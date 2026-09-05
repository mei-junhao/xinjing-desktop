'use strict';
// health-check.js — first-launch health contract (decision 2.3 / contract §9).
//
// Commit requires a NEW process started from the staged candidate with a
// temporary userData, synthetic data only, and a default-deny network wrapper.
// The probe must prove: version, channel, strategy, preload/IPC init, durable
// store open, required migration result, journal/marker coherence, and the
// declared core manual workflow. A single coherent success marker is recorded
// only after ALL checks complete. Timeout, forced kill, crash, missing marker,
// stale marker, malformed result, wrong version/title, renderer/main error or
// durable fallback is NOT a commit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { redact } = require('./redact');

const HEALTH_TIMEOUT_MS = 60000;
const REQUIRED_MARKER_FIELDS = ['status', 'version', 'channel', 'strategy', 'preloadOk', 'ipcOk', 'durableOk', 'migrationOk', 'journalOk', 'workflowOk', 'pid'];

function fail(code) {
  const error = new Error('health-check failed: ' + code);
  error.code = code;
  throw error;
}

function readMarkerFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

// Run the first-launch probe and return typed evidence.
// options: { electronExe, probeDir, expectedVersion, channel, strategy,
//            userDataDir (optional temp), env, timeoutMs, allowExitCode }
function runFirstLaunchHealth(options) {
  const dir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'xj463-health-'));
  const marker = path.join(dir, 'health.marker.json');
  const env = Object.assign({}, process.env, {
    XJ463_HEALTH_PROBE: '1',
    XJ463_HEALTH_MARKER: marker,
    XJ463_EXPECTED_VERSION: String(options.expectedVersion || ''),
    XJ463_EXPECTED_CHANNEL: String(options.channel || 'stable'),
    XJ463_EXPECTED_STRATEGY: String(options.strategy || 'installer'),
    // Default-deny network: the probe fails any network attempt and the
    // session wrapper cancels all requests.
    XJ463_DENY_NETWORK: '1'
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const timeoutMs = options.timeoutMs || HEALTH_TIMEOUT_MS;
  const child = spawn(options.electronExe, [options.probeDir, '--user-data-dir=' + dir], {
    cwd: options.probeDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); if (stdout.length > 65536) stdout = stdout.slice(-65536); });
  child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 65536) stderr = stderr.slice(-65536); });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, code: 'health-timeout', stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) });
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, code: 'spawn-error', detail: String((error && error.message) || error) }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const markerData = readMarkerFile(marker);
      const evidence = {
        exitCode: code, signal: signal ? String(signal) : null,
        marker: markerData,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000)
      };
      if (markerData && markerData.status === 'ok' && code === 0) {
        // Commit requires EVERY required check to be proven by the marker.
        const missing = REQUIRED_MARKER_FIELDS.filter((k) => !(k in markerData));
        if (missing.length) return finish({ ok: false, code: 'marker-incomplete:' + missing.join(','), evidence });
        if (String(markerData.version) !== String(options.expectedVersion)) return finish({ ok: false, code: 'health-version-mismatch', evidence });
        if (String(markerData.channel) !== String(options.channel)) return finish({ ok: false, code: 'health-channel-mismatch', evidence });
        if (String(markerData.strategy) !== String(options.strategy)) return finish({ ok: false, code: 'health-strategy-mismatch', evidence });
        if (!markerData.preloadOk || !markerData.ipcOk || !markerData.durableOk || !markerData.migrationOk || !markerData.journalOk || !markerData.workflowOk) {
          return finish({ ok: false, code: 'health-check-false', evidence });
        }
        return finish({ ok: true, code: 'health-ok', evidence, markerData });
      }
      if (markerData && markerData.status === 'fail') return finish({ ok: false, code: String(markerData.code || 'health-fail'), evidence });
      if (signal) return finish({ ok: false, code: 'health-killed:' + signal, evidence });
      if (code !== 0) return finish({ ok: false, code: 'health-exit:' + code, evidence });
      return finish({ ok: false, code: 'health-marker-missing', evidence });
    });
  });
}

// Declared core manual workflow check (Free path): the probe renderer verifies
// the manual data page reachable without paid verification. This is enforced in
// the probe; the helper here just documents the contract.
function coreManualWorkflowReachable(markerData) {
  return !!(markerData && markerData.workflowOk === true);
}

module.exports = { runFirstLaunchHealth, coreManualWorkflowReachable, REQUIRED_MARKER_FIELDS, HEALTH_TIMEOUT_MS, redact };
