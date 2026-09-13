/* ============================================================
   settings-update-ui.js — replace-mode settings.js update section
   (replaces settings.js:38-51 window.checkUpdate 3-second premature-success
   fallback; per serial_write_set[2]).
   - consumes a TYPED status stream (xj:update:status via
     window.__XJ_API__.update / __XJ_UPDATE_BRIDGE__);
   - success text appears ONLY after 'committed';
   - no fixed 3-second premature "already latest" fallback;
   - unknown states render a neutral '状态未知' and never claim success;
   - keyboard focus, reduced motion, narrow window and long Chinese text
     remain usable.
   ============================================================ */
(function () {
  'use strict';

  var STATE_TEXT = {
    checking: '正在检查更新…',
    available: '发现新版本',
    'awaiting-confirmation': '等待确认…',
    downloading: '正在下载更新…',
    verified: '已下载并校验通过',
    restarting: '正在重启以应用更新…',
    'health-check': '正在验证更新健康…',
    committed: '更新已完成',
    failed: '更新失败，已回滚到原版本',
    'rollback-pending': '回滚待处理…',
    'rolling-back': '正在回滚…',
    'rolled-back': '已回滚到原版本'
  };
  var UNKNOWN = '状态未知';

  var winRef = null;
  function bridge() {
    var w = winRef || window;
    var api = w.__XJ_API__ || {};
    if (api.update && api.update.onStatus) return api.update;
    return w.__XJ_UPDATE_BRIDGE__ || null;
  }

  function render(info, status) {
    if (!info) return;
    var state = status && status.state;
    if (!state || !Object.prototype.hasOwnProperty.call(STATE_TEXT, state)) {
      info.textContent = UNKNOWN; // never claim success on unknown input
      info.classList.remove('update-ok', 'update-warn');
      setBar(info, null);
      return;
    }
    // 2026-09-13（下载进度条）：downloading 状态带 progress 时显示百分比与进度条，
    // 让用户看到下载真实进展（此前只有文字「正在下载」，看起来像没反应）。
    var pct = status && typeof status.progress === 'number' ? Math.max(0, Math.min(100, status.progress)) : null;
    if (state === 'downloading') {
      info.textContent = '正在下载更新…' + (pct != null ? ' ' + pct + '%' : '') + (pct != null && pct >= 100 ? '（校验中…）' : '');
      setBar(info, pct == null ? 0 : pct);
    } else {
      info.textContent = STATE_TEXT[state];
      setBar(info, null);
    }
    info.classList.toggle('update-ok', status.committed === true);
    info.classList.toggle('update-warn', state === 'failed' || state === 'rolled-back' || state === 'rollback-pending' || state === 'rolling-back');
    // Long Chinese text must wrap in narrow windows.
    info.style.whiteSpace = 'normal';
    info.style.wordBreak = 'break-all';
  }

  // 进度条元素：惰性创建在 #update-info 之后（不改变既有 DOM 约定）。
  function setBar(info, pct) {
    var doc = info.ownerDocument || document;
    var bar = doc.getElementById('update-progress-bar');
    if (pct == null) {
      if (bar) bar.style.display = 'none';
      return;
    }
    if (!bar) {
      bar = doc.createElement('div');
      bar.id = 'update-progress-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', '更新下载进度');
      var inner = doc.createElement('div');
      inner.className = 'update-progress-inner';
      inner.style.cssText = 'height:100%;width:0%;background:var(--accent,#5B6478);border-radius:3px;transition:width .25s ease';
      bar.style.cssText = 'height:6px;width:100%;max-width:320px;margin-top:6px;background:rgba(127,127,127,.22);border-radius:3px;overflow:hidden';
      bar.appendChild(inner);
      if (info.parentNode) info.parentNode.insertBefore(bar, info.nextSibling);
    }
    bar.style.display = 'block';
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = bar.firstChild;
    if (fill) fill.style.width = pct + '%';
  }

  function install(windowRef) {
    var win = windowRef || window;
    winRef = win;
    var info = win.document.getElementById('update-info');
    if (!info) return;
    // Narrow-window baseline: long Chinese status text always wraps.
    info.style.whiteSpace = 'normal';
    info.style.wordBreak = 'break-all';

    win.checkUpdate = function () {
      var b = bridge();
      if (!b || typeof b.check !== 'function') {
        render(info, null);
        return Promise.resolve(null);
      }
      render(info, { state: 'checking', committed: false });
      var strategy = /portable/i.test(String(win.navigator.userAgent)) ? 'portable' : 'installer';
      return b.check('stable', strategy).then(function (status) {
        render(info, status || { state: 'checking' });
        return status || { state: 'checking' };
      }).catch(function () {
        render(info, { state: 'failed', committed: false });
        return { state: 'failed', committed: false };
      });
    };

    var b = bridge();
    if (b && typeof b.onStatus === 'function') {
      b.onStatus(function (status) { render(info, status); });
    }
    // Reduced motion: never animate; text-only updates.
    if (info && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      info.classList.add('reduce-motion');
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { install: install, STATE_TEXT: STATE_TEXT, UNKNOWN: UNKNOWN };
  else if (typeof window !== 'undefined') install(window);
})();
