// Where did a skill come from, and where is it now?
//
// origin  — personal | builtin | plugin. Auto-classified when a skill is
//           found, overridable per skill.
// source  — the agent, device and path it was adopted from.
// seen    — per device: which agents have it, last time that device scanned.
// All of it lives in <vault>/manifest.json so it travels with the vault.

import fs from 'fs';
import path from 'path';
import { expandHome } from './config.js';

export const ORIGINS = ['personal', 'builtin', 'plugin'];

// Paths that hold vendor-shipped skills. Anything found under these is builtin.
export const BUILTIN_ROOTS = [
  '/mnt/skills',                    // Claude app / Cowork built-ins
  '~/.claude/plugins',              // Claude Code plugin cache
  '~/.codex/superpowers',
  '~/.config/opencode/superpowers',
];

export function classifyOrigin({ realPath, bundle, license, agentSkillsDir, insideVault = false }) {
  if (license && /proprietary|anthropic|openai/i.test(license)) return 'builtin';
  const real = realPath || '';
  for (const root of BUILTIN_ROOTS) {
    const r = expandHome(root);
    if (real === r || real.startsWith(r + path.sep)) return 'builtin';
  }
  // A skill reached through a bundle that resolves outside the agent's own
  // skills dir (a symlinked repo checkout) is a plugin; a bundle that lives
  // inside it (e.g. ~/.claude/skills/synced/<id>/) is the user's own.
  if (bundle && agentSkillsDir && !real.startsWith(agentSkillsDir + path.sep) && !insideVault) return 'plugin';
  return 'personal';
}

export function manifestFile(vaultDir) { return path.join(vaultDir, 'manifest.json'); }

export function readManifest(vaultDir) {
  try { return JSON.parse(fs.readFileSync(manifestFile(vaultDir), 'utf8')); } catch { return { version: 1, skills: {} }; }
}

export function writeManifest(vaultDir, m) {
  fs.writeFileSync(manifestFile(vaultDir), JSON.stringify(m, null, 2) + '\n');
  return m;
}

export function getProvenance(vaultDir, name) {
  return readManifest(vaultDir).skills[name] || null;
}

export function setProvenance(vaultDir, name, patch) {
  const m = readManifest(vaultDir);
  m.skills[name] = { ...(m.skills[name] || {}), ...patch };
  writeManifest(vaultDir, m);
  return m.skills[name];
}

export function removeProvenance(vaultDir, name) {
  const m = readManifest(vaultDir);
  delete m.skills[name];
  writeManifest(vaultDir, m);
}

export function renameProvenance(vaultDir, from, to) {
  const m = readManifest(vaultDir);
  if (m.skills[from]) { m.skills[to] = m.skills[from]; delete m.skills[from]; writeManifest(vaultDir, m); }
}

// Record what this device sees for every vault skill. `presence` is
// { skillName: [agentId, ...] } for agents that currently have the skill.
export function recordSeen(vaultDir, device, presence) {
  const m = readManifest(vaultDir);
  const at = new Date().toISOString();
  let changed = false;
  for (const [name, agents] of Object.entries(presence)) {
    const entry = (m.skills[name] ||= {});
    const seen = (entry.seen ||= {});
    const prev = seen[device.id];
    const next = { device: device.name, agents: [...agents].sort(), at };
    if (!prev || prev.device !== next.device || prev.agents.join() !== next.agents.join()) { seen[device.id] = next; changed = true; }
    else prev.at = at;
  }
  // Skills gone from the vault drop out of the manifest.
  for (const name of Object.keys(m.skills)) if (!(name in presence)) { delete m.skills[name]; changed = true; }
  if (changed) writeManifest(vaultDir, m);
  else fs.existsSync(manifestFile(vaultDir)) || writeManifest(vaultDir, m);
  return m;
}
