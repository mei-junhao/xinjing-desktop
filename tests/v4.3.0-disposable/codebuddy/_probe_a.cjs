'use strict';
// Checkpoint A 探针（本任务临时文件，交付前删除）：真实 require prototype 模块并记录导出。
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const a = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'source-ref-adapter.js'));
const v = require(path.join(ROOT, 'design-previews', '4.3.0-opensquilla-case-atlas', 'case-atlas-view-model.js'));
console.log('ADAPTER_KEYS=' + Object.keys(a).map(k => k + ':' + typeof a[k]).join('|'));
console.log('VM_KEYS=' + Object.keys(v).map(k => k + ':' + typeof v[k]).join('|'));
console.log('SR_KEYS=' + Object.keys(a.SourceRef).map(k => k + ':' + typeof a.SourceRef[k]).join('|'));
console.log('UNSUPPORTED loadClient=' + typeof v.loadClient + ' refresh=' + typeof v.refresh + ' persistAIEdge=' + typeof a.persistAIEdge + ' saveDraft=' + typeof v.saveDraft + ' loadClientAdapter=' + typeof a.loadClient);
// 试调用：createAtlasSourceRef 正常输入
const ref = a.createAtlasSourceRef({ clientId: 'cli-x', sessionId: 'ses-x', anchor: { kind: 'quote', locator: 'section-1/transcript' }, sourceText: '合成文本A' });
console.log('REF_FIELDS=' + Object.keys(ref).join(','));
console.log('VERIFY_UNCHANGED=' + JSON.stringify(a.verifyAtlasSourceRef(ref, '合成文本A')));
console.log('VERIFY_CHANGED=' + JSON.stringify(a.verifyAtlasSourceRef(ref, '合成文本B')));
console.log('IS_PROMISE=' + (a.verifyAtlasSourceRef(ref, 'x') instanceof Promise));
