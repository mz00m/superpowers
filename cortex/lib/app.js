// Shared application layer used by both the HTTP server and the CLI.
// Every operation loads config fresh so edits from either side are seen.

import { loadConfig, saveConfig, loadDevice, saveDevice, vaultPath, collapseHome, DEFAULT_AGENTS, CONFIG_PATH } from './config.js';
import {
  ensureVault, listSkills, listMemory, listDevices, touchDevice, readSkillFiles, writeSkillFile,
  createSkill, deleteSkill, saveMemory, deleteMemory, readMemory,
} from './vault.js';
import {
  scan, adoptSkill, installSkill, uninstallSkill, pullSkill, pushMemory,
  importMemoryFromAgent, exportMemoryText, importMemoryText, conflicts, conflictCandidates,
} from './agents.js';
import { markDistinct, unmarkDistinct, readDistinct, lineDiff } from './similar.js';
import { setProvenance, ORIGINS } from './provenance.js';
import { gitStatus, gitAvailable, sync as gitSync, initGit } from './sync.js';
import fs from 'fs';
import path from 'path';

export function context() {
  const config = loadConfig();
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);   // first run: persist defaults so they're editable
  const vault = ensureVault(vaultPath(config));
  const device = loadDevice();
  return { config, vault, device };
}

export function getState() {
  const { config, vault, device } = context();
  const scanned = scan(config, vault, { device });
  const memory = listMemory(vault);
  const devices = touchDevice(vault, device, {
    agents: scanned.agents.filter(a => a.detected).map(a => a.id),
    vaultPath: collapseHome(vault),
  });
  return {
    device,
    devices,
    config: { ...config, vaultPathResolved: vault },
    storage: { ...config.storage, git: config.storage.mode === 'git' || gitStatus(vault).isRepo ? gitStatus(vault) : null, gitAvailable: gitAvailable() },
    skills: scanned.skills,
    agents: scanned.agents,
    memory,
    counts: {
      skills: scanned.skills.length,
      memory: memory.length,
      unadopted: scanned.agents.reduce((n, a) => n + a.unadopted.length, 0),
      conflicts: conflicts(config, vault).length,
      byOrigin: scanned.skills.reduce((o, s) => (o[s.origin] = (o[s.origin] || 0) + 1, o), {}),
      agentsDetected: scanned.agents.filter(a => a.detected).length,
    },
  };
}

export const ops = {
  scan: () => getState(),

  skill: (name) => { const { vault } = context(); return readSkillFiles(vault, name); },
  createSkill: ({ name, description, body }) => { const { vault } = context(); return createSkill(vault, name, description, body); },
  writeSkillFile: ({ name, path: rel, content }) => { const { vault } = context(); writeSkillFile(vault, name, rel, content); return { ok: true }; },
  deleteSkill: ({ name }) => { const { vault } = context(); deleteSkill(vault, name); return { ok: true }; },
  adopt: ({ agent, name, bundle, replace, as }) => { const { config, vault, device } = context(); return adoptSkill(config, vault, agent, name, { bundle, replace, as, device }); },
  setOrigin: ({ name, origin }) => {
    const { vault } = context();
    if (!ORIGINS.includes(origin)) throw new Error(`origin must be one of ${ORIGINS.join(', ')}`);
    return setProvenance(vault, name, { origin, originOverridden: true });
  },
  conflicts: ({ threshold, agentsOnly } = {}) => {
    const { config, vault } = context();
    return { pairs: conflicts(config, vault, { threshold: threshold ? Number(threshold) : undefined, agentsOnly: !!agentsOnly }), distinct: readDistinct(vault) };
  },
  compare: ({ a, b }) => {
    const { config, vault } = context();
    const cands = conflictCandidates(config, vault);
    const A = cands.find(c => c.key === a), B = cands.find(c => c.key === b);
    if (!A || !B) throw new Error('unknown skill key');
    const read = c => { try { return fs.readFileSync(path.join(c.path, 'SKILL.md'), 'utf8'); } catch { return ''; } };
    const ta = read(A), tb = read(B);
    return { a: { ...A, body: undefined, text: ta }, b: { ...B, body: undefined, text: tb }, diff: lineDiff(ta, tb) };
  },
  markDistinct: ({ a, b, note }) => { const { vault } = context(); return markDistinct(vault, a, b, note); },
  unmarkDistinct: ({ a, b }) => { const { vault } = context(); return unmarkDistinct(vault, a, b); },
  install: ({ name, agent, mode }) => {
    const { config, vault } = context();
    const targets = agent === 'all' ? config.agents.filter(a => a.kind === 'fs' && a.enabled && a.skillsDir).map(a => a.id) : [agent];
    return targets.map(id => ({ agent: id, ...installSkill(config, vault, name, id, mode) }));
  },
  uninstall: ({ name, agent }) => { const { config, vault } = context(); return uninstallSkill(config, vault, name, agent); },
  pull: ({ name, agent }) => { const { config, vault } = context(); return pullSkill(config, vault, name, agent); },

  memory: (id) => { const { vault } = context(); return readMemory(vault, id); },
  saveMemory: (item) => { const { vault, device } = context(); return saveMemory(vault, { ...item, device: item.device || (item.id ? undefined : device.name), agent: item.agent || (item.id ? undefined : 'cortex') }); },
  deleteMemory: ({ id }) => { const { vault } = context(); deleteMemory(vault, id); return { ok: true }; },
  pushMemory: ({ agent }) => {
    const { config, vault, device } = context();
    const targets = agent === 'all' ? config.agents.filter(a => a.kind === 'fs' && a.enabled && a.memoryFiles?.length).map(a => a.id) : [agent];
    return targets.map(id => ({ agent: id, ...pushMemory(config, vault, id, device) }));
  },
  importMemory: ({ agent, text, source, agents }) => {
    const { config, vault, device } = context();
    if (text != null) return importMemoryText(vault, text, { source: source || agent || 'paste', agents, device });
    return importMemoryFromAgent(config, vault, agent, device);
  },
  exportMemory: ({ agent = 'chatgpt', limit } = {}) => { const { vault } = context(); return exportMemoryText(vault, agent, { limit: limit ? Number(limit) : undefined }); },

  sync: () => {
    const { config, vault, device } = context();
    return gitSync(vault, { device, remote: config.storage.gitRemote });
  },
  initGit: ({ remote }) => { const { vault } = context(); return { log: initGit(vault, remote), status: gitStatus(vault) }; },

  config: () => loadConfig(),
  saveConfig: (patch) => {
    const current = loadConfig();
    const next = { ...current, ...patch, storage: { ...current.storage, ...(patch.storage || {}) } };
    if (patch.agents) next.agents = patch.agents;
    saveConfig(next);
    if (next.storage.mode === 'git' && next.storage.gitRemote) initGit(vaultPath(next), next.storage.gitRemote);
    return loadConfig();
  },
  resetAgents: () => { const c = loadConfig(); c.agents = DEFAULT_AGENTS.map(a => ({ ...a })); saveConfig(c); return c; },
  renameDevice: ({ name }) => { const d = loadDevice(); d.name = name; return saveDevice(d); },
  devices: () => { const { vault } = context(); return listDevices(vault); },
  listSkills: () => { const { vault } = context(); return listSkills(vault); },
  listMemory: () => { const { vault } = context(); return listMemory(vault); },
};
