'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRouterFromSource } = require('./support/load-chat-proxy-router.js');

const root = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const serverPath = path.join(root, 'server', 'chat-proxy-server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

assert.match(mainSource, /const AI_QUOTA_BASE = AI_PROXY_BASE\.replace\(/);
assert.match(mainSource, /AI_QUOTA_BASE \+ '\/quota\?mid=' \+ encodeURIComponent\(machineCode\)/);
assert.doesNotMatch(mainSource, /AI_PROXY_BASE \+ '\/quota\?mid=' \+ encodeURIComponent\(machineCode\)/);
assert.equal((mainSource.match(/AI_QUOTA_BASE \+ '\/quota\?mid=' \+ encodeURIComponent\(machineCode\)/g) || []).length, 2);

const router = loadRouterFromSource(serverSource, serverPath);
assert.equal(router.syntheticListeners.length, 2);
assert.deepEqual(router.syntheticListeners.map((listener) => listener.kind), ['https', 'http']);

const quotaResponse = router.invoke('GET', '/quota?mid=synthetic-machine');
assert.equal(quotaResponse.statusCode, 200);
const quotaBody = JSON.parse(quotaResponse.body);
assert.equal(quotaBody.ok, true);
assert.equal(quotaBody.machineCode, 'synthetic-machine');
assert.equal(quotaBody.remainingYuan, 5);
assert.equal(quotaBody.tier, 'v4-flash');

const v1QuotaResponse = router.invoke('GET', '/v1/quota?mid=synthetic-machine');
assert.equal(v1QuotaResponse.statusCode, 200);
const v1QuotaBody = JSON.parse(v1QuotaResponse.body);
assert.equal(v1QuotaBody.ok, true);
assert.equal(Object.hasOwn(v1QuotaBody, 'remainingYuan'), false);
assert.equal(Object.hasOwn(v1QuotaBody, 'machineCode'), false);
assert.equal(v1QuotaBody.quotaBudgetYuan, 5);

console.log('PASS exact router: /quota returns quota data and /v1/quota remains non-quota health data');
