'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var original = require("D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-case-atlas\\case-atlas-view-model.js");
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\M9-remove-30-session-minimum_mutant.js");

// STEP 1: Baseline — assertion against ORIGINAL module must PASS
(function() {
  var mutant = original; // shadow: assertion code uses `mutant` variable
  try {
  var input = fixtures.toPrototypeInput();
  input.sessions = input.sessions.slice(0, 10);
  var threw = false;
  try {
    mutant.createViewModel(input);
  } catch (e) {
    threw = true;
  }
  if (!threw) throw new Error('10-session fixture accepted — minimum removed');
    console.log('BASELINE_PASS');
  } catch (e) {
    console.log('BASELINE_FAIL: ' + e.message);
    process.exit(2);
  }
})();

// STEP 2: Assertion against MUTANT module — must FAIL
try {
  var input = fixtures.toPrototypeInput();
  input.sessions = input.sessions.slice(0, 10);
  var threw = false;
  try {
    mutant.createViewModel(input);
  } catch (e) {
    threw = true;
  }
  if (!threw) throw new Error('10-session fixture accepted — minimum removed');
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}