/* XinJing privacy observability pure core. */
(function (root, factory) {
  'use strict';

  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJPrivacyObservabilityCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MIN_TTL_MS = 60000;
  var DEFAULT_TTL_MS = 86400000;
  var MAX_TTL_MS = 604800000;
  var MIN_CAPACITY = 1;
  var DEFAULT_CAPACITY = 100;
  var MAX_CAPACITY = 500;
  var MAX_CLOCK_MS = 8640000000000000;

  var INPUT_FIELDS = Object.freeze(['errorCode', 'version', 'stage', 'recoveryResult']);
  var ALLOWED_OPTION_KEYS = Object.freeze(['clock', 'retentionMs', 'capacity']);
  var ERROR_CODES = Object.freeze([
    'UNKNOWN_FAILURE',
    'APP_STARTUP_FAILED',
    'RENDERER_EVENT_FAILED',
    'STORAGE_READ_FAILED',
    'STORAGE_WRITE_FAILED',
    'BACKUP_FAILED',
    'AI_REQUEST_FAILED',
    'NETWORK_REQUEST_FAILED',
    'IPC_REQUEST_FAILED',
    'UPDATE_FAILED',
    'SHUTDOWN_FAILED',
  ]);
  var STAGES = Object.freeze([
    'startup',
    'renderer',
    'storage-read',
    'storage-write',
    'backup',
    'ai',
    'network',
    'ipc',
    'update',
    'shutdown',
  ]);
  var RECOVERY_RESULTS = Object.freeze([
    'not-attempted',
    'recovered',
    'degraded',
    'failed',
    'cancelled',
  ]);
  var VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:-[0-9A-Za-z.-]{1,32})?$/;

  function deepFreeze(value, seen) {
    var type = typeof value;
    if (value === null || (type !== 'object' && type !== 'function')) return value;
    var visited = seen || new WeakSet();
    if (visited.has(value)) return value;
    visited.add(value);
    Object.freeze(value);
    var keys = Reflect.ownKeys(value);
    for (var index = 0; index < keys.length; index += 1) {
      deepFreeze(value[keys[index]], visited);
    }
    return value;
  }

  function fail(errorCode) {
    return deepFreeze({ ok: false, errorCode: errorCode, value: null });
  }

  function succeed(value) {
    return deepFreeze({ ok: true, errorCode: '', value: value });
  }

  function safeCall(work) {
    try { return work(); } catch (_) { return fail('internal-failure'); }
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null; // MUTATION: plain-object
  }

  function readDataProperties(value, allowedKeys, exactKeys, invalidCode) {
    if (!isPlainObject(value)) return { ok: false, errorCode: invalidCode };
    var keys = Reflect.ownKeys(value);
    if (keys.some(function (key) { return typeof key !== 'string'; })) {
      return { ok: false, errorCode: invalidCode };
    }
    if (exactKeys && keys.length !== allowedKeys.length) {
      return { ok: false, errorCode: invalidCode };
    }

    var values = {};
    for (var index = 0; index < keys.length; index += 1) {
      var key = keys[index];
      if (allowedKeys.indexOf(key) === -1) return { ok: false, errorCode: invalidCode };
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return { ok: false, errorCode: invalidCode };
      }
      values[key] = descriptor.value;
    }

    if (exactKeys) {
      for (var expectedIndex = 0; expectedIndex < allowedKeys.length; expectedIndex += 1) {
        if (!Object.prototype.hasOwnProperty.call(values, allowedKeys[expectedIndex])) {
          return { ok: false, errorCode: invalidCode };
        }
      }
    }
    return { ok: true, value: values };
  }

  function copyRecord(record) {
    return {
      errorCode: record.errorCode,
      version: record.version,
      stage: record.stage,
      recoveryResult: record.recoveryResult,
      timestamp: record.timestamp,
    };
  }

  function createPrivacyObservability(options) {
    return safeCall(function () {
      var normalizedOptions = options;
      if (normalizedOptions === undefined || normalizedOptions === null) normalizedOptions = {};
      if (!isPlainObject(normalizedOptions)) return fail('invalid-config');

      var optionData = readDataProperties(normalizedOptions, ALLOWED_OPTION_KEYS, false, 'invalid-config');
      if (!optionData.ok) return fail(optionData.errorCode);
      var optionValues = optionData.value;

      var clock = optionValues.clock;
      if (clock !== undefined && typeof clock !== 'function') return fail('invalid-config');

      var retentionMs = optionValues.retentionMs;
      if (retentionMs === undefined) retentionMs = DEFAULT_TTL_MS;
      if (!Number.isSafeInteger(retentionMs) || retentionMs < MIN_TTL_MS || retentionMs > MAX_TTL_MS) {
        return fail('invalid-config');
      }

      var capacity = optionValues.capacity;
      if (capacity === undefined) capacity = DEFAULT_CAPACITY;
      if (!Number.isSafeInteger(capacity) || capacity < MIN_CAPACITY || capacity > MAX_CAPACITY) {
        return fail('invalid-config');
      }

      var enabled = false; // MUTATION: default-disabled
      var records = [];

      function readClock() {
        var value;
        try {
          value = clock ? clock() : Date.now();
        } catch (_) {
          return null;
        }
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CLOCK_MS) return null; // MUTATION: clock-validation
        return value;
      }

      function pruneAt(nowMs) {
        var cutoff = nowMs - retentionMs;
        records = records.filter(function (entry) { return entry.timestampMs >= cutoff; });
      }

      function invalidEvent(errorCode) {
        return { ok: false, errorCode: errorCode || 'invalid-event' };
      }

      function validateEvent(event) {
        if (!isPlainObject(event)) return invalidEvent();
        var keys = Reflect.ownKeys(event);
        if (keys.some(function (key) { return typeof key !== 'string'; })) return invalidEvent();
        if (keys.length !== INPUT_FIELDS.length) return invalidEvent(); // MUTATION: exact-fields

        var values = {};
        for (var index = 0; index < keys.length; index += 1) {
          var key = keys[index];
          if (INPUT_FIELDS.indexOf(key) === -1) return invalidEvent();
          var descriptor = Object.getOwnPropertyDescriptor(event, key);
          if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            return invalidEvent();
          }
          values[key] = descriptor.value;
        }
        for (var fieldIndex = 0; fieldIndex < INPUT_FIELDS.length; fieldIndex += 1) {
          if (!Object.prototype.hasOwnProperty.call(values, INPUT_FIELDS[fieldIndex])) return invalidEvent();
        }

        if (ERROR_CODES.indexOf(values.errorCode) === -1) return invalidEvent('unknown-error-code'); // MUTATION: error-registry
        if (typeof values.version !== 'string' || !VERSION_PATTERN.test(values.version)) return invalidEvent('invalid-version');
        if (STAGES.indexOf(values.stage) === -1) return invalidEvent('unknown-stage');
        if (RECOVERY_RESULTS.indexOf(values.recoveryResult) === -1) return invalidEvent('unknown-recovery-result');
        return { ok: true, value: values };
      }

      var runtime = {
        grantConsent: function () {
          return safeCall(function () {
            enabled = true;
            return succeed({ enabled: true });
          });
        },

        revokeConsent: function () {
          return safeCall(function () {
            var cleared = records.length;
            records = []; // MUTATION: revoke-clears
            enabled = false;
            return succeed({ enabled: false, cleared: cleared });
          });
        },

        record: function (event) {
          return safeCall(function () {
            if (!enabled) return fail('consent-required'); // MUTATION: record-consent
            var eventData = validateEvent(event);
            if (!eventData.ok) return fail(eventData.errorCode);

            var nowMs = readClock();
            if (nowMs === null) return fail('invalid-clock');
            pruneAt(nowMs);

            var values = eventData.value;
            var recordValue = deepFreeze({
              errorCode: values.errorCode,
              version: values.version,
              stage: values.stage,
              recoveryResult: values.recoveryResult,
              timestamp: new Date(nowMs).toISOString(),
            });
            records.push({ timestampMs: nowMs, value: recordValue });
            while (records.length > capacity) records.shift(); // MUTATION: capacity
            return succeed(copyRecord(recordValue)); // MUTATION: isolated-return
          });
        },

        clear: function () {
          return safeCall(function () {
            var cleared = records.length;
            records = [];
            return succeed({ cleared: cleared });
          });
        },

        getState: function () {
          return safeCall(function () {
            var nowMs = readClock();
            if (nowMs === null) return fail('invalid-clock');
            pruneAt(nowMs);
            return succeed({
              enabled: enabled,
              count: records.length,
              retentionMs: retentionMs,
              capacity: capacity,
            });
          });
        },

        exportSupportReport: function () {
          return safeCall(function () {
            if (!enabled) return fail('consent-required');
            var nowMs = readClock();
            if (nowMs === null) return fail('invalid-clock');
            pruneAt(nowMs);
            return succeed({
              schemaVersion: 1,
              generatedAt: new Date(nowMs).toISOString(),
              records: records.map(function (entry) { return copyRecord(entry.value); }),
            });
          });
        },
      };

      return succeed(runtime);
    });
  }

  return deepFreeze({ createPrivacyObservability: createPrivacyObservability });
});
