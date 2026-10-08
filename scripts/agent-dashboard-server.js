#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { buildShadowState } = require('./agent-loop-shadow');

const ROOT = path.resolve(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'qa', 'agent-dashboard');
const COORD_ROOT = path.join(ROOT, 'docs', 'agent-coordination');
const CURRENT = readJson(path.join(COORD_ROOT, 'current.json'));
const COORD = CURRENT && CURRENT.coordination_root
  ? path.resolve(ROOT, CURRENT.coordination_root)
  : path.join(COORD_ROOT, 'v4.2.1');
const REPORT_DIRS = [path.join(ROOT, 'qa', 'agent-reviews'), path.join(ROOT, 'qa', 'agent-reports')];
const PORT = Number(process.env.XJ_AGENT_DASHBOARD_PORT || 4317);
const ROSTER = {
  codex: 'Codex', codebuddy: 'CodeBuddy', opencode: 'OpenCode', 'grok-4.5-pi': 'Grok 4.5', marvis: 'Marvis', trae: 'Trae', opensquilla: 'OpenSquilla', workbuddy: 'WorkBuddy'
};

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; } }
function within(base, target) { const relative = path.relative(base, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
function listJson(dir) { try { return fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch (error) { return []; } }
function classify(status) {
  const value = String(status || '');
  if (value.startsWith('completed') || value.startsWith('delivered') || value.startsWith('revoked')) return 'done';
  if (value.includes('blocked') || value.includes('rework') || value.includes('rejected') || value.includes('fail')) return 'blocked';
  if (value === 'completed') return 'done';
  if (value.includes('ready') || value.includes('awaiting')) return 'ready';
  if (value.includes('progress')) return 'active';
  return 'hold';
}
function taskWeight(task) {
  const kind = classify(task.status);
  return { active: 0, ready: 1, blocked: 2, hold: 3, done: 4 }[kind] ?? 5;
}
function taskFiles() {
  return listJson(path.join(COORD, 'tasks')).map((name) => {
    const file = path.join(COORD, 'tasks', name); const task = readJson(file); if (!task) return null;
    let modifiedAt = 0; try { modifiedAt = fs.statSync(file).mtimeMs; } catch (error) {}
    const reportFile = task.delivery_report ? path.resolve(ROOT, task.delivery_report) : '';
    return Object.assign({}, task, { file: path.relative(ROOT, file).replace(/\\/g, '/'), modifiedAt, reportExists: !!reportFile && fs.existsSync(reportFile) });
  }).filter(Boolean);
}
function lockState() {
  const data = readJson(path.join(COORD, 'write-locks.json')) || {};
  return (data.locks || []).map((lock) => Object.assign({}, lock, { active: lock.state !== 'released' }));
}
function releaseTrain() {
  return readJson(path.join(COORD, 'release-train.yaml')) || {
    active_version: CURRENT && CURRENT.active_version || 'unknown',
    state: CURRENT && CURRENT.state || 'unknown'
  };
}
function reports() {
  const rows = [];
  REPORT_DIRS.forEach((dir) => {
    let names = []; try { names = fs.readdirSync(dir); } catch (error) { return; }
    names.filter((name) => name.endsWith('.md')).forEach((name) => {
      const absolute = path.join(dir, name); let stat; try { stat = fs.statSync(absolute); } catch (error) { return; }
      const first = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).find((line) => line.trim().startsWith('#')) || name;
      const owner = Object.keys(ROSTER).find((id) => name.toLowerCase().includes(id.replace('grok-4.5-pi', 'grok45pi'))) || 'local';
      rows.push({ name, title: first.replace(/^#+\s*/, ''), path: path.relative(ROOT, absolute).replace(/\\/g, '/'), updatedAt: stat.mtimeMs, updatedLabel: new Date(stat.mtimeMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), owner: ROSTER[owner] || owner });
    });
  });
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}
function deriveNext(tasks, train, latestCandidate, loopShadow) {
  const steps = []; const actions = loopShadow && loopShadow.actions || []; const intake = actions.find((action) => action.type === 'intake-delivery'); const stale = actions.find((action) => action.type === 'rebind-task'); const expired = actions.find((action) => action.type === 'expire-lock'); const active = tasks.find((task) => classify(task.status) === 'active'); const review = tasks.find((task) => task.owner === 'grok-4.5-pi' && classify(task.status) === 'ready' && !task.reportExists); const reviewReport = tasks.find((task) => task.owner === 'grok-4.5-pi' && classify(task.status) === 'ready' && task.reportExists); const rework = tasks.find((task) => String(task.status || '').startsWith('rework-required'));
  if (intake) steps.push({ title: '验收已到交付并释放对应写锁', detail: intake.task_id + ' 的报告已落盘；先核验真实差异、哈希和测试，再决定接纳或返工。', owner: 'Codex' });
  if (expired) steps.push({ title: '收回过期写锁', detail: expired.task_id + ' 的租约已过期；保留证据并阻止继续写入。', owner: 'Codex' });
  if (stale) steps.push({ title: '重绑定仍活动的陈旧任务卡', detail: stale.task_id + ' 仍指向旧 release train，未修正前不得继续写入。', owner: 'Codex' });
  if (active) steps.push({ title: '等待当前执行中的任务交付', detail: active.task_id + ' 正在进行，保留写锁，等待 Markdown 报告。', owner: ROSTER[active.owner] || active.owner });
  if (reviewReport) steps.push({ title: '读取并验收 Grok 独立评审报告', detail: '报告已落盘；核对候选 SHA、评分、P0/P1 和 release-ready 边界，再更新任务卡状态。', owner: 'Codex' });
  if (review) steps.push({ title: '启动无上下文独立评审', detail: '先核验八文件 SHA，再执行 import、durable、self-test 和语法门禁。', owner: 'Grok 4.5' });
  if (rework) steps.push({ title: '完成返工后再重新绑定候选', detail: rework.task_id + ' 仍有返工项，旧评审不可复用。', owner: ROSTER[rework.owner] || rework.owner });
  if (!steps.length && train.candidate && train.candidate.status === 'not-created') steps.push({ title: '创建 local candidate 记录', detail: '当前 release-train 仍是 candidate: not-created，局部测试通过不等于 release-ready。', owner: 'Codex' });
  if (!steps.length) steps.push({ title: '等待下一条真实交付证据', detail: '没有新的自动动作，继续保持本地、只读和无远程发布边界。', owner: 'Codex' });
  return steps;
}
function timeline(tasks, locks, reportRows) {
  const lockByTask = new Map(locks.map((lock) => [lock.task_id, lock]));
  const reportByTask = new Map(tasks.filter((task) => task.delivery_report).map((task) => [task.task_id, reportRows.find((report) => report.path === task.delivery_report)]));
  const now = Date.now();
  return tasks.filter((task) => classify(task.status) !== 'done' || task.modifiedAt > now - 36 * 60 * 60 * 1000).map((task) => {
    const lock = lockByTask.get(task.task_id); const report = reportByTask.get(task.task_id);
    const lockedAt = lock && Date.parse(lock.acquired_at); const startAt = Number.isFinite(lockedAt) ? lockedAt : Math.max(0, task.modifiedAt - 60 * 60 * 1000);
    const done = classify(task.status) === 'done'; const endAt = Math.max(startAt + 1, done ? (report ? report.updatedAt : task.modifiedAt) : now);
    const id = task.task_id || ''; const phase = id.includes('billing') ? '账务耐久化' : id.includes('durable') || id.includes('store') ? '数据耐久化' : id.includes('acceptance') || id.includes('review') ? '验收与评审' : id.includes('visual') || id.includes('trae') ? 'UI/UX 准备' : id.includes('entitlement') ? '权益契约' : '发布列车';
    return { task_id: task.task_id, owner: ROSTER[task.owner] || task.owner, status: task.status, phase, startAt, endAt };
  }).sort((a, b) => b.endAt - a.endAt).slice(0, 12);
}
function buildState() {
  const loopShadow = buildShadowState(ROOT); const taskMap = new Map(taskFiles().map((task) => [task.task_id, task]));
  loopShadow.tasks.forEach((task) => { if (!taskMap.has(task.task_id)) taskMap.set(task.task_id, Object.assign({}, task, { file: path.relative(ROOT, task.source_file).replace(/\\/g, '/'), reportExists: task.report_exists })); });
  const tasks = Array.from(taskMap.values()); const locks = lockState(); const train = releaseTrain(); const reportRows = reports();
  const kinds = tasks.map((task) => classify(task.status)); const blocked = kinds.filter((kind) => kind === 'blocked').length; const completed = kinds.filter((kind) => kind === 'done').length; const attention = tasks.filter((task) => classify(task.status) !== 'done').length; const activeLocks = locks.filter((lock) => lock.active).length;
  const candidateTask = tasks.find((task) => task.candidate_sha256 && task.status === 'authorized-ready-independent-review') || tasks.find((task) => task.candidate_bundle_sha256);
  const latestCandidate = candidateTask ? { status: candidateTask.reportExists ? 'independent review delivered; Codex verification pending' : 'local candidate awaiting independent review', sha256: candidateTask.candidate_sha256 || candidateTask.candidate_bundle_sha256, task_id: candidateTask.task_id } : {};
  const gateLabel = train.candidate && train.candidate.status === 'not-created' ? '未进入 release-ready' : (blocked ? '存在阻塞' : '等待确认');
  return { generatedAt: new Date().toISOString(), root: 'D:/xinjing-electron', releaseTrain: train, tasks: tasks.sort((a, b) => taskWeight(a) - taskWeight(b) || (b.modifiedAt || 0) - (a.modifiedAt || 0)), locks, reports: reportRows, timeline: timeline(tasks, locks, reportRows), latestCandidate, nextSteps: deriveNext(tasks, train, latestCandidate, loopShadow), loopShadow, summary: { total: tasks.length, attention, blocked, completed, activeLocks, gateLabel, gateKind: blocked ? 'is-blocked' : '' } };
}
function sendJson(res, value, statusCode) { const body = JSON.stringify(value); res.writeHead(statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(body); }
function serveStatic(res, pathname) {
  const file = path.resolve(DASHBOARD, pathname === '/' ? 'index.html' : '.' + pathname); if (!within(DASHBOARD, file)) return sendJson(res, { error: 'not found' }, 404);
  fs.readFile(file, (error, data) => { if (error) return sendJson(res, { error: 'not found' }, 404); const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }; res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data); });
}
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/api/state') return sendJson(res, buildState());
  if (parsed.pathname === '/vendor/lucide.min.js') {
    const vendor = path.join(ROOT, 'app', 'vendor', 'lucide.min.js');
    try { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(vendor)); } catch (error) { return sendJson(res, { error: 'vendor not found' }, 404); }
  }
  if (parsed.pathname === '/api/report') {
    const relative = String(parsed.query.path || '').replace(/\\/g, '/'); const target = path.resolve(ROOT, relative); if (!within(ROOT, target) || !target.endsWith('.md')) return sendJson(res, { error: 'invalid report path' }, 400);
    try { return sendJson(res, { name: path.basename(target), content: fs.readFileSync(target, 'utf8') }); } catch (error) { return sendJson(res, { error: 'report not found' }, 404); }
  }
  if (req.method !== 'GET') return sendJson(res, { error: 'method not allowed' }, 405);
  return serveStatic(res, parsed.pathname);
});
server.listen(PORT, '127.0.0.1', () => { console.log('XinJing Agent Control Room: http://127.0.0.1:' + PORT); console.log('Watching: ' + COORD); });
