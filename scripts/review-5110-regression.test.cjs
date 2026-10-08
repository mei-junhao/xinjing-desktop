'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sanitizer = require('../app/js/pii-sanitizer.js');

async function main() {
  assert.equal(sanitizer.maskDocument('王小明今天来访。').text, '王某某今天来访。');
  const clinical = '咨询师说明：长期焦虑，高度紧张。';
  assert.equal(sanitizer.maskDocument(clinical).text, clinical);
  assert.equal(sanitizer.maskDocument('号码 133333333333', { customPatterns: [1, null, {}, '['] }).ok, true);
  const words = ['智远科技', '科技', '智远科技'];
  const single = sanitizer.maskDocument('智远科技', { customWords: [words[0]] });
  const overlap = sanitizer.maskDocument('智远科技', { customWords: words, customPatterns: ['科技'] });
  assert.equal(overlap.text, single.text);
  assert.equal(overlap.report.summary.total_findings, 1);

  // 完整加载生产页面模块，仅替代 DOM、存储和 AI 的外部边界。
  const nodes = Object.fromEntries(['sel-session', 'f1', 'f2', 'f3', 'f4', 'f5', 'f-free', 'soap-s', 'soap-o', 'soap-a', 'soap-p', 'dap-d', 'dap-a', 'dap-p'].map(id => [id, { value: '' }]));
  const sessions = { a: { id: 'a', transcript: '合成会谈甲' }, b: { id: 'b', transcript: '合成会谈乙' } };
  const callbacks = [];
  const writes = [];
  const context = {
    console, setTimeout, clearTimeout,
    document: { getElementById: id => nodes[id] || null, querySelectorAll: () => [] },
    App: { initPage() {}, showToast() {}, featureGate: () => true },
    Store: { getSession: id => sessions[id], updateSessionFull: async value => { writes.push(value); return { ok: true, value }; } },
    AI: { send: (messages, callback) => callbacks.push(callback) }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/js/consult-notes.js'), 'utf8'), context);
  const select = id => { nodes['sel-session'].value = id; context.onSessionChange(); };
  select('a');
  context.generateNoteSummary();
  select('b');
  await callbacks.shift()({ content: '甲摘要' });
  assert.equal(writes.length, 0);
  select('a');
  context.generateNoteSummary();
  select('b'); select('a');
  await callbacks.shift()({ content: '过期甲摘要' });
  assert.equal(writes.length, 0);
  context.generateNoteSummary();
  await callbacks.shift()({ content: '有效甲摘要' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, 'a');
  assert.equal(writes[0].summary, '有效甲摘要');
  console.log('PASS: 脱敏四类回归、摘要切换/切回拒绝、正常摘要保存');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
