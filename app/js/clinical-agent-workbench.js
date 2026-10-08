(function (root) {
  'use strict';
  var state = { root: null, active: null, runs: [], dirty: false, busy: false, message: '', refreshId: 0 };
  var LABELS = { 'countertransference-analysis': '反移情分析', 'session-review': '会谈复盘', 'case-conceptualization': '个案概念化', 'next-session-hypotheses': '下次会谈假设', 'supervision-question-builder': '督导问题生成', 'multi-school-comparison': '多流派比较', 'supervision-preview': '督导整体印象' };
  var STATUS = { planned: '已计划', 'awaiting-context': '等待来源', 'awaiting-confirmation': '等待确认', running: '执行中或已中断', 'draft-ready': '草稿待审阅', adopted: '已人工采用 · 本机草稿', persisted: '已保存', failed: '生成失败', stale: '来源已过期', cancelled: '已取消或丢弃' };
  var STEPS = { 'context-builder': '构建上下文', 'intent-classifier': '识别任务', 'supervision-router': '选择工作流', 'evidence-validator': '核验来源', 'draft-orchestrator': '编排草稿' };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sourceHref(source, origin) {
    var store = root.Store, id = source && source.id, kind = source && source.kind;
    if (!store || !id || !origin) return '';
    var item, route, params = new URLSearchParams();
    if (kind === 'client') { item = store.getClient(id); if (!item || item.id !== origin.clientId) return ''; route = 'doc-center.html'; }
    else if (kind === 'session') { item = store.getSession(id); if (!item || item.clientId !== origin.clientId) return ''; route = 'consult-notes.html'; params.set('sessionId', id); }
    else if (kind === 'material') { item = store.getMaterialWorkspace(id); if (!item || item.clientId !== origin.clientId || item.sessionId !== origin.sessionId) return ''; route = 'transcript.html'; params.set('materialId', id); if (item.sessionId) params.set('sessionId', item.sessionId); }
    else if (kind === 'supervision') { item = store.getSupervision(id); if (!item || item.clientId !== origin.clientId) return ''; route = 'real-supervision.html'; params.set('id', id); }
    else return '';
    if (origin.clientId) params.set('clientId', origin.clientId);
    return route + '?' + params.toString();
  }
  function message(copy) { state.message = copy; var node = state.root && state.root.querySelector('[data-agent-feedback]'); if (node) node.textContent = copy; }
  function fields() {
    var out = {};
    if (state.root) state.root.querySelectorAll('[data-draft-field]').forEach(function (node) { out[node.dataset.draftField] = node.value; });
    return out;
  }
  function currentSelection() { return typeof root.getClinicalAgentSelection === 'function' ? root.getClinicalAgentSelection() : {}; }
  function confirmLeave(event) {
    if (state.busy || state.dirty && !root.confirm('草稿编辑尚未保存，离开会丢失这些编辑。仍要离开吗？')) {
      event.preventDefault(); event.stopImmediatePropagation();
      message(state.busy ? '正在保存草稿，请稍后再离开。' : '编辑已保留，请先保存编辑。');
      return;
    }
    state.dirty = false;
  }
  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', function (event) {
      var link = event.target && event.target.closest && event.target.closest('a[href]');
      if (!link || link.hasAttribute('download') || link.target && link.target !== '_self' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      var destination = new URL(link.href, root.location.href), current = new URL(root.location.href);
      if (destination.origin === current.origin && destination.pathname === current.pathname && destination.search === current.search) return;
      if (state.dirty || state.busy) confirmLeave(event);
    }, true);
    root.addEventListener('beforeunload', function (event) {
      if (!state.dirty && !state.busy) return;
      message('草稿编辑尚未保存，请先保存编辑后再离开。');
      event.preventDefault(); event.returnValue = '';
    });
  }
  function isFresh(active, document) {
    if (!root.ClinicalAgentRunStore.sameOrigin(active.origin, currentSelection())) return false;
    var task = active.taskId === 'multi-school-comparison' ? 'supervision-multi-school' : active.taskId === 'supervision-question-builder' || active.taskId === 'supervision-preview' ? 'supervision-ai' : active.taskId;
    var built = root.ClinicalContext.build(task, currentSelection(), { inputText: document.question });
    return built && built.ok === true && built.snapshot.key === active.snapshotKey;
  }
  async function operate(action) {
    if (!state.active || state.busy) return;
    var active = state.active, edited = fields(), document;
    state.busy = true;
    state.root.querySelectorAll('[data-draft-action]').forEach(function (button) { button.disabled = true; });
    try {
      document = await root.ClinicalAgentRunStore.getDraft(active.runId);
      if (!document || (action !== 'discard' && !isFresh(active, document))) { message('当前来访者或来源已变更，编辑内容已保留。请返回原上下文，或重新生成草稿。'); return; }
      if (action === 'discard' && !root.confirm('丢弃这份本机草稿？正式会谈记录不会改变。')) return;
      var result = await root.ClinicalAgentRunStore.updateDraft(active.runId, edited, action, { origin: active.origin, snapshotKey: active.snapshotKey });
      if (!result || !result.ok) { message('保存失败，编辑内容仍在。请检查本机存储后重试。'); return; }
      state.dirty = false;
      state.active = action === 'discard' ? null : Object.assign({}, active, { status: result.draft.status, fields: result.draft.fields });
      state.message = action === 'discard' ? '已丢弃本机草稿，正式记录未改变。' : action === 'adopt' ? '已保存人工采用的本机草稿，正式记录未改变。' : '编辑已保存到本机草稿。';
      await refreshHistory(false);
      render();
    } catch (_) { message('本机草稿读取或保存失败，编辑内容仍在，请重试。'); }
    finally { state.busy = false; if (state.root) state.root.querySelectorAll('[data-draft-action]').forEach(function (button) { button.disabled = false; }); }
  }
  function render() {
    if (!state.root) return;
    var active = state.active, activeFields = active && active.fields || {};
    var history = state.runs.map(function (run) {
      var open = ['draft-ready', 'adopted'].indexOf(run.status) >= 0;
      var resume = root.ClinicalAgentRunStore.isResumable(run) || ['failed', 'stale'].indexOf(run.status) >= 0;
      return '<div class="xj-agent-history-row"><strong>' + esc(LABELS[run.taskId] || run.taskId) + '</strong><span>' + esc(STATUS[run.status]) + '</span><small>' + esc(run.runId) + '</small>' +
        (open ? '<button type="button" data-open-run="' + esc(run.runId) + '"><i data-lucide="file-pen-line"></i>审阅草稿</button>' : resume ? '<button type="button" data-resume-run="' + esc(run.runId) + '"><i data-lucide="play"></i>' + (run.status === 'failed' || run.status === 'stale' ? '重新预览' : '继续') + '</button>' : '') + '</div>';
    }).join('');
    state.root.innerHTML = '<div class="xj-agent-workbench-head"><div><h2>证据与草稿</h2><small>仅本机草稿 · 未写入正式记录</small></div><span class="xj-status-chip">' + esc(active ? STATUS[active.status] : '暂无草稿') + '</span></div><p data-agent-feedback role="status" aria-live="polite">' + esc(state.message) + '</p>' +
      '<div class="xj-agent-workbench-grid"><section><h3>当前任务</h3>' + (active ? '<div class="xj-agent-run-card"><strong>' + esc(LABELS[active.taskId]) + '</strong><span>运行 ' + esc(active.runId) + '</span><span>快照 ' + esc(active.snapshotKey) + '</span><ol class="xj-agent-plan">' + (active.stepIds || []).map(function (id) { return '<li>' + esc(STEPS[id] || id) + '</li>'; }).join('') + '</ol><div class="xj-agent-columns">' +
        ['facts', 'inferences', 'hypotheses'].map(function (key, index) { return '<label>' + ['事实（待人工核对）', '推论', '待验证假设'][index] + '<textarea data-draft-field="' + key + '">' + esc(activeFields[key] || '') + '</textarea></label>'; }).join('') + '</div><div class="xj-agent-actions"><button type="button" data-draft-action="adopt"><i data-lucide="check"></i>人工采用</button><button type="button" data-draft-action="save"><i data-lucide="save"></i>保存编辑</button><button type="button" data-draft-action="discard"><i data-lucide="trash-2"></i>丢弃</button></div></div>' : '<div class="xj-agent-empty">暂无草稿</div>') + '</section><section><h3>来源</h3><div class="xj-agent-sources">' +
      (active && active.sources.length ? active.sources.map(function (source) { var href = sourceHref(source, active.origin); return href ? '<a href="' + esc(href) + '">' + esc(({ client: '来访者', session: '会谈', material: '材料', supervision: '督导记录' })[source.kind]) + ' · ' + esc(source.id) + '</a>' : '<span>来源不可用 · ' + esc(source.id) + '</span>'; }).join('') : '<span class="xj-agent-empty">暂无来源</span>') +
      '</div><h3>运行历史</h3><div class="xj-agent-history">' + (history || '<span class="xj-agent-empty">暂无运行记录</span>') + '</div></section></div>';
    state.root.querySelectorAll('[data-draft-field]').forEach(function (node) { node.addEventListener('input', function () { state.dirty = true; }); });
    state.root.querySelectorAll('[data-draft-action]').forEach(function (button) { button.addEventListener('click', function () { operate(button.dataset.draftAction); }); });
    state.root.querySelectorAll('[data-open-run]').forEach(function (button) { button.addEventListener('click', function () { openDraft(button.dataset.openRun); }); });
    state.root.querySelectorAll('[data-resume-run]').forEach(function (button) { button.addEventListener('click', function () { var run = state.runs.find(function (row) { return row.runId === button.dataset.resumeRun; }); if (run && root.resumeClinicalAgentRun) root.resumeClinicalAgentRun(run); }); });
    if (root.IconSystem) root.IconSystem.render(state.root);
  }
  async function openDraft(runId) {
    if (state.busy || (state.dirty && !root.confirm('当前编辑尚未保存，切换草稿会丢失这些编辑。仍要切换吗？'))) return;
    try {
      var run = await root.ClinicalAgentRunStore.get(runId), document = await root.ClinicalAgentRunStore.getDraft(runId);
      if (!run || !document || document.snapshotKey !== run.snapshotKey || !root.ClinicalAgentRunStore.sameOrigin(document.origin, run.origin) || !root.ClinicalAgentRunStore.sameOrigin(run.origin, currentSelection())) { message('请先选择该草稿所属的来访者、会谈和材料。'); return; }
      state.active = Object.assign({}, run, { fields: document.fields, status: document.status }); state.dirty = false; state.message = ''; render();
    } catch (_) { message('读取草稿失败，请重试。'); }
  }
  async function refreshHistory(restore) {
    var id = ++state.refreshId;
    try {
      var rows = await root.ClinicalAgentRunStore.list();
      if (id !== state.refreshId) return;
      state.runs = rows;
      if (restore && !state.active) {
        var candidate = rows.find(function (run) { return ['draft-ready', 'adopted'].indexOf(run.status) >= 0 && root.ClinicalAgentRunStore.sameOrigin(run.origin, currentSelection()); });
        if (candidate) { var document = await root.ClinicalAgentRunStore.getDraft(candidate.runId); if (id !== state.refreshId) return; if (document && document.snapshotKey === candidate.snapshotKey && root.ClinicalAgentRunStore.sameOrigin(document.origin, candidate.origin)) state.active = Object.assign({}, candidate, { fields: document.fields }); }
      }
      if (!state.dirty && !state.busy) render();
    } catch (_) { message('运行历史读取失败，请重试。'); }
  }
  function mount(target) {
    state.root = typeof target === 'string' ? root.document.querySelector(target) : target;
    render(); return refreshHistory(true);
  }
  async function recordDraft(meta) {
    var result = await root.ClinicalAgentRunStore.saveDraft(meta);
    if (!result.ok) { message('生成结果尚未保存，不能采用。请保留聊天中的草稿并重试。'); return result; }
    if (state.dirty || state.busy) { await refreshHistory(false); message('新草稿已保存。当前编辑已保留，保存后可从运行历史审阅新草稿。'); return result; }
    var run = await root.ClinicalAgentRunStore.get(meta.runId);
    state.active = Object.assign({}, run || meta, { fields: result.draft.fields, status: 'draft-ready' }); state.dirty = false; state.message = '';
    await refreshHistory(false); render(); return result;
  }
  root.XJClinicalAgentWorkbench = Object.freeze({ mount: mount, recordDraft: recordDraft, refreshHistory: refreshHistory, openDraft: openDraft, sourceHref: sourceHref });
}(typeof window !== 'undefined' ? window : globalThis));
