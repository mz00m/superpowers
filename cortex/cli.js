#!/usr/bin/env node
// Cortex CLI. Same operations as the web UI, for scripts and agents.
//   cortex serve                       start the web UI (http://localhost:4747)
//   cortex status                      overview of vault, device, agents
//   cortex skills                      skill x agent matrix
//   cortex skill <name>                print a skill's SKILL.md
//   cortex adopt <agent> <name> [--bundle p] [--replace] [--as new-name]
//   cortex conflicts [--threshold 0.3] identical / same-name / similar skills across vault + agents
//   cortex compare <keyA> <keyB>       side-by-side diff of two skills (keys from `conflicts`)
//   cortex distinct <keyA> <keyB>      mark a pair as intentionally different
//   cortex install <name> [agent|all]  link/copy a vault skill into agent(s)
//   cortex uninstall <name> <agent>
//   cortex memory                      list memory items
//   cortex memory add "<title>" [--body "..."] [--tags a,b] [--agents x,y]
//   cortex memory rm <id>
//   cortex memory push [agent|all]     write memory block into agent memory files
//   cortex memory import <agent>       pull an agent's memory files into the vault
//   cortex memory import --text -      paste text (stdin) as memory items
//   cortex memory export [agent]       plain-text bundle (ChatGPT etc.)
//   cortex sync                        git pull/commit/push the vault
//   cortex config [key value]          show or set config (e.g. storage.mode git)
//   cortex device <name>               rename this device
// Add --json to any command for machine-readable output.

import { ops, getState } from './lib/app.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const args = argv.filter(a => a !== '--json');
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [cmd, ...rest] = positional;

function out(data, pretty) {
  if (json) return console.log(JSON.stringify(data, null, 2));
  if (typeof pretty === 'function') return pretty(data);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

const STATUS_ICON = { linked: '🔗', copied: '📋', diverged: '⚠️', missing: '·', 'foreign-link': '↗', 'broken-link': '✗', unsupported: ' ' };

function readStdin() {
  return new Promise(resolve => { let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s)); });
}

async function main() {
  switch (cmd) {
    case 'serve': {
      const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
      spawn(process.execPath, [server], { stdio: 'inherit', env: { ...process.env, CORTEX_PORT: flag('port') || process.env.CORTEX_PORT || '4747' } });
      return;
    }
    case undefined:
    case 'status': {
      const s = getState();
      return out(s, s => {
        console.log(`Cortex — device "${s.device.name}" (${s.device.id})`);
        console.log(`Vault: ${s.config.vaultPathResolved}  [${s.storage.mode}${s.storage.git?.isRepo ? `, git ${s.storage.git.branch}${s.storage.git.dirty ? `, ${s.storage.git.dirty} uncommitted` : ''}` : ''}]`);
        console.log(`Skills: ${s.counts.skills}   Memory: ${s.counts.memory}   Unadopted: ${s.counts.unadopted}   Devices: ${s.devices.length}`);
        console.log('Agents:');
        for (const a of s.agents) console.log(`  ${a.detected ? '●' : '○'} ${a.name.padEnd(12)} ${a.enabled ? '' : '(disabled) '}${a.kind === 'fs' ? (a.skillsDir || '') : a.notes}`);
      });
    }
    case 'skills': {
      const s = getState();
      return out(s.skills, skills => {
        const agents = s.agents.filter(a => a.kind === 'fs' && a.enabled && a.skillsDir);
        console.log('skill'.padEnd(34) + agents.map(a => a.id.padEnd(13)).join(''));
        for (const sk of skills) console.log(sk.name.padEnd(34) + agents.map(a => (STATUS_ICON[sk.agents[a.id]?.status] || '?').padEnd(13)).join(''));
        const un = s.agents.flatMap(a => a.unadopted.map(u => `${a.id}/${u.name}`));
        if (un.length) console.log(`\nNot in vault yet (cortex adopt <agent> <name>): ${un.join(', ')}`);
      });
    }
    case 'skill': {
      const files = ops.skill(rest[0]);
      if (!files) throw new Error(`no skill "${rest[0]}"`);
      return out(files, f => console.log(f.find(x => x.path === 'SKILL.md')?.content || ''));
    }
    case 'adopt': {
      try {
        return out(ops.adopt({ agent: rest[0], name: rest[1], bundle: flag('bundle'), replace: args.includes('--replace'), as: flag('as') }), r => console.log(r.adopted ? `adopted ${r.name} into vault` : `skipped: ${r.reason}`));
      } catch (err) {
        if (!err.conflict) throw err;
        if (json) { console.log(JSON.stringify({ error: err.message, conflict: err.conflict }, null, 2)); process.exit(2); }
        console.error(`conflict: ${err.message}\n  vault:    ${err.conflict.vault?.files} files, updated ${err.conflict.vault?.updated}\n  incoming: ${err.conflict.incoming?.files} files, updated ${err.conflict.incoming?.updated}\n  -> cortex adopt ${rest[0]} ${rest[1]} --replace   (agent wins)\n  -> cortex adopt ${rest[0]} ${rest[1]} --as ${rest[1]}-${rest[0]}   (keep both)\n  -> cortex compare vault/${rest[1]} ${rest[0]}/${flag('bundle') ? flag('bundle') + '/' : ''}${rest[1]}`);
        process.exit(2);
      }
    }
    case 'conflicts': {
      const r = ops.conflicts({ threshold: flag('threshold'), agentsOnly: args.includes('--agents-only') });
      return out(r, r => {
        if (!r.pairs.length) return console.log('no conflicts found');
        for (const p of r.pairs) console.log(`${p.kind.padEnd(10)} ${String(p.score).padEnd(5)} ${p.a.key}  <->  ${p.b.key}`);
        console.log(`\n${r.pairs.length} pair(s). Resolve with: cortex compare <a> <b> | cortex adopt ... --replace/--as | cortex distinct <a> <b>`);
      });
    }
    case 'compare': {
      const r = ops.compare({ a: rest[0], b: rest[1] });
      return out(r, r => {
        console.log(`--- ${r.a.key} (${r.a.files} files, ${r.a.updated})\n+++ ${r.b.key} (${r.b.files} files, ${r.b.updated})`);
        for (const l of r.diff) console.log(l.t === ' ' ? `  ${l.a}` : l.t === '-' ? `- ${l.a}` : `+ ${l.b}`);
      });
    }
    case 'distinct': return out(ops.markDistinct({ a: rest[0], b: rest[1], note: flag('note') }), () => console.log(`marked distinct: ${rest[0]} / ${rest[1]}`));
    case 'install': return out(ops.install({ name: rest[0], agent: rest[1] || 'all', mode: flag('mode') }), r => r.forEach(x => console.log(`${x.agent}: ${x.status} -> ${x.target}${x.note ? ` (${x.note})` : ''}`)));
    case 'uninstall': return out(ops.uninstall({ name: rest[0], agent: rest[1] }), r => console.log(`removed ${r.target}`));
    case 'sync': return out(ops.sync(), r => r.log.forEach(l => console.log(l)));
    case 'device': return out(ops.renameDevice({ name: rest[0] }), d => console.log(`device is now "${d.name}"`));
    case 'config': {
      if (rest.length >= 2) {
        const [key, value] = rest;
        const patch = {};
        const parts = key.split('.');
        let cur = patch;
        for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = {};
        cur[parts.at(-1)] = value === 'true' ? true : value === 'false' ? false : value;
        ops.saveConfig(patch);
        return out({ key, value }, () => console.log(`set ${key} = ${value}`));
      }
      return out(ops.config());
    }
    case 'memory': {
      const [sub, ...m] = rest;
      switch (sub) {
        case undefined:
        case 'ls': return out(ops.listMemory(), items => items.forEach(i => console.log(`${i.id.padEnd(40)} ${i.scope.padEnd(10)} [${i.tags.join(', ')}] ${i.title}`)));
        case 'add': return out(ops.saveMemory({ title: m[0], body: flag('body') || m[0], tags: flag('tags')?.split(',') || [], agents: flag('agents')?.split(',') || ['all'], scope: flag('scope') }), i => console.log(`saved ${i.id}`));
        case 'rm': return out(ops.deleteMemory({ id: m[0] }), () => console.log(`deleted ${m[0]}`));
        case 'push': return out(ops.pushMemory({ agent: m[0] || 'all' }), r => r.forEach(x => console.log(`${x.agent}: wrote ${x.count} item(s) to ${x.written.join(', ')}`)));
        case 'import': {
          const text = flag('text') !== undefined ? (flag('text') === '-' ? await readStdin() : flag('text')) : undefined;
          return out(ops.importMemory({ agent: m[0], text, source: flag('source') }), r => console.log(`imported ${r.created.length}, skipped ${r.skipped.length} (already imported)`));
        }
        case 'export': return out(ops.exportMemory({ agent: m[0] || 'chatgpt', limit: flag('limit') }), r => console.log(r.text));
        default: throw new Error(`unknown memory command "${sub}"`);
      }
    }
    case 'help': case '--help': case '-h':
      return console.log((await import('fs')).readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    default: throw new Error(`unknown command "${cmd}" (try: cortex help)`);
  }
}

main().catch(err => { console.error(json ? JSON.stringify({ error: err.message }) : `error: ${err.message}`); process.exit(1); });
