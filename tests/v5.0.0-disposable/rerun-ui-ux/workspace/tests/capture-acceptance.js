'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../../../../');
const TASK_ID = 'XJ-5.0.0-full-ui-ux-review-successor-391';
const TEST_ROOT = path.join(PROJECT_ROOT, 'tests/v5.0.0-disposable/rerun-ui-ux');
const EVIDENCE_ROOT = path.join(PROJECT_ROOT, 'docs/agent-coordination/v5.0.0/cli-coordination/runs', TASK_ID, 'workspace/evidence');
const COMMAND_ROOT = path.join(EVIDENCE_ROOT, 'commands');

const COMMANDS = [
  { id: '01-run-contract', script: 'workspace/tests/run-contract.js' },
  { id: '02-run-browser-matrix', script: 'workspace/tests/run-browser-matrix.js' },
  { id: '03-interaction-probes', script: 'workspace/tests/interaction-probes.js' },
  { id: '04-mutation-probes', script: 'workspace/tests/mutation-probes.js' },
  { id: '05-verify-artifacts', script: 'workspace/tests/verify-artifacts.js' }
];

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex').toUpperCase(); }

function main() {
  fs.mkdirSync(COMMAND_ROOT, { recursive: true });
  const results = [];
  for (const item of COMMANDS) {
    const command = `node ${item.script}`;
    const result = spawnSync(process.execPath, [item.script], { cwd: TEST_ROOT, encoding: 'utf8', windowsHide: true });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const stdoutPath = path.join(COMMAND_ROOT, `${item.id}.stdout.txt`);
    const stderrPath = path.join(COMMAND_ROOT, `${item.id}.stderr.txt`);
    fs.writeFileSync(stdoutPath, stdout, 'utf8');
    fs.writeFileSync(stderrPath, stderr, 'utf8');
    results.push({
      id: item.id,
      command,
      cwd: TEST_ROOT,
      exit_code: result.status === null ? 1 : result.status,
      signal: result.signal || null,
      stdout_path: path.relative(path.dirname(EVIDENCE_ROOT), stdoutPath).replaceAll(path.sep, '/'),
      stderr_path: path.relative(path.dirname(EVIDENCE_ROOT), stderrPath).replaceAll(path.sep, '/'),
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr)
    });
  }
  const output = { task_id: TASK_ID, generated_at: new Date().toISOString(), commands: results };
  fs.writeFileSync(path.join(EVIDENCE_ROOT, 'acceptance-command-results.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const failed = results.filter((item) => item.exit_code !== 0);
  if (failed.length) {
    console.error(`ACCEPTANCE CAPTURE FAIL: ${failed.map((item) => `${item.id}=${item.exit_code}`).join(',')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ACCEPTANCE CAPTURE PASS commands=${results.length} exits=${results.map((item) => item.exit_code).join(',')}`);
}

try { main(); } catch (error) { console.error(`ACCEPTANCE CAPTURE ERROR: ${error.message}`); process.exitCode = 1; }
