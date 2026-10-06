[STATUS]
035 只读审计完成。未修改生产代码、测试、配置或既有报告。指定 6.1-sol low 子代理通道连续返回不可解析 payload，最终无法提供可验收交付；本报告由 /root 按任务卡在本地以生产模块和 synthetic VM 探针完成，不把代理消息当证据。

[ARTIFACTS]
- docs/agent-coordination/v5.2.0/tasks/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
- docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md

[VALIDATION]
- 使用 node VM 读取真实 app/js/agent-tools.js，保留真实 TOOL_REGISTRY 和 window.AgentTools.invoke()；所有 invoke Promise 均 await，所有异常标记为 synthetic secret。
- confirmed：billing.add_record 的 createClientDurable rejection 在 data.details[].reason 拼入 Error.message；createSessionDurable 的失败对象 error.message 进入 data.details[].reason。工具整体仍返回 ok:true，但失败详情向调用者暴露原文。
- confirmed：billing.monthly_settle 新增和同月追加两条 updateClientDurable 失败对象路径，均将 error.message 拼入 public error；月结捕获实际 rejection 时使用固定文案，本次探针验证了失败对象透传路径。
- confirmed：client.update 对 Store 失败对象和 Error rejection 都把底层异常文本写入 public error；另一个 object 形态由 updateClientDurable 返回错误对象的探针覆盖。
- confirmed：supervision.start 对 SupervisionCore 返回的 error 字符串经 toolFailure 原样进入 public result；对其 Error 与 unknown-object rejection 也分别返回含原始 message 的失败文案。持久化失败对象走固定文案；该条未证明安全持久化 rejection 分支。
- confirmed：supervision.ask 对 runRound 返回的 error 字符串经 toolFailure 原样返回；Error 与 unknown-object rejection 的 handler catch 也保留原文。异步追问成功后若 updateSupervisionDurable rejection，public 结果仍为成功，但 console.warn 写入异常原文；返回非 ok 的失败对象则使用固定文案。
- confirmed：masters.open 在有 topic 的实际调用中，对 callMaster 返回的 error 字符串使用 toolFailure 原样返回；Error 与 unknown-object rejection 均由 handler catch 原样拼入 public error。其不带 topic 的会话创建成功路径被合成 MastersCore/Store 验证。
- confirmed：masters.message 在先通过同一真实 AgentTools 实例成功打开合成会话后，对 callMaster 返回错误、Error 和 unknown-object rejection 均可达并投影异常原文。
- confirmed：file.read / file.write 在 window.__XJ_API__ 返回失败对象时，将 message/error 文本透传到 invoke 返回对象；分别覆盖 message 与 error 字段。真正抛出的 Error/unknown object 被 invoke 外层统一投影为“工具执行失败”，未见原异常泄漏。该证据证明 renderer public result 对 IPC failure reason 的透传；底层 reason 是否为生产主进程原始异常，未在本审计验证。
- 当前探针未见泄漏：file.workdir 对返回失败对象使用固定“工作文件夹不可用”文案；read/write Promise rejection 使用 invoke 外层固定文案。
- 保护 SHA-256（审计前后复核一致）：agent-tools.js 0327989930E21278CD5751B2ED1DB29DC4142BD883FB16873795733756F5CCD9；agent-api.js 33B49EA81F54DA07A2DB1E67BF28DBB03E1431E0AF05C59BC151BC1980450388；agent-core.js 00F758CE37702108AF4FF9BF48C294EDCB5BC32480B6DD6AD6DFD7F7235A5AD2；package.json B74E0AA8F9B645D06647096545A3C611C112EF217AABADEA407B1950D629FC72；package-lock.json FDB8D11766CE697211B6C21AEE91E488ECD8E12FEAFF725C568D629061CB03。
- node --check app/js/agent-tools.js：通过。
- git diff --check -- docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md：通过。
- 初次临时 probe harness 自身对异步 fixture 的构造不正确并以非零退出；该次输出被丢弃，不作为证据。修正后重复运行的生产 VM 探针退出码为 0，结果如上。

证据分类：
- confirmed：billing.add_record、billing.monthly_settle、client.update、supervision.start、supervision.ask、masters.open、masters.message 的合成异常 result 投影；supervision.ask 的 console.warn 异常文本；file.read/file.write 对 IPC failure object 的文本透传。
- incomplete：文件 IPC 返回文本的主进程来源语义；未执行真实 IPC，不能据此断言每个 reason 都是原始异常。月结 catch rejection 的静态安全文案已检查，但具体抛错分支不属于本次已完成矩阵。
- unverified：督导启动持久化 rejection、月结两路径持久化 rejection 的所有组合、UI/主进程 IPC 调用者是否二次过滤、Agent 核心是否把 handler result 再次投影；未因源码候选或本 VM 未触发而宣称覆盖。
- out-of-scope：代码/测试修复、真实 IPC 或 Electron 文件访问、网络、真实临床数据、打包签名发布。

follow-up 建议：
- 先用一个新实现卡统一 AgentTools.invoke 顶层 handler 结果边界：对失败 result 的错误文本做固定安全投影，但需保留已确认的稳定业务校验错误和受信任结构化 code；不能简单递归抹掉所有 data 字段，因为 billing.add_record 的单条部分失败目前以 ok:true + details[] 表达。
- 同一卡覆盖已确认 handler 内的嵌套失败与异常 catch，包括 add_record details、monthly_settle、client.update、supervision.start/ask、masters.open/message，以及督导保存 catch 的 console.warn。文件 IPC 返回文本应单独评估主进程契约，避免破坏用户权限拒绝/路径校验等可操作提示。
- 仅在新实现卡授权后修改生产源和测试；当前审计卡不授权代码改动。

P0-P3：P0=0，P1=1（多条可达路径向调用方/日志泄露底层错误文本）；P2=0；P3=0。

内部对抗审查：
- 行为证据来自真实生产脚本、真实 TOOL_REGISTRY、真实 window.AgentTools.invoke() 和 await 后的结果；未替换 AgentTools 为 facade。
- synthetic secret 同时检查 public result 和捕获的 VM console；supervision.ask 保存抛错确实走真实 catch 并产生原文日志。
- Error rejection、unknown-object rejection、handler 返回 {error: string}、持久层返回 {ok:false,error:{message}} 分开探测，未将单一异常形态泛化为所有分支。
- 跳过 await、使用 mock AgentTools、只做源码字符串搜索均不能证明本报告中的可达结论，应判为无效证据。
- 写集核对仅含新增任务卡和本报告；受保护生产哈希未漂移。由于实现代理通道不可读，本地负责人承担此次审计执行；未因此扩大代码修改授权。
- 未做独立外部复核；本报告是本地行为审计，不是最终修复验收或 release-ready 证据。

残余风险：上述多条 confirmed 路径含临床/存储/提供商异常文本；其中督导追问还会记录异常原文至控制台。file.read/write 透传 IPC reason 的可用性和隐私边界需与主进程真实契约共同判断。035 未实施修复。

未授权动作：未访问真实临床数据、文件系统 API、网络或远端状态；未修改测试或生产源；未执行 commit、merge、push、package、sign、upload、publish。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-TOOLS-ERROR-PRIVACY-AUDIT-035.md
