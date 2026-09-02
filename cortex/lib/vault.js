// The vault is a plain folder:
//   <vault>/skills/<name>/SKILL.md ...   canonical copy of each skill
//   <vault>/memory/<id>.md               one memory item per file, with frontmatter
//   <vault>/devices.json                 devices that have opened this vault
//   <vault>/.imports.json                hashes of things already imported (dedupe)
// Plain markdown so it works with any sync mechanism and any agent.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

// ---------- frontmatter ----------

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      // YAML block scalar: gather indented continuation lines
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      v = v.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (/^["'].*["']$/.test(v)) {
      v = v.slice(1, -1);
    } else if (v === 'true' || v === 'false') {
      v = v === 'true';
    }
    data[kv[1]] = v;
  }
  return { data, body: m[2] };
}

export function serializeFrontmatter(data, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else if (typeof v === 'string' && /[:#]/.test(v)) lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\n+/, '');
}

// ---------- hashing ----------

export function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d, rel) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { h.update(r + '\0'); h.update(fs.readFileSync(full)); h.update('\0'); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ---------- vault layout ----------

export function ensureVault(vaultDir) {
  fs.mkdirSync(path.join(vaultDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'memory'), { recursive: true });
  const readme = path.join(vaultDir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '# Cortex vault',
      '',
      'Your skills and memory, portable across devices and agents.',
      '',
      '- `skills/<name>/SKILL.md` — one folder per skill (Agent Skills format)',
      '- `memory/<id>.md` — one markdown file per memory item, with frontmatter',
      '- `devices.json` — devices that have opened this vault',
      '',
      'Manage it with `cortex serve` (web UI) or `cortex --help` (CLI).',
      '',
    ].join('\n'));
  }
  return vaultDir;
}

export function isVault(vaultDir) {
  return fs.existsSync(path.join(vaultDir, 'skills')) && fs.existsSync(path.join(vaultDir, 'memory'));
}

// ---------- skills ----------

export function skillsDir(vaultDir) { return path.join(vaultDir, 'skills'); }

export function readSkillMeta(skillDir) {
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(text);
  // Folder name is canonical (it's what agents resolve); frontmatter name is informational.
  const name = path.basename(skillDir);
  const firstPara = body.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#')) || '';
  return {
    name,
    title: data.name && data.name !== name ? data.name : undefined,
    description: data.description || firstPara.slice(0, 200),
    tags: Array.isArray(data.tags) ? data.tags : [],
    path: skillDir,
    files: countFiles(skillDir),
    hash: hashTree(skillDir),
    updated: fs.statSync(file).mtime.toISOString(),
  };
}

function countFiles(dir) {
  let n = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    }
  };
  try { walk(dir); } catch {}
  return n;
}

export function listSkills(vaultDir) {
  const dir = skillsDir(vaultDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() || e.isSymbolicLink())
    .map(e => readSkillMeta(path.join(dir, e.name)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkillFiles(vaultDir, name) {
  const dir = path.join(skillsDir(vaultDir), safeName(name));
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else {
        const buf = fs.readFileSync(path.join(d, e.name));
        const isText = !buf.subarray(0, 512).includes(0);
        files.push({ path: r, size: buf.length, content: isText ? buf.toString('utf8') : null });
      }
    }
  };
  walk(dir, '');
  return files.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
}

export function writeSkillFile(vaultDir, name, relPath, content) {
  const dir = path.join(skillsDir(vaultDir), safeName(name));
  const target = path.join(dir, relPath);
  if (!target.startsWith(dir + path.sep) && target !== dir) throw new Error('path escapes skill dir');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function createSkill(vaultDir, name, description, body = '') {
  const dir = path.join(skillsDir(vaultDir), safeName(name));
  if (fs.existsSync(dir)) throw new Error(`skill "${name}" already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const md = serializeFrontmatter({ name, description }, body || `# ${name}\n\n${description}\n`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  return readSkillMeta(dir);
}

export function deleteSkill(vaultDir, name) {
  const dir = path.join(skillsDir(vaultDir), safeName(name));
  fs.rmSync(dir, { recursive: true, force: true });
}

export function safeName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.') || name.includes('..')) {
    throw new Error(`invalid name "${name}"`);
  }
  return name;
}

export function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- memory ----------

export function memoryDir(vaultDir) { return path.join(vaultDir, 'memory'); }

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'memory';
}

export function listMemory(vaultDir) {
  const dir = memoryDir(vaultDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => readMemory(vaultDir, f.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

export function readMemory(vaultDir, id) {
  const file = path.join(memoryDir(vaultDir), safeName(id) + '.md');
  if (!fs.existsSync(file)) return null;
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  return {
    id,
    title: data.title || id,
    tags: Array.isArray(data.tags) ? data.tags : [],
    scope: data.scope || 'global',
    agents: Array.isArray(data.agents) ? data.agents : ['all'],
    source: data.source || '',
    created: data.created || '',
    updated: data.updated || fs.statSync(file).mtime.toISOString(),
    body: body.trim(),
  };
}

export function saveMemory(vaultDir, item) {
  const now = new Date().toISOString();
  let id = item.id;
  if (!id) {
    const base = slugify(item.title || item.body?.slice(0, 40));
    id = base;
    let n = 2;
    while (fs.existsSync(path.join(memoryDir(vaultDir), id + '.md'))) id = `${base}-${n++}`;
  }
  const existing = readMemory(vaultDir, id);
  const data = {
    id,
    title: item.title || existing?.title || id,
    tags: item.tags ?? existing?.tags ?? [],
    scope: item.scope || existing?.scope || 'global',
    agents: item.agents?.length ? item.agents : (existing?.agents || ['all']),
    source: item.source ?? existing?.source ?? '',
    created: existing?.created || now,
    updated: now,
  };
  fs.mkdirSync(memoryDir(vaultDir), { recursive: true });
  fs.writeFileSync(path.join(memoryDir(vaultDir), id + '.md'), serializeFrontmatter(data, (item.body ?? existing?.body ?? '') + '\n'));
  return readMemory(vaultDir, id);
}

export function deleteMemory(vaultDir, id) {
  fs.rmSync(path.join(memoryDir(vaultDir), safeName(id) + '.md'), { force: true });
}

// Which memory items should a given agent receive?
export function memoryForAgent(items, agentId) {
  return items.filter(m => m.agents.includes('all') || m.agents.includes(agentId));
}

// ---------- devices ----------

export function devicesFile(vaultDir) { return path.join(vaultDir, 'devices.json'); }

export function listDevices(vaultDir) {
  try { return JSON.parse(fs.readFileSync(devicesFile(vaultDir), 'utf8')); } catch { return []; }
}

export function touchDevice(vaultDir, device, extra = {}) {
  const devices = listDevices(vaultDir).filter(d => d.id !== device.id);
  devices.push({ ...device, ...extra, lastSeen: new Date().toISOString() });
  devices.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  fs.writeFileSync(devicesFile(vaultDir), JSON.stringify(devices, null, 2) + '\n');
  return devices;
}

// ---------- import ledger (dedupe) ----------

export function importsFile(vaultDir) { return path.join(vaultDir, '.imports.json'); }

export function readImports(vaultDir) {
  try { return JSON.parse(fs.readFileSync(importsFile(vaultDir), 'utf8')); } catch { return {}; }
}

export function recordImport(vaultDir, hash, info) {
  const all = readImports(vaultDir);
  all[hash] = { ...info, at: new Date().toISOString() };
  fs.writeFileSync(importsFile(vaultDir), JSON.stringify(all, null, 2) + '\n');
}
