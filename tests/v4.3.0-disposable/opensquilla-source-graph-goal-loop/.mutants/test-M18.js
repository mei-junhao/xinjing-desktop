'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M18.js'); var a=m.createAdapter(); var q=a.quarantineSourceRef({id:'sr',clientId:'c',sessionId:'s'},'test'); if(q.verified){console.error('CONTRACT_FAIL: quarantine must not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);