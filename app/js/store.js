/* ============================================================
   心镜 XinJing — 数据存储层（v2 全 IndexedDB 架构）
   ------------------------------------------------------------
   设计目标：彻底解除容量焦虑
   - 所有业务数据（来访者 / 会话 / 督导 / 设置）统一存入 IndexedDB
     IndexedDB 容量 = 浏览器分配磁盘空间的 ~80%（轻松数 GB，远高于 50MB）
   - 运行时以「内存 cache」对外提供同步读写，瞬时不阻塞 UI
   - 每次写入后异步持久化到 IndexedDB（不阻塞交互）
   - 启动时必须 await Store.hydrate() 把数据载入内存（由 App.initPage 统一门控）
   - 兼容旧版：首次启动自动把 localStorage 中的 xj_* 数据迁移到 IndexedDB
   - 降级：IndexedDB 不可用时（如隐私模式）自动回退 localStorage，保证不丢当次编辑
   ============================================================ */

const Store = (() => {
  'use strict';

  const clinicalTaskValidators = typeof window !== 'undefined' ? window.ClinicalTaskValidators : null;
  if (!clinicalTaskValidators || typeof clinicalTaskValidators.normalizeClinicalTask !== 'function' ||
      typeof clinicalTaskValidators.hasClinicalBodyField !== 'function') {
    throw new Error('Store requires js/clinical-task-validators.js to be loaded first');
  }

  const DB_NAME = 'xinjing_db';
  const DB_VERSION = 1;
  const STORE = 'kv';

  // 内存缓存（对外同步访问）
  const cache = {
    clients: [],
    sessions: [],
    supervisions: [],
    supervisorIdentities: [],
    masterConversations: [],
    expenses: [],
    materialWorkspaces: [],
    clinicalActionRuns: [],
    clinicalTasks: [],
    importQuarantine: [],
    deletionBatches: [],
    deletionQuarantine: [],
    settings: { apiConfig: {}, version: '1.0.0' },
  };
  let hydrated = false;
  let _dbPromise = null;
  let _dbAvailable = true;
  // Failed durable saves are intentionally kept outside the authoritative cache.
  // A caller can surface the draft and must not switch away until it is resolved.
  const sessionSaveErrors = new Map();
  const storageDiagnostics = [];
  // Commercial state is a redacted renderer projection only; the durable
  // commercial envelope remains owned by the main process.
  let commercialProjection = null;

  function setCommercialProjection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const billing = value.billing;
    if (!billing || typeof billing !== 'object' || Array.isArray(billing)) return false;
    if (!['money-per-request', 'request-count-quota', 'byok', 'trial'].includes(billing.billingMode)) return false;
    if (typeof billing.chargeStatus !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
    commercialProjection = {
      billing: Object.assign({}, billing),
      revision: value.revision,
    };
    return true;
  }

  function getCommercialProjection() {
    return commercialProjection ? {
      billing: Object.assign({}, commercialProjection.billing),
      revision: commercialProjection.revision,
    } : null;
  }

  // ---------- IndexedDB 基础 ----------
  function getDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        _dbAvailable = false;
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => {
        _dbAvailable = false;
        reject(e.target.error);
      };
    });
    // S11 修复：打开失败时清空被缓存的 rejected promise，使后续调用能够重试，
    // 避免「一次性打开失败导致永久所有 DB 操作不可用」（缓存永久 rejected）。
    _dbPromise.catch(() => { _dbPromise = null; });
    return _dbPromise;
  }

  async function idbGet(key) {
    // 降级路径
    if (!_dbAvailable) {
      try {
        const raw = localStorage.getItem('xj2_' + key);
        return raw ? JSON.parse(raw) : undefined;
      } catch (e) {
        return undefined;
      }
    }
    try {
      const db = await getDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result ? r.result.value : undefined);
        r.onerror = () => reject(r.error);
      });
    } catch (e) {
      _dbAvailable = false;
      return idbGet(key); // 重试走降级
    }
  }

  async function idbPut(key, value, options) {
    const allowFallback = !options || options.allowFallback !== false;
    if (!_dbAvailable) {
      if (!allowFallback) throw new Error('IndexedDB unavailable for durable persistence');
      // A durable caller needs the real fallback failure, not a false success.
      localStorage.setItem('xj2_' + key, JSON.stringify(value));
      return;
    }
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      _dbAvailable = false;
      if (!allowFallback) throw e;
      return idbPut(key, value, options); // 重试走降级
    }
  }

  async function idbPutMany(entries, options) {
    const allowFallback = !options || options.allowFallback !== false;
    if (!_dbAvailable) {
      if (!allowFallback) throw new Error('IndexedDB unavailable for durable import');
      // Serialize every value before changing localStorage so an invalid value
      // cannot leave a partly written fallback batch.
      const serialized = entries.map(([key, value]) => ['xj2_' + key, JSON.stringify(value)]);
      serialized.forEach(([key, value]) => localStorage.setItem(key, value));
      return;
    }
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        entries.forEach(([key, value]) => store.put({ key, value }));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error('IndexedDB batch write aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB batch write failed'));
      });
    } catch (e) {
      _dbAvailable = false;
      if (!allowFallback) throw e;
      return idbPutMany(entries, options);
    }
  }

  async function idbDelete(key) {
    if (!_dbAvailable) {
      try { localStorage.removeItem('xj2_' + key); } catch (e) {}
      return;
    }
    try {
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      _dbAvailable = false;
      try { localStorage.removeItem('xj2_' + key); } catch (e2) {}
    }
  }
  function persist(key) {
    // 不阻塞：异步写回，失败静默告警
    idbPut(key, cache[key]).catch((e) => console.warn('[Store] 持久化失败', key, e));
  }

  // ---------- 旧版数据迁移 ----------
  async function migrateFromLocalStorage() {
    const oldMap = {
      'xj_clients': 'clients',
      'xj_sessions': 'sessions',
      'xj_supervisions': 'supervisions',
      'xj_settings': 'settings',
    };
    let migrated = false;
    for (const [oldKey, newKey] of Object.entries(oldMap)) {
      const raw = localStorage.getItem(oldKey);
      if (raw) {
        try {
          const val = JSON.parse(raw);
          await idbPut(newKey, val);
          localStorage.removeItem(oldKey);
          migrated = true;
        } catch (e) {
          /* 解析失败则跳过 */
        }
      }
    }
    // 旧版大文本：xj_blob_<sessionId>:<field>
    const blobKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('xj_blob_')) blobKeys.push(k);
    }
    for (const k of blobKeys) {
      const val = localStorage.getItem(k);
      if (val != null) {
        await idbPut('clients_blob_' + k.slice('xj_blob_'.length), val);
        localStorage.removeItem(k);
        migrated = true;
      }
    }
    if (migrated) console.info('[Store] 已从旧版 localStorage 迁移数据到 IndexedDB');
    return migrated;
  }

  // ---------- 启动加载 ----------
  async function hydrate() {
    if (hydrated) return;
    await migrateFromLocalStorage();
    const [clients, sessions, supervisions, supervisorIdentities, masterConversations, expenses, materialWorkspaces, clinicalActionRuns, clinicalTasks, importQuarantine, deletionBatches, deletionQuarantine, settings] = await Promise.all([
      idbGet('clients'),
      idbGet('sessions'),
      idbGet('supervisions'),
      idbGet('supervisorIdentities'),
      idbGet('masterConversations'),
      idbGet('expenses'),
      idbGet('materialWorkspaces'),
      idbGet('clinicalActionRuns'),
      idbGet('clinicalTasks'),
      idbGet('importQuarantine'),
      idbGet('deletionBatches'),
      idbGet('deletionQuarantine'),
      idbGet('settings'),
    ]);
    cache.clients = Array.isArray(clients) ? clients : [];
    cache.sessions = Array.isArray(sessions) ? sessions : [];
    cache.supervisions = Array.isArray(supervisions) ? supervisions : [];
    cache.supervisorIdentities = Array.isArray(supervisorIdentities) ? supervisorIdentities : [];
    cache.masterConversations = Array.isArray(masterConversations) ? masterConversations.map(normalizeMasterConversation) : [];
    cache.expenses = Array.isArray(expenses) ? expenses : [];
    cache.materialWorkspaces = Array.isArray(materialWorkspaces) ? materialWorkspaces.map(normalizeMaterialWorkspace).filter(Boolean) : [];
    cache.clinicalActionRuns = Array.isArray(clinicalActionRuns) ? clinicalActionRuns.map(normalizeClinicalActionRun).filter(Boolean) : [];
    storageDiagnostics.length = 0;
    cache.clinicalTasks = [];
    if (clinicalTasks !== undefined && !Array.isArray(clinicalTasks)) {
      storageDiagnostics.push({ code: 'XJ_CLINICAL_TASKS_CORRUPT', collection: 'clinicalTasks' });
    }
    const hydratedTaskIds = new Set();
    (Array.isArray(clinicalTasks) ? clinicalTasks : []).forEach((value) => {
      const normalized = normalizeClinicalTask(value);
      const reason = normalized ? clinicalTaskReferenceError(normalized) : 'invalid-task';
      if (!reason && !hydratedTaskIds.has(normalized.id)) {
        hydratedTaskIds.add(normalized.id);
        cache.clinicalTasks.push(normalized);
      } else {
        storageDiagnostics.push({
          code: 'XJ_CLINICAL_TASK_INVALID',
          collection: 'clinicalTasks',
          entityId: String(value && value.id || ''),
          reason: reason || 'duplicate-id',
        });
      }
    });
    cache.importQuarantine = Array.isArray(importQuarantine) ? importQuarantine : [];
    cache.deletionBatches = Array.isArray(deletionBatches)
      ? deletionBatches.map(normalizeDeletionBatch).filter(Boolean)
      : [];
    cache.deletionQuarantine = Array.isArray(deletionQuarantine)
      ? deletionQuarantine.map(normalizeDeletionQuarantineEntry).filter(Boolean)
      : [];
    cache.settings =
      settings && typeof settings === 'object'
        ? Object.assign({ apiConfig: {}, version: '1.0.0' }, settings)
        : { apiConfig: {}, version: '1.0.0' };
    // S8 修复：把旧版拆出的大字段（transcript/soap 等）合并回对应 session，
    // 必须在 maybeDedupe 之前完成，否则去重看不到合并后的会话。
    try { await mergeLegacyBlobs(); } catch (e) { console.error('[Store] 合并旧版 blob 失败（已跳过）', e); }
    hydrated = true;
    // 升级后一次性去重：根治「换端口迁移后同记录出现多份」(1.0.21 暴露 4 份重复)。
    // 去重前会备份原数据到 __xj_dedup_backup_*，并写防重标记，绝不误删内容不同的记录。
    try {
      const removed = await maybeDedupe();
      if (removed > 0) {
        console.info('[Store] 启动去重完成，合并', removed, '条重复记录，即将刷新');
        setTimeout(() => { location.reload(); }, 200);
        return;
      }
    } catch (e) {
      console.error('[Store] 去重异常（已跳过，不影响正常启动）', e);
    }
  }

  function isHydrated() {
    return hydrated;
  }

  // S8 修复：旧版把大字段（transcript / soap / dap / reflection / summary 等）拆到
  // localStorage 的 xj_blob_<sessionId>:<field>，migrateFromLocalStorage 已将其落到
  // IndexedDB 的 clients_blob_<sessionId>:<field>，但此前无人读取 → 数据等于丢失。
  // 此处把它们合并回对应 session 对象（存于 'sessions' 数组），让旧数据真正可用，随后删除孤儿键。
  async function mergeLegacyBlobs() {
    const PREFIX = 'clients_blob_';
    const all = await readAllKv();
    const matches = Object.keys(all).filter((k) => k.indexOf(PREFIX) === 0);
    if (!matches.length) return;
    let changed = 0;
    for (const k of matches) {
      const rest = k.slice(PREFIX.length); // <sessionId>:<field>
      const idx = rest.indexOf(':');
      if (idx <= 0) { try { await idbDelete(k); } catch (e) {} continue; }
      const sessionId = rest.slice(0, idx);
      const field = rest.slice(idx + 1);
      const session = cache.sessions.find((s) => s.id === sessionId);
      if (!session) { try { await idbDelete(k); } catch (e) {} continue; }
      const val = all[k];
      // 仅当目标字段为空才覆盖，绝不覆盖已存在的正式数据
      if (val != null && session[field] == null) {
        session[field] = val;
        changed++;
      }
      try { await idbDelete(k); } catch (e) {}
    }
    if (changed > 0) {
      // 重新计算报告标记后写回
      for (const s of cache.sessions) {
        Object.assign(s, computeSessionFlags(s));
      }
      persist('sessions');
      console.info('[Store] 已合并', changed, '条旧版大字段到对应会话');
    }
  }

  // ---------- 工具 ----------
  function genId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }
  function nowISO() {
    return new Date().toISOString();
  }

  // v4.3 deletion recovery keeps the original objects for restore. Only the
  // marker is durable metadata; it never replaces client/session identity or
  // clinical-task references.
  const DELETION_SCHEMA_VERSION = 1;
  const DELETION_TOMBSTONE_KEY = '__xjDeletionTombstone';
  const DELETION_BATCH_STATUSES = new Set(['applied', 'restored', 'quarantined']);
  const DELETION_COLLECTIONS = [
    'clients', 'sessions', 'records', 'materials', 'supervisions', 'billing',
    'clinicalTasks', 'actionRuns', 'sourceRefs', 'graphReferences',
  ];
  const DELETION_BODY_KEYS = new Set([
    'body', 'content', 'clinicalBody', 'clinical_body', 'transcript', 'rawContent', 'raw_content',
    'soap', 'dap', 'reflection', 'summary', 'prompt', 'modelOutput', 'model_output',
    'extractedText', 'notes', 'messages', 'response', 'request',
  ]);

  function deletionHash(input) {
    let first = 2166136261;
    let second = 2246822519;
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      first = Math.imul(first ^ code, 16777619) >>> 0;
      second = Math.imul(second ^ (code + i), 3266489917) >>> 0;
    }
    return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
  }

  function stableDeletionValue(value, key) {
    if (key && DELETION_BODY_KEYS.has(key)) return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => stableDeletionValue(item));
    const result = {};
    Object.keys(value).sort().forEach((name) => {
      const normalized = stableDeletionValue(value[name], name);
      if (normalized !== undefined) result[name] = normalized;
    });
    return result;
  }

  function stableDeletionStringify(value) {
    return JSON.stringify(stableDeletionValue(value));
  }

  function deletionId(value) {
    const id = value && value.id != null ? String(value.id) : '';
    return id.trim();
  }

  function deletionTombstone(value) {
    const marker = value && value[DELETION_TOMBSTONE_KEY];
    return marker && marker.status === 'tombstoned' ? marker : null;
  }

  function isDeletionTombstoned(value) {
    return !!deletionTombstone(value);
  }

  function cloneDeletion(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeDeletionEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const id = deletionId(value);
    if (!id) return null;
    const result = { id };
    [
      'collection', 'clientId', 'sessionId', 'originSessionId', 'targetType', 'targetId',
      'priorState', 'priorBatchId', 'materialId', 'actionRunId', 'reason',
    ].forEach((key) => {
      if (value[key] != null && typeof value[key] !== 'object') result[key] = String(value[key]);
    });
    ['sessionIds', 'sourceRefs', 'repairChoices'].forEach((key) => {
      if (Array.isArray(value[key])) {
        result[key] = value[key]
          .map((item) => (item && typeof item === 'object' ? item.id : item))
          .filter((item) => item != null && String(item).trim())
          .map((item) => String(item));
      }
    });
    return result;
  }

  function normalizeDeletionBatch(value) {
    if (!value || typeof value !== 'object') return null;
    const batchId = String(value.batchId || '').trim();
    const targetType = String(value.targetType || '').trim();
    const targetId = String(value.targetId || '').trim();
    if (!batchId || !['client', 'session'].includes(targetType) || !targetId) return null;
    const affected = {};
    DELETION_COLLECTIONS.forEach((collection) => {
      affected[collection] = Array.isArray(value.affected && value.affected[collection])
        ? value.affected[collection].map(normalizeDeletionEntry).filter(Boolean)
        : [];
    });
    const entries = Array.isArray(value.entries)
      ? value.entries.map(normalizeDeletionEntry).filter(Boolean)
      : [];
    const status = DELETION_BATCH_STATUSES.has(String(value.status)) ? String(value.status) : 'applied';
    return {
      schemaVersion: Number(value.schemaVersion) || DELETION_SCHEMA_VERSION,
      batchId,
      targetType,
      targetId,
      previewHash: String(value.previewHash || ''),
      storeRevision: String(value.storeRevision || ''),
      status,
      createdAt: String(value.createdAt || ''),
      appliedAt: String(value.appliedAt || ''),
      restoredAt: String(value.restoredAt || ''),
      affected,
      entries,
    };
  }

  function normalizeDeletionQuarantineEntry(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || '').trim();
    const collection = String(value.collection || '').trim();
    const entityId = String(value.entityId || '').trim();
    if (!id || !collection || !entityId) return null;
    return {
      id,
      collection,
      entityId,
      targetType: value.targetType == null ? '' : String(value.targetType),
      targetId: value.targetId == null ? '' : String(value.targetId),
      reason: String(value.reason || 'unknown'),
      repairChoices: Array.isArray(value.repairChoices) ? value.repairChoices.map(String) : [],
      createdAt: String(value.createdAt || ''),
    };
  }

  function makeDeletionQuarantine(collection, entityId, reason, targetType, targetId) {
    return normalizeDeletionQuarantineEntry({
      id: genId('dq'), collection, entityId, reason, targetType, targetId,
      repairChoices: ['inspect-identifier', 'restore-manually'], createdAt: nowISO(),
    });
  }

  function rawClient(id) {
    return cache.clients.find((client) => deletionId(client) === String(id || '')) || null;
  }

  function rawSession(id) {
    return cache.sessions.find((session) => deletionId(session) === String(id || '')) || null;
  }

  function deletionEntry(id, extra) {
    return normalizeDeletionEntry(Object.assign({ id: String(id || '') }, extra || {}));
  }

  function sortedDeletionEntries(entries) {
    return entries.filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function collectDeletionImpact(targetType, targetId) {
    const client = targetType === 'client' ? rawClient(targetId) : null;
    const session = targetType === 'session' ? rawSession(targetId) : null;
    if (targetType === 'client' && !client) return null;
    if (targetType === 'session' && !session) return null;

    const sessionIds = new Set(
      targetType === 'client'
        ? cache.sessions.filter((item) => String(item.clientId || '') === targetId).map((item) => deletionId(item))
        : [targetId]
    );
    const clientId = targetType === 'client' ? targetId : String(session.clientId || '');
    const affected = {};
    DELETION_COLLECTIONS.forEach((collection) => { affected[collection] = []; });

    if (client) affected.clients.push(deletionEntry(clientId));
    if (session) affected.sessions.push(deletionEntry(targetId, { clientId }));
    if (targetType === 'client') {
      cache.sessions
        .filter((item) => String(item.clientId || '') === clientId)
        .forEach((item) => affected.sessions.push(deletionEntry(item.id, { clientId })));
    }

    cache.supervisions.forEach((item) => {
      const references = Array.isArray(item.sessionIds) ? item.sessionIds.map(String) : [];
      // 与物理 deleteClient 的保守级联一致（S5 语义）：仅当督导关联的全部 session 都
      // 在删除集合时才纳入删除；任一关联 session 存活则保留整条督导，避免误删跨 client 督导。
      const allSessionsDeleted = references.length > 0 && references.every((id) => sessionIds.has(id));
      if (allSessionsDeleted) {
        affected.supervisions.push(deletionEntry(item.id, {
          clientId: item.clientId, sessionIds: references,
        }));
      }
    });
    cache.materialWorkspaces.forEach((item) => {
      if ((clientId && String(item.clientId || '') === clientId) || sessionIds.has(String(item.sessionId || ''))) {
        affected.materials.push(deletionEntry(item.id, {
          clientId: item.clientId, sessionId: item.sessionId,
        }));
        if (item.graphId) affected.graphReferences.push(deletionEntry(item.graphId, { materialId: item.id }));
      }
    });
    cache.clinicalTasks.forEach((item) => {
      if (String(item.clientId || '') === clientId || sessionIds.has(String(item.originSessionId || '')) || sessionIds.has(String(item.sessionId || ''))) {
        const sourceRefs = Array.isArray(item.sourceRefs)
          ? item.sourceRefs.map((ref) => (ref && typeof ref === 'object' ? ref.id : ref)).filter(Boolean).map(String)
          : [];
        affected.clinicalTasks.push(deletionEntry(item.id, {
          clientId: item.clientId, originSessionId: item.originSessionId, sourceRefs,
        }));
        sourceRefs.forEach((ref) => affected.sourceRefs.push(deletionEntry(ref, { targetId: item.id })));
      }
    });
    cache.clinicalActionRuns.forEach((item) => {
      const refs = [item, item.origin, item.snapshot].filter((value) => value && typeof value === 'object');
      const touchesClient = refs.some((value) => String(value.clientId || '') === clientId);
      const touchesSession = refs.some((value) => sessionIds.has(String(value.sessionId || '')));
      if (touchesClient || touchesSession) {
        affected.actionRuns.push(deletionEntry(item.id, {
          clientId: item.clientId || (item.origin && item.origin.clientId),
          sessionId: item.sessionId || (item.origin && item.origin.sessionId),
        }));
      }
    });
    cache.expenses.forEach((item) => {
      if ((clientId && String(item.clientId || '') === clientId) || sessionIds.has(String(item.sessionId || ''))) {
        affected.billing.push(deletionEntry(item.id, { clientId: item.clientId, sessionId: item.sessionId }));
      }
    });
    if (targetType === 'client' && client && client.billing && Array.isArray(client.billing.monthlyPayments)) {
      client.billing.monthlyPayments.forEach((payment, index) => {
        const paymentId = payment && payment.id ? payment.id : clientId + ':monthly:' + index;
        affected.billing.push(deletionEntry(paymentId, { clientId }));
      });
    }
    cache.sessions.forEach((item) => {
      if (sessionIds.has(deletionId(item)) && item.billing && typeof item.billing === 'object') {
        affected.billing.push(deletionEntry('session:' + item.id + ':billing', { clientId, sessionId: item.id }));
      }
    });

    DELETION_COLLECTIONS.forEach((collection) => {
      affected[collection] = sortedDeletionEntries(affected[collection]);
    });
    return affected;
  }

  function deletionRevision() {
    const pick = (collection, values) => values.map((item) => ({
      collection,
      id: deletionId(item),
      marker: deletionTombstone(item),
      metadata: stableDeletionValue(item),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const snapshot = {
      clients: pick('clients', cache.clients),
      sessions: pick('sessions', cache.sessions),
      supervisions: pick('supervisions', cache.supervisions),
      materials: pick('materials', cache.materialWorkspaces),
      clinicalTasks: pick('clinicalTasks', cache.clinicalTasks),
      actionRuns: pick('actionRuns', cache.clinicalActionRuns),
      expenses: pick('expenses', cache.expenses),
      deletionBatches: cache.deletionBatches.map((item) => normalizeDeletionBatch(item)).filter(Boolean),
      deletionQuarantine: cache.deletionQuarantine.map((item) => normalizeDeletionQuarantineEntry(item)).filter(Boolean),
    };
    return deletionHash(stableDeletionStringify(snapshot));
  }

  function buildDeletionPreview(targetType, targetId) {
    const affected = collectDeletionImpact(targetType, targetId);
    if (!affected) return null;
    const storeRevision = deletionRevision();
    const previewHash = deletionHash(stableDeletionStringify({
      schemaVersion: DELETION_SCHEMA_VERSION,
      targetType, targetId, storeRevision, affected,
    }));
    const counts = {};
    DELETION_COLLECTIONS.forEach((collection) => { counts[collection] = affected[collection].length; });
    return {
      schemaVersion: DELETION_SCHEMA_VERSION,
      targetType, targetId, storeRevision, previewHash, counts, affected,
    };
  }

  function deletionFailure(code, message) {
    return { ok: false, value: null, error: { code, message } };
  }

  function validateDeletionTarget(targetType, targetId) {
    if (!['client', 'session'].includes(targetType)) return deletionFailure('XJ_DELETION_TARGET_TYPE', 'Only client and session deletion is supported');
    if (!targetId) return deletionFailure('XJ_DELETION_TARGET_ID', 'A target identifier is required');
    const target = targetType === 'client' ? rawClient(targetId) : rawSession(targetId);
    if (!target) return deletionFailure('XJ_DELETION_TARGET_NOT_FOUND', 'The deletion target was not found');
    if (isDeletionTombstoned(target)) return deletionFailure('XJ_DELETION_TARGET_TOMBSTONED', 'The deletion target is already tombstoned');
    return { ok: true, value: target };
  }

  function deletionBatchEntries(affected) {
    const entries = [];
    DELETION_COLLECTIONS.forEach((collection) => {
      (affected[collection] || []).forEach((item) => entries.push(normalizeDeletionEntry(Object.assign({}, item, {
        collection,
        priorState: 'active',
      }))));
    });
    return entries.filter(Boolean).sort((a, b) => (String(a.collection) + ':' + a.id).localeCompare(String(b.collection) + ':' + b.id));
  }

  function tombstoneEntity(entity, batchId, targetType, targetId) {
    return Object.assign({}, entity, {
      [DELETION_TOMBSTONE_KEY]: {
        schemaVersion: DELETION_SCHEMA_VERSION,
        status: 'tombstoned', batchId, targetType, targetId, deletedAt: nowISO(),
      },
    });
  }

  function restoreEntity(entity) {
    const copy = Object.assign({}, entity);
    delete copy[DELETION_TOMBSTONE_KEY];
    return copy;
  }

  function previewDeletionImpact(input) {
    const targetType = String(input && input.targetType || '').trim();
    const targetId = String(input && input.targetId || '').trim();
    const validation = validateDeletionTarget(targetType, targetId);
    if (!validation.ok) return validation;
    return { ok: true, value: buildDeletionPreview(targetType, targetId) };
  }

  async function createDeletionBatch(input) {
    const targetType = String(input && input.targetType || '').trim();
    const targetId = String(input && input.targetId || '').trim();
    const previewHash = String(input && input.previewHash || '').trim();
    if (!previewHash) return deletionFailure('XJ_DELETION_PREVIEW_REQUIRED', 'A current previewHash is required');

    const target = targetType === 'client' ? rawClient(targetId) : rawSession(targetId);
    const existing = cache.deletionBatches.find((item) => item.targetType === targetType && item.targetId === targetId && item.previewHash === previewHash);
    const existingMarker = deletionTombstone(target);
    if (existing && existing.status === 'applied' && existingMarker && existingMarker.batchId === existing.batchId) {
      return { ok: true, value: cloneDeletion(existing), version: existing.appliedAt };
    }

    const validation = validateDeletionTarget(targetType, targetId);
    if (!validation.ok) return validation;

    const preview = buildDeletionPreview(targetType, targetId);
    if (!preview || preview.previewHash !== previewHash) {
      return deletionFailure('XJ_DELETION_PREVIEW_STALE', 'The deletion preview is stale; request a new preview');
    }
    if (existing && existing.status === 'restored') {
      return deletionFailure('XJ_DELETION_BATCH_ALREADY_RESTORED', 'The logical deletion batch has already been restored');
    }

    const batchId = 'delb_' + previewHash;
    const entries = deletionBatchEntries(preview.affected);
    const batch = {
      schemaVersion: DELETION_SCHEMA_VERSION,
      batchId, targetType, targetId, previewHash, storeRevision: preview.storeRevision,
      status: 'applied', createdAt: nowISO(), appliedAt: nowISO(), restoredAt: '',
      affected: cloneDeletion(preview.affected), entries,
    };
    const sessionIds = new Set((preview.affected.sessions || []).map((item) => String(item.id)));
    const clientIds = new Set((preview.affected.clients || []).map((item) => String(item.id)));
    const nextClients = cache.clients.map((item) => clientIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);
    const nextSessions = cache.sessions.map((item) => sessionIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);
    const nextBatches = cache.deletionBatches.concat([batch]);
    const nextQuarantine = cache.deletionQuarantine.slice();
    try {
      await idbPutMany([
        ['clients', nextClients], ['sessions', nextSessions],
        ['deletionBatches', nextBatches], ['deletionQuarantine', nextQuarantine],
      ], { allowFallback: false });
      cache.clients = nextClients;
      cache.sessions = nextSessions;
      cache.deletionBatches = nextBatches;
      cache.deletionQuarantine = nextQuarantine;
      return { ok: true, value: cloneDeletion(batch), version: batch.appliedAt };
    } catch (e) {
      return deletionFailure('XJ_DELETION_BATCH_PERSIST_FAILED', e && e.message ? e.message : 'Deletion batch persistence failed');
    }
  }

  function getDeletionBatch(batchId) {
    const batch = cache.deletionBatches.find((item) => item.batchId === String(batchId || ''));
    return batch ? { ok: true, value: cloneDeletion(batch) } : deletionFailure('XJ_DELETION_BATCH_NOT_FOUND', 'The deletion batch was not found');
  }

  function getDeletionQuarantine() {
    return { ok: true, value: cloneDeletion(cache.deletionQuarantine) };
  }

  async function restoreDeletionBatch(batchId) {
    const batch = cache.deletionBatches.find((item) => item.batchId === String(batchId || ''));
    if (!batch) return deletionFailure('XJ_DELETION_BATCH_NOT_FOUND', 'The deletion batch was not found');
    if (batch.status === 'restored') return { ok: true, value: cloneDeletion(batch), version: batch.restoredAt };
    if (batch.status === 'quarantined') return deletionFailure('XJ_DELETION_BATCH_QUARANTINED', 'The deletion batch requires identifier review');

    const nextClients = cache.clients.slice();
    const nextSessions = cache.sessions.slice();
    const nextQuarantine = cache.deletionQuarantine.slice();
    let mismatch = false;
    (batch.entries || []).filter((entry) => entry.collection === 'clients' || entry.collection === 'sessions').forEach((entry) => {
      const collection = entry.collection === 'clients' ? nextClients : nextSessions;
      const index = collection.findIndex((item) => deletionId(item) === entry.id);
      const entity = index >= 0 ? collection[index] : null;
      const marker = deletionTombstone(entity);
      const ownerMatches = entry.collection !== 'sessions' || !entry.clientId || String(entity && entity.clientId || '') === entry.clientId;
      if (!entity || !marker || marker.batchId !== batch.batchId || !ownerMatches) {
        mismatch = true;
        nextQuarantine.push(makeDeletionQuarantine(entry.collection, entry.id, 'identity-or-ownership-mismatch', batch.targetType, batch.targetId));
        return;
      }
      collection[index] = restoreEntity(entity);
    });
    const nextBatch = Object.assign({}, batch, {
      status: mismatch ? 'quarantined' : 'restored',
      restoredAt: nowISO(),
    });
    const nextBatches = cache.deletionBatches.map((item) => item.batchId === batch.batchId ? nextBatch : item);
    try {
      await idbPutMany([
        ['clients', nextClients], ['sessions', nextSessions],
        ['deletionBatches', nextBatches], ['deletionQuarantine', nextQuarantine],
      ], { allowFallback: false });
      cache.clients = nextClients;
      cache.sessions = nextSessions;
      cache.deletionBatches = nextBatches;
      cache.deletionQuarantine = nextQuarantine;
      if (mismatch) return deletionFailure('XJ_DELETION_RESTORE_QUARANTINED', 'Some identifiers could not be restored safely');
      return { ok: true, value: cloneDeletion(nextBatch), version: nextBatch.restoredAt };
    } catch (e) {
      return deletionFailure('XJ_DELETION_RESTORE_PERSIST_FAILED', e && e.message ? e.message : 'Deletion restore persistence failed');
    }
  }

  // 大师会话 schema v3：旧记录惰性补齐，不改写消息正文，保证跨版本可继续使用。
  function normalizeMasterConversation(conv) {
    if (!conv || typeof conv !== 'object') return conv;
    const createdAt = conv.createdAt || nowISO();
    const messages = Array.isArray(conv.messages) ? conv.messages.map((message) => {
      const item = Object.assign({}, message || {});
      if (!item.id) item.id = genId('msg');
      if (!item.createdAt) item.createdAt = item.ts ? new Date(item.ts).toISOString() : createdAt;
      if (item.status === 'streaming') item.status = 'interrupted';
      if (!item.status) item.status = 'complete';
      return item;
    }) : [];
    const importedHistory = conv.importedHistory && typeof conv.importedHistory === 'object' ? conv.importedHistory : {};
    return Object.assign({}, conv, {
      schemaVersion: 3,
      mode: conv.mode === 'roundtable' ? 'round' : (conv.mode || '1v1'),
      messages,
      settings: Object.assign({ temperature: 60, detail: 50, locale: 'zh-CN' }, conv.settings || {}),
      importedContext: typeof conv.importedContext === 'string' ? conv.importedContext.slice(0, 12000) : '',
      importedHistory: {
        sourceName: String(importedHistory.sourceName || ''),
        importedAt: String(importedHistory.importedAt || ''),
        sourceChars: Math.max(0, Number(importedHistory.sourceChars) || 0),
        messageCount: Math.max(0, Number(importedHistory.messageCount) || 0),
        truncated: !!importedHistory.truncated,
      },
      createdAt,
      updatedAt: conv.updatedAt || createdAt,
    });
  }

  // 计算会话是否含有各类报告（用于工作台/报告中心标记）
  // 账本边界：存在明确 billing 对象才属于财务会谈。
  // 注意：fee=0 仍可能是合法免费/减免咨询，不能用金额判断；临床记录为 billing:null 或缺失。
  function isBillableSession(session) {
    return !!(session && session.billing !== null && typeof session.billing === 'object' && !Array.isArray(session.billing));
  }

  function computeSessionFlags(session) {
    return {
      hasTranscript: !!(session.transcript && session.transcript.trim()),
      hasSoap: !!(
        session.soap &&
        (session.soap.subjective || session.soap.objective || session.soap.assessment || session.soap.plan)
      ),
      hasDap: !!(session.dap && (session.dap.data || session.dap.assessment || session.dap.plan)),
      hasReflection: !!(session.reflection && session.reflection.trim()),
      hasSummary: !!(session.summary && session.summary.trim()),
    };
  }

  // Manual clinical data remains available in every product tier.
  // Keep the compatibility hook at call sites so future policy changes stay centralized.
  function licenseGuard() {}

  // Preserve the public compatibility API without using the license state to
  // restrict manual clinical data. Entitlements are enforced at feature edges.
  function licenseMode() {
    try {
      if (typeof window !== 'undefined' && window.App && typeof window.App.getLicenseState === 'function') {
        const state = window.App.getLicenseState();
        if (state && state.mode) return String(state.mode);
      }
      if (typeof window !== 'undefined' && window.__XJ__ && window.__XJ__.mode) {
        return String(window.__XJ__.mode);
      }
    } catch (e) {}
    return 'free';
  }

  // AI 助手（含 AI 督导）是否解锁：优先读 App 的权威缓存，避免 preload 快照未同步
  function aiUnlocked() {
    try {
      if (typeof window !== 'undefined' && window.App && typeof window.App.aiUnlocked === 'function') {
        return window.App.aiUnlocked();
      }
      if (typeof window !== 'undefined' && window.__XJ__) {
        return window.__XJ__.aiUnlocked !== false;
      }
    } catch (e) {}
    return true; // 非桌面环境（web/演示）默认放开
  }

  // ============================================================
  // 来访者 (Client)
  // ============================================================
  function getClients() {
    return cache.clients.filter((client) => !isDeletionTombstoned(client));
  }
  function getClient(id) {
    return cache.clients.find((c) => c.id === id && !isDeletionTombstoned(c)) || null;
  }
  function saveClient(client) {
    const idx = cache.clients.findIndex((c) => c.id === client.id);
    if (idx >= 0) cache.clients[idx] = client;
    else cache.clients.push(client);
    persist('clients');
    return client;
  }
  function createClient(data) {
    licenseGuard('client', null);
    const client = Object.assign(
      {
        id: genId('c'),
        name: '',
        alias: '',
        gender: 'unknown',
        birthDate: '',
        phone: '',
        email: '',
        firstVisitDate: '',
        status: 'active',
        tags: [],
        notes: '',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      data
    );
    return saveClient(client);
  }
  async function createClientDurable(data) {
    licenseGuard('client', null);
    const client = Object.assign(
      {
        id: genId('c'), name: '', alias: '', gender: 'unknown', birthDate: '', phone: '', email: '',
        firstVisitDate: '', status: 'active', tags: [], notes: '', createdAt: nowISO(), updatedAt: nowISO(),
      },
      data
    );
    const nextClients = cache.clients.concat([client]);
    try {
      await idbPut('clients', nextClients, { allowFallback: false });
      cache.clients = nextClients;
      return { ok: true, value: client, version: client.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_CLIENT_CREATE_FAILED', message: e && e.message ? e.message : 'Client persistence failed' } };
    }
  }
  function updateClient(id, patch) {
    licenseGuard('client', id);
    const client = getClient(id);
    if (!client) return null;
    Object.assign(client, patch, { updatedAt: nowISO() });
    return saveClient(client);
  }
  async function updateClientDurable(id, patch) {
    licenseGuard('client', id);
    const index = cache.clients.findIndex((client) => client.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_CLIENT_NOT_FOUND', message: 'Client was not found' } };
    const client = Object.assign({}, cache.clients[index], patch || {}, { updatedAt: nowISO() });
    const nextClients = cache.clients.slice();
    nextClients[index] = client;
    try {
      await idbPut('clients', nextClients, { allowFallback: false });
      cache.clients = nextClients;
      return { ok: true, value: client, version: client.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_CLIENT_UPDATE_FAILED', message: e && e.message ? e.message : 'Client persistence failed' } };
    }
  }
  function deleteClient(id) {
    licenseGuard('client', id);
    cache.clients = cache.clients.filter((c) => c.id !== id);
    persist('clients');
    // 级联删除会话与督导
    const sessions = cache.sessions.filter((s) => s.clientId !== id);
    cache.sessions = sessions;
    persist('sessions');
    const remainingSessionIds = sessions.map((s) => s.id);
    cache.supervisions = cache.supervisions.filter((sv) => {
      const ids = sv.sessionIds || [];
      // 仅当督导关联的全部 session 都已被删（一个不剩）才级联删除该督导；
      // 用 some（而非 every）避免「任一 session 被删就整条督导丢失」（S5 修复）
      return ids.length === 0 ? true : ids.some((sid) => remainingSessionIds.includes(sid));
    });
    persist('supervisions');
    let materialChanged = false;
    cache.materialWorkspaces = cache.materialWorkspaces.map((material) => {
      if (material.clientId !== id) return material;
      materialChanged = true;
      return Object.assign({}, material, {
        clientId: '', sessionId: '', linkStatus: 'unlinked', updatedAt: nowISO(),
      });
    });
    if (materialChanged) persist('materialWorkspaces');
    return true;
  }

  // ============================================================
  // 会话 (Session) —— 完整内容直接存入 IndexedDB（不再分离大字段）
  // ============================================================
  function getSessions() {
    return cache.sessions.filter((session) => !isDeletionTombstoned(session));
  }
  function getSession(id) {
    return cache.sessions.find((s) => s.id === id && !isDeletionTombstoned(s)) || null;
  }
  function getSessionsByClient(clientId) {
    return getSessions()
      .filter((s) => s.clientId === clientId)
      .sort((a, b) => (a.sessionNumber || 0) - (b.sessionNumber || 0));
  }
  // 判断会话是否含有任何实质内容（供选会话列表过滤空壳幽灵用）
  function sessionHasMaterial(s) {
    if (!s) return false;
    const f = computeSessionFlags(s);
    if (f.hasTranscript || f.hasSoap || f.hasDap || f.hasReflection || f.hasSummary) return true;
    if (isBillableSession(s)) return true; // 账务会谈（含 fee=0 免费咨询）算有内容
    if (s.startTime || s.endTime || (Number(s.durationMinutes) > 0)) return true; // 日历排期节次
    return false;
  }
  // 供各「选会话历史」列表使用的干净列表（纯读取，不修改/删除底层数据）：
  //   1) 过滤孤儿（来访者已删）  2) 按 id 去重  3) 按 日期+节次 去重（留内容最丰富）
  //   4) 折叠同日空壳幽灵：同一天已有「有材料」的会话时，丢弃当天所有「无材料」的会话
  // 目的：修复「第1节 6-30（空壳）」与「第25节 6-30（正确）」同日并存的错误显示。
  function getSessionsForPicker(clientId) {
    if (!getClient(clientId)) return [];
    let list = getSessions().filter((s) => s.clientId === clientId);
    // 1) 按 id 去重
    const byId = new Map();
    for (const s of list) if (!byId.has(s.id)) byId.set(s.id, s);
    list = Array.from(byId.values());
    // 2) 按 日期+节次 去重，留内容最丰富的一条
    const byKey = new Map();
    for (const s of list) {
      const k = (s.date || '') + '#' + (s.sessionNumber || '');
      const prev = byKey.get(k);
      if (!prev || richness(s) > richness(prev)) byKey.set(k, s);
    }
    list = Array.from(byKey.values());
    // 3) 折叠同日空壳幽灵
    const datesWithMaterial = new Set();
    for (const s of list) if (sessionHasMaterial(s)) datesWithMaterial.add(s.date || '');
    list = list.filter((s) => sessionHasMaterial(s) || !datesWithMaterial.has(s.date || ''));
    // 4) 按节次升序
    list.sort((a, b) => (a.sessionNumber || 0) - (b.sessionNumber || 0));
    return list;
  }
  async function getSessionFull(id) {
    // 内容已完整存在于对象中，直接返回（保持 async 兼容旧调用）
    return getSession(id);
  }
  // 下一节序号 = 已有最大序号 + 1（用户可自定义到任意数值，之后顺延）。
  // 例：已有 1、2、3 → 4；用户把某新建节设成 135 → 之后新建的自动从 136 顺延。
  function nextSessionNumber(clientId) {
    const list = getSessionsByClient(clientId);
    if (!list.length) return 1;
    const max = list.reduce((m, s) => Math.max(m, Number(s.sessionNumber) || 0), 0);
    return max + 1;
  }
  function saveSession(session) {
    const idx = cache.sessions.findIndex((s) => s.id === session.id);
    const flags = computeSessionFlags(session);
    const meta = Object.assign({}, session, flags, { updatedAt: nowISO() });
    if (idx >= 0) cache.sessions[idx] = meta;
    else cache.sessions.push(meta);
    persist('sessions');
    // S10 修复：返回带 flags 的 meta（hasTranscript 等），而非原始 session，
    // 否则调用方拿到的对象缺报告标记，报告中心/工作台会误判「无逐字稿/无 SOAP」。
    return meta;
  }

  function sessionSaveScope(clientId, sessionId) {
    return String(clientId || '') + ':' + String(sessionId || '');
  }

  function getSessionSaveError(clientId, sessionId) {
    return sessionSaveErrors.get(sessionSaveScope(clientId, sessionId)) || null;
  }

  function getSessionRecoveryDraft(clientId, sessionId) {
    const failure = getSessionSaveError(clientId, sessionId);
    return failure && failure.draft ? failure.draft : null;
  }

  function canSwitchSession(clientId, sessionId) {
    const blocked = Array.from(sessionSaveErrors.values());
    if (!blocked.length) return { allowed: true, failures: [] };
    return {
      allowed: false,
      reason: 'unsaved-session-draft',
      target: { clientId: String(clientId || ''), sessionId: String(sessionId || '') },
      failures: blocked.map((failure) => ({
        clientId: failure.clientId,
        sessionId: failure.sessionId,
        message: failure.message,
        version: failure.version,
      })),
    };
  }

  function assertCanSwitchSession(clientId, sessionId) {
    const result = canSwitchSession(clientId, sessionId);
    if (result.allowed) return result;
    const error = new Error('Cannot switch while a session draft has not been saved');
    error.code = 'XJ_UNSAVED_SESSION_DRAFT';
    error.recovery = result;
    throw error;
  }

  async function saveSessionDurable(session) {
    const flags = computeSessionFlags(session);
    const meta = Object.assign({}, session, flags, { updatedAt: nowISO() });
    const scope = sessionSaveScope(meta.clientId, meta.id);
    const index = cache.sessions.findIndex((item) => item.id === meta.id);
    const nextSessions = cache.sessions.slice();
    if (index >= 0) nextSessions[index] = meta;
    else nextSessions.push(meta);

    try {
      await idbPut('sessions', nextSessions, { allowFallback: false });
      // The authoritative cache changes only after the transaction completes.
      cache.sessions = nextSessions;
      sessionSaveErrors.delete(scope);
      return { ok: true, value: meta, version: meta.updatedAt };
    } catch (e) {
      const failure = {
        clientId: String(meta.clientId || ''),
        sessionId: String(meta.id || ''),
        draft: meta,
        version: meta.updatedAt,
        message: e && e.message ? e.message : 'Session persistence failed',
        failedAt: nowISO(),
      };
      // Do not replace cache.sessions: existing authoritative data remains intact.
      sessionSaveErrors.set(scope, failure);
      return { ok: false, value: null, version: meta.updatedAt, error: failure };
    }
  }

  async function saveSessionsDurable(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      return { ok: false, value: null, error: { code: 'XJ_SESSION_BATCH_EMPTY', message: 'No sessions were supplied for persistence' } };
    }

    const nextSessions = cache.sessions.slice();
    const metas = [];
    const seenIds = new Set();
    try {
      sessions.forEach((session) => {
        if (!session || !session.clientId) throw new Error('A batch session requires clientId');
        const existing = session.id ? nextSessions.find((item) => item.id === session.id) : null;
        const meta = Object.assign(
          {
            id: session.id || genId('s'), clientId: session.clientId,
            sessionNumber: nextSessionNumber(session.clientId), date: '', startTime: '', endTime: '', durationMinutes: 0,
            transcript: '', soap: { subjective: '', objective: '', assessment: '', plan: '' },
            dap: { data: '', assessment: '', plan: '' }, reflection: '', summary: '', isConfirmed: false,
            createdAt: existing ? existing.createdAt : nowISO(),
          },
          existing || {},
          session,
          computeSessionFlags(session),
          { updatedAt: nowISO() }
        );
        if (seenIds.has(meta.id)) throw new Error('A batch session ID may appear only once');
        seenIds.add(meta.id);
        if (!existing) licenseGuard('client', meta.clientId);
        const index = nextSessions.findIndex((item) => item.id === meta.id);
        if (index >= 0) nextSessions[index] = meta;
        else nextSessions.push(meta);
        metas.push(meta);
      });
      await idbPutMany([['sessions', nextSessions]], { allowFallback: false });
      cache.sessions = nextSessions;
      metas.forEach((meta) => sessionSaveErrors.delete(sessionSaveScope(meta.clientId, meta.id)));
      return { ok: true, value: metas, version: metas.map((meta) => meta.updatedAt) };
    } catch (e) {
      const message = e && e.message ? e.message : 'Session batch persistence failed';
      const failures = metas.map((meta) => {
        const failure = {
          clientId: String(meta.clientId || ''), sessionId: String(meta.id || ''), draft: meta,
          version: meta.updatedAt, message, failedAt: nowISO(),
        };
        sessionSaveErrors.set(sessionSaveScope(meta.clientId, meta.id), failure);
        return failure;
      });
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_SESSION_BATCH_SAVE_FAILED', message, failures } };
    }
  }

  async function saveBillingBatchDurable(data) {
    data = data || {};
    const nextClients = Array.isArray(data.clients) ? data.clients : cache.clients.slice();
    const nextSessions = Array.isArray(data.sessions) ? data.sessions : cache.sessions.slice();
    const nextExpenses = Array.isArray(data.expenses) ? data.expenses : cache.expenses.slice();
    try {
      await idbPutMany([
        ['clients', nextClients],
        ['sessions', nextSessions],
        ['expenses', nextExpenses],
      ], { allowFallback: false });
      cache.clients = nextClients;
      cache.sessions = nextSessions;
      cache.expenses = nextExpenses;
      return { ok: true, value: { clients: nextClients, sessions: nextSessions, expenses: nextExpenses } };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_BILLING_BATCH_FAILED', message: e && e.message ? e.message : 'Billing batch persistence failed' } };
    }
  }

  async function createSessionDurable(data) {
    licenseGuard('client', data.clientId);
    const session = Object.assign(
      {
        id: genId('s'), clientId: data.clientId, sessionNumber: nextSessionNumber(data.clientId),
        date: '', startTime: '', endTime: '', durationMinutes: 0, transcript: '',
        soap: { subjective: '', objective: '', assessment: '', plan: '' },
        dap: { data: '', assessment: '', plan: '' }, reflection: '', summary: '',
        isConfirmed: false, createdAt: nowISO(), updatedAt: nowISO(),
      },
      data
    );
    return saveSessionDurable(session);
  }
  function createSession(data) {
    // S9 修复：受限模式下，溢出（前 5 名之后）的来访者为只读，新建节次应被拦截，
    // 与 updateClient/deleteClient 的 licenseGuard 行为保持一致。
    licenseGuard('client', data.clientId);
    const session = Object.assign(
      {
        id: genId('s'),
        clientId: data.clientId,
        sessionNumber: nextSessionNumber(data.clientId),
        date: '',
        startTime: '',
        endTime: '',
        durationMinutes: 0,
        transcript: '',
        soap: { subjective: '', objective: '', assessment: '', plan: '' },
        dap: { data: '', assessment: '', plan: '' },
        reflection: '',
        summary: '',
        isConfirmed: false,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      data
    );
    return saveSession(session);
  }
  async function updateSessionFull(session) {
    return saveSessionDurable(session);
  }
  function buildSessionDeleteState(ids) {
    const targets = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '')).filter(Boolean));
    const deleted = cache.sessions.filter((session) => targets.has(String(session && session.id || '')));
    if (!deleted.length) return null;
    const deletedIds = new Set(deleted.map((session) => String(session.id)));
    const nextSessions = cache.sessions.filter((session) => !deletedIds.has(String(session && session.id || '')));
    const nextSupervisions = cache.supervisions.map((supervision) => Object.assign({}, supervision, {
      sessionIds: (supervision.sessionIds || []).filter((sessionId) => !deletedIds.has(String(sessionId))),
    }));
    const nextMaterials = cache.materialWorkspaces.map((material) => {
      if (!deletedIds.has(String(material && material.sessionId || ''))) return material;
      return Object.assign({}, material, { sessionId: '', updatedAt: nowISO() });
    });
    return { deleted, nextSessions, nextSupervisions, nextMaterials };
  }

  async function deleteSessionsDurable(ids) {
    const next = buildSessionDeleteState(ids);
    if (!next) return { ok: false, error: { code: 'XJ_SESSION_NOT_FOUND', message: 'Session was not found' } };
    try {
      await idbPutMany([
        ['sessions', next.nextSessions],
        ['supervisions', next.nextSupervisions],
        ['materialWorkspaces', next.nextMaterials],
      ], { allowFallback: false });
      cache.sessions = next.nextSessions;
      cache.supervisions = next.nextSupervisions;
      cache.materialWorkspaces = next.nextMaterials;
      return { ok: true, deletedSessionIds: next.deleted.map((session) => session.id) };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'XJ_DURABLE_SESSION_DELETE_FAILED',
          message: e && e.message ? e.message : 'Session deletion persistence failed',
          failedAt: nowISO(),
        },
      };
    }
  }

  async function deleteSessionDurable(id) {
    return deleteSessionsDurable([id]);
  }

  // Compatibility path for legacy callers. New interactive deletion flows must await deleteSessionDurable/deleteSessionsDurable.
  function deleteSession(id) {
    cache.sessions = cache.sessions.filter((s) => s.id !== id);
    persist('sessions');
    cache.supervisions = cache.supervisions.map((sv) => ({
      ...sv,
      sessionIds: (sv.sessionIds || []).filter((sid) => sid !== id),
    }));
    persist('supervisions');
    let materialChanged = false;
    cache.materialWorkspaces = cache.materialWorkspaces.map((material) => {
      if (material.sessionId !== id) return material;
      materialChanged = true;
      return Object.assign({}, material, { sessionId: '', updatedAt: nowISO() });
    });
    if (materialChanged) persist('materialWorkspaces');
    return true;
  }

  // ============================================================
  // 临床动作与会谈模板选择（4.3）
  // ============================================================
  const SESSION_TEMPLATE_RULES = {
    'manual-session-v1': { minimumTier: 'Free', allowCustom: false },
    'ai-session-v1': { minimumTier: 'Pro', allowCustom: false },
    'flagship-session-v1': { minimumTier: 'Flagship', allowCustom: true },
  };
  const SESSION_TEMPLATE_TIER_RANK = { Free: 0, Pro: 1, Flagship: 2 };

  function normalizeClinicalTask(value) {
    return clinicalTaskValidators.normalizeClinicalTask(value, nowISO);
  }

  function clinicalTaskReferenceError(task, lookup) {
    const client = lookup && lookup.clients
      ? lookup.clients.get(task.clientId)
      : cache.clients.find((item) => String(item && item.id || '') === task.clientId);
    const session = lookup && lookup.sessions
      ? lookup.sessions.get(task.originSessionId)
      : cache.sessions.find((item) => String(item && item.id || '') === task.originSessionId);
    if (!client) return 'unknown-client';
    if (!session) return 'unknown-origin-session';
    if (String(session.clientId || '') !== task.clientId) return 'origin-client-mismatch';
    return '';
  }

  function clinicalTaskFailure(code, message) {
    return { ok: false, value: null, error: { code, message } };
  }

  function copyClinicalTask(task) {
    return task ? Object.assign({}, task, { sourceRefs: task.sourceRefs.slice() }) : null;
  }

  function getClinicalTasks() {
    return cache.clinicalTasks.map(copyClinicalTask);
  }

  function getClinicalTask(id) {
    return copyClinicalTask(cache.clinicalTasks.find((task) => task.id === id) || null);
  }

  function getClinicalTasksByClient(clientId) {
    return cache.clinicalTasks.filter((task) => task.clientId === clientId).map(copyClinicalTask);
  }

  async function persistClinicalTasks(nextTasks, operation) {
    try {
      await idbPut('clinicalTasks', nextTasks, { allowFallback: false });
      cache.clinicalTasks = nextTasks;
      return {
        ok: true,
        value: Array.isArray(operation.value) ? operation.value.map(copyClinicalTask) : copyClinicalTask(operation.value),
        version: operation.version,
      };
    } catch (e) {
      return clinicalTaskFailure(
        operation.failureCode,
        e && e.message ? e.message : 'Clinical task persistence failed'
      );
    }
  }

  async function createClinicalTaskDurable(data) {
    const stamp = nowISO();
    const normalized = normalizeClinicalTask(Object.assign({}, data || {}, {
      id: data && data.id || genId('ct'),
      createdBy: data && data.createdBy || 'manual',
      status: data && data.status || 'open',
      createdAt: data && data.createdAt || stamp,
      updatedAt: stamp,
    }));
    if (!normalized) return clinicalTaskFailure('XJ_CLINICAL_TASK_INVALID', 'Clinical task is invalid');
    if ((normalized.createdBy === 'manual' && normalized.status !== 'open') ||
        (normalized.createdBy === 'ai-draft' && normalized.status !== 'ai-draft')) {
      return clinicalTaskFailure('XJ_CLINICAL_TASK_CREATION_STATUS_INVALID', 'New tasks must begin as manual open or AI draft');
    }
    const referenceError = clinicalTaskReferenceError(normalized);
    if (referenceError) return clinicalTaskFailure('XJ_CLINICAL_TASK_REFERENCE_INVALID', referenceError);
    if (getClinicalTask(normalized.id)) return clinicalTaskFailure('XJ_CLINICAL_TASK_DUPLICATE', 'Clinical task ID already exists');
    return persistClinicalTasks(cache.clinicalTasks.concat([normalized]), {
      value: normalized, version: normalized.updatedAt, failureCode: 'XJ_DURABLE_CLINICAL_TASK_CREATE_FAILED',
    });
  }

  async function createAiDraftClinicalTaskDurable(data) {
    return createClinicalTaskDurable(Object.assign({}, data || {}, { createdBy: 'ai-draft', status: 'ai-draft' }));
  }

  async function updateClinicalTaskDurable(id, patch) {
    const index = cache.clinicalTasks.findIndex((task) => task.id === id);
    if (index < 0) return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_FOUND', 'Clinical task was not found');
    const current = cache.clinicalTasks[index];
    const candidate = Object.assign({}, current, patch || {}, { id: current.id, updatedAt: nowISO() });
    if (candidate.clientId !== current.clientId || candidate.originSessionId !== current.originSessionId) {
      return clinicalTaskFailure('XJ_CLINICAL_TASK_TRACE_IMMUTABLE', 'Clinical task client and origin session are immutable');
    }
    if (candidate.status !== current.status || candidate.createdBy !== current.createdBy) {
      return clinicalTaskFailure('XJ_CLINICAL_TASK_TRANSITION_REQUIRED', 'Use an explicit clinical task transition');
    }
    const normalized = normalizeClinicalTask(candidate);
    if (!normalized) return clinicalTaskFailure('XJ_CLINICAL_TASK_INVALID', 'Clinical task is invalid');
    const referenceError = clinicalTaskReferenceError(normalized);
    if (referenceError) return clinicalTaskFailure('XJ_CLINICAL_TASK_REFERENCE_INVALID', referenceError);
    const nextTasks = cache.clinicalTasks.slice();
    nextTasks[index] = normalized;
    return persistClinicalTasks(nextTasks, {
      value: normalized, version: normalized.updatedAt, failureCode: 'XJ_DURABLE_CLINICAL_TASK_UPDATE_FAILED',
    });
  }

  async function confirmClinicalTaskDurable(id) {
    const index = cache.clinicalTasks.findIndex((task) => task.id === id);
    if (index < 0) return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_FOUND', 'Clinical task was not found');
    const current = cache.clinicalTasks[index];
    if (current.status !== 'ai-draft') return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_AI_DRAFT', 'Only an AI draft may be confirmed');
    const next = Object.assign({}, current, { status: 'open', updatedAt: nowISO() });
    const nextTasks = cache.clinicalTasks.slice();
    nextTasks[index] = next;
    return persistClinicalTasks(nextTasks, {
      value: next, version: next.updatedAt, failureCode: 'XJ_DURABLE_CLINICAL_TASK_CONFIRM_FAILED',
    });
  }

  async function transitionClinicalTaskDurable(id, status, completedAt) {
    const index = cache.clinicalTasks.findIndex((task) => task.id === id);
    if (index < 0) return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_FOUND', 'Clinical task was not found');
    const current = cache.clinicalTasks[index];
    if (current.status !== 'open' || (status !== 'done' && status !== 'cancelled')) {
      return clinicalTaskFailure('XJ_CLINICAL_TASK_TRANSITION_INVALID', 'Only an open task may enter a terminal status');
    }
    const stamp = nowISO();
    const next = Object.assign({}, current, {
      status,
      updatedAt: stamp,
      completedAt: typeof completedAt === 'string' && completedAt ? completedAt : stamp,
    });
    const nextTasks = cache.clinicalTasks.slice();
    nextTasks[index] = next;
    return persistClinicalTasks(nextTasks, {
      value: next, version: next.updatedAt, failureCode: 'XJ_DURABLE_CLINICAL_TASK_TRANSITION_FAILED',
    });
  }

  async function saveClinicalTasksDurable(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) return clinicalTaskFailure('XJ_CLINICAL_TASK_BATCH_EMPTY', 'No clinical tasks were supplied');
    const batchIds = new Set();
    const normalizedBatch = [];
    for (const value of tasks) {
      const normalized = normalizeClinicalTask(value);
      if (!normalized) return clinicalTaskFailure('XJ_CLINICAL_TASK_INVALID', 'Clinical task batch contains an invalid task');
      if (batchIds.has(normalized.id)) return clinicalTaskFailure('XJ_CLINICAL_TASK_DUPLICATE', 'Clinical task batch contains a duplicate ID');
      batchIds.add(normalized.id);
      const referenceError = clinicalTaskReferenceError(normalized);
      if (referenceError) return clinicalTaskFailure('XJ_CLINICAL_TASK_REFERENCE_INVALID', referenceError);
      const current = getClinicalTask(normalized.id);
      if (current && (current.clientId !== normalized.clientId || current.originSessionId !== normalized.originSessionId)) {
        return clinicalTaskFailure('XJ_CLINICAL_TASK_TRACE_IMMUTABLE', 'Clinical task client and origin session are immutable');
      }
      if (current && (current.status !== normalized.status || current.createdBy !== normalized.createdBy)) {
        return clinicalTaskFailure('XJ_CLINICAL_TASK_TRANSITION_REQUIRED', 'Task batch updates cannot bypass explicit transitions');
      }
      if (!current && ((normalized.createdBy === 'manual' && normalized.status !== 'open') ||
          (normalized.createdBy === 'ai-draft' && normalized.status !== 'ai-draft'))) {
        return clinicalTaskFailure('XJ_CLINICAL_TASK_CREATION_STATUS_INVALID', 'New batch tasks must begin as manual open or AI draft');
      }
      normalizedBatch.push(normalized);
    }
    const nextTasks = cache.clinicalTasks.slice();
    normalizedBatch.forEach((task) => {
      const index = nextTasks.findIndex((item) => item.id === task.id);
      if (index >= 0) nextTasks[index] = task;
      else nextTasks.push(task);
    });
    return persistClinicalTasks(nextTasks, {
      value: normalizedBatch, version: nowISO(), failureCode: 'XJ_DURABLE_CLINICAL_TASK_BATCH_FAILED',
    });
  }

  function normalizeSessionTemplateSelection(value) {
    if (!value || typeof value !== 'object' || clinicalTaskValidators.hasClinicalBodyField(value)) return null;
    const templateId = typeof value.templateId === 'string' ? value.templateId.trim() : '';
    const tierAtSelection = typeof value.tierAtSelection === 'string' ? value.tierAtSelection.trim() : '';
    const context = typeof value.context === 'string' ? value.context.trim() : '';
    const rule = SESSION_TEMPLATE_RULES[templateId];
    if (!rule || SESSION_TEMPLATE_TIER_RANK[tierAtSelection] === undefined) return null;
    if (SESSION_TEMPLATE_TIER_RANK[tierAtSelection] < SESSION_TEMPLATE_TIER_RANK[rule.minimumTier]) return null;
    if (context !== 'individual' && context !== 'supervision') return null;
    if (value.version && value.version !== 'session-template-selection-v1') return null;
    const customTemplateId = typeof value.customTemplateId === 'string' ? value.customTemplateId.trim() : '';
    if (customTemplateId && (!rule.allowCustom || !/^[A-Za-z0-9._:-]{1,128}$/.test(customTemplateId))) return null;
    return {
      version: 'session-template-selection-v1',
      templateId,
      tierAtSelection,
      context,
      appliedAt: typeof value.appliedAt === 'string' && value.appliedAt ? value.appliedAt : nowISO(),
      customTemplateId,
    };
  }

  function getSessionTemplateSelection(sessionId) {
    const session = getSession(sessionId);
    return session && session.templateSelection ? Object.assign({}, session.templateSelection) : null;
  }

  async function saveSessionTemplateSelectionDurable(sessionId, selection) {
    const session = getSession(sessionId);
    if (!session) return { ok: false, value: null, error: { code: 'XJ_SESSION_NOT_FOUND', message: 'Session was not found' } };
    const normalized = normalizeSessionTemplateSelection(selection);
    if (!normalized) return { ok: false, value: null, error: { code: 'XJ_SESSION_TEMPLATE_SELECTION_INVALID', message: 'Session template selection is invalid' } };
    const result = await saveSessionDurable(Object.assign({}, session, { templateSelection: normalized }));
    if (!result.ok) return result;
    return { ok: true, value: normalized, session: result.value, version: result.version };
  }

  function getStorageDiagnostics() {
    return storageDiagnostics.slice();
  }

  async function clearBillingDataDurable() {
    const sessionState = buildSessionDeleteState(cache.sessions.filter(isBillableSession).map((session) => session.id));
    const nextClients = cache.clients.map((client) => Object.assign({}, client, {
      billing: Object.assign({}, client.billing || {}, { monthlyPayments: [] }),
      updatedAt: nowISO(),
    }));
    const nextExpenses = [];
    const nextSessions = sessionState ? sessionState.nextSessions : cache.sessions.slice();
    const nextSupervisions = sessionState ? sessionState.nextSupervisions : cache.supervisions.slice();
    const nextMaterials = sessionState ? sessionState.nextMaterials : cache.materialWorkspaces.slice();
    try {
      await idbPutMany([
        ['clients', nextClients],
        ['sessions', nextSessions],
        ['supervisions', nextSupervisions],
        ['materialWorkspaces', nextMaterials],
        ['expenses', nextExpenses],
      ], { allowFallback: false });
      cache.clients = nextClients;
      cache.sessions = nextSessions;
      cache.supervisions = nextSupervisions;
      cache.materialWorkspaces = nextMaterials;
      cache.expenses = nextExpenses;
      return { ok: true, deletedSessionCount: sessionState ? sessionState.deleted.length : 0 };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'XJ_DURABLE_BILLING_CLEAR_FAILED',
          message: e && e.message ? e.message : 'Billing data clear persistence failed',
          failedAt: nowISO(),
        },
      };
    }
  }

  // ============================================================
  // 临床材料工作项：仅保存安全元数据和已解析文本，不保存原始二进制文件或绝对路径。
  // ============================================================
  function normalizeMaterialWorkspace(value) {
    if (!value || typeof value !== 'object') return null;
    const source = value.source && typeof value.source === 'object' ? value.source : {};
    const workflow = value.workflow && typeof value.workflow === 'object' ? value.workflow : {};
    const artifacts = value.artifacts && typeof value.artifacts === 'object' ? value.artifacts : {};
    return {
      id: String(value.id || genId('mat')),
      title: String(value.title || source.name || '未命名材料'),
      source: {
        name: String(source.name || ''), ext: String(source.ext || '').toLowerCase(),
        size: Math.max(0, Number(source.size) || 0), modifiedAt: String(source.modifiedAt || ''),
      },
      extractedText: typeof value.extractedText === 'string' ? value.extractedText : '',
      parseStatus: ['parsing', 'ready', 'failed'].includes(value.parseStatus) ? value.parseStatus : 'failed',
      parseError: typeof value.parseError === 'string' ? value.parseError : '',
      clientId: typeof value.clientId === 'string' ? value.clientId : '',
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
      linkStatus: value.clientId ? 'linked' : 'unlinked',
      // v4.3 来源追溯：保留 sourceRef（若有），防止 normalize 白名单重建时丢失来源绑定
      sourceRef: value.sourceRef && typeof value.sourceRef === 'object'
        ? {
            id: String(value.sourceRef.id || ''),
            sessionId: String(value.sourceRef.sessionId || ''),
            normalizationVersion: String(value.sourceRef.normalizationVersion || ''),
            sourceVersion: String(value.sourceRef.sourceVersion || ''),
            sourceContentHash: String(value.sourceRef.sourceContentHash || ''),
            anchorContentHash: String(value.sourceRef.anchorContentHash || ''),
            status: String(value.sourceRef.status || 'active'),
          }
        : (value.sourceRef || null),
      workflow: {
        transcript: workflow.transcript || 'not-started', report: workflow.report || 'not-started',
        supervision: workflow.supervision || 'not-started', realSupervision: workflow.realSupervision || 'not-started',
      },
      artifacts: {
        transcriptSessionId: artifacts.transcriptSessionId || '', reportDraftKey: artifacts.reportDraftKey || '',
        supervisionId: artifacts.supervisionId || '', realSupervisionId: artifacts.realSupervisionId || '',
        transcriptActionRunId: artifacts.transcriptActionRunId || '', reportActionRunId: artifacts.reportActionRunId || '',
        supervisionActionRunId: artifacts.supervisionActionRunId || '', realSupervisionActionRunId: artifacts.realSupervisionActionRunId || '',
      },
      createdAt: value.createdAt || nowISO(), updatedAt: value.updatedAt || nowISO(),
    };
  }
  function materialWorkspaceLimit() {
    const api = typeof window !== 'undefined' ? window.XJEntitlements : null;
    return api && typeof api.materialWorkspaceLimit === 'function' ? api.materialWorkspaceLimit(window.__XJ__ || {}) : 20;
  }
  function getMaterialWorkspaces() { return cache.materialWorkspaces.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); }
  function getMaterialWorkspace(id) { return cache.materialWorkspaces.find((item) => item.id === id) || null; }
  // 督导/报告等页面只读使用，返回安全摘要，不暴露内部路径或改变材料状态。
  function getMaterialWorkspacesForSession(clientId, sessionId) {
    if (!clientId || !sessionId) return [];
    return getMaterialWorkspaces().filter((item) => item.clientId === clientId && item.sessionId === sessionId).map((item) => ({
      id: item.id,
      title: item.title || (item.source && item.source.name) || '未命名材料',
      sourceName: (item.source && item.source.name) || item.title || '本地材料',
      updatedAt: item.updatedAt || item.createdAt || '',
      text: item.extractedText || '',
      linkStatus: item.linkStatus || 'linked',
    }));
  }
  function createMaterialWorkspace(data) {
    const limit = materialWorkspaceLimit();
    const unlinkedCount = cache.materialWorkspaces.filter((item) => item.linkStatus === 'unlinked').length;
    if (unlinkedCount >= limit) return null;
    const item = normalizeMaterialWorkspace(Object.assign({ id: genId('mat'), createdAt: nowISO(), updatedAt: nowISO() }, data || {}));
    cache.materialWorkspaces.push(item);
    persist('materialWorkspaces');
    return item;
  }
  function updateMaterialWorkspace(id, patch) {
    const item = getMaterialWorkspace(id);
    if (!item || !patch || typeof patch !== 'object') return null;
    const next = normalizeMaterialWorkspace(Object.assign({}, item, patch, {
      source: Object.assign({}, item.source, patch.source || {}),
      workflow: Object.assign({}, item.workflow, patch.workflow || {}),
      artifacts: Object.assign({}, item.artifacts, patch.artifacts || {}), updatedAt: nowISO(),
    }));
    const index = cache.materialWorkspaces.findIndex((entry) => entry.id === id);
    cache.materialWorkspaces[index] = next;
    persist('materialWorkspaces');
    return next;
  }
  function deleteMaterialWorkspace(id) {
    const before = cache.materialWorkspaces.length;
    cache.materialWorkspaces = cache.materialWorkspaces.filter((item) => item.id !== id);
    if (cache.materialWorkspaces.length === before) return false;
    persist('materialWorkspaces');
    return true;
  }
  function linkMaterialWorkspace(id, clientId, sessionId) {
    const item = getMaterialWorkspace(id);
    if (!item) return null;
    const client = clientId ? getClient(clientId) : null;
    if (clientId && !client) return null;
    const session = sessionId ? getSession(sessionId) : null;
    if (sessionId && (!client || !session || session.clientId !== client.id)) return null;
    return updateMaterialWorkspace(id, {
      clientId: client ? client.id : '', sessionId: session ? session.id : '', linkStatus: client ? 'linked' : 'unlinked',
    });
  }
  function reconcileMaterialContext(id, clientId, sessionId, options) {
    const item = getMaterialWorkspace(id);
    if (!item) return null;
    const nextClientId = String(clientId || item.clientId || '');
    const clientChanged = !!item.clientId && !!nextClientId && item.clientId !== nextClientId;
    if (clientChanged && !(options && options.confirmClientChange)) return null;
    if (!nextClientId) return linkMaterialWorkspace(id, '', '');
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      if (options && options.unlinkSession) return linkMaterialWorkspace(id, nextClientId, '');
      return linkMaterialWorkspace(id, nextClientId, clientChanged ? '' : item.sessionId);
    }
    return linkMaterialWorkspace(id, nextClientId, sessionId);
  }

  // 临床动作溯源：只保存受控 ID、版本和长度信息，绝不复制临床正文或路径。
  const ACTION_TASKS = new Set(['transcript-ai-detect', 'report-ai-fill', 'supervision-ai', 'real-supervision-ai-organize', 'real-supervision-ai-record-analyze', 'growth-summary']);
  const ACTION_STATUSES = new Set(['pending', 'succeeded', 'failed', 'stale', 'cancelled']);
  const SOURCE_KINDS = new Set(['client', 'session', 'material', 'supervision', 'userdocs']);
  function normalizeClinicalActionRun(value) {
    if (!value || typeof value !== 'object' || !ACTION_TASKS.has(value.task)) return null;
    const origin = value.origin && typeof value.origin === 'object' ? value.origin : {};
    const sourceRows = Array.isArray(value.sources) ? value.sources : [];
    const snapshot = value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : {};
    return {
      id: String(value.id || genId('car')), task: value.task,
      status: ACTION_STATUSES.has(value.status) ? value.status : 'failed',
      origin: { clientId: String(origin.clientId || ''), sessionId: String(origin.sessionId || ''), materialId: String(origin.materialId || ''), supervisionId: String(origin.supervisionId || '') },
      sources: sourceRows.map((source) => ({ kind: SOURCE_KINDS.has(source && source.kind) ? source.kind : '', id: String((source && source.id) || ''), label: String((source && source.label) || ''), chars: Math.max(0, Number(source && source.chars) || 0), truncated: !!(source && source.truncated) })).filter((source) => source.kind && source.id),
      snapshot: {
        clientId: String(snapshot.clientId || ''), sessionId: String(snapshot.sessionId || ''), materialId: String(snapshot.materialId || ''), supervisionId: String(snapshot.supervisionId || ''),
        selectedSessionIds: Array.isArray(snapshot.selectedSessionIds) ? snapshot.selectedSessionIds.map(String).sort() : [], sessionVersions: snapshot.sessionVersions && typeof snapshot.sessionVersions === 'object' ? snapshot.sessionVersions : {},
        materialUpdatedAt: String(snapshot.materialUpdatedAt || ''), supervisionUpdatedAt: String(snapshot.supervisionUpdatedAt || ''), inputDigest: String(snapshot.inputDigest || ''), key: String(snapshot.key || '')
      },
      output: { kind: String(value.output && value.output.kind || ''), ref: String(value.output && value.output.ref || '') },
      error: String(value.error || '').slice(0, 200), createdAt: String(value.createdAt || nowISO()), completedAt: String(value.completedAt || '')
    };
  }
  function clinicalActionRunValidationError(run, lookup) {
    if (!run || !run.origin) return 'invalid-shape-or-task';
    const origin = run.origin;
    const isUnboundSupervision = run.task === 'supervision-ai' &&
      !origin.clientId && !origin.sessionId && !origin.materialId && !origin.supervisionId &&
      !run.sources.length &&
      !run.snapshot.clientId && !run.snapshot.sessionId && !run.snapshot.materialId && !run.snapshot.supervisionId &&
      !run.snapshot.selectedSessionIds.length;
    const isLongitudinalGrowth = run.task === 'growth-summary' &&
      !!origin.clientId && !origin.sessionId && !origin.materialId && !origin.supervisionId &&
      run.snapshot.clientId === origin.clientId && !run.snapshot.sessionId &&
      !run.snapshot.materialId && !run.snapshot.supervisionId &&
      run.snapshot.selectedSessionIds.length > 0;
    // 独立督导没有可关联的临床对象，仍保留不含正文的动作溯源记录。
    if (isUnboundSupervision) return '';
    if (!origin.clientId || !run.sources.length) return 'missing-client-or-sources';
    const findClient = lookup ? (id) => lookup.clients.get(String(id)) || null : getClient;
    const findSession = lookup ? (id) => lookup.sessions.get(String(id)) || null : getSession;
    const findMaterial = lookup ? (id) => lookup.materials.get(String(id)) || null : getMaterialWorkspace;
    const findSupervision = lookup ? (id) => lookup.supervisions.get(String(id)) || null : getSupervision;
    const client = findClient(origin.clientId);
    if (!client) return 'unknown-client';
    const session = origin.sessionId ? findSession(origin.sessionId) : null;
    if (origin.sessionId && (!session || String(session.clientId || '') !== String(client.id))) return 'unknown-or-mismatched-session';
    const material = origin.materialId ? findMaterial(origin.materialId) : null;
    if (origin.materialId && (!material || (material.clientId && material.clientId !== origin.clientId) || (material.sessionId && material.sessionId !== origin.sessionId))) return 'unknown-or-mismatched-material';
    const supervision = origin.supervisionId ? findSupervision(origin.supervisionId) : null;
    if (origin.supervisionId && (!supervision || (supervision.clientId && supervision.clientId !== origin.clientId))) return 'unknown-or-mismatched-supervision';
    if (isLongitudinalGrowth && !run.snapshot.selectedSessionIds.every((id) => {
      const selectedSession = findSession(id);
      return !!(selectedSession && String(selectedSession.clientId || '') === origin.clientId);
    })) return 'unknown-or-mismatched-selected-session';
    for (const source of run.sources) {
      if (isLongitudinalGrowth && source.kind !== 'material') return 'longitudinal-source-must-be-material';
      if (source.kind === 'client' && source.id === origin.clientId) continue;
      if (source.kind === 'session') {
        const sourceSession = findSession(source.id);
        if (sourceSession && String(sourceSession.clientId || '') === origin.clientId) continue;
      }
      if (source.kind === 'material') {
        const sourceMaterial = findMaterial(source.id);
        if (isLongitudinalGrowth && sourceMaterial && sourceMaterial.clientId === origin.clientId && run.snapshot.selectedSessionIds.includes(String(sourceMaterial.sessionId || ''))) continue;
        if (sourceMaterial && (!sourceMaterial.clientId || sourceMaterial.clientId === origin.clientId) && (!sourceMaterial.sessionId || sourceMaterial.sessionId === origin.sessionId)) continue;
      }
      if (source.kind === 'supervision') {
        const sourceSupervision = findSupervision(source.id);
        if (sourceSupervision && source.id === origin.supervisionId && (!sourceSupervision.clientId || sourceSupervision.clientId === origin.clientId)) continue;
      }
      if (source.kind === 'userdocs' && /^retrieval:[A-Za-z0-9_-]+$/.test(source.id)) continue;
      return 'unknown-or-mismatched-source';
    }
    return '';
  }
  function isValidClinicalActionRun(run, lookup) {
    return !clinicalActionRunValidationError(run, lookup);
  }
  function getClinicalActionRuns(filters) {
    filters = filters || {};
    return cache.clinicalActionRuns.filter((run) => (!filters.clientId || run.origin.clientId === filters.clientId) && (!filters.materialId || run.origin.materialId === filters.materialId)).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function getClinicalActionRun(id) { return cache.clinicalActionRuns.find((run) => run.id === id) || null; }
  function createClinicalActionRun(data) {
    const run = normalizeClinicalActionRun(Object.assign({ id: genId('car'), createdAt: nowISO() }, data || {}));
    if (!run || !isValidClinicalActionRun(run)) return null;
    cache.clinicalActionRuns.push(run); persist('clinicalActionRuns'); return run;
  }
  function updateClinicalActionRun(id, patch) {
    const current = getClinicalActionRun(id);
    if (!current) return null;
    const run = normalizeClinicalActionRun(Object.assign({}, current, patch || {}, { origin: Object.assign({}, current.origin, patch && patch.origin || {}), snapshot: Object.assign({}, current.snapshot, patch && patch.snapshot || {}), output: Object.assign({}, current.output, patch && patch.output || {}) }));
    if (!run || !isValidClinicalActionRun(run)) return null;
    const index = cache.clinicalActionRuns.findIndex((item) => item.id === id);
    cache.clinicalActionRuns[index] = run; persist('clinicalActionRuns'); return run;
  }

  // ============================================================
  // 督导 (Supervision) —— content/conclusion 大字段随对象整体存入 IndexedDB
  // ============================================================
  function getSupervisions() {
    return cache.supervisions;
  }
  function getSupervision(id) {
    return cache.supervisions.find((sv) => sv.id === id) || null;
  }
  function saveSupervision(sv) {
    const idx = cache.supervisions.findIndex((s) => s.id === sv.id);
    if (idx >= 0) cache.supervisions[idx] = sv;
    else cache.supervisions.push(sv);
    persist('supervisions');
    return sv;
  }
  async function saveSupervisionDurable(sv) {
    if (!sv || !sv.id) return { ok: false, value: null, error: { code: 'XJ_SUPERVISION_INVALID', message: 'Supervision was not supplied' } };
    const normalized = Object.assign({}, sv, { updatedAt: nowISO() });
    const nextSupervisions = cache.supervisions.slice();
    const index = nextSupervisions.findIndex((item) => item.id === normalized.id);
    if (index >= 0) nextSupervisions[index] = normalized;
    else nextSupervisions.push(normalized);
    try {
      await idbPut('supervisions', nextSupervisions, { allowFallback: false });
      cache.supervisions = nextSupervisions;
      return { ok: true, value: normalized, version: normalized.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_SUPERVISION_SAVE_FAILED', message: e && e.message ? e.message : 'Supervision persistence failed' } };
    }
  }
  function createSupervision(data) {
    licenseGuard('supervision', null);
    const sv = Object.assign(
      {
        id: genId('sv'),
        type: 'individual',
        supervisorName: '',
        date: '',
        sessionIds: [],
        content: '',
        conclusion: '',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      data
    );
    return saveSupervision(sv);
  }
  async function createSupervisionDurable(data) {
    licenseGuard('supervision', null);
    const sv = Object.assign(
      { id: genId('sv'), type: 'individual', supervisorName: '', date: '', sessionIds: [], content: '', conclusion: '', createdAt: nowISO(), updatedAt: nowISO() },
      data
    );
    return saveSupervisionDurable(sv);
  }
  function updateSupervision(id, patch) {
    licenseGuard('supervision', id);
    const sv = getSupervision(id);
    if (!sv) return null;
    Object.assign(sv, patch, { updatedAt: nowISO() });
    return saveSupervision(sv);
  }
  async function updateSupervisionDurable(id, patch) {
    licenseGuard('supervision', id);
    const index = cache.supervisions.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_SUPERVISION_NOT_FOUND', message: 'Supervision was not found' } };
    return saveSupervisionDurable(Object.assign({}, cache.supervisions[index], patch || {}));
  }
  function deleteSupervision(id) {
    licenseGuard('supervision', id);
    cache.supervisions = cache.supervisions.filter((s) => s.id !== id);
    persist('supervisions');
    return true;
  }

  // 取某来访者的既往督导记录（按创建时间由旧到新）。
  // 关联方式：督导记录 sessionIds[] 命中该来访者的任一会谈，或记录自带 clientId。
  function getSupervisionsByClient(clientId) {
    if (!clientId) return [];
    const sessionIdSet = new Set(getSessionsByClient(clientId).map((s) => s.id));
    return cache.supervisions
      .filter((sv) => sv.clientId === clientId || (sv.sessionIds || []).some((sid) => sessionIdSet.has(sid)))
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  }

  // 构建「长时程成长视角」上下文：把该来访者既往督导记录浓缩成文本，供 AI 督导纵向对照。
  // excludeSessionId：排除当前会谈自身的记录（避免把本次刚生成的内容当历史）。
  // 最多取最近 maxItems 条，每条正文/结论截断，控制 token。
  function buildSupervisionGrowthContext(clientId, excludeSessionId, maxItems) {
    const cap = maxItems || 6;
    let list = getSupervisionsByClient(clientId);
    if (excludeSessionId) {
      list = list.filter((sv) => !((sv.sessionIds || []).length === 1 && sv.sessionIds[0] === excludeSessionId));
    }
    if (!list.length) return '';
    const recent = list.slice(-cap);
    const clip = (s, n) => {
      s = String(s || '').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    return recent.map((sv, i) => {
      const when = sv.date || (sv.createdAt ? String(sv.createdAt).slice(0, 10) : '');
      const who = sv.supervisorName || (sv.type === 'ai' ? 'AI 督导' : '督导');
      const body = clip(sv.conclusion || sv.content, 500);
      return `— 第${i + 1}次（${when}${who ? ' · ' + who : ''}）\n${body}`;
    }).join('\n\n');
  }

  // 把一次 AI 督导输出持久化为督导记录，逐步积累成该来访者的「督导档案」。
  // 受限模式若已达上限则静默跳过（不阻断当前生成）。返回记录或 null。
  function buildAiSupervision(data) {
    return Object.assign({
      id: genId('sv'), type: 'ai', supervisorName: data.supervisorName || 'AI 督导', clientId: data.clientId || '',
      date: (data.date || nowISO().slice(0, 10)), sessionId: data.sessionId || '', sessionIds: data.sessionId ? [data.sessionId] : [],
      content: data.context || '', conclusion: data.content || '', createdAt: nowISO(), updatedAt: nowISO(),
    }, {});
  }
  async function saveAiSupervisionDurable(data) {
    try {
      licenseGuard('supervision', null);
      return saveSupervisionDurable(buildAiSupervision(data));
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_AI_SUPERVISION_FAILED', message: e && e.message ? e.message : 'AI supervision persistence failed' } };
    }
  }
  function saveAiSupervision(data) {
    try {
      const sv = buildAiSupervision(data);
      // 直接入库（绕过 createSupervision 的硬抛错，改为静默跳过上限）
      licenseGuard('supervision', null);
      cache.supervisions.push(sv);
      persist('supervisions');
      return sv;
    } catch (e) {
      console.warn('[Store] AI 督导记录未保存（可能受限模式已达上限）：', (e && e.message) || e);
      return null;
    }
  }

  // ============================================================
  // 大师对话（1v1 与多大师圆桌）—— 全部存于本地 IndexedDB
  // 每条对话 = { id, mode:'1v1'|'roundtable', masterKeys:[...], title,
  //              messages:[{role,content,masterKey?}], summary, createdAt, updatedAt }
  // summary：自动摘要（长时记忆）——对话过长时由 AI 生成，注入后续上下文，保留跨轮/跨会话要点。
  // ============================================================
  function getMasterConversations() {
    return cache.masterConversations.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }
  function getMasterConversation(id) {
    return cache.masterConversations.find((c) => c.id === id) || null;
  }
  function saveMasterConversation(conv) {
    if (!conv || !conv.id) return null;
    conv = normalizeMasterConversation(conv);
    conv.updatedAt = nowISO();
    const idx = cache.masterConversations.findIndex((c) => c.id === conv.id);
    if (idx >= 0) cache.masterConversations[idx] = conv;
    else cache.masterConversations.unshift(conv);
    persist('masterConversations');
    return conv;
  }
  async function saveMasterConversationDurable(conv) {
    if (!conv || !conv.id) return { ok: false, value: null, error: { code: 'XJ_MASTER_CONVERSATION_INVALID', message: 'Conversation was not supplied' } };
    const normalized = normalizeMasterConversation(conv);
    normalized.updatedAt = nowISO();
    const nextConversations = cache.masterConversations.slice();
    const idx = nextConversations.findIndex((item) => item.id === normalized.id);
    if (idx >= 0) nextConversations[idx] = normalized;
    else nextConversations.unshift(normalized);
    try {
      await idbPut('masterConversations', nextConversations, { allowFallback: false });
      cache.masterConversations = nextConversations;
      return { ok: true, value: normalized, version: normalized.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_MASTER_CONVERSATION_SAVE_FAILED', message: e && e.message ? e.message : 'Conversation persistence failed' } };
    }
  }
  function deleteMasterConversation(id) {
    cache.masterConversations = cache.masterConversations.filter((c) => c.id !== id);
    persist('masterConversations');
    return true;
  }

  async function deleteMasterConversationDurable(id) {
    const nextConversations = cache.masterConversations.filter((conversation) => conversation.id !== id);
    if (nextConversations.length === cache.masterConversations.length) {
      return { ok: false, value: null, error: { code: 'XJ_MASTER_CONVERSATION_NOT_FOUND', message: 'Conversation was not found' } };
    }
    try {
      await idbPut('masterConversations', nextConversations, { allowFallback: false });
      cache.masterConversations = nextConversations;
      return { ok: true, value: true };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_MASTER_CONVERSATION_DELETE_FAILED', message: e && e.message ? e.message : 'Conversation deletion failed' } };
    }
  }

  // ============================================================
  // 支出（专业发展费用）—— 收入侧的镜像数据
  // 每条 = { id, category:'personal'|'individual'|'group'|'course'|'other',
  //          date, amount, description, createdAt, updatedAt }
  // ============================================================
  function getExpenses() {
    return cache.expenses.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }
  function getExpense(id) {
    return cache.expenses.find((e) => e.id === id) || null;
  }
  function getExpensesByCategory(cat) {
    if (!cat || cat === 'all') return getExpenses();
    return getExpenses().filter((e) => e.category === cat);
  }
  function getExpensesByMonth(ym) {
    if (!ym) return getExpenses();
    return getExpenses().filter((e) => (e.date || '').slice(0, 7) === ym);
  }
  function createExpense(data) {
    const exp = Object.assign(
      {
        id: genId('exp'),
        category: 'other',
        date: nowISO().slice(0, 10),
        amount: 0,
        description: '',
        // v3.7.0 可选：关联来访者（支出可关联，非必要）；可选 batchId（AI 批量记账撤销用）
        clientId: '',
        batchId: '',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      },
      data
    );
    cache.expenses.push(exp);
    persist('expenses');
    return exp;
  }
  async function createExpenseDurable(data) {
    const stamp = nowISO();
    const expense = Object.assign(
      { id: genId('exp'), category: 'other', date: stamp.slice(0, 10), amount: 0, description: '', clientId: '', batchId: '', createdAt: stamp, updatedAt: stamp },
      data,
      { updatedAt: stamp }
    );
    const nextExpenses = cache.expenses.concat([expense]);
    try {
      await idbPut('expenses', nextExpenses, { allowFallback: false });
      cache.expenses = nextExpenses;
      return { ok: true, value: expense, version: expense.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_EXPENSE_CREATE_FAILED', message: e && e.message ? e.message : 'Expense persistence failed' } };
    }
  }
  // v3.7.0 撤销 AI 批量记账：删除所有 batchId 匹配的 sessions 和 expenses
  function undoBatch(batchId) {
    if (!batchId) return { sessions: 0, expenses: 0 };
    const sBefore = cache.sessions.length;
    const eBefore = cache.expenses.length;
    cache.sessions = cache.sessions.filter((s) => s.batchId !== batchId);
    cache.expenses = cache.expenses.filter((e) => e.batchId !== batchId);
    const sRemoved = sBefore - cache.sessions.length;
    const eRemoved = eBefore - cache.expenses.length;
    if (sRemoved > 0) persist('sessions');
    if (eRemoved > 0) persist('expenses');
    return { sessions: sRemoved, expenses: eRemoved };
  }
  function updateExpense(id, patch) {
    const idx = cache.expenses.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    cache.expenses[idx] = Object.assign({}, cache.expenses[idx], patch, { updatedAt: nowISO() });
    persist('expenses');
    return cache.expenses[idx];
  }
  async function updateExpenseDurable(id, patch) {
    const index = cache.expenses.findIndex((expense) => expense.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_EXPENSE_NOT_FOUND', message: 'Expense was not found' } };
    const expense = Object.assign({}, cache.expenses[index], patch, { updatedAt: nowISO() });
    const nextExpenses = cache.expenses.slice();
    nextExpenses[index] = expense;
    try {
      await idbPut('expenses', nextExpenses, { allowFallback: false });
      cache.expenses = nextExpenses;
      return { ok: true, value: expense, version: expense.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_EXPENSE_UPDATE_FAILED', message: e && e.message ? e.message : 'Expense persistence failed' } };
    }
  }
  function deleteExpense(id) {
    cache.expenses = cache.expenses.filter((e) => e.id !== id);
    persist('expenses');
    return true;
  }
  async function deleteExpenseDurable(id) {
    const expense = cache.expenses.find((item) => item.id === id);
    if (!expense) return { ok: false, deleted: false, error: { code: 'XJ_EXPENSE_NOT_FOUND', message: 'Expense was not found' } };
    const nextExpenses = cache.expenses.filter((item) => item.id !== id);
    try {
      await idbPut('expenses', nextExpenses, { allowFallback: false });
      cache.expenses = nextExpenses;
      return { ok: true, deleted: true, value: expense };
    } catch (e) {
      return { ok: false, deleted: false, error: { code: 'XJ_DURABLE_EXPENSE_DELETE_FAILED', message: e && e.message ? e.message : 'Expense persistence failed' } };
    }
  }
  function getExpenseStats() {
    const list = cache.expenses;
    const total = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCat = {};
    ['personal', 'individual', 'group', 'course', 'other'].forEach((cat) => {
      byCat[cat] = { count: 0, total: 0 };
    });
    list.forEach((e) => {
      if (byCat[e.category]) {
        byCat[e.category].count++;
        byCat[e.category].total += Number(e.amount) || 0;
      }
    });
    return { total, byCat, count: list.length };
  }

  // ============================================================
  // 督导师身份（AI 督导用，付费功能）
  // 每个身份 = { id, name, prompt, builtin, createdAt }
  // builtin=true 为内置温尼科特取向默认身份，不可删除。
  // ============================================================
  function getSupervisorIdentities() {
    return cache.supervisorIdentities;
  }
  function getSupervisorIdentity(id) {
    return cache.supervisorIdentities.find((s) => s.id === id) || null;
  }
  function createSupervisorIdentity(obj) {
    const identity = {
      id: obj.id || genId('sup'),
      name: (obj.name || '未命名督导师').trim(),
      prompt: obj.prompt || '',
      builtin: !!obj.builtin,
      createdAt: obj.createdAt || nowISO(),
    };
    cache.supervisorIdentities.push(identity);
    persist('supervisorIdentities');
    return identity;
  }
  function updateSupervisorIdentity(obj) {
    const idx = cache.supervisorIdentities.findIndex((s) => s.id === obj.id);
    if (idx < 0) return null;
    cache.supervisorIdentities[idx] = Object.assign({}, cache.supervisorIdentities[idx], {
      name: (obj.name || '').trim() || cache.supervisorIdentities[idx].name,
      prompt: obj.prompt != null ? obj.prompt : cache.supervisorIdentities[idx].prompt,
    });
    persist('supervisorIdentities');
    return cache.supervisorIdentities[idx];
  }
  function deleteSupervisorIdentity(id) {
    const target = cache.supervisorIdentities.find((s) => s.id === id);
    if (target && target.builtin) return false; // 内置身份不可删
    cache.supervisorIdentities = cache.supervisorIdentities.filter((s) => s.id !== id);
    persist('supervisorIdentities');
    return true;
  }

  // ============================================================
  // 设置
  // ============================================================
  function getSettings() {
    return cache.settings;
  }
  function saveSettings(patch) {
    cache.settings = Object.assign({}, cache.settings, patch);
    persist('settings');
    return cache.settings;
  }

  async function saveSettingsDurable(patch) {
    const nextSettings = Object.assign({}, cache.settings, patch);
    try {
      await idbPut('settings', nextSettings, { allowFallback: false });
      cache.settings = nextSettings;
      return { ok: true, value: nextSettings };
    } catch (e) {
      return {
        ok: false,
        value: cache.settings,
        error: { message: e && e.message ? e.message : 'Settings persistence failed' },
      };
    }
  }

  // ============================================================
  // 统计
  // ============================================================
  function getStats() {
    const clients = getClients();
    const sessions = getSessions();
    const sups = cache.supervisions;
    const activeClientsArr = clients.filter((c) => c.status === 'active');
    const activeClients = activeClientsArr.length;
    const recentReports = sessions.filter((s) => s.hasSoap || s.hasDap || s.hasReflection).length;

    // v1.4.0 新增：本月应收 / 已收 / 待收来访者数（口径与 agent-tools.js billingSummary 对齐）
    const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
    const activeIds = new Set(activeClientsArr.map((c) => c.id));
    let monthlyReceivable = 0;
    let monthlyReceived = 0;
    let pendingClients = 0;
    // 按来访者合并遍历：一次循环同时算应收/已收/待收，避免重复迭代
    const perClient = {}; // id -> { rec, paid }
    for (const s of sessions) {
      if (!isBillableSession(s)) continue;
      if (!activeIds.has(s.clientId)) continue;
      if (!s.date || s.date.slice(0, 7) !== ym) continue;
      const fee = Number(s.billing.fee) || 0;
      monthlyReceivable += fee;
      if (s.billing && s.billing.paid) monthlyReceived += fee;
      if (!perClient[s.clientId]) perClient[s.clientId] = { rec: 0, paid: 0 };
      perClient[s.clientId].rec += fee;
      if (s.billing && s.billing.paid) perClient[s.clientId].paid += fee;
    }
    // 累加月结 payment 到 monthlyReceived 和对应来访者已收
    for (const c of activeClientsArr) {
      if (c.billing && Array.isArray(c.billing.monthlyPayments)) {
        for (const mp of c.billing.monthlyPayments) {
          if (mp.month === ym) {
            const amt = Number(mp.amount) || 0;
            monthlyReceived += amt;
            if (!perClient[c.id]) perClient[c.id] = { rec: 0, paid: 0 };
            perClient[c.id].paid += amt;
          }
        }
      }
    }
    // 统计待收来访者：应收 > 已收
    for (const id in perClient) {
      if (perClient[id].rec > perClient[id].paid) pendingClients++;
    }

    return {
      activeClients,
      supervisionCount: sups.length,
      recentReports,
      totalClients: clients.length,
      totalSessions: sessions.length,
      // v1.4.0 新增
      monthlyReceivable,
      monthlyReceived,
      pendingClients,
    };
  }
  function getRecentSessions(limit = 5) {
    return getSessions()
      .slice()
      .filter((s) => getClients().some((c) => c.id === s.clientId)) // 过滤孤儿 session（来访者已被删除但 session 残留）
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, limit);
  }
  function getRecentReports(limit = 5) {
    const sessions = getSessions()
      .filter((s) => s.hasSoap || s.hasDap || s.hasReflection)
      .filter((s) => getClients().some((c) => c.id === s.clientId)); // 过滤孤儿 session
    sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return sessions.slice(0, limit);
  }

  // 备份只携带业务设置，不携带当前设备凭据或任何可作为密钥的字段。
  function sanitizeBackupSettings(settings) {
    const helper = typeof window !== 'undefined' ? window.XJBackupCrypto : null;
    if (helper && typeof helper.sanitizeExportPayload === 'function') {
      try { return helper.sanitizeExportPayload({ settings: settings || {} }).settings || {}; } catch (_) {}
    }
    const sensitive = new Set(['apiKey', 'accessToken', 'refreshToken', 'secret', 'password', 'token', 'privateKey', 'clientSecret']);
    function walk(value) {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== 'object') return value;
      const result = {};
      Object.keys(value).forEach((key) => { if (!sensitive.has(key)) result[key] = walk(value[key]); });
      return result;
    }
    return walk(settings || {});
  }

  function sanitizeImportedSettings(settings) {
    const incoming = sanitizeBackupSettings(settings || {});
    const currentApi = cache.settings && cache.settings.apiConfig && typeof cache.settings.apiConfig === 'object'
      ? cache.settings.apiConfig : {};
    const incomingApi = incoming.apiConfig && typeof incoming.apiConfig === 'object' ? incoming.apiConfig : {};
    return Object.assign({ apiConfig: {}, version: '1.0.0' }, incoming, {
      apiConfig: Object.assign({}, currentApi, incomingApi),
    });
  }

  // ============================================================
  // 备份 / 恢复（明文只存在于本次加密调用的短时内存）
  // ============================================================
  async function exportAll() {
    return JSON.stringify(
      {
        version: '2.0.0',
        exportedAt: nowISO(),
        clients: cache.clients,
        sessions: cache.sessions,
        supervisions: cache.supervisions,
        supervisorIdentities: cache.supervisorIdentities,
        masterConversations: cache.masterConversations,
        expenses: cache.expenses,
        materialWorkspaces: cache.materialWorkspaces,
        clinicalActionRuns: cache.clinicalActionRuns,
        clinicalTasks: cache.clinicalTasks,
        importQuarantine: cache.importQuarantine,
        deletionBatches: cache.deletionBatches.map(normalizeDeletionBatch).filter(Boolean),
        deletionQuarantine: cache.deletionQuarantine.map(normalizeDeletionQuarantineEntry).filter(Boolean),
      },
      null,
      2
    );
  }
  function importQuarantineRecord(collection, value, reason) {
    const origin = value && value.origin && typeof value.origin === 'object' ? value.origin : {};
    return {
      id: genId('iq'), collection, entityId: String(value && value.id || ''),
      clientId: String(value && value.clientId || origin.clientId || ''), sessionId: String(value && value.sessionId || origin.sessionId || ''),
      reason, importedAt: nowISO(),
    };
  }

  function prepareImport(data) {
    const next = {
      clients: Array.isArray(data.clients) ? data.clients : cache.clients,
      sessions: Array.isArray(data.sessions) ? data.sessions : cache.sessions,
      supervisions: Array.isArray(data.supervisions) ? data.supervisions : cache.supervisions,
      supervisorIdentities: Array.isArray(data.supervisorIdentities) ? data.supervisorIdentities : cache.supervisorIdentities,
      masterConversations: Array.isArray(data.masterConversations) ? data.masterConversations.map(normalizeMasterConversation) : cache.masterConversations,
      expenses: Array.isArray(data.expenses) ? data.expenses : cache.expenses,
      materialWorkspaces: Array.isArray(data.materialWorkspaces) ? data.materialWorkspaces.map(normalizeMaterialWorkspace).filter(Boolean) : [],
      clinicalActionRuns: [],
      clinicalTasks: [],
      settings: data.settings ? sanitizeImportedSettings(data.settings) : cache.settings,
    };
    const quarantine = Array.isArray(data.importQuarantine) ? data.importQuarantine.slice() : [];
    const clientIds = new Set(next.clients.map((client) => String(client && client.id || '')).filter(Boolean));
    const sessionIds = new Set();
    next.sessions = next.sessions.reduce((valid, session) => {
      if (!session || !session.id || !session.clientId || !clientIds.has(String(session.clientId))) {
        quarantine.push(importQuarantineRecord('sessions', session, 'missing-or-unknown-client'));
        return valid;
      }
      let normalizedSession = session;
      if (session.templateSelection !== undefined) {
        const selection = normalizeSessionTemplateSelection(session.templateSelection);
        if (!selection) {
          quarantine.push(importQuarantineRecord('sessions', session, 'invalid-template-selection'));
          normalizedSession = Object.assign({}, session);
          delete normalizedSession.templateSelection;
        } else {
          normalizedSession = Object.assign({}, session, { templateSelection: selection });
        }
      }
      sessionIds.add(String(normalizedSession.id));
      valid.push(normalizedSession);
      return valid;
    }, []);
    next.supervisions = next.supervisions.reduce((valid, supervision) => {
      if (!supervision || (supervision.clientId && !clientIds.has(String(supervision.clientId)))) {
        quarantine.push(importQuarantineRecord('supervisions', supervision, 'unknown-client'));
        return valid;
      }
      const references = Array.isArray(supervision.sessionIds) ? supervision.sessionIds : [];
      const retained = references.filter((sessionId) => sessionIds.has(String(sessionId)));
      if (retained.length !== references.length) quarantine.push(importQuarantineRecord('supervisions', supervision, 'unknown-session-reference'));
      valid.push(Object.assign({}, supervision, { sessionIds: retained }));
      return valid;
    }, []);
    next.materialWorkspaces = next.materialWorkspaces.map((material) => {
      const clientKnown = !material.clientId || clientIds.has(String(material.clientId));
      const sessionKnown = !material.sessionId || sessionIds.has(String(material.sessionId));
      if (clientKnown && sessionKnown) return material;
      quarantine.push(importQuarantineRecord('materialWorkspaces', material, 'unknown-client-or-session'));
      return Object.assign({}, material, { clientId: '', sessionId: '', linkStatus: 'unlinked', updatedAt: nowISO() });
    });
    const clinicalLookup = {
      clients: new Map(next.clients.map((client) => [String(client && client.id || ''), client]).filter((entry) => entry[0])),
      sessions: new Map(next.sessions.map((session) => [String(session && session.id || ''), session]).filter((entry) => entry[0])),
      materials: new Map(next.materialWorkspaces.map((material) => [String(material && material.id || ''), material]).filter((entry) => entry[0])),
      supervisions: new Map(next.supervisions.map((supervision) => [String(supervision && supervision.id || ''), supervision]).filter((entry) => entry[0])),
    };
    const importedRuns = Array.isArray(data.clinicalActionRuns) ? data.clinicalActionRuns : [];
    importedRuns.forEach((value) => {
      const run = normalizeClinicalActionRun(value);
      const reason = clinicalActionRunValidationError(run, clinicalLookup);
      if (reason) quarantine.push(importQuarantineRecord('clinicalActionRuns', run || value, reason));
      else next.clinicalActionRuns.push(run);
    });
    const importedTaskIds = new Set();
    const importedTasks = Array.isArray(data.clinicalTasks) ? data.clinicalTasks : [];
    importedTasks.forEach((value) => {
      const task = normalizeClinicalTask(value);
      const reason = task ? clinicalTaskReferenceError(task, {
        clients: clinicalLookup.clients,
        sessions: clinicalLookup.sessions,
      }) : 'invalid-task';
      if (reason || (task && importedTaskIds.has(task.id))) {
        quarantine.push(importQuarantineRecord('clinicalTasks', task || value, reason || 'duplicate-id'));
      } else {
        importedTaskIds.add(task.id);
        next.clinicalTasks.push(task);
      }
    });
    const deletionQuarantine = Array.isArray(data.deletionQuarantine)
      ? data.deletionQuarantine.map(normalizeDeletionQuarantineEntry).filter(Boolean)
      : cache.deletionQuarantine.map(normalizeDeletionQuarantineEntry).filter(Boolean);
    const importedBatches = Array.isArray(data.deletionBatches)
      ? data.deletionBatches.map(normalizeDeletionBatch).filter(Boolean)
      : cache.deletionBatches.map(normalizeDeletionBatch).filter(Boolean);
    next.deletionBatches = importedBatches.map((batch) => {
      const targetKnown = batch.targetType === 'client'
        ? clientIds.has(batch.targetId)
        : sessionIds.has(batch.targetId);
      const invalidEntry = (batch.entries || []).find((entry) => {
        if (entry.collection === 'clients') return !clientIds.has(entry.id);
        if (entry.collection === 'sessions') return !sessionIds.has(entry.id);
        return false;
      });
      if (targetKnown && !invalidEntry) return batch;
      const invalidId = invalidEntry ? invalidEntry.id : batch.targetId;
      deletionQuarantine.push(makeDeletionQuarantine(
        invalidEntry ? invalidEntry.collection : batch.targetType,
        invalidId,
        'invalid-imported-deletion-reference',
        batch.targetType,
        batch.targetId
      ));
      return Object.assign({}, batch, { status: 'quarantined' });
    });
    next.deletionQuarantine = deletionQuarantine;
    next.importQuarantine = quarantine;
    return next;
  }

  async function importAll(jsonStr) {
    let next;
    try {
      next = prepareImport(JSON.parse(jsonStr));
      const importKeys = ['clients', 'sessions', 'supervisions', 'supervisorIdentities', 'masterConversations', 'expenses', 'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks', 'importQuarantine', 'deletionBatches', 'deletionQuarantine', 'settings'];
      await idbPutMany(importKeys.map((key) => [key, next[key]]), { allowFallback: false });
      importKeys.forEach((key) => { cache[key] = next[key]; });
      return { ok: true, quarantine: next.importQuarantine.slice(), deletionQuarantine: next.deletionQuarantine.slice() };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_IMPORT_DURABLE_FAILED', message: e && e.message ? e.message : 'Import failed' } };
    }
  }
  function getImportQuarantine() { return cache.importQuarantine.slice(); }

  // ============================================================
  // 容量诊断（供设置页展示）
  // ============================================================
  function storageInfo() {
    let sessionChars = 0;
    let clientChars = 0;
    cache.sessions.forEach((s) => {
      sessionChars += (s.transcript || '').length + JSON.stringify(s.soap || {}).length +
        JSON.stringify(s.dap || {}).length + (s.reflection || '').length + (s.summary || '').length;
    });
    cache.clients.forEach((c) => {
      clientChars += JSON.stringify(c).length;
    });
    return {
      backend: _dbAvailable ? 'IndexedDB（GB 级容量）' : 'localStorage（降级，约 5MB）',
      clientCount: cache.clients.length,
      sessionCount: cache.sessions.length,
      supervisionCount: cache.supervisions.length,
      approxDataSizeMB: +((sessionChars + clientChars) / (1024 * 1024)).toFixed(2),
    };
  }

  // ============================================================
  // 旧端口历史数据迁移（根治「换端口=历史丢失」）
  // 主进程在旧端口临时起同源服务后，通过 __XJ_API__ 通知本函数；
  // 这里用隐藏 iframe 在「旧 origin」上下文读出 IndexedDB，再合并写入当前 origin。
  // ============================================================
  function readPortViaIframe(port) {
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      const expectedOrigin = 'http://127.0.0.1:' + port;
      let done = false, timer = null;
      const finish = (val) => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { window.removeEventListener('message', onMsg); } catch (e) {}
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve(val);
      };
      const onMsg = (e) => {
        if (e.origin !== expectedOrigin || e.source !== iframe.contentWindow) return;
        if (e.data && e.data.__xj_migrate) finish(e.data.error ? null : (e.data.data || null));
      };
      window.addEventListener('message', onMsg);
      timer = setTimeout(() => finish(null), 8000); // 单端口超时保护
      iframe.src = expectedOrigin + '/migrate-helper.html';
      document.body.appendChild(iframe);
    });
  }

  // 数组按 id 合并去重（当前优先，旧的补齐缺失项）
  function mergeById(a, b) {
    const seen = new Set();
    const out = [];
    for (const item of a) {
      if (item && item.id != null) { if (seen.has(item.id)) continue; seen.add(item.id); }
      out.push(item);
    }
    for (const item of b) {
      if (item && item.id != null) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
      }
      out.push(item);
    }
    return out;
  }

  // 把一个旧端口库的数据合并进 merged（当前库数据优先，旧库补齐缺失）
  function mergeInto(merged, old) {
    for (const k of Object.keys(old)) {
      const ov = old[k];
      if (ov == null) continue;
      if (Array.isArray(ov)) {
        const cur = Array.isArray(merged[k]) ? merged[k] : [];
        // 跨库 id 互不相同，不能只按 id 去重；改用业务指纹（见 keyFor）
        merged[k] = dedupeArray(cur.concat(ov || []), keyFor(k));
      } else if (typeof ov === 'object') {
        if (k === 'settings') {
          // 设置：当前为空（或缺失）时用旧的，否则保留当前（最新激活态优先）
          const curObj = merged[k];
          const curEmpty = !curObj || (typeof curObj === 'object' && !Array.isArray(curObj) && Object.keys(curObj).length === 0);
          if (curEmpty) { merged[k] = ov; }
          else {
            // 深度合并：当前优先，但当前缺的真实配置（如 apiConfig.apiKey）用旧的补，
            // 避免「当前默认 {apiConfig:{}} 非空 → 旧端口真实密钥被忽略」(S6 修复)
            const mergedSettings = Object.assign({}, ov, curObj);
            const curApi = (curObj && curObj.apiConfig) || {};
            const oldApi = (ov && ov.apiConfig) || {};
            if ((!curApi.apiKey || !String(curApi.apiKey).trim()) && oldApi.apiKey && String(oldApi.apiKey).trim()) {
              mergedSettings.apiConfig = Object.assign({}, curApi, oldApi);
            }
            merged[k] = mergedSettings;
          }
          continue;
        }
        const cur = (merged[k] && typeof merged[k] === 'object' && !Array.isArray(merged[k])) ? merged[k] : {};
        merged[k] = Object.assign({}, ov, cur); // 当前优先
      } else {
        if (!(k in merged)) merged[k] = ov; // 标量：当前无则取旧
      }
    }
  }

  // 主入口：合并所有旧端口库到当前端口库，写回后刷新页面
  async function migrateOldPorts(ports) {
    if (!ports || !ports.length) return;
    const db = await getDB();
    // 读当前库现有 kv
    const current = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const map = {};
        (req.result || []).forEach((r) => { map[r.key] = r.value; });
        resolve(map);
      };
      req.onerror = () => reject(req.error);
    });

    const merged = Object.assign({}, current);
    for (const port of ports) {
      const data = await readPortViaIframe(port);
      if (data && typeof data === 'object') mergeInto(merged, data);
    }

    // 写回合并结果（S7 修复：任一写入失败即整体 reject，绝不以「部分成功」冒充成功 → 避免静默丢旧端口数据）
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = Object.keys(merged);
      if (keys.length === 0) { resolve(); return; }
      let pending = keys.length;
      let failed = false;
      const dec = () => {
        if (--pending === 0) { if (failed) reject(new Error('部分数据写入失败')); else resolve(); }
      };
      for (const k of keys) {
        const putReq = store.put({ key: k, value: merged[k] });
        putReq.onsuccess = dec;
        putReq.onerror = () => { failed = true; dec(); };
      }
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('事务被中止'));
    });

    console.log('[migrate] 已合并旧端口数据到当前库，keys=', Object.keys(merged).length);

    // 通知主进程：关闭临时服务 + 归档旧库，然后刷新页面以重新 hydrate
    if (window.__XJ_API__ && window.__XJ_API__.notifyMigrateDone) {
      try { window.__XJ_API__.notifyMigrateDone(ports); } catch (e) {}
    }
    setTimeout(() => { location.reload(); }, 400);
  }

  // ============================================================
  // 旧端口迁移监听：主进程经 __XJ_API__ 通知后，自动把历史数据合并进当前库。
  // 必须在 return 之前注册——此前误放在 return 之后成为死代码，导致迁移永不触发、
  // 用户升级后历史数据完全不合并（20 版本暴露）。
  if (typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.onLegacyPorts) {
    window.__XJ_API__.onLegacyPorts((ports) => {
      if (ports && ports.length) {
        migrateOldPorts(ports).catch((e) => console.error('[migrate] 失败:', (e && e.message) || e));
      }
    });
  }

  // ============================================================
  // 启动去重（根治「迁移后同记录出现多份」：1.0.21 暴露 4 份重复）
  // 根因：旧端口库里同一条记录由各自进程独立 genId 生成，跨库 id 互不相同，
  //       仅按 id 去重完全失效。改为按业务指纹（稳定字段）去重；
  //       无指纹的记录保守保留，绝不误删内容不同的记录。
  // ============================================================
  function stableStringify(o) {
    try { return JSON.stringify(o, Object.keys(o || {}).sort()); }
    catch (e) { return JSON.stringify(o); }
  }
  // 来访者：业务唯一键=姓名（忽略大小写/空白）
  function clientKey(c) {
    if (!c) return '';
    if (c.name) return 'name:' + String(c.name).trim().toLowerCase();
    if (c.id != null) return 'id:' + c.id;
    return '';
  }
  // 会谈：临床记录不参与跨库业务去重（不同端口可能存在同日临床会谈）；
  // 账务记录仅在拥有稳定业务键时参与幂等去重，其他记录保守保留。
  function billingBusinessKey(s) {
    if (!isBillableSession(s)) return '';
    const b = s.billing;
    if (b.importKey) return 'import:' + b.importKey;
    const note = String(s.notes || '');
    const m = note.match(/\[billing:([^\]]+)\]/);
    return m ? 'billing:' + m[1] : '';
  }
  function sessionKey(s) {
    if (!s) return '';
    const key = billingBusinessKey(s);
    return key ? 'session:' + (s.clientId || '') + '|' + key : '';
  }
  // 督导：clientId + 日期 + 督导师 + 正文
  function supervisionKey(sv) {
    if (!sv) return '';
    return [sv.clientId || '', sv.date || '', sv.supervisorName || '', sv.content || '', sv.conclusion || ''].join('|');
  }
  function keyFor(k) {
    if (k === 'clients') return clientKey;
    if (k === 'sessions') return sessionKey;
    if (k === 'supervisions') return supervisionKey;
    // 其余数组（masterConversations / supervisorIdentities 等）按 id，无 id 则按内容指纹
    return (x) => (x && x.id != null ? 'id:' + x.id : 'json:' + stableStringify(x));
  }
  // 内容丰富度：去重时优先保留信息更完整的副本
  function richness(item) {
    if (!item || typeof item !== 'object') return 0;
    const s = item.soap || {};
    return (item.transcript || '').length + (s.subjective || '').length + (s.objective || '').length +
      (s.assessment || '').length + (s.plan || '').length + (item.summary || '').length +
      (item.reflection || '').length + (item.content || '').length + (item.conclusion || '').length;
  }
  // 单数组按指纹去重
  function dedupeArray(arr, keyFn) {
    const seen = new Map();
    const out = [];
    for (const item of (arr || [])) {
      const key = keyFn(item);
      if (!key) { out.push(item); continue; } // 无指纹：保守保留，不冒险去重
      if (seen.has(key)) {
        const prev = seen.get(key);
        if (richness(item) > richness(prev)) seen.set(key, item); // 保留更完整的
        continue;
      }
      seen.set(key, item);
      out.push(item);
    }
    return out;
  }
  // 月结付款：按 id 去重（结构稳定，含 id）
  function dedupeById(arr) {
    const seen = new Set();
    const out = [];
    for (const it of (arr || [])) {
      const id = it && it.id != null ? String(it.id) : null;
      if (id != null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(it);
    }
    return out;
  }
  async function readAllKv() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const map = {};
        (req.result || []).forEach((r) => { map[r.key] = r.value; });
        resolve(map);
      };
      req.onerror = () => reject(req.error);
    });
  }
  // 仅对拥有同一稳定账务业务键的 billable 记录做幂等去重。
  // 禁止按同日/同节次/零金额删记录：这些条件无法区分临床会谈、免费咨询和真实多次会谈。
  function dedupSessionSource(sessions) {
    if (!Array.isArray(sessions)) return { sessions: sessions || [], removed: 0 };
    const seen = new Map();
    const keep = [];
    let removed = 0;
    for (const s of sessions) {
      const key = billingBusinessKey(s);
      if (!key) { keep.push(s); continue; }
      const scoped = (s.clientId || '') + '|' + key;
      if (!seen.has(scoped)) {
        seen.set(scoped, s);
        keep.push(s);
        continue;
      }
      const prev = seen.get(scoped);
      // 同一稳定导入键才可视为重复；保留内容更丰富的一条。
      if (richness(s) > richness(prev)) {
        const idx = keep.indexOf(prev);
        if (idx >= 0) keep[idx] = s;
        seen.set(scoped, s);
      }
      removed++;
    }
    return { sessions: keep, removed };
  }

  // 对当前库已有重复做一次去重（应对旧端口已归档、迁移不再触发的现状）
  async function maybeDedupe() {
    const flag = await idbGet('__xj_dedup_v4');
    if (flag && flag.done) return 0; // 已处理过，防重
    const all = await readAllKv();
    const ARRAY_KEYS = ['clients', 'sessions', 'supervisions', 'masterConversations', 'supervisorIdentities', 'expenses'];
    let removed = 0;
    const backup = {};
    for (const k of ARRAY_KEYS) {
      const v = all[k];
      if (!Array.isArray(v)) continue;
      const before = v.length;
      const after = dedupeArray(v, keyFor(k));
      if (after.length < before) { removed += before - after; backup[k] = v; all[k] = after; }
    }
    // 第二轮：会谈来源优先级去重（import > manual 次结）
    if (Array.isArray(all.sessions)) {
      const before = all.sessions.length;
      const result = dedupSessionSource(all.sessions);
      if (result.removed > 0) {
        removed += result.removed;
        if (!backup.sessions) backup.sessions = all.sessions;
        all.sessions = result.sessions;
      }
    }
    // clients 内嵌 monthlyPayments 去重
    if (Array.isArray(all.clients)) {
      for (const c of all.clients) {
        const mp = c && c.billing && c.billing.monthlyPayments;
        if (Array.isArray(mp)) {
          const before = mp.length;
          const after = dedupeById(mp);
          if (after.length < before) { removed += before - after; c.billing.monthlyPayments = after; }
        }
      }
    }
    // 不再按“同日 + 零费用”物理删除。该启发式会把临床记录和合法免费咨询误判为重复。
    // 会谈只允许由上面稳定业务键（billing.importKey 或 [billing:key]）驱动的幂等去重处理。
    if (removed === 0) {
      await idbPut('__xj_dedup_v4', { done: true, at: Date.now(), removed: 0 });
      return 0;
    }
    // 备份原始重复数据，极端情况可经开发者工具恢复
    try { await idbPut('__xj_dedup_backup_' + Date.now(), backup); } catch (e) {}
    for (const k of ARRAY_KEYS) {
      if (all[k] !== undefined) await idbPut(k, all[k]);
    }
    await idbPut('__xj_dedup_v4', { done: true, at: Date.now(), removed });
    return removed;
  }

  // ============================================================
  // 公开接口
  // ============================================================
  return {
    hydrate,
    isHydrated,
    // 来访者
    getClients, getClient, createClient, createClientDurable, updateClient, updateClientDurable, deleteClient,
    // 会话
    getSessions, getSession, getSessionsByClient, getSessionsForPicker, isBillableSession,
    getSessionFull, createSession, createSessionDurable, saveSessionDurable, saveSessionsDurable, saveBillingBatchDurable, updateSessionFull, deleteSession, deleteSessionDurable, deleteSessionsDurable,
    nextSessionNumber,
    getSessionSaveError, getSessionRecoveryDraft, canSwitchSession, assertCanSwitchSession,
    // 临床任务与会谈模板选择
    getClinicalTasks, getClinicalTask, getClinicalTasksByClient,
    createClinicalTaskDurable, createAiDraftClinicalTaskDurable, updateClinicalTaskDurable,
    confirmClinicalTaskDurable, transitionClinicalTaskDurable, saveClinicalTasksDurable,
    getSessionTemplateSelection, saveSessionTemplateSelectionDurable, getStorageDiagnostics,
    // 督导
    getSupervisions, getSupervision, createSupervision, createSupervisionDurable, updateSupervision, updateSupervisionDurable, deleteSupervision,
    getSupervisionsByClient, buildSupervisionGrowthContext, saveSupervisionDurable, saveAiSupervision, saveAiSupervisionDurable,
    // 大师对话
    getMasterConversations, getMasterConversation, saveMasterConversation, saveMasterConversationDurable, deleteMasterConversation, deleteMasterConversationDurable,
    // 支出
    getExpenses, getExpense, getExpensesByCategory, getExpensesByMonth,
    createExpense, updateExpense, deleteExpense, createExpenseDurable, updateExpenseDurable, deleteExpenseDurable, clearBillingDataDurable, getExpenseStats,
    // v3.7.0 AI 批量记账撤销
    undoBatch,
    // 督导师身份（AI 督导，付费）
    getSupervisorIdentities, getSupervisorIdentity,
    createSupervisorIdentity, updateSupervisorIdentity, deleteSupervisorIdentity,
    // 临床材料工作项
    getMaterialWorkspaces, getMaterialWorkspace, getMaterialWorkspacesForSession, createMaterialWorkspace, updateMaterialWorkspace, deleteMaterialWorkspace, linkMaterialWorkspace, reconcileMaterialContext,
    // 临床动作溯源
    getClinicalActionRuns, getClinicalActionRun, createClinicalActionRun, updateClinicalActionRun,
    // 设置
    getSettings, saveSettings, saveSettingsDurable,
    // 统计
    getStats, getRecentSessions, getRecentReports,
    // 备份
    exportAll, importAll, getImportQuarantine,
    // v4.3 deletion impact, tombstone and recovery
    previewDeletionImpact, createDeletionBatch, restoreDeletionBatch,
    getDeletionBatch, getDeletionQuarantine,
    // 诊断
    storageInfo,
    // v5 商业余额/请求结果只读投影（不写入业务 IndexedDB）
    setCommercialProjection, getCommercialProjection,
    // 授权闸门
    licenseMode, aiUnlocked,
    // v3.3.0 记忆系统：暴露 KV 原语供 Memory 模块使用
    _get: idbGet, _put: idbPut, _del: idbDelete,
  };
})();

if (typeof window !== 'undefined') {
  window.Store = Store;
}
