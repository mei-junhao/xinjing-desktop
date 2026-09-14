'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODES = ['baseline', 'mutated', 'restored'];
const SELF_NAMES = ['runner', 'source-audit', 'verifier', 'expected-red', 'audit'];
const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../../');
const TASK_SLUG = path.basename(SCRIPT_DIR);
const SCRATCH_ROOT = path.resolve(PROJECT_ROOT, 'qa/task-scratch', TASK_SLUG);
const FIXTURE_PATH = path.join(SCRATCH_ROOT, 'rules-fixture.json');
const WRAPPER_PATH = path.join(SCRIPT_DIR, 'wrapper-033.js');

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      out.rest = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return out;
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function bytesFile(filePath) {
  return fs.statSync(filePath).size;
}

function digest(filePath) {
  const data = fs.readFileSync(filePath);
  return { sha256: sha256Buffer(data), bytes: data.length };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}

function isContained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hasParentSegment(value) {
  return String(value).replaceAll('\\', '/').split('/').some((part) => part === '..');
}

function hasLegacyFragment(value) {
  const normalized = String(value).replaceAll('\\', '/');
  return /(?:^|[/_-])(?:029|030|031|032)(?:[/_-]|$)/i.test(normalized);
}

function isCanonicalAbsolute(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return false;
  if (hasParentSegment(value)) return false;
  return path.normalize(value) === value || path.normalize(value).toLowerCase() === value.toLowerCase();
}

function isIsoUtc(value) {
  if (typeof value !== 'string' || !value.trim() || !value.endsWith('Z')) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timeOrder(startUtc, endUtc) {
  return isIsoUtc(startUtc) && isIsoUtc(endUtc) && Date.parse(startUtc) <= Date.parse(endUtc);
}

function pathComponents(filePath) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const tail = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const result = [];
  let current = parsed.root;
  for (const part of tail) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}

function linkSegments(filePath) {
  const links = [];
  for (const component of pathComponents(filePath)) {
    try {
      if (fs.lstatSync(component).isSymbolicLink()) links.push(component);
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
  }
  return links;
}

function assertRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`not a regular file: ${filePath}`);
  const links = linkSegments(filePath);
  if (links.length) throw new Error(`symbolic link path segment: ${links.join(', ')}`);
  return stat;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function loadFixture(filePath = FIXTURE_PATH) {
  const fixture = readJson(filePath);
  if (!exactKeys(fixture, ['fixtureId', 'schemaVersion', 'stages', 'mutations', 'sourceAudit'])) throw new Error('fixture has unknown or missing fields');
  if (fixture.schemaVersion !== 'rules-033-v1' || typeof fixture.fixtureId !== 'string' || !fixture.fixtureId) throw new Error('fixture identity is invalid');
  if (!Array.isArray(fixture.stages) || fixture.stages.length !== 8) throw new Error('fixture stage set is invalid');
  if (!Array.isArray(fixture.mutations) || fixture.mutations.length < 14) throw new Error('fixture mutation set is incomplete');
  if (!fixture.sourceAudit || !Array.isArray(fixture.sourceAudit.forbiddenSourceTokens) || !Array.isArray(fixture.sourceAudit.forbiddenLegacyFragments)) throw new Error('fixture source audit is invalid');
  return fixture;
}

function ensureAllowedPath(value, root, label, options = {}) {
  requiredString(value, label);
  if (!isCanonicalAbsolute(value)) throw new Error(`${label} must be canonical absolute without parent segments`);
  if (hasLegacyFragment(value)) throw new Error(`${label} contains a legacy evidence fragment`);
  const resolved = path.resolve(value);
  if (options.contained !== false && !isContained(root, resolved)) throw new Error(`${label} escapes its containment root`);
  if (options.mustExist !== false) assertRegularFile(resolved);
  return resolved;
}

function stableNonce() {
  return `nonce-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function stableRunId() {
  return `run-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function productionPaths() {
  return [
    path.join(PROJECT_ROOT, 'app/masters.html'),
    path.join(PROJECT_ROOT, 'app/js/masters.js'),
    path.join(PROJECT_ROOT, 'app/css/masters-clinical.css')
  ];
}

function collectProductionBaseline() {
  return productionPaths().map((filePath) => {
    const info = digest(filePath);
    return { path: filePath, sha256: info.sha256, bytes: info.bytes };
  });
}

module.exports = {
  MODES,
  SELF_NAMES,
  SCRIPT_DIR,
  PROJECT_ROOT,
  TASK_SLUG,
  SCRATCH_ROOT,
  FIXTURE_PATH,
  WRAPPER_PATH,
  parseArgs,
  sha256Buffer,
  sha256File,
  bytesFile,
  digest,
  writeJson,
  readJson,
  exactKeys,
  isContained,
  hasParentSegment,
  hasLegacyFragment,
  isCanonicalAbsolute,
  isIsoUtc,
  timeOrder,
  pathComponents,
  linkSegments,
  assertRegularFile,
  requiredString,
  requireArray,
  loadFixture,
  ensureAllowedPath,
  stableNonce,
  stableRunId,
  productionPaths,
  collectProductionBaseline
};
