'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const ROOT = path.join(WORKSPACE, 'candidate', 'repo');
const EVIDENCE = path.join(WORKSPACE, 'evidence');
const files = [
  'app/js/clinical-context.js',
  'app/js/clinical-task-validators.js',
  'app/js/source-ref.js',
  'app/js/prompt-governance.js',
  'app/js/longitudinal-summary.js',
  'app/js/agent-core.js',
];
const tests = [
  'trusted-ai-provenance-governance-contract.js',
  'longitudinal-summary-candidate-contract.js',
  'prompt-governance-candidate-contract.js',
  'source-context-fail-closed-contract.js',
  'mutation-probes.js',
  'internal-adversarial-review.js',
];
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function run(test) { return cp.spawnSync(process.execPath, [path.join(__dirname, test)], { encoding: 'utf8' }); }

function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const manifest = files.map((relative) => {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) throw new Error('missing candidate artifact: ' + relative);
    const syntax = cp.spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error('syntax failed: ' + relative + '\n' + syntax.stderr);
    return { path: relative.replace(/\\/g, '/'), bytes: fs.statSync(absolute).size, sha256: sha(absolute), syntaxExitCode: syntax.status };
  });
  const results = tests.map((test) => {
    const result = run(test);
    return { test, exitCode: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  });
  const failed = results.filter((item) => item.exitCode !== 0);
  const output = {
    suite: 'verify-artifacts',
    candidateRoot: ROOT,
    manifest,
    tests: results,
    runtimeEvidence: { status: 'BLOCKED', reason: 'Task-local Node VM proves candidate module behavior; isolated real Electron/renderer userData harness is not present in the frozen input and static evidence is not substituted.' },
    pass: failed.length === 0,
  };
  fs.writeFileSync(path.join(EVIDENCE, 'artifact-verification.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVIDENCE, 'candidate-manifest.json'), JSON.stringify({ candidateRoot: ROOT, files: manifest }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ suite: output.suite, artifacts: manifest.length, tests: results.length, failed: failed.length, runtimeEvidence: output.runtimeEvidence.status }, null, 2));
  if (failed.length) process.exit(1);
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
