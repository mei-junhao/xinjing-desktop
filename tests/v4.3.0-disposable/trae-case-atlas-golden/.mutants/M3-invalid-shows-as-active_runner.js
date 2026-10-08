'use strict';
var fs = require('fs');
var html = fs.readFileSync(process.argv[2], 'utf8');
try {
if (html.indexOf("status: 'invalid'") < 0) throw new Error('invalid status removed or changed');
  console.log('PROBE_PASS'); process.exit(0);
} catch (e) {
  console.log('PROBE_FAIL: ' + e.message); process.exit(1);
}