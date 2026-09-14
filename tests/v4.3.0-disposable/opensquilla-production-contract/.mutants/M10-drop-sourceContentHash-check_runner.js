'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var original = require("D:\\xinjing-electron\\design-previews\\4.3.0-opensquilla-case-atlas\\case-atlas-view-model.js");
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\M10-drop-sourceContentHash-check_mutant.js");

// STEP 1: Baseline — assertion against ORIGINAL module must PASS
(function() {
  var mutant = original; // shadow: assertion code uses `mutant` variable
  try {
  var input = fixtures.toPrototypeInput();
  var vm = mutant.createViewModel(input);
  vm.nodes.push({ id: 'bad_001', type: 'quote', sourceRef: { id: 'sr:bad', anchorContentHash: 'sha256:x' }, label: 'bad', summary: '', truncated: false, isAiDraft: false, isConfirmed: true });
  var val = mutant.validateViewModel(vm);
  if (val.ok) throw new Error('hashless node accepted — sourceContentHash check removed');
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
  vm.nodes.push({ id: 'bad_001', type: 'quote', sourceRef: { id: 'sr:bad', anchorContentHash: 'sha256:x' }, label: 'bad', summary: '', truncated: false, isAiDraft: false, isConfirmed: true });
  var val = mutant.validateViewModel(vm);
  if (val.ok) throw new Error('hashless node accepted — sourceContentHash check removed');
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}