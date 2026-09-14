'use strict';
// SHA/闸门复核（本任务临时文件，交付前删除）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..', '..');
const files = [
  'tests/v4.3.0-disposable/codebuddy/fixtures.js',
  'tests/v4.3.0-disposable/codebuddy/run-contract.js',
  'tests/v4.3.0-disposable/codebuddy/mutation-probes.js',
  'design-previews/4.3.0-opensquilla-case-atlas/case-atlas-view-model.js',
  'design-previews/4.3.0-opensquilla-case-atlas/source-ref-adapter.js',
  'docs/agent-coordination/v4.2.2/protected-files.json',
];
for (const f of files) {
  const p = path.join(ROOT, f);
  const buf = fs.readFileSync(p);
  console.log(f + ' | bytes=' + buf.length + ' | sha256=' + crypto.createHash('sha256').update(buf).digest('hex'));
}
console.log('HEAD=' + execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim());
console.log('BRANCH=' + execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT }).toString().trim());
