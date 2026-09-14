'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACT_PATH = path.join(
  ROOT,
  'docs',
  'agent-coordination',
  'v5.0.0',
  'contracts',
  'v4.5-privacy-observability-core-v1.md'
);

const POLICY_IDS = Array.from({ length: 16 }, function (_, index) {
  return 'POC-' + String(index + 1).padStart(2, '0');
});
const INPUT_FIELDS = ['errorCode', 'version', 'stage', 'recoveryResult'];
const RECORD_FIELDS = INPUT_FIELDS.concat('timestamp');
const ERROR_CODES = [
  'UNKNOWN_FAILURE',
  'APP_STARTUP_FAILED',
  'RENDERER_EVENT_FAILED',
  'STORAGE_READ_FAILED',
  'STORAGE_WRITE_FAILED',
  'BACKUP_FAILED',
  'AI_REQUEST_FAILED',
  'NETWORK_REQUEST_FAILED',
  'IPC_REQUEST_FAILED',
  'UPDATE_FAILED',
  'SHUTDOWN_FAILED',
];
const STAGES = [
  'startup',
  'renderer',
  'storage-read',
  'storage-write',
  'backup',
  'ai',
  'network',
  'ipc',
  'update',
  'shutdown',
];
const RECOVERY_RESULTS = ['not-attempted', 'recovered', 'degraded', 'failed', 'cancelled'];
const PUBLIC_ERROR_CODES = [
  'invalid-config',
  'invalid-clock',
  'consent-required',
  'invalid-event',
  'unknown-error-code',
  'invalid-version',
  'unknown-stage',
  'unknown-recovery-result',
  'internal-failure',
];
const FORBIDDEN_SIDE_EFFECTS = [
  'network',
  'file',
  'console',
  'dom',
  'electron',
  'store',
  'ipc',
  'ambient-global-read',
  'ambient-global-write-except-designated-umd-export',
];

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function same(actual, expected) {
  return canonical(actual) === canonical(expected);
}

function parsePolicyManifest(markdown) {
  const blocks = Array.from(markdown.matchAll(/```json policy-manifest\r?\n([\s\S]*?)\r?\n```/g));
  if (blocks.length !== 1) throw new Error('expected exactly one policy-manifest JSON block');
  return JSON.parse(blocks[0][1]);
}

function policyMap(manifest) {
  return new Map((manifest.policies || []).map(function (policy) { return [policy.id, policy]; }));
}

function validateManifest(manifest) {
  const errors = [];
  function expect(condition, message) {
    if (!condition) errors.push(message);
  }
  function expectSame(actual, expected, message) {
    expect(same(actual, expected), message);
  }

  expect(manifest.schema_version === 1, 'schema_version');
  expect(manifest.contract_id === 'v4.5-privacy-observability-core-v1', 'contract_id');
  expect(manifest.module && manifest.module.source_path === 'app/js/privacy-observability-core.js', 'source_path');
  expect(manifest.module && manifest.module.commonjs_export === 'module.exports', 'commonjs_export');
  expect(manifest.module && manifest.module.browser_global === 'XJPrivacyObservabilityCore', 'browser_global');
  expectSame(manifest.module && manifest.module.allowed_side_effects, ['umd-export-only'], 'allowed_side_effects');
  expectSame(manifest.module && manifest.module.forbidden_side_effects, FORBIDDEN_SIDE_EFFECTS, 'forbidden_side_effects');

  expect(manifest.limits && manifest.limits.min_ttl_ms === 60000, 'min_ttl_ms');
  expect(manifest.limits && manifest.limits.default_ttl_ms === 86400000, 'default_ttl_ms');
  expect(manifest.limits && manifest.limits.max_ttl_ms === 604800000, 'max_ttl_ms');
  expect(manifest.limits && manifest.limits.min_capacity === 1, 'min_capacity');
  expect(manifest.limits && manifest.limits.default_capacity === 100, 'default_capacity');
  expect(manifest.limits && manifest.limits.max_capacity === 500, 'max_capacity');
  expect(manifest.limits && manifest.limits.max_clock_ms === 8640000000000000, 'max_clock_ms');

  expectSame(manifest.registries && manifest.registries.input_fields, INPUT_FIELDS, 'input_fields');
  expectSame(manifest.registries && manifest.registries.record_fields, RECORD_FIELDS, 'record_fields');
  expectSame(manifest.registries && manifest.registries.error_codes, ERROR_CODES, 'error_codes');
  expectSame(manifest.registries && manifest.registries.stages, STAGES, 'stages');
  expectSame(manifest.registries && manifest.registries.recovery_results, RECOVERY_RESULTS, 'recovery_results');
  expectSame(manifest.registries && manifest.registries.public_error_codes, PUBLIC_ERROR_CODES, 'public_error_codes');
  expect(Array.isArray(manifest.registries && manifest.registries.forbidden_input_classes)
    && manifest.registries.forbidden_input_classes.length === 9, 'forbidden_input_classes');
  expect(manifest.registries && manifest.registries.version_pattern
    === '^(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})\\.(0|[1-9]\\d{0,2})(?:-[0-9A-Za-z.-]{1,32})?$', 'version_pattern');

  expect(manifest.api && manifest.api.factory === 'createPrivacyObservability', 'factory');
  expect(manifest.api && manifest.api.factory_result === 'result-envelope', 'factory_result');
  expectSame(manifest.api && manifest.api.runtime_methods,
    ['grantConsent', 'revokeConsent', 'record', 'clear', 'getState', 'exportSupportReport'], 'runtime_methods');
  expect(manifest.api && manifest.api.result_envelope && manifest.api.result_envelope.raw_error_allowed === false,
    'result_envelope.raw_error_allowed');
  expectSame(manifest.api && manifest.api.support_export_fields,
    ['schemaVersion', 'generatedAt', 'records'], 'support_export_fields');

  const ids = (manifest.policies || []).map(function (policy) { return policy.id; });
  expectSame(ids, POLICY_IDS, 'policy_ids');
  expect(new Set(ids).size === 16, 'policy_ids_unique');
  const policies = policyMap(manifest);
  function assertion(id) {
    const policy = policies.get(id);
    return policy && policy.assertion;
  }

  expectSame(assertion('POC-01'), { default_enabled: false }, 'POC-01');
  expectSame(assertion('POC-02'), {
    grant_method: 'grantConsent', record_requires_consent: true, export_requires_consent: true,
  }, 'POC-02');
  expectSame(assertion('POC-03'), {
    revoke_method: 'revokeConsent', disable_immediately: true, clear_immediately: true,
  }, 'POC-03');
  expectSame(assertion('POC-04'), {
    input_fields_ref: 'registries.input_fields',
    record_fields_ref: 'registries.record_fields',
    plain_object_required: true,
    core_generates_timestamp: true,
  }, 'POC-04');
  expectSame(assertion('POC-05'), {
    registry_ref: 'registries.error_codes', unknown_error_code: 'reject',
  }, 'POC-05');
  expectSame(assertion('POC-06'), {
    registry_ref: 'registries.stages', unknown_stage: 'reject',
  }, 'POC-06');
  expectSame(assertion('POC-07'), {
    registry_ref: 'registries.recovery_results', unknown_recovery_result: 'reject',
  }, 'POC-07');
  expectSame(assertion('POC-08'), {
    extra_fields: 'reject', forbidden_classes_ref: 'registries.forbidden_input_classes',
  }, 'POC-08');
  expectSame(assertion('POC-09'), {
    default_ttl_ms_ref: 'limits.default_ttl_ms',
    max_ttl_ms_ref: 'limits.max_ttl_ms',
    prune_on: ['record', 'getState', 'exportSupportReport'],
    invalid_config: 'fail-closed',
  }, 'POC-09');
  expectSame(assertion('POC-10'), {
    default_capacity_ref: 'limits.default_capacity',
    max_capacity_ref: 'limits.max_capacity',
    overflow: 'drop-oldest',
  }, 'POC-10');
  expectSame(assertion('POC-11'), {
    export_method: 'exportSupportReport',
    export_fields_ref: 'api.support_export_fields',
    record_fields_ref: 'registries.record_fields',
    consent_required: true,
  }, 'POC-11');
  expectSame(assertion('POC-12'), { deep_frozen: true, internal_reference_exposed: false }, 'POC-12');
  expectSame(assertion('POC-13'), {
    allowed_side_effects_ref: 'module.allowed_side_effects',
    forbidden_side_effects_ref: 'module.forbidden_side_effects',
  }, 'POC-13');
  expectSame(assertion('POC-14'), {
    commonjs_ref: 'module.commonjs_export', browser_global_ref: 'module.browser_global', same_api_identity: true,
  }, 'POC-14');
  expectSame(assertion('POC-15'), {
    injected_clock_option: 'clock',
    clock_returns: 'epoch-ms-safe-integer',
    invalid_time: 'fail-closed',
    timestamp_format: 'iso-8601-utc',
  }, 'POC-15');
  expectSame(assertion('POC-16'), {
    public_methods_throw: false,
    failure_registry_ref: 'registries.public_error_codes',
    raw_error_allowed: false,
    failure_value: null,
  }, 'POC-16');

  return errors;
}

function validateDocument(markdown) {
  const manifest = parsePolicyManifest(markdown);
  const errors = validateManifest(manifest);
  POLICY_IDS.forEach(function (id) {
    if (!markdown.includes('### ' + id + ' ')) errors.push('missing prose section ' + id);
  });
  manifest.api.runtime_methods.forEach(function (method) {
    if (!markdown.includes('`' + method + '(') && !markdown.includes('`' + method + '()`')) {
      errors.push('missing API prose for ' + method);
    }
  });
  return { manifest, errors };
}

function main() {
  const markdown = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const result = validateDocument(markdown);
  if (result.errors.length) {
    process.stderr.write(JSON.stringify({ ok: false, errors: result.errors }, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    contract_id: result.manifest.contract_id,
    policy_count: result.manifest.policies.length,
    policy_ids: result.manifest.policies.map(function (policy) { return policy.id; }),
  }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  CONTRACT_PATH,
  parsePolicyManifest,
  validateManifest,
  validateDocument,
};

