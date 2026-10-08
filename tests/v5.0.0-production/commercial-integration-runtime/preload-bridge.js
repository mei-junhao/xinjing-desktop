'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const commercialMethods = [
  'getSnapshot', 'evaluateAccess', 'applySubscriptionEvent', 'applyOrderEvent',
  'applyDeviceEvent', 'applyQuotaOperation', 'getAuditPage',
  'getModelPriceCatalog', 'getAccountBalance', 'quoteRequestCharge',
  'reserveRequestCharge', 'settleRequestCharge', 'releaseRequestCharge',
  'markRequestUnknown', 'reconcileRequestCharge',
];
const invokes = [];
const exposed = {};
const domEvents = [];
const contextBridge = { exposeInMainWorld(name, value) { exposed[name] = value; } };
const ipcRenderer = {
  invoke(channel, payload) { invokes.push({ channel, payload }); return Promise.resolve({ ok: true }); },
  send() {},
  on() {},
  removeListener() {},
};
const noop = () => ({ style: { removeProperty() {}, setProperty() {} }, classList: { add() {}, toggle() {} }, appendChild() {}, insertBefore() {}, setAttribute() {}, querySelector() { return null; } });
const document = { head: noop(), body: noop(), documentElement: noop(), createElement: noop, querySelector() { return null; }, getElementById() { return null; } };
const sandbox = {
  console: { log() {}, error() {} },
  require(name) { if (name === 'electron') return { contextBridge, ipcRenderer }; throw new Error('unexpected require: ' + name); },
  module: { exports: {} }, exports: {}, Object, Array, JSON, Date, String, Number, Boolean, Math, Promise, Error, RegExp,
  setTimeout, clearTimeout, location: { pathname: '/index.html' }, document,
  window: { addEventListener(type, handler) { domEvents.push({ type, handler }); } },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
new vm.Script(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'), { filename: 'preload.js' }).runInContext(sandbox);

assert.deepEqual(Object.keys(exposed).sort(), ['__XJ_API__', '__XJ__']);
assert.equal(Object.isFrozen(exposed.__XJ_API__.commercial), true);
assert.deepEqual(Object.keys(exposed.__XJ_API__.commercial).sort(), commercialMethods.slice().sort());
for (const method of commercialMethods) {
  assert.equal(typeof exposed.__XJ_API__.commercial[method], 'function');
  exposed.__XJ_API__.commercial[method]({ probe: method });
  const invocation = invokes[invokes.length - 1];
  assert.equal(invocation.channel, 'xj:commercial:' + method);
  assert.deepEqual(invocation.payload, { probe: method });
}
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
for (const method of commercialMethods.slice(0, 7)) assert.match(main, new RegExp(`xj:commercial:${method}`));
process.stdout.write(`COMMERCIAL_PRELOAD_MAIN_BOUNDARY: PASS (${commercialMethods.length} bridge methods, ${domEvents.length} DOM hooks)\n`);
