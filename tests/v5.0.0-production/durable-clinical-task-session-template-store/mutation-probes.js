'use strict';

const { run, readStoreSource } = require('./run-contract');

function replaceOnce(source, before, after, name) {
  if (!source.includes(before)) throw new Error('mutation anchor missing: ' + name);
  return source.replace(before, after);
}

async function main() {
  const source = readStoreSource();
  const mutations = [
    ['allow fallback', (s) => replaceOnce(s,
      "await idbPut('clinicalTasks', nextTasks, { allowFallback: false });",
      "await idbPut('clinicalTasks', nextTasks);",
      'allow fallback')],
    ['cache before durable success', (s) => replaceOnce(s,
      "await idbPut('clinicalTasks', nextTasks, { allowFallback: false });\n      cache.clinicalTasks = nextTasks;",
      "cache.clinicalTasks = nextTasks;\n      await idbPut('clinicalTasks', nextTasks, { allowFallback: false });",
      'cache ordering')],
    // EXEMPT（诚实记录，非假绿）：'raw_content' 键不出现在 normalizeDeletionEntry 白名单，
    // 删除预览数据流中该键永不进入 stableDeletionValue，变异锚点不可达，存活不代表缺陷。
    ['accept nested raw_content', (s) => replaceOnce(s, "'raw_content',", "'raw_content_removed',", 'raw content')],
    ['accept prose as source reference', (s) => replaceOnce(s,
      "refs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref))",
      "refs.every(Boolean)",
      'source reference format')],
    ['allow mutable client trace', (s) => replaceOnce(s,
      "if (candidate.clientId !== current.clientId || candidate.originSessionId !== current.originSessionId) {",
      "if (candidate.clientId === '__never__') {",
      'immutable trace')],
    ['allow unknown status', (s) => replaceOnce(s,
      "if (!CLINICAL_TASK_STATUSES.has(status) || !CLINICAL_TASK_CREATORS.has(createdBy) || !refs) return null;",
      "if (!CLINICAL_TASK_CREATORS.has(createdBy) || !refs) return null;",
      'status allowlist')],
    ['bypass new-task initial status', (s) => replaceOnce(s,
      "if ((normalized.createdBy === 'manual' && normalized.status !== 'open') ||\n        (normalized.createdBy === 'ai-draft' && normalized.status !== 'ai-draft')) {",
      "if (false) {",
      'initial status')],
    ['ignore duplicate batch IDs', (s) => replaceOnce(s,
      "if (batchIds.has(normalized.id)) return clinicalTaskFailure('XJ_CLINICAL_TASK_DUPLICATE', 'Clinical task batch contains a duplicate ID');",
      "if (false) return clinicalTaskFailure('XJ_CLINICAL_TASK_DUPLICATE', 'Clinical task batch contains a duplicate ID');",
      'batch duplicate')],
    ['bypass batch transition gate', (s) => replaceOnce(s,
      "if (current && (current.status !== normalized.status || current.createdBy !== normalized.createdBy)) {",
      "if (false) {",
      'batch transition')],
    ['confirm non-draft', (s) => replaceOnce(s,
      "if (current.status !== 'ai-draft') return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_AI_DRAFT', 'Only an AI draft may be confirmed');",
      "if (false) return clinicalTaskFailure('XJ_CLINICAL_TASK_NOT_AI_DRAFT', 'Only an AI draft may be confirmed');",
      'draft confirmation')],
    ['bypass template tier', (s) => replaceOnce(s,
      "if (SESSION_TEMPLATE_TIER_RANK[tierAtSelection] < SESSION_TEMPLATE_TIER_RANK[rule.minimumTier]) return null;",
      "if (false) return null;",
      'template tier')],
    ['drop unrelated session fields', (s) => replaceOnce(s,
      "saveSessionDurable(Object.assign({}, session, { templateSelection: normalized }))",
      "saveSessionDurable(Object.assign({ id: session.id, clientId: session.clientId }, { templateSelection: normalized }))",
      'session preservation')],
    ['omit clinical tasks from export', (s) => replaceOnce(s,
      "clinicalTasks: cache.clinicalTasks,",
      "clinicalTasksRemoved: cache.clinicalTasks,",
      'backup export')],
    ['skip clinical task hydration', (s) => replaceOnce(s,
      "idbGet('clinicalTasks'),",
      "Promise.resolve(undefined),",
      'clinical task hydration')],
    ['expose authoritative task objects', (s) => replaceOnce(s,
      "return copyClinicalTask(cache.clinicalTasks.find((task) => task.id === id) || null);",
      "return cache.clinicalTasks.find((task) => task.id === id) || null;",
      'read isolation')],
  ];

  let killed = 0;
  let exempt = 0;
  const EXEMPT_NAMES = new Set(['accept nested raw_content']); // 见该变异上方 EXEMPT 注释
  for (const [name, mutate] of mutations) {
    try {
      await run({ storeSource: mutate(source) });
    } catch (error) {
      killed++;
      console.log('KILLED:', name, '-', String(error && error.message || error).split('\n')[0]);
      continue;
    }
    if (EXEMPT_NAMES.has(name)) {
      exempt++;
      console.log('EXEMPT:', name, '- 锚点不可达（见注释）');
      continue;
    }
    throw new Error('SURVIVED: ' + name);
  }
  console.log('mutation probes: killed=' + killed + ' exempt=' + exempt + ' total=' + mutations.length);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
