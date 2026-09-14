'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../../..');
const CHAT_HOME = path.join(ROOT, 'app/js/chat-home.js');
const ALLOWED_BILLING_KEYS = new Set([
  'billingMode', 'chargeStatus', 'chargedMinor', 'priceMinor', 'currency',
  'catalogRevision', 'remainingBalanceMinor', 'availableBalanceMinor', 'quotaRemaining',
]);
const BILLING_MODES = new Set(['money-per-request', 'request-count-quota', 'byok', 'trial']);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this._innerHTML = '';
    this.listeners = {};
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this._text = String(value);
    this.children = [];
  }

  get innerHTML() { return this._innerHTML; }

  set textContent(value) {
    this._text = String(value);
    this._innerHTML = '';
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector.startsWith('.') && child.className.split(/\s+/).includes(selector.slice(1))) result.push(child);
        if (selector.startsWith('#') && child.attributes.id === selector.slice(1)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  constructor() {
    this.readyState = 'loading';
    this.nodes = new Map([
      ['chat-msgs', new FakeElement('div')],
      ['chat-input', new FakeElement('textarea')],
      ['chat-send', new FakeElement('button')],
      ['voice-btn', new FakeElement('button')],
    ]);
    this.domReady = null;
  }

  createElement(tagName) { return new FakeElement(tagName); }
  getElementById(id) {
    const node = this.nodes.get(id);
    if (node) node.attributes.id = id;
    return node || null;
  }
  addEventListener(name, handler) {
    if (name === 'DOMContentLoaded') this.domReady = handler;
  }
  fireDomReady() {
    this.readyState = 'complete';
    if (this.domReady) this.domReady();
  }
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function canonicalProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const billing = value.billing;
  if (!billing || typeof billing !== 'object' || Array.isArray(billing)) return null;
  if (Object.keys(billing).some(key => !ALLOWED_BILLING_KEYS.has(key))) return null;
  if (!BILLING_MODES.has(billing.billingMode) || typeof billing.chargeStatus !== 'string') return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  return { billing: { ...billing }, revision: value.revision };
}

async function boot(chat, source, options = {}) {
  const document = new FakeDocument();
  const localStorage = new FakeStorage();
  localStorage.setItem('xj_xinjing_chat_v1', JSON.stringify(chat));
  const window = { localStorage, __XJ_API__: options.api || undefined };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    XJEntitlements: { normalizeCommercialProjection: canonicalProjection },
    console,
    Number,
    Object,
    Array,
    Date,
    JSON,
    String,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
    AgentCore: options.agentCore,
    AgentTools: options.agentTools,
  });
  vm.runInContext(source, context, { filename: CHAT_HOME });
  document.fireDomReady();
  await new Promise(resolve => setImmediate(resolve));
  return { document, messages: document.getElementById('chat-msgs'), window };
}

function settledProjection() {
  return {
    billing: {
      billingMode: 'money-per-request',
      chargeStatus: 'settled',
      chargedMinor: 123,
      priceMinor: 123,
      currency: 'CNY',
      catalogRevision: 7,
      remainingBalanceMinor: 877,
      availableBalanceMinor: 877,
    },
    revision: 9,
  };
}

function countCommercial(messages) { return messages.querySelectorAll('.commercial-meta').length; }
function allText(messages) { return messages.textContent; }

async function runSuite(source = fs.readFileSync(CHAT_HOME, 'utf8')) {
  const valid = await boot([
    { role: 'user', content: '请查询今天的记录' },
    { role: 'assistant', content: '已完成查询', commercial: settledProjection() },
  ], source);
  assert.equal(countCommercial(valid.messages), 1, 'valid restored assistant projection renders one metadata row');
  assert.match(allText(valid.messages), /费用 ¥1\.23/);
  assert.match(allText(valid.messages), /可用余额 ¥8\.77/);

  const trial = await boot([
    { role: 'assistant', content: '本次使用试用额度', commercial: {
      billing: {
        billingMode: 'trial', chargeStatus: 'not-applicable', chargedMinor: null,
        priceMinor: null, currency: null, catalogRevision: null,
        remainingBalanceMinor: null, availableBalanceMinor: null, quotaRemaining: 3,
      },
      revision: 10,
    } },
  ], source);
  assert.equal(countCommercial(trial.messages), 1, 'trial projection renders a non-charge row');
  assert.match(allText(trial.messages), /本次未扣费/);
  assert.match(allText(trial.messages), /剩余次数 3/);
  assert.doesNotMatch(allText(trial.messages), /费用 ¥/);

  const malformed = await boot([{ role: 'assistant', content: '字符串金额', commercial: {
    billing: { ...settledProjection().billing, chargedMinor: '123' }, revision: 1,
  } }], source);
  assert.equal(countCommercial(malformed.messages), 0, 'string amount is rejected');

  const negative = await boot([{ role: 'assistant', content: '负数余额', commercial: {
    billing: { ...settledProjection().billing, availableBalanceMinor: -1 }, revision: 1,
  } }], source);
  assert.equal(countCommercial(negative.messages), 0, 'negative amount is rejected');

  const unknown = await boot([{ role: 'assistant', content: '未知字段', commercial: {
    billing: { ...settledProjection().billing, providerSecret: 'synthetic-secret' }, revision: 1,
  } }], source);
  assert.equal(countCommercial(unknown.messages), 0, 'unknown sensitive field is rejected');

  const absent = await boot([{ role: 'assistant', content: '没有商业投影' }], source);
  assert.equal(countCommercial(absent.messages), 0, 'assistant without projection renders no metadata row');

  const userProjection = await boot([{ role: 'user', content: '用户消息', commercial: settledProjection() }], source);
  assert.equal(countCommercial(userProjection.messages), 0, 'user message never renders commercial metadata');

  const sent = await boot([], source, {
    api: { getState: async () => ({ aiUnlocked: true }) },
    agentTools: {},
    agentCore: {
      runRound: async messages => {
        messages.push({ content: '本次回答', commercial: settledProjection() });
        return { reply: '本次回答', messages };
      },
    },
  });
  sent.window.sendQuick('请回答');
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const saved = JSON.parse(sent.window.localStorage.getItem('xj_xinjing_chat_v1'));
  assert.equal(saved.some(message => message.role === 'assistant' && message.commercial), true, 'new model response is saved as assistant');
  assert.equal(countCommercial(sent.messages), 1, 'new response renders its commercial projection');

  return { passed: 9 };
}

if (require.main === module) {
  runSuite().then(result => {
    console.log(`chat-home commercial projection contract: ${result.passed} cases PASS`);
  }).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { CHAT_HOME, runSuite };
