'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { workspace: WORKSPACE, candidateRoot: ROOT, inputRoot: INPUT, evidenceFile } = require('./harness-paths');
const INPUT_ROOT = path.join(INPUT, 'baseline-candidate');
const files = [
  'app/js/clinical-context.js',
  'app/js/clinical-task-validators.js',
  'app/js/source-ref.js',
  'app/js/prompt-governance.js',
  'app/js/longitudinal-summary.js',
  'app/js/agent-core.js',
];
const tests = [
  'source-context-admission-contract.js',
  'trusted-ai-provenance-governance-contract.js',
  'longitudinal-summary-candidate-contract.js',
  'prompt-governance-candidate-contract.js',
  'mutation-probes.js',
  'internal-adversarial-review.js',
];
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(); }
function run(test) { return cp.spawnSync(process.execPath, [path.join(__dirname, test)], { encoding: 'utf8' }); }

function main() {
  const evidenceDir = path.dirname(evidenceFile('artifact-verification.json'));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const manifest = files.map((relative) => {
    const absolute = path.join(ROOT, relative);
    const baseline = path.join(INPUT_ROOT, relative);
    if (!fs.existsSync(absolute) || !fs.existsSync(baseline)) throw new Error('missing candidate or baseline artifact: ' + relative);
    const syntax = cp.spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error('syntax failed: ' + relative + '\n' + syntax.stderr);
    return {
      path: relative.replace(/\\/g, '/'),
      bytes: fs.statSync(absolute).size,
      sha256: sha(absolute),
      baselineSha256: sha(baseline),
      changedFromBaseline: sha(absolute) !== sha(baseline),
      syntaxExitCode: syntax.status,
    };
  });
  const results = tests.map((test) => {
    const result = run(test);
    return { test, exitCode: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
  });
  const failed = results.filter((item) => item.exitCode !== 0);
  const changed = manifest.filter((item) => item.changedFromBaseline).map((item) => item.path);
  const expectedChanged = [
    'app/js/clinical-context.js',
    'app/js/longitudinal-summary.js',
    'app/js/prompt-governance.js',
  ];
  if (changed.slice().sort().join(',') !== expectedChanged.slice().sort().join(',')) throw new Error('candidate change scope mismatch: ' + changed.join(','));
  const output = {
    suite: 'verify-artifacts',
    candidateRoot: ROOT,
    manifest,
    changedFiles: changed,
    tests: results,
    runtimeEvidence: {
      status: 'BLOCKED',
      reason: 'Task-local Node VM proves isolated candidate behavior; no frozen isolated Electron/renderer userData harness exists, so Electron acceptance is not claimed.',
    },
    pass: failed.length === 0,
  };
  fs.writeFileSync(evidenceFile('artifact-verification.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
  fs.writeFileSync(evidenceFile('candidate-manifest.json'), JSON.stringify({ candidateRoot: ROOT, files: manifest, changedFiles: changed }, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ suite: output.suite, artifacts: manifest.length, changedFiles: changed, tests: results.length, failed: failed.length, runtimeEvidence: output.runtimeEvidence.status }, null, 2));
  if (failed.length) process.exit(1);
}

try { main(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
