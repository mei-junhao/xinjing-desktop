'use strict';
// redact.js — bounded redaction for update-path errors, journal sidecar and logs.
// Contract §2.5 / §8: never disclose clinical text, prompts, API keys, tokens,
// full user paths, provider responses or payment data through feed/journal/error.
// This module replaces the old chain's raw `console.error(err.message)` sink.

const SENSITIVE = /(Bearer\s+[A-Za-z0-9._~+/=-]+|api[_-]?key|access[_-]?token|refresh[_-]?token|private\s*key|client[_-]?secret|password|passphrase|secret)/i;
const PATH_LEAK = /([A-Za-z]:[\\/][^\s"'<>|]*|\\\\(?:[^\\\s]+\\)+[^\\\s]+)/g;
// key=value / key: value / Bearer <token> pairs: scrub the value too.
const VALUE_PAIR = /((?:Bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|private\s*key|client[_-]?secret|password|passphrase|secret|token)\s*)(?:=|:)?\s*[A-Za-z0-9._~+/=-]{4,}/gi;

function redact(value) {
  let text = String(value == null ? '' : value);
  // 1) key=value / Bearer <token> pairs: replace the value with a placeholder.
  text = text.replace(VALUE_PAIR, (m, key) => key.trim().replace(/\s+/g, '-').slice(0, 12) + ':[REDACTED]');
  // 2) bare sensitive key words.
  text = text.replace(SENSITIVE, (m) => m.replace(/^(.{0,12}).*$/i, '$1:[REDACTED]'));
  // 3) absolute/UNC paths (bounded: keep drive letter, drop remainder).
  text = text.replace(PATH_LEAK, (m) => {
    const drive = /^[A-Za-z]:/.test(m) ? m.slice(0, 3) : '\\\\';
    return drive + '<redacted-path>';
  });
  // 4) clinical / transcript / prompt content markers.
  text = text.replace(/(clinical|transcript|prompt|provider-response|session-transcript)/gi, '$1:[REDACTED]');
  // Bound total length to keep journal/error payloads small.
  if (text.length > 512) text = text.slice(0, 512) + '...[truncated]';
  return text;
}

function safeErrorCode(error) {
  const code = String((error && error.code) || (error && error.message) || 'unknown-error');
  return code.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
}

function logUpdate(level, message) {
  // Console sink only; never includes sensitive material.
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log']('[update-integrity] ' + redact(message));
}

module.exports = { redact, safeErrorCode, logUpdate, SENSITIVE };
