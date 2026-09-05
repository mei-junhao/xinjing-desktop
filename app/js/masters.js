/* 心镜 XinJing · 大师对话（方案D：左列表+中对话+右历史，拉齐Chat圆桌逻辑）
   - temperature: 0.7 (round1) / 0.6 (react/summary) — 与 Chat 项目一致
   - max_tokens: 512 (round1) / 400 (react) / 600 (summary) — 与 Chat 项目一致
   - 圆桌规则：独立回应、看不到别人、150字、可对其他大师说话 — 与 Chat 项目一致
   - 串行：过滤自己发言、600ms延迟、温尼科特summary、空格跳过 — 与 Chat 项目一致
   - @mention：其他人回应被@的大师 → 被@大师总结 — 与 Chat 项目一致
   ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var mode = '1v1';
  var currentConv = null;
  var roundKeys = [];
  var busy = false;
  var activeController = null;
  var retryState = null;
  var convList = [];
  var includeUserDocs = true;
  var masterSearchQuery = '';
  var masterSchool = '';
  var MAX_HISTORY_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
  // 温度滑块：每位大师独立存储，圆桌模式无滑块
  var talkTemp = 60;
  var talkDetail = 50;
  function loadTemp(key) {
    try { var v = localStorage.getItem('mc_temp_' + key); if (v != null) talkTemp = parseInt(v, 10) || 60; } catch(e) {}
    try { var d = localStorage.getItem('mc_detail_' + key); if (d != null) talkDetail = parseInt(d, 10) || 50; } catch(e) {}
    var slider = document.getElementById('temp-slider');
    if (slider) { slider.value = talkTemp; slider.parentElement.style.display = key ? '' : 'none'; }
    var dslider = document.getElementById('detail-slider');
    if (dslider) { dslider.value = talkDetail; }
  }
  function saveTemp(key) {
    try { localStorage.setItem('mc_temp_' + key, talkTemp); } catch(e) {}
    try { localStorage.setItem('mc_detail_' + key, talkDetail); } catch(e) {}
  }
  window.onTempChange = function (val) {
    talkTemp = parseInt(val, 10) || 60;
    if (currentConv && currentConv.mode === '1v1') saveTemp(currentConv.masterKeys[0]);
  };
  window.onDetailChange = function (val) {
    talkDetail = parseInt(val, 10) || 50;
    if (currentConv && currentConv.mode === '1v1') saveTemp(currentConv.masterKeys[0]);
  };

  function genId() { return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowISO() { return new Date().toISOString(); }
  function masterName(key) { var m = getMasterByKey(key); return m ? m.name : key; }
  function accentOf(m) { var map = { accent: 'var(--accent)', purple: 'var(--purple)', blue: 'var(--blue)', green: 'var(--green)', orange: 'var(--orange)', indigo: 'var(--indigo)', red: 'var(--red)' }; return map[m.accent] || 'var(--accent)'; }

  function updateContextPanels() {
    var title = $('context-title');
    var sub = $('context-sub');
    var modeEl = $('context-mode');
    var count = $('context-master-count');
    var matrixTitle = $('matrix-title');
    var summary = $('summary-text');
    if (!title || !sub || !modeEl || !count) return;

    if (!currentConv) {
      title.textContent = '未开始对话';
      sub.textContent = mode === '1v1' ? '选择一位大师，或进入圆桌模式开始讨论' : '选择至少两位大师开始讨论';
      modeEl.textContent = mode === '1v1' ? '一对一' : '圆桌';
      count.textContent = mode === '1v1' ? '未选择' : (roundKeys.length ? roundKeys.length + ' 位大师' : '未选择');
      if (matrixTitle) matrixTitle.textContent = '尚未形成观点';
      if (summary) summary.textContent = '开始对话后，这里会保留核心议题、共识和待深入的张力。';
      return;
    }

    var names = currentConv.masterKeys.map(masterName);
    if (currentConv.mode === '1v1') {
      var master = getMasterByKey(currentConv.masterKeys[0]);
      title.textContent = currentConv.messages.length ? (currentConv.messages.find(function (m) { return m.role === 'user'; }) || {}).content || masterName(currentConv.masterKeys[0]) : '与' + masterName(currentConv.masterKeys[0]) + '开始工作';
      sub.textContent = (master ? master.school : '') + ' · 一对一';
      modeEl.textContent = '一对一';
      count.textContent = master ? master.name : names[0];
      if (matrixTitle) matrixTitle.textContent = master ? master.name + ' 的视角' : '大师视角';
    } else {
      title.textContent = currentConv.title || '圆桌研讨';
      sub.textContent = names.length + ' 位大师 · @大师 可指定发言';
      modeEl.textContent = '圆桌';
      count.textContent = names.length + ' 位大师';
      if (matrixTitle) matrixTitle.textContent = currentConv.messages.length ? '本轮观点' : '尚未形成观点';
    }
    if (summary) summary.textContent = currentConv.summary || '对话继续后，系统会自动保留核心议题、共识和待深入的张力。';
  }

  function syncDocsButton() {
    var button = $('btn-use-docs');
    if (!button) return;
    var enabled = currentDocsSetting();
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '本次会话会引用我的资料' : '本次会话不引用我的资料';
    button.classList.toggle('active', enabled);
    var scope = $('source-scope');
    if (scope) scope.textContent = enabled ? '本次可引用资料库' : '仅本次输入';
  }

  function renderViewpoints() {
    var box = $('matrix-body');
    if (!box) return;
    if (!currentConv || !currentConv.messages.length) {
      box.innerHTML = '<div class="viewpoint-empty"><i data-lucide="layers-2"></i><span>大师回应会按视角汇总</span></div>';
      if (window.IconSystem && IconSystem.render) IconSystem.render(box);
      return;
    }
    var replies = currentConv.messages.filter(function (m) {
      return m.role === 'assistant' && m.content && m.status !== 'error' && m.status !== 'streaming';
    }).slice(-3).reverse();
    box.innerHTML = replies.map(function (msg) {
      var m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
      return '<div class="viewpoint-item"><div class="viewpoint-avatar" style="background:' + accentOf(m || {}) + '">' + (m ? m.initial : '师') + '</div><div><strong>' + App.escapeHtml(m ? m.name : '大师') + '</strong><p>' + App.escapeHtml(String(msg.content).slice(0, 100)) + '</p></div></div>';
    }).join('');
    if (window.IconSystem && IconSystem.render) IconSystem.render(box);
  }

  function loadConvs() {
    try { convList = Store.getMasterConversations() || []; } catch (e) { convList = []; }
  }

  function populateSchoolFilter() {
    var select = $('master-school-filter');
    if (!select) return;
    var schools = [];
    (window.MASTERS || []).forEach(function (master) {
      var school = String(master.school || '').trim();
      if (school && schools.indexOf(school) < 0) schools.push(school);
    });
    select.innerHTML = '<option value="">全部学派</option>' + schools.map(function (school) {
      return '<option value="' + App.escapeHtml(school) + '">' + App.escapeHtml(school) + '</option>';
    }).join('');
    select.value = masterSchool;
  }

  function masterMatchesFilters(master) {
    var haystack = (master.name + ' ' + (master.en || '') + ' ' + (master.school || '')).toLowerCase();
    return (!masterSearchQuery || haystack.indexOf(masterSearchQuery) >= 0) &&
      (!masterSchool || master.school === masterSchool);
  }

  // ---------- 大师列表渲染 ----------
  function renderMasterList() {
    var box = $('master-list');
    var list = (window.MASTERS || []).filter(masterMatchesFilters);
    var panel = box.parentElement;
    panel.classList.toggle('mode-round', mode === 'round');
    if (!list.length) {
      box.innerHTML = '<div class="viewpoint-empty"><i data-lucide="search-x"></i><span>没有匹配的理论学派或大师</span></div>';
      if (window.IconSystem && IconSystem.render) IconSystem.render(box);
      return;
    }
    box.innerHTML = list.map(function (m) {
      var sel = mode === '1v1' ? (currentConv && currentConv.mode === '1v1' && currentConv.masterKeys[0] === m.key) : roundKeys.indexOf(m.key) >= 0;
      return '<button class="master-card' + (sel ? ' active' : '') + '" type="button" data-key="' + m.key + '" onclick="onMasterClick(\'' + m.key + '\')">'
        + '<div class="m-avatar" style="background:' + accentOf(m) + '">' + (m.initial || m.emoji || '师') + '</div>'
        + '<div class="m-meta"><div class="m-name">' + m.name + '</div><div class="m-school">' + m.school + '</div></div>'
        + '<div class="m-check"><i data-lucide="check"></i></div></button>';
    }).join('');
  }

  // ---------- 历史列表渲染 ----------
  function renderHistList() {
    var box = $('hist-list');
    if (!box) return;
    var filter = (document.getElementById('history-filter') || {}).value || '';
    filter = filter.trim().toLowerCase();
    var visible = convList.filter(function (c) {
      if (!filter) return true;
      var title = c.title || (c.mode === 'round' ? '圆桌研讨' : masterName(c.masterKeys[0]));
      var preview = c.messages && c.messages.length ? c.messages[0].content || '' : '';
      return (title + ' ' + preview).toLowerCase().indexOf(filter) >= 0;
    });
    if (!visible.length) { box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">暂无匹配对话</div>'; return; }
    box.innerHTML = visible.map(function (c) {
      var title = c.title || (c.mode === 'round' ? '圆桌研讨' : masterName(c.masterKeys[0]));
      var date = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
      var preview = c.messages.length ? (c.messages[0].content || '').slice(0, 20) : '';
      var active = currentConv && c.id === currentConv.id;
      return '<div class="hist-item' + (active ? ' active' : '') + '" onclick="loadHist(\'' + c.id + '\')">'
        + '<div>' + App.escapeHtml(title) + '</div>'
        + '<div>' + date + ' · ' + c.messages.length + '条</div>'
        + (preview ? '<div>' + App.escapeHtml(preview) + '</div>' : '')
        + '<button onclick="deleteConvById(\'' + c.id + '\', event)" title="删除" aria-label="删除"></button>'
        + '</div>';
    }).join('');
  }

  window.loadHist = function (id) {
    var c = convList.find(function (x) { return x.id === id; });
    if (!c) return;
    currentConv = c;
    if (c.mode === 'round') { roundKeys = c.masterKeys.slice(); mode = 'round'; }
    else { mode = '1v1'; }
    syncModeButtons();
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // ---------- 模式切换 ----------
  function syncModeButtons() {
    document.querySelectorAll('#mode-toggle button').forEach(function (button) {
      var active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  window.setMode = function (m) {
    mode = m;
    syncModeButtons();
    currentConv = null; roundKeys = [];
    if (m === 'round') {
      // 多圆桌会话：按更新时间倒序选最近一个
      var rounds = convList.filter(function (c) { return c.mode === 'round'; });
      rounds.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
      var last = rounds[0] || null;
      if (last) { currentConv = last; roundKeys = last.masterKeys.slice(); }
    }
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // 新建圆桌
  window.newRound = function () {
    mode = 'round';
    syncModeButtons();
    currentConv = null; roundKeys = [];
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };
  document.getElementById('mode-toggle').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    window.setMode(btn.dataset.mode);
  });

  document.querySelectorAll('[data-inspector-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var key = tab.dataset.inspectorTab;
      document.querySelectorAll('[data-inspector-tab]').forEach(function (item) {
        var active = item === tab;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('.inspector-view').forEach(function (view) { view.classList.toggle('active', view.id === 'inspector-' + key); });
    });
  });

  function currentDocsSetting() {
    if (currentConv && currentConv.settings && currentConv.settings.includeUserDocs === false) return false;
    return includeUserDocs;
  }

  async function saveConversationOrWarn(conv) {
    var saved = await Store.saveMasterConversationDurable(conv);
    if (!saved || !saved.ok) {
      if (typeof App !== 'undefined' && App.showToast) App.showToast('对话保存失败：草稿仍保留，请恢复存储后重试', 'error');
      return false;
    }
    return true;
  }

  function readHistoryFile(file) {
    return new Promise(function (resolve, reject) {
      var name = String(file && file.name || '');
      var extension = name.split('.').pop().toLowerCase();
      if (['txt', 'md', 'markdown', 'docx'].indexOf(extension) < 0) {
        reject(new Error('仅支持 TXT、Markdown 或 DOCX 文件'));
        return;
      }
      if (Number(file && file.size || 0) > MAX_HISTORY_IMPORT_FILE_BYTES) {
        reject(new Error('历史文件不能超过 2 MB'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      if (extension === 'docx') {
        if (typeof mammoth === 'undefined') { reject(new Error('DOCX 解析组件未就绪')); return; }
        reader.onload = function (event) {
          mammoth.extractRawText({ arrayBuffer: event.target.result }).then(function (result) {
            resolve(result.value || '');
          }).catch(function () { reject(new Error('DOCX 解析失败')); });
        };
        reader.readAsArrayBuffer(file);
        return;
      }
      reader.onload = function (event) { resolve(event.target.result || ''); };
      reader.readAsText(file, 'utf-8');
    });
  }

  window.triggerHistoryImport = function () {
    if (!currentConv) { App.showToast('请先选择一位大师或圆桌，再导入历史对话', 'warning'); return; }
    var input = $('masters-history-file');
    if (input) input.click();
  };

  window.onHistoryImport = async function (event) {
    var input = event && event.target;
    var file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file || !currentConv) return;
    if (typeof MastersCore === 'undefined' || !MastersCore.parseImportedHistory) {
      App.showToast('历史导入组件未就绪', 'error');
      return;
    }
    try {
      var text = await readHistoryFile(file);
      var parsed = MastersCore.parseImportedHistory(text, currentConv.masterKeys && currentConv.masterKeys[0]);
      if (!parsed.messages.length) { App.showToast('文件没有可导入的对话内容', 'warning'); return; }
      var previousMessages = currentConv.messages.slice();
      var previousContext = currentConv.importedContext || '';
      var previousHistory = currentConv.importedHistory || null;
      currentConv.messages = previousMessages.concat([{ role: 'sys', content: '已从「' + file.name + '」导入历史对话；内容只保存在本机，等待你主动继续提问。', ts: Date.now() }], parsed.messages);
      currentConv.importedContext = parsed.importedContext;
      currentConv.importedHistory = {
        sourceName: file.name,
        importedAt: nowISO(),
        sourceChars: parsed.sourceChars,
        messageCount: parsed.messages.length,
        truncated: parsed.truncated,
      };
      if (!await saveConversationOrWarn(currentConv)) {
        currentConv.messages = previousMessages;
        currentConv.importedContext = previousContext;
        currentConv.importedHistory = previousHistory;
        return;
      }
      renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
      App.showToast(parsed.truncated ? '历史已部分导入，内容已按安全上限截断' : '历史对话已导入，可继续向大师提问', 'success');
    } catch (error) {
      App.showToast((error && error.message) || '历史导入失败', 'error');
    }
  };

  async function setDocsSetting(enabled) {
    includeUserDocs = enabled;
    if (currentConv) {
      currentConv.settings = Object.assign({}, currentConv.settings || {}, { includeUserDocs: enabled });
      await saveConversationOrWarn(currentConv);
    }
    var button = $('btn-use-docs');
    if (button) {
      button.setAttribute('aria-pressed', String(enabled));
      button.title = enabled ? '本次会话会引用我的资料' : '本次会话不引用我的资料';
      button.classList.toggle('active', enabled);
    }
    if (typeof App !== 'undefined' && App.showToast) App.showToast(enabled ? '本次会话将引用我的资料' : '本次会话不再引用我的资料', '');
  }

  function quoteLastMessage() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('当前还没有可引用的发言', 'warning'); return; }
    var message = currentConv.messages.slice().reverse().find(function (m) { return m.role === 'assistant' && m.content; });
    if (!message) { App.showToast('当前还没有可引用的大师发言', 'warning'); return; }
    var input = $('msg-input');
    var quote = '> ' + masterName(message.masterKey) + '：' + message.content.trim() + '\n\n';
    input.value = quote + input.value;
    input.focus();
  }

  async function saveCurrentPoint() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('开始对话后才能保存观点', 'warning'); return; }
    var message = currentConv.messages.slice().reverse().find(function (m) { return m.role === 'assistant' && m.content; });
    if (!message) { App.showToast('当前还没有可保存的大师观点', 'warning'); return; }
    currentConv.savedPoints = Array.isArray(currentConv.savedPoints) ? currentConv.savedPoints : [];
    currentConv.savedPoints.push({ id: genId(), masterKey: message.masterKey, content: message.content, createdAt: nowISO() });
    if (!await saveConversationOrWarn(currentConv)) return;
    App.showToast('观点已保存到当前对话', 'success');
  }

  function insertMention() {
    var input = $('msg-input');
    if (!input || input.disabled) { App.showToast('请先选择大师', 'warning'); return; }
    input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + '@';
    input.focus();
  }

  function toggleInspectorDensity() {
    var page = document.querySelector('.masters-clinical-page');
    var button = $('btn-pin-inspector');
    if (!page || !button) return;
    var compact = page.classList.toggle('inspector-compact');
    button.setAttribute('aria-pressed', String(compact));
    button.title = compact ? '恢复摘要详情' : '切换摘要密度';
    App.showToast(compact ? '已切换为紧凑摘要' : '已显示摘要详情', '');
  }

  function openNextSession() { location.href = 'session-calendar.html'; }

  function saveSupervisionDraft() {
    if (!currentConv || !currentConv.messages.length) { App.showToast('开始对话后才能保存督导草稿', 'warning'); return; }
    var text = currentConv.summary || currentConv.messages.filter(function (m) { return m.role === 'assistant'; }).slice(-3).map(function (m) { return m.content; }).join('\n\n');
    if (!text) { App.showToast('当前没有可保存的观点', 'warning'); return; }
    try { localStorage.setItem('xj_sup_v31_draft', text); } catch (e) {}
    location.href = 'supervision.html?source=masters';
  }

  var quoteButton = $('btn-quote-last');
  if (quoteButton) quoteButton.addEventListener('click', quoteLastMessage);
  var pointButton = $('btn-save-point');
  if (pointButton) pointButton.addEventListener('click', saveCurrentPoint);
  var docsButton = $('btn-use-docs');
  if (docsButton) docsButton.addEventListener('click', function () { setDocsSetting(!currentDocsSetting()); });
  var mentionButton = $('btn-mention');
  if (mentionButton) mentionButton.addEventListener('click', insertMention);
  var pinButton = $('btn-pin-inspector');
  if (pinButton) pinButton.addEventListener('click', toggleInspectorDensity);
  var nextButton = $('btn-next-session');
  if (nextButton) nextButton.addEventListener('click', openNextSession);
  var supervisionButton = $('btn-supervision-draft');
  if (supervisionButton) supervisionButton.addEventListener('click', saveSupervisionDraft);
  var filterButton = $('btn-filter-history');
  if (filterButton) filterButton.addEventListener('click', function () {
    var input = $('history-filter');
    if (!input) return;
    input.hidden = !input.hidden;
    filterButton.setAttribute('aria-pressed', String(!input.hidden));
    if (!input.hidden) { input.focus(); } else { input.value = ''; }
    renderHistList();
  });
  var filterInput = $('history-filter');
  if (filterInput) filterInput.addEventListener('input', renderHistList);

  var masterSearch = document.querySelector('.masters-search input');
  if (masterSearch) {
    masterSearch.addEventListener('input', function () {
      masterSearchQuery = masterSearch.value.trim().toLowerCase();
      renderMasterList();
    });
  }
  var schoolFilter = $('master-school-filter');
  if (schoolFilter) schoolFilter.addEventListener('change', function () {
    masterSchool = schoolFilter.value;
    renderMasterList();
  });

  // ---------- 大师点击 ----------
  window.onMasterClick = async function (key) {
    if (mode === '1v1') {
      loadTemp(key);
      var conv = convList.find(function (c) { return c.mode === '1v1' && c.masterKeys[0] === key; });
      if (!conv) {
        var m = getMasterByKey(key);
        conv = { id: genId(), mode: '1v1', masterKeys: [key], title: m ? m.name : key, messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        if (!await saveConversationOrWarn(conv)) return;
        convList.unshift(conv);
      }
      currentConv = conv;
    } else {
      var idx = roundKeys.indexOf(key);
      if (idx >= 0) roundKeys.splice(idx, 1); else roundKeys.push(key);
      var sameRound = currentConv && currentConv.mode === 'round' && !currentConv.messages.length;
      if (sameRound) {
        currentConv.masterKeys = roundKeys.slice();
        if (!await saveConversationOrWarn(currentConv)) return;
      } else if (roundKeys.length >= 2) {
        currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        if (!await saveConversationOrWarn(currentConv)) return;
        convList.unshift(currentConv);
      } else {
        currentConv = null;
      }
    }
    renderMasterList(); renderChat(); renderHistList(); updateContextPanels(); renderViewpoints();
  };

  // ---------- 对话渲染 ----------
  window.focusMasterPicker = function () {
    var list = $('master-list');
    if (list) {
      list.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var first = list.querySelector('button.master-card');
      if (first) first.focus();
    }
  };
  function renderChat() {
    var titleEl = $('chat-title'), subEl = $('chat-sub'), body = $('chat-body');
    if (body) body.classList.toggle('round-mode', !!(currentConv && currentConv.mode === 'round'));
    syncDocsButton();
    var input = $('msg-input'), sendBtn = $('send-btn'), btnNew = $('btn-new'), btnDel = $('btn-del'), composer = $('chat-composer');
    if (composer) composer.style.display = 'flex';

    if (!currentConv) {
      titleEl.textContent = mode === '1v1' ? '选择一位大师' : '勾选大师';
      subEl.textContent = mode === '1v1' ? '从左侧挑选一位开始对话' : '在左侧勾选两位及以上大师';
      body.innerHTML = '<div class="empty-state"><i data-lucide="messages-square"></i><div class="big">把一个临床问题带到桌面上</div><span>先选择大师，再输入你正在思考的材料</span><button class="primary" type="button" onclick="focusMasterPicker()"><i data-lucide="users-round"></i>选择大师</button></div>';
      input.disabled = true; sendBtn.disabled = true;
      input.placeholder = '选择一位大师后即可输入';
      btnNew.style.display = 'none'; btnDel.style.display = 'none';
      updateContextPanels(); renderViewpoints();
      if (window.IconSystem && IconSystem.render) IconSystem.render(body);
      return;
    }

    btnNew.style.display = ''; btnDel.style.display = '';
    input.disabled = false; sendBtn.disabled = false;
    input.placeholder = '继续追问，输入 @大师 可指定发言';

    if (currentConv.mode === '1v1') {
      var m = getMasterByKey(currentConv.masterKeys[0]);
      titleEl.innerHTML = '<span class="dialogue-title-mark" style="background:' + accentOf(m || {}) + '">' + (m ? m.initial : '师') + '</span>' + (m ? m.name : currentConv.masterKeys[0]);
      if (m && currentConv.messages.length === 0 && (m.introTitle || m.intro)) {
        // v3.4.2: 复刻截图式空态 — emoji + 问候 + 3 个专属选项
        var opts = '';
        var quickOpts = m.quickOptions || ['帮我理解临床中的移情-反移情', '如何理解来访者的沉默', '我最近在临床中感到疲惫'];
        opts = '<div class="masters-intro-quick">';
        quickOpts.forEach(function (o) {
          opts += '<button onclick="sendQuick(\'' + App.escapeHtml(o).replace(/'/g, "\\'") + '\')">' + App.escapeHtml(o) + '</button>';
        });
        opts += '</div>';
        subEl.innerHTML = '<div class="masters-intro">'
          + '<div class="masters-intro-mark">' + App.escapeHtml(m.initial || '') + '</div>'
          + '<div class="masters-intro-title">' + App.escapeHtml(m.introTitle || '') + '</div>'
          + '<div class="masters-intro-copy">' + App.escapeHtml(m.intro || '') + '</div>' + opts + '</div>';
      } else {
        subEl.textContent = (m ? m.school : '') + ' · 一对一';
      }
    } else {
      var names = currentConv.masterKeys.map(masterName).join('、');
      titleEl.textContent = '圆桌 · ' + (names || '');
      subEl.textContent = '多大师研讨 · @大师 可指定发言';
    }

    body.innerHTML = currentConv.messages.map(renderMsg).join('');
    body.scrollTop = body.scrollHeight;
    updateContextPanels(); renderViewpoints();
    if (window.IconSystem && IconSystem.render) IconSystem.render(body);
  }

  function renderErrorCard(errText, errorCode) {
    var accountSessionRequired = errorCode === 'account_session_required' || errorCode === 'XJ_AI_ACCOUNT_SESSION_REQUIRED';
    var message = accountSessionRequired
      ? '账号会话已失效或未登录，请重新登录后重试。草稿和本轮输入已保留。'
      : (errText || '模型调用失败，请检查配置、网络或服务状态。');
    var actionLabel = accountSessionRequired ? '登录 / 刷新会话' : '检查 AI 配置';
    return '<div class="bubble"><div class="error-card" role="alert">'
      + App.escapeHtml(message)
      + '</div><div class="error-actions"><button class="retry-btn" type="button" data-masters-action="retry">重试</button>'
      + '<button class="retry-btn secondary" type="button" data-masters-action="account">' + App.escapeHtml(actionLabel) + '</button></div></div>';
  }
  function renderMsg(msg) {
    if (msg.role === 'sys') {
      return '<div class="msg" style="justify-content:center"><div class="bubble" style="background:transparent;border:1px dashed var(--border);color:var(--text-muted);font-size:12px;padding:6px 14px;border-radius:10px;max-width:88%">' + App.escapeHtml(msg.content) + '</div></div>';
    }
    if (msg.role === 'user') {
      return '<div class="msg user"><div class="body"><div class="bubble">' + App.escapeHtml(msg.content) + '</div></div></div>';
    }
    if (msg.status === 'error') {
      var errorMaster = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
      var errorColor = errorMaster ? accentOf(errorMaster) : 'var(--accent)';
      var errorInitial = errorMaster ? errorMaster.initial : '师';
      var errorName = errorMaster ? errorMaster.name : (msg.masterKey || '大师');
      return '<div class="msg ai"><div class="av" style="background:' + errorColor + '">' + errorInitial + '</div><div class="body"><div class="sender">' + App.escapeHtml(errorName) + '</div>' + renderErrorCard(msg.error || msg.content, msg.errorCode) + '</div></div>';
    }
    var m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
    var name = m ? m.name : (msg.masterKey || '大师');
    var color = m ? accentOf(m) : 'var(--accent)';
    var initial = m ? m.initial : '师';
    var statusLabel = msg.status === 'interrupted' ? ' · 已中断' : '';
    return '<div class="msg ai' + (msg.status === 'interrupted' ? ' interrupted' : '') + '"><div class="av" style="background:' + color + '">' + initial + '</div><div class="body"><div class="sender">' + name + statusLabel + '</div><div class="bubble">' + App.escapeHtml(msg.content) + '<div class="theory-scope-note">理论视角 · 仅本次输入 · 非临床事实</div></div></div></div></div>';
  }

  // ---------- 快捷提问（空态点击） ----------
  window.sendQuick = function (text) {
    var input = $('msg-input');
    if (input) input.value = text;
    window.sendMessage();
  };

  // ---------- 发送消息 ----------
  window.sendMessage = async function () {
    if (busy) {
      if (activeController) activeController.abort();
      return;
    }
    if (!App.featureGate('ai-masters')) { applyAiLock(); App.showToast('AI 对话为付费功能' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'error'); return; }
    if (!(App.hasAICompute && App.hasAICompute())) { applyAiLock(); App.showToast('会员权益已解锁，但尚未检测到可用 AI 算力', 'warning'); return; }

    var input = $('msg-input');
    var text = (input.value || '').trim();
    if (!text) return;

    // 解析 @大师
    var targetKeys = null;
    var atMatch = text.match(/@([A-Za-z_\u4e00-\u9fa5]+)/);
    if (mode === 'round' && atMatch) {
      var hit = (window.MASTERS || []).find(function (m) { return m.name === atMatch[1] || m.key === atMatch[1].toLowerCase(); });
      if (hit) targetKeys = [hit.key];
    }

    if (!currentConv) {
      if (mode === '1v1') { App.showToast('请先选择一位大师', 'error'); return; }
      if (roundKeys.length < 2) { App.showToast('圆桌至少选择两位大师', 'warning'); return; }
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      if (!await saveConversationOrWarn(currentConv)) return;
      convList.unshift(currentConv); flashSaved();
    }
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('master_chat', { summary: '与大师对话：' + text.slice(0, 30) });
    if (mode === 'round' && currentConv.mode !== 'round') {
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      if (!await saveConversationOrWarn(currentConv)) return;
      convList.unshift(currentConv); flashSaved();
    }

    var cleanText = text.replace(/@[A-Za-z_\u4e00-\u9fa5]+\s*/, '').trim() || text;
    currentConv.messages.push({ role: 'user', content: cleanText, ts: Date.now() });
    input.value = '';
    renderChat();
    if (!await saveConversationOrWarn(currentConv)) return;
    flashSaved();

    var keys = (mode === '1v1') ? currentConv.masterKeys : (targetKeys || roundKeys);
    runMasters(keys, cleanText, targetKeys);
  };

  // ===== 圆桌 system prompt 规则（与 Chat roundtable.html 一致）=====
  // [我的资料库] 由 MastersCore 统一追加，页面只传递当前圆桌参数。
  function buildRoundSysPrompt(m, activeNames, isReactMode) {
    return MastersCore.buildRoundSystemPrompt(m, activeNames, isReactMode, { includeUserDocs: currentDocsSetting() });
  }

  // 1v1 system prompt（保持原逻辑 + style constraints）
  function build1v1SysPrompt(m) {
    return MastersCore.buildOneToOneSystemPrompt(currentConv, m, { temperature: talkTemp, includeUserDocs: currentDocsSetting() });
  }

  // 核心：调用大师 API（并行第一轮 + 串行 reacting）
  async function runMasters(keys, userText, mentionedKeys) {
    retryState = null;
    var failedMessages = [];
    var failedKeys = [];
    var rememberFailure = function (key, result, fallback) {
      var message = {
        role: 'assistant',
        content: fallback || (result && result.error) || '模型调用失败，请检查配置、网络或服务状态。',
        error: (result && result.error) || fallback || '模型调用失败，请检查配置、网络或服务状态。',
        errorCode: result && (result.errorCode || result.code),
        masterKey: key,
        status: 'error',
        ts: Date.now(),
      };
      currentConv.messages.push(message);
      failedMessages.push(message);
      if (failedKeys.indexOf(key) < 0) failedKeys.push(key);
      return message;
    };
    var rememberRetry = function () {
      if (!failedMessages.length) return;
      retryState = {
        convId: currentConv && currentConv.id,
        mode: currentConv && currentConv.mode,
        keys: failedKeys.slice(),
        userText: String(userText || ''),
        mentionedKeys: [],
        errorMessages: failedMessages.slice(),
      };
    };
    busy = true;
    activeController = mode === '1v1' && typeof AbortController !== 'undefined' ? new AbortController() : null;
    setGeneratingUi(true);
    $('msg-input').disabled = true;

    var activeNames = (mode === 'round' ? currentConv.masterKeys : keys).map(masterName).join('、');

    // 一对一优先使用流式响应；圆桌保留完整轮次，避免大师之间的上下文被半成品打断。
    if (mode === '1v1') {
      var singleKey = keys[0];
      var singleTyping = appendTyping(singleKey);
      var streamMessage = { role: 'assistant', content: '', masterKey: singleKey, status: 'streaming', ts: Date.now() };
      currentConv.messages.push(streamMessage);
      await saveConversationOrWarn(currentConv);
      var snapshotTimer = null;
      var scheduleSnapshot = function () {
        if (snapshotTimer) return;
        snapshotTimer = setTimeout(async function () {
          snapshotTimer = null;
          await saveConversationOrWarn(currentConv);
        }, 700);
      };
      var singleResult = await callMaster(singleKey, userText, false, activeNames, {
        onDelta: function (piece, fullText) {
          streamMessage.content = fullText;
          updateTyping(singleTyping, fullText);
          scheduleSnapshot();
        },
        signal: activeController ? activeController.signal : undefined,
      });
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
      if (singleTyping) singleTyping.remove();
      if (singleResult && singleResult.content && singleResult.content.trim()) {
        streamMessage.content = singleResult.content;
        streamMessage.status = singleResult.interrupted ? 'interrupted' : 'complete';
      } else if (singleResult && singleResult.error) {
        var partial = singleResult.partialContent || '';
        if (partial) {
          streamMessage.content = partial;
          streamMessage.status = 'interrupted';
        } else {
          currentConv.messages.pop();
          rememberFailure(singleKey, singleResult, singleResult.error);
        }
      } else {
        currentConv.messages.pop();
        rememberFailure(singleKey, { error: '模型未返回内容' }, '模型未返回内容');
      }
      rememberRetry();
      renderChat();
      if (await saveConversationOrWarn(currentConv)) flashSaved();
      busy = false;
      setGeneratingUi(false);
      $('msg-input').disabled = false;
      $('msg-input').focus();
      activeController = null;
      return;
    }

    // Round 1：所有大师并行
    var typingEls = {};
    keys.forEach(function (k) { typingEls[k] = appendTyping(k); });

    var round1Results = {};
    var promises = keys.map(function (k) {
      return callMaster(k, userText, false, activeNames).then(function (r) { round1Results[k] = r; });
    });
    await Promise.allSettled(promises);

    keys.forEach(function (k) { if (typingEls[k]) typingEls[k].remove(); });

    var repliedKeys = [];
    keys.forEach(function (k) {
      var r = round1Results[k];
      if (r && !r.error && r.content && r.content.trim() && r.content.trim() !== ' ') {
        currentConv.messages.push({ role: 'assistant', content: r.content, masterKey: k, ts: Date.now() });
        repliedKeys.push(k);
      } else if (r && r.error) {
        rememberFailure(k, r);
      } else if (!r) {
        rememberFailure(k, { error: '模型未返回内容' }, '模型未返回内容');
      }
      // ponytail: 空格/空回复 = 跳过，与 Chat 一致
    });
    rememberRetry();
    renderChat();
    if (await saveConversationOrWarn(currentConv)) flashSaved();

    // Z3（XJ519-Z3）：主回复完成后不再自动发起逐大师二次请求（reacting/总结波次）。
    // 每轮只保留用户请求的各位大师回复，禁止额外请求、碎片回复与失败卡污染摘要。
    // @大师 指定发言属于用户显式请求，保留其「其他人回应被@大师」的流程。
    if (mode === 'round' && repliedKeys.length >= 2 && mentionedKeys && mentionedKeys.length > 0) {
      // @mention 流程：其他人回应被@的大师 → 被@大师总结
      var targetKey = mentionedKeys[0];
        var others = repliedKeys.filter(function (k) { return k !== targetKey; });
        if (others.length > 0) {
          // 其他人并行回应被@的大师
          var mentionPromises = others.map(function (k) {
            var context = masterName(targetKey) + '：' + round1Results[targetKey].content;
            return callMaster(k, '以下是' + masterName(targetKey) + '的发言，请你就其观点做出回应：\n\n' + context, true, activeNames);
          });
          var mentionResults = await Promise.allSettled(mentionPromises);
          mentionResults.forEach(function (r, i) {
            var k = others[i];
            if (r.status === 'fulfilled' && r.value && r.value.content && r.value.content.trim() && r.value.content.trim() !== ' ') {
              currentConv.messages.push({ role: 'assistant', content: r.value.content, masterKey: k, ts: Date.now() });
            } else if (r.status === 'fulfilled' && r.value && r.value.error) {
              rememberFailure(k, r.value);
            } else if (r.status === 'rejected') {
              rememberFailure(k, { error: '模型调用失败，请检查配置、网络或服务状态。' });
            }
          });
          rememberRetry();
          renderChat(); if (await saveConversationOrWarn(currentConv)) flashSaved();
        }
        // 被@大师做总结
        var targetTyping = appendTyping(targetKey);
        var summaryResult = await callMaster(targetKey, null, 'summary', activeNames);
        if (targetTyping) targetTyping.remove();
        if (summaryResult && summaryResult.content && summaryResult.content.trim()) {
          currentConv.messages.push({ role: 'assistant', content: summaryResult.content, masterKey: targetKey, ts: Date.now() });
        } else if (summaryResult && summaryResult.error) {
          rememberFailure(targetKey, summaryResult);
        }
        rememberRetry();
        renderChat(); if (await saveConversationOrWarn(currentConv)) flashSaved();
    }

    busy = false;
    setGeneratingUi(false);
    $('msg-input').disabled = false;
    $('msg-input').focus();
    activeController = null;
  }

  async function retryLastMasterRequest(button) {
    if (!retryState || busy) return;
    var state = retryState;
    if (!currentConv || currentConv.id !== state.convId || currentConv.mode !== state.mode) {
      retryState = null;
      renderChat();
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = '重试中…';
    }
    retryState = null;
    currentConv.messages = currentConv.messages.filter(function (message) {
      return state.errorMessages.indexOf(message) < 0;
    });
    renderChat();
    if (!await saveConversationOrWarn(currentConv)) {
      retryState = state;
      renderChat();
      return;
    }
    await runMasters(state.keys, state.userText, state.mentionedKeys);
  }

  function openMasterRecoveryDestination() {
    var requiresAccount = retryState && retryState.errorMessages.some(function (message) {
      return message && (message.errorCode === 'account_session_required' || message.errorCode === 'XJ_AI_ACCOUNT_SESSION_REQUIRED');
    });
    window.location.href = requiresAccount ? 'account.html' : 'settings.html#ai';
  }

  // 事件委托在文件尾部注册；仅暴露受控动作函数，不暴露会话、请求或恢复状态。
  window.__xjMastersRetry = retryLastMasterRequest;
  window.__xjMastersOpenRecovery = openMasterRecoveryDestination;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function setGeneratingUi(isGenerating) {
    var button = $('send-btn');
    if (!button) return;
    button.disabled = isGenerating && mode === 'round';
    button.classList.toggle('is-stop', !!isGenerating);
    button.title = isGenerating ? '中止生成' : '发送';
    button.setAttribute('aria-label', isGenerating ? '中止生成' : '发送');
    button.innerHTML = '<i data-lucide="' + (isGenerating ? 'square' : 'arrow-up') + '"></i>';
    if (window.IconSystem && IconSystem.render) IconSystem.render(button);
  }

  // 调用单个大师 — 传递 temperature 和 maxTokens（与 Chat 项目一致）
  async function callMaster(masterKey, userText, isReactMode, activeNames, streamOptions) {
    var m = getMasterByKey(masterKey);
    if (!m) return { error: '大师未找到' };

    var system, options;
    if (mode === 'round' && activeNames) {
      system = buildRoundSysPrompt(m, activeNames, isReactMode);
      options = {
        temperature: isReactMode ? 0.6 : 0.7,
        maxTokens: isReactMode === 'summary' ? 600 : (isReactMode ? 400 : 512),
      };
    } else {
      system = build1v1SysPrompt(m);
      // v3.4.2: 温度滑块控制 temperature，详细度滑块控制 maxTokens
      options = {
        temperature: talkTemp / 100,
        maxTokens: 256 + Math.round(talkDetail / 100 * 768)
      };
    }

    if (typeof MastersCore !== 'undefined' && MastersCore.callMaster) {
      return MastersCore.callMaster(currentConv, m, userText, Object.assign({}, options, streamOptions || {}, { systemPrompt: system }))
        .then(function (res) {
          if (res && res.content && !res.error) return { content: res.content, interrupted: !!res.interrupted };
          return {
            error: (res && res.error) || '无响应',
            errorCode: res && (res.errorCode || res.code),
            partialContent: (res && res.partialContent) || '',
            interrupted: !!(res && res.interrupted),
          };
        });
    }
    return Promise.resolve({ error: '大师对话核心未就绪' });
  }

  function appendTyping(key) {
    var m = getMasterByKey(key);
    var body = $('chat-body');
    var el = document.createElement('div');
    el.className = 'msg ai typing';
    el.innerHTML = '<div class="av" style="background:' + accentOf(m) + '">' + m.initial + '</div><div class="body"><div class="sender">' + m.name + '</div><div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span> 思考中…</div></div>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function updateTyping(el, text) {
    if (!el) return;
    var bubble = el.querySelector('.bubble');
    if (!bubble) return;
    bubble.textContent = text || '思考中…';
    el.classList.toggle('has-content', !!text);
    var body = $('chat-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // ---------- 新对话 / 删除 ----------
  // 语义：先把当前对话存入历史记录（若含消息），再开启一个全新、无上下文的对话
  window.newConversation = async function () {
    if (currentConv && currentConv.messages && currentConv.messages.length) {
      if (!convList.some(function (c) { return c.id === currentConv.id; })) {
        await saveConversationOrWarn(currentConv);
        convList.unshift(currentConv);
      } else {
        await saveConversationOrWarn(currentConv); // 已在历史中，确保最新消息落盘
      }
    }
    currentConv = null; roundKeys = [];
    renderMasterList(); renderChat(); renderHistList();
  };
  window.deleteCurrent = function () {
    if (!currentConv) return;
    var deleteId = currentConv.id;
    App.confirmDialog('确定删除当前对话？此操作不可恢复。', function () {
      return Store.deleteMasterConversationDurable(deleteId).then(function (result) {
        if (!result || !result.ok) {
          App.showToast('删除失败：对话未改变，请恢复存储后重试', 'error');
          return false;
        }
        convList = convList.filter(function (c) { return c.id !== deleteId; });
        if (currentConv && currentConv.id === deleteId) currentConv = null;
        renderMasterList(); renderChat(); renderHistList();
        return true;
      });
    }, true);
  };
  // v3.4.2: 导出当前对话为 Markdown
  window.exportCurrent = function () {
    if (!currentConv) { App.showToast('请先选择对话', 'warning'); return; }
    var md = '# ' + (currentConv.title || '大师对话') + '\n\n';
    md += '> 日期：' + (currentConv.updatedAt ? new Date(currentConv.updatedAt).toLocaleDateString('zh-CN') : '') + ' | ' + currentConv.messages.length + ' 条消息\n\n';
    if (currentConv.summary) md += '## 摘要\n\n' + currentConv.summary + '\n\n';
    md += '## 对话\n\n';
    currentConv.messages.forEach(function (msg) {
      if (msg.role === 'user') md += '**你**：' + msg.content + '\n\n';
      else if (msg.role === 'assistant') {
        var nm = msg.masterKey ? (masterName(msg.masterKey) || msg.masterKey) : '大师';
        md += '**' + nm + '**：' + msg.content + '\n\n';
      }
    });
    var html = App.mdToWordHtml(md);
    App.exportWordDoc((currentConv.title || 'master_chat') + '_' + new Date().toISOString().slice(0, 10) + '.doc', html);
    App.showToast('已导出为 Word 文档', 'success');
  };
  // v3.4.2: 删除指定对话（从历史列表）
  window.deleteConvById = function (id, event) {
    if (event) event.stopPropagation();
    App.confirmDialog('确定删除这条对话？此操作不可恢复。', function () {
      return Store.deleteMasterConversationDurable(id).then(function (result) {
        if (!result || !result.ok) {
          App.showToast('删除失败：对话未改变，请恢复存储后重试', 'error');
          return false;
        }
        convList = convList.filter(function (c) { return c.id !== id; });
        if (currentConv && currentConv.id === id) currentConv = null;
        renderMasterList(); renderChat(); renderHistList();
        return true;
      });
    }, true);
  };

  // ---------- AI 锁 ----------
  function applyAiLock() {
    var lock = $('ai-lock'), input = $('msg-input'), sendBtn = $('send-btn');
    if (!lock) return;
    var eligible = App.featureGate('ai-masters');
    var compute = App.hasAICompute && App.hasAICompute();
    var title = lock.querySelector('strong');
    var copy = lock.querySelector('span');
    var action = $('btn-view-masters-plan');
    var license = (App.getLicenseState && App.getLicenseState()) || {};
    var currentTier = license.tier === 'custom' ? '旗舰版' : (license.tier === 'pro' || license.tier === 'full' ? '会员' : '免费版');
    if (eligible && compute) {
      lock.classList.add('hidden');
      input.disabled = !currentConv; sendBtn.disabled = !currentConv;
    } else {
      lock.classList.remove('hidden');
      input.disabled = true; sendBtn.disabled = true;
      if (!eligible) {
        if (title) title.textContent = '大师对话是会员功能';
        if (copy) copy.textContent = '功能：大师对话 · 所需档位：会员 · 当前档位：' + currentTier + '。可预览理论学派、一对一与圆桌界面；解锁后才会调用 AI。';
        if (action) { action.textContent = '查看并解锁会员'; action.href = 'activation.html'; }
      } else {
        if (title) title.textContent = '尚未检测到可用 AI 算力';
        if (copy) copy.textContent = '功能：大师对话 · 所需档位：会员 · 当前档位：' + currentTier + '。会员权益已生效，请检查内置服务或配置并验证个人 API。';
        if (action) { action.textContent = '配置 AI'; action.href = 'settings.html#ai'; }
      }
    }
  }
  App.onLicenseStateChange(function () { try { applyAiLock(); } catch (e) {} });
  function openActivation(event) {
    if (window.__XJ_API__ && window.__XJ_API__.openActivation) {
      if (event) event.preventDefault();
      window.__XJ_API__.openActivation();
    }
  }
  window.openActivation = openActivation;

  // "已保存" 闪烁提示
  function flashSaved() {
    var el = document.getElementById('save-indicator');
    if (!el) return;
    el.style.display = 'inline';
    setTimeout(function () { el.style.display = 'none'; }, 1500);
  }

  // ---------- 初始化 ----------
  App.initPage({
    title: '大师对话',
    onReady: function () {
      loadConvs();
      populateSchoolFilter();
      renderMasterList();
      renderChat();
      renderHistList();
      applyAiLock();
    },
  });
})();


(function () {
  'use strict';

  // 单一状态源；body/panel class 与 aria 属性均由此状态派生，避免两个状态漂移。
  var panelState = window.__xjMastersPanelState || { left: false, right: false };
  window.__xjMastersPanelState = panelState;

  function getPanel(side) {
    return document.getElementById(side === 'left' ? 'master-source-panel' : 'master-inspector-panel');
  }

  function getButton(side) {
    return document.getElementById(side === 'left' ? 'masters-collapse-left' : 'masters-collapse-right');
  }

  function syncPanel(side, keepFocus) {
    if (side !== 'left' && side !== 'right') return;
    var panel = getPanel(side);
    var button = getButton(side);
    if (!panel || !button || !document.body) return;

    var collapsed = panelState[side] === true;
    var label = side === 'left' ? '大师视角栏' : '摘要历史栏';
    var action = collapsed ? '恢复' : '折叠';
    var icon = side === 'left'
      ? (collapsed ? 'chevron-right' : 'chevron-left')
      : (collapsed ? 'chevron-left' : 'chevron-right');

    panel.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('masters-' + side + '-collapsed', collapsed);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', action + label);
    button.title = action + label;
    button.innerHTML = '<i data-lucide="' + icon + '" aria-hidden="true"></i>';
    if (window.IconSystem && IconSystem.render) IconSystem.render(button);
    if (keepFocus) {
      try { button.focus({ preventScroll: true }); } catch (e) { button.focus(); }
    }
  }

  window.toggleMasterPanel = function (side) {
    if (side !== 'left' && side !== 'right') return;
    // 以当前 DOM 为事实来源。路由重渲染或 CSS 状态恢复后，旧的内存值
    // 可能已经过期；按实际 class 反转可保证“恢复”按钮再次点击确实展开。
    var panel = getPanel(side);
    var currentlyCollapsed = !!(panel && panel.classList.contains('collapsed'));
    panelState[side] = !currentlyCollapsed;
    syncPanel(side, true);
  };

  // 016：Escape 恢复所有折叠面板（复用 panelState + syncPanel 单一状态源）
  function restoreAllFolded(keepFocusToFirst) {
    var restored = [];
    ['left', 'right'].forEach(function (side) {
      var panel = getPanel(side);
      var folded = !!(panel && panel.classList.contains('collapsed')) || panelState[side] === true;
      if (folded) { panelState[side] = false; restored.push(side); }
    });
    if (!restored.length) return restored;
    restored.forEach(function (side) { syncPanel(side, false); });
    if (keepFocusToFirst) {
      var first = getButton(restored[0]);
      if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
    }
    return restored;
  }

  function handleMasterEscape(event) {
    if (!event || event.key !== 'Escape') return;
    if (event.defaultPrevented || event.isComposing) return;
    var anyFolded = ['left', 'right'].some(function (side) {
      var panel = getPanel(side);
      return !!(panel && panel.classList.contains('collapsed')) || panelState[side] === true;
    });
    if (!anyFolded) return;
    event.preventDefault();
    restoreAllFolded(true);
  }

  function bindMasterEscapeOnce() {
    if (window.__xjMasterEscapeBound === 1) return;
    window.__xjMasterEscapeBound = 1;
    document.addEventListener('keydown', handleMasterEscape);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMasterEscapeOnce, { once: true });
  else bindMasterEscapeOnce();

  function initMasterPanelControls() {
    ['left', 'right'].forEach(function (side) {
      var button = getButton(side);
      if (!button || button.dataset.panelBound === '1') return;
      button.dataset.panelBound = '1';
      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        window.toggleMasterPanel(side);
      });
      // 键盘闭环：阻止浏览器默认 click/滚动时序漂移，确保 Enter/Space 各只触发一次。
      button.addEventListener('keydown', function (event) {
        if (!event || event.isComposing || event.defaultPrevented || event.repeat) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          window.toggleMasterPanel(side);
          return;
        }
        if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') {
          event.preventDefault();
          button.dataset.panelSpacePending = '1';
        }
      });
      button.addEventListener('keyup', function (event) {
        if (!event || event.isComposing) return;
        if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') {
          event.preventDefault();
          event.stopPropagation();
          if (button.dataset.panelSpacePending === '1') {
            delete button.dataset.panelSpacePending;
            window.toggleMasterPanel(side);
          }
        }
      });
      button.addEventListener('blur', function () { delete button.dataset.panelSpacePending; });
      syncPanel(side, false);
    });
  }

  // 动态路由可能在 masters.js 初始化后才插入面板 DOM。对尚未完成直接绑定的
  // 控件保留委托入口，确保按钮始终可用且不会与直接监听器重复切换。
  function bindMasterPanelDelegation() {
    if (window.__xjMasterPanelDelegationBound === 1) return;
    window.__xjMasterPanelDelegationBound = 1;
    document.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('.masters-collapse-btn') : null;
      if (!button || button.dataset.panelBound === '1') return;
      var side = button.id === 'masters-collapse-left' ? 'left' : (button.id === 'masters-collapse-right' ? 'right' : '');
      if (!side) return;
      event.preventDefault();
      window.toggleMasterPanel(side);
    });
    document.addEventListener('keydown', function (event) {
      if (!event || event.isComposing || event.defaultPrevented || event.key !== 'Enter') return;
      var button = event.target && event.target.closest ? event.target.closest('.masters-collapse-btn') : null;
      if (!button || button.dataset.panelBound === '1') return;
      var side = button.id === 'masters-collapse-left' ? 'left' : (button.id === 'masters-collapse-right' ? 'right' : '');
      if (!side) return;
      event.preventDefault();
      window.toggleMasterPanel(side);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMasterPanelControls, { once: true });
  else initMasterPanelControls();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMasterPanelDelegation, { once: true });
  else bindMasterPanelDelegation();

  // App 路由会异步替换页面片段；面板晚于脚本出现时重新执行一次绑定与状态同步。
  if (window.MutationObserver && !window.__xjMasterPanelObserver) {
    window.__xjMasterPanelObserver = new MutationObserver(function (mutations) {
      var needsInit = mutations.some(function (mutation) {
        return Array.prototype.some.call(mutation.addedNodes || [], function (node) {
          return node && node.nodeType === 1 && (node.id === 'master-source-panel' || node.id === 'master-inspector-panel' ||
            (node.querySelector && (node.querySelector('#masters-collapse-left') || node.querySelector('#masters-collapse-right'))));
        });
      });
      if (needsInit) initMasterPanelControls();
    });
    window.__xjMasterPanelObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }
})();

  document.addEventListener('click', function (e) {
    var button = e.target && e.target.closest ? e.target.closest('[data-masters-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-masters-action');
    if (action === 'retry') {
      e.preventDefault();
      if (typeof window.__xjMastersRetry === 'function') window.__xjMastersRetry(button);
    } else if (action === 'account') {
      e.preventDefault();
      if (typeof window.__xjMastersOpenRecovery === 'function') window.__xjMastersOpenRecovery();
    }
  });
