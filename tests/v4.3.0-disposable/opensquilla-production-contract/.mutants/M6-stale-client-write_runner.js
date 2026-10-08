'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var original = require("D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-case-atlas\\source-ref-adapter.js");
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\M6-stale-client-write_mutant.js");

// STEP 1: Baseline — assertion against ORIGINAL module must PASS
(function() {
  var mutant = original; // shadow: assertion code uses `mutant` variable
  try {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c_alpha', sessionId: 's1' };
  var cur = { sourceVersion: 'synthetic-001', clientId: 'c_BETA_DIFFERENT', sessionId: 's1' };
  var result = mutant.needsCacheInvalidation(snap, cur);
  if (result === false) throw new Error('stale client NOT detected — cross-client write risk');
    console.log('BASELINE_PASS');
  } catch (e) {
    console.log('BASELINE_FAIL: ' + e.message);
    process.exit(2);
  }
})();

// STEP 2: Assertion against MUTANT module — must FAIL
try {
  var snap = { normalizationVersion: '4.3.0-disposable-v1', sourceVersion: 'synthetic-001', clientId: 'c_alpha', sessionId: 's1' };
  var cur = { sourceVersion: 'synthetic-001', clientId: 'c_BETA_DIFFERENT', sessionId: 's1' };
  var result = mutant.needsCacheInvalidation(snap, cur);
  if (result === false) throw new Error('stale client NOT detected — cross-client write risk');
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}