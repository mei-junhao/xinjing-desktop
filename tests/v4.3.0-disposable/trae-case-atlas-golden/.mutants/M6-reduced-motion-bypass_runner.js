'use strict';
var fs = require('fs');
var html = fs.readFileSync(process.argv[2], 'utf8');
try {
if (html.indexOf('prefers-reduced-motion') < 0) throw new Error('reduced motion query was removed');
if (html.indexOf('0.01ms') < 0) throw new Error('zero duration override was removed');
  console.log('PROBE_PASS'); process.exit(0);
} catch (e) {
  console.log('PROBE_FAIL: ' + e.message); process.exit(1);
}