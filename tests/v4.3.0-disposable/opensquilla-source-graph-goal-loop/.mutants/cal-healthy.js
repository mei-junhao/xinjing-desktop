'use strict';
var m=require('D:\\xinjing-electron\\app\\js\\source-ref.js');
var r=m.create({clientId:'c',sessionId:'s',anchor:{kind:'t',locator:'l'},sourceText:'x',anchorText:'a'});
if(!r.id||!r.sourceContentHash){console.error('CONTRACT_FAIL');process.exit(1);}
console.log('CONTRACT_PASS');
process.exit(0);