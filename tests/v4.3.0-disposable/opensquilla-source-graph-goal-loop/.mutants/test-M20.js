'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M20.js'); var a=m.createAdapter(); var v=a.verifySourceRef({clientId:'c',sessionId:'s'}, {sourceText:'x'}); if(v.verified){console.error('CONTRACT_FAIL: missing fields should not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);