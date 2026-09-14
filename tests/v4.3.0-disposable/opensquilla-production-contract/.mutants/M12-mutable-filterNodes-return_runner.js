'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var original = require("D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-case-atlas\\case-atlas-view-model.js");
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\M12-mutable-filterNodes-return_mutant.js");

// STEP 1: Baseline — assertion against ORIGINAL module must PASS
(function() {
  var mutant = original; // shadow: assertion code uses `mutant` variable
  try {
  var input = fixtures.toPrototypeInput();
  var vm = mutant.createViewModel(input);
  var originalLen = vm.nodes.length;
  // filter 'all' with empty query skips both filter and query blocks,
  // so filtered = nodes.slice() (copy) or nodes (direct ref in mutant).
  // Using 'record' would call .filter() which always creates a new array,
  // masking the slice() mutation.
  var filtered = mutant.filterNodes(vm.nodes, 'all', '');
  filtered.push({ id: 'INJECTED', type: 'record', sourceRef: { id: 'fake' } });
  if (vm.nodes.length !== originalLen) throw new Error('injection affected original array — mutable return');
    console.log('BASELINE_PASS');
  } catch (e) {
    console.log('BASELINE_FAIL: ' + e.message);
    process.exit(2);
  }
})();

// STEP 2: Assertion against MUTANT module — must FAIL
try {
  var input = fixtures.toPrototypeInput();
  var vm = mutant.createViewModel(input);
  var originalLen = vm.nodes.length;
  // filter 'all' with empty query skips both filter and query blocks,
  // so filtered = nodes.slice() (copy) or nodes (direct ref in mutant).
  // Using 'record' would call .filter() which always creates a new array,
  // masking the slice() mutation.
  var filtered = mutant.filterNodes(vm.nodes, 'all', '');
  filtered.push({ id: 'INJECTED', type: 'record', sourceRef: { id: 'fake' } });
  if (vm.nodes.length !== originalLen) throw new Error('injection affected original array — mutable return');
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}