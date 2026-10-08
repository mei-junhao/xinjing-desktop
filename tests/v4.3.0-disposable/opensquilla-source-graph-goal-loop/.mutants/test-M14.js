'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M14.js'); var F=require('${path.join(__dirname,'fixtures.js').replace(/\/g,'\\')}'); var a=m.createAdapter(); var p=a.projectSync('synth-gc-alpha',F); p.aiPreviewEdges.forEach(function(e){if(e.isConfirmed){console.error('CONTRACT_FAIL: AI edge must not be confirmed');process.exit(1);}});
console.log('CONTRACT_PASS');
process.exit(0);