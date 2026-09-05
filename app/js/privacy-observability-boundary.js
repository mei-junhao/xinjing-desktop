/* XinJing privacy observability production boundary. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJPrivacyObservabilityBoundary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var OPTION_FIELDS = Object.freeze(['coreFactory', 'version', 'clock', 'retentionMs', 'capacity']);
  var RECORD_FIELDS = Object.freeze(['errorCode', 'stage', 'recoveryResult']);
  var CORE_METHODS = Object.freeze([
    'grantConsent', 'revokeConsent', 'clear', 'getState', 'record', 'exportSupportReport'
  ]);
  var ERROR_CODES = Object.freeze([
    'UNKNOWN_FAILURE', 'APP_STARTUP_FAILED', 'RENDERER_EVENT_FAILED', 'STORAGE_READ_FAILED',
    'STORAGE_WRITE_FAILED', 'BACKUP_FAILED', 'AI_REQUEST_FAILED', 'NETWORK_REQUEST_FAILED',
    'IPC_REQUEST_FAILED', 'UPDATE_FAILED', 'SHUTDOWN_FAILED'
  ]);
  var STAGES = Object.freeze([
    'startup', 'renderer', 'storage-read', 'storage-write', 'backup', 'ai',
    'network', 'ipc', 'update', 'shutdown'
  ]);
  var RECOVERY_RESULTS = Object.freeze(['not-attempted', 'recovered', 'degraded', 'failed', 'cancelled']);
  var VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:-[0-9A-Za-z.-]{1,32})?$/;

  function failure(errorCode) {
    return Object.freeze({ ok: false, errorCode: errorCode, value: null });
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    try {
      var prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch (_) { return false; }
  }

  function readDataProperties(value, allowedKeys, exactKeys, invalidCode) {
    if (!isPlainObject(value)) return { ok: false, errorCode: invalidCode };
    var keys;
    try { keys = Reflect.ownKeys(value); } catch (_) { return { ok: false, errorCode: invalidCode }; }
    if (keys.some(function (key) { return typeof key !== 'string'; })) return { ok: false, errorCode: invalidCode };
    if (exactKeys && keys.length !== allowedKeys.length) return { ok: false, errorCode: invalidCode };
    var values = {};
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (allowedKeys.indexOf(key) === -1) return { ok: false, errorCode: invalidCode };
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch (_) { return { ok: false, errorCode: invalidCode }; }
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return { ok: false, errorCode: invalidCode };
      }
      values[key] = descriptor.value;
    }
    if (exactKeys) {
      for (var expected = 0; expected < allowedKeys.length; expected += 1) {
        if (!Object.prototype.hasOwnProperty.call(values, allowedKeys[expected])) return { ok: false, errorCode: invalidCode };
      }
    }
    return { ok: true, value: values };
  }

  function isEnvelope(value) {
    if (!value || typeof value !== 'object') return false;
    try {
      if (!Object.isFrozen(value)) return false;
      var keys = Reflect.ownKeys(value);
      if (keys.length !== 3 || keys.some(function (key) { return typeof key !== 'string'; })) return false;
      if (keys.indexOf('ok') === -1 || keys.indexOf('errorCode') === -1 || keys.indexOf('value') === -1) return false;
      var ok = Object.getOwnPropertyDescriptor(value, 'ok');
      var code = Object.getOwnPropertyDescriptor(value, 'errorCode');
      var result = Object.getOwnPropertyDescriptor(value, 'value');
      return Boolean(ok && Object.prototype.hasOwnProperty.call(ok, 'value') && typeof ok.value === 'boolean' &&
        code && Object.prototype.hasOwnProperty.call(code, 'value') && typeof code.value === 'string' &&
        result && Object.prototype.hasOwnProperty.call(result, 'value'));
    } catch (_) { return false; }
  }

  function validEventValues(values) {
    return typeof values.errorCode === 'string' && ERROR_CODES.indexOf(values.errorCode) !== -1 &&
      typeof values.stage === 'string' && STAGES.indexOf(values.stage) !== -1 &&
      typeof values.recoveryResult === 'string' && RECOVERY_RESULTS.indexOf(values.recoveryResult) !== -1;
  }

  function invoke(runtime, methodName, args) {
    try {
      var result = runtime[methodName].apply(runtime, args || []);
      return isEnvelope(result) ? result : failure('internal-failure');
    } catch (_) { return failure('internal-failure'); }
  }

  function createPrivacyObservabilityBoundary(options) {
    var parsed = readDataProperties(options, OPTION_FIELDS, false, 'invalid-config');
    if (!parsed.ok) return failure(parsed.errorCode);
    var values = parsed.value;
    if (typeof values.coreFactory !== 'function') return failure('invalid-config');
    if (typeof values.version !== 'string' || !VERSION_PATTERN.test(values.version)) return failure('invalid-config');
    if (Object.prototype.hasOwnProperty.call(values, 'clock') && values.clock !== undefined && typeof values.clock !== 'function') return failure('invalid-config');
    if (Object.prototype.hasOwnProperty.call(values, 'retentionMs') && values.retentionMs !== undefined && !Number.isSafeInteger(values.retentionMs)) return failure('invalid-config');
    if (Object.prototype.hasOwnProperty.call(values, 'capacity') && values.capacity !== undefined && !Number.isSafeInteger(values.capacity)) return failure('invalid-config');

    var coreOptions = {};
    if (Object.prototype.hasOwnProperty.call(values, 'clock')) coreOptions.clock = values.clock;
    if (Object.prototype.hasOwnProperty.call(values, 'retentionMs')) coreOptions.retentionMs = values.retentionMs;
    if (Object.prototype.hasOwnProperty.call(values, 'capacity')) coreOptions.capacity = values.capacity;

    var coreResult;
    try { coreResult = values.coreFactory(coreOptions); } catch (_) { return failure('internal-failure'); }
    if (!isEnvelope(coreResult)) return failure('internal-failure');
    if (!coreResult.ok) return coreResult;
    if (!isPlainObject(coreResult.value)) return failure('internal-failure');
    var coreRuntime = coreResult.value;
    var methodData = readDataProperties(coreRuntime, CORE_METHODS, true, 'internal-failure');
    if (!methodData.ok) return failure('internal-failure');
    var runtimeMethods = methodData.value;
    for (var methodIndex = 0; methodIndex < CORE_METHODS.length; methodIndex += 1) {
      if (typeof runtimeMethods[CORE_METHODS[methodIndex]] !== 'function') return failure('internal-failure');
    }

    var boundVersion = values.version;
    var runtime = {
      grantConsent: function () { return invoke(coreRuntime, 'grantConsent'); },
      revokeConsent: function () { return invoke(coreRuntime, 'revokeConsent'); },
      clear: function () { return invoke(coreRuntime, 'clear'); },
      getState: function () { return invoke(coreRuntime, 'getState'); },
      exportSupportReport: function () { return invoke(coreRuntime, 'exportSupportReport'); },
      recordError: function (event) {
        var eventData = readDataProperties(event, RECORD_FIELDS, true, 'invalid-event');
        if (!eventData.ok || !validEventValues(eventData.value)) return failure('invalid-event');
        return invoke(coreRuntime, 'record', [{
          errorCode: eventData.value.errorCode,
          version: boundVersion,
          stage: eventData.value.stage,
          recoveryResult: eventData.value.recoveryResult
        }]);
      }
    };
    return Object.freeze(runtime);
  }

  return Object.freeze({ createPrivacyObservabilityBoundary: createPrivacyObservabilityBoundary });
});
