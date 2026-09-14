'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = 'D:/xinjing-electron';
const OUTPUT = path.join(
  ROOT,
  'docs/agent-coordination/v5.0.0/cli-coordination/runs',
  'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-282',
  'workspace/evidence/source-manifest.json'
);

function sha256(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function filesIn(relativeDir, suffix) {
  const dir = path.join(ROOT, relativeDir);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(dir, entry.name));
}

const paths = [
  ...filesIn('app/css', '.css'),
  ...filesIn('app/js', '.js'),
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'package-lock.json')
].sort((left, right) => left.localeCompare(right, 'en'));

const manifest = {
  task_id: 'XJ-5.0.0-sol-v5-full-ui-ux-system-review-prototype-282',
  kind: 'candidate-local-readonly-source-manifest',
  generated_at: new Date().toISOString(),
  source_state: 'dirty-worktree; unknown changes are protected',
  files: paths.map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      path: filePath.replace(/\\/g, '/'),
      bytes: stat.size,
      sha256: sha256(filePath)
    };
  })
};

fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output: OUTPUT, files: manifest.files.length }));
