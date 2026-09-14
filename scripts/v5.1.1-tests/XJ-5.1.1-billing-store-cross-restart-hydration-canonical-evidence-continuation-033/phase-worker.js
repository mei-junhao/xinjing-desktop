'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const {
  PROJECT_ROOT,
  SCRIPT_ROOT,
  FIXED_ORIGIN,
  ELECTRON_PATH,
  runChild,
  parseJsonLines,
  nowUtc,
  ensureDir
} = require('./common');

const TASK_DIR_NAME = path.basename(SCRIPT_ROOT);
const FIXTURE_PATH = '/scripts/v5.1.1-tests/' + TASK_DIR_NAME + '/store-fixture.html';
const FIXED_PORT = 19503;

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const runId = argValue('--run-id', 'run-033-unknown');
const runRoot = path.resolve(argValue('--run-root', ''));
const caseId = argValue('--case-id', 'core');
const stage = argValue('--stage', 'core');
const mutation = argValue('--mutation', '');

function staticServer() {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', FIXED_ORIGIN);
      let pathname = decodeURIComponent(requestUrl.pathname || '/');
      if (pathname === '/') pathname = FIXTURE_PATH;
      const resolved = path.resolve(PROJECT_ROOT, '.' + path.normalize(pathname));
      const relative = path.relative(PROJECT_ROOT, resolved);
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      let realPath;
      try { realPath = fs.realpathSync(resolved); } catch (error) {
        response.writeHead(404);
        response.end('Not Found');
        return;
      }
      const realRelative = path.relative(fs.realpathSync(PROJECT_ROOT), realPath);
      if (!realRelative || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      if (!fs.statSync(realPath).isFile()) {
        response.writeHead(404);
        response.end('Not Found');
        return;
      }
      const ext = path.extname(realPath).toLowerCase();
      const contentType = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      fs.createReadStream(realPath).pipe(response);
    } catch (error) {
      response.writeHead(500);
      response.end('Internal Error');
    }
  });
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function childUrl(role) {
  const params = new URLSearchParams({ runId: runId, caseId: caseId, stage: stage, role: role });
  if (mutation) params.set('mutation', mutation);
  return FIXED_ORIGIN + FIXTURE_PATH + '?' + params.toString();
}

function profilePath(root, stageName, variant) {
  const token = crypto.createHash('sha256')
    .update(String(caseId) + '|' + String(stageName) + '|' + String(variant))
    .digest('hex')
    .slice(0, 12);
  return path.join(root, 'p', token, variant);
}

function compactChild(child) {
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString('utf8'),
    stderr: child.stderr.toString('utf8')
  };
}

function fixtureResult(child) {
  const values = parseJsonLines(child.stdout.toString('utf8')).filter((value) => value && value.type === 'fixture-result');
  return values.length ? values[values.length - 1] : null;
}

async function runElectron(role, userData) {
  ensureDir(userData);
  const url = childUrl(role);
  const child = await runChild(ELECTRON_PATH, [path.join(SCRIPT_ROOT, 'fixture-electron.js')], {
    cwd: PROJECT_ROOT,
    env: {
      XJ_FIXTURE_URL: url,
      XJ_USER_DATA: userData,
      XJ_PHASE_RUN_ID: runId,
      XJ_PHASE_CASE_ID: caseId,
      XJ_PHASE_STAGE: stage
    }
  });
  return { role: role, origin: FIXED_ORIGIN, url: url, userData: userData, ...compactChild(child), fixtureResult: fixtureResult(child) };
}

async function runPhase() {
  const fixed = staticServer();
  try {
    await listen(fixed, FIXED_PORT);
    ensureDir(path.join(runRoot, 'contexts', caseId, stage));
    const writerData = profilePath(runRoot, stage, 'w');
    const readerData = mutation === 'cross-userdata-origin' ? profilePath(runRoot, stage, 'r') : writerData;
    ensureDir(writerData);
    ensureDir(readerData);
    const writer = await runElectron('writer', writerData);
    const reader = await runElectron('reader', readerData);
    const readerResult = reader.fixtureResult && reader.fixtureResult.result;
    const writerResult = writer.fixtureResult && writer.fixtureResult.result;
    const semanticPass = !!(reader.exitCode === 0 && readerResult && readerResult.ok === true &&
      readerResult.counts && readerResult.counts.clients === 1 && readerResult.counts.sessions >= 1 &&
      readerResult.counts.monthlyPayments === 1 && readerResult.counts.amount === 520);
    const verdict = stage === 'mutated' ? (semanticPass ? 'FAIL' : 'REJECTED') : (semanticPass ? 'PASS' : 'FAIL');
    process.stdout.write(JSON.stringify({
      type: 'phase-summary',
      runId: runId,
      caseId: caseId,
      stage: stage,
      mutation: mutation,
      fixedOrigin: FIXED_ORIGIN,
      denyNetwork: true,
      writerContext: { userData: writerData, origin: FIXED_ORIGIN },
      readerContext: { userData: readerData, origin: FIXED_ORIGIN },
      writer: { exitCode: writer.exitCode, result: writerResult, stdout: writer.stdout, stderr: writer.stderr },
      reader: { exitCode: reader.exitCode, result: readerResult, stdout: reader.stdout, stderr: reader.stderr },
      semanticPass: semanticPass,
      verdict: verdict,
      generatedAt: nowUtc()
    }) + String.fromCharCode(10));
    return verdict === 'PASS' ? 0 : 2;
  } finally {
    await closeServer(fixed);
  }
}

runPhase().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'phase-error', message: String((error && error.message) || error), stack: String((error && error.stack) || '') }) + String.fromCharCode(10));
  process.exitCode = 1;
});
