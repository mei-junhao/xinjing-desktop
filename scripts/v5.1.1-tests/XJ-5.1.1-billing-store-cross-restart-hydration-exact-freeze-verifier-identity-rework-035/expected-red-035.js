'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID, RUN33, PROJECT_ROOT, SCRATCH_ROOT,
  sha256Bytes, sha256File, bytesOf, nowUtc, randomNonce, ensureDir, writeJson, readJson,
  runChild, installSelfCapture, argValue, assertSafeLabel
} = require('./common-035');

const VERIFIER = path.join(__dirname, 'final-binding-verifier.js');

if (!argValue('--binding-dir', '')) {
  process.stderr.write(JSON.stringify({ type: 'expected-red-035-error', message: '--binding-dir is required' }) + String.fromCharCode(10));
  process.exitCode = 2;
} else {
  const bindingDir = path.resolve(argValue('--binding-dir', ''));
  const runId = argValue('--run-id', '') || readJson(path.join(bindingDir, 'final-binding-manifest-035.json')).runId;
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: SCRATCH_ROOT, runId: runId, toolName: 'expected-red-035' });
  const ER_ROOT = ensureDir(path.join(SCRATCH_ROOT, 'expected-red'));
  const nonce = randomNonce();
  let work;
  let template;

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
    fs.copyFileSync(path.join(bindingDir, 'final-binding-files-035.json'), path.join(dst, 'final-binding-files-035.json'));
    fs.copyFileSync(path.join(bindingDir, 'final-binding-manifest-035.json'), path.join(dst, 'final-binding-manifest-035.json'));
    return dst;
  }

  function copyDir(src, dst) {
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      if (fs.statSync(s).isDirectory()) { ensureDir(d); copyDir(s, d); }
      else fs.copyFileSync(s, d);
    }
  }

  function stageTemplate() {
    const filesDoc = readJson(path.join(bindingDir, 'final-binding-files-035.json'));
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

  function restoreFromTemplate(labels) {
    for (const label of labels) {
      const src = path.join(template, label);
      const dst = path.join(work, label);
      ensureDir(path.dirname(dst));
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  }

  const attacks = [
    { id: '01-delete-033-stage', name: '删 033 stage (wrong-db-name/mutated/stdout.txt)', binder: null, restoreLabels: ['evidence/cases/wrong-db-name/mutated/stdout.txt'], describe: 'delete staged 033 evidence file', mutate: (w) => { fs.rmSync(path.join(w, 'evidence/cases/wrong-db-name/mutated/stdout.txt'), { force: true }); } },
    { id: '02-tamper-033-raw', name: '篡改 033 raw (wrong-key/baseline/stdout.txt)', binder: null, restoreLabels: ['evidence/cases/wrong-key/baseline/stdout.txt'], describe: 'append bytes to staged 033 raw', mutate: (w) => { fs.appendFileSync(path.join(w, 'evidence/cases/wrong-key/baseline/stdout.txt'), 'TAMPERED'); } },
    { id: '03-replace-harness', name: '替换 1/10 harness (common.js)', binder: null, restoreLabels: ['harness/common.js'], describe: 'overwrite staged harness common.js', mutate: (w) => { fs.writeFileSync(path.join(w, 'harness/common.js'), '// replaced'); } },
    { id: '04-delete-freeze-stdout', name: '删 freeze stdout', binder: null, restoreLabels: ['self/freeze-verifier/stdout.txt'], describe: 'delete staged freeze stdout', mutate: (w) => { fs.rmSync(path.join(w, 'self/freeze-verifier/stdout.txt'), { force: true }); } },
    { id: '05-tamper-freeze-stderr', name: '篡改 freeze stderr', binder: null, restoreLabels: ['self/freeze-verifier/stderr.txt'], describe: 'append bytes to staged freeze stderr', mutate: (w) => { fs.appendFileSync(path.join(w, 'self/freeze-verifier/stderr.txt'), 'TAMPERED'); } },
    { id: '06-forge-freeze-meta', name: '伪造 freeze meta (删 executedSourceSha256)', binder: null, restoreLabels: ['self/freeze-verifier/meta.json'], describe: 'remove a mandatory identity field', mutate: (w) => {
      const metaPath = path.join(w, 'self/freeze-verifier/meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      delete meta.executedSourceSha256;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } },
    { id: '07-remove-source-binding', name: '删 source-binding (harness/audit.js entry)', binder: () => {
      const b = copyBindingTo('07-remove-source-binding');
      const filesDoc = readJson(path.join(b, 'final-binding-files-035.json'));
      filesDoc.entries = filesDoc.entries.filter((e) => !(e.kind === 'harness-source' && e.label === 'harness/audit.js'));
      filesDoc.entryCount = filesDoc.entries.length;
      writeJson(path.join(b, 'final-binding-files-035.json'), filesDoc);
      return b;
    }, restoreLabels: [], describe: 'remove a harness entry from a binding copy' },
    { id: '08-tamper-store', name: '改 Store SHA (store/store.js)', binder: null, restoreLabels: ['store/store.js'], describe: 'tamper staged store.js', mutate: (w) => { fs.appendFileSync(path.join(w, 'store/store.js'), '// tampered'); } },
    { id: '09-tamper-033-card', name: '改 033 卡 SHA (card/033)', binder: null, restoreLabels: ['card/033'], describe: 'tamper staged 033 card', mutate: (w) => { fs.appendFileSync(path.join(w, 'card/033'), '// tampered'); } },
    { id: '10-forge-flags', name: '篡改 flags (releaseReady=true)', binder: () => {
      const b = copyBindingTo('10-forge-flags');
      const manifestDoc = readJson(path.join(b, 'final-binding-manifest-035.json'));
      manifestDoc.flags.releaseReady = true;
      writeJson(path.join(b, 'final-binding-manifest-035.json'), manifestDoc);
      return b;
    }, restoreLabels: [], describe: 'flags misclaim in a binding copy' },
    { id: '11-capturedFrom-replica', name: 'meta capturedFrom/argv -> freeze-replica-check.js', binder: null, restoreLabels: ['self/freeze-verifier/meta.json'], describe: 'identity substitution: parent meta claims a different child source', mutate: (w) => {
      const metaPath = path.join(w, 'self/freeze-verifier/meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.capturedFrom = 'D:\\xinjing-electron\\scripts\\v5.1.1-tests\\XJ-5.1.1-billing-store-cross-restart-hydration-final-binding-evidence-closure-rework-034\\freeze-replica-check.js';
      meta.argv = [meta.argv[0], 'freeze-replica-check.js', '--evidence-root', 'x', '--run-id', 'y'];
      meta.tool = 'freeze-verifier';
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } },
    { id: '12-forge-executed-source-sha', name: '伪造 executedSourceSha256', binder: null, restoreLabels: ['self/freeze-verifier/meta.json'], describe: 'forged executed source fingerprint', mutate: (w) => {
      const metaPath = path.join(w, 'self/freeze-verifier/meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.executedSourceSha256 = '00'.repeat(32);
      meta.executedSourceBytes = 99999;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } },
    { id: '13-redirect-root-033', name: 'redirectRoot -> 033 candidate root (hook disabled)', binder: null, restoreLabels: ['self/freeze-verifier/meta.json'], describe: 'redirect relaxation targeting 033', mutate: (w) => {
      const metaPath = path.join(w, 'self/freeze-verifier/meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.redirectRoot = 'D:\\xinjing-electron\\qa\\task-scratch\\XJ-5.1.1-billing-store-cross-restart-hydration-canonical-evidence-continuation-033\\candidate\\run-033-20260827041958-3ec36f2a3a4bc9';
      delete meta.hookSha256;
      meta.mapping.scope = 'writes allowed outside 035';
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } },
    { id: '14-forge-hook-sha', name: '伪造 hookSha256', binder: null, restoreLabels: ['self/freeze-verifier/meta.json'], describe: 'hook fingerprint substitution', mutate: (w) => {
      const metaPath = path.join(w, 'self/freeze-verifier/meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.hookSha256 = '11'.repeat(32);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } }
  ];

  async function main() {
    const baselineResult = await runVerifier(bindingDir, null);
    const baselineDir = ensureDir(path.join(ER_ROOT, 'baseline'));
    const baselineRuns = writeRun(baselineDir, 'baseline', baselineResult);
    writeJson(path.join(baselineDir, 'meta.json'), {
      taskId: TASK_ID, runId: runId, run: 'baseline', mode: 'authoritative',
      startUtc: nowUtc(), endUtc: nowUtc(), exitCode: baselineResult.exitCode,
      verdict: baselineResult.exitCode === 0 ? 'PASS' : 'FAIL',
      stdoutSha256: baselineRuns.stdoutSha256, stderrSha256: baselineRuns.stderrSha256
    });
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
      else attack.mutate(work);
      const mutated = await runVerifier(usedBinding, work);
      const mutatedRuns = writeRun(outDir, 'mutated', mutated);
      if (attack.restoreLabels.length) restoreFromTemplate(attack.restoreLabels);
      else usedBinding = bindingDir;
      const restoreResult = await runVerifier(usedBinding, work);
      const restoreRuns = writeRun(outDir, 'restore', restoreResult);
      const endUtc = nowUtc();
      const rejected = mutated.exitCode !== 0;
      const restoredOk = restoreResult.exitCode === 0;
      const meta = {
        taskId: TASK_ID, runId: runId, attackId: attack.id, name: attack.name, description: attack.describe,
        bindingDir: usedBinding, inputsRoot: work, startUtc: startUtc, endUtc: endUtc,
        mutatedExit: mutated.exitCode, mutatedVerdict: rejected ? 'REJECTED' : 'FAIL',
        restoreExit: restoreResult.exitCode, restoreVerdict: restoredOk ? 'PASS' : 'FAIL',
        mutated: mutatedRuns, restore: restoreRuns, overall: rejected && restoredOk ? 'KILLED' : 'SURVIVED'
      };
      writeJson(path.join(outDir, 'meta.json'), meta);
      results.push(meta);
      if (!rejected) process.stderr.write(JSON.stringify({ type: 'attack-survived', attackId: attack.id }) + String.fromCharCode(10));
      if (!restoredOk) process.stderr.write(JSON.stringify({ type: 'restore-failed', attackId: attack.id }) + String.fromCharCode(10));
    }
    const killed = results.filter((r) => r.overall === 'KILLED').length;
    if (killed !== attacks.length) fail('not all attacks killed: ' + killed + '/' + attacks.length);
    process.stdout.write(JSON.stringify({
      type: 'expected-red-035-summary',
      taskId: TASK_ID, runId: runId, bindingDir: bindingDir,
      total: attacks.length, killed: killed,
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
    process.stderr.write(JSON.stringify({ type: 'expected-red-035-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
