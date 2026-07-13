/* 心镜 v3.0.1 — 撰写报告（分步向导式 + AI 辅助 + 模板上传自动生成模块） */
(function () {
  'use strict';
  var currentClientId = null;
  var tplSections = null; // 模板解析出的模块（null=用默认6段）
  var currentStep = 0;
  var stepData = {}; // {0: "text", 1: "text", ...}

  // 默认 6 段
  var defaultSections = [
    { title: '来访者基本信息与转介来源', hint: '姓名、年龄、性别、职业、婚姻状况、转介渠道等……', desc: '填写来访者的基本信息。可点击"AI 填写本步"自动从数据库提取。' },
    { title: '主诉与求助原因', hint: '来访者自述的困扰、持续时间、严重程度……', desc: '描述来访者主诉的核心困扰及求助原因。' },
    { title: '个人发展史与家庭背景', hint: '童年经历、家庭关系、重要生活事件……', desc: '填写来访者的成长经历与家庭背景。' },
    { title: '心理动力学评估与个案概念化', hint: '运用所选理论取向对个案形成理解……', desc: '基于理论取向对个案进行概念化。' },
    { title: '治疗过程概述与关键转折', hint: '历次咨询的进展、关键转折……', desc: '概述治疗过程中的关键节点。' },
    { title: '后续方向与反思', hint: '下一阶段的目标、可能的挑战、咨询师的自我反思……', desc: '展望后续治疗方向并做自我反思。' },
  ];

  function getSections() { return tplSections || defaultSections; }

  function loadClients() {
    var sel = document.getElementById('rpt-client');
    var clients = Store.getClients();
    sel.innerHTML = '<option value="">选择来访者…</option>' + clients.map(function (c) {
      return '<option value="' + c.id + '">' + App.escapeHtml(c.name) + '</option>';
    }).join('');
  }

  window.loadClientSessions = function () {
    var sel = document.getElementById('rpt-client');
    currentClientId = sel.value || null;
    if (!currentClientId) return;
    var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });
    var strip = document.getElementById('sessions-strip');
    strip.innerHTML = sessions.map(function (s) {
      return '<label class="sess-chip checked"><input type="checkbox" checked value="' + s.id + '"> 第' + s.sessionNumber + '节</label>';
    }).join('');
    document.getElementById('sess-bar').style.display = 'flex';
    // 载入来访者基本信息到第 1 步
    var c = Store.getClient(currentClientId);
    stepData[0] = App.escapeHtml(c.name) + '（化名）\n' + (c.notes || '');
    // 渲染步骤导航
    renderStepsNav();
    goToStep(0);
  };

  function renderStepsNav() {
    var secs = getSections();
    var nav = document.getElementById('steps-nav');
    nav.innerHTML = secs.map(function (sec, i) {
      var cls = i === currentStep ? ' active' : (stepData[i] ? ' done' : '');
      return '<div class="step' + cls + '" onclick="goToStep(' + i + ')"><span class="dot">' + (i + 1) + '</span><span class="stxt">' + App.escapeHtml(sec.title) + '</span></div>';
    }).join('');
  }

  window.goToStep = function (i) {
    var secs = getSections();
    if (i < 0 || i >= secs.length) return;
    currentStep = i;
    var sec = secs[i];
    document.getElementById('step-title').textContent = (i + 1) + '. ' + sec.title;
    document.getElementById('step-desc').textContent = sec.desc || sec.hint || '';
    // 渲染 textarea
    var body = document.getElementById('step-body');
    var val = stepData[i] || '';
    body.innerHTML = '<textarea id="step-ta" placeholder="' + App.escapeHtml(sec.hint || '请填写…') + '" oninput="stepData[' + i + ']=this.value">' + App.escapeHtml(val) + '</textarea>'
      + '<div class="ai-suggest" id="ai-suggest"><div class="label">AI 建议</div><div id="ai-suggest-content"></div><button class="accept" onclick="acceptAISuggest()">采用此段</button></div>';
    // 按钮状态
    document.getElementById('btn-prev').style.display = i > 0 ? '' : 'none';
    document.getElementById('btn-next').style.display = i < secs.length - 1 ? '' : 'none';
    document.getElementById('btn-next').textContent = i < secs.length - 1 ? '下一步 →' : '完成';
    document.getElementById('btn-ai-step').style.display = currentClientId ? '' : 'none';
    document.getElementById('step-info').textContent = '步骤 ' + (i + 1) + '/' + secs.length;
    renderStepsNav();
  };

  window.prevStep = function () { if (currentStep > 0) goToStep(currentStep - 1); };
  window.nextStep = function () {
    var secs = getSections();
    if (currentStep < secs.length - 1) { goToStep(currentStep + 1); }
    else {
      var html = '<div style="text-align:center;padding:10px 0;line-height:2">' +
        '<div style="font-size:36px;margin-bottom:10px">✅</div>' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:6px">报告已完成</div>' +
        '<div style="font-size:12px;color:var(--ink-3);margin-bottom:16px">你可以导出报告，也可以带着报告去 AI 督导深化分析</div>' +
        '<div style="display:flex;gap:10px;justify-content:center">' +
        '<button onclick="exportWord();App.closeDialog()" style="border:1px solid var(--border);background:var(--paper-2,#fff);border-radius:8px;padding:10px 20px;cursor:pointer;font:13px var(--sans)">📤 导出报告</button>' +
        '<button onclick="location.href=\'supervision.html\'" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font:600 13px var(--sans)">🧠 去 AI 督导</button>' +
        '</div></div>';
      App.confirmDialog(html, function () {});
    }
  };

  // 保存当前 textarea 值
  window.stepData = stepData;

  // AI 填写当前步骤
  window.aiFillCurrent = function () {
    if (!App.aiUnlocked()) { App.showToast('AI 填充需激活后使用', 'warning'); return; }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var secs = getSections();
    var sec = secs[currentStep];
    var ta = document.getElementById('step-ta');
    if (ta) ta.value = '生成中…';
    // 收集选中节次
    var checked = document.querySelectorAll('#sessions-strip input:checked');
    var sessionIds = Array.prototype.map.call(checked, function (c) { return c.value; });
    var sessionData = sessionIds.map(function (sid) {
      var s = Store.getSession(sid);
      if (!s) return '';
      var parts = ['第' + s.sessionNumber + '节 (' + s.date + ')'];
      if (s.transcript) parts.push('逐字稿: ' + s.transcript.slice(0, 800));
      if (s.soap) parts.push('SOAP: S=' + (s.soap.subjective||'').slice(0,300) + ' O=' + (s.soap.objective||'').slice(0,300) + ' A=' + (s.soap.assessment||'').slice(0,300) + ' P=' + (s.soap.plan||'').slice(0,300));
      if (s.notes) parts.push('备注: ' + s.notes.slice(0, 400));
      return parts.join('\n');
    }).join('\n\n');
    var c = Store.getClient(currentClientId);
    var clientInfo = c.name + '（化名），' + (c.notes || '');
    var sys = '你是案例报告撰写助手，温尼科特取向。请根据来访者信息和咨询记录，填写报告模块"' + sec.title + '"。要求专业、具体，引用概念标注英文原词。用中文回应。';
    var userContent = '来访者：' + clientInfo + '\n\n咨询记录：\n' + sessionData + '\n\n请填写模块"' + sec.title + '"的内容。';
    var msgs = [{ role: 'system', content: sys }, { role: 'user', content: userContent }];
    if (typeof AI !== 'undefined' && AI.send) {
      AI.send(msgs, function (res) {
        if (ta) ta.value = '';
        if (res && res.content) {
          var sug = document.getElementById('ai-suggest');
          var sugContent = document.getElementById('ai-suggest-content');
          if (sug && sugContent) { sugContent.textContent = res.content; sug.classList.add('show'); }
        } else {
          App.showToast('生成失败，请重试', 'error');
        }
      });
    } else {
      if (ta) ta.value = '';
      App.showToast('AI 模块未就绪', 'error');
    }
  };

  window.acceptAISuggest = function () {
    var sugContent = document.getElementById('ai-suggest-content');
    var ta = document.getElementById('step-ta');
    if (sugContent && ta) {
      ta.value = sugContent.textContent;
      stepData[currentStep] = ta.value;
    }
    var sug = document.getElementById('ai-suggest');
    if (sug) sug.classList.remove('show');
  };

  // AI 填写全部
  window.aiFillAll = function () {
    if (!App.aiUnlocked()) { App.showToast('AI 填充需激活后使用', 'warning'); return; }
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    var secs = getSections();
    secs.forEach(function (sec, i) { goToStep(i); window.aiFillCurrent(); });
  };

  // 上传模板
  window.onTemplateUpload = function (event) {
    var file = event.target.files[0];
    if (!file) return;
    App.showToast('正在分析模板…', 'info');
    var reader = new FileReader();
    reader.onload = function () {
      var content = reader.result;
      if (file.name.endsWith('.docx') && typeof mammoth !== 'undefined') {
        mammoth.extractRawText({ arrayBuffer: content }).then(function (r) {
          analyzeTemplate(r.value, file.name);
        }).catch(function () { App.showToast('docx 解析失败，请用 .txt 或 .md', 'error'); });
      } else {
        analyzeTemplate(content, file.name);
      }
    };
    if (file.name.endsWith('.docx')) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  };

  function analyzeTemplate(text, filename) {
    if (!text || !text.trim()) { App.showToast('模板内容为空', 'error'); return; }
    if (App.aiUnlocked() && typeof AI !== 'undefined' && AI.send) {
      var sys = '你是案例报告模板分析助手。用户将上传一份案例报告模板，请分析其结构，提取出所有需要填写的模块标题和简要说明。以 JSON 数组格式输出，每个元素包含 title、hint、desc 三个字段。只输出 JSON。';
      AI.send([{ role: 'system', content: sys }, { role: 'user', content: '模板内容：\n' + text.slice(0, 3000) }], function (res) {
        if (res && res.content) {
          try {
            var jsonMatch = res.content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              tplSections = JSON.parse(jsonMatch[0]);
              App.showToast('模板分析完成，已生成 ' + tplSections.length + ' 个模块', 'success');
              currentStep = 0; stepData = {};
              renderStepsNav(); goToStep(0);
              return;
            }
          } catch (e) {}
        }
        autoParseSections(text, filename);
      });
    } else {
      autoParseSections(text, filename);
    }
  }

  function autoParseSections(text, filename) {
    var lines = text.split('\n');
    var sections = [];
    lines.forEach(function (line) {
      var m = line.match(/^[#＃\s]*[\d一二三四五六七八九十]+[.、．\s]+(.+)/);
      if (m && m[1].trim()) sections.push({ title: m[1].trim(), hint: '根据模板要求填写', desc: m[1].trim() });
    });
    if (!sections.length) {
      var paras = text.split(/\n\s*\n/).filter(function (p) { return p.trim().length > 5; });
      paras.slice(0, 10).forEach(function (p, i) {
        sections.push({ title: '段落 ' + (i + 1), hint: p.trim().slice(0, 80), desc: '段落 ' + (i + 1) });
      });
    }
    tplSections = sections;
    App.showToast('已从模板提取 ' + sections.length + ' 个模块', 'success');
    currentStep = 0; stepData = {};
    renderStepsNav(); goToStep(0);
  }

  // 导出 Word
  window.exportWord = function () {
    var secs = getSections();
    var html = '<html><head><meta charset="UTF-8"><style>body{font-family:sans-serif;padding:32px;max-width:700px;line-height:2}h2{font-family:serif;color:#8B93C7}</style></head><body>';
    secs.forEach(function (sec, i) {
      var val = stepData[i] || '';
      if (val.trim()) html += '<h2>' + (i + 1) + '. ' + App.escapeHtml(sec.title) + '</h2><p>' + val.replace(/\n/g, '<br>') + '</p>';
    });
    html += '</body></html>';
    var client = Store.getClient(currentClientId);
    var fname = (client ? client.name : 'report') + '_案例报告.html';
    App.downloadFile(fname, html, 'text/html');
    App.showToast('已导出 Word 兼容 HTML', 'success');
  };

  App.initPage({ title: '撰写报告', subtitle: '', actions: '', noSidebar: true, onReady: function () {
    loadClients();
  }});
})();
