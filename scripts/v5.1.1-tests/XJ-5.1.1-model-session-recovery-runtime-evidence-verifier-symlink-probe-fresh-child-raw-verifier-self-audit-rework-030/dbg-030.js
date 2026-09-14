'use strict';
const cp = require('child_process'); const path = require('path'); const fs = require('fs');
const ROOT = 'D:/xinjing-electron';
const CHILD = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-fresh-child-raw-verifier-self-audit-rework-030/case-child-030.js');
for (const [mid, st] of [['A1-delete-stdout','baseline'], ['A1-delete-stdout','mutated'], ['A1-delete-stdout','restore'], ['A2-tamper-sha','baseline']]) {
  const r = cp.spawnSync(process.execPath, [CHILD, mid, st], { cwd: ROOT, encoding: 'utf8' });
  console.log(mid + '.' + st, 'exit=' + r.status, 'stderr=' + JSON.stringify((r.stderr||'').slice(0,100)));
}