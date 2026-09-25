# -*- coding: utf-8 -*-
"""Gen app/js/knowledge.builtins.js — 打包大师知识库 .md 文件。
构建期/dev 启动时运行，把 app/masters/knowledge/*.md 读取并 Base64 编码进 JS 常量，
供渲染进程运行时通过 window.Knowledge.byTemp(masterKey, talkTemp) 解码加载。

复用 gen-prompts-builtin.py 的 Base64 编码模式。

============================================================
DEC-03 载荷净化策略（产品负责人裁决 2026-09-24：「剖离，与其他条目同一口径」）
============================================================
一条一致的策略（取代此前两套标准）：

  【策略】内置知识进入 JS 产物的，只能是「可路由的临床知识正文」。
         凡是 (a) 角色扮演指令、(b) 身份/沉浸指令、(c) 第一人称生平自述，
         以及 (d) 整条不可路由且承载人设的条目，一律不得进入发往 provider 的 system 载荷。

  历史上该策略被拆成两处、口径不一致：
    - `consultant-a`（无 MASTERS key、正文含「你就是咨询师梅（A）」）被整条剔除（P2-2）；
    - 其余 11 位大师的 .md 却把 `## 角色扮演规则`、`此Skill激活后，直接以X的身份回应`、
      `而非跳出角色说`、`你不是在扮演X…被植入了X认知上下文的AI`、罗杰斯 `我父亲是…`
      原样 base64 内联并发给模型（复审 F3-P1-2）。
  两套标准不能同时成立。现在二者是**同一条判定**的两个分支：
    R5 不可路由 + 含人设 → 整条不进产物（= 原 consultant-a 处置，行为不变，但判据改为
       结构化的「是否 MASTERS 可寻址」而非「正文包含某字符串」——见下方 _routable()）；
    R1–R4 可路由的条目 → 按成文规则把 (a)(b)(c) 三类段落**结构化剥离**，其余正文一字不动。

  【为什么在生成器写盘边界做，而不是在运行时打补丁】
    1. `app/masters/knowledge/*.md` 是**只读源语料**（内容语义归产品/内容侧裁决，本卡不改），
       知识块有 3 个真实调用点（1v1 / 圆桌 / 督导）共用 `Knowledge.byTemp`，
       在任何一个调用点各自过滤 = 三份语义 = 必然漂移（复审 F3-P3-1 就是同一族教训）。
    2. 写盘边界是唯一写盘点：产物 `app/js/knowledge.builtins.js` 可重跑复算，
       净化结果 = 一个 md5，能证伪（连跑 3 次一致 + `_assert_no_persona_residue()` 硬闸门）。
    3. 已有的 `strip_frontmatter`（P3-2：AIGC/ContentProducer 生成元数据）就住在这条边界上；
       同一边界、同一策略，不新增第二道口子。

  【成文规则（可复算，按标题/结构切；不做「含某串就整份丢弃」）】
    R1 角色扮演容器段：level>=2 的标题命中 ROLEPLAY_HEADINGS → 删该标题本身 + 该标题下的
       直属正文 + 非保护子段；**PROTECTED_HEADINGS（回答工作流/心智模型/决策启发式/诚实边界/
       价值观/表达DNA/时间线/智识谱系/调研来源…）命中则整棵子树原样保留并上提**（防误删方法论）。
       level 1 是文档题目，永不匹配（例：`# Sue Johnson 人格 Skill` 只删不掉，也不该删）。
    R2 第一人称生平容器段：level>=2 标题命中 BIO_HEADINGS（`我是谁`、`基础人设`）→ 整棵子树删。
    R3 身份/沉浸指令块：段落·引用块首句或列表条目命中 IDENTITY_DIRECTIVE_PATTERNS → 删该块/该条目。
    R4 第一人称身份声明与生平句：
       R4a 行首标签命中 BIO_LABELS（`**我是谁**：`/`**我的起点**：`/`**我现在在做什么**：`）→ 删该条；
       R4b 保留块内**逐句**删去命中 FIRST_PERSON_BIO_PATTERNS 的句子（生平事实句），
           同段其余临床论述原样保留（例：罗杰斯「无条件积极关注」条目只删生平句、留临床命题）。
    R5 不可寻址条目整体不进产物（见上）。
    闸门 净化后再跑一次 `_assert_no_persona_residue()`：仍有 RESIDUE_ASSERT 命中即 exit(1)，
         宁可构建失败，也不让带人设的载荷出厂。

  【已知不剥离项（刻意保留，口径要写清）】
    - 霍妮 `## 二、角色规则`：**不匹配** R1（它不是「角色扮演规则」，而是「不模仿霍妮本人正在
      说话，而使用『霍妮视角会先检查…』的透明表达」等 10 条证据纪律）。按 R1 的判据（标题语义 =
      角色扮演/身份/第一人称）保留才是同口径；把它一起删属于「过宽」，被变异体 M-OVERBROAD 钉死。
    - 第三人称生平表（`## 人物时间线（关键节点）`、霍妮 `### 生平与思想节点`）：史实，非人设指令，保留。
    - 非临床元数据（`调研时间:`、`蒸馏方法:`、`## 附录：调研来源`、悬空 `references/research/`、
      裸词 `Skill`）：属 F3-P2-3，不在 DEC-03 范围内，本卡不改（已在报告 §6 如实登记为仍存）。
"""
import base64, os, json, re, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KB_DIR = os.path.join(BASE, 'app', 'masters', 'knowledge')
OUT = os.path.join(BASE, 'app', 'js', 'knowledge.builtins.js')
MASTERS_JS = os.path.join(BASE, 'app', 'js', 'masters-data.js')

# --- 变异/取证用的环境变量开关（只允许写非生产路径，见 _guard_out()） -----------
NO_SANITIZE = os.environ.get('XJ_KB_NO_SANITIZE') == '1'   # 关掉 R1-R4（反向变异）
OVERBROAD = os.environ.get('XJ_KB_OVERBROAD') == '1'       # 把净化规则改宽（反向变异）
OUT_OVERRIDE = os.environ.get('XJ_KB_OUT')                 # 产物改写到别处（取证/变异用）

if not os.path.isdir(KB_DIR):
    print(f'ERROR: KB_DIR not found: {KB_DIR}', file=sys.stderr)
    sys.exit(1)


def _guard_out():
    """净化被关掉/放宽时禁止覆盖生产产物 —— 逃生阀不能被用来出厂脏载荷。
    （反向变异需要「关掉规则再跑一遍生成」的能力，但绝不能因此污染 app/js/。）"""
    global OUT
    if OUT_OVERRIDE:
        cand = os.path.abspath(OUT_OVERRIDE)
        if (NO_SANITIZE or OVERBROAD) and os.path.normcase(cand) == os.path.normcase(OUT):
            print('ERROR: 关闭/放宽净化时 XJ_KB_OUT 不得指向生产产物路径', file=sys.stderr)
            sys.exit(2)
        OUT = cand
        return
    if NO_SANITIZE or OVERBROAD:
        print('ERROR: 关闭/放宽净化必须配 XJ_KB_OUT=<非生产路径>，拒绝写 ' + OUT, file=sys.stderr)
        sys.exit(2)


_guard_out()


# ============================================================
# MASTERS 可寻址 key 集合：从产品文件**派生**，不手写（F3-P1-1 同源教训）
# ============================================================
KEY_LINE_RE = re.compile(r"^\s*key:\s*'([A-Za-z0-9_\-]+)'", re.M)
# 产物内的 bundle 键名与 MASTERS key 的既有映射（susan_johnson <-> sue-johnson）
KEY_ALIASES = {'susan_johnson': 'sue-johnson'}


def load_routable_keys():
    """从 app/js/masters-data.js 抓 `key:` 行 -> bundle 可用键集合。
    派生而非手写：新大师进 MASTERS 即自动可打包，不需要改本脚本（否则又是一处手写漂移）。"""
    with open(MASTERS_JS, 'r', encoding='utf-8') as f:
        src = f.read()
    keys = []
    for k in KEY_LINE_RE.findall(src):
        if k not in keys:
            keys.append(k)
    if not keys:
        print('ERROR: masters-data.js 未解析出任何 key —— 拒绝生成空产物', file=sys.stderr)
        sys.exit(1)
    routable = set()
    for k in keys:
        routable.add(k)
        routable.add(k.replace('_', '-'))
    for v in KEY_ALIASES.values():
        routable.add(v)
    return keys, routable


MASTERS_KEYS, ROUTABLE = load_routable_keys()
# 文件名 -> (key, slot)：按已知 bundle 键前缀切，长键优先（'sue-johnson' 先于 's'）。
CANDIDATE_KEYS = sorted(set(list(MASTERS_KEYS) + [v for v in KEY_ALIASES.values()]
                            + [k.replace('_', '-') for k in MASTERS_KEYS]), key=len, reverse=True)

# ============================================================
# DEC-03 净化规则表（成文、可复算）
# ============================================================
HEADING_RE = re.compile(r'^(#{1,6})\s+(.*)$')
FENCE_RE = re.compile(r'^\s*(?:```|~~~)')
ITEM_RE = re.compile(r'^(\s*)(?:[-*+]|\d+[.)])\s+')

# R1 角色扮演容器标题（标题语义命中即整段是「扮演规则」）
ROLEPLAY_HEADINGS = [r'角色扮演规则', r'角色扮演', r'扮演规则', r'角色扮', r'身份规则',
                     r'第一人称规则', r'Role[-\s]?Play', r'人设规则']
# R1 保护名单：这些子段即使在角色扮演容器内也属临床方法论正文，整棵子树上提保留
PROTECTED_HEADINGS = [r'回答工作流', r'Agentic', r'心智模型', r'核心概念', r'概念清单',
                      r'决策启发式', r'启发式', r'表达\s*DNA', r'价值观', r'反模式', r'诚实边界',
                      r'人物时间线', r'时间线', r'智识谱系', r'调研来源', r'素材来源', r'附录',
                      r'思维架构', r'使用指南', r'核心信念', r'因果推理', r'基本假设',
                      r'模型\s*\d', r'Step\s*\d', r'参考知识库', r'概念百科', r'对话模式',
                      r'情感对话', r'督导', r'方法论', r'整书骨架', r'方法单元', r'三重验证']
# R2 第一人称生平容器标题
BIO_HEADINGS = [r'^我是谁', r'^我是谁$', r'基础人设', r'^人设$']
# R3 身份/沉浸指令（块级/条目级）
IDENTITY_DIRECTIVE_PATTERNS = [
    r'你不是在扮演', r'我不是在扮演', r'你现在不是',
    r'被植入了?[^。\n]{0,24}认知上下文',
    r'用「我」说话', r'像一个真正有这些经历的人',
    r'此\s*Skill\s*激活后', r'激活后[，,]?\s*直接以',
    r'直接以[^，。\n]{0,12}的身份回应',
    r'而非跳出角色', r'不要跳出角色', r'跳出角色说',
    r'你必须遵守以下身份规则', r'你必须以[^，。\n]{0,12}的身份',
    r'你在扮演', r'你将扮演', r'进入角色模式',
]
# R4a 第一人称身份声明标签（身份卡里的 "我是谁/我的起点/我现在在做什么" 三行）
BIO_LABELS = [r'^\**我是谁\**[：:]', r'^\**我的起点\**[：:]', r'^\**我现在在做什么\**[：:]']
# R4b 生平事实句（只删句子，不连带同段的临床论述）
#   全部**锚定在句首**（允许一个转折/承接前缀；引用行/列表符号等外壳先剥掉再判）：
#   这样「当有人跟我讲——"我妻子不理解我"——我的第一反应…」(亚隆 此时此刻 技术)、
#   「我不问「你童年发生了什么…」」(比昂 技术)、「我不花太多时间去挖童年」(罗杰斯 技术)
#   这类**引语内 / 反引用的生平词**不会被误伤。放宽到「句中任意位置」就会吞掉方法论正文——
#   实测过一版宽规则，误伤 8 处，记录在 logs/f3-payload/ledger-audit-BEFORE.txt；
#   收窄后的规则由变异体 M-OVERBROAD 反向钉死（过宽 => 方法论保真断言转红）。
_BIO_LEAD = r'(?:但|而|然后|后来|其实|只是|也|就|并且)?'
FIRST_PERSON_BIO_PATTERNS = [
    _BIO_LEAD + r'我(父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|妻子|丈夫|女儿|儿子)是',
    _BIO_LEAD + r'我在(19|20)\d\d',
    _BIO_LEAD + r'我(看过|见过|记得)[^\n。]{0,10}(孩子|婴儿)',
    _BIO_LEAD + r'我活了[^\n。]{0,8}(岁|二十|三十|四十|五十|六十|七十|八十)',
    _BIO_LEAD + r'我已经在\d{4}\s*年(死去|去世)',
    _BIO_LEAD + r'我(从小|童年|幼年|小时候)[^\n。]{0,12}(时候|里|中|时)',
]
# 净化后的硬闸门断言（复审 F3-8a2 的人设标记族）
RESIDUE_ASSERT = [
    ('roleplay-rules-heading', r'##\s*角色扮演规则|角色扮演规则（|Role-Play Guidelines'),
    ('adopt-identity-imperative', r'直接以[^，。\n]{0,12}的身份回应|此\s*Skill\s*激活后'),
    ('not-pretending-identity', r'[你我]不是在扮演'),
    ('implanted-context-AI', r'被植入了?[^。\n]{0,24}认知上下文'),
    ('first-person-bio', r'我父亲是|我小时候|我在(19|20)\d\d|我看过很多这样的婴儿|我记得一个孩子'),
    ('forbidden-to-step-out', r'而非跳出角色说'),
    ('must-obey-identity-rules', r'你必须遵守以下身份规则'),
]
_RESIDUE_COMPILED = [(n, re.compile(p)) for n, p in RESIDUE_ASSERT]

if OVERBROAD:
    # 反向变异：把判据放宽到「凡标题带『角色/工作流/模型』就整段吞掉」且取消保护名单
    ROLEPLAY_HEADINGS = [r'角色', r'工作流', r'模型', r'回答']
    PROTECTED_HEADINGS = []

_ROLEPLAY_RE = [re.compile(p) for p in ROLEPLAY_HEADINGS]
_PROTECTED_RE = [re.compile(p) for p in PROTECTED_HEADINGS]
_BIO_RE = [re.compile(p) for p in BIO_HEADINGS]
_DIRECTIVE_RE = [re.compile(p) for p in IDENTITY_DIRECTIVE_PATTERNS]
_BIOLABEL_RE = [re.compile(p) for p in BIO_LABELS]
_BIOSENT_RE = [re.compile(p) for p in FIRST_PERSON_BIO_PATTERNS]

_SENT_SPLIT_RE = re.compile(r'(?<=[。！？])')
_SHELL_RE = re.compile(r'^[\s>*\-+\u3000#0-9.、）)]+')


def _head(sentence):
    """句首外壳（列表符号 / 引用符 / 编号 / 缩进）剥掉后再做锚定判定。"""
    return _SHELL_RE.sub('', sentence).lstrip('*「《“')


class Log(object):
    def __init__(self, key, slot):
        self.key = key
        self.slot = slot
        self.dropped_headings = []   # (rule, heading)
        self.dropped_blocks = []     # (rule, text)
        self.dropped_sentences = []  # text


def _match_any(pats, text):
    return any(p.search(text) for p in pats)


# ---------------------------- block model ------------------------------------
def _mk_block(lines):
    first = lines[0].lstrip()
    if FENCE_RE.match(first):
        return {'kind': 'fence', 'lines': lines}   # 代码栅栏整块原样保留（模板/流程伪代码）
    if first.startswith('>') or all(l.strip() == '' or l.lstrip().startswith('>') for l in lines):
        kind = 'quote'
    elif first.startswith('|'):
        kind = 'table'
    elif ITEM_RE.match(first):
        kind = 'list'
    else:
        kind = 'para'
    if kind == 'list':
        items, cur, base_indent = [], None, len(ITEM_RE.match(first).group(1))
        for ln in lines:
            m = ITEM_RE.match(ln)
            if m and len(m.group(1)) <= base_indent and cur is not None:
                items.append(cur)
                cur = [ln]
            elif m and len(m.group(1)) <= base_indent and cur is None:
                cur = [ln]
            elif cur is None:
                cur = [ln]
            else:
                cur.append(ln)
        if cur:
            items.append(cur)
        return {'kind': 'list', 'items': items}
    return {'kind': kind, 'lines': lines}


class Node(object):
    __slots__ = ('level', 'title', 'items')

    def __init__(self, level, title):
        self.level = level
        self.title = title
        self.items = []


def parse_tree(text):
    root = Node(0, None)
    stack = [root]
    lines = text.split('\n')
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if FENCE_RE.match(line):
            buf = [line]
            i += 1
            while i < n:
                buf.append(lines[i])
                if FENCE_RE.match(lines[i]):
                    i += 1
                    break
                i += 1
            stack[-1].items.append(('b', _mk_block(buf)))
            continue
        h = HEADING_RE.match(line)
        if h:
            level = len(h.group(1))
            node = Node(level, h.group(2).strip())
            while stack and stack[-1].level >= level:
                stack.pop()
            stack[-1].items.append(('h', node))
            stack.append(node)
            i += 1
            continue
        if not line.strip():
            i += 1
            continue
        buf = [line]
        i += 1
        while i < n and lines[i].strip() and not HEADING_RE.match(lines[i]) and not FENCE_RE.match(lines[i]):
            buf.append(lines[i])
            i += 1
        stack[-1].items.append(('b', _mk_block(buf)))
    return root


# ---------------------------- sentence / line rules ---------------------------
def _strip_sentences(line, log):
    """R4b：只删命中生平事实的子句（锚定句首），保留同段其余论述。"""
    parts = _SENT_SPLIT_RE.split(line)
    keep = []
    for s in parts:
        if s.strip() and _match_any(_BIOSENT_RE, _head(s)):
            log.dropped_sentences.append(s.strip()[:120])
            continue
        keep.append(s)
    return ''.join(keep)


def _handle_line(line, log):
    """返回要保留的行列表（可能为空）。段落/引用行与列表条目正文共用。"""
    st = line.strip()
    if not st:
        return [line]
    if _match_any(_DIRECTIVE_RE, st) or _match_any(_BIOLABEL_RE, st):
        log.dropped_blocks.append(st[:120])
        return []
    if not _match_any(_BIOSENT_RE, _head(st)):
        return [line]
    out = _strip_sentences(st, log)
    if not out.strip():
        return []
    return [out]


def _block_lines(blk):
    """block -> 所有文本行（list 块展平 items）。"""
    if blk['kind'] == 'list':
        out = []
        for it in blk['items']:
            out.extend(it)
        return out
    return blk['lines']


def sanitize_block(blk, log):
    kind = blk['kind']
    if kind == 'fence':
        return blk['lines']
    if kind == 'table':
        return blk['lines']          # 表格是史实/文献结构（第三人物），非身份指令
    kept = []
    if kind == 'list':
        for item in blk['items']:
            if item and (_match_any(_DIRECTIVE_RE, item[0].strip())
                         or _match_any(_BIOLABEL_RE, item[0].strip())):
                log.dropped_blocks.append(item[0].strip()[:120])
                continue
            sub = []
            for ln in item:
                sub.extend(_handle_line(ln, log))
            if any(s.strip() for s in sub):
                kept.extend(sub)
        return kept
    lines = blk['lines']
    if lines and _match_any(_DIRECTIVE_RE, lines[0].strip()):
        log.dropped_blocks.append(' '.join(l.strip() for l in lines)[:120])
        return []
    for ln in lines:
        kept.extend(_handle_line(ln, log))
    return kept


def render(node, log):
    """-> list[chunk]，chunk = list[line]；chunk 之间以一个空行相接（保留 markdown 块结构）。"""
    chunks = []
    for kind, item in node.items:
        if kind == 'h':
            child = item
            if child.level >= 2 and _match_any(_BIO_RE, child.title):
                log.dropped_headings.append(('R2', child.title))
                continue
            if child.level >= 2 and _match_any(_ROLEPLAY_RE, child.title):
                log.dropped_headings.append(('R1', child.title))
                chunks.extend(render_roleplay_container(child, log))
                continue
            chunks.append(['#' * child.level + ' ' + child.title])
            chunks.extend(render(child, log))
            continue
        kept = sanitize_block(item, log)
        if any(k.strip() for k in kept):
            chunks.append(kept)
    return chunks


def render_roleplay_container(node, log):
    """R1：容器标题与其直属正文删掉；命中的子标题按保护名单决定「整棵子树上提」或删。"""
    chunks = []
    for kind, item in node.items:
        if kind == 'h':
            child = item
            if _match_any(_PROTECTED_RE, child.title):
                chunks.append(['#' * child.level + ' ' + child.title])
                chunks.extend(render(child, log))
                continue
            if child.level >= 2 and _match_any(_BIO_RE, child.title):
                log.dropped_headings.append(('R2', child.title))
                continue
            if child.level >= 2 and _match_any(_ROLEPLAY_RE, child.title):
                log.dropped_headings.append(('R1', child.title))
                chunks.extend(render_roleplay_container(child, log))
                continue
            log.dropped_headings.append(('R1.child', child.title))
            continue
        log.dropped_blocks.append('容器正文: ' + ' '.join(_block_lines(item))[:80])
    return chunks


def sanitize(text):
    log = Log('', '')
    if NO_SANITIZE:
        return text, log
    tree = parse_tree(text)
    chunks = render(tree, log)
    body = '\n\n'.join('\n'.join(c) for c in chunks).strip('\n')
    return (body + '\n') if body else '', log


# ---------------------------- 源文件读取（既有边界） --------------------------
def strip_frontmatter(text):
    """剥离 .md 顶部的 YAML frontmatter（---\\n ... \\n---）。
    知识正文里的 AIGC / ContentProducer / ProduceID 等生成元数据都住在这个块里，
    必须在「生成器写盘边界」剥掉，避免随知识原进入发往 provider 的 system 载荷（P3-2）。"""
    if text.startswith('\ufeff'):
        text = text[1:]
    lines = text.split('\n')
    if not lines or lines[0].strip() != '---':
        return text
    for i in range(1, len(lines)):
        s = lines[i].strip()
        if s == '---' or s == '...':
            return '\n'.join(lines[i + 1:]).lstrip('\n')
    return text  # 没有闭合分隔符则按纯正文处理


def _routable(key):
    """R5 的结构化判据：条目能否被 MASTERS 寻址（派生自 masters-data.js，不手写名单）。
    不可寻址 且 正文仍带人设/身份指令 -> 整条不进产物（consultant-a：`## 基础人设` +
    「你就是咨询师梅（A）」）。可寻址的条目永不整条丢弃，只做 R1-R4 结构化剥离。"""
    return key in ROUTABLE


KB = {}
AUDIT = []   # 每 (key, slot) 的净化台账：字符差 + 被删标题清单
skipped = []

for fn in sorted(os.listdir(KB_DIR)):
    if not fn.endswith('.md'):
        continue
    path = os.path.join(KB_DIR, fn)
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    # e.g. winnicott-knowledge.md -> key=winnicott, slot=knowledge
    # e.g. winnicott-skill-only.md -> key=winnicott, slot=skill-only
    base = fn[:-3]  # strip .md
    raw = strip_frontmatter(text)
    key = None
    slot = None
    for k in CANDIDATE_KEYS:
        if base.startswith(k + '-'):
            key = k
            slot = base[len(k) + 1:]
            break
    if not key:
        # R5（与 consultant-a 同一条策略的第一个分支）：文件名解析不出任何 MASTERS 可寻址 key
        # => 该条目在运行时没有任何入口能取到它；DEC-03 要求「同一口径」，所以这里也照同一判据
        #    记录其人设残留，而不是留给一段独立的 `if key == 'consultant-a'` 特例。
        residue = [n for n, p in _RESIDUE_COMPILED if p.search(raw)]
        # 同一条策略的第二个判据也照跑一遍（标题级：基础人设/我是谁 + 指令级）——
        # consultant-a 的人设住在 `## 基础人设` + 「你就是咨询师梅（A）」里，RESIDUE_ASSERT 的
        # 5 条标记抓不到它，所以这里把「为什么它也属于人设」一并打进构建日志，供审计复核。
        struct = [h for h in re.findall(r'(?m)^#{2,6}\s+(.+)$', raw)
                  if _match_any(_BIO_RE, h) or _match_any(_ROLEPLAY_RE, h)]
        why = 'R5 不可路由（文件名无 MASTERS key）'
        if residue or struct:
            why += '；且含人设文本（标记 %s / 人设类标题 %s）' % (
                ','.join(residue) or '-', ' | '.join(struct[:6]) or '-')
        skipped.append((fn, why))
        print(f'SKIP {fn} (R5: "{base}" 不匹配任何 MASTERS 可寻址 key -> 无产品入口'
              + (f'；并含人设文本 标记={residue} 标题={struct}' if (residue or struct) else '')
              + '，按 P2-2/DEC-03 不进产物)')
        continue
    # R5：不可路由 + 含人设/身份文本 -> 整条不进产物（P2-2 的处置，现并入 DEC-03 同一条策略）
    if not _routable(key):
        residue = [n for n, p in _RESIDUE_COMPILED if p.search(raw)]
        if residue:
            skipped.append((fn, 'R5 不可路由 + 人设残留 ' + ','.join(residue)))
            print(f'SKIP {fn} (R5: key={key} 不在 MASTERS 可寻址集合 + 含人设文本 {residue}，按 P2-2/DEC-03 整条剔除)')
            continue
        skipped.append((fn, 'R5 不可路由（无残留）'))
        print(f'SKIP {fn} (R5: key={key} 不在 MASTERS 可寻址集合，不进产物)')
        continue
    clean, log = sanitize(raw)
    AUDIT.append({
        'file': fn, 'key': key, 'slot': slot,
        'before_chars': len(raw), 'after_chars': len(clean),
        'delta_chars': len(raw) - len(clean),
        'dropped_headings': [[r, h] for r, h in log.dropped_headings],
        'dropped_blocks': list(log.dropped_blocks),
        'dropped_sentences': list(log.dropped_sentences),
        'dropped_block_count': len(log.dropped_blocks),
        'dropped_sentence_count': len(log.dropped_sentences),
        'before_residues': sorted({n for n, p in _RESIDUE_COMPILED if p.search(raw)}),
        'after_residues': sorted({n for n, p in _RESIDUE_COMPILED if p.search(clean)}),
    })
    if key not in KB:
        KB[key] = {}
    KB[key][slot] = clean


def _assert_no_persona_residue():
    """闸门：净化后仍有人设标记 = 构建失败（宁可不出货，也不发脏载荷）。"""
    bad = []
    for key in sorted(KB):
        for slot in sorted(KB[key]):
            body = KB[key][slot]
            for name, p in _RESIDUE_COMPILED:
                m = p.search(body)
                if m:
                    bad.append((key, slot, name, m.group(0)[:80]))
    if bad:
        print('ERROR: DEC-03 人设残留未清（拒绝出厂）：', file=sys.stderr)
        for b in bad:
            print('  ' + ' | '.join(b[:3]) + ' :: ' + b[3], file=sys.stderr)
        sys.exit(1)


if not NO_SANITIZE:
    _assert_no_persona_residue()

# 每位大师至少留一份「可路由且非占位」的知识正文（净化不得把某个槽掏空）
for mkey in MASTERS_KEYS:
    bundle = KEY_ALIASES.get(mkey, mkey)
    slots = KB.get(bundle)
    if slots is None:
        print('ERROR: MASTERS key %s 在产物里没有任何槽位（净化后不可路由）' % mkey, file=sys.stderr)
        sys.exit(1)
    if not any(len(v.strip()) >= 200 for v in slots.values()):
        print('ERROR: %s 净化后无非占位正文槽（全部 <200 字符）' % mkey, file=sys.stderr)
        sys.exit(1)


def b64(s):
    return base64.b64encode(s.encode('utf-8')).decode('ascii')


lines = []
lines.append('/** @internal 大师知识库（构建期打包）— 自动生成，勿手改 */')
lines.append('/* Generated by scripts/gen-knowledge-builtins.py */')
lines.append('/* DEC-03 载荷净化：角色扮演指令 / 身份沉浸指令 / 第一人称生平已在写盘边界结构化剥离 */')
lines.append("const Knowledge = (() => {")
lines.append("  'use strict';")
lines.append("  function d(b64) {")
lines.append("    try {")
lines.append("      const bin = atob(b64);")
lines.append("      const bytes = new Uint8Array(bin.length);")
lines.append("      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);")
lines.append('      return new TextDecoder("utf-8").decode(bytes);')
lines.append("    } catch (e) { return ''; }")
lines.append("  }")
lines.append("")
lines.append("  const RAW = {")
for key in sorted(KB.keys()):
    slots = KB[key]
    lines.append(f'    {json.dumps(key)}: {{')
    for slot in sorted(slots.keys()):
        lines.append(f'      {json.dumps(slot)}: "{b64(slots[slot])}",')
    lines.append('    },')
lines.append("  };")
lines.append("")
lines.append("  const KEY_ALIASES = { susan_johnson: 'sue-johnson' };")
lines.append("  function resolveKey(key) { return KEY_ALIASES[key] || key; }")
lines.append("")
lines.append("  function get(key, slot) {")
lines.append("    const m = RAW[resolveKey(key)];")
lines.append("    if (!m) return '';")
lines.append("    return m[slot] ? d(m[slot]) : '';")
lines.append("  }")
lines.append("")
lines.append("  function normalizeTemp(temp) {")
lines.append("    if (temp == null) return 60;")
lines.append("    if (typeof temp !== 'number' || !Number.isFinite(temp)) throw new TypeError('temperature must be a finite number');")
lines.append("    if (temp < 0 || temp > 100) throw new RangeError('temperature must be between 0 and 100');")
lines.append("    return temp;")
lines.append("  }")
lines.append("")
lines.append("  // Chat 项目温度区间映射：")
lines.append("  //   <=40: emotional (情感逐字稿, 仅温尼科特有) -> fallback perspective")
lines.append("  //   41-70: perspective (大师人格视角)")
lines.append("  //   >70: knowledge (完整知识库) + skill")
lines.append("  function byTemp(key, temp) {")
lines.append("    const m = RAW[resolveKey(key)] || {};")
lines.append("    const t = normalizeTemp(temp);")
lines.append("    if (t <= 40 && m['emotional']) return d(m['emotional']);")
lines.append("    if (t <= 40 && m['perspective']) return d(m['perspective']);")
lines.append("    if (t <= 70 && m['perspective']) return d(m['perspective']);")
lines.append("    let result = '';")
lines.append("    if (m['knowledge']) result = d(m['knowledge']);")
lines.append("    if (m['skill-only']) result += '\\n\\n' + d(m['skill-only']);")
lines.append("    if (!result && m['perspective']) result = d(m['perspective']);")
lines.append("    return result;")
lines.append("  }")
lines.append("")
lines.append("  // P2-1：溯源如实反映「实际取用的槽位文件」，判定与 byTemp 逐字对齐。")
lines.append("  function tempFiles(key, temp) {")
lines.append("    const bundleKey = resolveKey(key);")
lines.append("    const m = RAW[bundleKey] || {};")
lines.append("    const t = normalizeTemp(temp);")
lines.append("    const f = (slot) => 'masters/knowledge/' + bundleKey + '-' + slot + '.md';")
lines.append("    if (t <= 40 && m['emotional']) return f('emotional');")
lines.append("    if (t <= 40 && m['perspective']) return f('perspective');")
lines.append("    if (t <= 70 && m['perspective']) return f('perspective');")
lines.append("    const parts = [];")
lines.append("    if (m['knowledge']) parts.push(f('knowledge'));")
lines.append("    if (m['skill-only']) parts.push(f('skill-only'));")
lines.append("    if (!parts.length && m['perspective']) return f('perspective');")
lines.append("    return parts.join(' + ');")
lines.append("  }")
lines.append("")
lines.append("  function allKeys() { return Object.keys(RAW); }")
lines.append("  function slotsOf(key) { return RAW[resolveKey(key)] ? Object.keys(RAW[resolveKey(key)]) : []; }")
lines.append("")
lines.append("  return { get, byTemp, tempFiles, allKeys, slotsOf };")
lines.append("})();")
lines.append("")
lines.append("if (typeof window !== 'undefined') { window.Knowledge = Knowledge; }")
lines.append("")

result = '\n'.join(lines)
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(result)

print(f'WRITTEN {OUT}')
print(f'  size={os.path.getsize(OUT)} bytes')
print(f'  masters={len(KB)}')
print(f'  sanitize={"OFF(NO_SANITIZE)" if NO_SANITIZE else ("OVERBROAD" if OVERBROAD else "ON")}')
print(f'  routable_keys(from masters-data.js)={len(MASTERS_KEYS)}: {",".join(MASTERS_KEYS)}')
for k in sorted(KB.keys()):
    print(f'    {k}: {sorted(KB[k].keys())}')
print('--- DEC-03 净化台账（每槽） ---')
tot_b = tot_a = 0
for a in AUDIT:
    tot_b += a['before_chars']
    tot_a += a['after_chars']
    heads = '; '.join(r + ':' + h for r, h in a['dropped_headings']) or '(无标题级剥离)'
    print(f"  {a['file']}: {a['before_chars']} -> {a['after_chars']} (-{a['delta_chars']}) "
          f"| 被删标题 {a['dropped_headings'].__len__()} 项 | 块 {a['dropped_block_count']} | 句 {a['dropped_sentence_count']} "
          f"| 残留 {','.join(a['before_residues']) or '-'} => {','.join(a['after_residues']) or 'NONE'}")
    print(f"      标题清单: {heads}")
print(f'  TOTAL: {tot_b} -> {tot_a} (-{tot_b - tot_a} chars, {round((tot_b - tot_a) * 100.0 / tot_b, 2)}%)')

# 取证用：XJ_KB_LEDGER=<path> 时把逐条台账（含被删标题/句子清单）写成 JSON
_ledger = os.environ.get('XJ_KB_LEDGER')
if _ledger:
    with open(_ledger, 'w', encoding='utf-8') as f:
        json.dump({'routable_keys': MASTERS_KEYS, 'skipped': skipped, 'audit': AUDIT},
                  f, ensure_ascii=False, indent=1)
    print('LEDGER ' + _ledger)
