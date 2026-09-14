'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  TASK,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  FIXTURE_ROOT,
  ELECTRON,
  ORIGIN,
  EXPECTED_STORE_SHA,
  shaFile,
  shaBytes,
  readJson,
  loadIdentity,
  isContained,
  realContained,
} = require('./common-047');

const identity = loadIdentity();
const evidenceRoot = process.env.XJ_047_EVIDENCE_ROOT
  ? path.resolve(process.env.XJ_047_EVIDENCE_ROOT)
  : identity.evidenceRoot;
const failures = [];
const passes = [];

const META_FIELDS = [
  'schema', 'taskId', 'inputTaskId', 'runId', 'runNonce', 'cardSha256', 'storeSha256',
  'protectedFilesManifestSha256', 'fixedOrigin', 'stageId', 'phase', 'role', 'expectedFailure',
  'command', 'argv', 'spawnVector', 'cwd', 'startUtc', 'endUtc', 'processExitCode',
  'processSignal', 'exitCode', 'exitCodeSource', 'verdict', 'closeMode', 'forcedTermination',
  'runtime', 'realElectron', 'fixtureRoot', 'fixtureUrl', 'cdpPort', 'userDataDir',
  'evidenceRoot', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes',
  'stderrBytes', 'semanticResult', 'runnerError',
];

function check(label, condition, detail) {
  const entry = { label, detail: typeof detail === 'string' ? detail.slice(0, 900) : detail };
  (condition ? passes : failures).push(entry);
}

function safeJson(file) {
  try { return readJson(file); } catch (error) {
    check(`JSON readable ${file}`, false, error.message);
    return null;
  }
}

function validUtc(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function strictUtcRange(meta) {
  check(`${meta.stageId} startUtc valid`, validUtc(meta.startUtc), meta.startUtc);
  check(`${meta.stageId} endUtc valid`, validUtc(meta.endUtc), meta.endUtc);
  if (validUtc(meta.startUtc) && validUtc(meta.endUtc)) {
    check(`${meta.stageId} startUtc < endUtc`, Date.parse(meta.startUtc) < Date.parse(meta.endUtc), `${meta.startUtc}/${meta.endUtc}`);
  }
}

function verifyRaw(meta, field, shaField, bytesField) {
  const file = meta[field];
  check(`${meta.stageId} ${field} absolute`, typeof file === 'string' && path.isAbsolute(file), file);
  check(`${meta.stageId} ${field} under evidence`, typeof file === 'string' && isContained(evidenceRoot, file) && realContained(evidenceRoot, file), file);
  if (!file || !fs.existsSync(file)) return;
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) {
    check(`${meta.stageId} ${field} readable`, false, error.message);
    return;
  }
  check(`${meta.stageId} ${field} SHA`, shaBytes(bytes) === meta[shaField], `${meta[shaField]}/${shaBytes(bytes)}`);
  check(`${meta.stageId} ${field} bytes`, bytes.length === meta[bytesField], `${meta[bytesField]}/${bytes.length}`);
  check(`${meta.stageId} ${field} nonempty`, bytes.length > 0 || field === 'stderrPath', bytes.length);
  try {
    const st = fs.lstatSync(file);
    check(`${meta.stageId} ${field} regular file`, st.isFile() && !st.isSymbolicLink(), st);
  } catch (error) { check(`${meta.stageId} ${field} lstat`, false, error.message); }
}

function verifyMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  const keys = Object.keys(meta).sort();
  check(`${meta.stageId || 'unknown'} exact field schema`, JSON.stringify(keys) === JSON.stringify(META_FIELDS.slice().sort()), keys);
  check(`${meta.stageId} schema`, meta.schema === 'xj-047-stage-meta-v2', meta.schema);
  check(`${meta.stageId} task`, meta.taskId === TASK, meta.taskId);
  check(`${meta.stageId} input`, meta.inputTaskId === '046', meta.inputTaskId);
  check(`${meta.stageId} run identity`, meta.runId === identity.runId && meta.runNonce === identity.runNonce, `${meta.runId}/${meta.runNonce}`);
  check(`${meta.stageId} card SHA`, meta.cardSha256 === identity.cardSha256, meta.cardSha256);
  check(`${meta.stageId} store SHA`, meta.storeSha256 === EXPECTED_STORE_SHA, meta.storeSha256);
  check(`${meta.stageId} protected manifest SHA`, meta.protectedFilesManifestSha256 === identity.protectedFilesManifestSha256, meta.protectedFilesManifestSha256);
  check(`${meta.stageId} fixed origin`, meta.fixedOrigin === ORIGIN && typeof meta.fixtureUrl === 'string' && meta.fixtureUrl.startsWith(`${ORIGIN}/`), `${meta.fixedOrigin}/${meta.fixtureUrl}`);
  check(`${meta.stageId} runtime`, meta.runtime === 'electron' && meta.realElectron === true, `${meta.runtime}/${meta.realElectron}`);
  check(`${meta.stageId} cwd`, meta.cwd === ROOT && path.isAbsolute(meta.cwd), meta.cwd);
  check(`${meta.stageId} command`, meta.command === ELECTRON && path.isAbsolute(meta.command), meta.command);
  check(`${meta.stageId} argv array`, Array.isArray(meta.argv) && meta.argv.length >= 7, meta.argv);
  check(`${meta.stageId} spawn vector`, JSON.stringify(meta.spawnVector) === JSON.stringify([meta.command, ...meta.argv]), meta.spawnVector);
  check(`${meta.stageId} fixture root`, meta.fixtureRoot === FIXTURE_ROOT && path.isAbsolute(meta.fixtureRoot), meta.fixtureRoot);
  check(`${meta.stageId} stage evidence root`, meta.evidenceRoot === evidenceRoot && isContained(SCRATCH_ROOT, evidenceRoot) && realContained(SCRATCH_ROOT, evidenceRoot), meta.evidenceRoot);
  check(`${meta.stageId} userData absolute`, typeof meta.userDataDir === 'string' && path.isAbsolute(meta.userDataDir), meta.userDataDir);
  check(`${meta.stageId} userData outside evidence`, !isContained(evidenceRoot, meta.userDataDir), meta.userDataDir);
  strictUtcRange(meta);
  check(`${meta.stageId} browser close`, meta.closeMode === 'Browser.close' && meta.forcedTermination === false, `${meta.closeMode}/${meta.forcedTermination}`);
  check(`${meta.stageId} process exit`, meta.processExitCode === 0, meta.processExitCode);
  check(`${meta.stageId} argv gpu`, meta.argv.includes('--disable-gpu'), meta.argv);
  check(`${meta.stageId} argv sandbox`, meta.argv.includes('--no-sandbox'), meta.argv);
  check(`${meta.stageId} argv address`, meta.argv.includes('--remote-debugging-address=127.0.0.1'), meta.argv);
  check(`${meta.stageId} argv origins`, meta.argv.includes('--remote-allow-origins=*'), meta.argv);
  check(`${meta.stageId} argv userData`, meta.argv.includes(`--user-data-dir=${meta.userDataDir}`), meta.argv);
  check(`${meta.stageId} argv cdp`, meta.argv.includes(`--remote-debugging-port=${meta.cdpPort}`), meta.argv);
  check(`${meta.stageId} argv fixture`, meta.argv.includes(FIXTURE_ROOT), meta.argv);
  verifyRaw(meta, 'stdoutPath', 'stdoutSha256', 'stdoutBytes');
  verifyRaw(meta, 'stderrPath', 'stderrSha256', 'stderrBytes');
  const allText = [meta.stdoutPath, meta.stderrPath].filter(Boolean).map(file => {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  }).join('\n');
  check(`${meta.stageId} raw identity`, allText.includes(TASK) && allText.includes(identity.runId), allText.slice(0, 600));
  check(`${meta.stageId} no historical path`, !/(?:044|045|046|043)-?(?:evidence|hydration|billing-store)/i.test(allText), allText.slice(0, 600));
  check(`${meta.stageId} semantic result object`, meta.semanticResult && typeof meta.semanticResult === 'object' && !Array.isArray(meta.semanticResult), meta.semanticResult);
  if (meta.expectedFailure) {
    check(`${meta.stageId} mutated role`, meta.role === 'mutated', meta.role);
    check(`${meta.stageId} mutated KILLED`, meta.verdict === 'KILLED' && meta.exitCode === 1, `${meta.verdict}/${meta.exitCode}`);
    check(`${meta.stageId} mutated defect`, meta.semanticResult && meta.semanticResult.defect === true, meta.semanticResult);
    check(`${meta.stageId} semantic exit source`, meta.exitCodeSource === 'semantic-gate-defect', meta.exitCodeSource);
  } else {
    check(`${meta.stageId} positive verdict`, meta.verdict === 'PASS' || meta.verdict === 'PASS_EXPECTED_ERROR', meta.verdict);
    check(`${meta.stageId} positive exit`, meta.exitCode === 0, meta.exitCode);
    check(`${meta.stageId} positive semantic`, meta.semanticResult && meta.semanticResult.ok === true, meta.semanticResult);
  }
}

function semanticChecks(metas, manifest, results) {
  check('stage count exactly 29', metas.length === 29, metas.length);
  check('manifest stage count', manifest && manifest.stageCount === 29 && manifest.stageMetaPaths.length === 29, manifest && manifest.stageCount);
  const ids = metas.map(meta => meta.stageId);
  check('stage ids unique', new Set(ids).size === ids.length, ids);
  const byId = new Map(metas.map(meta => [meta.stageId, meta]));
  const migration = byId.get('core-migration-concurrent-hydrate');
  const restart = byId.get('core-graceful-close-same-origin-restart');
  const throwStage = byId.get('core-idb-open-throws-fallback');
  const eventStage = byId.get('core-idb-open-error-event-fallback');
  const badStage = byId.get('core-bad-value-fail-closed');
  check('core stages present', !!migration && !!restart && !!throwStage && !!eventStage && !!badStage, ids.slice(0, 5));
  if (migration) {
    const s = migration.semanticResult || {};
    check('migration origin', s.origin === ORIGIN, s.origin);
    check('migration real Electron', s.runtimeProbe && s.runtimeProbe.realElectron === true, s.runtimeProbe);
    check('migration old keys removed', Array.isArray(s.oldKeys) && s.oldKeys.length === 0, s.oldKeys);
    check('migration concurrent hydrate', s.concurrentHydrateCount >= 4 && s.firstPutCount >= s.beforeConcurrent, `${s.concurrentHydrateCount}/${s.firstPutCount}/${s.beforeConcurrent}`);
    check('migration repeat hydrate idempotent', s.repeatPutCount === 0, s.repeatPutCount);
    check('migration clients record', s.clientRecord && s.clientRecord.key === 'clients' && Array.isArray(s.clientRecord.value) && s.clientRecord.value[0].id === 'legacy-c1', s.clientRecord);
    check('migration sessions record', s.sessionRecord && s.sessionRecord.key === 'sessions' && Array.isArray(s.sessionRecord.value) && s.sessionRecord.value[0].transcript === 'LEGACY-BLOB-047', s.sessionRecord);
    check('migration supervision record', s.supervisionRecord && s.supervisionRecord.key === 'supervisions' && Array.isArray(s.supervisionRecord.value), s.supervisionRecord);
    check('migration settings record', s.settingsRecord && s.settingsRecord.key === 'settings' && s.settingsRecord.value && s.settingsRecord.value.marker === '047-seed', s.settingsRecord);
    check('migration blob captured', s.capturedBlobPut && s.capturedBlobPut.key === 'clients_blob_legacy-s1:transcript' && s.capturedBlobPut.value === 'LEGACY-BLOB-047', s.capturedBlobPut);
    check('migration blob merged', s.blobRecordAfterMerge === null && s.sessionTranscript === 'LEGACY-BLOB-047', `${s.blobRecordAfterMerge}/${s.sessionTranscript}`);
  }
  if (restart) {
    const s = restart.semanticResult || {};
    check('restart same userData', migration && restart.userDataDir === migration.userDataDir, `${restart.userDataDir}/${migration && migration.userDataDir}`);
    check('restart origin', s.origin === ORIGIN, s.origin);
    check('restart readback', !!s.client && !!s.session && s.session.transcript === 'LEGACY-BLOB-047', s);
    check('restart old keys removed', Array.isArray(s.oldKeys) && s.oldKeys.length === 0 && s.repeatMigration === false, `${s.oldKeys}/${s.repeatMigration}`);
  }
  for (const [stage, label] of [[throwStage, 'throw'], [eventStage, 'event']]) {
    if (!stage) continue;
    const s = stage.semanticResult || {};
    check(`${label} fallback evidence`, s.injectionEvidence && typeof s.injectionEvidence.kind === 'string', s.injectionEvidence);
    check(`${label} fallback data`, Array.isArray(s.fallbackKeys) && s.fallbackKeys.includes('xj2_clients') && Array.isArray(s.fallbackClients), s);
    check(`${label} durable failure`, s.durableResult && s.durableResult.ok === false && s.durableResult.error && typeof s.durableResult.error.code === 'string', s.durableResult);
  }
  if (badStage) {
    const s = badStage.semanticResult || {};
    check('bad values fail closed', Array.isArray(s.clients) && s.clients.length === 0 && Array.isArray(s.sessions) && s.sessions.length === 0, s);
  }
  const groups = new Map();
  for (const meta of metas.filter(item => item.stageId.startsWith('expected-red/'))) {
    const label = meta.stageId.split('/')[1];
    if (!groups.has(label)) groups.set(label, {});
    groups.get(label)[meta.role] = meta;
  }
  check('eight mutation groups', groups.size === 8, Array.from(groups.keys()));
  for (const [label, group] of groups) {
    check(`${label} three stages`, !!group.mutated && !!group.baseline && !!group.restore, Object.keys(group));
    check(`${label} mutated KILLED`, group.mutated && group.mutated.verdict === 'KILLED' && group.mutated.exitCode !== 0 && group.mutated.semanticResult && group.mutated.semanticResult.defect === true, group.mutated && group.mutated.semanticResult);
    check(`${label} baseline PASS`, group.baseline && group.baseline.verdict === 'PASS' && group.baseline.exitCode === 0 && group.baseline.semanticResult && group.baseline.semanticResult.ok === true, group.baseline && group.baseline.semanticResult);
    check(`${label} restore PASS`, group.restore && group.restore.verdict === 'PASS' && group.restore.exitCode === 0 && group.restore.semanticResult && group.restore.semanticResult.ok === true, group.restore && group.restore.semanticResult);
    check(`${label} baseline/restore fresh userData`, group.baseline && group.restore && group.baseline.userDataDir !== group.restore.userDataDir, group.baseline && group.restore && `${group.baseline.userDataDir}/${group.restore.userDataDir}`);
  }
  check('runner results summary', results && Array.isArray(results) && results.length === 16 && results.every(item => item && item.pass === true), results);
}

function main() {
  check('evidence root contained', isContained(SCRATCH_ROOT, evidenceRoot) && realContained(SCRATCH_ROOT, evidenceRoot), evidenceRoot);
  check('evidence root exists', fs.existsSync(evidenceRoot), evidenceRoot);
  if (!fs.existsSync(evidenceRoot)) return finish();
  const contextPath = path.join(evidenceRoot, 'run-context.json');
  const manifestPath = path.join(evidenceRoot, 'evidence-manifest.json');
  const resultsPath = path.join(evidenceRoot, 'results.json');
  const context = safeJson(contextPath);
  const manifest = safeJson(manifestPath);
  const results = safeJson(resultsPath);
  check('run context identity', context && context.taskId === TASK && context.inputTaskId === '046' && context.runId === identity.runId && context.runNonce === identity.runNonce && context.fixedOrigin === ORIGIN, context);
  check('run context evidence root', context && context.evidenceRoot === evidenceRoot, context && context.evidenceRoot);
  check('manifest identity', manifest && manifest.taskId === TASK && manifest.inputTaskId === '046' && manifest.runId === identity.runId && manifest.runNonce === identity.runNonce && manifest.cardSha256 === identity.cardSha256, manifest);
  check('manifest store SHA', manifest && manifest.storeSha256AtStart === EXPECTED_STORE_SHA && manifest.storeSha256AtEnd === EXPECTED_STORE_SHA, manifest);
  check('manifest flags local only', manifest && manifest.flags && manifest.flags.createdLocal === true && manifest.flags.releaseReady === false && manifest.flags.publishAuthorized === false && manifest.flags.released === false, manifest && manifest.flags);
  const metas = [];
  const metaPaths = manifest && Array.isArray(manifest.stageMetaPaths) ? manifest.stageMetaPaths : [];
  check('manifest paths unique', new Set(metaPaths).size === metaPaths.length, metaPaths);
  for (const metaPath of metaPaths) {
    check(`meta path contained ${metaPath}`, path.isAbsolute(metaPath) && isContained(evidenceRoot, metaPath) && realContained(evidenceRoot, metaPath), metaPath);
    const meta = safeJson(metaPath);
    if (meta) { metas.push(meta); verifyMeta(meta); }
  }
  semanticChecks(metas, manifest, results);
  check('current Store SHA unchanged', shaFile(path.join(ROOT, 'app/js/store.js')) === EXPECTED_STORE_SHA, shaFile(path.join(ROOT, 'app/js/store.js')));
  check('card SHA still pinned', shaFile(path.join(ROOT, 'docs/agent-coordination/v5.1.1/tasks', `${TASK}.md`)) === identity.cardSha256, identity.cardSha256);
  finish();
}

function finish() {
  const output = {
    verifier: '047',
    taskId: TASK,
    runId: identity.runId,
    runNonce: identity.runNonce,
    evidenceRoot,
    pass: failures.length === 0,
    passCount: passes.length,
    failCount: failures.length,
    failures,
    passes: passes.slice(0, 40),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

main();
