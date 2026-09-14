'use strict';
// XJ-5.0.0 Codex v4.3 跨会话临床任务追踪 — 场景矩阵验证器 (takeover-04)
// 运行: node validate-scenarios.js
// 退出码: 0 = PASS, 1 = FAIL
//
// Healthy baseline always verifies the frozen inputs. Mutation probes may skip
// only those global hashes after the healthy baseline has passed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..'); // tests/v5.0.0-disposable/<task> -> xinjing-electron
const MATRIX_PATH = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/workbuddy-cross-session-task-scenarios/scenario-matrix.json');
const MANIFEST_PATH = path.join(ROOT, 'docs/agent-coordination/v5.0.0/inventory/codex-v4.3-cross-session-task-scenarios-takeover/protected-files-manifest.json');
const EXPECTED_TASK_ID = 'XJ-5.0.0-codex-v4.3-cross-session-task-scenarios-takeover-04';

const REQUIRED_SCENARIO_IDS = [
  'S01-creating-task-in-session-a',
  'S02-viewing-in-later-session-b',
  'S03-dashboard-visibility',
  'S04-refresh-restart-continuity',
  'S05-completion',
  'S06-cancellation',
  'S07-missing-origin-session',
  'S08-client-session-mismatch',
  'S09-deletion-migration-handling',
  'S10-no-accidental-clinical-content-copying'
];

const REQUIRED_STATUS_BY_ID = Object.freeze({
  'S01-creating-task-in-session-a': 'CONFIRMED',
  'S02-viewing-in-later-session-b': 'EXPECTED_RED',
  'S03-dashboard-visibility': 'CONFIRMED',
  'S04-refresh-restart-continuity': 'CONFIRMED',
  'S05-completion': 'CONFIRMED',
  'S06-cancellation': 'EXPECTED_RED',
  'S07-missing-origin-session': 'BLOCKED',
  'S08-client-session-mismatch': 'CONFIRMED',
  'S09-deletion-migration-handling': 'BLOCKED',
  'S10-no-accidental-clinical-content-copying': 'CONFIRMED'
});

const SCENARIO_REQUIRED_FIELDS = [
  'id', 'name', 'synthetic_scenario', 'expected_status',
  'current_evidence_status', 'missing_behavior', 'source_anchor',
  'failure_expectation', 'missing_proof'
];

// [rework-02] 显式场景字段白名单：场景对象只能含白名单内字段。
// 任何白名单外字段（transcript / raw_content / body / content / clinical_body 等任意内容复制别名）一律拒绝。
const SCENARIO_ALLOWED_FIELDS = SCENARIO_REQUIRED_FIELDS.slice();

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function validateMatrix(matrix, opts) {
  opts = opts || {};
  const errors = [];
  if (!matrix || typeof matrix !== 'object') { errors.push('matrix 不是对象'); return { passed: false, errors }; }

  if (matrix.schema_version !== 2) errors.push('schema_version 必须为 2');
  if (matrix.task_id !== EXPECTED_TASK_ID) errors.push('task_id 未绑定 Codex takeover-04');
  if (matrix.synthetic_only !== true || matrix.non_clinical !== true) errors.push('矩阵必须保持 synthetic_only/non_clinical');

  if (!Array.isArray(matrix.scenarios)) { errors.push('scenarios 缺失或非数组'); return { passed: false, errors }; }

  // 1) 必填场景齐全
  const ids = matrix.scenarios.map(s => s && s.id);
  for (const rid of REQUIRED_SCENARIO_IDS) {
    if (!ids.includes(rid)) errors.push('缺失必填场景: ' + rid);
  }

  // 2) 重复 id
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push('重复场景 id: ' + id);
    seen.add(id);
  }

  // 3) 枚举与字段校验
  const evEnum = Array.isArray(matrix.evidence_status_enum) ? matrix.evidence_status_enum : [];
  const exEnum = Array.isArray(matrix.expected_status_enum) ? matrix.expected_status_enum : [];
  for (const s of matrix.scenarios) {
    if (!s || typeof s !== 'object') { errors.push('场景项非对象'); continue; }
    for (const f of SCENARIO_REQUIRED_FIELDS) {
      if (s[f] === undefined || s[f] === null || s[f] === '') errors.push(s.id + ' 缺失字段: ' + f);
    }
    if (s.current_evidence_status && evEnum.length && !evEnum.includes(s.current_evidence_status)) {
      errors.push(s.id + ' 不支持的 evidence status: ' + s.current_evidence_status);
    }
    if (s.expected_status && exEnum.length && !exEnum.includes(s.expected_status)) {
      errors.push(s.id + ' 不支持的 expected status: ' + s.expected_status);
    }
    if (REQUIRED_STATUS_BY_ID[s.id] && s.current_evidence_status !== REQUIRED_STATUS_BY_ID[s.id]) {
      errors.push(s.id + ' evidence status 不符合冻结证据: expected=' + REQUIRED_STATUS_BY_ID[s.id] + ' actual=' + s.current_evidence_status);
    }
    // EXPECTED_RED 必须命名缺失行为
    if (s.current_evidence_status === 'EXPECTED_RED' && (!s.missing_behavior || String(s.missing_behavior).trim() === '')) {
      errors.push(s.id + ' EXPECTED_RED 行未命名缺失行为(missing_behavior)');
    }
    if (s.current_evidence_status === 'CONFIRMED' && !/tests\/v5\.0\.0-production|durable Store|生产契约|run-contract/i.test(s.source_anchor)) {
      errors.push(s.id + ' CONFIRMED 缺少生产测试锚点');
    }
    if (s.current_evidence_status === 'BLOCKED' && !/等待|删除|契约|task/i.test(s.missing_proof)) {
      errors.push(s.id + ' BLOCKED 缺少明确依赖');
    }
    // [rework-02] 显式场景字段白名单：场景对象不得包含任何白名单外字段。
    // 通用拒绝 transcript / raw_content / body / content / clinical_body 等任意内容复制别名注入（S10 无意外临床内容复制边界）。
    const extraKeys = Object.keys(s).filter(k => !SCENARIO_ALLOWED_FIELDS.includes(k));
    if (extraKeys.length) {
      errors.push(s.id + ' 含白名单外字段(被拒绝): ' + extraKeys.join(','));
    }
  }

  // 4) 受保护输入完整性（real protected-source hash verification）
  if (!matrix.protected_hashes || typeof matrix.protected_hashes !== 'object') {
    errors.push('缺失 protected_hashes');
  } else {
    // 4a) manifest 自身 sha256 匹配
    if (!matrix.protected_hashes.manifest_sha256) {
      errors.push('缺失 protected_hashes.manifest_sha256');
    } else if (!opts.skipHashCheck) {
      try {
        const actual = sha256File(MANIFEST_PATH);
        if (actual !== String(matrix.protected_hashes.manifest_sha256).toUpperCase()) {
          errors.push('manifest sha256 不匹配: 矩阵=' + matrix.protected_hashes.manifest_sha256 + ' 实际=' + actual);
        }
      } catch (e) {
        errors.push('无法读取 manifest 计算 sha256: ' + e.message);
      }
    }
    // 4b) files 非空 + 每文件真实 hash 比对（清空格子即 FAIL）
    const files = matrix.protected_hashes.files;
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
      errors.push('缺失或非空的 protected_hashes.files（受保护源文件清单不得清空）');
    } else if (!opts.skipHashCheck) {
      for (const [rel, expected] of Object.entries(files)) {
        const abs = path.join(ROOT, rel);
        try {
          const actual = sha256File(abs);
          if (actual !== String(expected).toUpperCase()) {
            errors.push('受保护源文件 hash 不匹配: ' + rel + ' 登记=' + expected + ' 实际=' + actual);
          }
        } catch (e) {
          errors.push('无法读取受保护源文件计算 hash: ' + rel + ' (' + e.message + ')');
        }
      }
    }
    // 4c) matrix.files 须与权威 manifest.protected_files 的键+值完全一致，防止自填假清单
    if (!opts.skipHashCheck) {
      let manifest;
      try { manifest = loadManifest(); } catch (e) { manifest = null; errors.push('无法读取 manifest 校验 files 一致性: ' + e.message); }
      if (manifest && Array.isArray(manifest.protected_files)) {
        const mSet = new Map(Object.entries(files || {}).map(([k, v]) => [k, String(v).toUpperCase()]));
        const aSet = new Map(manifest.protected_files.map(x => [x.path, String(x.sha256).toUpperCase()]));
        if (mSet.size !== aSet.size) errors.push('protected_hashes.files 数量与 manifest.protected_files 不一致');
        for (const [k, v] of aSet) {
          if (!mSet.has(k)) errors.push('protected_hashes.files 缺少 manifest 登记文件: ' + k);
          else if (mSet.get(k) !== v) errors.push('protected_hashes.files 与 manifest 登记 hash 不一致: ' + k);
        }
      }
    }
  }

  // 5) mismatch / delete-migration 覆盖 + failure expectation
  const hasMismatch = matrix.scenarios.some(s => /mismatch/i.test(s.id) || /mismatch/i.test(s.name) || s.expected_status === 'MISMATCH_REJECTED');
  if (!hasMismatch) errors.push('缺少 client/session mismatch 覆盖场景');
  const hasDeleteMig = matrix.scenarios.some(s => /deletion|migration/i.test(s.id) || /deletion|migration/i.test(s.name));
  if (!hasDeleteMig) errors.push('缺少 deletion/migration handling 覆盖场景');
  const hasFailure = matrix.scenarios.every(s => s.failure_expectation && String(s.failure_expectation).trim() !== '');
  if (!hasFailure) errors.push('存在场景缺失 failure_expectation');

  return { passed: errors.length === 0, errors, scenarioCount: matrix.scenarios.length };
}

function main() {
  let matrix;
  try { matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')); }
  catch (e) { console.error(JSON.stringify({ passed: false, errors: ['无法读取矩阵: ' + e.message] })); process.exit(1); }
  const res = validateMatrix(matrix);
  console.log(JSON.stringify({ passed: res.passed, scenarioCount: res.scenarioCount, errors: res.errors }, null, 2));
  process.exit(res.passed ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  validateMatrix,
  REQUIRED_SCENARIO_IDS,
  REQUIRED_STATUS_BY_ID,
  SCENARIO_REQUIRED_FIELDS,
  MATRIX_PATH,
  MANIFEST_PATH
};
