[STATUS]
036 实施完成，由 Codex 主负责人本人按用户最新指令实现并验收。035 确认的 AgentTools 错误文本隐私泄漏已在 allowlist 范围内修复；本工作树仍是 5.2.0 implementation，不是 release-ready。

[ARTIFACTS]
- app/js/agent-tools.js
- tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs
- docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
- docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md

[VALIDATION]
- expected-red：改生产源之前运行 focused 合同，8 项中的 4 项按预期失败，真实复现 nested billing 错误、月结错误对象、督导/大师 raw error 和督导 console 日志泄漏。
- focused 最终：node --test tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs，8/8 通过。
- v5.2.0 全量合同：node --test tests/v5.2.0/*.contract.test.cjs，100/100 通过。
- 受控 Electron：node tests/v5.2.0/015-local-electron-acceptance.cjs，SUPERVISION_STATUS=PASS，退出码 0。
- node --check app/js/agent-tools.js、node --check tests/v5.2.0/agent-tools-error-privacy.contract.test.cjs 和 allowlist git diff --check 均通过。
- 反向变异：合同在 VM 临时生产源码副本中把固定 fallback 改回 src.error，同一个真实 invoke() 入口观察到 synthetic secret 重现；未改动工作树生产源码。
- 最终 SHA-256：agent-tools.js C40F46101A835AD11E4CAB31ED001D5BA63C9CCD57ECF1628C9221B3B91AD472；agent-api.js 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388；agent-core.js 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2；main.js 6F01CCB23DCA8A75C32BABA913310FFB491FB65287F9BE23686CFFCB4925D581；preload.js 9F922668F0FF93954DE63834292D0B56F5040C67CD885D826CB87722AB6987DD；package.json B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72；package-lock.json FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D629061CB03；最终合同测试 959936DEFDDC77B2CF5E664899838F33011D23CF0E0538DC7AA3C4BC90583B57。
- 验收前后受保护文件哈希未漂移；工作树原有 agent-api.js、package-lock.json 脏改动保留，未修改这两项。

实现结果：
- AgentTools 共享 toolFailure() 对 supervision 与 masters 固定返回操作失败文案；保留白名单内的 errorCode/code/stage/transportState、正整数 failedSegments、非负安全整数计数及布尔 truncated，拒绝自由文本和异常对象字段。
- billing.add_record 维持既有部分结果 ok:true 与 data.details[] 契约，但不再把 create-client/create-session 异常原文写进 reason。
- billing.monthly_settle 与 client.update 的存储失败对象及 rejection 均使用稳定操作级文案。
- supervision.start/ask、masters.open/message 的 Error 与 unknown-object rejection 不再投影异常原文；督导追问附加保存失败仍保留既有成功结果形状，但控制台仅记固定安全标签。
- 顶层 AgentTools.invoke() 的通用 catch 保持 034 固定文案。文件 IPC 权限/路径提示保持原样；主进程只回传固定 OS/业务码的事实由本卡前只读检查确认，未改 IPC 边界。

P0-P3：P0=0，P1=0（本卡已覆盖的 confirmed AgentTools handler/result/log 泄漏关闭），P2=0，P3=0。

内部对抗审查：
- 测试载入真实生产 app/js/agent-tools.js，通过 window.AgentTools.invoke() 并 await 异步结果；没有用 AgentTools facade 或 source-string-only 结论。
- 覆盖 Error、unknown object、返回 {error: string}、持久化失败对象、部分记账失败、督导追问存储 rejection 日志、正常成功结构和稳定验证文案。
- 反向变异恢复 raw src.error 后，真实入口合同能观察到合成 secret；可检出回归。测试内变异只运行在单独 VM 源字符串，不写生产文件。
- 人工核对 agent-tools.js 修改差异，无越界生产文件；保护哈希未漂移；合同等待所有 Promise；focused/full/Electron 都在最终源码上重新通过。
- 独立代理复核未执行；本交付由 Codex 自写并负责验收，非独立无上下文评审。没有用模型身份或档位主张替代平台工具证据。

残余风险：file.read/file.write 的 IPC 失败 result 仍保留可操作的主进程 reason/permission 文案；该边界本轮未改，且真实 IPC 路径不在本合同的行为验证内。035 报告标为 incomplete 的主进程来源语义及督导启动持久化 rejection 组合需新证据时再独立审计。全项目其它 AgentTools 路径没有被本卡证明全部无泄漏。

未授权/未执行：未修改 file IPC/UI、AgentCore/API、Store、主进程或 preload；未访问真实临床数据、网络和远端状态；未执行 commit、merge、push、package、sign、upload、publish。发布与发包留给其他 agent。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-036.md
