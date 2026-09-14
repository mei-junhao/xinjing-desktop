'use strict';
var m=require('D:\\xinjing-electron\\tests\\v4.3.0-disposable\\opensquilla-source-graph-goal-loop\\.mutants\\mutant-M06.js'); var ref=m.create({clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'orig',anchorText:'a'}); var v=m.verify(ref,{clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'CHANGED',anchorText:'OTHER'}); if(v.verified){console.error('CONTRACT_FAIL: changed should not be verified');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);