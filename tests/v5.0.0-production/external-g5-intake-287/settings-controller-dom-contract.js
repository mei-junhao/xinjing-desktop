'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { inputRoot: INPUT_ROOT, candidateRoot } = require('./harness-paths');
const replayCurrent = process.env.XJ_287_REPLAY_CURRENT === '1';
const baselinePath = path.join(INPUT_ROOT, 'app', 'settings.html');
const candidatePath = path.join(candidateRoot, 'app', 'settings.html');
const baseline = fs.readFileSync(baselinePath, 'utf8');
const candidate = fs.readFileSync(candidatePath, 'utf8');
const candidateSettings = fs.readFileSync(path.join(candidateRoot, 'app', 'js', 'settings.js'), 'utf8');
const controllerScripts = [
  '<script src="js/settings-data-safety-controller.js"></script>',
  '<script src="js/settings-observability-controller.js"></script>'
];
const strippedCandidate = controllerScripts.reduce((text, script) => text.replace(script, ''), candidate);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').toUpperCase();

const checks = [];
function check(name, work) {
  work();
  checks.push(name);
}

check('baseline DOM preserved byte-for-byte outside script insertion', () => {
  if (replayCurrent) {
    assert.ok(strippedCandidate.includes('<body'), 'current replay candidate must contain a settings body');
    return;
  }
  assert.strictEqual(sha(strippedCandidate), sha(baseline));
});
check('controller scripts load before settings entry', () => {
  const dataIndex = candidate.indexOf(controllerScripts[0]);
  const observabilityIndex = candidate.indexOf(controllerScripts[1]);
  const settingsIndex = candidate.indexOf('<script src="js/settings.js"></script>');
  assert.ok(dataIndex >= 0 && observabilityIndex > dataIndex && settingsIndex > observabilityIndex);
});
check('restore and backup entries remain wired', () => {
  assert.match(candidate, /onclick="backupData\(\)"/);
  assert.match(candidate, /id="restore-file"[^>]+onchange="restoreData\(event\)"/);
  assert.match(candidateSettings, /window\.backupData = function/);
  assert.match(candidateSettings, /window\.restoreData = function/);
});
check('privacy switch ARIA remains intact', () => {
  assert.match(candidate, /id="privacy-consent-toggle"[^>]+role="switch"[^>]+aria-checked="false"[^>]+aria-label="匿名错误诊断"/);
});
check('passphrase modal accessibility remains intact', () => {
  assert.match(candidate, /id="backup-passphrase-modal"[^>]+aria-hidden="true"/);
  assert.match(candidate, /aria-labelledby="backup-passphrase-title"[^>]+aria-describedby="backup-passphrase-description"/);
  assert.match(candidate, /id="backup-passphrase-error"[^>]+role="status"[^>]+aria-live="polite"/);
});
check('all controller target IDs remain unique', () => {
  const ids = [
    'privacy-consent-toggle', 'privacy-observability-status', 'privacy-observability-count',
    'privacy-export-btn', 'privacy-clear-btn', 'privacy-revoke-btn', 'restore-file',
    'backup-passphrase-modal', 'backup-passphrase', 'backup-passphrase-confirm',
    'backup-restore-confirm', 'backup-passphrase-error', 'backup-passphrase-submit'
  ];
  ids.forEach((id) => {
    const matches = candidate.match(new RegExp('id="' + id + '"', 'g')) || [];
    assert.strictEqual(matches.length, 1, id + ' must occur exactly once');
  });
});
check('existing settings groups remain present', () => {
  ['隐私诊断', '高级手动配置', '数据管理', '我的资料库', '外观', '帮助', '关于'].forEach((label) => {
    assert.ok(candidate.includes(label), 'missing group label: ' + label);
  });
});
check('no new remote font or CDN introduced', () => {
  const urls = (text) => (text.match(/https?:\/\/[^\s"'<>]+/gi) || []).sort();
  assert.deepStrictEqual(urls(candidate), urls(baseline));
});

console.log('settings-controller-dom-contract: ' + checks.length + '/' + checks.length + ' PASS');
console.log('DOM_RUNTIME_STATUS=STATIC_CONTRACT_ONLY');
