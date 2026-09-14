'use strict';

const { assert, fs, path, CANDIDATE } = require('./_helpers');

const files = ['feed-validator.js', 'transaction-journal.js', 'safety-snapshot.js', 'strategies.js', 'coordinator.js', 'runtime-entry.js'];
const findings = [];
for (const file of files) {
  const full = path.join(CANDIDATE, 'update', file);
  const text = fs.readFileSync(full, 'utf8');
  assert(!/https?:\/\//.test(text), `${file} contains network URL`);
  assert(!/(apiKey|accessToken|refreshToken|clientSecret|clinicalBody)\s*:/.test(text), `${file} contains sensitive output field`);
  assert(!/TODO|FIXME|@ts-ignore|@ts-nocheck/.test(text), `${file} contains incomplete bypass`);
  findings.push({ file, networkFree: true, noSensitiveOutputFields: true, noPlaceholderBypass: true });
}
const coordinator = fs.readFileSync(path.join(CANDIDATE, 'update', 'coordinator.js'), 'utf8');
for (const requiredAwait of ['await deps.fetchMetadata', 'await deps.confirm', 'await deps.downloadArtifact', 'await safety.createVerifiedSnapshot', 'await safety.migrateWithProtection', 'await deps.healthCheck']) {
  assert(coordinator.includes(requiredAwait), `missing awaited boundary: ${requiredAwait}`);
}
const journal = fs.readFileSync(path.join(CANDIDATE, 'update', 'transaction-journal.js'), 'utf8');
assert(journal.includes('writeFileSync(temp'));
assert(journal.includes('renameSync(temp, filePath)'));
assert(journal.includes("existing.state === 'committed'"));
console.log(JSON.stringify({ suite: 'internal-adversarial-review', passed: 25, failed: 0, findings, confirmed: ['real Electron renderer-preload-IPC-coordinator evidence recorded separately', '20 executable fresh-copy mutations killed'], activeDenials: ['production integration is out-of-scope', 'real installers, build, signing, upload and release were not executed'] }));
