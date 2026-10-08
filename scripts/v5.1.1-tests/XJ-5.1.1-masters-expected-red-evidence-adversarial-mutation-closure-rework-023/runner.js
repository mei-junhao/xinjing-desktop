// 023 adversarial mutation runner: >=9 mutations against verifier (baseline PASS -> mutated FAIL -> restore PASS)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-adversarial-mutation-closure-rework-023');
const SRC_022 = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-stage-self-binding-rework-022', 'expected-red');
const VERIFIER = path.join(ROOT, 'scripts', 'v5.1.1-tests', 'XJ-5.1.1-masters-expected-red-evidence-stage-self-binding-rework-022', 'verifier.js');
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex').toUpperCase(); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const results = { meta: { run_id: 'run-511-023-20260826T094604Z', now_utc: new Date().toISOString() }, mutations: {} };

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function runVerifier(evidenceDir) {
  const startUtc = new Date().toISOString();
  try {
    const result = childProcess.spawnSync('node', [VERIFIER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { XJ_023_EVIDENCE_DIR: evidenceDir }),
      timeout: 30000,
      stdio: 'pipe',
      windowsHide: true,
    });
    return {
      exitCode: result.status,
      stdout: (result.stdout || '').toString().slice(0, 2000),
      stderr: (result.stderr || '').toString().slice(0, 2000),
      startUtc,
      endUtc: new Date().toISOString(),
      passed: (result.stdout || '').toString().includes('PASS'),
    };
  } catch (e) {
    return { exitCode: -1, error: e.message, startUtc, endUtc: new Date().toISOString() };
  }
}

async function main() {
  fs.mkdirSync(path.join(SCRATCH, 'expected-red'), { recursive: true });
  const baselineDir = path.join(SCRATCH, 'expected-red', 'baseline');
  const mutatedDir = path.join(SCRATCH, 'expected-red', 'mutated');
  const restoredDir = path.join(SCRATCH, 'expected-red', 'restored');

  // Copy 022 evidence as baseline
  copyDir(SRC_022, baselineDir);
  results.baseline = runVerifier(baselineDir);
  console.log('BASELINE:', results.baseline.exitCode, results.baseline.passed);

  const mutations = [
    { id: 'am1', name: '删rawStdout/rawStderr', run: (d) => {
      const fp = path.join(d, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      delete j.rawStdout; delete j.rawStderr;
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am2', name: '伪造SHA/bytes', run: (d) => {
      const fp = path.join(d, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.rawStdout) { j.rawStdout.sha256 = 'DEADBEEF'; j.rawStdout.bytes += 99; }
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am3', name: '跨case raw', run: (d) => {
      const s1 = path.join(d, 'raw', 'er1', 'baseline.json');
      const s2 = path.join(d, 'raw', 'er2', 'baseline.json');
      const j1 = JSON.parse(fs.readFileSync(s1, 'utf8'));
      if (j1.rawStdout) {
        const j2 = JSON.parse(fs.readFileSync(s2, 'utf8'));
        j2.rawStdout = j1.rawStdout; // cross-case binding
        fs.writeFileSync(s2, JSON.stringify(j2, null, 2));
      }
    }},
    { id: 'am4', name: 'sibling/.. 路径', run: (d) => {
      const fp = path.join(d, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.rawStdout) j.rawStdout.rel = '../019/evil.txt';
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am5', name: '真实Junction外逃', run: (d) => {
      try {
        const juncDir = path.join(d, 'junction');
        const outsideDir = path.join(ROOT, 'qa', 'task-scratch', 'XJ-5.1.1-masters-expected-red-evidence-stage-self-binding-rework-022');
        childProcess.execSync(`powershell -Command "New-Item -ItemType Junction -Path '${juncDir}' -Target '${outsideDir}' -Force | Out-Null"`, { stdio: 'ignore', shell: 'cmd.exe' });
        // replace er1 baseline.json rawStdout rel to point through junction
        const fp = path.join(d, 'raw', 'er1', 'baseline.json');
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (j.rawStdout) {
          const juncFile = path.join(juncDir, 'raw', 'er1', 'baseline.stdout');
          j.rawStdout.rel = path.relative(ROOT, juncFile).replace(/\\/g, '/');
          fs.writeFileSync(fp, JSON.stringify(j, null, 2));
        }
      } catch (e) { console.log('AM5 junction skipped:', e.message); }
    }},
    { id: 'am6', name: 'ER7扁平化', run: (d) => {
      const fp = path.join(d, 'raw', 'er7', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (j.round) {
        const r = typeof j.round === 'string' ? JSON.parse(j.round) : j.round;
        r.gridTemplateColumns = '0px'; // flatten to zero
        r.tops = [0, 0, 0];
        j.round = JSON.stringify(r);
        fs.writeFileSync(fp, JSON.stringify(j, null, 2));
      }
    }},
    { id: 'am7', name: '只总数', run: (d) => {
      const resultsPath = path.join(d, 'results.json');
      const sum = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      sum.variants = { _fraud: 'only totals, no per-variant detail' };
      fs.writeFileSync(resultsPath, JSON.stringify(sum, null, 2));
    }},
    { id: 'am8', name: '旧raw复用', run: (d) => {
      const fp = path.join(d, 'raw', 'er1', 'baseline.json');
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      j.startUtc = '2020-01-01T00:00:00Z'; // ancient timestamp
      fs.writeFileSync(fp, JSON.stringify(j, null, 2));
    }},
    { id: 'am9', name: '删verifier-self raw', run: (d) => {
      const vp = path.join(d, 'verifier.json');
      if (fs.existsSync(vp)) fs.unlinkSync(vp);
    }},
  ];

  for (const m of mutations) {
    // fresh copy for each mutation
    if (fs.existsSync(mutatedDir)) fs.rmSync(mutatedDir, { recursive: true, force: true });
    copyDir(baselineDir, mutatedDir);
    try { m.run(mutatedDir); } catch (e) { console.log(m.id, 'mutation error:', e.message); }
    const out = runVerifier(mutatedDir);
    out.mutation = m.id;
    out.mutationName = m.name;
    results.mutations[m.id] = out;
    console.log(m.id.toUpperCase() + ':', m.name, 'exit:', out.exitCode, 'passed:', out.passed);
  }

  // restore: baseline should still pass
  results.restored = runVerifier(baselineDir);
  console.log('RESTORED:', results.restored.exitCode, results.restored.passed);

  const summaryPath = path.join(SCRATCH, 'expected-red', 'results.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  const kills = Object.values(results.mutations).filter(m => !m.passed).length;
  console.log(`KILLED: ${kills}/${Object.keys(results.mutations).length}`);
}
main().catch(e => { console.error('FAIL', e); process.exitCode = 1; });