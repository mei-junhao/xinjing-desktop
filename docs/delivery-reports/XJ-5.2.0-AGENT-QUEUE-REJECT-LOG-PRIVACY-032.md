[STATUS]
032 已完成两条 queue reject-catch 日志的 raw 异常文本移除。

[ARTIFACTS]
- app/js/agent-api.js
- tests/v5.2.0/agent-queue-reject-log-privacy.contract.test.cjs

[VALIDATION]
- focused 首轮失败原因：fixture AI:{} 使 isAvailable() 提前返回 SYS_INVALID_STATE，未进入 Session.send/acquireSlot/close 队列路径；修复 fixture 后真实 VM queue cancellation 测试通过。
- focused：2/2 通过。
- full v5.2.0 contracts：92/92 通过。
- controlled Electron：SUPERVISION_STATUS=PASS，退出码 0。
- node --check 与 git diff --check：通过。
- protected hashes：任务卡列出的 8 个保护文件均未漂移。

P0-P3：P0=0，P1=0，P2=0，P3=0。

内部对抗审查：真实 VM 覆盖正常 queue cancellation、Session.send/acquireSlot/close 路径和日志捕获；两个 reject-catch 本身因内部 Promise reject callback 不可注入且禁止新增生产测试钩子，仍标记 UNVERIFIED，未将 assert.ok(true) 视为隐私 PASS。恢复 raw e.message/e、替换 facade、删除 await 或改变 queue cancellation 行为应使可达合同失败。

残余风险：两条 reject-catch 异常回调分支缺乏真实触发证据；日志替换已完成但分支验证保持未验证。
未授权动作：未执行网络、真实临床数据、commit、merge、push、package、sign、upload、publish。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-QUEUE-REJECT-LOG-PRIVACY-032.md
