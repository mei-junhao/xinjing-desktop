'use strict';
// health-fixture-probe.js — node-level stand-in probe for p1-health-gate.test.js.
// It is NOT production code: it exists only to drive the REAL health-check.js
// gate through real child processes. Scenario is selected via
// XJ_FIXTURE_SCENARIO; the marker path comes from XJ463_HEALTH_MARKER exactly
// like the real XJ463 contract.
const fs = require('fs');
const path = require('path');

const scenario = String(process.env.XJ_FIXTURE_SCENARIO || 'ok');
const markerPath = String(process.env.XJ463_HEALTH_MARKER || '');
const expectedVersion = String(process.env.XJ463_EXPECTED_VERSION || '');
const expectedChannel = String(process.env.XJ463_EXPECTED_CHANNEL || 'stable');
const expectedStrategy = String(process.env.XJ463_EXPECTED_STRATEGY || 'installer');
// Like the real probe (app.getVersion()), the marker version is the fixture's
// OWN observed version, never an echo of the expected value.
const OWN_VERSION = require('./package.json').version;

function writeMarker(marker) {
  if (!markerPath) return;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = markerPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(marker), 'utf8');
  fs.renameSync(tmp, markerPath);
}

function completeMarker(over) {
  return Object.assign({
    status: 'ok',
    version: OWN_VERSION,
    channel: expectedChannel,
    strategy: expectedStrategy,
    preloadOk: true,
    ipcOk: true,
    durableOk: true,
    migrationOk: true,
    journalOk: true,
    workflowOk: true,
    pid: process.pid
  }, over || {});
}

switch (scenario) {
  case 'ok':
    writeMarker(completeMarker());
    process.exit(0);
    break;
  case 'miss-field': {
    const m = completeMarker();
    delete m.workflowOk;
    writeMarker(m);
    process.exit(0);
    break;
  }
  case 'fake-false':
    writeMarker(completeMarker({ workflowOk: false }));
    process.exit(0);
    break;
  case 'ver-diff':
    writeMarker(completeMarker({ version: '0.0.1' }));
    process.exit(0);
    break;
  case 'chan-diff':
    writeMarker(completeMarker({ channel: expectedChannel === 'stable' ? 'beta' : 'stable' }));
    process.exit(0);
    break;
  case 'strat-diff':
    writeMarker(completeMarker({ strategy: expectedStrategy === 'installer' ? 'portable' : 'installer' }));
    process.exit(0);
    break;
  case 'fail-mark':
    writeMarker({ status: 'fail', code: 'durable-broken', pid: process.pid });
    process.exit(0);
    break;
  case 'no-mark':
    process.exit(0);
    break;
  case 'crash':
    process.exit(2);
    break;
  case 'hang':
    setTimeout(() => process.exit(0), 30000);
    break;
  default:
    process.exit(3);
}
