'use strict';
// 046 候选依赖闭包契约 + expected-red（带护栏）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const CAND = ROOT + '/qa/package-candidates/5.1.0/pi-workbench-046';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const manifest = JSON.parse(fs.readFileSync(CAND + '/candidate-manifest-046.json', 'utf8'));
const CB = CAND + '/app/js/pi/clinical/clinical-transaction-bridge.js';
const CB_SOURCE_SHA = '98B8B435A26BEB74E0F3ED3A5328D091B3ABC55FD1C078AAE30548927A343E87';
const CB_SOURCE_BYTES = 25329;
function detect(m) {
  const errs = [];
  if (!m || !Array.isArray(m.files) || !m.files.length) { errs.push('files missing/empty'); return errs; }
  if (m.flags.release_ready !== false) errs.push('release_ready must be false');
  if (m.flags.publish_authorized !== false) errs.push('publish_authorized must be false');
  if (m.flags.released !== false) errs.push('released must be false');
  if (m.files.length !== 17) errs.push('candidate member count must be 17');
  const hasCB = m.files.some(f => f.path === 'app/js/pi/clinical/clinical-transaction-bridge.js');
  if (!hasCB) errs.push('clinical bridge missing from candidate');
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !f.path || !f.sha256 || !Number.isInteger(f.bytes) || !f.source_task) { errs.push('entry incomplete: ' + (f && f.path)); continue; }
    const sp = CAND + '/' + f.path;
    if (!fs.existsSync(sp)) { errs.push('candidate file missing: ' + f.path); continue; }
    if (fs.statSync(sp).size !== f.bytes) errs.push('bytes drift: ' + f.path);
    if (sha(fs.readFileSync(sp)) !== f.sha256) errs.push('sha drift: ' + f.path);
    if (f.path === 'app/js/pi/clinical/clinical-transaction-bridge.js') {
      if (f.sha256 !== CB_SOURCE_SHA || f.bytes !== CB_SOURCE_BYTES) errs.push('clinical bridge not bound to 013 source');
      if (f.source_task !== '013') errs.push('clinical bridge provenance not 013');
    }
  }
  return errs;
}
const R = [];
function t(name, fn) { try { fn(); R.push(true); console.log('PASS', name); } catch (e) { R.push(false); console.log('FAIL', name, '::', e.message); } }
t('C1 manifest 完整 + flags + 17 文件', () => { const errs = detect(manifest); if (errs.length) throw new Error(errs.join('; ')); if (manifest.flags.status !== 'created-local') throw new Error('status'); });
t('C2 clinical bridge 可加载（候选自包含）', () => { const mod = require(CB); if (typeof mod.createClinicalTransactionBridge !== 'function') throw new Error('no factory'); const b = mod.createClinicalTransactionBridge({ sessionBelongsToClient:()=>true, sourceBelongsToClient:()=>true, durableWrite:()=>({ok:false}), durableRead:()=>({ok:false}) }); const r = b.begin({ clientId:'c1', sessionId:'s1', taskId:'t1', snapshotHash:'sha256:'+'a'.repeat(64), sourceRefs:[{sourceId:'s',sourceVersion:'v',sourceContentHash:'sha256:'+'b'.repeat(64),anchorContentHash:'sha256:'+'c'.repeat(64)}], generationEntitlement:'manual' }); if (!r.ok) throw new Error('begin failed'); });
t('C3 044 旧候选未被覆盖', () => { const m44 = JSON.parse(fs.readFileSync(ROOT + '/qa/package-candidates/5.1.0/pi-workbench-044/candidate-manifest-044.json', 'utf8')); if (m44.candidate_id !== 'pi-workbench-044') throw new Error('044 manifest overwritten'); });
// expected-red（带护栏）
const K=[],S=[],INV=[];
function run(id, mfn, exp) {
  const mutated = mfn(JSON.stringify(manifest));
  const after = sha(mutated);
  if (after === sha(JSON.stringify(manifest))) { INV.push(id); console.log('INVALID_MUTATION ' + id + ' :: 字节未变'); return; }
  const m = JSON.parse(mutated); const errs = detect(m);
  const killed = errs.length > 0;
  (killed ? K : S).push(id);
  console.log((killed ? 'KILLED ' : 'SURVIVOR ') + id + ' :: afterSHA=' + after + ' | 期望=' + exp + ' | 实际=' + (errs.length ? '检测到: ' + errs[0] : '未检出'));
}
run('E1-delete-clinical-bridge', j => { const m = JSON.parse(j); m.files = m.files.filter(f => f.path !== 'app/js/pi/clinical/clinical-transaction-bridge.js'); return JSON.stringify(m); }, '缺 clinical bridge 被拒');
run('E2-tamper-cb-sha', j => { const m = JSON.parse(j); const f = m.files.find(x => x.path === 'app/js/pi/clinical/clinical-transaction-bridge.js'); f.sha256 = '0'.repeat(64); return JSON.stringify(m); }, '013 source SHA 篡改被拒');
run('E3-tamper-cb-bytes', j => { const m = JSON.parse(j); const f = m.files.find(x => x.path === 'app/js/pi/clinical/clinical-transaction-bridge.js'); f.bytes = f.bytes + 1; return JSON.stringify(m); }, '013 source bytes 篡改被拒');
run('E4-cb-provenance-not-013', j => { const m = JSON.parse(j); const f = m.files.find(x => x.path === 'app/js/pi/clinical/clinical-transaction-bridge.js'); f.source_task = '006'; return JSON.stringify(m); }, 'clinical bridge 来源非 013 被拒');
run('E5-release-ready-impersonation', j => { const m = JSON.parse(j); m.flags.release_ready = true; return JSON.stringify(m); }, 'release_ready 冒认被拒');
run('E6-path-escape', j => { const m = JSON.parse(j); m.files.push({ path: '../evil.js', bytes: 1, sha256: '0'.repeat(64), source_task: '001' }); return JSON.stringify(m); }, '路径逃逸被拒');
run('E7-count-only', j => { const m = JSON.parse(j); m.files = { count: m.files.length }; return JSON.stringify(m); }, '只写总数被拒');
run('E8-delete-member', j => { const m = JSON.parse(j); m.files.splice(0, 1); return JSON.stringify(m); }, '删候选成员被拒');
console.log('BEFORE_SHA=' + sha(JSON.stringify(manifest)));
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + S.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : '') + (S.length ? ' + ' + S.length + ' SURVIVOR' : ''));
process.exit(S.length === 0 && INV.length === 0 ? 0 : 2);
