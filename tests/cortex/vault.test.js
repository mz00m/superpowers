import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempHome, writeSkill } from './helpers.js';
import {
  parseFrontmatter, serializeFrontmatter, ensureVault, listSkills, createSkill, saveMemory,
  listMemory, readMemory, deleteMemory, memoryForAgent, hashTree, touchDevice, listDevices,
} from '../../cortex/lib/vault.js';

test('frontmatter round-trips lists, quoted strings, booleans', () => {
  const text = serializeFrontmatter({ title: 'Uses: colons', tags: ['a', 'b'], flag: true }, 'body\n');
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.title, 'Uses: colons');
  assert.deepEqual(data.tags, ['a', 'b']);
  assert.equal(data.flag, true);
  assert.equal(body.trim(), 'body');
});

test('parseFrontmatter returns whole text as body when no frontmatter', () => {
  const { data, body } = parseFrontmatter('# hi\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# hi\n');
});

test('ensureVault creates skills/ memory/ README', () => {
  const home = tempHome();
  const v = ensureVault(path.join(home, 'vault'));
  assert.ok(fs.existsSync(path.join(v, 'skills')));
  assert.ok(fs.existsSync(path.join(v, 'memory')));
  assert.ok(fs.existsSync(path.join(v, 'README.md')));
});

test('createSkill + listSkills read name/description/hash', () => {
  const home = tempHome();
  const v = ensureVault(path.join(home, 'vault'));
  createSkill(v, 'my-skill', 'Use when testing');
  const skills = listSkills(v);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'my-skill');
  assert.equal(skills[0].description, 'Use when testing');
  assert.equal(skills[0].hash, hashTree(path.join(v, 'skills', 'my-skill')));
  assert.throws(() => createSkill(v, 'my-skill', 'dup'), /already exists/);
  assert.throws(() => createSkill(v, '../escape', 'x'), /invalid name/);
});

test('hashTree changes with content and ignores .git', () => {
  const home = tempHome();
  const d = writeSkill(home, 's');
  const h1 = hashTree(d);
  fs.mkdirSync(path.join(d, '.git')); fs.writeFileSync(path.join(d, '.git', 'x'), 'ignored');
  assert.equal(hashTree(d), h1);
  fs.appendFileSync(path.join(d, 'SKILL.md'), 'more');
  assert.notEqual(hashTree(d), h1);
});

test('memory CRUD with generated ids, dedupe of slug collisions', () => {
  const home = tempHome();
  const v = ensureVault(path.join(home, 'vault'));
  const a = saveMemory(v, { title: 'Prefers TDD', body: 'Tests first.', tags: ['workflow'] });
  const b = saveMemory(v, { title: 'Prefers TDD', body: 'Second one.' });
  assert.equal(a.id, 'prefers-tdd');
  assert.equal(b.id, 'prefers-tdd-2');
  assert.deepEqual(a.tags, ['workflow']);
  assert.deepEqual(a.agents, ['all']);
  const updated = saveMemory(v, { id: a.id, body: 'Tests first, always.' });
  assert.equal(updated.title, 'Prefers TDD');
  assert.equal(updated.body, 'Tests first, always.');
  assert.equal(updated.created, a.created);
  assert.equal(listMemory(v).length, 2);
  deleteMemory(v, b.id);
  assert.equal(readMemory(v, b.id), null);
  assert.equal(listMemory(v).length, 1);
});

test('memoryForAgent filters by agent list', () => {
  const items = [
    { agents: ['all'] }, { agents: ['claude-code'] }, { agents: ['chatgpt', 'instinct'] },
  ];
  assert.equal(memoryForAgent(items, 'instinct').length, 2);
  assert.equal(memoryForAgent(items, 'codex').length, 1);
});

test('touchDevice registers and updates devices.json', () => {
  const home = tempHome();
  const v = ensureVault(path.join(home, 'vault'));
  touchDevice(v, { id: 'a', name: 'laptop' }, { agents: ['codex'] });
  touchDevice(v, { id: 'b', name: 'desktop' });
  touchDevice(v, { id: 'a', name: 'laptop-renamed' });
  const devices = listDevices(v);
  assert.equal(devices.length, 2);
  assert.equal(devices.find(d => d.id === 'a').name, 'laptop-renamed');
});
