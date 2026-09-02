import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempHome, writeSkill } from './helpers.js';
import { defaultConfig } from '../../cortex/lib/config.js';
import { ensureVault, listSkills, saveMemory } from '../../cortex/lib/vault.js';
import {
  scan, adoptSkill, installSkill, uninstallSkill, pullSkill, pushMemory, importMemoryFromAgent,
  upsertBlock, stripBlock, renderMemoryBlock, exportMemoryText, importMemoryText, expandGlob, BEGIN, END,
} from '../../cortex/lib/agents.js';

function setup() {
  const home = tempHome();
  const config = defaultConfig();
  const vault = ensureVault(path.join(home, '.cortex', 'vault'));
  return { home, config, vault };
}

test('scan finds unadopted skills in agent dirs and nested bundles', () => {
  const { home, config, vault } = setup();
  writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
  const bundle = path.join(home, 'repo', 'skills');
  writeSkill(bundle, 'beta'); writeSkill(bundle, 'gamma');
  fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(bundle, path.join(home, '.agents', 'skills', 'superpowers'));
  const s = scan(config, vault);
  const claude = s.agents.find(a => a.id === 'claude-code');
  const codex = s.agents.find(a => a.id === 'codex');
  assert.deepEqual(claude.unadopted.map(u => u.name), ['alpha']);
  assert.deepEqual(codex.unadopted.map(u => [u.name, u.bundle]), [['beta', 'superpowers'], ['gamma', 'superpowers']]);
  assert.equal(claude.detected, true);
  assert.equal(s.agents.find(a => a.id === 'cursor').detected, false);
});

test('adopt -> install(symlink) -> status linked -> uninstall -> missing', () => {
  const { home, config, vault } = setup();
  writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
  adoptSkill(config, vault, 'claude-code', 'alpha');
  assert.equal(listSkills(vault)[0].name, 'alpha');
  assert.throws(() => adoptSkill(config, vault, 'claude-code', 'alpha'), /already has/);

  let s = scan(config, vault);
  // agent still has its own (identical) copy -> copied
  assert.equal(s.skills[0].agents['claude-code'].status, 'copied');
  assert.equal(s.skills[0].agents['codex'].status, 'missing');

  const r = installSkill(config, vault, 'alpha', 'codex');
  assert.equal(r.status, 'linked');
  assert.ok(fs.lstatSync(r.target).isSymbolicLink());
  s = scan(config, vault);
  assert.equal(s.skills[0].agents['codex'].status, 'linked');
  // adopted skill no longer shows as unadopted, and the linked one doesn't either
  assert.equal(s.agents.find(a => a.id === 'codex').unadopted.length, 0);

  uninstallSkill(config, vault, 'alpha', 'codex');
  assert.equal(scan(config, vault).skills[0].agents['codex'].status, 'missing');
});

test('install(copy) then edit agent copy -> diverged; pull brings agent version into vault', () => {
  const { home, config, vault } = setup();
  writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
  adoptSkill(config, vault, 'claude-code', 'alpha');
  const r = installSkill(config, vault, 'alpha', 'codex', 'copy');
  assert.equal(r.status, 'copied');
  fs.appendFileSync(path.join(r.target, 'SKILL.md'), '\nAgent edit.\n');
  assert.equal(scan(config, vault).skills[0].agents['codex'].status, 'diverged');
  pullSkill(config, vault, 'alpha', 'codex');
  assert.match(fs.readFileSync(path.join(vault, 'skills', 'alpha', 'SKILL.md'), 'utf8'), /Agent edit/);
  assert.equal(scan(config, vault).skills[0].agents['codex'].status, 'copied');
});

test('upsertBlock replaces existing block and preserves surrounding content', () => {
  const block1 = `${BEGIN}\nv1\n${END}`;
  const block2 = `${BEGIN}\nv2\n${END}`;
  const first = upsertBlock('# Mine\nkeep me\n', block1);
  assert.match(first, /keep me/);
  assert.match(first, /v1/);
  const second = upsertBlock(first + '\ntrailing user text\n', block2);
  assert.equal((second.match(/cortex:begin/g) || []).length, 1);
  assert.match(second, /v2/); assert.doesNotMatch(second, /v1/);
  assert.match(second, /keep me/); assert.match(second, /trailing user text/);
  assert.equal(stripBlock(second).includes('v2'), false);
  assert.equal(upsertBlock('', block1), block1 + '\n');
});

test('pushMemory writes global items, respects agent targeting, never echoes an agent its own imports', () => {
  const { home, config, vault } = setup();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Mine\nBe terse.\n');
  saveMemory(vault, { title: 'Global', body: 'for everyone' });
  saveMemory(vault, { title: 'Codex only', body: 'codex secret', agents: ['codex'] });
  saveMemory(vault, { title: 'Project', body: 'scoped', scope: 'project:x' });
  const imp = importMemoryFromAgent(config, vault, 'claude-code', { name: 'dev' });
  assert.equal(imp.created.length, 1);
  assert.equal(imp.created[0].body, '# Mine\nBe terse.');

  const r = pushMemory(config, vault, 'claude-code', { name: 'dev' });
  assert.equal(r.count, 1);
  const claude = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Mine\nBe terse\./);
  assert.match(claude, /for everyone/);
  assert.doesNotMatch(claude, /codex secret/);
  assert.doesNotMatch(claude, /scoped/);
  assert.equal((claude.match(/Be terse/g) || []).length, 1, 'own memory not echoed back');

  const rc = pushMemory(config, vault, 'codex', { name: 'dev' });
  const codex = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal(rc.count, 3); // Global, Codex only, and the imported claude note
  assert.match(codex, /codex secret/);

  // second import of unchanged file is a no-op
  assert.equal(importMemoryFromAgent(config, vault, 'claude-code', { name: 'dev' }).created.length, 0);
  assert.throws(() => pushMemory(config, vault, 'chatgpt'), /export instead/);
});

test('project memory globs import with project scope', () => {
  const { home, config, vault } = setup();
  const dir = path.join(home, '.claude', 'projects', '-Users-me-app', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\nuse pnpm\n');
  assert.equal(expandGlob('~/.claude/projects/*/memory/*.md').length, 1);
  const r = importMemoryFromAgent(config, vault, 'claude-code', { name: 'dev' });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].scope, 'project:-Users-me-app');
  assert.equal(r.created[0].title, 'Notes');
});

test('export/import plain text for ChatGPT with dedupe', () => {
  const { vault } = setup();
  const r = importMemoryText(vault, 'Likes concise answers.\n\n- Works on three devices\n- Uses Instinct', { source: 'chatgpt' });
  assert.equal(r.created.length, 3);
  assert.deepEqual(r.created.map(i => i.title), ['Likes concise answers', 'Works on three devices', 'Uses Instinct']);
  assert.equal(importMemoryText(vault, 'Uses Instinct').created.length, 0);
  const e = exportMemoryText(vault, 'chatgpt', { limit: 40 });
  assert.equal(e.count, 3);
  assert.equal(e.overLimit, true);
  assert.match(e.text, /- Uses Instinct: Uses Instinct/);
});

test('renderMemoryBlock handles empty list', () => {
  const b = renderMemoryBlock([], { device: { name: 'x' } });
  assert.match(b, /No memory items yet/);
  assert.ok(b.startsWith(BEGIN) && b.endsWith(END));
});
