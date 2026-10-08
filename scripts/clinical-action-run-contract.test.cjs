/* 临床动作溯源契约测试（XJ-5.1.19 放行轮新增）
 *
 * 守的不变量：`js/clinical-context.js` 的任务表与 `js/store.js` 的 ACTION_TASKS 白名单
 * 必须同源。二者一旦错位，`ClinicalContext.build()` 会返回 ok:true 让页面继续往下走，
 * 而 `Store.createClinicalActionRun()` 在 normalize 阶段静默返回 null ——
 * 页面表现为「无法确认材料归属，已取消分析」且核心永不被调用（真实回归过：
 * 'supervision-multi-school' 曾长期缺席白名单，导致多学派督导在真实页面完全跑不起来）。
 *
 * 运行：node scripts/clinical-action-run-contract.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STORE_SRC = fs.readFileSync(path.join(__dirname, '../app/js/store.js'), 'utf8');
const CTX_SRC = fs.readFileSync(path.join(__dirname, '../app/js/clinical-context.js'), 'utf8');

function makeEnv() {
  const rows = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      let wrote = false;
      const tx = {
        error: null,
        objectStore() {
          return {
            get(key) {
              const req = {};
              queueMicrotask(() => {
                req.result = rows.get(key);
                if (req.onsuccess) req.onsuccess();
                queueMicrotask(() => { if (!wrote && tx.oncomplete) tx.oncomplete(); });
              });
              return req;
            },
            getAll() {
              const req = {};
              queueMicrotask(() => { req.result = [...rows.values()]; if (req.onsuccess) req.onsuccess(); });
              return req;
            },
            put(row) {
              wrote = true;
              queueMicrotask(() => { rows.set(row.key, structuredClone(row)); if (tx.oncomplete) tx.oncomplete(); });
              return {};
            },
          };
        },
      };
      return tx;
    },
  };
  const indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess({ target: req }); }); return req; } };
  const storage = new Map();
  const localStorage = {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i],
    getItem: (k) => storage.get(k) || null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  };
  const window = { ClinicalTaskValidators: { normalizeClinicalTask: (x) => x, hasClinicalBodyField: () => false }, indexedDB, localStorage };
  const context = { window, indexedDB, localStorage, console, Date, crypto: globalThis.crypto, setTimeout, clearTimeout, structuredClone, Promise, Error, JSON, Math, Array, Object, String, Number, Boolean, Set, Map, RegExp, isNaN, parseInt, encodeURIComponent };
  vm.createContext(context);
  vm.runInContext(STORE_SRC + '\nthis.Store = Store;', context);
  vm.runInContext(CTX_SRC, context);
  const ClinicalContext = context.window.ClinicalContext;
  assert.ok(ClinicalContext && ClinicalContext.TASKS, 'clinical-context.js 未导出 window.ClinicalContext.TASKS');
  return { Store: context.Store, ClinicalContext, rows };
}

// 页面侧任务真值：运行时读 ClinicalContext.TASKS 的键（不做源码正则猜测）。
function contextTaskIds(env) {
  return Object.keys(env.ClinicalContext.TASKS);
}
function actionTasksFromSource(source) {
  const m = source.match(/const ACTION_TASKS = new Set\(\[([^\]]*)\]/);
  assert.ok(m, 'store.js 必须保留 ACTION_TASKS 白名单定义位');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
function storeActionTaskIds() {
  return actionTasksFromSource(STORE_SRC);
}

const CASES = [];
function test(name, fn) { CASES.push({ name, fn }); }

test('parity: clinical-context 的每个任务都在 store 的 ACTION_TASKS 白名单内', async () => {
  const env = makeEnv();
  const ctxTasks = contextTaskIds(env);
  const storeTasks = storeActionTaskIds();
  assert.ok(ctxTasks.length >= 6, '任务表读取异常（只读到 ' + ctxTasks.length + ' 条）');
  const missing = ctxTasks.filter((id) => !storeTasks.includes(id));
  assert.deepEqual(missing, [], '这些任务被页面声明为可用、却被 store 白名单拒绝：' + missing.join(', '));
});

test('parity: 白名单不反向包含页面不存在的任务（避免不可达入口）', async () => {
  const env = makeEnv();
  const ctxTasks = contextTaskIds(env);
  const extra = storeActionTaskIds().filter((id) => !ctxTasks.includes(id));
  assert.deepEqual(extra, [], 'store 接受了页面无法构建的任务：' + extra.join(', '));
});

test('回归锁: supervision-multi-school 经真实 build→createActionRun 必须产出动作记录（独立督导）', async () => {
  const env = makeEnv();
  await env.Store.hydrate();
  const context = env.ClinicalContext.build('supervision-multi-school', {}, {
    system: '多学派临床督导编排；输出仅为草稿。',
    inputText: '合成材料：来访者在会谈中反复谈论「为了让别人满意而做自己」的模式。',
    instruction: '运行多学派督导并生成对比、分歧与整合建议',
  });
  assert.equal(context.ok, true, 'build 必须放行（否则先红在准入）：' + JSON.stringify(context));
  const run = env.ClinicalContext.createActionRun(context);
  assert.ok(run, 'createActionRun 返回空 = 页面会报「无法确认材料归属」且核心不被调用');
  assert.equal(run.task, 'supervision-multi-school');
  assert.equal(run.status, 'pending');
  assert.equal(run.output.kind, '');
});

test('回归锁: supervision-multi-school 绑定来访者后同样产出动作记录', async () => {
  const env = makeEnv();
  await env.Store.hydrate();
  const created = await env.Store.createClientDurable({ name: '合成来访者甲' });
  assert.equal(created.ok, true);
  const context = env.ClinicalContext.build('supervision-multi-school', { clientId: created.value.id, sessionId: '' }, {
    system: '多学派临床督导编排；输出仅为草稿。',
    inputText: '合成材料：反复的讨好模式与愤怒抑制。',
    instruction: '运行多学派督导',
  });
  assert.equal(context.ok, true, JSON.stringify(context));
  const run = env.ClinicalContext.createActionRun(context);
  assert.ok(run, '绑定来访者的多学派督导必须能创建动作记录');
  assert.equal(run.origin.clientId, created.value.id);
  assert.ok(run.sources.length >= 1, '至少要有当前来访者来源');
});

test('完成/失败回写链路可达（completeActionRun 不再因白名单被拒）', async () => {
  const env = makeEnv();
  await env.Store.hydrate();
  const context = env.ClinicalContext.build('supervision-multi-school', {}, {
    system: 's', inputText: '合成材料', instruction: 'i',
  });
  const run = env.ClinicalContext.createActionRun(context);
  assert.ok(run);
  const done = env.ClinicalContext.completeActionRun(run.id, { kind: 'supervision-multi-school', summary: '合成综合结论', citations: [] });
  assert.ok(done, 'completeActionRun 必须能回写（返回空即回滚链路断）');
  assert.equal(done.status, 'succeeded', '输出通过 schema 校验时应记为 succeeded，实得 ' + done.status);
});

test('闸门仍在: 未登记任务与缺来源的真实请求仍必须被拒', async () => {
  const env = makeEnv();
  await env.Store.hydrate();
  const created = await env.Store.createClientDurable({ name: '合成来访者乙' });
  assert.equal(created.ok, true);
  // 载荷形状完全合法（有来访者、有来源），只有 task 未登记 —— 只有白名单能拦住它。
  const ghost = {
    task: 'not-a-real-task', status: 'pending', outputMode: 'preview-only',
    origin: { clientId: created.value.id, sessionId: '', materialId: '', supervisionId: '' },
    sources: [{ kind: 'client', id: created.value.id, label: '当前来访者', chars: 12, truncated: false }],
    snapshot: { clientId: created.value.id, sessionId: '', materialId: '', supervisionId: '', selectedSessionIds: [] },
    createdAt: new Date().toISOString(),
  };
  assert.equal(env.Store.createClinicalActionRun(ghost), null, '未登记任务被接受了 = 白名单闸门被拆掉');
  const bound = env.ClinicalContext.build('supervision-multi-school', { clientId: 'ghost-client' }, { system: 's', inputText: 'x', instruction: 'i' });
  if (bound && bound.ok) {
    assert.equal(env.ClinicalContext.createActionRun(bound), null, '指向不存在来访者的动作记录必须被拒');
  }
});

test('mutation-target: 把 ACTION_TASKS 改回缺席 supervision-multi-school 时白名单断言必须转红', async () => {
  const env = makeEnv();
  // 该用例本身不制造变异；它固定住「哪条断言负责杀伤」，供 --mutation 模式使用。
  const ctxTasks = contextTaskIds(env);
  assert.ok(ctxTasks.includes('supervision-multi-school'), '任务表必须含 supervision-multi-school（否则本测试失去意义）');
  assert.ok(storeActionTaskIds().includes('supervision-multi-school'), 'store 白名单必须含 supervision-multi-school');
});

const MUTATIONS = [
  {
    id: 'M1-remove-multi-school-from-whitelist',
    reason: '回到本次放行轮抓出的真实缺陷：白名单漏登记 supervision-multi-school',
    needle: "'supervision-ai', 'supervision-multi-school', 'real-supervision-ai-organize'",
    replacement: "'supervision-ai', 'real-supervision-ai-organize'",
    kills: ['parity: clinical-context 的每个任务都在 store 的 ACTION_TASKS 白名单内',
      '回归锁: supervision-multi-school 经真实 build→createActionRun 必须产出动作记录（独立督导）'],
  },
  {
    id: 'M2-remove-unbound-allowance-for-multi-school',
    reason: '只登记任务却不给独立督导放行：绑定来访者可用、独立督导仍被拒',
    needle: "const UNBOUND_SUPERVISION_TASKS = new Set(['supervision-ai', 'supervision-multi-school']);",
    replacement: "const UNBOUND_SUPERVISION_TASKS = new Set(['supervision-ai']);",
    kills: ['回归锁: supervision-multi-school 经真实 build→createActionRun 必须产出动作记录（独立督导）'],
  },
  {
    id: 'M3-whitelist-everything',
    reason: '把闸门整体拆掉（用恒真判定替代白名单），必须被「未登记任务仍被拒」抓到',
    needle: 'if (!value || typeof value !== \'object\' || !ACTION_TASKS.has(value.task)) return null;',
    replacement: 'if (!value || typeof value !== \'object\') return null;',
    kills: ['闸门仍在: 未登记任务与缺来源的真实请求仍必须被拒'],
  },
];

function headTail(message) {
  const s = String(message || '');
  return s.length <= 220 ? s : s.slice(0, 120) + ' … ' + s.slice(-90);
}

async function runCase(item) {
  const started = Date.now();
  await item.fn();
  console.log('ok   - ' + item.name + ' (' + (Date.now() - started) + 'ms)');
}

async function runCases(list) {
  const failures = [];
  for (const item of list) {
    try { await runCase(item); } catch (e) {
      failures.push({ name: item.name, message: e && e.message ? e.message : String(e) });
      console.log('FAIL - ' + item.name + '\n       ' + headTail(e && e.message ? e.message : e));
    }
  }
  console.log('CASES: total=' + list.length + ' passed=' + (list.length - failures.length) + ' failed=' + failures.length);
  if (failures.length) process.exitCode = 1;
}

async function runMutations() {
  console.log('=== 反向变异自证 ===');
  let survivors = 0;
  for (const mutation of MUTATIONS) {
    const patched = STORE_SRC.split(mutation.needle).join(mutation.replacement);
    if (patched === STORE_SRC) {
      survivors += 1;
      console.log('SURVIVED - ' + mutation.id + ' 变异点未命中（needle 失效，测试已失去保护）');
      continue;
    }
    const original = STORE_SRC;
    // 用变异后的 store 源码重建环境：临时替换模块级常量。
    Object.defineProperty(globalThis, '__patchedStoreSrc', { value: patched, configurable: true });
    const targets = CASES.filter((c) => mutation.kills.includes(c.name));
    let killed = null;
    for (const item of targets) {
      try { await runMutationCase(patched, item); } catch (e) { killed = { name: item.name, message: e && e.message }; break; }
    }
    if (killed) {
      console.log('KILLED   - ' + mutation.id + ' → 用例转红：' + killed.name);
      console.log('           红在：' + headTail(killed.message));
    } else {
      survivors += 1;
      console.log('SURVIVED - ' + mutation.id + ' 未被抓到（目标用例 ' + targets.length + ' 个）');
    }
    void original;
  }
  console.log('MUTATIONS: total=' + MUTATIONS.length + ' survivors=' + survivors);
  if (survivors) process.exitCode = 1;
}

// 变异用例在独立 VM 里重跑（用 patched store 源码替换模块级 STORE_SRC 的读取）。
async function runMutationCase(patchedSrc, item) {
  const env = evalEnv(patchedSrc);
  await env.Store.hydrate();
  const ctx = env.ClinicalContext;
  switch (item.name) {
    case 'parity: clinical-context 的每个任务都在 store 的 ACTION_TASKS 白名单内': {
      const missing = contextTaskIds(env).filter((id) => !actionTasksFromSource(patchedSrc).includes(id));
      assert.deepEqual(missing, [], '白名单缺任务：' + missing.join(', '));
      return;
    }
    case '回归锁: supervision-multi-school 经真实 build→createActionRun 必须产出动作记录（独立督导）': {
      const context = ctx.build('supervision-multi-school', {}, { system: 's', inputText: '合成材料', instruction: 'i' });
      assert.equal(context.ok, true, 'build 未放行：' + JSON.stringify(context));
      assert.ok(ctx.createActionRun(context), 'createActionRun 返回空 = 独立多学派督导在页面上跑不起来');
      return;
    }
    case '闸门仍在: 未登记任务与缺来源的真实请求仍必须被拒': {
      const created = await env.Store.createClientDurable({ name: '合成来访者乙' });
      assert.equal(created.ok, true, '夹具未能创建来访者');
      const out = env.Store.createClinicalActionRun({
        task: 'not-a-real-task', status: 'pending', outputMode: 'preview-only',
        origin: { clientId: created.value.id, sessionId: '', materialId: '', supervisionId: '' },
        sources: [{ kind: 'client', id: created.value.id, label: '当前来访者', chars: 12, truncated: false }],
        snapshot: { clientId: created.value.id, sessionId: '', materialId: '', supervisionId: '', selectedSessionIds: [] },
        createdAt: new Date().toISOString(),
      });
      assert.equal(out, null, '未登记任务被接受了 = 白名单闸门被拆掉');
      return;
    }
    default:
      throw new Error('未编排的变异目标用例：' + item.name);
  }
}

function evalEnv(storeSourcePatched) {
  const rows = new Map();
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      let wrote = false;
      const tx = { error: null, objectStore() { return {
        get(key) { const req = {}; queueMicrotask(() => { req.result = rows.get(key); if (req.onsuccess) req.onsuccess(); queueMicrotask(() => { if (!wrote && tx.oncomplete) tx.oncomplete(); }); }); return req; },
        getAll() { const req = {}; queueMicrotask(() => { req.result = [...rows.values()]; if (req.onsuccess) req.onsuccess(); }); return req; },
        put(row) { wrote = true; queueMicrotask(() => { rows.set(row.key, structuredClone(row)); if (tx.oncomplete) tx.oncomplete(); }); return {}; },
      }; } };
      return tx;
    },
  };
  const indexedDB = { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess({ target: req }); }); return req; } };
  const storage = new Map();
  const localStorage = { get length() { return storage.size; }, key: (i) => [...storage.keys()][i], getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const window = { ClinicalTaskValidators: { normalizeClinicalTask: (x) => x, hasClinicalBodyField: () => false }, indexedDB, localStorage };
  const context = { window, indexedDB, localStorage, console, Date, crypto: globalThis.crypto, setTimeout, clearTimeout, structuredClone, Promise, Error, JSON, Math, Array, Object, String, Number, Boolean, Set, Map, RegExp, isNaN, parseInt, encodeURIComponent };
  vm.createContext(context);
  vm.runInContext(storeSourcePatched + '\nthis.Store = Store;', context);
  vm.runInContext(CTX_SRC, context);
  return { Store: context.Store, ClinicalContext: context.window.ClinicalContext, rows };
}

(async () => {
  const arg = process.argv[2] || '';
  if (arg === '--mutation' || arg === '--mutations') return runMutations();
  await runCases(CASES);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
