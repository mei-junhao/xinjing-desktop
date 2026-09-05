'use strict';
// app/js/update-durable-renderer.js — renderer side of the ONLY IndexedDB
// snapshot/migration boundary. It wraps the frozen Store.exportAll/importAll
// (window.Store) and answers the typed allowlisted IPC from the main process
// through the controlled preload bridge window.__XJ_API__.update.durable.
// The renderer NEVER sees the raw ipcRenderer (contextIsolation is enforced);
// only the two allowlisted request/reply channels are reachable. The renderer
// never receives filesystem paths, updater objects or signing material; it only
// performs real durable reads/writes and returns typed results. A successful
// return means the durable write COMPLETED (importAll uses idbPutMany with
// allowFallback:false and returns ok:false otherwise).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const api = window.__XJ_API__;
  const durable = api && api.update && api.update.durable;
  if (!durable || typeof durable.onRequest !== 'function' || typeof durable.sendReply !== 'function') return;

  const REQUEST = /^[A-Za-z0-9-]{1,80}$/;

  function storeApi() {
    const Store = window.Store;
    if (!Store || typeof Store.exportAll !== 'function' || typeof Store.importAll !== 'function') {
      throw new Error('Store-export-import-unavailable');
    }
    return Store;
  }

  // xj:update:snapshot:request -> await Store.exportAll() -> snapshot:reply
  durable.onRequest('xj:update:snapshot:request', async (request) => {
    try {
      if (!request || typeof request !== 'object' || !REQUEST.test(String(request.operationId || ''))) {
        durable.sendReply('xj:update:snapshot:reply', { ok: false, code: 'bad-request' });
        return;
      }
      const Store = storeApi();
      // REAL async durable read: await exportAll() to completion.
      const payload = await Store.exportAll();
      if (typeof payload !== 'string' || !payload.trim()) {
        durable.sendReply('xj:update:snapshot:reply', { ok: false, code: 'export-empty' });
        return;
      }
      durable.sendReply('xj:update:snapshot:reply', { ok: true, operationId: request.operationId, payload });
    } catch (error) {
      durable.sendReply('xj:update:snapshot:reply', { ok: false, code: 'export-thrown', message: String((error && error.message) || error).slice(0, 200) });
    }
  });

  // xj:update:restore:request -> await Store.importAll() -> restore:reply
  durable.onRequest('xj:update:restore:request', async (request) => {
    try {
      if (!request || typeof request !== 'object' || !REQUEST.test(String(request.operationId || '')) || typeof request.payload !== 'string') {
        durable.sendReply('xj:update:restore:reply', { ok: false, code: 'bad-request' });
        return;
      }
      const Store = storeApi();
      // REAL async durable write: await importAll() to completion. importAll
      // persists with allowFallback:false; ok:false means the IndexedDB write
      // did not complete durably and must fail the update closed.
      const result = await Store.importAll(request.payload);
      if (!result || result.ok !== true) {
        durable.sendReply('xj:update:restore:reply', { ok: false, code: 'import-durable-failed', detail: result && result.error && result.error.code });
        return;
      }
      const quarantine = Array.isArray(result.quarantine) ? result.quarantine : [];
      const deletionQuarantine = Array.isArray(result.deletionQuarantine) ? result.deletionQuarantine : [];
      durable.sendReply('xj:update:restore:reply', { ok: true, operationId: request.operationId, quarantine, deletionQuarantine });
    } catch (error) {
      durable.sendReply('xj:update:restore:reply', { ok: false, code: 'import-thrown', message: String((error && error.message) || error).slice(0, 200) });
    }
  });

  window.addEventListener('DOMContentLoaded', function () {
    // Declare the typed bridge so settings-update-ui can feature-check it.
    if (window.__XJ_API__ && window.__XJ_API__.update && typeof window.__XJ_API__.update.durableReady !== 'function') {
      window.__XJ_API__.update.durableReady = function () { return true; };
    }
  });
})();
