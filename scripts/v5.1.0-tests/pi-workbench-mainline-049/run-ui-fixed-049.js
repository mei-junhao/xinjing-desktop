'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const evidence = path.join(ROOT, 'qa/task-scratch/XJ-5.1.0-pi-workbench-mainline-merge-and-candidate-rebind-049/evidence');
const script = path.join(evidence, 'ui-005-fixed-049.js');
const stdoutPath = path.join(evidence, 'ui-005-fixed-049.stdout.raw');
const stderrPath = path.join(evidence, 'ui-005-fixed-049.stderr.raw');
const run = spawnSync(process.execPath, [script, 'default'], { cwd: evidence, encoding: null, shell: false, windowsHide: true });
fs.writeFileSync(stdoutPath, Buffer.from(run.stdout || Buffer.alloc(0)));
fs.writeFileSync(stderrPath, Buffer.from(run.stderr || Buffer.alloc(0)));
process.stdout.write(JSON.stringify({
  command: [process.execPath, script, 'default'], cwd: evidence,
  exit: run.status, signal: run.signal || null,
  stdout: stdoutPath, stderr: stderrPath,
}, null, 2) + '\n');
process.exitCode = Number.isInteger(run.status) ? run.status : 1;
