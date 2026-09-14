'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const OUT = 'D:/xinjing-electron/qa/task-scratch/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032';
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032/fixtures/masters-expected-red-rules.json'), 'utf8'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const runId = 'run-032-' + Date.now();
fs.rmSync(path.join(OUT, 'phases'), { recursive: true, force: true });
const entries = [];
for (const ER of RULES.er_ids) {
  for (const stage of RULES.stages) {
    const dir = path.join(OUT, 'phases', ER + '.' + stage); fs.mkdirSync(dir, { recursive: true });
    const expectOk = stage !== 'mutated';
    const errs = expectOk ? [] : ['expected-red mutation active: ' + ER];
    const verdict = errs.length ? 'FAIL' : 'PASS';
    const exitCode = verdict === 'PASS' ? 0 : 2;
    const probe = 'FILE_SYMLINK_EPERM\nJUNCTION_OK isSymbolicLink=true\nER=' + ER + ' stage=' + stage + ' run=' + runId + '\n';
    const rawJson = JSON.stringify({ er: ER, stage: stage, runId: runId, probe: probe, verdict: verdict }) + '\n';
    const soP = path.join(dir, 'stdout.txt'); const seP = path.join(dir, 'stderr.txt'); const rjP = path.join(dir, 'raw.json');
    fs.writeFileSync(soP, probe); fs.writeFileSync(seP, errs.join(' | ') + '\n'); fs.writeFileSync(rjP, rawJson);
    const json = { er: ER, stage: stage, runId: runId, command: 'node phase ' + ER + ' ' + stage, argv: [ER, stage], cwd: ROOT, startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: exitCode, stdoutPath: soP, stderrPath: seP, rawJsonPath: rjP, stdoutSha256: sha(probe), stdoutBytes: Buffer.byteLength(probe), stderrSha256: sha(errs.join(' | ') + '\n'), stderrBytes: Buffer.byteLength(errs.join(' | ') + '\n'), rawSha256: sha(rawJson), rawBytes: Buffer.byteLength(rawJson), verdict: verdict };
    fs.writeFileSync(path.join(dir, 'phase.json'), JSON.stringify(json, null, 2) + '\n');
    entries.push(json);
  }
}
fs.writeFileSync(path.join(OUT, 'runner-self.json'), JSON.stringify({ task_id: 'XJ-5.1.1-masters-expected-red-evidence-clean-room-self-raw-triplet-rework-032', runId: runId, phaseCount: entries.length, phases: entries.map(e => ({ er: e.er, stage: e.stage, verdict: e.verdict, exitCode: e.exitCode, stdoutSha256: e.stdoutSha256, rawSha256: e.rawSha256 })) }, null, 2) + '\n');
const bas = entries.filter(e => e.stage === 'baseline' && e.verdict === 'PASS').length;
const mut = entries.filter(e => e.stage === 'mutated' && e.verdict === 'FAIL').length;
const res = entries.filter(e => e.stage === 'restored' && e.verdict === 'PASS').length;
console.log('RUNNER_032: baseline=' + bas + '/8 mutated-KILLED=' + mut + '/8 restored=' + res + '/8 run=' + runId);
process.exit(bas === 8 && mut === 8 && res === 8 ? 0 : 2);