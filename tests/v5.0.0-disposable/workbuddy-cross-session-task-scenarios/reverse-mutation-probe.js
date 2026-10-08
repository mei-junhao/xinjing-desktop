'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const VALIDATOR_PATH = path.join(__dirname, 'validate-scenarios.js');
const MATRIX_PATH = path.resolve(__dirname, '../../../docs/agent-coordination/v5.0.0/inventory/workbuddy-cross-session-task-scenarios/scenario-matrix.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let source = fs.readFileSync(VALIDATOR_PATH, 'utf8');
const statusAnchor = "if (REQUIRED_STATUS_BY_ID[s.id] && s.current_evidence_status !== REQUIRED_STATUS_BY_ID[s.id]) {";
const proofAnchor = "if (s.current_evidence_status === 'CONFIRMED' && !/tests\\/v5\\.0\\.0-production|durable Store|生产契约|run-contract/i.test(s.source_anchor)) {";
if (!source.includes(statusAnchor) || !source.includes(proofAnchor)) {
  throw new Error('reverse mutation anchor missing');
}
source = source
  .replace(statusAnchor, 'if (false) {')
  .replace(proofAnchor, 'if (false) {');

const mutatedModule = new Module(VALIDATOR_PATH + '.mutated', module);
mutatedModule.filename = VALIDATOR_PATH;
mutatedModule.paths = Module._nodeModulePaths(path.dirname(VALIDATOR_PATH));
mutatedModule._compile(source, VALIDATOR_PATH);

const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
const healthy = mutatedModule.exports.validateMatrix(clone(matrix));
if (!healthy.passed) throw new Error('weakened validator broke healthy baseline for an unrelated reason');

const semanticMutation = clone(matrix);
semanticMutation.scenarios.find((item) => item.id === 'S02-viewing-in-later-session-b').current_evidence_status = 'CONFIRMED';
const semanticOnly = mutatedModule.exports.validateMatrix(semanticMutation, { skipHashCheck: true });
if (!semanticOnly.passed) {
  throw new Error('weakened validator still detected the target mutation: ' + semanticOnly.errors.join(' | '));
}

const maskedMutation = clone(semanticMutation);
maskedMutation.protected_hashes.files['app/js/store.js'] = '0'.repeat(64);
const maskedResult = mutatedModule.exports.validateMatrix(maskedMutation, { skipHashCheck: false });
const oldRunnerWouldClaimKilled = !maskedResult.passed;
const targetError = 'S02-viewing-in-later-session-b evidence status 不符合冻结证据';
const newRunnerWouldClaimKilled = maskedResult.errors.some((error) => String(error).includes(targetError));

if (!oldRunnerWouldClaimKilled || newRunnerWouldClaimKilled) {
  throw new Error('masking demonstration did not reproduce the old false-green classification');
}

console.log(JSON.stringify({
  reverse_mutation: 'remove frozen-status and CONFIRMED-proof detectors',
  semantic_mutation_survived: true,
  global_hash_drift_present: true,
  old_nonzero_only_runner_would_claim_killed: true,
  targeted_runner_would_claim_killed: false,
  result: 'PASS: masking attack reproduced and the new targeted classifier rejects it'
}, null, 2));
