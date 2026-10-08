'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const TASK_ID = 'XJ-5.0.0-codex-v4.3-deletion-tombstone-recovery-29';
const TASK_DIR = __dirname;
const INVENTORY_DIR = path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-v4.3-deletion-tombstone-recovery-29');
const MANIFEST_PATH = path.join(INVENTORY_DIR, 'protected-files-manifest.json');
const CONTRACT_RESULT_PATH = path.join(INVENTORY_DIR, 'contract-result.json');
const MUTATION_RESULT_PATH = path.join(INVENTORY_DIR, 'mutation-result.json');
const REPORT_PATH = path.join(ROOT, 'qa', 'agent-reviews', TASK_ID + '.md');

const checks = [];
function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}
function check(id, condition, evidence) {
  const pass = !!condition;
  checks.push({ id, pass, evidence });
  console.log('[' + (pass ? 'PASS' : 'FAIL') + '] ' + id + ' ' + evidence);
  return pass;
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const manifest = readJson(MANIFEST_PATH);
check('TASK_ID', manifest.task_id === TASK_ID, 'protected manifest task id matches');
check('BASE_COMMIT', manifest.base_commit === '9971787eb6e443ab5a5c80aee118b9b43285c093', 'protected manifest base commit matches task card');
(manifest.files || []).forEach((entry, index) => {
  const filePath = path.join(ROOT, entry.path);
  check('PROTECTED_' + index, fs.existsSync(filePath) && sha256(filePath) === String(entry.sha256).toUpperCase(), entry.path + ' hash matches');
});

const expectedFiles = new Set(['run-contract.js', 'mutation-probes.js', 'verify-artifacts.js', 'contract-result.json', 'mutation-result.json']);
const actualFiles = new Set(fs.readdirSync(TASK_DIR).filter((name) => fs.statSync(path.join(TASK_DIR, name)).isFile()));
check('STRICT_FILE_SET', actualFiles.size === expectedFiles.size && [...actualFiles].every((name) => expectedFiles.has(name)), 'task artifact directory contains only the declared files');

const contractResult = readJson(CONTRACT_RESULT_PATH);
check('CONTRACT_RESULT_ID', contractResult.task_id === TASK_ID, 'contract result task id matches');
check('CONTRACT_RESULT_GREEN', contractResult.status === 'PASS' && contractResult.failed === 0 && contractResult.confirmed >= 30, 'contract result is green with real confirmed checks');
check('CONTRACT_CHECKS_GREEN', Array.isArray(contractResult.checks) && contractResult.checks.length >= 30 && contractResult.checks.every((item) => item.pass === true), 'all focused contract checks pass');
check('CONTRACT_NO_EXPECTED_RED', contractResult.expected_red === 0, 'implemented contract has no remaining expected-red rows');

const mutationResult = readJson(MUTATION_RESULT_PATH);
check('MUTATION_RESULT_ID', mutationResult.task_id === TASK_ID, 'mutation result task id matches');
check('MUTATION_KILLED', mutationResult.killed >= 10 && mutationResult.survived === 0 && mutationResult.killed === mutationResult.total, 'all semantic mutations are killed');
check('MUTATION_DETERMINISTIC', mutationResult.determinism === 'no volatile fields; hash-stable across healthy runs', 'mutation result is deterministic');

check('REPORT_EXISTS', fs.existsSync(REPORT_PATH), 'delivery report exists');
if (fs.existsSync(REPORT_PATH)) {
  const report = fs.readFileSync(REPORT_PATH, 'utf8');
  const lines = report.split(/\r?\n/);
  check('REPORT_TAIL', lines[lines.length - 1] === 'DELIVERY_REPORT: ' + REPORT_PATH, 'delivery report has the strict final line');
  check('REPORT_ADVERSARIAL', report.includes('内部对抗审查'), 'delivery report contains the adversarial review section');
}

const failed = checks.filter((item) => !item.pass).length;
const output = {
  task_id: TASK_ID,
  status: failed === 0 ? 'PASS' : 'FAIL',
  failed,
  checks,
};
console.log(JSON.stringify(output, null, 2));
process.exitCode = failed === 0 ? 0 : 1;
