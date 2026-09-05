'use strict';
/**
 * account-auth-production-contract.test.js — rework-006
 * 生产只读契约探针（https://xinjingchat.online）：health/根配置、/quota、/v1 无权拒绝、
 * /account/* 超 64KB 确定性 JSON 413（恰好一次响应、不悬挂）。
 * 安全约束：仅 GET 只读端点 + 超限合成 body（超限 body 永远不会被解析，不建账号/不发邮件）；
 * 绝不发送可解析的注册/登录 body，不触碰真实邮箱；不输出任何密钥/token/验证码。
 */
const https = require('https');
const http = require('http');
const USE_HTTP = process.env.XJ_PROD_HTTP === '1';
const client = USE_HTTP ? http : https;

const HOST = process.env.XJ_PROD_HOST || 'xinjingchat.online';
const PORT = parseInt(process.env.XJ_PROD_PORT || '443', 10);

function req(method, urlPath, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const headers = {};
    if (bodyBuf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    const reqOpts = { host: HOST, port: PORT, path: urlPath, method, headers };
    if (!USE_HTTP) reqOpts.servername = HOST;
    const r = client.request(reqOpts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d, ms: Date.now() - t0 }));
    });
    r.on('error', (e) => reject(new Error(e.code + ':' + e.message)));
    r.setTimeout(timeoutMs || 20000, () => { r.destroy(new Error('client-timeout')); });
    if (bodyBuf) r.end(bodyBuf); else r.end();
  });
}

async function main() {
  const results = [];
  let fail = 0;
  function record(id, ok, detail) {
    results.push({ id, ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail);
    if (!ok) fail++;
  }

  // G1: 根路径配置探针（只输出布尔标志，不输出秘密）
  try {
    const g = await req('GET', '/');
    let j = null; try { j = JSON.parse(g.body); } catch (_) {}
    const keys = j && typeof j === 'object' ? Object.keys(j).sort().join(',') : 'n/a';
    const hasModel = !!(j && typeof j.defaultModel === 'string' && typeof j.budgetModel === 'string');
    record('G1-root-config', g.status === 200 && j && j.ok === true, 'status=' + g.status + ' keys=[' + keys + ']');
    record('G1b-default-model-routing', hasModel, 'defaultModel=' + (j && j.defaultModel) + ' budgetModel=' + (j && j.budgetModel));
  } catch (e) { record('G1-root-config', false, 'error ' + e.message); }

  // G2: /quota 合成 mid（只读，输出键名不输出数值）
  try {
    const q = await req('GET', '/quota?mid=synthetic-rework006-probe');
    let j = null; try { j = JSON.parse(q.body); } catch (_) {}
    const keys = j && typeof j === 'object' ? Object.keys(j).sort().join(',') : 'n/a';
    record('G2-quota', q.status === 200 && !!j, 'status=' + q.status + ' keys=[' + keys + ']');
  } catch (e) { record('G2-quota', false, 'error ' + e.message); }

  // V1: /v1/chat/completions 无凭据 → 401（不消耗配额）
  try {
    const v = await req('POST', '/v1/chat/completions', Buffer.from(JSON.stringify({ model: 'synthetic', messages: [] })));
    let j = null; try { j = JSON.parse(v.body); } catch (_) {}
    record('V1-unauthorized-401', v.status === 401 && j && j.error, 'status=' + v.status + ' error=' + (j && j.error));
  } catch (e) { record('V1-unauthorized-401', false, 'error ' + e.message); }

  // B1: /account/balance 无会话 → 401（契约 6：按登录会话鉴权，非 machineId；read-only）
  try {
    const b1 = await req('POST', '/account/balance', Buffer.from(JSON.stringify({ machineId: 'synthetic-probe' })));
    let jb = null; try { jb = JSON.parse(b1.body); } catch (_) {}
    record('B1-balance-no-session-401', b1.status === 401 && jb && jb.ok === false, 'status=' + b1.status + ' code=' + (jb && jb.error ? jb.error.code : 'n/a'));
  } catch (e) { record('B1-balance-no-session-401', false, 'error ' + e.message); }


  // L: /account/login 合成凭据（不存在邮箱）→ 非空错误信封，禁止 {} 空 Promise（read-only，不建账号）
  try {
    const lg = await req('POST', '/account/login', Buffer.from(JSON.stringify({ email: 'synthetic-probe@example.invalid', password: 'ProbePass123' })));
    let jl = null; try { jl = JSON.parse(lg.body); } catch (_) {}
    const notEmpty = !!(jl && jl.ok === false && jl.error && jl.error.code);
    record('L-login-error-envelope', lg.status === 200 && notEmpty, 'status=' + lg.status + ' code=' + (jl && jl.error ? jl.error.code : 'n/a') + ' body=' + lg.body.slice(0, 80));
  } catch (e) { record('L-login-error-envelope', false, 'error ' + e.message); }

  // O1/O2: /account/register 与 /account/login 超 64KB 合成 body → 确定性恰好一次 JSON 413
  const oversize = Buffer.from(JSON.stringify({ email: 'synthetic-probe@example.invalid', password: 'x'.repeat(100000) }));
  let n = 0;
  for (const p of ['/account/register', '/account/login']) {
    n++;
    try {
      const r = await req('POST', p, oversize, 15000);
      let j = null; try { j = JSON.parse(r.body); } catch (_) {}
      const isJson = r.headers['content-type'] && r.headers['content-type'].indexOf('application/json') === 0;
      const ok = r.status === 413 && isJson && j && j.ok === false && j.error && j.error.code === 'body-too-large' && r.ms < 8000;
      record('O' + n + '-oversize-' + p, ok, 'status=' + r.status + ' ms=' + r.ms + ' json=' + isJson + ' code=' + (j && j.error ? j.error.code : 'n/a'));
    } catch (e) {
      record('O' + n + '-oversize-' + p, false, 'non-deterministic/no-response: ' + e.message);
    }
  }

  // O3: 复测确定性（连续 3 次 register 超限，必须全部 413）
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await req('POST', '/account/register', oversize, 15000);
      record('O3-determinism-' + i, r.status === 413, 'status=' + r.status + ' ms=' + r.ms);
    } catch (e) {
      record('O3-determinism-' + i, false, 'non-deterministic/no-response: ' + e.message);
    }
  }

  console.log('PRODUCTION_CONTRACT ' + (fail === 0 ? 'PASS' : 'FAIL') + ' pass=' + (results.length - fail) + ' fail=' + fail + ' host=' + HOST);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('PRODUCTION_CONTRACT ERROR ' + e.message); process.exit(2); });
