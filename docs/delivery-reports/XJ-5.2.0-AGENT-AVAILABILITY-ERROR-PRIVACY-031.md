[STATUS]
031 独立验收修复完成：测试现通过真实 chat() 入口在 new Session(options) 期间触发 constructor 异常，验证 raw-secret 隐私。

[ARTIFACTS]
- tests/v5.2.0/agent-availability-error-privacy.contract.test.cjs
- docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md

[VALIDATION]
- 修复前假绿原因：bad.Session 赋值只修改导出的属性，未替换 IIFE 闭包内 Session；实际覆盖的是 AgentCore.runRound 不可用路径，不是 constructor catch。
- 修复后真实入口：chat('hello', optionsProxy)，optionsProxy.maxSteps getter 在闭包内 new Session(options) 期间抛出 synthetic secret；断言 SYS_INTERNAL_ERROR、result/log 无 secret。
- focused：2/2 通过。
- full v5.2.0 contracts：90/90 通过。
- controlled Electron：SUPERVISION_STATUS=PASS，退出码 0。
- node --check 与 git diff --check：通过。
- protected hashes：任务卡列出的 8 个保护文件均未漂移。

P0-P3：P0=0，P1=0，P2=0，P3=0。

内部对抗审查：真实 VM 覆盖 App.aiUnlocked、AI.getActiveConfig、AI.isToolCapable、真实 Session constructor throw、正常 unavailable/unsupported、成功 chat；恢复 raw e.message、替换 facade、删除 await、改变正常文案或 SYS_INTERNAL_ERROR mapping 均应使断言失败。

残余风险：allowlist 外历史错误投影未修改。
未授权动作：未执行网络、真实临床数据、commit、merge、push、package、sign、upload、publish。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-AVAILABILITY-ERROR-PRIVACY-031.md
