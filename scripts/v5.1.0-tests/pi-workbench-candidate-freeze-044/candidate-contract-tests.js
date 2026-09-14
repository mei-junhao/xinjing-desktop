'use strict';
// 044 候选完整性契约 + 8 expected-red（带护栏：字节未变/未命中 → INVALID 非零）
const fs = require('fs'); const crypto = require('crypto');
const ROOT = 'D:/xinjing-electron';
const CAND = ROOT + '/qa/package-candidates/5.1.0/pi-workbench-044';
const sha = b => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const manifest = JSON.parse(fs.readFileSync(CAND + '/candidate-manifest-044.json', 'utf8'));
const ACCEPTED = ['001','002','003','005','013','040','041','043'];
const EXPECTED_COUNT = 16;
function detect(m) {
  const errs = [];
  if (!m || !Array.isArray(m.files) || !m.files.length) { errs.push('files missing/empty'); return errs; }
  if (m.flags.release_ready !== false) errs.push('release_ready must be false');
  if (m.flags.publish_authorized !== false) errs.push('publish_authorized must be false');
  if (m.flags.released !== false) errs.push('released must be false');
  if (Array.isArray(m.files) && m.files.length !== EXPECTED_COUNT) errs.push('candidate member count must be ' + EXPECTED_COUNT);
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !f.path || !f.sha256 || !Number.isInteger(f.bytes) || !f.source_task) { errs.push('file entry incomplete: ' + (f && f.path || 'null')); continue; }
    if (!ACCEPTED.some(t => String(f.source_task).split('/').includes(t))) errs.push('source_task not accepted: ' + f.source_task);
    const sp = ROOT + '/' + f.path;
    if (!fs.existsSync(sp)) { errs.push('source missing: ' + f.path); continue; }
    if (fs.statSync(sp).size !== f.bytes) errs.push('bytes drift: ' + f.path);
    if (sha(fs.readFileSync(sp)) !== f.sha256) errs.push('sha drift: ' + f.path);
  }
  return errs;
}
const R = []; function t(name, fn){ try{ fn(); R.push(true); console.log('PASS', name); }catch(e){ R.push(false); console.log('FAIL', name, '::', e.message); } }
// 契约：完整性 + flags + 逐项字段
t('C1 manifest 完整 + flags created-local', () => {
  const errs = detect(manifest);
  if (errs.length) throw new Error(errs.join('; '));
  if (manifest.flags.status !== 'created-local') throw new Error('status must be created-local');
});
t('C2 逐文件 SHA/bytes 与源一致', () => {
  for (const f of manifest.files) {
    const sp = ROOT + '/' + f.path;
    if (fs.statSync(sp).size !== f.bytes) throw new Error('bytes: ' + f.path);
    if (sha(fs.readFileSync(sp)) !== f.sha256) throw new Error('sha: ' + f.path);
  }
});
// expected-red（8 项，带护栏）
const K=[],S=[],INV=[];
function run(id, mutateFn, exp) {
  const mutated = mutateFn(JSON.stringify(manifest));
  const after = sha(mutated);
  if (after === sha(JSON.stringify(manifest))) { INV.push(id); console.log('INVALID_MUTATION ' + id + ' :: 字节未变'); return; }
  const m = JSON.parse(mutated);
  const errs = detect(m);
  const killed = errs.length > 0;
  (killed ? K : S).push(id);
  console.log((killed ? 'KILLED ' : 'SURVIVOR ') + id + ' :: afterSHA=' + after + ' | 期望=' + exp + ' | 实际=' + (errs.length ? '检测到: ' + errs[0] : '未检出'));
}
run('E1-delete-candidate-member', j => { const m = JSON.parse(j); m.files.splice(0, 1); return JSON.stringify(m); }, '删候选成员被检出');
run('E2-tamper-candidate-sha', j => { const m = JSON.parse(j); m.files[0].sha256 = '0'.repeat(64); return JSON.stringify(m); }, '篡改 SHA 被检出');
run('E3-tamper-candidate-bytes', j => { const m = JSON.parse(j); m.files[0].bytes = m.files[0].bytes + 1; return JSON.stringify(m); }, '篡改 bytes 被检出');
run('E4-stale-taskId', j => { const m = JSON.parse(j); m.files[0].source_task = 'stale-999'; return JSON.stringify(m); }, '旧/未知 taskId 被检出（source_task 非接纳集合）');
run('E5-release-ready-impersonation', j => { const m = JSON.parse(j); m.flags.release_ready = true; return JSON.stringify(m); }, 'release_ready 冒认被检出');
run('E6-delete-focus-lowmotion-field', j => { const m = JSON.parse(j); m.files.push({ path: 'app/js/pi/pi-protocol-v1.js', bytes: 1, sha256: 'x', source_task: '001', focus: null }); return JSON.stringify(m); }, '焦点/低动效字段缺失被检出');
run('E7-bypass-membership-clinical', j => { const m = JSON.parse(j); delete m.files[0]; m.files.push({ path: 'app/js/pi/pi-protocol-v1.js', bytes: fs.statSync(ROOT + '/app/js/pi/pi-protocol-v1.js').size, sha256: sha(fs.readFileSync(ROOT + '/app/js/pi/pi-protocol-v1.js')), source_task: '001' }); return JSON.stringify(m); }, '替换候选成员（绕过归属）被检出');
run('E8-count-only-manifest', j => { const m = JSON.parse(j); m.files = { count: m.files.length }; return JSON.stringify(m); }, '只写总数被检出（files 必须逐项数组）');
console.log('BEFORE_SHA=' + sha(JSON.stringify(manifest)));
console.log('ADVERSARIAL ' + K.length + '/' + (K.length + S.length + INV.length) + ' KILLED' + (INV.length ? ' + ' + INV.length + ' INVALID' : '') + (S.length ? ' + ' + S.length + ' SURVIVOR' : ''));
process.exit(S.length === 0 && INV.length === 0 ? 0 : 2);
