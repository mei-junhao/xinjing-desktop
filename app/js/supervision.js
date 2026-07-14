/* 心镜 v3.1.0 — AI 督导（方案C：三栏研究台 + 历史 + 会员分层） */
App.initPage({
  title: 'AI 督导',
  noSidebar: true,
  onReady: function () {
    'use strict';
    var chat = document.getElementById('sup-chat');
    var input = document.getElementById('sup-input');
    var materialTA = document.getElementById('sup-material');
    var curOrient = 'builtin-winnicott';
    var curOrientName = '温尼科特取向督导师';
    var messages = [];
    var busy = false;
    var currentClientId = null;
    var draftKey = 'xj_sup_v31_draft';
    var chatKey = 'xj_sup_v31_chat';

    // 来访者列表
    var selClient = document.getElementById('sup-client');
    Store.getClients().forEach(function (c) {
      if (c.status !== 'ended') {
        var opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.name;
        selClient.appendChild(opt);
      }
    });

    // 恢复草稿
    try { var d = localStorage.getItem(draftKey); if (d) materialTA.value = d; } catch(e){}
    materialTA.addEventListener('input', function () { try { localStorage.setItem(draftKey, this.value); } catch(e){} });

    // 动态填充督导流派下拉
    var orientSel = document.getElementById('sup-orient');
    if (typeof Supervisors !== 'undefined' && Supervisors.getBuiltinList) {
      Supervisors.getBuiltinList().forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        orientSel.appendChild(opt);
      });
      // 自定义督导占位
      var custOpt = document.createElement('option');
      custOpt.value = '__custom__'; custOpt.textContent = '自定义督导（会员专属）';
      custOpt.style.color = 'var(--ink-3)';
      orientSel.appendChild(custOpt);
    }
    orientSel.value = curOrient;
    orientSel.addEventListener('change', function () {
      if (this.value === '__custom__') {
        alert('自定义督导功能请联系开发者定制。');
        this.value = curOrient;
        return;
      }
      curOrient = this.value;
      curOrientName = this.options[this.selectedIndex].textContent;
      updateBadge();
    });
    function updateBadge() {
      document.getElementById('sup-badge').textContent = curOrientName;
    }

    // Tab 切换
    window.switchTab = function (tab) {
      document.querySelectorAll('.m-tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === tab); });
      document.getElementById('impression-body').parentElement.style.display = tab === 'impression' ? '' : 'none';
      document.getElementById('deepen-block').style.display = tab === 'deepen' ? '' : 'none';
      document.getElementById('material-block').style.display = tab === 'material' ? '' : 'none';
    };

    // 来访者选择 → 加载会话历史
    window.onClientChange = function () {
      var cid = selClient.value;
      if (!cid) { currentClientId = null; renderSessionHistory([]); return; }
      currentClientId = cid;
      var sessions = Store.getSessionsByClient(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      renderSessionHistory(sessions);
      // 自动载入最近一次会话的逐字稿
      if (sessions.length && sessions[0].transcript) {
        materialTA.value = sessions[0].transcript;
        addMsg('ai', '已自动载入 ' + Store.getClient(cid).name + ' 第' + sessions[0].sessionNumber + '节的逐字稿。点「生成整体印象」开始督导。');
      } else {
        addMsg('ai', '已选择 ' + Store.getClient(cid).name + '。该来访者暂无逐字稿，请在材料区手动书写。');
      }
    };

    function renderSessionHistory(sessions) {
      var box = document.getElementById('session-history');
      if (!sessions || !sessions.length) {
        box.innerHTML = '<div style="padding:24px;text-align:center;color:var(--ink-3);font-size:12px">' +
          (currentClientId ? '暂无会话记录' : '请先选择来访者') + '</div>';
        return;
      }
      box.innerHTML = sessions.map(function (s) {
        var hasTranscript = s.transcript && s.transcript.trim();
        var hasSoap = s.soap && (s.soap.subjective || s.soap.objective || s.soap.assessment || s.soap.plan);
        var tags = '';
        if (hasTranscript) tags += '<span class="tag done">逐字稿</span>';
        if (hasSoap) tags += '<span class="tag done">记录</span>';
        if (!hasTranscript && !hasSoap) tags += '<span class="tag">无材料</span>';
        var preview = (s.transcript || '').slice(0, 60);
        return '<div class="lh-item" onclick="loadSessionTranscript(\'' + s.id + '\')" data-id="' + s.id + '">' +
          '<div class="s-num">第' + (s.sessionNumber || '?') + '节</div>' +
          '<div class="s-date">' + App.formatDate(s.date) + '</div>' +
          (preview ? '<div class="s-preview">' + App.escapeHtml(preview) + '…</div>' : '') +
          '<div class="s-tags">' + tags + '</div></div>';
      }).join('');
    }

    window.loadSessionTranscript = function (sessionId) {
      var s = Store.getSession(sessionId);
      if (!s) return;
      materialTA.value = s.transcript || '';
      if (s.soap) materialTA.value += '\n\n--- SOAP ---\nS: ' + (s.soap.subjective||'') + '\nO: ' + (s.soap.objective||'') + '\nA: ' + (s.soap.assessment||'') + '\nP: ' + (s.soap.plan||'');
      addMsg('ai', '已载入第' + (s.sessionNumber || '?') + '节逐字稿。');
      // 高亮选中的会话
      document.querySelectorAll('.lh-item').forEach(function (el) { el.classList.remove('active'); });
      var active = document.querySelector('.lh-item[data-id="' + sessionId + '"]');
      if (active) active.classList.add('active');
    };

    window.loadTranscript = function () {
      var cid = selClient.value;
      if (!cid) { App.showToast('请先选择来访者', 'warning'); return; }
      var sessions = Store.getSessionsByClient(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      if (!sessions.length) { App.showToast('该来访者无会话记录', 'warning'); return; }
      var html = sessions.map(function (s, i) {
        return '<label style="display:block;padding:8px;cursor:pointer"><input type="radio" name="sup-sess" value="' + s.id + '"' + (i === 0 ? ' checked' : '') + '> 第' + s.sessionNumber + '节 · ' + App.formatDate(s.date) + (s.transcript ? ' (有逐字稿)' : ' (无逐字稿)') + '</label>';
      }).join('');
      App.confirmDialog(html, function () {
        var checked = document.querySelector('input[name="sup-sess"]:checked');
        if (!checked) return;
        loadSessionTranscript(checked.value);
      });
    };

    function addMsg(role, text) {
      var div = document.createElement('div');
      div.className = 'msg ' + (role === 'me' ? 'me' : 'ai');
      if (role === 'ai') {
        div.innerHTML = '<div class="src">小镜</div>' + App.escapeHtml(text).replace(/\n/g, '<br>');
      } else {
        div.textContent = text;
      }
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      messages.push({ role: role === 'me' ? 'user' : 'assistant', content: text });
    }

    function addTyping() {
      var div = document.createElement('div');
      div.className = 'msg ai'; div.id = 'sup-typing';
      div.innerHTML = '<div class="src">小镜</div>思考中…';
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }
    function removeTyping() { var t = document.getElementById('sup-typing'); if (t) t.remove(); }

    function buildMessages(userText, isImpression) {
      var sys = (typeof Supervisors !== 'undefined' && Supervisors.buildSystemPrompt)
        ? Supervisors.buildSystemPrompt(curOrient.replace('builtin-', ''))
        : '你是一位心理咨询督导，请用中文回应，语气专业而温暖。';
      var material = materialTA.value.trim();
      var hist = messages.slice(-12).map(function (m) { return { role: m.role, content: m.content }; });

      var userContent = '';
      if (isImpression) {
        userContent = '以下是临床材料，请基于' + curOrientName + '给出整体印象（个案概念化、核心议题、治疗师功能、值得注意的线索）：\n\n' + material;
      } else {
        userContent = userText;
        if (material) userContent += '\n\n--- 临床材料 ---\n' + material;
      }
      return [{ role: 'system', content: sys }].concat(hist).concat([{ role: 'user', content: userContent }]);
    }

    function callAI(msgs) {
      return new Promise(function (resolve) {
        if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
        AI.send(msgs, function (res) {
          if (res && res.content && !res.error) resolve({ content: res.content });
          else resolve({ error: (res && res.error) || '无响应' });
        });
      });
    }

    function renderImpression(text) {
      var body = document.getElementById('impression-body');
      body.innerHTML = '';
      var paras = text.split('\n').filter(Boolean);
      paras.forEach(function (p) {
        if (p.startsWith('【') && p.endsWith('】')) {
          body.innerHTML += '<div style="font-weight:600;font-family:var(--serif);font-size:14px;margin:12px 0 6px;color:var(--accent)">' + App.escapeHtml(p) + '</div>';
        } else if (p.startsWith('"') || p.startsWith('“')) {
          body.innerHTML += '<div class="ab-quote">' + App.escapeHtml(p) + '</div>';
        } else {
          body.innerHTML += '<p style="margin:6px 0">' + App.escapeHtml(p) + '</p>';
        }
      });
    }

    window.generateImpression = function () {
      if (busy) return;
      if (!App.featureGate('ai-supervise')) { App.showToast('AI 督导需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
      var mat = materialTA.value.trim();
      if (!mat) { App.showToast('请先在材料区填写临床材料', 'warning'); return; }
      sendToAI('生成整体印象', true);
    };

    window.quickAction = function (kind) {
      if (busy) return;
      if (!App.featureGate('ai-supervise')) { App.showToast('AI 督导需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
      var prompts = {
        deepen: '请就材料中的核心议题深化讨论，提出进一步的思考角度与开放式提问。',
        polish: '请在不改变原意的前提下润色以下临床材料的语言，使其更通顺、专业。',
        tech: '基于材料，请给出具体的技术建议——在接下来的咨询中我应该怎样回应？',
        transference: '请就材料中的移情/反移情议题进行分析。如果信息不足，请提出需要关注的移情线索。',
      };
      sendToAI(prompts[kind] || prompts.deepen, false);
    };

    window.inviteMaster = function () {
      if (busy) return;
      if (!App.aiUnlocked()) { App.showToast('邀请大师需激活后使用', 'warning'); return; }
      var masters = (window.MASTERS || []);
      var html = masters.map(function (m) {
        return '<label style="display:inline-block;padding:6px 12px;cursor:pointer"><input type="radio" name="sup-master" value="' + m.key + '"' + (m.key === 'winnicott' ? ' checked' : '') + '> ' + m.name + '</label>';
      }).join('');
      App.confirmDialog(html, function () {
        var checked = document.querySelector('input[name="sup-master"]:checked');
        if (!checked) return;
        var m = (window.getMasterByKey ? getMasterByKey(checked.value) : null);
        if (!m) return;
        var mat = materialTA.value.trim();
        if (!mat) { App.showToast('请先填写临床材料', 'warning'); return; }
        addMsg('me', '邀请 ' + m.name + ' 发表视角');
        addTyping();
        busy = true;
        var sys = m.systemPrompt + '\n\n以下是临床材料，请以你的理论视角给出对个案的分析和督导意见：\n\n' + mat;
        callAI([{ role: 'system', content: sys }, { role: 'user', content: '请基于你的取向分析这个个案。' }]).then(function (r) {
          removeTyping();
          if (r && !r.error) {
            addMsg('ai', '【' + m.name + '视角】\n' + r.content);
            // 也渲染到中栏深化区
            var deepenBody = document.getElementById('deepen-body');
            deepenBody.innerHTML = '<div class="ab-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-weight:600;color:var(--accent)">' + m.name + '视角</span></div>' +
              '<div style="font-size:13px;line-height:1.8">' + App.escapeHtml(r.content).replace(/\n/g, '<br>') + '</div>';
            switchTab('deepen');
          } else addMsg('ai', '生成失败：' + ((r && r.error) || '未知'));
          busy = false;
        });
      });
    };

    window.sendSupMsg = function () {
      var text = (input.value || '').trim();
      if (!text || busy) return;
      if (!App.featureGate('ai-supervise')) { App.showToast('AI 督导需激活后使用' + (App.isTrial() ? '，或升级会员解锁全部功能' : ''), 'warning'); return; }
      input.value = '';
      sendToAI(text, false);
    };

    async function sendToAI(text, isImpression) {
      if (busy) return;
      if (!isImpression) addMsg('me', text);
      addTyping();
      busy = true;
      try {
        var msgs = buildMessages(text, isImpression);
        var r = await callAI(msgs);
        removeTyping();
        if (r && !r.error) {
          addMsg('ai', r.content);
          if (isImpression) {
            renderImpression(r.content);
            switchTab('impression');
          } else {
            // 把深化分析渲染到中栏
            var deepenBody = document.getElementById('deepen-body');
            deepenBody.innerHTML = '<div style="font-size:13px;line-height:1.8">' + App.escapeHtml(r.content).replace(/\n/g, '<br>') + '</div>';
            switchTab('deepen');
          }
        } else {
          addMsg('ai', '生成失败：' + ((r && r.error) || '未知错误'));
        }
      } catch (e) {
        removeTyping();
        addMsg('ai', '执行异常：' + (e && e.message));
      }
      busy = false;
    }

    window.saveSup = function () {
      if (!messages.length) { App.showToast('无内容可保存', 'warning'); return; }
      var full = messages.map(function (m) { return (m.role === 'user' ? '咨询师：' : '督导师：') + m.content; }).join('\n\n');
      var modeName = curOrientName;
      if (typeof Store !== 'undefined' && typeof Store.saveAiSupervision === 'function') {
        Store.saveAiSupervision({
          supervisorName: modeName,
          clientId: currentClientId || '',
          sessionId: '',
          context: materialTA.value.trim(),
          content: full,
        });
      }
      App.showToast('已保存督导记录', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '完成了 AI 督导' });
    };

    window.exportSup = function () {
      var html = '<html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:32px;max-width:700px;line-height:2}h2{color:#8B93C7}</style></head><body>';
      html += '<h2>AI 督导记录</h2>';
      messages.forEach(function (m) {
        html += '<p><b>' + (m.role === 'user' ? '我' : '小镜') + '：</b>' + m.content.replace(/\n/g, '<br>') + '</p>';
      });
      html += '</body></html>';
      App.downloadFile('督导记录_' + App.todayStr() + '.html', html, 'text/html');
      App.showToast('已导出', 'success');
    };
  },
});