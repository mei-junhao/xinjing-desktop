'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M09.js'); var ref=m.create({clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'orig'},sourceText:'orig',anchorText:'a'}); var v=m.verify(ref,{clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'WRONG'},sourceText:'orig',anchorText:'a'}); if(v.status!=='ambiguous'){console.error('CONTRACT_FAIL: locator mismatch should be ambiguous');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);