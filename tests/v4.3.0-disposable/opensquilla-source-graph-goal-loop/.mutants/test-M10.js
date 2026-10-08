'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M10.js'); var v=m.verify({schemaVersion:'',sourceContentHash:''}, {clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'x',anchorText:'a'}); if(v.verified){console.error('CONTRACT_FAIL: legacy should not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);