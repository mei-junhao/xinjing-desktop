'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const protectedPath = path.join(root, 'docs/agent-coordination/v5.0.0/contracts/v5.0-commercial-domain-state-machine-current-protected-files-manifest.json');
const artifactPath = path.join(__dirname, 'artifact-hashes-current.json');
const reportPath = path.join(root, 'docs/agent-coordination/v5.0.0/cli-coordination/runs/XJ-5.0.0-codex-commercial-state-machine-artifact-refreeze-53/DELIVERY_REPORT.md');
const reportTail = 'DELIVERY_REPORT: D:\\xinjing-electron\\docs\\agent-coordination\\v5.0.0\\cli-coordination\\runs\\XJ-5.0.0-codex-commercial-state-machine-artifact-refreeze-53\\DELIVERY_REPORT.md';

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

assert.strictEqual(fs.existsSync(protectedPath), true, 'current protected manifest missing');
assert.strictEqual(fs.existsSync(artifactPath), true, 'current artifact manifest missing');
const protectedManifest = JSON.parse(fs.readFileSync(protectedPath, 'utf8'));
const artifactManifest = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
assert.strictEqual(protectedManifest.task_id, 'XJ-5.0.0-codex-commercial-state-machine-artifact-refreeze-53');
assert.strictEqual(artifactManifest.task_id, protectedManifest.task_id);
const protectedCount = verifyEntries(protectedManifest.protected_files, 'protected');
const artifactCount = verifyEntries(artifactManifest.artifacts, 'artifact');
assert.strictEqual(fs.existsSync(reportPath), true, 'current delivery report missing');
const lines = fs.readFileSync(reportPath, 'utf8').trimEnd().split(/\r?\n/);
assert.strictEqual(lines[lines.length - 1], reportTail, 'current delivery report final line mismatch');

process.stdout.write(`COMMERCIAL_STATE_MACHINE_CURRENT_ARTIFACTS: PASS (${protectedCount} protected, ${artifactCount} artifacts, report tail)\n`);
