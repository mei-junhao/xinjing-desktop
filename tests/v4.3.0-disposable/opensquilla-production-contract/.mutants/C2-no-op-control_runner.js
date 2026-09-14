'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\C2-no-op-control_mutant.js");
try {
  var vm = mutant.createViewModel(fixtures);
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}