// Agent adapters: scan what each agent has on disk, compare to the vault,
// link/copy skills in, and push/import memory.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandHome } from './config.js';
import {
  hashTree, hashText, readSkillMeta, copyTree, safeName, skillsDir, listSkills,
  listMemory, memoryForAgent, saveMemory, readImports, recordImport, parseFrontmatter,
} from './vault.js';

export const BEGIN = '<!-- cortex:begin -->';
export const END = '<!-- cortex:end -->';

// Tiny glob: supports a single `*` per path segment (enough for
// ~/.claude/projects/*/memory/*.md). Returns absolute paths.
export function expandGlob(pattern) {
  const abs = expandHome(pattern);
  const parts = abs.split(path.sep).filter(Boolean);
  let paths = [abs.startsWith(path.sep) ? path.sep : ''];
  for (const part of parts) {
    const next = [];
    for (const base of paths) {
      if (!part.includes('*')) { next.push(path.join(base, part)); continue; }
      const re = new RegExp('^' + part.split('*').map(escapeRe).join('.*') + '$');
      let entries = [];
      try { entries = fs.readdirSync(base); } catch {}
      for (const e of entries) if (re.test(e)) next.push(path.join(base, e));
    }
    paths = next;
  }
  return paths.filter(p => fs.existsSync(p));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function fsAgents(config) {
  return config.agents.filter(a => a.kind === 'fs');
}

export function agentSkillsDir(agent) {
  return agent.skillsDir ? expandHome(agent.skillsDir) : null;
}

// ---------- scanning ----------

function realpathSafe(p) { try { return fs.realpathSync(p); } catch { return null; } }

// Status of one vault skill inside one agent's skills directory.
export function skillStatus(vaultDir, agent, skill) {
  const dir = agentSkillsDir(agent);
  if (!dir) return { status: 'unsupported' };
  const target = path.join(dir, skill.name);
  let lst;
  try { lst = fs.lstatSync(target); } catch { return { status: 'missing', target }; }
  const vaultSkill = path.join(skillsDir(vaultDir), skill.name);
  if (lst.isSymbolicLink()) {
    const real = realpathSafe(target);
    if (real && real === realpathSafe(vaultSkill)) return { status: 'linked', target };
    return { status: real ? 'foreign-link' : 'broken-link', target, linkTarget: real };
  }
  if (lst.isDirectory()) {
    return { status: hashTree(target) === skill.hash ? 'copied' : 'diverged', target };
  }
  return { status: 'missing', target };
}

// Skills present in an agent dir that the vault doesn't know about.
export function unadoptedSkills(vaultDir, agent, vaultSkills) {
  const dir = agentSkillsDir(agent);
  if (!dir || !fs.existsSync(dir)) return [];
  const known = new Set(vaultSkills.map(s => s.name));
  const vaultReal = realpathSafe(skillsDir(vaultDir)) || '';
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const real = realpathSafe(full);
    if (!real || !fs.statSync(real).isDirectory()) continue;
    if (real.startsWith(vaultReal + path.sep)) continue;      // already linked from vault
    if (known.has(e.name)) continue;                          // vault has same name (status shown in matrix)
    const meta = readSkillMeta(real);
    if (meta) {
      out.push({ ...meta, agent: agent.id, name: e.name, isLink: e.isSymbolicLink() });
      continue;
    }
    // A linked bundle (e.g. ~/.agents/skills/superpowers -> repo/skills) contains nested skills.
    for (const sub of fs.readdirSync(real, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const sm = readSkillMeta(path.join(real, sub.name));
      if (sm && !known.has(sub.name)) out.push({ ...sm, agent: agent.id, name: sub.name, bundle: e.name, isLink: true });
    }
  }
  return out;
}

export function scan(config, vaultDir) {
  const skills = listSkills(vaultDir);
  const agents = config.agents.map(a => {
    const dir = a.kind === 'fs' ? agentSkillsDir(a) : null;
    const memoryFiles = (a.memoryFiles || []).map(expandHome);
    const memoryGlobFiles = (a.memoryGlobs || []).flatMap(expandGlob);
    const detected = a.kind === 'fs'
      ? [dir, ...memoryFiles].filter(Boolean).some(p => fs.existsSync(p)) || memoryGlobFiles.length > 0
      : null;
    return {
      ...a,
      skillsDirResolved: dir,
      skillsDirExists: dir ? fs.existsSync(dir) : false,
      memoryFilesResolved: memoryFiles.map(p => ({ path: p, exists: fs.existsSync(p) })),
      memoryGlobFiles,
      detected,
      unadopted: a.kind === 'fs' && a.enabled ? unadoptedSkills(vaultDir, a, skills) : [],
    };
  });
  const matrix = skills.map(s => ({
    ...s,
    agents: Object.fromEntries(
      fsAgents(config).filter(a => a.enabled).map(a => [a.id, skillStatus(vaultDir, a, s)])
    ),
  }));
  return { skills: matrix, agents };
}

// ---------- adopt / install / uninstall ----------

export function adoptSkill(config, vaultDir, agentId, name, { bundle } = {}) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const dir = agentSkillsDir(agent);
  const src = realpathSafe(bundle ? path.join(dir, bundle, name) : path.join(dir, safeName(name)));
  if (!src || !fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`no skill "${name}" in ${agent.name}`);
  const dest = path.join(skillsDir(vaultDir), name);
  if (fs.existsSync(dest)) throw new Error(`vault already has "${name}"`);
  copyTree(src, dest);
  return readSkillMeta(dest);
}

export function installSkill(config, vaultDir, name, agentId, mode = config.linkMode) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const dir = agentSkillsDir(agent);
  if (!dir) throw new Error(`${agent.name} has no skills directory`);
  const src = path.join(skillsDir(vaultDir), safeName(name));
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`vault has no skill "${name}"`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  removeTarget(target);
  if (mode === 'symlink') {
    try {
      fs.symlinkSync(src, target, os.platform() === 'win32' ? 'junction' : 'dir');
      return { status: 'linked', target };
    } catch (err) {
      // Fall back to copying (e.g. Windows without symlink privilege, cross-volume sync folders).
      copyTree(src, target);
      return { status: 'copied', target, note: `symlink failed (${err.code || err.message}); copied instead` };
    }
  }
  copyTree(src, target);
  return { status: 'copied', target };
}

export function uninstallSkill(config, vaultDir, name, agentId) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const dir = agentSkillsDir(agent);
  if (!dir) throw new Error(`${agent.name} has no skills directory`);
  const target = path.join(dir, safeName(name));
  removeTarget(target);
  return { status: 'missing', target };
}

// Pull an agent's diverged copy back into the vault (agent wins).
export function pullSkill(config, vaultDir, name, agentId) {
  const agent = config.agents.find(a => a.id === agentId);
  const src = path.join(agentSkillsDir(agent), safeName(name));
  const real = realpathSafe(src);
  const dest = path.join(skillsDir(vaultDir), name);
  if (!real || real === realpathSafe(dest)) throw new Error('nothing to pull');
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(real, dest);
  return readSkillMeta(dest);
}

function removeTarget(target) {
  let lst;
  try { lst = fs.lstatSync(target); } catch { return; }
  if (lst.isSymbolicLink() || lst.isFile()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true });
}

// ---------- memory: render / push / import ----------

export function renderMemoryBlock(items, { device, agentId, title = 'Memory' } = {}) {
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [
    BEGIN,
    `## ${title} (synced by Cortex${device ? ` from ${device.name}` : ''}, ${stamp})`,
    'Do not edit inside this block; it is regenerated. Edit the vault instead.',
    '',
  ];
  for (const m of items) {
    lines.push(`### ${m.title}`);
    if (m.scope && m.scope !== 'global') lines.push(`_Scope: ${m.scope}_`);
    lines.push(m.body, '');
  }
  if (!items.length) lines.push('_No memory items yet._', '');
  lines.push(END);
  return lines.join('\n');
}

// Replace (or append) the cortex block in a file, leaving the user's own
// content untouched.
export function upsertBlock(existing, block) {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  const sep = existing.length && !existing.endsWith('\n') ? '\n\n' : (existing.length ? '\n' : '');
  return existing + sep + block + '\n';
}

export function stripBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return text;
  return (text.slice(0, start) + text.slice(end + END.length)).trim() + '\n';
}

export function pushMemory(config, vaultDir, agentId, device) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  if (agent.kind !== 'fs') throw new Error(`${agent.name} has no memory file; use export instead`);
  // Global items only, and never echo an agent's own imported memory back to it.
  const items = memoryForAgent(listMemory(vaultDir), agentId)
    .filter(m => m.scope === 'global' && !m.source.startsWith(`${agentId}@`));
  const block = renderMemoryBlock(items, { device, agentId });
  const written = [];
  for (const f of agent.memoryFiles || []) {
    const file = expandHome(f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, upsertBlock(existing, block));
    written.push(file);
  }
  if (!written.length) throw new Error(`${agent.name} has no memoryFiles configured`);
  return { written, count: items.length };
}

// Import an agent's own memory (everything outside the cortex block) into the
// vault as one item per file. Skips content already imported (by hash).
export function importMemoryFromAgent(config, vaultDir, agentId, device) {
  const agent = config.agents.find(a => a.id === agentId);
  if (!agent) throw new Error(`unknown agent ${agentId}`);
  const imports = readImports(vaultDir);
  const created = [], skipped = [];
  const files = [
    ...(agent.memoryFiles || []).map(f => ({ file: expandHome(f), scope: 'global' })),
    ...(agent.memoryGlobs || []).flatMap(g => expandGlob(g).map(file => ({ file, scope: projectScope(file) }))),
  ];
  for (const { file, scope } of files) {
    if (!fs.existsSync(file)) continue;
    const text = stripBlock(fs.readFileSync(file, 'utf8')).trim();
    if (!text) continue;
    const hash = hashText(text);
    if (imports[hash]) { skipped.push(file); continue; }
    const { data, body } = parseFrontmatter(text);
    const title = data.title || data.name || firstHeading(body) || `${agent.name}: ${path.basename(file)}`;
    const item = saveMemory(vaultDir, {
      title, body: body.trim(), scope,
      tags: ['imported', agent.id],
      source: `${agent.id}@${device?.name || os.hostname()}:${file}`,
    });
    recordImport(vaultDir, hash, { agent: agent.id, file, id: item.id });
    created.push(item);
  }
  return { created, skipped };
}

function projectScope(file) {
  // ~/.claude/projects/<encoded-cwd>/memory/x.md -> project:<encoded-cwd>
  const parts = file.split(path.sep);
  const i = parts.indexOf('projects');
  return i !== -1 && parts[i + 1] ? `project:${parts[i + 1]}` : 'global';
}

function firstHeading(text) {
  const m = /^#+\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

// Plain-text bundle for agents without a filesystem (ChatGPT custom
// instructions, a Project's instructions, or a system prompt).
export function exportMemoryText(vaultDir, agentId = 'chatgpt', { limit } = {}) {
  const items = memoryForAgent(listMemory(vaultDir), agentId).filter(m => m.scope === 'global');
  const text = ['Things to remember about me and how I work:', '',
    ...items.map(m => `- ${m.title}: ${m.body.replace(/\s+/g, ' ').trim()}`)].join('\n');
  return { text, count: items.length, chars: text.length, overLimit: limit ? text.length > limit : false };
}

// Paste from ChatGPT "Manage memories" (or any list): one item per
// non-empty paragraph or bullet.
export function importMemoryText(vaultDir, text, { source = 'chatgpt', agents = ['all'] } = {}) {
  const imports = readImports(vaultDir);
  const chunks = String(text).split(/\n\s*\n|\n(?=\s*[-*•]\s)/).map(s => s.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
  const created = [], skipped = [];
  for (const chunk of chunks) {
    const hash = hashText(chunk);
    if (imports[hash]) { skipped.push(chunk); continue; }
    const title = chunk.split(/[.\n]/)[0].slice(0, 70);
    const item = saveMemory(vaultDir, { title, body: chunk, tags: ['imported', source], source, agents });
    recordImport(vaultDir, hash, { agent: source, id: item.id });
    created.push(item);
  }
  return { created, skipped };
}
