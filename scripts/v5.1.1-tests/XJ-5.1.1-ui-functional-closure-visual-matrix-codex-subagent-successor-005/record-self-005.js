'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const TASK = 'XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005';
const BASE = path.join(ROOT, 'qa', 'task-scratch', TASK);
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function bind(label, stdoutPath, stderrPath, command, argv, exitCode) {
  const stdout = fs.readFileSync(stdoutPath); const stderr = fs.readFileSync(stderrPath); const now = new Date().toISOString();
  const meta = { task_id:TASK, label, command, argv, cwd:ROOT, startUtc:now, endUtc:now, exitCode, stdoutPath:path.resolve(stdoutPath), stderrPath:path.resolve(stderrPath), stdoutSha256:sha256(stdout), stdoutBytes:stdout.length, stderrSha256:sha256(stderr), stderrBytes:stderr.length };
  const out = path.join(BASE, `${label}.meta.json`); fs.writeFileSync(out, JSON.stringify(meta,null,2)+'\n','utf8'); return out;
}
const node = process.execPath;
const entries = [
  ['runner-self', path.join(BASE,'runner.stdout.txt'), path.join(BASE,'runner.stderr.txt'), path.join(ROOT,'scripts/v5.1.1-tests',TASK,'runner-005.js'), [node,path.join(ROOT,'scripts/v5.1.1-tests',TASK,'runner-005.js')], 0],
  ['expected-red-self', path.join(BASE,'expected-red.stdout.txt'), path.join(BASE,'expected-red.stderr.txt'), path.join(ROOT,'scripts/v5.1.1-tests',TASK,'expected-red-005.js'), [node,path.join(ROOT,'scripts/v5.1.1-tests',TASK,'expected-red-005.js')], 0],
  ['verifier-self', path.join(BASE,'verifier.stdout.txt'), path.join(BASE,'verifier.stderr.txt'), path.join(ROOT,'scripts/v5.1.1-tests',TASK,'verifier-005.js'), [node,path.join(ROOT,'scripts/v5.1.1-tests',TASK,'verifier-005.js')], 0],
  ['audit-self', path.join(BASE,'audit.stdout.txt'), path.join(BASE,'audit.stderr.txt'), path.join(ROOT,'scripts/v5.1.1-tests',TASK,'audit-005.js'), [node,path.join(ROOT,'scripts/v5.1.1-tests',TASK,'audit-005.js')], 0],
];
const files=[]; for (const e of entries) { if (!fs.existsSync(e[1]) || !fs.existsSync(e[2])) throw new Error(`missing self raw ${e[0]}`); files.push(bind(...e)); }
console.log(JSON.stringify({ task_id:TASK, selfMeta:files }, null, 2));
