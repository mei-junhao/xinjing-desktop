/* SourceRef 模块合成单测 — 纯 Node，无外部依赖。
 * 运行：node tests/v4.2.1-source-ref/run-tests.js
 * 全部使用合成 fixture，不涉及真实数据、DOM、Store 或远程动作。
 */
'use strict';

var path = require('path');
var SourceRef = require(path.join(__dirname, '..', '..', 'app', 'js', 'source-ref.js'));
var fx = require('./fixtures-synthetic.js');

var passed = 0, failed = 0;
var failures = [];

function ok(cond, name) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; failures.push(name); console.log('  FAIL  ' + name); }
}
function eq(a, b, name) { ok(a === b, name + ' (得到 ' + JSON.stringify(a) + ', 期望 ' + JSON.stringify(b) + ')'); }

console.log('SYNTHETIC fixtures marker =', fx.SYNTHETIC, '(必须为 true)');
ok(fx.SYNTHETIC === true, 'fixtures 标记为 synthetic=true');

/* ---- 1. create 产出全部必填字段 ---- */
console.log('\n[1] create 必填字段');
var base = fx.caseUnchanged();
var ref = SourceRef.create(base);
eq(typeof ref.id, 'string', 'id 为字符串');
ok(ref.id.indexOf('sr:sha256:') === 0, 'id 格式为 sr:sha256:...');
eq(ref.clientId, 'c_anon_alpha', 'clientId 透传');
eq(ref.sessionId, 's_anon_001', 'sessionId 透传');
ok(typeof ref.anchor === 'object' && ref.anchor.kind === 'session', 'anchor 存在');
eq(ref.normalizationVersion, SourceRef.NORMALIZATION_VERSION, 'normalizationVersion');
eq(ref.sourceVersion, SourceRef.SOURCE_VERSION, 'sourceVersion');
ok(ref.sourceContentHash.indexOf('sha256:') === 0, 'sourceContentHash 为 sha256');
ok(ref.anchorContentHash.indexOf('sha256:') === 0, 'anchorContentHash 为 sha256');
ok(typeof ref.capturedAt === 'string' && !isNaN(Date.parse(ref.capturedAt)), 'capturedAt 为 ISO 时间');

/* ---- 2. 稳定 id：相同输入产出相同 id ---- */
console.log('\n[2] 稳定 id 幂等');
var ref2 = SourceRef.create(base);
eq(ref.id, ref2.id, '相同输入两次 create 得到相同 id');

/* ---- 3. 绝对路径拒绝 ---- */
console.log('\n[3] 绝对路径拒绝');
ok(SourceRef.containsAbsolutePath('C:\\Users\\x\\file.txt') === true, 'Windows 绝对路径被识别');
ok(SourceRef.containsAbsolutePath('/etc/passwd') === true, 'Unix 绝对路径被识别');
ok(SourceRef.containsAbsolutePath('https://x/y') === true, 'URL 绝对形式被识别');
ok(SourceRef.containsAbsolutePath('../secret') === true, '路径遍历被识别');
ok(SourceRef.containsAbsolutePath('session:s_anon_001') === false, '受控相对 locator 不被误判');
var threw = false;
try { SourceRef.create({ clientId: 'c_anon_alpha', sessionId: 's_anon_001', anchor: { kind: 'session', locator: 'C:\\x\\y.txt' }, sourceText: 'x' }); }
catch (e) { threw = true; }
ok(threw, '含绝对路径 locator 的 create 抛错（不写入 SourceRef）');

/* ---- 4. unchanged ---- */
console.log('\n[4] unchanged 状态');
var curUnchanged = { clientId: 'c_anon_alpha', sessionId: 's_anon_001', anchor: fx.anchor('session:s_anon_001', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' };
var rUnchanged = SourceRef.verify(ref, curUnchanged);
eq(rUnchanged.status, 'unchanged', 'status=unchanged');
eq(rUnchanged.verified, true, 'unchanged 时 verified=true');

/* ---- 5. changed（来源变 + 锚点消失） ---- */
console.log('\n[5] changed 状态');
var curChanged = fx.caseSourceChangedAnchorGone();
var rChanged = SourceRef.verify(ref, curChanged);
eq(rChanged.status, 'changed', 'status=changed');
eq(rChanged.verified, false, 'changed 时 verified=false');

/* ---- 6. 关键规则：来源变但锚点仍匹配 => warning candidate，绝不 verified ---- */
console.log('\n[6] 关键规则：来源内容变化 => warning，禁止 verified');
var curAnchorKept = fx.caseChangedWithAnchorKept();
var rWarn = SourceRef.verify(ref, curAnchorKept);
eq(rWarn.status, 'warning', 'status=warning');
eq(rWarn.verified, false, 'warning 时 verified=false');
eq(rWarn.warning, true, 'warning 标记存在');
eq(rWarn.candidate, true, 'warning 为 candidate');

/* ---- 7. missing（当前来源缺失） ---- */
console.log('\n[7] missing 状态');
var rMissing = SourceRef.verify(ref, null);
eq(rMissing.status, 'missing', 'status=missing');
eq(rMissing.verified, false, 'missing 时 verified=false');

/* ---- 8. ambiguous（client/session/anchor locator 不匹配） ---- */
console.log('\n[8] ambiguous 状态');
var curClientMismatch = { clientId: 'c_anon_beta', sessionId: 's_anon_001', anchor: fx.anchor('session:s_anon_001', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' };
eq(SourceRef.verify(ref, curClientMismatch).status, 'ambiguous', 'client 不匹配 => ambiguous');

var curSessionMismatch = { clientId: 'c_anon_alpha', sessionId: 's_anon_999', anchor: fx.anchor('session:s_anon_001', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' };
eq(SourceRef.verify(ref, curSessionMismatch).status, 'ambiguous', 'session 不匹配 => ambiguous');

var curLocatorMismatch = { clientId: 'c_anon_alpha', sessionId: 's_anon_001', anchor: fx.anchor('material:m_other', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' };
eq(SourceRef.verify(ref, curLocatorMismatch).status, 'ambiguous', 'anchor locator 不匹配 => ambiguous');

/* ---- 9. legacy-unverified（旧引用） ---- */
console.log('\n[9] legacy-unverified 状态');
var legacyRef = { id: 'old-ref-1', clientId: 'c_anon_alpha', sessionId: 's_anon_001', anchor: fx.anchor('session:s_anon_001', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' };
var rLegacy = SourceRef.verify(legacyRef, curUnchanged);
eq(rLegacy.status, 'legacy-unverified', '缺 schemaVersion/sourceContentHash => legacy-unverified');
eq(rLegacy.verified, false, 'legacy 时 verified=false');
eq(rLegacy.legacy, true, 'legacy 标记存在');

var migrated = SourceRef.migrateLegacy(legacyRef);
eq(migrated.status, 'legacy-unverified', 'migrateLegacy => legacy-unverified');
eq(migrated.verified, false, 'migrateLegacy 不声称 verified');
eq(migrated.migrated, true, 'migrateLegacy 标记 migrated=true');
ok(migrated.sourceContentHash.indexOf('sha256:') === 0, 'migrateLegacy 补算 sourceContentHash');

/* ---- 10. 真实数据不应存在（合成保证） ---- */
console.log('\n[10] 合成保证');
ok(JSON.stringify(ref).indexOf('C:\\') === -1 && JSON.stringify(ref).indexOf('/Users/') === -1, 'SourceRef 不含绝对路径片段');

/* ---- 11. 冻结契约：clientId / sessionId 均为必填 ---- */
console.log('\n[11] 负向：clientId/sessionId 任一为空即拒绝（冻结契约）');
function expectThrow(fn, name) {
  var thrown = false;
  try { fn(); } catch (e) { thrown = true; }
  ok(thrown, name);
}
expectThrow(function () { SourceRef.create({ sessionId: 's_anon_001', anchor: fx.anchor('session:s_anon_001', 'x'), sourceText: 'synthetic-only' }); }, '缺 clientId 时 create 抛错（不写入 SourceRef）');
expectThrow(function () { SourceRef.create({ clientId: 'c_anon_alpha', anchor: fx.anchor('session:s_anon_001', 'x'), sourceText: 'synthetic-only' }); }, '缺 sessionId 时 create 抛错（不写入 SourceRef）');
expectThrow(function () { SourceRef.create({ anchor: fx.anchor('session:s_anon_001', 'x'), sourceText: 'synthetic-only' }); }, 'clientId 与 sessionId 皆空时 create 抛错');
var okRef = SourceRef.create(fx.caseUnchanged());
var rNoClient = SourceRef.verify(okRef, { sessionId: 's_anon_001', anchor: fx.anchor('session:s_anon_001', '工作相关的焦虑'), sourceText: fx.SOURCE_TEXTS.transcript_v1, anchorText: '工作相关的焦虑' });
eq(rNoClient.status, 'invalid', 'verify 的 current 缺 clientId => invalid（不通过）');

console.log('\n========================================');
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) { console.log('失败用例: ' + failures.join('; ')); process.exit(1); }
console.log('全部合成用例通过 (synthetic=' + fx.SYNTHETIC + ')');
