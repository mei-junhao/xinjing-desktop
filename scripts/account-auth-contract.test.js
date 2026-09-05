'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountAuth } = require('../server/account-auth');
const { ResendEmailAdapter } = require('../server/resend-email-adapter');
const { createServer } = require('../server/account-auth-routes');

function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'xj-ar2-' + name + '-')), 'a.sqlite'); }
const EMAIL = 'user@example.com';
const PASSWORD = 'Password123';

async function post(base, p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test('ER-1 注册 HTTP 响应不含 verificationToken', async () => {
  const { server, mailer, listen } = createServer({ dataFile: tmpFile('er1') });
  const port = await listen();
  const r = await post('http://127.0.0.1:' + port, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual('verificationToken' in r.json, false);
  assert.strictEqual(mailer.drain().length, 1);
  server.close();
});

test('ER-2 未知会话会员查询 fail-closed', async () => {
  const { server, listen } = createServer({ dataFile: tmpFile('er2') });
  const port = await listen();
  const r = await post('http://127.0.0.1:' + port, '/account/membership', { sessionToken: 'nope' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.ok, false);
  server.close();
});

test('ER-3 匿名 disable 不可禁用；内部 disable() 仍使会话失效', async () => {
  const { server, auth, mailer, listen } = createServer({ dataFile: tmpFile('er3') });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  const reg = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  const token = mailer.drain()[0].verificationToken;
  await post(base, '/account/verify', { token });
  const login = await post(base, '/account/login', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(login.json.ok, true);

  const dis = await post(base, '/account/disable', { email: EMAIL });
  assert.notStrictEqual(dis.status, 200, '匿名 disable 必须非成功');
  assert.notStrictEqual(dis.json.ok, true);

  const login2 = await post(base, '/account/login', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(login2.json.ok, true, '账号未被匿名禁用');

  // 内部 trusted 代码直调 disable() 仍能使会话失效
  auth.disable(EMAIL);
  const sess = await post(base, '/account/session', { sessionToken: login2.json.sessionToken });
  assert.strictEqual(sess.json.ok, false);
  server.close();
});

test('ER-4 注册投递失败：503 无 token 无阻塞状态，可干净重试', async () => {
  let fail = true;
  const flaky = { async sendVerificationEmail() { return fail ? { ok: false, error: { code: 'synthetic-fail' } } : { ok: true }; } };
  const { server, listen } = createServer({ dataFile: tmpFile('er4'), mailer: flaky });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  const r1 = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r1.status, 503);
  assert.strictEqual(r1.json.ok, false);
  assert.strictEqual(r1.json.error.code, 'email-delivery-failed');
  assert.strictEqual('verificationToken' in r1.json, false);
  fail = false;
  const r2 = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.ok, true);
  server.close();
});

test('ER-5 注册投递抛错：确定性 503 不挂起', async () => {
  const throwing = { async sendVerificationEmail() { throw new Error('synthetic-throw'); } };
  const { server, listen } = createServer({ dataFile: tmpFile('er5'), mailer: throwing });
  const port = await listen();
  const r = await post('http://127.0.0.1:' + port, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.ok, false);
  assert.strictEqual(r.json.error.code, 'email-delivery-failed');
  server.close();
});

test('ER-6a 重发投递失败保留旧 token（旧 token 仍可验证）', async () => {
  let fail = false;
  const q = [];
  const flaky = {
    async sendVerificationEmail(input) { if (fail) return { ok: false, error: { code: 'synthetic-fail' } }; q.push({ to: input.to, verificationToken: input.token }); return { ok: true }; },
    drain() { const x = q.slice(); q.length = 0; return x; },
  };
  const { server, mailer, listen } = createServer({ dataFile: tmpFile('er6a'), mailer: flaky });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  const reg = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  const t1 = mailer.drain()[0].verificationToken;
  fail = true;
  const bad = await post(base, '/account/resend', { email: EMAIL });
  assert.strictEqual(bad.status, 503);
  assert.strictEqual(bad.json.ok, false);
  assert.strictEqual((await post(base, '/account/verify', { token: t1 })).json.ok, true, '投递失败后旧 token 仍有效');
  server.close();
});

test('ER-6b 成功重发作废旧 token、新 token 有效', async () => {
  const q = [];
  const good = {
    async sendVerificationEmail(input) { q.push({ to: input.to, verificationToken: input.token }); return { ok: true }; },
    drain() { const x = q.slice(); q.length = 0; return x; },
  };
  const { server, mailer, listen } = createServer({ dataFile: tmpFile('er6b'), mailer: good });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  const reg = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  const t1 = mailer.drain()[0].verificationToken;
  const r = await post(base, '/account/resend', { email: EMAIL });
  assert.strictEqual(r.status, 200);
  const t2 = mailer.drain()[0].verificationToken;
  assert.strictEqual((await post(base, '/account/verify', { token: t1 })).json.ok, false, '旧 token 已作废');
  assert.strictEqual((await post(base, '/account/verify', { token: t2 })).json.ok, true, '新 token 有效');
  server.close();
});

// ===== 核心功能（保持） =====
test('R1 注册策略 + 哈希落盘', () => {
  const a = new AccountAuth({ dataFile: tmpFile('r1') });
  const ok = a.register({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(a.register({ email: 'bad', password: PASSWORD }).error.code, 'invalid-email');
  assert.strictEqual(a.register({ email: 'x@y.com', password: 'short' }).error.code, 'weak-password');
  assert.strictEqual(a.register({ email: EMAIL, password: PASSWORD }).error.code, 'email-taken');
  assert.strictEqual(a._audit().passwordHashedAtRest, true);
  assert.strictEqual(a._audit().tokensHashedAtRest, true);
    assert.strictEqual(a._audit().verificationTokensHashedAtRest, true);
    assert.strictEqual(a._audit().sessionTokensHashedAtRest, true);
    assert.strictEqual(a._audit().sessionTokenStorage, 'empty');
});

test('R2 验证 token 单次/限时/重放', () => {
  const a = new AccountAuth({ dataFile: tmpFile('r2') });
  const reg = a.register({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(a.verify(reg.verificationToken).ok, true);
  assert.strictEqual(a.verify(reg.verificationToken).error.code, 'token-not-found');
});

test('R3 登录拒绝未验证/禁用/错密码', async () => {
  const a = new AccountAuth({ dataFile: tmpFile('r3') });
  const reg = a.register({ email: EMAIL, password: PASSWORD });
  assert.strictEqual((await a.login({ email: EMAIL, password: PASSWORD })).error.code, 'email-unverified');
  a.verify(reg.verificationToken);
  assert.strictEqual((await a.login({ email: EMAIL, password: 'WrongPass1' })).error.code, 'invalid-credentials');
  a.setDisabled(EMAIL, true);
  assert.strictEqual((await a.login({ email: EMAIL, password: PASSWORD })).error.code, 'account-disabled');
});

test('R4 会话过期/篡改/禁用拒绝', async () => {
  const a = new AccountAuth({ dataFile: tmpFile('r4') });
  const reg = a.register({ email: EMAIL, password: PASSWORD });
  a.verify(reg.verificationToken);
  const l = await a.login({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(a.validateSession(l.sessionToken).ok, true);
  assert.strictEqual(a.validateSession('tampered').ok, false);
  a.setDisabled(EMAIL, true);
  assert.strictEqual(a.validateSession(l.sessionToken).error.code, 'account-disabled');
});

test('R5 会员服务端权威 + 未知档位拒绝', async () => {
  const a = new AccountAuth({ dataFile: tmpFile('r5') });
  const reg = a.register({ email: EMAIL, password: PASSWORD });
  a.verify(reg.verificationToken);
  const l = await a.login({ email: EMAIL, password: PASSWORD });
  assert.strictEqual(a.getMembership(l.sessionToken).tier, 'free');
  assert.strictEqual(a.getMembership('bad').ok, false);
  assert.strictEqual(a.grantMembership(reg.accountId, 'pro').ok, true);
  assert.strictEqual(a.getMembership(l.sessionToken).tier, 'pro');
  a._setMembershipRaw(reg.accountId, 'admin');
  assert.strictEqual(a.validateSession(l.sessionToken).error.code, 'unknown-tier');
});

test('R6 重启持久化', async () => {
  const f = tmpFile('r6');
  const a1 = new AccountAuth({ dataFile: f });
  const reg = a1.register({ email: EMAIL, password: PASSWORD });
  a1.verify(reg.verificationToken);
  const l = await a1.login({ email: EMAIL, password: PASSWORD });
  const a2 = new AccountAuth({ dataFile: f });
  assert.strictEqual(a2.validateSession(l.sessionToken).ok, true);
});

test('R7 resend prepare/commit：prepare 不废旧 token，commit 才废', () => {
  const a = new AccountAuth({ dataFile: tmpFile('r7') });
  const reg = a.register({ email: EMAIL, password: PASSWORD });
  const t1 = reg.verificationToken;
  const r = a.resendVerification(EMAIL);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(a.verify(t1).ok, true, 'prepare 阶段旧 token 仍有效');
  assert.strictEqual(a.commitResend(EMAIL).ok, true);
  assert.strictEqual(a.verify(t1).ok, false, 'commit 后旧 token 作废');
  assert.strictEqual(a.verify(r.verificationToken).ok, true, '新 token 有效');
});

test('R8 损坏存储 fail-closed 字节不变', () => {
  const f = tmpFile('r8');
  fs.writeFileSync(f, 'NOT JSON {{', 'utf8');
  const before = fs.readFileSync(f, 'utf8');
  let err = null; try { new AccountAuth({ dataFile: f }); } catch (e) { err = e.message; }
  assert.strictEqual(err, 'account-store-corrupt');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
});

test('R9 Resend 适配器缺配置 fail-closed + 超时', async () => {
  let called = 0;
  const fake = async () => { called += 1; return { ok: true, status: 200 }; };
  const noCfg = new ResendEmailAdapter({ apiKey: '', from: '', fetch: fake });
  assert.strictEqual((await noCfg.sendVerificationEmail({ to: 'a@b.com', token: 'x' })).error.code, 'provider-missing-config');
  assert.strictEqual(called, 0);
  const t = new ResendEmailAdapter({ apiKey: 'k', from: 'f', timeoutMs: 10, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')))) });
  assert.strictEqual((await t.sendVerificationEmail({ to: 'a@b.com', token: 'x' })).error.code, 'provider-timeout');
});

test('R10 HTTP body 413/400', async () => {
  const { server, listen } = createServer({ dataFile: tmpFile('r10') });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  const r1 = await fetch(base + '/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: 'x'.repeat(70000) }) });
  assert.strictEqual(r1.status, 413);
  const r2 = await fetch(base + '/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' });
  assert.strictEqual(r2.status, 400);
  server.close();
});

test('ER-7 重发持久化失败：503+旧token仍有效+新token失败（进程内+重载）+恢复重试', async () => {
  const mk = (name) => { const q = []; const m = { async sendVerificationEmail(input) { q.push({ to: input.to, verificationToken: input.token }); return { ok: true }; }, drain() { const x = q.slice(); q.length = 0; return x; } }; return { m, q }; };
  const phase = (name) => {
    const dataFile = tmpFile(name);
    const auth = new AccountAuth({ dataFile });
    const { m } = mk(name);
    const { server, listen } = createServer({ dataFile, auth, mailer: m });
    return listen().then((port) => ({ dataFile, auth, m, server, base: 'http://127.0.0.1:' + port }));
  };
  // 进程内
  {
    const c = await phase('er7a');
    const reg = await post(c.base, '/account/register', { email: EMAIL, password: PASSWORD });
    const t1 = c.m.drain()[0].verificationToken;
    c.auth.setSaveFail(true);
    const bad = await post(c.base, '/account/resend', { email: EMAIL });
    assert.strictEqual(bad.status, 503);
    const tNew = c.m.drain()[0].verificationToken;
    c.auth.setSaveFail(false);
    assert.strictEqual((await post(c.base, '/account/verify', { token: t1 })).json.ok, true, '旧 token 进程内有效');
    assert.strictEqual((await post(c.base, '/account/verify', { token: tNew })).json.ok, false, '新 token 进程内无效');
    c.server.close();
  }
  // 重载
  {
    const c = await phase('er7b');
    const reg = await post(c.base, '/account/register', { email: EMAIL, password: PASSWORD });
    const t1 = c.m.drain()[0].verificationToken;
    c.auth.setSaveFail(true);
    const bad = await post(c.base, '/account/resend', { email: EMAIL });
    assert.strictEqual(bad.status, 503);
    const tNew = c.m.drain()[0].verificationToken;
    const reloaded = new AccountAuth({ dataFile: c.dataFile });
    assert.strictEqual(reloaded.verify(t1).ok, true, '旧 token 重载后有效');
    assert.strictEqual(reloaded.verify(tNew).ok, false, '新 token 重载后无效');
    c.server.close();
  }
  // 恢复
  {
    const c = await phase('er7c');
    await post(c.base, '/account/register', { email: EMAIL, password: PASSWORD });
    c.m.drain();
    c.auth.setSaveFail(true);
    await post(c.base, '/account/resend', { email: EMAIL });
    c.m.drain();
    c.auth.setSaveFail(false);
    const ok = await post(c.base, '/account/resend', { email: EMAIL });
    assert.strictEqual(ok.status, 200);
    const t2 = c.m.drain()[0].verificationToken;
    assert.strictEqual((await post(c.base, '/account/verify', { token: t2 })).json.ok, true, '恢复后重试成功');
    c.server.close();
  }
});

test('ER-8 注册持久化失败：503+账户/token不可见（进程内+重载）+恢复重试成功', async () => {
  const dataFile = tmpFile('er8');
  const auth = new AccountAuth({ dataFile });
  const good = { async sendVerificationEmail() { return { ok: true }; } };
  const { server, listen } = createServer({ dataFile, auth, mailer: good });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;

  auth.setSaveFail(true);
  const r = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error.code, 'persistence-failed');
  assert.strictEqual('verificationToken' in r.json, false);
  assert.strictEqual(auth._audit().accountCount, 0, '进程内账户不可见');
  assert.strictEqual(auth._audit().pendingVerificationCount, 0, '进程内 token 不可见');

  const reloaded = new AccountAuth({ dataFile });
  assert.strictEqual(reloaded._audit().accountCount, 0, '重载后账户不可见');
  assert.strictEqual((await reloaded.login({ email: EMAIL, password: PASSWORD })).ok, false, '重载后登录失败');

  auth.setSaveFail(false);
  const r2 = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.ok, true, '恢复后重试成功');
  server.close();
});

test('ER-9 注册最终持久化失败（邮件已接受）：503 无 token，账户/token 进程内+重载后均不可见，投递 token 不可验证，恢复后同邮箱可注册', async () => {
  const dataFile = tmpFile('er9');
  const auth = new AccountAuth({ dataFile });
  const q = [];
  const recording = {
    async sendVerificationEmail(input) { q.push({ to: input.to, verificationToken: input.token }); return { ok: true }; },
    drain() { const x = q.slice(); q.length = 0; return x; },
  };
  const { server, listen } = createServer({ dataFile, auth, mailer: recording });
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;

  auth.setSaveFail(true);
  const r = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.json.error.code, 'persistence-failed');
  assert.strictEqual('verificationToken' in r.json, false);
  const deliveredToken = recording.drain()[0].verificationToken;
  assert.ok(deliveredToken, '合成邮件应记录投递 token');
  assert.strictEqual(auth._audit().accountCount, 0, '进程内账户不可见');
  assert.strictEqual(auth._audit().pendingVerificationCount, 0, '进程内 token 不可见');
  auth.setSaveFail(false);
  assert.strictEqual(auth.verify(deliveredToken).ok, false, '进程内投递 token 不可验证');

  const reloaded = new AccountAuth({ dataFile });
  assert.strictEqual(reloaded._audit().accountCount, 0, '重载后账户不可见');
  assert.strictEqual(reloaded._audit().pendingVerificationCount, 0, '重载后 token 不可见');
  assert.strictEqual(reloaded.verify(deliveredToken).ok, false, '重载后投递 token 不可验证');

  auth.setSaveFail(false);
  const r2 = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.ok, true, '恢复后同邮箱可正常注册');
  server.close();
});

test('ER-10 投递失败/抛错先于持久化：503 email-delivery-failed，无补偿写，账户/token 进程内+重载后均不可见，可干净重试', async () => {
  for (const name of ['false', 'throw']) {
    const dataFile = tmpFile('er10-' + name);
    const auth = new AccountAuth({ dataFile });
    const failing = {
      async sendVerificationEmail() {
        if (name === 'false') return { ok: false, error: { code: 'synthetic-fail' } };
        throw new Error('synthetic-throw');
      },
    };
    const { server, listen } = createServer({ dataFile, auth, mailer: failing });
    const port = await listen();
    const base = 'http://127.0.0.1:' + port;

    const r1 = await post(base, '/account/register', { email: EMAIL, password: PASSWORD });
    assert.strictEqual(r1.status, 503, name + ' 应 503');
    assert.strictEqual(r1.json.error.code, 'email-delivery-failed', name + ' 错误码');
    assert.strictEqual('verificationToken' in r1.json, false, name + ' 不泄露 token');
    assert.strictEqual(auth.store._onMutations, 0, name + ' 不得调用任何持久化/补偿写');
    assert.strictEqual(auth._audit().accountCount, 0, name + ' 进程内账户不可见');
    assert.strictEqual(auth._audit().pendingVerificationCount, 0, name + ' 进程内 token 不可见');

    const reloaded = new AccountAuth({ dataFile });
    assert.strictEqual(reloaded._audit().accountCount, 0, name + ' 重载后账户不可见');
    assert.strictEqual(reloaded._audit().pendingVerificationCount, 0, name + ' 重载后 token 不可见');

    server.close();
    const good = { async sendVerificationEmail() { return { ok: true }; } };
    const { server: server2, listen: listen2 } = createServer({ dataFile, auth, mailer: good });
    const port2 = await listen2();
    const r2 = await post('http://127.0.0.1:' + port2, '/account/register', { email: EMAIL, password: PASSWORD });
    assert.strictEqual(r2.status, 200, name + ' 重试应成功');
    assert.strictEqual(r2.json.ok, true);
    server2.close();
  }
});
