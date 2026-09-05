'use strict';
/**
 * account-auth-routes.js — 回环合成验收 harness（rework-004）。
 * 修复：注册/重发响应剔除验证 token；会员查询须有效会话；body 处理确定化（413/400/abort）。
 * 注册改为 staged registration：先 validate/staged → 合成邮件成功 → 单次 clone/persist/swap。
 * 邮件失败/抛错在持久化前返回 503 email-delivery-failed，不回滚；最终持久化失败返回 503 persistence-failed。
 */
const http = require('http');
const { AccountAuth } = require('./account-auth');
const { SyntheticEmailAdapter } = require('./email-adapter');

const MAX_BODY = 64 * 1024;

function createServer(opts) {
  opts = opts || {};
  const auth = opts.auth || new AccountAuth({ dataFile: opts.dataFile });
  const mailer = opts.mailer || new SyntheticEmailAdapter();
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 0;

  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      let tooLarge = false;
      let settled = false;
      function done(result) { if (!settled) { settled = true; resolve(result); } }
      req.on('data', (c) => {
        if (tooLarge) return;
        data += c;
        if (data.length > MAX_BODY) {
          tooLarge = true;
          done({ error: 'body-too-large' });
          // rework-006：超限立即结算（调用方写 413），不再 pause 等待；安全排空：丢弃剩余 body，硬上限强制销毁，不留悬挂 socket
          req.removeAllListeners('data');
          req.removeAllListeners('end');
          req.on('data', () => {});
          req.resume();
          const killTimer = setTimeout(() => { try { req.destroy(); } catch (_) {} }, 5000);
          if (killTimer.unref) killTimer.unref();
          req.once('close', () => clearTimeout(killTimer));
        }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try { done({ body: data ? JSON.parse(data) : {} }); }
        catch (e) { done({ error: 'invalid-json' }); }
      });
      req.on('error', () => done({ error: 'request-error' }));
      req.on('aborted', () => done({ error: 'request-aborted' }));
    });
  }

  function sessionTokenFrom(req, body) {
    const accountSession = String(req.headers['x-account-session'] || '').trim();
    if (accountSession) return accountSession;
    const authz = req.headers['authorization'] || '';
    if (/^Bearer\s+\S+$/i.test(authz)) return authz.replace(/^Bearer\s+/i, '');
    if (body && typeof body.sessionToken === 'string') return body.sessionToken;
    return '';
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = (req.url || '/').split('?')[0];
    if (method === 'GET' && url === '/health') return json(res, 200, { ok: true, service: 'account-auth' });

    if (method === 'POST') {
      const parsed = await readBody(req);
      if (parsed.error === 'body-too-large') { const payload = JSON.stringify({ ok: false, error: { code: 'body-too-large' } }); res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Connection': 'close' }); res.end(payload); return; }
      if (parsed.error === 'invalid-json') return json(res, 400, { ok: false, error: { code: 'invalid-json' } });
      if (parsed.error) return json(res, 400, { ok: false, error: { code: parsed.error } });
      const b = parsed.body || {};

      if (url === '/account/register') {
        // rework-004 staged registration：validate/staged → 合成邮件成功 → 单次 clone/persist/swap
        let staged;
        try { staged = auth.prepareRegistration(b); }
        catch (e) { return json(res, 503, { ok: false, error: { code: 'persistence-failed' } }); }
        if (!staged.ok) return json(res, 400, staged);
        let delivery = null;
        try { delivery = await mailer.sendVerificationEmail({ to: staged.email, token: staged.verificationToken }); }
        catch (e) { delivery = null; }
        if (!delivery || delivery.ok !== true) {
          return json(res, 503, { ok: false, error: { code: 'email-delivery-failed' } });
        }
        let committed = null;
        try { committed = auth.commitRegistration(staged); } catch (e) { committed = null; }
        if (!committed || committed.ok !== true) return json(res, 503, { ok: false, error: { code: 'persistence-failed' } });
        // 响应剔除 token
        return json(res, 200, { ok: true, accountId: committed.accountId, email: committed.email });
      }
      if (url === '/account/resend') {
        const r = auth.resendVerification(b.email);
        if (!r.ok) return json(res, r.error.code === 'resend-cooldown' ? 429 : 400, r);
        let delivery = null;
        try { delivery = await mailer.sendVerificationEmail({ to: r.email, token: r.verificationToken }); }
        catch (e) { delivery = null; }
        if (!delivery || delivery.ok !== true) return json(res, 503, { ok: false, error: { code: 'email-delivery-failed' } });
        let commit = null;
        try { commit = auth.commitResend(r.email); } catch (e) { commit = null; }
        if (!commit || commit.ok !== true) return json(res, 503, { ok: false, error: { code: 'persistence-failed' } });
        return json(res, 200, { ok: true, accountId: r.accountId, email: r.email });
      }
      if (url === '/account/verify') return json(res, 200, auth.verify(b.token));
      if (url === '/account/login') { const l = await auth.login(b); return json(res, 200, l); }
      if (url === '/account/session') return json(res, 200, auth.validateSession(b.sessionToken || b.token));
      if (url === '/account/revoke') return json(res, 200, auth.revokeSession(b.sessionToken || b.token));
      if (url === '/account/membership') {
        const tok = sessionTokenFrom(req, b);
        if (!tok) return json(res, 401, { ok: false, error: { code: 'no-session' } });
        const m = auth.getMembership(tok);
        return json(res, m.ok ? 200 : 401, m);
      }
      if (url === '/account/balance') {
        // 登录会话只读自己的脱敏余额；未知/无会话 fail-closed
        const tok = sessionTokenFrom(req, b);
        if (!tok) return json(res, 401, { ok: false, error: { code: 'no-session' } });
        const p = auth.balanceProjection(tok);
        return json(res, p.ok ? 200 : 401, p);
      }
      if (url === '/account/admin-credit') {
        // 受保护的内部管理员充值：独立 admin token 校验；幂等键强制
        const adminToken = opts.adminToken || process.env.ACCOUNT_ADMIN_TOKEN || '';
        const given = String(b.adminToken || req.headers['x-admin-token'] || '');
        if (!adminToken || given !== adminToken) return json(res, 401, { ok: false, error: { code: 'admin-forbidden' } });
        const r2 = auth.adminCredit(b.accountId, b.amountCents, { idempotencyKey: b.idempotencyKey, operator: 'admin', via: 'http', meta: { note: b.note } });
        return json(res, r2.ok ? 200 : 400, r2);
      }
    }
    json(res, 404, { ok: false, error: { code: 'not-found' } });
  });

  return { server, auth, mailer, listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))) };
}

module.exports = { createServer, MAX_BODY };
