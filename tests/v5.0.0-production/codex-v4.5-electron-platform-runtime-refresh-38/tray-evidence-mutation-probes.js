'use strict';

const fs = require('fs');
const path = require('path');
const { validateTrayEvidence } = require('./tray-evidence-contract');

const ARTIFACTS = path.join(__dirname, 'artifacts');
const baseSession = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'tray-runtime-session.json'), 'utf8'));
const baseVisual = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'manual-visual.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const baseErrors = validateTrayEvidence(baseSession, baseVisual, ARTIFACTS);
if (baseErrors.length) {
  console.error('[BASE_INVALID] ' + baseErrors.join('; '));
  process.exit(1);
}
const mutations = [
  ['disable-login-item-intercept', (session) => { session.login_item_call_intercepted = false; }],
  ['fake-tray-construction', (session) => { session.tray_constructed = false; }],
  ['skip-real-main', (session) => { session.production_main_loaded = false; }],
  ['keep-temporary-profile', (_session, visual) => { visual.tray_evidence.temporary_profile_removed = false; }],
  ['replace-menu-screenshot-hash', (_session, visual) => { visual.tray_evidence.menu_screenshot_sha256 = '0'.repeat(64); }],
  ['cross-task-visual-provenance', (_session, visual) => { visual.task_id = 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-regression-06'; }]
];

let killed = 0;
for (const [name, mutate] of mutations) {
  const session = clone(baseSession);
  const visual = clone(baseVisual);
  mutate(session, visual);
  const errors = validateTrayEvidence(session, visual, ARTIFACTS);
  if (!errors.length) {
    console.error('[SURVIVED] ' + name);
  } else {
    killed += 1;
    console.log('[KILLED] ' + name + ': ' + errors[0]);
  }
}

if (killed !== mutations.length) process.exit(1);
console.log('Tray evidence mutations: ' + killed + '/' + mutations.length + ' killed');
