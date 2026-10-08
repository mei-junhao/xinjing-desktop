'use strict';
const path = require('path');
const c = require('./common-037');
function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; }
const clone = path.resolve(arg('--clone')); const out = path.resolve(arg('--out'));
const result = c.capture(out, 'verifier-037', () => c.verifyClone(clone, { checkSources: true }));
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
