'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const {
  PROJECT_ROOT,
  SCRIPT_ROOT,
  FIXED_ORIGIN,
  WRONG_ORIGIN,
  ELECTRON_PATH,
  runChild,
  parseJsonLines,
  nowUtc,
  ensureDir,
} = require('./common');

const TASK_DIR_NAME = path.basename(SCRIPT_ROOT);
const FIXTURE_PATH = '/scripts/v5.1.1-tests/' + TASK_DIR_NAME + '/store-fixture.html';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const runId = argValue('--run-id', 'run-029-unknown');
const runRoot = path.resolve(argValue('--run-root', path.join(PROJECT_ROOT, 'qa/task-scratch', 'XJ-029-missing-root')));
const caseId = argValue('--case-id', 'core');
const stage = argValue('--stage', 'core');
const mutation = argValue('--mutation', '');

function staticServer(port) {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:' + port);
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
      try { realPath = fs.realpathSync(resolved); } catch (_) {
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
      const contentType = ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
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

function childUrl(origin, role) {
  const params = new URLSearchParams({ runId, caseId, stage, role });
  if (mutation) params.set('mutation', mutation);
  return origin + FIXTURE_PATH + '?' + params.toString();
}

function profilePath(root, caseId, stage, variant) {
  const token = crypto.createHash('sha256')
    .update(String(caseId) + '\0' + String(stage) + '\0' + String(variant))
    .digest('hex')
    .slice(0, 12);
  return path.join(root, 'p', token, variant);
}

function compactChild(child) {
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString('utf8'),
    stderr: child.stderr.toString('utf8'),
  };
}

function fixtureResult(child) {
  const values = parseJsonLines(child.stdout.toString('utf8')).filter((value) => value && value.type === 'fixture-result');
  return values.length ? values[values.length - 1] : null;
}

async function runElectron(role, origin, userData) {
  ensureDir(userData);
  const url = childUrl(origin, role);
  const child = await runChild(ELECTRON_PATH, [path.join(SCRIPT_ROOT, 'fixture-electron.js')], {
    cwd: PROJECT_ROOT,
    env: {
      XJ_FIXTURE_URL: url,
      XJ_USER_DATA: userData,
      XJ_PHASE_RUN_ID: runId,
      XJ_PHASE_CASE_ID: caseId,
      XJ_PHASE_STAGE: stage,
    },
  });
  return { role, origin, url, userData, ...compactChild(child), fixtureResult: fixtureResult(child) };
}

async function runPhase() {
  const fixed = staticServer(19431);
  const alternate = mutation === 'cross-userdata-origin' ? staticServer(19432) : null;
  const acceptance = stage === 'core' ? staticServer(0) : null;
  let fixedAddress;
  let alternateAddress;
  let acceptanceAddress;
  try {
    fixedAddress = await listen(fixed, 19431);
    if (alternate) alternateAddress = await listen(alternate, 19432);
    if (acceptance) acceptanceAddress = await listen(acceptance, 0);
    const contextDir = ensureDir(path.join(runRoot, 'contexts', caseId, stage));
    // Keep the evidence context directory human-readable, but use a compact
    // profile path so Chromium's IndexedDB LevelDB path stays below Windows'
    // legacy path limit even when the run root carries the full task/run ID.
    const writerData = profilePath(runRoot, caseId, stage, 'w');
    const readerData = mutation === 'cross-userdata-origin'
      ? profilePath(runRoot, caseId, stage, 'r')
      : writerData;
    ensureDir(writerData);
    ensureDir(readerData);
    const readerOrigin = mutation === 'cross-userdata-origin' ? WRONG_ORIGIN : FIXED_ORIGIN;
    const writer = await runElectron('writer', FIXED_ORIGIN, writerData);
    const reader = await runElectron('reader', readerOrigin, readerData);
    const readerResult = reader.fixtureResult && reader.fixtureResult.result;
    const writerResult = writer.fixtureResult && writer.fixtureResult.result;
    const semanticPass = !!(reader.exitCode === 0 && readerResult && readerResult.ok === true &&
      readerResult.counts && readerResult.counts.clients === 1 && readerResult.counts.sessions >= 1 &&
      readerResult.counts.monthlyPayments === 1 && readerResult.counts.amount === 520);
    const verdict = stage === 'mutated' ? (semanticPass ? 'FAIL' : 'REJECTED') : (semanticPass ? 'PASS' : 'FAIL');
    process.stdout.write(JSON.stringify({
      type: 'phase-summary',
      runId,
      caseId,
      stage,
      mutation,
      fixedOrigin: FIXED_ORIGIN,
      actualFixedOrigin: 'http://' + fixedAddress.address + ':' + fixedAddress.port,
      productionAcceptanceListen0Origin: acceptanceAddress ? 'http://' + acceptanceAddress.address + ':' + acceptanceAddress.port : null,
      alternateOrigin: alternateAddress ? 'http://' + alternateAddress.address + ':' + alternateAddress.port : null,
      denyNetwork: true,
      writerContext: { userData: writerData, origin: FIXED_ORIGIN },
      readerContext: { userData: readerData, origin: readerOrigin },
      writer: { exitCode: writer.exitCode, result: writerResult, stdout: writer.stdout.toString('utf8'), stderr: writer.stderr.toString('utf8') },
      reader: { exitCode: reader.exitCode, result: readerResult, stdout: reader.stdout.toString('utf8'), stderr: reader.stderr.toString('utf8') },
      semanticPass,
      verdict,
      generatedAt: nowUtc(),
    }) + '\n');
    // A mutated phase is a deliberately rejected child-process run.  Its
    // non-zero exit is part of the evidence contract and must reach the
    // parent runner instead of being represented only by a JSON verdict.
    return verdict === 'PASS' ? 0 : 2;
  } finally {
    await closeServer(acceptance);
    await closeServer(alternate);
    await closeServer(fixed);
  }
}

runPhase().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(JSON.stringify({ type: 'phase-error', message: String(error && error.message || error), stack: String(error && error.stack || '') }) + '\n');
  process.exitCode = 1;
});
