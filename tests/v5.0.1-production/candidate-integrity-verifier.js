'use strict';
/**
 * candidate-integrity-verifier.js — XinJing 5.0.1 生产候选完整性校验器
 *
 * 任务: XJ-5.0.1-production-candidate-integration-001
 * 契约: XJ-5.0.1-CANDIDATE-INTEGRATION-V1
 *
 * 真实字节验证（不做占位/假绿）：
 *  - 193 条候选成员从真实工作树逐文件重算 SHA-256 与字节数，与 freeze.json
 *    entries 和 candidate-file-sha256.txt 双向核对；
 *  - 候选聚合摘要（path NUL sha NUL bytes LF 序）重算并与 freeze.json /
 *    release-train.yaml / candidate-artifact.json 三处指针核对；
 *  - 成员闭包：candidate-files.txt == candidate-file-sha256.txt == freeze entries，
 *    ordinal 排序、唯一性；
 *  - freeze-009 谱系：190 路径全量在场，187 条字节等同，3 条声明内重绑，
 *    3 条版本输入为声明内新增，无其它增删；
 *  - 禁止范围：qa/**、task-scratch、agent-reviews、design-previews、各 agent
 *    运行时目录、_tmp*、账号/邮件未完成线上闭环文件、secret 文件等零命中；
 *  - 版本链：package.json / package-lock.json / version.generated.js /
 *    settings.html / settings.js / verify-build-files-policy.js /
 *    release-train.yaml 全部等于 5.0.1；
 *  - 候选状态：created-local；release_ready/publish_authorized/released=false；
 *    local_commit/push/upload/sign/publish denied。
 *
 * 校验器零写入；输出不含时间戳等易变字段，两次连续运行必须字节一致。
 * 退出码: 0=PASS, 1=FAIL。
 * 变异探针: verifyCandidate(root, { tamper }) 允许在内存中篡改期望表并必须被
 * 真实字节比对捕获（供 candidate-integrity.test.js 反向证明）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const FREEZE_DIR = 'docs/agent-coordination/v5.0.1/candidate-freeze/5.0.1-rt-5.0.1-0001-001-production-candidate-integration';
const FREEZE009_DIR = 'docs/agent-coordination/v5.0.0/candidate-freeze/5.0.0-rt-5.0.0-0003-009-ui-language-migration-clean-replay';
const EXPECTED_VERSION = '5.0.1';
const EXPECTED_BASE_COMMIT = '9971787eb6e443ab5a5c80aee118b9b43285c093';
const EXPECTED_BRANCH = 'release/3.6.3-mac';
const EXPECTED_FREEZE009_FILES_TXT_SHA = '991AF5A2547995BFFE48E62415FFBC4FC9D3F69C8FCC2F95510D7B27EA1D4778';
const DECLARED_CHANGED = ['app/js/settings.js', 'app/settings.html', 'scripts/verify-build-files-policy.js'];
const DECLARED_ADDED = ['package-lock.json', 'package.json', 'version.generated.js'];
const FORBIDDEN_MEMBER_PATTERNS = [
  /(^|\/)qa\//,
  /(^|\/)task-scratch\//,
  /(^|\/)agent-reviews\//,
  /(^|\/)design-previews\//,
  /(^|\/)\.codex\//,
  /(^|\/)\.reasonix\//,
  /(^|\/)\.grok-duty\//,
  /(^|\/)\.qoder\//,
  /(^|\/)\.opensquilla\//,
  /(^|\/)\.agent-teams\//,
  /(^|\/)\.workbuddy\//,
  /(^|\/)_tmp/,
  /(^|\/)\.git\//,
  /(^|\/)secret\.generated\.js$/,
  /(^|\/)proxy-secret\.generated\.js$/,
  /(^|\/)\.license-secret$/,
  /(^|\/)\.app-proxy-key$/,
  /(^|\/)scripts\/\.cos-secret\.ps1$/,
  /(^|\/)server\/account-auth[^/]*\.js$/,
  /(^|\/)server\/email-adapter\.js$/,
  /(^|\/)server\/resend-email-adapter\.js$/,
  /(^|\/)scripts\/account-auth[^/]*\.js$/,
  /(^|\/)tests\/v4\.2\./,
  /(^|\/)tests\/v4\.3\./,
  /(^|\/)scripts\/v4\.2\.[0-9]+-tests\//,
  /(^|\/)scripts\/v4\.3\.[0-9]+-tests\//
];

function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(); }
function readIfExists(root, rel) {
  try { return fs.readFileSync(path.join(root, rel)); } catch (e) { return null; }
}
function readJsonIfExists(root, rel) {
  const buf = readIfExists(root, rel);
  if (buf === null) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

function verifyCandidate(root, opts) {
  root = root || DEFAULT_ROOT;
  const tamper = (opts && opts.tamper) || {};
  const results = [];
  function check(id, pass, detail) { results.push({ id: id, pass: !!pass, detail: detail || '' }); }

  const freezePath = path.posix.join(FREEZE_DIR, 'freeze.json');
  const filesTxtPath = path.posix.join(FREEZE_DIR, 'candidate-files.txt');
  const shaTxtPath = path.posix.join(FREEZE_DIR, 'candidate-file-sha256.txt');
  const trainPath = 'docs/agent-coordination/v5.0.1/release-train.yaml';
  const artPath = path.posix.join(FREEZE_DIR, 'candidate-artifact.json');

  const freezeBuf = readIfExists(root, freezePath);
  check('freeze.json:exists', !!freezeBuf, freezePath);
  const freeze = freezeBuf ? JSON.parse(freezeBuf.toString('utf8')) : null;
  const filesTxtBuf = readIfExists(root, filesTxtPath);
  check('candidate-files.txt:exists', !!filesTxtBuf, filesTxtPath);
  const shaTxtBuf = readIfExists(root, shaTxtPath);
  check('candidate-file-sha256.txt:exists', !!shaTxtBuf, shaTxtPath);
  const train = readJsonIfExists(root, trainPath);
  check('release-train.yaml:exists-and-parses', !!train, trainPath);
  const art = readJsonIfExists(root, artPath);
  check('candidate-artifact.json:exists-and-parses', !!art, artPath);
  if (!freeze || !filesTxtBuf || !shaTxtBuf || !train || !art) {
    return finish(results);
  }

  const filesTxtSha = sha256Buf(filesTxtBuf);
  const shaTxtSha = sha256Buf(shaTxtBuf);
  check('candidate-files.txt:sha-bind', filesTxtSha === freeze.candidate_files_txt_sha256, filesTxtSha + ' vs frozen ' + freeze.candidate_files_txt_sha256);
  check('candidate-file-sha256.txt:sha-bind', shaTxtSha === freeze.candidate_file_sha256_txt_sha256, shaTxtSha + ' vs frozen ' + freeze.candidate_file_sha256_txt_sha256);

  const fromFilesTxt = filesTxtBuf.toString('utf8').split(/\r?\n/).filter(l => l.trim()).map(l => l.replace(/^\//, ''));
  const fromShaTxt = shaTxtBuf.toString('utf8').split(/\r?\n/).filter(l => l.trim()).map(l => {
    const i = l.indexOf(' ');
    return { path: l.slice(i + 2), sha256: l.slice(0, i) };
  });
  const entryArr = freeze.entries;
  check('entries:is-array-nonempty', Array.isArray(entryArr) && entryArr.length > 0, String(Array.isArray(entryArr) ? entryArr.length : -1));

  const setA = fromFilesTxt.slice().sort();
  const setB = fromShaTxt.map(e => e.path).sort();
  const setC = entryArr.map(e => e.path).sort();
  check('membership:filesTxt==shaTxt', JSON.stringify(setA) === JSON.stringify(setB));
  check('membership:filesTxt==entries', JSON.stringify(setA) === JSON.stringify(setC));
  const uniq = new Set(setA);
  check('membership:unique', uniq.size === setA.length, setA.length + ' paths, ' + uniq.size + ' unique');
  const sorted = fromFilesTxt.slice().sort();
  check('membership:ordinal-sorted', JSON.stringify(sorted) === JSON.stringify(fromFilesTxt));
  check('membership:count-193', setA.length === 193 && entryArr.length === 193, setA.length + '/193');

  const shaByPath = {};
  for (const e of fromShaTxt) shaByPath[e.path] = e.sha256;
  const entryByPath = {};
  for (const e of entryArr) entryByPath[e.path] = e;
  check('entries:no-cross-mismatch-with-shaTxt', entryArr.every(e => shaByPath[e.path] === e.sha256));

  if (tamper.flipSha && entryByPath[tamper.flipSha]) {
    entryByPath[tamper.flipSha] = Object.assign({}, entryByPath[tamper.flipSha], { sha256: '0'.repeat(64) });
  }
  if (tamper.dropMember && entryByPath[tamper.dropMember]) {
    delete entryByPath[tamper.dropMember];
  }
  if (tamper.addMember) {
    entryByPath[tamper.addMember] = { path: tamper.addMember, sha256: '1'.repeat(64), bytes: 1 };
  }

  let livePass = 0, liveFail = 0;
  const failuresLive = [];
  const liveEntries = Object.keys(entryByPath).sort().map(p => entryByPath[p]);
  for (const e of liveEntries) {
    const buf = readIfExists(root, e.path);
    if (buf === null) { liveFail++; failuresLive.push(e.path + ':MISSING'); continue; }
    const actual = sha256Buf(buf);
    if (actual !== e.sha256) { liveFail++; failuresLive.push(e.path + ':' + actual + '!=' + e.sha256); continue; }
    if (typeof e.bytes === 'number' && buf.length !== e.bytes) { liveFail++; failuresLive.push(e.path + ':bytes ' + buf.length + '!=' + e.bytes); continue; }
    livePass++;
  }
  check('live-bytes:all-193-match', liveFail === 0 && livePass === Object.keys(entryByPath).length && livePass > 0, livePass + ' pass / ' + liveFail + ' fail; ' + failuresLive.slice(0, 3).join(' | '));

  const aggLines = liveEntries.map(e => e.path + '\u0000' + String(e.sha256).toUpperCase() + '\u0000' + String(e.bytes) + '\n');
  const recomputed = sha256Buf(Buffer.from(aggLines.join(''), 'utf8'));
  check('candidate-sha:recomputed==freeze.json', recomputed === freeze.candidate_sha256, recomputed + ' vs frozen ' + freeze.candidate_sha256);
  check('candidate-sha:freeze==release-train', freeze.candidate_sha256 === (train.candidate && train.candidate.sha256));
  check('candidate-sha:freeze==artifact', freeze.candidate_sha256 === (art.candidate && art.candidate.sha256));
  check('candidate-sha:expected-constant', recomputed === '77190C0D4D3D0054214E4DD95254912712BCE754A1CB15BE98C4ED358AB4C3FA');

  const freeze009ShaTxt = readIfExists(root, path.posix.join(FREEZE009_DIR, 'candidate-file-sha256.txt'));
  const freeze009FilesTxt = readIfExists(root, path.posix.join(FREEZE009_DIR, 'candidate-files.txt'));
  check('freeze009:inputs-present', !!freeze009ShaTxt && !!freeze009FilesTxt);
  if (freeze009ShaTxt && freeze009FilesTxt) {
    check('freeze009:protected-manifest-hash', sha256Buf(freeze009FilesTxt) === EXPECTED_FREEZE009_FILES_TXT_SHA, 'candidate-files.txt sha');
    const f009 = {};
    freeze009ShaTxt.toString('utf8').split(/\r?\n/).filter(l => l.trim()).forEach(l => {
      const i = l.indexOf(' ');
      f009[l.slice(i + 2)] = l.slice(0, i);
    });
    const f009Paths = Object.keys(f009);
    check('freeze009:190-paths', f009Paths.length === 190, String(f009Paths.length));
    const missing = f009Paths.filter(p => !(p in entryByPath));
    check('freeze009:all-paths-in-5.0.1-candidate', missing.length === 0, missing.slice(0, 5).join(','));
    const changed = [], drifted = [];
    for (const p of f009Paths) {
      const e = entryByPath[p];
      if (!e) continue;
      if (e.sha256 === f009[p]) continue;
      if (DECLARED_CHANGED.indexOf(p) !== -1) changed.push(p);
      else drifted.push(p);
    }
    check('freeze009:rebound-set-exact', changed.length === DECLARED_CHANGED.length && drifted.length === 0, 'rebound=' + changed.join(',') + ' undeclared-drift=' + drifted.join(','));
    const added = Object.keys(entryByPath).filter(p => !(p in f009));
    check('freeze009:added-set-exact', JSON.stringify(added.sort()) === JSON.stringify(DECLARED_ADDED.slice().sort()), added.join(','));
    const removed = f009Paths.filter(p => !(p in entryByPath));
    check('freeze009:removed-set-empty', removed.length === 0, removed.join(','));
  }

  const memberUnion = Array.from(new Set(setA.concat(Object.keys(entryByPath)))).sort();
  const forbiddenHits = memberUnion.filter(p => FORBIDDEN_MEMBER_PATTERNS.some(re => re.test(p)));
  check('forbidden:zero-member-hits', forbiddenHits.length === 0, forbiddenHits.slice(0, 5).join(','));

  const pkg = readJsonIfExists(root, 'package.json');
  const lock = readJsonIfExists(root, 'package-lock.json');
  check('version:package.json', !!pkg && pkg.version === EXPECTED_VERSION, pkg && pkg.version);
  check('version:package-lock-top', !!lock && lock.version === EXPECTED_VERSION, lock && lock.version);
  check('version:package-lock-root-pkg', !!lock && lock.packages && lock.packages[''] && lock.packages[''].version === EXPECTED_VERSION);
  check('version:package-name-main-stable', !!pkg && pkg.name === 'xinjing' && pkg.main === 'main.js');
  check('version:scripts-dist-bare-electron-builder', !!pkg && pkg.scripts && pkg.scripts.dist === 'electron-builder');
  check('version:no-build-key-in-package', !!pkg && pkg.build == null);
  const vg = readIfExists(root, 'version.generated.js');
  check('version:version.generated.js', !!vg && /VERSION:\s*"5\.0\.1"/.test(vg.toString('utf8')));
  const settingsHtml = readIfExists(root, 'app/settings.html');
  check('version:settings.html-ver-text', !!settingsHtml && settingsHtml.toString('utf8').indexOf('id="ver-text">v5.0.1') !== -1);
  check('version:settings.html-about-version', !!settingsHtml && settingsHtml.toString('utf8').indexOf('id="about-version">v5.0.1') !== -1);
  const settingsJs = readIfExists(root, 'app/js/settings.js');
  check('version:settings.js-fallback', !!settingsJs && settingsJs.toString('utf8').indexOf("var ver = '5.0.1'") !== -1);
  const policyJs = readIfExists(root, 'scripts/verify-build-files-policy.js');
  check('version:policy-EXPECTED_VERSION', !!policyJs && policyJs.toString('utf8').indexOf("const EXPECTED_VERSION = '5.0.1';") !== -1);
  check('version:release-train-active_version', train.active_version === EXPECTED_VERSION);
  check('version:release-train-transition', train.transition_id === 'rt-5.0.1-0001');

  check('state:freeze-status-created-local', freeze.status === 'created-local');
  check('state:freeze-not-released', freeze.release_ready === false && freeze.publish_authorized === false && freeze.released === false);
  check('state:train-candidate-not-released', train.candidate && train.candidate.release_ready === false && train.candidate.publish_authorized === false && train.candidate.released === false);
  check('state:base-commit', freeze.base_commit === EXPECTED_BASE_COMMIT);
  check('state:branch', freeze.branch === EXPECTED_BRANCH);
  check('state:train-base-commit', train.base_commit === EXPECTED_BASE_COMMIT);
  check('auth:authorization-denials', freeze.authorization && freeze.authorization.local_commit === 'denied' && freeze.authorization.push === 'denied' && freeze.authorization.upload === 'denied' && freeze.authorization.sign === 'denied' && freeze.authorization.publish === 'denied');

  return finish(results);
}

function finish(results) {
  const failed = results.filter(r => !r.pass);
  const out = {
    verifier: 'xj-5.0.1-candidate-integrity-verifier/v1',
    expected_version: EXPECTED_VERSION,
    candidate_freeze_dir: FREEZE_DIR,
    result: failed.length === 0 ? 'PASS' : 'FAIL',
    total: results.length,
    failed: failed.length,
    failures: failed.map(f => ({ id: f.id, detail: f.detail }))
  };
  return out;
}

if (require.main === module) {
  const out = verifyCandidate(DEFAULT_ROOT, {});
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.result === 'PASS' ? 0 : 1);
}

module.exports = { verifyCandidate, EXPECTED_VERSION };
