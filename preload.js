/**
 * preload.js — 心镜 XinJing 渲染进程桥
 * 职责：
 *  - 向页面注入授权状态 window.__XJ__
 *  - 非完整模式时注入顶部横幅 / 水印 / 禁用导出打印
 *  - 暴露 window.__XJ_API__.openActivation() 打开激活窗口
 *
 * 注意：contextIsolation:true 下，preload 运行在 isolated world，主 world 的
 * 渲染页通过 window.__XJ_API__ 访问桥。preload 内部一律用闭包常量 `api` 调用，
 * 不依赖 window 代理的 realm 差异，避免 "reading 'openActivation' of undefined"。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Electron sandboxed preload 不能加载项目相对模块；这里保留与
// pi-bridge-preload-v1.js 相同的白名单形状，避免为接线而关闭 sandbox。
const PI_PRELOAD_METHODS = Object.freeze([
  'startTask', 'contextCheck', 'plan', 'runToolStep', 'commitStep',
  'resolveApproval', 'pause', 'resume', 'cancel', 'diagnose', 'timeoutScan',
]);
const PI_PRELOAD_CHANNEL = 'xj-pi-v1:invoke';
const PI_CLINICAL_METHODS = Object.freeze([
  'begin', 'draftAppend', 'commitRecord', 'approve', 'reject', 'commitDurable',
  'verify', 'pause', 'resume', 'cancel', 'status',
]);
const PI_CLINICAL_CHANNEL = 'xj-pi-clinical-v1:invoke';
function createSandboxPiApi() {
  const api = { __xjPiBridgeVersion: 1 };
  PI_PRELOAD_METHODS.forEach((method) => {
    api[method] = (...args) => ipcRenderer.invoke(PI_PRELOAD_CHANNEL, { method, args });
  });
  const clinical = {};
  PI_CLINICAL_METHODS.forEach((method) => {
    clinical[method] = (...args) => ipcRenderer.invoke(PI_CLINICAL_CHANNEL, { method, args });
  });
  api.clinical = Object.freeze(clinical);
  return Object.freeze(api);
}

const piApi = createSandboxPiApi();
const piRendererTransport = Object.freeze({
  onRequest: (cb) => {
    if (typeof cb !== 'function') return null;
    const handler = (_event, request) => {
      if (!request || typeof request !== 'object') return;
      const requestId = String(request.requestId || '');
      const kind = String(request.kind || '');
      if (!/^pi_req_[A-Za-z0-9_-]{8,96}$/.test(requestId) || !/^[a-z-]{3,40}$/.test(kind)) return;
      try { cb({ requestId, kind, payload: request.payload }); } catch (_) {}
    };
    ipcRenderer.on('xj:pi:renderer-request', handler);
    return () => ipcRenderer.removeListener('xj:pi:renderer-request', handler);
  },
  reply: (requestId, response) => {
    const id = String(requestId || '');
    if (!/^pi_req_[A-Za-z0-9_-]{8,96}$/.test(id)) return false;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
    ipcRenderer.send('xj:pi:renderer-reply', { requestId: id, response });
    return true;
  },
  publishState: (state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    ipcRenderer.send('xj:pi:publish-state', state);
    return true;
  },
});

// 桥接 API 用闭包常量保存：preload 内部只通过 api.* 调用，
// 渲染页通过 contextBridge 暴露的 window.__XJ_API__ 访问。
const api = {
  openActivation: () => ipcRenderer.send('xj:openActivation'),
  getState: () => ipcRenderer.invoke('xj:getState'),
  getVersion: () => ipcRenderer.invoke('xj:getVersion'),
  supervisionSkill: Object.freeze({
    inspectPackage: (bytes, fileName) => ipcRenderer.invoke('xj:supervisionSkill:inspectPackage', { bytes, fileName }),
    installPackage: (bytes, inspectionToken, confirmed) => ipcRenderer.invoke('xj:supervisionSkill:installPackage', { bytes, inspectionToken, confirmed: confirmed === true }),
    listInstalled: () => ipcRenderer.invoke('xj:supervisionSkill:listInstalled'),
    getRuntimeDescriptor: (packageId, packageVersion) => ipcRenderer.invoke('xj:supervisionSkill:getRuntimeDescriptor', { packageId, packageVersion }),
    run: (packageId, packageVersion) => ipcRenderer.invoke('xj:supervisionSkill:run', { packageId, packageVersion }),
    removePackage: (packageId, packageVersion) => ipcRenderer.invoke('xj:supervisionSkill:removePackage', { packageId, packageVersion }),
  }),
  recipientGrant: Object.freeze({
    getProjection: (grantId) => ipcRenderer.invoke('xj:recipientGrant:getProjection', { grantId }),
    getAuditPage: (cursor, limit) => ipcRenderer.invoke('xj:recipientGrant:getAuditPage', { cursor, limit }),
  }),
  activate: (code) => ipcRenderer.invoke('xj:activate', code),
  cloudActivate: (code) => ipcRenderer.invoke('xj:cloud-activate', code),
  getMachineCode: () => ipcRenderer.invoke('xj:getMachineCode'),
  done: () => ipcRenderer.send('xj:activationDone'),
  saveBackupConfig: (cfg) => ipcRenderer.invoke('xj:saveBackupConfig', cfg),
  selectBackupFolder: () => ipcRenderer.invoke('xj:selectBackupFolder'),
  encryptBackup: (payload, passphrase) => ipcRenderer.invoke('xj:backup:encrypt', { payload, passphrase }),
  decryptBackup: (packageText, passphrase) => ipcRenderer.invoke('xj:backup:decrypt', { packageText, passphrase }),
  writeBackupSafetySnapshot: (payload, passphrase) => ipcRenderer.invoke('xj:backup:writeSafetySnapshot', { payload, passphrase }),
  commercial: Object.freeze({
    getSnapshot: (input) => ipcRenderer.invoke('xj:commercial:getSnapshot', input || {}),
    evaluateAccess: (input) => ipcRenderer.invoke('xj:commercial:evaluateAccess', input || {}),
    applySubscriptionEvent: (input) => ipcRenderer.invoke('xj:commercial:applySubscriptionEvent', input || {}),
    applyOrderEvent: (input) => ipcRenderer.invoke('xj:commercial:applyOrderEvent', input || {}),
    applyDeviceEvent: (input) => ipcRenderer.invoke('xj:commercial:applyDeviceEvent', input || {}),
    applyQuotaOperation: (input) => ipcRenderer.invoke('xj:commercial:applyQuotaOperation', input || {}),
    getAuditPage: (input) => ipcRenderer.invoke('xj:commercial:getAuditPage', input || {}),
    getServerModelCatalog: (input) => ipcRenderer.invoke('xj:commercial:getServerModelCatalog', input || {}),
    getModelPriceCatalog: (input) => ipcRenderer.invoke('xj:commercial:getModelPriceCatalog', input || {}),
    getAccountBalance: (input) => ipcRenderer.invoke('xj:commercial:getAccountBalance', input || {}),
    quoteRequestCharge: (input) => ipcRenderer.invoke('xj:commercial:quoteRequestCharge', input || {}),
    reserveRequestCharge: (input) => ipcRenderer.invoke('xj:commercial:reserveRequestCharge', input || {}),
    settleRequestCharge: (input) => ipcRenderer.invoke('xj:commercial:settleRequestCharge', input || {}),
    releaseRequestCharge: (input) => ipcRenderer.invoke('xj:commercial:releaseRequestCharge', input || {}),
    markRequestUnknown: (input) => ipcRenderer.invoke('xj:commercial:markRequestUnknown', input || {}),
    reconcileRequestCharge: (input) => ipcRenderer.invoke('xj:commercial:reconcileRequestCharge', input || {}),
  }),
  update: Object.freeze((() => {
    // v5.0 update-integrity typed bridge（Task 463 候选适配 contextBridge 版本）
    const VALID_STATES = new Set(['checking', 'available', 'awaiting-confirmation', 'downloading', 'verified', 'restarting', 'health-check', 'committed', 'failed', 'rollback-pending', 'rolling-back', 'rolled-back']);
    const statusListeners = [];
    function sanitizeStatus(data) {
      if (!data || typeof data !== 'object' || data.ok !== true) return null;
      if (!VALID_STATES.has(data.state)) return null;
      return {
        state: data.state,
        committed: data.committed === true || data.state === 'committed',
        version: typeof data.version === 'string' ? data.version.slice(0, 32) : null,
        channel: typeof data.channel === 'string' ? data.channel : null,
        strategy: typeof data.strategy === 'string' ? data.strategy : null,
        progress: Number.isFinite(data.progress) ? Math.max(0, Math.min(100, data.progress)) : null,
        errorCode: typeof data.errorCode === 'string' ? data.errorCode.slice(0, 80) : null,
        operationId: typeof data.operationId === 'string' ? data.operationId.slice(0, 80) : null
      };
    }
    ipcRenderer.on('xj:update:status', (event, data) => {
      const status = sanitizeStatus(data);
      if (!status) return;
      statusListeners.slice().forEach((cb) => { try { cb(status); } catch (_) {} });
    });
    return {
      check: (channel, strategy) => ipcRenderer.invoke('xj:update:check', { channel, strategy }),
      confirm: (operationId, decision) => ipcRenderer.invoke('xj:update:confirm', { operationId, decision }),
      snapshot: (operationId) => ipcRenderer.invoke('xj:update:snapshot', { operationId }),
      restore: (operationId) => ipcRenderer.invoke('xj:update:restore', { operationId }),
      subscribe: () => ipcRenderer.invoke('xj:update:subscribe', {}),
      onStatus: (cb) => {
        if (typeof cb !== 'function') return null;
        statusListeners.push(cb);
        return () => { const i = statusListeners.indexOf(cb); if (i >= 0) statusListeners.splice(i, 1); };
      },
      durableReady: () => true,
      // P0-4 fix: controlled durable snapshot/restore bridge. The page NEVER sees
      // the raw ipcRenderer; only the two allowlisted request/reply channels are
      // reachable, and only the renderer-owned Store.exportAll/importAll are touched.
      durable: (() => {
        const ALLOWED_REQUEST = new Set(['xj:update:snapshot:request', 'xj:update:restore:request']);
        const ALLOWED_REPLY = new Set(['xj:update:snapshot:reply', 'xj:update:restore:reply']);
        return Object.freeze({
          onRequest: (channel, cb) => {
            if (!ALLOWED_REQUEST.has(channel) || typeof cb !== 'function') return null;
            ipcRenderer.on(channel, (_event, request) => { try { cb(request); } catch (_) {} });
            return channel;
          },
          sendReply: (channel, payload) => {
            if (!ALLOWED_REPLY.has(channel)) return false;
            ipcRenderer.send(channel, payload);
            return true;
          }
        });
      })()
    };
  })()),
  onLicenseState: (cb) => { if (typeof cb === 'function') stateListeners.push(cb); },
  onLegacyPorts: (cb) => { if (typeof cb === 'function') legacyPortsListeners.push(cb); },
  notifyMigrateDone: (ports) => ipcRenderer.send('xj:migrate-done', ports),
  checkForUpdates: () => ipcRenderer.invoke('xj:check-updates'),
  encryptSecret: (plain) => ipcRenderer.invoke('xj:encryptSecret', plain),
  aiRequest: (payload) => ipcRenderer.invoke('xj:aiRequest', payload),
  cancelAiRequest: (requestId) => ipcRenderer.send('xj:aiCancel', requestId),
  onAiChunk: (cb) => {
    if (typeof cb !== 'function') return null;
    const handler = (_event, data) => {
      if (!data || typeof data !== 'object') return;
      const requestId = String(data.requestId || '');
      const chunk = typeof data.chunk === 'string' ? data.chunk : '';
      if (!/^[A-Za-z0-9_-]{12,80}$/.test(requestId) || !chunk) return;
      try { cb({ requestId, chunk }); } catch (e) {}
    };
    ipcRenderer.on('xj:ai-chunk', handler);
    return () => ipcRenderer.removeListener('xj:ai-chunk', handler);
  },
  selectUserDocFolder: () => ipcRenderer.invoke('xj:selectUserDocFolder'),
  getUserDocFolder: () => ipcRenderer.invoke('xj:getUserDocFolder'),
  readUserDocs: (opts) => ipcRenderer.invoke('xj:readUserDocs', opts),
  readUserDocMeta: () => ipcRenderer.invoke('xj:readUserDocMeta'),
  readUserDocFile: (relPath) => ipcRenderer.invoke('xj:readUserDocFile', { relPath }),
  searchUserDocs: (query, max) => ipcRenderer.invoke('xj:searchUserDocs', { query, max }),
  readKnowledgeMeta: () => ipcRenderer.invoke('xj:readKnowledgeMeta'),
  writeKnowledgeMeta: (entries) => ipcRenderer.invoke('xj:writeKnowledgeMeta', entries),
  ragIndexStatus: () => ipcRenderer.invoke('xj:ragIndexStatus'),
  ragIndex: () => ipcRenderer.invoke('xj:ragIndex'),
  ragCancel: () => ipcRenderer.invoke('xj:ragCancel'),
  ragSearch: (query, topK, tier) => ipcRenderer.invoke('xj:ragSearch', { query, topK, tier }),
  onRagProgress: (cb) => {
    if (typeof cb !== 'function') return null;
    const handler = (e, data) => { try { cb(data); } catch (err) {} };
    ipcRenderer.on('xj:ragProgress', handler);
    return () => ipcRenderer.removeListener('xj:ragProgress', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('xj:openExternal', url),
  saveFileAs: (opts) => ipcRenderer.invoke('xj:saveFileAs', opts),
  selectClinicalMaterialFile: () => ipcRenderer.invoke('xj:selectClinicalMaterialFile'),
  parseClinicalMaterialFile: (selectionId) => ipcRenderer.invoke('xj:parseClinicalMaterialFile', selectionId),
  // v5.0.2 桌面账号桥：渲染进程只见 sanitized 状态（authenticated/account/会员投影/错误码）；
  // session token 只存在于主进程与加密落盘，永不经桥暴露；验证码 token 仅在 verify 时由用户输入传入。
  account: Object.freeze({
    bootstrap: () => ipcRenderer.invoke('xj:account:bootstrap'),
    register: (email, password) => ipcRenderer.invoke('xj:account:register', { email, password }),
    resend: (email) => ipcRenderer.invoke('xj:account:resend', { email }),
    verify: (token) => ipcRenderer.invoke('xj:account:verify', { token }),
    forgotPassword: (email) => ipcRenderer.invoke('xj:account:forgotPassword', { email }),
    resetPassword: (payload) => ipcRenderer.invoke('xj:account:resetPassword', payload),
    login: (email, password) => ipcRenderer.invoke('xj:account:login', { email, password }),
    logout: () => ipcRenderer.invoke('xj:account:logout'),
    status: () => ipcRenderer.invoke('xj:account:status'),
    refreshMembership: () => ipcRenderer.invoke('xj:account:refreshMembership'),
    onChanged: (cb) => {
      if (typeof cb !== 'function') return null;
      const handler = (_event, data) => {
        if (!data || typeof data !== 'object') return;
        try { cb(data); } catch (e) { /* 页面回调异常不影响桥 */ }
      };
      ipcRenderer.on('xj:account:changed', handler);
      return () => ipcRenderer.removeListener('xj:account:changed', handler);
    },
  }),
  // 5.1.0 Pi 生产 transport：只暴露结构化请求/回执，不暴露 ipcRenderer。
  piTransport: piRendererTransport,
};
// 主进程 xj:license-state 广播的订阅者（preload 内部 + 渲染页经 onLicenseState 注册）
const stateListeners = [];
// 旧端口迁移订阅者（主进程 xj:legacy-ports 广播）
const legacyPortsListeners = [];

// 毫秒时间戳 → YYYY-MM-DD（0 视为终身）；与 main.js 的 fmtDate 对齐
function fmtDate(ms) {
  if (!ms) return '终身';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

try {
  contextBridge.exposeInMainWorld('__XJ_API__', api);
  console.log('[XJ] bridge __XJ_API__ exposed');
} catch (e) {
  console.error('[XJ] exposeInMainWorld __XJ_API__ FAILED:', (e && e.message) || e);
}

try {
  contextBridge.exposeInMainWorld('__PI__', piApi);
  console.log('[XJ] bridge __PI__ exposed');
} catch (e) {
  console.error('[XJ] exposeInMainWorld __PI__ FAILED:', (e && e.message) || e);
}

const stateRef = { mode: null, daysLeft: null, identity: null, tier: null, aiUnlocked: false, aiTrialActive: false, aiTrialDaysLeft: 0, aiTrialDays: 60, expired: false, expiresAt: 0 };
try {
  contextBridge.exposeInMainWorld('__XJ__', stateRef);
} catch (e) {
  console.error('[XJ] exposeInMainWorld __XJ__ FAILED:', (e && e.message) || e);
}

(function () {
  const isActivationPage = location.pathname.includes('activation.html');
  if (isActivationPage) return; // 激活页自行管理 UI
  const isAccountGatePage = location.pathname.includes('account.html');
  if (isAccountGatePage) return; // 账号页（强制登录门禁）自行管理 UI，不注入横幅/脚本


  window.addEventListener('DOMContentLoaded', async () => {
    let state = {};
    try {
      state = await api.getState() || {};
    } catch (e) {
      state = {};
    }
    Object.assign(stateRef, state); // 更新被桥接的引用，renderer 端实时可见
    if (state.mode === 'full') return;

    injectStyles();
    injectBanner(state);
  });

  // 独立的监听器：注入 Agent 浮窗资源（所有模式，已激活用户也能用）
  // 注意：必须独立，因为上面受限模式的回调对已激活用户会 early return。
  // 资源路径相对应用根目录（main.js 的 file:// 服务）。
  window.addEventListener('DOMContentLoaded', () => {
    try {
      // Agent CSS
      if (!document.querySelector('link[data-xj-agent]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'css/agent.css';
        link.setAttribute('data-xj-agent', '1');
        document.head.appendChild(link);
      }
      // Agent 工具集 + 纯核 + 浮窗壳（顺序：tools → core → shell，依赖关系）
      // v3.5.0：末尾追加 js/userdocs.js（用户资料缓存+检索共享模块，须在所有 build 函数调用前就绪）
      const scripts = ['js/agent-tools.js', 'js/agent-core.js', 'js/agent-shell.js', 'js/userdocs.js'];
      scripts.forEach((src) => {
        if (document.querySelector('script[data-xj-agent="' + src + '"]')) return;
        const s = document.createElement('script');
        s.src = src;
        s.setAttribute('data-xj-agent', src);
        s.defer = true;
        document.body.appendChild(s);
      });
    } catch (e) { /* ignore */ }
  });

  // 激活成功后由主进程广播最新授权状态：无需整页 reload 即可实时刷新解锁 UI
  ipcRenderer.on('xj:license-state', (e, s) => {
    try {
      if (s && typeof s === 'object') Object.assign(stateRef, s); // 渲染页读 window.__XJ__ 即时可见
      refreshInjectedUI(s);
      syncPageLocks(s);
      stateListeners.forEach((cb) => { try { cb(s); } catch (err) {} });
    } catch (err) { /* ignore */ }
  });

  // 旧端口数据迁移广播：转发给渲染进程注册的 onLegacyPorts 回调
  ipcRenderer.on('xj:legacy-ports', (e, ports) => {
    legacyPortsListeners.forEach((cb) => { try { cb(ports); } catch (err) {} });
  });

  // 直接在共享 DOM 上同步页面级锁（#ai-lock / #supervisor-lock-note）。
  // contextIsolation 隔离 JS realm，但 DOM 共享，故此处操作对渲染页可见。
  function syncPageLocks(state) {
    const unlocked = !!(state && state.aiUnlocked);
    const lock = document.getElementById('ai-lock');
    if (lock) lock.classList.toggle('hidden', unlocked);
    const supLock = document.getElementById('supervisor-lock-note');
    if (supLock) supLock.classList.toggle('hidden', unlocked);
  }
  function removeEl(id) {
    const el = document.getElementById(id);
    if (el && el.__xjResizeObserver) el.__xjResizeObserver.disconnect();
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function clearInjected() {
    ['xj-banner', 'xj-watermark', 'xj-notice', 'xj-lic-panel', 'xj-style'].forEach(removeEl);
    document.body.style.paddingTop = '';
    document.documentElement.style.removeProperty('--xj-top-offset');
  }
  // 依据新状态重建限制 UI。导出和基础打印由各页面明确的 feature 命令决定，preload 不做文字猜测拦截。
  function refreshInjectedUI(state) {
    if (!state || typeof state !== 'object') return;
    clearInjected();
    if (state.mode === 'full') return;
    injectStyles();
    injectBanner(state);
  }

  function injectStyles() {
    const css = `
    #xj-banner{position:sticky;top:0;z-index:2147483646;
      display:flex;align-items:center;gap:12px;padding:10px 16px;
      font:600 13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
      color:#fff;background:linear-gradient(90deg,#9c5a3c,#b06a47);
      box-shadow:0 2px 10px rgba(0,0,0,.25);}
    #xj-banner.limited{background:linear-gradient(90deg,#a33327,#c0463a);}
    #xj-banner .xj-txt{flex:1;}
    #xj-banner button{background:#fff;color:#9c5a3c;border:0;border-radius:999px;
      padding:6px 16px;font-weight:700;cursor:pointer;}
    #xj-banner.limited button{color:#a33327;}
    #xj-notice{margin:0 0 14px;padding:12px 16px;border-radius:12px;
      background:#fbf1e6;color:#9c5a3c;border:1px solid #e7c9b0;
      font:600 13px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}
    #xj-lic-panel{margin:0 0 18px;padding:16px 18px;border-radius:14px;
      background:#fff;border:1px solid #e7c9b0;box-shadow:0 2px 10px rgba(156,90,60,.08);}
    #xj-lic-title{font:700 15px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;color:#9c5a3c;margin-bottom:6px;}
    #xj-lic-row{font:500 13px/1.55 "PingFang SC","Microsoft YaHei",sans-serif;color:#5b4636;margin-bottom:4px;}
    #xj-lic-panel button{margin-top:10px;background:#9c5a3c;color:#fff;border:0;border-radius:999px;
      padding:7px 18px;font-weight:700;cursor:pointer;}
    `;
    const tag = document.createElement('style');
    tag.id = 'xj-style';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function injectBanner(state) {
    const bar = document.createElement('div');
    bar.id = 'xj-banner';
    if (state.mode === 'limited') bar.classList.add('limited');
    let txt;
    if (state.expired) {
      txt = '激活码已过期：完整功能已锁定（含 AI 助手），请向开发者索取续费激活码 · 输入激活码解锁';
    } else if (state.mode === 'limited') {
      txt = '免费版：手工执业工作流可继续使用；AI 临床能力、无水印导出与高级检索需升级会员';
    } else if (state.aiTrialActive) {
      txt = `未激活 · AI 助手 / AI 督导 限时免费试用剩余 ${state.aiTrialDaysLeft} 天 · 现在激活可叠加剩余免费天数并长期解锁`;
    } else {
      txt = `免费版 · 剩余 ${state.daysLeft} 天 · AI 免费试用已结束，AI 助手 / 督导需激活后解锁`;
    }
    bar.innerHTML = `<span class="xj-txt">${txt}</span>`;
    const btn = document.createElement('button');
    btn.textContent = '激活';
    btn.onclick = () => api.openActivation(); // 用闭包变量，规避 window 引用差异
    bar.appendChild(btn);
    // Keep this global status visible without taking it out of document flow.
    // A sticky first child cannot cover the sidebar or the current page header.
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // 设置页：注入授权状态面板（试用 / 受限均显示，完整模式不显示）
  function injectSettingsPanel(state) {
    const p = location.pathname;
    if (!p.includes('settings')) return;
    const tierLabel = (function (t) {
      if (t === 'pro') return '标准版 (Pro)';
      if (t === 'custom') return '定制旗舰版 (Custom)';
      if (t === 'full') return '完整版（旧激活码）';
      return '';
    })(state.tier);
    let title, detail;
    if (state.expired) {
      title = '激活码已过期';
      detail = '完整功能（含 AI 助手）已锁定。请向开发者索取续费激活码后重新激活。';
    } else if (state.mode === 'limited') {
      title = '免费版';
      detail = '手工执业工作流可继续使用；AI 临床能力、无水印导出与高级资料检索需升级会员。';
    } else if (state.aiTrialActive) {
      title = `未激活 · AI 免费试用中（剩余 ${state.aiTrialDaysLeft} 天）`;
      detail = `安装后 ${state.aiTrialDays} 天内 AI 助手 / AI 督导免费无限制使用。现在激活可把剩余 ${state.aiTrialDaysLeft} 天叠加到激活码有效期，并长期解锁全部功能。`;
    } else {
      title = `试用版（剩余 ${state.daysLeft} 天）`;
      detail = '免费版：基础个案管理可用，AI 免费试用已结束，AI 助手 / 督导需激活后解锁。';
    }
    const expText = (state.expiresAt && state.expiresAt !== 0)
      ? '有效期至 ' + fmtDate(state.expiresAt)
      : (state.expiresAt === 0 && state.identity ? '终身有效' : '');
    const who = state.identity ? `授权给：${state.identity}${tierLabel ? ' · ' + tierLabel : ''}` : '尚未激活';
    let rows = `<div class="xj-lic-row">${who}</div>` + `<div class="xj-lic-row">${detail}</div>`;
    if (expText) rows += `<div class="xj-lic-row">${expText}</div>`;
    const box = document.createElement('div');
    box.id = 'xj-lic-panel';
    box.innerHTML =
      `<div class="xj-lic-title">${title}</div>` +
      rows +
      `<button id="xj-lic-activate">输入激活码</button>`;
    mountInto(box);
    const btn = box.querySelector('#xj-lic-activate');
    if (btn) btn.onclick = () => api.openActivation(); // 用闭包变量
  }

  function mountInto(el) {
    const host = document.querySelector('.content') || document.body;
    host.insertBefore(el, host.firstChild);
  }
})();
