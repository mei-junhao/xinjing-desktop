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
  var convList = [];
  // 温度滑块：每位大师独立存储，圆桌模式无滑块
  var talkTemp = 60;
  function loadTemp(key) {
    try { var v = localStorage.getItem('mc_temp_' + key); if (v != null) talkTemp = parseInt(v, 10) || 60; } catch(e) {}
    var slider = document.getElementById('temp-slider');
    if (slider) {
      slider.value = talkTemp;
      slider.parentElement.style.display = key ? '' : 'none';
    }
  }
  function saveTemp(key) {
    try { localStorage.setItem('mc_temp_' + key, talkTemp); } catch(e) {}
  }
  window.onTempChange = function (val) {
    talkTemp = parseInt(val, 10) || 60;
    if (currentConv && currentConv.mode === '1v1') {
      saveTemp(currentConv.masterKeys[0]);
    }
  };

  function genId() { return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function nowISO() { return new Date().toISOString(); }
  function masterName(key) { var m = getMasterByKey(key); return m ? m.name : key; }
  function accentOf(m) { var map = { accent: 'var(--accent)', purple: 'var(--purple)', blue: 'var(--blue)', green: 'var(--green)', orange: 'var(--orange)', indigo: 'var(--indigo)', red: 'var(--red)' }; return map[m.accent] || 'var(--accent)'; }

  function loadConvs() {
    try { convList = Store.getMasterConversations() || []; } catch (e) { convList = []; }
  }

  // ---------- 大师列表渲染 ----------
  function renderMasterList() {
    var box = $('master-list');
    var list = window.MASTERS || [];
    var panel = box.parentElement;
    panel.classList.toggle('mode-round', mode === 'round');
    box.innerHTML = list.map(function (m) {
      var sel = mode === '1v1' ? (currentConv && currentConv.mode === '1v1' && currentConv.masterKeys[0] === m.key) : roundKeys.indexOf(m.key) >= 0;
      return '<div class="master-card' + (sel ? ' active' : '') + '" data-key="' + m.key + '" onclick="onMasterClick(\'' + m.key + '\')">'
        + '<div class="m-avatar" style="background:' + accentOf(m) + '">' + (m.emoji || m.initial) + '</div>'
        + '<div class="m-meta"><div class="m-name">' + m.name + '</div><div class="m-school">' + m.school + '</div></div>'
        + '<div class="m-check">&#10003;</div></div>';
    }).join('');
  }

  // ---------- 历史列表渲染 ----------
  function renderHistList() {
    var box = $('hist-list');
    if (!box) return;
    if (!convList.length) { box.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">暂无历史对话</div>'; return; }
    box.innerHTML = convList.map(function (c) {
      var title = c.title || (c.mode === 'round' ? '圆桌研讨' : masterName(c.masterKeys[0]));
      var date = c.updatedAt ? new Date(c.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '';
      var preview = c.messages.length ? (c.messages[0].content || '').slice(0, 20) : '';
      var active = currentConv && c.id === currentConv.id;
      return '<div class="hist-item' + (active ? ' active' : '') + '" onclick="loadHist(\'' + c.id + '\')" style="padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:4px;' + (active ? 'background:var(--accent-soft)' : '') + '">'
        + '<div style="font:600 12px var(--sans)">' + App.escapeHtml(title) + '</div>'
        + '<div style="font-size:10px;color:var(--text-muted)">' + date + ' · ' + c.messages.length + '条</div>'
        + (preview ? '<div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + App.escapeHtml(preview) + '</div>' : '')
        + '</div>';
    }).join('');
  }

  window.loadHist = function (id) {
    var c = convList.find(function (x) { return x.id === id; });
    if (!c) return;
    currentConv = c;
    if (c.mode === 'round') { roundKeys = c.masterKeys.slice(); mode = 'round'; }
    else { mode = '1v1'; }
    document.querySelectorAll('#mode-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    renderMasterList(); renderChat(); renderHistList();
  };

  // ---------- 模式切换 ----------
  window.setMode = function (m) {
    mode = m;
    document.querySelectorAll('#mode-toggle button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === m); });
    currentConv = null; roundKeys = [];
    if (m === 'round') {
      var last = convList.find(function (c) { return c.mode === 'round'; });
      if (last) { currentConv = last; roundKeys = last.masterKeys.slice(); }
    }
    renderMasterList(); renderChat(); renderHistList();
  };
  document.getElementById('mode-toggle').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    window.setMode(btn.dataset.mode);
  });

  // ---------- 大师点击 ----------
  window.onMasterClick = function (key) {
    if (mode === '1v1') {
      loadTemp(key);
      var conv = convList.find(function (c) { return c.mode === '1v1' && c.masterKeys[0] === key; });
      if (!conv) {
        var m = getMasterByKey(key);
        conv = { id: genId(), mode: '1v1', masterKeys: [key], title: m ? m.name : key, messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(conv); convList.unshift(conv);
      }
      currentConv = conv;
    } else {
      var idx = roundKeys.indexOf(key);
      if (idx >= 0) roundKeys.splice(idx, 1); else roundKeys.push(key);
      var rconv = convList.find(function (c) { return c.mode === 'round'; });
      if (!rconv) {
        rconv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
        Store.saveMasterConversation(rconv); convList.unshift(rconv);
      }
      currentConv = rconv;
    }
    renderMasterList(); renderChat(); renderHistList();
  };

  // ---------- 对话渲染 ----------
  function renderChat() {
    var titleEl = $('chat-title'), subEl = $('chat-sub'), body = $('chat-body');
    var input = $('msg-input'), sendBtn = $('send-btn'), btnNew = $('btn-new'), btnDel = $('btn-del');

    if (!currentConv) {
      titleEl.textContent = mode === '1v1' ? '选择一位大师' : '勾选大师';
      subEl.textContent = mode === '1v1' ? '从左侧挑选一位开始对话' : '在左侧勾选两位及以上大师';
      body.innerHTML = '<div class="empty"><div class="big">与思想者对话</div>所有对话保存在本机，不上传任何服务器。<br>对话过长时自动生成摘要，延续脉络。</div>';
      input.disabled = true; sendBtn.disabled = true;
      btnNew.style.display = 'none'; btnDel.style.display = 'none';
      return;
    }

    btnNew.style.display = ''; btnDel.style.display = '';
    input.disabled = false; sendBtn.disabled = false;

    if (currentConv.mode === '1v1') {
      var m = getMasterByKey(currentConv.masterKeys[0]);
      titleEl.innerHTML = '<span style="font-size:20px">' + (m && m.emoji ? m.emoji + ' ' : '') + '</span>' + (m ? m.name : currentConv.masterKeys[0]);
      if (m && currentConv.messages.length === 0 && (m.introTitle || m.intro)) {
        subEl.innerHTML = '<div style="font-size:14px;font-weight:600;color:var(--accent);margin-bottom:2px">' + App.escapeHtml(m.introTitle || '') + '</div><div style="font-size:13px;color:var(--ink-3);line-height:1.8">' + App.escapeHtml(m.intro || '') + '</div>';
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
  }

  function renderMsg(msg) {
    if (msg.role === 'sys') {
      return '<div class="msg" style="justify-content:center"><div class="bubble" style="background:transparent;border:1px dashed var(--border);color:var(--text-muted);font-size:12px;padding:6px 14px;border-radius:10px;max-width:88%">' + App.escapeHtml(msg.content) + '</div></div>';
    }
    if (msg.role === 'user') {
      return '<div class="msg user"><div class="body"><div class="bubble">' + App.escapeHtml(msg.content) + '</div></div></div>';
    }
    var m = msg.masterKey ? getMasterByKey(msg.masterKey) : null;
    var name = m ? m.name : (msg.masterKey || '大师');
    var color = m ? accentOf(m) : 'var(--accent)';
    var initial = m ? m.initial : '师';
    return '<div class="msg ai"><div class="av" style="background:' + color + '">' + initial + '</div><div class="body"><div class="sender">' + name + '</div><div class="bubble">' + App.escapeHtml(msg.content) + '</div></div></div>';
  }

  // ---------- 发送消息 ----------
  window.sendMessage = function () {
    if (busy) return;
    if (!App.aiUnlocked()) { applyAiLock(); App.showToast('AI 对话为付费功能，请先激活', 'error'); return; }

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
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      Store.saveMasterConversation(currentConv); convList.unshift(currentConv); flashSaved();
    }
    if (mode === 'round' && currentConv.mode !== 'round') {
      currentConv = { id: genId(), mode: 'round', masterKeys: roundKeys.slice(), title: '圆桌研讨', messages: [], summary: '', createdAt: nowISO(), updatedAt: nowISO() };
      Store.saveMasterConversation(currentConv); convList.unshift(currentConv); flashSaved();
    }

    var cleanText = text.replace(/@[A-Za-z_\u4e00-\u9fa5]+\s*/, '').trim() || text;
    currentConv.messages.push({ role: 'user', content: cleanText, ts: Date.now() });
    input.value = '';
    renderChat();
    Store.saveMasterConversation(currentConv); flashSaved();

    var keys = (mode === '1v1') ? currentConv.masterKeys : (targetKeys || roundKeys);
    runMasters(keys, cleanText, targetKeys);
  };

  // ===== 圆桌 system prompt 规则（与 Chat roundtable.html 一致）=====
  function buildRoundSysPrompt(m, activeNames, isReactMode) {
    var styleC = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
    if (isReactMode === 'summary') {
      return '[重要指令：①始终使用中文对话]\n[你是' + m.name + '，你是这场圆桌讨论的总结者。'
        + '\n在场的还有：' + activeNames + '。'
        + '\n\n刚才各位大师围绕用户的问题各自发表了看法，还进行了讨论。'
        + '\n现在请你作为最后发言的人，对整场讨论做总结性回应，然后把注意力带回用户身上。'
        + '\n\n规则：\n① 用「我」说话。\n② 可以提到其他大师的观点（例如"弗洛伊德刚才提到……我同意他的看法"）。'
        + '\n③ 控制在120字以内，做一个有温度的收尾，把注意力带回用户。'
        + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。]\n\n'
        + m.systemPrompt + '\n\n' + (styleC || '');
    } else if (isReactMode) {
      return '[重要指令：①始终使用中文对话]\n[你是' + m.name + '。刚才用户提问后，各位大师已经分别回应了。'
        + '\n在场的还有：' + activeNames + '。'
        + '\n你刚才已经说过你的看法了。现在请看看其他大师说了什么。'
        + '\n如果你觉得有必要补充、回应或质疑，可以说一两句。'
        + '\n如果觉得没什么要补充的，输出空字符串。'
        + '\n\n规则：\n① 用「我」说话。\n② 可以直接对其他大师说话（例如"温尼科特，我同意你的看法……"）。'
        + '\n③ 控制在80字以内，简短自然。'
        + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。'
        + '\n⑤ 没什么要说的就输出一个空格。'
        + '\n⑥ 温尼科特作为最后总结者时，记得把话题带回用户身上，问问用户的感受或想法。]\n\n'
        + m.systemPrompt + '\n\n' + (styleC || '');
    } else {
      // Round 1：独立回应
      return '[重要指令：①始终使用中文对话]\n[你是' + m.name + '，你是参与圆桌讨论的其中一位。'
        + '\n在场的还有：' + activeNames + '。'
        + '\n\n规则：\n① 用「我」说话。就像你本人坐在房间里一样。'
        + '\n② 独立回应。你正在和所有人同时发言，所以你看不到其他人此刻说了什么。不要假设你知道别人会说什么。'
        + '\n③ 每条回应控制在150字以内，自然、口语化。'
        + '\n④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。'
        + '\n⑤ 不要替用户做决定。'
        + '\n⑥ 保持你的人格和语气——你的经历决定了你如何看待问题。'
        + '\n⑦ 你可以根据你的风格决定是否在回应中关注用户。]\n\n'
        + m.systemPrompt + '\n\n' + (styleC || '');
    }
  }

  // 1v1 system prompt（保持原逻辑 + style constraints）
  function build1v1SysPrompt(m) {
    var summaryLine = currentConv.summary ? '\n\n以下是你与这位咨询师的【既往对话摘要（长时记忆）】，请在回应时保持脉络连贯：\n' + currentConv.summary : '';
    var styleC = (typeof PromptsBuiltin !== 'undefined') ? PromptsBuiltin.STYLE_CONSTRAINTS : '';
    var tempInstr = talkTemp != null ? '\n\n[温度指令：当前对话权重 ' + talkTemp + '/100。' + (talkTemp <= 20 ? '只用情感化个人回应，不要分隔线，不要理论部分。用温尼科特自己的声音说话，像一个人在跟你聊天。每次回复控制在150字以内。' : talkTemp <= 40 ? '第一部分情感回应为主（约70%），第二部分理论锚点简略带过（约30%）。' : talkTemp <= 70 ? '情感回应与理论并重，临床逐字稿蒸馏为主。' : '优先使用完整知识库，支持RAG查询，理论深度为主。') + ']' : '';
    return m.systemPrompt + summaryLine + (styleC ? '\n\n' + styleC : '') + tempInstr;
  }

  // 核心：调用大师 API（并行第一轮 + 串行 reacting）
  async function runMasters(keys, userText, mentionedKeys) {
    busy = true;
    $('send-btn').disabled = true;
    $('msg-input').disabled = true;

    var activeNames = (mode === 'round' ? currentConv.masterKeys : keys).map(masterName).join('、');

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
        currentConv.messages.push({ role: 'assistant', content: '（生成失败：' + r.error + '）', masterKey: k, ts: Date.now() });
      }
      // ponytail: 空格/空回复 = 跳过，与 Chat 一致
    });
    renderChat();
    Store.saveMasterConversation(currentConv); flashSaved();

    // Round 2：串行 reacting（仅圆桌模式，>=2 位大师回复）
    if (mode === 'round' && repliedKeys.length >= 2) {
      var isMention = mentionedKeys && mentionedKeys.length > 0;

      if (isMention) {
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
            }
          });
          renderChat(); Store.saveMasterConversation(currentConv); flashSaved();
        }
        // 被@大师做总结
        var targetTyping = appendTyping(targetKey);
        var summaryResult = await callMaster(targetKey, null, 'summary', activeNames);
        if (targetTyping) targetTyping.remove();
        if (summaryResult && summaryResult.content && summaryResult.content.trim()) {
          currentConv.messages.push({ role: 'assistant', content: summaryResult.content, masterKey: targetKey, ts: Date.now() });
        }
        renderChat(); Store.saveMasterConversation(currentConv); flashSaved();
      } else {
        // 正常串行流程
        var serialOrder = repliedKeys.filter(function (k) { return k !== 'winnicott'; });
        if (repliedKeys.indexOf('winnicott') >= 0) serialOrder.push('winnicott');

        for (var i = 0; i < serialOrder.length; i++) {
          var sk = serialOrder[i];
          var isLast = (i === serialOrder.length - 1);

          // 收集其他大师的发言（过滤掉自己的）— 与 Chat 一致
          var context = repliedKeys.filter(function (k) { return k !== sk; }).map(function (k) {
            return masterName(k) + '：' + round1Results[k].content;
          }).join('\n\n');

          var reactPrompt = isLast
            ? '以下是其他大师对同一议题的发言，请你作为总结者，综合各位观点，给出你的最终回应：\n\n' + context
            : '以下是其他大师对这一议题的发言，请你就他们的观点做出回应，可补充、质疑或深化：\n\n' + context;

          var typingEl = appendTyping(sk);
          var rr = await callMaster(sk, reactPrompt, isLast ? 'summary' : true, activeNames);
          if (typingEl) typingEl.remove();

          // ponytail: 空格/空回复 = 跳过
          if (rr && !rr.error && rr.content && rr.content.trim() && rr.content.trim() !== ' ') {
            currentConv.messages.push({ role: 'assistant', content: rr.content, masterKey: sk, ts: Date.now() });
          }
          renderChat();
          Store.saveMasterConversation(currentConv); flashSaved();

          if (!isLast) await sleep(600);
        }
      }
    }

    busy = false;
    $('send-btn').disabled = false;
    $('msg-input').disabled = false;
    $('msg-input').focus();
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 调用单个大师 — 传递 temperature 和 maxTokens（与 Chat 项目一致）
  async function callMaster(masterKey, userText, isReactMode, activeNames) {
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
      options = { temperature: 0.7, maxTokens: 512 };
    }

    var hist = currentConv.messages.filter(function (x) { return x.role === 'user' || x.role === 'assistant'; }).slice(-16).map(function (x) {
      if (x.role === 'user') return { role: 'user', content: x.content };
      var nm = masterName(x.masterKey);
      return { role: 'assistant', content: '[' + nm + ']: ' + x.content };
    });

    var messages = [{ role: 'system', content: system }].concat(hist);
    if (userText) messages.push({ role: 'user', content: userText });

    return new Promise(function (resolve) {
      if (typeof AI === 'undefined' || !AI.send) { resolve({ error: 'AI 模块未就绪' }); return; }
      AI.send(messages, function (res) {
        if (res && res.content && !res.error) resolve({ content: res.content });
        else resolve({ error: (res && res.error) || '无响应' });
      }, options);
    });
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

  // ---------- 新对话 / 删除 ----------
  window.newConversation = function () {
    currentConv = null; roundKeys = [];
    renderMasterList(); renderChat(); renderHistList();
  };
  window.deleteCurrent = function () {
    if (!currentConv) return;
    App.confirmDialog('确定删除当前对话？此操作不可恢复。', function () {
      Store.deleteMasterConversation(currentConv.id);
      convList = convList.filter(function (c) { return c.id !== currentConv.id; });
      currentConv = null; renderMasterList(); renderChat(); renderHistList();
    }, true);
  };

  // ---------- AI 锁 ----------
  function applyAiLock() {
    var lock = $('ai-lock'), input = $('msg-input'), sendBtn = $('send-btn');
    if (!lock) return;
    if (App.aiUnlocked()) {
      lock.classList.add('hidden');
      input.disabled = !currentConv; sendBtn.disabled = !currentConv;
    } else {
      lock.classList.remove('hidden');
      input.disabled = true; sendBtn.disabled = true;
    }
  }
  App.onLicenseStateChange(function () { try { applyAiLock(); } catch (e) {} });
  function openActivation() { if (window.__XJ_API__ && window.__XJ_API__.openActivation) window.__XJ_API__.openActivation(); }
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
    noSidebar: true,
    onReady: function () {
      loadConvs();
      renderMasterList();
      renderChat();
      renderHistList();
      applyAiLock();
    },
  });
})();
