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
      return;
    }
    info.textContent = STATE_TEXT[state];
    info.classList.toggle('update-ok', status.committed === true);
    info.classList.toggle('update-warn', state === 'failed' || state === 'rolled-back' || state === 'rollback-pending' || state === 'rolling-back');
    // Long Chinese text must wrap in narrow windows.
    info.style.whiteSpace = 'normal';
    info.style.wordBreak = 'break-all';
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
