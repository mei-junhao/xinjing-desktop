'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  PROJECT_ROOT,
  SCRIPT_ROOT,
  SCRATCH_ROOT,
  ensureFreshEvidenceRoot,
  readJson,
  writeJson,
  sha256File,
  nowUtc,
  randomNonce,
  runChild,
  installSelfCapture,
  assertMetaShape,
  assertFreshEvidencePath,
  lastJsonLine
} = require('./common');

const VERIFIER = path.join(SCRIPT_ROOT, 'verifier.js');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const rootArg = argValue('--evidence-root', '');
if (!rootArg) {
  process.stderr.write(JSON.stringify({ type: 'audit-error', message: '--evidence-root is required' }) + String.fromCharCode(10));
  process.exitCode = 2;
} else {
  const evidenceRoot = ensureFreshEvidenceRoot(rootArg);
  const manifest = readJson(path.join(evidenceRoot, 'run-manifest.json'));
  const runId = argValue('--run-id', '') || manifest.runId;
  process.env.XJ_SELF_START_UTC = nowUtc();
  const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId: runId, toolName: 'audit' });
  const runSafe = String(runId).replace(/[^A-Za-z0-9._-]/g, '_');
  const ATTACK_ROOT = ensureFreshEvidenceRoot(path.join(SCRATCH_ROOT, 'audit', runSafe + '-' + randomNonce()));
  const CLONE_ROOT = path.join(SCRATCH_ROOT, 'audit-clones', runSafe);
  fs.mkdirSync(CLONE_ROOT, { recursive: true });

  function copyFiltered(src, dst) {
    const skip = new Set(['contexts', 'p']);
    const walk = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const name of fs.readdirSync(from)) {
        if (skip.has(name)) continue;
        const s = path.join(from, name);
        const d = path.join(to, name);
        const st = fs.lstatSync(s);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(s, d);
        else if (st.isFile()) fs.copyFileSync(s, d);
      }
    };
    walk(src, dst);
  }

  function stagePath(cloneRoot, caseId, stage) {
    return path.join(cloneRoot, 'cases', caseId, stage);
  }

  function rewriteStage(cloneRoot, caseId, stage, summaryMutator, metaPatcher) {
    const dir = stagePath(cloneRoot, caseId, stage);
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    const lines = fs.readFileSync(stdoutPath, 'utf8').split(/\r?\n/);
    const out = [];
    for (const line of lines) {
      let replaced = line;
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.type === 'phase-summary') {
          replaced = JSON.stringify(summaryMutator(parsed));
        }
      } catch (error) {}
      out.push(replaced);
    }
    fs.writeFileSync(stdoutPath, out.join(String.fromCharCode(10)) + String.fromCharCode(10));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const patched = metaPatcher(meta);
    patched.stdoutSha256 = sha256File(stdoutPath);
    patched.stderrSha256 = sha256File(stderrPath);
    patched.stdoutBytes = fs.statSync(stdoutPath).size;
    patched.stderrBytes = fs.statSync(stderrPath).size;
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(patched, null, 2) + String.fromCharCode(10));
  }

  function freshClone(tag) {
    const dst = path.join(CLONE_ROOT, tag);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    copyFiltered(evidenceRoot, dst);
    return dst;
  }

  function makeMeta(attack, cloneRoot, verifierResult, startUtc, endUtc) {
    const outDir = path.join(ATTACK_ROOT, attack.id);
    fs.mkdirSync(outDir, { recursive: true });
    const outStdout = path.join(outDir, 'verifier.stdout.txt');
    const outStderr = path.join(outDir, 'verifier.stderr.txt');
    fs.writeFileSync(outStdout, verifierResult.stdout);
    fs.writeFileSync(outStderr, verifierResult.stderr);
    const meta = {
      taskId: TASK_ID,
      attackId: attack.id,
      name: attack.name,
      command: VERIFIER,
      argv: [VERIFIER, '--evidence-root', cloneRoot],
      cwd: PROJECT_ROOT,
      startUtc: startUtc,
      endUtc: endUtc,
      exitCode: verifierResult.exitCode,
      verdict: verifierResult.exitCode === 0 ? 'FAIL' : 'REJECTED',
      verifierRejected: verifierResult.exitCode !== 0,
      stdoutPath: outStdout,
      stderrPath: outStderr,
      stdoutSha256: sha256File(outStdout),
      stderrSha256: sha256File(outStderr),
      stdoutBytes: fs.statSync(outStdout).size,
      stderrBytes: fs.statSync(outStderr).size,
      description: attack.description
    };
    writeJson(path.join(outDir, 'meta.json'), meta);
    return meta;
  }

  const attacks = [
    {
      id: '01-delete-stage', name: '删 stage',
      description: 'Remove an entire stage (wrong-db-name/mutated) from a clone; verifier must reject the missing triplet.',
      mutate: (clone) => { fs.rmSync(stagePath(clone, 'wrong-db-name', 'mutated'), { recursive: true, force: true }); }
    },
    {
      id: '02-delete-stderr', name: '删 stderr',
      description: 'Remove stderr.txt of wrong-db-name/baseline; verifier must reject the missing raw file.',
      mutate: (clone) => { fs.rmSync(path.join(stagePath(clone, 'wrong-db-name', 'baseline'), 'stderr.txt'), { force: true }); }
    },
    {
      id: '03-tamper-sha', name: '篡改 SHA',
      description: 'Append bytes to wrong-object-store/baseline/stdout.txt; recomputed SHA must mismatch meta.',
      mutate: (clone) => { fs.appendFileSync(path.join(stagePath(clone, 'wrong-object-store', 'baseline'), 'stdout.txt'), String.fromCharCode(10) + 'TAMPERED'); }
    },
    {
      id: '04-old-raw-inject', name: '旧 raw 注入',
      description: 'Inject a fabricated phase-summary whose runId claims the legacy 029 run; verifier must reject the identity mismatch.',
      mutate: (clone) => {
        const fake = { type: 'phase-summary', runId: 'run-029-20260827091500-codex', caseId: 'wrong-key', stage: 'baseline', fixedOrigin: 'http://127.0.0.1:19503', denyNetwork: true, writer: { exitCode: 0, result: { ok: true }, stdout: '', stderr: '' }, reader: { exitCode: 0, result: { ok: true, counts: { clients: 1, sessions: 2, monthlyPayments: 1, amount: 520 } }, stdout: '', stderr: '' }, writerContext: { userData: 'x', origin: 'http://127.0.0.1:19503' }, readerContext: { userData: 'x', origin: 'http://127.0.0.1:19503' }, semanticPass: true, verdict: 'PASS', generatedAt: '2026-08-27T00:00:00.000Z' };
        fs.writeFileSync(path.join(stagePath(clone, 'wrong-key', 'baseline'), 'stdout.txt'), JSON.stringify(fake) + String.fromCharCode(10));
      }
    },
    {
      id: '05-baseline-as-mutated', name: 'baseline 冒充 mutated',
      description: 'Replace skip-await/mutated with pristine baseline files; verifier must reject PASS-in-mutated.',
      mutate: (clone) => {
        const src = stagePath(clone, 'skip-await', 'baseline');
        const dst = stagePath(clone, 'skip-await', 'mutated');
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(dst, { recursive: true });
        for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) fs.copyFileSync(path.join(src, name), path.join(dst, name));
      }
    },
    {
      id: '06-cross-case', name: '跨 case/sibling 路径',
      description: 'Copy wrong-db-name/baseline files into wrong-object-store/baseline; summary caseId must mismatch.',
      mutate: (clone) => {
        const src = stagePath(clone, 'wrong-db-name', 'baseline');
        const dst = stagePath(clone, 'wrong-object-store', 'baseline');
        for (const name of ['stdout.txt', 'stderr.txt', 'meta.json']) fs.copyFileSync(path.join(src, name), path.join(dst, name));
      }
    },
    {
      id: '07-forge-pass', name: '伪造 PASS / ok:true',
      description: 'Flip wrong-key/mutated meta to PASS + exit 0 without touching raw; verdict/exit contract must reject.',
      mutate: (clone) => {
        const metaPath = path.join(stagePath(clone, 'wrong-key', 'mutated'), 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.verdict = 'PASS';
        meta.exitCode = 0;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + String.fromCharCode(10));
      }
    },
    {
      id: '08-force-kill-as-graceful', name: '强杀冒充 graceful',
      description: 'Rewrite skip-await/mutated summary to erase forceExit and flip meta to PASS/0 with recomputed SHA; REJECTED contract must still reject.',
      mutate: (clone) => {
        rewriteStage(clone, 'skip-await', 'mutated',
          (summary) => { if (summary.writer && summary.writer.result) { delete summary.writer.result.forceExit; } return summary; },
          (meta) => { meta.verdict = 'PASS'; meta.exitCode = 0; return meta; });
      }
    },
    {
      id: '09-mutated-exit-zero', name: 'mutated exit 改 0',
      description: 'Set object-as-array/mutated meta exitCode to 0 (verdict stays REJECTED); fixed exit=2 contract must reject.',
      mutate: (clone) => {
        const metaPath = path.join(stagePath(clone, 'object-as-array', 'mutated'), 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.exitCode = 0;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + String.fromCharCode(10));
      }
    },
    {
      id: '10-summary-only', name: 'summary-only',
      description: 'Delete cross-userdata-origin/mutated triplet and leave a bare summary file; missing raw/meta must reject.',
      mutate: (clone) => {
        const dir = stagePath(clone, 'cross-userdata-origin', 'mutated');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ forged: true }) + String.fromCharCode(10));
      }
    }
  ];

  async function runVerifier(cloneRoot) {
    return runChild(process.execPath, [VERIFIER, '--evidence-root', cloneRoot], { cwd: PROJECT_ROOT });
  }

  function verifySelfTriplet(toolName) {
    const dir = path.join(evidenceRoot, 'self', toolName);
    const metaPath = path.join(dir, 'meta.json');
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) throw new Error(toolName + ' self triplet missing');
    const meta = readJson(metaPath);
    assertMetaShape(meta, evidenceRoot, { runId: runId, caseId: '__self__', stage: toolName });
    if (meta.verdict !== 'PASS' || meta.exitCode !== 0) throw new Error(toolName + ' self did not PASS');
    return meta;
  }

  async function probeEarlySelfCapture() {
    const clone = freshClone('probe-early-self-capture');
    const selfDir = path.join(clone, 'self', 'runner');
    const stdoutPath = path.join(selfDir, 'stdout.txt');
    const stderrPath = path.join(selfDir, 'stderr.txt');
    const endUtc = nowUtc();
    const startUtc = new Date(Date.parse(endUtc) + 3600000).toISOString();
    const meta = {
      taskId: TASK_ID, runId: runId, caseId: '__self__', stage: 'runner',
      command: process.execPath, argv: ['runner.js'], cwd: PROJECT_ROOT,
      startUtc: startUtc, endUtc: endUtc, exitCode: 0,
      stdoutPath: stdoutPath, stderrPath: stderrPath, metaPath: path.join(selfDir, 'meta.json'),
      stdoutSha256: sha256File(stdoutPath), stderrSha256: sha256File(stderrPath),
      stdoutBytes: fs.statSync(stdoutPath).size, stderrBytes: fs.statSync(stderrPath).size,
      verdict: 'PASS'
    };
    fs.writeFileSync(path.join(selfDir, 'meta.json'), JSON.stringify(meta, null, 2) + String.fromCharCode(10));
    const res = await runVerifier(clone);
    return { ok: res.exitCode !== 0, exitCode: res.exitCode };
  }

  async function main() {
    const ledger = readJson(path.join(evidenceRoot, 'expected-red-ledger.json'));
    const killed = {};
    const attackResults = [];
    for (const attack of attacks) {
      const clone = freshClone(attack.id);
      const startUtc = nowUtc();
      attack.mutate(clone);
      const res = await runVerifier(clone);
      const endUtc = nowUtc();
      const meta = makeMeta(attack, clone, res, startUtc, endUtc);
      killed[attack.id] = res.exitCode !== 0;
      attackResults.push(meta);
      if (res.exitCode === 0) {
        process.stderr.write(JSON.stringify({ type: 'attack-survived', attackId: attack.id, message: 'verifier accepted the wounded clone' }) + String.fromCharCode(10));
      }
    }
    const killedCount = attackResults.filter((r) => r.verifierRejected).length;
    if (killedCount !== attacks.length) throw new Error('not all attacks were killed: ' + killedCount + '/' + attacks.length);

    const probes = [
      { id: 'p1-drop-await', name: '删除 await', timeout: false },
      { id: 'p2-replace-durable-api', name: '替换 durable API', timeout: false },
      { id: 'p3-swallow-ok-false', name: '吞掉 ok:false', timeout: false },
      { id: 'p4-skip-handler', name: '跳过持久化 handler', timeout: false },
      { id: 'p5-forge-success', name: '伪造成功', timeout: false },
      { id: 'p6-reuse-old-raw', name: '复用历史 raw（对应攻击 04）', timeout: false },
      { id: 'p7-baseline-as-mutated', name: 'baseline 冒充 mutated（对应攻击 05）', timeout: false },
      { id: 'p8-early-self-capture', name: '提前 self-capture', timeout: true }
    ];
    const caseOf = { 'p1-drop-await': 'skip-await', 'p2-replace-durable-api': 'wrong-key', 'p3-swallow-ok-false': 'swallow-ok-false', 'p4-skip-handler': 'object-as-array', 'p5-forge-success': 'old-memory-reuse' };
    const probeResults = [];
    for (const probe of probes) {
      if (probe.id === 'p8-early-self-capture') {
        const res = await probeEarlySelfCapture();
        probeResults.push({ id: probe.id, name: probe.name, ok: res.ok, detail: { verifierExit: res.exitCode } });
        continue;
      }
      if (probe.id === 'p6-reuse-old-raw' || probe.id === 'p7-baseline-as-mutated') {
        const attackId = probe.id === 'p6-reuse-old-raw' ? '04-old-raw-inject' : '05-baseline-as-mutated';
        probeResults.push({ id: probe.id, name: probe.name, ok: killed[attackId] === true, detail: { attack: attackId, killed: killed[attackId] } });
        continue;
      }
      const entry = ledger.cases.find((c) => c.caseId === caseOf[probe.id]);
      const mutated = entry && entry.stages && entry.stages.mutated;
      const ok = !!mutated && mutated.exitCode === 2 && mutated.verdict === 'REJECTED' && mutated.summaryVerdict === 'REJECTED';
      probeResults.push({ id: probe.id, name: probe.name, ok: ok, detail: { caseId: entry && entry.caseId, exitCode: mutated && mutated.exitCode, verdict: mutated && mutated.verdict } });
    }
    if (probeResults.some((p) => !p.ok)) throw new Error('internal adversarial review probes did not all pass');

    const selfChecks = {};
    for (const tool of ['runner', 'expected-red', 'verifier']) {
      try { verifySelfTriplet(tool); selfChecks[tool] = 'PASS'; } catch (error) { selfChecks[tool] = 'FAIL:' + error.message; }
    }
    if (Object.values(selfChecks).some((v) => v !== 'PASS')) throw new Error('self triplet verification failed: ' + JSON.stringify(selfChecks));

    const auditSummary = {
      type: 'audit-summary',
      taskId: TASK_ID,
      runId: runId,
      evidenceRoot: evidenceRoot,
      attackerRoot: ATTACK_ROOT,
      verifierExitCode: 0,
      total: attacks.length,
      killed: killedCount,
      probes: probeResults.length,
      probesOk: probeResults.filter((p) => p.ok).length,
      attacks: attackResults.map((r) => ({ attackId: r.attackId, verdict: r.verdict, exitCode: r.exitCode })),
      probesDetail: probeResults,
      self: selfChecks,
      adversarialReview: 'PASS',
      verdict: 'PASS',
      reviewedAt: nowUtc()
    };
    process.stdout.write(JSON.stringify(auditSummary) + String.fromCharCode(10));
    return 0;
  }

  main().then((code) => {
    finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ type: 'audit-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
    finalizeSelf(1, 'FAIL');
    process.exitCode = 1;
  });
}
