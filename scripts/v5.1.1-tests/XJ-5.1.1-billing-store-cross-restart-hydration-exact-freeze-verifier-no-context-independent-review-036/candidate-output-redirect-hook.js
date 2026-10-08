'use strict';

// candidate-output-redirect-hook.js (035 preload)
// Loaded into the ORIGINAL 033 freeze-verifier child via NODE_OPTIONS=--require.
// It redirects ONLY writes whose logical target is under
//   033 SCRATCH_ROOT/candidate/<run-033> (env XJ035_CANDIDATE_PREFIX)
// into the 035 isolation root (env XJ035_ISOLATION_ROOT).
// ANY other write attempt fails closed (throw) so no 033/production byte is ever touched.

const fs = require('fs');
const path = require('path');

const PREFIX = process.env.XJ035_CANDIDATE_PREFIX ? path.resolve(process.env.XJ035_CANDIDATE_PREFIX) : '';
const ISOLATION = process.env.XJ035_ISOLATION_ROOT ? path.resolve(process.env.XJ035_ISOLATION_ROOT) : '';
if (!PREFIX || !ISOLATION) {
  throw new Error('candidate-output-redirect-hook requires XJ035_CANDIDATE_PREFIX and XJ035_ISOLATION_ROOT');
}
if (!ISOLATION.toLowerCase().startsWith(path.resolve(process.env.XJ035_SCRATCH_ROOT || '').toLowerCase())) {
  throw new Error('candidate-output-redirect-hook isolation root must live under the 035 scratch root');
}

function normalize(target) {
  return path.resolve(String(target));
}
function mapped(target) {
  const abs = normalize(target);
  const prefix = normalize(PREFIX);
  const rel = path.relative(prefix, abs);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null;
  return path.join(ISOLATION, rel);
}
function exists(target) {
  try { return fs.statSync(target).isDirectory() || fs.statSync(target).isFile(); } catch (error) { return false; }
}

const originalMkdirSync = fs.mkdirSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalAppendFileSync = fs.appendFileSync.bind(fs);

fs.mkdirSync = function guardedMkdirSync(target, options) {
  const dest = mapped(target);
  if (dest) return originalMkdirSync(dest, options || { recursive: true });
  if (exists(target)) return undefined;
  throw new Error('XJ035-FAIL-CLOSED mkdir outside candidate isolation root: ' + target);
};
fs.writeFileSync = function guardedWriteFileSync(target, data, options) {
  const dest = mapped(target);
  if (dest) return originalWriteFileSync(dest, data, options);
  throw new Error('XJ035-FAIL-CLOSED writeFileSync outside candidate isolation root: ' + target);
};
fs.appendFileSync = function guardedAppendFileSync(target, data, options) {
  const dest = mapped(target);
  if (dest) return originalWriteFileSync(dest, data, Object.assign({}, options || {}, { flag: 'a' }));
  throw new Error('XJ035-FAIL-CLOSED appendFileSync outside candidate isolation root: ' + target);
};
