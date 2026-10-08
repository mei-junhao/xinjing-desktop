'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const hashesPath = path.join(__dirname, 'artifact-hashes.json');
const protectedPath = path.join(root, 'docs/agent-coordination/v5.0.0/contracts/v5.0-commercial-domain-state-machine-protected-files-manifest.json');
const reportPath = path.join(root, 'qa/agent-reviews/XJ-5.0.0-codex-commercial-domain-state-machine-06.md');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function verifyEntries(entries, label) {
  let count = 0;
  entries.forEach(function (entry) {
    const absolute = path.resolve(root, entry.path);
    assert.strictEqual(absolute.startsWith(root + path.sep), true, `${label} escapes project root: ${entry.path}`);
    assert.strictEqual(fs.existsSync(absolute), true, `${label} missing: ${entry.path}`);
    assert.strictEqual(sha256(absolute), String(entry.sha256).toUpperCase(), `${label} hash mismatch: ${entry.path}`);
    count += 1;
  });
  return count;
}

const protectedManifest = JSON.parse(fs.readFileSync(protectedPath, 'utf8'));
const artifactManifest = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
assert.strictEqual(protectedManifest.task_id, 'XJ-5.0.0-codex-commercial-domain-state-machine-06');
assert.strictEqual(artifactManifest.task_id, protectedManifest.task_id);
const protectedCount = verifyEntries(protectedManifest.protected_files, 'protected');
const artifactCount = verifyEntries(artifactManifest.artifacts, 'artifact');

assert.strictEqual(fs.existsSync(reportPath), true, 'delivery report missing');
const lines = fs.readFileSync(reportPath, 'utf8').trimEnd().split(/\r?\n/);
assert.strictEqual(
  lines[lines.length - 1],
  'DELIVERY_REPORT: D:\\xinjing-electron\\qa\\agent-reviews\\XJ-5.0.0-codex-commercial-domain-state-machine-06.md',
  'delivery report final line mismatch',
);

process.stdout.write(`COMMERCIAL_STATE_MACHINE_ARTIFACTS: PASS (${protectedCount} protected, ${artifactCount} artifacts, report tail)\n`);
