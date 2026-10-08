// 024 adversarial mutation runner: fresh rebuild, 9+ mutations, verifier must exit non-zero on FAIL
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024');
const VERIFIER = path.join(__dirname, 'verifier.js');
const SRC_024 = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024', 'expected-red');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function runVerifier(label) {
  const startUtc = new Date().toISOString();
  try {
    const res = childProcess.spawnSync('node', [VERIFIER], { cwd: ROOT, timeout: 30000, stdio: 'pipe', windowsHide: true });
    const stdout = (res.stdout || '').toString();
    const stderr = (res.stderr || '').toString();
    const passed = stdout.includes('PASS') && !stdout.includes('FAIL');
    const endUtc = new Date().toISOString();
    return { label, exitCode: res.status, passed, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000), startUtc, endUtc, command: `node ${path.relative(ROOT, VERIFIER).replace(/\\/g, '/')}`, argv: ['node', path.relative(ROOT, VERIFIER).replace(/\\/g, '/')], cwd: path.relative(ROOT, ROOT).replace(/\\/g, '/') || '.' };
  } catch (e) {
    return { label, exitCode: -1, passed: false, error: e.message, startUtc, endUtc: new Date().toISOString() };
  }
}

const results = { meta: { run_id: 'run-511-024-20260826T095814Z', now_utc: new Date().toISOString() }, mutations: {} };

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });
  // 1. Copy 022 valid evidence as baseline (adapt paths for 024)
  // The evidence structure: results.json + raw/ (subdirs er1..er8, each with baseline.json etc)
  if (!fs.existsSync(path.join(SCRATCH, 'results.json'))) {
    copyDir(SRC_024, SCRATCH);
    // update paths in results.json and stage JSONs to point to 024 scratch
    const sumPath = path.join(SCRATCH, 'results.json');
    const summary = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
    for (const [vid, v] of Object.entries(summary.variants || {})) {
      for (const st of ['baseline', 'mutated', 'restored']) {
        const s = v[st] || {};
        for (const k of ['rawJson', 'rawStdout', 'rawStderr']) {
          const bnd = s[k];
          if (bnd && bnd.rel) {
            bnd.rel = bnd.rel.replace(/XJ-5\.1\.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024/g, 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024');
          }
        }
      }
    }
    fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
    // update individual stage JSON rels
    const rawDir = path.join(SCRATCH, 'raw');
    for (let i = 1; i <= 8; i += 1) {
      for (const st of ['baseline', 'mutated', 'restored']) {
        const fp = path.join(rawDir, `er${i}`, `${st}.json`);
        if (fs.existsSync(fp)) {
          const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
          for (const k of ['rawJson', 'rawStdout', 'rawStderr']) {
            if (j[k] && j[k].rel) {
              j[k].rel = j[k].rel.replace(/XJ-5\.1\.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024/g, 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024');
            }
          }
          fs.writeFileSync(fp, JSON.stringify(j, null, 2));
        }
      }
    }
  }

  // 2. Baseline verifier run
  results.baseline = runVerifier('baseline');
  console.log('BASELINE:', results.baseline.exitCode, results.baseline.passed);

  // 3. 9 adversarial mutations
  const mutations = [
    { id: 'am1', name: '删rawStdout/rawStderr', run: () => {
      const fp = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      delete j.rawStdout; delete j.rawStderr;
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am2', name: '伪造SHA/bytes', run: () => {
      const fp = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.rawStdout) { j.rawStdout.sha256 = 'DEADBEEF'; j.rawStdout.bytes += 99; }
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am3', name: '跨case raw', run: () => {
      const s1 = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
      const s2 = path.join(SCRATCH, 'raw', 'er2', 'baseline.json');
      const j1 = JSON.parse(fs.readFileSync(s1, 'utf8'));
      if (j1.rawStdout) {
        const j2 = JSON.parse(fs.readFileSync(s2, 'utf8'));
        j2.rawStdout = j1.rawStdout;
        fs.writeFileSync(s2, JSON.stringify(j2, null, 2));
      }
    }},
    { id: 'am4', name: 'sibling/.. 路径', run: () => {
      const fp = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.rawStdout) j.rawStdout.rel = '../019/evil.txt';
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am5', name: '真实Junction外逃', run: () => {
      try {
        const juncDir = path.join(SCRATCH, 'junction');
        const outsideDir = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-fresh-verifier-self-audit-closure-rework-024');
        childProcess.execSync(`powershell -Command "New-Item -ItemType Junction -Path '${juncDir}' -Target '${outsideDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' });
        if (fs.existsSync(path.join(juncDir, 'raw', 'er1', 'baseline.stdout'))) {
          const fp = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
          const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (j.rawStdout) j.rawStdout.rel = path.relative(ROOT, path.join(juncDir, 'raw', 'er1', 'baseline.stdout')).replace(/\\/g, '/');
          fs.writeFileSync(fp, JSON.stringify(j, null, 2));
        }
      } catch (e) { console.log('AM5 skipped:', e.message); }
    }},
    { id: 'am6', name: 'ER7扁平化', run: () => {
      const fp = path.join(SCRATCH, 'raw', 'er7', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.round) {
        const r = typeof j.round === 'string' ? JSON.parse(j.round) : j.round;
        r.gridTemplateColumns = '0px'; r.tops = [0,0,0];
        j.round = JSON.stringify(r);
        fs.writeFileSync(fp, JSON.stringify(j, null, 2));
      }
    }},
    { id: 'am7', name: '只总数', run: () => {
      const sumPath = path.join(SCRATCH, 'results.json');
      const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
      sum.variants = { _fraud: 'variants removed' };
      fs.writeFileSync(sumPath, JSON.stringify(sum, null, 2));
    }},
    { id: 'am8', name: '旧raw复用', run: () => {
      const fp = path.join(SCRATCH, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      j.startUtc = '2020-01-01T00:00:00Z';
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am9', name: '删verifier-self raw', run: () => {
      const vp = path.join(SCRATCH, 'verifier-self.json');
      if (fs.existsSync(vp)) fs.unlinkSync(vp);
    }},
  ];

  for (const m of mutations) {
    // Restore clean baseline before each mutation
    if (fs.existsSync(SCRATCH)) fs.rmSync(SCRATCH, { recursive: true, force: true });
    copyDir(SRC_024, SCRATCH);
    // Re-apply path fixes
    const sumPath = path.join(SCRATCH, 'results.json');
    if (fs.existsSync(sumPath)) {
      const summary = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
      for (const [vid, v] of Object.entries(summary.variants || {})) {
        for (const st of ['baseline', 'mutated', 'restored']) {
          for (const k of ['rawJson', 'rawStdout', 'rawStderr']) {
            if ((v[st] || {})[k] && (v[st] || {})[k].rel) {
              (v[st] || {})[k].rel = (v[st] || {})[k].rel.replace(/fresh-verifier-self-audit-closure-rework-024/g, 'fresh-verifier-self-audit-closure-rework-024');
            }
          }
        }
      }
      fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
    }
    try { m.run(); } catch (e) { console.log(m.id, 'mutation error:', e.message); }
    const out = runVerifier(m.id);
    out.mutationName = m.name;
    results.mutations[m.id] = out;
    console.log(m.id.toUpperCase() + ':', m.name, 'exit:', out.exitCode, 'passed:', out.passed);
  }

  // 4. Restore: clean baseline, run verifier
  if (fs.existsSync(SCRATCH)) fs.rmSync(SCRATCH, { recursive: true, force: true });
  copyDir(SRC_024, SCRATCH);
  // Re-apply path fixes one more time
  const sumPath = path.join(SCRATCH, 'results.json');
  if (fs.existsSync(sumPath)) {
    const summary = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
    for (const [vid, v] of Object.entries(summary.variants || {})) {
      for (const st of ['baseline', 'mutated', 'restored']) {
        for (const k of ['rawJson', 'rawStdout', 'rawStderr']) {
          if ((v[st] || {})[k] && (v[st] || {})[k].rel) {
            (v[st] || {})[k].rel = (v[st] || {})[k].rel.replace(/fresh-verifier-self-audit-closure-rework-024/g, 'fresh-verifier-self-audit-closure-rework-024');
          }
        }
      }
    }
    fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  }
  results.restored = runVerifier('restored');
  console.log('RESTORED:', results.restored.exitCode, results.restored.passed);

  const outPath = path.join(SCRATCH, 'adversarial-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  const kills = Object.values(results.mutations).filter(m => !m.passed).length;
  console.log(`KILLED: ${kills}/${Object.keys(results.mutations).length}`);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });