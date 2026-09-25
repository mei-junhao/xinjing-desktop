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

  // 「事务失败」与「IndexedDB 环境不可用」必须区分：一次 readwrite 事务 abort
  // （例如并发冲突、上层主动 abort、注入故障）绝不能把 _dbAvailable 翻成 false，
  // 否则该 renderer 之后所有 durable 写全废（既有缺陷）。只有真·环境错误才允许降级。
  const STORAGE_ENV_ERROR_NAMES = new Set(['NotFoundError', 'QuotaExceededError', 'InvalidStateError', 'SecurityError']);
  function isStorageEnvironmentError(error) {
    if (!error) return false;
    if (STORAGE_ENV_ERROR_NAMES.has(String(error.name || ''))) return true;
    return /IndexedDB 不可用/.test(String(error.message || ''));
  }

  // F4-3：写失败必须「可见」。同步 API（createSupervisorIdentity / createExpense /
  // saveSupervision / saveSettings …）已经把记录返回给调用方，无法再补抛错，所以任何
  // 「没落到持久层」的分支都必须登记进诊断台账，由页面经 getStorageDiagnostics() 取用。
  // 规则：宁可多一条诊断也不许静默；诊断本身绝不改变写入结果。
  const MAX_STORAGE_DIAGNOSTICS = 200;
  function recordStorageDiagnostic(code, detail) {
    const entry = { code: String(code || 'XJ_STORAGE_WRITE_FAILED'), at: nowISO() };
    if (detail && typeof detail === 'object') {
      Object.keys(detail).forEach((field) => { entry[field] = detail[field]; });
    }
    storageDiagnostics.push(entry);
    if (storageDiagnostics.length > MAX_STORAGE_DIAGNOSTICS) {
      storageDiagnostics.splice(0, storageDiagnostics.length - MAX_STORAGE_DIAGNOSTICS);
    }
    return entry;
  }
  function failureText(error) {
    return (error && error.message) || String((error && error.name) || error || 'unknown storage error');
  }
  function failureName(error) {
    return String((error && error.name) || '');
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
    let db;
    try {
      db = await getDB();
    } catch (e) {
      _dbAvailable = false;
      return idbGet(key); // 打不开库才走降级
    }
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result ? r.result.value : undefined);
        r.onerror = () => reject(r.error || new Error('IndexedDB read failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB read aborted'));
      });
    } catch (e) {
      if (!isStorageEnvironmentError(e)) {
        // 读路径：事务级失败不翻转降级标志，但仍按既有行为从 localStorage 兜底读一次，
        // 避免给 KV 读调用方（memory / consult-notes）抛出未处理的 rejection。
        try {
          const raw = localStorage.getItem('xj2_' + key);
          return raw ? JSON.parse(raw) : undefined;
        } catch (e2) {
          return undefined;
        }
      }
      _dbAvailable = false;
      return idbGet(key); // 真·环境错误才重试走降级
    }
  }

  async function idbPut(key, value, options) {
    const allowFallback = !options || options.allowFallback !== false;
    if (!_dbAvailable) {
      if (!allowFallback) throw new Error('IndexedDB unavailable for durable persistence');
      // A durable caller needs the real fallback failure, not a false success.
      // F4-3：降级写失败（配额耗尽 / 隐私模式禁用 localStorage / 序列化异常）经
      // writeKvDegraded 登记诊断台账后原样上抛 —— 绝不吞掉、绝不冒充成功。
      writeKvDegraded(key, value);
      return;
    }
    let db;
    try {
      db = await getDB();
    } catch (e) {
      _dbAvailable = false;
      if (!allowFallback) throw e;
      return idbPut(key, value, options); // 重试走降级
    }
    // 事务内的失败原样抛出：不翻转 _dbAvailable（见上注释）。
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    });
  }

  async function idbPutMany(entries, options) {
    const allowFallback = !options || options.allowFallback !== false;
    if (!_dbAvailable) {
      if (!allowFallback) throw new Error('IndexedDB unavailable for durable import');
      // Serialize every value before changing localStorage so an invalid value
      // cannot leave a partly written fallback batch.
      const serialized = entries.map(([key, value]) => ['xj2_' + key, JSON.stringify(value)]);
      // F4-3：同样不得吞掉降级批量写的失败（importAll 在降级态尤其容易撞配额）。
      try {
        serialized.forEach(([key, value]) => localStorage.setItem(key, value));
      } catch (e) {
        recordStorageDiagnostic('XJ_DEGRADED_WRITE_BATCH_FAILED', {
          collections: serialized.map(([key]) => String(key).slice(4)).join(','),
          name: failureName(e), message: failureText(e),
        });
        throw e;
      }
      return;
    }
    let db;
    try {
      db = await getDB();
    } catch (e) {
      _dbAvailable = false;
      if (!allowFallback) throw e;
      return idbPutMany(entries, options);
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      entries.forEach(([key, value]) => store.put({ key, value }));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB batch write aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB batch write failed'));
    });
  }

  // ---------- 降级（localStorage 影子档）读写原语 ----------
  // 降级态下每个集合 / 每个 KV 键都是共享 localStorage 里 xj2_<key> 的一整个 JSON 值。
  // 三条纪律：① 读必须重新取共享值（不能信本窗口 cache）；② 写/删失败必须登记诊断台账
  // 并上抛（F4-3）；③ 档案本身损坏时宁可失败也不要把另一窗口的新数据整档覆盖掉。
  function readKvDegraded(key) {
    const raw = localStorage.getItem('xj2_' + key);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw);
    } catch (e) {
      recordStorageDiagnostic('XJ_DEGRADED_ARCHIVE_UNPARSABLE', {
        collection: key, name: failureName(e), message: failureText(e),
      });
      throw new Error('Degraded archive for ' + key + ' is unparsable: ' + failureText(e));
    }
  }
  function writeKvDegraded(key, value) {
    try {
      localStorage.setItem('xj2_' + key, JSON.stringify(value));
    } catch (e) {
      recordStorageDiagnostic('XJ_DEGRADED_WRITE_FAILED', {
        collection: key, name: failureName(e), message: failureText(e),
      });
      throw e;
    }
  }
  function removeKvDegraded(key) {
    try {
      localStorage.removeItem('xj2_' + key);
    } catch (e) {
      recordStorageDiagnostic('XJ_DEGRADED_REMOVE_FAILED', {
        collection: key, name: failureName(e), message: failureText(e),
      });
      throw e;
    }
  }

  // ---------- 降级（localStorage 影子档）read-modify-write 的统一收口 ----------
  // 证据项①（毫秒级并发）：localStorage 在同源多窗口之间只保证「单次 get / set 各自原子」，
  // 不保证「读 → 合并 → 写」这一串不被另一窗口的整值写插在中间。两层防护：
  //   ① 写之前重新读共享档案（绝不拿本窗口 cache 当底）；
  //   ② 写完立刻回读，用本次意图的 holds(archive) 判定：
  //        · 成立 → 提交成功；
  //        · 不成立（说明对方在我们之后又整值写过）→ 重新读、重新合并、再写，最多 3 轮；
  //        · 3 轮仍不成立 → 登记诊断台账并返回 {ok:false}，绝不对调用方冒充「已落盘」。
  // merge(current) 约定返回 { value, holds? }；holds 缺省为「盘上仍等于我刚写的整值」。
  const DEGRADED_WRITE_MAX_ATTEMPTS = 3;
  function commitDegradedArchive(key, merge) {
    let failure = null;
    for (let attempt = 1; attempt <= DEGRADED_WRITE_MAX_ATTEMPTS; attempt += 1) {
      let current;
      try {
        current = readKvDegraded(key);
      } catch (e) {
        return { ok: false, attempts: attempt, error: { code: 'XJ_DEGRADED_ARCHIVE_UNPARSABLE', message: failureText(e) } };
      }
      let produced;
      try {
        produced = merge(current === undefined ? collectionDefault(key) : current) || {};
      } catch (e) {
        recordStorageDiagnostic('XJ_DEGRADED_MERGE_FAILED', {
          collection: key, name: failureName(e), message: failureText(e),
        });
        return { ok: false, attempts: attempt, error: { code: 'XJ_DEGRADED_MERGE_FAILED', message: failureText(e) } };
      }
      const next = Object.prototype.hasOwnProperty.call(produced, 'value') ? produced.value : current;
      const holds = typeof produced.holds === 'function'
        ? produced.holds
        : (actual) => valuesEqual(actual, next);
      const entity = produced.entityId == null ? null : { id: String(produced.entityId) };
      try {
        localStorage.setItem('xj2_' + key, JSON.stringify(next));
      } catch (e) {
        // 配额耗尽 / 隐私模式禁用 localStorage / 序列化异常：登记后停止重试。
        recordStorageDiagnostic('XJ_DEGRADED_WRITE_FAILED', {
          collection: key, entityId: entity ? entity.id : '', name: failureName(e), message: failureText(e),
        });
        failure = e;
        break;
      }
      let verified;
      try {
        verified = readKvDegraded(key);
      } catch (e) {
        verified = undefined;
      }
      // 校验口径用「盘上仍等于我刚写的整值」。只问「我的记录在不在」是查不出
      // 「另一窗口拿它的陈旧整档把我刚写的那条覆盖回旧样子」的（E1 的两种交错）。
      if (valuesEqual(verified, next)) {
        scheduleDegradedAudit(key, holds, entity);
        return { ok: true, value: next, attempts: attempt };
      }
      // 盘上不再是本窗口刚写的整值。两种可能：
      //   · 本次意图已经被整值写挤掉（意图不再成立）→ 必须重新读、重新合并、再写；
      //   · 只是另一窗口在本窗口写完之后又合法地往前写了（意图仍成立）→ 接受，排延迟复核。
      if (!holds(verified)) {
        failure = new Error('Degraded write for ' + key + ' was overwritten by another window');
        continue;
      }
      scheduleDegradedAudit(key, holds, entity);
      return { ok: true, value: next, attempts: attempt };
    }
    recordStorageDiagnostic('XJ_DEGRADED_WRITE_SUPERSEDED', {
      collection: key, entityId: '', attempts: DEGRADED_WRITE_MAX_ATTEMPTS, message: failureText(failure),
    });
    return {
      ok: false,
      attempts: DEGRADED_WRITE_MAX_ATTEMPTS,
      error: { code: 'XJ_DEGRADED_WRITE_SUPERSEDED', message: failureText(failure) },
    };
  }
  // 延迟复核（证据项①的另一半）：localStorage 没有 test-and-set，另一窗口的整值写仍然
  // 可能落在本窗口「读」与「写」之间，把本窗口刚提交的记录抹掉 —— 而本窗口自己看不见
  // （盘上就是它写的值）。被覆盖的那一方在下一轮宏任务里一定看得见：自己的意图不再成立。
  // 所以每次成功的降级写入都排一次延迟复核，不成立就登记诊断台账，让「丢了」成为可观测
  // 事实，而不是静默冒充成功。刻意**不做**「延迟补写」：补写会把对方稍后合法的删除意图
  // 还原成记录复活（N1 家族），代价比收益大 —— 复活禁止由 E1c 用例把守。
  function scheduleDegradedAudit(key, holds, entity) {
    setTimeout(() => {
      let actual;
      try {
        actual = readKvDegraded(key);
      } catch (e) {
        return; // 档案坏了：读路径已经登记过诊断，不再重复
      }
      if (holds(actual)) return;
      recordStorageDiagnostic('XJ_DEGRADED_WRITE_SUPERSEDED', {
        collection: key,
        entityId: entity ? String(entity.id) : '',
        message: 'A later whole-value write from another window replaced this degraded commit',
      });
    }, 0);
  }
  function archiveHasRecordId(value, id) {
    return Array.isArray(value) && value.some((record) => recordIdOf(record) === String(id));
  }
  function archiveLacksRecordId(value, id) {
    return !archiveHasRecordId(value, id);
  }

  async function idbDelete(key) {
    if (!_dbAvailable) {
      removeKvDegraded(key);
      return;
    }
    let db;
    try {
      db = await getDB();
    } catch (e) {
      _dbAvailable = false;
      removeKvDegraded(key);
      return;
    }
    // 事务级失败原样抛出，不把整个 renderer 永久降级。
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    });
  }

  // ---------- 独立 KV 键的「单写入者 + 单事务」写原语（F4-4） ----------
  // 旧出口 _put / _del 直通 idbPut / idbDelete：既不排队进 queueStoreWrite（可与
  // importAll / 督导归档 / 启动去重 / 普通 durable 写交错进行），失败也只留给调用方
  // 自己 .catch，等于「绕过 RMW 与互斥」。现在两个出口都走这里：
  //   · 与所有 durable 写共用同一条单写入者队列（互斥口径一致）；
  //   · 每个键的 put/delete 在同一个 readwrite 事务里，失败整体 abort 并原样上抛
  //     + 登记诊断台账（失败可见，不报成功）；
  //   · 语义仍是「整值替换」—— 这条通道服务的是 cache 之外的独立 KV 命名空间：
  //       - memory.js: 'activities'（滚动窗口，写方自己按时间/条数裁剪，必须整值替换）
  //       - consult-notes.js: 单会话草稿快照 {version,updatedAt,mode,workflow,fields}
  //     这两个键都不允许做「按 id 并档」，否则裁剪掉的旧条目会被永久复活。
  //   · 需要 read-modify-write 的调用方必须改用 _mutate：读-改-写在一个事务内完成，
  //     跨窗口不会后写覆盖前写（_put 的整值替换契约本身不承担这件事）。
  function commitKvWrite(key, value) {
    return queueStoreWrite(async () => {
      if (!_dbAvailable) {
        if (value === undefined) removeKvDegraded(key);
        else writeKvDegraded(key, value);
        return;
      }
      const db = await getDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        try {
          if (value === undefined) objectStore.delete(key);
          else objectStore.put({ key, value });
        } catch (e) {
          try { tx.abort(); } catch (ignored) {}
          recordStorageDiagnostic('XJ_KV_WRITE_FAILED', { collection: key, name: failureName(e), message: failureText(e) });
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        tx.oncomplete = () => resolve();
        tx.onabort = () => {
          recordStorageDiagnostic('XJ_KV_WRITE_FAILED', { collection: key, name: failureName(tx.error), message: failureText(tx.error) });
          reject(tx.error || new Error('IndexedDB kv write aborted'));
        };
        tx.onerror = () => reject(tx.error || new Error('IndexedDB kv write failed'));
      });
    });
  }
  // 事务内 read-modify-write：transform(当前值) 的返回值即新值（undefined 表示删除）。
  function mutateKv(key, transform) {
    if (typeof transform !== 'function') return Promise.reject(new Error('_mutate requires a transform function'));
    return queueStoreWrite(async () => {
      if (!_dbAvailable) {
        const current = readKvDegraded(key);
        const nextDegraded = transform(current === undefined ? undefined : cloneRecord(current));
        if (nextDegraded === undefined) removeKvDegraded(key);
        else writeKvDegraded(key, nextDegraded);
        return nextDegraded;
      }
      const db = await getDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const request = objectStore.get(key);
        let settled = false;
        let committed;
        const bail = (error) => {
          if (settled) return;
          settled = true;
          try { tx.abort(); } catch (ignored) {}
          recordStorageDiagnostic('XJ_KV_MUTATE_FAILED', { collection: key, name: failureName(error), message: failureText(error) });
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        request.onsuccess = () => {
          if (settled) return;
          try {
            const stored = request.result ? request.result.value : undefined;
            committed = transform(stored === undefined ? undefined : cloneRecord(stored));
            if (committed === undefined) objectStore.delete(key);
            else objectStore.put({ key, value: committed });
          } catch (e) { bail(e); }
        };
        request.onerror = () => bail(request.error || new Error('IndexedDB kv read failed for ' + key));
        tx.oncomplete = () => { if (!settled) resolve(committed); };
        tx.onabort = () => bail(tx.error || new Error('IndexedDB kv mutation aborted'));
        tx.onerror = () => bail(tx.error || new Error('IndexedDB kv mutation failed'));
      });
    });
  }

  function persist(key) {
    // 不阻塞：异步写回，失败静默告警。
    // F4 修复：durable 路径绝不把「本 renderer 的整档 cache」直接覆盖到 IndexedDB，
    // 否则并发窗口新增的记录会被整档抹掉（lost update）。
    if (!_dbAvailable) {
      // 降级路径同样不得整档覆盖：localStorage 在同源多窗口之间是共享的，
      // 直接把本窗口 cache 灌回去会让另一窗口新增的记录当场消失且不再回来。
      // 与 IndexedDB 路径同语义：重新读出当前值，按 id / 字段合并后再写。
      let degraded;
      try {
        const raw = localStorage.getItem('xj2_' + key);
        degraded = mergeCacheIntoArchive(raw ? JSON.parse(raw) : undefined, cache[key]);
      } catch (e) {
        // 共享档案读不回来（损坏）：登记留痕后再按 cache 视图写回，方便定位坏档的窗口。
        recordStorageDiagnostic('XJ_DEGRADED_ARCHIVE_UNPARSABLE', {
          collection: key, name: failureName(e), message: failureText(e),
        });
        degraded = cache[key];
      }
      // idbPut 的降级分支已把写失败登记进诊断台账并上抛，这里只补 console 归因。
      idbPut(key, degraded).catch((e) => console.warn('[Store] 持久化失败', key, e));
      return;
    }
    commitInTx([key], (values) => ({ [key]: mergeCacheIntoArchive(values[key], cache[key]) }), { syncCache: false })
      .catch((e) => {
        recordStorageDiagnostic('XJ_DURABLE_PERSIST_FAILED', {
          collection: key, name: failureName(e), message: failureText(e),
        });
        console.warn('[Store] 持久化失败', key, e);
      });
  }

  // ---------- 统一 durable 提交原语（F4：单写入者 / 事务内 read-modify-write） ----------
  // IndexedDB 里每个集合是 kv object store 中一个 key 下的「一整个数组/对象」。
  // 因此任何 durable 写入都必须：在同一个 readwrite 事务内读出全部参与集合 →
  // 在 DB 当前值上做合并/字段级 patch → 同事务写回 → 只有 tx.oncomplete 之后才把
  // 结果同步进内存 cache。mutate 抛错即 tx.abort()，磁盘不留一半改动。
  const OBJECT_COLLECTION_KEYS = new Set(['settings']);
  const RECORD_GONE = 'XJ_DURABLE_RECORD_GONE';

  function isPlainObjectValue(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function collectionDefault(key) {
    return OBJECT_COLLECTION_KEYS.has(key) ? {} : [];
  }
  function cloneRecord(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function recordIdOf(value) {
    return value && value.id != null ? String(value.id) : '';
  }
  function valuesEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }
  // 浅层按 key 比较：值不等、或 base 缺失该 key，都视为变更；base 有而 next 无时保守不删。
  function diffRecordFields(base, next) {
    const changed = {};
    const source = isPlainObjectValue(base) ? base : {};
    Object.keys(next || {}).forEach((field) => {
      if (!(field in source) || !valuesEqual(source[field], next[field])) changed[field] = next[field];
    });
    return changed;
  }
  // 只把 base→next 的差量落到 DB 当前记录上；DB 记录上的其余字段保持 DB 值。
  // DB 当前值与本窗口新值同为普通对象时再做一层嵌套合并，避免本窗口的写回把其他
  // 窗口写进同一对象的字段（如 billing.note / billing.paid）整对象替换掉。
  function applyFieldPatch(current, base, next) {
    const changed = diffRecordFields(base, next);
    const out = Object.assign({}, current);
    Object.keys(changed).forEach((field) => {
      const fromBase = base ? base[field] : undefined;
      const fromDb = current ? current[field] : undefined;
      const toNext = next[field];
      if (isPlainObjectValue(toNext) && isPlainObjectValue(fromDb)) {
        out[field] = Object.assign({}, fromDb, isPlainObjectValue(fromBase) ? diffRecordFields(fromBase, toNext) : toNext);
      } else {
        out[field] = toNext;
      }
    });
    return out;
  }
  function indexOfRecord(arr, id) {
    const target = String(id || '');
    for (let i = 0; i < arr.length; i += 1) if (recordIdOf(arr[i]) === target) return i;
    return -1;
  }
  function upsertRecord(arr, record) {
    const out = (Array.isArray(arr) ? arr : []).slice();
    const id = recordIdOf(record);
    const index = id ? indexOfRecord(out, id) : -1;
    if (index >= 0) out[index] = record;
    else out.push(record);
    return out;
  }
  function removeRecords(arr, ids) {
    const targets = ids instanceof Set ? ids : new Set((ids || []).map(String));
    if (!targets.size) return (Array.isArray(arr) ? arr : []).slice();
    return (Array.isArray(arr) ? arr : []).filter((item) => !targets.has(recordIdOf(item)));
  }
  function patchRecord(arr, id, base, next) {
    const list = Array.isArray(arr) ? arr : [];
    const index = indexOfRecord(list, id);
    if (index < 0) return { array: list, status: RECORD_GONE, record: null };
    const out = list.slice();
    out[index] = applyFieldPatch(out[index], base, next);
    return { array: out, status: 'ok', record: out[index] };
  }
  function upsertMany(arr, records) {
    return (records || []).reduce((acc, record) => upsertRecord(acc, record), arr);
  }
  // 通用（无 base/next 对的）路径：把 cache 里的记录逐条 upsert 到 DB 当前数组，
  // DB 中 cache 从未见过的记录（其他窗口新增）原样保留 → 绝不整档覆盖。
  function mergeCacheIntoArchive(current, incoming) {
    if (Array.isArray(incoming)) return upsertMany(Array.isArray(current) ? current : [], incoming);
    // 对象集合（settings）：浅合并 patch 到 DB 当前对象上，DB 独有的键保留。
    if (isPlainObjectValue(incoming)) {
      return Object.assign({}, isPlainObjectValue(current) ? current : {}, incoming);
    }
    return incoming;
  }
  // base = 本窗口发起修改前看到的整档；next = 调用方构造的目标整档；cur = DB 当前值。
  // base 有而 next 无 → 按 id 过滤删除；base/next 都有且不同 → 字段级 patch；
  // next 有而 base 无 → 新增；base/next 相同 → 完全保留 DB 版本（含其他窗口改动）。
  function mergeArchive(base, next, cur) {
    const baseArr = Array.isArray(base) ? base : [];
    const nextArr = Array.isArray(next) ? next : [];
    let out = Array.isArray(cur) ? cur.slice() : [];
    const baseById = new Map();
    baseArr.forEach((record) => { const id = recordIdOf(record); if (id) baseById.set(id, record); });
    const nextIds = new Set();
    nextArr.forEach((record) => { const id = recordIdOf(record); if (id) nextIds.add(id); });
    const removedIds = new Set();
    baseArr.forEach((record) => { const id = recordIdOf(record); if (id && !nextIds.has(id)) removedIds.add(id); });
    if (removedIds.size) out = removeRecords(out, removedIds);
    const gone = [];
    nextArr.forEach((record) => {
      const id = recordIdOf(record);
      const previous = id ? baseById.get(id) : undefined;
      if (!previous) { out = upsertRecord(out, record); return; }
      if (valuesEqual(previous, record)) return;
      const merged = patchRecord(out, id, previous, record);
      if (merged.status === RECORD_GONE) { gone.push(id); return; }
      out = merged.array;
    });
    return { array: out, gone };
  }

  // keys: string[] 参与集合；mutate(values, out) 同步返回 {key: value} 映射（未返回的
  // key 不写回，等价于保持 DB 原值）；out 是调用方带回结果的信箱。
  function commitInTx(keys, mutate, options) {
    const names = Array.from(new Set(keys || []));
    const syncCache = !options || options.syncCache !== false;
    return queueStoreWrite(async () => {
      if (!_dbAvailable) throw new Error('IndexedDB unavailable for durable persistence');
      const db = await getDB();
      const committed = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const values = {};
        const out = {};
        let next = null;
        let failed = false;
        let pending = names.length;
        const bail = (error) => {
          if (failed) return;
          failed = true;
          try { tx.abort(); } catch (ignored) {}
          const wrapped = error instanceof Error ? error : new Error(String((error && error.message) || error || 'IndexedDB transaction failed'));
          reject(wrapped);
        };
        const flush = () => {
          if (failed || pending > 0) return;
          try {
            next = mutate(values, out) || {};
            names.forEach((key) => {
              if (Object.prototype.hasOwnProperty.call(next, key)) objectStore.put({ key, value: next[key] });
            });
          } catch (error) { bail(error); }
        };
        if (!names.length) flush();
        names.forEach((key) => {
          const request = objectStore.get(key);
          request.onsuccess = () => {
            try {
              const stored = request.result ? request.result.value : undefined;
              if (stored === undefined) values[key] = collectionDefault(key);
              else if (OBJECT_COLLECTION_KEYS.has(key)) {
                if (!isPlainObjectValue(stored)) throw new Error('Existing ' + key + ' archive is invalid');
                values[key] = stored;
              } else {
                if (!Array.isArray(stored)) throw new Error('Existing ' + key + ' archive is invalid');
                values[key] = stored;
              }
            } catch (error) { pending = 0; bail(error); return; }
            pending -= 1;
            flush();
          };
          request.onerror = () => bail(request.error || new Error('IndexedDB read failed for ' + key));
        });
        tx.oncomplete = () => { if (!failed) resolve({ values, next: next || {}, result: out.result }); };
        tx.onabort = () => bail(tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = () => bail(tx.error || new Error('IndexedDB transaction failed'));
      });
      // 只有 oncomplete 之后才把提交结果同步进内存（契约 §1.4）。
      if (syncCache) {
        Object.keys(committed.next).forEach((key) => { cache[key] = committed.next[key]; });
      }
      return { values: committed.values, next: committed.next, result: committed.result };
    });
  }

  // 同步 UI 路径的「意图登记」：保留同步改 cache 的语义，但持久化走事务内合并。
  // holds(actual) 描述「本次意图在共享档案里应当成立的样子」，降级路径用它做写后回读
  // 校验与延迟复核（证据项①）；durable 路径由事务本身保证，忽略它。
  function durableIntentCommit(key, apply, intent) {
    const holds = intent && intent.holds;
    const entityId = intent && intent.entityId;
    if (!_dbAvailable) {
      // 降级态必须跑同一个 apply，而不是退回到「把 cache 合并上去」。
      // apply 里带着 remove / patch 语义：丢掉它会让删除类意图在降级窗口里不生效，
      // 并且下次 hydrate 从 xj2_* 读回时把已删记录当场复活。
      // F4-3 + 证据项①：统一走 commitDegradedArchive（读-合并-写-回读校验-重试），
      // 失败既登记诊断台账也 console 归因 —— 同步 API 已经返回记录了，只剩这里能说话。
      const committed = commitDegradedArchive(key, (current) => ({
        value: pickIntent(current, apply, key),
        holds,
        entityId,
      }));
      if (!committed.ok) console.warn('[Store] 持久化失败', key, committed.error && committed.error.message);
      return Promise.resolve(null);
    }
    return commitInTx([key], apply, { syncCache: false }).catch((e) => {
      recordStorageDiagnostic('XJ_DURABLE_INTENT_WRITE_FAILED', {
        collection: key, name: failureName(e), message: failureText(e),
      });
      console.warn('[Store] 持久化失败', key, e);
      return null;
    });
  }
  function pickIntent(current, apply, key) {
    const produced = apply({ [key]: current }, {}) || {};
    return Object.prototype.hasOwnProperty.call(produced, key) ? produced[key] : current;
  }
  function persistRecordIntent(key, record, base) {
    const snapshot = cloneRecord(record);
    const baseline = base == null ? null : cloneRecord(base);
    const id = recordIdOf(snapshot);
    return durableIntentCommit(key, (values) => {
      if (!baseline) return { [key]: upsertRecord(values[key], snapshot) };
      const merged = patchRecord(values[key], recordIdOf(snapshot), baseline, snapshot);
      return merged.status === RECORD_GONE ? {} : { [key]: merged.array };
    // 意图成立 = 这条记录还在共享档案里（被别的窗口整值写挤掉 → 重试 / 报诊断）
    }, { holds: id ? (actual) => archiveHasRecordId(actual, id) : undefined, entityId: id });
  }
  function persistRemoveIntent(key, ids) {
    const targets = ids instanceof Set ? new Set(Array.from(ids).map(String)) : new Set((ids || []).map(String));
    if (!targets.size) return Promise.resolve(null);
    return durableIntentCommit(key, (values) => ({ [key]: removeRecords(values[key], targets) }),
      // 删除意图成立 = 目标 id 全部不在共享档案里（被整值写还原 → 重试 / 报诊断）
      { holds: (actual) => Array.from(targets).every((id) => archiveLacksRecordId(actual, id)) });
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

  // ---------- 降级期档案（xj2_*）回迁到 IndexedDB ----------
  // 降级（IndexedDB 不可用）期间所有集合写在同源共享 localStorage 的 xj2_<key> 里。
  // 下一次启动若 IndexedDB 恢复，这些数据必须被「并进」库，而不是永远留在影子档里没人读。
  // 合并口径与降级写盘同规格：库是 durable 真值，影子档只补缺（数组按 id、对象按键），
  // 库里已有的记录 / 已有的设置键一律以库为准 —— 回迁绝不覆盖、绝不回滚库里的现值。
  // 只有事务提交成功才清除影子档；失败时原样保留，下次启动还能重试。
  const DEGRADED_ADOPTION_KEYS = [
    'clients', 'sessions', 'supervisions', 'supervisorIdentities', 'masterConversations',
    'expenses', 'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks',
    'importQuarantine', 'deletionBatches', 'deletionQuarantine', 'settings',
  ];
  function mergeDegradedIntoDurable(current, incoming) {
    if (Array.isArray(incoming)) {
      const base = Array.isArray(current) ? current : [];
      const seen = new Set();
      base.forEach((record) => { const id = recordIdOf(record); if (id) seen.add(id); });
      const out = base.slice();
      incoming.forEach((record) => {
        const id = recordIdOf(record);
        if (id) { if (seen.has(id)) return; seen.add(id); }
        out.push(record);
      });
      return { value: out, added: out.length - base.length };
    }
    if (isPlainObjectValue(incoming)) {
      const base = isPlainObjectValue(current) ? current : {};
      const added = Object.keys(incoming).filter((field) => !(field in base)).length;
      // 同名键以库为准（base 在后），影子档只补库里没有的键。
      return { value: Object.assign({}, incoming, base), added };
    }
    return { value: current, added: 0 };
  }
  async function adoptDegradedArchives() {
    if (!_dbAvailable) return;
    let shadowKeys;
    try {
      shadowKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const raw = localStorage.key(i);
        if (raw && raw.indexOf('xj2_') === 0) shadowKeys.push(raw.slice(4));
      }
    } catch (e) {
      recordStorageDiagnostic('XJ_DEGRADED_ADOPTION_READ_FAILED', { message: failureText(e) });
      return;
    }
    if (!shadowKeys.length) return;
    const pending = shadowKeys.filter((key) => DEGRADED_ADOPTION_KEYS.indexOf(key) >= 0);
    const strays = shadowKeys.filter((key) => DEGRADED_ADOPTION_KEYS.indexOf(key) < 0);
    const adopted = [];
    if (pending.length) {
      await commitInTx(pending, (values) => {
        const next = {};
        pending.forEach((key) => {
          let incoming;
          try { incoming = readKvDegraded(key); } catch (e) { return; }
          const merged = mergeDegradedIntoDurable(values[key], incoming);
          if (merged.added > 0) { next[key] = merged.value; adopted.push(key); }
        });
        return next;
      }, { syncCache: true });
      pending.forEach((key) => {
        try { localStorage.removeItem('xj2_' + key); }
        catch (e) { recordStorageDiagnostic('XJ_DEGRADED_SHADOW_CLEAR_FAILED', { collection: key, message: failureText(e) }); }
      });
    }
    // 集合之外的独立 KV 键（记忆活动、会谈草稿快照等）：库里没有这个键才搬进去，
    // 库里已有则以库为准 —— 影子档一律清除，回迁是一次性的，绝不反复并。
    for (let i = 0; i < strays.length; i += 1) {
      const key = strays[i];
      let incoming;
      try { incoming = readKvDegraded(key); } catch (e) { continue; }
      try {
        await mutateKv(key, (stored) => (stored === undefined ? incoming : stored));
      } catch (e) {
        continue; // 写失败：影子档原样保留，下次启动再试
      }
      try { localStorage.removeItem('xj2_' + key); }
      catch (e) { recordStorageDiagnostic('XJ_DEGRADED_SHADOW_CLEAR_FAILED', { collection: key, message: failureText(e) }); }
    }
    if (adopted.length) console.info('[Store] 降级期档案已回迁 IndexedDB：', adopted.join(','));
  }

  // ---------- 启动加载 ----------
  async function hydrate() {
    if (hydrated) return;
    // 诊断台账在每次启动的水合起点清零：本轮登记的都是「本次启动」的事实。
    storageDiagnostics.length = 0;
    await migrateFromLocalStorage();
    try {
      await adoptDegradedArchives();
    } catch (e) {
      // 回迁失败绝不影响启动：影子档保持原样，下次启动重试（数据不丢，只是还没并进库）。
      console.error('[Store] 降级期档案回迁失败（已跳过，保留待下次启动重试）', e);
    }
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
    // 先把旧键名解析成「待合并的 (会谈 id, 字段, 值)」；这一步不碰 cache、也不碰库。
    const patches = [];
    matches.forEach((blobKey) => {
      const rest = blobKey.slice(PREFIX.length); // <sessionId>:<field>
      const idx = rest.indexOf(':');
      if (idx <= 0) return; // 畸形键：合并之后统一清理
      patches.push({ sessionId: rest.slice(0, idx), field: rest.slice(idx + 1), value: all[blobKey] });
    });
    // F4：合并目标 = commitInTx 事务内读到的 DB 当前 sessions，而不是本窗口 hydrate 时的
    // cache。双开 / acceptance 夹具下两个 renderer 会同时 hydrate，那时长出来的 cache 是
    // 陈旧视图，按它写回会把另一窗口刚提交的会谈整条抹掉，或把同一条会谈的其它字段回退。
    let changed = 0;
    const mergeIntoDbSessions = (values) => {
      const list = Array.isArray(values.sessions) ? values.sessions : [];
      const byId = new Map();
      list.forEach((record) => {
        const id = recordIdOf(record);
        if (id && !byId.has(id)) byId.set(id, record);
      });
      patches.forEach((patch) => {
        const record = byId.get(String(patch.sessionId));
        // DB 里没有这条会谈（例如另一窗口已删）→ 不复活、不写入。
        if (!record || !isPlainObjectValue(record)) return;
        // 仅当目标字段为空才补，绝不覆盖已存在的正式数据。
        if (patch.value == null || record[patch.field] != null) return;
        record[patch.field] = patch.value;
        changed += 1;
      });
      // 一条都没补上 → 返回空映射 = 本次迁移零写入。
      if (!changed) return {};
      // 与旧实现一致：写回前重算报告标记（纯派生字段，从 DB 当前值重算不会回退内容）。
      return {
        sessions: list.map((record) => (isPlainObjectValue(record) ? Object.assign({}, record, computeSessionFlags(record)) : record)),
      };
    };
    let mergeFailed = false;
    try {
      await commitInTx(['sessions'], mergeIntoDbSessions, { syncCache: true });
    } catch (e) {
      // 迁移写失败时保留旧键，下次启动还能重试；绝不留下「键已删、字段没合并」的半完成态。
      mergeFailed = true;
      console.error('[Store] 旧版大字段合并失败（已跳过，保留待下次启动重试）', e);
    }
    if (!mergeFailed) {
      for (const k of matches) { try { await idbDelete(k); } catch (e) {} }
    }
    if (changed > 0) {
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

  // v4.3 删除影响引擎：一律 over 传入的快照，绝不直接读全局 cache。
  // 快照既可以是 cache（同步 preview API，行为不变），也可以是事务内重读到的 DB 值（CAS）。
  // DB 值必须先经过与 hydrate 相同的归一化管线，否则 cache 派生的 previewHash 与
  // DB 派生的 hash 永远不一致，会把正常删除误判成 STALE。
  function deletionArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function normalizeArchivedMaterialRow(row) {
    const hadCreated = !!(row && row.createdAt);
    const hadUpdated = !!(row && row.updatedAt);
    const normalized = normalizeMaterialWorkspace(row);
    if (!normalized) return null;
    if (!hadCreated) delete normalized.createdAt;
    if (!hadUpdated) delete normalized.updatedAt;
    return normalized;
  }
  function normalizeArchivedActionRun(row) {
    const hadCreated = !!(row && row.createdAt);
    const normalized = normalizeClinicalActionRun(row);
    if (!normalized) return null;
    if (!hadCreated) delete normalized.createdAt;
    return normalized;
  }
  function deletionSnapshot(source) {
    const raw = source || cache;
    const clients = deletionArray(raw.clients);
    const sessions = deletionArray(raw.sessions);
    const lookup = {
      clients: new Map(clients.map((item) => [deletionId(item), item]).filter((entry) => entry[0])),
      sessions: new Map(sessions.map((item) => [deletionId(item), item]).filter((entry) => entry[0])),
    };
    const taskIds = new Set();
    const clinicalTasks = deletionArray(raw.clinicalTasks).reduce((acc, row) => {
      const normalized = normalizeClinicalTask(row);
      const reason = normalized ? clinicalTaskReferenceError(normalized, lookup) : 'invalid-task';
      if (!reason && normalized && !taskIds.has(normalized.id)) {
        taskIds.add(normalized.id);
        acc.push(normalized);
      }
      return acc;
    }, []);
    return {
      clients,
      sessions,
      supervisions: deletionArray(raw.supervisions),
      materialWorkspaces: deletionArray(raw.materialWorkspaces).map(normalizeArchivedMaterialRow).filter(Boolean),
      clinicalTasks,
      clinicalActionRuns: deletionArray(raw.clinicalActionRuns).map(normalizeArchivedActionRun).filter(Boolean),
      expenses: deletionArray(raw.expenses),
      deletionBatches: deletionArray(raw.deletionBatches).map(normalizeDeletionBatch).filter(Boolean),
      deletionQuarantine: deletionArray(raw.deletionQuarantine).map(normalizeDeletionQuarantineEntry).filter(Boolean),
    };
  }

  function rawClient(snapshot, id) {
    const list = snapshot && snapshot.clients ? snapshot.clients : cache.clients;
    return list.find((client) => deletionId(client) === String(id || '')) || null;
  }

  function rawSession(snapshot, id) {
    const list = snapshot && snapshot.sessions ? snapshot.sessions : cache.sessions;
    return list.find((session) => deletionId(session) === String(id || '')) || null;
  }

  function deletionEntry(id, extra) {
    return normalizeDeletionEntry(Object.assign({ id: String(id || '') }, extra || {}));
  }

  function sortedDeletionEntries(entries) {
    return entries.filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function collectDeletionImpact(snapshot, targetType, targetId) {
    const client = targetType === 'client' ? rawClient(snapshot, targetId) : null;
    const session = targetType === 'session' ? rawSession(snapshot, targetId) : null;
    if (targetType === 'client' && !client) return null;
    if (targetType === 'session' && !session) return null;

    const sessionIds = new Set(
      targetType === 'client'
        ? snapshot.sessions.filter((item) => String(item.clientId || '') === targetId).map((item) => deletionId(item))
        : [targetId]
    );
    const clientId = targetType === 'client' ? targetId : String(session.clientId || '');
    const affected = {};
    DELETION_COLLECTIONS.forEach((collection) => { affected[collection] = []; });

    if (client) affected.clients.push(deletionEntry(clientId));
    if (session) affected.sessions.push(deletionEntry(targetId, { clientId }));
    if (targetType === 'client') {
      snapshot.sessions
        .filter((item) => String(item.clientId || '') === clientId)
        .forEach((item) => affected.sessions.push(deletionEntry(item.id, { clientId })));
    }

    snapshot.supervisions.forEach((item) => {
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
    snapshot.materialWorkspaces.forEach((item) => {
      if ((clientId && String(item.clientId || '') === clientId) || sessionIds.has(String(item.sessionId || ''))) {
        affected.materials.push(deletionEntry(item.id, {
          clientId: item.clientId, sessionId: item.sessionId,
        }));
        if (item.graphId) affected.graphReferences.push(deletionEntry(item.graphId, { materialId: item.id }));
      }
    });
    snapshot.clinicalTasks.forEach((item) => {
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
    snapshot.clinicalActionRuns.forEach((item) => {
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
    snapshot.expenses.forEach((item) => {
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
    snapshot.sessions.forEach((item) => {
      if (sessionIds.has(deletionId(item)) && item.billing && typeof item.billing === 'object') {
        affected.billing.push(deletionEntry('session:' + item.id + ':billing', { clientId, sessionId: item.id }));
      }
    });

    DELETION_COLLECTIONS.forEach((collection) => {
      affected[collection] = sortedDeletionEntries(affected[collection]);
    });
    return affected;
  }

  function deletionRevision(snapshot) {
    const source = snapshot || cache;
    const pick = (collection, values) => values.map((item) => ({
      collection,
      id: deletionId(item),
      marker: deletionTombstone(item),
      metadata: stableDeletionValue(item),
    })).sort((a, b) => a.id.localeCompare(b.id));
    const revisionInput = {
      clients: pick('clients', source.clients),
      sessions: pick('sessions', source.sessions),
      supervisions: pick('supervisions', source.supervisions),
      materials: pick('materials', source.materialWorkspaces),
      clinicalTasks: pick('clinicalTasks', source.clinicalTasks),
      actionRuns: pick('actionRuns', source.clinicalActionRuns),
      expenses: pick('expenses', source.expenses),
      deletionBatches: source.deletionBatches.map((item) => normalizeDeletionBatch(item)).filter(Boolean),
      deletionQuarantine: source.deletionQuarantine.map((item) => normalizeDeletionQuarantineEntry(item)).filter(Boolean),
    };
    return deletionHash(stableDeletionStringify(revisionInput));
  }

  function buildDeletionPreview(snapshot, targetType, targetId) {
    const source = deletionSnapshot(snapshot || cache);
    const affected = collectDeletionImpact(source, targetType, targetId);
    if (!affected) return null;
    const storeRevision = deletionRevision(source);
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

  function validateDeletionTarget(targetType, targetId, snapshot) {
    if (!['client', 'session'].includes(targetType)) return deletionFailure('XJ_DELETION_TARGET_TYPE', 'Only client and session deletion is supported');
    if (!targetId) return deletionFailure('XJ_DELETION_TARGET_ID', 'A target identifier is required');
    const target = targetType === 'client' ? rawClient(snapshot, targetId) : rawSession(snapshot, targetId);
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
    const snapshot = deletionSnapshot(cache);
    const validation = validateDeletionTarget(targetType, targetId, snapshot);
    if (!validation.ok) return validation;
    return { ok: true, value: buildDeletionPreview(snapshot, targetType, targetId) };
  }

  // 删除参与集合：影响引擎要读的全部键（写回只发生在 clients/sessions/deletionBatches/
  // deletionQuarantine 四个键上，其余键仅用于事务内重算 previewHash = CAS 基线）。
  const DELETION_IMPACT_KEYS = [
    'clients', 'sessions', 'supervisions', 'materialWorkspaces', 'clinicalTasks',
    'clinicalActionRuns', 'expenses', 'deletionBatches', 'deletionQuarantine',
  ];

  async function createDeletionBatch(input) {
    const targetType = String(input && input.targetType || '').trim();
    const targetId = String(input && input.targetId || '').trim();
    const previewHash = String(input && input.previewHash || '').trim();
    if (!previewHash) return deletionFailure('XJ_DELETION_PREVIEW_REQUIRED', 'A current previewHash is required');
    let outcome;
    try {
      outcome = await commitInTx(DELETION_IMPACT_KEYS, (values, out) => {
        // 一切判定都在事务内用 DB 值重算：cache 只用于发起，不作为 CAS 依据。
        const snapshot = deletionSnapshot(values);
        const target = targetType === 'client' ? rawClient(snapshot, targetId) : rawSession(snapshot, targetId);
        const existing = snapshot.deletionBatches.find((item) => item.targetType === targetType && item.targetId === targetId && item.previewHash === previewHash);
        const existingMarker = deletionTombstone(target);
        if (existing && existing.status === 'applied' && existingMarker && existingMarker.batchId === existing.batchId) {
          // 幂等：同 previewHash 重复 apply 不产生第二条 batch（零写入）
          out.result = { kind: 'reused', batch: existing };
          return {};
        }
        const validation = validateDeletionTarget(targetType, targetId, snapshot);
        if (!validation.ok) { out.result = { kind: 'failed', failure: validation }; return {}; }
        const preview = buildDeletionPreview(snapshot, targetType, targetId);
        if (!preview || preview.previewHash !== previewHash) {
          out.result = { kind: 'failed', failure: deletionFailure('XJ_DELETION_PREVIEW_STALE', 'The deletion preview is stale; request a new preview') };
          return {};
        }
        if (existing && existing.status === 'restored') {
          out.result = { kind: 'failed', failure: deletionFailure('XJ_DELETION_BATCH_ALREADY_RESTORED', 'The logical deletion batch has already been restored') };
          return {};
        }
        const batchId = 'delb_' + previewHash;
        const batch = {
          schemaVersion: DELETION_SCHEMA_VERSION,
          batchId, targetType, targetId, previewHash, storeRevision: preview.storeRevision,
          status: 'applied', createdAt: nowISO(), appliedAt: nowISO(), restoredAt: '',
          affected: cloneDeletion(preview.affected), entries: deletionBatchEntries(preview.affected),
        };
        const sessionIds = new Set((preview.affected.sessions || []).map((item) => String(item.id)));
        const clientIds = new Set((preview.affected.clients || []).map((item) => String(item.id)));
        // tombstone 打在 DB 当前记录上：本窗口 cache 未知、由其他窗口新增的记录原样保留。
        const nextClients = values.clients.map((item) => clientIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);
        const nextSessions = values.sessions.map((item) => sessionIds.has(deletionId(item)) ? tombstoneEntity(item, batchId, targetType, targetId) : item);
        const nextBatches = values.deletionBatches.concat([batch]);
        out.result = { kind: 'applied', batch };
        return {
          clients: nextClients,
          sessions: nextSessions,
          deletionBatches: nextBatches,
          deletionQuarantine: values.deletionQuarantine,
        };
      });
    } catch (e) {
      return deletionFailure('XJ_DELETION_BATCH_PERSIST_FAILED', e && e.message ? e.message : 'Deletion batch persistence failed');
    }
    const result = outcome && outcome.result;
    if (!result || result.kind === 'failed') {
      return (result && result.failure) || deletionFailure('XJ_DELETION_BATCH_PERSIST_FAILED', 'Deletion batch persistence produced no result');
    }
    return { ok: true, value: cloneDeletion(result.batch), version: result.batch.appliedAt };
  }

  function getDeletionBatch(batchId) {
    const batch = cache.deletionBatches.find((item) => item.batchId === String(batchId || ''));
    return batch ? { ok: true, value: cloneDeletion(batch) } : deletionFailure('XJ_DELETION_BATCH_NOT_FOUND', 'The deletion batch was not found');
  }

  function getDeletionQuarantine() {
    return { ok: true, value: cloneDeletion(cache.deletionQuarantine) };
  }

  async function restoreDeletionBatch(batchId) {
    const wanted = String(batchId || '');
    let outcome;
    try {
      outcome = await commitInTx(['clients', 'sessions', 'deletionBatches', 'deletionQuarantine'], (values, out) => {
        // 恢复同样在事务内重读：batch 与 tombstone 归属都以 DB 当前值为准。
        const batch = values.deletionBatches.find((item) => item.batchId === wanted);
        if (!batch) {
          out.result = { failure: deletionFailure('XJ_DELETION_BATCH_NOT_FOUND', 'The deletion batch was not found') };
          return {};
        }
        if (batch.status === 'restored') {
          out.result = { reused: cloneDeletion(batch) };
          return {};
        }
        if (batch.status === 'quarantined') {
          out.result = { failure: deletionFailure('XJ_DELETION_BATCH_QUARANTINED', 'The deletion batch requires identifier review') };
          return {};
        }
        const nextClients = values.clients.slice();
        const nextSessions = values.sessions.slice();
        const nextQuarantine = values.deletionQuarantine.slice();
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
        const nextBatches = values.deletionBatches.map((item) => item.batchId === batch.batchId ? nextBatch : item);
        out.result = { applied: true, batch: nextBatch, mismatch };
        return {
          clients: nextClients, sessions: nextSessions,
          deletionBatches: nextBatches, deletionQuarantine: nextQuarantine,
        };
      });
    } catch (e) {
      return deletionFailure('XJ_DELETION_RESTORE_PERSIST_FAILED', e && e.message ? e.message : 'Deletion restore persistence failed');
    }
    const result = outcome && outcome.result;
    if (!result) return deletionFailure('XJ_DELETION_RESTORE_PERSIST_FAILED', 'Deletion restore produced no result');
    if (result.failure) return result.failure;
    if (result.reused) return { ok: true, value: result.reused, version: result.reused.restoredAt };
    if (result.mismatch) return deletionFailure('XJ_DELETION_RESTORE_QUARANTINED', 'Some identifiers could not be restored safely');
    return { ok: true, value: cloneDeletion(result.batch), version: result.batch.restoredAt };
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
  function saveClient(client, knownBase) {
    const idx = cache.clients.findIndex((c) => c.id === client.id);
    const previous = idx >= 0 ? cache.clients[idx] : null;
    // 调用方常先就地 mutate 同一个对象再保存，此时 cache 里的「旧值」已经等于新值，
    // 无法再算差量 → 退回「按 id upsert 整条」，但绝不整档覆盖。
    const base = knownBase !== undefined ? knownBase : (previous === client ? null : previous);
    if (idx >= 0) cache.clients[idx] = client;
    else cache.clients.push(client);
    persistRecordIntent('clients', client, base);
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
    // 事务内以 DB 当前数组为底按 id upsert：其他窗口并发新增的来访者原样保留。
    try {
      await commitInTx(['clients'], (values) => ({ clients: upsertRecord(values.clients, client) }));
      return { ok: true, value: client, version: client.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_CLIENT_CREATE_FAILED', message: e && e.message ? e.message : 'Client persistence failed' } };
    }
  }
  function updateClient(id, patch) {
    licenseGuard('client', id);
    const client = getClient(id);
    if (!client) return null;
    const base = cloneRecord(client);
    Object.assign(client, patch, { updatedAt: nowISO() });
    return saveClient(client, base);
  }
  async function updateClientDurable(id, patch) {
    licenseGuard('client', id);
    const index = cache.clients.findIndex((client) => client.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_CLIENT_NOT_FOUND', message: 'Client was not found' } };
    const base = cloneRecord(cache.clients[index]);
    const candidate = Object.assign({}, base, patch || {}, { updatedAt: nowISO() });
    try {
      const committed = await commitInTx(['clients'], (values, out) => {
        const merged = patchRecord(values.clients, id, base, candidate);
        out.result = merged;
        // 记录已被其他窗口删除 → 不复活、零写入。
        return merged.status === RECORD_GONE ? {} : { clients: merged.array };
      });
      const merged = committed.result;
      if (!merged || merged.status === RECORD_GONE) {
        return { ok: false, value: null, error: { code: RECORD_GONE, message: 'Client was removed by another window' } };
      }
      return { ok: true, value: merged.record, version: merged.record.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_CLIENT_UPDATE_FAILED', message: e && e.message ? e.message : 'Client persistence failed' } };
    }
  }
  // A synchronous multi-collection delete cannot honestly report durable success.
  // Keep this compatibility name, but return a Promise that commits or fails atomically.
  async function deleteClient(id) {
    try {
      licenseGuard('client', id);
      return await queueStoreWrite(async () => {
        if (!_dbAvailable) throw new Error('IndexedDB unavailable for durable deletion');
        const db = await getDB();
        const next = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          const objectStore = tx.objectStore(STORE);
          const keys = ['clients', 'sessions', 'supervisions', 'materialWorkspaces'];
          const values = {};
          let pending = keys.length;
          let updated = null;
          keys.forEach((key) => {
            const request = objectStore.get(key);
            request.onsuccess = () => {
              try {
                if (request.result && !Array.isArray(request.result.value)) throw new Error('Existing ' + key + ' archive is invalid');
                values[key] = request.result ? request.result.value : [];
                pending -= 1;
                if (pending) return;
                const removedSessions = new Set(values.sessions.filter((session) => session.clientId === id).map((session) => session.id));
                updated = {
                  clients: values.clients.filter((client) => client.id !== id),
                  sessions: values.sessions.filter((session) => session.clientId !== id),
                  supervisions: values.supervisions.filter((sv) => {
                    const refs = sv.sessionIds || [];
                    return !refs.length || refs.some((sid) => !removedSessions.has(sid));
                  }),
                  materialWorkspaces: values.materialWorkspaces.map((material) => material.clientId === id
                    ? Object.assign({}, material, { clientId: '', sessionId: '', linkStatus: 'unlinked', updatedAt: nowISO() }) : material),
                };
                keys.forEach((name) => objectStore.put({ key: name, value: updated[name] }));
              } catch (error) { try { tx.abort(); } catch (ignored) {} reject(error); }
            };
            request.onerror = () => reject(request.error);
          });
          tx.oncomplete = () => resolve(updated);
          tx.onabort = () => reject(tx.error || new Error('IndexedDB client deletion aborted'));
          tx.onerror = () => reject(tx.error || new Error('IndexedDB client deletion failed'));
        });
        Object.keys(next).forEach((key) => { cache[key] = next[key]; });
        return { ok: true, value: true };
      });
    } catch (error) {
      return { ok: false, value: false, error: { code: 'XJ_DURABLE_CLIENT_DELETE_FAILED', message: error && error.message || 'Client deletion failed' } };
    }
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
    const base = idx >= 0 && cache.sessions[idx] !== session ? cloneRecord(cache.sessions[idx]) : null;
    if (idx >= 0) cache.sessions[idx] = meta;
    else cache.sessions.push(meta);
    persistRecordIntent('sessions', meta, base);
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
    const candidate = Object.assign({}, session, flags, { updatedAt: nowISO() });
    const scope = sessionSaveScope(candidate.clientId, candidate.id);
    const index = cache.sessions.findIndex((item) => item.id === candidate.id);
    const base = index >= 0 ? cloneRecord(cache.sessions[index]) : null;
    try {
      const committed = await commitInTx(['sessions'], (values, out) => {
        if (!base) {
          const array = upsertRecord(values.sessions, candidate);
          out.result = { status: 'ok', record: array[indexOfRecord(array, candidate.id)] };
          return { sessions: array };
        }
        const merged = patchRecord(values.sessions, candidate.id, base, candidate);
        out.result = merged;
        return merged.status === RECORD_GONE ? {} : { sessions: merged.array };
      });
      const merged = committed.result;
      if (!merged || merged.status === RECORD_GONE) {
        const failure = {
          clientId: String(candidate.clientId || ''),
          sessionId: String(candidate.id || ''),
          draft: candidate,
          version: candidate.updatedAt,
          message: 'The session was removed by another window',
          code: RECORD_GONE,
          failedAt: nowISO(),
        };
        sessionSaveErrors.set(scope, failure);
        return { ok: false, value: null, version: candidate.updatedAt, error: failure };
      }
      sessionSaveErrors.delete(scope);
      return { ok: true, value: merged.record, version: merged.record.updatedAt };
    } catch (e) {
      const failure = {
        clientId: String(candidate.clientId || ''),
        sessionId: String(candidate.id || ''),
        draft: candidate,
        version: candidate.updatedAt,
        message: e && e.message ? e.message : 'Session persistence failed',
        failedAt: nowISO(),
      };
      // Do not replace cache.sessions: existing authoritative data remains intact.
      sessionSaveErrors.set(scope, failure);
      return { ok: false, value: null, version: candidate.updatedAt, error: failure };
    }
  }

  async function saveSessionsDurable(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      return { ok: false, value: null, error: { code: 'XJ_SESSION_BATCH_EMPTY', message: 'No sessions were supplied for persistence' } };
    }

    const baseSessions = cloneRecord(cache.sessions);
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
      const committed = await commitInTx(['sessions'], (values, out) => {
        // base = 本窗口发起批量保存前的整档；next = 本窗口构造的目标整档；
        // cur = DB 当前值 → 只有差量落到 DB 上，其他窗口新增/改动的记录不被回退。
        const merged = mergeArchive(baseSessions, nextSessions, values.sessions);
        if (merged.gone.length) {
          throw new Error(RECORD_GONE + ': ' + merged.gone.join(',') + ' removed by another window');
        }
        out.result = merged.array;
        return { sessions: merged.array };
      });
      // commitInTx 已在 oncomplete 后把 sessions 同步进 cache（含其他窗口的记录）。
      const stored = Array.isArray(committed.next.sessions) ? committed.next.sessions : [];
      const saved = metas.map((meta) => {
        const index = indexOfRecord(stored, meta.id);
        return index >= 0 ? stored[index] : meta;
      });
      saved.forEach((meta) => sessionSaveErrors.delete(sessionSaveScope(meta.clientId, meta.id)));
      return { ok: true, value: saved, version: saved.map((meta) => meta.updatedAt) };
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
  // 账务批次的字段级 patch：本窗口的账务改动落到 DB 当前记录上，非账务字段保持 DB 值。

  async function saveBillingBatchDurable(data) {
    data = data || {};
    const keys = ['clients', 'sessions', 'expenses'];
    const base = {};
    const intended = {};
    keys.forEach((key) => {
      // base = 本窗口构造这批数据时看到的整档（当前 cache）；intended = 调用方给出的目标整档。
      base[key] = cloneRecord(cache[key]);
      intended[key] = Array.isArray(data[key]) ? data[key] : base[key];
    });
    try {
      const committed = await commitInTx(keys, (values) => {
        const next = {};
        const gone = [];
        keys.forEach((key) => {
          if (intended[key] === base[key]) return; // 本窗口没碰这个集合 → 完全不写 DB 值
          const merged = mergeArchive(base[key], intended[key], values[key]);
          gone.push.apply(gone, merged.gone.map((id) => key + ':' + id));
          next[key] = merged.array;
        });
        if (gone.length) throw new Error(RECORD_GONE + ': ' + gone.join(','));
        return next;
      });
      return {
        ok: true,
        value: {
          clients: committed.next.clients,
          sessions: committed.next.sessions,
          expenses: committed.next.expenses,
        },
      };
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
    const targets = new Set(next.deleted.map((session) => String(session.id)));
    try {
      const committed = await commitInTx(['sessions', 'supervisions', 'materialWorkspaces'], (values) => {
        // 删除在 DB 当前值上按 id/谓词过滤，绝不用 cache 数组整体覆盖：
        // 其他窗口新增的会谈、督导、材料全部原样保留。
        const removedIds = new Set();
        values.sessions.forEach((session) => { if (targets.has(recordIdOf(session))) removedIds.add(recordIdOf(session)); });
        const nextSessions = values.sessions.filter((session) => !removedIds.has(recordIdOf(session)));
        const nextSupervisions = values.supervisions.map((supervision) => Object.assign({}, supervision, {
          sessionIds: (supervision.sessionIds || []).filter((id) => !removedIds.has(String(id))),
        }));
        const nextMaterials = values.materialWorkspaces.map((material) => (material && removedIds.has(String(material.sessionId || ''))
          ? Object.assign({}, material, { sessionId: '', updatedAt: nowISO() }) : material));
        return { sessions: nextSessions, supervisions: nextSupervisions, materialWorkspaces: nextMaterials };
      });
      const survived = new Set((committed.next.sessions || []).map(recordIdOf));
      const removedIds = (committed.values.sessions || []).map(recordIdOf).filter((id) => !survived.has(id));
      return { ok: true, deletedSessionIds: removedIds.length ? removedIds : Array.from(targets) };
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
    persistRemoveIntent('sessions', [id]);
    cache.supervisions = cache.supervisions.map((sv) => ({
      ...sv,
      sessionIds: (sv.sessionIds || []).filter((sid) => sid !== id),
    }));
    queueStoreWrite(() => persistSupervisionSessionCleanup(id)).then((saved) => {
      if (!saved.ok) console.warn('[Store] 会谈督导关联持久化失败', saved.error);
    });
    // F4：解除材料工作区的会谈关联同样不得用 cache 整档覆盖 materialWorkspaces，
    // 否则另一窗口新建的材料工作区会被抹掉。逐条按 base→next 差量登记意图。
    const materialPairs = [];
    cache.materialWorkspaces = cache.materialWorkspaces.map((material) => {
      if (material.sessionId !== id) return material;
      materialPairs.push({
        base: cloneRecord(material),
        next: Object.assign({}, material, { sessionId: '', updatedAt: nowISO() }),
      });
      return materialPairs[materialPairs.length - 1].next;
    });
    materialPairs.forEach((pair) => persistRecordIntent('materialWorkspaces', pair.next, pair.base));
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

  // base = 本窗口构造 nextTasks 时看到的整档（各调用点都在改 cache 之前把 nextTasks 拷出来，
  // 故此处 cache.clinicalTasks 就是发起前的快照）；next = 本窗口目标整档。
  // 事务内只把差量落到 DB 当前数组上：其他窗口新增/改动的任务不受影响；
  // 任务被他窗口删除 → 整事务回滚并返回 operation.failureCode（不复活、不报成功）。
  async function persistClinicalTasks(nextTasks, operation) {
    const base = cloneRecord(cache.clinicalTasks);
    const next = cloneRecord(Array.isArray(nextTasks) ? nextTasks : []);
    try {
      const committed = await commitInTx(['clinicalTasks'], (values) => {
        const merged = mergeArchive(base, next, values.clinicalTasks);
        if (merged.gone.length) throw new Error(RECORD_GONE + ': ' + merged.gone.join(','));
        return { clinicalTasks: merged.array };
      });
      const stored = Array.isArray(committed.next.clinicalTasks) ? committed.next.clinicalTasks : [];
      const readback = (value) => {
        const index = indexOfRecord(stored, recordIdOf(value));
        return copyClinicalTask(index >= 0 ? stored[index] : value);
      };
      return {
        ok: true,
        value: Array.isArray(operation.value) ? operation.value.map(readback) : readback(operation.value),
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
    try {
      const committed = await commitInTx(['clients', 'sessions', 'supervisions', 'materialWorkspaces', 'expenses'], (values) => {
        // 清账只按「DB 当前值 + 谓词」清理账务痕迹：其他窗口新增的临床会谈、督导、
        // 材料与来访者字段保持 DB 值，绝不用本窗口 cache 整档覆盖。
        const removedIds = new Set();
        values.sessions.forEach((session) => { if (isBillableSession(session)) removedIds.add(recordIdOf(session)); });
        const nextSessions = values.sessions.filter((session) => !removedIds.has(recordIdOf(session)));
        const nextClients = values.clients.map((client) => {
          const payments = client && client.billing && Array.isArray(client.billing.monthlyPayments) ? client.billing.monthlyPayments : [];
          if (!payments.length) return client;
          return Object.assign({}, client, {
            billing: Object.assign({}, client.billing, { monthlyPayments: [] }),
            updatedAt: nowISO(),
          });
        });
        const nextSupervisions = values.supervisions.map((supervision) => {
          const refs = supervision.sessionIds || [];
          const kept = refs.filter((id) => !removedIds.has(String(id)));
          return kept.length === refs.length ? supervision : Object.assign({}, supervision, { sessionIds: kept });
        });
        const nextMaterials = values.materialWorkspaces.map((material) => (material && removedIds.has(String(material.sessionId || ''))
          ? Object.assign({}, material, { sessionId: '', updatedAt: nowISO() }) : material));
        return {
          clients: nextClients,
          sessions: nextSessions,
          supervisions: nextSupervisions,
          materialWorkspaces: nextMaterials,
          expenses: [],
        };
      });
      return { ok: true, deletedSessionCount: committed.values.sessions.filter(isBillableSession).length };
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
    persistRecordIntent('materialWorkspaces', item, null);
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
    persistRecordIntent('materialWorkspaces', next, item === next ? null : cloneRecord(item));
    return next;
  }
  function deleteMaterialWorkspace(id) {
    const before = cache.materialWorkspaces.length;
    cache.materialWorkspaces = cache.materialWorkspaces.filter((item) => item.id !== id);
    if (cache.materialWorkspaces.length === before) return false;
    persistRemoveIntent('materialWorkspaces', [id]);
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
  // 任务白名单必须与 js/clinical-context.js 的 TASKS 同源；漏登记会让该任务的动作记录
  // 在 normalize 阶段被丢弃，页面表现为「无法确认材料归属」且核心从不被调用。
  const ACTION_TASKS = new Set(['transcript-ai-detect', 'report-ai-fill', 'supervision-ai', 'supervision-multi-school', 'real-supervision-ai-organize', 'real-supervision-ai-record-analyze', 'growth-summary']);
  // 无临床对象可绑的督导任务：与 clinical-context.js :: validateSources 的无来源放行分支一一对应。
  const UNBOUND_SUPERVISION_TASKS = new Set(['supervision-ai', 'supervision-multi-school']);
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
    const isUnboundSupervision = UNBOUND_SUPERVISION_TASKS.has(run.task) &&
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
    cache.clinicalActionRuns.push(run); persistRecordIntent('clinicalActionRuns', run, null); return run;
  }
  function updateClinicalActionRun(id, patch) {
    const current = getClinicalActionRun(id);
    if (!current) return null;
    const base = cloneRecord(current);
    const run = normalizeClinicalActionRun(Object.assign({}, current, patch || {}, { origin: Object.assign({}, current.origin, patch && patch.origin || {}), snapshot: Object.assign({}, current.snapshot, patch && patch.snapshot || {}), output: Object.assign({}, current.output, patch && patch.output || {}) }));
    if (!run || !isValidClinicalActionRun(run)) return null;
    const index = cache.clinicalActionRuns.findIndex((item) => item.id === id);
    cache.clinicalActionRuns[index] = run; persistRecordIntent('clinicalActionRuns', run, base); return run;
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
    // Preserve the synchronous legacy API, but never write its stale whole-array
    // cache back over records archived by another renderer window.
    const snapshot = Object.assign({}, sv);
    queueStoreWrite(() => persistSupervisionSnapshot(snapshot)).then((saved) => {
      if (!saved || !saved.ok) console.warn('[Store] 督导持久化失败', saved && saved.error);
    });
    return sv;
  }
  // Serialize durable supervision read-modify-writes so concurrent archives cannot
  // overwrite one another's snapshot of the single IndexedDB kv array.
  let supervisionWrite = Promise.resolve();
  function queueStoreWrite(action) {
    const pending = supervisionWrite.then(action, action);
    supervisionWrite = pending.then(() => {}, () => {});
    return pending;
  }
  // ---------- 督导集合的单一合并口径（durable 与降级共用，F4-1） ----------
  // 把「一条督导快照落进当前档案」的判定抽成纯函数：两个后端跑同一段代码，
  // 语义（archiveKey 幂等 → reused；否则按 id upsert；不整档覆盖他窗口记录）逐字节一致。
  function applySupervisionSnapshot(rows, sv, archiveKey) {
    const list = Array.isArray(rows) ? rows : [];
    const existing = archiveKey
      ? list.find((item) => item && item.mode === 'multi-school' && item.archiveKey === archiveKey)
      : null;
    if (existing) {
      return {
        rows: list,
        changed: false,
        holds: (actual) => archiveHasRecordId(actual, existing.id),
        entityId: existing.id,
        result: { ok: true, value: existing, version: existing.updatedAt, reused: true },
      };
    }
    const normalized = Object.assign({}, sv, { updatedAt: nowISO() });
    const next = list.slice();
    const index = next.findIndex((item) => item && item.id === normalized.id);
    if (index >= 0) next[index] = normalized;
    else next.push(normalized);
    return {
      rows: next,
      changed: true,
      holds: (actual) => archiveHasRecordId(actual, normalized.id),
      entityId: normalized.id,
      result: { ok: true, value: normalized, version: normalized.updatedAt },
    };
  }
  function supervisionRemovalStep(rows, id) {
    const list = Array.isArray(rows) ? rows : [];
    return {
      rows: list.filter((item) => !item || item.id !== id),
      changed: true,
      holds: (actual) => archiveLacksRecordId(actual, id),
      entityId: id,
      result: { ok: true },
    };
  }
  // F4-1：降级（IndexedDB 不可用）态下督导集合必须与其它集合同规格地落到共享
  // localStorage 的 xj2_supervisions，而不是「直接 throw ⇒ 只活在内存、重启即永久丢失，
  // 且同步 API 照旧把记录还给调用方」。失败时返回 {ok:false,error}（禁止报成功），
  // 且只有校验通过的写入才更新 cache —— 不留半写入状态。
  function persistSupervisionsDegraded(step) {
    let produced = null;
    const committed = commitDegradedArchive('supervisions', (current) => {
      produced = step(current);
      return { value: produced.rows, holds: produced.holds, entityId: produced.entityId };
    });
    if (!committed.ok) {
      console.warn('[Store] 督导持久化失败', committed.error && committed.error.message);
      return {
        ok: false,
        value: null,
        error: {
          code: 'XJ_DEGRADED_SUPERVISION_SAVE_FAILED',
          message: (committed.error && committed.error.message) || 'Degraded supervision persistence failed',
        },
      };
    }
    cache.supervisions = committed.value;
    return (produced && produced.result) || { ok: true };
  }
  async function persistSupervisionSnapshot(sv, archiveKey) {
    try {
      if (!_dbAvailable) {
        return persistSupervisionsDegraded((rows) => applySupervisionSnapshot(rows, sv, archiveKey));
      }
      const db = await getDB();
      const committed = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const request = objectStore.get('supervisions');
        let result = null;
        let nextSupervisions = null;
        request.onsuccess = () => {
          try {
            if (request.result && !Array.isArray(request.result.value)) throw new Error('Existing supervision archive is invalid');
            // Reading and replacing the kv array within the SAME IDB readwrite
            // transaction serializes separate renderer windows as well as this page.
            const step = applySupervisionSnapshot(request.result ? request.result.value : [], sv, archiveKey);
            nextSupervisions = step.rows;
            if (step.changed) objectStore.put({ key: 'supervisions', value: step.rows });
            result = step.result;
          } catch (error) { try { tx.abort(); } catch (ignored) {} reject(error); }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve({ result, nextSupervisions });
        tx.onabort = () => reject(tx.error || new Error('IndexedDB supervision write aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB supervision write failed'));
      });
      cache.supervisions = committed.nextSupervisions;
      return committed.result;
    } catch (e) {
      recordStorageDiagnostic('XJ_DURABLE_SUPERVISION_SAVE_FAILED', { collection: 'supervisions', message: failureText(e) });
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_SUPERVISION_SAVE_FAILED', message: e && e.message ? e.message : 'Supervision persistence failed' } };
    }
  }
  async function saveSupervisionDurable(sv) {
    if (!sv || !sv.id) return { ok: false, value: null, error: { code: 'XJ_SUPERVISION_INVALID', message: 'Supervision was not supplied' } };
    return queueStoreWrite(() => persistSupervisionSnapshot(sv));
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
  async function persistSupervisionPatch(id, base, candidate) {
    try {
      if (!_dbAvailable) {
        return queueStoreWrite(() => persistSupervisionsDegraded((rows) => {
          const merged = patchRecord(rows, id, base, candidate);
          if (merged.status === RECORD_GONE) {
            return { rows, changed: false, holds: (actual) => archiveLacksRecordId(actual, id), entityId: id,
              result: { ok: false, value: null, error: { code: RECORD_GONE, message: 'Supervision was removed by another window' } } };
          }
          return { rows: merged.array, changed: true, holds: (actual) => archiveHasRecordId(actual, id), entityId: id,
            result: { ok: true, value: merged.record, version: merged.record.updatedAt } };
        }));
      }
      const committed = await commitInTx(['supervisions'], (values, out) => {
        const merged = patchRecord(values.supervisions, id, base, candidate);
        out.result = merged;
        return merged.status === RECORD_GONE ? {} : { supervisions: merged.array };
      });
      const merged = committed.result;
      if (!merged || merged.status === RECORD_GONE) {
        return { ok: false, value: null, error: { code: RECORD_GONE, message: 'Supervision was removed by another window' } };
      }
      return { ok: true, value: merged.record, version: merged.record.updatedAt };
    } catch (e) {
      recordStorageDiagnostic('XJ_DURABLE_SUPERVISION_SAVE_FAILED', { collection: 'supervisions', message: failureText(e) });
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_SUPERVISION_SAVE_FAILED', message: failureText(e) } };
    }
  }
  function updateSupervision(id, patch) {
    licenseGuard('supervision', id);
    const sv = getSupervision(id);
    if (!sv) return null;
    const base = cloneRecord(sv);
    Object.assign(sv, patch, { updatedAt: nowISO() });
    const candidate = cloneRecord(sv);
    persistSupervisionPatch(id, base, candidate).then((saved) => {
      if (!saved || !saved.ok) console.warn('[Store] 督导更新持久化失败', saved && saved.error);
    });
    return sv;
  }
  async function updateSupervisionDurable(id, patch) {
    licenseGuard('supervision', id);
    const index = cache.supervisions.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_SUPERVISION_NOT_FOUND', message: 'Supervision was not found' } };
    const base = cloneRecord(cache.supervisions[index]);
    const candidate = Object.assign({}, base, patch || {}, { updatedAt: nowISO() });
    return persistSupervisionPatch(id, base, candidate);
  }
  function deleteSupervision(id) {
    licenseGuard('supervision', id);
    cache.supervisions = cache.supervisions.filter((s) => s.id !== id);
    queueStoreWrite(() => persistSupervisionRemoval(id)).then((saved) => {
      if (!saved.ok) console.warn('[Store] 督导移除持久化失败', saved.error);
    });
    return true;
  }
  async function persistSupervisionCleanup(transform) {
    try {
      // F4-1：清理（解除会谈关联等）在降级态同样要落到 xj2_supervisions，
      // 否则重启后旧关联会原样复活。
      if (!_dbAvailable) {
        return persistSupervisionsDegraded((rows) => ({
          rows: transform(rows), changed: true, result: { ok: true },
        }));
      }
      const db = await getDB();
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const request = objectStore.get('supervisions');
        let nextRows = [];
        request.onsuccess = () => {
          try {
            if (request.result && !Array.isArray(request.result.value)) throw new Error('Existing supervision archive is invalid');
            nextRows = transform(request.result ? request.result.value : []);
            objectStore.put({ key: 'supervisions', value: nextRows });
          } catch (error) { try { tx.abort(); } catch (ignored) {} reject(error); }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(nextRows);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB supervision cleanup aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB supervision cleanup failed'));
      });
      cache.supervisions = rows;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: { code: 'XJ_DURABLE_SUPERVISION_CLEANUP_FAILED', message: error && error.message || 'Supervision cleanup failed' } };
    }
  }
  function persistSupervisionSessionCleanup(id) {
    return persistSupervisionCleanup((rows) => rows.map((sv) => Object.assign({}, sv, {
      sessionIds: (sv.sessionIds || []).filter((sid) => sid !== id),
    })));
  }
  async function persistSupervisionRemoval(id) {
    try {
      // F4-1：降级态的督导删除也要落到共享档案，否则重启即复活（与 S11/S12 对其它
      // 集合已立的同一口径）。
      if (!_dbAvailable) {
        return persistSupervisionsDegraded((rows) => supervisionRemovalStep(rows, id));
      }
      const db = await getDB();
      const next = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const request = objectStore.get('supervisions');
        let nextRows = [];
        request.onsuccess = () => {
          try {
            if (request.result && !Array.isArray(request.result.value)) throw new Error('Existing supervision archive is invalid');
            nextRows = (request.result ? request.result.value : []).filter((item) => item.id !== id);
            objectStore.put({ key: 'supervisions', value: nextRows });
          } catch (error) { try { tx.abort(); } catch (ignored) {} reject(error); }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => resolve(nextRows);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB supervision removal aborted'));
        tx.onerror = () => reject(tx.error || new Error('IndexedDB supervision removal failed'));
      });
      cache.supervisions = next;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: { code: 'XJ_DURABLE_SUPERVISION_DELETE_FAILED', message: error && error.message || 'Supervision removal failed' } };
    }
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
    const sv = {
      id: genId('sv'), type: 'ai', supervisorName: data.supervisorName || 'AI 督导', clientId: data.clientId || '',
      date: (data.date || nowISO().slice(0, 10)), sessionId: data.sessionId || '', sessionIds: Array.isArray(data.sessionIds) && data.sessionIds.length ? data.sessionIds.slice() : (data.sessionId ? [data.sessionId] : []),
      content: data.context || '', conclusion: data.content || '', createdAt: nowISO(), updatedAt: nowISO(),
    };
    if (data.mode === 'multi-school') {
      sv.mode = 'multi-school';
      sv.archiveKey = data.archiveKey || '';
      sv.schools = Array.isArray(data.schools) ? data.schools.slice() : [];
      sv.route = data.route || null;
      sv.analyses = Array.isArray(data.analyses) ? data.analyses.slice() : [];
      sv.summary = data.summary || '';
      sv.usage = data.usage || null;
    }
    return sv;
  }
  async function saveAiSupervisionDurable(data) {
    try {
      if (!data || typeof data !== 'object') return { ok: false, value: null, error: { code: 'XJ_SUPERVISION_INVALID', message: 'AI supervision was not supplied' } };
      return await queueStoreWrite(() => {
        // Never trust a renderer cache hit: another window may have removed the
        // record. The durable transaction decides whether this key is reused.
        licenseGuard('supervision', null);
        return persistSupervisionSnapshot(buildAiSupervision(data), data.mode === 'multi-school' ? data.archiveKey : '');
      });
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_AI_SUPERVISION_FAILED', message: e && e.message ? e.message : 'AI supervision persistence failed' } };
    }
  }
  function saveAiSupervision(data) {
    try {
      const sv = buildAiSupervision(data);
      // 直接入库（绕过 createSupervision 的硬抛错，改为静默跳过上限）
      licenseGuard('supervision', null);
      return saveSupervision(sv);
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
    const normalized = normalizeMasterConversation(conv);
    normalized.updatedAt = nowISO();
    const idx = cache.masterConversations.findIndex((c) => c.id === normalized.id);
    const base = idx >= 0 && cache.masterConversations[idx] !== conv ? cache.masterConversations[idx] : null;
    if (idx >= 0) cache.masterConversations[idx] = normalized;
    else cache.masterConversations.unshift(normalized);
    persistRecordIntent('masterConversations', normalized, base);
    return normalized;
  }
  async function saveMasterConversationDurable(conv) {
    if (!conv || !conv.id) return { ok: false, value: null, error: { code: 'XJ_MASTER_CONVERSATION_INVALID', message: 'Conversation was not supplied' } };
    const normalized = normalizeMasterConversation(conv);
    normalized.updatedAt = nowISO();
    const index = cache.masterConversations.findIndex((item) => item.id === normalized.id);
    const base = index >= 0 ? cloneRecord(cache.masterConversations[index]) : null;
    try {
      const committed = await commitInTx(['masterConversations'], (values, out) => {
        if (!base) {
          const array = upsertRecord(values.masterConversations, normalized);
          out.result = { status: 'ok', record: array[indexOfRecord(array, normalized.id)] };
          return { masterConversations: array };
        }
        const merged = patchRecord(values.masterConversations, normalized.id, base, normalized);
        out.result = merged;
        return merged.status === RECORD_GONE ? {} : { masterConversations: merged.array };
      });
      const merged = committed.result;
      if (!merged || merged.status === RECORD_GONE) {
        return { ok: false, value: null, error: { code: RECORD_GONE, message: 'Conversation was removed by another window' } };
      }
      return { ok: true, value: merged.record, version: merged.record.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_MASTER_CONVERSATION_SAVE_FAILED', message: e && e.message ? e.message : 'Conversation persistence failed' } };
    }
  }
  function deleteMasterConversation(id) {
    cache.masterConversations = cache.masterConversations.filter((c) => c.id !== id);
    persistRemoveIntent('masterConversations', [id]);
    return true;
  }

  async function deleteMasterConversationDurable(id) {
    try {
      const committed = await commitInTx(['masterConversations'], (values, out) => {
        // 删除在 DB 当前数组上按 id 过滤，其他窗口新增的对话保留；DB 里本就没有时
        // 视为幂等成功（零写入），不再按本窗口 cache 的有无报「删除失败」。
        const array = removeRecords(values.masterConversations, [id]);
        out.result = { removed: array.length !== values.masterConversations.length };
        return out.result.removed ? { masterConversations: array } : {};
      });
      return { ok: true, deleted: !!(committed.result && committed.result.removed), value: true };
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
    persistRecordIntent('expenses', exp, null);
    return exp;
  }
  async function createExpenseDurable(data) {
    const stamp = nowISO();
    const expense = Object.assign(
      { id: genId('exp'), category: 'other', date: stamp.slice(0, 10), amount: 0, description: '', clientId: '', batchId: '', createdAt: stamp, updatedAt: stamp },
      data,
      { updatedAt: stamp }
    );
    // 事务内按 id upsert 到 DB 当前数组：他窗口并发新增的支出保留。
    try {
      await commitInTx(['expenses'], (values) => ({ expenses: upsertRecord(values.expenses, expense) }));
      return { ok: true, value: expense, version: expense.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_EXPENSE_CREATE_FAILED', message: e && e.message ? e.message : 'Expense persistence failed' } };
    }
  }
  // v3.7.0 撤销 AI 批量记账：删除所有 batchId 匹配的 sessions 和 expenses
  function undoBatch(batchId) {
    if (!batchId) return { sessions: 0, expenses: 0 };
    const removedSessionIds = cache.sessions.filter((s) => s.batchId === batchId).map((s) => String(s.id));
    const removedExpenseIds = cache.expenses.filter((e) => e.batchId === batchId).map((e) => String(e.id));
    const sBefore = cache.sessions.length;
    const eBefore = cache.expenses.length;
    cache.sessions = cache.sessions.filter((s) => s.batchId !== batchId);
    cache.expenses = cache.expenses.filter((e) => e.batchId !== batchId);
    const sRemoved = sBefore - cache.sessions.length;
    const eRemoved = eBefore - cache.expenses.length;
    // 撤销按 id 从 DB 当前数组过滤，不用整档覆盖（其他窗口的记录不会被打回来）。
    if (removedSessionIds.length) persistRemoveIntent('sessions', removedSessionIds);
    if (removedExpenseIds.length) persistRemoveIntent('expenses', removedExpenseIds);
    return { sessions: sRemoved, expenses: eRemoved };
  }
  function updateExpense(id, patch) {
    const idx = cache.expenses.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const base = cloneRecord(cache.expenses[idx]);
    cache.expenses[idx] = Object.assign({}, cache.expenses[idx], patch, { updatedAt: nowISO() });
    persistRecordIntent('expenses', cache.expenses[idx], base);
    return cache.expenses[idx];
  }
  async function updateExpenseDurable(id, patch) {
    const index = cache.expenses.findIndex((expense) => expense.id === id);
    if (index < 0) return { ok: false, value: null, error: { code: 'XJ_EXPENSE_NOT_FOUND', message: 'Expense was not found' } };
    const base = cloneRecord(cache.expenses[index]);
    const candidate = Object.assign({}, base, patch, { updatedAt: nowISO() });
    try {
      const committed = await commitInTx(['expenses'], (values, out) => {
        const merged = patchRecord(values.expenses, id, base, candidate);
        out.result = merged;
        return merged.status === RECORD_GONE ? {} : { expenses: merged.array };
      });
      const merged = committed.result;
      if (!merged || merged.status === RECORD_GONE) {
        return { ok: false, value: null, error: { code: RECORD_GONE, message: 'Expense was removed by another window' } };
      }
      return { ok: true, value: merged.record, version: merged.record.updatedAt };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_DURABLE_EXPENSE_UPDATE_FAILED', message: e && e.message ? e.message : 'Expense persistence failed' } };
    }
  }
  function deleteExpense(id) {
    cache.expenses = cache.expenses.filter((e) => e.id !== id);
    persistRemoveIntent('expenses', [id]);
    return true;
  }
  async function deleteExpenseDurable(id) {
    const expense = cache.expenses.find((item) => item.id === id);
    if (!expense) return { ok: false, deleted: false, error: { code: 'XJ_EXPENSE_NOT_FOUND', message: 'Expense was not found' } };
    try {
      const committed = await commitInTx(['expenses'], (values, out) => {
        // 按 id 从 DB 当前数组过滤，绝不用 cache 数组整档覆盖。
        const array = removeRecords(values.expenses, [id]);
        out.result = { removed: array.length !== values.expenses.length, array };
        return out.result.removed ? { expenses: array } : {};
      });
      if (!committed.result || !committed.result.removed) {
        return { ok: true, deleted: false, value: expense };
      }
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
    persistRecordIntent('supervisorIdentities', identity, null);
    return identity;
  }
  function updateSupervisorIdentity(obj) {
    const idx = cache.supervisorIdentities.findIndex((s) => s.id === obj.id);
    if (idx < 0) return null;
    const base = cloneRecord(cache.supervisorIdentities[idx]);
    cache.supervisorIdentities[idx] = Object.assign({}, cache.supervisorIdentities[idx], {
      name: (obj.name || '').trim() || cache.supervisorIdentities[idx].name,
      prompt: obj.prompt != null ? obj.prompt : cache.supervisorIdentities[idx].prompt,
    });
    // base 必须传进来：传 null 会被当成「新增/整条替换」，
    // 另一窗口对同一身份其它字段的改动会被回退。
    persistRecordIntent('supervisorIdentities', cache.supervisorIdentities[idx], base);
    return cache.supervisorIdentities[idx];
  }
  function deleteSupervisorIdentity(id) {
    const target = cache.supervisorIdentities.find((s) => s.id === id);
    if (target && target.builtin) return false; // 内置身份不可删
    cache.supervisorIdentities = cache.supervisorIdentities.filter((s) => s.id !== id);
    persistRemoveIntent('supervisorIdentities', [id]);
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
    // 设置是对象集合：只把本次 patch 的键浅合并到 DB 当前对象上，其他窗口写入的
    // 其他设置键（含 apiConfig）保持 DB 值。
    const keys = Object.keys(patch && typeof patch === 'object' ? patch : {});
    const safePatch = cloneRecord(patch && typeof patch === 'object' ? patch : {});
    if (!_dbAvailable) {
      // F4-2：降级路径与 durable 路径同规格 —— 只把「本次 patch 的键」合并进共享档案。
      // 旧实现走 persist('settings')，等价于把本窗口整份陈旧 settings（含上一轮 hydrate
      // 读到的 apiConfig / version）灌回同源共享 localStorage，于是后写的陈旧窗口会把
      // 另一窗口刚提交的供应商 / 计费配置原地回滚。空 patch 同样零写入（与 durable 一致）。
      persistSettingsPatchDegraded(keys, safePatch);
    } else if (keys.length) {
      commitInTx(['settings'], (values) => ({
        settings: Object.assign({}, values.settings, pickFields(safePatch, keys)),
      }), { syncCache: false }).catch((e) => console.warn('[Store] 持久化失败', 'settings', e));
    }
    // 空 patch + IndexedDB 可用：本次没有任何要落盘的设置意图，写盘只会把本窗口的
    // 陈旧设置灌回 DB（覆盖另一窗口更新过的同名键）→ 零写入。
    return cache.settings;
  }
  function pickFields(source, keys) {
    const out = {};
    keys.forEach((key) => { if (source && Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]; });
    return out;
  }

  // 降级态 settings 写入：重新读出共享档案 → 只合并本次 patch 的键 → 写回 → 回读校验。
  // 共享档案读不回来 / 不是对象时直接失败留痕，绝不借机整档替换掉另一窗口的设置。
  function persistSettingsPatchDegraded(keys, safePatch) {
    if (!keys.length) return;
    const committed = commitDegradedArchive('settings', (current) => {
      if (!isPlainObjectValue(current)) throw new Error('Existing degraded settings archive is invalid');
      const picked = pickFields(safePatch, keys);
      return {
        value: Object.assign({}, current, picked),
        // 意图成立 = 本次 patch 的键都还在共享设置档里（被整档写挤掉 → 重试 / 报诊断）
        holds: (actual) => isPlainObjectValue(actual) && keys.every((field) => field in actual),
      };
    });
    if (!committed.ok) console.warn('[Store] 持久化失败', 'settings', committed.error && committed.error.message);
  }

  async function saveSettingsDurable(patch) {
    const safePatch = patch && typeof patch === 'object' ? patch : {};
    try {
      // 事务内读 DB 当前 settings 对象，只把本次 patch 的键浅合并上去：
      // 其他窗口写入的其他设置键保持 DB 值。
      const committed = await commitInTx(['settings'], (values) => ({
        settings: Object.assign({}, values.settings, cloneRecord(safePatch)),
      }));
      return { ok: true, value: committed.next.settings };
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

  function sanitizeImportedSettings(settings, source) {
    const base = source || cache;
    const incoming = sanitizeBackupSettings(settings || {});
    const currentApi = base.settings && base.settings.apiConfig && typeof base.settings.apiConfig === 'object'
      ? base.settings.apiConfig : {};
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

  // 备份里缺少的集合，回落基准从「本窗口 cache」改成「调用方传入的快照」。
  // importAll 会传入事务内重读到的 DB 值，因此导入不再拿过期 cache 派生整档。
  function prepareImport(data, source) {
    const base = source || cache;
    const next = {
      clients: Array.isArray(data.clients) ? data.clients : base.clients,
      sessions: Array.isArray(data.sessions) ? data.sessions : base.sessions,
      supervisions: Array.isArray(data.supervisions) ? data.supervisions : base.supervisions,
      supervisorIdentities: Array.isArray(data.supervisorIdentities) ? data.supervisorIdentities : base.supervisorIdentities,
      masterConversations: Array.isArray(data.masterConversations) ? data.masterConversations.map(normalizeMasterConversation) : base.masterConversations,
      expenses: Array.isArray(data.expenses) ? data.expenses : base.expenses,
      materialWorkspaces: Array.isArray(data.materialWorkspaces) ? data.materialWorkspaces.map(normalizeMaterialWorkspace).filter(Boolean) : [],
      clinicalActionRuns: [],
      clinicalTasks: [],
      settings: data.settings ? sanitizeImportedSettings(data.settings, base) : base.settings,
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
      : base.deletionQuarantine.map(normalizeDeletionQuarantineEntry).filter(Boolean);
    const importedBatches = Array.isArray(data.deletionBatches)
      ? data.deletionBatches.map(normalizeDeletionBatch).filter(Boolean)
      : base.deletionBatches.map(normalizeDeletionBatch).filter(Boolean);
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

  const IMPORT_KEYS = [
    'clients', 'sessions', 'supervisions', 'supervisorIdentities', 'masterConversations',
    'expenses', 'materialWorkspaces', 'clinicalActionRuns', 'clinicalTasks', 'importQuarantine',
    'deletionBatches', 'deletionQuarantine', 'settings',
  ];

  async function importAll(jsonStr) {
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_IMPORT_DURABLE_FAILED', message: e && e.message ? e.message : 'Import payload is not valid JSON' } };
    }
    try {
      // 一个 readwrite 事务：事务内重读全部集合作为 prepareImport 的基准（不再用 cache），
      // 再按 §2 的差量合并写回；mutate 抛错或任一 put 失败 → 整事务 abort，磁盘保持导入前状态。
      const committed = await commitInTx(IMPORT_KEYS, (values, out) => {
        const snapshot = deletionImportBase(values);
        const next = prepareImport(data, snapshot);
        const written = {};
        IMPORT_KEYS.forEach((key) => {
          if (key === 'settings') {
            written.settings = Object.assign({}, values.settings, diffRecordFields(snapshot.settings, next.settings));
            return;
          }
          if (key === 'importQuarantine') {
            // 隔离区是本次导入产生的审计记录：按 id upsert 到 DB 当前数组，不删除历史隔离项。
            written.importQuarantine = mergeCacheIntoArchive(values.importQuarantine, next.importQuarantine);
            return;
          }
          written[key] = mergeArchive(snapshot[key], next[key], values[key]).array;
        });
        out.result = { quarantine: written.importQuarantine.slice(), deletionQuarantine: written.deletionQuarantine.slice() };
        return written;
      });
      return {
        ok: true,
        quarantine: committed.result.quarantine,
        deletionQuarantine: committed.result.deletionQuarantine,
      };
    } catch (e) {
      return { ok: false, value: null, error: { code: 'XJ_IMPORT_DURABLE_FAILED', message: e && e.message ? e.message : 'Import failed' } };
    }
  }
  // 导入基准：DB 当前值经与 hydrate 一致的归一化后的视图（deletionSnapshot 已覆盖
  // 删除影响引擎需要的集合，这里补齐其余集合的原始数组形状）。
  function deletionImportBase(values) {
    return {
      clients: deletionArray(values.clients),
      sessions: deletionArray(values.sessions),
      supervisions: deletionArray(values.supervisions),
      supervisorIdentities: deletionArray(values.supervisorIdentities),
      masterConversations: deletionArray(values.masterConversations),
      expenses: deletionArray(values.expenses),
      materialWorkspaces: deletionArray(values.materialWorkspaces),
      clinicalActionRuns: deletionArray(values.clinicalActionRuns),
      clinicalTasks: deletionArray(values.clinicalTasks),
      importQuarantine: deletionArray(values.importQuarantine),
      deletionBatches: deletionArray(values.deletionBatches),
      deletionQuarantine: deletionArray(values.deletionQuarantine),
      settings: isPlainObjectValue(values.settings) ? values.settings : {},
    };
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
  // F4-5：旧实现是「readonly 事务 getAll 读 → 合并 → 另一个 readwrite 事务写全部」，
  // 而且完全不在 queueStoreWrite 里 ⇒ 启动期它与并发窗口的普通写、与本窗口的督导归档 /
  // importAll / 去重事务都不共享互斥：两个事务之间落地的写入会被这份陈旧快照整档覆盖。
  // 现在：① iframe 取数先行（跨源通信不能占用 IDB 事务生命周期）；
  //       ② 读当前库 + 合并 + 写回在同一个 readwrite 事务内完成；
  //       ③ 整个提交纳入 queueStoreWrite，与所有 durable 写串行；
  //       ④ 任一步失败 → tx.abort() 整体回滚 + 诊断台账 + 上抛（绝不部分成功）。
  async function migrateOldPorts(ports) {
    if (!ports || !ports.length) return;
    if (!_dbAvailable) {
      recordStorageDiagnostic('XJ_LEGACY_PORT_MIGRATION_SKIPPED', {
        ports: String(ports.join(',')), message: 'IndexedDB unavailable',
      });
      throw new Error('IndexedDB unavailable for legacy port migration');
    }
    const legacyPayloads = [];
    for (const port of ports) {
      const data = await readPortViaIframe(port);
      if (data && typeof data === 'object') legacyPayloads.push(data);
    }
    const written = await queueStoreWrite(async () => {
      const db = await getDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const read = objectStore.getAll();
        let settled = false;
        let keys = 0;
        const bail = (error) => {
          if (settled) return;
          settled = true;
          try { tx.abort(); } catch (ignored) {}
          recordStorageDiagnostic('XJ_LEGACY_PORT_MIGRATION_FAILED', {
            name: failureName(error), message: failureText(error),
          });
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        read.onsuccess = () => {
          if (settled) return;
          try {
            // 合并底 = 本次事务内读到的当前库真值，不是本窗口 hydrate 时的 cache。
            const merged = {};
            (read.result || []).forEach((row) => { merged[row.key] = row.value; });
            legacyPayloads.forEach((data) => mergeInto(merged, data));
            const all = Object.keys(merged);
            keys = all.length;
            all.forEach((k) => objectStore.put({ key: k, value: merged[k] }));
          } catch (e) { bail(e); }
        };
        read.onerror = () => bail(read.error || new Error('IndexedDB read failed for legacy port migration'));
        tx.oncomplete = () => { if (!settled) { settled = true; resolve(keys); } };
        tx.onabort = () => bail(tx.error || new Error('迁移事务被中止'));
        tx.onerror = () => bail(tx.error || new Error('迁移事务失败'));
      });
    });
    console.log('[migrate] 已合并旧端口数据到当前库，keys=', written);

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
  // 督导：优先以稳定归档键或记录 ID 区分独立生成，避免按内容误合并。
  function supervisionKey(sv) {
    if (!sv) return '';
    // A separate clinical generation is never a duplicate solely because its
    // date, material and synthesis happen to match another record.
    if (sv.mode === 'multi-school' && sv.archiveKey) return 'multi-school:' + sv.archiveKey;
    if (sv.id) return 'id:' + sv.id;
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

  // 对当前库已有重复做一次去重（应对旧端口已归档、迁移不再触发的现状）。
  // 与 import/督导归档/清理共用同一队列，并在一个 readwrite 事务中完成
  // 读取、备份、数据替换和完成标记，避免并发写覆盖或标记先于数据提交。
  async function maybeDedupe() {
    return queueStoreWrite(async () => {
      if (!_dbAvailable) return 0;
      const db = await getDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const objectStore = tx.objectStore(STORE);
        const read = objectStore.getAll();
        let result = 0;
        let failed = false;
        read.onsuccess = () => {
          try {
            const all = {};
            (read.result || []).forEach((row) => { all[row.key] = row.value; });
            const flag = all.__xj_dedup_v4;
            if (flag && flag.done) return;
            const ARRAY_KEYS = ['clients', 'sessions', 'supervisions', 'masterConversations', 'supervisorIdentities', 'expenses'];
            let removed = 0;
            const backup = {};
            for (const k of ARRAY_KEYS) {
              const v = all[k];
              if (!Array.isArray(v)) continue;
              const before = v.length;
              const after = dedupeArray(v, keyFor(k));
              if (after.length < before) { removed += before - after.length; backup[k] = v; all[k] = after; }
            }
            // 第二轮：会谈来源优先级去重（import > manual 次结）
            if (Array.isArray(all.sessions)) {
              const sourceResult = dedupSessionSource(all.sessions);
              if (sourceResult.removed > 0) {
                removed += sourceResult.removed;
                if (!backup.sessions) backup.sessions = all.sessions;
                all.sessions = sourceResult.sessions;
              }
            }
            // clients 内嵌 monthlyPayments 去重
            if (Array.isArray(all.clients)) {
              for (const c of all.clients) {
                const mp = c && c.billing && c.billing.monthlyPayments;
                if (Array.isArray(mp)) {
                  const before = mp.length;
                  const after = dedupeById(mp);
                  if (after.length < before) { removed += before - after.length; c.billing.monthlyPayments = after; }
                }
              }
            }
            // 不按“同日 + 零费用”物理删除，避免误伤临床会谈和合法免费咨询。
            if (removed > 0) {
              const backupKey = '__xj_dedup_backup_' + Date.now();
              objectStore.put({ key: backupKey, value: backup });
              for (const k of ARRAY_KEYS) {
                if (all[k] !== undefined) objectStore.put({ key: k, value: all[k] });
              }
            }
            result = removed;
            objectStore.put({ key: '__xj_dedup_v4', value: { done: true, at: Date.now(), removed } });
          } catch (error) {
            failed = true;
            try { tx.abort(); } catch (ignored) {}
            reject(error);
          }
        };
        read.onerror = () => { failed = true; reject(read.error); };
        tx.oncomplete = () => { if (!failed) resolve(result); };
        tx.onabort = () => { if (!failed) reject(tx.error || new Error('IndexedDB dedupe aborted')); };
        tx.onerror = () => { if (!failed) reject(tx.error || new Error('IndexedDB dedupe failed')); };
      });
    });
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
    // F4-4：_put/_del 不再直通 idbPut/idbDelete，改为经 commitKvWrite —— 与所有 durable
    // 写共享 queueStoreWrite 互斥、单事务提交、失败上抛并入诊断台账。
    // 契约：整值替换（memory 的滚动活动窗、consult-notes 的草稿快照都要这个语义）。
    // 需要读-改-写的调用方用 _mutate（事务内 RMW，跨窗口不丢写）。
    _get: idbGet, _put: (key, value) => commitKvWrite(key, value), _del: (key) => commitKvWrite(key, undefined),
    _mutate: mutateKv,
    // F4-5：旧端口合并纳入单写入者队列后，这里开一个只读出口给回归夹具用（页面不调用）。
    _migrateOldPorts: migrateOldPorts,
  };
})();

if (typeof window !== 'undefined') {
  window.Store = Store;
}
