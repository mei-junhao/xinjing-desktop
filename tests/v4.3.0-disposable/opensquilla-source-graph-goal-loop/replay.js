'use strict';
/**
 * XJ-4.3.0-opensquilla-source-graph-goal-loop-01
 * Replay: run from empty state and from resume, verifying ledger recoverability.
 * --from-empty: clear ledger, run full loop, verify deterministic.
 * --resume: keep ledger, continue from last iteration, verify no data loss.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const F = require(path.join(__dirname, 'fixtures.js'));
const LR = require(path.join(__dirname, 'loop-runner.js'));

const LEDGER_PATH = path.resolve(__dirname, '..', '..', '..', 'docs', 'agent-coordination', 'v4.3.0', 'inventory', 'opensquilla-source-graph-goal-loop', 'iteration-ledger.jsonl');

function resetQueue() {
  var q = JSON.parse(fs.readFileSync(path.join(__dirname, 'goal-queue.json'), 'utf8'));
  q.goals.forEach(function (g) { g.status = 'pending'; g.pass_count = 0; g.negative_count = 0; g.iteration_count = 0; g.loop_passes = 0; g.error_count = 0; });
  q.summary = q.summary || {};
  q.summary.pending = 12; q.summary.done = 0; q.summary.blocked = 0; q.summary.total_iterations = 0;
  fs.writeFileSync(path.join(__dirname, 'goal-queue.json'), JSON.stringify(q, null, 2), 'utf8');
}

function fromEmpty() {
  resetQueue();
  if (fs.existsSync(LEDGER_PATH)) fs.writeFileSync(LEDGER_PATH, '', 'utf8');
  LR.runLoop(true);
  var l1 = LR.readLedger();
  var sha1 = crypto.createHash('sha256').update(fs.readFileSync(LEDGER_PATH)).digest('hex').toUpperCase();

  resetQueue();
  fs.writeFileSync(LEDGER_PATH, '', 'utf8');
  LR.runLoop(true);
  var l2 = LR.readLedger();
  var sha2 = crypto.createHash('sha256').update(fs.readFileSync(LEDGER_PATH)).digest('hex').toUpperCase();

  var deterministic = l1.length === l2.length && l1.every(function (e, i) { return e.iteration === l2[i].iteration && e.goal === l2[i].goal && e.classification === l2[i].classification; });
  console.log('=== Replay From Empty ===');
  console.log('Run 1: ' + l1.length + ' entries, SHA=' + sha1.slice(0, 16));
  console.log('Run 2: ' + l2.length + ' entries, SHA=' + sha2.slice(0, 16));
  console.log('Deterministic: ' + deterministic);
  return { deterministic: deterministic, entries1: l1.length, entries2: l2.length, sha1: sha1, sha2: sha2 };
}

function resume() {
  var before = LR.readLedger();
  var beforeCount = before.length;
  var beforeLast = beforeCount > 0 ? before[before.length - 1].iteration : 0;

  LR.runLoop(false);
  var after = LR.readLedger();
  var afterCount = after.length;
  var afterLast = afterCount > 0 ? after[after.length - 1].iteration : 0;

  var noLoss = afterCount >= beforeCount;
  var continued = afterLast >= beforeLast;

  console.log('=== Replay Resume ===');
  console.log('Before: ' + beforeCount + ' entries, last=' + beforeLast);
  console.log('After: ' + afterCount + ' entries, last=' + afterLast);
  console.log('No data loss: ' + noLoss);
  console.log('Continued from last: ' + continued);
  return { noLoss: noLoss, continued: continued, before: beforeCount, after: afterCount, beforeLast: beforeLast, afterLast: afterLast };
}

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.indexOf('--from-empty') >= 0) {
    var r = fromEmpty();
    process.exit(r.deterministic ? 0 : 1);
  } else if (args.indexOf('--resume') >= 0) {
    var r2 = resume();
    process.exit(r2.noLoss && r2.continued ? 0 : 1);
  } else {
    console.log('Usage: node replay.js --from-empty | --resume');
    process.exit(1);
  }
}

module.exports = { fromEmpty: fromEmpty, resume: resume };
