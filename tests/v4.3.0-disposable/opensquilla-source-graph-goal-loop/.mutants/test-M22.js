'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M22.js'); var r=m.validateViewModel({nodes:[{id:'x',type:'WRONG',sourceRef:{}}],edges:[]}); if(r.ok){console.error('CONTRACT_FAIL: invalid VM should not pass validation');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);