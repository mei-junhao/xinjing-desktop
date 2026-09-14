'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadRouterFromSource } = require('../v5.0.0-production/support/load-chat-proxy-router.js');

const root = path.resolve(__dirname, '../..');
const serverPath = path.join(root, 'server', 'chat-proxy-server.js');
const serverSource = fs.readFileSync(serverPath, 'utf8');

function assertCanonicalQuotaDispatch(source) {
  const router = loadRouterFromSource(source, serverPath);
  const quota = JSON.parse(router.invoke('GET', '/quota?mid=synthetic-machine').body);
  assert.equal(quota.remainingYuan, 5);
  assert.equal(quota.machineCode, 'synthetic-machine');

  const v1Quota = JSON.parse(router.invoke('GET', '/v1/quota?mid=synthetic-machine').body);
  assert.equal(Object.hasOwn(v1Quota, 'remainingYuan'), false);
  assert.equal(Object.hasOwn(v1Quota, 'machineCode'), false);
}

assert.doesNotThrow(() => assertCanonicalQuotaDispatch(serverSource));
const wrongRoute = serverSource.replace("urlPath === '/quota'", "urlPath === '/v1/quota'");
assert.notEqual(wrongRoute, serverSource, 'route mutation did not modify the exact source');
assert.throws(() => assertCanonicalQuotaDispatch(wrongRoute), undefined, 'server quota-route mutation survived');

console.log('PASS runtime mutation killed: moving quota to /v1/quota breaks the exact-router contract');
