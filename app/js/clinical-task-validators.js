/*
 * XinJing clinical-task validation and normalization.
 * This browser module deliberately has no Store, DOM, Electron or network dependency.
 */
(() => {
  'use strict';

  const CLINICAL_TASK_STATUSES = new Set(['ai-draft', 'open', 'done', 'cancelled']);
  const CLINICAL_TASK_CREATORS = new Set(['manual', 'ai-draft']);
  const CLINICAL_BODY_KEYS = new Set([
    'body', 'content', 'clinicalBody', 'clinical_body', 'transcript', 'rawContent', 'raw_content',
  ]);

  function hasClinicalBodyField(value, seen) {
    if (!value || typeof value !== 'object') return false;
    seen = seen || new Set();
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.keys(value).some((key) => CLINICAL_BODY_KEYS.has(key) || hasClinicalBodyField(value[key], seen));
  }

  function normalizeClinicalTaskSourceRefs(value) {
    if (!Array.isArray(value) || !value.length) return null;
    const refs = value.map((ref) => {
      if (typeof ref === 'string') return ref.trim();
      if (ref && typeof ref.id === 'string') return ref.id.trim();
      return '';
    });
    if (!refs.every((ref) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref)) || new Set(refs).size !== refs.length) return null;
    return refs;
  }

  function defaultNowISO() {
    return new Date().toISOString();
  }

  function normalizeClinicalTask(value, nowFn) {
    if (!value || typeof value !== 'object' || hasClinicalBodyField(value)) return null;
    const required = ['id', 'clientId', 'originSessionId', 'title', 'target', 'createdBy'];
    if (required.some((key) => typeof value[key] !== 'string' || !value[key].trim())) return null;
    const status = String(value.status || '');
    const createdBy = String(value.createdBy || '').trim();
    const refs = normalizeClinicalTaskSourceRefs(value.sourceRefs);
    if (!CLINICAL_TASK_STATUSES.has(status) || !CLINICAL_TASK_CREATORS.has(createdBy) || !refs) return null;
    if (createdBy === 'manual' && status !== 'open' && status !== 'done' && status !== 'cancelled') return null;
    if (createdBy === 'ai-draft' && (typeof value.actionRunId !== 'string' || !value.actionRunId.trim())) return null;
    const clock = typeof nowFn === 'function' ? nowFn : defaultNowISO;
    const createdAt = typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : clock();
    return {
      id: value.id.trim(),
      clientId: value.clientId.trim(),
      originSessionId: value.originSessionId.trim(),
      title: value.title.trim(),
      status,
      due: typeof value.due === 'string' ? value.due : '',
      sourceRefs: refs,
      target: value.target.trim(),
      createdBy,
      actionRunId: typeof value.actionRunId === 'string' ? value.actionRunId.trim() : '',
      createdAt,
      updatedAt: typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : createdAt,
      completedAt: typeof value.completedAt === 'string' ? value.completedAt : '',
    };
  }

  if (typeof window === 'undefined') {
    throw new Error('ClinicalTaskValidators requires a browser window');
  }

  window.ClinicalTaskValidators = Object.freeze({
    CLINICAL_TASK_STATUSES,
    CLINICAL_TASK_CREATORS,
    CLINICAL_BODY_KEYS,
    hasClinicalBodyField,
    normalizeClinicalTaskSourceRefs,
    normalizeClinicalTask,
  });
})();
