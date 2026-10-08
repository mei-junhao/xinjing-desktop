'use strict';
// Task 294: verify INPUT_MANIFEST.json hashes/bytes against workspace/input files.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'input', 'INPUT_MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let ok = true;
for (const f of manifest.files) {
  const abs = path.join(root, 'input', f.path);
  const buf = fs.readFileSync(abs);
  const sha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  const match = sha === f.sha256 && buf.length === f.bytes;
  if (!match) ok = false;
  console.log((match ? 'OK  ' : 'FAIL') + ' ' + f.path + ' sha256=' + sha + ' bytes=' + buf.length);
}
console.log(ok ? 'ALL_MATCH' : 'MISMATCH');
process.exit(ok ? 0 : 1);
