'use strict';
var fs = require('fs');
var html = fs.readFileSync(process.argv[2], 'utf8');
try {
if (html.indexOf('900px') < 0) throw new Error('900px breakpoint was removed');
  console.log('PROBE_PASS'); process.exit(0);
} catch (e) {
  console.log('PROBE_FAIL: ' + e.message); process.exit(1);
}