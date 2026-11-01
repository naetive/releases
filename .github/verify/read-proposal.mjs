#!/usr/bin/env node
// Read a release proposal as data (doc #320 r3; Security b1). Runs from
// releases main under pull_request_target, never from the pull request: it
// reads the PR's files through the API at the PR's head commit and executes
// nothing from them. Fails on any other path, any extra field, or approval
// files, proposal.json and manifest.json that disagree. Writes only validated
// values to GITHUB_OUTPUT: commit (40 hex), pieces ("kind=version=sha" lines)
// and installers ("name=sha" lines, from manifest.json).
//
// manifest.json (doc #320 r8, doc #319 u1): exactly the whole set, every piece
// as the approval files will be after the merge, the installers' sha256, and a
// serial exactly one above releases main's (1 when main has none). Once main
// has a manifest, every proposal must change it.
//
// env: GH_TOKEN (read-only), REPO, PR (number), HEAD_SHA, BASE_SHA (40 hex)
import fs from 'node:fs';

const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{8}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const APPROVAL = { 'tunnel.json': 'tunnel', 'cli.json': 'cli', 'console.json': 'console' };
const ALLOWED = new Set([...Object.keys(APPROVAL), 'proposal.json', 'manifest.json']);
const PIECE_NAMES = ['tunnel', 'cli', 'console'];
const INSTALLERS = ['install.sh', 'install.ps1'];

const fail = (why) => { console.error(`✗ ${why}`); process.exit(1); };
const exactKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

export function approvalOf(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!exactKeys(j, ['version', 'sha256']) || !VERSION_RE.test(j.version) || !SHA_RE.test(j.sha256)) return null;
  return j;
}

export function proposalOf(text) {
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!exactKeys(j, ['v', 'platform_commit', 'review_thread', 'pieces']) || j.v !== 1) return null;
  if (!COMMIT_RE.test(j.platform_commit) || !THREAD_RE.test(j.review_thread)) return null;
  const kinds = Object.keys(j.pieces || {});
  if (!kinds.length || !kinds.every((k) => ['tunnel', 'cli', 'console'].includes(k))) return null;
  for (const k of kinds) if (!approvalOf(JSON.stringify(j.pieces[k]))) return null;
  return j;
}

export function manifestOf(text) {
  if (typeof text !== 'string' || text.length > 8192) return null;
  let j; try { j = JSON.parse(text); } catch { return null; }
  if (!exactKeys(j, ['v', 'serial', 'rollback', 'platform_commit', 'pieces', 'installers'])) return null;
  if (j.v !== 1 || !Number.isSafeInteger(j.serial) || j.serial < 1 || typeof j.rollback !== 'boolean' || !COMMIT_RE.test(String(j.platform_commit))) return null;
  if (!exactKeys(j.pieces, PIECE_NAMES) || !PIECE_NAMES.every((k) => approvalOf(JSON.stringify(j.pieces[k])))) return null;
  if (!exactKeys(j.installers, INSTALLERS) || !INSTALLERS.every((k) => exactKeys(j.installers[k], ['sha256']) && SHA_RE.test(j.installers[k].sha256))) return null;
  return j;
}

/**
 * files: [{ filename, status }]; read(name) gives its text at the head commit;
 * readBase(name) gives it at releases main (null when it is not there).
 */
export async function check(files, read, readBase = async () => null) {
  if (!files.length) return { error: 'the pull request changes nothing' };
  for (const f of files) {
    if (!ALLOWED.has(f.filename)) return { error: `the pull request changes ${JSON.stringify(f.filename).slice(0, 80)}; a proposal may change only tunnel.json, cli.json, console.json, proposal.json and manifest.json` };
    if (!['added', 'modified'].includes(f.status)) return { error: `${f.filename} is ${f.status}; a proposal only adds or changes files` };
  }
  if (!files.some((f) => f.filename === 'proposal.json')) return { error: 'proposal.json is missing' };
  const baseManifestText = await readBase('manifest.json');
  const baseManifest = baseManifestText === null ? null : manifestOf(baseManifestText);
  if (baseManifestText !== null && !baseManifest) return { error: 'manifest.json on releases main is not a valid manifest' };
  const hasManifest = files.some((f) => f.filename === 'manifest.json');
  if (baseManifest && !hasManifest) return { error: 'releases main has a manifest, so a proposal must change manifest.json too' };
  const proposal = proposalOf(await read('proposal.json'));
  if (!proposal) return { error: 'proposal.json is not a valid proposal' };
  const changed = files.filter((f) => APPROVAL[f.filename]);
  const kinds = new Set(changed.map((f) => APPROVAL[f.filename]));
  if (kinds.size !== Object.keys(proposal.pieces).length || ![...kinds].every((k) => proposal.pieces[k])) return { error: 'proposal.json names other pieces than the files it changes' };
  for (const f of changed) {
    const a = approvalOf(await read(f.filename));
    const kind = APPROVAL[f.filename];
    if (!a) return { error: `${f.filename} is not exactly { version, sha256 }` };
    if (a.version !== proposal.pieces[kind].version || a.sha256 !== proposal.pieces[kind].sha256) return { error: `${f.filename} and proposal.json disagree` };
  }
  let installers = [];
  if (hasManifest) {
    const manifest = manifestOf(await read('manifest.json'));
    if (!manifest) return { error: 'manifest.json is not exactly a manifest' };
    const want = baseManifest ? baseManifest.serial + 1 : 1;
    if (manifest.serial !== want) return { error: `manifest.json has serial ${manifest.serial}; it must be ${want}, one above releases main` };
    if (manifest.platform_commit !== proposal.platform_commit) return { error: 'manifest.json and proposal.json name other platform commits' };
    // Every piece as its approval file will be after the merge: the proposal's, or main's.
    for (const kind of PIECE_NAMES) {
      const name = `${kind}.json`;
      const after = kinds.has(kind) ? proposal.pieces[kind] : approvalOf(String(await readBase(name)));
      if (!after) return { error: `${name} on releases main is missing or not exactly { version, sha256 }, so the set is not complete` };
      if (after.version !== manifest.pieces[kind].version || after.sha256 !== manifest.pieces[kind].sha256) return { error: `manifest.json and ${name} disagree` };
    }
    installers = INSTALLERS.map((k) => `${k}=${manifest.installers[k].sha256}`);
  }
  return { commit: proposal.platform_commit, pieces: [...kinds].sort().map((k) => `${k}=${proposal.pieces[k].version}=${proposal.pieces[k].sha256}`), installers };
}

async function gh(url, accept = 'application/vnd.github+json', { missingOk = false } = {}) {
  const res = await fetch(`https://api.github.com${url}`, { redirect: 'error', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' } });
  if (missingOk && res.status === 404) return null;
  if (!res.ok) fail(`GitHub said ${res.status} for ${url}`);
  return accept.endsWith('raw') ? res.text() : res.json();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { REPO, PR, HEAD_SHA, BASE_SHA } = process.env;
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(REPO)) || !/^\d+$/.test(String(PR)) || !COMMIT_RE.test(String(HEAD_SHA)) || !COMMIT_RE.test(String(BASE_SHA))) fail('bad inputs');
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/repos/${REPO}/pulls/${PR}/files?per_page=100&page=${page}`);
    files.push(...batch.map((f) => ({ filename: f.filename, status: f.status })));
    if (batch.length < 100) break;
  }
  const r = await check(files,
    (name) => gh(`/repos/${REPO}/contents/${encodeURIComponent(name)}?ref=${HEAD_SHA}`, 'application/vnd.github.raw'),
    (name) => gh(`/repos/${REPO}/contents/${encodeURIComponent(name)}?ref=${BASE_SHA}`, 'application/vnd.github.raw', { missingOk: true }));
  if (r.error) fail(r.error);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `commit=${r.commit}\npieces<<EOF\n${r.pieces.join('\n')}\nEOF\ninstallers<<EOF\n${r.installers.join('\n')}\nEOF\n`);
  console.log(`✓ a valid proposal for platform commit ${r.commit}: ${r.pieces.map((p) => p.split('=').slice(0, 2).join(' ')).join(', ')}`);
}
