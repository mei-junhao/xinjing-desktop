'use strict';

const assert = require('node:assert/strict');
const data = require('../../../../app/js/supervision-syndicate-data.js');
const core = require('../../../../app/js/supervision-syndicate.js');

assert.equal(data.CARDS.length, 9, 'expected lead + summarizer + seven schools');
assert.equal(data.SCHOOLS.length, 7, 'expected seven school cards');
assert.deepEqual(core.parseRouteResponse(JSON.stringify({ schools: ['sup-freud', 'sup-klein', 'sup-bion', 'sup-jung'] })).schools, ['sup-freud', 'sup-klein', 'sup-bion']);

function mockProvider(config) {
  const calls = [];
  let absentUsed = false;
  let routeAttempts = 0;
  let synthesisAttempts = 0;
  return {
    calls,
    send(messages, callback) {
      const all = messages.map((message) => message.content).join('\n');
      calls.push(all);
      let response;
      if (all.includes('四节结构化摘要')) {
        response = { content: '一、情感脉络：焦虑→悲伤\n二、防御模式：理智化\n三、移情线索：依赖\n四、干预变化：澄清' };
      } else if (all.includes('请判断案例类型并输出路由 JSON')) {
        routeAttempts += 1;
        response = config.routeFail ? { error: 'lead-route-down' } : { content: JSON.stringify({ case_type: '综合性', schools: ['sup-freud', 'sup-klein', 'sup-bion', 'sup-jung'], focus: '移情', workflow: 'focused' }) };
      } else if (all.includes('你现在执行综合阶段')) {
        synthesisAttempts += 1;
        response = config.synthesisFail ? { error: 'lead-synthesis-down' } : { content: '【对比表】\n各派证据\n【分歧点】\n解释路径不同\n【整合建议】\n继续确认材料' };
      } else if (config.absentKey && all.includes(config.absentKey) && !absentUsed) {
        absentUsed = true;
        response = { error: 'school-down' };
      } else {
        response = { content: '逐派分析：依据材料列出观察、判断与建议。' };
      }
      callback(response);
    },
  };
}

(async () => {
  const provider = mockProvider({ absentKey: '比昂式督导师' });
  const stored = [];
  const result = await core.run('x'.repeat(5001), { provider, autoSave: false });
  assert.equal(result.ok, true);
  assert.equal(result.summarized, true, 'long material must invoke summarizer');
  assert.equal(result.schools.length, 3, 'route is capped to three schools');
  assert.deepEqual(result.analyses.filter((row) => row.status === 'absent').map((row) => row.key), ['sup-bion']);
  assert.match(result.synthesis, /对比表/);
  assert.match(result.synthesis, /分歧点/);
  assert.match(result.synthesis, /整合建议/);

  const archive = await core.saveMultiSchoolDurable(result, { material: 'synthetic', clientId: 'c1' }, {
    store: { saveAiSupervisionDurable: async (payload) => { stored.push(payload); return { ok: true, value: { id: 'sv1' } }; } },
  });
  assert.equal(archive.ok, true);
  assert.equal(stored[0].mode, 'multi-school');
  assert.deepEqual(stored[0].schools, result.schools);
  assert.equal((await core.saveMultiSchoolDurable({ ok: true }, {}, { store: { saveAiSupervisionDurable: async () => ({ ok: true }) } })).ok, false, 'missing mode must fail closed');

  const routeDown = await core.run('short synthetic material', { provider: mockProvider({ routeFail: true }), autoSave: false });
  assert.equal(routeDown.ok, false);
  assert.equal(routeDown.errorCode, 'LEAD_ROUTE_FAILED');
  assert.equal(routeDown.synthesis, undefined, 'lead route double failure must not fabricate synthesis');

  const synthesisDown = await core.run('short synthetic material', { provider: mockProvider({ synthesisFail: true }), autoSave: false });
  assert.equal(synthesisDown.ok, false);
  assert.equal(synthesisDown.errorCode, 'LEAD_SYNTHESIS_FAILED');
  assert.equal(synthesisDown.synthesis, undefined, 'lead synthesis double failure must not fabricate output');

  console.log(JSON.stringify({ ok: true, calls: provider.calls.length, schools: result.schools, absent: ['sup-bion'], archiveMode: stored[0].mode }));
})();
