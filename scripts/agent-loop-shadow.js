#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

function scalar(text, key) {
  const match = text.match(new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+?)\\s*$', 'm'));
  return match ? match[1].replace(/^['"]|['"]$/g, '') : null;
}

function list(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp('^' + key + ':\\s*$').test(line));
  if (start < 0) return [];
  const values = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s{2}-\s+(.+?)\s*$/);
    if (!match) break;
    values.push(match[1]);
  }
  return values;
}

function readTask(file) {
  if (file.endsWith('.json')) return Object.assign({ source_file: file }, readJson(file) || {});
  const text = fs.readFileSync(file, 'utf8');
  return {
    source_file: file,
    task_id: scalar(text, 'task_id'),
    owner: scalar(text, 'owner'),
    active_release_train: scalar(text, 'active_release_train'),
    write_lock_id: scalar(text, 'write_lock_id'),
    delivery_report: scalar(text, 'delivery_report'),
    depends_on: list(text, 'depends_on')
  };
}

function collectTasks(coordinationRoot) {
  const dir = path.join(coordinationRoot, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') || name.endsWith('.md'))
    .map((name) => readTask(path.join(dir, name)))
    .filter((task) => task.task_id);
}

function detectCycles(tasks) {
  const graph = new Map(tasks.map((task) => [task.task_id, task.depends_on || []]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(id, trail) {
    if (visiting.has(id)) { cycles.push(trail.concat(id)); return; }
    if (visited.has(id) || !graph.has(id)) return;
    visiting.add(id);
    (graph.get(id) || []).forEach((dependency) => visit(dependency, trail.concat(id)));
    visiting.delete(id);
    visited.add(id);
  }
  graph.forEach((unused, id) => visit(id, []));
  return cycles;
}

function globMatches(pattern, file) {
  const normalizedPattern = String(pattern).replace(/\\/g, '/');
  const normalizedFile = String(file).replace(/\\/g, '/');
  if (normalizedPattern === '**/*') return true;
  const expression = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + expression + '$').test(normalizedFile);
}

function selectVerificationRoutes(routes, changedFiles) {
  const selected = (routes || []).filter((route) => route.id === 'baseline' || (changedFiles || []).some((file) => (route.patterns || []).some((pattern) => globMatches(pattern, file))));
  return {
    route_ids: selected.map((route) => route.id),
    commands: Array.from(new Set(selected.flatMap((route) => route.commands || []))),
    gates: Array.from(new Set(selected.flatMap((route) => route.gates || [])))
  };
}

function buildShadowState(root, nowValue, changedFiles) {
  const coordRoot = path.join(root, 'docs', 'agent-coordination');
  const current = readJson(path.join(coordRoot, 'current.json')) || {};
  const coordinationRoot = path.resolve(root, current.coordination_root || path.join('docs', 'agent-coordination', 'v4.2.1'));
  const train = readJson(path.join(coordinationRoot, 'release-train.yaml')) || {};
  const lockFile = readJson(path.join(coordinationRoot, 'write-locks.json')) || { locks: [] };
  const routes = readJson(path.join(coordinationRoot, 'verification-routes.json')) || { routes: [] };
  const expectedTrain = [train.active_version, train.state, train.transition_id].join('/');
  const now = new Date(nowValue || Date.now());
  const lockById = new Map((lockFile.locks || []).map((lock) => [lock.lock_id, lock]));
  const tasks = collectTasks(coordinationRoot).map((task) => {
    const lock = lockById.get(task.write_lock_id);
    const report = task.delivery_report ? path.resolve(root, task.delivery_report) : null;
    const reportExists = !!report && fs.existsSync(report);
    const historical = reportExists && (!lock || lock.state === 'released');
    const staleTrain = task.active_release_train !== expectedTrain;
    const blockingStale = staleTrain && !reportExists;
    const expired = !!lock && lock.state !== 'released' && Number.isFinite(Date.parse(lock.expires_at)) && Date.parse(lock.expires_at) <= now.getTime();
    let status = 'queued';
    if (historical) status = 'delivered-historical';
    else if (expired) status = 'expired-lock';
    else if (reportExists) status = 'delivery-awaiting-intake';
    else if (blockingStale) status = 'stale-release-train';
    else if (lock && lock.state === 'granted') status = 'active';
    else if (lock && lock.state === 'released') status = 'lock-released';
    return Object.assign({}, task, { lock_state: lock && lock.state || 'missing', report_exists: reportExists, historical, stale_release_train: staleTrain, blocking_stale_release_train: blockingStale, lease_expired: expired, status });
  });
  const actions = [];
  tasks.forEach((task) => {
    if (task.blocking_stale_release_train) actions.push({ type: 'rebind-task', task_id: task.task_id, blocking: true, reason: 'active task release-train differs from active train' });
    if (task.lease_expired) actions.push({ type: 'expire-lock', task_id: task.task_id, blocking: true, reason: 'write-lock lease expired' });
    if (task.report_exists && !task.historical) actions.push({ type: 'intake-delivery', task_id: task.task_id, blocking: false, reason: 'delivery report exists and requires Codex verification' });
  });
  const cycles = detectCycles(tasks);
  cycles.forEach((cycle) => actions.push({ type: 'break-cycle', task_id: cycle[0], blocking: true, reason: cycle.join(' -> ') }));
  const normalizedChangedFiles = (changedFiles || []).map((file) => String(file).replace(/\\/g, '/')).filter(Boolean);
  return {
    schema_version: 1,
    mode: 'shadow',
    generated_at: now.toISOString(),
    active_release_train: expectedTrain,
    coordination_root: path.relative(root, coordinationRoot).replace(/\\/g, '/'),
    tasks,
    cycles,
    verification_routes: routes.routes || [],
    changed_files: normalizedChangedFiles,
    selected_verification: selectVerificationRoutes(routes.routes || [], normalizedChangedFiles),
    actions,
    user_interruptions_allowed: ['product-decision', 'remote-sign-publish-authority', 'unrecoverable-after-three-materially-different-attempts'],
    side_effects: []
  };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const changedFiles = process.argv.filter((value) => value.startsWith('--changed=')).map((value) => value.slice('--changed='.length));
  process.stdout.write(JSON.stringify(buildShadowState(root, null, changedFiles), null, 2) + '\n');
}

module.exports = { buildShadowState, collectTasks, detectCycles, globMatches, selectVerificationRoutes };
