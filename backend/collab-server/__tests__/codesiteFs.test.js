const test = require('node:test');
const assert = require('node:assert');
const {
  assertCodeSiteWriteAllowed,
  codeSiteContextFromRequest,
  evaluateCodeSiteWrite,
  normalizeRepoRelativePath,
} = require('../codesiteFs');

test('normalizes repo-relative paths and rejects traversal', () => {
  assert.strictEqual(normalizeRepoRelativePath('src\\app/page.jsx'), 'src/app/page.jsx');
  assert.strictEqual(normalizeRepoRelativePath('/src/app/page.jsx'), 'src/app/page.jsx');
  assert.throws(() => normalizeRepoRelativePath('../secret'), /path_escape/);
  assert.throws(() => normalizeRepoRelativePath('a/../../secret'), /path_escape/);
  assert.throws(() => normalizeRepoRelativePath(''), /path_required/);
});

test('extracts CodeSite context from payload and headers', () => {
  const req = {
    headers: {
      'x-codesite-transaction-id': 'txn-1',
      'x-codesite-allowed-paths': 'synthi/src/**,docs/**',
      'x-codesite-blocked-paths': 'api/auth/**',
      'x-codesite-callsign': 'CODEX-04',
    },
  };
  const context = codeSiteContextFromRequest(req, {}, { workspaceSlug: 'acme', effectiveUserId: 'user-1' });

  assert.strictEqual(context.active, true);
  assert.strictEqual(context.transactionId, 'txn-1');
  assert.deepStrictEqual(context.allowedPaths, ['synthi/src/**', 'docs/**']);
  assert.deepStrictEqual(context.blockedPaths, ['api/auth/**']);
  assert.strictEqual(context.displayCallsign, 'CODEX-04');
});

test('allows writes inside lease route and blocks no-fly or out-of-route writes', () => {
  const context = {
    active: true,
    mutationLeaseId: 'lease-1',
    transactionId: 'txn-1',
    allowedPaths: ['synthi/src/components/**'],
    blockedPaths: ['api/**'],
    allowedTools: ['file_write'],
  };

  assert.strictEqual(evaluateCodeSiteWrite(context, { path: 'synthi/src/components/Button.jsx', tool: 'file_write' }).ok, true);

  assert.throws(
    () => assertCodeSiteWriteAllowed(context, { path: 'api/auth/signup.ts', tool: 'file_write', kind: 'write-file' }),
    (error) => error.code === 'CODESITE_WRITE_DENIED' && error.event.details.reason_codes.includes('entered_no_fly_zone'),
  );

  assert.throws(
    () => assertCodeSiteWriteAllowed(context, { path: 'synthi/src/app/page.jsx', tool: 'file_write', kind: 'write-file' }),
    (error) => error.code === 'CODESITE_WRITE_DENIED' && error.event.details.reason_codes.includes('outside_clearance_route'),
  );
});

test('monitor mode returns denied events without throwing', () => {
  const context = {
    active: true,
    mode: 'monitor',
    allowedPaths: ['docs/**'],
  };

  const result = assertCodeSiteWriteAllowed(context, { path: 'api/auth/signup.ts', kind: 'write-file' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.event.type, 'write_denied');
});
