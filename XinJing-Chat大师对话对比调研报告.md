# Winnicott-Chat vs XinJing — 大师对话/圆桌对话 对比调研报告

**调研日期**：2026-07-13
**调研人**：OpenCode（deepseek-v4-pro）

---

## 一、大师配置对比

### Winnicott-Chat（roundtable.html）

```javascript
var MASTERS = {
  winnicott: { name:'温尼科特', initial:'W', icon:'🧸',
    sub:'儿科医生 · 足够好的母亲 · 过渡性客体',
    kb:'winnicott-perspective.md',     // ← 知识库文件（fetch 异步加载）
    accent:'#8b6f5c', light:'#f3ede6', // ← 主题色 + 浅色背景
    font:'"Georgia","Noto Serif SC",serif', // ← 每位大师独立字体
    permanent:true,                    // ← 温尼科特永远在场
    hint:'一生都在琢磨「在场」这件事',
    intro:'我是温尼科特。一个看了四十年孩子的儿科医生……'  // ← 欢迎语
  },
  freud: { accent:'#5b3a8c', light:'#EEEDFE', font:'"Georgia",...', intro:'我是弗洛伊德……' },
  klein: { accent:'#3a8c5b', light:'#EAF3DE', font:'"Palatino Linotype",...', intro:'我是梅兰妮·克莱因……' },
  jung:  { accent:'#8c6b3a', light:'#FAEEDA', font:'"Garamond",...', intro:'我是荣格……' },
  rogers:{ accent:'#B8734A', light:'#F0E8E0', font:'"Verdana",...', intro:'我是卡尔·罗杰斯……' },
  beck:  { accent:'#4A6B8C', light:'#E0E8F0', font:'"Arial",...', intro:'我是艾伦·贝克……' },
  yalom: { accent:'#8C4A6B', light:'#F0E8F0', font:'"Georgia",...', intro:'我是欧文·亚隆……' },
  adler: { accent:'#C49A3C', light:'#F8F0D8', font:'"Trebuchet MS",...', intro:'我是阿德勒……' },
  susan_johnson:{ accent:'#D4537E', light:'#FBEAF0', font:'"Segoe UI",...', intro:'我是苏珊·约翰逊……' }
};
```

**Chat 项目独有特征：**
- 每位大师有**独立字体**（Georgia / Palatino / Garamond / Verdana / Arial / Trebuchet MS / Segoe UI）
- 每位大师有**主题色 + 浅色背景**（消息气泡用大师专属背景色）
- 每位大师有**欢迎语 intro**（首次加入圆桌时自动发送，仅显示不入对话历史）
- 每位大师有**知识库文件** `.md`（fetch 异步加载，注入到 system prompt）
- 每位大师有**icon emoji**（🧸🧔👩🔮🌱🧪📖🧭💞）
- 每位大师有**hint 提示语**（简短性格描述）

### XinJing（masters-data.js）

```javascript
const MASTERS = [
  { key:'winnicott', name:'温尼科特', en:'D. W. Winnicott',
    school:'独立学派 · 客体关系',
    accent:'accent', initial:'温',
    systemPrompt:'你是唐纳德·温尼科特……'  // ← 内联 system prompt（无知识库文件）
  },
  { key:'freud', accent:'blue', initial:'弗', systemPrompt:'你是西格蒙德·弗洛伊德……' },
  // ... 共 11 位
];
```

**XinJing 项目特征：**
- 无独立字体（全统一 `var(--sans)`）
- 无欢迎语 intro
- 无知识库文件（system prompt 全部内联在 systemPrompt 字段）
- 无独立浅色背景（消息气泡统一灰色）
- accent 使用 CSS 变量名（`accent`/`blue`/`green`/`purple`/`orange`/`indigo`/`red`）而非具体 hex
- 无 icon emoji
- 有 `school` 字段（Chat 项目用 `sub` 字段）

### 差异汇总

| 特征 | Chat 项目 | XinJing 项目 | 差距 |
|------|----------|-------------|------|
| 大师数量 | 9 位（无拉康、比昂） | 11 位（含拉康、比昂） | XinJing 多 2 位 |
| 独立字体 | ✅ 每位不同 | ❌ 统一 | **缺失** |
| 主题色+浅背景 | ✅ hex 值对 | ❌ 仅 CSS 变量名 | **缺失** |
| 欢迎语 intro | ✅ 首次加入显示 | ❌ 无 | **缺失** |
| 知识库 .md 文件 | ✅ fetch 加载注入 | ❌ 内联 systemPrompt | **架构不同** |
| icon emoji | ✅ | ❌ | **缺失** |
| hint 提示语 | ✅ | ❌ | **缺失** |
| 预设组合 | ✅ 5 组 | ❌ | **缺失** |
| 场景关键词推荐 | ✅ | ❌ | **缺失** |
| 字体缩放 | ✅ A+/A- | ❌ | **缺失** |
| 打赏弹窗 | ✅ | ❌（桌面版不需要） | 合理差异 |

---

## 二、API 调用方式对比

### Chat 项目

```javascript
// 直连 fetch API
var cfg = getActiveConfig();
var apiRes = await fetch(cfg.api, {
  method: 'POST',
  headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+cfg.key },
  body: JSON.stringify({
    model: cfg.model,
    messages: msgs,
    temperature: isReactMode ? 0.6 : 0.7,
    max_tokens: isReactMode === 'summary' ? 600 : (isReactMode ? 400 : 512),
    stream: false
  })
});
```

- **优先 SCF 云函数代理**：`https://xinjingchat.online`（同一个域名！）
- **回退 TIERS**：DeepSeek V4 Flash → DeepSeek Pro → MiniMax M3 → Agnes
- **用户自定义 API**：可填自己的 API 地址 + Key + 模型
- **temperature**：Round 1 = 0.7，Round 2 = 0.6
- **max_tokens**：Round 1 = 512，Round 2 react = 400，summary = 600

### XinJing 项目

```javascript
// 通过 AI.send() 间接调用
AI.send(messages, callback, options);
```

- **AI.send 内部**：`callDirect()` → `fetch(baseUrl + '/chat/completions')`
- **试用档**：走 `https://xinjingchat.online/v1`（**同一个代理服务器！**）
- **用户档**：用户填的 baseUrl + apiKey + model
- **temperature**：固定 0.3（`callDirect` 中硬编码）
- **max_tokens**：默认 4000（用户可配置）
- **消息归一化**：`normalizeMessageSequence()` 处理连续相同角色合并、tool_calls 配对

### 差异汇总

| 特征 | Chat 项目 | XinJing 项目 | 差距 |
|------|----------|-------------|------|
| 代理服务器 | `xinjingchat.online` | `xinjingchat.online/v1` | **同一服务器** |
| temperature | 0.6~0.7（区分轮次） | 固定 0.3 | **差异显著** |
| max_tokens | 512/400/600（区分轮次） | 4000 | **差异显著** |
| 消息归一化 | 无 | ✅ 有 | XinJing 更健壮 |
| 用户自定义 API | ✅ | ✅ | 一致 |

---

## 三、System Prompt 对比

### Chat 项目 — 圆桌 Round 1（独立回应）

```
[重要指令：①始终使用中文对话]
[你是{大师名}，你是参与圆桌讨论的其中一位。
在场的还有：{其他大师名}。

规则：
① 用「我」说话。就像你本人坐在房间里一样。
② 独立回应。你正在和所有人同时发言，所以你看不到其他人此刻说了什么。不要假设你知道别人会说什么。
③ 每条回应控制在150字以内，自然、口语化。
④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。
⑤ 不要替用户做决定。
⑥ 保持你的人格和语气——你的经历决定了你如何看待问题。
⑦ 你可以根据你的风格决定是否在回应中关注用户。]

{知识库 .md 内容}
```

### Chat 项目 — 圆桌 Round 2（串行回应）

```
[重要指令：①始终使用中文对话]
[你是{大师名}。刚才用户提问后，各位大师已经分别回应了。
在场的还有：{其他大师名}。
你刚才已经说过你的看法了。现在请看看其他大师说了什么。
如果你觉得有必要补充、回应或质疑，可以说一两句。
如果觉得没什么要补充的，输出空字符串。

规则：
① 用「我」说话。
② 可以直接对其他大师说话。
③ 控制在80字以内，简短自然。
④ 可使用*斜体*或**加粗**做适度强调。禁止使用#、※、-等符号做列表或标题。
⑤ 没什么要说的就输出一个空格。
⑥ 温尼科特作为最后总结者时，记得把话题带回用户身上。]

{知识库 .md 内容}
```

### Chat 项目 — 圆桌 Round 2（温尼科特总结）

```
[重要指令：①始终使用中文对话]
[你是温尼科特，你是这场圆桌讨论的总结者。
在场的还有：{其他大师名}。
刚才各位大师围绕用户的问题各自发表了看法，还进行了讨论。
现在请你作为最后发言的人，对整场讨论做总结性回应，然后把注意力带回用户身上。

规则：
① 用「我」说话。
② 可以提到其他大师的观点。
③ 控制在120字以内，做一个有温度的收尾。
④ 可使用*斜体*或**加粗**做适度强调。]

{知识库 .md 内容}
```

### XinJing 项目 — masters-data.js 内联 systemPrompt

```
你是唐纳德·温尼科特（D. W. Winnicott），英国儿科医师与精神分析师，独立学派代表人物。
请以其理论取向与语气回应：关注足够好的母亲、抱持性环境、过渡客体与过渡现象、
真假自体、客体使用与破坏性、游戏与创造力、促进性环境。
立场抱持、不入侵、允许沉默与不确定；优先从来访者的原话与主观体验出发，
少做诠释性断言，多用「也许」「仿佛」等抱持性语言。
当你引用概念时，标注其英文原词。
```

### XinJing 项目 — masters-core.js buildMessages

```
system = master.systemPrompt + summaryLine + STYLE_CONSTRAINTS
```

- 无圆桌规则（无"在场还有谁""独立回应""150字以内"等指令）
- 无知识库注入
- 有 `STYLE_CONSTRAINTS`（去 AI 文风约束）
- 有 `summaryLine`（长时记忆摘要）

---

## 四、圆桌对话逻辑对比

### Chat 项目

1. **Round 1 — 并行**：所有 responding masters 通过 `Promise.allSettled` 同时调用 API
2. **Round 2 — 串行**：
   - **@mention 模式**：其他大师回应被@的大师 → 被@大师做总结
   - **正常模式**：按 `SERIAL_ORDER`（freud→jung→klein→rogers→beck→yalom→adler→susan_johnson，**温尼科特永远最后**）逐一回应
   - 每位大师只看到**其他大师的发言**（看不到自己的）
   - 600ms 延迟（让气泡逐个出现）
   - 温尼科特最后做 summary（120字以内，把话题带回用户）

### XinJing 项目（masters.js）

1. **Round 1 — 并行**：`Promise.allSettled` 同时调用（与 Chat 一致）
2. **Round 2 — 串行**：
   - 非温尼科特先，温尼科特最后
   - 每位大师收到**其他大师的发言作为 context**
   - 最后一位做 summary（"综合各位观点，给出你的最终回应"）
   - **无 600ms 延迟**
   - **无"看不到自己发言"的过滤**
   - **无@mention 模式区分**
   - **无"没什么要说的输出空格"机制**

---

## 五、必须拉齐的项

| # | 差异项 | 严重程度 | 修复方案 |
|---|--------|---------|---------|
| 1 | **temperature** 0.3 vs 0.6-0.7 | **高** — 影响输出风格 | masters-core 调 AI.send 时传 `{temperature: 0.7}` |
| 2 | **max_tokens** 4000 vs 512/400/600 | **高** — 4000 导致过长 | masters-core 调 AI.send 时传 `{maxTokens: 512}` |
| 3 | **圆桌 system prompt** 缺规则 | **高** — 无"独立回应""150字""看不到别人"等 | 在 masters.js 圆桌模式构建 messages 时注入规则 |
| 4 | **串行过滤** 不过滤自己 | **中** — 大师会看到自己的话 | Round 2 过滤掉当前大师自己的发言 |
| 5 | **温尼科特 summary** 缺专属 prompt | **中** — 无"120字收尾" | 最后一位用 summary 专用 system prompt |
| 6 | **600ms 延迟** | **低** — 体验差异 | 加 `await sleep(600)` |
| 7 | **@mention 模式** | **中** — 无区分 | 实现 @mention 解析 + 区分流程 |
| 8 | **独立字体/颜色/欢迎语** | **中** — 视觉体验 | masters-data.js 增加 font/light/intro/icon/hint 字段 |
| 9 | **知识库 .md 注入** | **低** — 内联 prompt 可替代 | 可选：fetch 加载或保持内联 |
| 10 | **预设组合** | **低** — 体验增强 | 可选：加 5 组预设 |
| 11 | **场景关键词推荐** | **低** — 体验增强 | 可选：关键词匹配推荐大师 |
| 12 | **"没什么要说的输出空格"** | **中** — 避免无意义回复 | 检查返回内容，空格则跳过 |

---

## 六、结论

XinJing 的大师对话与 Chat 项目**没有拉齐**，核心差异在：

1. **API 参数**：temperature 和 max_tokens 差距大，直接导致输出风格不同（Chat 的回复更自然、更口语化、更短；XinJing 的回复更长、更正式）
2. **圆桌 system prompt**：Chat 有详细的圆桌规则（独立回应、字数限制、看不到别人、可对其他大师说话），XinJing 完全没有
3. **串行逻辑**：Chat 有"看不到自己发言"过滤、600ms 延迟、温尼科特 summary 专属 prompt、@mention 模式区分，XinJing 都缺
4. **视觉**：Chat 每位大师有独立字体、主题色、浅色背景、欢迎语、icon，XinJing 全部统一

**要"和 chat 项目一模一样"，需要修复上表中的高+中严重程度项（#1~#8, #12）。**
