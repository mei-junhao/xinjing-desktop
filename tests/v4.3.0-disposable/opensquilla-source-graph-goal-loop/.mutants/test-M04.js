'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M04.js'); var r=m.normalizeAnchor({kind:'t',locator:'../../../etc'}); if(r!==null){console.error('CONTRACT_FAIL: path traversal should be rejected');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);