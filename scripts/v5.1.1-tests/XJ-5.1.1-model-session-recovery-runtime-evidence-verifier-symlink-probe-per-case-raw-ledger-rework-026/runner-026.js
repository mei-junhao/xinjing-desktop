'use strict';
const cp = require('child_process'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const OUT = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026');
const CHILD = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026/case-child-026.js');
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
const STAGES = ['baseline','mutated','restore'];
const entries = [];
for (const mid of MUT) {
  for (const st of STAGES) {
    const r = cp.spawnSync(process.execPath, [CHILD, mid, st], { cwd: ROOT, encoding: 'utf8' });
    const dir = path.join(OUT, 'runs', mid + '.' + st);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    entries.push({ mutationId: mid, stage: st, runDir: path.relative(OUT, dir), metaPath: path.relative(OUT, path.join(dir, 'meta.json')), stdoutPath: path.relative(OUT, path.join(dir, 'stdout.txt')), stderrPath: path.relative(OUT, path.join(dir, 'stderr.txt')), exitCode: r.status, verdict: meta.verdict });
  }
}
const ledger = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-per-case-raw-ledger-rework-026', card_sha256: '10CC2F7D8FB1ACDDF254E7492ACFBBC130E5E3F4C40E9E466B3202BEC0372FBC', candidate_source_sha256: sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8')), runCount: entries.length, entries: entries };
fs.writeFileSync(path.join(OUT, 'ledger-026.json'), JSON.stringify(ledger, null, 2) + '\n');
const bas = entries.filter(e => e.stage === 'baseline' && e.verdict === 'PASS').length;
const mut = entries.filter(e => e.stage === 'mutated' && e.verdict === 'FAIL').length;
const res = entries.filter(e => e.stage === 'restore' && e.verdict === 'PASS').length;
console.log('LEDGER_026: baseline=' + bas + '/8 mutated-KILLED=' + mut + '/8 restore=' + res + '/8');
process.exit(bas === 8 && mut === 8 && res === 8 ? 0 : 2);