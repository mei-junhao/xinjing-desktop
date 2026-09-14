'use strict';

const fs = require('fs');
const path = require('path');
const {
  TASK_ID,
  PROJECT_ROOT,
  SCRIPT_ROOT,
  ensureFreshEvidenceRoot,
  ensureDir,
  readJson,
  writeJson,
  writeUtf8,
  sha256File,
  byteLength,
  nowUtc,
  runChild,
  makeMeta,
  installSelfCapture,
} = require('./common');

const VERIFIER = path.join(SCRIPT_ROOT, 'verifier.js');
const LEGACY_ROOT = path.resolve(PROJECT_ROOT, 'qa/task-scratch/XJ-5.1.1-billing-store-cross-restart-hydration-no-context-independent-review-evidence-raw-closure-rework-024');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const evidenceRoot = ensureFreshEvidenceRoot(argValue('--evidence-root', ''));
const manifest = readJson(path.join(evidenceRoot, 'run-manifest.json'));
const runId = argValue('--run-id', manifest.runId);
process.env.XJ_SELF_START_UTC = nowUtc();
const finalizeSelf = installSelfCapture({ root: evidenceRoot, runId, toolName: 'audit' });

function walkFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else result.push(full);
  }
  return result;
}

function copyEvidenceClone(target) {
  fs.cpSync(evidenceRoot, target, { recursive: true, force: true, errorOnExist: false });
  const escapedOriginal = evidenceRoot.replace(/\\/g, '\\\\');
  const escapedTarget = target.replace(/\\/g, '\\\\');
  for (const filePath of walkFiles(target)) {
    // Rebind path-bearing JSON metadata only. Raw stdout/stderr must remain
    // byte-identical to the canonical evidence so an attack fails for the
    // mutation under test, not because clone-path substitution changed its
    // recorded byte count or SHA.
    if (!/\.json$/i.test(filePath)) continue;
    const raw = fs.readFileSync(filePath, 'utf8');
    const rebound = raw.split(evidenceRoot).join(target).split(escapedOriginal).join(escapedTarget);
    if (rebound !== raw) fs.writeFileSync(filePath, rebound, 'utf8');
  }
}

function stagePath(root, caseId, stage, file) {
  return path.join(root, 'cases', caseId, stage, file);
}

function refreshMeta(metaPath) {
  const meta = readJson(metaPath);
  meta.stdoutSha256 = sha256File(meta.stdoutPath);
  meta.stderrSha256 = sha256File(meta.stderrPath);
  meta.stdoutBytes = fs.statSync(meta.stdoutPath).size;
  meta.stderrBytes = fs.statSync(meta.stderrPath).size;
  writeJson(metaPath, meta);
}

function rewriteSummary(filePath, mutate) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/(\r?\n)/);
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    if (!line || !line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && value.type === 'phase-summary') {
        lines[index] = JSON.stringify(mutate(value));
        break;
      }
    } catch (_) {}
  }
  fs.writeFileSync(filePath, lines.join(''), 'utf8');
}

function findLegacyRaw() {
  const candidates = walkFiles(LEGACY_ROOT).filter((filePath) => /stdout\.txt$/i.test(filePath));
  return candidates.length ? candidates[0] : null;
}

async function runVerifierOnClone(cloneRoot, attackId, index) {
  const attackRoot = ensureDir(path.join(evidenceRoot, 'attacks', String(index).padStart(2, '0') + '-' + attackId));
  const startUtc = nowUtc();
  const result = await runChild(process.execPath, [VERIFIER, '--run-id', runId, '--evidence-root', cloneRoot], { cwd: PROJECT_ROOT });
  const stdoutPath = path.join(attackRoot, 'stdout.txt');
  const stderrPath = path.join(attackRoot, 'stderr.txt');
  writeUtf8(stdoutPath, result.stdout);
  writeUtf8(stderrPath, result.stderr);
  const killed = result.exitCode !== 0;
  const meta = makeMeta({
    runId,
    caseId: '__audit__',
    stage: attackId,
    command: process.execPath,
    argv: [VERIFIER, '--run-id', runId, '--evidence-root', cloneRoot],
    cwd: PROJECT_ROOT,
    startUtc,
    endUtc: nowUtc(),
    exitCode: result.exitCode,
    stdoutPath,
    stderrPath,
    verdict: killed ? 'REJECTED' : 'PASS',
  });
  const metaPath = path.join(attackRoot, 'meta.json');
  writeJson(metaPath, meta);
  return {
    attackId,
    command: process.execPath,
    argv: [VERIFIER, '--run-id', runId, '--evidence-root', cloneRoot],
    cwd: PROJECT_ROOT,
    exitCode: result.exitCode,
    killed,
    stdoutPath,
    stderrPath,
    metaPath,
    stdoutSha256: meta.stdoutSha256,
    stderrSha256: meta.stderrSha256,
    originalResult: result.stdout.toString('utf8'),
    originalError: result.stderr.toString('utf8'),
  };
}

function attackMutations() {
  return [
    {
      id: 'delete-stage',
      apply(root) { fs.unlinkSync(stagePath(root, 'wrong-db-name', 'baseline', 'stdout.txt')); },
    },
    {
      id: 'delete-stderr',
      apply(root) { fs.unlinkSync(stagePath(root, 'wrong-db-name', 'baseline', 'stderr.txt')); },
    },
    {
      id: 'alter-sha',
      apply(root) {
        const metaPath = stagePath(root, 'wrong-key', 'baseline', 'meta.json');
        const meta = readJson(metaPath);
        meta.stdoutSha256 = '0'.repeat(64);
        writeJson(metaPath, meta);
      },
    },
    {
      id: 'copy-024-raw',
      apply(root) {
        const source = findLegacyRaw();
        const target = stagePath(root, 'wrong-db-name', 'mutated', 'stdout.txt');
        if (source) fs.copyFileSync(source, target);
        else writeUtf8(target, '{"type":"legacy-024-raw"}\n');
        refreshMeta(stagePath(root, 'wrong-db-name', 'mutated', 'meta.json'));
      },
    },
    {
      id: 'baseline-masquerade',
      apply(root) {
        const baselineOut = stagePath(root, 'wrong-key', 'baseline', 'stdout.txt');
        const baselineErr = stagePath(root, 'wrong-key', 'baseline', 'stderr.txt');
        const targetOut = stagePath(root, 'wrong-key', 'mutated', 'stdout.txt');
        const targetErr = stagePath(root, 'wrong-key', 'mutated', 'stderr.txt');
        fs.copyFileSync(baselineOut, targetOut);
        fs.copyFileSync(baselineErr, targetErr);
        refreshMeta(stagePath(root, 'wrong-key', 'mutated', 'meta.json'));
      },
    },
    {
      id: 'cross-case-sibling',
      apply(root) {
        const metaPath = stagePath(root, 'wrong-key', 'mutated', 'meta.json');
        const meta = readJson(metaPath);
        const siblingPath = stagePath(root, 'wrong-db-name', 'mutated', 'stdout.txt');
        meta.stdoutPath = siblingPath;
        meta.stdoutBytes = byteLength(siblingPath);
        meta.stdoutSha256 = sha256File(siblingPath);
        writeJson(metaPath, meta);
      },
    },
    {
      id: 'fake-ok-true',
      apply(root) {
        const out = stagePath(root, 'object-as-array', 'mutated', 'stdout.txt');
        rewriteSummary(out, (summary) => {
          summary.semanticPass = true;
          summary.verdict = 'PASS';
          if (summary.reader && summary.reader.result) {
            summary.reader.result.ok = true;
            summary.reader.result.counts = { clients: 1, sessions: 2, monthlyPayments: 1, amount: 520 };
          }
          return summary;
        });
        refreshMeta(stagePath(root, 'object-as-array', 'mutated', 'meta.json'));
      },
    },
    {
      id: 'force-kill-graceful',
      apply(root) {
        const out = stagePath(root, 'core', 'core', 'stdout.txt');
        rewriteSummary(out, (summary) => {
          if (summary.writer && summary.writer.result) summary.writer.result.forceExit = true;
          return summary;
        });
        refreshMeta(stagePath(root, 'core', 'core', 'meta.json'));
      },
    },
  ];
}

async function main() {
  if (manifest.taskId !== TASK_ID || manifest.runId !== runId || manifest.evidenceRoot !== evidenceRoot) throw new Error('audit manifest identity mismatch');
  const canonicalVerifier = await runChild(process.execPath, [VERIFIER, '--run-id', runId, '--evidence-root', evidenceRoot], { cwd: PROJECT_ROOT });
  if (canonicalVerifier.exitCode !== 0) throw new Error('canonical verifier failed before adversarial audit');
  const source = findLegacyRaw();
  const attacks = [];
  let index = 0;
  for (const mutation of attackMutations()) {
    index += 1;
    const cloneRoot = path.resolve(path.dirname(evidenceRoot), 'attack-clone-' + index + '-' + mutation.id + '-' + runId.slice(-8));
    copyEvidenceClone(cloneRoot);
    mutation.apply(cloneRoot);
    const record = await runVerifierOnClone(cloneRoot, mutation.id, index);
    record.sourceFound = mutation.id === 'copy-024-raw' ? !!source : null;
    record.sourceKind = mutation.id === 'copy-024-raw' ? 'legacy-024-read-only-attack-only' : null;
    if (!record.killed) throw new Error('adversarial attack survived: ' + mutation.id);
    attacks.push(record);
  }
  const ledger = {
    version: 'audit-ledger-025-v1',
    taskId: TASK_ID,
    runId,
    evidenceRoot,
    canonicalVerifier: { exitCode: canonicalVerifier.exitCode, stdout: canonicalVerifier.stdout.toString('utf8'), stderr: canonicalVerifier.stderr.toString('utf8') },
    attacks,
    killed: attacks.filter((entry) => entry.killed).length,
    total: attacks.length,
    verdict: attacks.length === 8 && attacks.every((entry) => entry.killed) ? 'PASS' : 'FAIL',
    generatedAt: nowUtc(),
  };
  writeJson(path.join(evidenceRoot, 'audit-ledger.json'), ledger);
  if (ledger.verdict !== 'PASS') throw new Error('audit ledger did not PASS');
  process.stdout.write(JSON.stringify({ type: 'audit-summary', taskId: TASK_ID, runId, evidenceRoot, total: ledger.total, killed: ledger.killed, canonicalVerifierExitCode: canonicalVerifier.exitCode, verdict: 'PASS' }) + '\n');
  return 0;
}

main().then((code) => {
  finalizeSelf(code, code === 0 ? 'PASS' : 'FAIL');
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'audit-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
  finalizeSelf(1, 'FAIL');
  process.exitCode = 1;
});
