'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M17.js'); var F=require('${path.join(__dirname,'fixtures.js').replace(/\/g,'\\')}'); var a=m.createAdapter(); var p=a.projectSync('synth-gc-alpha',F); var leak=p.nodes.filter(function(n){return n.clientId!=='synth-gc-alpha';}); if(leak.length>0){console.error('CONTRACT_FAIL: cross-client leak: '+leak.length);process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);