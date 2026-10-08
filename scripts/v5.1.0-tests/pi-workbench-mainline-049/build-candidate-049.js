'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const sourceManifest = path.join(ROOT, 'qa/package-candidates/5.1.0/pi-workbench-046/candidate-manifest-046.json');
const candidateRoot = path.join(ROOT, 'qa/package-candidates/5.1.0/pi-workbench-049');
const manifestPath = path.join(candidateRoot, 'candidate-manifest-049.json');
const filesPath = path.join(candidateRoot, 'candidate-files-049.txt');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const source = JSON.parse(fs.readFileSync(sourceManifest, 'utf8'));
const files = source.files.map((entry) => {
  const rel = entry.path.replace(/\\/g, '/');
  const src = path.join(ROOT, rel);
  const dst = path.join(candidateRoot, rel);
  if (!fs.existsSync(src)) throw new Error('source missing: ' + rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const bytes = fs.readFileSync(dst);
  return {
    path: rel,
    bytes: bytes.length,
    sha256: sha(bytes),
    source_task: entry.source_task,
    rebound_from: 'pi-workbench-046',
    source_scope: rel === 'app/css/workbench.css' ? 'current-shared-tree-preserved-055-tail' : 'current-shared-tree-byte-match-046'
  };
});
const manifest = {
  candidate_id: 'pi-workbench-049',
  created_at: new Date().toISOString(),
  predecessor_candidate: 'pi-workbench-046',
  rebound_reason: '048 accepted; rebind to current shared-tree bytes without overwriting unrelated drift',
  flags: { release_ready: false, publish_authorized: false, released: false, status: 'created-local' },
  files
};
fs.mkdirSync(candidateRoot, { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.writeFileSync(filesPath, files.map((x) => `${x.path}\t${x.bytes}\t${x.sha256}\t${x.source_scope}`).join('\n') + '\n', 'utf8');
const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
const h = crypto.createHash('sha256');
for (const f of sorted) { h.update(f.path); h.update(String(f.bytes)); h.update(f.sha256); }
const aggregate = h.digest('hex').toUpperCase();
const snapshot = {};
for (const name of ['candidate-files-049.txt', 'candidate-manifest-049.json']) {
  const b = fs.readFileSync(path.join(candidateRoot, name));
  snapshot[name] = { sha256: sha(b), bytes: b.length };
}
fs.writeFileSync(path.join(candidateRoot, 'candidate-aggregate-049.json'), JSON.stringify({ candidate_id: 'pi-workbench-049', aggregate_sha256: aggregate, files: files.length, snapshot }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ candidateRoot, files: files.length, aggregate, manifestSha256: sha(fs.readFileSync(manifestPath)), snapshot }, null, 2));
