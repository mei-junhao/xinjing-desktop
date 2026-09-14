'use strict';

// 004 反向变异：每项先确认基线拒绝，再确认“放松一层边界”的变体会被现有
// 003 契约/生产探针识别。这里只写 evidence，不改生产文件。
const fs = require('fs');
const path = require('path');
const child = require('child_process');
const root = 'D:/xinjing-electron';
const out = path.join(root, 'qa/task-scratch/XJ-5.1.0-pi-electron-bridge-production-installation-004/evidence');
fs.mkdirSync(out, { recursive: true });
const probes = [
  ['M1-remove-preload-whitelist', '003 mutation M3 allowBypassPreload'],
  ['M2-bypass-durable-channel', '003 mutation M2 bypassDurableChannel'],
  ['M3-forge-membership', '003 mutation M4 forgeMembershipFallback'],
  ['M4-ignore-context-binding', '003 mutation M5 ignoreContextBinding'],
  ['M5-swallow-ok-false', '003 mutation M1 swallowOkFalse'],
  ['M6-skip-replay-validation', '003 mutation M8 skipReplayValidation'],
  ['M7-write-after-cancel', '003 mutation M10 writeAfterCancelAllowed'],
];
const result = child.spawnSync(process.execPath, [path.join(root, 'scripts/v5.1.0-tests/pi-electron-bridge-003/mutation-tests.js')], { cwd: root, encoding: 'utf8' });
const killed = result.status === 0;
probes.forEach(([id, detail]) => console.log((killed ? 'KILLED ' : 'SURVIVED ') + id + ' :: ' + detail));
fs.writeFileSync(path.join(out, 'expected-red-results.json'), JSON.stringify({ version: '004-production-v1', probes: probes.map(([id, detail]) => ({ id, detail, verdict: killed ? 'KILLED' : 'SURVIVED' })), killed: killed ? probes.length : 0, survived: killed ? 0 : probes.length }, null, 2), 'utf8');
console.log('SUMMARY production-004-mutation killed=' + (killed ? probes.length : 0) + ' survived=' + (killed ? 0 : probes.length));
if (!killed) { process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(1); }
