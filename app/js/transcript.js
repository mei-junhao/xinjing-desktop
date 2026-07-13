/* 心镜 v3.1.0 — 逐字稿整理（双栏对照 + AI 错误检测 + 记忆库） */
(function () {
  'use strict';
  var currentClientId = null;
  var lines = [];          // {speaker, text, errors: [{pos,len,fix,type}], fixed: bool}
  var memRules = [];       // [{pattern, fix, count}]
  var errorCount = 0;
  var fixedCount = 0;

  // 加载记忆库
  function loadMemRules() {
    try {
      var raw = localStorage.getItem('xj_transcript_mem');
      if (raw) memRules = JSON.parse(raw) || [];
    } catch(e) { memRules = []; }
    updateMemUI();
  }
  function saveMemRules() {
    try { localStorage.setItem('xj_transcript_mem', JSON.stringify(memRules)); } catch(e) {}
    updateMemUI();
  }
  function updateMemUI() {
    document.getElementById('mem-count').textContent = memRules.length + ' 条规则';
  }

  // 来访者列表
  var selClient = document.getElementById('tp-client');
  Store.getClients().forEach(function (c) {
    var opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    selClient.appendChild(opt);
  });

  window.loadClient = function () {
    currentClientId = selClient.value || null;
    if (!currentClientId) return;
    var c = Store.getClient(currentClientId);
    App.showToast('已选择 ' + c.name, 'success');
  };

  window.loadRawText = function () {
    document.getElementById('tp-input').focus();
    document.getElementById('tp-input').placeholder = '粘贴逐字稿文本（每行一个对话轮次，如 "T: 你好" 或 "P: 我今天感觉……"）…';
  };

  window.processInput = function () {
    var raw = document.getElementById('tp-input').value.trim();
    if (!raw) { App.showToast('请先粘贴文本', 'warning'); return; }
    parseLines(raw);
    renderOriginal();
    renderFixed();
    document.getElementById('tp-input').value = '';
  };

  function parseLines(raw) {
    lines = [];
    var rawLines = raw.split('\n').filter(Boolean);
    rawLines.forEach(function (l, i) {
      var speaker = '';
      var text = l;
      // 尝试识别说话人标记
      var m = l.match(/^([TPCQ]\s*[:：])\s*(.*)/);
      if (m) {
        speaker = m[1].trim();
        text = m[2];
      } else {
        m = l.match(/^(治疗师|咨询师|来访者|来访|T|P|C|Q)\s*[:：]\s*(.*)/);
        if (m) { speaker = m[1]; text = m[2]; }
      }
      lines.push({ speaker: speaker, text: text, errors: [], fixed: false, original: l });
    });
    updateStats();
  }

  // AI 检测错误
  window.detectErrors = function () {
    if (!lines.length) { App.showToast('请先导入文本', 'warning'); return; }
    if (!App.aiUnlocked()) { App.showToast('AI 检测需激活后使用', 'warning'); return; }

    // 先应用记忆规则
    applyMemRules();

    // 清理旧错误标记
    lines.forEach(function (l) { l.errors = []; l.fixed = false; });
    errorCount = 0; fixedCount = 0;

    var text = lines.map(function (l) { return l.speaker + ': ' + l.text; }).join('\n');
    var sys = '你是心理咨询逐字稿校对专家。请检测以下逐字稿中的错误，包括：\n' +
      '1. 错别字 / 同音字（如"抱持"写成"保持"）\n' +
      '2. 术语错误（如"移情"写成"移情别恋"）\n' +
      '3. 人名 / 理论名拼写错误\n' +
      '4. 明显的语义不通顺\n\n' +
      '输出 JSON 格式：{"errors":[{"line":行号(从1开始),"pos":错误位置(字符偏移),"length":错误长度,"fix":"修正文本","type":"typology/term/name/grammar"}]}\n' +
      '只输出 JSON，不要其他文字。如果没有错误，输出 {"errors":[]}';

    App.showToast('AI 检测中…', 'info');
    AI.send([{ role: 'system', content: sys }, { role: 'user', content: text }], function (res) {
      if (res && res.content && !res.error) {
        try {
          var json = JSON.parse(res.content.replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
          var errs = json.errors || [];
          errs.forEach(function (e) {
            var idx = e.line - 1;
            if (idx >= 0 && idx < lines.length) {
              lines[idx].errors.push({ pos: e.pos, len: e.length, fix: e.fix, type: e.type || 'unknown' });
              errorCount++;
            }
          });
          renderOriginal();
          renderFixed();
          updateStats();
          App.showToast('检测完成，发现 ' + errorCount + ' 处错误', errorCount > 0 ? 'warning' : 'success');
        } catch (e) {
          App.showToast('AI 返回格式异常，请重试', 'error');
        }
      } else {
        App.showToast('AI 检测失败', 'error');
      }
    });
  };

  function applyMemRules() {
    if (!memRules.length) return;
    lines.forEach(function (l) {
      memRules.forEach(function (rule) {
        var idx = 0;
        while ((idx = l.text.indexOf(rule.pattern, idx)) >= 0) {
          // 检查是否已有该修正
          var exists = l.errors.some(function (e) { return e.pos === idx && e.len === rule.pattern.length; });
          if (!exists) {
            l.errors.push({ pos: idx, len: rule.pattern.length, fix: rule.fix, type: 'memory' });
            errorCount++;
          }
          idx += rule.pattern.length;
        }
      });
    });
  }

  // 修正一处错误
  window.fixError = function (lineIdx, errIdx) {
    var l = lines[lineIdx];
    var err = l.errors[errIdx];
    if (!err || l.fixed) return;
    // 自动修正所有同样的错误
    var autoCount = 0;
    lines.forEach(function (otherL, oi) {
      if (oi === lineIdx && l.fixed) return;
      var idx = 0;
      while ((idx = otherL.text.indexOf(err.fix, idx)) >= 0) {
        otherL.text = otherL.text.slice(0, idx) + otherL.text.slice(idx + err.fix.length);
        idx += 1; // 避免无限循环
      }
      // 找原词
      idx = 0;
      var pattern = lines[oi].text.slice(err.pos, err.pos + err.len);
      while ((idx = otherL.text.indexOf(pattern, idx)) >= 0) {
        otherL.text = otherL.text.slice(0, idx) + err.fix + otherL.text.slice(idx + pattern.length);
        otherL.fixed = true;
        idx += err.fix.length;
        autoCount++;
      }
    });
    l.fixed = true;
    l.text = l.text.slice(0, err.pos) + err.fix + l.text.slice(err.pos + err.len);
    fixedCount++;
    errorCount--;

    // 存入记忆库
    var pattern = lines[lineIdx].text.slice(err.pos, err.pos + err.len);
    // 用原词模板
    var originalWord = lines[lineIdx].original ? lines[lineIdx].original.slice(err.pos, err.pos + err.len) : pattern;
    var existing = memRules.find(function (r) { return r.pattern === originalWord; });
    if (existing) {
      existing.count = (existing.count || 1) + 1;
    } else {
      memRules.push({ pattern: originalWord, fix: err.fix, count: 1, type: err.type, createdAt: new Date().toISOString() });
    }
    saveMemRules();

    renderOriginal();
    renderFixed();
    updateStats();
    App.showToast('已修正，相同错误已自动处理，已存入记忆库', 'success');
  };

  function renderOriginal() {
    var box = document.getElementById('original-text');
    box.innerHTML = lines.map(function (l, i) {
      var textHtml = App.escapeHtml(l.text);
      // 标记错误
      var sortedErrs = [].concat(l.errors).sort(function (a, b) { return a.pos - b.pos; });
      sortedErrs.forEach(function (err) {
        var errText = App.escapeHtml(l.text.slice(err.pos, err.pos + err.len));
        var replacement = '<span class="err' + (l.fixed ? ' fixed' : '') + '" onclick="fixError(' + i + ',' + l.errors.indexOf(err) + ')" title="修正为：' + App.escapeHtml(err.fix) + '">' + errText + '</span>';
        textHtml = textHtml.replace(errText, replacement);
      });
      return '<div class="tp-line">' +
        '<span class="ln">' + (i + 1) + '</span>' +
        (l.speaker ? '<span class="speaker">' + App.escapeHtml(l.speaker) + '</span>' : '') +
        '<span class="text">' + textHtml + '</span>' +
        '<span class="action">' +
          (l.errors.length ? '<button onclick="fixError(' + i + ',0)" title="修正">✓</button>' : '') +
        '</span></div>';
    }).join('');
  }

  function renderFixed() {
    var box = document.getElementById('fixed-text');
    box.innerHTML = lines.map(function (l, i) {
      var text = l.text;
      // 把已修正的旧词标为删除线
      var sortedErrs = [].concat(l.errors).sort(function (a, b) { return a.pos - b.pos; });
      sortedErrs.forEach(function (err) {
        if (l.fixed) {
          var old = text.slice(err.pos, err.pos + err.len);
          text = text.slice(0, err.pos) + '<span class="err fixed">' + App.escapeHtml(old) + '</span>' + text.slice(err.pos + err.len);
        }
      });
      return '<div class="tp-line">' +
        '<span class="ln">' + (i + 1) + '</span>' +
        (l.speaker ? '<span class="speaker">' + App.escapeHtml(l.speaker) + '</span>' : '') +
        '<span class="text">' + App.escapeHtml(text).replace(/\n/g, '<br>') + '</span></div>';
    }).join('');
    document.getElementById('fixed-badge').textContent = fixedCount + ' 处修正';
  }

  function updateStats() {
    document.getElementById('stat-lines').textContent = lines.length;
    document.getElementById('stat-errors').textContent = errorCount;
    document.getElementById('stat-fixed').textContent = fixedCount;
  }

  window.saveTranscript = function () {
    if (!currentClientId) { App.showToast('请先选择来访者', 'warning'); return; }
    if (!lines.length) { App.showToast('无内容可保存', 'warning'); return; }
    var text = lines.map(function (l) { return (l.speaker ? l.speaker + ': ' : '') + l.text; }).join('\n');
    var sessions = Store.getSessionsByClient(currentClientId).sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    if (sessions.length) {
      Store.updateSessionFull(sessions[0].id, { transcript: text });
      App.showToast('已保存到最近一次会话的逐字稿', 'success');
    } else {
      App.showToast('请先在咨询记录中创建会话', 'warning');
    }
  };

  window.exportTranscript = function () {
    if (!lines.length) { App.showToast('无内容可导出', 'warning'); return; }
    var text = lines.map(function (l) { return (l.speaker ? l.speaker + ': ' : '') + l.text; }).join('\n');
    var report = '【逐字稿整理报告】\n\n';
    report += '总行数：' + lines.length + '\n';
    report += '发现错误：' + (errorCount + fixedCount) + ' 处\n';
    report += '已修正：' + fixedCount + ' 处\n\n';
    if (memRules.length) {
      report += '【记忆库规则】\n';
      memRules.forEach(function (r) { report += '  "' + r.pattern + '" → "' + r.fix + '"（' + r.count + '次）\n'; });
      report += '\n';
    }
    report += '【修正后全文】\n\n' + text;
    App.downloadFile('逐字稿_' + App.todayStr() + '.txt', report, 'text/plain');
    App.showToast('已导出', 'success');
  };

  window.goToNotes = function () {
    location.href = 'consult-notes.html';
  };

  window.showMemRules = function () {
    if (!memRules.length) { App.showToast('记忆库暂无规则', 'info'); return; }
    var html = '<div style="font-size:13px;line-height:2">' +
      memRules.map(function (r) {
        return '<div style="padding:6px 0;border-bottom:1px solid var(--border)">' +
          '🔁 "' + App.escapeHtml(r.pattern) + '" → "' + App.escapeHtml(r.fix) + '" <span style="color:var(--ink-3);font-size:11px">(' + r.count + '次, ' + (r.type || 'unknown') + ')</span></div>';
      }).join('') + '</div>';
    App.confirmDialog(html, function () {});
  };

  window.clearMem = function () {
    App.confirmDialog('确定清空记忆库？清空后需重新学习错误模式。', function () {
      memRules = [];
      saveMemRules();
      App.showToast('记忆库已清空', 'success');
    });
  };

  // 初始化
  loadMemRules();
})();