'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  TASK,
  SCRIPT_ROOT,
  EVIDENCE_ROOT: _unused,
  FIXTURE_ROOT,
  shaFile,
  readJson,
  loadIdentity,
  isContained,
  realContained,
  lstatFacts,
  EXPECTED_STORE_SHA,
} = require('./common-044');

const identity = loadIdentity();
const evidenceRoot = identity.evidenceRoot;
const failures = [];
const passes = [];

function check(label, condition, detail) {
  (condition ? passes : failures).push({ label, detail: String(detail || '').slice(0, 600) });
}

function readStage(metaPath) {
  check(`meta exists ${metaPath}`, fs.existsSync(metaPath), metaPath);
  if (!fs.existsSync(metaPath)) return null;
  try { return readJson(metaPath); } catch (error) { check(`meta JSON ${metaPath}`, false, error.message); return null; }
}

function checkRaw(meta, field, shaField, bytesField) {
  const file = meta[field];
  check(`${meta.stageId} ${field} absolute`, typeof file === 'string' && path.isAbsolute(file), file);
  check(`${meta.stageId} ${field} contained`, typeof file === 'string' && isContained(evidenceRoot, file) && realContained(evidenceRoot, file), file);
  if (!file || !fs.existsSync(file)) return;
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { check(`${meta.stageId} ${field} readable`, false, error.message); return; }
  check(`${meta.stageId} ${field} SHA`, shaFile(file) === meta[shaField], `${meta[shaField]} vs ${shaFile(file)}`);
  check(`${meta.stageId} ${field} bytes`, bytes.length === meta[bytesField], `${meta[bytesField]} vs ${bytes.length}`);
  check(`${meta.stageId} ${field} nonempty`, bytes.length > 0 || field === 'stderrPath', `${bytes.length}`);
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function requiredArg(meta, predicate, label) {
  check(`${meta.stageId} argv ${label}`, Array.isArray(meta.argv) && meta.argv.some(predicate), meta.argv);
}

function verifyMeta(meta) {
  if (!meta) return;
  check(`${meta.stageId} schema`, meta.schema === 'xj-044-stage-meta-v2', meta.schema);
  check(`${meta.stageId} task`, meta.taskId === TASK, meta.taskId);
  check(`${meta.stageId} input`, meta.inputTaskId === '043', meta.inputTaskId);
  check(`${meta.stageId} run`, meta.runId === identity.runId && meta.runNonce === identity.runNonce, `${meta.runId}/${meta.runNonce}`);
  check(`${meta.stageId} card SHA`, meta.cardSha256 === identity.cardSha256, meta.cardSha256);
  check(`${meta.stageId} Store SHA`, meta.storeSha256 === EXPECTED_STORE_SHA, meta.storeSha256);
  check(`${meta.stageId} origin`, meta.fixedOrigin === identity.fixedOrigin && meta.fixtureUrl.startsWith(identity.fixedOrigin), `${meta.fixedOrigin}/${meta.fixtureUrl}`);
  check(`${meta.stageId} runtime`, meta.runtime === 'electron' && meta.realElectron === true, `${meta.runtime}/${meta.realElectron}`);
  check(`${meta.stageId} cwd`, meta.cwd === ROOT && path.isAbsolute(meta.cwd), meta.cwd);
  check(`${meta.stageId} command`, meta.command === path.join(ROOT, 'node_modules/electron/dist/electron.exe') && path.isAbsolute(meta.command), meta.command);
  check(`${meta.stageId} argv array`, Array.isArray(meta.argv) && meta.argv.length >= 7, meta.argv);
  check(`${meta.stageId} spawn vector`, JSON.stringify(meta.spawnVector) === JSON.stringify([meta.command, ...meta.argv]), meta.spawnVector);
  check(`${meta.stageId} stage path`, isContained(evidenceRoot, path.dirname(meta.stdoutPath)) && realContained(evidenceRoot, path.dirname(meta.stdoutPath)), meta.stdoutPath);
  check(`${meta.stageId} times`, validTime(meta.startUtc) && validTime(meta.endUtc) && Date.parse(meta.startUtc) <= Date.parse(meta.endUtc), `${meta.startUtc}/${meta.endUtc}`);
  check(`${meta.stageId} userData absolute`, typeof meta.userDataDir === 'string' && path.isAbsolute(meta.userDataDir), meta.userDataDir);
  check(`${meta.stageId} userData not evidence`, !isContained(evidenceRoot, meta.userDataDir), meta.userDataDir);
  check(`${meta.stageId} close graceful`, meta.closeMode === 'Browser.close' && meta.forcedTermination === false, `${meta.closeMode}/${meta.forcedTermination}`);
  check(`${meta.stageId} process exit`, meta.processExitCode === 0, meta.processExitCode);
  requiredArg(meta, arg => arg === '--disable-gpu', '--disable-gpu');
  requiredArg(meta, arg => arg === '--no-sandbox', '--no-sandbox');
  requiredArg(meta, arg => arg === `--user-data-dir=${meta.userDataDir}`, 'exact userDataDir');
  requiredArg(meta, arg => arg === '--remote-debugging-address=127.0.0.1', 'remote address');
  requiredArg(meta, arg => arg === `--remote-debugging-port=${meta.cdpPort}`, 'exact CDP port');
  requiredArg(meta, arg => arg === '--remote-allow-origins=*', 'remote origin switch');
  requiredArg(meta, arg => arg === FIXTURE_ROOT, 'fixture root');
  checkRaw(meta, 'stdoutPath', 'stdoutSha256', 'stdoutBytes');
  checkRaw(meta, 'stderrPath', 'stderrSha256', 'stderrBytes');
  const allText = [meta.stdoutPath, meta.stderrPath].filter(Boolean).map(file => {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  }).join('\n');
  check(`${meta.stageId} raw identity`, allText.includes(TASK) && allText.includes(identity.runId), allText.slice(0, 600));
  check(`${meta.stageId} no old evidence path`, !/billing-store-hydration-legacy-migration-concurrency-(?:evidence-rework-043|no-context-independent-review-042|fix-no-context-independent-review-041)/i.test(allText), 'legacy path scan');
  check(`${meta.stageId} semantic result`, meta.semanticResult && typeof meta.semanticResult === 'object', meta.semanticResult);
  if (meta.expectedFailure) {
    check(`${meta.stageId} mutated verdict`, meta.role === 'mutated' && meta.verdict === 'KILLED' && meta.exitCode === 1, `${meta.role}/${meta.verdict}/${meta.exitCode}`);
    check(`${meta.stageId} mutated defect`, meta.semanticResult && meta.semanticResult.defect === true, meta.semanticResult);
    check(`${meta.stageId} mutation exit source`, meta.exitCodeSource === 'semantic-gate-defect', meta.exitCodeSource);
  } else {
    check(`${meta.stageId} positive verdict`, meta.verdict === 'PASS' || meta.verdict === 'PASS_EXPECTED_ERROR', meta.verdict);
    check(`${meta.stageId} positive exit`, meta.exitCode === 0, meta.exitCode);
    check(`${meta.stageId} positive semantic`, meta.semanticResult && meta.semanticResult.ok === true, meta.semanticResult);
  }
}

function semanticChecks(metas) {
  const byId = new Map(metas.map(meta => [meta.stageId, meta]));
  const migration = byId.get('core-migration-concurrent-hydrate');
  const restart = byId.get('core-graceful-close-same-origin-restart');
  const throwStage = byId.get('core-idb-open-throws-fallback');
  const eventStage = byId.get('core-idb-open-error-event-fallback');
  const badStage = byId.get('core-bad-value-fail-closed');
  check('stage count', metas.length === 29, metas.length);
  check('migration exists', !!migration, 'core-migration-concurrent-hydrate');
  check('restart exists', !!restart, 'core-graceful-close-same-origin-restart');
  check('throw degrade exists', !!throwStage, 'core-idb-open-throws-fallback');
  check('event degrade exists', !!eventStage, 'core-idb-open-error-event-fallback');
  check('bad value exists', !!badStage, 'core-bad-value-fail-closed');
  if (migration) {
    const s = migration.semanticResult || {};
    check('migration runtime real Electron', s.runtimeProbe && s.runtimeProbe.realElectron === true, s.runtimeProbe);
    check('migration fixed origin', s.origin === identity.fixedOrigin, s.origin);
    check('migration old keys gone', Array.isArray(s.oldKeys) && s.oldKeys.length === 0, s.oldKeys);
    check('migration repeat hydrate no writes', s.repeatPutCount === 0, s.repeatPutCount);
    check('migration concurrent hydrate', s.concurrentHydrateCount >= 4 && s.firstPutCount >= s.beforeConcurrent, `${s.concurrentHydrateCount}/${s.firstPutCount}/${s.beforeConcurrent}`);
    check('migration clients kv record', s.clientRecord && s.clientRecord.key === 'clients' && Array.isArray(s.clientRecord.value) && s.clientRecord.value[0].id === 'legacy-c1', s.clientRecord);
    check('migration sessions kv record', s.sessionRecord && s.sessionRecord.key === 'sessions' && Array.isArray(s.sessionRecord.value) && s.sessionRecord.value[0].transcript === 'LEGACY-BLOB-044', s.sessionRecord);
    check('migration supervisions kv record', s.supervisionRecord && s.supervisionRecord.key === 'supervisions' && Array.isArray(s.supervisionRecord.value) && s.supervisionRecord.value[0].id === 'legacy-sup1', s.supervisionRecord);
    check('migration settings kv record', s.settingsRecord && s.settingsRecord.key === 'settings' && s.settingsRecord.value && s.settingsRecord.value.marker === '044-seed', s.settingsRecord);
    check('migration captured blob key/value', s.capturedBlobPut && s.capturedBlobPut.key === 'clients_blob_legacy-s1:transcript' && s.capturedBlobPut.value === 'LEGACY-BLOB-044', s.capturedBlobPut);
    check('migration blob merged/deleted', s.blobRecordAfterMerge === null && s.sessionTranscript === 'LEGACY-BLOB-044', `${s.blobRecordAfterMerge}/${s.sessionTranscript}`);
  }
  if (restart && migration) {
    const s = restart.semanticResult || {};
    check('restart same userData explicit', restart.userDataDir === migration.userDataDir, `${restart.userDataDir}/${migration.userDataDir}`);
    check('restart same origin', s.origin === identity.fixedOrigin, s.origin);
    check('restart client/session readback', !!s.client && !!s.session && s.session.transcript === 'LEGACY-BLOB-044', s);
    check('restart no old keys', Array.isArray(s.oldKeys) && s.oldKeys.length === 0 && s.repeatMigration === false, `${s.oldKeys}/${s.repeatMigration}`);
  }
  for (const [meta, label] of [[throwStage, 'throw'], [eventStage, 'event']]) {
    if (!meta) continue;
    const s = meta.semanticResult || {};
    check(`${label} injection evidence`, s.injectionEvidence && typeof s.injectionEvidence.kind === 'string', s.injectionEvidence);
    check(`${label} fallback localStorage`, Array.isArray(s.fallbackKeys) && s.fallbackKeys.includes('xj2_clients') && Array.isArray(s.fallbackClients), s);
    check(`${label} durable explicit failure`, s.durableResult && s.durableResult.ok === false && s.durableResult.error && typeof s.durableResult.error.code === 'string', s.durableResult);
  }
  if (badStage) {
    const s = badStage.semanticResult || {};
    check('bad-value fail-closed arrays', Array.isArray(s.clients) && s.clients.length === 0 && Array.isArray(s.sessions) && s.sessions.length === 0, s);
  }
  const grouped = new Map();
  for (const meta of metas.filter(item => item.stageId.startsWith('expected-red/'))) {
    const label = meta.stageId.split('/')[1];
    if (!grouped.has(label)) grouped.set(label, {});
    grouped.get(label)[meta.role] = meta;
  }
  check('eight mutation groups', grouped.size === 8, Array.from(grouped.keys()));
  for (const [label, group] of grouped) {
    check(`${label} has mutated/baseline/restore`, !!group.mutated && !!group.baseline && !!group.restore, Object.keys(group));
    if (group.mutated) check(`${label} mutated semantic defect`, group.mutated.verdict === 'KILLED' && group.mutated.exitCode === 1 && group.mutated.semanticResult && group.mutated.semanticResult.defect === true, group.mutated.semanticResult);
    if (group.baseline) check(`${label} baseline fresh PASS`, group.baseline.verdict === 'PASS' && group.baseline.exitCode === 0 && group.baseline.semanticResult && group.baseline.semanticResult.ok === true, group.baseline.semanticResult);
    if (group.restore) check(`${label} restore fresh PASS`, group.restore.verdict === 'PASS' && group.restore.exitCode === 0 && group.restore.semanticResult && group.restore.semanticResult.ok === true, group.restore.semanticResult);
    if (group.baseline && group.restore) check(`${label} baseline/restore isolated userData`, group.baseline.userDataDir !== group.restore.userDataDir, `${group.baseline.userDataDir}/${group.restore.userDataDir}`);
  }
}

function main() {
  check('evidence root exists', fs.existsSync(evidenceRoot), evidenceRoot);
  if (!fs.existsSync(evidenceRoot)) return finish();
  const contextPath = path.join(evidenceRoot, 'run-context.json');
  const manifestPath = path.join(evidenceRoot, 'evidence-manifest.json');
  check('run context exists', fs.existsSync(contextPath), contextPath);
  check('manifest exists', fs.existsSync(manifestPath), manifestPath);
  let context = null;
  let manifest = null;
  try { context = readJson(contextPath); } catch (error) { check('run context parse', false, error.message); }
  try { manifest = readJson(manifestPath); } catch (error) { check('manifest parse', false, error.message); }
  if (context) {
    check('context identity', context.taskId === TASK && context.runId === identity.runId && context.runNonce === identity.runNonce, context);
    check('context root', context.evidenceRoot === evidenceRoot && context.fixedOrigin === identity.fixedOrigin, context);
    check('context argv policy', context.argvPolicy === 'argv is the exact array passed to child_process.spawn', context.argvPolicy);
  }
  const metas = [];
  const paths = manifest && Array.isArray(manifest.stageMetaPaths) ? manifest.stageMetaPaths : [];
  for (const metaPath of paths) {
    check('meta path absolute/contained', path.isAbsolute(metaPath) && isContained(evidenceRoot, metaPath) && realContained(evidenceRoot, metaPath), metaPath);
    const meta = readStage(metaPath);
    if (meta) { metas.push(meta); verifyMeta(meta); }
  }
  semanticChecks(metas);
  check('manifest stage count', manifest && manifest.stageCount === metas.length, `${manifest && manifest.stageCount}/${metas.length}`);
  check('manifest identity', manifest && manifest.taskId === TASK && manifest.runId === identity.runId && manifest.cardSha256 === identity.cardSha256, manifest);
  check('manifest Store SHA unchanged', manifest && manifest.storeSha256AtStart === EXPECTED_STORE_SHA && manifest.storeSha256AtEnd === EXPECTED_STORE_SHA, manifest);
  check('current Store SHA unchanged', shaFile(path.join(ROOT, 'app/js/store.js')) === EXPECTED_STORE_SHA, shaFile(path.join(ROOT, 'app/js/store.js')));
  finish();
}

function finish() {
  const output = { verifier: '044', taskId: TASK, runId: identity.runId, evidenceRoot, pass: failures.length === 0, passCount: passes.length, failCount: failures.length, failures, passes: passes.slice(0, 30) };
  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exitCode = 1;
}

main();
