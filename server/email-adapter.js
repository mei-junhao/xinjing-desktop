'use strict';
/**
 * email-adapter.js — 合成事务邮件适配器。
 * 不联网、不真实投递、不含凭据；仅入队（供回环验收读取）。
 */
class SyntheticEmailAdapter {
  constructor() { this.queue = []; this.counter = 0; }
  async sendVerificationEmail(input) {
    const to = String(input && input.to || '');
    const token = String(input && input.token || '');
    if (!to || !token) return { ok: false, error: { code: 'bad-email-input' } };
    this.counter += 1;
    const record = { id: 'synthetic-' + this.counter, to, verificationToken: token, at: Date.now() };
    this.queue.push(record);
    // 合成发送：不调用任何真实 SMTP/HTTP，无凭据。
    return { ok: true, messageId: record.id };
  }
  // 测试/审计用只读视图
  drain() { const q = this.queue.slice(); this.queue = []; return q; }
  peek() { return this.queue.slice(); }
  count() { return this.queue.length; }
}

module.exports = { SyntheticEmailAdapter };
