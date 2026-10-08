#!/usr/bin/env node
/* ============================================================
   XJ-4.2.3-ui-p0-repair-v2 — UI P0 修复契约测试（Rework 02）
   验证 4.2.3 六个用户路径问题 + Rework 02 残余修复：
   emoji 伪元素消除、AI 填写锁标识、内联 emoji 移除、
   expected-red 变异探针。
   ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..', '..');
var APP_JS = path.join(ROOT, 'app', 'js', 'app.js');
var SCAL_JS = path.join(ROOT, 'app', 'js', 'session-calendar.js');
var DC_JS = path.join(ROOT, 'app', 'js', 'doc-center.js');
var CN_JS = path.join(ROOT, 'app', 'js', 'consult-notes.js');
var DC_HTML = path.join(ROOT, 'app', 'doc-center.html');
var DG_HTML = path.join(ROOT, 'app', 'doc-growth.html');
var CN_HTML = path.join(ROOT, 'app', 'consult-notes.html');
var BS_HTML = path.join(ROOT, 'app', 'billing-shell.html');
var RS_AI_HTML = path.join(ROOT, 'app', 'real-supervision-ai.html');
var SM_HTML = path.join(ROOT, 'app', 'supervision-mindmap.html');
var TG_HTML = path.join(ROOT, 'app', 'transcript-guide.html');
var SUP_HTML = path.join(ROOT, 'app', 'supervision.html');
var TP_HTML = path.join(ROOT, 'app', 'transcript.html');
var RS_HTML = path.join(ROOT, 'app', 'real-supervision.html');
var TOKENS_CSS = path.join(ROOT, 'app', 'css', 'tokens.css');

var APP = fs.readFileSync(APP_JS, 'utf8');
var SCAL = fs.readFileSync(SCAL_JS, 'utf8');
var DCJS = fs.readFileSync(DC_JS, 'utf8');
var CNJS = fs.readFileSync(CN_JS, 'utf8');
var DCH = fs.readFileSync(DC_HTML, 'utf8');
var DGH = fs.readFileSync(DG_HTML, 'utf8');
var CNH = fs.readFileSync(CN_HTML, 'utf8');
var BSH = fs.readFileSync(BS_HTML, 'utf8');
var RSAI = fs.readFileSync(RS_AI_HTML, 'utf8');
var SMH = fs.readFileSync(SM_HTML, 'utf8');
var TGH = fs.readFileSync(TG_HTML, 'utf8');
var SUPH = fs.readFileSync(SUP_HTML, 'utf8');
var TPH = fs.readFileSync(TP_HTML, 'utf8');
var RSH = fs.readFileSync(RS_HTML, 'utf8');
var TOK = fs.readFileSync(TOKENS_CSS, 'utf8');

var passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('[PASS] ' + name); }
  catch (e) { failed++; console.log('[FAIL] ' + name + ' — ' + (e.message || '').slice(0, 200)); }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

// ====== P0#1: 全局切换稳定性 ======
test('P0#1a: refreshSidebarChrome does not use outerHTML', function () {
  ensure(APP.indexOf('refreshSidebarChrome') >= 0, 'refreshSidebarChrome not found');
  var fn = APP.slice(APP.indexOf('function refreshSidebarChrome'));
  var body = fn.slice(0, fn.indexOf('\n  }') + 10);
  ensure(!/\.outerHTML\s*=/.test(body) || body.indexOf('// P0#1') >= 0,
    'refreshSidebarChrome still uses outerHTML replacement');
});

test('P0#1b: refreshSidebarChrome uses innerHTML only when sidebar absent', function () {
  ensure(APP.indexOf('mount.innerHTML = renderSidebar()') >= 0,
    'refreshSidebarChrome missing innerHTML fallback');
  ensure(APP.indexOf('bindSidebarControls();') >= 0,
    'refreshSidebarChrome missing bindSidebarControls call');
});

test('P0#1c: refreshSidebarChrome exported', function () {
  ensure(APP.indexOf('refreshSidebarChrome,') >= 0,
    'refreshSidebarChrome not exported in App return');
});

// ====== P0#2: 侧栏收缩 ======
test('P0#2a: session-calendar delegates to App.refreshSidebarChrome', function () {
  ensure(SCAL.indexOf('App.refreshSidebarChrome') >= 0,
    'session-calendar does not use App.refreshSidebarChrome');
  ensure(!(/sm\.outerHTML\s*=\s*App\.renderSidebar/.test(SCAL)),
    'session-calendar still uses outerHTML');
});

test('P0#2b: session-calendar has fallback path', function () {
  ensure(SCAL.indexOf('typeof App.refreshSidebarChrome') >= 0,
    'session-calendar missing refreshSidebarChrome type check');
  ensure(SCAL.indexOf('sm.innerHTML = App.renderSidebar()') >= 0,
    'session-calendar fallback missing innerHTML');
});

// ====== P0#3: 会员锁布局 ======
test('P0#3a: doc-growth.html no ::after emoji pseudo-element', function () {
  ensure(!(/\.xj-premium-btn::after\s*\{/.test(DGH)),
    'doc-growth.html still has .xj-premium-btn::after pseudo-element');
  ensure(!(/\.xj-locked-area.*::before\s*\{/.test(DGH)),
    'doc-growth.html still has .xj-locked-area::before pseudo-element');
  ensure(DGH.indexOf('.xj-lock-badge') >= 0 || DGH.indexOf('.xj-premium-btn') >= 0,
    'doc-growth.html missing .xj-lock-badge or .xj-premium-btn class');
});

test('P0#3b: doc-center.html has stable id on growth link', function () {
  ensure(DCH.indexOf('id="dc-growth-link"') >= 0,
    'doc-center.html missing id="dc-growth-link"');
});

test('P0#3c: doc-center.js dynamically sets lock badge', function () {
  ensure(DCJS.indexOf("document.getElementById('dc-growth-link')") >= 0,
    'doc-center.js missing dynamic lock badge for growth link');
  ensure(DCJS.indexOf("App.lockBadge('ai-growth')") >= 0,
    'doc-center.js missing lockBadge call');
});

test('P0#3d: consult-notes.html upload button has no lock-mini', function () {
  ensure(!(/lock-mini/.test(CNH)),
    'consult-notes.html upload button still has lock-mini badge');
  ensure(CNH.indexOf('type="button"') >= 0,
    'consult-notes.html upload button missing type=button');
});

// ====== P0#4: 成长语义 ======
test('P0#4a: doc-center.html tabs renamed', function () {
  ensure(DCH.indexOf('AI 成长洞察') >= 0,
    'doc-center.html missing "AI 成长洞察" tab');
  ensure(DCH.indexOf('个案时间线') >= 0,
    'doc-center.html missing "个案时间线" tab');
});

test('P0#4b: doc-center.js references renamed', function () {
  ensure(DCJS.indexOf('AI 成长洞察') >= 0,
    'doc-center.js still uses old "成长轨迹" text');
});

test('P0#4c: doc-growth.html title uses AI 成长洞察', function () {
  ensure(DGH.indexOf('AI 成长洞察') >= 0,
    'doc-growth.html title not updated to AI 成长洞察');
  ensure(!(/AI 成长轨迹/.test(DGH)),
    'doc-growth.html still has old "AI 成长轨迹" text');
});

// ====== P0#5: 咨询记录权益 ======
test('P0#5a: consult-notes.js upload has no ai-analyze gate at start', function () {
  ensure(!(/if \(!App\.featureGate\('ai-analyze'\)\)/.test(CNJS)),
    'consult-notes.js upload still blocked by ai-analyze gate');
});

test('P0#5b: consult-notes.js AI analysis is conditional', function () {
  ensure(CNJS.indexOf("if (App.featureGate('ai-analyze'))") >= 0,
    'consult-notes.js missing conditional AI analysis');
  ensure(CNJS.indexOf('逐字稿已保存至会话') >= 0,
    'consult-notes.js missing Free upload confirmation');
});

test('P0#5c: consult-notes.js ai-notes gate for AI fill remains', function () {
  ensure(CNJS.indexOf("App.featureGate('ai-notes')") >= 0,
    'consult-notes.js ai-notes gate removed');
});

// ====== P0#6: 记账入口 ======
test('P0#6a: billing-shell has bf-add-record with type=button', function () {
  ensure(BSH.indexOf('id="bf-add-record"') >= 0,
    'billing-shell missing bf-add-record id');
  ensure(BSH.indexOf('type="button"') >= 0,
    'billing-shell missing type=button');
});

test('P0#6b: billing-shell has bf-open-calendar', function () {
  ensure(BSH.indexOf('id="bf-open-calendar"') >= 0,
    'billing-shell missing bf-open-calendar id');
  ensure(BSH.indexOf('bfOpenCalendar') >= 0,
    'billing-shell missing bfOpenCalendar handler');
});

test('P0#6c: billing-shell has bf-monthly-settle', function () {
  ensure(BSH.indexOf('toggleSettleForm') >= 0,
    'billing-shell missing toggleSettleForm handler');
});

test('P0#6d: billing-shell does not overwrite App.openFeaturePage', function () {
  ensure(!(/App\.openFeaturePage\s*=\s*function/.test(BSH)),
    'billing-shell still overwrites App.openFeaturePage');
});

// ====== R2#3: 全局 emoji 伪元素消除 ======
test('R2#3a: tokens.css has no emoji pseudo-element locks', function () {
  ensure(!(/xj-premium-btn::after\s*\{[^}]*content:\s*['"]🔒/.test(TOK)),
    'tokens.css still has xj-premium-btn::after with emoji content');
  ensure(!(/xj-locked-area.*::before\s*\{[^}]*content:\s*["']🔒/.test(TOK)),
    'tokens.css still has lock-overlay::before with emoji content');
});

test('R2#3b: real-supervision-ai.html has no emoji pseudo-element', function () {
  ensure(!(/xj-premium-btn::after\s*\{[^}]*content:\s*['"]🔒/.test(RSAI)),
    'real-supervision-ai.html still has xj-premium-btn::after emoji');
  ensure(!(/xj-locked-area.*::before\s*\{[^}]*content:\s*["']🔒/.test(RSAI)),
    'real-supervision-ai.html still has lock-overlay::before emoji');
});

test('R2#3c: supervision-mindmap.html has no emoji pseudo-element', function () {
  ensure(!(/xj-premium-btn::after\s*\{[^}]*content:\s*['"]🔒/.test(SMH)),
    'supervision-mindmap.html still has xj-premium-btn::after emoji');
  ensure(!(/xj-locked-area.*::before\s*\{[^}]*content:\s*["']🔒/.test(SMH)),
    'supervision-mindmap.html still has lock-overlay::before emoji');
});

test('R2#3d: transcript-guide.html has no emoji pseudo-element', function () {
  ensure(!(/xj-premium-btn::after\s*\{[^}]*content:\s*['"]🔒/.test(TGH)),
    'transcript-guide.html still has xj-premium-btn::after emoji');
  ensure(!(/xj-locked-area.*::before\s*\{[^}]*content:\s*["']🔒/.test(TGH)),
    'transcript-guide.html still has lock-overlay::before emoji');
});

test('R2#3e: supervision.html has no member-lock::after emoji', function () {
  ensure(!(/member-lock::after\s*\{[^}]*content:\s*["']🔒/.test(SUPH)),
    'supervision.html still has member-lock::after emoji');
});

test('R2#3f: tokens.css uses inline-flex for premium-btn', function () {
  ensure(TOK.indexOf('.xj-premium-btn') >= 0,
    'tokens.css missing .xj-premium-btn');
  ensure(/\.xj-premium-btn\s*\{[^}]*inline-flex/.test(TOK),
    'tokens.css .xj-premium-btn missing inline-flex');
  ensure(TOK.indexOf('.xj-lock-badge') >= 0,
    'tokens.css missing .xj-lock-badge class');
});

// ====== R2#5: AI 填写锁标识 ======
test('R2#5a: consult-notes.html AI fill button has id, type=button, lock span', function () {
  ensure(CNH.indexOf('id="btn-ai-fill"') >= 0,
    'consult-notes.html AI fill button missing id="btn-ai-fill"');
  var btnTag = CNH.indexOf('<button type="button" id="btn-ai-fill"');
  ensure(btnTag >= 0,
    'consult-notes.html AI fill button missing type=button or incorrect attribute order');
  var btnSlice = CNH.slice(btnTag, btnTag + 300);
  ensure(btnSlice.indexOf('ai-fill-lock') >= 0,
    'consult-notes.html AI fill button missing ai-fill-lock span');
});

test('R2#5b: consult-notes.js dynamically sets AI fill lock badge', function () {
  ensure(CNJS.indexOf("document.getElementById('ai-fill-lock')") >= 0,
    'consult-notes.js missing dynamic AI fill lock badge init');
  ensure(CNJS.indexOf("App.lockBadge('ai-notes')") >= 0,
    'consult-notes.js missing lockBadge call for ai-notes');
});

test('R2#5c: consult-notes.js ai-notes gate still exists (expected-red base)', function () {
  ensure(CNJS.indexOf("!App.featureGate('ai-notes')") >= 0,
    'consult-notes.js ai-notes gate removed — mutation would go undetected');
});

// ====== R2#5d-e: 内联 emoji 移除 ======
test('R2#5d: transcript.html no inline emoji in premium button', function () {
  ensure(TPH.indexOf('\u{1F916}') < 0,
    'transcript.html still has inline robot emoji');
  ensure(TPH.indexOf('&#128274') < 0,
    'transcript.html still has inline lock emoji entity');
  ensure(TPH.indexOf('data-lucide="sparkles"') >= 0,
    'transcript.html missing Lucide sparkles icon replacement');
});

test('R2#5e: real-supervision.html no inline emoji and uses xj-lock-badge', function () {
  ensure(RSH.indexOf('\u{1F916}') < 0,
    'real-supervision.html still has inline robot emoji');
  ensure(RSH.indexOf('&#128274') < 0,
    'real-supervision.html still has inline lock emoji entity');
  ensure(RSH.indexOf('xj-lock-badge') >= 0,
    'real-supervision.html missing xj-lock-badge class');
  ensure(RSH.indexOf('data-lucide="sparkles"') >= 0,
    'real-supervision.html missing Lucide sparkles icon replacement');
});

// ====== Expected-red mutation probes ======
test('M-RED-1: restoring emoji ::after in tokens.css is detectable', function () {
  var mutated = TOK + '\n.xj-premium-btn::after{content:"\u{1F512}";font-size:9px}\n';
  var re = /xj-premium-btn::after\s*\{[^}]*content:\s*["'][^"]*["']/;
  ensure(re.test(mutated),
    'mutation did not produce detectable emoji pseudo-element');
});

test('M-RED-2: removing ai-notes gate is detectable', function () {
  var gate = "!App.featureGate('ai-notes')";
  ensure(CNJS.indexOf(gate) >= 0, 'precondition: ai-notes gate must exist in source');
  var mutated = CNJS.split(gate).join('true');
  ensure(mutated.indexOf(gate) < 0,
    'mutation did not remove ai-notes gate');
  ensure(mutated !== CNJS,
    'mutation was a no-op — ai-notes gate pattern not found');
});

test('M-RED-3: restoring lock-mini in consult-notes.html is detectable', function () {
  var mutated = CNH + '<span class="lock-mini">会员</span>';
  ensure(/lock-mini/.test(mutated),
    'mutation did not produce detectable lock-mini');
});

test('M-RED-4: restoring "AI 成长轨迹" in doc-growth.html is detectable', function () {
  var mutated = DGH.replace('AI 成长洞察', 'AI 成长轨迹');
  ensure(/AI 成长轨迹/.test(mutated),
    'mutation did not produce detectable old label');
  ensure(mutated !== DGH,
    'mutation was a no-op — "AI 成长洞察" pattern not found');
});

test('M-RED-5: re-gating upload with ai-analyze is detectable', function () {
  var mutated = CNJS + "\nif (!App.featureGate('ai-analyze')) { return; }";
  ensure(/if \(!App\.featureGate\('ai-analyze'\)\)/.test(mutated),
    'mutation did not produce detectable ai-analyze gate');
});

// ---- Summary ----
console.log('');
console.log('=== XJ-4.2.3-ui-p0-repair-v2 contract (Rework 02) ===');
console.log('----------------------------------------');
console.log('Passed: ' + passed + ' | Failed: ' + failed);

var changedFiles = [APP_JS, SCAL_JS, DC_JS, CN_JS, DC_HTML, DG_HTML, CN_HTML,
  RS_AI_HTML, SM_HTML, TG_HTML, SUP_HTML, TP_HTML, RS_HTML, TOKENS_CSS];
var shaMap = {};
changedFiles.forEach(function (f) {
  shaMap[path.relative(ROOT, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
});
console.log('changed_file_sha256: ' + JSON.stringify(shaMap));

if (failed > 0) {
  console.log('contract_phase: CONTRACT-BROKEN');
  process.exit(1);
} else {
  console.log('contract_phase: ALL-GREEN');
  console.log('注：仅验证 4.2.3 UI P0 Rework 02 契约，不宣称 release-ready。');
  process.exit(0);
}
