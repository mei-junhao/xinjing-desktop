'use strict';
const path = require('path');
const c = require('./common-037');
function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; }
const clone = path.resolve(arg('--clone'));
const out = path.resolve(arg('--out'));
const result = c.capture(out, 'build-clone-037', () => c.buildClone(clone));
if (result.exitCode === 0) c.lifecycle('running', { checkpoint: 'A-B', clone });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
