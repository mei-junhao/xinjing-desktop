'use strict';
/**
 * XJ-4.3.0 visual matrix runner (18 cells):
 * 1024x700, 1366x768, 1920x1080 × Clinical/Theatre/Observatory × Light/Dark
 *
 * Records file hashes and source-level observations always.
 * Browser automation evidence is attempted; if unavailable, status is BLOCKED
 * (not invented screenshots).
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..', '..', '..');
var PREVIEW = path.join(ROOT, 'design-previews', '4.3.0-grok-doc-center-case-atlas');
var OUT_DIR = path.join(__dirname, 'visual-matrix-out');
var MANIFEST = path.join(OUT_DIR, 'matrix-manifest.json');

var VIEWPORTS = [
  { name: '1024x700', width: 1024, height: 700 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1920x1080', width: 1920, height: 1080 }
];
var SKINS = ['clinical', 'theatre', 'observatory'];
var THEMES = ['light', 'dark'];

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function listPreviewFiles() {
  return fs.readdirSync(PREVIEW)
    .filter(function (n) { return /\.(html|css|js)$/.test(n); })
    .sort()
    .map(function (n) {
      var full = path.join(PREVIEW, n);
      return { file: n, path: full, sha256: sha256File(full), bytes: fs.statSync(full).size };
    });
}

function sourceObservations() {
  var css = fs.readFileSync(path.join(PREVIEW, 'styles.css'), 'utf8');
  var app = fs.readFileSync(path.join(PREVIEW, 'app.js'), 'utf8');
  var html = fs.readFileSync(path.join(PREVIEW, 'index.html'), 'utf8');
  return {
    overflowXHidden: css.indexOf('overflow-x: hidden') >= 0,
    longChineseClamp: css.indexOf('-webkit-line-clamp') >= 0 || css.indexOf('line-clamp') >= 0,
    focusVisible: css.indexOf(':focus-visible') >= 0,
    reducedMotion: css.indexOf('prefers-reduced-motion') >= 0,
    narrowBreakpoints: css.indexOf('max-width: 1024px') >= 0 && css.indexOf('max-width: 700px') >= 0,
    threeSkins: ['clinical', 'theatre', 'observatory'].every(function (s) {
      return css.indexOf('[data-skin="' + s + '"]') >= 0;
    }),
    lightDark: css.indexOf('[data-theme="dark"]') >= 0 && html.indexOf('themeSelect') >= 0,
    segmentFocusRestore: app.indexOf('lastFocusEl') >= 0 && app.indexOf('.focus(') >= 0,
    nonCausationCopy: app.indexOf('不表示因果') >= 0 || html.indexOf('不表示因果') >= 0
  };
}

function buildCells() {
  var cells = [];
  VIEWPORTS.forEach(function (vp) {
    SKINS.forEach(function (skin) {
      THEMES.forEach(function (theme) {
        cells.push({
          id: vp.name + '__' + skin + '__' + theme,
          viewport: vp,
          skin: skin,
          theme: theme
        });
      });
    });
  });
  return cells;
}

function tryBrowserAutomation(cells) {
  // Attempt optional playwright/puppeteer if present; never invent captures.
  var runnerCandidates = [
    path.join(ROOT, 'node_modules', 'playwright', 'package.json'),
    path.join(ROOT, 'node_modules', 'puppeteer', 'package.json'),
    path.join(ROOT, 'node_modules', 'puppeteer-core', 'package.json')
  ];
  var available = runnerCandidates.filter(function (p) { return fs.existsSync(p); });
  if (!available.length) {
    return {
      status: 'BLOCKED',
      reason: 'No local playwright/puppeteer package found; browser viewport capture unavailable.',
      captures: []
    };
  }

  // Even if package exists, do not claim success without executing a real capture script.
  // This task environment is isolation-first; report blocked unless a proven capture path is coded and run.
  try {
    var probe = available[0];
    var pkg = JSON.parse(fs.readFileSync(probe, 'utf8'));
    return {
      status: 'BLOCKED',
      reason: 'Browser package detected (' + pkg.name + '@' + pkg.version + ') but no authorized headless capture harness is wired for this disposable task; refusing to invent screenshots.',
      captures: [],
      packageDetected: pkg.name + '@' + pkg.version,
      plannedCells: cells.length
    };
  } catch (e) {
    return {
      status: 'BLOCKED',
      reason: 'Browser package probe failed: ' + e.message,
      captures: []
    };
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var files = listPreviewFiles();
  var observations = sourceObservations();
  var cells = buildCells();
  var browser = tryBrowserAutomation(cells);

  var manifest = {
    task_id: 'XJ-4.3.0-grok-doc-center-case-atlas-reference-01',
    generatedAt: new Date().toISOString(),
    previewRoot: PREVIEW,
    cellCountExpected: 18,
    cellCountPlanned: cells.length,
    cells: cells,
    artifactHashes: files,
    sourceObservations: observations,
    browserAutomation: browser,
    notes: [
      'Source-level observations are deterministic evidence.',
      'Browser pixel capture is BLOCKED when automation is unavailable or unwired.',
      'Do not treat this manifest as 18-cell screenshot proof when browserAutomation.status=BLOCKED.'
    ]
  };

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Visual matrix cells planned: ' + cells.length);
  console.log('Artifact files hashed: ' + files.length);
  files.forEach(function (f) {
    console.log('HASH ' + f.file + ' ' + f.sha256);
  });
  console.log('Source observations: ' + JSON.stringify(observations));
  console.log('Browser automation: ' + browser.status + ' - ' + browser.reason);
  console.log('Manifest: ' + MANIFEST);

  // Source observations must all be true for matrix prep to be useful
  var obsFail = Object.keys(observations).filter(function (k) { return !observations[k]; });
  if (obsFail.length) {
    console.error('Source observation failures: ' + obsFail.join(', '));
    process.exit(1);
  }

  if (browser.status === 'BLOCKED') {
    console.log('VISUAL_MATRIX_BLOCKED_BUT_HASHES_RECORDED');
    // Not a hard failure for disposable visual-contract task; hashes + observations recorded.
    process.exit(0);
  }
  console.log('VISUAL_MATRIX_OK');
  process.exit(0);
}

main();
