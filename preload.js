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

// 构建期注入的真实版本（version.generated.js，由 scripts/codegen-version.js 生成并打进 exe）。
// 设置页「关于」版本号优先读此值，与安装包强制绑定，根治「装新包后版本号不更新」的脆弱链路。
let BUILD_VERSION = '0.0.0';
try { BUILD_VERSION = require('./version.generated.js').VERSION || BUILD_VERSION; } catch (e) { /* dev 期无该文件则回退 0.0.0 */ }

// 桥接 API 用闭包常量保存：preload 内部只通过 api.* 调用，
// 渲染页通过 contextBridge 暴露的 window.__XJ_API__ 访问。
const api = {
  openActivation: () => ipcRenderer.send('xj:openActivation'),
  getState: () => ipcRenderer.invoke('xj:getState'),
  getVersion: () => BUILD_VERSION,
  activate: (code) => ipcRenderer.invoke('xj:activate', code),
  cloudActivate: (code) => ipcRenderer.invoke('xj:cloud-activate', code),
  getMachineCode: () => ipcRenderer.invoke('xj:getMachineCode'),
  done: () => ipcRenderer.send('xj:activationDone'),
  saveBackupConfig: (cfg) => ipcRenderer.invoke('xj:saveBackupConfig', cfg),
  selectBackupFolder: () => ipcRenderer.invoke('xj:selectBackupFolder'),
  onLicenseState: (cb) => { if (typeof cb === 'function') stateListeners.push(cb); },
  onLegacyPorts: (cb) => { if (typeof cb === 'function') legacyPortsListeners.push(cb); },
  notifyMigrateDone: (ports) => ipcRenderer.send('xj:migrate-done', ports),
  checkForUpdates: () => ipcRenderer.invoke('xj:check-updates'),
  encryptSecret: (plain) => ipcRenderer.invoke('xj:encryptSecret', plain),
  decryptSecret: (stored) => ipcRenderer.invoke('xj:decryptSecret', stored),
  appProxyKey: () => { try { return require('./secret.generated').APP_PROXY_KEY || ''; } catch (e) { return ''; } },
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

const stateRef = { mode: null, daysLeft: null, identity: null, tier: null, aiUnlocked: false, aiTrialActive: false, aiTrialDaysLeft: 0, aiTrialDays: 60, expired: false, expiresAt: 0 };
try {
  contextBridge.exposeInMainWorld('__XJ__', stateRef);
} catch (e) {
  console.error('[XJ] exposeInMainWorld __XJ__ FAILED:', (e && e.message) || e);
}

(function () {
  const isActivationPage = location.pathname.includes('activation.html');
  if (isActivationPage) return; // 激活页自行管理 UI

  // 受限模式导出/打印锁的句柄，便于激活为完整模式后撤销
  let lockClickHandler = null, origPrint = null;

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
    if (state.mode === 'limited') {
      lockExportPrint();
    }
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
    injectBanner(state);
    if (state.mode === 'limited') lockExportPrint();
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
    document.body.appendChild(bar);
    // 给内容留顶边距，避免被横幅遮挡
    document.body.style.paddingTop = '42px';
  }

  function lockExportPrint() {
    if (lockClickHandler) return; // 已加锁，避免重复绑定
    // P1 修复：只检查可点击元素（button/a/input/[role=button]）自身的 textContent，
    // 不检查容器元素的 textContent（会包含所有后代按钮文本，导致误判）。
    // 原因：账单页 #cpanel-invoice 渲染后含"导出 Word 账单"按钮，main.main 的 textContent
    // 随之包含"导出"字样，导致免费版用户点击顶栏"记一笔"按钮时被误拦截（事件路径经过 main.main）。
    const isBlocked = (el) => {
      if (!el) return false;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const isClickable = tag === 'button' || tag === 'a' || tag === 'input' ||
                          el.getAttribute && el.getAttribute('role') === 'button';
      // 容器元素只检查 title/aria-label（元素自身属性），不检查 textContent（会聚合后代文本）
      const textPart = isClickable ? (el.textContent || '') : '';
      const titleAttr = (el.getAttribute && el.getAttribute('title')) || '';
      const ariaAttr = (el.getAttribute && el.getAttribute('aria-label')) || '';
      const t = textPart + ' ' + titleAttr + ' ' + ariaAttr;
      return /导出|打印|export|print/i.test(t);
    };
    lockClickHandler = (e) => {
      let el = e.target;
      while (el && el !== document.body) {
        if (isBlocked(el)) {
          e.preventDefault();
          e.stopPropagation();
          alert('免费版不含无水印导出与打印，请升级会员后使用。');
          return;
        }
        el = el.parentElement;
      }
    };
    document.addEventListener('click', lockClickHandler, true);
    origPrint = window.print;
    window.print = function () {
      alert('免费版不含无水印打印，请升级会员后使用。');
    };
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
