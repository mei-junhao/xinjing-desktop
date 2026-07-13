/* 心镜 v3.0.0 — 咨询记录（APA/SOAP/DAP/自由 + 小镜辅助） */
(function () {
  'use strict';
  var currentClientId = null;
  var currentMode = 'apa';

  function loadClients() {
    var sel = document.getElementById('sel-client');
    var clients = Store.getClients().filter(function (c) { return c.status !== 'ended'; });
    sel.innerHTML = '<option value="">选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
  }

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

  window.loadClientSessions = function () {
    var sel = document.getElementById('sel-client');
    currentClientId = sel.value || null;
    if (currentClientId) {
      var c = Store.getClient(currentClientId);
      addXjMsg('ai', '已选择 ' + c.name + '。选择上方 APA/SOAP/DAP 模式开始记录，我可以帮你展开任何一条。');
    }
  };

  function addXjMsg(role, text) {
    var chat = document.getElementById('rdock-chat');
    var div = document.createElement('div');
    div.className = 'rmsg ' + role;
    div.innerHTML = App.escapeHtml(text).replace(/\n/g, '<br>');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  window.saveNotes = function () {
    var notes = '';
    var hasSoap = false, hasDap = false, hasTranscript = false;
    if (currentMode === 'apa') {
      var d = {
        c1: document.getElementById('f1').value.trim(),
        c2: document.getElementById('f2').value.trim(),
        c3: document.getElementById('f3').value.trim(),
        c4: document.getElementById('f4').value.trim(),
        c5: document.getElementById('f5').value.trim(),
      };
      if (!d.c1 && !d.c2 && !d.c3 && !d.c4 && !d.c5) { App.showToast('请至少填写一项', 'warning'); return; }
      notes = ['主诉: ' + d.c1, '行为观察: ' + d.c2, '情绪: ' + d.c3, '对话: ' + d.c4, '方向: ' + d.c5].filter(function (x) { return x.split(': ')[1]; }).join('\n');
      hasTranscript = !!d.c4;
    } else if (currentMode === 'soap') {
      var s = document.getElementById('soap-s').value.trim();
      var o = document.getElementById('soap-o').value.trim();
      var a = document.getElementById('soap-a').value.trim();
      var p = document.getElementById('soap-p').value.trim();
      if (!s && !o && !a && !p) { App.showToast('请至少填写一项', 'warning'); return; }
      notes = 'S: ' + s + '\nO: ' + o + '\nA: ' + a + '\nP: ' + p;
      hasSoap = true;
    } else if (currentMode === 'dap') {
      var dd = document.getElementById('dap-d').value.trim();
      var aa = document.getElementById('dap-a').value.trim();
      var pp = document.getElementById('dap-p').value.trim();
      if (!dd && !aa && !pp) { App.showToast('请至少填写一项', 'warning'); return; }
      notes = 'D: ' + dd + '\nA: ' + aa + '\nP: ' + pp;
      hasDap = true;
    } else {
      notes = document.getElementById('f-free').value.trim();
      if (!notes) { App.showToast('请填写内容', 'warning'); return; }
    }
    Store.createSession({
      clientId: currentClientId || '__notes__',
      date: App.todayStr(),
      durationMinutes: 0,
      type: 'individual',
      notes: notes,
      hasTranscript: hasTranscript,
      hasSoap: hasSoap,
      hasDap: hasDap,
    });
    App.showToast('已保存', 'success');
  };

  window.sendToXj = function () {
    var input = document.getElementById('rdock-input');
    var text = (input.value || '').trim();
    if (!text) return;
    addXjMsg('me', text);
    input.value = '';
    // 调用 AI
    if (!App.aiUnlocked()) { addXjMsg('ai', 'AI 功能需激活后使用。'); return; }
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

  App.initPage({ title: '咨询记录', subtitle: '', actions: '', noSidebar: true, onReady: function () {
    loadClients();
  }});
})();
