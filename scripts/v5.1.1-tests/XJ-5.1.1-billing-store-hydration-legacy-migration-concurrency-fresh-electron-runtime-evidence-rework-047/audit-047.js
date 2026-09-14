'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  TASK,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  EXPECTED_STORE_SHA,
  shaFile,
  shaBytes,
  readJson,
  loadIdentity,
  isContained,
  realContained,
} = require('./common-047');

const identity = loadIdentity();
const evidenceRoot = identity.evidenceRoot;
const failures = [];
const passes = [];
function check(label, condition, detail) { (condition ? passes : failures).push({ label, detail }); }
function checkRaw(meta, field, shaField, bytesField) {
  const file = meta[field];
  check(`${meta.stageId} ${field} path`, path.isAbsolute(file) && isContained(evidenceRoot, file) && realContained(evidenceRoot, file), file);
  if (!file || !fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  check(`${meta.stageId} ${field} sha`, shaBytes(bytes) === meta[shaField], `${meta[shaField]}/${shaBytes(bytes)}`);
  check(`${meta.stageId} ${field} bytes`, bytes.length === meta[bytesField], `${meta[bytesField]}/${bytes.length}`);
  const stat = fs.lstatSync(file);
  check(`${meta.stageId} ${field} regular`, stat.isFile() && !stat.isSymbolicLink(), stat);
}
function auditStage(meta) {
  const expected = ['schema','taskId','inputTaskId','runId','runNonce','cardSha256','storeSha256','protectedFilesManifestSha256','fixedOrigin','stageId','phase','role','expectedFailure','command','argv','spawnVector','cwd','startUtc','endUtc','processExitCode','processSignal','exitCode','exitCodeSource','verdict','closeMode','forcedTermination','runtime','realElectron','fixtureRoot','fixtureUrl','cdpPort','userDataDir','evidenceRoot','stdoutPath','stderrPath','stdoutSha256','stderrSha256','stdoutBytes','stderrBytes','semanticResult','runnerError'];
  check(`${meta.stageId} exact keys`, JSON.stringify(Object.keys(meta).sort()) === JSON.stringify(expected.sort()), Object.keys(meta));
  check(`${meta.stageId} time order`, Date.parse(meta.startUtc) < Date.parse(meta.endUtc), `${meta.startUtc}/${meta.endUtc}`);
  checkRaw(meta, 'stdoutPath', 'stdoutSha256', 'stdoutBytes');
  checkRaw(meta, 'stderrPath', 'stderrSha256', 'stderrBytes');
}
function auditSelf() {
  const selfRoot = path.join(SCRATCH_ROOT, 'self', identity.runId);
  for (const label of ['runner-047', 'verifier-047', 'expected-red-047', 'audit-047']) {
    const dir = path.join(selfRoot, label);
    const metaPath = path.join(dir, 'meta.json');
    const outPath = path.join(dir, 'stdout.txt');
    const errPath = path.join(dir, 'stderr.txt');
    check(`self ${label} meta`, fs.existsSync(metaPath), metaPath);
    check(`self ${label} stdout`, fs.existsSync(outPath), outPath);
    check(`self ${label} stderr`, fs.existsSync(errPath), errPath);
    if (!fs.existsSync(metaPath)) continue;
    const meta = readJson(metaPath);
    check(`self ${label} task`, meta.taskId === TASK && meta.runId === identity.runId && meta.runNonce === identity.runNonce, meta);
    check(`self ${label} cwd`, meta.cwd === ROOT && path.isAbsolute(meta.cwd), meta.cwd);
    check(`self ${label} command`, meta.command === process.execPath && path.isAbsolute(meta.command), meta.command);
    check(`self ${label} argv`, Array.isArray(meta.argv) && meta.argv.length === 1 && path.isAbsolute(meta.argv[0]), meta.argv);
    check(`self ${label} time`, Date.parse(meta.startUtc) < Date.parse(meta.endUtc), `${meta.startUtc}/${meta.endUtc}`);
    for (const [field, shaField, bytesField, actual] of [['stdoutPath','stdoutSha256','stdoutBytes',outPath],['stderrPath','stderrSha256','stderrBytes',errPath]]) {
      check(`self ${label} ${field} binding`, path.resolve(meta[field]) === path.resolve(actual), `${meta[field]}/${actual}`);
      if (fs.existsSync(actual)) {
        const bytes = fs.readFileSync(actual);
        check(`self ${label} ${field} sha`, shaBytes(bytes) === meta[shaField], `${meta[shaField]}/${shaBytes(bytes)}`);
        check(`self ${label} ${field} bytes`, bytes.length === meta[bytesField], `${meta[bytesField]}/${bytes.length}`);
      }
    }
  }
}
function main() {
  check('evidence root', fs.existsSync(evidenceRoot) && isContained(SCRATCH_ROOT, evidenceRoot) && realContained(SCRATCH_ROOT, evidenceRoot), evidenceRoot);
  const manifest = readJson(path.join(evidenceRoot, 'evidence-manifest.json'));
  check('manifest stage count', manifest.stageCount === 29 && manifest.stageMetaPaths.length === 29, manifest.stageCount);
  const metas = manifest.stageMetaPaths.map(file => readJson(file));
  metas.forEach(auditStage);
  check('metas unique', new Set(metas.map(item => item.stageId)).size === 29, metas.map(item => item.stageId));
  check('store unchanged', shaFile(path.join(ROOT, 'app/js/store.js')) === EXPECTED_STORE_SHA, shaFile(path.join(ROOT, 'app/js/store.js')));
  check('card unchanged', shaFile(path.join(ROOT, 'docs/agent-coordination/v5.1.1/tasks', `${TASK}.md`)) === identity.cardSha256, identity.cardSha256);
  auditSelf();
  const output = { audit: '047', taskId: TASK, runId: identity.runId, evidenceRoot, pass: failures.length === 0, passCount: passes.length, failCount: failures.length, failures, passes: passes.slice(0, 60) };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}
main();
