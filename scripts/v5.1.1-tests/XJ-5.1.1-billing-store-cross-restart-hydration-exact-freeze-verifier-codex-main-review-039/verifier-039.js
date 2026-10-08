'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const SOURCE_TASK = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035';
const EXPECTED_AGGREGATE = '1d438e41037ff1953ef1ad448c711c56f01094eb980669664f5efd6141e787f6';
const EXPECTED_ENTRY_COUNT = 1627;
const EXPECTED_STORE_SHA = '84ded0e7eaf3b8de98a727d5f1671ed42b9ea27ae7ea27caa644e8ef20cf768d';
const EXPECTED_PROTECTED_SHA = 'd52755d4aed2e9e8d8a4cff316b3b5f8b2d937b33aa766523998006daa8b336c';
const EXPECTED_033_VERIFIER = 'D:\\xinjing-electron\\scripts\\v5.1.1-tests\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\freeze-verifier.js';
const EXPECTED_033_VERIFIER_SHA = '22e6cb8942ad4f86afb9e55dd58129a984da9566bef003f79ce1ae0dc1f9d13e';
const EXPECTED_033_VERIFIER_BYTES = 9242;
const EXPECTED_OBJECTS = {
  'evidence-file': 1608,
  'harness-source': 10,
  'freeze-self': 3,
  'candidate-file': 2,
  card: 2,
  store: 1,
  'protected-sha': 1
};

const EXPECTED_033_CARD_SHA = 'd3aff9699e94c371abc8490750ac408833e558a8f6685499e28d1a63f1044d6b';
const EXPECTED_033_CANDIDATE_FILES_SHA = '72d6d0032683270216ed13b051e226d34fcf358f80d51971b9bee5dcb0573397';
const EXPECTED_033_CANDIDATE_MANIFEST_SHA = '104831b9823f13a13d85814d7512e8ed230a027d37e230c0d2773828235eb37e';
const EXPECTED_033_AGGREGATE = 'aa82b8b788c6f4c462bd8816e17f12ff25448167c9c1753f09c1e7a76d23f315';
const EXPECTED_033_RUN_ID = 'run-033-20260827041958-3ec36f2a3a4bc9';
const EXPECTED_033_EVIDENCE_ROOT = 'D:\\xinjing-electron\\qa\\task-scratch\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\evidence\\run-033-20260827041958-3ec36f2a3a4bc9';
const EXPECTED_033_CANDIDATE_DIR = 'D:\\xinjing-electron\\qa\\task-scratch\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\candidate\\run-033-20260827041958-3ec36f2a3a4bc9';
const EXPECTED_035_SCRATCH = 'D:\\xinjing-electron\\qa\\task-scratch\\XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035';
const EXPECTED_MANIFEST_KEYS = [
  'schemaVersion', 'selfReferenceExcluded', 'taskId', 'contractId', 'baseCommit', 'runId',
  'bindingDir', 'filesPath', 'aggregateSha256', 'entryCount', 'objects', 'metadata',
  'harness', 'freezeCapture', 'flags', 'generatedAt'
];
const EXPECTED_BINDING_KEYS = [
  'schemaVersion', 'selfReferenceExcluded', 'taskId', 'contractId', 'runId',
  'entryCount', 'aggregateSha256', 'aggregateInput', 'entries'
];
const EXPECTED_ENTRY_KEYS = ['kind', 'label', 'sourcePath', 'sha256', 'bytes'];
const EXPECTED_OUTPUT_KEYS = ['rel', 'sha256', 'bytes'];
const EXPECTED_METADATA = {
  '033-run-id': EXPECTED_033_RUN_ID,
  '033-aggregate': EXPECTED_033_AGGREGATE,
  '033-card-sha': EXPECTED_033_CARD_SHA,
  '035-card-sha': '7365394966f622c218f02515e5ebddbbc22f171d8fdbe3c04281a8cffa0bb06b',
  'store-sha': EXPECTED_STORE_SHA,
  'protected-manifest-sha': EXPECTED_PROTECTED_SHA,
  '033-candidate-files-sha': EXPECTED_033_CANDIDATE_FILES_SHA,
  '033-candidate-manifest-sha': EXPECTED_033_CANDIDATE_MANIFEST_SHA
};
const EXPECTED_HARNESS = [
  ['common.js', 'a5ab48c233f484ca494fbbf46bf7d0c2b349c563921660210e0951b8fa231beb', 14040],
  ['fixture-electron.js', '169aefcce08a6a2a5be288df35a935bd51d1c08d7d85260d10dfe9870e41f6c9', 3631],
  ['store-fixture.html', '66f955fac3144856c9ddb7e57234a9a8a92f1d95df206fa430ffce8f6edcd238', 8162],
  ['phase-worker.js', '107bac93d9f3d3e47c853d58d13e69ed6f443b6ac53a31f2294375ad4c0ef59f', 6689],
  ['runner.js', '15f0e8003617cef3d2a6a1a8f8d75bbca4dd55ed54c298e091aad2aca5e74214', 4900],
  ['expected-red.js', 'dbbac88a7d1a4a070667c25c13996c0cfb696f46fe071d7521a597830b0fc952', 5366],
  ['verifier.js', '3c92360c5d7d7171fa2fe4bf2974be226ffabfadb545478d9344f1362c2e8729', 13102],
  ['audit.js', '6e0eff9ec34583613dac6e47b72247e9d9d56c0ef8761200dbb0dbdcbd5c1096', 16381],
  ['freeze-verifier.js', EXPECTED_033_VERIFIER_SHA, EXPECTED_033_VERIFIER_BYTES],
  ['expected-red.json', '2e623aa3d23784d167c23d029c9636077c89b90e70cf5ee5bb684653a27ed81a', 1620]
];

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function bytewiseCompare(a, b) {
  const aa = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

function localeComparator(a, b) {
  return String(a).localeCompare(String(b));
}

function ensureAbsolute(p, label) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`${label}: absolute path required`);
  return path.normalize(p);
}

function ensureNoLink(filePath) {
  const abs = ensureAbsolute(filePath, 'path');
  let current = abs;
  while (true) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw new Error(`symlink/junction rejected: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: object required`);
  const actual = Object.keys(value).sort(bytewiseCompare);
  const wanted = expected.slice().sort(bytewiseCompare);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label}: fields mismatch (got ${actual.join(',')}, expected ${wanted.join(',')})`);
  }
}

function assertIsoRange(startUtc, endUtc, label) {
  assertEqual(typeof startUtc, 'string', `${label}.startUtc type`);
  assertEqual(typeof endUtc, 'string', `${label}.endUtc type`);
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error(`${label}: invalid UTC range`);
}

function pathInside(root, candidate, label) {
  const base = ensureAbsolute(root, `${label}.root`);
  const target = ensureAbsolute(candidate, label);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label}: outside root`);
  return target;
}

function canonicalObject(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort((a, b) => bytewiseCompare(a[0], b[0]))));
}

function loadJson(filePath, label) {
  ensureNoLink(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function verifyEntrySource(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('entry: object required');
  assertKeys(entry, EXPECTED_ENTRY_KEYS, 'entry');
  assertEqual(typeof entry.kind, 'string', 'entry.kind type');
  assertEqual(typeof entry.label, 'string', 'entry.label type');
  assertEqual(typeof entry.sha256, 'string', `${entry.label} sha type`);
  assertEqual(typeof entry.bytes, 'number', `${entry.label} bytes type`);
  if (entry.kind === 'protected-sha') {
    assertEqual(entry.sha256.toLowerCase(), EXPECTED_PROTECTED_SHA, 'protected sha');
    assertEqual(entry.bytes, 64, 'protected bytes');
    return;
  }
  const sourcePath = ensureAbsolute(entry.sourcePath, `${entry.label}.sourcePath`);
  if (!fs.existsSync(sourcePath)) throw new Error(`${entry.label}: source missing ${sourcePath}`);
  ensureNoLink(sourcePath);
  const stat = fs.statSync(sourcePath);
  assertEqual(stat.size, entry.bytes, `${entry.label} bytes`);
  assertEqual(fileSha(sourcePath), entry.sha256.toLowerCase(), `${entry.label} sha256`);
}

function aggregateEntries(entries, comparatorName) {
  const comparator = comparatorName === 'locale' ? localeComparator : bytewiseCompare;
  const sorted = entries.slice().sort((a, b) => {
    const byKind = comparator(a.kind, b.kind);
    return byKind || comparator(a.label, b.label);
  });
  const input = sorted.map((entry) => ({
    kind: entry.kind,
    label: entry.label,
    sha256: String(entry.sha256).toLowerCase(),
    bytes: entry.bytes
  }));
  return { input, aggregate: sha256Bytes(Buffer.from(JSON.stringify(input), 'utf8')) };
}

function verifyFreezeCapture(manifest) {
  const capture = manifest.freezeCapture;
  if (!capture || typeof capture !== 'object') throw new Error('freezeCapture missing');
  assertKeys(capture, [
    'tool', 'capturedFrom', 'command', 'argv', 'nodeOptions', 'cwd', 'startUtc', 'endUtc',
    'exitCode', 'verdict', 'executedSourceSha256', 'executedSourceBytes', 'sourceByteIdentical',
    'executedCommonSha256', 'hookPath', 'hookSha256', 'hookBytes', 'redirectRoot', 'mapping',
    'isolationOutputs', 'childSelfTriplet', 'prePostEqual', 'stdoutSha256', 'stderrSha256',
    'stdoutBytes', 'stderrBytes', 'summary', 'exactSourceIdentity'
  ], 'freezeCapture');
  assertEqual(capture.tool, 'freeze-verifier', 'freeze tool');
  assertEqual(path.normalize(capture.capturedFrom), path.normalize(EXPECTED_033_VERIFIER), 'capturedFrom');
  assertEqual(path.normalize(capture.argv?.[0]), path.normalize(EXPECTED_033_VERIFIER), 'argv[0]');
  assertEqual(Array.isArray(capture.argv), true, 'freeze argv');
  assertEqual(capture.command, process.execPath, 'freeze command');
  assertEqual(capture.cwd, 'D:\\xinjing-electron', 'freeze cwd');
  assertEqual(typeof capture.nodeOptions, 'string', 'nodeOptions type');
  assertEqual(capture.nodeOptions.includes('candidate-output-redirect-hook.js'), true, 'nodeOptions hook');
  assertIsoRange(capture.startUtc, capture.endUtc, 'freezeCapture');
  const sourcePath = ensureAbsolute(capture.capturedFrom, 'capturedFrom');
  ensureNoLink(sourcePath);
  assertEqual(fileSha(sourcePath), EXPECTED_033_VERIFIER_SHA, 'executed source sha');
  assertEqual(fs.statSync(sourcePath).size, EXPECTED_033_VERIFIER_BYTES, 'executed source bytes');
  assertEqual(capture.executedSourceSha256, EXPECTED_033_VERIFIER_SHA, 'capture source sha');
  assertEqual(capture.executedSourceBytes, EXPECTED_033_VERIFIER_BYTES, 'capture source bytes');
  assertEqual(capture.sourceByteIdentical, true, 'sourceByteIdentical');
  const hookPath = ensureAbsolute(capture.hookPath, 'hookPath');
  pathInside(path.join('D:\\xinjing-electron', 'scripts', 'v5.1.1-tests'), hookPath, 'hookPath');
  ensureNoLink(hookPath);
  assertEqual(fileSha(hookPath), String(capture.hookSha256).toLowerCase(), 'hook sha');
  assertEqual(fs.statSync(hookPath).size, capture.hookBytes, 'hook bytes');
  const redirect = ensureAbsolute(capture.redirectRoot, 'redirectRoot');
  const candidateRoot = path.resolve(path.join(EXPECTED_035_SCRATCH, 'candidate-isolation'));
  const rel = path.relative(candidateRoot, redirect);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('redirectRoot outside 035 candidate-isolation');
  ensureNoLink(redirect);
  assertEqual(capture.exitCode, 0, 'freeze child exit');
  assertEqual(capture.verdict, 'PASS', 'freeze verdict');
  assertEqual(Array.isArray(capture.isolationOutputs), true, 'isolationOutputs array');
  assertEqual(capture.isolationOutputs.length, 5, 'isolationOutputs count');
  const expectedRels = [
    'candidate-files-033.json', 'candidate-manifest-033.json',
    'self/freeze-verifier/stdout.txt', 'self/freeze-verifier/stderr.txt', 'self/freeze-verifier/meta.json'
  ];
  const outputMap = new Map();
  for (const output of capture.isolationOutputs) {
    assertKeys(output, EXPECTED_OUTPUT_KEYS, 'isolation output');
    assertEqual(typeof output.rel, 'string', 'isolation rel type');
    if (path.isAbsolute(output.rel) || output.rel.includes('..')) throw new Error('isolation rel escapes redirect');
    if (outputMap.has(output.rel)) throw new Error('duplicate isolation output');
    outputMap.set(output.rel, output);
    const raw = pathInside(redirect, path.join(redirect, output.rel), 'isolation output');
    ensureNoLink(raw);
    if (!fs.existsSync(raw)) throw new Error(`isolation output missing: ${output.rel}`);
    assertEqual(fileSha(raw), String(output.sha256).toLowerCase(), `${output.rel} sha`);
    assertEqual(fs.statSync(raw).size, output.bytes, `${output.rel} bytes`);
  }
  assertEqual(JSON.stringify(Array.from(outputMap.keys()).sort(bytewiseCompare)), JSON.stringify(expectedRels.sort(bytewiseCompare)), 'isolation output set');
  const triplet = capture.childSelfTriplet;
  assertKeys(triplet, ['metaPath', 'verdict', 'exitCode'], 'childSelfTriplet');
  assertEqual(triplet.verdict, 'PASS', 'child verdict');
  assertEqual(triplet.exitCode, 0, 'child exit');
  const childMetaPath = pathInside(redirect, triplet.metaPath, 'child metaPath');
  assertEqual(path.normalize(childMetaPath), path.normalize(path.join(redirect, 'self', 'freeze-verifier', 'meta.json')), 'child metaPath target');
  ensureNoLink(childMetaPath);
  const childMeta = loadJson(childMetaPath, 'child meta');
  assertKeys(childMeta, [
    'taskId', 'runId', 'caseId', 'stage', 'command', 'argv', 'cwd', 'startUtc', 'endUtc',
    'exitCode', 'stdoutPath', 'stderrPath', 'metaPath', 'stdoutSha256', 'stderrSha256',
    'stdoutBytes', 'stderrBytes', 'verdict'
  ], 'child meta');
  assertEqual(childMeta.taskId, 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033', 'child taskId');
  assertEqual(childMeta.runId, EXPECTED_033_RUN_ID, 'child runId');
  assertEqual(childMeta.caseId, '__self__', 'child caseId');
  assertEqual(childMeta.stage, 'freeze-verifier', 'child stage');
  assertIsoRange(childMeta.startUtc, childMeta.endUtc, 'child meta');
  assertEqual(childMeta.exitCode, 0, 'child meta exit');
  assertEqual(childMeta.verdict, 'PASS', 'child meta verdict');
  assertEqual(childMeta.stdoutSha256.toLowerCase(), capture.stdoutSha256.toLowerCase(), 'child stdout sha');
  assertEqual(childMeta.stderrSha256.toLowerCase(), capture.stderrSha256.toLowerCase(), 'child stderr sha');
  assertEqual(childMeta.stdoutBytes, capture.stdoutBytes, 'child stdout bytes');
  assertEqual(childMeta.stderrBytes, capture.stderrBytes, 'child stderr bytes');
  for (const field of ['stdoutPath', 'stderrPath']) {
    const raw = ensureAbsolute(childMeta[field], `child ${field}`);
    ensureNoLink(raw);
    if (!fs.existsSync(raw)) throw new Error(`child ${field} missing`);
    assertEqual(fileSha(raw), String(childMeta[field === 'stdoutPath' ? 'stdoutSha256' : 'stderrSha256']).toLowerCase(), `child ${field} sha`);
    assertEqual(fs.statSync(raw).size, childMeta[field === 'stdoutPath' ? 'stdoutBytes' : 'stderrBytes'], `child ${field} bytes`);
  }
  assertEqual(capture.stdoutSha256.toLowerCase(), outputMap.get('self/freeze-verifier/stdout.txt').sha256.toLowerCase(), 'freeze stdout sha');
  assertEqual(capture.stderrSha256.toLowerCase(), outputMap.get('self/freeze-verifier/stderr.txt').sha256.toLowerCase(), 'freeze stderr sha');
  assertEqual(capture.stdoutBytes, outputMap.get('self/freeze-verifier/stdout.txt').bytes, 'freeze stdout bytes');
  assertEqual(capture.stderrBytes, outputMap.get('self/freeze-verifier/stderr.txt').bytes, 'freeze stderr bytes');
  assertEqual(capture.prePostEqual, true, 'freeze prePostEqual');
  assertEqual(capture.exactSourceIdentity, true, 'freeze exactSourceIdentity');
  assertKeys(capture.mapping, ['prefixBefore', 'prefixAfter', 'scope'], 'freeze mapping');
  assertEqual(capture.mapping.prefixBefore, path.join('D:\\xinjing-electron', 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033', 'candidate', EXPECTED_033_RUN_ID), 'mapping prefixBefore');
  assertEqual(capture.mapping.prefixAfter, redirect, 'mapping prefixAfter');
  assertEqual(capture.mapping.scope, '033 SCRATCH_ROOT/candidate/<run-033> write operations only; all other writes fail-closed', 'mapping scope');
  assertKeys(capture.summary, ['type', 'taskId', 'runId', 'evidenceRoot', 'candidateDir', 'fileCount', 'aggregateSha256', 'flags', 'verdict'], 'freeze summary');
  assertEqual(capture.summary.type, 'freeze-summary', 'summary type');
  assertEqual(capture.summary.taskId, 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033', 'summary task');
  assertEqual(capture.summary.runId, EXPECTED_033_RUN_ID, 'summary run');
  assertEqual(capture.summary.evidenceRoot, EXPECTED_033_EVIDENCE_ROOT, 'summary evidenceRoot');
  assertEqual(capture.summary.candidateDir, EXPECTED_033_CANDIDATE_DIR, 'summary candidateDir');
  assertEqual(capture.summary.fileCount, 1608, 'summary fileCount');
  assertEqual(capture.summary.aggregateSha256, EXPECTED_033_AGGREGATE, 'summary aggregate');
  assertKeys(capture.summary.flags, ['createdLocal', 'releaseReady', 'publishAuthorized', 'released'], 'summary flags');
  assertEqual(JSON.stringify(capture.summary.flags), JSON.stringify({ createdLocal: true, releaseReady: false, publishAuthorized: false, released: false }), 'summary flags values');
  assertEqual(capture.summary.verdict, 'PASS', 'summary verdict');
}

function verify(options) {
  const binding = loadJson(options.binding, 'binding');
  const manifest = loadJson(options.manifest, 'manifest');
  assertKeys(binding, EXPECTED_BINDING_KEYS, 'binding');
  assertKeys(manifest, EXPECTED_MANIFEST_KEYS, 'manifest');
  assertEqual(binding.taskId, SOURCE_TASK, 'binding taskId');
  assertEqual(manifest.taskId, SOURCE_TASK, 'manifest taskId');
  assertEqual(binding.entryCount, EXPECTED_ENTRY_COUNT, 'binding entryCount');
  assertEqual(manifest.entryCount, EXPECTED_ENTRY_COUNT, 'manifest entryCount');
  assertEqual(binding.runId, 'run-035-20260827063639-5a43423c511376', 'binding runId');
  assertEqual(manifest.runId, binding.runId, 'manifest runId');
  assertEqual(binding.entries.length, EXPECTED_ENTRY_COUNT, 'binding entries length');
  const counts = {};
  for (const entry of binding.entries) {
    counts[entry.kind] = (counts[entry.kind] || 0) + 1;
    verifyEntrySource(entry);
  }
  assertEqual(canonicalObject(counts), canonicalObject(EXPECTED_OBJECTS), 'object counts');
  const computed = aggregateEntries(binding.entries, options.comparator);
  assertEqual(computed.aggregate, EXPECTED_AGGREGATE, 'aggregate');
  assertEqual(binding.aggregateSha256.toLowerCase(), EXPECTED_AGGREGATE, 'binding aggregateSha256');
  assertEqual(JSON.stringify(binding.aggregateInput), JSON.stringify(computed.input), 'binding aggregateInput');
  assertEqual(path.normalize(manifest.filesPath), path.normalize(options.binding), 'manifest filesPath');
  assertEqual(path.normalize(manifest.bindingDir), path.normalize(path.dirname(options.binding)), 'manifest bindingDir');
  assertEqual(manifest.aggregateSha256, EXPECTED_AGGREGATE, 'manifest aggregate');
  assertEqual(canonicalObject(manifest.objects), canonicalObject(EXPECTED_OBJECTS), 'manifest objects');
  assertEqual(manifest.schemaVersion, 'final-binding-manifest-035-v1', 'manifest schema');
  assertEqual(manifest.selfReferenceExcluded, true, 'manifest self reference');
  assertEqual(manifest.baseCommit, '9971787eb6e443ab5a5c80aee118b9b43285c093', 'manifest baseCommit');
  assertEqual(manifest.generatedAt && typeof manifest.generatedAt, 'string', 'manifest generatedAt');
  assertKeys(manifest.flags, ['createdLocal', 'releaseReady', 'publishAuthorized', 'released'], 'manifest flags');
  assertEqual(JSON.stringify(manifest.flags), JSON.stringify({ createdLocal: true, releaseReady: false, publishAuthorized: false, released: false }), 'manifest flags values');
  assertKeys(manifest.metadata, Object.keys(EXPECTED_METADATA), 'manifest metadata');
  for (const [key, value] of Object.entries(EXPECTED_METADATA)) assertEqual(String(manifest.metadata[key]).toLowerCase(), String(value).toLowerCase(), `manifest metadata ${key}`);
  assertEqual(Array.isArray(manifest.harness), true, 'manifest harness');
  assertEqual(manifest.harness.length, EXPECTED_HARNESS.length, 'manifest harness count');
  for (let i = 0; i < EXPECTED_HARNESS.length; i += 1) {
    const actual = manifest.harness[i];
    assertKeys(actual, ['name', 'sha256', 'bytes'], `harness[${i}]`);
    assertEqual(actual.name, EXPECTED_HARNESS[i][0], `harness[${i}] name`);
    assertEqual(String(actual.sha256).toLowerCase(), EXPECTED_HARNESS[i][1], `harness[${i}] sha`);
    assertEqual(actual.bytes, EXPECTED_HARNESS[i][2], `harness[${i}] bytes`);
  }
  const store = binding.entries.find((entry) => entry.kind === 'store');
  assertEqual(store.sha256.toLowerCase(), EXPECTED_STORE_SHA, 'store sha');
  verifyFreezeCapture(manifest);
  return {
    ok: true,
    verdict: 'PASS',
    taskId: TASK_ID,
    sourceTask: SOURCE_TASK,
    entryCount: binding.entries.length,
    aggregate: computed.aggregate,
    objects: counts,
    comparator: options.comparator === 'locale' ? 'localeCompare (mutation only)' : 'utf8-bytewise',
    freezeIdentity: true
  };
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

try {
  const options = args();
  if (!options.binding || !options.manifest) throw new Error('--binding and --manifest are required');
  const result = verify(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, verdict: 'FAIL', taskId: TASK_ID, error: String(error.message || error) })}\n`);
  process.exitCode = 1;
}
