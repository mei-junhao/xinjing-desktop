'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateTrayEvidence } = require('./tray-evidence-contract');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS = path.join(__dirname, 'artifacts');
const TASK_ID = process.env.XJ_ELECTRON_RUNTIME_TASK_ID || 'XJ-5.0.0-codex-v4.5-electron-platform-runtime-refresh-38';
const MANIFEST = process.env.XJ_ELECTRON_RUNTIME_MANIFEST
  ? path.resolve(ROOT, process.env.XJ_ELECTRON_RUNTIME_MANIFEST)
  : path.join(ROOT, 'docs', 'agent-coordination', 'v5.0.0', 'inventory', 'codex-electron-platform-runtime-refresh-38', 'protected-files-manifest.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function requireCondition(label, condition) {
  if (!condition) throw new Error(label);
  console.log('[PASS] ' + label);
}

const summaryPath = path.join(ARTIFACTS, 'runtime-summary.json');
const visualPath = path.join(ARTIFACTS, 'manual-visual.json');
const traySessionPath = path.join(ARTIFACTS, 'tray-runtime-session.json');
const nativeDialogPath = path.join(ARTIFACTS, 'native-dialog-session.json');
requireCondition('runtime summary exists', fs.existsSync(summaryPath));
requireCondition('manual visual record exists', fs.existsSync(visualPath));
requireCondition('tray runtime record exists', fs.existsSync(traySessionPath));
requireCondition('native dialog record exists', fs.existsSync(nativeDialogPath));
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const visual = JSON.parse(fs.readFileSync(visualPath, 'utf8'));
const traySession = JSON.parse(fs.readFileSync(traySessionPath, 'utf8'));
const nativeDialog = JSON.parse(fs.readFileSync(nativeDialogPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

requireCondition('runtime and visual evidence are bound to the selected task', summary.task_id === TASK_ID && visual.task_id === TASK_ID && traySession.task_id === TASK_ID && nativeDialog.task_id === TASK_ID && manifest.task_id === TASK_ID);
requireCondition('normal runtime contract has no failed checks', summary.mode === 'normal' && summary.failed === 0 && Array.isArray(summary.checks) && summary.checks.every((entry) => entry.pass));
requireCondition('Electron 43.2.0 is bound in evidence', summary.electron_version === '43.2.0');
requireCondition('temporary profile was used and removed', summary.profile && summary.profile.temporary === true && summary.profile.cleaned === true);
requireCondition('IndexedDB evidence records distinct post-reload time origin', summary.indexeddb && summary.indexeddb.initial && summary.indexeddb.afterReload && summary.indexeddb.initial.timeOrigin !== summary.indexeddb.afterReload.timeOrigin && summary.indexeddb.afterReload.raw && summary.indexeddb.afterReload.raw.nonce === summary.indexeddb.initial.key);
requireCondition('forged file selection was rejected without a path', summary.forged_selection && summary.forged_selection.ok === false && !Object.prototype.hasOwnProperty.call(summary.forged_selection, 'path'));
requireCondition('both packaged boundaries remain expected red', Array.isArray(summary.expected_red) && summary.expected_red.includes('packaged-updater') && summary.expected_red.includes('installer-upgrade-rollback'));
requireCondition('at least one real screenshot was captured', Array.isArray(summary.screenshots) && summary.screenshots.length > 0 && summary.screenshots.every((entry) => fs.existsSync(entry.file) && entry.bytes > 1024));
requireCondition('manual visual cancellation paths were observed', visual.status === 'confirmed' && visual.synthetic_profile_only === true && visual.tray_visible === true && visual.file_picker_cancelled === true && visual.print_dialog_cancelled === true && visual.window_usable_after_cancel === true);
requireCondition('native dialog cancellation record is complete', nativeDialog.stage === 'completed' && nativeDialog.synthetic_profile_only === true && nativeDialog.file_picker_cancelled === true && nativeDialog.print_dialog_cancelled === true && nativeDialog.window_usable_after_cancel === true && visual.tray_evidence.native_dialog_record === 'artifacts/native-dialog-session.json' && sha256(nativeDialogPath) === visual.tray_evidence.native_dialog_record_sha256);
const trayErrors = validateTrayEvidence(traySession, visual, ARTIFACTS);
requireCondition('tray evidence is bound to real main, intercepted auto-start, temporary profile and screenshots', trayErrors.length === 0);
for (const entry of manifest.protected_files) {
  requireCondition('protected hash matches: ' + entry.path, sha256(path.join(ROOT, entry.path)) === entry.sha256);
}
console.log('Artifacts verified: runtime, native-dialog visual record, protected hashes');
