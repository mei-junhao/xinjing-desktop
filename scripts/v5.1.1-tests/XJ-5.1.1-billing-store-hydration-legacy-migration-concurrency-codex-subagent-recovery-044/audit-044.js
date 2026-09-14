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
  EXPECTED_STORE_SHA,
  loadIdentity,
  readJson,
  shaFile,
  isContained,
  realContained,
} = require('./common-044');

const identity = loadIdentity();
const evidenceRoot = identity.evidenceRoot;
const selfRoot = identity.selfRoot;
const failures = [];
const passes = [];

function check(label, condition, detail) {
  (condition ? passes : failures).push({ label, detail: String(detail || '').slice(0, 650) });
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function verifySelfTriplet(role) {
  const dir = path.join(selfRoot, role);
  const metaPath = path.join(dir, 'meta.json');
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  check(`self ${role} meta exists`, fs.existsSync(metaPath), metaPath);
  check(`self ${role} stdout exists`, fs.existsSync(stdoutPath), stdoutPath);
  check(`self ${role} stderr exists`, fs.existsSync(stderrPath), stderrPath);
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try { meta = readJson(metaPath); } catch (error) { check(`self ${role} meta parse`, false, error.message); return null; }
  check(`self ${role} task/run`, meta.taskId === TASK && meta.runId === identity.runId && meta.evidenceRoot === evidenceRoot, meta);
  check(`self ${role} command`, meta.command === process.execPath && Array.isArray(meta.argv) && meta.argv.length >= 1, meta);
  check(`self ${role} spawn vector`, JSON.stringify(meta.spawnVector) === JSON.stringify([meta.command, ...meta.argv]), meta.spawnVector);
  check(`self ${role} cwd absolute/root`, meta.cwd === ROOT && path.isAbsolute(meta.cwd), meta.cwd);
  for (const [field, shaField, bytesField] of [['stdoutPath', 'stdoutSha256', 'stdoutBytes'], ['stderrPath', 'stderrSha256', 'stderrBytes']]) {
    const file = meta[field];
    check(`self ${role} ${field} path`, typeof file === 'string' && path.isAbsolute(file) && isContained(SCRATCH_ROOT, file) && realContained(SCRATCH_ROOT, file), file);
    check(`self ${role} ${field} exists`, typeof file === 'string' && fs.existsSync(file), file);
    if (file && fs.existsSync(file)) {
      check(`self ${role} ${field} SHA`, shaFile(file) === meta[shaField], `${meta[shaField]}/${shaFile(file)}`);
      check(`self ${role} ${field} bytes`, fs.statSync(file).size === meta[bytesField], `${meta[bytesField]}/${fs.statSync(file).size}`);
    }
  }
  check(`self ${role} actual argv includes tool`, meta.argv.some(arg => String(arg).endsWith(`${role === 'runner' ? 'runner' : role === 'verifier' ? 'verifier' : role === 'expected-red' ? 'expected-red' : 'audit'}-044.js`)), meta.argv);
  const text = readText(meta.stdoutPath) + '\n' + readText(meta.stderrPath);
  check(`self ${role} raw identity`, text.includes(TASK) && text.includes(identity.runId), text.slice(0, 500));
  check(`self ${role} no predecessor evidence path`, !/qa[\\/]task-scratch[\\/]XJ-5\.1\.1-billing-store-hydration-legacy-migration-concurrency-(?:evidence-rework-043|no-context-independent-review-042|fix-no-context-independent-review-041)/i.test(text), text.slice(0, 500));
  return meta;
}

function verifyEvidence() {
  check('evidence root exists', fs.existsSync(evidenceRoot), evidenceRoot);
  const manifestPath = path.join(evidenceRoot, 'evidence-manifest.json');
  check('evidence manifest exists', fs.existsSync(manifestPath), manifestPath);
  if (!fs.existsSync(manifestPath)) return [];
  let manifest;
  try { manifest = readJson(manifestPath); } catch (error) { check('evidence manifest parse', false, error.message); return []; }
  check('manifest identity', manifest.taskId === TASK && manifest.runId === identity.runId && manifest.cardSha256 === identity.cardSha256, manifest);
  check('manifest flags no release', manifest.flags && manifest.flags.createdLocal === true && manifest.flags.releaseReady === false && manifest.flags.publishAuthorized === false && manifest.flags.released === false, manifest.flags);
  const metas = [];
  for (const metaPath of Array.isArray(manifest.stageMetaPaths) ? manifest.stageMetaPaths : []) {
    check('manifest meta path containment', path.isAbsolute(metaPath) && isContained(evidenceRoot, metaPath) && realContained(evidenceRoot, metaPath), metaPath);
    if (!fs.existsSync(metaPath)) { check('manifest meta exists', false, metaPath); continue; }
    try { metas.push(readJson(metaPath)); } catch (error) { check('manifest meta parse', false, error.message); }
  }
  check('manifest has 29 stage metas', metas.length === 29, metas.length);
  for (const meta of metas) {
    check(`${meta.stageId} raw files`, fs.existsSync(meta.stdoutPath) && fs.existsSync(meta.stderrPath), `${meta.stdoutPath}/${meta.stderrPath}`);
    if (fs.existsSync(meta.stdoutPath)) check(`${meta.stageId} stdout raw binding`, shaFile(meta.stdoutPath) === meta.stdoutSha256 && fs.statSync(meta.stdoutPath).size === meta.stdoutBytes, meta.stageId);
    if (fs.existsSync(meta.stderrPath)) check(`${meta.stageId} stderr raw binding`, shaFile(meta.stderrPath) === meta.stderrSha256 && fs.statSync(meta.stderrPath).size === meta.stderrBytes, meta.stageId);
    check(`${meta.stageId} command argv binding`, meta.command === ELECTRON && JSON.stringify(meta.spawnVector) === JSON.stringify([meta.command, ...meta.argv]) && meta.argv.includes(FIXTURE_ROOT), meta.argv);
    check(`${meta.stageId} userData argv binding`, meta.argv.includes(`--user-data-dir=${meta.userDataDir}`), meta.userDataDir);
    check(`${meta.stageId} path containment`, isContained(evidenceRoot, meta.stdoutPath) && isContained(evidenceRoot, meta.stderrPath) && realContained(evidenceRoot, meta.stdoutPath) && realContained(evidenceRoot, meta.stderrPath), meta.stageId);
    const raw = readText(meta.stdoutPath) + '\n' + readText(meta.stderrPath);
    check(`${meta.stageId} not summary-only`, raw.includes('=== 044 EVALUATION_RESULT ===') && raw.includes(meta.stageId), raw.slice(-500));
    check(`${meta.stageId} not only exit mutation`, !meta.expectedFailure || (meta.semanticResult && meta.semanticResult.defect === true && raw.includes('"defect":true')), meta.stageId);
  }
  const migration = metas.find(meta => meta.stageId === 'core-migration-concurrent-hydrate');
  const restart = metas.find(meta => meta.stageId === 'core-graceful-close-same-origin-restart');
  check('restart argv uses migration userData', !!migration && !!restart && restart.userDataDir === migration.userDataDir && restart.argv.includes(`--user-data-dir=${migration.userDataDir}`), `${migration && migration.userDataDir}/${restart && restart.userDataDir}`);
  const throwStage = metas.find(meta => meta.stageId === 'core-idb-open-throws-fallback');
  const eventStage = metas.find(meta => meta.stageId === 'core-idb-open-error-event-fallback');
  check('throw path not swallowed', !!throwStage && throwStage.semanticResult && throwStage.semanticResult.injectionEvidence && throwStage.semanticResult.durableResult && throwStage.semanticResult.durableResult.ok === false, throwStage && throwStage.semanticResult);
  check('error-event path not swallowed', !!eventStage && eventStage.semanticResult && eventStage.semanticResult.injectionEvidence && eventStage.semanticResult.injectionEvidence.errorEvent && eventStage.semanticResult.injectionEvidence.errorEvent.event === true && eventStage.semanticResult.durableResult && eventStage.semanticResult.durableResult.ok === false, eventStage && eventStage.semanticResult);
  check('Store source remains unchanged', shaFile(path.join(ROOT, 'app/js/store.js')) === EXPECTED_STORE_SHA, shaFile(path.join(ROOT, 'app/js/store.js')));
  return metas;
}

function adversarialChecks(metas) {
  const all = [];
  const dirs = [evidenceRoot, selfRoot];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else all.push(full);
      }
    };
    walk(dir);
  }
  const text = all.filter(file => /\.(?:json|txt|md)$/i.test(file)).map(file => readText(file)).join('\n');
  check('attack reuse predecessor raw paths', !/XJ-5\.1\.1-billing-store-hydration-legacy-migration-concurrency-(?:evidence-rework-043|no-context-independent-review-042|fix-no-context-independent-review-041)[\\/]/i.test(text), 'path scan');
  check('attack summary-only', metas.every(meta => readText(meta.stdoutPath).includes('=== 044 EVALUATION_RESULT ===')), 'all stage stdout contains evaluation result');
  check('attack only fake exitCode', metas.filter(meta => meta.expectedFailure).every(meta => meta.semanticResult && meta.semanticResult.defect === true && meta.exitCodeSource === 'semantic-gate-defect'), 'mutated semantic gate');
  check('attack fake ok:true on degrade', metas.filter(meta => /idb-open-(?:throws|error-event)-fallback/.test(meta.stageId)).every(meta => meta.semanticResult && meta.semanticResult.durableResult && meta.semanticResult.durableResult.ok === false), 'durable failure explicit');
  check('attack snapshot-as-migration', metas.filter(meta => meta.stageId === 'core-migration-concurrent-hydrate').every(meta => meta.semanticResult && meta.semanticResult.runtimeProbe && meta.semanticResult.runtimeProbe.realElectron === true && meta.semanticResult.capturedBlobPut && meta.semanticResult.clientRecord && meta.semanticResult.clientRecord.key === 'clients'), 'live IDB/blob evidence');
  check('attack missing stderr/SHA/bytes', metas.every(meta => typeof meta.stderrSha256 === 'string' && Number.isInteger(meta.stderrBytes) && typeof meta.stdoutSha256 === 'string' && Number.isInteger(meta.stdoutBytes)), 'schema completeness');
  check('attack relative cwd', metas.every(meta => path.isAbsolute(meta.cwd) && meta.cwd === ROOT), 'cwd');
  check('attack sibling-prefix containment', metas.every(meta => isContained(evidenceRoot, meta.stdoutPath) && isContained(evidenceRoot, meta.stderrPath)), 'containment');
  check('attack junction containment', metas.every(meta => realContained(evidenceRoot, meta.stdoutPath) && realContained(evidenceRoot, meta.stderrPath)), 'realpath containment');
  check('attack wrong argv/userData', metas.every(meta => meta.argv.includes(`--user-data-dir=${meta.userDataDir}`)), 'argv/userData');
  check('attack old origin', metas.every(meta => meta.fixedOrigin === 'http://127.0.0.1:19421' && meta.semanticResult && meta.semanticResult.runtimeProbe && meta.semanticResult.runtimeProbe.origin === 'http://127.0.0.1:19421'), 'origin');
}

function main() {
  const selfMetas = ['runner', 'verifier', 'expected-red'].map(verifySelfTriplet);
  const metas = verifyEvidence();
  adversarialChecks(metas);
  const output = { tool: 'audit-044', taskId: TASK, runId: identity.runId, evidenceRoot, pass: failures.length === 0, passCount: passes.length, failCount: failures.length, selfTriplets: selfMetas.filter(Boolean).map(meta => ({ role: meta.role, verdict: meta.verdict, childExitCode: meta.childExitCode })), failures, passes: passes.slice(0, 40) };
  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exitCode = 1;
}

main();
