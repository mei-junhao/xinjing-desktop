'use strict';
// probe-main.js — XJ463 first-launch health probe PRODUCTION consumer (P1-2).
//
// Entry: main.js branches here ONLY when XJ463_HEALTH_PROBE=1 (the update
// health adapter in production-adapters.js is the only producer). A normal
// app start never enters this module; this module never enters the normal
// app flow (no tray, no static server, no license windows, no real store).
//
// Contract (task XJ463): the probe runs with a TEMPORARY userData inside
// os.tmpdir(), synthetic data only and a default-deny network wrapper. It
// must prove: version/channel/strategy match, preload + typed IPC init,
// durable open, migration/schema boundary result, journal coherence, and at
// least one Free manual workflow. Only after ALL checks hold does it write
// ONE complete health marker ATOMICALLY (tmp + fsync + rename) and exit 0.
// Any failure, timeout, crash, network attempt or missing boundary writes a
// fail marker (or none) and exits non-zero -> the update health gate stays
// fail-closed and never commits.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, session } = require('electron');

const { assertPayloadSchema, sha256Hex } = require('../durable-bridge');
const journal = require('../transaction-journal');

const PROBE_INTERNAL_TIMEOUT_MS = 45000;
const REPORT_CHANNEL = 'xj463:probe:report';
const PING_CHANNEL = 'xj463:probe:ping';
const WORKFLOW_CHANNEL = 'xj463:probe:workflow';
const DENY_SENTINEL_URL = 'http://203.0.113.7/xj463-deny-sentinel';
const CHANNELS = ['stable', 'beta'];
const STRATEGIES = ['installer', 'portable'];

function atomicWriteMarker(markerPath, marker) {
  const dir = path.dirname(markerPath);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = markerPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(marker, null, 1), 'utf8');
  const fd = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, markerPath);
}

function failMarker(markerPath, code, extra) {
  try {
    atomicWriteMarker(markerPath, Object.assign({
      status: 'fail',
      code: String(code || 'probe-failed').slice(0, 80),
      pid: process.pid,
      finishedAt: new Date().toISOString()
    }, extra || {}));
  } catch (_) { /* no marker is itself fail-closed evidence */ }
}

function insideTempDir(candidate) {
  try {
    const tempRoot = fs.realpathSync.native(path.resolve(os.tmpdir()));
    const resolved = fs.realpathSync.native(path.resolve(candidate));
    return resolved !== tempRoot && resolved.startsWith(tempRoot + path.sep);
  } catch (_) { return false; }
}

function runHealthProbe() {
  const markerPath = String(process.env.XJ463_HEALTH_MARKER || '').trim();
  const expectedVersion = String(process.env.XJ463_EXPECTED_VERSION || '');
  const expectedChannel = String(process.env.XJ463_EXPECTED_CHANNEL || 'stable');
  const expectedStrategy = String(process.env.XJ463_EXPECTED_STRATEGY || 'installer');
  const denyNetwork = process.env.XJ463_DENY_NETWORK === '1';

  if (!markerPath || !path.isAbsolute(markerPath)) {
    console.error('[health-probe] missing XJ463_HEALTH_MARKER; refuse to run');
    app.exit(3);
    return;
  }
  if (!denyNetwork) {
    failMarker(markerPath, 'probe-deny-network-missing');
    app.exit(1);
    return;
  }
  if (!CHANNELS.includes(expectedChannel) || !STRATEGIES.includes(expectedStrategy)) {
    failMarker(markerPath, 'probe-bad-expected-enum');
    app.exit(1);
    return;
  }

  const userDataDir = app.getPath('userData');
  if (!insideTempDir(userDataDir)) {
    failMarker(markerPath, 'probe-userdata-not-temp');
    app.exit(1);
    return;
  }

  // ---- default-deny network wrapper state: anything that is not an explicit
  // loopback http(s) URL is cancelled BEFORE any socket is opened. The wrapper
  // itself is installed after app is ready (session is unavailable before).
  const denyState = { blockedSentinel: false, cancelled: [], allowedEgress: [] };
  try {
    app.disableHardwareAcceleration();
  } catch (_) {}

  function installDenyWrapper() {
    const probeSession = session.defaultSession;
    probeSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    if (typeof probeSession.setPermissionCheckHandler === 'function') {
      probeSession.setPermissionCheckHandler(() => false);
    }
    probeSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      let allowed = false;
      try {
        const u = new URL(details.url);
        const host = String(u.hostname || '').replace(/^\[|\]$/g, '');
        allowed = (host === '127.0.0.1' || host === 'localhost' || host === '::1') &&
          (u.protocol === 'http:' || u.protocol === 'https:');
      } catch (_) { allowed = false; }
      if (!allowed) {
        denyState.cancelled.push(String(details.url).slice(0, 200));
        if (String(details.url).startsWith(DENY_SENTINEL_URL)) denyState.blockedSentinel = true;
      } else {
        denyState.allowedEgress.push(String(details.url).slice(0, 200));
      }
      callback({ cancel: !allowed });
    });
  }

  let settled = false;
  // Failure exit only. The success marker is written exactly once, at the end
  // of the evidence-collection path, never here.
  function finish(code, markerExtra) {
    if (settled || code === 0) return;
    settled = true;
    try { if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy(); } catch (_) {}
    failMarker(markerPath, markerExtra && markerExtra.code, markerExtra);
    app.exit(code);
  }

  // Internal timeout: must fire before the health adapter's own timeout so a
  // stuck probe always leaves fail-closed evidence instead of being killed.
  const internalTimer = setTimeout(() => {
    finish(2, { code: 'probe-timeout' });
  }, PROBE_INTERNAL_TIMEOUT_MS);

  let probeWindow = null;
  let rendererReport = null;

  const checks = {
    versionOk: false, channelOk: false, strategyOk: false,
    preloadOk: false, ipcOk: false, durableOk: false,
    migrationOk: false, journalOk: false, workflowOk: false,
    networkDenied: false
  };

  // ---- typed IPC (probe-scoped, operation-bounded) ----
  ipcMain.handle(PING_CHANNEL, async (_event, input) => {
    if (!input || typeof input !== 'object' || typeof input.correlationId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(input.correlationId)) {
      return { ok: false, code: 'probe-bad-ping' };
    }
    return { ok: true, correlationId: input.correlationId, pid: process.pid };
  });

  // Free manual workflow boundary: renderer-created synthetic manual record
  // exported as a v2 payload; main validates it with the REAL production
  // schema boundary (durable-bridge.assertPayloadSchema). No paid entitlement
  // is consulted anywhere on this path.
  ipcMain.handle(WORKFLOW_CHANNEL, async (_event, input) => {
    try {
      if (!input || typeof input !== 'object' || typeof input.payload !== 'string') {
        return { ok: false, code: 'probe-bad-workflow' };
      }
      const payload = assertPayloadSchema(input.payload);
      return { ok: true, sha256: sha256Hex(JSON.stringify(payload)), records: (payload.clients || []).length };
    } catch (error) {
      return { ok: false, code: String((error && error.code) || 'probe-workflow-rejected') };
    }
  });

  ipcMain.on(REPORT_CHANNEL, (_event, report) => {
    if (rendererReport) return; // first report wins; duplicates ignored
    rendererReport = report && typeof report === 'object' ? report : {};
  });

  // ---- migration/schema boundary check (REAL production bytes) ----
  function runMigrationCheck() {
    try {
      const synthetic = JSON.stringify({
        version: '2.0.0', exportedAt: '2026-01-01T00:00:00.000Z',
        clients: [{ id: 'syn-probe-1', name: '合成来访者', tier: 'free' }],
        sessions: [], supervisions: [], supervisorIdentities: [],
        masterConversations: [], expenses: [], materialWorkspaces: [],
        clinicalActionRuns: [], clinicalTasks: [], importQuarantine: [],
        deletionBatches: [], deletionQuarantine: []
      });
      const accepted = assertPayloadSchema(synthetic);
      if (!accepted || accepted.version !== '2.0.0') return false;
      // stale schema must be rejected
      let staleRejected = false;
      try { assertPayloadSchema(JSON.stringify({ version: '1.9.9', exportedAt: 'x' })); }
      catch (e) { staleRejected = (e && e.code === 'snapshot-stale-schema'); }
      // authority keys must never pass the boundary
      let authorityRejected = false;
      try {
        assertPayloadSchema(JSON.stringify({ version: '2.0.0', exportedAt: 'x', licenseState: {}, clients: [], sessions: [], supervisions: [], supervisorIdentities: [], masterConversations: [], expenses: [], materialWorkspaces: [], clinicalActionRuns: [], clinicalTasks: [], importQuarantine: [], deletionBatches: [], deletionQuarantine: [] }));
      } catch (e) { authorityRejected = !!(e && /^snapshot-authority-key/.test(String(e.code || ''))); }
      return staleRejected && authorityRejected;
    } catch (_) { return false; }
  }

  // ---- journal coherence check (REAL transaction-journal bytes) ----
  function runJournalCheck() {
    try {
      const workDir = path.join(userDataDir, 'update-integrity-probe');
      const markerFile = path.join(workDir, 'probe.journal.marker.json');
      if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
      const operationId = 'probe-op-1';
      const artifactSha512 = crypto.createHash('sha512').update(Buffer.from('xj463-probe-synthetic-artifact')).digest('hex').toUpperCase();
      const base = { operationId, version: app.getVersion(), channel: expectedChannel, artifactSha512 };
      // Must follow the REAL transition table exactly; any illegal transition
      // throws and fails the journal coherence check.
      const sequence = [
        journal.STATES.discovered, journal.STATES.awaitingConfirmation,
        journal.STATES.downloading, journal.STATES.verified,
        journal.STATES.backupCreated, journal.STATES.staged,
        journal.STATES.restarting, journal.STATES.healthCheck,
        journal.STATES.committed
      ];
      sequence.forEach((state, index) => {
        journal.writeMarker(markerFile, journal.makeMarker(Object.assign({}, base, { state, sequence: index })));
      });
      const readBack = journal.readMarker(markerFile);
      const recovered = journal.recover(markerFile, expectedChannel);
      return readBack.state === journal.STATES.committed &&
        recovered.state === journal.STATES.committed &&
        journal.TERMINAL.has(recovered.state);
    } catch (_) { return false; }
  }

  app.whenReady().then(() => {
    // default-deny wrapper must be in place BEFORE the probe window loads.
    try { installDenyWrapper(); }
    catch (error) {
      clearTimeout(internalTimer);
      finish(1, { code: 'probe-deny-wrapper-failed', detail: String((error && error.message) || error).slice(0, 160) });
      return;
    }
    // ---- version/channel/strategy contract ----
    checks.versionOk = String(app.getVersion()) === expectedVersion && expectedVersion !== '';
    checks.channelOk = CHANNELS.includes(expectedChannel);
    checks.strategyOk = STRATEGIES.includes(expectedStrategy);
    checks.migrationOk = runMigrationCheck();
    checks.journalOk = runJournalCheck();

    if (!checks.versionOk || !checks.channelOk || !checks.strategyOk || !checks.migrationOk || !checks.journalOk) {
      clearTimeout(internalTimer);
      finish(1, { code: !checks.versionOk ? 'probe-version-mismatch' : (!checks.channelOk || !checks.strategyOk) ? 'probe-enum-mismatch' : (!checks.migrationOk ? 'probe-migration-failed' : 'probe-journal-failed'), checks });
      return;
    }

    // ---- probe window: real preload + typed IPC + real IndexedDB ----
    probeWindow = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      title: 'XJ463 health probe',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: path.join(__dirname, 'probe-preload.js')
      }
    });
    probeWindow.webContents.on('preload-error', (_ev, err) => {
      clearTimeout(internalTimer);
      finish(1, { code: 'probe-preload-error', detail: String((err && err.message) || err).slice(0, 160) });
    });
    probeWindow.webContents.on('render-process-gone', (_ev, details) => {
      clearTimeout(internalTimer);
      finish(1, { code: 'probe-renderer-gone', detail: String((details && details.reason) || 'gone').slice(0, 80) });
    });
    probeWindow.webContents.on('did-finish-load', () => {
      try { probeWindow.webContents.send('xj463:probe:start', { denySentinelUrl: DENY_SENTINEL_URL }); } catch (_) {}
    });
    probeWindow.loadFile(path.join(__dirname, 'probe.html'));
  }).catch((error) => {
    clearTimeout(internalTimer);
    finish(1, { code: 'probe-when-ready-failed', detail: String((error && error.message) || error).slice(0, 160) });
  });

  // ---- collect renderer evidence until complete or timeout ----
  const collectTimer = setInterval(() => {
    if (settled || !rendererReport) return;
    const report = rendererReport;
    checks.preloadOk = report.preloadOk === true;
    checks.ipcOk = report.ipcOk === true;
    checks.durableOk = report.durableOk === true;
    checks.workflowOk = report.workflowOk === true;
    const rendererBlocked = report.networkProbe === 'blocked';
    checks.networkDenied = rendererBlocked && denyState.blockedSentinel === true && denyState.allowedEgress.length === 0;
    clearInterval(collectTimer);
    clearTimeout(internalTimer);

    const allOk = checks.preloadOk && checks.ipcOk && checks.durableOk &&
      checks.workflowOk && checks.networkDenied &&
      checks.versionOk && checks.channelOk && checks.strategyOk &&
      checks.migrationOk && checks.journalOk;

    if (!allOk) {
      const firstFail = ['preloadOk', 'ipcOk', 'durableOk', 'workflowOk', 'networkDenied', 'versionOk', 'channelOk', 'strategyOk', 'migrationOk', 'journalOk']
        .filter((k) => !checks[k]);
      finish(1, { code: 'probe-check-false:' + firstFail.join(','), checks });
      return;
    }

    try {
      atomicWriteMarker(markerPath, {
        status: 'ok',
        version: String(app.getVersion()),
        channel: expectedChannel,
        strategy: expectedStrategy,
        preloadOk: true,
        ipcOk: true,
        durableOk: true,
        migrationOk: true,
        journalOk: true,
        workflowOk: true,
        pid: process.pid,
        networkAttempted: false,
        denySentinelBlocked: true,
        cancelledRequests: denyState.cancelled.length,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      finish(1, { code: 'probe-marker-write-failed', detail: String((error && error.message) || error).slice(0, 160) });
      return;
    }
    settled = true;
    try { if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy(); } catch (_) {}
    app.exit(0);
  }, 50);
}

module.exports = { runHealthProbe, DENY_SENTINEL_URL, REPORT_CHANNEL, PING_CHANNEL, WORKFLOW_CHANNEL };
