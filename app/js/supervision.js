/* 心镜 v3.1.0 — AI 督导（方案C：三栏研究台 + 历史 + 会员分层） */
App.initPage({
  title: 'AI 督导',
  onReady: function () {
    'use strict';
    var chat = document.getElementById('sup-chat');
    var input = document.getElementById('sup-input');
    var materialTA = document.getElementById('sup-material');
    var curOrient = 'cangjie';
    var curOrientName = '仓颉版温尼科特督导师';
    var messages = [];
    var busy = false;
    var currentClientId = null;
    var currentSessionId = '';
    var materialId = '';
    var latestSupervision = null;
    var draftKey = 'xj_sup_v31_draft';
    var chatKey = 'xj_sup_v31_chat';

    function currentMaterialWorkspace() { return materialId && Store.getMaterialWorkspace ? Store.getMaterialWorkspace(materialId) : null; }
    function showMaterialSource(material) {
      var host = document.querySelector('.sup-main') || document.querySelector('.sup-page') || document.body;
      if (!host || !material || document.getElementById('sup-material-source')) return;
      var source = document.createElement('div');
      source.id = 'sup-material-source'; source.style.cssText = 'margin:8px 0;padding:8px 10px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;font-size:12px;color:var(--ink-2)';
      source.textContent = 'AI 上下文来源：当前材料「' + (material.source.name || material.title) + '」' + (material.clientId ? '、已关联来访者' : '；未归档，保存前请选择来访者');
      host.insertBefore(source, host.firstChild);
    }

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

    // 督导师注册表与批准后的取向选择器
    var orientSel = document.getElementById('sup-orient');
    var orientDesc = document.getElementById('sup-orient-desc');
    var supervisorList = [];
    if (typeof Supervisors !== 'undefined' && Supervisors.getBuiltinList) {
      supervisorList = Supervisors.getBuiltinList();
      supervisorList.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        if (s.desc) opt.setAttribute('data-desc', s.desc);
        orientSel.appendChild(opt);
      });
    }
    function renderSupervisorOptions() {
      function buttonFor(s) {
        return '<button class="supervisor-option' + (s.isWinnicott ? ' special' : '') + (s.id === curOrient ? ' selected' : '') + '" type="button" data-supervisor-id="' + App.escapeHtml(s.id) + '" aria-pressed="' + (s.id === curOrient ? 'true' : 'false') + '">' +
          '<span class="supervisor-option-mark">' + App.escapeHtml(s.mark || '督') + '</span><span><strong>' + App.escapeHtml(s.name) + '</strong><small>' + App.escapeHtml(s.desc || '') + '</small></span><i class="supervisor-option-check" data-lucide="check"></i></button>';
      }
      var special = document.getElementById('supervisor-special-options');
      var ordinary = document.getElementById('supervisor-orientation-options');
      if (special) special.innerHTML = supervisorList.filter(function (s) { return s.isWinnicott; }).map(buttonFor).join('');
      if (ordinary) ordinary.innerHTML = supervisorList.filter(function (s) { return !s.isWinnicott; }).map(buttonFor).join('');
      document.querySelectorAll('[data-supervisor-id]').forEach(function (button) {
        button.addEventListener('click', function () { setOrientation(button.getAttribute('data-supervisor-id'), true); closeSupervisorPicker(); });
      });
      if (window.IconSystem) window.IconSystem.render(document.getElementById('supervisor-picker'));
    }
    function closeSupervisorPicker() {
      var picker = document.getElementById('supervisor-picker');
      var openButton = document.getElementById('open-supervisor-picker');
      if (picker) picker.hidden = true;
      if (openButton) openButton.setAttribute('aria-expanded', 'false');
    }
    function setOrientation(orientationId, persistPreference) {
      var normalized = Supervisors.normalizeId ? Supervisors.normalizeId(orientationId) : orientationId;
      var definition = Supervisors.getDefinition ? Supervisors.getDefinition(normalized) : null;
      if (!normalized || !definition) { App.showToast('督导师配置无效，请重新选择', 'error'); return; }
      orientSel.value = normalized;
      curOrient = normalized;
      curOrientName = definition.displayName;
      updateBadge();
      var desc = definition.desc || '';
      if (orientDesc) {
        orientDesc.textContent = desc || '';
        orientDesc.style.display = 'none';
      }
      renderSupervisorOptions();
      if (persistPreference && currentClientId) {
        var client = Store.getClient(currentClientId);
        if (client) {
          Store.updateClient(currentClientId, {
            preferences: Object.assign({}, client.preferences || {}, { lastSupervisionOrientation: curOrient })
          });
        }
      }
    }
    setOrientation(curOrient, false);
    orientSel.addEventListener('change', function () { setOrientation(this.value, true); });
    var openPickerButton = document.getElementById('open-supervisor-picker');
    if (openPickerButton) openPickerButton.addEventListener('click', function () {
      var picker = document.getElementById('supervisor-picker');
      var opening = picker && picker.hidden;
      if (picker) picker.hidden = !opening;
      openPickerButton.setAttribute('aria-expanded', String(!!opening));
    });
    var closePickerButton = document.getElementById('close-supervisor-picker');
    if (closePickerButton) closePickerButton.addEventListener('click', closeSupervisorPicker);
    var customOption = document.getElementById('custom-supervisor-option');
    if (customOption) customOption.addEventListener('click', function () {
      if (!App.canUse('custom-supervisors')) {
        App.showToast('新建定制督导师为旗舰功能', 'warning');
        App.openPlans();
        return;
      }
      location.href = 'feedback.html?type=custom-supervisor';
    });
    function updateBadge() {
      document.getElementById('sup-badge').textContent = curOrientName;
      var name = document.getElementById('supervisor-current-name');
      var mark = document.getElementById('supervisor-current-mark');
      var definition = Supervisors.getDefinition ? Supervisors.getDefinition(curOrient) : null;
      if (name) name.textContent = curOrientName;
      if (mark) mark.textContent = (definition && definition.mark) || '督';
    }
    function ensureSupervisionAccess() {
      if (!App.canUse('ai-supervise')) {
        App.showToast('AI 督导为会员功能，可先预览界面', 'warning');
        App.openPlans();
        return false;
      }
      if (!(App.hasAICompute && App.hasAICompute())) {
        App.showToast('会员权益已解锁，但尚未检测到可用 AI 算力', 'warning');
        return false;
      }
      return true;
    }
    function syncAccessUI() {
      var unlock = document.getElementById('sup-unlock-button');
      if (unlock) unlock.style.display = App.canUse('ai-supervise') ? 'none' : '';
    }
    syncAccessUI();
    if (App.onLicenseStateChange) App.onLicenseStateChange(syncAccessUI);

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
      var continueButton = document.getElementById('continue-supervision');
      if (!cid) {
        currentClientId = null;
        currentSessionId = '';
        latestSupervision = null;
        if (continueButton) continueButton.style.display = 'none';
        renderSessionHistory([]);
        return;
      }
      currentClientId = cid;
      if (App.setActiveClientId) App.setActiveClientId(currentClientId);
      if (materialId && Store.reconcileMaterialContext) Store.reconcileMaterialContext(materialId, currentClientId, currentSessionId || null, {});
      var client = Store.getClient(cid);
      var preferences = (client && client.preferences) || {};
      if (preferences.lastSupervisionOrientation) setOrientation(preferences.lastSupervisionOrientation, false);
      var supervisions = Store.getSupervisionsByClient ? Store.getSupervisionsByClient(cid) : [];
      latestSupervision = supervisions.length ? supervisions[supervisions.length - 1] : null;
      if (continueButton) continueButton.style.display = latestSupervision ? '' : 'none';
      var sessions = Store.getSessionsForPicker(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      renderSessionHistory(sessions);
      // 自动载入最近一次会话的逐字稿
      if (sessions.length && sessions[0].transcript) {
        materialTA.value = sessions[0].transcript;
        currentSessionId = sessions[0].id;
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
      currentSessionId = s.id;
      materialTA.value = s.transcript || '';
      if (s.soap) materialTA.value += '\n\n--- SOAP ---\nS: ' + (s.soap.subjective||'') + '\nO: ' + (s.soap.objective||'') + '\nA: ' + (s.soap.assessment||'') + '\nP: ' + (s.soap.plan||'');
      addMsg('ai', '已载入第' + (s.sessionNumber || '?') + '节逐字稿。');
      // 高亮选中的会话
      document.querySelectorAll('.lh-item').forEach(function (el) { el.classList.remove('active'); });
      var active = document.querySelector('.lh-item[data-id="' + sessionId + '"]');
      if (active) active.classList.add('active');
    };

    window.continueLastSupervision = function () {
      if (!latestSupervision) return;
      var context = String(latestSupervision.context || latestSupervision.content || '').trim();
      if (context) {
        materialTA.value = context;
        try { localStorage.setItem(draftKey, context); } catch (e) {}
      }
      currentSessionId = latestSupervision.sessionId || ((latestSupervision.sessionIds || [])[0]) || currentSessionId;
      addMsg('ai', '已恢复上次督导的材料和流派。你可以补充本次材料后再开始分析。');
      switchTab('material');
    };

    window.loadTranscript = function () {
      var cid = selClient.value;
      if (!cid) { App.showToast('请先选择来访者', 'warning'); return; }
      var sessions = Store.getSessionsForPicker(cid).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
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
        ? Supervisors.buildSystemPrompt(curOrient)
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
        var input = materialTA ? materialTA.value.trim() : '';
        var finalMessage = msgs[msgs.length - 1] || {};
        var context = ClinicalContext.build('supervision-ai', { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId }, { system: (msgs[0] && msgs[0].content) || '', inputText: input, instruction: finalMessage.content || '', history: msgs.slice(1, -1) });
        if (!context.ok) { resolve({ error: '当前上下文无效，请重新选择来访者或材料' }); return; }
        if (ClinicalContextView) ClinicalContextView.renderSummary(document.querySelector('.sup-main') || document.body, context);
        if (ClinicalContextView && !ClinicalContextView.confirmSend(context)) { resolve({ error: '用户已取消本次 AI 督导' }); return; }
        var run = ClinicalContext.createActionRun(context);
        if (!run) { resolve({ error: '无法确认材料归属' }); return; }
        AI.send(context.messages, function (res) {
          var currentInput = materialTA ? materialTA.value.trim() : '';
          if (!ClinicalContext.isSnapshotCurrent(context.snapshot, currentInput, { clientId: currentClientId, sessionId: currentSessionId, materialId: materialId })) { ClinicalContext.failActionRun(run.id, '上下文已变更', 'stale'); resolve({ error: '上下文已变更，旧结果未采用' }); return; }
          if (res && res.content && !res.error) { ClinicalContext.completeActionRun(run.id, { kind: 'supervision-response', ref: materialId || currentClientId || '' }); resolve({ content: res.content }); }
          else { ClinicalContext.failActionRun(run.id, (res && res.error) || '无响应'); resolve({ error: (res && res.error) || '无响应' }); }
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
      if (!ensureSupervisionAccess()) return;
      var mat = materialTA.value.trim();
      if (!mat) { App.showToast('请先在材料区填写临床材料', 'warning'); return; }
      sendToAI('生成整体印象', true);
    };

    window.quickAction = function (kind) {
      if (busy) return;
      if (!ensureSupervisionAccess()) return;
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
      if (!ensureSupervisionAccess()) return;
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
      if (!ensureSupervisionAccess()) return;
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
        var saved = Store.saveAiSupervision({
          supervisorName: modeName,
          clientId: currentClientId || '',
          sessionId: currentSessionId,
          sessionIds: currentSessionId ? [currentSessionId] : [],
          context: materialTA.value.trim(),
          content: full,
        });
        if (saved && materialId && Store.updateMaterialWorkspace) Store.updateMaterialWorkspace(materialId, { workflow: { supervision: 'completed' }, artifacts: { supervisionId: saved.id } });
      }
      App.showToast('已保存督导记录', 'success');
      if (typeof Memory !== 'undefined' && Memory.record) Memory.record('supervision_done', { summary: '完成了 AI 督导' });
    };

    window.exportSup = function () {
      var body = '<h2>AI 督导记录</h2>';
      messages.forEach(function (m) {
        body += '<p><strong>' + (m.role === 'user' ? '我' : '小镜') + '：</strong>' + App.escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
      });
      App.exportWordDoc('督导记录_' + App.todayStr() + '.doc', body);
      App.showToast('已导出 Word 文档', 'success');
    };

    // 手动上传案例报告 → 载入材料区
    window.onReportFileUpload = function (event) {
      var file = event.target.files[0];
      if (!file) return;
      var name = file.name.toLowerCase();
      App.showToast('正在读取报告…', 'info');
      var onText = function (text) {
        var cur = materialTA.value.trim();
        materialTA.value = (cur ? cur + '\n\n' : '') + '【上传的案例报告：' + file.name + '】\n' + text;
        try { localStorage.setItem(draftKey, materialTA.value); } catch (e) {}
        App.showToast('案例报告已载入材料区', 'success');
        switchTab('material');
      };
      var reader = new FileReader();
      if (name.endsWith('.docx')) {
        if (typeof mammoth !== 'undefined') {
          reader.onload = function (ev) {
            mammoth.extractRawText({ arrayBuffer: ev.target.result }).then(function (r) { onText(r.value); })
              .catch(function () { App.showToast('docx 解析失败', 'error'); });
          };
          reader.readAsArrayBuffer(file);
        } else { App.showToast('docx 解析库未加载', 'warning'); }
      } else {
        reader.onload = function (ev) { onText(ev.target.result); };
        reader.readAsText(file, 'UTF-8');
      }
      event.target.value = '';
    };

    // 从「撰写报告」跳转而来：选择来访者并预填案例报告
    try {
      var qs = new URLSearchParams(location.search);
      var autoClient = qs.get('clientId') || qs.get('client') || (App.getActiveClientId && App.getActiveClientId());
      var autoSession = qs.get('sessionId') || qs.get('session');
      materialId = qs.get('materialId') || '';
      var material = currentMaterialWorkspace();
      if (material && material.parseStatus === 'ready') {
        if (material.clientId) autoClient = material.clientId;
        if (material.sessionId) autoSession = material.sessionId;
        materialTA.value = material.extractedText || '';
        Store.updateMaterialWorkspace(materialId, { workflow: { supervision: 'in-progress' } });
        showMaterialSource(material);
      }
      var autoReport = qs.get('autoloadreport') === '1';
      if (autoClient) {
        selClient.value = autoClient;
        if (selClient.value === autoClient) {
          window.onClientChange();
          if (autoSession) window.loadSessionTranscript(autoSession);
          if (autoReport) {
            var draft = localStorage.getItem('xj_report_draft_' + autoClient);
            if (draft) {
              materialTA.value = draft;
              try { localStorage.setItem(draftKey, draft); } catch (e) {}
              addMsg('ai', '已载入从「撰写报告」带过来的案例报告。点「生成整体印象」或直接在右侧对话窗深入督导。');
              switchTab('material');
            }
          }
        }
      }
      if (material && material.parseStatus === 'ready') {
        materialTA.value = material.extractedText || '';
        switchTab('material');
      }
    } catch (e) {}
  },
});
