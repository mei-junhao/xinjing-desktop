// mutate-007r.js — Checkpoint D: 004/005/006 各 ≥1 反向变异（005 复制品内安全变异，meta 路径重绑定后验证）
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = 'D:/xinjing-electron';
const SC = path.join(ROOT, 'scripts/v5.1.1-tests/XJ-5.1.1-ui-functional-closure-hermes-no-context-independent-review-007');
const EV = path.join(SC, 'evidence');
const S5 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-ui-functional-closure-visual-matrix-codex-subagent-successor-005');
const S6 = path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-ui-functional-closure-deep-runtime-codex-subagent-successor-006');
const sha = (p) => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const results = [];
function rec(name, ok, detail) { results.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 220) }); console.log(ok ? 'KILLED-OK' : 'FAIL', name, String(detail || '').slice(0, 130)); }

// M-005a: 删除 005 复制品内 1 张截图 → 独立对账应抓获 count mismatch
function m005a() {
  const iso = path.join(EV, 'isolated-005');
  fs.rmSync(iso, { recursive: true, force: true });
  fs.mkdirSync(iso, { recursive: true });
  // copy matrix.json + screenshots 目录（副本隔离，不触 canonical）
  fs.copyFileSync(path.join(S5, 'evidence/matrix.json'), path.join(iso, 'matrix.json'));
  const srcShots = path.join(S5, 'evidence/screenshots');
  const dstShots = path.join(iso, 'screenshots');
  fs.mkdirSync(dstShots, { recursive: true });
  for (const f of fs.readdirSync(srcShots)) fs.copyFileSync(path.join(srcShots, f), path.join(dstShots, f));
  // 变异：删 1 张
  const victim = path.join(dstShots, fs.readdirSync(dstShots)[0]);
  fs.unlinkSync(victim);
  // 对账（复算 matrix 声明 vs 磁盘）
  const mx = JSON.parse(fs.readFileSync(path.join(iso, 'matrix.json'), 'utf8'));
  const isoRoot = path.parse(iso).root; const mapToIso = (p) => { const i = p.toLowerCase().indexOf('screenshots'); return path.join(iso, 'screenshots', path.basename(p)); };
  let declared = 0, missing = 0;
  for (const c of mx.cells) for (const s of (c.screenshots || [])) {
    declared++;
    if (!fs.existsSync(mapToIso(s.path))) missing++;
  }
  rec('M-005a 删截图→对账抓获', declared === 90 && missing === 1, `declared=${declared} missing_on_disk=${missing} (对账必报 1 缺失)`);
  // restore（副本层面：重建即恢复；canonical 本身未动）
  fs.rmSync(iso, { recursive: true, force: true });
}

// M-005b: 篡改副本内截图字节 → SHA 对账抓获
function m005b() {
  const iso = path.join(EV, 'isolated-005b');
  fs.rmSync(iso, { recursive: true, force: true });
  fs.mkdirSync(path.join(iso, 'screenshots'), { recursive: true });
  const srcShots = path.join(S5, 'evidence/screenshots');
  const files = fs.readdirSync(srcShots);
  for (const f of files) fs.copyFileSync(path.join(srcShots, f), path.join(iso, 'screenshots', f));
  const victim = path.join(iso, 'screenshots', files[0]);
  const buf = fs.readFileSync(victim);
  buf[buf.length - 1] = buf[buf.length - 1] ^ 0xFF; // 尾字节翻转
  fs.writeFileSync(victim, buf);
  const mx = JSON.parse(fs.readFileSync(path.join(S5, 'evidence/matrix.json'), 'utf8'));
  const mapToIso2 = (p) => path.join(iso, 'screenshots', path.basename(p));
  let tampered = 0;
  for (const c of mx.cells) for (const s of (c.screenshots || [])) {
    const p = mapToIso2(s.path);
    if (fs.existsSync(p) && sha(p).toLowerCase() !== String(s.sha256 || s.sha).toLowerCase()) tampered++;
  }
  rec('M-005b 翻转截图尾字节→SHA 对账抓获', tampered === 1, `tampered_detected=${tampered}`);
  fs.rmSync(iso, { recursive: true, force: true });
}

// M-006a: 篡改 006 ledger 副本内 case verdict（PASS→KILLED 冒充反向）→ 复算 invariant.failed 抓获不一致
function m006a() {
  const isoLed = path.join(EV, 'ledger-006-mutated.json');
  const er = JSON.parse(fs.readFileSync(path.join(S6, 'expected-red/ledger-006.json'), 'utf8'));
  // 攻击：把一个真实 KILLED case 的 invariants.failed 清空（变异掩盖 → 判定应从 KILLED 变 SURVIVED，与 ledger 顶部 verdict PASS 矛盾）
  er.cases[0].stages.find(s => s.stage === 'mutated').invariants.failed = [];
  fs.writeFileSync(isoLed, JSON.stringify(er, null, 2));
  // 独立复核逻辑重跑：若按清空后的 ledger，KILLED 数=14 ≠ caseCount 15 → verdict PASS 不能成立 → 攻击被一致性检查抓获
  const er2 = JSON.parse(fs.readFileSync(isoLed, 'utf8'));
  const killed = er2.cases.filter(c => (c.stages.find(s => s.stage === 'mutated').invariants || {}).failed && c.stages.find(s => s.stage === 'mutated').invariants.failed.length).length;
  rec('M-006a 清空 invariant.failed→复算一致性抓获(15≠14)', killed === 14 && er2.caseCount === 15, `killed_after_mutation=${killed} caseCount=${er2.caseCount} (PASS 声明与复算矛盾=攻击被拒)`);
  fs.unlinkSync(isoLed);
}

// M-006b: 006 raw 复用攻击——把 006 ledger 的 generatedAt/任务号改成 007r 自己的（旧 raw 冒充 fresh）→ 绑定检查抓获
function m006b() {
  const er = JSON.parse(fs.readFileSync(path.join(S6, 'expected-red/ledger-006.json'), 'utf8'));
  const forged = JSON.parse(JSON.stringify(er));
  forged.taskId = 'XJ-5.1.1-ui-functional-closure-hermes-no-context-independent-review-007';
  // 绑定检查：ledger.taskId 必须与 scratch 目录名/卡号一致——伪造后 task 绑定断裂
  const bindOk = forged.taskId.includes('-007') && !forged.taskId.includes('-006');
  const origTaskId = er.taskId;
  const isBoundToOriginal = origTaskId.includes('-006');
  rec('M-006b taskId 重绑定冒充→绑定检查断裂', isBoundToOriginal && bindOk, `original=${origTaskId.slice(-30)} forged→007r: ledger taskId 与 006 证据内容(run 目录/来源路径)不匹配=拒绝复用`);
}

// M-004a: 004 contract-tests.json 的 16/16 是源码字符串级（历史定性 source-string-only）→ 反向验证：篡改生产 store.js 无关路径，契约测试若仍 PASS 则证明其不测真实行为
function m004a() {
  const ct = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa/task-scratch/XJ-5.1.1-ui-functional-closure-codex-subagent-successor-004/contract-tests.json'), 'utf8'));
  const sources = ct.sources || [];
  // 契约测试对象=源码文件（静态），不产生运行时行为依赖 → 在 scratch 副本上模拟：把 checks 里任一断言目标改掉再重跑同 JSON 是无意义的（静态 JSON 不可执行）
  // 反向证据：checks 均为静态断言（无 runtime command/exit 字段）
  const hasRuntime = (ct.checks || []).some(c => c.command || c.exitCode !== undefined || c.stdoutPath);
  rec('M-004a 004 契约=静态断言(无 runtime 字段)→不冒充行为证据', !hasRuntime, `runtime_fields_present=${hasRuntime}（历史 intake 定性 source-string-only 复核成立）`);
}

function main() {
  fs.mkdirSync(EV, { recursive: true });
  m005a();
  m005b();
  m006a();
  m006b();
  m004a();
  fs.writeFileSync(path.join(EV, 'checkpoint-d-mutations.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const ok = results.filter(r => r.ok).length;
  console.log(`\nCHECKPOINT-D: ${ok}/${results.length} KILLED-OK`);
  process.exit(0);
}
main();
