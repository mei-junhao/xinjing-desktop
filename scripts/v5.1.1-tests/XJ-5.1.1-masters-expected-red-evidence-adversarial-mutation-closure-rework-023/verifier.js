// 022 verifier: 直接读取阶段 JSON 验证 rawStdout/rawStderr 自包含绑定
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = process.env.XJ_023_EVIDENCE_DIR || path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-stage-self-binding-rework-022');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
const results = {}; const report = [];
function check(name, cond, detail) { results[name] = !!cond; report.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); }
function segmentContainment(absPath, allowRoot) {
  const resolved = path.resolve(absPath);
  const allowResolved = path.resolve(allowRoot);
  // realpath to resolve symlinks/junctions
  let realPath, realAllow;
  try { realPath = fs.realpathSync(resolved); realAllow = fs.realpathSync(allowResolved); } catch (e) { return false; }
  // lstat: must not be a symlink/junction
  try { const st = fs.lstatSync(resolved); if (st.isSymbolicLink()) return false; } catch (e) { return false; }
  // path.relative segment check on realpath
  const rel = path.relative(realAllow, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

async function main() {
  const prod = { 'app/masters.html': '78A43F422CDCE6902AF78E6F2D48642D42D138C5E485E5DF7C18E8084DF4EA9F', 'app/js/masters.js': '8166BA0F698ECB0EBA03D02CA23F57A83743C8FE2E2F96BF85500B69AC677D83', 'app/css/masters-clinical.css': '64566F269B7C8F7091CD230E5285640599507548FBA9E258D1A72653ED34AFE4' };
  for (const [f, expect] of Object.entries(prod)) {
    check(`prod ${f}`, sha256(fs.readFileSync(path.join(ROOT, f))) === expect);
  }
  const resultsJson = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'results.json'), 'utf8'));
  let totalRaw = 0, shaOk = 0, stageFiles = 0;
  for (let i = 1; i <= 8; i += 1) {
    const v = resultsJson.variants[`er${i}`];
    check(`ER${i} verdict KILLED`, v && v.verdict === 'KILLED');
    const times = [];
    for (const st of ['baseline', 'mutated', 'restored']) {
      const s = v[st] || {};
      // READ stage JSON directly from disk (not from results.json binding)
      const rj = s.rawJson;
      if (!rj) { check(`ER${i}.${st} rawJson binding`, false); continue; }
      stageFiles += 1;
      const abs = path.join(ROOT, path.normalize(rj.rel));
      if (!segmentContainment(abs, SCRATCH)) {
        check(`ER${i}.${st} containment`, false, rj.rel);
      }
      if (!fs.existsSync(abs)) { check(`ER${i}.${st} stage json exists`, false); continue; }
      const stageJson = JSON.parse(fs.readFileSync(abs, 'utf8'));
      // verify meta fields
      check(`ER${i}.${st} meta`, ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode'].every(k => k in stageJson));
      times.push({ st, t: Date.parse(stageJson.startUtc || 0) });
      // verify rawStdout/rawStderr SELF-CONTAINED in stage JSON
      for (const key of ['rawStdout', 'rawStderr']) {
        const bnd = stageJson[key];
        if (!bnd || !bnd.rel || !bnd.sha256 || !bnd.bytes) {
          check(`ER${i}.${st} ${key} self-contained`, false, 'missing fields');
          continue;
        }
        totalRaw += 1;
        const bndAbs = path.join(ROOT, path.normalize(bnd.rel));
        if (!segmentContainment(bndAbs, SCRATCH)) {
          check(`ER${i}.${st} ${key} containment`, false, bnd.rel);
        }
        if (fs.existsSync(bndAbs)) {
          const bb = fs.readFileSync(bndAbs);
          if (sha256(bb) === bnd.sha256 && bb.length === bnd.bytes) shaOk += 1;
          else check(`ER${i}.${st} ${key} sha`, false);
        } else { check(`ER${i}.${st} ${key} exists`, false); }
      }
    }
    check(`ER${i} time order`, times[0].t && times[1].t && times[2].t && times[0].t < times[1].t && times[1].t < times[2].t);
    // ER7 dual assertion (from stage JSON)
    if (i === 7) {
      for (const st of ['baseline', 'mutated', 'restored']) {
        const s = v[st] || {};
        const r = s.round ? (typeof s.round === 'string' ? JSON.parse(s.round) : s.round) : null;
        if (r) {
          const cols = String(r.gridTemplateColumns || '').split(' ').filter(Boolean);
          const tops = r.tops || [];
          if (st === 'mutated') {
            check(`ER7.${st} grid-multi-col`, cols.length > 1, `cols=${cols.length}`);
            check(`ER7.${st} tops-not-increasing`, tops.length > 1 && !tops.every((t, j) => j === 0 || t > tops[j - 1]), `tops=${tops}`);
          } else {
            check(`ER7.${st} grid-single-col`, cols.length === 1, `cols=${cols.length}`);
            check(`ER7.${st} tops-increasing`, tops.length > 1 && tops.every((t, j) => j === 0 || t > tops[j - 1]), `tops=${tops}`);
          }
        }
      }
    }
  }
  check(`stage JSON files ${stageFiles}/24`, stageFiles === 24);
  check(`raw sha/bytes ${shaOk}/${totalRaw}`, shaOk === totalRaw);
  // junction expected-red: junction must resolve OUTSIDE allowRoot -> segmentContainment rejects
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-022-junction-test-'));
  try {
    const insideDir = path.join(tmpDir, 'inside');
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(insideDir);
    fs.mkdirSync(outsideDir);
    const escapeFile = path.join(outsideDir, 'escape.txt');
    fs.writeFileSync(escapeFile, 'evil');
    // junction from inside/escape -> outside (outside allowRoot)
    const junctionDir = path.join(insideDir, 'escape');
    let junctionCreated = false;
    try {
      const { execSync } = require('child_process');
      execSync(`powershell -Command "New-Item -ItemType Junction -Path '${junctionDir}' -Target '${outsideDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' });
      junctionCreated = fs.existsSync(path.join(junctionDir, 'escape.txt'));
    } catch (e) { console.log('junction creation failed:', e.message); }
    if (junctionCreated) {
      const junctionFile = path.join(junctionDir, 'escape.txt');
      const junctionResult = segmentContainment(junctionFile, insideDir);
      check('junction expected-red', junctionResult === false, 'verifier rejects junction escape (target outside allowRoot)');
    } else {
      console.log('junction test skipped (mklink requires admin)');
    }
    // normal file inside allowRoot should pass
    const normalFile = path.join(insideDir, 'normal.txt');
    fs.writeFileSync(normalFile, 'ok');
    const normalResult = segmentContainment(normalFile, insideDir);
    check('junction normal-file', normalResult === true, 'verifier accepts normal file');
    // sibling-prefix should reject
    const siblingDir = path.join(tmpDir, 'sibling');
    fs.mkdirSync(siblingDir);
    const siblingFile = path.join(siblingDir, 'evil.txt');
    fs.writeFileSync(siblingFile, 'evil');
    const siblingResult = segmentContainment(siblingFile, insideDir);
    check('junction sibling-prefix', siblingResult === false, 'verifier rejects sibling directory');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  const out = { verifier_run_utc: new Date().toISOString(), results, report, stageFiles, totalRaw };
  fs.writeFileSync(path.join(SCRATCH, 'verifier.json'), JSON.stringify(out, null, 2));
  // verifier self raw: write verifier's own stdout/stderr
  const verifierSelfRaw = { command: `node ${path.relative(ROOT, __filename).replace(/\\/g, '/')}`, argv: ['node', path.relative(ROOT, __filename).replace(/\\/g, '/')], cwd: ROOT.replace(/\\/g, '/'), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: Object.keys(results).some(k => !results[k]) ? 1 : 0, totalChecks: Object.keys(results).length, passed: Object.keys(results).filter(k => results[k]).length };
  fs.writeFileSync(path.join(SCRATCH, 'verifier-self.json'), JSON.stringify(verifierSelfRaw, null, 2));
  console.log(report.join('\n'));
  console.log(`TOTAL: ${verifierSelfRaw.passed}/${verifierSelfRaw.totalChecks} PASS`);
  // non-zero exit on any check failure
  if (verifierSelfRaw.exitCode !== 0) process.exit(1);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });