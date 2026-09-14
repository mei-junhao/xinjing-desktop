'use strict';
var fs = require('fs');
var html = fs.readFileSync(process.argv[2], 'utf8');
try {
if (html.indexOf('aiDraft: true') < 0) throw new Error('AI draft marker removed -- AI inference shown as formal conclusion');
  console.log('PROBE_PASS'); process.exit(0);
} catch (e) {
  console.log('PROBE_FAIL: ' + e.message); process.exit(1);
}