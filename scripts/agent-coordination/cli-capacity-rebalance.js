'use strict';

const fs = require('fs');
const path = require('path');

const EXECUTORS = [
  { id: 'reasonix-cli', owner: /reasonix/i, hardMax: 4 },
  { id: 'pi-cli', owner: /(^|-)pi($|-)|pi-cli/i, hardMax: 4 },
  { id: 'claude-cli', owner: /claude/i, hardMax: 3 },
  { id: 'opensquilla-cli', owner: /opensquilla/i, hardMax: 4 },
];

function trailingNumber(taskId) {
  const match = String(taskId || '').match(/(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function isAccepted(state) {
  return /^accepted(?:-|$)/i.test(String(state || ''));
}

function isNegative(state) {
  return /(blocked|rework|required|failed|revoked)/i.test(String(state || ''));
}

function summarize(ledger, executor, windowSize, historyAfterTaskNumber = -1) {
  const tasks = Array.isArray(ledger.tasks) ? ledger.tasks : [];
  const recent = tasks
    .filter((task) => executor.owner.test(String(task.owner || '')))
    .map((task, index) => ({ ...task, _index: index, _number: trailingNumber(task.task_id) }))
    .filter((task) => task._number > historyAfterTaskNumber)
    .sort((a, b) => b._number - a._number || b._index - a._index)
    .slice(0, windowSize);

  const accepted = recent.filter((task) => isAccepted(task.state)).length;
  const negative = recent.filter((task) => isNegative(task.state)).length;
  let acceptedStreak = 0;
  for (const task of recent) {
    if (!isAccepted(task.state)) break;
    acceptedStreak += 1;
  }

  const sample = recent.length;
  const smoothedCompletion = (accepted + 1) / (sample + 2);
  const score = smoothedCompletion + Math.min(acceptedStreak, 3) * 0.08;
  return { sample, accepted, negative, acceptedStreak, smoothedCompletion, score };
}

function calculate(ledger, health, options = {}) {
  const totalCapacity = Number(options.totalCapacity || 6);
  const windowSize = Number(options.windowSize || 12);
  const rows = EXECUTORS.map((executor) => {
    const probe = health.executors && health.executors[executor.id] || {};
    const historyAfterTaskNumber = Number.isFinite(Number(probe.history_after_task_number))
      ? Number(probe.history_after_task_number)
      : -1;
    const metrics = summarize(ledger, executor, windowSize, historyAfterTaskNumber);
    const usable = probe.usable === true;
    const coldStart = metrics.accepted === 0;
    return {
      ...executor,
      ...metrics,
      usable,
      requestedModel: probe.requested_model || null,
      actualModel: probe.actual_model || null,
      historyAfterTaskNumber,
      maxSlots: usable ? Math.min(executor.hardMax, coldStart ? 1 : executor.hardMax) : 0,
      slots: 0,
    };
  });

  let remaining = totalCapacity;
  for (const row of rows) {
    if (row.usable && row.maxSlots > 0 && remaining > 0) {
      row.slots = 1;
      remaining -= 1;
    }
  }

  while (remaining > 0) {
    const eligible = rows
      .filter((row) => row.usable && row.slots < row.maxSlots)
      .sort((a, b) => (b.score / (b.slots + 1)) - (a.score / (a.slots + 1)) || a.id.localeCompare(b.id));
    if (!eligible.length) break;
    eligible[0].slots += 1;
    remaining -= 1;
  }

  const allocations = Object.fromEntries(rows.map((row) => [row.id, row.slots]));
  return {
    schema_version: 1,
    total_capacity: totalCapacity,
    allocated_capacity: totalCapacity - remaining,
    unallocated_capacity: remaining,
    allocations,
    executors: Object.fromEntries(rows.map((row) => [row.id, {
      usable: row.usable,
      sample: row.sample,
      accepted: row.accepted,
      negative: row.negative,
      accepted_streak: row.acceptedStreak,
      smoothed_completion_rate: Number(row.smoothedCompletion.toFixed(4)),
      score: Number(row.score.toFixed(4)),
      requested_model: row.requestedModel,
      actual_model: row.actualModel,
      history_after_task_number: row.historyAfterTaskNumber,
      slots: row.slots,
    }])),
    rules: {
      recompute_on: ['before_dispatch', 'after_codex_intake', 'after_health_change'],
      cold_start_max_slots: 1,
      unavailable_slots: 0,
      one_active_writer_per_production_file: true,
      quotas_are_upper_bounds_not_fill_targets: true,
      default_total_capacity: 6,
      capacity_may_exceed_default_when_explicitly_requested: true,
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) throw new Error(`Unknown argument: ${key || ''}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ledger || !args.health) {
    throw new Error('Usage: node cli-capacity-rebalance.js --ledger <path> --health <path> [--out <path>] [--total-capacity <positive integer>]');
  }
  const ledger = JSON.parse(fs.readFileSync(path.resolve(args.ledger), 'utf8'));
  const health = JSON.parse(fs.readFileSync(path.resolve(args.health), 'utf8'));
  const totalCapacity = args['total-capacity'] === undefined ? 6 : Number(args['total-capacity']);
  if (!Number.isInteger(totalCapacity) || totalCapacity <= 0) {
    throw new Error('--total-capacity must be a positive integer');
  }
  const result = { generated_at: new Date().toISOString(), ...calculate(ledger, health, { totalCapacity }) };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), output, 'utf8');
  process.stdout.write(output);
}

module.exports = { calculate };
