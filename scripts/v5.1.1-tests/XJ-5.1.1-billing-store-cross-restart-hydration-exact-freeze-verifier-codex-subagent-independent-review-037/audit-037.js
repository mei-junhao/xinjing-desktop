'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const c = require('./common-037');

function arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; }
const clone = path.resolve(arg('--clone'));
const red = path.resolve(arg('--expected-red'));
const out = path.resolve(arg('--out'));
const expectedIds = new Set(['01-delete-stage-raw', '02-tamper-033-raw', '03-replace-harness', '04-delete-freeze-stdout', '05-tamper-freeze-stderr', '06-remove-source-binding', '07-replica-argv', '08-forge-source-digest', '09-redirect-old-root', '10-tamper-store', '11-tamper-card', '12-forge-flags', '13-relative-cwd-path-escape', '14-summary-only', '15-old-cross-case-raw', '16-exitcode-only', '17-reparse-escape']);
function audit() {
  const clean = c.verifyClone(clone, { checkSources: true });
  const casesRoot = path.join(red, 'cases'); if (!fs.existsSync(casesRoot)) throw new Error('expected-red case root missing');
  const names = fs.readdirSync(casesRoot).sort(); if (names.length !== expectedIds.size) throw new Error('expected-red case count mismatch: ' + names.length);
  const invocationIds = new Set();
  for (const name of names) {
    if (!expectedIds.has(name)) throw new Error('unexpected expected-red case: ' + name);
    const root = path.join(casesRoot, name); const meta = c.json(path.join(root, 'case-meta.json'));
    if (meta.overall !== 'KILLED' || meta.baselineExit !== 0 || meta.mutatedExit === 0 || meta.restoreExit !== 0 || meta.mutationNonzero !== true || meta.freshRaw !== true) throw new Error('expected-red outcome invalid: ' + name);
    for (const phase of ['baseline', 'mutated', 'restore']) {
      const phaseRoot = path.join(root, phase); const expectedExit = phase === 'mutated' ? meta.mutatedExit : 0; const raw = c.checkCaptured(phaseRoot, expectedExit);
      if (invocationIds.has(raw.invocationId)) throw new Error('old/cross-case raw reuse: ' + name + '/' + phase); invocationIds.add(raw.invocationId);
      c.contained(root, raw.stdoutPath); c.contained(root, raw.stderrPath); c.contained(root, raw.metaPath);
    }
  }
  const redMeta = c.checkCaptured(red, 0); if (redMeta.tool !== 'expected-red-037') throw new Error('expected-red self raw identity invalid');
  const diff = spawnSync('git', ['-C', c.PROJECT, 'diff', '--check', '--', c.S37, c.Q37], { cwd: c.PROJECT, encoding: 'utf8', shell: false, windowsHide: true });
  if (diff.status !== 0 || String(diff.stdout || '') || String(diff.stderr || '')) throw new Error('git diff --check failed for 037 allowlist');
  const finalStatus = spawnSync('git', ['-C', c.PROJECT, 'status', '--short'], { cwd: c.PROJECT, encoding: 'utf8', shell: false, windowsHide: true }).stdout;
  fs.writeFileSync(path.join(clone, 'state', 'git-status-end.txt'), finalStatus, 'utf8');
  return { type: 'audit-037-summary', taskId: c.TASK, clean, expectedRed: { total: names.length, killed: names.length, restoresPass: names.length }, protectedInputs: '033/035/036/Store zero-drift confirmed by source rehash plus metadata trees', verdict: 'PASS' };
}
const result = c.capture(out, 'audit-037', audit);
if (result.exitCode === 0) c.lifecycle('delivered', { checkpoint: 'D', clone, expectedRed: 17 });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;
