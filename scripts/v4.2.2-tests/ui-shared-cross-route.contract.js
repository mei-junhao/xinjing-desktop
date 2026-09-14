#!/usr/bin/env node
'use strict';
/**
 * XJ-4.2.2-opensquilla-ui-shared-cross-route-contract-rework-04
 *
 * Rework fixes:
 *  [1] Mutation verifies source changed (no-op → flagged, NOT killed)
 *  [2] Syntax errors → SYNTAX-ERROR, NOT killed
 *  [3] removeAssert → disableStringCheck (targets real !isString(actual))
 *  [4] fakeRoute → fakeSkin (syntactically valid, changes SKINS array)
 *  [5] Baseline 0-fail verified before mutations
 *  [6] runCoreTests validates IconButton aria-label via validateComponent
 *  [7] 5 separate categories: killed, survived, no-op, syntax-error, harness-error
 *  [8] Any non-killed → non-zero exit
 *  [9] T43 self-test: inherited failure, not touched
 * [10] Fresh internal adversarial review
 *
 * Exit: 0 = ALL_GREEN (10 killed, 0 survived/no-op/syntax/harness) | 1 = BROKEN
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var FIXTURES = require('./ui-shared-cross-route.fixtures.js');

var passed = 0, failed = 0, blocked = 0;
var results = [];
var mutKilled = 0, mutSurvived = 0, mutNoop = 0, mutSyntaxErr = 0, mutHarnessErr = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function test(name, fn) {
  try { fn(); results.push('[PASS] ' + name); passed++; }
  catch (e) { results.push('[FAIL] ' + name + ' — ' + e.message); failed++; }
}

// ── Load real production sources ──
function loadContract(src) {
  var sandbox = { module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ui-contract.js' });
  return sandbox.module.exports;
}

var UI_CONTRACT_PATH = path.join(ROOT, 'app', 'js', 'ui-contract.js');
var UI_CONTRACT_SRC = fs.readFileSync(UI_CONTRACT_PATH, 'utf8');
var UI_CONTRACT_SHA = crypto.createHash('sha256').update(UI_CONTRACT_SRC).digest('hex');
var UI = loadContract(UI_CONTRACT_SRC);

var XJ_UI_CSS = fs.readFileSync(path.join(ROOT, 'app', 'css', 'xj-ui-system.css'), 'utf8');
var WORKBENCH_CSS = fs.readFileSync(path.join(ROOT, 'app', 'css', 'workbench.css'), 'utf8');
var STYLE_CSS = fs.readFileSync(path.join(ROOT, 'app', 'css', 'style.css'), 'utf8');
var APP_JS = fs.readFileSync(path.join(ROOT, 'app', 'js', 'app.js'), 'utf8');

function readHtml(route) {
  var p = path.join(ROOT, 'app', route);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ── Mutation engine with proper no-op/syntax/harness detection ──
// Each mutation targets a real, verified string in ui-contract.js.
// If the target string is not found, mutation is a no-op (returned unchanged).
function buildMutant(kind, src) {
  switch (kind) {
    case 'removeAria':
      return src.replace("requiredAria: { role: 'banner' }", "requiredAria: {}");
    case 'removeReducedMotion':
      return src.replace('removesActiveTransforms: true', 'removesActiveTransforms: false');
    case 'removeOverflowX':
      return src.replace('noHorizontalOverflow: true', 'noHorizontalOverflow: false');
    case 'shrinkFont10':
      return src.replace('MIN_FONT_PX = 12', 'MIN_FONT_PX = 10');
    case 'removeComponent':
      return src.replace('EmptyState: {', 'EmptyState_REMOVED: {');
    case 'mockPass':
      return src.replace('return SIDEBAR_WIDTHS[mode] === px;', 'return true;');
    case 'fakeSkin':
      // Adds a 4th skin → THEME_COMBINATIONS has 8 entries → assert 6 fails
      return src.replace(
        "SKINS = ['clinical', 'theatre', 'observatory'];",
        "SKINS = ['clinical', 'theatre', 'observatory', 'fake'];"
      );
    case 'disableStringCheck':
      // Disables string-type ARIA validation → validateComponent('IconButton',{}) returns ok:true
      return src.replace('!isString(actual)', 'false');
    case 'emptyEmptyStateAria':
      // Empties EmptyState ARIA → allHaveAria check fails
      return src.replace(
        "requiredAria: { role: 'status' },",
        "requiredAria: {},"
      );
    case 'hideOverflow':
      return src.replace('minWidth: 1024', 'minWidth: 0');
    default:
      return src; // unknown mutation → no-op
  }
}

// loadMutant returns { status, exports? }
// status: 'loaded' | 'no-op' | 'syntax-error' | 'harness-error'
function loadMutant(kind) {
  var mutated = buildMutant(kind, UI_CONTRACT_SRC);
  if (mutated === UI_CONTRACT_SRC) {
    return { status: 'no-op' };
  }
  try {
    var U = loadContract(mutated);
    return { status: 'loaded', exports: U };
  } catch (e) {
    var msg = (e && e.message) || String(e);
    if (msg.indexOf('SyntaxError') >= 0 || msg.indexOf('Unexpected') >= 0) {
      return { status: 'syntax-error', reason: msg };
    }
    return { status: 'harness-error', reason: msg };
  }
}

// Run core invariant subset against a UI instance
function runCoreTests(U) {
  var p = 0, f = 0;
  try { assert(U.THEME_COMBINATIONS.length === 6, '6 themes'); p++; } catch(e) { f++; }
  try {
    FIXTURES.COMPONENTS.forEach(function(n) { assert(U.COMPONENTS[n], n); });
    p++;
  } catch(e) { f++; }
  try {
    assert(U.validateSidebarWidth('expanded', 224), '224 ok');
    assert(!U.validateSidebarWidth('expanded', 200), 'reject 200');
    p++;
  } catch(e) { f++; }
  try { assert(U.MIN_FONT_PX === 12, 'font 12'); p++; } catch(e) { f++; }
  try { assert(U.REDUCED_MOTION_RULES.removesActiveTransforms === true, 'rm transform'); p++; } catch(e) { f++; }
  try { assert(U.WIDTH_BUDGET.minWidth === 1024, 'min 1024'); p++; } catch(e) { f++; }
  try { assert(U.WIDTH_BUDGET.noHorizontalOverflow === true, 'no overflow'); p++; } catch(e) { f++; }
  // [6] validateComponent rejects IconButton without aria-label (string type)
  // PageHeader's requiredAria is {role:'banner'} — the validator only checks
  // 'string'/'boolean' type expectations, so {} correctly passes for PageHeader.
  // IconButton's requiredAria is {aria-label:'string'} — {} must fail.
  try {
    var r2 = U.validateComponent('IconButton', {});
    assert(r2.ok === false, 'IconButton no aria-label');
    assert(r2.issues && r2.issues.length > 0, 'IconButton issues present');
    p++;
  } catch(e) { f++; }
  try { assert(U.KEYBOARD_CONTRACT.focusVisible === true, 'focus'); p++; } catch(e) { f++; }
  // all components have non-empty requiredAria
  try {
    var allHaveAria = true;
    Object.keys(U.COMPONENTS).forEach(function(n) {
      var a = U.COMPONENTS[n].requiredAria;
      if (!a || typeof a !== 'object' || Object.keys(a).length === 0) allHaveAria = false;
    });
    assert(allHaveAria, 'all components have ARIA');
    p++;
  } catch(e) { f++; }
  // all components have non-empty states
  try {
    var allHaveStates = true;
    Object.keys(U.COMPONENTS).forEach(function(n) {
      var s = U.COMPONENTS[n].states;
      if (!s || !Array.isArray(s) || s.length === 0) allHaveStates = false;
    });
    assert(allHaveStates, 'all components have states');
    p++;
  } catch(e) { f++; }
  return { pass: p, fail: f };
}

// ══════════════════════════════════════════════════════════════
// S1-S6: Cross-route HTML analysis
// ══════════════════════════════════════════════════════════════

test('S1: 22 business routes exist as HTML files', function () {
  var missing = [];
  FIXTURES.ROUTES.forEach(function (r) {
    if (!fs.existsSync(path.join(ROOT, 'app', r))) missing.push(r);
  });
  assert(missing.length === 0, 'Missing: ' + missing.join(', '));
});

test('S2: Core routes (19) include app.js', function () {
  var issues = [];
  FIXTURES.ROUTES.forEach(function (r) {
    if (FIXTURES.NON_CORE.indexOf(r) >= 0) return;
    var html = readHtml(r);
    if (!html || html.indexOf('app.js') < 0) issues.push(r);
  });
  assert(issues.length === 0, 'Missing app.js: ' + issues.join(', '));
});

test('S3: Core routes include shared CSS (style.css or xj-ui-system.css)', function () {
  var issues = [];
  FIXTURES.ROUTES.forEach(function (r) {
    if (FIXTURES.NON_CORE.indexOf(r) >= 0) return;
    var html = readHtml(r);
    if (!html) return;
    if (html.indexOf('style.css') < 0 && html.indexOf('xj-ui-system.css') < 0) issues.push(r);
  });
  assert(issues.length === 0, 'Missing shared CSS: ' + issues.join(', '));
});

test('S4: Sidebar routes have sidebar-mount in HTML', function () {
  var issues = [];
  FIXTURES.ROUTES.forEach(function (r) {
    if (FIXTURES.NO_SIDEBAR_HTML.indexOf(r) >= 0 || FIXTURES.NON_CORE.indexOf(r) >= 0) return;
    var html = readHtml(r);
    if (!html) return;
    if (html.indexOf('sidebar-mount') < 0 && html.indexOf('renderSidebar') < 0) issues.push(r);
  });
  assert(issues.length === 0, 'Missing sidebar: ' + issues.join(', '));
});

test('S5: Non-core routes correctly lack sidebar', function () {
  FIXTURES.NON_CORE.forEach(function (r) {
    var html = readHtml(r);
    assert(!html || (html.indexOf('sidebar-mount') < 0), r + ' should not have sidebar');
  });
});

test('S6: No route adds unauthorized top-level business entry', function () {
  var issues = [];
  FIXTURES.ROUTES.forEach(function (r) {
    var html = readHtml(r);
    if (!html) return;
    var hrefs = (html.match(/href="([^"]+\.html)"/g) || []);
    hrefs.forEach(function (m) {
      var base = m.replace('href="', '').replace('"', '').split('/').pop();
      if (base.indexOf('.html') >= 0 && FIXTURES.ROUTES.indexOf(base) < 0) {
        if (base.indexOf('design-preview') < 0) issues.push(r + ' → ' + base);
      }
    });
  });
  assert(issues.length === 0, 'Unknown routes: ' + issues.join('; '));
});

// ══════════════════════════════════════════════════════════════
// S7-S12: CSS token and component verification
// ══════════════════════════════════════════════════════════════

test('S7: All required CSS tokens exist in xj-ui-system.css', function () {
  var missing = [];
  Object.keys(FIXTURES.TOKEN_CHECKS).forEach(function (tok) {
    if (XJ_UI_CSS.indexOf(tok + ': ' + FIXTURES.TOKEN_CHECKS[tok]) < 0) missing.push(tok);
  });
  assert(missing.length === 0, 'Missing tokens: ' + missing.join(', '));
});

test('S8: All 8 component CSS selectors exist in xj-ui-system.css', function () {
  var missing = [];
  FIXTURES.COMPONENT_SELECTORS.forEach(function (sel) {
    if (XJ_UI_CSS.indexOf(sel) < 0) missing.push(sel);
  });
  assert(missing.length === 0, 'Missing selectors: ' + missing.join(', '));
});

test('S9: prefers-reduced-motion in 3 CSS files', function () {
  assert(XJ_UI_CSS.indexOf('prefers-reduced-motion') >= 0, 'Missing in xj-ui-system.css');
  assert(WORKBENCH_CSS.indexOf('prefers-reduced-motion') >= 0, 'Missing in workbench.css');
  assert(STYLE_CSS.indexOf('prefers-reduced-motion') >= 0, 'Missing in style.css');
});

test('S10: overflow-x: hidden in xj-ui-system.css', function () {
  assert(XJ_UI_CSS.indexOf('overflow-x: hidden') >= 0, 'Missing overflow-x: hidden');
});

test('S11: No sub-12px hardcoded font in workbench.css', function () {
  var lines = WORKBENCH_CSS.split('\n');
  var violations = [];
  lines.forEach(function (line, i) {
    var m = line.match(/font-size:\s*(\d+)px/);
    if (m && parseInt(m[1], 10) < 12 && line.indexOf('var(--xj-font-min') < 0) {
      violations.push('L' + (i + 1) + ': ' + line.trim());
    }
  });
  assert(violations.length === 0, 'Sub-12px:\n' + violations.join('\n'));
});

test('S12: Three skin variants + dark blocks in CSS', function () {
  assert(XJ_UI_CSS.indexOf('[data-skin="clinical"]') >= 0, 'Missing clinical');
  assert(XJ_UI_CSS.indexOf('[data-skin="theatre"]') >= 0, 'Missing theatre');
  assert(XJ_UI_CSS.indexOf('[data-skin="observatory"]') >= 0, 'Missing observatory');
  var darkCount = (XJ_UI_CSS.match(/\.dark\s*\{/g) || []).length;
  assert(darkCount >= 3, 'Need 3+ dark blocks, got ' + darkCount);
});

// ══════════════════════════════════════════════════════════════
// S13-S18: Real ui-contract.js behavior verification
// ══════════════════════════════════════════════════════════════

test('S13: 6 themes in ui-contract.js', function () {
  assert(UI.THEME_COMBINATIONS.length === 6, 'Expected 6, got ' + UI.THEME_COMBINATIONS.length);
  FIXTURES.THEMES.forEach(function (id) { assert(UI.validateTheme(id), 'Missing: ' + id); });
});

test('S14: 8 components with states + ARIA', function () {
  FIXTURES.COMPONENTS.forEach(function (name) {
    assert(UI.COMPONENTS[name], 'Missing: ' + name);
    assert(UI.COMPONENTS[name].states.length > 0, name + ' no states');
    assert(UI.COMPONENTS[name].requiredAria, name + ' no requiredAria');
  });
});

test('S15: Keyboard contract + error/loading states', function () {
  var kc = UI.KEYBOARD_CONTRACT;
  assert(kc.focusVisible, 'focusVisible');
  assert(kc.escapeClosesDrawer, 'escape');
  assert(kc.enterActivatesButton, 'enter');
  assert(UI.COMPONENTS.PageHeader.states.indexOf('error') >= 0, 'PageHeader error');
  assert(UI.COMPONENTS.StatusChip.states.indexOf('danger') >= 0, 'StatusChip danger');
  assert(UI.COMPONENTS.LoadingState.requiredAria['aria-live'] === 'polite', 'aria-live');
});

test('S16: validateSidebarWidth rejects wrong widths', function () {
  assert(UI.validateSidebarWidth('expanded', 224), '224 ok');
  assert(!UI.validateSidebarWidth('expanded', 200), '200 should fail');
  assert(!UI.validateSidebarWidth('fake', 224), 'fake mode');
});

test('S17: validateFontSize rejects sub-12', function () {
  assert(UI.validateFontSize(12), '12 ok');
  assert(!UI.validateFontSize(11), '11 fail');
  assert(!UI.validateFontSize(10), '10 fail');
});

test('S18: 22 routes in ROUTE_REGISTRY (app.js)', function () {
  var missing = [];
  FIXTURES.ROUTES.forEach(function (r) {
    if (APP_JS.indexOf("'" + r + "'") < 0) missing.push(r);
  });
  assert(missing.length === 0, 'Missing in ROUTE_REGISTRY: ' + missing.join(', '));
});

// ══════════════════════════════════════════════════════════════
// S19-S23: CSS component state verification
// ══════════════════════════════════════════════════════════════

test('S19: PageHeader error state CSS', function () {
  assert(XJ_UI_CSS.indexOf('[data-state="error"]') >= 0, 'data-state=error');
});

test('S20: StatusChip variants in CSS', function () {
  assert(XJ_UI_CSS.indexOf('[data-variant="default"]') >= 0, 'default');
  assert(XJ_UI_CSS.indexOf('[data-variant="success"]') >= 0, 'success');
  assert(XJ_UI_CSS.indexOf('[data-variant="warning"]') >= 0, 'warning');
  assert(XJ_UI_CSS.indexOf('[data-variant="danger"]') >= 0, 'danger');
});

test('S21: SourceRow invalid state CSS', function () {
  assert(XJ_UI_CSS.indexOf('[data-state="invalid"]') >= 0, 'data-state=invalid');
});

test('S22: focus-visible + outline in CSS', function () {
  assert(XJ_UI_CSS.indexOf(':focus-visible') >= 0, 'focus-visible');
  assert(XJ_UI_CSS.indexOf('outline') >= 0, 'outline');
  assert(XJ_UI_CSS.indexOf('var(--xj-focus)') >= 0, '--xj-focus');
});

test('S23: Theme toggle (classList.toggle dark + localStorage) in app.js', function () {
  assert(APP_JS.indexOf('classList.toggle') >= 0, 'classList.toggle');
  assert(APP_JS.indexOf("'dark'") >= 0, 'dark mode');
  assert(APP_JS.indexOf('xj_theme') >= 0, 'localStorage key');
});

// ══════════════════════════════════════════════════════════════
// S24: validateComponent rejects IconButton without aria-label
// ══════════════════════════════════════════════════════════════

test('S24: validateComponent rejects IconButton missing aria-label', function () {
  var r = UI.validateComponent('IconButton', {});
  assert(r.ok === false, 'should reject empty IconButton');
  assert(r.issues && r.issues.length > 0, 'should have issues');
});

// ══════════════════════════════════════════════════════════════
// N1-N3: Negative testing
// ══════════════════════════════════════════════════════════════

test('N1: Unknown routes do not exist on disk', function () {
  FIXTURES.FAKE_ROUTES.forEach(function (r) {
    assert(!fs.existsSync(path.join(ROOT, 'app', r)), r + ' should not exist');
  });
});

test('N2: validateTheme rejects fake themes', function () {
  assert(!UI.validateTheme('fake-light'), 'fake-light');
  assert(!UI.validateTheme('clinical'), 'bare skin');
  assert(!UI.validateTheme(''), 'empty');
});

test('N3: validateComponent rejects unknown', function () {
  var r = UI.validateComponent('NonExistent', {});
  assert(r.ok === false, 'should fail');
});

// ══════════════════════════════════════════════════════════════
// M1-M10: Reverse mutations with 5-category output
// ══════════════════════════════════════════════════════════════

console.log('\n--- Reverse Mutation Sensitivity ---');

// [5] Baseline must pass with 0 failures before running mutations
var baseline = runCoreTests(UI);
if (baseline.fail > 0) {
  console.log('  [BLOCKED] baseline has ' + baseline.fail + ' failures — mutations cannot be tested');
  console.log('contract_phase: CONTRACT-BROKEN (baseline)');
  process.exit(1);
}
console.log('  baseline: ' + baseline.pass + ' pass, ' + baseline.fail + ' fail');

FIXTURES.MUTATIONS.forEach(function (kind) {
  var loadResult = loadMutant(kind);

  if (loadResult.status === 'no-op') {
    console.log('  [NO-OP] ' + kind + ' — target string not in source');
    mutNoop++;
    return;
  }

  if (loadResult.status === 'syntax-error') {
    console.log('  [SYNTAX-ERROR] ' + kind + ' — ' + (loadResult.reason || '').slice(0, 80));
    mutSyntaxErr++;
    return;
  }

  if (loadResult.status === 'harness-error') {
    console.log('  [HARNESS-ERROR] ' + kind + ' — ' + (loadResult.reason || '').slice(0, 80));
    mutHarnessErr++;
    return;
  }

  // status === 'loaded' — run core tests against mutant
  try {
    var mutantResult = runCoreTests(loadResult.exports);
    if (mutantResult.fail > baseline.fail || mutantResult.pass < baseline.pass) {
      console.log('  [KILLED] ' + kind + ' (fail: ' + baseline.fail + '→' + mutantResult.fail + ', pass: ' + baseline.pass + '→' + mutantResult.pass + ')');
      mutKilled++;
      passed++;
    } else {
      console.log('  [SURVIVED] ' + kind + ' — FALSE GREEN RISK');
      mutSurvived++;
      failed++;
    }
  } catch (e) {
    console.log('  [HARNESS-ERROR] ' + kind + ' — ' + (e.message || '').slice(0, 80));
    mutHarnessErr++;
  }
});

// ══════════════════════════════════════════════════════════════
// Summary with 5-category mutation report
// ══════════════════════════════════════════════════════════════

console.log('\n=== SUMMARY ===');
results.forEach(function (r) { console.log(r); });
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
console.log('Blocked: ' + blocked);
console.log('--- Mutation Report ---');
console.log('Mutations killed: ' + mutKilled);
console.log('Mutations survived: ' + mutSurvived);
console.log('Mutations no-op: ' + mutNoop);
console.log('Mutations syntax-error: ' + mutSyntaxErr);
console.log('Mutations harness-error: ' + mutHarnessErr);
console.log('ui_contract_sha256: ' + UI_CONTRACT_SHA);

var anyProblem = mutSurvived > 0 || mutNoop > 0 || mutSyntaxErr > 0 || mutHarnessErr > 0 || failed > 0;

if (anyProblem) {
  console.log('contract_phase: CONTRACT-BROKEN');
  console.log('Note: Any survived, no-op, syntax-error, or failed mutation breaks this contract.');
  process.exit(1);
} else {
  console.log('contract_phase: ALL-GREEN');
  console.log('Note: All 10 mutations killed, 0 survived/no-op/syntax/harness. Not release-ready.');
  process.exit(0);
}
