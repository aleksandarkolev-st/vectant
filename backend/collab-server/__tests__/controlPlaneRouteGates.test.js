'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasTrustedInternalToken } = require('../collabGatewayAuth');

function request(headers = {}) {
  return { headers };
}

test('control-plane internal token rejects missing and incorrect credentials', () => {
  const env = { COLLAB_INTERNAL_TOKEN: 'internal-secret', NODE_ENV: 'test' };

  assert.equal(hasTrustedInternalToken(request(), { config: {}, env }), false);
  assert.equal(
    hasTrustedInternalToken(request({ 'x-collab-internal-token': 'wrong' }), { config: {}, env }),
    false,
  );
});

test('control-plane internal token accepts matching collab token', () => {
  assert.equal(
    hasTrustedInternalToken(
      request({ 'x-collab-internal-token': 'internal-secret' }),
      { config: {}, env: { COLLAB_INTERNAL_TOKEN: 'internal-secret', NODE_ENV: 'test' } },
    ),
    true,
  );
});
