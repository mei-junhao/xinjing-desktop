'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeServerBalance, yuanToMinor } = require('../../app/js/server-balance-projection.js');

const root = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const fetchedAt = '2026-08-02T00:00:00.000Z';

assert.equal(yuanToMinor(12.34), 1234);
assert.equal(yuanToMinor(0), 0);
assert.equal(yuanToMinor(-1), null);
assert.equal(yuanToMinor(1.001), null);
assert.equal(yuanToMinor(Number.MAX_SAFE_INTEGER), null);

const valid = normalizeServerBalance({
  ok: true,
  remainingYuan: 12.34,
  machineCode: 'synthetic-machine-must-not-cross',
  tier: 'v4-flash',
}, fetchedAt);
assert.deepEqual(valid, {
  source: 'server',
  currency: 'CNY',
  remainingBalanceMinor: 1234,
  availableBalanceMinor: null,
  serverRevision: null,
  fetchedAt,
});
assert.equal(Object.prototype.hasOwnProperty.call(valid, 'machineCode'), false);
assert.equal(normalizeServerBalance({ ok: true }, fetchedAt), null);
assert.equal(normalizeServerBalance([], fetchedAt), null);
assert.equal(normalizeServerBalance('server', fetchedAt), null);
assert.equal(normalizeServerBalance({ ok: true, remainingYuan: -1 }, fetchedAt), null);
assert.equal(normalizeServerBalance({ ok: true, remainingYuan: 1.234 }, fetchedAt), null);
assert.equal(normalizeServerBalance({ ok: true, remainingYuan: 2, availableBalanceMinor: 300 }, fetchedAt), null);
assert.equal(normalizeServerBalance({ ok: true, remainingYuan: 2, availableBalanceMinor: null }, fetchedAt).availableBalanceMinor, null);

assert.equal(mainSource.includes("const AI_QUOTA_BASE = AI_PROXY_BASE.replace(/\\/v1$/, '');"), true);
assert.match(mainSource, /AI_QUOTA_BASE \+ '\/quota\?mid=' \+ encodeURIComponent\(machineCode\)/);
assert.doesNotMatch(mainSource, /AI_PROXY_BASE \+ '\/quota\?mid=' \+ encodeURIComponent\(machineCode\)/);
assert.match(mainSource, /method === 'getModelPriceCatalog'[\s\S]{0,240}value: \{\}/);
assert.match(mainSource, /method === 'getAccountBalance'[\s\S]{0,80}readServerAccountBalance/);

console.log('PASS server-authoritative balance route: valid, negative, precision, overflow, optional-field and source-boundary cases');
