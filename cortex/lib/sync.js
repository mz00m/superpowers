// Remote storage via git. The vault is just a folder, so "folder" mode
// (iCloud/Dropbox/Syncthing) needs nothing from us; "git" mode gets a
// one-button pull/commit/push.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

function git(vaultDir, args, opts = {}) {
  return execFileSync('git', args, { cwd: vaultDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryGit(vaultDir, args) {
  try { return { ok: true, out: git(vaultDir, args) }; }
  catch (err) { return { ok: false, out: (err.stderr || err.stdout || err.message || '').toString().trim() }; }
}

export function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export function gitStatus(vaultDir) {
  if (!fs.existsSync(path.join(vaultDir, '.git'))) return { isRepo: false };
  const br = tryGit(vaultDir, ['symbolic-ref', '--short', 'HEAD']);
  const branch = br.ok && br.out ? br.out : 'main';
  const hasCommits = tryGit(vaultDir, ['rev-parse', '--verify', 'HEAD']).ok;
  const remote = tryGit(vaultDir, ['remote', 'get-url', 'origin']).out;
  const dirty = tryGit(vaultDir, ['status', '--porcelain']).out.split('\n').filter(Boolean).length;
  let ahead = 0, behind = 0;
  const ab = tryGit(vaultDir, ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`]);
  if (ab.ok) [ahead, behind] = ab.out.split(/\s+/).map(Number);
  const last = tryGit(vaultDir, ['log', '-1', '--format=%h %s (%cr)']).out;
  return { isRepo: true, branch, hasCommits, remote: remote || '', dirty, ahead, behind, last: last || '' };
}

export function initGit(vaultDir, remote) {
  const log = [];
  if (!fs.existsSync(path.join(vaultDir, '.git'))) { log.push(git(vaultDir, ['init'])); }
  const gi = path.join(vaultDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.DS_Store\n');
  if (remote) {
    const cur = tryGit(vaultDir, ['remote', 'get-url', 'origin']);
    if (!cur.ok) log.push(git(vaultDir, ['remote', 'add', 'origin', remote]) || `added origin ${remote}`);
    else if (cur.out !== remote) log.push(git(vaultDir, ['remote', 'set-url', 'origin', remote]) || `origin -> ${remote}`);
  }
  return log;
}

// add -> commit -> pull --rebase -> push. Never destructive: a rebase conflict
// is reported and left for the user to resolve.
export function sync(vaultDir, { device, remote } = {}) {
  const log = [];
  if (!fs.existsSync(path.join(vaultDir, '.git'))) log.push(...initGit(vaultDir, remote));
  let status = gitStatus(vaultDir);
  if (status.dirty) {
    git(vaultDir, ['add', '-A']);
    const msg = `sync from ${device?.name || 'device'}`;
    const r = tryGit(vaultDir, ['-c', 'user.name=Cortex', '-c', 'user.email=cortex@localhost', 'commit', '-m', msg]);
    log.push(r.ok ? `committed ${status.dirty} change(s)` : r.out);
  } else {
    log.push('nothing to commit');
  }
  status = gitStatus(vaultDir);
  if (!status.hasCommits) { log.push('nothing committed yet'); return { ok: true, log }; }
  if (status.remote || remote) {
    const branch = status.branch;
    const pull = tryGit(vaultDir, ['pull', '--rebase', 'origin', branch]);
    log.push(pull.ok ? `pulled: ${pull.out.split('\n').pop() || 'ok'}` : `pull failed: ${pull.out}`);
    if (!pull.ok && /conflict/i.test(pull.out)) {
      return { ok: false, log, conflict: true };
    }
    const push = tryGit(vaultDir, ['push', '-u', 'origin', branch]);
    log.push(push.ok ? 'pushed' : `push failed: ${push.out}`);
    return { ok: push.ok, log };
  }
  log.push('no remote configured; committed locally only');
  return { ok: true, log };
}
