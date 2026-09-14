'use strict';

const fs = require('fs');
const path = require('path');
const {
  MODES,
  SELF_NAMES,
  SCRIPT_DIR,
  PROJECT_ROOT,
  SCRATCH_ROOT,
  WRAPPER_PATH,
  parseArgs,
  readJson,
  exactKeys,
  isContained,
  hasParentSegment,
  hasLegacyFragment,
  isCanonicalAbsolute,
  isIsoUtc,
  timeOrder,
  linkSegments,
  digest,
  loadFixture,
  productionPaths
} = require('./common-033');

const RUNNER_PATH = path.join(SCRIPT_DIR, 'runner-033.js');
const SOURCE_AUDIT_PATH = path.join(SCRIPT_DIR, 'source-audit-033.js');
const LEDGER_PATH = path.join(SCRIPT_DIR, 'mutation-ledger-033.js');
const AUDIT_PATH = path.join(SCRIPT_DIR, 'audit-033.js');
const WORKER_PATH = path.join(SCRIPT_DIR, 'phase-worker-033.js');
const VERIFIER_PATH = path.join(SCRIPT_DIR, 'strict-verifier-033.js');

class Checker {
  constructor() {
    this.errors = [];
  }

  error(message) {
    this.errors.push(String(message));
  }

  require(condition, message) {
    if (!condition) this.error(message);
    return Boolean(condition);
  }

  exact(value, keys, label) {
    this.require(exactKeys(value, keys), `${label}: unknown or missing fields`);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  string(value, label) {
    return this.require(typeof value === 'string' && value.trim().length > 0, `${label}: non-empty string required`);
  }

  integer(value, label) {
    return this.require(Number.isInteger(value) && value >= 0, `${label}: non-negative integer required`);
  }

  bool(value, label) {
    return this.require(typeof value === 'boolean', `${label}: boolean required`);
  }

  array(value, label) {
    return this.require(Array.isArray(value), `${label}: array required`);
  }

  time(startUtc, endUtc, label) {
    this.require(timeOrder(startUtc, endUtc), `${label}: invalid or reversed time range`);
  }

  path(value, root, label, options = {}) {
    const valid = this.string(value, label) && isCanonicalAbsolute(value) && !hasParentSegment(value) && !hasLegacyFragment(value);
    this.require(valid, `${label}: unsafe absolute path`);
    const resolved = path.resolve(String(value));
    if (options.contained !== false) this.require(isContained(root, resolved), `${label}: containment violation`);
    if (options.mustExist !== false && valid && isContained(root, resolved)) {
      try {
        const stat = fs.lstatSync(resolved);
        this.require(options.regular === false || stat.isFile(), `${label}: regular file required`);
        const links = linkSegments(resolved);
        this.require(options.allowLink === true || links.length === 0, `${label}: symbolic link or junction path segment detected`);
      } catch (error) {
        this.error(`${label}: missing or unreadable path`);
      }
    }
    return resolved;
  }

  digestFile(filePath, expectedSha, expectedBytes, label) {
    try {
      const actual = digest(filePath);
      this.require(actual.sha256 === expectedSha, `${label}: SHA-256 mismatch`);
      this.require(actual.bytes === expectedBytes, `${label}: byte count mismatch`);
    } catch (error) {
      this.error(`${label}: digest read failed`);
    }
  }

  json(filePath, label) {
    try {
      return readJson(filePath);
    } catch (error) {
      this.error(`${label}: invalid JSON`);
      return null;
    }
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedSelfTarget(name) {
  const targets = {
    runner: RUNNER_PATH,
    'source-audit': SOURCE_AUDIT_PATH,
    verifier: path.join(SCRIPT_DIR, 'strict-verifier-033.js'),
    'expected-red': LEDGER_PATH,
    audit: AUDIT_PATH
  };
  return targets[name];
}

function checkWrapperMeta(checker, metaPath, record, root, label) {
  const meta = checker.json(metaPath, `${label}.meta`);
  const metaKeys = ['schemaVersion', 'name', 'wrapperPath', 'targetPath', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'stdoutPath', 'stdoutSha256', 'stdoutBytes', 'stderrPath', 'stderrSha256', 'stderrBytes'];
  if (!checker.exact(meta, metaKeys, `${label}.meta`)) return;
  checker.require(meta.schemaVersion === 'wrapper-meta-033-v1', `${label}.meta.schemaVersion invalid`);
  checker.require(meta.name === record.name, `${label}.meta.name mismatch`);
  checker.require(meta.wrapperPath === WRAPPER_PATH, `${label}.meta.wrapperPath mismatch`);
  checker.require(meta.targetPath === record.targetPath, `${label}.meta.targetPath mismatch`);
  checker.string(meta.command, `${label}.meta.command`);
  checker.array(meta.argv, `${label}.meta.argv`);
  if (Array.isArray(meta.argv)) meta.argv.forEach((entry, index) => checker.string(entry, `${label}.meta.argv[${index}]`));
  checker.require(meta.command === record.command, `${label}.meta.command mismatch`);
  checker.require(sameJson(meta.argv, record.argv), `${label}.meta.argv mismatch`);
  checker.require(meta.cwd === root, `${label}.meta.cwd mismatch`);
  checker.time(meta.startUtc, meta.endUtc, `${label}.meta`);
  checker.require(meta.exitCode === record.exitCode, `${label}.meta.exitCode mismatch`);
  checker.require(meta.runId === record.runId, `${label}.meta.runId mismatch`);
  checker.require(meta.nonce === record.nonce, `${label}.meta.nonce mismatch`);
  checker.require(meta.stdoutPath === record.stdoutPath, `${label}.meta.stdoutPath mismatch`);
  checker.require(meta.stderrPath === record.stderrPath, `${label}.meta.stderrPath mismatch`);
  checker.require(meta.stdoutSha256 === record.stdoutSha256, `${label}.meta.stdoutSha256 mismatch`);
  checker.require(meta.stdoutBytes === record.stdoutBytes, `${label}.meta.stdoutBytes mismatch`);
  checker.require(meta.stderrSha256 === record.stderrSha256, `${label}.meta.stderrSha256 mismatch`);
  checker.require(meta.stderrBytes === record.stderrBytes, `${label}.meta.stderrBytes mismatch`);
}

function checkPhase(checker, phase, index, fixture, manifest) {
  const label = `phase[${index}]`;
  const keys = ['phaseId', 'stageId', 'mode', 'phaseJsonPath', 'stdoutPath', 'stderrPath', 'rawPath', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'phaseSha256', 'phaseBytes', 'stdoutSha256', 'stdoutBytes', 'stderrSha256', 'stderrBytes', 'rawSha256', 'rawBytes'];
  if (!checker.exact(phase, keys, label)) return;
  checker.string(phase.phaseId, `${label}.phaseId`);
  checker.string(phase.stageId, `${label}.stageId`);
  checker.require(MODES.includes(phase.mode), `${label}.mode invalid`);
  const stage = fixture.stages.find((entry) => entry.id === phase.stageId);
  checker.require(Boolean(stage), `${label}.stageId not in fixture`);
  const expectedPhaseId = `${phase.stageId}-${phase.mode}`;
  checker.require(phase.phaseId === expectedPhaseId, `${label}.phaseId mismatch`);
  checker.path(phase.phaseJsonPath, manifest.evidenceRoot, `${label}.phaseJsonPath`);
  checker.path(phase.stdoutPath, manifest.evidenceRoot, `${label}.stdoutPath`);
  checker.path(phase.stderrPath, manifest.evidenceRoot, `${label}.stderrPath`);
  checker.path(phase.rawPath, manifest.evidenceRoot, `${label}.rawPath`);
  checker.string(phase.command, `${label}.command`);
  checker.array(phase.argv, `${label}.argv`);
  if (Array.isArray(phase.argv)) phase.argv.forEach((entry, itemIndex) => checker.string(entry, `${label}.argv[${itemIndex}]`));
  checker.require(phase.argv && phase.argv[0] === WORKER_PATH, `${label}.argv target mismatch`);
  checker.require(phase.cwd === manifest.evidenceRoot, `${label}.cwd mismatch`);
  checker.time(phase.startUtc, phase.endUtc, label);
  checker.require(phase.exitCode === (phase.mode === 'mutated' ? 7 : 0), `${label}.exitCode unexpected`);
  checker.require(phase.runId === manifest.runId, `${label}.runId mismatch`);
  checker.require(phase.nonce === manifest.nonce, `${label}.nonce mismatch`);
  checker.integer(phase.phaseBytes, `${label}.phaseBytes`);
  checker.integer(phase.stdoutBytes, `${label}.stdoutBytes`);
  checker.integer(phase.stderrBytes, `${label}.stderrBytes`);
  checker.integer(phase.rawBytes, `${label}.rawBytes`);
  checker.string(phase.phaseSha256, `${label}.phaseSha256`);
  checker.string(phase.stdoutSha256, `${label}.stdoutSha256`);
  checker.string(phase.stderrSha256, `${label}.stderrSha256`);
  checker.string(phase.rawSha256, `${label}.rawSha256`);
  checker.digestFile(phase.phaseJsonPath, phase.phaseSha256, phase.phaseBytes, `${label}.phase`);
  checker.digestFile(phase.stdoutPath, phase.stdoutSha256, phase.stdoutBytes, `${label}.stdout`);
  checker.digestFile(phase.stderrPath, phase.stderrSha256, phase.stderrBytes, `${label}.stderr`);
  checker.digestFile(phase.rawPath, phase.rawSha256, phase.rawBytes, `${label}.raw`);

  const phaseJson = checker.json(phase.phaseJsonPath, `${label}.phaseJson`);
  const phaseKeys = ['schemaVersion', 'phaseId', 'stageId', 'mode', 'runId', 'nonce', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'rawSchemaVersion'];
  if (checker.exact(phaseJson, phaseKeys, `${label}.phaseJson`)) {
    checker.require(phaseJson.schemaVersion === 'phase-json-033-v1', `${label}.phaseJson.schemaVersion invalid`);
    checker.require(phaseJson.phaseId === phase.phaseId && phaseJson.stageId === phase.stageId && phaseJson.mode === phase.mode, `${label}.phaseJson identity mismatch`);
    checker.require(phaseJson.runId === phase.runId && phaseJson.nonce === phase.nonce, `${label}.phaseJson run binding mismatch`);
    checker.require(phaseJson.command === phase.command, `${label}.phaseJson.command mismatch`);
    checker.require(sameJson(phaseJson.argv, phase.argv), `${label}.phaseJson.argv mismatch`);
    checker.require(phaseJson.cwd === phase.cwd, `${label}.phaseJson.cwd mismatch`);
    checker.time(phaseJson.startUtc, phaseJson.endUtc, `${label}.phaseJson`);
    checker.require(phaseJson.exitCode === phase.exitCode, `${label}.phaseJson.exitCode mismatch`);
    checker.require(phaseJson.rawSchemaVersion === 'phase-raw-033-v1', `${label}.phaseJson.rawSchemaVersion invalid`);
    checker.array(phaseJson.argv, `${label}.phaseJson.argv`);
    checker.string(phaseJson.command, `${label}.phaseJson.command`);
    checker.string(phaseJson.cwd, `${label}.phaseJson.cwd`);
  }

  const raw = checker.json(phase.rawPath, `${label}.raw`);
  const rawKeys = ['schemaVersion', 'phaseId', 'stageId', 'mode', 'runId', 'nonce', 'ok', 'payload'];
  if (checker.exact(raw, rawKeys, `${label}.raw`)) {
    checker.require(raw.schemaVersion === 'phase-raw-033-v1', `${label}.raw.schemaVersion invalid`);
    checker.require(raw.phaseId === phase.phaseId && raw.stageId === phase.stageId && raw.mode === phase.mode, `${label}.raw identity mismatch`);
    checker.require(raw.runId === phase.runId && raw.nonce === phase.nonce, `${label}.raw run binding mismatch`);
    checker.bool(raw.ok, `${label}.raw.ok`);
    checker.require(raw.ok === (phase.mode !== 'mutated'), `${label}.raw.ok unexpected`);
    if (stage) {
      const expectedPayload = stage.shape === 'nested'
        ? { nested: { signal: stage.signal, marker: 'independent' } }
        : { signal: stage.signal, marker: 'independent' };
      checker.require(sameJson(raw.payload, expectedPayload), `${label}.raw.payload shape mismatch`);
    }
    try {
      const stdoutText = fs.readFileSync(phase.stdoutPath, 'utf8');
      checker.require(stdoutText === `${JSON.stringify(raw)}\n`, `${label}.stdout does not bind raw bytes`);
    } catch (error) {
      checker.error(`${label}.stdout cannot be read`);
    }
    try {
      const stderrText = fs.readFileSync(phase.stderrPath, 'utf8');
      if (phase.mode === 'mutated') checker.require(stderrText.length > 0, `${label}.mutated stderr is empty`);
      if (phase.mode !== 'mutated') checker.require(stderrText.length === 0, `${label}.baseline/restored stderr is non-empty`);
    } catch (error) {
      checker.error(`${label}.stderr cannot be read`);
    }
  }
}

function checkSelf(checker, record, index, manifest) {
  const label = `selfTriplet[${index}]`;
  const keys = ['name', 'wrapperPath', 'targetPath', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'stdoutPath', 'stdoutSha256', 'stdoutBytes', 'stderrPath', 'stderrSha256', 'stderrBytes', 'metaPath', 'metaSha256', 'metaBytes'];
  if (!checker.exact(record, keys, label)) return;
  checker.require(SELF_NAMES.includes(record.name), `${label}.name invalid`);
  checker.path(record.wrapperPath, PROJECT_ROOT, `${label}.wrapperPath`, { mustExist: true });
  checker.require(record.wrapperPath === WRAPPER_PATH, `${label}.wrapperPath mismatch`);
  checker.path(record.targetPath, SCRIPT_DIR, `${label}.targetPath`, { mustExist: true });
  checker.require(record.targetPath === expectedSelfTarget(record.name), `${label}.targetPath mismatch`);
  checker.string(record.command, `${label}.command`);
  checker.array(record.argv, `${label}.argv`);
  if (Array.isArray(record.argv)) record.argv.forEach((entry, itemIndex) => checker.string(entry, `${label}.argv[${itemIndex}]`));
  checker.require(record.argv && record.argv[0] === record.targetPath, `${label}.argv target mismatch`);
  checker.require(record.cwd === manifest.evidenceRoot, `${label}.cwd mismatch`);
  checker.time(record.startUtc, record.endUtc, label);
  checker.require(record.exitCode === 0, `${label}.exitCode must be zero`);
  checker.require(record.runId === manifest.runId && record.nonce === manifest.nonce, `${label}.run binding mismatch`);
  checker.path(record.stdoutPath, manifest.evidenceRoot, `${label}.stdoutPath`);
  checker.path(record.stderrPath, manifest.evidenceRoot, `${label}.stderrPath`);
  checker.path(record.metaPath, manifest.evidenceRoot, `${label}.metaPath`);
  checker.integer(record.stdoutBytes, `${label}.stdoutBytes`);
  checker.integer(record.stderrBytes, `${label}.stderrBytes`);
  checker.integer(record.metaBytes, `${label}.metaBytes`);
  checker.string(record.stdoutSha256, `${label}.stdoutSha256`);
  checker.string(record.stderrSha256, `${label}.stderrSha256`);
  checker.string(record.metaSha256, `${label}.metaSha256`);
  checker.digestFile(record.stdoutPath, record.stdoutSha256, record.stdoutBytes, `${label}.stdout`);
  checker.digestFile(record.stderrPath, record.stderrSha256, record.stderrBytes, `${label}.stderr`);
  checker.digestFile(record.metaPath, record.metaSha256, record.metaBytes, `${label}.meta`);
  checkWrapperMeta(checker, record.metaPath, record, manifest.evidenceRoot, label);
  try {
    const stdoutText = fs.readFileSync(record.stdoutPath, 'utf8');
    checker.require(stdoutText.trim().length > 0, `${label}.stdout must not be empty`);
    JSON.parse(stdoutText);
  } catch (error) {
    checker.error(`${label}.stdout must contain valid JSON`);
  }
  try {
    const stderrText = fs.readFileSync(record.stderrPath, 'utf8');
    checker.require(stderrText.length === 0, `${label}.stderr must be empty for a successful self probe`);
  } catch (error) {
    checker.error(`${label}.stderr read failed`);
  }
}

function checkPathSelf(checker, manifest, fixture) {
  const report = checker.json(manifest.pathSelfCheckPath, 'pathSelfCheck');
  const keys = ['schemaVersion', 'scratchRoot', 'runRoot', 'fixturePath', 'outputPath', 'scratchContained', 'outputContained', 'legacyFragmentsRejected', 'fixtureId', 'stageCount', 'mutationCount', 'checkedUtc'];
  if (!checker.exact(report, keys, 'pathSelfCheck')) return;
  checker.require(report.schemaVersion === 'path-self-check-033-v1', 'pathSelfCheck.schemaVersion invalid');
  checker.require(report.scratchRoot === SCRATCH_ROOT, 'pathSelfCheck.scratchRoot mismatch');
  checker.require(report.runRoot === manifest.evidenceRoot, 'pathSelfCheck.runRoot mismatch');
  checker.require(report.fixturePath === manifest.rulesPath, 'pathSelfCheck.fixturePath mismatch');
  checker.require(report.outputPath === manifest.pathSelfCheckPath, 'pathSelfCheck.outputPath mismatch');
  checker.bool(report.scratchContained, 'pathSelfCheck.scratchContained');
  checker.bool(report.outputContained, 'pathSelfCheck.outputContained');
  checker.require(report.legacyFragmentsRejected === true, 'pathSelfCheck legacy gate missing');
  checker.string(report.fixtureId, 'pathSelfCheck.fixtureId');
  checker.require(report.stageCount === fixture.stages.length, 'pathSelfCheck.stageCount invalid');
  checker.integer(report.mutationCount, 'pathSelfCheck.mutationCount');
  checker.require(report.mutationCount === fixture.mutations.length, 'pathSelfCheck.mutationCount invalid');
  checker.require(isIsoUtc(report.checkedUtc), 'pathSelfCheck.checkedUtc invalid');
}

function checkProduction(checker, value) {
  if (!checker.exact(value, ['files'], 'productionBaseline')) return;
  checker.array(value.files, 'productionBaseline.files');
  const expected = productionPaths();
  checker.require(value.files.length === expected.length, 'productionBaseline file count mismatch');
  if (Array.isArray(value.files)) {
    value.files.forEach((entry, index) => {
      const label = `productionBaseline.files[${index}]`;
      if (!checker.exact(entry, ['path', 'sha256', 'bytes'], label)) return;
      checker.require(entry.path === expected[index], `${label}.path mismatch`);
      checker.path(entry.path, PROJECT_ROOT, `${label}.path`, { contained: false, mustExist: true });
      checker.string(entry.sha256, `${label}.sha256`);
      checker.integer(entry.bytes, `${label}.bytes`);
      checker.digestFile(entry.path, entry.sha256, entry.bytes, label);
    });
  }
}

function checkVerification(checker, verification, snapshotRoot, label, expectedVariant) {
  const keys = ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'stdoutPath', 'stdoutSha256', 'stdoutBytes', 'stderrPath', 'stderrSha256', 'stderrBytes', 'metaPath', 'metaSha256', 'metaBytes'];
  if (!checker.exact(verification, keys, label)) return;
  checker.string(verification.command, `${label}.command`);
  checker.array(verification.argv, `${label}.argv`);
  if (Array.isArray(verification.argv)) verification.argv.forEach((entry, index) => checker.string(entry, `${label}.argv[${index}]`));
  checker.require(verification.cwd === snapshotRoot, `${label}.cwd mismatch`);
  checker.time(verification.startUtc, verification.endUtc, label);
  checker.require(expectedVariant === 'mutated' ? verification.exitCode !== 0 : verification.exitCode === 0, `${label}.exitCode unexpected`);
  checker.string(verification.runId, `${label}.runId`);
  checker.string(verification.nonce, `${label}.nonce`);
  checker.path(verification.stdoutPath, snapshotRoot, `${label}.stdoutPath`);
  checker.path(verification.stderrPath, snapshotRoot, `${label}.stderrPath`);
  checker.path(verification.metaPath, snapshotRoot, `${label}.metaPath`);
  checker.integer(verification.stdoutBytes, `${label}.stdoutBytes`);
  checker.integer(verification.stderrBytes, `${label}.stderrBytes`);
  checker.integer(verification.metaBytes, `${label}.metaBytes`);
  checker.string(verification.stdoutSha256, `${label}.stdoutSha256`);
  checker.string(verification.stderrSha256, `${label}.stderrSha256`);
  checker.string(verification.metaSha256, `${label}.metaSha256`);
  checker.digestFile(verification.stdoutPath, verification.stdoutSha256, verification.stdoutBytes, `${label}.stdout`);
  checker.digestFile(verification.stderrPath, verification.stderrSha256, verification.stderrBytes, `${label}.stderr`);
  checker.digestFile(verification.metaPath, verification.metaSha256, verification.metaBytes, `${label}.meta`);
  const meta = checker.json(verification.metaPath, `${label}.metaJson`);
  const metaKeys = ['schemaVersion', 'name', 'wrapperPath', 'targetPath', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'stdoutPath', 'stdoutSha256', 'stdoutBytes', 'stderrPath', 'stderrSha256', 'stderrBytes'];
  if (checker.exact(meta, metaKeys, `${label}.metaJson`)) {
    checker.require(meta.schemaVersion === 'wrapper-meta-033-v1', `${label}.metaJson.schemaVersion invalid`);
    checker.require(meta.name === 'verifier', `${label}.metaJson.name invalid`);
    checker.require(meta.wrapperPath === WRAPPER_PATH && meta.targetPath === VERIFIER_PATH, `${label}.metaJson target binding mismatch`);
    checker.require(meta.command === verification.command && sameJson(meta.argv, verification.argv), `${label}.metaJson command binding mismatch`);
    checker.require(meta.cwd === verification.cwd && meta.startUtc === verification.startUtc && meta.endUtc === verification.endUtc, `${label}.metaJson process binding mismatch`);
    checker.require(meta.exitCode === verification.exitCode && meta.runId === verification.runId && meta.nonce === verification.nonce, `${label}.metaJson run binding mismatch`);
    checker.require(meta.stdoutPath === verification.stdoutPath && meta.stdoutSha256 === verification.stdoutSha256 && meta.stdoutBytes === verification.stdoutBytes, `${label}.metaJson stdout binding mismatch`);
    checker.require(meta.stderrPath === verification.stderrPath && meta.stderrSha256 === verification.stderrSha256 && meta.stderrBytes === verification.stderrBytes, `${label}.metaJson stderr binding mismatch`);
  }
}

function checkLedgerArtifact(checker, artifact, index, snapshotRoot, expectedVariant) {
  const label = `ledgerArtifact[${index}]`;
  const keys = ['present', 'kind', 'path', 'sha256', 'bytes', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce'];
  if (!checker.exact(artifact, keys, label)) return;
  checker.bool(artifact.present, `${label}.present`);
  checker.string(artifact.kind, `${label}.kind`);
  checker.path(artifact.path, snapshotRoot, `${label}.path`, { allowLink: expectedVariant === 'mutated', mustExist: artifact.present });
  checker.string(artifact.sha256, `${label}.sha256`);
  checker.integer(artifact.bytes, `${label}.bytes`);
  checker.string(artifact.command, `${label}.command`);
  checker.array(artifact.argv, `${label}.argv`);
  if (Array.isArray(artifact.argv)) artifact.argv.forEach((entry, itemIndex) => checker.string(entry, `${label}.argv[${itemIndex}]`));
  checker.require(artifact.cwd === snapshotRoot, `${label}.cwd mismatch`);
  checker.time(artifact.startUtc, artifact.endUtc, label);
  checker.require(Number.isInteger(artifact.exitCode), `${label}.exitCode must be integer`);
  checker.string(artifact.runId, `${label}.runId`);
  checker.string(artifact.nonce, `${label}.nonce`);
  if (artifact.present) checker.digestFile(artifact.path, artifact.sha256, artifact.bytes, label);
  else {
    checker.require(expectedVariant === 'mutated', `${label}: missing artifact outside mutated variant`);
    checker.require(!fs.existsSync(artifact.path), `${label}: present=false but file exists`);
  }
}

function checkLedgerSnapshot(checker, snapshot, index, manifest, expectedVariant) {
  const label = `ledger.entries[${index}].${expectedVariant}`;
  const keys = ['variant', 'manifestPath', 'manifestSha256', 'manifestBytes', 'runId', 'nonce', 'verification', 'artifacts'];
  if (!checker.exact(snapshot, keys, label)) return;
  checker.require(snapshot.variant === expectedVariant, `${label}.variant mismatch`);
  checker.path(snapshot.manifestPath, manifest.evidenceRoot, `${label}.manifestPath`);
  checker.string(snapshot.manifestSha256, `${label}.manifestSha256`);
  checker.integer(snapshot.manifestBytes, `${label}.manifestBytes`);
  checker.string(snapshot.runId, `${label}.runId`);
  checker.string(snapshot.nonce, `${label}.nonce`);
  checker.require(snapshot.runId === manifest.runId && snapshot.nonce === manifest.nonce, `${label}.run binding mismatch`);
  const snapshotRoot = path.dirname(snapshot.manifestPath);
  checker.require(isContained(manifest.evidenceRoot, snapshotRoot), `${label}.snapshotRoot escapes evidenceRoot`);
  checker.digestFile(snapshot.manifestPath, snapshot.manifestSha256, snapshot.manifestBytes, `${label}.manifest`);
  checkVerification(checker, snapshot.verification, snapshotRoot, `${label}.verification`, expectedVariant);
  checker.array(snapshot.artifacts, `${label}.artifacts`);
  if (Array.isArray(snapshot.artifacts)) {
    checker.require(snapshot.artifacts.length >= 24 * 4 + SELF_NAMES.length * 3, `${label}.artifacts incomplete`);
    snapshot.artifacts.forEach((artifact, artifactIndex) => checkLedgerArtifact(checker, artifact, artifactIndex, snapshotRoot, expectedVariant));
  }
}

function checkCapability(checker, capability, index, manifest) {
  const label = `ledger.entries[${index}].capability`;
  const keys = ['required', 'attempted', 'supported', 'linkType', 'probePath', 'targetPath', 'lstatIsSymbolicLink', 'message'];
  if (!checker.exact(capability, keys, label)) return;
  checker.bool(capability.required, `${label}.required`);
  checker.bool(capability.attempted, `${label}.attempted`);
  checker.bool(capability.supported, `${label}.supported`);
  checker.string(capability.linkType, `${label}.linkType`);
  checker.string(capability.probePath, `${label}.probePath`);
  checker.string(capability.targetPath, `${label}.targetPath`);
  checker.bool(capability.lstatIsSymbolicLink, `${label}.lstatIsSymbolicLink`);
  checker.string(capability.message, `${label}.message`);
  if (capability.required) {
    checker.require(capability.attempted && capability.supported && capability.lstatIsSymbolicLink, `${label}: required real-link capability was not proven`);
    checker.path(capability.probePath, manifest.evidenceRoot, `${label}.probePath`, { allowLink: true, regular: false });
    checker.path(capability.targetPath, manifest.evidenceRoot, `${label}.targetPath`, { regular: false });
  }
}

function checkLedger(checker, manifest, fixture) {
  const ledger = checker.json(manifest.mutationLedgerPath, 'mutationLedger');
  const topKeys = ['schemaVersion', 'taskId', 'contractId', 'runId', 'nonce', 'entryCount', 'entries', 'capabilityProbe'];
  if (!checker.exact(ledger, topKeys, 'mutationLedger')) return;
  checker.require(ledger.schemaVersion === 'ledger-033-v1', 'mutationLedger.schemaVersion invalid');
  checker.require(ledger.taskId === manifest.taskId && ledger.contractId === manifest.contractId, 'mutationLedger identity mismatch');
  checker.require(ledger.runId === manifest.runId && ledger.nonce === manifest.nonce, 'mutationLedger run binding mismatch');
  checker.integer(ledger.entryCount, 'mutationLedger.entryCount');
  checker.require(ledger.entryCount === fixture.mutations.length, 'mutationLedger.entryCount mismatch');
  checker.array(ledger.entries, 'mutationLedger.entries');
  checker.exact(ledger.capabilityProbe, ['attempted', 'supported', 'linkType', 'probePath', 'targetPath', 'lstatIsSymbolicLink', 'message'], 'mutationLedger.capabilityProbe');
  checker.bool(ledger.capabilityProbe && ledger.capabilityProbe.attempted, 'mutationLedger.capabilityProbe.attempted');
  checker.bool(ledger.capabilityProbe && ledger.capabilityProbe.supported, 'mutationLedger.capabilityProbe.supported');
  checker.require(ledger.capabilityProbe && ledger.capabilityProbe.supported && ledger.capabilityProbe.lstatIsSymbolicLink, 'mutationLedger real-link capability not proven');
  if (ledger.capabilityProbe) {
    checker.string(ledger.capabilityProbe.linkType, 'mutationLedger.capabilityProbe.linkType');
    checker.string(ledger.capabilityProbe.probePath, 'mutationLedger.capabilityProbe.probePath');
    checker.string(ledger.capabilityProbe.targetPath, 'mutationLedger.capabilityProbe.targetPath');
    checker.bool(ledger.capabilityProbe.lstatIsSymbolicLink, 'mutationLedger.capabilityProbe.lstatIsSymbolicLink');
    checker.string(ledger.capabilityProbe.message, 'mutationLedger.capabilityProbe.message');
    checker.path(ledger.capabilityProbe.probePath, manifest.evidenceRoot, 'mutationLedger.capabilityProbe.probePath', { allowLink: true, regular: false });
    checker.path(ledger.capabilityProbe.targetPath, manifest.evidenceRoot, 'mutationLedger.capabilityProbe.targetPath', { regular: false });
  }
  const seen = new Set();
  if (Array.isArray(ledger.entries)) {
    ledger.entries.forEach((entry, index) => {
      const label = `mutationLedger.entries[${index}]`;
      const entryKeys = ['id', 'kind', 'description', 'capability', 'baseline', 'mutated', 'restored', 'verdict', 'uncovered'];
      if (!checker.exact(entry, entryKeys, label)) return;
      checker.string(entry.id, `${label}.id`);
      checker.string(entry.kind, `${label}.kind`);
      checker.string(entry.description, `${label}.description`);
      checker.require(!seen.has(entry.id), `${label}.id duplicate`);
      seen.add(entry.id);
      const rule = fixture.mutations[index];
      if (rule) {
        checker.require(entry.id === rule.id && entry.kind === rule.kind, `${label}.rule mismatch`);
      }
      checkCapability(checker, entry.capability, index, manifest);
      checkLedgerSnapshot(checker, entry.baseline, index, manifest, 'baseline');
      checkLedgerSnapshot(checker, entry.mutated, index, manifest, 'mutated');
      checkLedgerSnapshot(checker, entry.restored, index, manifest, 'restored');
      checker.require(entry.verdict === 'KILLED', `${label}.verdict must be KILLED`);
      checker.array(entry.uncovered, `${label}.uncovered`);
      if (Array.isArray(entry.uncovered)) checker.require(entry.uncovered.length === 0, `${label}.uncovered must be empty`);
      checker.require(entry.baseline && entry.baseline.verification && entry.baseline.verification.exitCode === 0, `${label}.baseline did not PASS`);
      checker.require(entry.mutated && entry.mutated.verification && entry.mutated.verification.exitCode !== 0, `${label}.mutated unexpectedly passed`);
      checker.require(entry.restored && entry.restored.verification && entry.restored.verification.exitCode === 0, `${label}.restored did not PASS`);
    });
  }
  checker.require(seen.size === fixture.mutations.length, 'mutationLedger missing mutation entries');
}

function checkSnapshotLedger(checker, manifest, fixture, manifestPath) {
  const ledger = checker.json(manifest.mutationLedgerPath, 'snapshotLedger');
  const keys = ['schemaVersion', 'taskId', 'contractId', 'runId', 'nonce', 'mutationId', 'variant', 'manifestPath', 'manifestSha256', 'manifestBytes', 'verification'];
  if (!checker.exact(ledger, keys, 'snapshotLedger')) return;
  checker.require(ledger.schemaVersion === 'snapshot-ledger-033-v1', 'snapshotLedger.schemaVersion invalid');
  checker.require(ledger.taskId === manifest.taskId && ledger.contractId === manifest.contractId, 'snapshotLedger identity mismatch');
  checker.require(ledger.runId === manifest.runId && ledger.nonce === manifest.nonce, 'snapshotLedger run binding mismatch');
  checker.require(ledger.mutationId === manifest.mutationId, 'snapshotLedger mutationId mismatch');
  checker.require(ledger.variant === manifest.snapshotVariant, 'snapshotLedger variant mismatch');
  checker.require(ledger.manifestPath === manifestPath, 'snapshotLedger.manifestPath mismatch');
  checker.string(ledger.manifestSha256, 'snapshotLedger.manifestSha256');
  checker.integer(ledger.manifestBytes, 'snapshotLedger.manifestBytes');
  checker.digestFile(ledger.manifestPath, ledger.manifestSha256, ledger.manifestBytes, 'snapshotLedger.manifest');
  checkVerification(checker, ledger.verification, manifest.evidenceRoot, 'snapshotLedger.verification', manifest.snapshotVariant);
  const rule = fixture.mutations.find((entry) => entry.id === manifest.mutationId);
  checker.require(Boolean(rule), 'snapshotLedger mutation is not in fixture');
}

function checkAudit(checker, manifest, fixture, manifestPath) {
  const report = checker.json(manifest.auditPath, 'audit');
  const keys = ['schemaVersion', 'manifestPath', 'manifestSha256', 'manifestBytes', 'runId', 'nonce', 'phaseCount', 'selfCount', 'ledgerEntryCount', 'strictVerifierExitCode', 'ok', 'checkedUtc'];
  if (!checker.exact(report, keys, 'audit')) return;
  checker.require(report.schemaVersion === 'audit-033-v1', 'audit.schemaVersion invalid');
  checker.require(report.manifestPath === manifestPath, 'audit.manifestPath mismatch');
  checker.string(report.manifestSha256, 'audit.manifestSha256');
  checker.integer(report.manifestBytes, 'audit.manifestBytes');
  checker.digestFile(manifestPath, report.manifestSha256, report.manifestBytes, 'audit.manifest');
  checker.require(report.runId === manifest.runId && report.nonce === manifest.nonce, 'audit run binding mismatch');
  checker.require(report.phaseCount === manifest.phaseCount, 'audit.phaseCount mismatch');
  checker.require(report.selfCount === manifest.selfTriplets.length, 'audit.selfCount mismatch');
  checker.integer(report.ledgerEntryCount, 'audit.ledgerEntryCount');
  checker.require(report.ledgerEntryCount === fixture.mutations.length, 'audit.ledgerEntryCount unexpected');
  checker.require(report.strictVerifierExitCode === 0, 'audit.strictVerifierExitCode must be zero');
  checker.bool(report.ok, 'audit.ok');
  checker.require(report.ok === true, 'audit.ok must be true');
  checker.require(isIsoUtc(report.checkedUtc), 'audit.checkedUtc invalid');
}

function checkRunManifest(checker, manifestPath, manifest, fixture) {
  const expectedKeys = ['schemaVersion', 'manifestKind', 'taskId', 'contractId', 'runId', 'nonce', 'createdUtc', 'evidenceRoot', 'rulesPath', 'pathSelfCheckPath', 'phaseCount', 'phases', 'selfTriplets', 'mutationLedgerPath', 'auditPath', 'productionBaseline'];
  if (!checker.exact(manifest, expectedKeys, 'manifest')) return;
  checker.require(manifest.schemaVersion === 'manifest-033-v1', 'manifest.schemaVersion invalid');
  checker.require(manifest.manifestKind === 'run', 'manifest.manifestKind invalid');
  checker.string(manifest.taskId, 'manifest.taskId');
  checker.string(manifest.contractId, 'manifest.contractId');
  checker.string(manifest.runId, 'manifest.runId');
  checker.string(manifest.nonce, 'manifest.nonce');
  checker.require(isIsoUtc(manifest.createdUtc), 'manifest.createdUtc invalid');
  checker.path(manifestPath, SCRATCH_ROOT, 'manifestPath');
  checker.path(manifest.evidenceRoot, SCRATCH_ROOT, 'manifest.evidenceRoot', { mustExist: false });
  checker.require(path.resolve(manifest.evidenceRoot) === path.dirname(manifestPath), 'manifest.evidenceRoot must equal manifest directory');
  checker.path(manifest.rulesPath, manifest.evidenceRoot, 'manifest.rulesPath');
  checker.path(manifest.pathSelfCheckPath, manifest.evidenceRoot, 'manifest.pathSelfCheckPath');
  checker.path(manifest.mutationLedgerPath, manifest.evidenceRoot, 'manifest.mutationLedgerPath');
  checker.path(manifest.auditPath, manifest.evidenceRoot, 'manifest.auditPath');
  checker.integer(manifest.phaseCount, 'manifest.phaseCount');
  checker.require(manifest.phaseCount === fixture.stages.length * MODES.length, 'manifest.phaseCount invalid');
  checker.array(manifest.phases, 'manifest.phases');
  checker.require(manifest.phases.length === manifest.phaseCount, 'manifest.phases length mismatch');
  const combos = new Set();
  if (Array.isArray(manifest.phases)) manifest.phases.forEach((phase, index) => {
    checkPhase(checker, phase, index, fixture, manifest);
    if (phase && typeof phase.phaseId === 'string') combos.add(phase.phaseId);
  });
  fixture.stages.forEach((stage) => MODES.forEach((mode) => checker.require(combos.has(`${stage.id}-${mode}`), `manifest missing phase ${stage.id}-${mode}`)));
  checker.array(manifest.selfTriplets, 'manifest.selfTriplets');
  checker.require(manifest.selfTriplets.length === SELF_NAMES.length, 'manifest.selfTriplets count mismatch');
  const selfNames = new Set();
  if (Array.isArray(manifest.selfTriplets)) manifest.selfTriplets.forEach((record, index) => {
    checkSelf(checker, record, index, manifest);
    if (record && typeof record.name === 'string') selfNames.add(record.name);
  });
  SELF_NAMES.forEach((name) => checker.require(selfNames.has(name), `manifest missing self triplet ${name}`));
  checkPathSelf(checker, manifest, fixture);
  checkProduction(checker, manifest.productionBaseline);
  checkLedger(checker, manifest, fixture);
  checkAudit(checker, manifest, fixture, manifestPath);
}

function checkSnapshotManifest(checker, manifestPath, manifest, fixture) {
  const expectedKeys = ['schemaVersion', 'manifestKind', 'taskId', 'contractId', 'runId', 'nonce', 'createdUtc', 'evidenceRoot', 'rulesPath', 'pathSelfCheckPath', 'phaseCount', 'phases', 'selfTriplets', 'mutationLedgerPath', 'auditPath', 'productionBaseline', 'snapshotVariant', 'mutationId'];
  if (!checker.exact(manifest, expectedKeys, 'manifest')) return;
  checker.require(manifest.schemaVersion === 'manifest-033-v1', 'manifest.schemaVersion invalid');
  checker.require(manifest.manifestKind === 'mutation-snapshot', 'manifest.manifestKind invalid');
  checker.require(['baseline', 'mutated', 'restored'].includes(manifest.snapshotVariant), 'manifest.snapshotVariant invalid');
  checker.string(manifest.mutationId, 'manifest.mutationId');
  checker.path(manifestPath, SCRATCH_ROOT, 'manifestPath');
  checker.path(manifest.evidenceRoot, SCRATCH_ROOT, 'manifest.evidenceRoot', { mustExist: false });
  checker.require(path.resolve(manifest.evidenceRoot) === path.dirname(manifestPath), 'snapshot evidenceRoot must equal manifest directory');
  checker.path(manifest.rulesPath, manifest.evidenceRoot, 'manifest.rulesPath');
  checker.path(manifest.pathSelfCheckPath, manifest.evidenceRoot, 'manifest.pathSelfCheckPath');
  checker.path(manifest.mutationLedgerPath, manifest.evidenceRoot, 'manifest.mutationLedgerPath');
  checker.path(manifest.auditPath, manifest.evidenceRoot, 'manifest.auditPath');
  checker.integer(manifest.phaseCount, 'manifest.phaseCount');
  checker.require(manifest.phaseCount === fixture.stages.length * MODES.length, 'snapshot phaseCount invalid');
  checker.array(manifest.phases, 'manifest.phases');
  checker.require(manifest.phases.length === manifest.phaseCount, 'snapshot phases length mismatch');
  if (Array.isArray(manifest.phases)) manifest.phases.forEach((phase, index) => checkPhase(checker, phase, index, fixture, manifest));
  checker.array(manifest.selfTriplets, 'manifest.selfTriplets');
  checker.require(manifest.selfTriplets.length === SELF_NAMES.length, 'snapshot self triplet count mismatch');
  if (Array.isArray(manifest.selfTriplets)) manifest.selfTriplets.forEach((record, index) => checkSelf(checker, record, index, manifest));
  checkPathSelf(checker, manifest, fixture);
  checkProduction(checker, manifest.productionBaseline);
  checkSnapshotLedger(checker, manifest, fixture, manifestPath);
}

function verifyManifest(manifestPath) {
  const checker = new Checker();
  const absoluteManifestPath = path.resolve(manifestPath);
  if (!isContained(SCRATCH_ROOT, absoluteManifestPath) || hasLegacyFragment(absoluteManifestPath)) checker.error('manifest path is outside the 033 scratch root');
  const manifest = checker.json(absoluteManifestPath, 'manifest');
  let fixture = null;
  if (manifest && typeof manifest === 'object' && typeof manifest.rulesPath === 'string') {
    try {
      fixture = loadFixture(manifest.rulesPath);
    } catch (error) {
      checker.error('manifest rules fixture is invalid');
    }
  } else {
    checker.error('manifest rules path is missing');
  }
  if (manifest && fixture) {
    if (manifest.manifestKind === 'run') checkRunManifest(checker, absoluteManifestPath, manifest, fixture);
    else if (manifest.manifestKind === 'mutation-snapshot') checkSnapshotManifest(checker, absoluteManifestPath, manifest, fixture);
    else checker.error('manifest.manifestKind is unknown');
  }
  return { manifestPath: absoluteManifestPath, runId: manifest && manifest.runId, errorCount: checker.errors.length, errors: checker.errors };
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

const args = parseArgs(process.argv);

if (args['self-probe']) {
  const sources = [__filename, WRAPPER_PATH, WORKER_PATH, RUNNER_PATH, SOURCE_AUDIT_PATH, LEDGER_PATH, AUDIT_PATH];
  const ok = sources.every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  process.stdout.write(`${JSON.stringify({ ok, script: 'verifier', sourceCount: sources.length })}\n`);
  process.exitCode = ok ? 0 : 2;
} else {
  const manifestPath = args.manifest ? path.resolve(String(args.manifest)) : latestManifestPath();
  const result = verifyManifest(manifestPath);
  const output = {
    schemaVersion: 'strict-verifier-result-033-v1',
    manifestPath: result.manifestPath,
    runId: result.runId || 'unknown-run',
    errorCount: result.errorCount,
    errors: result.errors,
    verdict: result.errorCount === 0 ? 'PASS' : 'FAIL',
    checkedUtc: new Date().toISOString()
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = result.errorCount === 0 ? 0 : 1;
}

module.exports = { verifyManifest };
