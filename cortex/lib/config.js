// Cortex configuration: where the vault lives, how it's stored, which agents
// to talk to, and who this device is. Everything is plain JSON under
// ~/.cortex so it's inspectable and hand-editable.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const CORTEX_HOME = process.env.CORTEX_HOME || path.join(os.homedir(), '.cortex');
export const CONFIG_PATH = path.join(CORTEX_HOME, 'config.json');
export const DEVICE_PATH = path.join(CORTEX_HOME, 'device.json');

// Storage modes for the vault:
//   local  - a folder on this machine only
//   folder - a folder inside a sync service (iCloud, Dropbox, Drive, Syncthing)
//   git    - a git repo with a remote; `cortex sync` pulls/pushes
export const STORAGE_MODES = ['local', 'folder', 'git'];
export const LINK_MODES = ['symlink', 'copy'];

// Built-in agent adapters. `kind: 'fs'` agents have skills/memory on disk.
// `kind: 'manual'` agents (ChatGPT) only support import/export of text.
export const DEFAULT_AGENTS = [
  {
    id: 'claude-code', name: 'Claude Code', kind: 'fs', enabled: true,
    skillsDir: '~/.claude/skills',
    memoryFiles: ['~/.claude/CLAUDE.md'],
    memoryGlobs: ['~/.claude/projects/*/memory/*.md'],
  },
  {
    id: 'codex', name: 'Codex', kind: 'fs', enabled: true,
    skillsDir: '~/.agents/skills',
    memoryFiles: ['~/.codex/AGENTS.md'],
  },
  {
    id: 'opencode', name: 'OpenCode', kind: 'fs', enabled: true,
    skillsDir: '~/.config/opencode/skills',
    memoryFiles: ['~/.config/opencode/AGENTS.md'],
  },
  {
    id: 'cursor', name: 'Cursor', kind: 'fs', enabled: true,
    skillsDir: '~/.cursor/skills',
    memoryFiles: [],
  },
  {
    id: 'gemini', name: 'Gemini CLI', kind: 'fs', enabled: true,
    skillsDir: null,
    memoryFiles: ['~/.gemini/GEMINI.md'],
  },
  {
    id: 'chatgpt', name: 'ChatGPT', kind: 'manual', enabled: true,
    notes: 'No filesystem. Import a memory export here; paste the export block into Custom Instructions or a Project.',
  },
  {
    id: 'instinct', name: 'Instinct', kind: 'fs', enabled: false, custom: true,
    skillsDir: '~/.instinct/skills',
    memoryFiles: ['~/.instinct/MEMORY.md'],
    notes: 'Your own agent. Point skillsDir / memoryFiles at wherever it reads from, then enable.',
  },
];

export function defaultConfig() {
  return {
    version: 1,
    vaultPath: '~/.cortex/vault',
    storage: { mode: 'local', gitRemote: '', autoSync: false },
    linkMode: 'symlink',
    agents: DEFAULT_AGENTS.map(a => ({ ...a })),
  };
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function collapseHome(p) {
  if (!p) return p;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Merge saved agents over defaults so new built-in adapters appear on upgrade
// while user edits (paths, enabled flags, custom agents) are preserved.
function mergeAgents(saved = []) {
  const byId = new Map(DEFAULT_AGENTS.map(a => [a.id, { ...a }]));
  for (const s of saved) {
    byId.set(s.id, { ...(byId.get(s.id) || {}), ...s });
  }
  return [...byId.values()];
}

export function loadConfig() {
  const base = defaultConfig();
  const saved = readJson(CONFIG_PATH, null);
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    storage: { ...base.storage, ...(saved.storage || {}) },
    agents: mergeAgents(saved.agents),
  };
}

export function saveConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error('Invalid config: ' + errors.join('; '));
  writeJson(CONFIG_PATH, config);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!config.vaultPath) errors.push('vaultPath is required');
  if (!STORAGE_MODES.includes(config.storage?.mode)) errors.push(`storage.mode must be one of ${STORAGE_MODES.join(', ')}`);
  if (!LINK_MODES.includes(config.linkMode)) errors.push(`linkMode must be one of ${LINK_MODES.join(', ')}`);
  if (config.storage?.mode === 'git' && !config.storage.gitRemote) errors.push('storage.gitRemote is required in git mode');
  const ids = new Set();
  for (const a of config.agents || []) {
    if (!a.id || !/^[a-z0-9-]+$/.test(a.id)) errors.push(`agent id "${a.id}" must be lowercase letters, digits, dashes`);
    if (ids.has(a.id)) errors.push(`duplicate agent id "${a.id}"`);
    ids.add(a.id);
  }
  return errors;
}

export function vaultPath(config) {
  return expandHome(config.vaultPath);
}

// Each machine gets a stable random id + a friendly name (hostname by default).
export function loadDevice() {
  const existing = readJson(DEVICE_PATH, null);
  if (existing?.id) return existing;
  const device = {
    id: crypto.randomBytes(6).toString('hex'),
    name: os.hostname(),
    platform: `${os.platform()}-${os.arch()}`,
    created: new Date().toISOString(),
  };
  writeJson(DEVICE_PATH, device);
  return device;
}

export function saveDevice(device) {
  writeJson(DEVICE_PATH, device);
  return device;
}
