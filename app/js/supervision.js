/* ============================================================
   心镜 XinJing — AI 督导（Word 式编辑区 + 常驻 AI 坞）
   - 取向 / 模板切换 → 仅改变 curO / curT 与 #dockHint（不触碰 Supervisors）
   - 选区浮动格式工具栏（粗体/斜体/H3/列表/引用）
   - AI 坞动作将结果以 <mark class="ai"> 插入编辑器光标处（非独立卡）
   - 草稿本地自动保存 / 载入；会员自定义模板走 App.aiUnlocked() 门控
   - 手工记录模态（含日期字段）逻辑原样保留
   不得修改 supervision-core.js / supervisors.js / store.js / app.js
   ============================================================ */

App.initPage({
  title: 'AI 督导',
  onReady: function () {
    'use strict';

    App.bindModalClose('sup-modal');

    const orientNames = {
      winnicott: '温尼科特', psychoanalysis: '精神分析', cbt: 'CBT',
      rogers: '人本-罗杰斯', yalom: '存在-亚隆', generic: '通用整合',
    };
    let curO = 'winnicott';
    let curT = 'default';
    const DRAFT_KEY = 'xj_sup_editor_draft';

    const editor = document.getElementById('editor');
    const floatTb = document.getElementById('floatTb');
    const wrap = document.getElementById('editorWrap');
    const dockHint = document.getElementById('dockHint');

    // ===================== 草稿本地自动保存 / 载入 =====================
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) editor.innerHTML = draft;
    } catch (e) { /* localStorage 不可用则忽略 */ }

    let saveTimer = null;
    function persistDraft() {
      try { localStorage.setItem(DRAFT_KEY, editor.innerHTML); } catch (e) {}
    }
    editor.addEventListener('input', function () {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistDraft, 500);
    });

    // ===================== 取向 / 模板切换 =====================
    function refreshHint() {
      const activeChip = document.querySelector('.chip.active');
      const tpl = activeChip ? activeChip.dataset.tpl : 'default';
      dockHint.innerHTML = '当前取向：<b>' + (orientNames[curO] || curO) + '</b> · 模板：<b>' + tpl + '</b>。所有结果直接插入左侧文档，无需跳转。拖动左缘可调宽。';
    }

    document.querySelectorAll('#orient button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#orient button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        curO = b.dataset.o;
        refreshHint();
      });
    });

    document.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        if (c.classList.contains('locked')) {
          App.showToast('自定义模板为会员功能，正在打开激活入口…', 'info');
          openActivation();
          return;
        }
        document.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        curT = c.dataset.tpl;
        refreshHint();
      });
    });
    refreshHint();

    function openActivation() {
      if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation();
    }
    window.openActivation = openActivation;

    // ===================== 选区浮动工具栏 =====================
    editor.addEventListener('mouseup', function () {
      setTimeout(function () {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !editor.contains(sel.anchorNode)) { floatTb.style.display = 'none'; return; }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        floatTb.style.display = 'flex';
        floatTb.style.left = (r.left - wr.left + wrap.scrollLeft + 10) + 'px';
        floatTb.style.top = (r.top - wr.top + wrap.scrollTop - floatTb.offsetHeight - 8) + 'px';
      }, 10);
    });
    editor.addEventListener('blur', function () { setTimeout(function () { floatTb.style.display = 'none'; }, 150); });
    floatTb.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.execCommand(b.dataset.cmd, b.dataset.cmd === 'formatBlock', b.dataset.val || null);
        editor.focus();
        persistDraft();
      });
    });

    // ===================== 插入 <mark class="ai"> 到光标 / 选区 =====================
    function insertAiBlock(text) {
      const mark = document.createElement('mark');
      mark.className = 'ai';
      mark.textContent = text;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0);
        r.collapse(false);
        r.insertNode(mark);
        r.setStartAfter(mark);
        r.setEndAfter(mark);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        editor.appendChild(mark);
      }
      editor.focus();
      persistDraft();
    }

    function getSelectionText() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.toString().trim();
      return '';
    }
    function getEditorText() { return (editor.innerText || '').trim(); }

    function ensureUnlocked() {
      if (!App.aiUnlocked()) { App.showToast('AI 督导为付费功能，正在打开激活入口…', 'info'); openActivation(); return false; }
      return true;
    }
    function setBtnLoading(btn, loading, label) {
      if (!btn) return;
      if (loading) { btn.dataset._t = btn.textContent; btn.disabled = true; btn.textContent = label || '生成中…'; }
      else { btn.disabled = false; btn.textContent = btn.dataset._t || label; }
    }

    // ===================== AI 坞动作（结果插入编辑器） =====================
    document.getElementById('btnImpression').addEventListener('click', async function () {
      if (!ensureUnlocked()) return;
      const material = getEditorText();
      if (!material) { App.showToast('请先在左侧文档写入临床材料', 'error'); return; }
      const btn = this;
      setBtnLoading(btn, true, '生成中…');
      try {
        const result = await SupervisionCore.runImpression(curO, material);
        if (result && result.error) { App.showToast(result.error, 'error'); return; }
        insertAiBlock('【整体印象 · ' + (orientNames[curO] || curO) + '】\n' + (result.impression || ''));
      } catch (e) { App.showToast((e && e.message) || '生成失败', 'error'); }
      finally { setBtnLoading(btn, false); }
    });

    // 深化 / 总结 / 润色：supervision-core 无专用方法，统一经 runRound（system+user）实现
    async function runSelectionAction(btn, kind) {
      if (!ensureUnlocked()) return;
      const selText = getSelectionText();
      if (!selText) { App.showToast('请先在左侧文档选中文字', 'error'); return; }
      setBtnLoading(btn, true, '生成中…');
      try {
        const sys = (window.Supervisors && Supervisors.buildSystemPrompt) ? Supervisors.buildSystemPrompt(curO) : '';
        let title = '', instruction = '';
        if (kind === 'deepen') { title = '深化讨论'; instruction = '请就以下临床材料深化讨论，提出进一步的思考角度与开放式提问：\n'; }
        else if (kind === 'summarize') { title = '选区总结'; instruction = '请总结以下选区的要点：\n'; }
        else { title = '润色后'; instruction = '请在不改变原意的前提下润色以下文字，使其更通顺、专业：\n'; }
        const userText = instruction + selText;
        const chatMessages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
        const result = await SupervisionCore.runRound(chatMessages, userText);
        if (result && result.error) { App.showToast(result.error, 'error'); return; }
        insertAiBlock('【' + title + '】\n' + (result.reply || ''));
      } catch (e) { App.showToast((e && e.message) || '生成失败', 'error'); }
      finally { setBtnLoading(btn, false); }
    }
    document.getElementById('btnDeepen').addEventListener('click', function () { runSelectionAction(this, 'deepen'); });
    document.getElementById('btnSummarize').addEventListener('click', function () { runSelectionAction(this, 'summarize'); });
    document.getElementById('btnPolish').addEventListener('click', function () { runSelectionAction(this, 'polish'); });

    document.getElementById('btnMaster').addEventListener('click', function () {
      const ctx = getSelectionText() || getEditorText();
      if (window.__XJ_API__ && typeof window.__XJ_API__.openMaster === 'function') {
        try { window.__XJ_API__.openMaster(ctx); return; } catch (e) { /* 回退跳转 */ }
      }
      location.href = 'masters.html';
    });

    document.getElementById('btnRealSup').addEventListener('click', function () {
      document.getElementById('realsup').classList.toggle('open');
    });
    document.getElementById('rsRun').addEventListener('click', async function () {
      if (!ensureUnlocked()) return;
      const ta = document.getElementById('rsText');
      const t = (ta.value || '').trim();
      if (t.length < 30) { App.showToast('文字稿过短（需 ≥30 字）', 'error'); return; }
      const btn = this;
      setBtnLoading(btn, true, '结构化中…');
      try {
        const parsed = await SupervisionCore.runRealSupParse(t);
        const lines = ['【真人督导整理】'];
        lines.push('来访者：' + (parsed.clientName || '未识别'));
        lines.push('日期：' + (parsed.sessionDate || '—'));
        lines.push('要点：' + (parsed.summary || ''));
        if (parsed.keyFrags && parsed.keyFrags.length) lines.push('关键片段：\n' + parsed.keyFrags.map(function (s) { return '· ' + s; }).join('\n'));
        if (parsed.techniques && parsed.techniques.length) lines.push('技术建议：\n' + parsed.techniques.map(function (s) { return '· ' + s; }).join('\n'));
        insertAiBlock(lines.join('\n'));
        document.getElementById('realsup').classList.remove('open');
        ta.value = '';
      } catch (e) { App.showToast((e && e.message) || '结构化失败', 'error'); }
      finally { setBtnLoading(btn, false); }
    });

    // ===================== 坞可拖拽调宽 =====================
    const resizer = document.getElementById('resizer');
    const ws = document.getElementById('ws');
    const root = document.documentElement;
    let drag = false;
    resizer.addEventListener('mousedown', function (e) { drag = true; document.body.style.cursor = 'col-resize'; e.preventDefault(); });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      const rect = ws.getBoundingClientRect();
      let w = rect.right - e.clientX;
      w = Math.max(260, Math.min(560, w));
      root.style.setProperty('--dock-w', w + 'px');
    });
    window.addEventListener('mouseup', function () { if (drag) { drag = false; document.body.style.cursor = ''; } });

    const dock = document.getElementById('aidock');
    const tog = document.getElementById('dockToggle');
    tog.addEventListener('click', function () {
      dock.classList.toggle('collapsed');
      tog.textContent = dock.classList.contains('collapsed') ? '展开 AI 坞' : '收起 AI 坞';
    });

    // ===================== 手工记录（保留日期字段，逻辑原样迁移） =====================
    let currentType = 'all';

    window.setSupType = function (type) {
      currentType = type;
      document.querySelectorAll('#sup-type-filter .pill').forEach(function (p) {
        p.classList.toggle('active', p.dataset.type === type);
      });
      renderList();
    };

    function renderSessionOptions(selectedIds) {
      const box = document.getElementById('sv-sessions');
      if (!box) return;
      const sessions = Store.getSessions();
      if (!sessions.length) {
        box.innerHTML = '<div style="font-size:13px;color:var(--muted);font-family:var(--sans)">暂无会话记录</div>';
        return;
      }
      box.innerHTML = sessions.map(function (s) {
        const client = Store.getClient(s.clientId);
        const name = client ? client.name : '?';
        const checked = selectedIds.indexOf(s.id) >= 0 ? 'checked' : '';
        return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-family:var(--sans);font-size:13px;cursor:pointer">' +
          '<input type="checkbox" value="' + s.id + '" ' + checked + '> ' + App.escapeHtml(name) + ' · 第' + s.sessionNumber + '节 (' + App.formatDate(s.date, true) + ')' +
          '</label>';
      }).join('');
    }

    window.openSupModal = function (id) {
      const isEdit = !!id;
      document.getElementById('sup-modal-title').textContent = isEdit ? '编辑督导记录' : '新增督导记录';
      document.getElementById('sv-id').value = id || '';
      document.getElementById('sv-type').value = 'individual';
      document.getElementById('sv-supervisor').value = '';
      document.getElementById('sv-date').value = App.todayStr();
      document.getElementById('sv-content').value = '';
      document.getElementById('sv-conclusion').value = '';
      renderSessionOptions([]);
      if (isEdit) {
        const sv = Store.getSupervision(id);
        if (sv) {
          document.getElementById('sv-type').value = sv.type;
          document.getElementById('sv-supervisor').value = sv.supervisorName || '';
          document.getElementById('sv-date').value = sv.date || App.todayStr();
          document.getElementById('sv-content').value = sv.content || '';
          document.getElementById('sv-conclusion').value = sv.conclusion || '';
          renderSessionOptions(sv.sessionIds || []);
        }
      }
      App.openModal('sup-modal');
    };

    window.saveSupervision = function () {
      const id = document.getElementById('sv-id').value;
      const sessionIds = Array.prototype.slice.call(document.querySelectorAll('#sv-sessions input:checked')).map(function (c) { return c.value; });
      const data = {
        type: document.getElementById('sv-type').value,
        supervisorName: document.getElementById('sv-supervisor').value.trim(),
        date: document.getElementById('sv-date').value,
        sessionIds: sessionIds,
        content: document.getElementById('sv-content').value.trim(),
        conclusion: document.getElementById('sv-conclusion').value.trim(),
      };
      try {
        if (id) { Store.updateSupervision(id, data); App.showToast('已保存', 'success'); }
        else { Store.createSupervision(data); App.showToast('已新增督导记录', 'success'); }
      } catch (e) { App.showToast(e.message, 'error'); return; }
      App.closeModal('sup-modal');
    };

    function renderList() {
      const container = document.getElementById('sup-list');
      if (!container) return; // 本页工作区不渲染手工列表，但函数保留以备外部调用
      let sups = Store.getSupervisions();
      if (currentType !== 'all') sups = sups.filter(function (s) { return s.type === currentType; });
      sups.sort(function (a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
      if (!sups.length) {
        container.innerHTML = '<div class="empty-state"><div class="icon">' + App.svgIcon('cap') + '</div><div class="text">暂无督导记录</div></div>';
        return;
      }
      container.innerHTML = sups.map(function (sv) {
        const typeLabel = sv.type === 'group' ? '团体督导' : (sv.type === 'ai' ? 'AI 督导' : '个体督导');
        const names = (sv.sessionIds || []).map(function (sid) {
          const s = Store.getSession(sid);
          if (!s) return '';
          const c = Store.getClient(s.clientId);
          return c ? c.name + '·第' + s.sessionNumber + '节' : '';
        }).filter(Boolean).join('、');
        const preview = (sv.content || '').slice(0, 60);
        return '<div class="list-card">' +
          '<div class="row1"><span class="title">' + App.escapeHtml(sv.supervisorName || '未填督导师') + ' · ' + typeLabel + '</span>' +
          '<span class="meta">' + App.formatDate(sv.date, true) +
          ' <span style="margin-left:8px;cursor:pointer;color:var(--accent)" onclick="openSupModal(\'' + sv.id + '\')">编辑</span>' +
          ' <span style="margin-left:8px;cursor:pointer;color:var(--red)" onclick="deleteSup(\'' + sv.id + '\')">删除</span></span></div>' +
          (names ? '<div class="meta" style="margin-bottom:4px">关联：' + App.escapeHtml(names) + '</div>' : '') +
          '<div class="desc">' + (App.escapeHtml(preview) || '（无内容）') + '</div></div>';
      }).join('');
    }

    window.deleteSup = function (id) {
      App.confirmDialog('确定删除该督导记录？', function () {
        try { Store.deleteSupervision(id); } catch (e) { App.showToast(e.message, 'error'); return; }
        App.showToast('已删除', 'success');
        renderList();
      }, true);
    };
  },
});
