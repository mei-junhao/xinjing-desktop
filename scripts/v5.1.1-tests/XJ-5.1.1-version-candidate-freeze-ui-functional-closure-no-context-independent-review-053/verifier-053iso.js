'use strict';
// 053 isolated verifier entry: binds freeze-052 verifier to an ISOLATED candidate copy via NODE_PATH shadowing.
// Creates a temp shadow module dir with freeze-052.js whose CANDIDATE points at the copy, then runs the real verifier logic against it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TARGET = process.argv[2];
if (!TARGET || !fs.existsSync(path.join(TARGET, 'manifest.json'))) {
  console.error(JSON.stringify({ verdict: 'FAIL', error: 'usage: node verifier-053iso.js <isolated-candidate-dir>' }));
  process.exit(1);
}
const S52 = path.resolve(process.argv[3] || 'qa/task-scratch/XJ-5.1.1-version-candidate-freeze-ui-functional-closure-052');
const REPO = path.resolve('.');

// read original freeze-052.js and rebind ROOT so CANDIDATE resolves inside TARGET's repo-relative position
// CANDIDATE = path.join(ROOT, 'docs/agent-coordination/v5.1.1/candidate-freeze/<name>')
// => set ROOT to a temp dir that contains the same relative path as a junction/copy? Simpler: rebind the constant directly.
let src = fs.readFileSync(path.join(S52, 'freeze-052.js'), 'utf8');
const marker = "candidate-freeze";
const idx = src.indexOf(marker);
// replace the CANDIDATE assignment line with a literal pointing at TARGET
src = src.replace(/const CANDIDATE = [^;]+;/, "const CANDIDATE = " + JSON.stringify(path.resolve(TARGET)) + ";");
if (!src.includes(JSON.stringify(path.resolve(TARGET)))) {
  console.error(JSON.stringify({ verdict: 'FAIL', error: 'CANDIDATE rebind failed' }));
  process.exit(1);
}
// write shadow module next to verifier so its require('./freeze-052.js') resolves to the rebound copy
const shadowDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj053-'));
fs.writeFileSync(path.join(shadowDir, 'freeze-052.js'), src);
// copy verifier-052.js into shadow dir (it requires './freeze-052.js')
fs.writeFileSync(path.join(shadowDir, 'verifier-052.js'), fs.readFileSync(path.join(S52, 'verifier-052.js')));

// run it
const { spawnSync } = require('child_process');
const r = spawnSync(process.execPath, [path.join(shadowDir, 'verifier-052.js')], { cwd: REPO, encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exitCode = r.status || 0;
try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch (e) {}