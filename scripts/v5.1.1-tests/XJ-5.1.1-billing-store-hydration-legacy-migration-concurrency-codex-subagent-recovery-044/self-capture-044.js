'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const {
  ROOT,
  TASK,
  SCRATCH_ROOT,
  loadIdentity,
  ensureDir,
  writeJson,
  shaFile,
} = require('./common-044');

const identity = loadIdentity();
const selfRoot = identity.selfRoot;

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function capture(role, toolPath) {
  const dir = path.join(selfRoot, role);
  ensureDir(dir);
  const argv = [toolPath];
  const startUtc = new Date().toISOString();
  const child = cp.spawn(process.execPath, argv, { cwd: ROOT, env: Object.assign({}, process.env, { XJ_044_TASK_ID: TASK, XJ_044_RUN_ID: identity.runId }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      finish(null, 'SIGTIMEOUT', true);
    }, 20 * 60 * 1000);
    const finish = (code, signal, forcedTermination) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
      const endUtc = new Date().toISOString();
      const stdoutPath = path.join(dir, 'stdout.txt');
      const stderrPath = path.join(dir, 'stderr.txt');
      fs.writeFileSync(stdoutPath, stdout, 'utf8');
      fs.writeFileSync(stderrPath, stderr, 'utf8');
      const meta = {
        schema: 'xj-044-self-meta-v1',
        role,
        toolPath,
        taskId: TASK,
        inputTaskId: '043',
        runId: identity.runId,
        runNonce: identity.runNonce,
        cardSha256: identity.cardSha256,
        storeSha256: identity.storeSha256,
        protectedFilesManifestSha256: identity.protectedFilesManifestSha256,
        command: process.execPath,
        argv: argv.slice(),
        spawnVector: [process.execPath, ...argv],
        cwd: ROOT,
        startUtc,
        endUtc,
        childExitCode: code,
        childSignal: signal,
        forcedTermination: !!forcedTermination,
        verdict: !forcedTermination && code === 0 ? 'PASS' : 'FAIL',
        evidenceRoot: identity.evidenceRoot,
        selfRoot,
        stdoutPath,
        stderrPath,
        stdoutSha256: shaFile(stdoutPath),
        stderrSha256: shaFile(stderrPath),
        stdoutBytes: fs.statSync(stdoutPath).size,
        stderrBytes: fs.statSync(stderrPath).size,
      };
      writeJson(path.join(dir, 'meta.json'), meta);
      console.log(`${role} ${meta.verdict} exit=${code} stdout=${meta.stdoutBytes} stderr=${meta.stderrBytes}`);
      resolve(meta);
    };
    child.once('close', (code, signal) => finish(code, signal, false));
    child.once('error', error => {
      stderr += `\nSELF CAPTURE SPAWN ERROR ${error && error.stack || error}\n`;
      finish(null, error && error.code || 'spawn-error', false);
    });
  });
}

async function main() {
  ensureDir(selfRoot);
  const tools = [
    ['runner', path.join(identity.scriptRoot, 'runner-044.js')],
    ['verifier', path.join(identity.scriptRoot, 'verifier-044.js')],
    ['expected-red', path.join(identity.scriptRoot, 'expected-red-044.js')],
    ['audit', path.join(identity.scriptRoot, 'audit-044.js')],
  ];
  const metas = [];
  for (const [role, toolPath] of tools) {
    metas.push(await capture(role, toolPath));
  }
  const summary = {
    schema: 'xj-044-self-capture-summary-v1',
    taskId: TASK,
    runId: identity.runId,
    evidenceRoot: identity.evidenceRoot,
    selfRoot,
    tools: metas.map(meta => ({ role: meta.role, verdict: meta.verdict, childExitCode: meta.childExitCode, stdoutPath: meta.stdoutPath, stderrPath: meta.stderrPath, metaPath: path.join(path.dirname(meta.stdoutPath), 'meta.json') })),
    allPass: metas.every(meta => meta.verdict === 'PASS'),
    finishedUtc: new Date().toISOString(),
  };
  writeJson(path.join(selfRoot, 'summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allPass) process.exitCode = 1;
}

main().catch(error => { console.error('SELF CAPTURE FATAL', error && error.stack || error); process.exitCode = 1; });
