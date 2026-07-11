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
    hydrated = true;
  }

  function isHydrated() {
    return hydrated;
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
      return ids.every((sid) => remainingSessionIds.includes(sid));
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
    return session;
  }
  async function createSession(data) {
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
    const activeClients = clients.filter((c) => c.status === 'active').length;
    const recentReports = sessions.filter((s) => s.hasSoap || s.hasDap || s.hasReflection).length;
    return {
      activeClients,
      supervisionCount: sups.length,
      recentReports,
      totalClients: clients.length,
      totalSessions: sessions.length,
    };
  }
  function getRecentSessions(limit = 5) {
    return cache.sessions
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, limit);
  }
  function getRecentReports(limit = 5) {
    const sessions = cache.sessions.filter((s) => s.hasSoap || s.hasDap || s.hasReflection);
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
        merged[k] = mergeById(cur, ov);
      } else if (typeof ov === 'object') {
        if (k === 'settings') {
          // 设置：当前为空（或缺失）时用旧的，否则保留当前（最新激活态优先）
          const curObj = merged[k];
          const curEmpty = !curObj || (typeof curObj === 'object' && !Array.isArray(curObj) && Object.keys(curObj).length === 0);
          if (curEmpty) merged[k] = ov;
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

    // 写回合并结果
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = Object.keys(merged);
      if (keys.length === 0) { resolve(); return; }
      let pending = keys.length;
      const dec = () => { if (--pending === 0) resolve(); };
      for (const k of keys) {
        const putReq = store.put({ key: k, value: merged[k] });
        putReq.onsuccess = dec;
        putReq.onerror = dec;
      }
      tx.onerror = () => reject(tx.error);
    });

    console.log('[migrate] 已合并旧端口数据到当前库，keys=', Object.keys(merged).length);

    // 通知主进程：关闭临时服务 + 归档旧库，然后刷新页面以重新 hydrate
    if (window.__XJ_API__ && window.__XJ_API__.notifyMigrateDone) {
      try { window.__XJ_API__.notifyMigrateDone(ports); } catch (e) {}
    }
    setTimeout(() => { location.reload(); }, 400);
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

  // 注册旧端口迁移监听：主进程经 __XJ_API__ 通知后，自动把历史数据合并进当前库
  if (typeof window !== 'undefined' && window.__XJ_API__ && window.__XJ_API__.onLegacyPorts) {
    window.__XJ_API__.onLegacyPorts((ports) => {
      if (ports && ports.length) {
        migrateOldPorts(ports).catch((e) => console.error('[migrate] 失败:', (e && e.message) || e));
      }
    });
  }
})();

if (typeof window !== 'undefined') {
  window.Store = Store;
}
