# XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028

[STATUS]
已完成 known-error logging privacy 修复，未改变 public result/onError、错误码、terminal gate、close-after-await 或 stream callback 行为。

[ARTIFACTS]
- `app/js/agent-api.js`：known-error 日志改为仅输出安全映射文本，不再输出 provider 原始 message。
- `tests/v5.2.0/agent-session-stream-callback.contract.test.cjs`：真实 VM console 捕获回归，校验 provider secret 不出现在 result/onError/日志。

[VALIDATION]
- `node --test tests/v5.2.0/agent-session-stream-callback.contract.test.cjs`：退出码 0，11/11 通过。
- `node --test tests/v5.2.0/*.contract.test.cjs`：退出码 0，85/85 通过。
- `node --check app/js/agent-api.js`：退出码 0。
- `node --check tests/v5.2.0/agent-session-stream-callback.contract.test.cjs`：退出码 0。
- `node tests/v5.2.0/015-local-electron-acceptance.cjs`：退出码 0，SUPERVISION_STATUS=PASS。
- `git diff --check -- ...`：退出码 0。
- 保护文件 SHA-256 与任务卡一致：agent-core、agent-tools、xinjing-chat、index、chat-home、clinical-agent-runtime、package.json、package-lock.json 均未漂移。

P0-P3：P0=0，P1=0，P2=0，P3=0。

内部对抗审查：
- 真实 VM 生产 `app/js/agent-api.js` 加载并捕获 `console.error`，不是 facade 或源码字符串断言。
- provider-shaped `{code: MODEL_TIMEOUT, message: provider-secret-clinical-text}` 通过 result/onError/log 隐私断言。
- errObj-shaped 本地 timeout、两条 timeout race（`writeExecuted===0`）、pre-terminal positive confirmation、late callback suppression 均通过。
- 反向变异思路：恢复 raw provider message 到 known-error log 时，新增 captured-log assertion 将失败；删除 await、替换 VM facade、删除 terminal gate 或改变 timeout mapping 将使既有 focused contract 失败。
- 未执行网络、真实临床数据、commit、merge、push、sign、package、upload、publish。

残余风险：未知错误对象分支仍保留既有通用日志行为；本任务仅授权 known-error privacy 修复，未扩大范围。

DELIVERY_REPORT: D:/xinjing-electron/docs/delivery-reports/XJ-5.2.0-AGENT-SESSION-ERROR-LOG-PRIVACY-028.md
