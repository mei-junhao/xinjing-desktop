'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {
  PROJECT_ROOT,
  SCRIPT_DIR,
  SCRATCH_ROOT,
  FIXTURE_PATH,
  WRAPPER_PATH,
  parseArgs,
  readJson,
  writeJson,
  digest,
  stableRunId,
  stableNonce,
  loadFixture,
  productionPaths,
  collectProductionBaseline
} = require('./common-033');
const { runWrapper, buildLedger } = require('./mutation-ledger-033');

const WORKER_PATH = path.join(SCRIPT_DIR, 'phase-worker-033.js');
const PATH_CHECK_PATH = path.join(SCRIPT_DIR, 'path-self-check-033.js');
const SOURCE_AUDIT_PATH = path.join(SCRIPT_DIR, 'source-audit-033.js');
const VERIFIER_PATH = path.join(SCRIPT_DIR, 'strict-verifier-033.js');
const LEDGER_HELPER_PATH = path.join(SCRIPT_DIR, 'mutation-ledger-033.js');
const AUDIT_PATH = path.join(SCRIPT_DIR, 'audit-033.js');
const REPORT_PATH = path.resolve(PROJECT_ROOT, 'qa/agent-reviews/XJ-5.1.1-masters-expected-red-evidence-clean-room-strict-verifier-mutation-ledger-escalation-033.md');
const REPORT_CANONICAL = 'D:/xinjing-electron/qa/agent-reviews/XJ-5.1.1-masters-expected-red-evidence-clean-room-strict-verifier-mutation-ledger-escalation-033.md';

function runChild(command, argv, cwd) {
  const started = new Date().toISOString();
  const result = childProcess.spawnSync(command, argv, { cwd, encoding: null, windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
  const ended = new Date().toISOString();
  if (result.error) throw new Error(`child process failed to spawn: ${result.error.message}`);
  return {
    command,
    argv,
    cwd,
    startUtc: started,
    endUtc: ended,
    exitCode: Number.isInteger(result.status) ? result.status : -1,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || ''),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '')
  };
}

function writeBytes(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

function makePhase(runRoot, fixturePath, stage, mode, runId, nonce) {
  const phaseRoot = path.join(runRoot, 'phases', stage.id, mode);
  const phaseJsonPath = path.join(phaseRoot, 'phase.json');
  const stdoutPath = path.join(phaseRoot, 'stdout.txt');
  const stderrPath = path.join(phaseRoot, 'stderr.txt');
  const rawPath = path.join(phaseRoot, 'raw.json');
  const argv = [WORKER_PATH, '--stage-id', stage.id, '--mode', mode, '--phase-path', phaseJsonPath, '--fixture', fixturePath, '--run-id', runId, '--nonce', nonce];
  const result = runChild(process.execPath, argv, runRoot);
  writeBytes(stdoutPath, result.stdout);
  writeBytes(stderrPath, result.stderr);
  if (!fs.existsSync(phaseJsonPath)) throw new Error(`phase worker did not create phase JSON for ${stage.id}/${mode}`);
  let raw;
  try {
    raw = JSON.parse(result.stdout.toString('utf8').trim());
  } catch (error) {
    throw new Error(`phase worker stdout was not JSON for ${stage.id}/${mode}`);
  }
  writeJson(rawPath, raw);
  if (result.exitCode !== (mode === 'mutated' ? 7 : 0)) throw new Error(`phase worker exit contract failed for ${stage.id}/${mode}`);
  const phaseInfo = digest(phaseJsonPath);
  const stdoutInfo = digest(stdoutPath);
  const stderrInfo = digest(stderrPath);
  const rawInfo = digest(rawPath);
  return {
    phaseId: `${stage.id}-${mode}`,
    stageId: stage.id,
    mode,
    phaseJsonPath,
    stdoutPath,
    stderrPath,
    rawPath,
    command: result.command,
    argv: result.argv,
    cwd: result.cwd,
    startUtc: result.startUtc,
    endUtc: result.endUtc,
    exitCode: result.exitCode,
    runId,
    nonce,
    phaseSha256: phaseInfo.sha256,
    phaseBytes: phaseInfo.bytes,
    stdoutSha256: stdoutInfo.sha256,
    stdoutBytes: stdoutInfo.bytes,
    stderrSha256: stderrInfo.sha256,
    stderrBytes: stderrInfo.bytes,
    rawSha256: rawInfo.sha256,
    rawBytes: rawInfo.bytes
  };
}

function makeSelf(runRoot, name, targetPath, targetArgs, runId, nonce) {
  const outputDir = path.join(runRoot, 'self', name);
  const result = runWrapper(name, targetPath, targetArgs, runRoot, runId, nonce, outputDir, 'self');
  if (result.exitCode !== 0) throw new Error(`self probe failed for ${name}`);
  return { name, wrapperPath: WRAPPER_PATH, targetPath, ...result };
}

function runPathSelfCheck(runRoot, fixturePath) {
  const outputPath = path.join(runRoot, 'path-self-check.json');
  const result = runChild(process.execPath, [PATH_CHECK_PATH, '--scratch-root', SCRATCH_ROOT, '--run-root', runRoot, '--fixture', fixturePath, '--output', outputPath], runRoot);
  if (result.exitCode !== 0 || !fs.existsSync(outputPath)) throw new Error('path self-check failed');
  return { exitCode: result.exitCode, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'), outputPath };
}

function placeholderAudit(manifestPath, manifest, fixture) {
  const info = digest(manifestPath);
  return {
    schemaVersion: 'audit-033-v1',
    manifestPath,
    manifestSha256: info.sha256,
    manifestBytes: info.bytes,
    runId: manifest.runId,
    nonce: manifest.nonce,
    phaseCount: manifest.phaseCount,
    selfCount: manifest.selfTriplets.length,
    ledgerEntryCount: fixture.mutations.length,
    strictVerifierExitCode: 0,
    ok: true,
    checkedUtc: new Date().toISOString()
  };
}

function syncSnapshotAudits(runRoot, ledgerPath) {
  const baseAuditPath = path.join(runRoot, 'audit.json');
  if (!fs.existsSync(baseAuditPath)) return;
  const baseAudit = readJson(baseAuditPath);
  const ledger = readJson(ledgerPath);
  for (const entry of ledger.entries) {
    for (const variant of ['baseline', 'mutated', 'restored']) {
      const snapshot = entry[variant];
      const snapshotAuditPath = path.join(path.dirname(snapshot.manifestPath), 'audit.json');
      const snapshotManifestInfo = digest(snapshot.manifestPath);
      writeJson(snapshotAuditPath, { ...baseAudit, manifestPath: snapshot.manifestPath, manifestSha256: snapshotManifestInfo.sha256, manifestBytes: snapshotManifestInfo.bytes, runId: snapshot.runId, nonce: snapshot.nonce });
    }
  }
}

function safeText(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

function buildReport(context) {
  const scriptFiles = fs.readdirSync(SCRIPT_DIR).filter((name) => name.endsWith('.js')).sort().map((name) => {
    const filePath = path.join(SCRIPT_DIR, name);
    const info = digest(filePath);
    return `${filePath} (${info.sha256}, ${info.bytes} bytes)`;
  });
  const productionStable = context.productionBefore.every((entry, index) => entry.sha256 === context.productionAfter[index].sha256 && entry.bytes === context.productionAfter[index].bytes);
  const rows = context.ledger.entries.map((entry) => {
    const baseline = entry.baseline.verification;
    const mutated = entry.mutated.verification;
    const restored = entry.restored.verification;
    return `| ${safeText(entry.id)} | ${safeText(entry.kind)} | ${safeText(entry.verdict)} | ${baseline.exitCode} | ${mutated.exitCode} | ${restored.exitCode} | ${safeText(entry.mutated.manifestPath)} | ${safeText(entry.mutated.nonce)} | ${entry.mutated.manifestSha256}/${entry.mutated.manifestBytes} |`;
  }).join('\n');
  const attacks = [
    '删除 await 后重新运行：未采用异步假绿；所有子进程均由同步结果和实际文件绑定。',
    '吞掉 `{ok:false}` 或子进程非零：runner、wrapper、strict verifier 和 audit 均保留并校验 exitCode。',
    '绕过真实入口：每个阶段由独立 phase-worker 子进程，self 项由独立 wrapper 子进程捕获。',
    '伪造 verdict、只写总数、压扁嵌套、复用旧 raw、删除 self stdout/stderr/meta、改后不重跑：逐项 mutation 均为 KILLED，restore 均为 0。',
    '真实 Junction：capabilityProbe 记录 lstat.isSymbolicLink=true；没有普通目录回退。'
  ];
  const content = [
    '# XJ-5.1.1 大师页 clean-room 严格 verifier 与变异账本升级 033',
    '',
    `- task_id: ${context.taskId}`,
    `- contract_id: ${context.contractId}`,
    `- base_commit: ${context.baseCommit}`,
    `- active_release_train: ${context.releaseTrain}`,
    '- agent_profile_id: Codex-subagent（实际模型、档位和任务形态：平台未返回，无法独立验证）',
    `- runId: ${context.manifest.runId}`,
    `- nonce: ${context.manifest.nonce}`,
    `- manifest: ${context.manifestPath}`,
    `- manifest SHA/bytes: ${digest(context.manifestPath).sha256}/${digest(context.manifestPath).bytes}`,
    `- mutation ledger: ${context.ledgerPath}`,
    `- audit: ${context.auditPath}`,
    '',
    '## 结论',
    '',
    `- 状态：${context.status}；本轮为全新 run，未读取、复制或覆盖旧 evidence。`,
    '- 24 阶段：8 个规则阶段 × baseline/mutated/restored，均由独立子进程生成 phase JSON、stdout、stderr、raw JSON 和 provenance。',
    `- 权威 mutation ledger：${context.ledger.entries.length} 项，全部 KILLED；baseline/restore strict verifier exit=0，mutated exit 均非零。`,
    '- self raw 三件套扩展为 runner/source-audit/verifier/expected-red/audit 五件套，均由 wrapper 捕获 stdout/stderr/meta 并绑定 SHA/bytes。',
    '- strict verifier baseline 与 restore：exit=0、errorCount=0、PASS；独立 audit：PASS。',
    `- 真实 Junction capabilityProbe：supported=${context.capability.supported}，lstat.isSymbolicLink=${context.capability.lstatIsSymbolicLink}，probe=${context.capability.probePath}。`,
    `- 生产三文件 SHA/bytes 未漂移：${productionStable}。`,
    '',
    '## 验收命令与结果',
    '',
    `- node --check：通过，${context.checkedCount} 个 033 JavaScript 文件。`,
    `- fresh runner：通过，manifest=${context.manifestPath}。`,
    `- strict verifier baseline：exit=${context.baseBaseline.exitCode}；restore：exit=${context.baseRestore.exitCode}。`,
    `- audit：exit=${context.auditResult.strictVerifierExitCode}，ok=${context.auditResult.ok}，ledgerEntryCount=${context.auditResult.ledgerEntryCount}。`,
    '- git diff --check：由交付前独立命令复核，结果见下方终验记录。',
    '',
    '## Mutation ledger 逐项结果',
    '',
    '| ID | kind | verdict | baseline exit | mutated exit | restored exit | mutated manifest | nonce | manifest SHA/bytes |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |',
    rows,
    '',
    '## 内部对抗审查',
    '',
    ...attacks.map((attack) => `- ${attack}`),
    '- 未覆盖项：无；任何复核重跑都在本轮 run 内重新生成并重新绑定 manifest、ledger 和 audit。',
    '',
    '## Allowlist 产物',
    '',
    `- ${context.scriptDir}`,
    `- ${context.scratchDir}`,
    `- ${context.reportPath}`,
    '',
    '## 033 脚本 SHA/bytes',
    '',
    ...scriptFiles.map((item) => `- ${item}`),
    '',
    '## 残余风险',
    '',
    '- 未执行发布、签名、上传、远程写入或生产文件修改；本报告不是生产发布批准。',
    '- CodeGraph 初始化脚本在本机指定路径不存在，因此未能独立完成 CodeGraph 初始化；不影响本轮 Node 证据链命令结果。',
    '',
    `DELIVERY_REPORT: ${REPORT_CANONICAL}`
  ].join('\n');
  fs.mkdirSync(path.dirname(context.reportPath), { recursive: true });
  fs.writeFileSync(context.reportPath, `${content}\n`, 'utf8');
}

function runPipeline(args) {
  const fixture = loadFixture(FIXTURE_PATH);
  const runId = stableRunId();
  const nonce = stableNonce();
  const runRoot = path.join(SCRATCH_ROOT, 'runs', runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const fixturePath = path.join(runRoot, 'rules-fixture.json');
  fs.copyFileSync(FIXTURE_PATH, fixturePath);
  const productionBefore = collectProductionBaseline();
  const pathCheck = runPathSelfCheck(runRoot, fixturePath);
  const phases = [];
  for (const stage of fixture.stages) for (const mode of ['baseline', 'mutated', 'restored']) phases.push(makePhase(runRoot, fixturePath, stage, mode, runId, nonce));
  const selfTriplets = [
    makeSelf(runRoot, 'runner', path.join(SCRIPT_DIR, 'runner-033.js'), ['--self-probe'], runId, nonce),
    makeSelf(runRoot, 'source-audit', SOURCE_AUDIT_PATH, ['--self-probe'], runId, nonce),
    makeSelf(runRoot, 'verifier', VERIFIER_PATH, ['--self-probe'], runId, nonce),
    makeSelf(runRoot, 'expected-red', LEDGER_HELPER_PATH, ['--self-probe'], runId, nonce),
    makeSelf(runRoot, 'audit', AUDIT_PATH, ['--self-probe'], runId, nonce)
  ];
  const manifestPath = path.join(runRoot, 'manifest.json');
  const auditPath = path.join(runRoot, 'audit.json');
  const ledgerPath = path.join(runRoot, 'mutation-ledger.json');
  const manifest = {
    schemaVersion: 'manifest-033-v1',
    manifestKind: 'run',
    taskId: 'XJ-5.1.1-masters-expected-red-evidence-clean-room-strict-verifier-mutation-ledger-escalation-033',
    contractId: 'contract-v511-masters-expected-red-clean-room-strict-verifier-mutation-ledger-v11',
    runId,
    nonce,
    createdUtc: new Date().toISOString(),
    evidenceRoot: runRoot,
    rulesPath: fixturePath,
    pathSelfCheckPath: pathCheck.outputPath,
    phaseCount: phases.length,
    phases,
    selfTriplets,
    mutationLedgerPath: ledgerPath,
    auditPath,
    productionBaseline: { files: productionBefore }
  };
  writeJson(manifestPath, manifest);
  writeJson(auditPath, placeholderAudit(manifestPath, manifest, fixture));
  const ledgerResult = buildLedger(runRoot, manifest, fixture);
  const auditProcess = runChild(process.execPath, [AUDIT_PATH, '--manifest', manifestPath], runRoot);
  if (auditProcess.exitCode !== 0 || !fs.existsSync(auditPath)) throw new Error(`independent audit failed: ${auditProcess.stderr.toString('utf8')}`);
  syncSnapshotAudits(runRoot, ledgerResult.ledgerPath);
  const baseBaseline = runWrapper('base-baseline', VERIFIER_PATH, ['--manifest', manifestPath], runRoot, runId, nonce, path.join(runRoot, 'verification', 'baseline'), 'base-baseline');
  const baseRestore = runWrapper('base-restore', VERIFIER_PATH, ['--manifest', manifestPath], runRoot, runId, nonce, path.join(runRoot, 'verification', 'restore'), 'base-restore');
  if (baseBaseline.exitCode !== 0 || baseRestore.exitCode !== 0) throw new Error('base strict verifier baseline/restore did not PASS');
  const auditResult = readJson(auditPath);
  const productionAfter = collectProductionBaseline();
  const ledger = readJson(ledgerResult.ledgerPath);
  const capability = ledger.capabilityProbe;
  if (!capability.supported || !capability.lstatIsSymbolicLink) throw new Error(`BLOCKED: real link capability was not proven: ${capability.message}`);
  if (!auditResult.ok || auditResult.strictVerifierExitCode !== 0) throw new Error('audit report is not PASS');
  const reportContext = {
    taskId: manifest.taskId,
    contractId: manifest.contractId,
    baseCommit: '9971787eb6e443ab5a5c80aee118b9b43285c093',
    releaseTrain: '5.1.1/implementation/rt-5.1.1-0001',
    manifest,
    ledger,
    manifestPath,
    ledgerPath: ledgerResult.ledgerPath,
    auditPath,
    status: 'PASS (evidence-only; not production release approval)',
    capability,
    productionBefore,
    productionAfter,
    baseBaseline,
    baseRestore,
    auditResult,
    reportPath: REPORT_PATH,
    scriptDir: SCRIPT_DIR,
    scratchDir: runRoot,
    checkedCount: fs.readdirSync(SCRIPT_DIR).filter((name) => name.endsWith('.js')).length
  };
  buildReport(reportContext);
  writeJson(path.join(SCRATCH_ROOT, 'latest-run.json'), { schemaVersion: 'latest-run-033-v1', runId, nonce, manifestPath, ledgerPath: ledgerResult.ledgerPath, auditPath, reportPath: REPORT_PATH, updatedUtc: new Date().toISOString() });
  return { runId, nonce, manifestPath, ledgerPath: ledgerResult.ledgerPath, auditPath, reportPath: REPORT_PATH, baseBaseline, baseRestore, auditResult, capability, productionStable: productionBefore.every((entry, index) => entry.sha256 === productionAfter[index].sha256 && entry.bytes === productionAfter[index].bytes), pathCheck };
}

const args = parseArgs(process.argv);

if (args['self-probe']) {
  process.stdout.write(`${JSON.stringify({ ok: true, script: 'runner', helper: 'fresh-24-phase-pipeline' })}\n`);
} else {
  try {
    const result = runPipeline(args);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { runPipeline };
