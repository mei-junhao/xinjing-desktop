'use strict';

const fs = require('fs');
const {
  CONTRACT_PATH,
  parsePolicyManifest,
  validateManifest,
  validateDocument,
} = require('./validate-contract');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policy(manifest, id) {
  return manifest.policies.find(function (entry) { return entry.id === id; });
}

const markdown = fs.readFileSync(CONTRACT_PATH, 'utf8');
const source = parsePolicyManifest(markdown);
const mutations = [
  {
    id: 'default-enabled',
    mutate: function (manifest) { policy(manifest, 'POC-01').assertion.default_enabled = true; },
  },
  {
    id: 'raw-extra-field-ignored',
    mutate: function (manifest) { policy(manifest, 'POC-08').assertion.extra_fields = 'ignore'; },
  },
  {
    id: 'revocation-retains-records',
    mutate: function (manifest) { policy(manifest, 'POC-03').assertion.clear_immediately = false; },
  },
  {
    id: 'ttl-over-seven-days',
    mutate: function (manifest) { manifest.limits.max_ttl_ms = 604800001; },
  },
  {
    id: 'network-side-effect-allowed',
    mutate: function (manifest) {
      manifest.module.forbidden_side_effects = manifest.module.forbidden_side_effects.filter(function (entry) {
        return entry !== 'network';
      });
    },
  },
  {
    id: 'raw-public-failure-enabled',
    mutate: function (manifest) {
      manifest.api.result_envelope.raw_error_allowed = true;
      policy(manifest, 'POC-16').assertion.raw_error_allowed = true;
    },
  },
];

const results = mutations.map(function (mutation) {
  const candidate = clone(source);
  mutation.mutate(candidate);
  const errors = validateManifest(candidate);
  return { id: mutation.id, killed: errors.length > 0, errors };
});

let proseOnlyKilled = false;
let proseOnlyErrors = [];
try {
  const proseOnly = markdown.replace(/```json policy-manifest\r?\n[\s\S]*?\r?\n```/, '');
  const result = validateDocument(proseOnly);
  proseOnlyErrors = result.errors;
  proseOnlyKilled = result.errors.length > 0;
} catch (error) {
  proseOnlyKilled = true;
  proseOnlyErrors = ['canonical policy-manifest required'];
}
results.push({
  id: 'prose-without-canonical-json',
  killed: proseOnlyKilled,
  errors: proseOnlyErrors,
});

const survivors = results.filter(function (result) { return !result.killed; });
process.stdout.write(JSON.stringify({
  ok: survivors.length === 0,
  killed: results.length - survivors.length,
  total: results.length,
  results,
}, null, 2) + '\n');

if (survivors.length) process.exit(1);
