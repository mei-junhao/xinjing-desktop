/* 心镜 v3.0.0 — 咨询记录（APA/SOAP/DAP/自由 + 小镜辅助） */
(function () {
  'use strict';
  var currentClientId = null;
  var currentSessionId = null;
  var summaryRequestVersion = 0;
  var currentMode = 'apa';
  var allClients = [];
  var autoSaveTimer = null;
  var lastSavedContent = '';
  var contextDate = '';
  var currentWorkflow = 'quick';
  var restoredDraftKeys = {};
  var suppressClientDraftRestore = false;
  var currentTemplateSelection = null;
  var templateSelectionDirty = false;
  var templateSelectionFailure = null;
  var templateControlsBound = false;

  function draftKey() {
    if (!currentClientId) return '';
    return 'noteDraft:' + currentClientId + ':' + (currentSessionId || contextDate || App.todayStr()) + ':' + currentWorkflow;
  }

  function readFields() {
    var values = {};
    ['f1','f2','f3','f4','f5','soap-s','soap-o','soap-a','soap-p','dap-d','dap-a','dap-p','f-free'].forEach(function (id) {
      var el = document.getElementById(id); values[id] = el ? el.value : '';
    });
    return values;
  }

  function applyFields(values) {
    Object.keys(values || {}).forEach(function (id) { var el = document.getElementById(id); if (el) el.value = values[id] || ''; });
  }

  function saveDraft() {
    var key = draftKey();
    if (!key || !Store._put) return;
    var content = collectCurrentContent();
    if (!content.trim()) return;
    Store._put(key, { version: 1, updatedAt: new Date().toISOString(), mode: currentMode, workflow: currentWorkflow, fields: readFields() }).catch(function () {});
  }

  function clearDraft() {
    var key = draftKey();
    if (key && Store._del) Store._del(key).catch(function () {});
  }

  function restoreDraft() {
    var key = draftKey();
    if (!key || !Store._get || restoredDraftKeys[key]) return;
    restoredDraftKeys[key] = true;
    Store._get(key).then(function (draft) {
      if (!draft || !draft.fields) return;
      if (!window.confirm('发现未保存的本地草稿，是否恢复？')) { return; }
      applyFields(draft.fields);
      if (draft.mode) setRecordMode(draft.mode, false);
      if (draft.workflow) setWorkflow(draft.workflow, false);
      App.showToast('已恢复本地草稿', 'success');
    }).catch(function () {});
  }

  function updateContextLabel() {
    var el = document.getElementById('record-context');
    if (!el) return;
    var c = currentClientId && Store.getClient(currentClientId);
    if (!c) { el.textContent = '选择来访者后开始记录'; return; }
    var suffix = currentSessionId ? ('第' + ((Store.getSession(currentSessionId) || {}).sessionNumber || '?') + '节') : (contextDate || App.todayStr());
    el.textContent = c.name + ' · ' + suffix;
  }

  function renderNoteSummary(summary) {
    var box = document.getElementById('note-summary');
    var text = document.getElementById('note-summary-text');
    if (!box || !text) return;
    var value = String(summary || '').trim();
    text.textContent = value;
    box.hidden = !value;
    box.classList.toggle('show', !!value);
  }

  function templateViewModel() {
    if (typeof SessionTemplateViewModel !== 'undefined') return SessionTemplateViewModel;
    if (typeof window !== 'undefined' && window.SessionTemplateViewModel) return window.SessionTemplateViewModel;
    return null;
  }

  function templateLicenseState() {
    try { return App && typeof App.getLicenseState === 'function' ? App.getLicenseState() : null; }
    catch (e) { return null; }
  }

  function defaultTemplateSelection() {
    var vm = templateViewModel();
    if (vm && typeof vm.createSelection === 'function') {
      var result = vm.createSelection('manual-session-v1', { licenseState: templateLicenseState(), context: 'individual' });
      if (result && result.ok) return result.selection;
    }
    return { version: 'session-template-selection-v1', templateId: 'manual-session-v1', tierAtSelection: 'Free', context: 'individual', appliedAt: new Date().toISOString(), customTemplateId: '' };
  }

  function templateLabel(item, historical) {
    if (historical) return item.title + '（历史锁定）';
    if (item.locked && item.preview) return item.title + '（试用预览）';
    if (item.locked) return item.title + '（' + (item.requiredTier === 'Flagship' ? '需旗舰版' : '需会员') + '）';
    return item.title;
  }

  function renderSessionTemplateControl() {
    var bar = document.getElementById('session-template-bar');
    var select = document.getElementById('session-template-select');
    var status = document.getElementById('session-template-status');
    var customWrap = document.getElementById('session-template-custom');
    var customInput = document.getElementById('session-custom-template-id');
    var plans = document.getElementById('session-template-plans');
    if (!bar || !select || !status || !customWrap || !customInput) return;
    if (!currentClientId) { bar.hidden = true; return; }
    bar.hidden = false;
    var vm = templateViewModel();
    if (!vm || typeof vm.list !== 'function') {
      select.innerHTML = '<option value="manual-session-v1">基础手动记录</option>';
      select.value = 'manual-session-v1';
      select.disabled = false;
      customWrap.hidden = true;
      status.className = 'session-template-status';
      status.textContent = '模板边界暂不可用，当前仅保留手动记录。';
      if (plans) plans.hidden = true;
      return;
    }
    var result = vm.list({ licenseState: templateLicenseState(), context: 'individual', includeLocked: true });
    if (!result || !result.ok) {
      select.innerHTML = '<option value="manual-session-v1">基础手动记录</option>';
      select.value = 'manual-session-v1';
      status.className = 'session-template-status';
      status.textContent = '当前仅可使用基础手动记录。';
      customWrap.hidden = true;
      if (plans) plans.hidden = true;
      return;
    }
    var normalizedCurrent = currentTemplateSelection && typeof vm.normalizeSelection === 'function' ? vm.normalizeSelection(currentTemplateSelection) : null;
    var historicalId = normalizedCurrent && normalizedCurrent.ok ? normalizedCurrent.selection.templateId : '';
    var rows = result.templates.slice();
    if (historicalId && !rows.some(function (item) { return item.id === historicalId; })) {
      rows.push({ id: historicalId, title: '历史模板', requiredTier: normalizedCurrent.selection.tierAtSelection, locked: true, preview: false, outline: '历史选择保留为受限元数据。' });
    }
    select.innerHTML = rows.map(function (item) {
      var historical = !!(historicalId && item.id === historicalId && !templateSelectionDirty);
      return '<option value="' + App.escapeHtml(item.id) + '"' + (item.locked && !historical ? ' disabled' : '') + ' title="' + App.escapeHtml(item.outline || '') + '">' + App.escapeHtml(templateLabel(item, historical)) + '</option>';
    }).join('');
    var wanted = historicalId || 'manual-session-v1';
    var option = Array.prototype.find.call(select.options, function (candidate) { return candidate.value === wanted; });
    select.value = option ? wanted : 'manual-session-v1';
    var selected = rows.find(function (item) { return item.id === select.value; });
    var selectedIsLocked = !!(selected && selected.locked && !templateSelectionDirty);
    customWrap.hidden = !selected || selected.id !== 'flagship-session-v1';
    customInput.value = normalizedCurrent && normalizedCurrent.ok ? (normalizedCurrent.selection.customTemplateId || '') : '';
    customInput.disabled = selectedIsLocked;
    select.setAttribute('aria-describedby', 'session-template-status');
    status.className = 'session-template-status' + (templateSelectionFailure ? ' error' : (selectedIsLocked ? ' locked' : ''));
    if (templateSelectionFailure) {
      status.textContent = '模板选择保存失败，当前记录已保留；请重试。';
    } else if (selectedIsLocked) {
      status.textContent = '历史模板当前不可用，已保留原选择，不会自动改写。可改用当前可用模板。';
    } else if (result.access && result.access.trial) {
      status.textContent = '当前为 AI 试用：付费模板仅供预览，不能写入会谈。';
    } else if (templateSelectionDirty) {
      status.textContent = '本次选择将在保存记录时写入。';
    } else {
      status.textContent = '选择会谈记录的结构；模板正文不会写入选择快照。';
    }
    if (plans) plans.hidden = !rows.some(function (item) { return item.locked && !item.preview; });
    if (window.IconSystem) window.IconSystem.render(bar);
  }

  function chooseTemplateFromControl() {
    var select = document.getElementById('session-template-select');
    var customInput = document.getElementById('session-custom-template-id');
    var vm = templateViewModel();
    if (!select || !vm || typeof vm.createSelection !== 'function') return false;
    var selectedId = select.value || 'manual-session-v1';
    var result = vm.createSelection(selectedId, {
      licenseState: templateLicenseState(),
      context: 'individual',
      customTemplateId: selectedId === 'flagship-session-v1' && customInput ? customInput.value : '',
    });
    if (!result || !result.ok) {
      templateSelectionFailure = { code: result && result.code ? result.code : 'template-selection-invalid' };
      renderSessionTemplateControl();
      App.showToast('当前模板不可用，请选择可用模板', 'warning');
      return false;
    }
    currentTemplateSelection = result.selection;
    templateSelectionDirty = true;
    templateSelectionFailure = null;
    renderSessionTemplateControl();
    return true;
  }

  function prepareTemplateSelectionForSave() {
    if (currentSessionId && !templateSelectionDirty) return { ok: true, selection: null };
    if (!currentTemplateSelection) currentTemplateSelection = defaultTemplateSelection();
    if (!templateSelectionDirty && currentSessionId) return { ok: true, selection: null };
    var select = document.getElementById('session-template-select');
    var customInput = document.getElementById('session-custom-template-id');
    if (select && !chooseTemplateFromControl()) return { ok: false, error: { code: 'XJ_NOTES_TEMPLATE_INVALID', message: '模板选择不可用' } };
    return { ok: true, selection: currentTemplateSelection };
  }

  function bindTemplateControls() {
    if (templateControlsBound) return;
    templateControlsBound = true;
    var select = document.getElementById('session-template-select');
    var customInput = document.getElementById('session-custom-template-id');
    var plans = document.getElementById('session-template-plans');
    if (select) select.addEventListener('change', chooseTemplateFromControl);
    if (customInput) customInput.addEventListener('change', chooseTemplateFromControl);
    if (plans) plans.addEventListener('click', function () { if (App && typeof App.openPlans === 'function') App.openPlans(); });
    if (App && typeof App.onLicenseStateChange === 'function') App.onLicenseStateChange(renderSessionTemplateControl);
  }

  function renderClinicalTaskContext() {
    var section = document.getElementById('clinical-task-context');
    var list = document.getElementById('clinical-task-list');
    var summary = document.getElementById('clinical-task-summary');
    if (!section || !list || !summary) return;

    list.innerHTML = '';
    summary.textContent = '';
    if (!currentClientId || !currentSessionId) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    if (!window.ClinicalTaskViewModel || typeof window.ClinicalTaskViewModel.project !== 'function' ||
        typeof Store.getClinicalTasksByClient !== 'function' || typeof Store.getSession !== 'function') {
      summary.textContent = '暂时无法读取';
      list.innerHTML = '<div class="clinical-task-error" role="status">任务上下文暂时不可用，请稍后重试。</div>';
      return;
    }

    var selectedSession = Store.getSession(currentSessionId);
    if (!selectedSession || String(selectedSession.clientId || '') !== currentClientId) {
      summary.textContent = '会谈不可用';
      list.innerHTML = '<div class="clinical-task-error" role="status">当前会谈不存在或不属于该来访者，任务上下文已关闭。</div>';
      return;
    }

    var projected;
    try {
      projected = window.ClinicalTaskViewModel.project(
        Store.getClinicalTasksByClient(currentClientId),
        currentClientId,
        currentSessionId,
        { allowLaterSession: true }
      );
    } catch (error) {
      projected = null;
    }
    if (!projected || projected.ok !== true || !projected.value || !Array.isArray(projected.value.active)) {
      summary.textContent = '投影失败';
      list.innerHTML = '<div class="clinical-task-error" role="status">任务上下文读取失败，当前记录内容未受影响。</div>';
      return;
    }

    var invalidOrigins = 0;
    var rows = projected.value.active.map(function (task) {
      var origin = typeof Store.getSession === 'function' ? Store.getSession(task.originSessionId) : null;
      if (!origin || String(origin.clientId || '') !== currentClientId) {
        invalidOrigins += 1;
        return '';
      }
      var isCurrent = task.originSessionId === currentSessionId;
      var originLabel = isCurrent
        ? '本节创建'
        : '源自第' + (origin.sessionNumber || '?') + '节' + (origin.date ? ' · ' + origin.date : '');
      var statusLabel = task.status === 'ai-draft' ? '待确认' : '跟进中';
      var statusClass = task.status === 'ai-draft' ? 'clinical-task-state draft' : 'clinical-task-state';
      var dueLabel = task.due ? ' · 截止 ' + task.due : '';
      return '<div class="clinical-task-item" data-clinical-task-id="' + App.escapeHtml(task.id) + '">' +
        '<div><div class="clinical-task-title">' + App.escapeHtml(task.title) + '</div>' +
        '<div class="clinical-task-meta">' + App.escapeHtml(originLabel + dueLabel) + '</div></div>' +
        '<span class="' + statusClass + '">' + statusLabel + '</span></div>';
    }).filter(Boolean);

    summary.textContent = rows.length + ' 项活动任务' + (invalidOrigins ? '，' + invalidOrigins + ' 项来源不可用' : '');
    list.innerHTML = rows.length
      ? rows.join('')
      : '<div class="clinical-task-empty">当前会谈没有可继续跟进的活动任务。</div>';
  }

  window.renderClinicalTaskContext = renderClinicalTaskContext;

  function setWorkflow(workflow, persist) {
    currentWorkflow = workflow === 'quick' ? 'quick' : 'structured';
    var left = document.getElementById('left-pane');
    if (left) left.classList.toggle('quick-mode', currentWorkflow === 'quick');
    document.querySelectorAll('#record-workflow button[data-workflow]').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.workflow === currentWorkflow); });
    if (currentWorkflow === 'quick') setRecordMode('apa', false);
    if (persist && currentClientId) {
      var c = Store.getClient(currentClientId);
      Store.updateClient(currentClientId, { preferences: Object.assign({}, (c && c.preferences) || {}, { lastNoteMode: currentWorkflow === 'quick' ? 'quick' : currentMode }) });
    }
  }

  function setRecordMode(mode, persist) {
    if (['apa', 'soap', 'dap', 'free'].indexOf(mode) < 0) mode = 'apa';
    currentMode = mode;
    document.querySelectorAll('.prompt-strip .chip').forEach(function (chip) { chip.classList.toggle('active', chip.dataset.mode === currentMode); });
    ['apa', 'soap', 'dap', 'free'].forEach(function (m) { var pane = document.getElementById('pane-' + m); if (pane) pane.style.display = m === currentMode ? '' : 'none'; });
    if (persist && currentWorkflow === 'structured' && currentClientId) {
      var c = Store.getClient(currentClientId);
      Store.updateClient(currentClientId, { preferences: Object.assign({}, (c && c.preferences) || {}, { lastNoteMode: currentMode }) });
    }
  }

  function loadClients() {
    var sel = document.getElementById('sel-client');
    allClients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    var clients = allClients;
    sel.innerHTML = '<option value="">选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
    initClientSearch();
  }

  function initClientSearch() {
    var search = document.getElementById('client-search');
    var dropdown = document.getElementById('client-dropdown');
    if (!search || !dropdown) return;

    search.addEventListener('input', function () {
      var q = (search.value || '').toLowerCase();
      var matched = allClients.filter(function (c) {
        return c.name.toLowerCase().indexOf(q) >= 0 || (c.phone && c.phone.indexOf(q) >= 0);
      });
      if (matched.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      dropdown.innerHTML = matched.map(function (c) {
        return '<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px" data-id="' + c.id + '" onmouseenter="this.style.background=\'var(--accent-soft)\'" onmouseleave="this.style.background=\'\'" onclick="selectClient(\'' + c.id + '\')">' +
          '<div style="width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px">' + (c.name || '?')[0] + '</div>' +
          '<div><div style="font-size:13px;font-weight:600;color:var(--ink)">' + App.escapeHtml(c.name) + '</div>' + (c.phone ? '<div style="font-size:11px;color:var(--ink-3)">' + App.escapeHtml(c.phone) + '</div>' : '') + '</div>' +
        '</div>';
      }).join('');
      dropdown.style.display = '';
    });

    search.addEventListener('focus', function () {
      if (!search.value) {
        dropdown.innerHTML = allClients.map(function (c) {
          return '<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px" data-id="' + c.id + '" onmouseenter="this.style.background=\'var(--accent-soft)\'" onmouseleave="this.style.background=\'\'" onclick="selectClient(\'' + c.id + '\')">' +
            '<div style="width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px">' + (c.name || '?')[0] + '</div>' +
            '<div><div style="font-size:13px;font-weight:600;color:var(--ink)">' + App.escapeHtml(c.name) + '</div>' + (c.phone ? '<div style="font-size:11px;color:var(--ink-3)">' + App.escapeHtml(c.phone) + '</div>' : '') + '</div>' +
          '</div>';
        }).join('');
        dropdown.style.display = '';
      }
    });

    document.addEventListener('click', function (e) {
      if (!search || !dropdown) return;
      if (!search.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  window.selectClient = function (id) {
    currentClientId = id;
    if (currentClientId && App.setActiveClientId) App.setActiveClientId(currentClientId);
    var search = document.getElementById('client-search');
    var dropdown = document.getElementById('client-dropdown');
    var c = allClients.find(function (x) { return x.id === id; });
    if (search && c) search.value = c.name;
    if (dropdown) dropdown.style.display = 'none';
    onClientChange();
  };

  // 选择来访者：填充会话下拉并显示上传/导出入口
  window.onClientChange = function () {
    summaryRequestVersion += 1;
    var sel = document.getElementById('sel-client');
    currentClientId = sel.value || currentClientId;
    if (currentClientId && App.setActiveClientId) App.setActiveClientId(currentClientId);
    currentSessionId = null;
    currentTemplateSelection = defaultTemplateSelection();
    templateSelectionDirty = !!currentClientId;
    templateSelectionFailure = null;
    renderNoteSummary('');
    var sessSel = document.getElementById('sel-session');
    var upBtn = document.getElementById('btn-upload-transcript');
    var exBtn = document.getElementById('btn-export');
    if (!currentClientId) {
      sessSel.style.display = 'none';
      upBtn.style.display = 'none';
      exBtn.style.display = 'none';
      renderSessionTemplateControl();
      renderClinicalTaskContext();
      return;
    }
    var c = Store.getClient(currentClientId);
    addXjMsg('ai', '已选择 ' + c.name + '。可选「来访者会话」继续编辑某节次，或直接在下方新建记录；我可以帮你展开任何一条。');
    var sessions = Store.getSessionsForPicker(currentClientId).sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });
    sessSel.innerHTML = '<option value="">选择来访者会话…</option>' + sessions.map(function (s) {
      var tag = s.hasTranscript ? '（逐字稿）' : (s.hasSoap ? '（SOAP）' : (s.hasDap ? '（DAP）' : ''));
      return '<option value="' + s.id + '">第' + s.sessionNumber + '节 ' + (s.date || '') + tag + '</option>';
    }).join('');
    sessSel.style.display = '';
    upBtn.style.display = '';
    exBtn.style.display = '';
    var preferred = (c.preferences && c.preferences.lastNoteMode) || 'quick';
    setWorkflow(preferred === 'quick' ? 'quick' : 'structured', false);
    if (preferred !== 'quick') setRecordMode(preferred, false);
    updateContextLabel();
    renderSessionTemplateControl();
    renderClinicalTaskContext();
    if (!suppressClientDraftRestore) restoreDraft();
  };

  // 选择已有会话：把该节次内容载入编辑区（按记录类型匹配模式）
  window.onSessionChange = function () {
    summaryRequestVersion += 1;
    var sessSel = document.getElementById('sel-session');
    currentSessionId = sessSel.value || null;
    renderNoteSummary('');
    // 清空所有编辑区
    ['f1','f2','f3','f4','f5','soap-s','soap-o','soap-a','soap-p','dap-d','dap-a','dap-p','f-free'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    if (!currentSessionId) {
      currentTemplateSelection = defaultTemplateSelection();
      templateSelectionDirty = !!currentClientId;
      templateSelectionFailure = null;
      renderSessionTemplateControl();
      renderClinicalTaskContext();
      return;
    }
    var s = Store.getSession(currentSessionId);
    if (!s) { renderSessionTemplateControl(); renderClinicalTaskContext(); return; }
    renderNoteSummary(s.summary);
    currentTemplateSelection = typeof Store.getSessionTemplateSelection === 'function' ? Store.getSessionTemplateSelection(currentSessionId) : null;
    templateSelectionDirty = !currentTemplateSelection;
    templateSelectionFailure = null;
    if (!currentTemplateSelection) currentTemplateSelection = defaultTemplateSelection();
    // 切换到对应模式并载入
    var target = 'free';
    if (s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan)) { target = 'soap'; }
    else if (s.dap && (s.dap.data || s.dap.assessment || s.dap.plan)) { target = 'dap'; }
    else if (s.transcript) { target = 'free'; document.getElementById('f-free').value = s.transcript; }
    else if (s.notes) {
      // APA 合并文本尝试回填前 5 项
      target = 'apa';
      var parts = (s.notes || '').split('\n').map(function (x) { return x.split(': ')[1] || ''; });
      if (parts.length >= 5) { ['f1','f2','f3','f4','f5'].forEach(function (id, i) { var el = document.getElementById(id); if (el) el.value = parts[i] || ''; }); }
      else { document.getElementById('f-free').value = s.notes; target = 'free'; }
    }
    // 触发模式切换
    setWorkflow('structured', false);
    setRecordMode(target, false);
    updateContextLabel();
    renderSessionTemplateControl();
    renderClinicalTaskContext();
    restoreDraft();
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('session_opened', { summary: '打开了第' + s.sessionNumber + '节记录', relatedClientId: currentClientId });
  };

  // 模式切换
  document.querySelectorAll('.prompt-strip .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      setWorkflow('structured', false);
      setRecordMode(chip.dataset.mode, true);
    });
  });

  document.querySelectorAll('#record-workflow button[data-workflow]').forEach(function (btn) {
    btn.addEventListener('click', function () { setWorkflow(btn.dataset.workflow, true); });
  });

  function addXjMsg(role, text) {
    var chat = document.getElementById('rdock-chat');
    var div = document.createElement('div');
    div.className = 'rmsg ' + role;
    div.innerHTML = App.escapeHtml(text).replace(/\n/g, '<br>');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  // 收集当前编辑区内容（返回 {notes, hasSoap, hasDap, hasTranscript, soap, dap, transcript}）
  function collectCurrent() {
    var notes = '';
    var hasSoap = false, hasDap = false, hasTranscript = false;
    var soap = null, dap = null, transcript = null;
    if (currentMode === 'apa') {
      var d = {
        c1: document.getElementById('f1').value.trim(),
        c2: document.getElementById('f2').value.trim(),
        c3: document.getElementById('f3').value.trim(),
        c4: document.getElementById('f4').value.trim(),
        c5: document.getElementById('f5').value.trim(),
      };
      notes = ['主诉: ' + d.c1, '行为观察: ' + d.c2, '情绪: ' + d.c3, '对话: ' + d.c4, '方向: ' + d.c5].filter(function (x) { return x.split(': ')[1]; }).join('\n');
      hasTranscript = !!d.c4;
    } else if (currentMode === 'soap') {
      var s = document.getElementById('soap-s').value.trim();
      var o = document.getElementById('soap-o').value.trim();
      var a = document.getElementById('soap-a').value.trim();
      var p = document.getElementById('soap-p').value.trim();
      if (!s && !o && !a && !p) return null;
      notes = 'S: ' + s + '\nO: ' + o + '\nA: ' + a + '\nP: ' + p;
      hasSoap = true;
      soap = { subjective: s, objective: o, assessment: a, plan: p };
    } else if (currentMode === 'dap') {
      var dd = document.getElementById('dap-d').value.trim();
      var aa = document.getElementById('dap-a').value.trim();
      var pp = document.getElementById('dap-p').value.trim();
      if (!dd && !aa && !pp) return null;
      notes = 'D: ' + dd + '\nA: ' + aa + '\nP: ' + pp;
      hasDap = true;
      dap = { data: dd, assessment: aa, plan: pp };
    } else {
      notes = document.getElementById('f-free').value.trim();
      if (!notes) return null;
      transcript = notes; // 自由笔记模式写入 transcript 字段，便于报告/督导识别
      hasTranscript = true;
    }
    return { notes: notes, hasSoap: hasSoap, hasDap: hasDap, hasTranscript: hasTranscript, soap: soap, dap: dap, transcript: transcript };
  }

  // silent=true 时为自动保存（不弹 toast、空内容直接跳过）
  // XJ-5.1.9-desensitize-work-style（就地替换版）：点击「就地脱敏」后立刻用脱敏结果
  // 替换当前面板已填写字段（用户裁决）；原文可通过「保存记录」前的撤销/再编辑恢复。
  window.openDesensitize = function () {
    if (typeof XJPIISanitizer === 'undefined' || typeof XJPIISanitizer.maskDocument !== 'function') {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('本地脱敏引擎未就绪', 'error');
      return;
    }
    var rules = {};
    try { rules = JSON.parse(localStorage.getItem('xj_desensitize_custom_rules') || '{}'); } catch (e) { rules = {}; }
    var paneIds = ['pane-apa', 'pane-soap', 'pane-dap', 'pane-free'];
    var total = 0;
    var fields = 0;
    paneIds.forEach(function (paneId) {
      var pane = document.getElementById(paneId);
      if (!pane || pane.style.display === 'none') return;
      pane.querySelectorAll('textarea').forEach(function (ta) {
        var value = (ta.value || '').trim();
        if (!value) return;
        var r = XJPIISanitizer.maskDocument(ta.value, {
          documentName: '咨询记录.md',
          customWords: rules.words || [],
          customPatterns: rules.patterns || [],
          excludeWords: rules.exclude || [],
        });
        if (r.ok && r.report.summary.total_findings > 0) {
          ta.value = r.text;
          fields += 1;
          total += r.report.summary.total_findings;
        }
      });
    });
    if (fields === 0) {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('未命中敏感信息（或记录为空）', 'info');
      return;
    }
    if (typeof App !== 'undefined' && App.showToast) App.showToast('已就地脱敏 ' + total + ' 处（' + fields + ' 个字段）；请检查后保存记录', 'success');
  };


  window.saveNotes = function (silent) {
    return (async function () {
    if (!currentClientId) {
      if (!silent) App.showToast('请先选择来访者', 'warning');
      return false;
    }
    var templatePlan = prepareTemplateSelectionForSave();
    if (!templatePlan.ok) {
      if (!silent) App.showToast('模板选择无效：记录内容尚未保存', 'warning');
      return false;
    }
    var data = collectCurrent();
    if (!data) {
      if (!silent) App.showToast('请至少填写一项', 'warning');
      return false;
    }
    var payload = {
      clientId: currentClientId,
      date: contextDate || App.todayStr(),
      durationMinutes: 0,
      type: 'individual',
      recordKind: 'clinical',
      billing: null,
      notes: data.notes,
      hasTranscript: data.hasTranscript,
      hasSoap: data.hasSoap,
      hasDap: data.hasDap,
    };
    if (data.soap) payload.soap = data.soap;
    if (data.dap) payload.dap = data.dap;
    if (data.transcript) payload.transcript = data.transcript;

    var durableResult = null;
    if (currentSessionId) {
      // 更新已选会话（保留其原 sessionNumber/date 等）
      var existing = Store.getSession(currentSessionId);
      if (existing) {
        try {
          durableResult = await Store.updateSessionFull(Object.assign({}, existing, payload, {
            id: currentSessionId,
            date: existing.date || payload.date,
            startTime: existing.startTime || '',
            endTime: existing.endTime || '',
            durationMinutes: existing.durationMinutes || payload.durationMinutes
          }));
        } catch (e) {
          durableResult = { ok: false, error: { code: 'XJ_NOTES_SESSION_THROW', message: (e && e.message) || String(e) } };
        }
      }
    } else {
      // 修复：保存后锁定到新创建的会话，避免连续点击「保存」反复生成重复节次
      try { durableResult = await Store.createSessionDurable(payload); }
      catch (e) { durableResult = { ok: false, error: { code: 'XJ_NOTES_SESSION_THROW', message: (e && e.message) || String(e) } }; }
      var newId = (durableResult && durableResult.ok && durableResult.value) ? durableResult.value.id : null;
      currentSessionId = newId;
      // 直接刷新会话下拉（不触发 onClientChange，以免重复刷 AI 消息），并选中新建节次
      var sessSel2 = document.getElementById('sel-session');
      if (sessSel2 && newId) {
        var sessions = Store.getSessionsForPicker(currentClientId).sort(function (a, b) {
          return (b.date || '').localeCompare(a.date || '');
        });
        sessSel2.innerHTML = '<option value="">选择来访者会话…</option>' + sessions.map(function (s) {
          var tag = s.hasTranscript ? '（逐字稿）' : (s.hasSoap ? '（SOAP）' : (s.hasDap ? '（DAP）' : ''));
          return '<option value="' + s.id + '">第' + s.sessionNumber + '节 ' + (s.date || '') + tag + '</option>';
        }).join('');
        sessSel2.value = newId;
      }
    }
    if (!durableResult || !durableResult.ok) {
      if (!silent) App.showToast('保存失败：本地草稿已保留，请恢复存储后重试', 'error');
      return false;
    }
    if (templatePlan.selection) {
      var selectionResult;
      try { selectionResult = await Store.saveSessionTemplateSelectionDurable(currentSessionId, templatePlan.selection); }
      catch (e) { selectionResult = { ok: false, error: { code: 'XJ_NOTES_TEMPLATE_THROW', message: (e && e.message) || String(e) } }; }
      if (!selectionResult || !selectionResult.ok) {
        templateSelectionFailure = (selectionResult && selectionResult.error) || { code: 'XJ_NOTES_TEMPLATE_SAVE_FAILED', message: '模板选择保存失败' };
        templateSelectionDirty = true;
        renderSessionTemplateControl();
        if (!silent) App.showToast('记录内容已保存，但模板选择未完成；请恢复存储后重试', 'error');
        return false;
      }
      currentTemplateSelection = selectionResult.value || templatePlan.selection;
      templateSelectionDirty = false;
      templateSelectionFailure = null;
    }
    clearDraft();
    updateContextLabel();
    renderSessionTemplateControl();
    renderClinicalTaskContext();
    if (!silent) {
      var saved = currentSessionId ? Store.getSession(currentSessionId) : null;
      var client = Store.getClient(currentClientId);
      var complete = document.getElementById('note-complete');
      var text = document.getElementById('note-complete-text');
      if (complete && text && saved && client) {
        text.textContent = '已保存到：' + client.name + ' · 第' + saved.sessionNumber + '节 · ' + (saved.date || App.todayStr());
        complete.classList.add('show');
      }
      renderNoteSummary(saved && saved.summary);
      App.showToast('已保存', 'success');
    }
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('session_saved', { summary: '保存了咨询记录', relatedClientId: currentClientId });
    return true;
    })();
  };

  window.sendToXj = function () {
    var input = document.getElementById('rdock-input');
    var text = (input.value || '').trim();
    if (!text) return;
    addXjMsg('me', text);
    input.value = '';
    // 调用 AI
    if (!App.featureGate('ai-notes')) { addXjMsg('ai', 'AI 功能需激活后使用。'); return; }
    addXjMsg('ai', '思考中…');
    var orient = '温尼科特取向';
    var sys = '你是心理咨询师的小镜助手，温尼科特取向。请用中文简短回应咨询师的问题，帮助梳理临床材料。';
    var userContent = text;
    // 附带当前编辑区内容
    var currentText = '';
    if (currentMode === 'apa') {
      currentText = [document.getElementById('f1').value, document.getElementById('f2').value, document.getElementById('f3').value, document.getElementById('f4').value, document.getElementById('f5').value].filter(Boolean).join('\n');
    } else if (currentMode === 'soap') {
      currentText = [document.getElementById('soap-s').value, document.getElementById('soap-o').value, document.getElementById('soap-a').value, document.getElementById('soap-p').value].filter(Boolean).join('\n');
    } else if (currentMode === 'dap') {
      currentText = [document.getElementById('dap-d').value, document.getElementById('dap-a').value, document.getElementById('dap-p').value].filter(Boolean).join('\n');
    } else {
      currentText = document.getElementById('f-free').value;
    }
    if (currentText) userContent += '\n\n--- 当前记录 ---\n' + currentText;
    var msgs = [{ role: 'system', content: sys }, { role: 'user', content: userContent }];
    var chat = document.getElementById('rdock-chat');
    var lastMsg = chat.lastElementChild;
    if (typeof AI !== 'undefined' && AI.send) {
      AI.send(msgs, function (res) {
        if (lastMsg) lastMsg.remove();
        if (res && res.content) addXjMsg('ai', res.content);
        else addXjMsg('ai', '生成失败，请重试。');
      }, { onDelta: function (piece, fullText) { if (lastMsg) { lastMsg.textContent = fullText || piece || ''; } } });
    } else {
      if (lastMsg) lastMsg.remove();
      addXjMsg('ai', 'AI 模块未就绪，请重启应用。');
    }
  };

  // ---------- 上传逐字稿 + AI 分析（会员功能） ----------
  window.onTranscriptUpload = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    // P0#5 修复：逐字稿上传/读取是 Manual Free，不门控；仅 AI 分析部分需要权益
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); event.target.value = ''; return; }
    App.showToast('正在读取逐字稿…', 'info');
    var reader = new FileReader();
    var onText = async function (text) {
      // 写入当前会话的 transcript（无选中会话则新建一条逐字稿会话）
      if (currentSessionId) {
        var ex = Store.getSession(currentSessionId);
        if (ex) {
          var updated = await Store.updateSessionFull(Object.assign({}, ex, { transcript: text, hasTranscript: true }));
          if (!updated || !updated.ok) { App.showToast('逐字稿保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
        }
      } else {
        var r = await Store.createSessionDurable({
          clientId: currentClientId, date: App.todayStr(), durationMinutes: 0, type: 'individual',
          recordKind: 'clinical', billing: null, transcript: text, hasTranscript: true, notes: '',
        });
        if (!r || !r.ok || !r.value) { App.showToast('逐字稿保存失败：草稿已保留，请恢复存储后重试', 'error'); return; }
        currentSessionId = r.value.id;
        // 刷新会话下拉，标记逐字稿
        onClientChange();
        var sessSel = document.getElementById('sel-session');
        if (sessSel) sessSel.value = currentSessionId || '';
      }
      // 切到自由笔记模式展示内容
      var chip = document.querySelector('.prompt-strip .chip[data-mode="free"]');
      if (chip) chip.click();
      document.getElementById('f-free').value = text;
      App.showToast('逐字稿已载入', 'success');
      // P0#5 修复：AI 分析单独门控 ai-analyze，上传本身是 Free
      if (App.featureGate('ai-analyze')) {
        aiAnalyzeTranscript(text);
      } else {
        App.showToast('AI 分析需会员及以上方案，逐字稿已保存至会话。', 'warning');
      }
    };
    if (file.name.toLowerCase().endsWith('.docx')) {
      if (typeof mammoth !== 'undefined') {
        reader.onload = function (ev) {
          mammoth.extractRawText({ arrayBuffer: ev.target.result }).then(function (r) { onText(r.value); }).catch(function () { App.showToast('docx 解析失败，请贴入文本', 'error'); });
        };
        reader.readAsArrayBuffer(file);
      } else { App.showToast('docx 解析库未加载，请手动粘贴', 'warning'); }
    } else {
      reader.onload = function (ev) { onText(ev.target.result); };
      reader.readAsText(file, 'UTF-8');
    }
    event.target.value = '';
  };

  function aiAnalyzeTranscript(text) {
    App.showToast('AI 分析中…', 'info');
    var sys = '你是心理咨询督导分析专家。请分析以下逐字稿，输出 JSON 格式：\n' +
      '{"clientName":"来访者姓名","keyIssues":["核心议题1","核心议题2"],"supervisorTechniques":["督导师使用的技术1","技术2"],"knowledgeSource":"对应的理论/知识来源","suggestions":["给咨询师的建议"]}\n只输出 JSON，不要其他文字。';
    var ud = (typeof window !== 'undefined' && window.UserDocs && window.UserDocs.getContextBlock) ? window.UserDocs.getContextBlock() : '';
    if (ud) sys += '\n\n' + ud;
    var streamMsg = addXjMsg('ai', '正在流式分析…');
    AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
      if (res && res.content && !res.error) {
        try {
          var json = JSON.parse(res.content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
          var summary = '【AI 逐字稿分析结果】\n\n';
          summary += '来访者：' + (json.clientName || '未识别') + '\n';
          summary += '\n核心议题：\n' + (json.keyIssues || []).map(function (s) { return '· ' + s; }).join('\n');
          summary += '\n\n督导师技术：\n' + (json.supervisorTechniques || []).map(function (s) { return '· ' + s; }).join('\n');
          summary += '\n\n知识来源：' + (json.knowledgeSource || '未识别');
          summary += '\n\n建议：\n' + (json.suggestions || []).map(function (s) { return '· ' + s; }).join('\n');
          // 把分析结果追加进自由笔记区，便于保存进数据库
          var ta = document.getElementById('f-free');
          if (ta) { ta.value = (ta.value ? ta.value + '\n\n' : '') + summary; ta.dispatchEvent(new Event('input', { bubbles: true })); }
          addXjMsg('ai', summary);
          App.showToast('AI 分析完成，结果已填入笔记区', 'success');
        } catch (e) {
          App.showToast('AI 返回格式异常', 'error');
        }
      } else {
        App.showToast('AI 分析失败', 'error');
      }
    }, { onDelta: function (piece, fullText) { if (streamMsg) { streamMsg.textContent = fullText || piece || ''; } } });
  }

  // ---------- AI 根据逐字稿填写本页（会员功能）----------
  window.aiFillPage = function () {
    if (!App.featureGate('ai-notes')) {
      App.showToast('AI 填写需激活会员后使用', 'warning');
      return;
    }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    // 1) 定位已加载的逐字稿
    var transcript = null;
    if (currentSessionId) {
      var s0 = Store.getSession(currentSessionId);
      if (s0 && s0.transcript && s0.transcript.trim()) transcript = s0.transcript;
    }
    if (!transcript) {
      var sessions = Store.getSessionsByClient(currentClientId) || [];
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i].transcript && sessions[i].transcript.trim()) {
          transcript = sessions[i].transcript;
          currentSessionId = sessions[i].id;
          var sessSel = document.getElementById('sel-session');
          if (sessSel) {
            var exists = [].some.call(sessSel.options, function (o) { return o.value === currentSessionId; });
            if (!exists) onClientChange();
            sessSel.value = currentSessionId;
          }
          break;
        }
      }
    }
    if (!transcript || !transcript.trim()) {
      App.showToast('未找到逐字稿，请先上传逐字稿', 'warning');
      var up = document.getElementById('transcript-file');
      if (up) up.click(); // 直接唤起上传对话框
      return;
    }
    // 2) 按当前模式构造字段要求并调 AI
    var fieldsMap = {
      apa: { keys: ['c1','c2','c3','c4','c5'], map: { c1:'f1', c2:'f2', c3:'f3', c4:'f4', c5:'f5' }, desc: 'c1=主诉与咨询目标；c2=行为观察与非言语信息；c3=情绪状态与情感反应；c4=关键对话片段（尽量还原原话）；c5=下次咨询方向' },
      soap: { keys: ['s','o','a','p'], map: { s:'soap-s', o:'soap-o', a:'soap-a', p:'soap-p' }, desc: 's=主观资料(Subjective)；o=客观资料(Objective)；a=评估(Assessment)；p=计划(Plan)' },
      dap: { keys: ['d','a','p'], map: { d:'dap-d', a:'dap-a', p:'dap-p' }, desc: 'd=资料(Data)；a=评估(Assessment)；p=计划(Plan)' },
      free: { keys: ['text'], map: { text:'f-free' }, desc: 'text=整段自由笔记（基于逐字稿的梳理与反思）' },
    };
    var f = fieldsMap[currentMode] || fieldsMap.free;
    App.showToast('AI 正在根据逐字稿填写本页…', 'info');
    addXjMsg('ai', '正在根据逐字稿填写「' + currentMode.toUpperCase() + '」本页…');
    var sys = '你是心理咨询记录填写助手，温尼科特取向。请根据提供的咨询逐字稿，按 ' + currentMode.toUpperCase() + ' 格式填写以下字段。字段含义：' + f.desc + '。\n只输出 JSON（不要任何额外文字），键必须为：' + f.keys.join(',') + '，值为对应文字内容。若某字段在逐字稿中无依据，填空字符串。';
    AI.send([{ role: 'system', content: sys }, { role: 'user', content: transcript }], function (res) {
      if (res && res.content && !res.error) {
        try {
          var j = JSON.parse(res.content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
          f.keys.forEach(function (k) {
            var ta = document.getElementById(f.map[k]);
            if (ta && j[k] != null && String(j[k]).trim() !== '') {
              if (currentMode === 'free') {
                ta.value = (ta.value ? ta.value + '\n\n' : '') + String(j[k]);
              } else {
                ta.value = String(j[k]);
              }
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
          });
          App.showToast('已根据逐字稿填写本页', 'success');
        } catch (e) {
          App.showToast('AI 返回格式异常，请重试', 'error');
        }
      } else {
        App.showToast('AI 填写失败', 'error');
      }
    }, { onDelta: function (piece, fullText) {
      var preview = document.getElementById('rdock-chat');
      var node = preview && preview.lastElementChild;
      if (node) node.textContent = fullText || piece || '';
    } });
  };

  // ---------- 导出当前编辑内容 ----------
  window.exportNotes = function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var c = Store.getClient(currentClientId);
    var data = collectCurrent();
    var content = data && data.notes ? data.notes : (document.querySelector('.prompt-strip .chip.active') ? '' : '');
    // 兜底：直接读编辑区
    if (!content) {
      var ids = currentMode === 'soap' ? ['soap-s','soap-o','soap-a','soap-p']
        : currentMode === 'dap' ? ['dap-d','dap-a','dap-p']
        : currentMode === 'apa' ? ['f1','f2','f3','f4','f5']
        : ['f-free'];
      content = ids.map(function (id) { var el = document.getElementById(id); return el ? el.value : ''; }).filter(Boolean).join('\n');
    }
    if (!content.trim()) { App.showToast('当前没有可导出的内容', 'warning'); return; }
    var body = '<h1>' + App.escapeHtml(c.name) + ' 咨询记录（' + App.todayStr() + '）</h1><pre>' + App.escapeHtml(content) + '</pre>';
    App.exportWordDoc((c.name || 'client') + '_咨询记录.doc', body);
    App.showToast('已导出 Word 文档', 'success');
  };

  // ---------- 离开 / 跳转：自动保存 ----------
  function autoSaveSilent() { try { saveDraft(); } catch (e) {} }
  window.leavePage = function () { autoSaveSilent(); location.href = 'index.html'; };
  window.finishAndGoReport = async function () {
    if (await saveNotes(false)) location.href = 'report-writing.html?clientId=' + encodeURIComponent(currentClientId || '') + '&sessionId=' + encodeURIComponent(currentSessionId || '');
  };

  window.scheduleNextSession = function () {
    if (!currentClientId) return;
    location.href = 'session-calendar.html?clientId=' + encodeURIComponent(currentClientId) + '&new=1';
  };
  window.openCurrentBilling = function () {
    if (!currentClientId) return;
    location.href = 'billing-shell.html?clientId=' + encodeURIComponent(currentClientId);
  };
  window.openCurrentSupervision = function () {
    if (!currentClientId) return;
    location.href = 'supervision.html?clientId=' + encodeURIComponent(currentClientId) + '&sessionId=' + encodeURIComponent(currentSessionId || '');
  };
  window.generateNoteSummary = function () {
    var data = collectCurrent();
    if (!currentSessionId || !data || !data.notes) { App.showToast('请先保存含内容的咨询记录', 'warning'); return; }
    var requestClientId = currentClientId;
    var requestSessionId = currentSessionId;
    if (!App.featureGate('ai-notes') || typeof AI === 'undefined' || !AI.send) { App.showToast('生成摘要需激活 AI 功能', 'warning'); return; }
    var requestVersion = ++summaryRequestVersion;
    App.showToast('正在生成会谈摘要…', 'info');
    AI.send([{ role: 'system', content: '你是心理咨询记录助手。基于输入记录生成一段简洁、非诊断性的会谈摘要，只陈述已有材料，不补充事实。' }, { role: 'user', content: data.notes }], async function (res) {
      if (!res || res.error || !res.content) { App.showToast('生成摘要失败，请重试', 'error'); return; }
      if (requestVersion !== summaryRequestVersion || currentClientId !== requestClientId || currentSessionId !== requestSessionId) {
        App.showToast('会谈已切换，已丢弃旧摘要结果', 'warning');
        return;
      }
      var summary = String(res.content).trim();
      if (!summary) { App.showToast('模型返回了空摘要，请重试', 'error'); return; }
      // 先展示真实生成结果，避免持久化异常让用户只看到加载状态消失。
      renderNoteSummary(summary);
      var box = document.getElementById('note-summary');
      var status = box && box.querySelector('.note-summary-status');
      if (status) status.textContent = '正在保存到本次会谈…';
      var s = Store.getSession(requestSessionId);
      if (!s) {
        if (status) status.textContent = '未找到本次会谈，摘要仅保留在当前页面';
        App.showToast('未找到本次会谈，摘要未写入本地', 'error');
        return;
      }
      var saved;
      try {
        saved = await Store.updateSessionFull(Object.assign({}, s, { summary: summary }));
      } catch (error) {
        if (status) status.textContent = '保存失败，摘要仍在页面；请重试保存';
        App.showToast('会谈摘要保存失败：摘要已保留，请恢复存储后重试', 'error');
        return;
      }
      if (!saved || saved.ok !== true) {
        if (status) status.textContent = '保存失败，摘要仍在页面；请重试保存';
        App.showToast('会谈摘要保存失败：摘要已保留，请恢复存储后重试', 'error');
        return;
      }
      if (status) status.textContent = '已保存到本次会谈';
      renderNoteSummary(saved.value && saved.value.summary ? saved.value.summary : summary);
      App.showToast('会谈摘要已保存', 'success');
    }, { onDelta: function (piece, fullText) { renderNoteSummary(fullText || piece || ''); } });
  };

  App.initPage({ title: '咨询记录', subtitle: '', actions: '', onReady: function () {
    bindTemplateControls();
    loadClients();
    // P0 REPAIR 02: 动态设置 AI 填写按钮的 Pro/会员锁标识
    try {
      var aiFillLock = document.getElementById('ai-fill-lock');
      if (aiFillLock && typeof App !== 'undefined' && typeof App.lockBadge === 'function') {
        aiFillLock.innerHTML = App.lockBadge('ai-notes');
        if (window.IconSystem) window.IconSystem.render(aiFillLock);
      }
    } catch (e) { /* ignore */ }
    // 支持从咨询日历跳转：?client=ID&session=ID 自动预选来访者与会话
    try {
      var params = new URLSearchParams(location.search);
      var pClient = params.get('clientId') || params.get('client') || (App.getActiveClientId && App.getActiveClientId());
      var pSession = params.get('sessionId') || params.get('session');
      contextDate = params.get('date') || '';
      var requestedMode = params.get('mode');
      if (pClient) {
        suppressClientDraftRestore = !!pSession;
        var sel = document.getElementById('sel-client');
        if (sel) { sel.value = pClient; onClientChange(); }
        suppressClientDraftRestore = false;
        var c = allClients.find(function (x) { return x.id === pClient; });
        var search = document.getElementById('client-search');
        if (search && c) search.value = c.name;
        if (pSession) {
          var ss = document.getElementById('sel-session');
          if (ss) { ss.value = pSession; onSessionChange(); }
        }
        if (requestedMode === 'quick') setWorkflow('quick', false);
      }
    } catch (e) {}
    // 离开页面（关闭/刷新）自动保存当前草稿
    window.addEventListener('beforeunload', autoSaveSilent);
    // 自动保存：每隔 30 秒检查一次变化并保存
    var textareas = document.querySelectorAll('.left textarea');
    textareas.forEach(function (ta) {
      ta.addEventListener('input', function () {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(function () {
          try {
            var current = collectCurrentContent();
            if (current !== lastSavedContent && current.trim()) {
              saveDraft();
              lastSavedContent = current;
            }
          } catch (e) {}
        }, 30000);
      });
    });
  }});

  function collectCurrentContent() {
    if (currentMode === 'apa') {
      return [document.getElementById('f1').value, document.getElementById('f2').value, document.getElementById('f3').value, document.getElementById('f4').value, document.getElementById('f5').value].join('\n');
    } else if (currentMode === 'soap') {
      return [document.getElementById('soap-s').value, document.getElementById('soap-o').value, document.getElementById('soap-a').value, document.getElementById('soap-p').value].join('\n');
    } else if (currentMode === 'dap') {
      return [document.getElementById('dap-d').value, document.getElementById('dap-a').value, document.getElementById('dap-p').value].join('\n');
    } else {
      return document.getElementById('f-free').value || '';
    }
  }
})();
