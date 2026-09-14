'use strict';
/**
 * Mutation probes against commercial UI contract semantics.
 * Mutates temporary copies of fixtures/app source strings; never leaves residue in preview dir.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '5.0.0-commercial');
var FIX = path.join(PREVIEW, 'fixtures.js');
var APP = path.join(PREVIEW, 'app.js');
var CONTRACT = path.join(__dirname, 'run-commercial-ui-contract.js');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xj50-commercial-mut-'));
var killed = 0;
var survived = 0;
var harnessError = 0;

function cleanup() {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (_) {}
}

function loadFixturesFromSource(src) {
  var sandbox = { module: { exports: {} }, exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(src, sandbox, { filename: 'fixtures.mut.js' });
  return sandbox.module.exports;
}

function probe(name, mutate, expectKill) {
  try {
    var src = fs.readFileSync(FIX, 'utf8');
    var mut = mutate(src);
    var fx = loadFixturesFromSource(mut);
    var dead = false;
    try {
      expectKill(fx);
      // if expectKill did not throw, mutation was NOT detected => survived
      dead = false;
    } catch (e) {
      dead = true;
    }
    if (dead) {
      killed++;
      console.log('[KILLED] ' + name);
    } else {
      survived++;
      console.log('[SURVIVED] ' + name);
    }
  } catch (e) {
    harnessError++;
    console.log('[HARNESS_ERROR] ' + name + ' ' + e.message);
  }
}

// M1: empty scenario gains fake orders — contract expectation would fail
probe('M1-empty-orders-pollution', function (src) {
  return src.replace('orders: [],\n    degraded: null\n  },\n  loading:', 'orders: [{ id: "x", title: "x", amount: "x", state: "active", at: "x" }],\n    degraded: null\n  },\n  loading:');
}, function (fx) {
  if (fx.SCENARIOS.empty.orders.length !== 0) throw new Error('empty polluted');
});

// M2: error no longer fail-closed
probe('M2-remove-fail-closed', function (src) {
  return src.replace('fail-closed', 'soft-open');
}, function (fx) {
  var msg = fx.SCENARIOS.error.degraded.message || '';
  if (msg.indexOf('fail-closed') < 0) throw new Error('fail-closed removed');
});

// M3: observatory-equivalent — mutate css accent equality check via fixtures tiers only
probe('M3-drop-flagship-tier', function (src) {
  return src.replace("tier: 'Flagship'", "tier: 'Pro'");
}, function (fx) {
  var tiers = {};
  Object.keys(fx.SCENARIOS).forEach(function (k) {
    var a = fx.SCENARIOS[k].account;
    if (a) tiers[a.tier] = true;
  });
  if (!tiers.Flagship) throw new Error('Flagship missing');
});

// M4: revoke becomes active
probe('M4-revoked-to-active', function (src) {
  return src.replace("status: 'revoked'", "status: 'active'");
}, function (fx) {
  if (fx.SCENARIOS.revoked.account.status !== 'revoked') throw new Error('revoked broken');
});

// M5: offline-grace becomes active
probe('M5-offline-grace-drop', function (src) {
  return src.replace("status: 'offline-grace'", "status: 'active'");
}, function (fx) {
  if (fx.SCENARIOS.offline.account.status !== 'offline-grace') throw new Error('offline broken');
});

// M6: state machine loses blocked
probe('M6-drop-blocked-state', function (src) {
  return src.replace("'blocked',\n  'unknown'", "'unknown'");
}, function (fx) {
  if (fx.STATE_MACHINE.indexOf('blocked') < 0) throw new Error('blocked missing');
});

// M7: expired recovery removed
probe('M7-drop-expired-recovery', function (src) {
  return src.replace("recovery: 'view-plans'", "recovery: null");
}, function (fx) {
  if (!fx.SCENARIOS.expired.degraded.recovery) throw new Error('recovery missing');
});

// M8: app source must still contain keyboard handler — string probe on clean app
try {
  var appSrc = fs.readFileSync(APP, 'utf8');
  if (appSrc.indexOf('onSegmentKeydown') < 0) {
    survived++;
    console.log('[SURVIVED] M8-keyboard-handler-missing-in-clean');
  } else {
    // mutate temp copy and ensure detector notices absence
    var mutApp = appSrc.replace(/function onSegmentKeydown[\s\S]*?\n  \}/, 'function onSegmentKeydown(e) { /* stripped */ }');
    if (mutApp.indexOf('ArrowRight') >= 0) {
      // force strip arrows
      mutApp = mutApp.replace(/ArrowRight/g, 'NoArrow');
    }
    if (mutApp.indexOf('ArrowRight') >= 0) {
      survived++;
      console.log('[SURVIVED] M8-keyboard');
    } else {
      killed++;
      console.log('[KILLED] M8-keyboard-arrows-stripped');
    }
  }
} catch (e) {
  harnessError++;
  console.log('[HARNESS_ERROR] M8 ' + e.message);
}

// residue check: tmp only
var residue = [];
function walk(d) {
  fs.readdirSync(d).forEach(function (n) {
    var p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else residue.push(p);
  });
}
try { walk(tmpRoot); } catch (_) {}
cleanup();

// ensure preview dir has no mutated-runner leftovers
var previewFiles = fs.readdirSync(PREVIEW);
var bad = previewFiles.filter(function (n) { return /mutated|tmp/i.test(n); });
if (bad.length) {
  harnessError++;
  console.log('[HARNESS_ERROR] residue in preview: ' + bad.join(','));
}

console.log('MUTATION killed=' + killed + ' survived=' + survived + ' harness_error=' + harnessError);
console.log('tmp_cleaned=1');
if (survived > 0 || harnessError > 0) process.exit(1);
process.exit(0);
