import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempHome, writeSkill } from './helpers.js';
import { defaultConfig } from '../../cortex/lib/config.js';
import { ensureVault, listSkills, saveMemory, deleteSkill } from '../../cortex/lib/vault.js';
import { adoptSkill, scan, importMemoryFromAgent } from '../../cortex/lib/agents.js';
import { classifyOrigin, readManifest, setProvenance } from '../../cortex/lib/provenance.js';

test('classifyOrigin: license, builtin roots, external bundles, personal', () => {
  assert.equal(classifyOrigin({ realPath: '/home/u/.claude/skills/synced/x/docx', license: 'Proprietary. LICENSE.txt has complete terms' }), 'builtin');
  assert.equal(classifyOrigin({ realPath: '/mnt/skills/public/pdf' }), 'builtin');
  assert.equal(classifyOrigin({ realPath: '/home/u/repos/superpowers/skills/tdd', bundle: 'superpowers', agentSkillsDir: '/home/u/.agents/skills' }), 'plugin');
  assert.equal(classifyOrigin({ realPath: '/home/u/.claude/skills/synced/abc/pg-writer', bundle: 'synced/abc', agentSkillsDir: '/home/u/.claude/skills' }), 'personal');
  assert.equal(classifyOrigin({ realPath: '/home/u/.claude/skills/mine' }), 'personal');
});

test('adopt records origin + source (agent, device, path); scan records seen per device; override sticks', () => {
  const home = tempHome();
  const config = defaultConfig();
  const vault = ensureVault(path.join(home, '.cortex', 'vault'));
  const nested = path.join(home, '.claude', 'skills', 'synced', 'id1');
  writeSkill(nested, 'pg-writer', 'Essays');
  const docx = writeSkill(nested, 'docx', 'Word docs');
  fs.writeFileSync(path.join(docx, 'SKILL.md'), '---\nname: docx\ndescription: Word docs\nlicense: Proprietary\n---\n# docx\n');
  const repo = path.join(home, 'repo', 'skills'); writeSkill(repo, 'tdd', 'Test first');
  fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  fs.symlinkSync(repo, path.join(home, '.agents', 'skills', 'superpowers'));

  const s0 = scan(config, vault);
  const un = Object.fromEntries(s0.agents.flatMap(a => a.unadopted.map(u => [`${a.id}/${u.name}`, u.origin])));
  assert.deepEqual(un, { 'claude-code/pg-writer': 'personal', 'claude-code/docx': 'builtin', 'codex/tdd': 'plugin' });

  const laptop = { id: 'dev1', name: 'laptop' };
  adoptSkill(config, vault, 'claude-code', 'pg-writer', { bundle: 'synced/id1', device: laptop });
  adoptSkill(config, vault, 'codex', 'tdd', { bundle: 'superpowers', device: laptop });
  let skills = listSkills(vault);
  const pg = skills.find(s => s.name === 'pg-writer'), tdd = skills.find(s => s.name === 'tdd');
  assert.equal(pg.origin, 'personal'); assert.equal(tdd.origin, 'plugin');
  assert.equal(pg.source.agent, 'claude-code'); assert.equal(pg.source.device, 'laptop'); assert.equal(pg.source.bundle, 'synced/id1');
  assert.ok(pg.adopted);

  scan(config, vault, { device: laptop });
  scan(config, vault, { device: { id: 'dev2', name: 'desktop' } });
  const m = readManifest(vault);
  assert.deepEqual(m.skills['pg-writer'].seen.dev1.agents, ['claude-code']);
  assert.equal(m.skills['pg-writer'].seen.dev2.device, 'desktop');
  assert.deepEqual(m.skills.tdd.seen.dev1.agents, ['codex']);

  setProvenance(vault, 'tdd', { origin: 'personal', originOverridden: true });
  assert.equal(listSkills(vault).find(s => s.name === 'tdd').origin, 'personal');
  deleteSkill(vault, 'tdd');
  assert.equal(readManifest(vault).skills.tdd, undefined);
  // manifest is plain JSON inside the vault, so it syncs with it
  assert.ok(fs.existsSync(path.join(vault, 'manifest.json')));
});

test('vault skill identical to a built-in copy is classified builtin', async () => {
  const home = tempHome();
  const config = defaultConfig();
  config.agents.push({ id: 'app', name: 'App', kind: 'fs', enabled: true, skillsDir: path.join(home, 'mnt-skills') });
  const vault = ensureVault(path.join(home, '.cortex', 'vault'));
  writeSkill(path.join(home, '.claude', 'skills'), 'morning', 'Brief');
  writeSkill(path.join(home, 'mnt-skills', 'examples'), 'morning', 'Brief');
  const { BUILTIN_ROOTS } = await import('../../cortex/lib/provenance.js');
  BUILTIN_ROOTS.push(path.join(home, 'mnt-skills'));
  adoptSkill(config, vault, 'claude-code', 'morning', { device: { id: 'd', name: 'x' } });
  assert.equal(listSkills(vault)[0].origin, 'personal');           // from the user's folder, no license
  const s = scan(config, vault);
  assert.equal(s.skills[0].origin, 'builtin');                       // ...but identical to a built-in copy
  assert.match(s.skills[0].originNote, /identical/);
});

test('memory items carry agent + device', () => {
  const home = tempHome();
  const config = defaultConfig();
  const vault = ensureVault(path.join(home, '.cortex', 'vault'));
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'Be brief.\n');
  const r = importMemoryFromAgent(config, vault, 'gemini', { name: 'laptop' });
  assert.equal(r.created[0].agent, 'gemini'); assert.equal(r.created[0].device, 'laptop');
  const m = saveMemory(vault, { title: 'x', body: 'y', agent: 'cortex', device: 'desktop' });
  assert.equal(m.device, 'desktop');
});
