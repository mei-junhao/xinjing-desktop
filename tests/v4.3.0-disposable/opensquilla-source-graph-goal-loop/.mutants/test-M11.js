'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M11.js'); var ref=m.create({clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'x',anchorText:'a'}); var v=m.verify(ref,null); if(v.verified){console.error('CONTRACT_FAIL: missing should not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);