#!/usr/bin/env node
// Cortex local server: serves the web UI and a small JSON API that the UI,
// the CLI, and any agent (Claude Code, Codex, your own) can call.
// Zero dependencies — Node built-ins only. Binds to localhost by default.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ops } from './lib/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CORTEX_PORT || 4747);
const HOST = process.env.CORTEX_HOST || '127.0.0.1';
const UI = path.join(__dirname, 'ui', 'index.html');

// route table: [method, pattern, handler(params, body, query)]
const routes = [
  ['GET', '/api/state', () => ops.scan()],
  ['GET', '/api/config', () => ops.config()],
  ['PUT', '/api/config', (_, body) => ops.saveConfig(body)],
  ['POST', '/api/config/reset-agents', () => ops.resetAgents()],
  ['POST', '/api/device', (_, body) => ops.renameDevice(body)],
  ['GET', '/api/skills', () => ops.listSkills()],
  ['POST', '/api/skills', (_, body) => ops.createSkill(body)],
  ['GET', '/api/skills/:name', (p) => ops.skill(p.name)],
  ['PUT', '/api/skills/:name/file', (p, body) => ops.writeSkillFile({ name: p.name, ...body })],
  ['DELETE', '/api/skills/:name', (p) => ops.deleteSkill({ name: p.name })],
  ['POST', '/api/skills/:name/origin', (p, body) => ops.setOrigin({ name: p.name, origin: body.origin })],
  ['POST', '/api/skills/adopt', (_, body) => ops.adopt(body)],
  ['POST', '/api/skills/install', (_, body) => ops.install(body)],
  ['POST', '/api/skills/uninstall', (_, body) => ops.uninstall(body)],
  ['POST', '/api/skills/pull', (_, body) => ops.pull(body)],
  ['GET', '/api/conflicts', (_, __, q) => ops.conflicts(q)],
  ['GET', '/api/conflicts/compare', (_, __, q) => ops.compare(q)],
  ['POST', '/api/conflicts/distinct', (_, body) => ops.markDistinct(body)],
  ['DELETE', '/api/conflicts/distinct', (_, body) => ops.unmarkDistinct(body)],
  ['GET', '/api/memory', () => ops.listMemory()],
  ['POST', '/api/memory', (_, body) => ops.saveMemory(body)],
  ['GET', '/api/memory/export', (_, __, q) => ops.exportMemory(q)],
  ['POST', '/api/memory/push', (_, body) => ops.pushMemory(body)],
  ['POST', '/api/memory/import', (_, body) => ops.importMemory(body)],
  ['GET', '/api/memory/:id', (p) => ops.memory(p.id)],
  ['DELETE', '/api/memory/:id', (p) => ops.deleteMemory({ id: p.id })],
  ['POST', '/api/sync', () => ops.sync()],
  ['POST', '/api/sync/init', (_, body) => ops.initGit(body)],
];

function match(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const pp = pattern.split('/'), up = pathname.split('/');
    if (pp.length !== up.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(up[i]);
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(data) : data;
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // Only accept browser requests from our own origin (blocks drive-by
    // localhost attacks from other tabs). Non-browser clients send no Origin.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request blocked' });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html');
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, version: 1 });
    if (url.pathname === '/favicon.ico') return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="13" font-size="13">🧠</text></svg>', 'image/svg+xml');

    const found = match(req.method, url.pathname);
    if (!found) return send(res, 404, { error: 'not found' });
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await found.handler(found.params, body, Object.fromEntries(url.searchParams));
      if (result === null || result === undefined) return send(res, 404, { error: 'not found' });
      send(res, 200, result);
    } catch (err) {
      send(res, err.conflict ? 409 : 400, { error: err.message, conflict: err.conflict });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ type: 'server-started', url: `http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`, host: HOST, port: PORT }));
  });
}
