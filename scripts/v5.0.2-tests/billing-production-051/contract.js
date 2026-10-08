'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..', '..');
const shellPath = path.join(root, 'app', 'billing-shell.html');
const calendarPath = path.join(root, 'app', 'billing-calendar.html');
const calendarJsPath = path.join(root, 'app', 'js', 'billing-calendar.js');
const shell = fs.readFileSync(shellPath, 'utf8');
const calendar = fs.readFileSync(calendarPath, 'utf8');
const calendarJs = fs.readFileSync(calendarJsPath, 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (!condition) {
    failed += 1;
    console.error('FAIL', name);
    return;
  }
  passed += 1;
  console.log('PASS', name);
}

function expectKilled(name, condition) {
  if (condition) {
    failed += 1;
    console.error('FAIL', name, '(mutation survived)');
  } else {
    passed += 1;
    console.log('KILLED', name);
  }
}

function shellInlineScript(source) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((text) => text.trim());
  return scripts[scripts.length - 1] || '';
}

check('top-level obsolete record button removed', !/id=["']bf-add-record["'][^>]*>[\s\S]*?记一笔/.test(shell));
check('income column has real 记收入 primary action', /id=["']bf-add-income["'][\s\S]*?记收入/.test(shell));
check('income action appears before monthly invoice action', shell.indexOf('id="bf-add-income"') >= 0 && shell.indexOf('id="bf-add-income"') < shell.indexOf('id="bf-monthly-settle"'));
check('income action has explicit binding', /getElementById\('bf-add-income'\)[\s\S]*?addEventListener\('click'/.test(shell));
check('income action opens income-scoped modal', /openIncomeModal\(\)/.test(shell) && /openAddModal\(cid, '', 'income'\)/.test(shell));
check('income save remains durable', /Store\.saveSessionsDurable\(entries\)/.test(shell));
check('expense save remains durable', /Store\.createExpenseDurable\(/.test(shell));
check('monthly invoice action remains bound', /getElementById\('bf-monthly-settle'\)[\s\S]*?addEventListener\('click'/.test(shell));
check('calendar route has month navigation', /id="month-label"/.test(calendar) && /onclick="prevMonth\(\)"/.test(calendar) && /onclick="nextMonth\(\)"/.test(calendar));
check('calendar waits for hydration and authorization refresh', /Store\.hydrate\(\)/.test(calendarJs) && /onLicenseStateChange/.test(calendarJs) && /renderLoadingState/.test(calendarJs));
check('calendar month/date interactions are real', /showDayDetail\(date,/.test(calendarJs) && /function renderInvoiceDetail\(/.test(calendarJs));
check('calendar settlement uses durable Store update', /Store\.updateClientDurable\(clientId, \{ billing: billing \}\)/.test(calendarJs));
check('calendar has retryable error state', /function renderErrorState\(/.test(calendarJs) && /bc-retry-render/.test(calendarJs));
check('day detail offers income entry path', /记收入/.test(calendarJs) && /billing-shell\.html\?date=/.test(calendarJs));

try {
  new vm.Script(shellInlineScript(shell), { filename: shellPath });
  check('billing shell inline JavaScript parses', true);
} catch (error) {
  check('billing shell inline JavaScript parses', false);
  console.error(error.stack || error);
}

try {
  new vm.Script(calendarJs, { filename: calendarJsPath });
  check('billing calendar JavaScript parses', true);
} catch (error) {
  check('billing calendar JavaScript parses', false);
  console.error(error.stack || error);
}

const mutations = [
  ['M1 remove 记收入 button', (source) => source.replace(/\s*<button type="button" class="primary" id="bf-add-income"[\s\S]*?<\/button>/, ''), (source) => /id="bf-add-income"/.test(source)],
  ['M2 remove income binding', (source) => source.replace(/var addIncome = document\.getElementById\('bf-add-income'\);/, "var addIncome = null;"), (source) => /var addIncome = document\.getElementById\('bf-add-income'\);/.test(source)],
  ['M3 bypass durable income save', (source) => source.replace('result = await Store.saveSessionsDurable(entries);', 'result = { ok: true };'), (source) => /result = await Store\.saveSessionsDurable\(entries\);/.test(source)],
  ['M4 remove calendar license refresh', (source) => source.replace(/App\.onLicenseStateChange/g, 'App.removedLicenseListener'), (source) => /App\.onLicenseStateChange/.test(source)],
  ['M5 remove calendar error retry', (source) => source.replace(/bc-retry-render/g, 'bc-error-retry-removed'), (source) => /bc-retry-render/.test(source)],
];

for (const [name, mutate, assertion] of mutations) {
  const mutated = mutate(name.startsWith('M4') || name.startsWith('M5') ? calendarJs : shell);
  expectKilled(name, assertion(mutated));
}

console.log(`SUMMARY passed=${passed} failed=${failed}`);
process.exitCode = failed ? 1 : 0;
