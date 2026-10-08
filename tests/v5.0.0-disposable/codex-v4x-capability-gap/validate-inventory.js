'use strict';

const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const INVENTORY_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/agent-coordination/v5.0.0/inventory/codex-v4x-capability-gap/capability-inventory.json'
);
const LOCKS_PATH = path.join(REPOSITORY_ROOT, 'docs/agent-coordination/v5.0.0/write-locks.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalise(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function rootForGlob(glob) {
  const normalised = normalise(glob);
  const wildcard = normalised.search(/[?*]/);
  return wildcard === -1 ? normalised : normalised.slice(0, wildcard).replace(/\/$/, '');
}

function globsOverlap(left, right) {
  const leftRoot = rootForGlob(left);
  const rightRoot = rootForGlob(right);
  return leftRoot === rightRoot || leftRoot.startsWith(rightRoot + '/') || rightRoot.startsWith(leftRoot + '/');
}

function activeLocks(lockDocument) {
  return (lockDocument.locks || []).filter(function (lock) {
    return lock && lock.state === 'active';
  });
}

function validateInventory(inventory, lockDocument, repositoryRoot) {
  const errors = [];
  const statuses = new Set(inventory.allowed_statuses || []);
  const seenIds = new Set();
  const root = repositoryRoot || REPOSITORY_ROOT;

  if (!Array.isArray(inventory.clusters) || inventory.clusters.length === 0) {
    errors.push('clusters must be a non-empty array');
  }

  (inventory.clusters || []).forEach(function (cluster, index) {
    const prefix = 'cluster[' + index + ']';
    if (!cluster || typeof cluster !== 'object') {
      errors.push(prefix + ' must be an object');
      return;
    }
    if (!cluster.id || typeof cluster.id !== 'string') {
      errors.push(prefix + ' is missing id');
    } else if (seenIds.has(cluster.id)) {
      errors.push(prefix + ' duplicates cluster id ' + cluster.id);
    } else {
      seenIds.add(cluster.id);
    }
    if (!cluster.plan_anchor || typeof cluster.plan_anchor !== 'string') {
      errors.push(prefix + ' is missing plan_anchor');
    }
    if (!statuses.has(cluster.status)) {
      errors.push(prefix + ' has unsupported status ' + String(cluster.status));
    }
    if (!Array.isArray(cluster.evidence) || cluster.evidence.length === 0) {
      errors.push(prefix + ' is missing evidence');
    } else {
      cluster.evidence.forEach(function (evidence, evidenceIndex) {
        if (!evidence || !evidence.path || typeof evidence.path !== 'string') {
          errors.push(prefix + '.evidence[' + evidenceIndex + '] is missing path');
          return;
        }
        if (!fs.existsSync(path.resolve(root, evidence.path))) {
          errors.push(prefix + '.evidence[' + evidenceIndex + '] path does not exist: ' + evidence.path);
        }
      });
    }
    if (cluster.status === 'CONFIRMED' && !(cluster.evidence || []).some(function (evidence) {
      return evidence.kind === 'source' || evidence.kind === 'test';
    })) {
      errors.push(prefix + ' CONFIRMED without source or test evidence');
    }
  });

  const currentLocks = activeLocks(lockDocument);
  (inventory.successor_proposals || []).forEach(function (proposal, index) {
    const prefix = 'successor_proposals[' + index + ']';
    if (!proposal || !proposal.task_id || !Array.isArray(proposal.write_allowlist) || proposal.write_allowlist.length === 0) {
      errors.push(prefix + ' is missing task_id or write_allowlist');
      return;
    }
    currentLocks.forEach(function (lock) {
      (lock.globs || []).forEach(function (lockGlob) {
        proposal.write_allowlist.forEach(function (proposalGlob) {
          if (globsOverlap(lockGlob, proposalGlob)) {
            errors.push(prefix + ' overlaps active lock ' + lock.lock_id + ': ' + proposalGlob + ' <> ' + lockGlob);
          }
        });
      });
    });
  });

  return errors;
}

function main() {
  const errors = validateInventory(readJson(INVENTORY_PATH), readJson(LOCKS_PATH), REPOSITORY_ROOT);
  if (errors.length) {
    errors.forEach(function (error) { console.error('[FAIL] ' + error); });
    process.exitCode = 1;
    return;
  }
  console.log('capability-gap inventory: PASS');
}

if (require.main === module) main();

module.exports = {
  activeLocks,
  globsOverlap,
  readJson,
  validateInventory,
  INVENTORY_PATH,
  LOCKS_PATH,
  REPOSITORY_ROOT
};
