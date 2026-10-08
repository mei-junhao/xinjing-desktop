'use strict';
const cp = require('child_process'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-restore-audit-closure-rework-032';
const CHILD = 'D:/xinjing-electron/scripts/v5.1.1-tests/XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-restore-audit-closure-rework-032/case-child-032.js';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const MUT = ['A1-delete-stdout','A2-tamper-sha','A3-tamper-bytes','A4-delete-field','A5-unknown-field','A6-sibling-prefix','A7-real-junction','A8-swallow-junction'];
const STAGES = ['baseline','mutated','restore'];
fs.rmSync(path.join(OUT, 'runs'), { recursive: true, force: true });
const entries = [];
for (const mid of MUT) {
  for (const st of STAGES) {
    const r = cp.spawnSync(process.execPath, [CHILD, mid, st], { cwd: ROOT, encoding: 'utf8' });
    const dir = path.join(OUT, 'runs', mid + '.' + st);
    const mp = path.join(dir, 'meta.json');
    if (!fs.existsSync(mp)) { console.error('META_MISSING', mid, st, 'exit=' + r.status); process.exit(2); }
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    entries.push({ mutationId: mid, stage: st, runDir: dir, metaPath: mp, stdoutPath: path.join(dir, 'stdout.txt'), stderrPath: path.join(dir, 'stderr.txt'), exitCode: meta.exitCode, verdict: meta.verdict });
  }
}
const ledger = { task_id: 'XJ-5.1.1-model-session-recovery-runtime-evidence-verifier-symlink-probe-restore-audit-closure-rework-032', card_sha256: '200904DEE947504E41FE51BA41AD11D69BE01C5DEEE3193DD091B4185EA8AC04', candidate_source_sha256: sha(fs.readFileSync(path.join(ROOT, 'app/js/xinjing-chat.js'), 'utf8')), runCount: entries.length, entries: entries };
fs.writeFileSync(path.join(OUT, 'ledger-032.json'), JSON.stringify(ledger, null, 2) + '\n');
const bas = entries.filter(e => e.stage === 'baseline' && e.verdict === 'PASS' && e.exitCode === 0).length;
const mut = entries.filter(e => e.stage === 'mutated' && e.verdict === 'FAIL' && e.exitCode === 2).length;
const res = entries.filter(e => e.stage === 'restore' && e.verdict === 'PASS' && e.exitCode === 0).length;
console.log('LEDGER_032: baseline=' + bas + '/8 mutated=' + mut + '/8 restore=' + res + '/8');
process.exit(bas === 8 && mut === 8 && res === 8 ? 0 : 2);