'use strict';
// p1-health-gate.test.js — P1-2 behavioral regression (node-level): the REAL
// health-check.js gate must accept ONLY a complete coherent marker produced by
// a real child process and must fail closed on every defect class. Children
// are REAL spawned processes (process.execPath running a fixture probe) —
// runFirstLaunchHealth itself is never mocked. Also proves the REAL
// production health adapter (createHealthAdapter) spawns a real child and
// consumes its real marker (kills the "skip probe" defect class).
const fs = require('fs');
const path = require('path');
const { Suite, tmpDir } = require('./_testkit');
const { runFirstLaunchHealth, REQUIRED_MARKER_FIELDS } = require('../../../app/update/health-check');
const { createHealthAdapter } = require('../../../app/update/production-adapters');

const s = new Suite('p1-health-gate');
// health-check.js spawns `electronExe [probeDir, --user-data-dir]` with
// cwd=probeDir, exactly like an Electron app dir. The fixture is therefore a
// minimal app directory (package.json main) executed by the real node binary.
const FIXTURE = path.join(__dirname, 'support', 'health-fixture-app');

function setScenario(name) { process.env.XJ_FIXTURE_SCENARIO = name; }

function runHealth(over = {}) {
  return runFirstLaunchHealth(Object.assign({
    electronExe: process.execPath,
    probeDir: FIXTURE,
    expectedVersion: '9.9.9',
    channel: 'stable',
    strategy: 'installer',
    timeoutMs: 15000
  }, over));
}

(async () => {
  if (!fs.existsSync(path.join(FIXTURE, 'main.js')) || !fs.existsSync(path.join(FIXTURE, 'package.json'))) { console.error('fixture missing: ' + FIXTURE); process.exit(1); }

  // H1: complete marker + exit 0 -> health-ok (the ONLY success path).
  setScenario('ok');
  const h1 = await runHealth();
  s.ok('H1 complete marker from real child -> health-ok', h1.ok === true && h1.code === 'health-ok' && h1.evidence && h1.evidence.exitCode === 0, JSON.stringify({ ok: h1.ok, code: h1.code }));
  s.ok('H1 marker carries every required field', h1.markerData && REQUIRED_MARKER_FIELDS.every((k) => k in h1.markerData), JSON.stringify(Object.keys(h1.markerData || {})));
  s.ok('H1 marker pid is the REAL child pid (not this process)', h1.markerData && Number.isFinite(h1.markerData.pid) && h1.markerData.pid !== process.pid, 'pid=' + (h1.markerData || {}).pid);

  // H2: missing required field -> marker-incomplete, never health-ok.
  setScenario('miss-field');
  const h2 = await runHealth();
  s.ok('H2 missing marker field rejected', h2.ok === false && /^marker-incomplete:/.test(String(h2.code)) && /workflowOk/.test(String(h2.code)), JSON.stringify({ code: h2.code }));

  // H3: fake status:ok with a false check -> health-check-false.
  setScenario('fake-false');
  const h3 = await runHealth();
  s.ok('H3 fake ok with false workflow rejected', h3.ok === false && h3.code === 'health-check-false', JSON.stringify({ code: h3.code }));

  // H4: version mismatch -> health-version-mismatch.
  setScenario('ver-diff');
  const h4 = await runHealth();
  s.ok('H4 version mismatch rejected', h4.ok === false && h4.code === 'health-version-mismatch', JSON.stringify({ code: h4.code }));

  // H5: channel mismatch -> health-channel-mismatch.
  setScenario('chan-diff');
  const h5 = await runHealth();
  s.ok('H5 channel mismatch rejected', h5.ok === false && h5.code === 'health-channel-mismatch', JSON.stringify({ code: h5.code }));

  // H6: strategy mismatch -> health-strategy-mismatch.
  setScenario('strat-diff');
  const h6 = await runHealth();
  s.ok('H6 strategy mismatch rejected', h6.ok === false && h6.code === 'health-strategy-mismatch', JSON.stringify({ code: h6.code }));

  // H7: explicit fail marker propagates its code, never success.
  setScenario('fail-mark');
  const h7 = await runHealth();
  s.ok('H7 fail marker never succeeds', h7.ok === false && h7.code === 'durable-broken', JSON.stringify({ code: h7.code }));

  // H8: no marker at all -> health-marker-missing.
  setScenario('no-mark');
  const h8 = await runHealth();
  s.ok('H8 missing marker rejected', h8.ok === false && h8.code === 'health-marker-missing', JSON.stringify({ code: h8.code }));

  // H9: child crash (exit 2, no marker) -> health-exit:2.
  setScenario('crash');
  const h9 = await runHealth();
  s.ok('H9 crashing child rejected', h9.ok === false && h9.code === 'health-exit:2', JSON.stringify({ code: h9.code }));

  // H10: hanging child -> health-timeout (kill enforced by the gate).
  setScenario('hang');
  const t10 = Date.now();
  const h10 = await runHealth({ timeoutMs: 2000 });
  s.ok('H10 timeout fails closed', h10.ok === false && h10.code === 'health-timeout' && (Date.now() - t10) < 12000, JSON.stringify({ code: h10.code, ms: Date.now() - t10 }));

  // H11: REAL production adapter spawns a real child and consumes its marker.
  setScenario('ok');
  const adapter = createHealthAdapter({ electronExe: process.execPath, probeDir: FIXTURE, appVersion: '9.9.9', healthTimeoutMs: 15000 });
  const h11 = await adapter(null, { channel: 'stable', strategy: 'installer' });
  s.ok('H11 real adapter health-ok through real child', h11.ok === true && h11.code === 'health-ok', JSON.stringify({ ok: h11.ok, code: h11.code }));
  s.ok('H11 adapter evidence bound to spawned child', h11.evidence && Number.isFinite(h11.evidence.exitCode) && h11.markerData && h11.markerData.pid !== process.pid, JSON.stringify({ pid: (h11.markerData || {}).pid }));

  // H12: adapter with wrong expected version -> mismatch, never commit-grade.
  setScenario('ok');
  const adapterBad = createHealthAdapter({ electronExe: process.execPath, probeDir: FIXTURE, appVersion: '0.0.1', healthTimeoutMs: 15000 });
  const h12 = await adapterBad(null, { channel: 'stable', strategy: 'installer' });
  s.ok('H12 adapter version mismatch fails closed', h12.ok === false && (h12.code === 'health-version-mismatch' || /^marker-incomplete/.test(String(h12.code))), JSON.stringify({ code: h12.code }));

  delete process.env.XJ_FIXTURE_SCENARIO;
  console.log('P1_HEALTH_GATE_STATUS=' + (s.fail === 0 ? 'PASS' : 'FAIL'));
  process.exit(s.finish() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
