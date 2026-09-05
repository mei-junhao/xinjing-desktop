'use strict';
/**
 * resend-email-adapter.js — Resend 事务邮件适配器。
 * 读取 RESEND_API_KEY / RESEND_FROM 环境变量 + 注入 fetch；缺配置 fail-closed。
 * 设超时；绝不打印凭据/token。验收仅对本地 fake fetch，不真实发信。
 */
class ResendEmailAdapter {
  constructor(opts) {
    opts = opts || {};
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.RESEND_API_KEY || '');
    this.from = opts.from !== undefined ? opts.from : (process.env.RESEND_FROM || '');
    this.fetchImpl = opts.fetch !== undefined ? opts.fetch : (typeof fetch === 'function' ? fetch : undefined);
    this.timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 10000;
  }

  async sendPasswordResetEmail(input) {
    const to = String(input && input.to || '');
    const token = String(input && input.token || '');
    if (!to || !token) return { ok: false, error: { code: 'bad-email-input' } };
    if (!this.apiKey || !this.from) return { ok: false, error: { code: 'provider-missing-config' } };
    if (typeof this.fetchImpl !== 'function') return { ok: false, error: { code: 'provider-no-fetch' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [to], subject: '心镜账号密码重置', text: '您正在重置心镜账号密码，这是您的验证码：' + token + '（10 分钟内有效）' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp || typeof resp.ok !== 'boolean') return { ok: false, error: { code: 'provider-bad-response' } };
      if (!resp.ok) return { ok: false, error: { code: 'provider-http-' + resp.status } };
      return { ok: true, messageId: 'resend-' + Date.now() };
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') return { ok: false, error: { code: 'provider-timeout' } };
      return { ok: false, error: { code: 'provider-error' } };
    }
  }

  async sendPasswordResetEmail(input) {
    const to = String(input && input.to || '');
    const token = String(input && input.token || '');
    if (!to || !token) return { ok: false, error: { code: 'bad-email-input' } };
    if (!this.apiKey || !this.from) return { ok: false, error: { code: 'provider-missing-config' } };
    if (typeof this.fetchImpl !== 'function') return { ok: false, error: { code: 'provider-no-fetch' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [to], subject: '心镜账号密码重置', text: '您正在重置心镜账号密码，这是您的验证码：' + token + '（10 分钟内有效）' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp || typeof resp.ok !== 'boolean') return { ok: false, error: { code: 'provider-bad-response' } };
      if (!resp.ok) return { ok: false, error: { code: 'provider-http-' + resp.status } };
      return { ok: true, messageId: 'resend-' + Date.now() };
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') return { ok: false, error: { code: 'provider-timeout' } };
      return { ok: false, error: { code: 'provider-error' } };
    }
  }

  async sendVerificationEmail(input) {
    const to = String(input && input.to || '');
    const token = String(input && input.token || '');
    if (!to || !token) return { ok: false, error: { code: 'bad-email-input' } };
    if (!this.apiKey || !this.from) return { ok: false, error: { code: 'provider-missing-config' } };
    if (typeof this.fetchImpl !== 'function') return { ok: false, error: { code: 'provider-no-fetch' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [to], subject: '心镜账号验证', text: '您正在注册心境客户端，这是您的验证码：' + token }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp || typeof resp.ok !== 'boolean') return { ok: false, error: { code: 'provider-bad-response' } };
      if (!resp.ok) return { ok: false, error: { code: 'provider-http-' + resp.status } };
      return { ok: true, messageId: 'resend-' + Date.now() };
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') return { ok: false, error: { code: 'provider-timeout' } };
      return { ok: false, error: { code: 'provider-error' } };
    }
  }
}

module.exports = { ResendEmailAdapter };
