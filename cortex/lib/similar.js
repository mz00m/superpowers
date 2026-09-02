// Deconfliction: find skills that are the same, share a name, or look alike,
// across the vault and every agent. Pure functions over skill metadata plus a
// small persisted "these are distinct" ledger.

import fs from 'fs';
import path from 'path';

const STOP = new Set(('a an the and or of to in for on with by from as is are be this that it its you your use when '
  + 'use-when when-to trigger triggers also any all into about how what which via one skill skills md file files').split(' '));

export function tokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w)));
}

export function shingles(text, n = 3) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Containment (overlap / smaller set) with a floor so tiny texts can't score
// high by accident. Calibrated on real skill libraries: true look-alikes
// (pdf vs pdf-reading, code-review vs requesting-code-review, chrome-browser vs
// built-in-browser) land at 0.3-0.5; unrelated skills stay under 0.25.
export const DEFAULT_THRESHOLD = 0.3;

function contain(a, b, floor) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(Math.min(a.size, b.size), floor);
}

export function features(c) {
  return { nameT: tokens(c.name), descT: tokens(c.description), bodyT: tokens(c.body), bodyS: shingles(c.body) };
}

export function similarity(a, b, fa = features(a), fb = features(b)) {
  if (a.hash && a.hash === b.hash) return 1;
  const name = jaccard(fa.nameT, fb.nameT);
  const desc = contain(fa.descT, fb.descT, 6);
  const body = contain(fa.bodyS, fb.bodyS, 40);
  const bodyTok = contain(fa.bodyT, fb.bodyT, 40);
  const s = Math.max(0.5 * name + 0.5 * desc, 0.2 * name + 0.35 * desc + 0.25 * body + 0.2 * bodyTok);
  return Math.round(s * 100) / 100;
}

export function pairKey(a, b) {
  return [a, b].sort().join(' :: ');
}

export function distinctFile(vaultDir) { return path.join(vaultDir, '.distinct.json'); }
export function readDistinct(vaultDir) {
  try { return JSON.parse(fs.readFileSync(distinctFile(vaultDir), 'utf8')); } catch { return {}; }
}
export function markDistinct(vaultDir, keyA, keyB, note = '') {
  const d = readDistinct(vaultDir);
  d[pairKey(keyA, keyB)] = { at: new Date().toISOString(), note };
  fs.writeFileSync(distinctFile(vaultDir), JSON.stringify(d, null, 2) + '\n');
  return d;
}
export function unmarkDistinct(vaultDir, keyA, keyB) {
  const d = readDistinct(vaultDir);
  delete d[pairKey(keyA, keyB)];
  fs.writeFileSync(distinctFile(vaultDir), JSON.stringify(d, null, 2) + '\n');
  return d;
}

// candidates: [{ key, name, description, body, hash, where: 'vault' | agentId, ... }]
// Returns groups sorted by severity: identical > same-name > similar.
export function findConflicts(candidates, { threshold = DEFAULT_THRESHOLD, distinct = {} } = {}) {
  const pairs = [];
  const feats = candidates.map(features);   // compute once, not per pair
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (distinct[pairKey(a.key, b.key)]) continue;
      const score = similarity(a, b, feats[i], feats[j]);
      let kind = null;
      if (a.hash && a.hash === b.hash) kind = 'identical';
      else if (a.name === b.name) kind = 'same-name';
      else if (score >= threshold) kind = 'similar';
      if (kind) pairs.push({ kind, score, a: strip(a), b: strip(b) });
    }
  }
  const rank = { identical: 0, 'same-name': 1, similar: 2 };
  return pairs.sort((x, y) => rank[x.kind] - rank[y.kind] || y.score - x.score);
}

function strip(c) { const { body, ...rest } = c; return rest; }

// Minimal line diff (LCS) for side-by-side review in the UI/CLI.
export function lineDiff(aText, bText) {
  const a = String(aText || '').split('\n'), b = String(bText || '').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', a: a[i], b: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', a: a[i] }); i++; }
    else { out.push({ t: '+', b: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', a: a[i++] });
  while (j < m) out.push({ t: '+', b: b[j++] });
  return out;
}
