'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function validateTrayEvidence(session, visual, artifactRoot) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const expectedTaskId = process.env.XJ_ELECTRON_RUNTIME_TASK_ID || 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-refresh-38';
  check(session && session.task_id === expectedTaskId, 'tray session must be bound to the selected task');
  check(visual && visual.task_id === expectedTaskId, 'manual visual must be bound to the selected task');
  check(session && session.synthetic_profile_only === true, 'tray session must use a synthetic profile');
  check(session && session.production_main_loaded === true, 'real main.js must be loaded');
  check(session && session.tray_constructed === true && session.tray_constructor_count === 1, 'exactly one real tray must be constructed');
  check(session && session.tray_tooltip === '心镜 XinJing', 'tray tooltip must match production');
  check(session && session.tray_menu_opened === true, 'real tray menu must be opened for visual evidence');
  check(session && session.login_item_call_intercepted === true && session.login_item_call_count === 1, 'setLoginItemSettings must be intercepted exactly once');
  check(session && session.error === null, 'tray session must not record an execution error');
  check(session && typeof session.temp_root === 'string' && path.basename(session.temp_root).startsWith('xj-tray-acceptance-'), 'tray session must use the dedicated temporary path prefix');
  check(session && typeof session.temp_root === 'string' && !fs.existsSync(session.temp_root), 'tray session temporary profile must no longer exist');
  check(visual && visual.status === 'confirmed' && visual.tray_visible === true, 'manual visual status must confirm tray visibility');
  check(visual && visual.tray_evidence && visual.tray_evidence.temporary_profile_removed === true, 'temporary tray profile must be removed');

  for (const key of ['runtime_record', 'menu_screenshot', 'desktop_screenshot']) {
    const relative = visual && visual.tray_evidence && visual.tray_evidence[key];
    const expected = visual && visual.tray_evidence && visual.tray_evidence[key + '_sha256'];
    const absolute = relative ? path.resolve(artifactRoot, '..', relative) : '';
    check(Boolean(relative && expected), key + ' path and hash are required');
    check(Boolean(absolute && fs.existsSync(absolute)), key + ' must exist');
    if (absolute && fs.existsSync(absolute) && expected) check(sha256(absolute) === expected, key + ' hash must match');
  }
  return errors;
}

module.exports = { validateTrayEvidence };
