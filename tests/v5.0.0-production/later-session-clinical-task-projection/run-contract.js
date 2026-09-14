'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const htmlPath = process.env.XJ_LATER_SESSION_HTML || path.join(ROOT, 'app', 'consult-notes.html');
const consultPath = process.env.XJ_LATER_SESSION_JS || path.join(ROOT, 'app', 'js', 'consult-notes.js');
const vmPath = process.env.XJ_LATER_SESSION_VM || path.join(ROOT, 'app', 'js', 'clinical-task-view-model.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const consult = fs.readFileSync(consultPath, 'utf8');
const vmSource = fs.readFileSync(vmPath, 'utf8');

let failures = 0;
function check(id, condition, message) {
  if (condition) process.stdout.write('[PASS] ' + id + '\n');
  else {
    failures += 1;
    process.stderr.write('[FAIL] ' + id + ': ' + message + '\n');
  }
}

const context = vm.createContext({ module: { exports: {} }, exports: {}, globalThis: {}, Object, Array, String, Boolean, Number, Error });
vm.runInContext(vmSource, context, { filename: vmPath });
const TaskVM = context.module.exports;
const base = {
  id: 'SYN-T01', clientId: 'SYN-C01', originSessionId: 'SYN-SA', title: '合成任务',
  status: 'open', due: '', sourceRefs: ['session:SYN-SA'], target: 'consult-notes.html',
  createdBy: 'manual', actionRunId: '', createdAt: '2026-07-27T00:00:00Z', completedAt: ''
};
const terminal = Object.assign({}, base, { id: 'SYN-T02', status: 'done', completedAt: '2026-07-27T01:00:00Z' });
const otherClient = Object.assign({}, base, { id: 'SYN-T03', clientId: 'SYN-C02' });
const projected = TaskVM.project([base, terminal, otherClient], 'SYN-C01', 'SYN-SB', { allowLaterSession: true });

check('C01-real-viewmodel-later-session', projected.ok === true && projected.value.active.length === 1 && projected.value.active[0].originSessionId === 'SYN-SA', 'real ViewModel must retain prior origin');
check('C02-terminal-hidden', projected.ok === true && projected.value.terminal.length === 0, 'terminal tasks must remain hidden');
check('C03-cross-client-rejected', projected.ok === true && projected.value.rejected.some((item) => item.id === 'SYN-T03' && item.reason === 'cross-client'), 'cross-client task must be rejected');

const storeRead = 'Store.getClinicalTasksByClient(currentClientId)';
check('C04-same-client-store-read', consult.includes(storeRead) && !consult.includes('Store.getClinicalTasks(),\n        currentClientId'), 'consult page must use same-client Store read');
check('C05-later-session-option', /allowLaterSession:\s*true/.test(consult), 'later-session option missing');
check('C06-origin-retained', consult.includes('task.originSessionId === currentSessionId') && consult.includes('Store.getSession(task.originSessionId)'), 'origin trace label missing');
check('C07-origin-client-gate', consult.includes("String(origin.clientId || '') !== currentClientId"), 'origin client mismatch must fail closed');
check('C08-safe-title-render', consult.includes('App.escapeHtml(task.title)') && consult.includes('App.escapeHtml(task.id)'), 'task fields must be escaped');
check('C09-ai-draft-visible-state', consult.includes("task.status === 'ai-draft'") && consult.includes('待确认'), 'AI draft state must be explicit');
check('C10-stale-dom-cleared', consult.includes("list.innerHTML = ''") && /if \(!currentClientId \|\| !currentSessionId\)/.test(consult), 'selection changes must clear stale content');
check('C11-session-change-rerenders', (consult.match(/renderClinicalTaskContext\(\)/g) || []).length >= 5, 'client/session paths must rerender task context');
check('C12-current-session-gate', consult.includes('var selectedSession = Store.getSession(currentSessionId)') && consult.includes("String(selectedSession.clientId || '') !== currentClientId") && consult.includes('当前会谈不存在或不属于该来访者'), 'current session must exist and match the selected client before tasks render');

const vmScript = html.indexOf('js/clinical-task-view-model.js');
const consultScript = html.indexOf('js/consult-notes.js');
check('C13-script-order', vmScript >= 0 && consultScript > vmScript, 'ViewModel must load before consult page logic');
check('C14-accessible-region', /id="clinical-task-context"[^>]*aria-labelledby="clinical-task-title"[^>]*aria-live="polite"/.test(html), 'accessible live region missing');
check('C15-long-title-wrap', /\.clinical-task-title\{[^}]*overflow-wrap:anywhere/.test(html), 'long title wrapping missing');
check('C16-unframed-form-context', /class="clinical-task-context"/.test(html) && !/clinical-task-context[^\n]*card/.test(html), 'context must remain an unframed form section');

if (failures) {
  process.stderr.write('later-session clinical-task projection: FAIL ' + failures + '\n');
  process.exit(1);
}
process.stdout.write('later-session clinical-task projection: PASS 16/16\n');
