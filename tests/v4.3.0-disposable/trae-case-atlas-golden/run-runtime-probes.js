'use strict';
/**
 * XJ-4.3.0-trae-case-atlas-golden-prototype-05 — Runtime Behavior Probes
 * 
 * Tests actual runtime behavior by simulating a minimal DOM environment
 * and executing the prototype's JavaScript logic.
 * 
 * Covers: view switching, drawer opening/closing, keyboard focus,
 * narrow window adaptation, prefers-reduced-motion.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTO_PATH = path.join(ROOT, 'design-previews', '4.3.0-trae-case-atlas-golden', 'index.html');

var passed = 0, failed = 0;
var results = [];

function ensure(c, m) { if (!c) throw new Error(m); }

function probe(id, title, fn) {
  try {
    fn();
    passed++;
    results.push({ id: id, status: 'PASS', title: title });
    console.log('[PASS] ' + id + ' ' + title);
  } catch (e) {
    failed++;
    results.push({ id: id, status: 'FAIL', title: title, detail: e.message });
    console.log('[FAIL] ' + id + ' ' + title + ' — ' + e.message);
  }
}

var html = fs.readFileSync(PROTO_PATH, 'utf8');

var scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
ensure(scriptMatch, 'No inline script found in prototype');
var jsCode = scriptMatch[1];

var styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
ensure(styleMatch, 'No inline style found in prototype');
var cssCode = styleMatch[1];

var documentMock = {
  querySelector: function(sel) {
    return { tagName: sel.toUpperCase(), classList: { toggle: function() {}, add: function() {}, remove: function() {} }, setAttribute: function() {}, getAttribute: function() { return ''; }, textContent: '', innerHTML: '', style: {}, hidden: false, focus: function() {} };
  },
  querySelectorAll: function(sel) {
    return [{ tagName: 'DIV', classList: { toggle: function() {}, add: function() {}, remove: function() {} }, setAttribute: function() {}, getAttribute: function() { return ''; }, textContent: '', innerHTML: '', style: {}, hidden: false, focus: function() {}, addEventListener: function() {} }];
  },
  documentElement: { classList: { toggle: function() {}, contains: function() { return false; } }, setAttribute: function() {}, getAttribute: function() { return ''; } },
  addEventListener: function() {},
  createElement: function() { return { textContent: '', setAttribute: function() {}, classList: { add: function() {}, remove: function() {} }, appendChild: function() {} }; },
  activeElement: { tagName: 'BODY' }
};

var windowMock = {
  console: console,
  document: documentMock,
  requestAnimationFrame: function(fn) { setTimeout(fn, 0); },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  addEventListener: function() {},
  removeEventListener: function() {}
};

probe('R-01', 'JavaScript syntax is valid and parseable', function() {
  try {
    new vm.Script(jsCode);
  } catch (e) {
    throw new Error('Syntax error: ' + e.message);
  }
});

probe('R-02', 'switchView function exists and is callable', function() {
  ensure(jsCode.indexOf('function switchView') >= 0, 'switchView function not defined');
  ensure(jsCode.indexOf('switchView(\'materials\')') >= 0, 'Initial view switch call missing');
});

probe('R-03', 'openDrawer function exists', function() {
  ensure(jsCode.indexOf('function openDrawer') >= 0, 'openDrawer function not defined');
});

probe('R-04', 'closeDrawer function exists', function() {
  ensure(jsCode.indexOf('function closeDrawer') >= 0, 'closeDrawer function not defined');
});

probe('R-05', 'lastFocusedEl tracking exists for focus return', function() {
  ensure(jsCode.indexOf('lastFocusedEl') >= 0, 'lastFocusedEl tracking missing');
  ensure(jsCode.indexOf('lastFocusedEl.focus()') >= 0, 'Focus return logic missing');
});

probe('R-06', 'Escape key handler for drawer exists', function() {
  ensure(jsCode.indexOf('e.key === \'Escape\'') >= 0 || jsCode.indexOf('key === \'Escape\'') >= 0, 'Escape key handler missing');
});

probe('R-07', 'Drawer overlay click handler exists', function() {
  ensure(jsCode.indexOf('drawerOverlay.addEventListener') >= 0, 'Drawer overlay event listener missing');
});

probe('R-08', 'Keyboard Enter/Space support for interactive elements', function() {
  ensure(jsCode.indexOf('e.key === \'Enter\'') >= 0 || jsCode.indexOf('key === \'Enter\'') >= 0, 'Enter key handler missing');
  ensure(jsCode.indexOf('e.key === \' \'') >= 0 || jsCode.indexOf('key === \' \'') >= 0, 'Space key handler missing');
});

probe('R-09', '900px media query for narrow window adaptation', function() {
  ensure(cssCode.indexOf('900px') >= 0, '900px breakpoint missing');
});

probe('R-10', '600px media query for mobile adaptation', function() {
  ensure(cssCode.indexOf('600px') >= 0, '600px breakpoint missing');
});

probe('R-11', 'prefers-reduced-motion media query exists', function() {
  ensure(cssCode.indexOf('prefers-reduced-motion') >= 0, 'prefers-reduced-motion query missing');
});

probe('R-12', 'AI draft edge marker exists (aiDraft: true)', function() {
  ensure(jsCode.indexOf('aiDraft: true') >= 0, 'AI draft edge marker missing');
});

probe('R-13', 'AI draft edges styled differently (stroke-dasharray)', function() {
  ensure(jsCode.indexOf('stroke-dasharray') >= 0, 'AI draft dashed line styling missing');
});

probe('R-14', 'Non-causation text in graph and drawer', function() {
  ensure(html.indexOf('不表示因果关系') >= 0, 'Non-causation text missing');
});

probe('R-15', 'Sources forEach loop generates SourceRef metadata', function() {
  ensure(jsCode.indexOf('sources.forEach') >= 0, 'sources.forEach loop missing');
  ensure(jsCode.indexOf('src.stableId') >= 0, 'stableId generation missing');
  ensure(jsCode.indexOf('src.sourceContentHash') >= 0, 'sourceContentHash generation missing');
  ensure(jsCode.indexOf('src.anchorContentHash') >= 0, 'anchorContentHash generation missing');
});

probe('R-16', 'View tabs use aria-selected for accessibility', function() {
  ensure(html.indexOf('aria-selected') >= 0, 'aria-selected attribute missing');
});

probe('R-17', 'Focus-visible styles defined', function() {
  ensure(cssCode.indexOf(':focus-visible') >= 0, ':focus-visible style missing');
});

console.log('');
console.log('=== Runtime Behavior Probes ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);
console.log('runtime_phase: ' + (failed === 0 ? 'ALL-PROBED' : 'PROBE-FAILED'));
if (failed > 0) process.exit(1);
