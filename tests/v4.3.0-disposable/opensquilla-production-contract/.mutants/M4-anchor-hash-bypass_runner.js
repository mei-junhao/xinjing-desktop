'use strict';
var path = require('path');
var ROOT = "D:\\xinjing-electron";
var SUITE_DIR = "D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract";
var fixtures = require(path.join(SUITE_DIR, 'fixtures.js'));
var SourceRef = require(path.join(ROOT, 'app', 'js', 'source-ref.js'));
var original = require("D:\\xinjing-electron\\app\\js\\source-ref.js");
var mutant = require("D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-production-contract\\.mutants\\M4-anchor-hash-bypass_mutant.js");

// STEP 1: Baseline — assertion against ORIGINAL module must PASS
(function() {
  var mutant = original; // shadow: assertion code uses `mutant` variable
  try {
  var ref = mutant.create({
    clientId: 'c1', sessionId: 's1',
    anchor: { kind: 'test', locator: 'doc/1' },
    sourceText: 'original content'
  });
  var v = mutant.verify(ref, {
    clientId: 'c1', sessionId: 's1',
    anchor: { kind: 'test', locator: 'doc/1' },
    sourceText: 'CHANGED CONTENT SHOULD NOT VERIFY'
  });
  if (v.verified === true) throw new Error('changed source accepted as verified — anchor-hash bypass');
    console.log('BASELINE_PASS');
  } catch (e) {
    console.log('BASELINE_FAIL: ' + e.message);
    process.exit(2);
  }
})();

// STEP 2: Assertion against MUTANT module — must FAIL
try {
  var ref = mutant.create({
    clientId: 'c1', sessionId: 's1',
    anchor: { kind: 'test', locator: 'doc/1' },
    sourceText: 'original content'
  });
  var v = mutant.verify(ref, {
    clientId: 'c1', sessionId: 's1',
    anchor: { kind: 'test', locator: 'doc/1' },
    sourceText: 'CHANGED CONTENT SHOULD NOT VERIFY'
  });
  if (v.verified === true) throw new Error('changed source accepted as verified — anchor-hash bypass');
  console.log('CONTRACT_PASS');
  process.exit(0);
} catch (e) {
  console.log('CONTRACT_FAIL: ' + e.message);
  process.exit(1);
}