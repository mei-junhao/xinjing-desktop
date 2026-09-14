'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  PROJECT_ROOT,
  SCRIPT_DIR,
  SCRATCH_ROOT,
  WRAPPER_PATH,
  parseArgs,
  readJson,
  writeJson,
  digest,
  sha256Buffer,
  exactKeys,
  loadFixture
} = require('./common-033');

const VERIFIER_PATH = path.join(SCRIPT_DIR, 'strict-verifier-033.js');

function runWrapper(name, targetPath, targetArgs, root, runId, nonce, outputDir, variant) {
  const stdoutPath = path.join(outputDir, `${name}-stdout.txt`);
  const stderrPath = path.join(outputDir, `${name}-stderr.txt`);
  const metaPath = path.join(outputDir, `${name}-meta.json`);
  fs.mkdirSync(outputDir, { recursive: true });
  const args = [
    WRAPPER_PATH,
    '--name', name,
    '--target', targetPath,
    '--cwd', root,
    '--stdout', stdoutPath,
    '--stderr', stderrPath,
    '--meta', metaPath,
    '--run-id', runId,
    '--nonce', nonce,
    '--target-args-json', JSON.stringify(targetArgs)
  ];
  const startUtc = new Date().toISOString();
  const result = childProcess.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
  const endUtc = new Date().toISOString();
  if (result.error) throw new Error(`wrapper failed to spawn: ${result.error.message}`);
  if (!fs.existsSync(metaPath) || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) throw new Error(`wrapper did not produce a complete triplet for ${variant}`);
  const meta = readJson(metaPath);
  if (!exactKeys(meta, ['schemaVersion', 'name', 'wrapperPath', 'targetPath', 'command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode', 'runId', 'nonce', 'stdoutPath', 'stdoutSha256', 'stdoutBytes', 'stderrPath', 'stderrSha256', 'stderrBytes'])) throw new Error(`wrapper meta shape invalid for ${variant}`);
  if (meta.runId !== runId || meta.nonce !== nonce || meta.name !== name) throw new Error(`wrapper meta binding invalid for ${variant}`);
  if (meta.exitCode !== (Number.isInteger(result.status) ? result.status : -1)) throw new Error(`wrapper exit binding invalid for ${variant}`);
  const outDigest = digest(stdoutPath);
  const errDigest = digest(stderrPath);
  if (outDigest.sha256 !== meta.stdoutSha256 || outDigest.bytes !== meta.stdoutBytes || errDigest.sha256 !== meta.stderrSha256 || errDigest.bytes !== meta.stderrBytes) throw new Error(`wrapper output digest binding invalid for ${variant}`);
  return {
    command: meta.command,
    argv: meta.argv,
    cwd: meta.cwd,
    startUtc: meta.startUtc || startUtc,
    endUtc: meta.endUtc || endUtc,
    exitCode: meta.exitCode,
    runId: meta.runId,
    nonce: meta.nonce,
    stdoutPath: meta.stdoutPath,
    stdoutSha256: meta.stdoutSha256,
    stdoutBytes: meta.stdoutBytes,
    stderrPath: meta.stderrPath,
    stderrSha256: meta.stderrSha256,
    stderrBytes: meta.stderrBytes,
    metaPath,
    metaSha256: digest(metaPath).sha256,
    metaBytes: digest(metaPath).bytes
  };
}

function copyTree(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'mutation-ledger.json' || entry.name === 'ledger') continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath, fs.statSync(sourcePath).isDirectory() ? 'junction' : 'file');
    else fs.copyFileSync(sourcePath, destinationPath);
  }
}

function replaceRoot(value, oldRoot, newRoot) {
  if (typeof value === 'string') {
    const oldValue = path.resolve(oldRoot);
    const candidate = path.resolve(value);
    const lowerCandidate = candidate.toLowerCase();
    const lowerOld = oldValue.toLowerCase();
    if (lowerCandidate === lowerOld || lowerCandidate.startsWith(`${lowerOld}${path.sep}`)) {
      const suffix = candidate.slice(oldValue.length).replace(/^[/\\]+/, '');
      return suffix ? path.join(newRoot, suffix) : path.resolve(newRoot);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => replaceRoot(entry, oldRoot, newRoot));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = replaceRoot(entry, oldRoot, newRoot);
    return output;
  }
  return value;
}

function rewriteJsonTree(root, oldRoot, newRoot) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) rewriteJsonTree(filePath, oldRoot, newRoot);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const value = readJson(filePath);
      writeJson(filePath, replaceRoot(value, oldRoot, newRoot));
    }
  }
}

function refreshSnapshotManifest(snapshotRoot) {
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  const manifest = readJson(manifestPath);
  const safeDigest = (filePath, fallback) => {
    try { return digest(filePath); } catch (error) { return fallback; }
  };
  for (const phase of manifest.phases) {
    const phaseInfo = safeDigest(phase.phaseJsonPath, { sha256: phase.phaseSha256, bytes: phase.phaseBytes });
    const stdoutInfo = safeDigest(phase.stdoutPath, { sha256: phase.stdoutSha256, bytes: phase.stdoutBytes });
    const stderrInfo = safeDigest(phase.stderrPath, { sha256: phase.stderrSha256, bytes: phase.stderrBytes });
    const rawInfo = safeDigest(phase.rawPath, { sha256: phase.rawSha256, bytes: phase.rawBytes });
    phase.phaseSha256 = phaseInfo.sha256;
    phase.phaseBytes = phaseInfo.bytes;
    phase.stdoutSha256 = stdoutInfo.sha256;
    phase.stdoutBytes = stdoutInfo.bytes;
    phase.stderrSha256 = stderrInfo.sha256;
    phase.stderrBytes = stderrInfo.bytes;
    phase.rawSha256 = rawInfo.sha256;
    phase.rawBytes = rawInfo.bytes;
  }
  for (const record of manifest.selfTriplets) {
    if (fs.existsSync(record.metaPath)) {
      const meta = readJson(record.metaPath);
      record.wrapperPath = meta.wrapperPath;
      record.targetPath = meta.targetPath;
      record.command = meta.command;
      record.argv = meta.argv;
      record.cwd = meta.cwd;
      record.startUtc = meta.startUtc;
      record.endUtc = meta.endUtc;
      record.exitCode = meta.exitCode;
      record.runId = meta.runId;
      record.nonce = meta.nonce;
      record.stdoutPath = meta.stdoutPath;
      record.stdoutSha256 = safeDigest(record.stdoutPath, { sha256: record.stdoutSha256, bytes: record.stdoutBytes }).sha256;
      record.stdoutBytes = safeDigest(record.stdoutPath, { sha256: record.stdoutSha256, bytes: record.stdoutBytes }).bytes;
      record.stderrPath = meta.stderrPath;
      const stderrInfo = safeDigest(record.stderrPath, { sha256: record.stderrSha256, bytes: record.stderrBytes });
      record.stderrSha256 = stderrInfo.sha256;
      record.stderrBytes = stderrInfo.bytes;
      record.metaPath = path.resolve(record.metaPath);
      const metaInfo = safeDigest(record.metaPath, { sha256: record.metaSha256, bytes: record.metaBytes });
      record.metaSha256 = metaInfo.sha256;
      record.metaBytes = metaInfo.bytes;
    }
  }
  if (fs.existsSync(manifest.auditPath)) {
    try {
      const audit = readJson(manifest.auditPath);
      if (audit && typeof audit === 'object') {
        audit.manifestPath = manifestPath;
        audit.manifestSha256 = sha256Buffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
        audit.manifestBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        writeJson(manifest.auditPath, audit);
      }
    } catch (error) {
      // A copied audit artifact is not the verification authority for a snapshot.
    }
  }
  writeJson(manifestPath, manifest);
  return manifest;
}

function phaseByMode(manifest, mode) {
  return manifest.phases.find((phase) => phase.mode === mode) || manifest.phases[0];
}

function selfByName(manifest, name) {
  return manifest.selfTriplets.find((record) => record.name === name);
}

function writePhaseRaw(phase, raw) {
  const text = `${JSON.stringify(raw)}\n`;
  fs.writeFileSync(phase.rawPath, text, 'utf8');
  fs.writeFileSync(phase.stdoutPath, text, 'utf8');
}

function createRealJunction(snapshotRoot, phase) {
  const targetRoot = path.join(snapshotRoot, 'junction-target');
  const linkRoot = path.join(snapshotRoot, 'junction-link');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.copyFileSync(phase.rawPath, path.join(targetRoot, 'raw.json'));
  try {
    fs.symlinkSync(targetRoot, linkRoot, 'junction');
    const isSymbolicLink = fs.lstatSync(linkRoot).isSymbolicLink();
    if (!isSymbolicLink) return { required: true, attempted: true, supported: false, linkType: 'junction', probePath: linkRoot, targetPath: targetRoot, lstatIsSymbolicLink: false, message: 'junction created but lstat did not report a symbolic link' };
    phase.rawPath = path.join(linkRoot, 'raw.json');
    return { required: true, attempted: true, supported: true, linkType: 'junction', probePath: linkRoot, targetPath: targetRoot, lstatIsSymbolicLink: true, message: 'real junction capability proven by lstat' };
  } catch (error) {
    return { required: true, attempted: true, supported: false, linkType: 'junction', probePath: linkRoot, targetPath: targetRoot, lstatIsSymbolicLink: false, message: `junction creation failed: ${error.message}` };
  }
}

function applyMutation(snapshotRoot, rule, fixture) {
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  const manifest = readJson(manifestPath);
  const capability = { required: false, attempted: false, supported: true, linkType: 'none', probePath: 'not-applicable', targetPath: 'not-applicable', lstatIsSymbolicLink: false, message: 'not-required' };
  const baselinePhase = phaseByMode(manifest, 'baseline');
  const mutatedPhase = phaseByMode(manifest, 'mutated');
  const verifierSelf = selfByName(manifest, 'verifier');
  if (rule.kind === 'delete-stdout') fs.unlinkSync(baselinePhase.stdoutPath);
  else if (rule.kind === 'delete-stderr') fs.unlinkSync(baselinePhase.stderrPath);
  else if (rule.kind === 'delete-meta') fs.unlinkSync(verifierSelf.metaPath);
  else if (rule.kind === 'fake-sha') baselinePhase.stdoutSha256 = '0'.repeat(64);
  else if (rule.kind === 'fake-bytes') baselinePhase.rawBytes += 1;
  else if (rule.kind === 'unknown-field') baselinePhase.unexpectedField = true;
  else if (rule.kind === 'type-change') baselinePhase.exitCode = String(baselinePhase.exitCode);
  else if (rule.kind === 'cross-case') baselinePhase.rawPath = manifest.phases.find((phase) => phase.phaseId !== baselinePhase.phaseId).rawPath;
  else if (rule.kind === 'sibling-prefix') baselinePhase.rawPath = `${snapshotRoot}-sibling-prefix${path.sep}raw.json`;
  else if (rule.kind === 'dotdot') baselinePhase.rawPath = path.join(snapshotRoot, '..', 'outside', 'raw.json');
  else if (rule.kind === 'real-junction') Object.assign(capability, createRealJunction(snapshotRoot, baselinePhase));
  else if (rule.kind === 'flatten-er7') {
    const nestedPhase = manifest.phases.find((phase) => {
      const raw = readJson(phase.rawPath);
      return raw && raw.payload && raw.payload.nested;
    });
    const raw = readJson(nestedPhase.rawPath);
    raw.payload = { signal: raw.payload.nested.signal, marker: raw.payload.nested.marker };
    writePhaseRaw(nestedPhase, raw);
    nestedPhase.rawSha256 = digest(nestedPhase.rawPath).sha256;
    nestedPhase.rawBytes = digest(nestedPhase.rawPath).bytes;
    nestedPhase.stdoutSha256 = digest(nestedPhase.stdoutPath).sha256;
    nestedPhase.stdoutBytes = digest(nestedPhase.stdoutPath).bytes;
  } else if (rule.kind === 'old-nonce') baselinePhase.nonce = 'nonce-old-evidence';
  else if (rule.kind === 'old-raw') baselinePhase.rawPath = path.join(SCRATCH_ROOT, 'legacy-032-evidence', 'raw.json');
  else if (rule.kind === 'summary-only') manifest.phases = [];
  else if (rule.kind === 'delete-verifier-self') manifest.selfTriplets = manifest.selfTriplets.filter((record) => record.name !== 'verifier');
  else if (rule.kind === 'tamper-source') manifest.productionBaseline.files[0].sha256 = 'f'.repeat(64);
  else if (rule.kind === 'swallow-failure') mutatedPhase.exitCode = 0;
  else throw new Error(`unsupported mutation kind: ${rule.kind}`);
  writeJson(manifestPath, manifest);
  return { manifest, capability };
}

function artifactList(manifest) {
  const artifacts = [];
  const add = (kind, record, filePath) => {
    let info;
    let present = true;
    try {
      info = digest(filePath);
    } catch (error) {
      present = false;
      const expected = kind === 'phase-json' ? [record.phaseSha256, record.phaseBytes]
        : kind === 'phase-stdout' ? [record.stdoutSha256, record.stdoutBytes]
          : kind === 'phase-stderr' ? [record.stderrSha256, record.stderrBytes]
            : kind === 'phase-raw' ? [record.rawSha256, record.rawBytes]
              : kind === 'self-stdout' ? [record.stdoutSha256, record.stdoutBytes]
                : kind === 'self-stderr' ? [record.stderrSha256, record.stderrBytes]
                  : [record.metaSha256, record.metaBytes];
      info = { sha256: expected[0], bytes: expected[1] };
    }
    const exitCode = Number.isInteger(record.exitCode) ? record.exitCode : (record.mode === 'mutated' ? 7 : 0);
    artifacts.push({ present, kind, path: filePath, sha256: info.sha256, bytes: info.bytes, command: record.command, argv: record.argv, cwd: record.cwd, startUtc: record.startUtc, endUtc: record.endUtc, exitCode, runId: record.runId, nonce: record.nonce });
  };
  for (const phase of manifest.phases) {
    add('phase-json', phase, phase.phaseJsonPath);
    add('phase-stdout', phase, phase.stdoutPath);
    add('phase-stderr', phase, phase.stderrPath);
    add('phase-raw', phase, phase.rawPath);
  }
  for (const record of manifest.selfTriplets) {
    add('self-stdout', record, record.stdoutPath);
    add('self-stderr', record, record.stderrPath);
    add('self-meta', record, record.metaPath);
  }
  return artifacts;
}

function makeSnapshotRecord(snapshotRoot, variant, verification, manifest) {
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  const manifestInfo = digest(manifestPath);
  let artifactManifest = manifest;
  const templatePath = path.join(snapshotRoot, 'manifest-template.json');
  if (fs.existsSync(templatePath)) artifactManifest = readJson(templatePath);
  return {
    variant,
    manifestPath,
    manifestSha256: manifestInfo.sha256,
    manifestBytes: manifestInfo.bytes,
    runId: manifest.runId,
    nonce: manifest.nonce,
    verification,
    artifacts: artifactList(artifactManifest)
  };
}

function writeSnapshotLedger(snapshotRoot, manifest, mutationId, variant, verification) {
  const verificationPath = path.join(snapshotRoot, 'verify', 'verifier-meta.json');
  const localLedgerPath = path.join(snapshotRoot, 'mutation-ledger.json');
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  const manifestInfo = digest(manifestPath);
  const payload = {
    schemaVersion: 'snapshot-ledger-033-v1',
    taskId: manifest.taskId,
    contractId: manifest.contractId,
    runId: manifest.runId,
    nonce: manifest.nonce,
    mutationId,
    variant,
    manifestPath,
    manifestSha256: manifestInfo.sha256,
    manifestBytes: manifestInfo.bytes,
    verification
  };
  writeJson(localLedgerPath, payload);
  return { localLedgerPath, verificationPath };
}

function writeSnapshotPlaceholder(snapshotRoot, manifest, mutationId, variant) {
  const verifyRoot = path.join(snapshotRoot, 'verify');
  const stdoutPath = path.join(verifyRoot, 'verifier-stdout.txt');
  const stderrPath = path.join(verifyRoot, 'verifier-stderr.txt');
  const metaPath = path.join(verifyRoot, 'verifier-meta.json');
  fs.mkdirSync(verifyRoot, { recursive: true });
  fs.writeFileSync(stdoutPath, '', 'utf8');
  fs.writeFileSync(stderrPath, '', 'utf8');
  const startUtc = new Date().toISOString();
  const endUtc = new Date().toISOString();
  const verification = {
    command: process.execPath,
    argv: [VERIFIER_PATH, '--manifest', path.join(snapshotRoot, 'manifest.json')],
    cwd: snapshotRoot,
    startUtc,
    endUtc,
    exitCode: variant === 'mutated' ? -1 : 0,
    runId: manifest.runId,
    nonce: manifest.nonce,
    stdoutPath,
    stdoutSha256: digest(stdoutPath).sha256,
    stdoutBytes: digest(stdoutPath).bytes,
    stderrPath,
    stderrSha256: digest(stderrPath).sha256,
    stderrBytes: digest(stderrPath).bytes,
    metaPath,
    metaSha256: '',
    metaBytes: 0
  };
  writeJson(metaPath, {
    schemaVersion: 'wrapper-meta-033-v1',
    name: 'verifier',
    wrapperPath: WRAPPER_PATH,
    targetPath: VERIFIER_PATH,
    command: process.execPath,
    argv: [VERIFIER_PATH, '--manifest', path.join(snapshotRoot, 'manifest.json')],
    cwd: snapshotRoot,
    startUtc,
    endUtc,
    exitCode: variant === 'mutated' ? -1 : 0,
    runId: manifest.runId,
    nonce: manifest.nonce,
    stdoutPath,
    stdoutSha256: digest(stdoutPath).sha256,
    stdoutBytes: digest(stdoutPath).bytes,
    stderrPath,
    stderrSha256: digest(stderrPath).sha256,
    stderrBytes: digest(stderrPath).bytes
  });
  verification.metaSha256 = digest(metaPath).sha256;
  verification.metaBytes = digest(metaPath).bytes;
  writeSnapshotLedger(snapshotRoot, manifest, mutationId, variant, verification);
}

function buildEntry(baseRoot, entryRule, runId, nonce, index) {
  const entryRoot = path.join(baseRoot, 'ledger', entryRule.id);
  const baselineRoot = path.join(entryRoot, 'baseline');
  const mutatedRoot = path.join(entryRoot, 'mutated');
  const restoredRoot = path.join(entryRoot, 'restored');
  copyTree(baseRoot, baselineRoot);
  copyTree(baseRoot, mutatedRoot);
  copyTree(baseRoot, restoredRoot);
  for (const [snapshotRoot, variant] of [[baselineRoot, 'baseline'], [mutatedRoot, 'mutated'], [restoredRoot, 'restored']]) {
    fs.copyFileSync(path.join(snapshotRoot, 'manifest.json'), path.join(snapshotRoot, 'manifest-template.json'));
    const snapshotManifestPath = path.join(snapshotRoot, 'manifest.json');
    const snapshotManifest = readJson(snapshotManifestPath);
    snapshotManifest.manifestKind = 'mutation-snapshot';
    snapshotManifest.snapshotVariant = variant;
    snapshotManifest.mutationId = entryRule.id;
    writeJson(snapshotManifestPath, snapshotManifest);
  }
  rewriteJsonTree(baselineRoot, baseRoot, baselineRoot);
  rewriteJsonTree(mutatedRoot, baseRoot, mutatedRoot);
  rewriteJsonTree(restoredRoot, baseRoot, restoredRoot);
  const baselineManifest = refreshSnapshotManifest(baselineRoot);
  const restoredManifest = refreshSnapshotManifest(restoredRoot);
  const mutation = applyMutation(mutatedRoot, entryRule, loadFixture(path.join(baseRoot, 'rules-fixture.json')));
  const mutatedManifest = mutation.manifest;
  const capability = mutation.capability;
  writeSnapshotPlaceholder(baselineRoot, baselineManifest, entryRule.id, 'baseline');
  writeSnapshotPlaceholder(mutatedRoot, mutatedManifest, entryRule.id, 'mutated');
  writeSnapshotPlaceholder(restoredRoot, restoredManifest, entryRule.id, 'restored');
  const baselineVerification = runWrapper('verifier', VERIFIER_PATH, ['--manifest', path.join(baselineRoot, 'manifest.json')], baselineRoot, runId, nonce, path.join(baselineRoot, 'verify'), 'baseline');
  const mutatedVerification = runWrapper('verifier', VERIFIER_PATH, ['--manifest', path.join(mutatedRoot, 'manifest.json')], mutatedRoot, runId, nonce, path.join(mutatedRoot, 'verify'), 'mutated');
  const restoredVerification = runWrapper('verifier', VERIFIER_PATH, ['--manifest', path.join(restoredRoot, 'manifest.json')], restoredRoot, runId, nonce, path.join(restoredRoot, 'verify'), 'restored');
  if (capability.required && !capability.supported) throw new Error(`BLOCKED: required real-link mutation capability unavailable: ${capability.message}`);
  if (baselineVerification.exitCode !== 0 || mutatedVerification.exitCode === 0 || restoredVerification.exitCode !== 0) throw new Error(`mutation ${entryRule.id} failed expected-red exit contract`);
  const baseline = makeSnapshotRecord(baselineRoot, 'baseline', baselineVerification, baselineManifest);
  const mutated = makeSnapshotRecord(mutatedRoot, 'mutated', mutatedVerification, mutatedManifest);
  const restored = makeSnapshotRecord(restoredRoot, 'restored', restoredVerification, restoredManifest);
  writeSnapshotLedger(baselineRoot, baselineManifest, entryRule.id, 'baseline', baselineVerification);
  writeSnapshotLedger(mutatedRoot, mutatedManifest, entryRule.id, 'mutated', mutatedVerification);
  writeSnapshotLedger(restoredRoot, restoredManifest, entryRule.id, 'restored', restoredVerification);
  return {
    id: entryRule.id,
    kind: entryRule.kind,
    description: `independent mutation ${index + 1}: ${entryRule.target}`,
    capability,
    baseline,
    mutated,
    restored,
    verdict: 'KILLED',
    uncovered: []
  };
}

function buildLedger(baseRoot, manifest, fixture) {
  const ledgerRoot = path.join(baseRoot, 'ledger');
  fs.mkdirSync(ledgerRoot, { recursive: true });
  const entries = [];
  for (let index = 0; index < fixture.mutations.length; index += 1) entries.push(buildEntry(baseRoot, fixture.mutations[index], manifest.runId, manifest.nonce, index));
  const linkEntry = entries.find((entry) => entry.kind === 'real-junction');
  const capabilityProbe = linkEntry ? { attempted: linkEntry.capability.attempted, supported: linkEntry.capability.supported, linkType: linkEntry.capability.linkType, probePath: linkEntry.capability.probePath, targetPath: linkEntry.capability.targetPath, lstatIsSymbolicLink: linkEntry.capability.lstatIsSymbolicLink, message: linkEntry.capability.message } : { attempted: false, supported: false, linkType: 'none', probePath: 'missing', targetPath: 'missing', lstatIsSymbolicLink: false, message: 'real-link mutation was not executed' };
  if (!capabilityProbe.supported || !capabilityProbe.lstatIsSymbolicLink) throw new Error(`BLOCKED: capability probe did not prove a real link: ${capabilityProbe.message}`);
  const ledger = {
    schemaVersion: 'ledger-033-v1',
    taskId: manifest.taskId,
    contractId: manifest.contractId,
    runId: manifest.runId,
    nonce: manifest.nonce,
    entryCount: entries.length,
    entries,
    capabilityProbe
  };
  const ledgerPath = path.join(baseRoot, 'mutation-ledger.json');
  writeJson(ledgerPath, ledger);
  return { ledgerPath, ledger };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (args['self-probe']) {
    process.stdout.write(`${JSON.stringify({ ok: true, script: 'expected-red', helper: 'mutation-ledger' })}\n`);
  } else {
    try {
      const fixture = loadFixture(args.fixture);
      process.stdout.write(`${JSON.stringify({ ok: true, mutationCount: fixture.mutations.length })}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}

module.exports = { buildLedger, runWrapper, refreshSnapshotManifest, copyTree, rewriteJsonTree, applyMutation, artifactList };
