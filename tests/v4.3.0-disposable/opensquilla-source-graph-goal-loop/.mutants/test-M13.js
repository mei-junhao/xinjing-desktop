'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M13.js'); var a=m.createAdapter(); var r=a.persistEdge({id:'e'}); if(r.rejected){/*good*/}else{console.error('CONTRACT_FAIL: persist should be rejected');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);