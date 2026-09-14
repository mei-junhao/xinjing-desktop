'use strict';

const validator = require('./validate-inventory');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectRejected(label, mutate) {
  const inventory = clone(validator.readJson(validator.INVENTORY_PATH));
  const locks = clone(validator.readJson(validator.LOCKS_PATH));
  mutate(inventory, locks);
  const errors = validator.validateInventory(inventory, locks, validator.REPOSITORY_ROOT);
  if (errors.length === 0) {
    console.error('[FAIL] ' + label + ': mutation survived');
    return false;
  }
  console.log('[PASS] ' + label + ': mutation killed');
  return true;
}

const results = [
  expectRejected('M1-missing-plan-anchor', function (inventory) {
    inventory.clusters[0].plan_anchor = '';
  }),
  expectRejected('M2-duplicate-cluster', function (inventory) {
    inventory.clusters[1].id = inventory.clusters[0].id;
  }),
  expectRejected('M3-missing-evidence-path', function (inventory) {
    inventory.clusters[2].evidence[0].path = 'does-not-exist/unsupported-evidence.js';
  }),
  expectRejected('M4-unsupported-status', function (inventory) {
    inventory.clusters[3].status = 'GREEN';
  }),
  expectRejected('M5-successor-overlaps-active-lock', function (inventory, locks) {
    if (validator.activeLocks(locks).length === 0) {
      locks.locks.push({
        lock_id: 'mutation-active-lock',
        state: 'active',
        globs: ['tests/mutation-active-lock/**']
      });
    }
    const active = validator.activeLocks(locks)[0];
    inventory.successor_proposals[0].write_allowlist = [active.globs[0]];
  })
];

const killed = results.filter(Boolean).length;
console.log('inventory mutations: ' + killed + '/' + results.length + ' killed');
if (killed !== results.length) process.exitCode = 1;
