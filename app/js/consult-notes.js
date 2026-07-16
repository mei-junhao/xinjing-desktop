/* 心镜 v3.0.0 — 咨询记录（APA/SOAP/DAP/自由 + 小镜辅助） */
(function () {
  'use strict';
  var currentClientId = null;
  var currentSessionId = null;
  var currentMode = 'apa';

  function loadClients() {
    var sel = document.getElementById('sel-client');
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    sel.innerHTML = '<option value="">选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
  }

  // 选择来访者：填充会话下拉并显示上传/导出入口
  window.onClientChange = function () {
    var sel = document.getElementById('sel-client');
    currentClientId = sel.value || null;
    currentSessionId = null;
    var sessSel = document.getElementById('sel-session');
    var upBtn = document.getElementById('btn-upload-transcript');
    var exBtn = document.getElementById('btn-export');
    if (!currentClientId) {
      sessSel.style.display = 'none';
      upBtn.style.display = 'none';
      exBtn.style.display = 'none';
      return;
    }
    var c = Store.getClient(currentClientId);
    addXjMsg('ai', '已选择 ' + c.name + '。可选「来访者会话」继续编辑某节次，或直接在下方新建记录；我可以帮你展开任何一条。');
    // 填充会话下拉
    var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });
    var seenC = {};
    sessions = sessions.filter(function (s) { if (seenC[s.id]) return false; seenC[s.id] = 1; return true; });
    sessSel.innerHTML = '<option value="">选择来访者会话…</option>' + sessions.map(function (s) {
      var tag = s.hasTranscript ? '（逐字稿）' : (s.hasSoap ? '（SOAP）' : (s.hasDap ? '（DAP）' : ''));
      return '<option value="' + s.id + '">第' + s.sessionNumber + '节 ' + (s.date || '') + tag + '</option>';
    }).join('');
    sessSel.style.display = '';
    upBtn.style.display = '';
    exBtn.style.display = '';
  };

  // 选择已有会话：把该节次内容载入编辑区（按记录类型匹配模式）
  window.onSessionChange = function () {
    var sessSel = document.getElementById('sel-session');
    currentSessionId = sessSel.value || null;
    // 清空所有编辑区
    ['f1','f2','f3','f4','f5','soap-s','soap-o','soap-a','soap-p','dap-d','dap-a','dap-p','f-free'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    if (!currentSessionId) return;
    var s = Store.getSession(currentSessionId);
    if (!s) return;
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
    var chip = document.querySelector('.prompt-strip .chip[data-mode="' + target + '"]');
    if (chip) chip.click();
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('session_opened', { summary: '打开了第' + s.sessionNumber + '节记录', relatedClientId: currentClientId });
  };

  // 模式切换
  document.querySelectorAll('.prompt-strip .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('.prompt-strip .chip').forEach(function (x) { x.classList.remove('active'); });
      chip.classList.add('active');
      currentMode = chip.dataset.mode;
      ['apa', 'soap', 'dap', 'free'].forEach(function (m) {
        var pane = document.getElementById('pane-' + m);
        if (pane) pane.style.display = m === currentMode ? '' : 'none';
      });
    });
  });

  function addXjMsg(role, text) {
    var chat = document.getElementById('rdock-chat');
    var div = document.createElement('div');
    div.className = 'rmsg ' + role;
    div.innerHTML = App.escapeHtml(text).replace(/\n/g, '<br>');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
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
  window.saveNotes = function (silent) {
    if (!currentClientId) {
      if (!silent) App.showToast('请先选择来访者', 'warning');
      return false;
    }
    var data = collectCurrent();
    if (!data) {
      if (!silent) App.showToast('请至少填写一项', 'warning');
      return false;
    }
    var payload = {
      clientId: currentClientId,
      date: App.todayStr(),
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

    if (currentSessionId) {
      // 更新已选会话（保留其原 sessionNumber/date 等）
      var existing = Store.getSession(currentSessionId);
      if (existing) {
        Store.updateSessionFull(Object.assign({}, existing, payload, { id: currentSessionId }));
      }
    } else {
      // 修复：保存后锁定到新创建的会话，避免连续点击「保存」反复生成重复节次
      var created = Store.createSession(payload);
      var newId = (created && created.id) ? created.id : null;
      currentSessionId = newId;
      // 直接刷新会话下拉（不触发 onClientChange，以免重复刷 AI 消息），并选中新建节次
      var sessSel2 = document.getElementById('sel-session');
      if (sessSel2 && newId) {
        var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) {
          return (b.date || '').localeCompare(a.date || '');
        });
        var seenS = {};
        sessions = sessions.filter(function (s) { if (seenS[s.id]) return false; seenS[s.id] = 1; return true; });
        sessSel2.innerHTML = '<option value="">选择来访者会话…</option>' + sessions.map(function (s) {
          var tag = s.hasTranscript ? '（逐字稿）' : (s.hasSoap ? '（SOAP）' : (s.hasDap ? '（DAP）' : ''));
          return '<option value="' + s.id + '">第' + s.sessionNumber + '节 ' + (s.date || '') + tag + '</option>';
        }).join('');
        sessSel2.value = newId;
      }
    }
    if (!silent) App.showToast('已保存', 'success');
    if (typeof Memory !== 'undefined' && Memory.record) Memory.record('session_saved', { summary: '保存了咨询记录', relatedClientId: currentClientId });
    return true;
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
      });
    } else {
      if (lastMsg) lastMsg.remove();
      addXjMsg('ai', 'AI 模块未就绪，请重启应用。');
    }
  };

  // ---------- 上传逐字稿 + AI 分析（会员功能） ----------
  window.onTranscriptUpload = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    if (!App.featureGate('ai-analyze')) {
      App.showToast('上传逐字稿 AI 分析需激活会员后使用', 'warning');
      event.target.value = '';
      return;
    }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); event.target.value = ''; return; }
    App.showToast('正在读取逐字稿…', 'info');
    var reader = new FileReader();
    var onText = function (text) {
      // 写入当前会话的 transcript（无选中会话则新建一条逐字稿会话）
      if (currentSessionId) {
        var ex = Store.getSession(currentSessionId);
        if (ex) Store.updateSessionFull(Object.assign({}, ex, { transcript: text, hasTranscript: true }));
      } else {
        var r = Store.createSession({
          clientId: currentClientId, date: App.todayStr(), durationMinutes: 0, type: 'individual',
          recordKind: 'clinical', billing: null, transcript: text, hasTranscript: true, notes: '',
        });
        if (r) currentSessionId = r.id;
        // 刷新会话下拉，标记逐字稿
        onClientChange();
        var sessSel = document.getElementById('sel-session');
        if (sessSel) sessSel.value = currentSessionId || '';
      }
      // 切到自由笔记模式展示内容
      var chip = document.querySelector('.prompt-strip .chip[data-mode="free"]');
      if (chip) chip.click();
      document.getElementById('f-free').value = text;
      App.showToast('逐字稿已载入，开始 AI 分析…', 'success');
      aiAnalyzeTranscript(text);
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
    });
  }

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
  function autoSaveSilent() { try { saveNotes(true); } catch (e) {} }
  window.leavePage = function () { autoSaveSilent(); location.href = 'index.html'; };
  window.finishAndGoReport = function () {
    saveNotes(true); // 自动保存（不弹 toast）
    location.href = 'report-writing.html';
  };

  App.initPage({ title: '咨询记录', subtitle: '', actions: '', noSidebar: true, onReady: function () {
    loadClients();
    // 离开页面（关闭/刷新）自动保存当前草稿
    window.addEventListener('beforeunload', autoSaveSilent);
  }});
})();
