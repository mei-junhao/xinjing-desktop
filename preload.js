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

// 桥接 API 用闭包常量保存：preload 内部只通过 api.* 调用，
// 渲染页通过 contextBridge 暴露的 window.__XJ_API__ 访问。
const api = {
  openActivation: () => ipcRenderer.send('xj:openActivation'),
  getState: () => ipcRenderer.invoke('xj:getState'),
  getVersion: () => ipcRenderer.invoke('xj:getVersion'),
  activate: (code) => ipcRenderer.invoke('xj:activate', code),
  done: () => ipcRenderer.send('xj:activationDone'),
  saveBackupConfig: (cfg) => ipcRenderer.invoke('xj:saveBackupConfig', cfg),
  selectBackupFolder: () => ipcRenderer.invoke('xj:selectBackupFolder')
};

try {
  contextBridge.exposeInMainWorld('__XJ_API__', api);
  console.log('[XJ] bridge __XJ_API__ exposed');
} catch (e) {
  console.error('[XJ] exposeInMainWorld __XJ_API__ FAILED:', (e && e.message) || e);
}

const stateRef = { mode: null, daysLeft: null, identity: null };
try {
  contextBridge.exposeInMainWorld('__XJ__', stateRef);
} catch (e) {
  console.error('[XJ] exposeInMainWorld __XJ__ FAILED:', (e && e.message) || e);
}

(function () {
  const isActivationPage = location.pathname.includes('activation.html');
  if (isActivationPage) return; // 激活页自行管理 UI

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
    if (state.mode === 'limited') injectWatermark();
    injectBanner(state);
    if (state.mode === 'limited') {
      injectPageNotice();
      lockExportPrint();
    }
    if (state.mode !== 'full') injectSettingsPanel(state);
  });

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
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function injectBanner(state) {
    const bar = document.createElement('div');
    bar.id = 'xj-banner';
    if (state.mode === 'limited') bar.classList.add('limited');
    const txt = state.mode === 'limited'
      ? '试用已到期 · 受限模式：仅可管理前 5 位来访者与 50 条督导记录（其余只读），禁止导出/打印 · 输入激活码解锁'
      : `试用版 · 剩余 ${state.daysLeft} 天 · 功能不受限 · 输入激活码可永久解锁`;
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
    const isBlocked = (el) => {
      if (!el) return false;
      const t = (el.textContent || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
      return /导出|打印|export|print/i.test(t);
    };
    document.addEventListener('click', (e) => {
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
    }, true);
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
    const title = state.mode === 'limited' ? '受限模式（未激活）' : `试用版（剩余 ${state.daysLeft} 天）`;
    const detail = state.mode === 'limited'
      ? '仅可管理前 5 位来访者与 50 条督导记录（超出只读），禁止导出/打印，界面含水印。'
      : '试用期内功能不受限；到期后将进入受限模式。';
    const who = state.identity ? `授权给：${state.identity}` : '尚未激活';
    const box = document.createElement('div');
    box.id = 'xj-lic-panel';
    box.innerHTML =
      `<div class="xj-lic-title">${title}</div>` +
      `<div class="xj-lic-row">${who}</div>` +
      `<div class="xj-lic-row">${detail}</div>` +
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
