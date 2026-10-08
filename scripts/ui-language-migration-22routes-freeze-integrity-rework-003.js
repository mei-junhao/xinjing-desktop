'use strict';

/* XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003
 * Freeze-integrity tooling for the task-003 successor evidence bundle.
 *
 * Subcommands:
 *   node scripts/ui-language-migration-22routes-freeze-integrity-rework-003.js build-manifest
 *       Generate the successor final SHA manifest from LIVE disk bytes (true
 *       values only). Excludes LEASE.json, the delivery report, the manifest
 *       itself, the pin file, and post-freeze mutable working files.
 *   node scripts/ui-language-migration-22routes-freeze-integrity-rework-003.js pin
 *       Write manifest-sha256.pin next to the manifest (post-freeze anchor).
 *   node scripts/ui-language-migration-22routes-freeze-integrity-rework-003.js expected-reds
 *       Run the five real-disk adversarial mutations against the frozen
 *       bundle, require a nonzero verifier exit for each, restore every byte
 *       in finally, confirm restoration by SHA, then require verifier PASS.
 *   node scripts/ui-language-migration-22routes-freeze-integrity-rework-003.js bundle-hash [label]
 *       SHA-256 aggregate over every manifest-declared artifact (drift probe).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = 'D:/xinjing-electron';
const TASK_002 = 'XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002';
const TASK_003 = 'XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003';
const SCRATCH_003 = path.join(ROOT, 'qa/task-scratch', TASK_003);
const EVIDENCE_003 = path.join(SCRATCH_003, 'evidence');
const SHOT_DIR_003 = path.join(EVIDENCE_003, 'screenshots');
const MANIFEST = path.join(SCRATCH_003, 'final-sha-manifest.json');
const PIN = path.join(SCRATCH_003, 'manifest-sha256.pin');
const PRED_MANIFEST = path.join(ROOT, 'qa/task-scratch', TASK_002, 'final-sha-manifest.json');
const VERIFIER = path.join(ROOT, 'scripts/ui-language-migration-22routes-verifier.js');
const TOOL = 'scripts/ui-language-migration-22routes-freeze-integrity-rework-003.js';

function sha256Buf(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function sha256File(p) { return sha256Buf(fs.readFileSync(p)); }
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function entry(p, shaKey) { return { path: rel(p), sha256: sha256File(p), size: fs.statSync(p).size }; }

function runVerifier(extraArgs) {
  const r = spawnSync(process.execPath, [VERIFIER].concat(extraArgs || []), { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function buildManifest() {
  const pred = JSON.parse(fs.readFileSync(PRED_MANIFEST, 'utf8'));
  const uiSources = pred.writable_files.map(f => {
    const abs = path.join(ROOT, f.path);
    return { path: f.path, final_sha256: sha256File(abs), size: fs.statSync(abs).size };
  });
  const protectedFiles = pred.protected_files.map(f => entry(path.join(ROOT, f.path)));
  const harnessScripts = pred.harness_scripts.map(f => entry(path.join(ROOT, f.path)));
  const shims = fs.readdirSync(path.join(SCRATCH_003, 'shims')).sort()
    .map(n => entry(path.join(SCRATCH_003, 'shims', n)));
  const tooling = [
    entry(VERIFIER),
    entry(path.join(ROOT, TOOL)),
    entry(path.join(SCRATCH_003, 'snapshot-guard.js')),
    entry(path.join(SCRATCH_003, 'checkpoint-a-verify.js')),
  ];
  const evidenceFiles = fs.readdirSync(EVIDENCE_003).sort().filter(n => n.endsWith('.json'))
    .map(n => entry(path.join(EVIDENCE_003, n)));
  const shotNames = fs.readdirSync(SHOT_DIR_003).sort();
  const shotFiles = shotNames.map(n => entry(path.join(SHOT_DIR_003, n)));
  const aggLines = shotFiles.map(f => f.path + '\u0000' + f.sha256 + '\u0000' + String(f.size)).sort();
  const aggregate = sha256Buf(Buffer.from(aggLines.join('\n') + '\n', 'utf8'));
  const visualInputs = [
    { path: pred.visual_baseline.workbench_png, sha256: sha256File(pred.visual_baseline.workbench_png), size: fs.statSync(pred.visual_baseline.workbench_png).size },
    { path: pred.visual_baseline.workflow_html, sha256: sha256File(pred.visual_baseline.workflow_html), size: fs.statSync(pred.visual_baseline.workflow_html).size },
  ];
  const taskCard = 'docs/agent-coordination/v5.0.0/tasks/XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003.md';
  const governanceInputs = [
    { id: 'task_card', ...entry(path.join(ROOT, taskCard)) },
    { id: 'benchmark_manifest', ...entry(PRED_MANIFEST) },
    { id: 'predecessor_report', ...entry(path.join(ROOT, 'qa/agent-reviews/XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002.md')) },
    { id: 'protected_manifest_002', ...entry(path.join(ROOT, 'docs/agent-coordination/v5.0.0/tasks/XJ-5.0.0-ui-language-migration-22routes-current-baseline-rebind-002.protected.json')) },
  ];
  const checkpointArtifacts = [
    entry(path.join(SCRATCH_003, 'CHECKPOINT-A.json')),
    entry(path.join(SCRATCH_003, 'CHECKPOINT-B-defect.json')),
    entry(path.join(SCRATCH_003, 'CHECKPOINT-B-old-verifier-output.txt')),
  ];

  const manifest = {
    task_id: TASK_003,
    config_evidence_id: 'ui-language-migration-22routes-evidence-freeze-verifier-rework-v3',
    contract_id: 'XJ-5.0.0-UI-LANGUAGE-MIGRATION-EVIDENCE-FREEZE-V3',
    write_lock_id: 'lock-XJ-5.0.0-ui-language-migration-22routes-evidence-freeze-verifier-rework-003',
    generated_at: new Date().toISOString(),
    base_commit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
    branch: 'release/3.6.3-mac',
    active_release_train: '5.0.0/release-ready/rt-5.0.0-0003',
    predecessor_task_id: TASK_002,
    predecessor_benchmark_manifest_sha256: sha256File(PRED_MANIFEST),
    notes: [
      'Every artifact below is byte-bound by SHA-256; post-freeze drift fails closed in scripts/ui-language-migration-22routes-verifier.js (v2).',
      'Excluded by design: LEASE.json, the delivery report, this manifest, manifest-sha256.pin, and post-freeze mutable working files (command ledger, expected-red outputs).',
      'The three task-002 evidence JSONs are known-stale against the task-002 manifest (P1 false-green fixed here); this successor manifest binds the successor evidence bundle in qa/task-scratch/<task-003>/evidence.',
    ],
    evidence_dir_closed: true,
    closed_dirs: [rel(EVIDENCE_003)],
    ui_sources: uiSources,
    protected_files: protectedFiles,
    harness_scripts: harnessScripts,
    successor_harness_shims: shims,
    verifier_tooling: tooling,
    evidence_files: evidenceFiles,
    screenshots: {
      declared_count: shotFiles.length,
      aggregate_algorithm: 'sha256(sorted path\\0sha256\\0size\\n)',
      aggregate_sha256: aggregate,
      files: shotFiles,
    },
    visual_inputs: visualInputs,
    governance_inputs: governanceInputs,
    checkpoint_artifacts: checkpointArtifacts,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  console.log('MANIFEST-WRITTEN ' + rel(MANIFEST));
  console.log('manifest_sha256 ' + sha256File(MANIFEST));
  console.log('sections: ui_sources=' + uiSources.length + ' protected=' + protectedFiles.length + ' harness=' + harnessScripts.length + ' shims=' + shims.length + ' tooling=' + tooling.length + ' evidence=' + evidenceFiles.length + ' screenshots=' + shotFiles.length + ' visual=' + visualInputs.length + ' governance=' + governanceInputs.length + ' checkpoint=' + checkpointArtifacts.length);
}

function pin() {
  const sha = sha256File(MANIFEST);
  fs.writeFileSync(PIN, sha + '\n');
  console.log('PIN-WRITTEN ' + rel(PIN) + ' ' + sha);
}

function bundleHash(label) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const all = [].concat(
    manifest.ui_sources.map(f => [f.path, f.final_sha256]),
    manifest.protected_files.map(f => [f.path, f.sha256]),
    manifest.harness_scripts.map(f => [f.path, f.sha256]),
    manifest.successor_harness_shims.map(f => [f.path, f.sha256]),
    manifest.verifier_tooling.map(f => [f.path, f.sha256]),
    manifest.evidence_files.map(f => [f.path, f.sha256]),
    manifest.screenshots.files.map(f => [f.path, f.sha256]),
    manifest.visual_inputs.map(f => [f.path, f.sha256]),
    manifest.governance_inputs.map(f => [f.path, f.sha256]),
    manifest.checkpoint_artifacts.map(f => [f.path, f.sha256]),
  );
  let drifted = [];
  for (const [p, expected] of all) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    const actual = fs.existsSync(abs) ? sha256File(abs) : 'MISSING';
    if (actual !== String(expected).toUpperCase()) drifted.push({ path: p, expected, actual });
  }
  const lines = all.map(([p, s]) => p + '\u0000' + String(s).toUpperCase()).sort();
  const agg = sha256Buf(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  console.log('BUNDLE-HASH ' + agg + ' artifacts=' + all.length + ' drifted=' + drifted.length + (label ? ' label=' + label : ''));
  for (const d of drifted) console.log('DRIFT', d.path, d.actual);
  return drifted.length === 0;
}

/* ---- expected-reds: five real-disk attacks, each must be rejected ---- */
function expectedReds() {
  const manifestShaOriginal = sha256File(MANIFEST);
  const pinOriginal = fs.existsSync(PIN) ? fs.readFileSync(PIN) : null;
  const evidenceTarget = path.join(EVIDENCE_003, 'route-matrix-result.json');
  const evidenceOriginal = fs.readFileSync(evidenceTarget);
  const manifestOriginal = fs.readFileSync(MANIFEST);
  const manifestObj = JSON.parse(manifestOriginal.toString('utf8'));
  const shotEntry = manifestObj.screenshots.files[0];
  const shotTarget = path.join(ROOT, shotEntry.path);
  const shotOriginal = fs.readFileSync(shotTarget);
  const uiEntry = manifestObj.ui_sources[0];
  const ledger = [];

  function attack(id, mutate, restore) {
    const before = { evidence: sha256Buf(evidenceOriginal), shot: sha256Buf(shotOriginal), manifest: sha256Buf(manifestOriginal) };
    let observed = { status: null, tail: '' };
    let restored = false;
    const after = {};
    try {
      mutate();
      const r = runVerifier([]);
      observed = { status: r.status, tail: (r.stdout + r.stderr).split('\n').filter(l => l.trim()).slice(-8).join(' | ') };
    } finally {
      restore();
      after.evidence = sha256File(evidenceTarget);
      after.shot = sha256File(shotTarget);
      after.manifest = sha256File(MANIFEST);
      restored = before.evidence === after.evidence && before.shot === after.shot && before.manifest === after.manifest;
      if (pinOriginal) {
        const pinNow = fs.existsSync(PIN) ? fs.readFileSync(PIN) : null;
        if (!pinNow || !pinNow.equals(pinOriginal)) { fs.writeFileSync(PIN, pinOriginal); after.pin_restored = true; }
      }
    }
    const killed = observed.status !== null && observed.status !== 0;
    ledger.push({ id, killed, verifier_exit: observed.status, restored_bytes: restored, sha_before: before, sha_after: after, verifier_tail: observed.tail });
    console.log((killed && restored ? 'RED-OK ' : 'RED-BAD ') + id + ' exit=' + observed.status + ' restored=' + restored);
  }

  /* R1: one-byte mutation of a JSON evidence file */
  attack('R1-json-evidence-byte-mutation', () => {
    const b = Buffer.from(evidenceOriginal);
    b[Math.floor(b.length / 2)] = b[Math.floor(b.length / 2)] ^ 0x01;
    fs.writeFileSync(evidenceTarget, b);
  }, () => { fs.writeFileSync(evidenceTarget, evidenceOriginal); });

  /* R2: one-byte mutation of one matrix screenshot */
  attack('R2-screenshot-byte-mutation', () => {
    const b = Buffer.from(shotOriginal);
    b[100] = b[100] ^ 0x01; /* inside PNG data area */
    fs.writeFileSync(shotTarget, b);
  }, () => { fs.writeFileSync(shotTarget, shotOriginal); });

  /* R3: manifest evidence-file list deletion / count-only substitution */
  attack('R3-manifest-evidence-list-removed-count-only', () => {
    const m = JSON.parse(manifestOriginal.toString('utf8'));
    m.evidence_file_count = (m.evidence_files || []).length;
    delete m.evidence_files;
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n');
  }, () => { fs.writeFileSync(MANIFEST, manifestOriginal); });

  /* R4: UI-source SHA substitution in the manifest */
  attack('R4-ui-source-sha-substitution', () => {
    const m = JSON.parse(manifestOriginal.toString('utf8'));
    m.ui_sources[0] = { ...m.ui_sources[0], final_sha256: m.ui_sources[1].final_sha256 };
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n');
  }, () => { fs.writeFileSync(MANIFEST, manifestOriginal); });

  /* R5: post-freeze added artifact inside the closed evidence directory */
  const rogue = path.join(EVIDENCE_003, 'rogue-post-freeze-artifact.json');
  attack('R5-post-freeze-added-artifact', () => {
    fs.writeFileSync(rogue, JSON.stringify({ rogue: true }) + '\n');
  }, () => { fs.rmSync(rogue, { force: true }); });

  /* final: verifier must PASS after full restoration */
  const finalRun = runVerifier([]);
  const finalPass = finalRun.status === 0;
  console.log((finalPass ? 'RESTORED-PASS ' : 'RESTORED-FAIL ') + 'verifier exit=' + finalRun.status);
  const out = {
    manifest_sha256_before: manifestShaOriginal,
    manifest_sha256_final: sha256File(MANIFEST),
    pin_sha256_before: pinOriginal ? sha256Buf(pinOriginal) : null,
    pin_sha256_final: fs.existsSync(PIN) ? sha256Buf(fs.readFileSync(PIN)) : null,
    ledger,
    final_verifier_exit: finalRun.status,
    final_verifier_pass: finalPass,
  };
  fs.writeFileSync(path.join(SCRATCH_003, 'expected-reds-result.json'), JSON.stringify(out, null, 1) + '\n');
  if (!ledger.every(l => l.killed && l.restored_bytes) || !finalPass) process.exit(2);
}

const cmd = process.argv[2];
if (cmd === 'build-manifest') buildManifest();
else if (cmd === 'pin') pin();
else if (cmd === 'bundle-hash') { if (!bundleHash(process.argv[3])) process.exit(2); }
else if (cmd === 'expected-reds') expectedReds();
else { console.error('usage: build-manifest | pin | bundle-hash [label] | expected-reds'); process.exit(1); }
