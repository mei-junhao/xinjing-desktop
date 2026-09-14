'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M23.js'); var F=require('${path.join(__dirname,'fixtures.js').replace(/\/g,'\\')}'); var orig=F.nodes.length; var f=m.filterNodes(F.nodes,{type:'quote'}); f.push({id:'inj'}); if(F.nodes.length!==orig){console.error('CONTRACT_FAIL: filter must not mutate input');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);