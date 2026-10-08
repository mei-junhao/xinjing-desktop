/* XinJing settings privacy-observability UI controller. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJSettingsObservabilityController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var REPORT_KEYS = Object.freeze(['schemaVersion', 'generatedAt', 'records']);
  var RECORD_KEYS = Object.freeze(['errorCode', 'version', 'stage', 'recoveryResult', 'timestamp']);
  var ERROR_CODES = Object.freeze([
    'UNKNOWN_FAILURE', 'APP_STARTUP_FAILED', 'RENDERER_EVENT_FAILED', 'STORAGE_READ_FAILED',
    'STORAGE_WRITE_FAILED', 'BACKUP_FAILED', 'AI_REQUEST_FAILED', 'NETWORK_REQUEST_FAILED',
    'IPC_REQUEST_FAILED', 'UPDATE_FAILED', 'SHUTDOWN_FAILED'
  ]);
  var STAGES = Object.freeze(['startup', 'renderer', 'storage-read', 'storage-write', 'backup', 'ai', 'network', 'ipc', 'update', 'shutdown']);
  var RECOVERY_RESULTS = Object.freeze(['not-attempted', 'recovered', 'degraded', 'failed', 'cancelled']);
  var VERSION_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:-[0-9A-Za-z.-]{1,32})?$/;

  function success(value) { return { ok: true, errorCode: '', value: value }; }
  function failure(errorCode) { return { ok: false, errorCode: errorCode, value: null }; }
  function dataObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var prototype;
    try { prototype = Object.getPrototypeOf(value); } catch (_) { return null; }
    return prototype === Object.prototype || prototype === null ? value : null;
  }
  function exactData(value, keys) {
    var object = dataObject(value);
    if (!object) return null;
    var ownKeys;
    try { ownKeys = Reflect.ownKeys(object); } catch (_) { return null; }
    if (ownKeys.length !== keys.length || ownKeys.some(function (key) { return typeof key !== 'string' || keys.indexOf(key) === -1; })) return null;
    var result = {};
    for (var index = 0; index < keys.length; index += 1) {
      var descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(object, keys[index]); } catch (_) { return null; }
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      result[keys[index]] = descriptor.value;
    }
    return result;
  }
  function sanitizeSupportReport(value) {
    var report = exactData(value, REPORT_KEYS);
    if (!report || report.schemaVersion !== 1 || typeof report.generatedAt !== 'string' || !Array.isArray(report.records)) return failure('unsafe-support-report');
    var records = [];
    for (var index = 0; index < report.records.length; index += 1) {
      var record = exactData(report.records[index], RECORD_KEYS);
      if (!record || ERROR_CODES.indexOf(record.errorCode) === -1 || !VERSION_PATTERN.test(record.version) ||
          STAGES.indexOf(record.stage) === -1 || RECOVERY_RESULTS.indexOf(record.recoveryResult) === -1 ||
          typeof record.timestamp !== 'string') return failure('unsafe-support-report');
      records.push({
        errorCode: record.errorCode,
        version: record.version,
        stage: record.stage,
        recoveryResult: record.recoveryResult,
        timestamp: record.timestamp
      });
    }
    return success({ schemaVersion: 1, generatedAt: report.generatedAt, records: records });
  }
  function safeState(app) {
    try {
      var result = app && typeof app.getPrivacyObservabilityState === 'function' ? app.getPrivacyObservabilityState() : null;
      var value = result && result.ok === true && result.value && typeof result.value === 'object' ? result.value : null;
      if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.count) || value.count < 0) return { enabled: false, count: 0 };
      return { enabled: value.enabled === true, count: value.count };
    } catch (_) { return { enabled: false, count: 0 }; }
  }

  function createSettingsObservabilityController(dependencies) {
    var deps = dependencies || {};
    var elements = deps.elements || {};
    var app = deps.app || {};
    var toggle = elements.toggle;
    var status = elements.status;
    var countElement = elements.count;
    var exportButton = elements.exportButton;
    var clearButton = elements.clearButton;
    var revokeButton = elements.revokeButton;
    var busy = false;

    function render(message) {
      var state = safeState(app);
      var enabled = state.enabled === true;
      if (toggle) {
        if (toggle.classList && typeof toggle.classList.toggle === 'function') toggle.classList.toggle('on', enabled);
        if (typeof toggle.setAttribute === 'function') toggle.setAttribute('aria-checked', String(enabled));
        toggle.disabled = busy;
      }
      if (exportButton) exportButton.disabled = busy || !enabled;
      if (clearButton) clearButton.disabled = busy || !enabled || state.count === 0;
      if (revokeButton) revokeButton.disabled = busy || !enabled;
      if (status) status.textContent = message || (enabled ? '已启用；只保留匿名诊断枚举，不包含原始错误内容' : '默认关闭；只记录错误码、版本、阶段和恢复结果');
      if (countElement) countElement.textContent = enabled ? (state.count + ' 条匿名记录') : '未启用';
      return state;
    }
    function setBusy(value) { busy = value === true; render(status && status.textContent ? status.textContent : ''); }
    async function toggleConsent() {
      var current = safeState(app);
      setBusy(true);
      try {
        var result = current.enabled
          ? await app.revokePrivacyConsent()
          : await app.grantPrivacyConsent();
        if (!result || result.ok !== true) {
          render(current.enabled ? '撤销未完成，请恢复本地设置后重试' : '同意未保存，诊断仍保持关闭');
          return failure(current.enabled ? 'consent-revoke-failed' : 'consent-grant-failed');
        }
        render(current.enabled ? '已撤销同意，匿名记录已清空' : '已启用；只保留匿名诊断枚举，不包含原始错误内容');
        return success(safeState(app));
      } catch (_) {
        render(current.enabled ? '撤销未完成，请恢复本地设置后重试' : '同意未保存，诊断仍保持关闭');
        return failure('consent-operation-failed');
      } finally {
        setBusy(false);
      }
    }
    async function revokeConsent() {
      setBusy(true);
      try {
        var result = await app.revokePrivacyConsent();
        if (!result || result.ok !== true) {
          render('撤销未完成，请恢复本地设置后重试');
          return failure('consent-revoke-failed');
        }
        render('已撤销同意，匿名记录已清空');
        return success(safeState(app));
      } catch (_) {
        render('撤销未完成，请恢复本地设置后重试');
        return failure('consent-revoke-failed');
      } finally { setBusy(false); }
    }
    function clearDiagnostics() {
      var result;
      try { result = app.clearPrivacyDiagnostics(); } catch (_) { result = null; }
      if (!result || result.ok !== true) {
        render('记录未清空，请稍后重试');
        return failure('diagnostic-clear-failed');
      }
      render('匿名诊断记录已清空');
      return success(safeState(app));
    }
    function exportDiagnostics() {
      var exported;
      try { exported = app.exportPrivacyDiagnostics(); } catch (_) { exported = null; }
      if (!exported || exported.ok !== true || !exported.value) {
        render('请先主动开启诊断后再导出');
        return failure('diagnostic-export-unavailable');
      }
      var safe = sanitizeSupportReport(exported.value);
      if (!safe.ok) {
        render('诊断导出未通过隐私校验');
        return safe;
      }
      try {
        app.downloadFile('心镜-匿名诊断.json', JSON.stringify(safe.value, null, 2), 'application/json');
        if (typeof app.showToast === 'function') app.showToast('匿名诊断已导出', 'success');
        return success({ downloaded: true });
      } catch (_) {
        if (typeof app.showToast === 'function') app.showToast('导出失败，请稍后重试', 'error');
        return failure('diagnostic-export-failed');
      }
    }
    function initialize() {
      render();
      if (toggle && typeof toggle.addEventListener === 'function') toggle.addEventListener('click', toggleConsent);
      if (clearButton && typeof clearButton.addEventListener === 'function') clearButton.addEventListener('click', function () {
        if (typeof app.confirmDialog === 'function') app.confirmDialog('清空全部匿名诊断记录？此操作不可恢复。', clearDiagnostics, true);
      });
      if (revokeButton && typeof revokeButton.addEventListener === 'function') revokeButton.addEventListener('click', function () {
        if (typeof app.confirmDialog === 'function') app.confirmDialog('撤销诊断同意并清空匿名记录？', revokeConsent, true);
      });
      if (exportButton && typeof exportButton.addEventListener === 'function') exportButton.addEventListener('click', exportDiagnostics);
      return success(safeState(app));
    }

    return Object.freeze({
      initialize: initialize,
      render: render,
      toggleConsent: toggleConsent,
      revokeConsent: revokeConsent,
      clearDiagnostics: clearDiagnostics,
      exportDiagnostics: exportDiagnostics
    });
  }

  return Object.freeze({
    sanitizeSupportReport: sanitizeSupportReport,
    createSettingsObservabilityController: createSettingsObservabilityController
  });
});
