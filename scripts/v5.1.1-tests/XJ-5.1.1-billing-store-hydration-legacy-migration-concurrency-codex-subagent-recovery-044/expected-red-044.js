'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK,
  EXPECTED_STORE_SHA,
  loadIdentity,
  readJson,
  shaFile,
  isContained,
  realContained,
} = require('./common-044');

const identity = loadIdentity();
const evidenceRoot = identity.evidenceRoot;
const failures = [];
const passes = [];
const labels = [
  '01-delete-migration',
  '02-wrong-key-map',
  '03-keep-old-keys',
  '04-skip-await',
  '05-swallow-open-error',
  '06-object-as-array-api',
  '07-hydrate-reset',
  '08-ghost-cross-origin',
];

function check(label, condition, detail) {
  (condition ? passes : failures).push({ label, detail: String(detail || '').slice(0, 500) });
}

function rawText(meta) {
  try { return `${fs.readFileSync(meta.stdoutPath, 'utf8')}\n${fs.readFileSync(meta.stderrPath, 'utf8')}`; } catch (_) { return ''; }
}

function verifyRaw(meta) {
  check(`${meta.stageId} stdout contained`, typeof meta.stdoutPath === 'string' && fs.existsSync(meta.stdoutPath), meta.stdoutPath);
  check(`${meta.stageId} stderr contained`, typeof meta.stderrPath === 'string' && fs.existsSync(meta.stderrPath), meta.stderrPath);
  if (!meta.stdoutPath || !meta.stderrPath || !fs.existsSync(meta.stdoutPath) || !fs.existsSync(meta.stderrPath)) return;
  check(`${meta.stageId} stdout path containment`, isContained(evidenceRoot, meta.stdoutPath) && realContained(evidenceRoot, meta.stdoutPath), meta.stdoutPath);
  check(`${meta.stageId} stderr path containment`, isContained(evidenceRoot, meta.stderrPath) && realContained(evidenceRoot, meta.stderrPath), meta.stderrPath);
  check(`${meta.stageId} stdout SHA/bytes`, shaFile(meta.stdoutPath) === meta.stdoutSha256 && fs.statSync(meta.stdoutPath).size === meta.stdoutBytes, meta.stdoutPath);
  check(`${meta.stageId} stderr SHA/bytes`, shaFile(meta.stderrPath) === meta.stderrSha256 && fs.statSync(meta.stderrPath).size === meta.stderrBytes, meta.stderrPath);
  check(`${meta.stageId} raw task/run`, rawText(meta).includes(TASK) && rawText(meta).includes(identity.runId), rawText(meta).slice(0, 450));
}

function main() {
  check('fresh evidence root', fs.existsSync(evidenceRoot), evidenceRoot);
  if (!fs.existsSync(evidenceRoot)) return finish();
  const manifestPath = path.join(evidenceRoot, 'evidence-manifest.json');
  check('fresh manifest', fs.existsSync(manifestPath), manifestPath);
  let manifest = null;
  try { manifest = readJson(manifestPath); } catch (error) { check('manifest parse', false, error.message); }
  check('manifest identity', manifest && manifest.taskId === TASK && manifest.runId === identity.runId && manifest.cardSha256 === identity.cardSha256, manifest);
  check('manifest Store SHA', manifest && manifest.storeSha256AtStart === EXPECTED_STORE_SHA && manifest.storeSha256AtEnd === EXPECTED_STORE_SHA, manifest);
  const metas = [];
  for (const metaPath of manifest && Array.isArray(manifest.stageMetaPaths) ? manifest.stageMetaPaths : []) {
    try { const meta = readJson(metaPath); metas.push(meta); verifyRaw(meta); } catch (error) { check(`meta ${metaPath}`, false, error.message); }
  }
  const groups = new Map();
  for (const meta of metas.filter(item => item.stageId && item.stageId.startsWith('expected-red/'))) {
    const [label, role] = meta.stageId.split('/').slice(1);
    if (!groups.has(label)) groups.set(label, {});
    groups.get(label)[role] = meta;
  }
  check('exactly eight expected-red labels', labels.every(label => groups.has(label)) && groups.size === 8, Array.from(groups.keys()));
  let killed = 0;
  let restored = 0;
  for (const label of labels) {
    const group = groups.get(label) || {};
    const m = group.mutated;
    const b = group.baseline;
    const r = group.restore;
    const mRaw = m ? rawText(m) : '';
    const bRaw = b ? rawText(b) : '';
    const rRaw = r ? rawText(r) : '';
    const mut = !!m && m.expectedFailure === true && m.verdict === 'KILLED' && m.exitCode === 1 && m.processExitCode === 0 && m.semanticResult && m.semanticResult.defect === true && mRaw.includes('"defect":true');
    const base = !!b && b.expectedFailure === false && b.verdict === 'PASS' && b.exitCode === 0 && b.processExitCode === 0 && b.semanticResult && b.semanticResult.ok === true && bRaw.includes('"ok":true');
    const restore = !!r && r.expectedFailure === false && r.verdict === 'PASS' && r.exitCode === 0 && r.processExitCode === 0 && r.semanticResult && r.semanticResult.ok === true && rRaw.includes('"ok":true');
    if (mut) killed++;
    if (restore) restored++;
    check(`${label} mutated KILLED is semantic`, mut, { mutated: m && { verdict: m.verdict, exitCode: m.exitCode, processExitCode: m.processExitCode, defect: m.semanticResult && m.semanticResult.defect } });
    check(`${label} baseline PASS`, base, b && b.semanticResult);
    check(`${label} restore PASS`, restore, r && r.semanticResult);
    check(`${label} baseline/restore independent`, !!b && !!r && b.userDataDir !== r.userDataDir && b.stdoutPath !== r.stdoutPath && r.stdoutPath !== b.stdoutPath, `${b && b.userDataDir}/${r && r.userDataDir}`);
  }
  check('8/8 mutated KILLED', killed === 8, `${killed}/8`);
  check('8/8 restore PASS', restored === 8, `${restored}/8`);
  const positiveKilled = metas.filter(meta => !meta.expectedFailure && meta.verdict === 'KILLED');
  check('positive robustness not counted as KILLED', positiveKilled.length === 0, positiveKilled.map(meta => meta.stageId));
  check('current Store SHA', shaFile(path.join(identity.scriptRoot, '..', '..', '..', 'app/js/store.js')) === EXPECTED_STORE_SHA, 'Store source SHA');
  finish();
}

function finish() {
  const output = { tool: 'expected-red-044', taskId: TASK, runId: identity.runId, evidenceRoot, pass: failures.length === 0, killed: passes.filter(item => /KILLED/.test(item.label)).length, failures, passes: passes.slice(0, 24) };
  console.log(JSON.stringify(output, null, 2));
  if (failures.length) process.exitCode = 1;
}

main();
