'use strict';
var fs = require('fs');
var src = fs.readFileSync(process.argv[2], 'utf8');
try {
if (src.indexOf('sourceContentHash') < 0) throw new Error('sourceContentHash removed');
if (src.indexOf("sourceContentHash: partial.sourceContentHash || shaLike('src:' + id)") < 0) throw new Error('sourceContentHash assignment mutated');
  console.log('PROBE_PASS'); process.exit(0);
} catch (e) {
  console.log('PROBE_FAIL: ' + e.message); process.exit(1);
}