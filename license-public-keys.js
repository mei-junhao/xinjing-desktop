'use strict';

// Public verification keys are safe to ship. Private keys live outside the repo.
module.exports = Object.freeze({
  schemaVersion: 1,
  license: Object.freeze({
    'ed25519-2026-01': [
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEAp/WbwBmd7RH5FYZ8BDkU4svVU3GB84KliQ8SxABlgBE=',
      '-----END PUBLIC KEY-----',
      '',
    ].join('\n'),
  }),
  revocation: Object.freeze({
    'revocation-ed25519-2026-01': [
      '-----BEGIN PUBLIC KEY-----',
      'MCowBQYDK2VwAyEAq1kEhQrP4TcLnqLWkDyVEnAHtU3PVoFIfhkCsmmA6VA=',
      '-----END PUBLIC KEY-----',
      '',
    ].join('\n'),
  }),
});
