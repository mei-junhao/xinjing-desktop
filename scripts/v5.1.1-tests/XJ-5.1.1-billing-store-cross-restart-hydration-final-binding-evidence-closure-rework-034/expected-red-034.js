'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, CONTRACT_ID, RUN33,
  PROJECT_ROOT, SCRATCH_ROOT,
  sha256Bytes, sha256File, bytesOf, nowUtc, randomNonce, ensureDir, writeJson, readJson,
  runChild, installSelfCapture, argValue, assertSafeLabel
} = require('./common-034');

const VERIFIER = path.join(__dirname, 'final-binding-verifier.js');

if (!argValue('--binding-dir', '')) {
  process.stderr.write(JSON.stringify({ type: 'expected-red-034-error', message: '--binding-dir is required' }) + String.fromCharCode(10));
  process.exitCode = 2;
} else {
  const bindingDir = path.resolve(argValue('--binding-dir', ''));
  const runId = argValue('--run-id', '') || readJson(path.join(bindingDir, 'final-binding-manifest-034.json')).runId;
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'expected-red-034' });
  const ER_ROOT = ensureDir(path.join(SCRATCH_ROOT, 'expected-red'));
  const nonce = randomNonce();

  function fail(message) { throw new Error(message); }

  async function runVerifier(binding, workRoot) {
    const argv = [VERIFIER, '--binding-dir', binding, '--run-id', runId];
    if (workRoot) argv.push('--inputs-root', workRoot);
    return runChild(process.execPath, argv, { cwd: PROJECT_ROOT });
  }

  function writeRun(outDir, name, result) {
    const stdoutPath = path.join(outDir, name + '.stdout.txt');
    const stderrPath = path.join(outDir, name + '.stderr.txt');
    fs.writeFileSync(stdoutPath, result.stdout);
    fs.writeFileSync(stderrPath, result.stderr);
    return { stdoutPath: path.resolve(stdoutPath), stderrPath: path.resolve(stderrPath), stdoutSha256: sha256File(stdoutPath), stderrSha256: sha256File(stderrPath), stdoutBytes: bytesOf(stdoutPath), stderrBytes: bytesOf(stderrPath) };
  }

  function copyBindingTo(attackId) {
    const dst = ensureDir(path.join(ER_ROOT, 'bindings', attackId));
    fs.copyFileSync(path.join(bindingDir, 'final-binding-files-034.json'), path.join(dst, 'final-binding-files-034.json'));
    fs.copyFileSync(path.join(bindingDir, 'final-binding-manifest-034.json'), path.join(dst, 'final-binding-manifest-034.json'));
    return dst;
  }

  function stageTemplate() {
    const filesDoc = readJson(path.join(bindingDir, 'final-binding-files-034.json'));
    const template = ensureDir(path.join(ER_ROOT, 'template', nonce));
    let copied = 0;
    for (const entry of filesDoc.entries) {
      if (entry.kind === 'protected-sha') continue;
      const target = path.join(template, entry.label);
      assertSafeLabel(entry.label);
      ensureDir(path.dirname(target));
      fs.copyFileSync(entry.sourcePath, target);
      copied++;
    }
    const work = ensureDir(path.join(ER_ROOT, 'work', nonce));
    copyDir(template, work);
    return { template: template, work: work, copied: copied };
  }

  function copyDir(src, dst) {
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      if (fs.statSync(s).isDirectory()) { ensureDir(d); copyDir(s, d); }
      else fs.copyFileSync(s, d);
    }
  }

  function restoreFromTemplate(template, labels) {
    for (const label of labels) {
      const src = path.join(template, label);
      const dst = path.join(work, label);
      ensureDir(path.dirname(dst));
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  }

  let work;
  let template;
  const attacks = [
    {
      id: '01-delete-033-stage', name: '删 033 stage (wrong-db-name/mutated/stdout.txt)',
      mutation: (w) => { fs.rmSync(path.join(w, 'evidence/cases/wrong-db-name/mutated/stdout.txt'), { force: true }); },
      restoreLabels: ['evidence/cases/wrong-db-name/mutated/stdout.txt'],
      binder: null, description: 'A staged 033 evidence file is deleted; verifier must fail-closed.'
    },
    {
      id: '02-tamper-033-raw', name: '篡改 033 raw (wrong-key/baseline/stdout.txt)',
      mutation: (w) => { fs.appendFileSync(path.join(w, 'evidence/cases/wrong-key/baseline/stdout.txt'), String.fromCharCode(10) + 'TAMPERED'); },
      restoreLabels: ['evidence/cases/wrong-key/baseline/stdout.txt'],
      binder: null, description: 'A staged 033 evidence raw byte is tampered; entry SHA must mismatch.'
    },
    {
      id: '03-replace-harness', name: '替换 1/10 harness (common.js)',
      mutation: (w) => { fs.writeFileSync(path.join(w, 'harness/common.js'), '// replaced by attacker' + String.fromCharCode(10)); },
      restoreLabels: ['harness/common.js'],
      binder: null, description: 'One of the 10 harness sources is replaced; bound SHA must mismatch.'
    },
    {
      id: '04-delete-freeze-stdout', name: '删 freeze stdout',
      mutation: (w) => { fs.rmSync(path.join(w, 'self/freeze-verifier/stdout.txt'), { force: true }); },
      restoreLabels: ['self/freeze-verifier/stdout.txt'],
      binder: null, description: 'Freeze self triplet stdout is deleted; triplet must be incomplete.'
    },
    {
      id: '05-tamper-freeze-stderr', name: '篡改 freeze stderr',
      mutation: (w) => { fs.appendFileSync(path.join(w, 'self/freeze-verifier/stderr.txt'), 'TAMPERED'); },
      restoreLabels: ['self/freeze-verifier/stderr.txt'],
      binder: null, description: 'Freeze self triplet stderr is tampered; entry SHA must mismatch.'
    },
    {
      id: '06-forge-freeze-meta', name: '伪造 freeze meta',
      mutation: (w) => {
        const forged = { taskId: 'XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033', runId: RUN33, tool: 'freeze-verifier', exitCode: 0, verdict: 'PASS', stdoutSha256: 'abababababababababababababababab', stderrSha256: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', stdoutBytes: 1, stderrBytes: 1 };
        fs.writeFileSync(path.join(w, 'self/freeze-verifier/meta.json'), JSON.stringify(forged, null, 2) + String.fromCharCode(10));
      },
      restoreLabels: ['self/freeze-verifier/meta.json'],
      binder: null, description: 'Freeze meta is replaced with a forged 033-identity PASS record; verifier must reject.'
    },
    {
      id: '07-remove-source-binding', name: '删 source-binding (harness/audit.js entry)',
      binder: () => {
        const b = copyBindingTo('07-remove-source-binding');
        const filesDoc = readJson(path.join(b, 'final-binding-files-034.json'));
        filesDoc.entries = filesDoc.entries.filter((e) => !(e.kind === 'harness-source' && e.label === 'harness/audit.js'));
        filesDoc.entryCount = filesDoc.entries.length;
        writeJson(path.join(b, 'final-binding-files-034.json'), filesDoc);
        return b;
      },
      restoreLabels: [],
      description: 'A harness source-binding entry is removed from a binding copy; counts and aggregate must fail.'
    },
    {
      id: '08-tamper-store', name: '改 Store SHA (store/store.js)',
      mutation: (w) => { fs.appendFileSync(path.join(w, 'store/store.js'), '// tampered'); },
      restoreLabels: ['store/store.js'],
      binder: null, description: 'The Store byte is tampered in staging; bound Store SHA and constant must fail.'
    },
    {
      id: '09-tamper-033-card', name: '改 033 卡 SHA (card/033)',
      mutation: (w) => { fs.appendFileSync(path.join(w, 'card/033'), '// tampered'); },
      restoreLabels: ['card/033'],
      binder: null, description: 'The 033 card byte is tampered; bound card SHA and constant must fail.'
    },
    {
      id: '10-forge-flags', name: '篡改 flags (releaseReady=true)',
      binder: () => {
        const b = copyBindingTo('10-forge-flags');
        const manifestDoc = readJson(path.join(b, 'final-binding-manifest-034.json'));
        manifestDoc.flags.releaseReady = true;
        writeJson(path.join(b, 'final-binding-manifest-034.json'), manifestDoc);
        return b;
      },
      restoreLabels: [],
      description: 'The manifest flags claim release readiness; verifier must reject the misclaim.'
    }
  ];

  async function main() {
    const baselineBindingDir = bindingDir;
    const baselineResult = await runVerifier(baselineBindingDir, null);
    const baselineDir = ensureDir(path.join(ER_ROOT, 'baseline'));
    const baselineRuns = writeRun(baselineDir, 'baseline', baselineResult);
    const baselineMeta = {
      taskId: TASK_ID, runId: runId, run: 'baseline', mode: 'authoritative',
      startUtc: nowUtc(), endUtc: nowUtc(), exitCode: baselineResult.exitCode,
      verdict: baselineResult.exitCode === 0 ? 'PASS' : 'FAIL',
      stdoutSha256: baselineRuns.stdoutSha256, stderrSha256: baselineRuns.stderrSha256
    };
    writeJson(path.join(baselineDir, 'meta.json'), baselineMeta);
    if (baselineResult.exitCode !== 0) fail('clean baseline verifier failed');

    const staged = stageTemplate();
    work = staged.work;
    template = staged.template;

    const results = [];
    for (const attack of attacks) {
      const outDir = ensureDir(path.join(ER_ROOT, 'attacks', attack.id));
      const startUtc = nowUtc();
      let usedBinding = bindingDir;
      if (attack.binder) usedBinding = attack.binder();
      else attack.mutation(work);
      const mutated = await runVerifier(usedBinding, work);
      const mutatedRuns = writeRun(outDir, 'mutated', mutated);
      let restored;
      if (attack.restoreLabels.length) {
        restoreFromTemplate(template, attack.restoreLabels);
      } else {
        usedBinding = bindingDir;
      }
      const restoreResult = await runVerifier(usedBinding, work);
      const restoreRuns = writeRun(outDir, 'restore', restored = restoreResult);
      const endUtc = nowUtc();
      const rejected = mutated.exitCode !== 0;
      const restoredOk = restoreResult.exitCode === 0;
      const meta = {
        taskId: TASK_ID,
        runId: runId,
        attackId: attack.id,
        name: attack.name,
        description: attack.description,
        bindingDir: usedBinding,
        inputsRoot: work,
        startUtc: startUtc,
        endUtc: endUtc,
        mutatedExit: mutated.exitCode,
        mutatedVerdict: rejected ? 'REJECTED' : 'FAIL',
        restoreExit: restoreResult.exitCode,
        restoreVerdict: restoredOk ? 'PASS' : 'FAIL',
        mutated: mutatedRuns,
        restore: restoreRuns,
        overall: rejected && restoredOk ? 'KILLED' : 'SURVIVED'
      };
      writeJson(path.join(outDir, 'meta.json'), meta);
      results.push(meta);
      if (!rejected) process.stderr.write(JSON.stringify({ type: 'attack-survived', attackId: attack.id }) + String.fromCharCode(10));
      if (!restoredOk) process.stderr.write(JSON.stringify({ type: 'restore-failed', attackId: attack.id }) + String.fromCharCode(10));
    }
    const killed = results.filter((r) => r.overall === 'KILLED').length;
    if (killed !== attacks.length) fail('not all attacks killed: ' + killed + '/' + attacks.length);
    process.stdout.write(JSON.stringify({
      type: 'expected-red-034-summary',
      taskId: TASK_ID,
      runId: runId,
      bindingDir: bindingDir,
      total: attacks.length,
      killed: killed,
      mutatedNonZero: results.filter((r) => r.mutatedExit !== 0).length,
      restoresPass: results.filter((r) => r.restoreExit === 0).length,
      verdict: 'PASS'
    }) + String.fromCharCode(10));
    return 0;
  }

  main().then((code) => {
    finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ type: 'expected-red-034-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
