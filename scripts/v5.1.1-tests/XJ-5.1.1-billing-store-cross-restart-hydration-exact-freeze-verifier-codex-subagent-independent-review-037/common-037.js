'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-subagent-independent-review-037';
const TASK35 = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035';
const TASK33 = 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033';
const RUN35 = 'run-035-20260827063639-5a43423c511376';
const RUN33 = 'run-033-20260827041958-3ec36f2a3a4bc9';
const EXPECTED = Object.freeze({
  card37: '734069022e11368e2dcd1d0224cec3b42befb35bc5ecccffb94e596ef0493d85',
  card35: '7365394966f622c218f02515e5ebddbbc22f171d8fdbe3c04281a8cffa0bb06b',
  report35: '81517985b47938e6ae730d5daca271a8f4b9a7d0e566a734855b6c9998d17dff',
  freeze33: '22e6cb8942ad4f86afb9e55dd58129a984da9566bef003f79ce1ae0dc1f9d13e',
  store: '84ded0e7eaf3b8de98a727d5f1671ed42b9ea27ae7ea27caa644e8ef20cf768d',
  protected: 'd52755d4aed2e9e8d8a4cff316b3b5f8b2d937b33aa766523998006daa8b336c',
  aggregate35: '1d438e41037ff1953ef1ad448c711c56f01094eb980669664f5efd6141e787f6',
  aggregate33: 'aa82b8b788c6f4c462bd8816e17f12ff25448167c9c1753f09c1e7a76d23f315'
});
const PROJECT = path.resolve(__dirname, '../../..');
const S37 = path.resolve(__dirname);
const Q37 = path.join(PROJECT, 'qa/task-scratch', TASK);
const REVIEW37 = path.join(PROJECT, 'qa/agent-reviews', TASK + '.md');
const CARD37 = path.join(PROJECT, 'docs/agent-coordination/v5.1.1/tasks', TASK + '.md');
const CARD35 = path.join(PROJECT, 'docs/agent-coordination/v5.1.1/tasks', TASK35 + '.md');
const REPORT35 = path.join(PROJECT, 'qa/agent-reviews', TASK35 + '.md');
const S35 = path.join(PROJECT, 'scripts/v5.1.1-tests', TASK35);
const Q35 = path.join(PROJECT, 'qa/task-scratch', TASK35);
const B35 = path.join(Q35, 'binding', RUN35);
const S33 = path.join(PROJECT, 'scripts/v5.1.1-tests', TASK33);
const Q33 = path.join(PROJECT, 'qa/task-scratch', TASK33);
const E33 = path.join(Q33, 'evidence', RUN33);
const C33 = path.join(Q33, 'candidate', RUN33);
const CARD33 = path.join(PROJECT, 'docs/agent-coordination/v5.1.1/tasks', TASK33 + '.md');
const FREEZE33 = path.join(S33, 'freeze-verifier.js');
const COMMON33 = path.join(S33, 'common.js');
const STORE = path.join(PROJECT, 'app/js/store.js');
const LOCKS = path.join(PROJECT, 'docs/agent-coordination/v5.1.1/write-locks.json');
const FILES35 = path.join(B35, 'final-binding-files-035.json');
const MANIFEST35 = path.join(B35, 'final-binding-manifest-035.json');
const KINDS = Object.freeze({ 'evidence-file': 1608, 'harness-source': 10, 'freeze-self': 3, 'candidate-file': 2, card: 2, store: 1, 'protected-sha': 1 });
const HARNESS = Object.freeze(['common.js', 'fixture-electron.js', 'store-fixture.html', 'phase-worker.js', 'runner.js', 'expected-red.js', 'verifier.js', 'audit.js', 'freeze-verifier.js', 'expected-red.json']);

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function fileSha(p) { return sha(fs.readFileSync(p)); }
function stat(p) { return fs.statSync(p); }
function bytes(p) { return stat(p).size; }
function utc() { return new Date().toISOString(); }
function json(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
function ensure(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function norm(p) { return path.resolve(p); }
function same(a, b) { return norm(a).toLowerCase() === norm(b).toLowerCase(); }
function contained(root, candidate, allowRoot) {
  const rel = path.relative(norm(root), norm(candidate));
  if ((!allowRoot && !rel) || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('path escapes allowed root: ' + candidate);
  return norm(candidate);
}
function safeLabel(label) {
  if (typeof label !== 'string' || !label || label.includes('..') || path.isAbsolute(label) || label.includes('\\')) throw new Error('unsafe label: ' + label);
  return label.split('/').join(path.sep);
}
function noLink(p, root) {
  const info = fs.lstatSync(p);
  if (info.isSymbolicLink()) throw new Error('symlink/junction rejected: ' + p);
  const realP = fs.realpathSync.native(p);
  const realRoot = fs.realpathSync.native(root);
  contained(realRoot, realP, same(realRoot, realP));
  return { path: norm(p), realpath: realP, bytes: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
}
function fileRecord(p, root) { const item = noLink(p, root); return Object.assign(item, { sha256: fileSha(p) }); }
function aggregate(entries) {
  const sorted = entries.slice().sort((a, b) => a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind.localeCompare(b.kind));
  const input = sorted.map((e) => ({ kind: e.kind, label: e.label, sha256: String(e.sha256).toLowerCase(), bytes: e.bytes }));
  return { input, hash: sha(Buffer.from(JSON.stringify(input))), sorted };
}
function expectedSource(entry) {
  const rawLabel = String(entry.label);
  const label = safeLabel(rawLabel);
  let expected;
  if (entry.kind === 'evidence-file') expected = path.join(E33, label.slice('evidence'.length + 1));
  else if (entry.kind === 'harness-source') expected = path.join(S33, label.slice('harness'.length + 1));
  else if (entry.kind === 'freeze-self') expected = path.join(Q35, label);
  else if (entry.kind === 'candidate-file') expected = path.join(C33, label.slice('candidate'.length + 1));
  else if (entry.kind === 'card') expected = rawLabel === 'card/033' ? CARD33 : CARD35;
  else if (entry.kind === 'store') expected = STORE;
  else if (entry.kind === 'protected-sha') return 'constant:protected-files-manifest-sha256';
  else throw new Error('unexpected entry kind: ' + entry.kind);
  if (!same(entry.sourcePath, expected)) throw new Error('entry source identity mismatch: ' + entry.kind + '/' + entry.label);
  return expected;
}
function validateEntryDoc(doc) {
  if (!doc || doc.taskId !== TASK35 || doc.runId !== RUN35 || doc.entryCount !== 1627 || String(doc.aggregateSha256).toLowerCase() !== EXPECTED.aggregate35 || !Array.isArray(doc.entries) || doc.entries.length !== 1627) throw new Error('035 final-binding-files identity invalid');
  const counts = {};
  const seen = new Set();
  for (const e of doc.entries) {
    if (!Object.hasOwn(KINDS, e.kind)) throw new Error('unapproved kind: ' + e.kind);
    const key = e.kind + '|' + e.label;
    if (seen.has(key)) throw new Error('duplicate entry: ' + key);
    seen.add(key); counts[e.kind] = (counts[e.kind] || 0) + 1;
    safeLabel(e.label);
    if (!/^[0-9a-f]{64}$/i.test(String(e.sha256)) || !Number.isInteger(e.bytes) || e.bytes < 0) throw new Error('invalid entry digest: ' + key);
    expectedSource(e);
  }
  for (const [kind, count] of Object.entries(KINDS)) if (counts[kind] !== count) throw new Error('entry class count mismatch ' + kind + ': ' + counts[kind]);
  const actual = aggregate(doc.entries);
  if (actual.hash !== EXPECTED.aggregate35 || actual.hash !== String(doc.aggregateSha256).toLowerCase()) throw new Error('035 canonical aggregate mismatch');
  return actual;
}
function validateManifest(manifest, doc) {
  if (!manifest || manifest.taskId !== TASK35 || manifest.runId !== RUN35 || manifest.entryCount !== 1627 || String(manifest.aggregateSha256).toLowerCase() !== EXPECTED.aggregate35 || manifest.selfReferenceExcluded !== true) throw new Error('035 final-binding-manifest identity invalid');
  for (const [kind, count] of Object.entries(KINDS)) if (!manifest.objects || manifest.objects[kind] !== count) throw new Error('manifest class mismatch: ' + kind);
  const flags = manifest.flags || {};
  if (flags.createdLocal !== true || flags.releaseReady !== false || flags.publishAuthorized !== false || flags.released !== false) throw new Error('manifest flags invalid');
  if (!manifest.metadata || String(manifest.metadata['035-card-sha']).toLowerCase() !== EXPECTED.card35 || String(manifest.metadata['store-sha']).toLowerCase() !== EXPECTED.store || String(manifest.metadata['protected-manifest-sha']).toLowerCase() !== EXPECTED.protected || String(manifest.metadata['033-aggregate']).toLowerCase() !== EXPECTED.aggregate33) throw new Error('manifest constants invalid');
  if (String(doc.aggregateSha256).toLowerCase() !== String(manifest.aggregateSha256).toLowerCase()) throw new Error('files/manifest aggregate disagreement');
}
function treeMeta(root) {
  if (!fs.existsSync(root)) return { root: norm(root), missing: true, rows: [] };
  const rows = [];
  function walk(dir, rel) {
    const d = fs.lstatSync(dir);
    if (d.isSymbolicLink()) throw new Error('symlink/junction rejected in protected tree: ' + dir);
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name); const next = rel ? rel + '/' + name : name; const x = fs.lstatSync(abs);
      if (x.isSymbolicLink()) throw new Error('symlink/junction rejected in protected tree: ' + abs);
      rows.push({ rel: next, type: x.isDirectory() ? 'dir' : x.isFile() ? 'file' : 'other', bytes: x.size, mtimeMs: x.mtimeMs, ctimeMs: x.ctimeMs });
      if (x.isDirectory()) walk(abs, next);
    }
  }
  walk(root, '');
  return { root: norm(root), missing: false, rows };
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function lifecycle(state, detail) {
  const claimPath = path.join(Q37, 'EXECUTOR_CLAIM.json'); const leasePath = path.join(Q37, 'LEASE.json');
  const claim = json(claimPath); const lease = json(leasePath); const event = { state, utc: utc(), detail: detail || null };
  claim.lifecycle = Array.isArray(claim.lifecycle) ? claim.lifecycle.concat([event]) : [event];
  claim.status = state; lease.status = state; lease.updatedUtc = event.utc; writeJson(claimPath, claim); writeJson(leasePath, lease);
}
function primaryInputScan() {
  const card37 = fileRecord(CARD37, path.dirname(CARD37));
  const card35 = fileRecord(CARD35, path.dirname(CARD35));
  const report35 = fileRecord(REPORT35, path.dirname(REPORT35));
  const freeze33 = fileRecord(FREEZE33, S33);
  const common33 = fileRecord(COMMON33, S33);
  const store = fileRecord(STORE, path.dirname(STORE));
  const locks = fileRecord(LOCKS, path.dirname(LOCKS));
  const lockDoc = json(LOCKS);
  if (card37.sha256 !== EXPECTED.card37 || card35.sha256 !== EXPECTED.card35 || report35.sha256 !== EXPECTED.report35 || freeze33.sha256 !== EXPECTED.freeze33 || freeze33.bytes !== 9242 || store.sha256 !== EXPECTED.store || String(lockDoc.protected_files_manifest_sha256 || '').toLowerCase() !== EXPECTED.protected) throw new Error('task-card/protected source fingerprint mismatch');
  const docs = { files: json(FILES35), manifest: json(MANIFEST35) };
  const a = validateEntryDoc(docs.files); validateManifest(docs.manifest, docs.files);
  const actualEntries = [];
  for (const e of docs.files.entries) {
    if (e.kind === 'protected-sha') { actualEntries.push(Object.assign({}, e, { sha256: EXPECTED.protected, bytes: 64 })); continue; }
    const source = expectedSource(e); const root = e.kind === 'evidence-file' ? E33 : e.kind === 'harness-source' ? S33 : e.kind === 'freeze-self' ? Q35 : e.kind === 'candidate-file' ? C33 : e.kind === 'card' ? path.dirname(source) : path.dirname(source);
    noLink(source, root); const actual = { sha256: fileSha(source), bytes: bytes(source) };
    if (actual.sha256 !== String(e.sha256).toLowerCase() || actual.bytes !== e.bytes) throw new Error('source entry drift: ' + e.kind + '/' + e.label);
    actualEntries.push(Object.assign({}, e, actual));
  }
  const ag = aggregate(actualEntries);
  if (ag.hash !== EXPECTED.aggregate35) throw new Error('independent 1627 aggregate mismatch');
  return { docs, aggregate: ag, inputs: { card37, card35, report35, freeze33, common33, store, locks }, actualEntries };
}
function copyExact(source, target, root) { noLink(source, root); ensure(path.dirname(target)); fs.copyFileSync(source, target); if (fileSha(source) !== fileSha(target) || bytes(source) !== bytes(target)) throw new Error('copy changed bytes: ' + source); }
function clonePath(root, label) { return contained(path.join(root, 'entries'), path.join(root, 'entries', safeLabel(label))); }
function tripletSource(tool) { return path.join(Q35, 'self', tool); }
function copyTriplet(root, sourceDir, rel) { for (const n of ['stdout.txt', 'stderr.txt', 'meta.json']) copyExact(path.join(sourceDir, n), path.join(root, 'support', rel, n), sourceDir); }
function buildClone(cloneRoot) {
  if (fs.existsSync(cloneRoot)) throw new Error('clone root already exists: ' + cloneRoot);
  const scan = primaryInputScan();
  ensure(cloneRoot);
  for (const e of scan.docs.files.entries) if (e.kind !== 'protected-sha') copyExact(expectedSource(e), clonePath(cloneRoot, e.label), e.kind === 'evidence-file' ? E33 : e.kind === 'harness-source' ? S33 : e.kind === 'freeze-self' ? Q35 : e.kind === 'candidate-file' ? C33 : path.dirname(expectedSource(e)));
  writeJson(path.join(cloneRoot, 'binding', 'final-binding-files-035.json'), scan.docs.files);
  writeJson(path.join(cloneRoot, 'binding', 'final-binding-manifest-035.json'), scan.docs.manifest);
  for (const tool of ['exact-freeze-runner', 'freeze-verifier', 'final-binding-builder', 'final-binding-verifier', 'final-binding-audit', 'expected-red-035']) copyTriplet(cloneRoot, tripletSource(tool), '035-self/' + tool);
  copyTriplet(cloneRoot, path.join(Q35, 'candidate-isolation', RUN33, 'self', 'freeze-verifier'), '035-child-freeze');
  copyExact(path.join(S35, 'candidate-output-redirect-hook.js'), path.join(cloneRoot, 'support', 'hook', 'candidate-output-redirect-hook.js'), S35);
  const baseline = {
    schema: 'xj-037-input-baseline-v1', taskId: TASK, createdUtc: utc(), aggregate35: scan.aggregate.hash, entryCount: scan.actualEntries.length,
    inputs: scan.inputs, entries: scan.actualEntries.map((e) => ({ kind: e.kind, label: e.label, sourcePath: e.sourcePath, sha256: e.sha256, bytes: e.bytes })),
    treeMetadata: { root33: treeMeta(Q33), root35: treeMeta(Q35), root36: treeMeta(path.join(PROJECT, 'qa/task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-no-context-independent-review-036')) },
    gitStart: spawnSync('git', ['-C', PROJECT, 'status', '--short'], { encoding: 'utf8', shell: false }).stdout
  };
  writeJson(path.join(cloneRoot, 'state', 'input-baseline.json'), baseline);
  writeJson(path.join(cloneRoot, 'state', 'clone.json'), { taskId: TASK, sourceTaskId: TASK35, sourceRunId: RUN35, cloneRoot: norm(cloneRoot), createdUtc: utc(), sourceAggregate: scan.aggregate.hash, cloneEntryCount: scan.actualEntries.length });
  return { cloneRoot: norm(cloneRoot), entryCount: scan.actualEntries.length, aggregate: scan.aggregate.hash };
}
function requireCloneFile(root, rel) { const p = contained(root, path.join(root, rel)); if (!fs.existsSync(p)) throw new Error('clone file missing: ' + rel); noLink(p, root); return p; }
function checkRawMeta(dir, tool, expectedSourceDir, required) {
  const metaP = requireCloneFile(dir, 'meta.json'); const stdoutP = requireCloneFile(dir, 'stdout.txt'); const stderrP = requireCloneFile(dir, 'stderr.txt'); const meta = json(metaP);
  if (meta.tool !== tool || meta.exitCode !== 0 || meta.verdict !== 'PASS') throw new Error('self triplet failed: ' + tool);
  if (meta.taskId !== TASK35 || meta.runId !== RUN35) throw new Error('self triplet task/run mismatch: ' + tool);
  if (!same(meta.stdoutPath, path.join(expectedSourceDir, 'stdout.txt')) || !same(meta.stderrPath, path.join(expectedSourceDir, 'stderr.txt')) || !same(meta.metaPath, path.join(expectedSourceDir, 'meta.json'))) throw new Error('self triplet raw path mismatch: ' + tool);
  if (meta.cwd !== PROJECT || !Array.isArray(meta.argv) || !path.isAbsolute(meta.argv[0]) || !meta.startUtc || !meta.endUtc || Date.parse(meta.endUtc) < Date.parse(meta.startUtc)) throw new Error('self triplet runtime fields invalid: ' + tool);
  if (meta.stdoutSha256 !== fileSha(stdoutP) || meta.stderrSha256 !== fileSha(stderrP) || meta.stdoutBytes !== bytes(stdoutP) || meta.stderrBytes !== bytes(stderrP)) throw new Error('self triplet raw digest mismatch: ' + tool);
  const markers = JSON.stringify(meta).toLowerCase(); if (markers.includes('replica') || markers.includes('equivalent') || markers.includes('executed:false')) throw new Error('forbidden source marker: ' + tool);
  for (const [k, v] of Object.entries(required || {})) if (meta[k] !== v) throw new Error('self triplet required field mismatch ' + tool + '/' + k);
  return meta;
}
function verifyFreeze(root, manifest) {
  const parentDir = path.join(root, 'support/035-self/freeze-verifier'); const parent = checkRawMeta(parentDir, 'freeze-verifier', path.join(Q35, 'self/freeze-verifier'));
  if (!same(parent.capturedFrom, FREEZE33) || !Array.isArray(parent.argv) || !same(parent.argv[0], FREEZE33) || parent.executedSourceSha256 !== EXPECTED.freeze33 || parent.executedSourceBytes !== 9242 || parent.sourceByteIdentical !== true || parent.executedCommonSha256 !== fileSha(COMMON33)) throw new Error('exact original freeze identity invalid');
  const hookP = path.join(root, 'support/hook/candidate-output-redirect-hook.js'); requireCloneFile(root, 'support/hook/candidate-output-redirect-hook.js');
  const expectedHook = path.join(S35, 'candidate-output-redirect-hook.js');
  if (!same(parent.hookPath, expectedHook) || parent.hookSha256 !== fileSha(hookP) || parent.hookBytes !== bytes(hookP) || parent.hookSha256 !== fileSha(expectedHook) || parent.hookBytes !== bytes(expectedHook)) throw new Error('redirect hook binding invalid');
  const expectedRedirect = path.join(Q35, 'candidate-isolation', RUN33);
  if (!same(parent.redirectRoot, expectedRedirect) || String(parent.redirectRoot).toLowerCase().includes('continuation-033') || String(parent.redirectRoot).toLowerCase().includes('034')) throw new Error('redirect root not isolated to 035');
  if (!parent.mapping || !same(parent.mapping.prefixBefore, C33) || !same(parent.mapping.prefixAfter, expectedRedirect) || !String(parent.mapping.scope).includes('only')) throw new Error('redirect mapping invalid');
  const child = checkRawMeta(path.join(root, 'support/035-child-freeze'), 'freeze-verifier', path.join(Q35, 'candidate-isolation', RUN33, 'self/freeze-verifier'));
  if (!Array.isArray(child.argv) || !same(child.argv[0], FREEZE33)) throw new Error('child raw did not execute original source');
  const parentStdout = fs.readFileSync(path.join(parentDir, 'stdout.txt'), 'utf8'); const line = parentStdout.split(/\r?\n/).find((x) => x.includes('freeze-summary'));
  let summary; try { summary = JSON.parse(line); } catch (_) { throw new Error('freeze summary raw missing/invalid'); }
  if (summary.verdict !== 'PASS' || summary.fileCount !== 1608 || String(summary.aggregateSha256).toLowerCase() !== EXPECTED.aggregate33) throw new Error('freeze summary content invalid');
  const mf = manifest.freezeCapture || {};
  for (const key of ['tool', 'capturedFrom', 'executedSourceSha256', 'executedSourceBytes', 'sourceByteIdentical', 'hookPath', 'hookSha256', 'hookBytes', 'redirectRoot', 'exitCode', 'verdict']) if (JSON.stringify(mf[key]) !== JSON.stringify(parent[key])) throw new Error('manifest freeze field mismatch: ' + key);
}
function verifySourceNow(baseline) {
  const scan = primaryInputScan();
  for (const key of Object.keys(baseline.inputs)) if (JSON.stringify(scan.inputs[key]) !== JSON.stringify(baseline.inputs[key])) throw new Error('protected input drift: ' + key);
  const nowTrees = { root33: treeMeta(Q33), root35: treeMeta(Q35), root36: treeMeta(path.join(PROJECT, 'qa/task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-no-context-independent-review-036')) };
  for (const key of Object.keys(nowTrees)) if (!sameJson(nowTrees[key], baseline.treeMetadata[key])) throw new Error('protected root metadata drift: ' + key);
  return scan;
}
function verifyClone(root, options) {
  root = norm(root); noLink(root, path.dirname(root));
  const state = json(requireCloneFile(root, 'state/input-baseline.json'));
  const docs = { files: json(requireCloneFile(root, 'binding/final-binding-files-035.json')), manifest: json(requireCloneFile(root, 'binding/final-binding-manifest-035.json')) };
  validateEntryDoc(docs.files); validateManifest(docs.manifest, docs.files);
  const actual = [];
  for (const e of docs.files.entries) {
    if (e.kind === 'protected-sha') { actual.push(Object.assign({}, e, { sha256: EXPECTED.protected, bytes: 64 })); continue; }
    const p = clonePath(root, e.label); noLink(p, path.join(root, 'entries')); const digest = { sha256: fileSha(p), bytes: bytes(p) };
    if (digest.sha256 !== String(e.sha256).toLowerCase() || digest.bytes !== e.bytes) throw new Error('clone entry digest mismatch: ' + e.kind + '/' + e.label);
    actual.push(Object.assign({}, e, digest));
  }
  const ag = aggregate(actual); if (ag.hash !== EXPECTED.aggregate35) throw new Error('clone aggregate mismatch');
  for (const tool of ['exact-freeze-runner', 'final-binding-builder', 'final-binding-verifier', 'final-binding-audit', 'expected-red-035']) checkRawMeta(path.join(root, 'support/035-self', tool), tool, tripletSource(tool));
  verifyFreeze(root, docs.manifest);
  if (!options || options.checkSources !== false) verifySourceNow(state);
  return { taskId: TASK, cloneRoot: root, entryCount: actual.length, aggregateSha256: ag.hash, verdict: 'PASS' };
}
function capture(out, tool, run) {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('fresh raw directory required: ' + out);
  ensure(out); const startUtc = utc(); let result; let error = null;
  try { result = run(); } catch (e) { error = e; }
  const endUtc = utc(); const stdout = error ? '' : JSON.stringify(result) + '\n'; const stderr = error ? JSON.stringify({ type: tool + '-error', message: String(error.message || error), stack: String(error.stack || '') }) + '\n' : '';
  const stdoutP = path.join(out, 'stdout.txt'); const stderrP = path.join(out, 'stderr.txt'); fs.writeFileSync(stdoutP, stdout); fs.writeFileSync(stderrP, stderr);
  const meta = { taskId: TASK, tool, command: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(), startUtc, endUtc, invocationId: crypto.randomBytes(12).toString('hex'), exitCode: error ? 1 : 0, verdict: error ? 'FAIL' : 'PASS', stdoutPath: norm(stdoutP), stderrPath: norm(stderrP), metaPath: norm(path.join(out, 'meta.json')), stdoutSha256: fileSha(stdoutP), stderrSha256: fileSha(stderrP), stdoutBytes: bytes(stdoutP), stderrBytes: bytes(stderrP) };
  writeJson(path.join(out, 'meta.json'), meta); return { exitCode: meta.exitCode, stdout, stderr, meta, result };
}
function checkCaptured(out, expectedExit) {
  const metaP = path.join(out, 'meta.json'); const stdoutP = path.join(out, 'stdout.txt'); const stderrP = path.join(out, 'stderr.txt');
  if (!fs.existsSync(metaP) || !fs.existsSync(stdoutP) || !fs.existsSync(stderrP)) throw new Error('raw triplet missing: ' + out);
  const m = json(metaP); if (m.exitCode !== expectedExit || m.stdoutSha256 !== fileSha(stdoutP) || m.stderrSha256 !== fileSha(stderrP) || m.stdoutBytes !== bytes(stdoutP) || m.stderrBytes !== bytes(stderrP) || !same(m.stdoutPath, stdoutP) || !same(m.stderrPath, stderrP)) throw new Error('raw triplet invalid: ' + out); return m;
}
module.exports = { TASK, TASK35, TASK33, RUN35, RUN33, EXPECTED, PROJECT, S37, Q37, REVIEW37, CARD37, CARD35, REPORT35, S35, Q35, B35, S33, Q33, E33, C33, CARD33, FREEZE33, COMMON33, STORE, LOCKS, FILES35, MANIFEST35, KINDS, HARNESS, sha, fileSha, bytes, utc, json, writeJson, ensure, norm, same, contained, safeLabel, noLink, fileRecord, aggregate, expectedSource, primaryInputScan, treeMeta, sameJson, lifecycle, buildClone, verifyClone, verifySourceNow, capture, checkCaptured, clonePath };
