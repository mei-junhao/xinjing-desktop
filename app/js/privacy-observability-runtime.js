/* XinJing privacy observability renderer runtime. */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJPrivacyObservabilityRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULT_VERSION = '4.2.4';
  var SETTINGS_KEY = 'privacyObservability';
  var VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:-[0-9A-Za-z.-]{1,32})?$/;
  var runtime = null;
  var initialized = false;
  var version = DEFAULT_VERSION;
  var revocationFence = false;
  var RUNTIME_METHODS = Object.freeze([
    'grantConsent', 'revokeConsent', 'clear', 'getState', 'recordError', 'exportSupportReport'
  ]);

  function failure(errorCode) { return Object.freeze({ ok: false, errorCode: errorCode, value: null }); }
  function success(value) { return Object.freeze({ ok: true, errorCode: '', value: value }); }
  function hasRuntimeSurface(value) {
    if (!value || typeof value !== 'object') return false;
    try {
      for (var index = 0; index < RUNTIME_METHODS.length; index += 1) {
        if (typeof value[RUNTIME_METHODS[index]] !== 'function') return false;
      }
      return true;
    } catch (_) { return false; }
  }
  function normalizeBoundaryResult(result) {
    try {
      if (hasRuntimeSurface(result)) return success(result);
      if (result && result.ok === false && typeof result.errorCode === 'string' && result.value === null) {
        return failure(result.errorCode);
      }
      if (result && result.ok === true && hasRuntimeSurface(result.value)) return success(result.value);
    } catch (_) { /* Treat malformed boundary output as a failed dependency. */ }
    return failure('runtime-create-failed');
  }
  function getStore() {
    try {
      var store = root && root.Store;
      return store && typeof store.getSettings === 'function' ? store : null;
    } catch (_) { return null; }
  }
  function readPrivacySettings() {
    var store = getStore();
    if (!store) return {};
    try {
      var settings = store.getSettings();
      if (!settings || typeof settings !== 'object') return {};
      var settingsDescriptor = Object.getOwnPropertyDescriptor(settings, SETTINGS_KEY);
      if (!settingsDescriptor || !Object.prototype.hasOwnProperty.call(settingsDescriptor, 'value')) return {};
      var privacy = settingsDescriptor.value;
      if (!privacy || typeof privacy !== 'object' || Array.isArray(privacy)) return {};
      var consentDescriptor = Object.getOwnPropertyDescriptor(privacy, 'consentGranted');
      if (!consentDescriptor || !Object.prototype.hasOwnProperty.call(consentDescriptor, 'value')) return {};
      return { consentGranted: consentDescriptor.value === true };
    } catch (_) { return {}; }
  }
  function persistLocalRejection(store) {
    try {
      if (!store || typeof store.saveSettings !== 'function') return;
      store.saveSettings({ privacyObservability: { consentGranted: false } });
    } catch (_) { /* Durable failure must never turn into an exception. */ }
  }
  function saveConsent(value) {
    var store = getStore();
    var saver;
    try { saver = store && store.saveSettingsDurable; } catch (_) { saver = null; }
    if (!store || typeof saver !== 'function') {
      if (value !== true) persistLocalRejection(store);
      return Promise.resolve(failure('consent-persist-unavailable'));
    }
    var patch = {};
    patch[SETTINGS_KEY] = { consentGranted: value === true };
    return Promise.resolve().then(function () { return saver.call(store, patch); }).then(function (result) {
      if (!result || result.ok !== true) {
        if (value !== true) persistLocalRejection(store);
        return failure('consent-persist-failed');
      }
      return success({ consentGranted: value === true });
    }).catch(function () {
      if (value !== true) persistLocalRejection(store);
      return failure('consent-persist-failed');
    });
  }
  function makeRuntime() {
    var core = root && root.XJPrivacyObservabilityCore;
    var boundary = root && root.XJPrivacyObservabilityBoundary;
    if (!core || typeof core.createPrivacyObservability !== 'function' || !boundary || typeof boundary.createPrivacyObservabilityBoundary !== 'function') {
      return failure('runtime-dependencies-missing');
    }
    try {
      return normalizeBoundaryResult(boundary.createPrivacyObservabilityBoundary({
        coreFactory: core.createPrivacyObservability,
        version: version,
        retentionMs: 86400000,
        capacity: 100,
      }));
    } catch (_) { return failure('runtime-create-failed'); }
  }
  function ensureRuntime(options) {
    if (options && typeof options.version === 'string' && VERSION_PATTERN.test(options.version)) version = options.version;
    if (!runtime) {
      var result = makeRuntime();
      if (!result || !result.ok || !hasRuntimeSurface(result.value)) return result || failure('runtime-create-failed');
      runtime = result.value;
    }
    return Object.freeze({ ok: true, errorCode: '', value: runtime });
  }
  function initialize(options) {
    var ensured = ensureRuntime(options);
    if (!ensured.ok) return ensured;
    var privacy = readPrivacySettings();
    if (privacy.consentGranted === true && !revocationFence) {
      var granted = runtime.grantConsent();
      if (!granted || !granted.ok) return granted || failure('consent-restore-failed');
    }
    initialized = true;
    return runtime.getState();
  }
  function requireRuntime() {
    if (!initialized) return failure('not-initialized');
    return runtime ? Object.freeze({ ok: true, errorCode: '', value: runtime }) : failure('not-initialized');
  }
  function grantConsent() {
    var ensured = initialized ? requireRuntime() : initialize();
    if (!ensured.ok) return Promise.resolve(ensured);
    var granted = runtime.grantConsent();
    if (!granted || !granted.ok) return Promise.resolve(granted || failure('consent-grant-failed'));
    return saveConsent(true).then(function (saved) {
      if (!saved.ok) {
        revocationFence = true;
        runtime.revokeConsent();
        persistLocalRejection(getStore());
        return saved;
      }
      revocationFence = false;
      return granted;
    });
  }
  function revokeConsent() {
    var ensured = requireRuntime();
    if (!ensured.ok) return Promise.resolve(ensured);
    revocationFence = true;
    var revoked = runtime.revokeConsent();
    if (!revoked || !revoked.ok) return Promise.resolve(revoked || failure('consent-revoke-failed'));
    return saveConsent(false).then(function (saved) {
      if (!saved.ok) return saved;
      return revoked;
    });
  }
  function call(name, args) {
    var ensured = requireRuntime();
    if (!ensured.ok) return ensured;
    try { return runtime[name].apply(runtime, args || []); } catch (_) { return failure('runtime-call-failed'); }
  }
  function getErrorRecords() {
    var exported = call('exportSupportReport');
    if (!exported || !exported.ok || !exported.value || !Array.isArray(exported.value.records)) return [];
    return exported.value.records.slice();
  }

  return Object.freeze({
    initialize: initialize,
    grantConsent: grantConsent,
    revokeConsent: revokeConsent,
    clear: function () { return call('clear'); },
    getState: function () { return call('getState'); },
    recordError: function (event) { return call('recordError', [event]); },
    exportSupportReport: function () { return call('exportSupportReport'); },
    getErrorRecords: getErrorRecords,
  });
});
