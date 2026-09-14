'use strict';
/**
 * XJ-4.3.0-grok-doc-center-case-atlas-reference-01 — Contract runner
 * Source + fixture level checks for the isolated preview.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '4.3.0-grok-doc-center-case-atlas');
var SPEC = path.join(ROOT, 'docs', 'agent-coordination', 'v4.3.0', 'design', 'grok-doc-center-case-atlas-spec.md');

var FILES = {
  html: path.join(PREVIEW, 'index.html'),
  css: path.join(PREVIEW, 'styles.css'),
  app: path.join(PREVIEW, 'app.js'),
  fixtures: path.join(PREVIEW, 'fixtures.js')
};

var passed = 0;
var failed = 0;
var results = [];

function sha256(filePath) {
  var buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensure(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(id, title, fn) {
  try {
    fn();
    passed++;
    results.push({ id: id, status: 'CONFIRMED', title: title });
    console.log('[CONFIRMED] ' + id + ' ' + title);
  } catch (e) {
    failed++;
    results.push({ id: id, status: 'FAIL', title: title, detail: e.message });
    console.log('[FAIL] ' + id + ' ' + title + ' — ' + e.message);
  }
}

Object.keys(FILES).forEach(function (k) {
  ensure(fs.existsSync(FILES[k]), 'missing preview file: ' + FILES[k]);
});
ensure(fs.existsSync(SPEC), 'missing design spec: ' + SPEC);

var html = fs.readFileSync(FILES.html, 'utf8');
var css = fs.readFileSync(FILES.css, 'utf8');
var app = fs.readFileSync(FILES.app, 'utf8');
var fixturesSrc = fs.readFileSync(FILES.fixtures, 'utf8');
var spec = fs.readFileSync(SPEC, 'utf8');

var fixtures = require(FILES.fixtures);

console.log('Preview root: ' + PREVIEW);
console.log('HTML chars: ' + html.length);

// ---- File / isolation ----
test('C-01', 'preview is multi-file local bundle without CDN/network refs', function () {
  ensure(html.indexOf('fixtures.js') >= 0, 'fixtures script missing');
  ensure(html.indexOf('app.js') >= 0, 'app script missing');
  ensure(html.indexOf('styles.css') >= 0, 'styles link missing');
  ensure(html.indexOf('http://') < 0 && html.indexOf('https://') < 0, 'remote URL found in HTML');
  ensure(css.indexOf('http://') < 0 && css.indexOf('https://') < 0, 'remote URL found in CSS');
  ensure(app.indexOf('fetch(') < 0, 'fetch() found in app');
  ensure(app.indexOf('XMLHttpRequest') < 0, 'XHR found in app');
});

test('C-02', 'no Goldentime global skin / Fraunces / 32px radius copy', function () {
  ensure(html.indexOf('data-skin="goldentime"') < 0, 'goldentime skin attribute present');
  ensure(css.indexOf('Fraunces') < 0, 'Fraunces font present');
  ensure(css.indexOf('--radius: 32px') < 0, '32px global radius present');
  ensure(css.indexOf('#3b352b') < 0 && css.indexOf('#3B352B') < 0, 'Goldentime cocoa primary copied');
  ensure(css.indexOf('--r-card: 8px') >= 0, 'XinJing card radius missing');
});

test('C-03', 'Clinical / Theatre / Observatory skins defined distinctly', function () {
  ensure(css.indexOf('[data-skin="clinical"]') >= 0, 'clinical skin missing');
  ensure(css.indexOf('[data-skin="theatre"]') >= 0, 'theatre skin missing');
  ensure(css.indexOf('[data-skin="observatory"]') >= 0, 'observatory skin missing');
  // Observatory accent must differ from Clinical
  var clinicalAccent = css.match(/\[data-skin="clinical"\][\s\S]*?--accent:\s*([^;]+);/);
  var observatoryAccent = css.match(/\[data-skin="observatory"\][\s\S]*?--accent:\s*([^;]+);/);
  ensure(clinicalAccent && observatoryAccent, 'accent tokens missing');
  ensure(clinicalAccent[1].trim() !== observatoryAccent[1].trim(), 'Observatory accent identical to Clinical');
});

test('C-04', 'Light/Dark theme attributes supported without page duplication', function () {
  ensure(html.indexOf('data-theme="light"') >= 0, 'default light theme missing');
  ensure(html.indexOf('id="themeSelect"') >= 0, 'theme select missing');
  ensure(css.indexOf('[data-theme="dark"]') >= 0, 'dark theme rules missing');
  ensure(html.indexOf('Theatre') >= 0 && html.indexOf('Observatory') >= 0, 'skin options incomplete');
});

// ---- Three segments ----
test('C-10', 'Material / Timeline / Case Atlas segments present', function () {
  ensure(html.indexOf('data-segment="material"') >= 0, 'material segment missing');
  ensure(html.indexOf('data-segment="timeline"') >= 0, 'timeline segment missing');
  ensure(html.indexOf('data-segment="atlas"') >= 0, 'atlas segment missing');
  ensure(html.indexOf('id="viewMaterial"') >= 0, 'viewMaterial missing');
  ensure(html.indexOf('id="viewTimeline"') >= 0, 'viewTimeline missing');
  ensure(html.indexOf('id="viewAtlas"') >= 0, 'viewAtlas missing');
});

test('C-11', 'segment switch handler and focus restoration exist', function () {
  ensure(app.indexOf('function setSegment') >= 0 || app.indexOf('setSegment:') >= 0 || app.indexOf('setSegment =') >= 0 || app.indexOf('function setSegment') >= 0, 'setSegment missing');
  ensure(app.indexOf('setSegment(') >= 0, 'setSegment calls missing');
  ensure(app.indexOf('lastFocusEl') >= 0, 'lastFocusEl tracking missing');
  ensure(app.indexOf('.focus(') >= 0, 'focus restoration missing');
  ensure(app.indexOf('aria-selected') >= 0 || html.indexOf('aria-selected') >= 0, 'aria-selected missing');
});

test('C-12', 'each segment has a real primary control handler', function () {
  // Exact control ids/actions — substring-safe replacements must fail.
  ensure(/\bbtnRefreshMaterials\b/.test(app), 'material handler id missing');
  ensure(/data-action="refresh-materials"|id="btnRefreshMaterials"/.test(app), 'material refresh wiring missing');
  ensure(/\bbtnFocusLatest\b/.test(app), 'timeline handler id missing');
  ensure(/\bbtnFitAtlas\b/.test(app), 'atlas handler id missing');
  ensure(/\bprimaryAction\b/.test(app) || html.indexOf('id="primaryAction"') >= 0, 'global primary action missing');
  ensure(app.indexOf("addEventListener('click'") >= 0 || app.indexOf('addEventListener("click"') >= 0, 'click handlers missing');
});

// ---- Fixtures / source safety ----
test('C-20', 'synthetic fixtures expose SourceRef-like fields', function () {
  ensure(fixtures.materials.length >= 8, 'too few materials');
  fixtures.materials.forEach(function (n) {
    ensure(n.stableId, 'stableId missing on ' + n.id);
    ensure(n.normalizationVersion, 'normalizationVersion missing on ' + n.id);
    ensure(n.sourceVersion, 'sourceVersion missing on ' + n.id);
    ensure(n.sourceContentHash && n.sourceContentHash.length >= 32, 'sourceContentHash missing on ' + n.id);
    ensure(n.anchorContentHash && n.anchorContentHash.length >= 32, 'anchorContentHash missing on ' + n.id);
    ensure(n.sourceStatus, 'sourceStatus missing on ' + n.id);
  });
});

test('C-21', 'stale / invalid / quarantined fixtures exist and are non-usable', function () {
  var statuses = fixtures.materials.map(function (n) { return n.sourceStatus; });
  ensure(statuses.indexOf('stale') >= 0, 'stale fixture missing');
  ensure(statuses.indexOf('invalid') >= 0, 'invalid fixture missing');
  ensure(statuses.indexOf('quarantined') >= 0, 'quarantined fixture missing');
  var usable = fixtures.usableNodes(fixtures.materials);
  usable.forEach(function (n) {
    ensure(n.sourceStatus === 'verified' || n.sourceStatus === 'unverified', 'blocked status leaked into usable set: ' + n.id);
  });
  ensure(usable.length < fixtures.materials.length, 'usable set should exclude blocked nodes');
});

test('C-22', 'AI drafts remain drafts in fixtures and UI copy', function () {
  var drafts = fixtures.materials.filter(function (n) { return n.aiDraft; });
  ensure(drafts.length >= 1, 'aiDraft fixtures missing');
  ensure(app.indexOf('AI 草稿') >= 0, 'AI draft label missing in app');
  ensure(app.indexOf('不表示因果') >= 0 || html.indexOf('不表示因果') >= 0, 'non-causation copy missing');
});

test('C-23', 'scenario model covers loading / empty / error / no-client / ready', function () {
  ['ready', 'loading', 'empty', 'error', 'no-client'].forEach(function (id) {
    var model = fixtures.buildModel(id);
    ensure(model && model.scenario && model.scenario.id === id, 'scenario model failed for ' + id);
  });
  ensure(fixtures.buildModel('loading').loading === true, 'loading flag missing');
  ensure(fixtures.buildModel('error').error && fixtures.buildModel('error').error.code, 'error model missing');
  ensure(fixtures.buildModel('empty').nodes.length === 0, 'empty model not empty');
  ensure(fixtures.buildModel('no-client').clientId == null, 'no-client still has clientId');
});

test('C-24', 'blocked statuses have explicit recovery UI hooks', function () {
  ensure(app.indexOf('action-retry') >= 0, 'retry recovery missing');
  ensure(fixtures.STATUS_LABELS.stale === '版本过期', 'stale label missing');
  ensure(fixtures.STATUS_LABELS.invalid === '不可用', 'invalid label missing');
  ensure(fixtures.STATUS_LABELS.quarantined === '已隔离', 'quarantine label missing');
  ensure(/\bfunction isBlockedStatus\b|\bisBlockedStatus\s*=/.test(app) || app.indexOf('function isBlockedStatus') >= 0, 'blocked status helper missing');
  ensure(app.indexOf('受限来源：仅保留定位，不展示正文。') >= 0, 'blocked material warning copy missing');
  ensure(app.indexOf('受限来源：不进入可用来源正文。') >= 0, 'blocked timeline warning copy missing');
  ensure(app.indexOf("status === 'stale'") >= 0 && app.indexOf("status === 'invalid'") >= 0 && app.indexOf("status === 'quarantined'") >= 0, 'blocked status checks missing');
});

// ---- A11y / layout ----
test('C-30', 'reduced-motion and focus-visible rules present', function () {
  ensure(css.indexOf('prefers-reduced-motion') >= 0, 'reduced-motion missing');
  ensure(css.indexOf(':focus-visible') >= 0, 'focus-visible missing');
  ensure(css.indexOf('line-clamp') >= 0 || css.indexOf('-webkit-line-clamp') >= 0, 'long Chinese clamp missing');
});

test('C-31', 'narrow window breakpoints present', function () {
  ensure(css.indexOf('@media (max-width: 1024px)') >= 0, '1024 breakpoint missing');
  ensure(css.indexOf('@media (max-width: 700px)') >= 0, '700 breakpoint missing');
  ensure(css.indexOf('overflow-x: hidden') >= 0, 'overflow-x guard missing');
});

test('C-32', 'simplified Chinese clinical copy present', function () {
  ensure(html.indexOf('文档中心') >= 0, 'doc center title missing');
  ensure(html.indexOf('材料列表') >= 0, 'material label missing');
  ensure(html.indexOf('时间线') >= 0, 'timeline label missing');
  ensure(html.indexOf('个案图谱') >= 0, 'atlas label missing');
});

// ---- Spec ----
test('C-40', 'adaptation spec documents route, safety, accepted/rejected Goldentime items', function () {
  ensure(spec.indexOf('doc-center') >= 0 || spec.indexOf('文档中心') >= 0, 'route missing in spec');
  ensure(spec.indexOf('主任务') >= 0 || spec.indexOf('primary') >= 0 || spec.indexOf('主要任务') >= 0, 'primary task missing');
  ensure(spec.indexOf('接受') >= 0 && spec.indexOf('拒绝') >= 0, 'accepted/rejected Goldentime section missing');
  ensure(spec.indexOf('Clinical') >= 0 && spec.indexOf('Theatre') >= 0 && spec.indexOf('Observatory') >= 0, 'skin impact missing');
  ensure(spec.indexOf('SourceRef') >= 0 || spec.indexOf('来源') >= 0, 'source safety missing');
});

// ---- Hashes ----
test('C-50', 'emit deterministic SHA-256 for allowlisted preview artifacts', function () {
  Object.keys(FILES).forEach(function (k) {
    var digest = sha256(FILES[k]);
    ensure(/^[a-f0-9]{64}$/.test(digest), 'bad hash for ' + k);
    console.log('SHA256 ' + path.basename(FILES[k]) + ' ' + digest);
  });
  console.log('SHA256 ' + path.basename(SPEC) + ' ' + sha256(SPEC));
});

console.log('');
console.log('Contract summary: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  process.exit(1);
}
console.log('CONTRACT_OK');
process.exit(0);
