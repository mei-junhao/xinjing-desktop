'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const defaultModulePath = path.resolve(__dirname, '..', '..', '..', 'app', 'js', 'privacy-observability-core.js');
const modulePath = path.resolve(process.env.MODULE_UNDER_TEST || defaultModulePath);
const source = fs.readFileSync(modulePath, 'utf8');
const core = require(modulePath);

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    process.stdout.write(`FAIL ${name}: ${failures[failures.length - 1].message}\n`);
  }
}

function assertFailure(result, errorCode) {
  assert.deepStrictEqual(Object.keys(result).sort(), ['errorCode', 'ok', 'value']);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, errorCode);
  assert.strictEqual(result.value, null);
  assert.strictEqual(Object.isFrozen(result), true);
}

function assertSuccess(result) {
  assert.deepStrictEqual(Object.keys(result).sort(), ['errorCode', 'ok', 'value']);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errorCode, '');
  assert.strictEqual(Object.isFrozen(result), true);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
  seen.add(value);
  assert.strictEqual(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], seen);
}

function validEvent(overrides) {
  return Object.assign({
    errorCode: 'APP_STARTUP_FAILED',
    version: '5.0.0',
    stage: 'startup',
    recoveryResult: 'not-attempted',
  }, overrides || {});
}

function createEnabled(options) {
  const created = core.createPrivacyObservability(options);
  assertSuccess(created);
  const granted = created.value.grantConsent();
  assertSuccess(granted);
  return created.value;
}

test('POC-01 default disabled', () => {
  const runtime = core.createPrivacyObservability().value;
  assertFailure(runtime.record(validEvent()), 'consent-required');
  assertFailure(runtime.exportSupportReport(), 'consent-required');
});

test('POC-02 grant is explicit and idempotent', () => {
  const runtime = core.createPrivacyObservability().value;
  assert.strictEqual(runtime.grantConsent().value.enabled, true);
  assert.strictEqual(runtime.grantConsent().value.enabled, true);
  assertSuccess(runtime.record(validEvent()));
});

test('POC-03 revoke disables and clears synchronously', () => {
  const runtime = createEnabled({ clock: () => 1000 });
  runtime.record(validEvent());
  const revoked = runtime.revokeConsent();
  assertSuccess(revoked);
  assert.deepStrictEqual(revoked.value, { enabled: false, cleared: 1 });
  assertFailure(runtime.record(validEvent()), 'consent-required');
  runtime.grantConsent();
  assert.strictEqual(runtime.getState().value.count, 0);
});

test('POC-04 exact fixed record schema and generated timestamp', () => {
  const runtime = createEnabled({ clock: () => 1700000000000 });
  const result = runtime.record(validEvent());
  assertSuccess(result);
  assert.deepStrictEqual(Object.keys(result.value).sort(), ['errorCode', 'recoveryResult', 'stage', 'timestamp', 'version']);
  assert.strictEqual(result.value.timestamp, '2023-11-14T22:13:20.000Z');
  assert.notStrictEqual(result.value, runtime.exportSupportReport().value.records[0]);
});

test('POC-04 rejects class instances and null while accepting a null-prototype data object', () => {
  class EventLike {
    constructor() { Object.assign(this, validEvent()); }
  }
  const runtime = createEnabled({ clock: () => 1000 });
  assertFailure(runtime.record(new EventLike()), 'invalid-event');
  assertFailure(runtime.record(null), 'invalid-event');
  const event = Object.assign(Object.create(null), validEvent());
  assertSuccess(runtime.record(event));
});

test('POC-04 rejects accessors without invoking them', () => {
  const runtime = createEnabled({ clock: () => 1000 });
  let getterCalls = 0;
  const event = validEvent();
  Object.defineProperty(event, 'version', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('dynamic-secret'); },
  });
  assertFailure(runtime.record(event), 'invalid-event');
  assert.strictEqual(getterCalls, 0);
});

test('POC-05 rejects unknown error code', () => {
  assertFailure(createEnabled().record(validEvent({ errorCode: 'CUSTOM_FAILURE' })), 'unknown-error-code');
});

test('POC-06 rejects unknown stage', () => {
  assertFailure(createEnabled().record(validEvent({ stage: 'custom' })), 'unknown-stage');
});

test('POC-07 rejects unknown recovery result', () => {
  assertFailure(createEnabled().record(validEvent({ recoveryResult: 'custom' })), 'unknown-recovery-result');
});

test('POC-08 rejects missing and extra raw fields', () => {
  const runtime = createEnabled();
  const missing = validEvent();
  delete missing.version;
  assertFailure(runtime.record(missing), 'invalid-event');
  for (const key of ['timestamp', 'message', 'stack', 'path', 'prompt', 'token', 'clinicalBody', 'modelOutput']) {
    assertFailure(runtime.record(Object.assign(validEvent(), { [key]: 'redacted-test-value' })), 'invalid-event');
  }
});

test('POC-09 validates TTL bounds and prunes with one operation clock read', () => {
  assertFailure(core.createPrivacyObservability({ retentionMs: 59999 }), 'invalid-config');
  assertFailure(core.createPrivacyObservability({ retentionMs: 604800001 }), 'invalid-config');
  let now = 100000;
  let calls = 0;
  const runtime = createEnabled({ retentionMs: 60000, clock: () => { calls += 1; return now; } });
  assertSuccess(runtime.record(validEvent()));
  assert.strictEqual(calls, 1);
  now += 60001;
  assert.strictEqual(runtime.getState().value.count, 0);
  assert.strictEqual(calls, 2);
});

test('POC-10 enforces capacity and drops oldest', () => {
  let now = 1000;
  const runtime = createEnabled({ capacity: 2, clock: () => now++ });
  runtime.record(validEvent({ errorCode: 'APP_STARTUP_FAILED' }));
  runtime.record(validEvent({ errorCode: 'BACKUP_FAILED', stage: 'backup' }));
  runtime.record(validEvent({ errorCode: 'UPDATE_FAILED', stage: 'update' }));
  const records = runtime.exportSupportReport().value.records;
  assert.deepStrictEqual(records.map((entry) => entry.errorCode), ['BACKUP_FAILED', 'UPDATE_FAILED']);
});

test('POC-11 support export has exact safe schema', () => {
  const runtime = createEnabled({ clock: () => 1700000000000 });
  runtime.record(validEvent());
  const result = runtime.exportSupportReport();
  assertSuccess(result);
  assert.deepStrictEqual(Object.keys(result.value).sort(), ['generatedAt', 'records', 'schemaVersion']);
  assert.strictEqual(result.value.schemaVersion, 1);
  assert.strictEqual(result.value.generatedAt, '2023-11-14T22:13:20.000Z');
  assert.deepStrictEqual(Object.keys(result.value.records[0]).sort(), ['errorCode', 'recoveryResult', 'stage', 'timestamp', 'version']);
});

test('POC-12 envelopes, runtime and nested values are deeply frozen', () => {
  const created = core.createPrivacyObservability({ clock: () => 1000 });
  assertDeepFrozen(created);
  const runtime = created.value;
  assertDeepFrozen(runtime.grantConsent());
  assertDeepFrozen(runtime.record(validEvent()));
  assertDeepFrozen(runtime.getState());
  assertDeepFrozen(runtime.exportSupportReport());
  assertDeepFrozen(runtime.clear());
  assertDeepFrozen(runtime.revokeConsent());
});

test('POC-12 repeated exports do not share internal record identities', () => {
  const runtime = createEnabled({ clock: () => 1000 });
  runtime.record(validEvent());
  const first = runtime.exportSupportReport();
  const second = runtime.exportSupportReport();
  assert.notStrictEqual(first.value.records, second.value.records);
  assert.notStrictEqual(first.value.records[0], second.value.records[0]);
  assert.deepStrictEqual(first.value.records[0], second.value.records[0]);
});

test('POC-12 record return does not expose the stored record identity', () => {
  const browserContext = {};
  vm.createContext(browserContext);
  vm.runInContext("globalThis.__storedRecord = null; const push = Array.prototype.push; Array.prototype.push = function (...items) { const entry = items[0]; if (items.length === 1 && entry && typeof entry.timestampMs === 'number' && entry.value && typeof entry.value.timestamp === 'string') globalThis.__storedRecord = entry.value; return push.apply(this, items); };", browserContext);
  vm.runInContext(source, browserContext, { filename: modulePath });
  vm.runInContext("const runtime = XJPrivacyObservabilityCore.createPrivacyObservability({ clock: () => 1000 }).value; runtime.grantConsent(); globalThis.__recordedValue = runtime.record({ errorCode: 'APP_STARTUP_FAILED', version: '5.0.0', stage: 'startup', recoveryResult: 'not-attempted' }).value;", browserContext);
  assert.notStrictEqual(browserContext.__recordedValue, browserContext.__storedRecord);
});

test('POC-13 source has no forbidden runtime surface', () => {
  for (const pattern of [/require\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bconsole\./, /\bdocument\b/, /\belectron\b/, /\bipcRenderer\b/, /\bipcMain\b/]) {
    assert.strictEqual(pattern.test(source), false, `forbidden source surface: ${pattern}`);
  }
});

test('POC-14 CommonJS and designated browser global share one API identity', () => {
  assert.strictEqual(globalThis.XJPrivacyObservabilityCore, core);
  assert.strictEqual(typeof core.createPrivacyObservability, 'function');
  assert.strictEqual(Object.isFrozen(core), true);
  const browserContext = {};
  vm.runInNewContext(source, browserContext, { filename: modulePath });
  assert.strictEqual(typeof browserContext.XJPrivacyObservabilityCore.createPrivacyObservability, 'function');
  assert.strictEqual(Object.isFrozen(browserContext.XJPrivacyObservabilityCore), true);
});

test('POC-15 invalid and throwing clocks fail closed without state mutation', () => {
  const clocks = [
    () => NaN,
    () => -1,
    () => 8640000000000001,
    () => { throw new Error('clock-secret'); },
  ];
  for (const clock of clocks) {
    const runtime = createEnabled({ clock });
    const result = runtime.record(validEvent());
    assertFailure(result, 'invalid-clock');
    assert.strictEqual(JSON.stringify(result).includes('secret'), false);
  }
});

test('POC-15 record, getState and export each read the clock once', () => {
  let calls = 0;
  const values = [1000, 1001, 1002];
  const runtime = createEnabled({ clock: () => { const value = values[calls]; calls += 1; return value; } });
  assertSuccess(runtime.record(validEvent()));
  assert.strictEqual(calls, 1);
  assertSuccess(runtime.getState());
  assert.strictEqual(calls, 2);
  assertSuccess(runtime.exportSupportReport());
  assert.strictEqual(calls, 3);
});

test('POC-15 invalid clock rejects getState and export', () => {
  let now = 1000;
  const runtime = createEnabled({ clock: () => now });
  runtime.record(validEvent());
  now = NaN;
  assertFailure(runtime.getState(), 'invalid-clock');
  assertFailure(runtime.exportSupportReport(), 'invalid-clock');
  now = 1001;
  assert.strictEqual(runtime.getState().value.count, 1);
});

test('POC-16 throwing Proxy inputs never escape public methods', () => {
  const proxy = new Proxy({}, {
    ownKeys() { throw new Error('proxy-secret'); },
  });
  const factoryResult = core.createPrivacyObservability(proxy);
  assertFailure(factoryResult, 'internal-failure');
  assert.strictEqual(JSON.stringify(factoryResult).includes('secret'), false);
  const runtime = createEnabled();
  const recordResult = runtime.record(proxy);
  assertFailure(recordResult, 'internal-failure');
  assert.strictEqual(JSON.stringify(recordResult).includes('secret'), false);
});

test('POC-16 factory rejects unsafe option shapes and accessors', () => {
  class Options { constructor() { this.capacity = 2; } }
  assertFailure(core.createPrivacyObservability(new Options()), 'invalid-config');
  assertFailure(core.createPrivacyObservability(42), 'invalid-config');
  let getterCalls = 0;
  const options = {};
  Object.defineProperty(options, 'clock', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('option-secret'); },
  });
  assertFailure(core.createPrivacyObservability(options), 'invalid-config');
  assert.strictEqual(getterCalls, 0);
});

test('POC-16 factory rejects extra string and symbol option fields', () => {
  assertFailure(core.createPrivacyObservability({ capacity: 2, extra: true }), 'invalid-config');
  const symbolOptions = { capacity: 2 };
  symbolOptions[Symbol('extra')] = true;
  assertFailure(core.createPrivacyObservability(symbolOptions), 'invalid-config');
});

test('version registry accepts and rejects exact pattern boundaries', () => {
  const runtime = createEnabled({ clock: () => 1000 });
  for (const version of ['0.0.0', '1.2.3', '999.999.999', '5.0.0-beta.1']) {
    assertSuccess(runtime.record(validEvent({ version })));
  }
  for (const version of ['', '1', '1.0', '01.0.0', '1000.0.0', '1.0.0-', '1.0.0+build']) {
    assertFailure(runtime.record(validEvent({ version })), 'invalid-version');
  }
});

test('clear works in disabled and enabled states', () => {
  const runtime = core.createPrivacyObservability({ clock: () => 1000 }).value;
  assert.deepStrictEqual(runtime.clear().value, { cleared: 0 });
  runtime.grantConsent();
  runtime.record(validEvent());
  assert.deepStrictEqual(runtime.clear().value, { cleared: 1 });
  assert.strictEqual(runtime.getState().value.count, 0);
});

const summary = { passed, failed, total: passed + failed, modulePath, failures };
process.stdout.write(`RESULT ${JSON.stringify(summary)}\n`);
process.exitCode = failed === 0 ? 0 : 1;
