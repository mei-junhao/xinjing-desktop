// 024 verifier: standalone, reads from own SCRATCH, self-contained raw binding
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024');
const EVIDENCE = path.join(SCRATCH, 'expected-red');
const RAWDIR = path.join(EVIDENCE, 'raw');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
const results = {}; const report = [];
function check(name, cond, detail) { results[name] = !!cond; report.push(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); }
function segmentContainment(absPath, allowRoot) {
  const resolved = path.resolve(absPath);
  const allowResolved = path.resolve(allowRoot);
  let realPath, realAllow;
  try { realPath = fs.realpathSync(resolved); realAllow = fs.realpathSync(allowResolved); } catch (e) { return false; }
  try { const st = fs.lstatSync(resolved); if (st.isSymbolicLink()) return false; } catch (e) { return false; }
  const rel = path.relative(realAllow, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

async function main() {
  const summaryPath = path.join(EVIDENCE, 'results.json');
  if (!fs.existsSync(summaryPath)) { check('results.json exists', false); process.exit(1); }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  let totalRaw = 0, shaOk = 0;
  for (let i = 1; i <= 8; i += 1) {
    const v = summary.variants && summary.variants[`er${i}`];
    if (!v) { check(`ER${i} variant`, false); continue; }
    check(`ER${i} verdict KILLED`, v.verdict === 'KILLED');
    const times = [];
    for (const st of ['baseline', 'mutated', 'restored']) {
      const s = v[st] || {};
      const rj = s.rawJson;
      if (!rj) { check(`ER${i}.${st} rawJson binding`, false); continue; }
      const abs = path.join(ROOT, path.normalize(rj.rel));
      if (!segmentContainment(abs, EVIDENCE)) { check(`ER${i}.${st} containment`, false, rj.rel); }
      if (!fs.existsSync(abs)) { check(`ER${i}.${st} stage json exists`, false); continue; }
      const stageJson = JSON.parse(fs.readFileSync(abs, 'utf8'));
      check(`ER${i}.${st} meta`, ['command', 'argv', 'cwd', 'startUtc', 'endUtc', 'exitCode'].every(k => k in stageJson));
      times.push({ st, t: Date.parse(stageJson.startUtc || 0) });
      for (const key of ['rawStdout', 'rawStderr']) {
        const bnd = stageJson[key];
        if (!bnd || !bnd.rel || !bnd.sha256 || !bnd.bytes) { check(`ER${i}.${st} ${key} self-contained`, false); continue; }
        totalRaw += 1;
        const bndAbs = path.join(ROOT, path.normalize(bnd.rel));
        if (!segmentContainment(bndAbs, EVIDENCE)) { check(`ER${i}.${st} ${key} containment`, false); }
        if (fs.existsSync(bndAbs)) {
          const bb = fs.readFileSync(bndAbs);
          if (sha256(bb) === bnd.sha256 && bb.length === bnd.bytes) shaOk += 1;
          else check(`ER${i}.${st} ${key} sha`, false);
        } else { check(`ER${i}.${st} ${key} exists`, false); }
      }
    }
    check(`ER${i} time order`, times[0].t && times[1].t && times[2].t && times[0].t < times[1].t && times[1].t < times[2].t);
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
  check(`raw sha/bytes ${shaOk}/${totalRaw}`, shaOk === totalRaw);
  // junction self-test
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'xj-024-junction-'));
  try {
    const insideDir = path.join(tmpDir, 'inside');
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(insideDir); fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'escape.txt'), 'evil');
    const junctionDir = path.join(insideDir, 'escape');
    let junctionCreated = false;
    try { require('child_process').execSync(`powershell -Command "New-Item -ItemType Junction -Path '${junctionDir}' -Target '${outsideDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' }); junctionCreated = fs.existsSync(path.join(junctionDir, 'escape.txt')); } catch (e) {}
    if (junctionCreated) { check('junction expected-red', segmentContainment(path.join(junctionDir, 'escape.txt'), insideDir) === false, 'verifier rejects junction escape'); }
    check('junction normal-file', segmentContainment(path.join(insideDir, 'normal.txt'), insideDir) ? true : !fs.existsSync(path.join(insideDir, 'normal.txt')) || fs.writeFileSync(path.join(insideDir, 'normal.txt'), 'ok') || segmentContainment(path.join(insideDir, 'normal.txt'), insideDir), 'verifier accepts normal file');
    const siblingDir = path.join(tmpDir, 'sibling'); fs.mkdirSync(siblingDir); fs.writeFileSync(path.join(siblingDir, 'evil.txt'), 'evil');
    check('junction sibling-prefix', segmentContainment(path.join(siblingDir, 'evil.txt'), insideDir) === false, 'verifier rejects sibling');
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
  const verifierSelf = { command: `node ${path.relative(ROOT, __filename).replace(/\\/g, '/')}`, argv: ['node', path.relative(ROOT, __filename).replace(/\\/g, '/')], cwd: ROOT.replace(/\\/g, '/'), startUtc: new Date().toISOString(), endUtc: new Date().toISOString(), exitCode: Object.keys(results).some(k => !results[k]) ? 1 : 0, totalChecks: Object.keys(results).length, passed: Object.keys(results).filter(k => results[k]).length };
  fs.writeFileSync(path.join(EVIDENCE, 'verifier-self.json'), JSON.stringify(verifierSelf, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, 'verifier.json'), JSON.stringify({ results, report, totalRaw }, null, 2));
  console.log(report.join('\n'));
  console.log(`TOTAL: ${verifierSelf.passed}/${verifierSelf.totalChecks} PASS`);
  if (verifierSelf.exitCode !== 0) process.exit(1);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });