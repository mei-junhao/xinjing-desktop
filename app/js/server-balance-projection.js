'use strict';

const DECIMAL_YUAN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function yuanToMinor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const text = String(value);
  if (!DECIMAL_YUAN.test(text)) return null;
  const parts = text.split('.');
  const whole = BigInt(parts[0]);
  const fraction = (parts[1] || '').padEnd(2, '0');
  const minor = whole * 100n + BigInt(fraction || '0');
  if (minor > MAX_SAFE_MINOR) return null;
  return Number(minor);
}

function optionalSafeMinor(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function normalizeServerBalance(payload, fetchedAt) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok !== true
    || typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) return null;
  const hasAccountShape = Object.prototype.hasOwnProperty.call(payload, 'balanceCents')
    || Object.prototype.hasOwnProperty.call(payload, 'balanceYuan');
  let remainingBalanceMinor = null;
  if (hasAccountShape) {
    if (typeof payload.accountId !== 'string' || !payload.accountId.trim()) return null;
    remainingBalanceMinor = optionalSafeMinor(payload.balanceCents);
    const yuanMinor = yuanToMinor(payload.balanceYuan);
    if (remainingBalanceMinor === null || yuanMinor === null || remainingBalanceMinor !== yuanMinor) return null;
  } else {
    remainingBalanceMinor = yuanToMinor(payload.remainingYuan);
  }
  if (remainingBalanceMinor === null) return null;

  let availableBalanceMinor = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'availableBalanceMinor')) {
    availableBalanceMinor = optionalSafeMinor(payload.availableBalanceMinor);
    if (payload.availableBalanceMinor !== null && availableBalanceMinor === null) return null;
    if (availableBalanceMinor !== null && availableBalanceMinor > remainingBalanceMinor) return null;
  }

  let serverRevision = null;
  const revisionValue = Object.prototype.hasOwnProperty.call(payload, 'revision')
    ? payload.revision
    : payload.serverRevision;
  if (revisionValue !== undefined) {
    serverRevision = optionalSafeMinor(revisionValue);
    if (revisionValue !== null && serverRevision === null) return null;
  }

  return {
    source: 'server',
    currency: 'CNY',
    remainingBalanceMinor,
    availableBalanceMinor,
    serverRevision,
    fetchedAt,
  };
}

module.exports = { normalizeServerBalance, yuanToMinor };
