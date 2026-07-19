/* ============================================================
 * 心镜 XinJing — 强引导 Onboarding（v3.6.2）
 *
 * 两种形态结合（用户选定 C·两者结合）：
 *   ① 首启聚光灯分步导览（spotlight tour）：蒙层 + box-shadow 挖洞高亮 + 气泡
 *      —— 仅首次进入首页自动跑一遍；localStorage 'xj_onboarding_done' 记录。
 *   ② 首页常驻新手任务清单：真实数据驱动打勾（配 AI / 建来访 / 记咨询 / 体验 AI）
 *      —— 全部完成或用户手动关闭后收起。
 *
 * 设计约束（血的教训）：
 *   - 样式经 JS 创建 <style> 元素注入，字符串内绝不出现字面关闭标签，杜绝 CSS 泄漏。
 *   - 全程 try/catch 健壮：任一环节异常都不阻断首页正常渲染。
 *   - 使用暖色皮肤变量：--accent / --paper-2 / --ink / --border / --accent-soft 等。
 *
 * 对外：window.Onboarding = { maybeStartTour, startTour, renderChecklist, reset }
 * ============================================================ */
(function () {
  'use strict';

  var LS_TOUR = 'xj_onboarding_done';        // 是否已看过聚光灯导览
  var LS_CHECK_DISMISS = 'xj_ob_checklist_dismissed'; // 是否手动收起任务清单
  var LS_EXPLORE = 'xj_ob_task_explore';     // 是否体验过 AI 督导 / 大师对话

  // ---------- 小工具 ----------
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ---------- 样式注入（一次）----------
  var STYLE_ID = 'xj-onboarding-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.xjob-mask{position:fixed;inset:0;z-index:9000;pointer-events:auto;cursor:pointer}',
      '.xjob-hole{position:fixed;z-index:9001;border-radius:14px;box-shadow:0 0 0 9999px rgba(20,18,16,.58);',
        'transition:all .28s cubic-bezier(.4,0,.2,1);pointer-events:none;',
        'outline:2px solid var(--accent,#8b93c7);outline-offset:3px}',
      '.xjob-full{position:fixed;inset:0;z-index:9001;background:rgba(20,18,16,.58);pointer-events:none}',
      '.xjob-pop{position:fixed;z-index:9002;max-width:340px;width:min(340px,90vw);',
        'background:var(--paper-2,#fff);border:1px solid var(--border,#e7e2da);border-radius:16px;',
        'padding:20px 22px 18px;box-shadow:0 20px 60px rgba(20,18,16,.28);',
        'font-family:var(--sans,-apple-system,system-ui,sans-serif);',
        'animation:xjobPop .28s cubic-bezier(.34,1.3,.64,1) both}',
      '@keyframes xjobPop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}',
      '.xjob-pop .xjob-step{font-size:11px;letter-spacing:.06em;color:var(--accent,#8b93c7);font-weight:700;margin-bottom:8px}',
      '.xjob-pop h4{margin:0 0 8px;font-family:var(--serif,Georgia,serif);font-size:18px;font-weight:600;color:var(--ink,#2b3140)}',
      '.xjob-pop p{margin:0;font-size:13.5px;line-height:1.72;color:var(--ink-2,#5a5750)}',
      '.xjob-row{display:flex;align-items:center;gap:8px;margin-top:18px}',
      '.xjob-row .sp{flex:1}',
      '.xjob-skip{border:none;background:transparent;color:var(--ink-3,#9a948c);font-size:12.5px;cursor:pointer;padding:6px 2px}',
      '.xjob-skip:hover{color:var(--ink-2,#5a5750)}',
      '.xjob-btn{border:1px solid var(--border,#e7e2da);background:var(--paper,#fff);color:var(--ink-2,#5a5750);',
        'border-radius:10px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:all .18s ease}',
      '.xjob-btn:hover{border-color:var(--accent,#8b93c7);color:var(--accent,#8b93c7)}',
      '.xjob-btn.pri{background:var(--accent,#8b93c7);border-color:var(--accent,#8b93c7);color:#fff}',
      '.xjob-btn.pri:hover{filter:brightness(1.06);color:#fff}',
      '.xjob-dots{display:flex;gap:5px;align-items:center}',
      '.xjob-dots i{width:6px;height:6px;border-radius:50%;background:var(--border,#e7e2da);transition:all .2s ease}',
      '.xjob-dots i.on{background:var(--accent,#8b93c7);width:16px;border-radius:3px}',
      // ---- 新手任务清单 ----
      '.xjob-cl{background:var(--paper-2,#fff);border:1px solid var(--border,#e7e2da);border-radius:16px;',
        'padding:18px 22px 16px;animation:xjobPop .4s ease both}',
      '.xjob-cl-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}',
      '.xjob-cl-head .ic{width:30px;height:30px;border-radius:9px;background:var(--accent-soft,#eef0f8);',
        'color:var(--accent,#8b93c7);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}',
      '.xjob-cl-head h3{margin:0;font-family:var(--serif,Georgia,serif);font-size:16px;font-weight:600;color:var(--ink,#2b3140);flex:1}',
      '.xjob-cl-head .pct{font-size:12px;color:var(--ink-3,#9a948c);font-family:var(--sans,system-ui)}',
      '.xjob-cl-close{border:none;background:transparent;color:var(--ink-3,#c4beb4);font-size:18px;cursor:pointer;padding:2px 4px;line-height:1}',
      '.xjob-cl-close:hover{color:var(--ink-2,#5a5750)}',
      '.xjob-bar{height:5px;border-radius:3px;background:var(--bg-sunken,#f0ece4);overflow:hidden;margin:10px 0 14px}',
      '.xjob-bar i{display:block;height:100%;background:var(--accent,#8b93c7);border-radius:3px;transition:width .4s cubic-bezier(.4,0,.2,1)}',
      '.xjob-task{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:10px;cursor:pointer;transition:background .15s ease}',
      '.xjob-task:hover{background:var(--hover-tint,#f7f4ee)}',
      '.xjob-task .box{width:20px;height:20px;border-radius:6px;border:2px solid var(--border,#d8d2c8);flex-shrink:0;',
        'display:flex;align-items:center;justify-content:center;transition:all .18s ease}',
      '.xjob-task.done .box{background:var(--success,#5b9e6f);border-color:var(--success,#5b9e6f)}',
      '.xjob-task .box svg{width:12px;height:12px;opacity:0;transition:opacity .18s ease}',
      '.xjob-task.done .box svg{opacity:1}',
      '.xjob-task .tx{flex:1;min-width:0}',
      '.xjob-task .tt{font-size:13.5px;font-weight:600;color:var(--ink,#2b3140);font-family:var(--sans,system-ui)}',
      '.xjob-task.done .tt{color:var(--ink-3,#9a948c);text-decoration:line-through}',
      '.xjob-task .ds{font-size:11.5px;color:var(--ink-3,#9a948c);margin-top:1px;font-family:var(--sans,system-ui)}',
      '.xjob-task .go{font-size:11.5px;color:var(--accent,#8b93c7);font-weight:600;white-space:nowrap;font-family:var(--sans,system-ui)}',
      '.xjob-task.done .go{display:none}',
      '.xjob-cl-alldone{text-align:center;padding:6px 0 2px;font-size:13px;color:var(--success,#5b9e6f);font-weight:600;font-family:var(--sans,system-ui)}'
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>';

  // ============================================================
  // ① 聚光灯分步导览
  // ============================================================
  var TOUR_STEPS = [
    { sel: null, title: '欢迎来到心镜', text: '这是为心理咨询师打造的一体化工作台。功能不少，先花 40 秒跟我认识几个最常用的入口，之后你随时能在「设置」里重看。' },
    { sel: '.xj-new-client', title: '录入你的第一位来访者', text: '点这里建立来访者档案。之后所有咨询记录、账单、报告都会挂在 TA 名下。' },
    { sel: 'a.mod[href="consult-notes.html"]', title: '记录每一次会谈', text: '每次咨询结束后来这里记录整理，支持 APA 结构化提示与 AI 辅助逐字稿。' },
    { sel: 'a.mod[href="supervision.html"]', title: '遇到卡点问 AI 督导', text: '三栏研究台：整体印象 / 深化分析 / 临床材料，随时给你一份专业的督导视角。' },
    { sel: 'a.mod[href="masters.html"]', title: '与思想大师对话', text: '和 11 位心理学思想者一对一，或发起多人圆桌研讨，换个角度看个案。' },
    { sel: 'a.mod[href="knowledge.html"]', title: '把你的资料喂给 AI', text: '导入课程讲义与文献到「我的资料库」，AI 对话时会自动引用，也能随时检索。' },
    { sel: 'a.mod[href="settings.html"]', title: '第一步：配置 AI 模型', text: '在「设置」里填入你自己的 API 密钥，即可解锁高性能模型；未配置也能用内置免费额度。' },
    { sel: '#xj-toggle-btn', title: '随时呼叫小镜', text: '右上角的「小镜」是贯穿全站的 AI 助手，任何页面都能唤起它帮你处理当前工作。' },
    { sel: null, title: '开始使用吧', text: '下方的「新手任务清单」会陪你走完最初几步——完成后它会自动收起。祝你用得顺手。' }
  ];

  var tourIdx = 0;
  var tourEls = null; // { mask, hole, full, pop }
  var reflowBound = null;

  function buildTourDom() {
    var mask = document.createElement('div'); mask.className = 'xjob-mask';
    var full = document.createElement('div'); full.className = 'xjob-full';
    var hole = document.createElement('div'); hole.className = 'xjob-hole'; hole.style.display = 'none';
    var pop = document.createElement('div'); pop.className = 'xjob-pop';
    // 允许点蒙层任意处退出导览（防止误操作导致的卡死；进度可重看）
    mask.addEventListener('click', function () { try { endTour(false); } catch (e) {} });
    mask.appendChild(full);
    document.body.appendChild(mask);
    document.body.appendChild(hole);
    document.body.appendChild(pop);
    return { mask: mask, full: full, hole: hole, pop: pop };
  }

  function measureAndPlace() {
    if (!tourEls) return;
    var step = TOUR_STEPS[tourIdx];
    var target = step.sel ? q(step.sel) : null;
    var pop = tourEls.pop, hole = tourEls.hole, full = tourEls.full;
    var vw = window.innerWidth, vh = window.innerHeight;

    if (!target) {
      // 居中卡片 + 全屏暗幕
      full.style.display = 'block';
      hole.style.display = 'none';
      pop.style.left = Math.round((vw - pop.offsetWidth) / 2) + 'px';
      pop.style.top = Math.round((vh - pop.offsetHeight) / 2) + 'px';
      return;
    }

    // 量位置前先确保元素在可视区内（用 instant 避免 smooth 异步导致量到旧坐标）
    try { target.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (e) {}
    // 双 rAF 确保布局已落定（auto 滚动同步，但保险起见再等一帧）
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!tourEls) return;
        var r = target.getBoundingClientRect();
        // 目标飞出视口（如被某容器 overflow 裁剪）时改用居中卡片，避免挖洞错位
        if (r.width === 0 && r.height === 0) {
          full.style.display = 'block';
          hole.style.display = 'none';
          pop.style.left = Math.round((vw - pop.offsetWidth) / 2) + 'px';
          pop.style.top = Math.round((vh - pop.offsetHeight) / 2) + 'px';
          return;
        }
        var pad = 6;
        full.style.display = 'none';
        hole.style.display = 'block';
        hole.style.left = Math.max(4, r.left - pad) + 'px';
        hole.style.top = Math.max(4, r.top - pad) + 'px';
        hole.style.width = (r.width + pad * 2) + 'px';
        hole.style.height = (r.height + pad * 2) + 'px';

        // 气泡放在目标下方，放不下则放上方，再不行居中
        var pw = pop.offsetWidth || 340, ph = pop.offsetHeight || 180;
        var left = r.left + r.width / 2 - pw / 2;
        left = Math.max(12, Math.min(left, vw - pw - 12));
        var top;
        if (r.bottom + 14 + ph < vh) top = r.bottom + 14;
        else if (r.top - 14 - ph > 0) top = r.top - 14 - ph;
        else top = Math.max(12, (vh - ph) / 2);
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
      });
    });
  }

  // 滚动/缩放时重新定位（用 passive 监听 + 节流，避免气泡抖动）
  var reflowRaf = null;
  function scheduleReflow() {
    if (reflowRaf) cancelAnimationFrame(reflowRaf);
    reflowRaf = requestAnimationFrame(function () { reflowRaf = null; measureAndPlace(); });
  }

  function positionStep() { measureAndPlace(); }

  function renderStep() {
    if (!tourEls) return;
    var step = TOUR_STEPS[tourIdx];
    var last = tourIdx === TOUR_STEPS.length - 1;
    var first = tourIdx === 0;
    var dots = TOUR_STEPS.map(function (_, i) { return '<i class="' + (i === tourIdx ? 'on' : '') + '"></i>'; }).join('');
    tourEls.pop.innerHTML =
      '<div class="xjob-step">第 ' + (tourIdx + 1) + ' / ' + TOUR_STEPS.length + ' 步</div>' +
      '<h4></h4><p></p>' +
      '<div class="xjob-row">' +
        '<div class="xjob-dots">' + dots + '</div>' +
        '<span class="sp"></span>' +
        (first ? '<button class="xjob-skip" data-act="skip">跳过</button>'
               : '<button class="xjob-btn" data-act="prev">上一步</button>') +
        '<button class="xjob-btn pri" data-act="next">' + (last ? '完成' : '下一步') + '</button>' +
      '</div>';
    // 文本用 textContent 防 XSS / 转义困扰
    tourEls.pop.querySelector('h4').textContent = step.title;
    tourEls.pop.querySelector('p').textContent = step.text;
    tourEls.pop.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-act');
        if (a === 'skip' || (a === 'next' && last)) return endTour(true);
        if (a === 'prev') { tourIdx = Math.max(0, tourIdx - 1); renderStep(); positionStep(); return; }
        if (a === 'next') { tourIdx = Math.min(TOUR_STEPS.length - 1, tourIdx + 1); renderStep(); positionStep(); }
      });
    });
    positionStep();
  }

  function startTour() {
    try {
      injectStyle();
      if (tourEls) endTour(false);
      tourIdx = 0;
      tourEls = buildTourDom();
      reflowBound = function () { scheduleReflow(); };
      window.addEventListener('resize', reflowBound);
      window.addEventListener('scroll', reflowBound, true);
      renderStep();
    } catch (e) { console.warn('[Onboarding] 导览启动失败', e); }
  }

  // 强制清理所有导览 DOM（防止任何异常导致全屏蒙层残留、页面卡死无法点击）
  function forceCleanup() {
    try {
      ['xjob-mask', 'xjob-full', 'xjob-hole', 'xjob-pop'].forEach(function (cls) {
        var nodes = document.querySelectorAll('.' + cls);
        nodes.forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
      });
      tourEls = null;
    } catch (e) {}
  }

  function endTour(markDone) {
    try {
      if (reflowBound) {
        window.removeEventListener('resize', reflowBound);
        window.removeEventListener('scroll', reflowBound, true);
        reflowBound = null;
      }
      if (tourEls) {
        [tourEls.mask, tourEls.hole, tourEls.full, tourEls.pop].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
        tourEls = null;
      }
      // 兜底：无论上面是否成功，再扫一遍残留节点，杜绝蒙层卡死
      forceCleanup();
      if (markDone) {
        lsSet(LS_TOUR, '1');
        renderChecklist(); // 导览结束后立即刷新清单
      }
    } catch (e) {
      // 即使异常也要尽力清理，避免整页不可点击
      forceCleanup();
    }
  }

  // 首启判定：仅当从未看过导览时自动开跑
  function maybeStartTour() {
    try {
      // 兜底：无论历史是否残留蒙层，先清一次，确保页面可点击
      forceCleanup();
      if (lsGet(LS_TOUR) === '1') return;
      // 稍等首页动画/侧栏注入完成再开
      setTimeout(function () {
        // 第二次兜底（防止首屏期间注入侧栏时被遮挡残留）
        forceCleanup();
        startTour();
      }, 550);
    } catch (e) {}
  }

  // ============================================================
  // ② 新手任务清单（真实数据驱动）
  // ============================================================
  function taskState() {
    var hasAI = false, hasClient = false, hasSession = false, explored = false, hasProfile = false;
    try { hasAI = (window.AI && typeof AI.getTier === 'function' && AI.getTier() === 'user'); } catch (e) {}
    try { hasClient = (window.Store && Store.getClients && Store.getClients().length > 0); } catch (e) {}
    try { hasSession = (window.Store && Store.getSessions && Store.getSessions().length > 0); } catch (e) {}
    try { explored = lsGet(LS_EXPLORE) === '1'; } catch (e) {}
    try { var profile = (Store.getSettings().profile) || {}; hasProfile = !!(profile.displayName || profile.orientation); } catch (e) {}
    return [
      { key: 'ai', done: hasAI, tt: '配置 AI 模型', ds: '填入你的 API 密钥，解锁高性能模型', go: '去设置', act: function () { location.href = 'settings.html'; } },
      { key: 'client', done: hasClient, tt: '新建第一位来访者', ds: '建立档案，开始你的个案管理', go: '去新建', act: function () {
          if (typeof ClientModal !== 'undefined') { ClientModal.show(function (c) { try { if (window.App) App.showToast('已新增来访者「' + c.name + '」', 'success'); } catch (e) {} renderChecklist(); }); }
          else location.href = 'consult-notes.html';
        } },
      { key: 'session', done: hasSession, tt: '记录一次咨询', ds: '写下第一条会谈记录', go: '去记录', act: function () { location.href = 'consult-notes.html'; } },
      { key: 'explore', done: explored, tt: '体验 AI 督导 / 大师对话', ds: '让 AI 给你专业视角', go: '去体验', act: function () { lsSet(LS_EXPLORE, '1'); location.href = 'supervision.html'; } },
      { key: 'profile', done: hasProfile, optional: true, tt: '可选：完善执业画像', ds: '称呼和取向仅用于本地个性化，不影响手工工作', go: '去设置', act: function () { location.href = 'settings.html#profile'; } }
    ];
  }

  function renderChecklist() {
    try {
      var mount = document.getElementById('ob-checklist');
      if (!mount) return;
      if (lsGet(LS_CHECK_DISMISS) === '1') { mount.innerHTML = ''; return; }
      injectStyle();

      var tasks = taskState();
      var requiredTasks = tasks.filter(function (t) { return !t.optional; });
      var doneN = requiredTasks.filter(function (t) { return t.done; }).length;
      var pct = Math.round(doneN / Math.max(1, requiredTasks.length) * 100);

      // 全部完成：显示祝贺一小会儿后自动收起（并持久化 dismiss，避免下次再弹）
      var allDone = doneN === requiredTasks.length;

      var rows = tasks.map(function (t) {
        return '<div class="xjob-task' + (t.done ? ' done' : '') + '" data-k="' + t.key + '">' +
          '<div class="box">' + CHECK_SVG + '</div>' +
          '<div class="tx"><div class="tt">' + t.tt + '</div><div class="ds">' + t.ds + '</div></div>' +
          '<div class="go">' + t.go + ' →</div>' +
        '</div>';
      }).join('');

      mount.innerHTML =
        '<div class="xjob-cl">' +
          '<div class="xjob-cl-head">' +
            '<div class="ic">✦</div>' +
            '<h3>新手任务清单</h3>' +
            '<span class="pct">' + doneN + ' / ' + requiredTasks.length + ' 必做完成</span>' +
            '<button class="xjob-cl-close" title="收起" data-close="1">×</button>' +
          '</div>' +
          '<div class="xjob-bar"><i style="width:' + pct + '%"></i></div>' +
          rows +
          (allDone ? '<div class="xjob-cl-alldone">🎉 全部完成，你已经上手了！</div>' : '') +
        '</div>';

      // 绑定：任务点击 → 执行动作
      tasks.forEach(function (t) {
        var row = mount.querySelector('.xjob-task[data-k="' + t.key + '"]');
        if (row && !t.done) row.addEventListener('click', function () { try { t.act(); } catch (e) {} });
      });
      // 收起
      var closeBtn = mount.querySelector('[data-close]');
      if (closeBtn) closeBtn.addEventListener('click', function () { lsSet(LS_CHECK_DISMISS, '1'); mount.innerHTML = ''; });

      // 全部完成后 4 秒自动收起
      if (allDone) { setTimeout(function () { lsSet(LS_CHECK_DISMISS, '1'); if (mount) mount.innerHTML = ''; }, 4000); }
    } catch (e) { console.warn('[Onboarding] 清单渲染失败', e); }
  }

  // ============================================================
  // reset：供设置页「重看新手引导」调用 —— 清标记并立即开跑
  // ============================================================
  function reset() {
    try {
      lsSet(LS_TOUR, '0');
      lsSet(LS_CHECK_DISMISS, '0');
      lsSet(LS_EXPLORE, '0');
      // 若当前在首页，直接开跑导览并刷新清单
      if (document.getElementById('main-page')) { startTour(); renderChecklist(); }
      else { location.href = 'index.html'; }
    } catch (e) { console.warn('[Onboarding] reset 失败', e); }
  }

  window.Onboarding = {
    maybeStartTour: maybeStartTour,
    startTour: startTour,
    renderChecklist: renderChecklist,
    reset: reset
  };
})();
