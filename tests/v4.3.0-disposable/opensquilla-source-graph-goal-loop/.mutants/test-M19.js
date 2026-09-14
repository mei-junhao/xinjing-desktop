'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M19.js'); var a=m.createAdapter(); var inv=a.createInvalidSourceRef({clientId:'',sessionId:''}); if(inv.verified){console.error('CONTRACT_FAIL: invalid must not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);