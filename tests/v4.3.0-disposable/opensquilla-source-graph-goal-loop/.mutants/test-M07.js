'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M07.js'); var ref=m.create({clientId:'c1',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'orig',anchorText:'a'}); var v=m.verify(ref,{clientId:'c2',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'orig',anchorText:'a'}); if(v.verified){console.error('CONTRACT_FAIL: ambiguous should not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);