'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { candidateRoot: ROOT } = require('./harness-paths');
const governancePath = path.join(ROOT, 'app', 'js', 'prompt-governance.js');

function source(id, version, kind, label, content, hash) {
  const item = { id, version, kind, label, source: label + '.synthetic', content };
  if (hash !== undefined) item.contentHash = hash;
  return item;
}

function run() {
  delete require.cache[require.resolve(governancePath)];
  const governance = require(governancePath);
  const hashA = governance.sha256('SYNTHETIC_A');

  const deduped = governance.mergeKnowledgeSources([
    source('knowledge:one', 'v1', 'master-builtin', '内置知识', 'SYNTHETIC_A', hashA),
    source('knowledge:one', 'v1', 'user-library', '用户资料', 'SYNTHETIC_A', hashA),
  ]);
  assert.strictEqual(deduped.ok, true, 'same id/version/hash must deduplicate across labels');
  assert.strictEqual(deduped.sources.length, 1, 'cross-label duplicate must have one accepted identity');

  const conflict = governance.mergeKnowledgeSources([
    source('knowledge:one', 'v1', 'master-builtin', '内置知识', 'SYNTHETIC_A'),
    source('knowledge:one', 'v1', 'user-library', '用户资料', 'SYNTHETIC_B'),
  ]);
  assert.strictEqual(conflict.ok, false, 'same id/version different hash must conflict across labels');
  assert.strictEqual(conflict.text, '');
  assert.ok(conflict.conflicts.every((item) => !Object.prototype.hasOwnProperty.call(item, 'content')), 'conflict projection must not leak content');

  assert.throws(() => governance.mergeKnowledgeSources([source('knowledge:one', '', 'master-builtin', '内置知识', 'x')]), /version/);
  assert.throws(() => governance.mergeKnowledgeSources([source('knowledge:one', 'v1', 'unknown-kind', '未知', 'x')]), /Unsupported/);
  assert.throws(() => governance.mergeKnowledgeSources([{ id: 'knowledge:one', version: 'v1', kind: 'master-builtin', label: '内置知识', source: 'x', content: 'x', contentHash: '' }]), /hash/);
  assert.throws(() => governance.mergeKnowledgeSources([source('knowledge:one', 'v1', 'master-builtin', '内置知识', 'SYNTHETIC_A', governance.sha256('OTHER'))]), /hash mismatch/);

  const rendered = governance.mergeKnowledgeSources([source('knowledge:two', 'v1', 'master-builtin', '内置知识', 'SYNTHETIC_A', hashA)]);
  assert.strictEqual(rendered.ok, true);
  assert.ok(rendered.text.includes(hashA));
  assert.ok(fs.readFileSync(governancePath, 'utf8').includes("normalized.id + '@' + normalized.version"), 'merge identity must exclude kind/label');

  console.log(JSON.stringify({ suite: 'prompt-governance-candidate', pass: 11, fail: 0, root: ROOT }, null, 2));
}

try { run(); } catch (error) { console.error(error && error.stack || error); process.exit(1); }
