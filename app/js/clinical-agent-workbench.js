(function (root) {
  'use strict';
  var state = { root: null, active: null, runs: [] };
  var LABELS = { 'countertransference-analysis': '反移情分析', 'session-review': '会谈复盘', 'case-conceptualization': '个案概念化', 'next-session-hypotheses': '下次会谈假设', 'supervision-question-builder': '督导问题生成', 'multi-school-comparison': '多流派比较', 'supervision-preview': '督导整体印象' };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function render() {
    if (!state.root) return;
    var active = state.active;
    var history = state.runs.slice(0, 8).map(function (run) { return '<div class="xj-agent-history-row"><strong>' + esc(LABELS[run.taskId] || run.taskId) + '</strong><span>' + esc(run.status || 'unknown') + '</span><small>' + esc(run.runId) + '</small><button type="button" data-resume-run="' + esc(run.runId) + '">继续</button></div>'; }).join('');
    state.root.innerHTML = '<div class="xj-agent-workbench-head"><div><small>受控临床 Agent</small><h2>证据与草稿工作台</h2></div><span class="xj-status-chip">只读证据 · 人工确认</span></div>' +
      '<div class="xj-agent-workbench-grid"><section><h3>当前任务</h3>' + (active ? '<div class="xj-agent-run-card"><strong>' + esc(LABELS[active.taskId] || active.taskId) + '</strong><span>运行 ' + esc(active.runId) + '</span><span>快照 ' + esc(active.snapshotKey) + '</span><div class="xj-agent-plan">' + (active.pipelineSteps || []).map(function (step) { return '<span data-state="' + esc(step.status) + '">' + esc(step.id) + ' · ' + esc(step.status) + '</span>'; }).join('') + '</div><div class="xj-agent-columns"><label>事实<textarea data-draft-field="facts" placeholder="仅填写可核对事实"></textarea></label><label>推论<textarea data-draft-field="inferences" placeholder="标注为推论"></textarea></label><label>假设<textarea data-draft-field="hypotheses" placeholder="标注为待验证假设"></textarea></label></div><div class="xj-agent-actions"><button type="button" data-draft-action="adopt">采用草稿</button><button type="button" data-draft-action="discard">丢弃</button></div></div>' : '<div class="xj-agent-empty">完成一次聊天督导后，草稿与计划会显示在这里。</div>') + '</section>' +
      '<section><h3>来源与运行历史</h3><div class="xj-agent-sources">' + (active && active.sources && active.sources.length ? active.sources.map(function (source) { return '<a href="consult-notes.html#source-' + encodeURIComponent(source.id) + '">' + esc(source.kind) + ' · ' + esc(source.id) + '</a>'; }).join('') : '<span class="xj-agent-empty">暂无安全来源摘要</span>') + '</div><div class="xj-agent-history">' + (history || '<span class="xj-agent-empty">暂无可恢复运行</span>') + '</div></section></div>';
    state.root.querySelectorAll('[data-resume-run]').forEach(function (button) { button.addEventListener('click', function () { var run = state.runs.find(function (row) { return row.runId === button.getAttribute('data-resume-run'); }); if (run && typeof window.resumeClinicalAgentRun === 'function') window.resumeClinicalAgentRun(run); }); });
    state.root.querySelectorAll('[data-draft-action]').forEach(function (button) { button.addEventListener('click', function () { if (!state.active) return; state.active.status = button.getAttribute('data-draft-action') === 'adopt' ? 'adopted' : 'discarded'; render(); }); });
  }
  function mount(target) { state.root = typeof target === 'string' ? document.querySelector(target) : target; render(); refreshHistory(); }
  function recordDraft(meta) { state.active = Object.assign({}, meta, { status: 'draft-ready' }); render(); }
  function refreshHistory() { if (!window.ClinicalAgentRunStore || typeof window.ClinicalAgentRunStore.list !== 'function') return; window.ClinicalAgentRunStore.list().then(function (rows) { state.runs = Array.isArray(rows) ? rows : []; render(); }).catch(function () {}); }
  root.XJClinicalAgentWorkbench = Object.freeze({ mount: mount, recordDraft: recordDraft, refreshHistory: refreshHistory });
}(typeof window !== 'undefined' ? window : globalThis));
