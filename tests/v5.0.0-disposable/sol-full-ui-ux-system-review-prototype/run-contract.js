'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = 'D:/xinjing-electron';
const PROTOTYPE = path.join(
  ROOT,
  'design-previews/5.0.0-sol-full-ui-ux-system-review-prototype'
);
const REQUIRED_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'fixtures.js',
  'route-manifest.json',
  'state-manifest.json',
  'design-system.md',
  'route-review.md',
  'decision-matrix.md',
  'README.md'
];
const REQUIRED_ROUTES = [
  'index', 'chat-home', 'session-calendar', 'consult-notes', 'transcript',
  'transcript-guide', 'report-writing', 'supervision',
  'supervision-mindmap', 'real-supervision', 'real-supervision-ai',
  'masters', 'doc-center', 'doc-growth', 'knowledge', 'billing-shell',
  'billing-calendar', 'settings', 'feedback', 'activation',
  'confirm-close', 'migrate-helper'
];

const results = [];
function check(id, condition, detail) {
  results.push({ id, pass: Boolean(condition), detail });
}
function read(name) {
  return fs.readFileSync(path.join(PROTOTYPE, name), 'utf8');
}

for (const name of REQUIRED_FILES) {
  check(
    `file:${name}`,
    fs.existsSync(path.join(PROTOTYPE, name)),
    `required artifact ${name}`
  );
}

if (fs.existsSync(path.join(PROTOTYPE, 'route-manifest.json'))) {
  const routes = JSON.parse(read('route-manifest.json'));
  check('routes:count', routes.length === 22, `actual=${routes.length}`);
  for (const id of REQUIRED_ROUTES) {
    const route = routes.find((item) => item.id === id);
    check(`route:${id}`, Boolean(route), 'route exists');
    if (route) {
      check(`route-contract:${id}`, [
        'pattern', 'primaryTask', 'primaryAction', 'preservedFunctions',
        'tierImpact', 'states', 'evidenceId'
      ].every((key) => Object.prototype.hasOwnProperty.call(route, key)),
      'route contract fields');
    }
  }
}

if (fs.existsSync(path.join(PROTOTYPE, 'app.js'))) {
  const source = read('app.js');
  check('network:no-fetch', !/\bfetch\s*\(/.test(source), 'no fetch calls');
  check('network:no-xhr', !/XMLHttpRequest/.test(source), 'no XHR');
  check('tier:unknown-fail-closed', source.includes('unknown-feature'), 'unknown feature denial');
  check('compute:separate', source.includes('computeAvailability'), 'separate compute state');
  check('await:truthful-save', source.includes('await simulateResult'), 'awaited result before success');
  check('a11y:keyboard-file', source.includes('keyboard-file-input'), 'keyboard file path');
  check('a11y:reduced-motion', source.includes('reducedMotion'), 'reduced motion state');
}

if (fs.existsSync(path.join(PROTOTYPE, 'styles.css'))) {
  const css = read('styles.css');
  check('style:no-gradient', !/gradient\s*\(/i.test(css), 'no decorative gradients');
  check('style:no-remote-font', !/@import|https?:\/\//i.test(css), 'no remote styles');
  check('style:focus-visible', /:focus-visible/.test(css), 'visible keyboard focus');
  check('style:reduced-motion', /prefers-reduced-motion:\s*reduce/.test(css), 'system reduced motion');
  check('style:narrow', /@media\s*\(max-width:\s*1100px\)/.test(css), 'narrow window layout');
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed
}, null, 2));
process.exit(failed.length ? 1 : 0);
