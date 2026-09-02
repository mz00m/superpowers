import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { tempHome, writeSkill } from './helpers.js';

let server, base, home;
before(async () => {
  home = tempHome();
  writeSkill(path.join(home, '.claude', 'skills'), 'alpha');
  const { createServer } = await import('../../cortex/server.js');
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

test('serves UI and health', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Cortex<\/title>/);
  assert.equal((await j('GET', '/api/health')).data.ok, true);
});

test('state -> adopt -> install -> memory -> export flow over HTTP', async () => {
  let s = (await j('GET', '/api/state')).data;
  assert.equal(s.counts.skills, 0);
  assert.equal(s.counts.unadopted, 1);
  assert.equal(s.devices.length, 1);

  assert.equal((await j('POST', '/api/skills/adopt', { agent: 'claude-code', name: 'alpha' })).status, 200);
  const inst = await j('POST', '/api/skills/install', { name: 'alpha', agent: 'codex' });
  assert.equal(inst.data[0].status, 'linked');
  s = (await j('GET', '/api/state')).data;
  assert.equal(s.skills[0].agents.codex.status, 'linked');

  const files = (await j('GET', '/api/skills/alpha')).data;
  assert.equal(files[0].path, 'SKILL.md');
  await j('PUT', '/api/skills/alpha/file', { path: 'SKILL.md', content: '---\nname: alpha\ndescription: edited\n---\n' });
  assert.equal((await j('GET', '/api/skills')).data[0].description, 'edited');

  const m = (await j('POST', '/api/memory', { title: 'Hello', body: 'world', tags: ['t'] })).data;
  assert.equal(m.id, 'hello');
  const push = (await j('POST', '/api/memory/push', { agent: 'gemini' })).data;
  assert.equal(push[0].count, 1);
  assert.match(fs.readFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'utf8'), /world/);
  const exp = (await j('GET', '/api/memory/export?agent=chatgpt')).data;
  assert.match(exp.text, /Hello: world/);
  assert.equal((await j('DELETE', '/api/memory/hello')).status, 200);
  assert.equal((await j('GET', '/api/memory/hello')).status, 404);
});

test('config validation and errors come back as 400', async () => {
  const bad = await j('PUT', '/api/config', { storage: { mode: 'git', gitRemote: '' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /gitRemote/);
  const ok = await j('PUT', '/api/config', { linkMode: 'copy' });
  assert.equal(ok.data.linkMode, 'copy');
  assert.equal((await j('POST', '/api/skills/install', { name: 'nope', agent: 'codex' })).status, 400);
  assert.equal((await j('GET', '/api/nothing')).status, 404);
});

test('cross-origin browser requests are rejected', async () => {
  const r = await fetch(base + '/api/state', { headers: { Origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
});
