'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  SCRIPT_DIR,
  SCRATCH_ROOT,
  parseArgs,
  readJson,
  writeJson,
  digest,
  exactKeys,
  isContained,
  loadFixture,
  SELF_NAMES,
  MODES
} = require('./common-033');

const VERIFIER_PATH = path.join(SCRIPT_DIR, 'strict-verifier-033.js');

class Audit {
  constructor() {
    this.errors = [];
  }

  error(message) {
    this.errors.push(String(message));
  }

  require(condition, message) {
    if (!condition) this.error(message);
  }

  json(filePath, label) {
    try {
      return readJson(filePath);
    } catch (error) {
      this.error(`${label}: invalid JSON`);
      return null;
    }
  }

  digest(filePath, sha256, bytes, label) {
    try {
      const actual = digest(filePath);
      this.require(actual.sha256 === sha256, `${label}: SHA mismatch`);
      this.require(actual.bytes === bytes, `${label}: byte mismatch`);
    } catch (error) {
      this.error(`${label}: unreadable`);
    }
  }
}

function inspectPhase(audit, phase, index, manifest, fixture) {
  const label = `phase[${index}]`;
  audit.require(phase && typeof phase === 'object' && !Array.isArray(phase), `${label}: record missing`);
  if (!phase || typeof phase !== 'object') return;
  const stage = fixture.stages.find((entry) => entry.id === phase.stageId);
  audit.require(Boolean(stage), `${label}: stage not in fixture`);
  audit.require(MODES.includes(phase.mode), `${label}: mode invalid`);
  audit.require(phase.runId === manifest.runId && phase.nonce === manifest.nonce, `${label}: run binding mismatch`);
  for (const field of ['phaseJsonPath', 'stdoutPath', 'stderrPath', 'rawPath']) {
    audit.require(isContained(manifest.evidenceRoot, phase[field]), `${label}.${field}: containment mismatch`);
  }
  audit.digest(phase.phaseJsonPath, phase.phaseSha256, phase.phaseBytes, `${label}.phase`);
  audit.digest(phase.stdoutPath, phase.stdoutSha256, phase.stdoutBytes, `${label}.stdout`);
  audit.digest(phase.stderrPath, phase.stderrSha256, phase.stderrBytes, `${label}.stderr`);
  audit.digest(phase.rawPath, phase.rawSha256, phase.rawBytes, `${label}.raw`);
  const phaseJson = audit.json(phase.phaseJsonPath, `${label}.phaseJson`);
  const raw = audit.json(phase.rawPath, `${label}.raw`);
  audit.require(phaseJson && phaseJson.phaseId === phase.phaseId && phaseJson.exitCode === phase.exitCode, `${label}: phase JSON binding mismatch`);
  audit.require(raw && raw.phaseId === phase.phaseId && raw.runId === phase.runId && raw.nonce === phase.nonce, `${label}: raw binding mismatch`);
  try {
    audit.require(fs.readFileSync(phase.stdoutPath, 'utf8') === `${JSON.stringify(raw)}\n`, `${label}: stdout/raw byte binding mismatch`);
  } catch (error) {
    audit.error(`${label}: stdout read failed`);
  }
}

function inspectSelf(audit, record, index, manifest) {
  const label = `self[${index}]`;
  audit.require(record && typeof record === 'object' && !Array.isArray(record), `${label}: record missing`);
  if (!record || typeof record !== 'object') return;
  audit.require(SELF_NAMES.includes(record.name), `${label}: unexpected name`);
  audit.require(record.runId === manifest.runId && record.nonce === manifest.nonce, `${label}: run binding mismatch`);
  for (const field of ['stdoutPath', 'stderrPath', 'metaPath']) audit.require(isContained(manifest.evidenceRoot, record[field]), `${label}.${field}: containment mismatch`);
  audit.digest(record.stdoutPath, record.stdoutSha256, record.stdoutBytes, `${label}.stdout`);
  audit.digest(record.stderrPath, record.stderrSha256, record.stderrBytes, `${label}.stderr`);
  audit.digest(record.metaPath, record.metaSha256, record.metaBytes, `${label}.meta`);
  const meta = audit.json(record.metaPath, `${label}.meta`);
  audit.require(meta && meta.name === record.name && meta.stdoutPath === record.stdoutPath && meta.stderrPath === record.stderrPath && meta.exitCode === 0, `${label}: meta binding mismatch`);
  try {
    audit.require(fs.readFileSync(record.stderrPath, 'utf8').length === 0, `${label}: stderr is not empty`);
    audit.require(fs.readFileSync(record.stdoutPath, 'utf8').trim().length > 0, `${label}: stdout is empty`);
  } catch (error) {
    audit.error(`${label}: raw output read failed`);
  }
}

function inspectLedgerSnapshot(audit, snapshot, entryIndex, variant, manifest) {
  const label = `ledger[${entryIndex}].${variant}`;
  audit.require(snapshot && typeof snapshot === 'object', `${label}: snapshot missing`);
  if (!snapshot || typeof snapshot !== 'object') return;
  const root = path.dirname(snapshot.manifestPath || '');
  audit.require(isContained(manifest.evidenceRoot, root), `${label}: snapshot root escapes evidence root`);
  audit.require(snapshot.variant === variant, `${label}: variant mismatch`);
  audit.digest(snapshot.manifestPath, snapshot.manifestSha256, snapshot.manifestBytes, `${label}.manifest`);
  const verification = snapshot.verification;
  audit.require(verification && verification.runId === snapshot.runId && verification.nonce === snapshot.nonce, `${label}: verification run binding mismatch`);
  if (verification) {
    audit.digest(verification.stdoutPath, verification.stdoutSha256, verification.stdoutBytes, `${label}.verify.stdout`);
    audit.digest(verification.stderrPath, verification.stderrSha256, verification.stderrBytes, `${label}.verify.stderr`);
    audit.digest(verification.metaPath, verification.metaSha256, verification.metaBytes, `${label}.verify.meta`);
    audit.require(variant === 'mutated' ? verification.exitCode !== 0 : verification.exitCode === 0, `${label}: verification exit contract mismatch`);
    const rerunExit = runStrictVerifier(snapshot.manifestPath);
    audit.require(rerunExit === verification.exitCode, `${label}: independent verifier rerun exit mismatch`);
  }
  audit.require(Array.isArray(snapshot.artifacts), `${label}: artifacts missing`);
  if (Array.isArray(snapshot.artifacts)) {
    audit.require(snapshot.artifacts.length >= 24 * 4 + SELF_NAMES.length * 3, `${label}: artifacts incomplete`);
    snapshot.artifacts.forEach((artifact, artifactIndex) => {
      const artifactLabel = `${label}.artifact[${artifactIndex}]`;
      audit.require(isContained(root, artifact.path), `${artifactLabel}: containment mismatch`);
      if (artifact.present === false) audit.require(variant === 'mutated' && !fs.existsSync(artifact.path), `${artifactLabel}: missing artifact is not a valid mutated absence`);
      else audit.digest(artifact.path, artifact.sha256, artifact.bytes, artifactLabel);
      audit.require(artifact.runId === snapshot.runId && artifact.nonce === snapshot.nonce, `${artifactLabel}: run binding mismatch`);
    });
  }
}

function runStrictVerifier(manifestPath) {
  const result = childProcess.spawnSync(process.execPath, [VERIFIER_PATH, '--manifest', manifestPath], { cwd: path.dirname(manifestPath), encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
  return Number.isInteger(result.status) ? result.status : -1;
}

function latestManifestPath() {
  const markerPath = path.join(SCRATCH_ROOT, 'latest-run.json');
  try {
    const marker = readJson(markerPath);
    if (marker && typeof marker.manifestPath === 'string') return path.resolve(marker.manifestPath);
  } catch (error) {
    // Fall through to the explicit missing-path error below.
  }
  return path.join(SCRATCH_ROOT, 'current-manifest.json');
}

function auditManifest(manifestPath) {
  const audit = new Audit();
  const manifest = audit.json(manifestPath, 'manifest');
  if (!manifest || typeof manifest !== 'object') return { ok: false, audit, manifest: null };
  const fixture = (() => {
    try { return loadFixture(manifest.rulesPath); } catch (error) { audit.error('fixture: invalid'); return null; }
  })();
  audit.require(path.resolve(manifest.evidenceRoot) === path.dirname(manifestPath), 'manifest: evidenceRoot mismatch');
  audit.require(Array.isArray(manifest.phases) && manifest.phases.length === manifest.phaseCount, 'manifest: phase count mismatch');
  if (fixture && Array.isArray(manifest.phases)) manifest.phases.forEach((phase, index) => inspectPhase(audit, phase, index, manifest, fixture));
  audit.require(Array.isArray(manifest.selfTriplets) && manifest.selfTriplets.length === SELF_NAMES.length, 'manifest: self count mismatch');
  if (Array.isArray(manifest.selfTriplets)) manifest.selfTriplets.forEach((record, index) => inspectSelf(audit, record, index, manifest));
  const ledger = audit.json(manifest.mutationLedgerPath, 'ledger');
  let ledgerEntryCount = 0;
  if (ledger && typeof ledger === 'object' && Array.isArray(ledger.entries)) {
    ledgerEntryCount = ledger.entries.length;
    ledger.entries.forEach((entry, index) => {
      inspectLedgerSnapshot(audit, entry.baseline, index, 'baseline', manifest);
      inspectLedgerSnapshot(audit, entry.mutated, index, 'mutated', manifest);
      inspectLedgerSnapshot(audit, entry.restored, index, 'restored', manifest);
      audit.require(entry.verdict === 'KILLED', `ledger[${index}]: verdict mismatch`);
    });
    audit.require(ledger.entries.length >= 14, 'ledger: fewer than fourteen independent mutations');
    audit.require(ledger.capabilityProbe && ledger.capabilityProbe.supported && ledger.capabilityProbe.lstatIsSymbolicLink, 'ledger: real-link capability not proven');
  } else {
    audit.error('ledger: missing entries');
  }
  const strictVerifierExitCode = runStrictVerifier(manifestPath);
  audit.require(strictVerifierExitCode === 0, 'strict verifier did not PASS');
  return { ok: audit.errors.length === 0, audit, manifest, ledgerEntryCount, strictVerifierExitCode };
}

const args = parseArgs(process.argv);

if (args['self-probe']) {
  process.stdout.write(`${JSON.stringify({ ok: true, script: 'audit', helper: 'independent-recompute' })}\n`);
} else {
  try {
    const manifestPath = path.resolve(String(args.manifest || latestManifestPath()));
    const result = auditManifest(manifestPath);
    const manifestInfo = result.manifest ? digest(manifestPath) : { sha256: 'missing', bytes: 0 };
    const report = {
      schemaVersion: 'audit-033-v1',
      manifestPath,
      manifestSha256: manifestInfo.sha256,
      manifestBytes: manifestInfo.bytes,
      runId: result.manifest ? result.manifest.runId : 'unknown-run',
      nonce: result.manifest ? result.manifest.nonce : 'unknown-nonce',
      phaseCount: result.manifest ? result.manifest.phaseCount : 0,
      selfCount: result.manifest && Array.isArray(result.manifest.selfTriplets) ? result.manifest.selfTriplets.length : 0,
      ledgerEntryCount: result.ledgerEntryCount || 0,
      strictVerifierExitCode: result.strictVerifierExitCode === undefined ? -1 : result.strictVerifierExitCode,
      ok: result.ok,
      checkedUtc: new Date().toISOString()
    };
    writeJson(result.manifest ? result.manifest.auditPath : path.join(path.dirname(manifestPath), 'audit.json'), report);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, manifestPath, phaseCount: report.phaseCount, ledgerEntryCount: report.ledgerEntryCount, strictVerifierExitCode: report.strictVerifierExitCode })}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

module.exports = { auditManifest };
