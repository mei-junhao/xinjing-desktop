'use strict';

const fs = require('fs');
const {
  validateMatrix,
  MATRIX_PATH
} = require('./validate-scenarios.js');

function loadMatrix() {
  return JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasError(result, fragment) {
  return result.errors.some((error) => String(error).includes(fragment));
}

const baseline = validateMatrix(loadMatrix());
if (!baseline.passed) {
  console.error(JSON.stringify({
    overall: 'FAIL',
    reason: 'healthy-baseline-failed',
    errors: baseline.errors
  }, null, 2));
  process.exit(1);
}

const probes = [];

function probe(name, mutate, expectedError, options) {
  const matrix = clone(loadMatrix());
  mutate(matrix);
  const result = validateMatrix(matrix, Object.assign({ skipHashCheck: true }, options));
  const targeted = !result.passed && hasError(result, expectedError);
  probes.push({
    mutation: name,
    expected_error: expectedError,
    result: targeted ? 'KILLED' : 'SURVIVED',
    observed_errors: result.errors
  });
}

probe('remove-required-scenario', (matrix) => {
  matrix.scenarios = matrix.scenarios.filter((item) => item.id !== 'S01-creating-task-in-session-a');
}, '缺失必填场景: S01-creating-task-in-session-a');

probe('duplicate-scenario-id', (matrix) => {
  matrix.scenarios.push(clone(matrix.scenarios[0]));
}, '重复场景 id: S01-creating-task-in-session-a');

probe('corrupt-manifest-hash', (matrix) => {
  matrix.protected_hashes.manifest_sha256 = 'DEADBEEF'.repeat(8);
}, 'manifest sha256 不匹配', { skipHashCheck: false });

probe('fabricate-later-session-confirmed', (matrix) => {
  matrix.scenarios.find((item) => item.id === 'S02-viewing-in-later-session-b').current_evidence_status = 'CONFIRMED';
}, 'S02-viewing-in-later-session-b evidence status 不符合冻结证据');

probe('remove-failure-expectation', (matrix) => {
  matrix.scenarios.find((item) => item.id === 'S03-dashboard-visibility').failure_expectation = '';
}, 'S03-dashboard-visibility 缺失字段: failure_expectation');

probe('remove-mismatch-coverage', (matrix) => {
  matrix.scenarios = matrix.scenarios.filter((item) => item.id !== 'S08-client-session-mismatch');
}, '缺失必填场景: S08-client-session-mismatch');

probe('remove-deletion-coverage', (matrix) => {
  matrix.scenarios = matrix.scenarios.filter((item) => item.id !== 'S09-deletion-migration-handling');
}, '缺失必填场景: S09-deletion-migration-handling');

for (const key of ['clinical_body', 'transcript', 'raw_content', 'body', 'content']) {
  probe('inject-body-alias-' + key, (matrix) => {
    matrix.scenarios[0][key] = 'SYNTHETIC_FORBIDDEN_BODY';
  }, '含白名单外字段(被拒绝): ' + key);
}

probe('clear-protected-file-list', (matrix) => {
  matrix.protected_hashes.files = {};
}, '缺失或非空的 protected_hashes.files');

probe('change-confirmed-status-to-unverified', (matrix) => {
  matrix.scenarios.find((item) => item.id === 'S01-creating-task-in-session-a').current_evidence_status = 'UNVERIFIED';
}, 'S01-creating-task-in-session-a evidence status 不符合冻结证据');

// Adversarial control: unrelated global drift is deliberately skipped for a
// semantic mutation. The target status detector must still kill the mutation.
const masked = clone(loadMatrix());
masked.protected_hashes.files['app/js/store.js'] = '0'.repeat(64);
masked.scenarios.find((item) => item.id === 'S02-viewing-in-later-session-b').current_evidence_status = 'CONFIRMED';
const maskedResult = validateMatrix(masked, { skipHashCheck: true });
probes.push({
  mutation: 'global-hash-drift-cannot-mask-target-detector',
  expected_error: 'S02-viewing-in-later-session-b evidence status 不符合冻结证据',
  result: hasError(maskedResult, 'S02-viewing-in-later-session-b evidence status 不符合冻结证据') ? 'KILLED' : 'SURVIVED',
  observed_errors: maskedResult.errors
});

const survived = probes.filter((item) => item.result !== 'KILLED');
console.log(JSON.stringify({
  overall: survived.length ? 'FAIL' : 'PASS',
  baseline: 'PASS',
  killed: probes.length - survived.length,
  survived: survived.length,
  probes
}, null, 2));
process.exit(survived.length ? 1 : 0);
