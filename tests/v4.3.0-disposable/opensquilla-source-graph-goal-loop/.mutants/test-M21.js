'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M21.js'); var F=require('${path.join(__dirname,'fixtures.js').replace(/\/g,'\\')}'); var vm=m.createViewModel(F); var ai=vm.edges.filter(function(e){return e.isAi||e.previewOnly;}); ai.forEach(function(e){if(e.isConfirmed){console.error('CONTRACT_FAIL: AI edge must not be confirmed');process.exit(1);}});
console.log('CONTRACT_PASS');
process.exit(0);