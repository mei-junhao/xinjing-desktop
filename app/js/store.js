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
    settings: { apiConfig: {}, version: '1.0.0' },
  };
  let hydrated = false;
  let _dbPromise = null;
  let _dbAvailable = true;

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

  async function idbPut(key, value) {
    if (!_dbAvailable) {
      try {
        localStorage.setItem('xj2_' + key, JSON.stringify(value));
      } catch (e) {
        console.warn('[Store] localStorage 持久化失败（可能容量超限）', e);
      }
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
      return idbPut(key, value); // 重试走降级
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
    const [clients, sessions, supervisions, supervisorIdentities, masterConversations, settings] = await Promise.all([
      idbGet('clients'),
      idbGet('sessions'),
      idbGet('supervisions'),
      idbGet('supervisorIdentities'),
      idbGet('masterConversations'),
      idbGet('settings'),
    ]);
    cache.clients = Array.isArray(clients) ? clients : [];
    cache.sessions = Array.isArray(sessions) ? sessions : [];
    cache.supervisions = Array.isArray(supervisions) ? supervisions : [];
    cache.supervisorIdentities = Array.isArray(supervisorIdentities) ? supervisorIdentities : [];
    cache.masterConversations = Array.isArray(masterConversations) ? masterConversations : [];
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

  // 计算会话是否含有各类报告（用于工作台/报告中心标记）
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

  // ============================================================
  // 授权限制闸门（仅 Electron 桌面「受限模式」生效；web/演示版无 window.__XJ__ 自动放行）
  // 受限模式：来访者最多 5 个、督导记录最多 50 条；超出部分仅可读（新建/编辑/删除均拦截）
  // ============================================================
  const LICENSE_CAP_CLIENT = 5;
  const LICENSE_CAP_SUPERVISION = 50;

  function licenseMode() {
    try {
      if (typeof window !== 'undefined' && window.App && typeof window.App.getLicenseState === 'function') {
        const state = window.App.getLicenseState();
        if (state && state.mode === 'limited') return 'limited';
        return 'free';
      }
      if (typeof window !== 'undefined' && window.__XJ__ && window.__XJ__.mode === 'limited') {
        return 'limited';
      }
    } catch (e) {}
    return 'free'; // full / trial / web 版
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

  function licenseRank(arr, id) {
    const sorted = arr.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    return sorted.findIndex((x) => x.id === id);
  }

  function licenseGuard(kind, id) {
    if (licenseMode() !== 'limited') return; // 完整/试用/web 版一律放行
    const isClient = kind === 'client';
    const cap = isClient ? LICENSE_CAP_CLIENT : LICENSE_CAP_SUPERVISION;
    const label = isClient ? '来访者' : '督导记录';
    if (id == null) {
      // 新建：达到上限即拦截
      const arr = isClient ? cache.clients : cache.supervisions;
      if (arr.length >= cap) {
        throw new Error(`试用期已结束，受限模式下最多保存 ${cap} 个${label}。请输入激活码解锁完整功能。`);
      }
    } else {
      // 编辑/删除：仅前 N 个（按创建时间排序）可管理，其余只读
      const arr = isClient ? cache.clients : cache.supervisions;
      const rank = licenseRank(arr, id);
      if (rank === -1) return; // 找不到（理论上不发生），交由后续逻辑处理
      if (rank >= cap) {
        throw new Error(`试用期已结束，受限模式下仅可管理前 ${cap} 个${label}（其余为只读）。请输入激活码解锁完整功能。`);
      }
    }
  }

  // ============================================================
  // 来访者 (Client)
  // ============================================================
  function getClients() {
    return cache.clients;
  }
  function getClient(id) {
    return cache.clients.find((c) => c.id === id) || null;
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
  function updateClient(id, patch) {
    licenseGuard('client', id);
    const client = getClient(id);
    if (!client) return null;
    Object.assign(client, patch, { updatedAt: nowISO() });
    return saveClient(client);
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
    return true;
  }

  // ============================================================
  // 会话 (Session) —— 完整内容直接存入 IndexedDB（不再分离大字段）
  // ============================================================
  function getSessions() {
    return cache.sessions;
  }
  function getSession(id) {
    return cache.sessions.find((s) => s.id === id) || null;
  }
  function getSessionsByClient(clientId) {
    return cache.sessions
      .filter((s) => s.clientId === clientId)
      .sort((a, b) => (a.sessionNumber || 0) - (b.sessionNumber || 0));
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
  async function createSession(data) {
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
    return saveSession(session);
  }
  function deleteSession(id) {
    cache.sessions = cache.sessions.filter((s) => s.id !== id);
    persist('sessions');
    cache.supervisions = cache.supervisions.map((sv) => ({
      ...sv,
      sessionIds: (sv.sessionIds || []).filter((sid) => sid !== id),
    }));
    persist('supervisions');
    return true;
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
  function updateSupervision(id, patch) {
    licenseGuard('supervision', id);
    const sv = getSupervision(id);
    if (!sv) return null;
    Object.assign(sv, patch, { updatedAt: nowISO() });
    return saveSupervision(sv);
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
  function saveAiSupervision(data) {
    try {
      const sv = Object.assign(
        {
          id: genId('sv'),
          type: 'ai',
          supervisorName: data.supervisorName || 'AI 督导',
          clientId: data.clientId || '',
          date: (data.date || nowISO().slice(0, 10)),
          sessionIds: data.sessionId ? [data.sessionId] : [],
          content: data.context || '',
          conclusion: data.content || '',
          createdAt: nowISO(),
          updatedAt: nowISO(),
        },
        {}
      );
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
    conv.updatedAt = nowISO();
    const idx = cache.masterConversations.findIndex((c) => c.id === conv.id);
    if (idx >= 0) cache.masterConversations[idx] = conv;
    else cache.masterConversations.unshift(conv);
    persist('masterConversations');
    return conv;
  }
  function deleteMasterConversation(id) {
    cache.masterConversations = cache.masterConversations.filter((c) => c.id !== id);
    persist('masterConversations');
    return true;
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

  // ============================================================
  // 统计
  // ============================================================
  function getStats() {
    const clients = cache.clients;
    const sessions = cache.sessions;
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
      if (!activeIds.has(s.clientId)) continue;
      if (!s.date || s.date.slice(0, 7) !== ym) continue;
      const fee = (s.billing && Number(s.billing.fee)) || 0;
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
    return cache.sessions
      .slice()
      .filter((s) => cache.clients.some((c) => c.id === s.clientId)) // 过滤孤儿 session（来访者已被删除但 session 残留）
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, limit);
  }
  function getRecentReports(limit = 5) {
    const sessions = cache.sessions
      .filter((s) => s.hasSoap || s.hasDap || s.hasReflection)
      .filter((s) => cache.clients.some((c) => c.id === s.clientId)); // 过滤孤儿 session
    sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return sessions.slice(0, limit);
  }

  // ============================================================
  // 备份 / 恢复（导出为单个 JSON 文件，内容已含完整正文）
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
        settings: cache.settings,
      },
      null,
      2
    );
  }
  async function importAll(jsonStr) {
    const data = JSON.parse(jsonStr);
    if (Array.isArray(data.clients)) cache.clients = data.clients;
    if (Array.isArray(data.sessions)) cache.sessions = data.sessions;
    if (Array.isArray(data.supervisions)) cache.supervisions = data.supervisions;
    if (Array.isArray(data.supervisorIdentities)) cache.supervisorIdentities = data.supervisorIdentities;
    if (data.settings) cache.settings = Object.assign({ apiConfig: {}, version: '1.0.0' }, data.settings);
    persist('clients');
    persist('sessions');
    persist('supervisions');
    persist('settings');
    return true;
  }

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
      let done = false, timer = null;
      const finish = (val) => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { window.removeEventListener('message', onMsg); } catch (e) {}
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve(val);
      };
      const onMsg = (e) => {
        if (e.data && e.data.__xj_migrate) finish(e.data.error ? null : (e.data.data || null));
      };
      window.addEventListener('message', onMsg);
      timer = setTimeout(() => finish(null), 8000); // 单端口超时保护
      iframe.src = 'http://127.0.0.1:' + port + '/migrate-helper.html';
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
  // 会谈：clientId + 日期 + 费用/已付/来源 + 正文内容 + 唯一字段（sessionNumber 或 id）
  // 含唯一字段可区分「同日多个空 session」（内容都空），避免互相误判为重复被删（S4 修复）
  function sessionKey(s) {
    if (!s) return '';
    const b = s.billing || {};
    const soap = s.soap || {};
    const content = [s.transcript || '', soap.subjective || '', soap.objective || '', soap.assessment || '', soap.plan || '', s.summary || '', s.reflection || ''].join('');
    const unique = (s.sessionNumber != null ? 'n' + s.sessionNumber : '') + (s.id != null ? '#' + s.id : '');
    return [s.clientId || '', s.date || '', b.fee != null ? b.fee : '', b.paid ? 1 : 0, b.source || '', unique, content].join('|');
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
  // 对当前库已有重复做一次去重（应对旧端口已归档、迁移不再触发的现状）
  async function maybeDedupe() {
    const flag = await idbGet('__xj_dedup_v2');
    if (flag && flag.done) return 0; // 已处理过，防重
    const all = await readAllKv();
    const ARRAY_KEYS = ['clients', 'sessions', 'supervisions', 'masterConversations', 'supervisorIdentities'];
    let removed = 0;
    const backup = {};
    for (const k of ARRAY_KEYS) {
      const v = all[k];
      if (!Array.isArray(v)) continue;
      const before = v.length;
      const after = dedupeArray(v, keyFor(k));
      if (after.length < before) { removed += before - after; backup[k] = v; all[k] = after; }
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
    if (removed === 0) {
      await idbPut('__xj_dedup_v2', { done: true, at: Date.now(), removed: 0 });
      return 0;
    }
    // 备份原始重复数据，极端情况可经开发者工具恢复
    try { await idbPut('__xj_dedup_backup_' + Date.now(), backup); } catch (e) {}
    for (const k of ARRAY_KEYS) {
      if (all[k] !== undefined) await idbPut(k, all[k]);
    }
    await idbPut('__xj_dedup_v2', { done: true, at: Date.now(), removed });
    return removed;
  }

  // ============================================================
  // 公开接口
  // ============================================================
  return {
    hydrate,
    isHydrated,
    // 来访者
    getClients, getClient, createClient, updateClient, deleteClient,
    // 会话
    getSessions, getSession, getSessionsByClient,
    getSessionFull, createSession, updateSessionFull, deleteSession,
    nextSessionNumber,
    // 督导
    getSupervisions, getSupervision, createSupervision, updateSupervision, deleteSupervision,
    getSupervisionsByClient, buildSupervisionGrowthContext, saveAiSupervision,
    // 大师对话
    getMasterConversations, getMasterConversation, saveMasterConversation, deleteMasterConversation,
    // 督导师身份（AI 督导，付费）
    getSupervisorIdentities, getSupervisorIdentity,
    createSupervisorIdentity, updateSupervisorIdentity, deleteSupervisorIdentity,
    // 设置
    getSettings, saveSettings,
    // 统计
    getStats, getRecentSessions, getRecentReports,
    // 备份
    exportAll, importAll,
    // 诊断
    storageInfo,
    // 授权闸门
    licenseMode, aiUnlocked,
  };
})();

if (typeof window !== 'undefined') {
  window.Store = Store;
}
