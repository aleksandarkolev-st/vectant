'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripSensitiveServerEnvironment } = require('../terminalService');

test('terminal child environment strips server credentials but preserves the scoped agent token', () => {
  const env = {
    PATH: 'C:\\Windows',
    HOME: 'C:\\Users\\workspace',
    SYNTHI_WORKSPACE_SLUG: 'team',
    SYNTHI_CODESITE_AGENT_TOKEN: `csa_${'x'.repeat(40)}`,
    SYNTHI_CODESITE_TOKEN: 'control-plane-admin-token',
    COLLAB_INTERNAL_TOKEN: 'internal-token',
    NEXTAUTH_SECRET: 'signing-secret',
    AUTH_SECRET: 'auth-secret',
    YSWEET_AUTH_KEY: 'ysweet-secret',
    AI_ENGINE_AUTH_TOKEN: 'engine-secret',
    OPENAI_API_KEY: 'provider-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/gcp.json',
    GCP_PRIVATE_KEY: 'gcp-private',
    GCS_BUCKET: 'private-bucket',
    DATABASE_URL: 'postgres://user:password@db/private',
    REDIS_URL: 'redis://:password@redis/private',
    SENTRY_DSN: 'https://private@sentry.test/1',
  };

  stripSensitiveServerEnvironment(env);

  assert.deepEqual(env, {
    PATH: 'C:\\Windows',
    HOME: 'C:\\Users\\workspace',
    SYNTHI_WORKSPACE_SLUG: 'team',
    SYNTHI_CODESITE_AGENT_TOKEN: `csa_${'x'.repeat(40)}`,
  });
});

test('terminal environment sanitizer is safe for missing or empty inputs', () => {
  assert.equal(stripSensitiveServerEnvironment(null), null);
  assert.deepEqual(stripSensitiveServerEnvironment({}), {});
});
