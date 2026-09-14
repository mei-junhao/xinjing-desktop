'use strict';

const { assert, crypto, fs, path, RUN, CANDIDATE } = require('./_helpers');

const allowedRoots = [
  path.join(RUN, 'workspace', 'candidate'),
  path.join(RUN, 'workspace', 'tests'),
  path.join(RUN, 'workspace', 'evidence'),
  path.join(RUN, 'workspace', 'scratch'),
  path.join(RUN, 'workspace', 'delivery'),
];
const inputRoot = path.join(RUN, 'workspace', 'input');
const manifestPath = path.join(inputRoot, 'INPUT_MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const drift = [];
for (const item of manifest.files) {
  const full = path.join(inputRoot, ...item.path.split('/'));
  const bytes = fs.statSync(full).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').toUpperCase();
  if (bytes !== item.bytes || sha256 !== item.sha256) drift.push({ path: item.path, bytes, sha256 });
}
assert.deepStrictEqual(drift, []);
const required = ['feed-validator.js', 'transaction-journal.js', 'safety-snapshot.js', 'strategies.js', 'coordinator.js', 'runtime-entry.js'];
const hashes = [];
for (const name of required) {
  const full = path.join(CANDIDATE, 'update', name);
  assert(fs.existsSync(full));
  hashes.push({ path: full.replace(/\\/g, '/'), bytes: fs.statSync(full).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
}
const protectedCandidates = ['package.json', 'package-lock.json', 'version.generated.js'];
for (const name of protectedCandidates) assert(!fs.existsSync(path.join(CANDIDATE, name)), `protected candidate file unexpectedly present: ${name}`);
const output = { suite: 'verify-artifacts', passed: required.length + manifest.files.length + protectedCandidates.length, failed: 0, manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'), inputCount: manifest.files.length, candidateHashes: hashes, allowedRoots: allowedRoots.map((p) => p.replace(/\\/g, '/')) };
fs.mkdirSync(path.join(RUN, 'workspace', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(RUN, 'workspace', 'evidence', 'artifact-hashes.json'), JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(output));
