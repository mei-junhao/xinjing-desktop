'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);
const VERIFIER = path.join(__dirname, 'verifier-039.js');
const BINDING = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035', 'binding', 'run-035-20260827063639-5a43423c511376', 'final-binding-files-035.json');
const MANIFEST = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-identity-rework-035', 'binding', 'run-035-20260827063639-5a43423c511376', 'final-binding-manifest-035.json');

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function shaFile(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function assertMeta(meta, expectedTool) {
  const fields = ['schema', 'taskId', 'tool', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes', 'verdict'];
  assert(JSON.stringify(Object.keys(meta).sort()) === JSON.stringify(fields.sort()), `${expectedTool} self meta fields mismatch`);
  assert(meta.taskId === TASK_ID && meta.tool === expectedTool, `${expectedTool} self identity mismatch`);
  assert(path.isAbsolute(meta.cwd) && path.isAbsolute(meta.stdoutPath) && path.isAbsolute(meta.stderrPath), `${expectedTool} self path not absolute`);
  assert(fs.existsSync(meta.stdoutPath) && fs.existsSync(meta.stderrPath), `${expectedTool} self raw missing`);
  assert(shaFile(meta.stdoutPath) === meta.stdoutSha256, `${expectedTool} stdout SHA mismatch`);
  assert(shaFile(meta.stderrPath) === meta.stderrSha256, `${expectedTool} stderr SHA mismatch`);
  assert(fs.statSync(meta.stdoutPath).size === meta.stdoutBytes, `${expectedTool} stdout bytes mismatch`);
  assert(fs.statSync(meta.stderrPath).size === meta.stderrBytes, `${expectedTool} stderr bytes mismatch`);
  assert(meta.verdict === 'PASS' && meta.exitCode === 0, `${expectedTool} self not PASS`);
}

function assertCaseMeta(meta, item, stage, expectedExit) {
  const fields = ['schema', 'taskId', 'caseId', 'stage', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes', 'verdict'];
  assert(JSON.stringify(Object.keys(meta).sort()) === JSON.stringify(fields.sort()), `${item.caseId}/${stage} meta fields mismatch`);
  assert(meta.taskId === TASK_ID && meta.caseId === item.caseId && meta.stage === stage, `${item.caseId}/${stage} identity mismatch`);
  assert(meta.exitCode === expectedExit, `${item.caseId}/${stage} exit mismatch`);
  assert(path.isAbsolute(meta.cwd) && path.isAbsolute(meta.stdoutPath) && path.isAbsolute(meta.stderrPath), `${item.caseId}/${stage} path not absolute`);
  assert(fs.existsSync(meta.stdoutPath) && fs.existsSync(meta.stderrPath), `${item.caseId}/${stage} raw missing`);
  assert(shaFile(meta.stdoutPath) === meta.stdoutSha256, `${item.caseId}/${stage} stdout SHA mismatch`);
  assert(shaFile(meta.stderrPath) === meta.stderrSha256, `${item.caseId}/${stage} stderr SHA mismatch`);
  assert(fs.statSync(meta.stdoutPath).size === meta.stdoutBytes, `${item.caseId}/${stage} stdout bytes mismatch`);
  assert(fs.statSync(meta.stderrPath).size === meta.stderrBytes, `${item.caseId}/${stage} stderr bytes mismatch`);
  if (stage === 'baseline' || stage === 'restore') assert(meta.verdict === 'PASS', `${item.caseId}/${stage} verdict mismatch`);
  if (stage === 'mutated') assert(meta.verdict !== 'PASS', `${item.caseId}/${stage} survived`);
}

function main() {
  const runs = fs.readdirSync(path.join(SCRATCH, 'runs')).filter((name) => name.startsWith('run-039-')).sort();
  assert(runs.length > 0, 'no expected-red run found');
  const runId = runs[runs.length - 1];
  const runRoot = path.join(SCRATCH, 'runs', runId);
  const results = readJson(path.join(runRoot, 'expected-red-results.json'));
  assert(results.taskId === TASK_ID && results.runId === runId, 'expected-red identity mismatch');
  assert(results.caseCount >= 15 && results.killed === results.caseCount && results.restorePass === results.caseCount && results.verdict === 'PASS', 'expected-red summary incomplete');
  const rawPaths = new Set();
  for (const item of results.cases) {
    assert(item.killed === true, `${item.caseId} not killed`);
    for (const stage of ['baseline', 'mutated', 'restore']) {
      const meta = item[stage].meta;
      const metaPath = item[stage].metaPath;
      assert(path.normalize(metaPath) === path.normalize(path.join(runRoot, 'cases', item.caseId, stage, 'raw', 'meta.json')), `${item.caseId}/${stage} meta path mismatch`);
      assertCaseMeta(meta, item, stage, stage === 'mutated' ? 1 : 0);
      assert(meta.caseId === item.caseId && meta.stage === stage, `${item.caseId}/${stage} stage identity mismatch`);
      assert(!rawPaths.has(meta.stdoutPath) && !rawPaths.has(meta.stderrPath) && !rawPaths.has(metaPath), `${item.caseId}/${stage} raw path reused`);
      rawPaths.add(meta.stdoutPath); rawPaths.add(meta.stderrPath); rawPaths.add(metaPath);
      if (stage === 'baseline' || stage === 'restore') assert(meta.exitCode === 0 && meta.verdict === 'PASS', `${item.caseId}/${stage} not PASS`);
      if (stage === 'mutated') assert(meta.exitCode !== 0 && meta.verdict !== 'PASS', `${item.caseId} mutation survived`);
    }
  }
  const verifierSelf = path.join(runRoot, 'self', 'verifier', 'meta.json');
  const expectedSelf = path.join(runRoot, 'self', 'expected-red', 'meta.json');
  const auditSelf = path.join(runRoot, 'self', 'audit', 'meta.json');
  for (const [tool, metaPath] of [['verifier', verifierSelf], ['expected-red', expectedSelf]]) {
    assert(fs.existsSync(metaPath), `${tool} self meta missing`);
    assertMeta(readJson(metaPath), tool);
  }
  const selfAuditMode = process.argv.includes('--self-audit');
  if (!selfAuditMode) {
    assert(fs.existsSync(auditSelf), 'audit self meta missing');
    assertMeta(readJson(auditSelf), 'audit');
  }
  const verifierChild = spawnSync(process.execPath, [VERIFIER, '--binding', BINDING, '--manifest', MANIFEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert(verifierChild.status === 0, `independent verifier rerun failed: ${verifierChild.status}`);
  const verdict = JSON.parse(String(verifierChild.stdout).trim());
  assert(verdict.verdict === 'PASS' && verdict.aggregate === '1d438e41037ff1953ef1ad448c711c56f01094eb980669664f5efd6141e787f6', 'independent verifier verdict mismatch');
  const summary = { type: 'audit-summary', taskId: TASK_ID, runId, caseCount: results.caseCount, killed: results.killed, restorePass: results.restorePass, rawCount: rawPaths.size, verifierRerunExit: verifierChild.status, verdict: 'PASS' };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ type: 'audit-error', taskId: TASK_ID, error: String(error.message || error), stack: String(error.stack || '') })}\n`);
  process.exitCode = 1;
}
