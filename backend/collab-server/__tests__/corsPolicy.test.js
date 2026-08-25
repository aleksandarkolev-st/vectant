'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCorsPolicy } = require('../corsPolicy');

test('resolveCorsPolicy permits credentials only for exact allowlist matches', () => {
  const origins = ['https://app.example'];

  assert.deepEqual(
    resolveCorsPolicy({ origin: undefined, allowedOrigins: origins }),
    { allowOrigin: '*', credentials: false },
  );
  assert.deepEqual(
    resolveCorsPolicy({
      origin: 'https://app.example',
      allowedOrigins: origins,
      devBypass: true,
    }),
    { allowOrigin: 'https://app.example', credentials: true },
  );
  assert.deepEqual(
    resolveCorsPolicy({
      origin: 'https://evil.example',
      allowedOrigins: origins,
      devBypass: true,
    }),
    { allowOrigin: null, credentials: false },
  );
  assert.deepEqual(
    resolveCorsPolicy({
      origin: 'https://open.example',
      allowedOrigins: [],
      devBypass: false,
    }),
    { allowOrigin: null, credentials: false },
  );
  assert.deepEqual(
    resolveCorsPolicy({
      origin: 'https://local.dev',
      allowedOrigins: [],
      devBypass: true,
    }),
    { allowOrigin: 'https://local.dev', credentials: true },
  );
  assert.deepEqual(
    resolveCorsPolicy({
      origin: 'https://APP.example',
      allowedOrigins: ['https://app.example'],
    }),
    { allowOrigin: null, credentials: false },
  );
});
