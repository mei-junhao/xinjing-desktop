/* ============================================================
   心镜 XinJing — 示例数据注入脚本
   用途：首次体验时注入示例来访者，复刻参考图效果
   运行方式：浏览器控制台执行 seedData() 后刷新
   ============================================================ */

function seedData() {
  if (Store.getClients().length > 0) {
    if (!confirm('已有数据，继续将追加示例数据。确定？')) return;
  }

  // 小A
  const xiaoA = Store.createClient({
    name: '小A',
    gender: 'female',
    birthDate: '1992-03-12',
    phone: '138****0001',
    firstVisitDate: '2026-06-01',
    status: 'active',
    tags: ['成人个体', '焦虑', '关系议题'],
    notes: '25岁，职场新人。主诉焦虑、入睡困难，与母亲关系紧张。首次咨询由朋友转介。',
  });

  // 阿拉伯
  const alabo = Store.createClient({
    name: '阿拉伯',
    gender: 'male',
    birthDate: '1988-11-20',
    firstVisitDate: '2026-06-10',
    status: 'active',
    tags: ['成人个体', '抑郁'],
    notes: '38岁，自由职业者。主诉情绪低落、兴趣减退。',
  });

  // 小A 的4节会话
  const xiaoASessions = [
    {
      sessionNumber: 1, date: '2026-06-01', startTime: '14:00', endTime: '15:00', durationMinutes: 60,
      transcript: '咨：你好，今天想聊些什么？\n来：我最近总是睡不好，脑子里停不下来。\n咨：睡不好是从什么时候开始的？\n来：大概一个月前，换了新部门之后。',
      soap: { subjective: '来访者自述近一个月入睡困难，思维反刍，与岗位变动相关。', objective: '会谈中语速偏快，手指反复交握，表情紧绷。', assessment: '适应性焦虑，与角色转换期的不确定性有关；防御以理智化为主。', plan: '提供抱持性空间，探索对新角色的期待与恐惧。' },
      dap: { data: '', assessment: '', plan: '' },
      reflection: '反移情上感到被其焦虑"追赶"，需保持节制，不急于给建议。',
      isConfirmed: true,
    },
    {
      sessionNumber: 2, date: '2026-06-15', startTime: '14:00', endTime: '15:00', durationMinutes: 60,
      transcript: '咨：上周之后有什么变化吗？\n来：还是睡不好，但好像没那么怕了。\n咨：哦？是什么让你没那么怕了？',
      soap: { subjective: '来访者报告焦虑略减，开始区分"工作表现"与"自我价值"。', objective: '相较首次，姿态放松，偶尔微笑。', assessment: '初步建立治疗联盟，可承受适度探索。', plan: '引入"足够好的"概念，讨论完美主义议题。' },
      dap: { data: '', assessment: '', plan: '' },
      reflection: '注意到她开始使用"好像"这类试探性语言，真假自体议题浮现。',
      isConfirmed: true,
    },
    {
      sessionNumber: 3, date: '2026-06-29', startTime: '14:00', endTime: '15:00', durationMinutes: 60,
      transcript: '来：我妈又打电话来了，一接就烦。\n咨：烦的是什么？\n来：她总觉得我过得不好，像我没能力一样。',
      soap: { subjective: '来访者谈及与母亲通话后的烦躁，感到被贬低。', objective: '提及母亲时声音提高，握拳。', assessment: '母婴关系中的控制议题，重现于移情；早期抱持环境不足。', plan: '在移情中处理控制感议题，不催促其与母亲沟通。' },
      dap: { data: '', assessment: '', plan: '' },
      reflection: '需小心不要变成"替妈妈辩解"的位置，保持来访者视角。',
      isConfirmed: true,
    },
    {
      sessionNumber: 4, date: '2026-07-06', startTime: '14:00', endTime: '15:00', durationMinutes: 60,
      transcript: '来：这周我试着跟自己说"已经够好了"。\n咨：这句话对你意味着什么？\n来：意味着我可以停下来。',
      soap: { subjective: '', objective: '', assessment: '', plan: '' },
      dap: { data: '', assessment: '', plan: '' },
      reflection: '',
      isConfirmed: false,
    },
  ];

  xiaoASessions.forEach((s) => {
    Store.createSession(Object.assign({ clientId: xiaoA.id }, s));
  });

  // 阿拉伯 的1节会话
  Store.createSession({
    clientId: alabo.id,
    sessionNumber: 1,
    date: '2026-06-10',
    startTime: '10:00',
    endTime: '11:00',
    durationMinutes: 60,
    transcript: '来：没什么特别想说的，就是觉得累。\n咨：这种累，是身体的，还是别的？\n来：说不清，像是提不起劲。',
    soap: { subjective: '来访者主诉持续性疲乏、兴趣减退，归因模糊。', objective: '语调低平，眼神少接触，反应迟缓。', assessment: '抑郁状态，需评估严重程度与风险；动力学层面存在情感隔离。', plan: '建立关系优先，评估睡眠与日常功能，必要时转介精神科。' },
    dap: { data: '', assessment: '', plan: '' },
    reflection: '他的"提不起劲"让我想慢下来，不催他产出。',
    isConfirmed: true,
  });

  // 督导记录（关联小A第1节）
  const xiaoASession1 = Store.getSessionsByClient(xiaoA.id)[0];
  Store.createSupervision({
    type: 'individual',
    supervisorName: '张老师',
    date: '2026-06-05',
    sessionIds: [xiaoASession1.id],
    content: '讨论初始访谈的抱持姿态，以及如何不急于结构化。',
    conclusion: '建议在焦虑议题上保持"不解释"的节制，让来访者先充分言说。',
  });

  alert('示例数据已注入！刷新页面查看效果。');
  location.reload();
}
