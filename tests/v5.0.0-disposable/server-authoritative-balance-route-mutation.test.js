'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const helperPath = path.join(root, 'app/js/server-balance-projection.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function load(source) {
  const module = { exports: {} };
  vm.runInNewContext(`(function (module, exports) { ${source}\n})(module, module.exports);`, { module });
  return module.exports;
}

function expectKilled(label, source, contract) {
  assert.throws(() => contract(load(source)), undefined, `${label} mutation survived`);
}

expectKilled('relax decimal precision', helperSource.replace('\\.\\d{1,2}', '\\.\\d{1,3}'), (mod) => {
  assert.equal(mod.yuanToMinor(1.001), null);
});
expectKilled('replace server source with local source', helperSource.replace("source: 'server'", "source: 'local'"), (mod) => {
  const value = mod.normalizeServerBalance({ ok: true, remainingYuan: 1 }, '2026-08-02T00:00:00.000Z');
  assert.equal(value && value.source, 'server');
});

const wrongRoute = mainSource.replace("AI_QUOTA_BASE + '/quota?mid='", "AI_PROXY_BASE + '/quota?mid='");
expectKilled('use /v1/quota route', wrongRoute, (source) => {
  assert.match(source, /AI_QUOTA_BASE \+ '\/quota\?mid='/);
  assert.doesNotMatch(source, /AI_PROXY_BASE \+ '\/quota\?mid='/);
});

const localCatalog = mainSource.replace("return { ok: true, value: {}, revision: null, idempotent: false };", "return { ok: true, value: { 'model-alpha': { priceMinor: 100 } }, revision: 1, idempotent: false };");
expectKilled('restore local price catalog', localCatalog, (source) => {
  assert.match(source, /method === 'getModelPriceCatalog'[\s\S]{0,240}value: \{\}/);
  assert.doesNotMatch(source, /model-alpha/);
});

console.log('PASS mutations killed: decimal precision, local source, /v1/quota route and local price catalog');
