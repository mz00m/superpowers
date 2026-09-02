import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempHome, writeSkill } from './helpers.js';
import { defaultConfig } from '../../cortex/lib/config.js';
import { ensureVault } from '../../cortex/lib/vault.js';
import { adoptSkill, conflicts, scan } from '../../cortex/lib/agents.js';
import { similarity, findConflicts, lineDiff, markDistinct, readDistinct, pairKey } from '../../cortex/lib/similar.js';

test('similarity: identical hash is 1, unrelated is ~0, related is in between', () => {
  const a = { name: 'code-review', description: 'Review a diff for bugs and style', body: 'Read the diff. Look for bugs. Report by severity.', hash: 'x' };
  const b = { name: 'requesting-code-review', description: 'Ask for a review of a diff for bugs', body: 'Read the diff. Look for bugs. Then report by severity to the author.', hash: 'y' };
  const c = { name: 'grocery-shopping', description: 'Order groceries online', body: 'Open the store. Add items to the cart. Checkout.', hash: 'z' };
  assert.equal(similarity(a, { ...a }), 1);
  assert.ok(similarity(a, b) >= 0.3, `related ${similarity(a, b)}`);
  assert.ok(similarity(a, c) < 0.2, `unrelated ${similarity(a, c)}`);
});

test('findConflicts classifies identical, same-name, similar and honours distinct ledger', () => {
  const cands = [
    { key: 'vault/pdf', name: 'pdf', description: 'work with pdf files', body: 'merge split rotate pdf pages', hash: 'h1' },
    { key: 'claude-code/pdf', name: 'pdf', description: 'work with pdf files', body: 'merge split rotate pdf pages', hash: 'h1' },
    { key: 'codex/pdf', name: 'pdf', description: 'pdf tools', body: 'totally different content here', hash: 'h2' },
    { key: 'vault/pdf-reading', name: 'pdf-reading', description: 'read pdf files and extract text', body: 'merge split rotate pdf pages and extract text', hash: 'h3' },
    { key: 'vault/paint', name: 'paint', description: 'draw pictures', body: 'canvas brush color', hash: 'h4' },
  ];
  const pairs = findConflicts(cands);
  const kinds = Object.fromEntries(pairs.map(p => [pairKey(p.a.key, p.b.key), p.kind]));
  assert.equal(kinds[pairKey('vault/pdf', 'claude-code/pdf')], 'identical');
  assert.equal(kinds[pairKey('vault/pdf', 'codex/pdf')], 'same-name');
  assert.equal(kinds[pairKey('vault/pdf', 'vault/pdf-reading')], 'similar');
  assert.equal(kinds[pairKey('vault/paint', 'vault/pdf')], undefined);
  assert.equal(pairs[0].kind, 'identical');
  const filtered = findConflicts(cands, { distinct: { [pairKey('vault/pdf', 'vault/pdf-reading')]: {} } });
  assert.equal(filtered.some(p => pairKey(p.a.key, p.b.key) === pairKey('vault/pdf', 'vault/pdf-reading')), false);
});

test('lineDiff marks added/removed/common lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(d.map(l => l.t), [' ', '-', ' ', '+']);
});

test('end to end: nested skills found, conflicts across agents, adopt resolves, distinct persists', () => {
  const home = tempHome();
  const config = defaultConfig();
  const vault = ensureVault(path.join(home, '.cortex', 'vault'));
  // Claude Code with skills nested two levels deep (synced/<id>/<skill>)
  const nested = path.join(home, '.claude', 'skills', 'synced', 'abc123');
  writeSkill(nested, 'pdf', 'Work with PDF files');
  writeSkill(nested, 'pg-writer', 'Write essays like Paul Graham');
  // Codex with a different pdf skill
  const codexPdf = writeSkill(path.join(home, '.agents', 'skills'), 'pdf', 'Work with PDF files');
  fs.appendFileSync(path.join(codexPdf, 'SKILL.md'), '\nExtra codex-only guidance.\n');

  const s = scan(config, vault);
  const claude = s.agents.find(a => a.id === 'claude-code');
  assert.deepEqual(claude.unadopted.map(u => [u.name, u.bundle]).sort(), [['pdf', 'synced/abc123'], ['pg-writer', 'synced/abc123']]);

  let c = conflicts(config, vault);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'same-name');
  assert.deepEqual([c[0].a.key, c[0].b.key].sort(), ['claude-code/synced/abc123/pdf', 'codex/pdf']);

  adoptSkill(config, vault, 'claude-code', 'pdf', { bundle: 'synced/abc123' });
  c = conflicts(config, vault);
  // claude's copy is identical to vault/pdf, so it collapses into the vault entry: one same-name pair vs codex
  assert.deepEqual(c.map(p => p.kind), ['same-name']);
  assert.deepEqual([c[0].a.key, c[0].b.key].sort(), ['codex/pdf', 'vault/pdf']);
  const cell = scan(config, vault).skills.find(s => s.name === 'pdf').agents['claude-code'];
  assert.equal(cell.status, 'copied');
  assert.equal(cell.nested, 'synced/abc123');

  assert.throws(() => adoptSkill(config, vault, 'codex', 'pdf'), e => e.conflict?.vault?.name === 'pdf');
  adoptSkill(config, vault, 'codex', 'pdf', { as: 'pdf-codex' });
  markDistinct(vault, 'vault/pdf', 'vault/pdf-codex', 'codex variant has extra guidance');
  assert.ok(readDistinct(vault)[pairKey('vault/pdf-codex', 'vault/pdf')]);
  c = conflicts(config, vault);
  assert.equal(c.some(p => pairKey(p.a.key, p.b.key) === pairKey('vault/pdf', 'vault/pdf-codex')), false);
});
