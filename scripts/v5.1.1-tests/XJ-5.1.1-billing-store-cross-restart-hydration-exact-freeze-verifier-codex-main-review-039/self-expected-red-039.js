'use strict';

const fs = require('fs');
const path = require('path');

const TASK_ID = 'XJ-5.1.1-billing-store-cross-restart-hydration-exact-freeze-verifier-codex-main-review-039';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', TASK_ID);

function main() {
  const runsRoot = path.join(SCRATCH, 'runs');
  const runs = fs.readdirSync(runsRoot).filter((name) => name.startsWith('run-039-')).sort();
  if (!runs.length) throw new Error('expected-red run missing');
  const runId = runs[runs.length - 1];
  const result = JSON.parse(fs.readFileSync(path.join(runsRoot, runId, 'expected-red-results.json'), 'utf8'));
  if (result.taskId !== TASK_ID || result.runId !== runId || result.verdict !== 'PASS' || result.killed !== result.caseCount || result.restorePass !== result.caseCount || result.caseCount < 15) {
    throw new Error('expected-red result contract failed');
  }
  process.stdout.write(`${JSON.stringify({ type: 'expected-red-self-summary', taskId: TASK_ID, runId, caseCount: result.caseCount, killed: result.killed, restorePass: result.restorePass, verdict: 'PASS' })}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${JSON.stringify({ type: 'expected-red-self-error', taskId: TASK_ID, error: String(error.message || error) })}\n`);
  process.exitCode = 1;
}
