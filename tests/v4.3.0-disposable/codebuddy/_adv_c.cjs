'use strict';
/*
 * 内部对抗审查（本任务临时文件，交付前删除）。
 * 对本任务自己的契约/探针施加攻击：每个攻击生成一个变异副本（同目录，保证相对 require 生效），
 * 以子进程运行并断言退出码变为 1（攻击被暴露）。攻击后立刻删除变异副本。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const RC = fs.readFileSync(path.join(DIR, 'run-contract.js'), 'utf8');
const MP = fs.readFileSync(path.join(DIR, 'mutation-probes.js'), 'utf8');

const out = [];
function attack(id, title, baseSrc, find, replace, expectExit) {
  if (baseSrc.indexOf(find) === -1) { out.push([id, title, 'TARGET_NOT_FOUND', 'FAIL']); return; }
  const mutated = baseSrc.split(find).join(replace);
  const tmp = path.join(DIR, '_adv_variant_' + id + '.js');
  fs.writeFileSync(tmp, mutated, 'utf8');
  const r = spawnSync(process.execPath, [tmp], { cwd: path.join(DIR, '..', '..', '..'), encoding: 'utf8', timeout: 120000 });
  fs.unlinkSync(tmp);
  const ok = r.status === expectExit;
  out.push([id, title, 'exit=' + r.status + ' expect=' + expectExit, ok ? 'EXPOSED(攻击被暴露)' : 'NOT-EXPOSED(FAIL)']);
}

// ADV-1 把真实 prototype require 改成测试内 stub 替代实现 → 契约必须大量 FAIL（exit 1）
attack('ADV1', '替代实现攻击：atlas/adapter 换成 stub', RC,
  'try { atlas = require(ATLAS_PATH); } catch (e) { prototypeLoadErrors.push(\'case-atlas-view-model.js :: \' + e.message); }',
  'atlas = { createViewModel: function () { return { stats: { totalSessions: 30 }, timeline: { length: 30, slice: function () { return []; } }, nodes: [], edges: [], client: { id: "cli-synth-0001" } }; }, validateViewModel: function () { return { ok: true, issues: [] }; }, filterNodes: function () { return []; }, NODE_TYPES: [], EDGE_TYPES: [], FILTERS: [] };',
  1);

// ADV-2 删除真实调用攻击：PI-01/PI-02b 不再调用 createViewModel，改用手造对象 → 必须 FAIL（exit 1）
attack('ADV2', '删除真实调用：PI-01 用手造 vm 顶替', RC,
  'const vm = atlas.createViewModel(input);',
  'const vm = { stats: { totalSessions: 30 }, timeline: { length: 30 }, client: { id: "cli-synth-0001" } };',
  1);

// ADV-3 弱探针攻击：mutation 探针永真 → mutant 必须显示 survived（exit 1）
attack('ADV3', '弱探针：timelineUnder30Flagged 永真', MP,
  "return !v.ok && v.issues.some(i => i.includes('fewer than 30'));",
  'return true;',
  1);

// ADV-4 mutation 目标丢失攻击：find 串不存在 → 必须 FAIL（exit 1），不得默默跳过
attack('ADV4', 'mutation 目标不存在必须暴露', MP,
  "find: 'if (vm.timeline && vm.timeline.length < 30) issues.push'",
  "find: 'THIS_STRING_DOES_NOT_EXIST_IN_PROTOTYPE'",
  1);

// ADV-5 吞异常攻击：piRecord 的 catch 把非预期异常改报 PASS → 强制 PI-01 抛错后必须仍能观察到（exit 0 但 PASS 造假）
// 这一攻击属于“自我报告层说谎”，无法靠运行器自身暴露；做双重变异验证：先让 PI-01 抛错（正常应 exit 1），再叠加吞异常（exit 变 0）→ 证明吞异常攻击确实能伪造，必须靠独立复跑防御。
(function adv5() {
  const findThrow = 'const vm = atlas.createViewModel(input);';
  const replThrow = 'atlas.noSuchFunction(); const vm = atlas.createViewModel(input);';
  if (RC.indexOf(findThrow) === -1) { out.push(['ADV5a', '目标未找到', 'TARGET_NOT_FOUND', 'FAIL']); return; }
  const findSwallow = "record({ id, title, target: 'prototype', ran: true, call, status: 'FAIL', observed: 'unexpected throw', detail: '非预期异常: ' + e.message });";
  const replSwallow = "record({ id, title, target: 'prototype', ran: true, call, status: 'PASS', observed: 'swallowed', detail: '' });";
  const m1 = RC.split(findThrow).join(replThrow);
  const tmp1 = path.join(DIR, '_adv_variant_ADV5a.js');
  fs.writeFileSync(tmp1, m1, 'utf8');
  const r1 = spawnSync(process.execPath, [tmp1], { cwd: path.join(DIR, '..', '..', '..'), encoding: 'utf8', timeout: 120000 });
  fs.unlinkSync(tmp1);
  const m2 = m1.split(findSwallow).join(replSwallow);
  const tmp2 = path.join(DIR, '_adv_variant_ADV5b.js');
  fs.writeFileSync(tmp2, m2, 'utf8');
  const r2 = spawnSync(process.execPath, [tmp2], { cwd: path.join(DIR, '..', '..', '..'), encoding: 'utf8', timeout: 120000 });
  fs.unlinkSync(tmp2);
  const exposed = r1.status === 1; // 异常正常暴露
  const swallowWorks = r2.status === 0; // 吞异常攻击确实能伪造全绿 —— 记录为已知说谎面
  out.push(['ADV5a', '非预期异常正常暴露为 FAIL', 'exit=' + r1.status + ' expect=1', exposed ? 'EXPOSED(攻击被暴露)' : 'NOT-EXPOSED(FAIL)']);
  out.push(['ADV5b', '吞异常攻击可伪造（自我报告层说谎面，需独立复跑防御）', 'exit=' + r2.status + ' 伪造成功=' + swallowWorks, swallowWorks ? 'DOCUMENTED-LIMIT' : 'UNEXPECTED']);
})();

for (const row of out) console.log(row.join(' | '));
const bad = out.filter(r => r[3] === 'NOT-EXPOSED(FAIL)' || r[3] === 'FAIL' || r[3] === 'UNEXPECTED');
console.log('ADV_SUMMARY: total=' + out.length + ' notExposed=' + bad.length);
process.exit(bad.length ? 1 : 0);
