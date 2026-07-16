/**
 * tauri-bridge.js — 心镜 XinJing 渲染进程桥（Tauri v2 版）
 *
 * 作为 Electron preload.js 的 Tauri 版替代品，以 <script> 标签加载（无打包工具）。
 * 职责：
 *  - 暴露与原 preload.js 完全一致的 window.__XJ_API__，底层用 Tauri v2 invoke 调用 Rust commands
 *  - 用 @tauri-apps/api/event 的 listen 替代 ipcRenderer.on 订阅事件
 *  - 向页面注入授权状态 window.__XJ__
 *  - 非完整模式时注入顶部横幅 / 水印 / 禁用导出打印
 *  - 注入 Agent 浮窗资源（css/agent.css, js/agent-tools.js, js/agent-core.js, js/agent-shell.js, js/userdocs.js）
 *
 * Tauri API 获取策略：
 *  - 优先使用 Tauri 注入的 window.__TAURI__（需 tauri.conf.json 中 withGlobalTauri: true）
 *  - 回退动态 import('@tauri-apps/api/core') / event（需模块可被 WebView 解析，通常需打包工具）
 *
 * 注意：内部一律用闭包常量 `api` 调用，不依赖 window 代理的 realm 差异，
 * 规避 "reading 'openActivation' of undefined" 之类问题。
 */
(function () {
  'use strict';

  // ===========================================================================
  // Tauri API 获取（优先 window.__TAURI__，回退动态 import）
  // ===========================================================================
  let _invoke = null;
  let _listen = null;
  let _tauriLoading = null;

  function loadTauri() {
    if (_tauriLoading) return _tauriLoading;
    _tauriLoading = (async () => {
      // 方式 2：全局 __TAURI__（withGlobalTauri: true 时由 Tauri 注入，无需打包工具）
      const g = window.__TAURI__;
      if (g && g.core && typeof g.core.invoke === 'function') {
        _invoke = g.core.invoke;
        _listen = (g.event && typeof g.event.listen === 'function') ? g.event.listen : null;
        return;
      }
      // 方式 1：动态 import ES Module（需模块可被 WebView 解析，通常需打包工具）
      try {
        const core = await import('@tauri-apps/api/core');
        const evt = await import('@tauri-apps/api/event');
        _invoke = core.invoke;
        _listen = evt.listen;
      } catch (e) {
        // 都不可用：保持 null，invoke/listen 将优雅失败
        console.error('[XJ] Tauri API 不可用，invoke 调用将被拒绝:', (e && e.message) || e);
      }
    })();
    return _tauriLoading;
  }

  // invoke 包装：未就绪时等待加载；仍不可用则 reject
  function invoke(cmd, args) {
    if (_invoke) return _invoke(cmd, args);
    return loadTauri().then(() => {
      if (_invoke) return _invoke(cmd, args);
      return Promise.reject(new Error('Tauri API not available: ' + cmd));
    });
  }

  // listen 包装：返回 Promise<UnlistenFn>；不可用时返回空 unlisten
  function listen(eventName, cb) {
    if (_listen) return _listen(eventName, cb);
    return loadTauri().then(() => {
      if (_listen) return _listen(eventName, cb);
      return () => {}; // 空 unlisten
    });
  }

  // 启动时即预热 Tauri API
  loadTauri();

  // ===========================================================================
  // 版本号
  // ===========================================================================
  // 构建期注入的真实版本（原 Electron 由 version.generated.js 提供）。
  // Tauri 版优先读 HTML 注入的 window.__XJ_VERSION__（构建期可通过环境变量注入），
  // 否则回退到 package.json 版本。后续可改由 Rust command 暴露。
  let BUILD_VERSION = '1.0.0';
  try {
    if (typeof window.__XJ_VERSION__ === 'string' && window.__XJ_VERSION__) {
      BUILD_VERSION = window.__XJ_VERSION__;
    }
  } catch (e) { /* ignore */ }

  // ===========================================================================
  // 监听器列表
  // ===========================================================================
  // Rust 端 license-state 广播的订阅者（bridge 内部 + 渲染页经 onLicenseState 注册）
  const stateListeners = [];
  // 旧端口迁移广播的订阅者
  const legacyPortsListeners = [];

  // ===========================================================================
  // 工具函数
  // ===========================================================================
  // 毫秒时间戳 → YYYY-MM-DD（0 视为终身）；与 license.rs / 原 main.js 的 fmtDate 对齐
  function fmtDate(ms) {
    if (!ms) return '终身';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // Rust 端 LicenseState 序列化为 snake_case（days_left / ai_trial_active / expires_at …），
  // 而原前端 / UI 注入逻辑使用 camelCase（daysLeft / aiTrialActive / expiresAt …）。
  // 此函数将任意对象的 snake_case 键转为 camelCase；camelCase / 无下划线键原样保留。
  function toCamelKey(k) {
    return k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  }
  function normalizeState(s) {
    if (!s || typeof s !== 'object') return s;
    const out = {};
    for (const k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k)) out[toCamelKey(k)] = s[k];
    }
    return out;
  }

  // ===========================================================================
  // 桥接 API（与原 preload.js 的 window.__XJ_API__ 接口一致）
  // ===========================================================================
  // appProxyKey：原 Electron 同步 require('./secret.generated')。Tauri 版无法 require，
  // 改为异步从 Rust command get_app_proxy_key 预热缓存，同步返回缓存值。
  // 短期 Rust 端未实现该 command 时返回空字符串，后续完善。
  let cachedAppProxyKey = '';
  async function primeAppProxyKey() {
    try {
      const v = await invoke('get_app_proxy_key');
      if (typeof v === 'string') cachedAppProxyKey = v;
    } catch (e) { /* command 未实现时静默 */ }
  }

  const api = {
    openActivation: () => invoke('open_activation'),
    getState: () => invoke('get_state'),
    getVersion: () => BUILD_VERSION,
    activate: (code) => invoke('activate', { code }),
    cloudActivate: (code) => invoke('cloud_activate', { code }),
    getMachineCode: () => invoke('get_machine_code'),
    done: () => invoke('activation_done'),
    saveBackupConfig: (cfg) => invoke('save_backup_config', { cfg }),
    selectBackupFolder: () => invoke('select_backup_folder'),
    onLicenseState: (cb) => { if (typeof cb === 'function') stateListeners.push(cb); },
    onLegacyPorts: (cb) => { if (typeof cb === 'function') legacyPortsListeners.push(cb); },
    notifyMigrateDone: (ports) => invoke('notify_migrate_done', { ports }),
    checkForUpdates: () => invoke('check_for_updates'),
    encryptSecret: (plain) => invoke('encrypt_secret', { plain }),
    decryptSecret: (stored) => invoke('decrypt_secret', { stored }),
    appProxyKey: () => cachedAppProxyKey,
    selectUserDocFolder: () => invoke('select_user_doc_folder'),
    getUserDocFolder: () => invoke('get_user_doc_folder'),
    readUserDocs: (opts) => invoke('read_user_docs', { opts }),
    readUserDocMeta: () => invoke('read_user_doc_meta'),
    readUserDocFile: (relPath) => invoke('read_user_doc_file', { relPath }),
    searchUserDocs: (query, max) => invoke('search_user_docs', { query, max }),
    openExternal: (url) => invoke('open_external', { url }),
    // 关闭确认窗口动作（confirm-close.html 使用）
    closeDecision: (action) => invoke('close_decision', { action }),
    // RAG 相关
    ragBuildIndex: (entries) => invoke('rag_build_index', { entries }),
    ragSearch: (query, topK, tier) => invoke('rag_search', { query, topK, tier }),
    ragStatus: () => invoke('rag_status'),
    ragCancel: () => invoke('rag_cancel'),
  };

  // ===========================================================================
  // 状态引用（渲染页通过 window.__XJ__ 实时读取）
  // ===========================================================================
  const stateRef = {
    mode: null, daysLeft: null, identity: null, tier: null,
    aiUnlocked: false, aiTrialActive: false, aiTrialDaysLeft: 0, aiTrialDays: 60,
    expired: false, expiresAt: 0,
  };

  // 暴露到 window
  window.__XJ_API__ = api;
  window.__XJ__ = stateRef;
  console.log('[XJ] bridge __XJ_API__ exposed (tauri)');

  // 预热 appProxyKey（best-effort，异步）
  primeAppProxyKey();

  // ===========================================================================
  // UI 注入（受限模式横幅 / 水印 / 导出打印锁 / 设置页授权面板 / Agent 资源 / 事件监听）
  // ===========================================================================
  (function () {
    const isActivationPage = location.pathname.includes('activation.html');
    if (isActivationPage) return; // 激活页自行管理 UI

    // 受限模式导出/打印锁的句柄，便于激活为完整模式后撤销
    let lockClickHandler = null, origPrint = null;

    window.addEventListener('DOMContentLoaded', async () => {
      let raw = {};
      try {
        raw = await api.getState() || {};
      } catch (e) {
        raw = {};
      }
      const state = normalizeState(raw); // snake_case → camelCase
      Object.assign(stateRef, state); // 更新被桥接的引用，renderer 端实时可见
      if (state.mode === 'full') return;

      injectStyles();
      if (state.mode === 'limited') injectWatermark();
      injectBanner(state);
      if (state.mode === 'limited') {
        injectPageNotice();
        lockExportPrint();
      }
      if (state.mode !== 'full') injectSettingsPanel(state);
    });

    // 独立的监听器：注入 Agent 浮窗资源（所有模式，已激活用户也能用）
    // 注意：必须独立，因为上面受限模式的回调对已激活用户会 early return。
    // 资源路径相对应用根目录（Tauri frontendDist 指向 app/）。
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

    // 激活成功后由 Rust 端广播最新授权状态（事件名 license-state）：无需整页 reload 即可实时刷新解锁 UI。
    // Tauri 的 listen 是异步的（返回 Promise<UnlistenFn>），此处包装成与 ipcRenderer.on 等效的回调订阅。
    let unlistenLicenseState = null;
    async function setupLicenseStateListener() {
      if (unlistenLicenseState) return;
      unlistenLicenseState = await listen('license-state', (event) => {
        try {
          const s = normalizeState(event.payload); // snake_case → camelCase
          if (s && typeof s === 'object') Object.assign(stateRef, s); // 渲染页读 window.__XJ__ 即时可见
          refreshInjectedUI(s);
          syncPageLocks(s);
          stateListeners.forEach((cb) => { try { cb(s); } catch (err) {} });
        } catch (err) { /* ignore */ }
      });
    }

    // 旧端口数据迁移广播（事件名 legacy-ports）：转发给渲染进程注册的 onLegacyPorts 回调
    let unlistenLegacyPorts = null;
    async function setupLegacyPortsListener() {
      if (unlistenLegacyPorts) return;
      unlistenLegacyPorts = await listen('legacy-ports', (event) => {
        const ports = event.payload;
        legacyPortsListeners.forEach((cb) => { try { cb(ports); } catch (err) {} });
      });
    }

    // 启动事件监听（fire-and-forget）
    setupLicenseStateListener();
    setupLegacyPortsListener();

    // 直接在共享 DOM 上同步页面级锁（#ai-lock / #supervisor-lock-note）。
    function syncPageLocks(state) {
      const unlocked = !!(state && state.aiUnlocked);
      const lock = document.getElementById('ai-lock');
      if (lock) lock.classList.toggle('hidden', unlocked);
      const supLock = document.getElementById('supervisor-lock-note');
      if (supLock) supLock.classList.toggle('hidden', unlocked);
    }
    function removeEl(id) { const el = document.getElementById(id); if (el && el.parentNode) el.parentNode.removeChild(el); }
    function clearInjected() {
      ['xj-banner', 'xj-watermark', 'xj-notice', 'xj-lic-panel', 'xj-style'].forEach(removeEl);
    }
    function removeLockIfFull() {
      if (lockClickHandler) { document.removeEventListener('click', lockClickHandler, true); lockClickHandler = null; }
      if (origPrint) { window.print = origPrint; origPrint = null; }
    }
    // 依据新状态重建限制 UI：完整模式→全部移除并撤销导出/打印锁；否则按模式重新注入
    function refreshInjectedUI(state) {
      if (!state || typeof state !== 'object') return;
      clearInjected();
      removeLockIfFull();
      if (state.mode === 'full') return;
      injectStyles();
      if (state.mode === 'limited') injectWatermark();
      injectBanner(state);
      if (state.mode === 'limited') { injectPageNotice(); lockExportPrint(); }
      if (state.mode !== 'full') injectSettingsPanel(state);
    }

    function injectStyles() {
      const css = `
      #xj-banner{position:fixed;top:0;left:0;right:0;z-index:2147483646;
        display:flex;align-items:center;gap:12px;padding:10px 16px;
        font:600 13px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
        color:#fff;background:linear-gradient(90deg,#9c5a3c,#b06a47);
        box-shadow:0 2px 10px rgba(0,0,0,.25);}
      #xj-banner.limited{background:linear-gradient(90deg,#a33327,#c0463a);}
      #xj-banner .xj-txt{flex:1;}
      #xj-banner button{background:#fff;color:#9c5a3c;border:0;border-radius:999px;
        padding:6px 16px;font-weight:700;cursor:pointer;}
      #xj-banner.limited button{color:#a33327;}
      #xj-watermark{position:fixed;inset:0;z-index:2147483645;pointer-events:none;
        opacity:.07;background-image:repeating-linear-gradient(-30deg,
          transparent 0 120px, rgba(156,90,60,.9) 120px 360px);
        background-size:auto;}
      #xj-watermark::after{content:"心镜 XinJing · 未激活";position:absolute;inset:0;
        display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:40px;
        transform:rotate(-18deg);font:800 38px/1.1 "PingFang SC","Microsoft YaHei",sans-serif;
        color:rgba(156,90,60,.9);letter-spacing:6px;white-space:pre;}
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
        txt = '受限模式：仅可管理前 5 位来访者与 50 条督导记录（其余只读），禁止导出/打印，AI 助手锁定 · 输入激活码解锁';
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
      document.body.appendChild(bar);
      // 给内容留顶边距，避免被横幅遮挡
      document.body.style.paddingTop = '42px';
    }

    function injectWatermark() {
      const wm = document.createElement('div');
      wm.id = 'xj-watermark';
      document.body.appendChild(wm);
    }

    function lockExportPrint() {
      if (lockClickHandler) return; // 已加锁，避免重复绑定
      const isBlocked = (el) => {
        if (!el) return false;
        const t = (el.textContent || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
        return /导出|打印|export|print/i.test(t);
      };
      lockClickHandler = (e) => {
        let el = e.target;
        while (el && el !== document.body) {
          if (isBlocked(el)) {
            e.preventDefault();
            e.stopPropagation();
            alert('当前为受限模式，激活后可导出/打印。');
            return;
          }
          el = el.parentElement;
        }
      };
      document.addEventListener('click', lockClickHandler, true);
      origPrint = window.print;
      window.print = function () {
        alert('当前为受限模式，激活后可打印。');
      };
    }

    // 受限模式：在来访者 / 督导页面注入醒目的上限提示条
    function injectPageNotice() {
      const p = location.pathname;
      let msg = '';
      if (p.includes('clients')) {
        msg = '受限模式提醒：试用期已结束，仅可管理前 5 位来访者，超出部分只读（不可编辑或删除）。输入激活码解锁无限制。';
      } else if (p.includes('supervision')) {
        msg = '受限模式提醒：试用期已结束，仅可管理前 50 条督导记录，超出部分只读。输入激活码解锁无限制。';
      }
      if (!msg) return;
      const box = document.createElement('div');
      box.id = 'xj-notice';
      box.textContent = msg;
      mountInto(box);
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
        title = '受限模式（未激活）';
        detail = '仅可管理前 5 位来访者与 50 条督导记录（超出只读），禁止导出/打印，AI 助手锁定。';
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
})();
