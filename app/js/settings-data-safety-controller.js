/* XinJing settings data-safety orchestration controller. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XJSettingsDataSafetyController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PASSPHRASE_MIN_LENGTH = 12;
  var PASSPHRASE_MAX_LENGTH = 4096;
  var COLLECTIONS = Object.freeze([
    'clients', 'sessions', 'supervisions', 'supervisorIdentities',
    'masterConversations', 'expenses', 'materialWorkspaces',
    'clinicalActionRuns', 'clinicalTasks', 'importQuarantine',
    'deletionBatches', 'deletionQuarantine'
  ]);

  function success(value) { return { ok: true, errorCode: '', value: value }; }
  function failure(errorCode) { return { ok: false, errorCode: errorCode, value: null }; }
  function passphraseLength(value) { return typeof value === 'string' ? Array.from(value).length : 0; }
  function validateRuntimePassphrase(value) {
    var length = passphraseLength(value);
    if (length < PASSPHRASE_MIN_LENGTH || length > PASSPHRASE_MAX_LENGTH || !String(value || '').trim()) {
      return failure('XJ_BACKUP_PASSPHRASE_TOO_SHORT');
    }
    return success({ length: length });
  }
  function errorCodeOf(result, fallback) {
    if (result && typeof result.errorCode === 'string' && result.errorCode) return result.errorCode;
    if (result && result.error && typeof result.error.code === 'string' && result.error.code) return result.error.code;
    return fallback;
  }
  function errorMessage(code) {
    var messages = {
      XJ_BACKUP_PASSPHRASE_TOO_SHORT: '恢复口令至少需要 12 个字符。',
      XJ_BACKUP_AUTH_FAILED: '恢复口令错误，或备份文件已损坏/被修改。',
      XJ_BACKUP_PACKAGE_INVALID: '这不是可识别的加密备份文件。',
      XJ_BACKUP_PACKAGE_UNSUPPORTED: '备份版本不受当前版本支持。',
      XJ_BACKUP_KDF_UNSUPPORTED: '该备份属于设备自动备份，请在原设备恢复，或使用恢复口令备份跨设备迁移。',
      XJ_BACKUP_PAYLOAD_HASH_MISMATCH: '备份完整性校验失败，当前数据未改变。',
      XJ_BACKUP_SAFETY_WRITE_FAILED: '恢复前安全快照创建失败，当前数据未改变。',
      XJ_IMPORT_DURABLE_FAILED: '数据写入失败，当前数据未改变。',
      XJ_RESTORE_READBACK_FAILED: '恢复后的数据校验失败，已尝试保留原有数据。',
      XJ_RESTORE_ROLLBACK_FAILED: '恢复校验失败且原数据回退未能确认，请勿继续操作。',
      XJ_BACKUP_SENDER_DENIED: '备份请求来源未通过安全校验。'
    };
    return messages[code] || '备份操作失败，当前数据未改变。';
  }
  function parsePayload(text) {
    try {
      var value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== '2.0.0') return null;
      var allowed = ['version', 'exportedAt'].concat(COLLECTIONS);
      var keys = Object.keys(value);
      if (keys.some(function (key) { return allowed.indexOf(key) === -1; })) return null;
      if (value.exportedAt !== undefined && typeof value.exportedAt !== 'string') return null;
      for (var index = 0; index < COLLECTIONS.length; index += 1) {
        if (!Array.isArray(value[COLLECTIONS[index]])) return null;
      }
      return value;
    } catch (_) { return null; }
  }
  function stableIds(values) {
    return values.map(function (value, index) {
      if (value && (typeof value.id === 'string' || typeof value.id === 'number')) return String(value.id);
      return '#' + index;
    }).sort();
  }
  function referenceProjection(parsed) {
    var clients = new Set(parsed.clients.map(function (value) { return String(value && value.id || ''); }).filter(Boolean));
    var sessions = new Set(parsed.sessions.map(function (value) { return String(value && value.id || ''); }).filter(Boolean));
    var invalid = [];
    parsed.sessions.forEach(function (value) {
      if (!value || !value.id || !value.clientId || !clients.has(String(value.clientId))) invalid.push('sessions:' + String(value && value.id || ''));
    });
    ['supervisions', 'expenses', 'materialWorkspaces'].forEach(function (key) {
      parsed[key].forEach(function (value) {
        if (value && value.clientId && !clients.has(String(value.clientId))) invalid.push(key + ':' + String(value.id || ''));
        if (value && value.sessionId && !sessions.has(String(value.sessionId))) invalid.push(key + ':' + String(value.id || ''));
      });
    });
    return invalid.sort();
  }
  function readbackProjection(text) {
    var parsed = parsePayload(text);
    if (!parsed) return null;
    var projection = { version: parsed.version };
    for (var index = 0; index < COLLECTIONS.length; index += 1) {
      var key = COLLECTIONS[index];
      var list = parsed[key];
      projection[key] = { count: list.length, ids: stableIds(list) };
    }
    projection.invalidReferences = referenceProjection(parsed);
    return projection;
  }
  function sameProjection(expectedText, actualText) {
    var expected = readbackProjection(expectedText);
    var actual = readbackProjection(actualText);
    return !!expected && !!actual && JSON.stringify(expected) === JSON.stringify(actual);
  }
  function safeToast(ui, message, type) {
    try { if (ui && typeof ui.showToast === 'function') ui.showToast(message, type); } catch (_) {}
  }
  function clearSecret(request) {
    try { if (request && Object.prototype.hasOwnProperty.call(request, 'passphrase')) request.passphrase = ''; } catch (_) {}
  }

  function createSettingsDataSafetyController(dependencies) {
    var deps = dependencies || {};
    var requestPassphrase = deps.requestPassphrase;
    var bridge = deps.bridge || {};
    var store = deps.store || {};
    var ui = deps.ui || {};

    async function backup() {
      var request = typeof requestPassphrase === 'function' ? await requestPassphrase('export') : null;
      if (!request) return failure('cancelled');
      try {
        var passphraseCheck = validateRuntimePassphrase(request.passphrase);
        if (!passphraseCheck.ok) {
          safeToast(ui, errorMessage(passphraseCheck.errorCode), 'error');
          return passphraseCheck;
        }
        if (typeof bridge.encryptBackup !== 'function' || typeof store.exportAll !== 'function') {
          safeToast(ui, '加密备份暂不可用，请恢复后重试', 'error');
          return failure('XJ_BACKUP_UNAVAILABLE');
        }
        var json = await store.exportAll();
        var encrypted = await bridge.encryptBackup(json, request.passphrase);
        if (!encrypted || encrypted.ok !== true || typeof encrypted.package !== 'string') {
          var encryptionCode = errorCodeOf(encrypted, 'XJ_BACKUP_FAILED');
          safeToast(ui, errorMessage(encryptionCode), 'error');
          return failure(encryptionCode);
        }
        var date = typeof ui.formatDate === 'function' ? ui.formatDate(new Date(), true) : new Date().toISOString().slice(0, 10);
        var dateString = String(date).replace(/-/g, '');
        if (typeof ui.downloadFile === 'function') ui.downloadFile('心镜加密备份_' + dateString + '.xjbackup', encrypted.package, 'application/json');
        if (typeof store.saveSettings === 'function') store.saveSettings({ backupLastTime: new Date().toISOString() });
        safeToast(ui, '加密备份已下载', 'success');
        if (typeof ui.updateBackupTime === 'function') ui.updateBackupTime();
        return success({ downloaded: true });
      } catch (_) {
        safeToast(ui, '加密备份失败，请恢复后重试', 'error');
        return failure('XJ_BACKUP_FAILED');
      } finally {
        clearSecret(request);
      }
    }

    async function restore(input) {
      var operation = input || {};
      var file = operation.file || null;
      var inputElement = operation.inputElement || null;
      if (!file || typeof file.text !== 'function') return failure('no-file');
      var request = typeof requestPassphrase === 'function' ? await requestPassphrase('restore') : null;
      if (!request) return failure('cancelled');
      var before = null;
      var imported = false;
      try {
        var passphraseCheck = validateRuntimePassphrase(request.passphrase);
        if (!passphraseCheck.ok) {
          safeToast(ui, errorMessage(passphraseCheck.errorCode), 'error');
          return passphraseCheck;
        }
        if (!request.confirmed) return failure('confirmation-required');
        if (typeof bridge.decryptBackup !== 'function' || typeof bridge.writeBackupSafetySnapshot !== 'function' ||
            typeof store.exportAll !== 'function' || typeof store.importAll !== 'function') {
          safeToast(ui, '加密恢复暂不可用，请恢复后重试', 'error');
          return failure('XJ_RESTORE_UNAVAILABLE');
        }
        var encryptedText = await file.text();
        var decrypted = await bridge.decryptBackup(encryptedText, request.passphrase);
        if (!decrypted || decrypted.ok !== true || typeof decrypted.payload !== 'string' || !parsePayload(decrypted.payload)) {
          var decryptCode = errorCodeOf(decrypted, 'XJ_BACKUP_PACKAGE_INVALID');
          safeToast(ui, errorMessage(decryptCode), 'error');
          return failure(decryptCode);
        }
        before = await store.exportAll();
        var safety = await bridge.writeBackupSafetySnapshot(before, request.passphrase);
        if (!safety || safety.ok !== true) {
          var safetyCode = errorCodeOf(safety, 'XJ_BACKUP_SAFETY_WRITE_FAILED');
          safeToast(ui, errorMessage(safetyCode), 'error');
          return failure(safetyCode);
        }
        var importResult = await store.importAll(decrypted.payload);
        if (!importResult || importResult.ok !== true) {
          var importCode = errorCodeOf(importResult, 'XJ_IMPORT_DURABLE_FAILED');
          safeToast(ui, errorMessage(importCode), 'error');
          return failure(importCode);
        }
        imported = true;
        var readback = await store.exportAll();
        if (!sameProjection(decrypted.payload, readback)) {
          var rollback = await store.importAll(before);
          if (!rollback || rollback.ok !== true) {
            safeToast(ui, errorMessage('XJ_RESTORE_ROLLBACK_FAILED'), 'error');
            return failure('XJ_RESTORE_ROLLBACK_FAILED');
          }
          var rollbackReadback = await store.exportAll();
          if (!sameProjection(before, rollbackReadback)) {
            safeToast(ui, errorMessage('XJ_RESTORE_ROLLBACK_FAILED'), 'error');
            return failure('XJ_RESTORE_ROLLBACK_FAILED');
          }
          safeToast(ui, errorMessage('XJ_RESTORE_READBACK_FAILED'), 'error');
          return failure('XJ_RESTORE_READBACK_FAILED');
        }
        if (inputElement) inputElement.value = '';
        safeToast(ui, '数据已恢复；当前设置和 API 密钥未改变', 'success');
        if (typeof ui.reload === 'function') ui.reload();
        return success({ restored: true, readbackVerified: true });
      } catch (_) {
        if (imported && before && typeof store.importAll === 'function') {
          try {
            var catchRollback = await store.importAll(before);
            if (!catchRollback || catchRollback.ok !== true || !sameProjection(before, await store.exportAll())) {
              safeToast(ui, errorMessage('XJ_RESTORE_ROLLBACK_FAILED'), 'error');
              return failure('XJ_RESTORE_ROLLBACK_FAILED');
            }
          } catch (_) {
            safeToast(ui, errorMessage('XJ_RESTORE_ROLLBACK_FAILED'), 'error');
            return failure('XJ_RESTORE_ROLLBACK_FAILED');
          }
        }
        safeToast(ui, '恢复失败，当前数据未改变', 'error');
        return failure('XJ_RESTORE_FAILED');
      } finally {
        clearSecret(request);
      }
    }

    return Object.freeze({ backup: backup, restore: restore });
  }

  return Object.freeze({
    PASSPHRASE_MIN_LENGTH: PASSPHRASE_MIN_LENGTH,
    PASSPHRASE_MAX_LENGTH: PASSPHRASE_MAX_LENGTH,
    validateRuntimePassphrase: validateRuntimePassphrase,
    readbackProjection: readbackProjection,
    createSettingsDataSafetyController: createSettingsDataSafetyController
  });
});
