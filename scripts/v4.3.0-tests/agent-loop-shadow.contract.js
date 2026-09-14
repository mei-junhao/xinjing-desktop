#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Loop = require('../agent-loop-shadow');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('[PASS] ' + name); }
  catch (error) { console.error('[FAIL] ' + name + ': ' + error.message); process.exitCode = 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-loop-shadow-'));
try {
  const coord = path.join(root, 'docs', 'agent-coordination', 'v4.3.0');
  fs.mkdirSync(path.join(coord, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'agent-coordination', 'current.json'), JSON.stringify({ coordination_root: 'docs/agent-coordination/v4.3.0' }));
  fs.writeFileSync(path.join(coord, 'release-train.yaml'), JSON.stringify({ active_version: '4.3.0', state: 'implementation', transition_id: 'rt-test' }));
  fs.writeFileSync(path.join(coord, 'verification-routes.json'), JSON.stringify({ routes: [
    { id: 'baseline', patterns: ['**/*'], commands: ['baseline'], gates: ['node'] },
    { id: 'billing', patterns: ['app/billing*.html'], commands: ['billing'], gates: ['runtime'] }
  ] }));
  fs.writeFileSync(path.join(coord, 'write-locks.json'), JSON.stringify({ locks: [
    { lock_id: 'lock-a', task_id: 'task-a', state: 'granted', expires_at: '2030-01-01T00:00:00Z' },
    { lock_id: 'lock-b', task_id: 'task-b', state: 'granted', expires_at: '2030-01-01T00:00:00Z' }
  ] }));
  fs.writeFileSync(path.join(root, 'qa', 'task-a.md'), '# delivered');
  fs.writeFileSync(path.join(coord, 'tasks', 'task-a.md'), [
    '```yaml',
    'task_id: task-a',
    'owner: worker',
    'active_release_train: 4.3.0/preparation/old',
    'write_lock_id: lock-a',
    'delivery_report: qa/task-a.md',
    '```'
  ].join('\n'));
  fs.writeFileSync(path.join(coord, 'tasks', 'task-b.md'), [
    '```yaml',
    'task_id: task-b',
    'owner: worker',
    'active_release_train: 4.3.0/preparation/old',
    'write_lock_id: lock-b',
    'delivery_report: qa/task-b.md',
    '```'
  ].join('\n'));

  const state = Loop.buildShadowState(root, '2026-07-24T00:00:00Z', ['app/billing-shell.html']);
  test('uses the active 4.3.0 train', () => assert.strictEqual(state.active_release_train, '4.3.0/implementation/rt-test'));
  test('reads Markdown task cards', () => assert.strictEqual(state.tasks.length, 2));
  test('records historical train drift without blocking delivered work', () => assert.strictEqual(state.tasks.find((task) => task.task_id === 'task-a').blocking_stale_release_train, false));
  test('detects an existing delivery report', () => assert.strictEqual(state.tasks.find((task) => task.task_id === 'task-a').report_exists, true));
  test('does not expire a live lease', () => assert.strictEqual(state.tasks.find((task) => task.task_id === 'task-a').lease_expired, false));
  test('requests rebinding only for an undelivered active task', () => assert(state.actions.some((action) => action.type === 'rebind-task' && action.task_id === 'task-b')));
  test('requests Codex delivery intake', () => assert(state.actions.some((action) => action.type === 'intake-delivery')));
  test('selects baseline verification', () => assert(state.selected_verification.route_ids.includes('baseline')));
  test('routes billing changes', () => assert(state.selected_verification.route_ids.includes('billing')));
  test('deduplicates commands', () => assert.strictEqual(new Set(state.selected_verification.commands).size, state.selected_verification.commands.length));
  test('shadow mode records no side effects', () => assert.deepStrictEqual(state.side_effects, []));
  test('glob matching accepts billing page', () => assert(Loop.globMatches('app/billing*.html', 'app/billing-shell.html')));
  test('glob matching rejects unrelated page', () => assert(!Loop.globMatches('app/billing*.html', 'app/index.html')));
  test('DAG cycle detection catches executable cycle', () => assert.strictEqual(Loop.detectCycles([{ task_id: 'a', depends_on: ['b'] }, { task_id: 'b', depends_on: ['a'] }]).length, 1));
  test('DAG cycle detection accepts a chain', () => assert.strictEqual(Loop.detectCycles([{ task_id: 'a', depends_on: [] }, { task_id: 'b', depends_on: ['a'] }]).length, 0));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Loop shadow contract: ' + passed + ' passed / ' + (process.exitCode ? 1 : 0) + ' failed');
