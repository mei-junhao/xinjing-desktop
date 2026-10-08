'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const TASK = 'XJ-5.1.1-ui-functional-closure-codex-subagent-successor-004';
const SCRATCH = path.join(ROOT, 'qa/task-scratch', TASK);
const checks = [];
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function ok(name, condition, detail) { checks.push({ name, ok: !!condition, detail: detail || '' }); }
function sha(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase(); }

const masters = read('app/js/masters.js');
const mastersCss = read('app/css/masters-clinical.css');
const billing = read('app/js/billing-calendar.js');
const dashboard = read('app/js/dashboard.js');
const index = read('app/index.html');
const supervision = read('app/js/real-supervision.js');
const supervisionHtml = read('app/real-supervision.html');
const calendar = read('app/js/session-calendar.js');
const calendarHtml = read('app/session-calendar.html');

ok('masters-single-panel-state', /__xjMastersPanelState/.test(masters) && /syncPanel\(side, true\)/.test(masters));
ok('masters-grid-collapse-left', /body\.masters-left-collapsed \.masters-workspace \{ grid-template-columns: 0 minmax\(0, 1fr\) 300px; \}/.test(mastersCss));
ok('masters-grid-collapse-right', /body\.masters-right-collapsed \.masters-workspace \{ grid-template-columns: 244px minmax\(0, 1fr\) 0; \}/.test(mastersCss));
ok('masters-round-vertical', /round-mode/.test(masters) && /\.chat-body\.round-mode \{ flex-direction: column/.test(mastersCss));
ok('billing-original-override-delta', /原金额（自动）/.test(billing) && /覆盖金额/.test(billing) && /覆盖差额/.test(billing));
ok('billing-durable-await-ok', /saved = await Store\.updateClientDurable\(clientId, \{ billing: billing \}\)/.test(billing) && /if \(!saved \|\| !saved\.ok\)/.test(billing));
ok('billing-failure-keeps-input', /原输入金额已保留/.test(billing) && /setBillingFeedback\('月结保存失败/.test(billing));
ok('billing-feedback-live', /id="bc-inv-feedback" role="status" aria-live="polite"/.test(billing));
ok('dashboard-eight-shortcut-targets', ['consult-notes.html','supervision.html','masters.html','billing-shell.html','knowledge.html','session-calendar.html'].every((x) => index.includes('href="' + x + '"')) && /id="qr-entry"/.test(index) && /id="more-mod-btn"/.test(index));
ok('dashboard-membership-gate', /openMembershipGate\(button\.dataset\.feature\)/.test(dashboard) && /data-feature="ai-supervise"/.test(index) && /data-feature="ai-masters"/.test(index));
ok('dashboard-route-error-feedback', /快捷入口目标不可用/.test(dashboard) && /allowedRoutes/.test(dashboard));
ok('upload-six-state-markup', /data-state="idle"/.test(supervisionHtml) && /rs-upload-cancel/.test(supervisionHtml) && /rs-upload-retry/.test(supervisionHtml));
ok('upload-progress', /reader\.onprogress/.test(supervision) && /uploadStateUi\('uploading'/.test(supervision));
ok('upload-success-failure', /uploadStateUi\('success'/.test(supervision) && /uploadStateUi\('failure'/.test(supervision));
ok('upload-retry-cancel', /processTranscriptUpload\(uploadJob\.file\)/.test(supervision) && /reader\.abort\(\)/.test(supervision) && /uploadStateUi\('cancel'/.test(supervision));
ok('calendar-aria-live-regression', /id="period-label"[^>]*aria-live="polite"/.test(calendarHtml) && /updatePeriodLabel/.test(calendar));

const result = { task: TASK, generatedAt: new Date().toISOString(), cwd: ROOT, total: checks.length, passed: checks.filter((x) => x.ok).length, failed: checks.filter((x) => !x.ok).length, checks, sources: { masters: sha(masters), mastersCss: sha(mastersCss), billing: sha(billing), dashboard: sha(dashboard), index: sha(index), supervision: sha(supervision), supervisionHtml: sha(supervisionHtml), calendar: sha(calendar), calendarHtml: sha(calendarHtml) } };
fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(path.join(SCRATCH, 'contract-tests.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.failed ? 1 : 0;
