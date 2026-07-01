const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CodeSiteFS,
  assertCodeSiteWriteAllowed,
  codeSiteCommitMessage,
  codeSiteCommitTrailers,
  codeSiteContextFromRequest,
  codeSiteQuarantineReplayPlan,
  codeSiteRuntimeEnv,
  codeSiteRuntimeMetadata,
  collectCodeSiteRepoState,
  completeCodeSiteCommitProof,
  createCodeSiteFS,
  createCodeSiteQuarantineWorkspace,
  deriveLineProvenanceFromContentChange,
  enforceCodeSiteWriteAllowed,
  evaluateCodeSiteWrite,
  finalizeCodeSiteQuarantineWorkspace,
  listCodeSiteQuarantineManifests,
  normalizeRepoRelativePath,
  readCodeSiteQuarantineManifest,
  resolveCodeSiteRepoPath,
} = require('../codesiteFs');

test('normalizes repo-relative paths and rejects traversal', () => {
  assert.strictEqual(normalizeRepoRelativePath('src\\app/page.jsx'), 'src/app/page.jsx');
  assert.strictEqual(normalizeRepoRelativePath('/src/app/page.jsx'), 'src/app/page.jsx');
  assert.throws(() => normalizeRepoRelativePath('../secret'), /path_escape/);
  assert.throws(() => normalizeRepoRelativePath('a/../../secret'), /path_escape/);
  assert.throws(() => normalizeRepoRelativePath(''), /path_required/);
});

test('resolves CodeSiteFS paths through a symlink-safe repo containment boundary', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-resolve-repo-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-resolve-outside-'));
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'app.js'), 'inside\n');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo, 'src', 'secret-link.txt'));
    await fs.symlink(outside, path.join(repo, 'outside-dir'));

    const existing = await resolveCodeSiteRepoPath(repo, 'src/app.js');
    assert.strictEqual(existing.path, 'src/app.js');
    assert.strictEqual(existing.exists, true);
    assert.strictEqual(existing.kind, 'file');

    const missing = await resolveCodeSiteRepoPath(repo, 'src/new-file.js');
    assert.strictEqual(missing.path, 'src/new-file.js');
    assert.strictEqual(missing.exists, false);
    assert.match(missing.parentRealPath, /src$/);

    await assert.rejects(
      () => resolveCodeSiteRepoPath(repo, 'src/secret-link.txt'),
      (error) => error.code === 'repo_path_symlink_escape',
    );
    await assert.rejects(
      () => resolveCodeSiteRepoPath(repo, 'outside-dir/new-file.js'),
      (error) => error.code === 'repo_parent_symlink_escape',
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
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

test('empty legacy requests stay inactive but declared CodeSite requests fail closed', async () => {
  const legacy = codeSiteContextFromRequest({ headers: {} }, {}, { workspaceSlug: 'acme' });
  assert.strictEqual(legacy.active, false);

  for (const context of [
    codeSiteContextFromRequest({ headers: { 'x-codesite-required': '1' } }, {}, { workspaceSlug: 'acme' }),
    codeSiteContextFromRequest({ headers: { 'x-codesite-mode': 'enforce' } }, {}, { workspaceSlug: 'acme' }),
    codeSiteContextFromRequest({ headers: {} }, { codesite: {} }, { workspaceSlug: 'acme' }),
  ]) {
    assert.strictEqual(context.active, true);
    await assert.rejects(
      () => enforceCodeSiteWriteAllowed(context, {
        path: 'synthi/src/App.jsx',
        tool: 'file_write',
        kind: 'write-file',
      }, { fetch: async () => new Response('{}') }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_transaction_required')
        && error.event.details.reason_codes.includes('codesite_control_plane_url_required'),
    );
  }
});

test('managed agent attribution without CodeSite headers still fails closed', async () => {
  const context = codeSiteContextFromRequest({
    headers: {
      'x-agent-session-id': 'agent-session-omitted-codesite',
      'x-agent-provider': 'codex',
      'x-agent-runtime': 'codex-cli',
    },
  }, {}, { workspaceSlug: 'acme', actorUserId: 'agent-owner-1' });

  assert.strictEqual(context.active, true);
  assert.strictEqual(context.managedAgent, true);
  assert.strictEqual(context.agentSessionId, 'agent-session-omitted-codesite');
  assert.strictEqual(context.agentProvider, 'codex');
  assert.strictEqual(context.agentRuntime, 'codex-cli');
  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch: async () => new Response('{}') }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('codesite_transaction_required')
      && error.event.details.reason_codes.includes('codesite_authoritative_context_required'),
  );
});

test('ordinary runtime routing headers do not force CodeSite managed-agent mode', () => {
  const context = codeSiteContextFromRequest({
    headers: {
      'x-runtime-scope': 'ws-demo-user-demo',
      'x-runtime-kind': 'workspace',
      'x-runtime-fs-user-id': 'user-1',
    },
  }, {}, { workspaceSlug: 'acme', actorUserId: 'user-1' });

  assert.strictEqual(context.active, false);
  assert.strictEqual(context.managedAgent, false);
});

test('generic process ancestry marks MCP and workflow writes as managed', () => {
  const context = codeSiteContextFromRequest({ headers: {} }, {
    processAncestry: ['mcp:synthi_apply_patch'],
  }, { workspaceSlug: 'acme' });

  assert.strictEqual(context.active, true);
  assert.strictEqual(context.managedAgent, true);
  assert.deepStrictEqual(context.processAncestry, ['mcp:synthi_apply_patch']);
});

test('trusted managed write scopes fail closed when CodeSite context is missing', async () => {
  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(null, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { requireAuthoritativeContext: true, fetch: async () => new Response('{}') }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('codesite_context_required'),
  );
});

test('derives sanitized CodeSite runtime env and metadata for managed processes', () => {
  const context = codeSiteContextFromRequest({
    headers: {
      'x-codesite-transaction-id': 'txn-1',
      'x-codesite-lease-id': 'lease-1',
      'x-codesite-allowed-paths': 'synthi/src/**',
      'x-codesite-blocked-paths': 'secrets/**',
      'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
      'x-codesite-token': 'secret-token',
      cookie: 'next-auth=secret',
    },
  }, {
    codesite: {
      displayCallsign: 'ATLAS-1',
      allowedTools: ['file_write'],
      evidenceRefs: ['proof:1'],
      processAncestry: ['collab-server'],
    },
  }, {
    workspaceSlug: 'acme',
    actorUserId: 'actor-1',
    effectiveUserId: 'fs-1',
  });

  const env = codeSiteRuntimeEnv(context, { processAncestry: ['exec'] });

  assert.strictEqual(env.CODESITE_ACTIVE, '1');
  assert.strictEqual(env.CODESITE_WORKSPACE_SLUG, 'acme');
  assert.strictEqual(env.CODESITE_TRANSACTION_ID, 'txn-1');
  assert.strictEqual(env.CODESITE_MUTATION_LEASE_ID, 'lease-1');
  assert.strictEqual(env.CODESITE_CALLSIGN, 'ATLAS-1');
  assert.strictEqual(env.CODESITE_ACTOR_USER_ID, 'actor-1');
  assert.strictEqual(env.CODESITE_EFFECTIVE_USER_ID, 'fs-1');
  assert.strictEqual(env.CODESITE_ALLOWED_PATHS, JSON.stringify(['synthi/src/**']));
  assert.strictEqual(env.CODESITE_BLOCKED_PATHS, JSON.stringify(['secrets/**']));
  assert.strictEqual(env.CODESITE_ALLOWED_TOOLS, JSON.stringify(['file_write']));
  assert.strictEqual(env.CODESITE_EVIDENCE_REFS, JSON.stringify(['proof:1']));
  assert.strictEqual(env.CODESITE_PROCESS_ANCESTRY, JSON.stringify(['collab-server', 'exec']));
  assert.strictEqual(env.SYNTHI_CODESITE_API_BASE_URL, 'http://app.test/api/workspace/acme/codesite');
  assert.strictEqual(env.SYNTHI_CODESITE_TOKEN, undefined);
  assert.strictEqual(env.COOKIE, undefined);

  assert.deepStrictEqual(codeSiteRuntimeMetadata(context), {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    displayCallsign: 'ATLAS-1',
    agentSessionId: null,
    agentProvider: null,
    agentRuntime: null,
    managedAgent: false,
    allowedPaths: ['synthi/src/**'],
    blockedPaths: ['secrets/**'],
    allowedTools: ['file_write'],
    evidenceRefs: ['proof:1'],
    processAncestry: ['collab-server'],
  });
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

test('CodeSiteFS lifecycle applies an allowed write through prepare, emit, apply, and verify', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-boundary-'));
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'app.js'), 'before\n');
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, eventId: `event-${calls.length}` }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['src/**'],
    allowedTools: ['file_write'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  try {
    const codesiteFs = new CodeSiteFS(context, { fetch, repoRoot: repo });
    const prepared = await codesiteFs.prepare({ path: 'src/app.js', tool: 'file_write', kind: 'write-file' });
    assert.strictEqual(prepared.phase, 'prepared');
    assert.strictEqual(prepared.ok, true);
    assert.strictEqual(prepared.disposition, 'write_allowed');
    assert.strictEqual(prepared.rollbackHint.strategy, 'transaction_abort_or_revert');

    const validated = await codesiteFs.validate(prepared);
    assert.strictEqual(validated.phase, 'validated');

    const applied = await codesiteFs.apply(validated, async () => {
      assert.strictEqual(calls.length, 1, 'prewrite event is emitted before real repo mutation');
      await fs.writeFile(path.join(repo, 'src', 'app.js'), 'after\n');
      return { bytesWritten: 6 };
    });

    assert.strictEqual(applied.phase, 'applied');
    assert.deepStrictEqual(applied.applyResult, { bytesWritten: 6 });
    assert.strictEqual(applied.verification.ok, true);
    assert.strictEqual(applied.verification.digest.exists, true);
    assert.match(applied.verification.digest.digest, /^sha256:/);
    assert.strictEqual(await fs.readFile(path.join(repo, 'src', 'app.js'), 'utf8'), 'after\n');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1/record-write');
    assert.strictEqual(calls[0].body.codesiteFsEvent.type, 'write_allowed');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('CodeSiteFS lifecycle emits denied prewrite evidence and blocks apply outside clearance', async () => {
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      ok: false,
      policyDecision: { reasonCodes: ['outside_clearance_route'] },
    }), { status: 200 });
  };
  const codesiteFs = createCodeSiteFS({
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['docs/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  }, { fetch });
  let applied = false;

  const prepared = await codesiteFs.prepare({ path: 'src/app.js', tool: 'file_write', kind: 'write-file' });
  assert.strictEqual(prepared.ok, false);
  assert.strictEqual(prepared.disposition, 'write_denied');
  assert.strictEqual(prepared.rollbackHint.strategy, 'no_repo_mutation');

  await assert.rejects(
    () => codesiteFs.apply(prepared, async () => {
      applied = true;
    }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('outside_clearance_route'),
  );

  assert.strictEqual(applied, false);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, 'src/app.js');
  assert.strictEqual(calls[0].codesiteFsEvent.type, 'write_denied');
});

test('CodeSiteFS lifecycle blocks symlink escapes before apply', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-symlink-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-outside-'));
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(repo, 'src', 'secret-link.txt'));
    const codesiteFs = createCodeSiteFS({
      active: true,
      workspaceSlug: 'acme',
      transactionId: 'txn-symlink',
      mutationLeaseId: 'lease-symlink',
      allowedPaths: ['src/**'],
      controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
    }, { fetch, repoRoot: repo });
    let applied = false;

    await assert.rejects(
      () => codesiteFs.apply({
        path: 'src/secret-link.txt',
        tool: 'file_write',
        kind: 'write-file',
      }, async () => {
        applied = true;
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('repo_path_symlink_escape'),
    );

    assert.strictEqual(applied, false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].codesiteFsEvent.type, 'write_denied');
    assert.ok(calls[0].codesiteFsEvent.details.reason_codes.includes('repo_path_symlink_escape'));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('CodeSiteFS run validates every attempt before applying a multi-file mutation', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codesitefs-run-'));
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'a.js'), 'a-before\n');
  await fs.writeFile(path.join(repo, 'src', 'b.js'), 'b-before\n');
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const codesiteFs = createCodeSiteFS({
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-run',
    mutationLeaseId: 'lease-run',
    allowedPaths: ['src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  }, { fetch, repoRoot: repo });

  try {
    const result = await codesiteFs.run({
      operation: 'write-files-batch',
      tool: 'file_write',
      attempts: [
        { path: 'src/a.js', kind: 'write-files-batch', tool: 'file_write' },
        { path: 'src/b.js', kind: 'write-files-batch', tool: 'file_write' },
      ],
    }, async ({ attempts }) => {
      assert.strictEqual(attempts.length, 2);
      assert.deepStrictEqual(calls.map((call) => call.path), ['src/a.js', 'src/b.js']);
      await fs.writeFile(path.join(repo, 'src', 'a.js'), 'a-after\n');
      await fs.writeFile(path.join(repo, 'src', 'b.js'), 'b-after\n');
      return { written: 2 };
    });

    assert.strictEqual(result.phase, 'applied');
    assert.deepStrictEqual(result.applyResult, { written: 2 });
    assert.strictEqual(result.verification.length, 2);
    assert.ok(result.verification.every((item) => item.ok && item.digest.exists));
    assert.deepStrictEqual(result.rollbackHints.map((hint) => hint.strategy), [
      'transaction_abort_or_revert',
      'transaction_abort_or_revert',
    ]);
    assert.strictEqual(await fs.readFile(path.join(repo, 'src', 'a.js'), 'utf8'), 'a-after\n');
    assert.strictEqual(await fs.readFile(path.join(repo, 'src', 'b.js'), 'utf8'), 'b-after\n');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('CodeSiteFS run blocks a mixed multi-file mutation before emitting allowed events', async () => {
  const calls = [];
  const fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const codesiteFs = createCodeSiteFS({
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-run-denied',
    mutationLeaseId: 'lease-run-denied',
    allowedPaths: ['src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  }, { fetch });
  let applied = false;

  await assert.rejects(
    () => codesiteFs.run({
      operation: 'write-files-batch',
      tool: 'file_write',
      attempts: [
        { path: 'src/a.js', kind: 'write-files-batch', tool: 'file_write' },
        { path: 'docs/readme.md', kind: 'write-files-batch', tool: 'file_write' },
      ],
    }, async () => {
      applied = true;
    }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.path === 'docs/readme.md',
  );

  assert.strictEqual(applied, false);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, 'docs/readme.md');
  assert.strictEqual(calls[0].codesiteFsEvent.type, 'write_denied');
});

test('derives ranged line provenance from content changes', () => {
  const rows = deriveLineProvenanceFromContentChange(
    'src/App.jsx',
    ['alpha', 'beta', 'gamma', 'delta', 'omega'].join('\n'),
    ['alpha', 'BETA', 'gamma', 'DELTA', 'omega'].join('\n'),
    {
      evidenceRefs: ['runtime:event:apply-1'],
      processAncestry: ['collab-server'],
      promptSummary: 'Apply two edits',
    },
  );

  assert.deepStrictEqual(rows.map((row) => ({
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    lineAnchor: row.lineAnchor,
  })), [
    { filePath: 'src/App.jsx', startLine: 2, endLine: 2, lineAnchor: 'src/App.jsx#L2-L2' },
    { filePath: 'src/App.jsx', startLine: 4, endLine: 4, lineAnchor: 'src/App.jsx#L4-L4' },
  ]);
  assert(rows.every((row) => row.evidenceRefs.includes('runtime:event:apply-1')));
  assert(rows.every((row) => row.evidenceRefs.some((ref) => ref.startsWith('hunk:sha256:'))));
  assert.deepStrictEqual(rows[0].processAncestry, ['collab-server']);
  assert.strictEqual(rows[0].promptSummary, 'Apply two edits');
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

test('enforcement records allowed transaction writes through the CodeSite control plane', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, transaction: { id: 'txn-1' } }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['synthi/src/**'],
    allowedTools: ['file_write'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
    evidenceRefs: ['lease:proof'],
    processAncestry: ['node', 'collab-server'],
  };

  const result = await enforceCodeSiteWriteAllowed(context, {
    path: 'synthi/src/App.jsx',
    tool: 'file_write',
    kind: 'write-file',
    evidenceRefs: ['hunk:evidence'],
    processAncestry: ['mcp:synthi_codesite_apply_patch'],
    lineProvenance: [{
      filePath: 'synthi/src/App.jsx',
      startLine: 12,
      endLine: 18,
      lineAnchor: 'synthi/src/App.jsx#L12-L18',
      evidenceRefs: ['hunk:evidence'],
      promptSummary: 'Update app shell copy',
    }],
  }, { fetch });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1/record-write');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    path: 'synthi/src/App.jsx',
    tool: 'file_write',
    evidenceRefs: ['lease:proof', 'hunk:evidence'],
    processAncestry: ['node', 'collab-server', 'mcp:synthi_codesite_apply_patch'],
    lineProvenance: [{
      filePath: 'synthi/src/App.jsx',
      startLine: 12,
      endLine: 18,
      lineAnchor: 'synthi/src/App.jsx#L12-L18',
      evidenceRefs: ['hunk:evidence'],
      promptSummary: 'Update app shell copy',
    }],
    codesiteFsEvent: result.event,
  });
});

test('managed agent writes fail closed without an active transaction', async () => {
  const context = codeSiteContextFromRequest({ headers: {} }, {
    agentSessionId: 'ags-1',
    managedAgent: true,
  }, {
    workspaceSlug: 'acme',
    actorUserId: 'agent-owner-1',
  });

  assert.strictEqual(context.active, true);
  assert.strictEqual(context.managedAgent, true);
  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch: async () => new Response('{}') }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('codesite_transaction_required'),
  );
});

test('managed agent enforcement hydrates transaction write set instead of trusting forged allowed paths', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/transactions/txn-1')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-1',
          status: 'open',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'ags-1',
          writeSet: ['docs/**'],
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ok: false,
      policyDecision: { reasonCodes: ['outside_clearance_route'] },
    }), { status: 200 });
  };
  const context = codeSiteContextFromRequest({
    headers: {
      'x-codesite-managed-agent': '1',
      'x-codesite-transaction-id': 'txn-1',
      'x-codesite-agent-session-id': 'ags-1',
      'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
      'x-codesite-allowed-paths': 'api/**',
    },
  }, {}, { workspaceSlug: 'acme' });

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'api/auth/signup.ts',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('outside_clearance_route'),
  );

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1');
  const body = JSON.parse(calls[1].options.body);
  assert.strictEqual(body.path, 'api/auth/signup.ts');
  assert.strictEqual(body.codesiteFsEvent.type, 'write_denied');
  assert.strictEqual(body.codesiteFsEvent.details.reason_codes.includes('outside_clearance_route'), true);
});

test('authoritative server enforcement hydrates active non-managed CodeSite writes', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/transactions/txn-1')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-1',
          status: 'open',
          writeSet: ['docs/**'],
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      ok: false,
      policyDecision: { reasonCodes: ['outside_clearance_route'] },
    }), { status: 200 });
  };
  const context = codeSiteContextFromRequest({
    headers: {
      'x-codesite-transaction-id': 'txn-1',
      'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
      'x-codesite-allowed-paths': 'api/**',
    },
  }, {}, { workspaceSlug: 'acme' });

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'api/auth/signup.ts',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch, requireAuthoritativeContext: true }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('outside_clearance_route'),
  );

  assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1');
});

test('managed agent enforcement rejects stale or closed transactions before writes', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/transactions/txn-closed')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-closed',
          status: 'committed',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'ags-1',
          writeSet: ['synthi/src/**'],
        },
      }), { status: 200 });
    }
    throw new Error('unexpected fetch');
  };
  const context = codeSiteContextFromRequest({
    headers: {
      'x-codesite-managed-agent': '1',
      'x-codesite-transaction-id': 'txn-closed',
      'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
    },
  }, {}, { workspaceSlug: 'acme' });

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('codesite_transaction_not_open')
      && error.event.details.reason_codes.includes('codesite_authoritative_context_required'),
  );
});

test('managed agent enforcement rejects authoritative transactions with no write set', async () => {
  const fetch = async (url) => {
    if (url.endsWith('/transactions/txn-empty')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-empty',
          status: 'open',
          mutationLeaseId: 'lease-1',
          agentSessionId: 'ags-1',
          writeSet: [],
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    throw new Error('unexpected fetch');
  };
  const context = codeSiteContextFromRequest({
    headers: {
      'x-codesite-managed-agent': '1',
      'x-codesite-transaction-id': 'txn-empty',
      'x-codesite-control-plane-url': 'http://app.test/api/workspace/acme/codesite',
    },
  }, {}, { workspaceSlug: 'acme' });

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('codesite_transaction_write_set_required'),
  );
});

test('enforcement fails closed without durable CodeSite control-plane context', async () => {
  const context = {
    active: true,
    workspaceSlug: 'acme',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['synthi/src/**'],
    allowedTools: ['file_write'],
  };

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, {
      path: 'synthi/src/App.jsx',
      tool: 'file_write',
      kind: 'write-file',
    }, { fetch: async () => new Response('{}') }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.type === 'write_denied'
      && error.event.details.reason_codes.includes('codesite_transaction_required')
      && error.event.details.reason_codes.includes('codesite_control_plane_url_required'),
  );
});

test('monitor mode does not fail closed when durable CodeSite context is absent', async () => {
  const result = await enforceCodeSiteWriteAllowed({
    active: true,
    mode: 'monitor',
    workspaceSlug: 'acme',
    allowedPaths: ['synthi/src/**'],
  }, {
    path: 'synthi/src/App.jsx',
    tool: 'file_write',
    kind: 'write-file',
  });

  assert.strictEqual(result.ok, true);
});

test('enforcement fails closed when persisted transaction policy rejects the write', async () => {
  const fetch = async () => new Response(JSON.stringify({
    ok: false,
    policyDecision: { reasonCodes: ['outside_clearance_route'] },
  }), { status: 200 });
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['synthi/src/**'],
    allowedTools: ['file_write'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, { path: 'synthi/src/App.jsx', tool: 'file_write' }, { fetch }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('control_plane_denied_write')
      && error.event.details.reason_codes.includes('outside_clearance_route'),
  );
});

test('enforcement records local denied writes before throwing', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      ok: false,
      policyDecision: { reasonCodes: ['outside_clearance_route'] },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['synthi/src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  await assert.rejects(
    () => enforceCodeSiteWriteAllowed(context, { path: 'api/auth/signup.ts', tool: 'file_write' }, { fetch }),
    (error) => error.code === 'CODESITE_WRITE_DENIED'
      && error.event.details.reason_codes.includes('outside_clearance_route'),
  );

  assert.strictEqual(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.path, 'api/auth/signup.ts');
  assert.strictEqual(body.codesiteFsEvent.type, 'write_denied');
  assert.deepStrictEqual(body.codesiteFsEvent.details.reason_codes, ['outside_clearance_route']);
});

test('formats proof-carrying CodeSite commit trailers', () => {
  const message = codeSiteCommitMessage('Implement checkout', {
    codesite: {
      projectId: 'site-checkout',
      callsign: 'ATLAS-1',
      transactionId: 'txn-1',
      mutationLeaseId: 'lease-1',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      invariants: ['typecheck:pass', 'visual:pass'],
      landingStatus: 'landed',
      blackBoxDigest: 'sha256:blackbox',
    },
  });

  assert.match(message, /Implement checkout\n\nCodeSite-Project: site-checkout/);
  assert.match(message, /CodeSite-Flight: ATLAS-1/);
  assert.match(message, /CodeSite-Transaction: txn-1/);
  assert.match(message, /CodeSite-Lease: lease-1/);
  assert.match(message, /CodeSite-Invariants: typecheck:pass,visual:pass/);
  assert.match(message, /CodeSite-Black-Box: sha256:blackbox/);
});

test('does not duplicate existing CodeSite trailers', () => {
  const trailers = codeSiteCommitTrailers({
    proofBundle: {
      transactionId: 'txn-2',
      mutationLeaseId: 'lease-2',
      readSetDigest: 'sha256:read',
      writeSetDigest: 'sha256:write',
      bundleDigest: 'sha256:bundle',
    },
  });
  assert.ok(trailers.some(([key]) => key === 'CodeSite-Transaction'));

  const message = codeSiteCommitMessage('Patch\n\nCodeSite-Transaction: txn-existing', {
    transactionId: 'txn-2',
    mutationLeaseId: 'lease-2',
  });
  assert.strictEqual((message.match(/CodeSite-Transaction:/g) || []).length, 1);
  assert.match(message, /CodeSite-Lease: lease-2/);
});

test('completes transaction proof before proof-carrying commits', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      transaction: { id: 'txn-1' },
      proofBundle: {
        projectId: 'project-1',
        transactionId: 'txn-1',
        mutationLeaseId: 'lease-1',
        readSetDigest: 'sha256:read',
        writeSetDigest: 'sha256:write',
        bundleDigest: 'sha256:bundle',
        invariants: ['clearance.diff.inside_route'],
      },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  const proof = await completeCodeSiteCommitProof(context, {
    evidenceRefs: ['docker:vitest'],
  }, { fetch });

  assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1/commit');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body).evidenceRefs, ['docker:vitest']);
  const message = codeSiteCommitMessage('Land transaction', { codesite: { proofBundle: proof.proofBundle } });
  assert.match(message, /CodeSite-Transaction: txn-1/);
  assert.match(message, /CodeSite-Read-Set: sha256:read/);
  assert.match(message, /CodeSite-Black-Box: sha256:bundle/);
});

test('blocks proof-carrying commits when transaction validation fails', async () => {
  const fetch = async () => new Response(JSON.stringify({
    decision: { ok: false, reasonCodes: ['stale_read_detected'] },
  }), { status: 200 });
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  await assert.rejects(
    () => completeCodeSiteCommitProof(context, {}, { fetch }),
    (error) => error.code === 'CODESITE_COMMIT_BLOCKED'
      && error.details.reasonCodes.includes('stale_read_detected'),
  );
});

test('collects repo-state evidence from actual workspace files', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-repo-state-'));
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'app.js'), 'actual file content\n');

  const evidence = await collectCodeSiteRepoState(repo, {
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    baseSnapshot: 'repo@sha256:base',
    writePaths: ['src/app.js'],
  });

  assert.strictEqual(evidence.schemaVersion, 'synthi.codesite.repoStateEvidence.v1');
  assert.strictEqual(evidence.workspaceSlug, 'acme');
  assert.strictEqual(evidence.transactionId, 'txn-1');
  assert.match(evidence.worktreeDiffDigest, /^sha256:/);
  assert.match(evidence.evidenceDigest, /^sha256:/);
  assert.deepStrictEqual(evidence.writeFileDigests, [{
    path: 'src/app.js',
    digest: 'sha256:ffc765b812e82586d3f41c451b45cb4f600d70ab1490f869133f094aaecda448',
    size: 20,
    exists: true,
  }]);
});

test('quarantines raw terminal workspace changes and records them as evidence', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-src-'));
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-quarantine-'));
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'app.js'), 'before\n');
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      ok: false,
      quarantined: true,
      policyDecision: { reasonCodes: ['raw_terminal_quarantine'] },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-1',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  try {
    const quarantine = await createCodeSiteQuarantineWorkspace(context, source, {
      baseDir,
      operation: 'exec',
    });
    await fs.writeFile(path.join(quarantine.cwd, 'src', 'app.js'), 'after\n');
    await fs.writeFile(path.join(quarantine.cwd, 'src', 'new.js'), 'new\n');

    const result = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, { fetch });

    assert.deepStrictEqual(result.changes.map((change) => change.path), ['src/app.js', 'src/new.js']);
    assert.match(quarantine.quarantineId, /^qtn-/);
    assert.strictEqual(calls.length, 2);
    const firstBody = JSON.parse(calls[0].options.body);
    assert.strictEqual(firstBody.codesiteFsEvent.type, 'write_quarantined');
    assert.strictEqual(firstBody.codesiteFsEvent.details.quarantine_id, quarantine.quarantineId);
    assert.deepStrictEqual(firstBody.codesiteFsEvent.details.reason_codes, ['raw_terminal_quarantine']);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_root, /codesite-quarantine/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.beforeDigest, /^sha256:/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.afterDigest, /^sha256:/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.evidenceRef, /^codesitefs:quarantine:sha256:/);
    assert.strictEqual(firstBody.codesiteFsEvent.details.quarantine_evidence.beforeText, 'before\n');
    assert.strictEqual(firstBody.codesiteFsEvent.details.quarantine_evidence.afterText, 'after\n');
    assert.ok(firstBody.codesiteFsEvent.details.quarantine_evidence.textDiff.lines.some((line) => line === '-before'));
    assert.ok(firstBody.codesiteFsEvent.details.quarantine_evidence.textDiff.lines.some((line) => line === '+after'));
    assert.strictEqual(result.changes[0].quarantineEvidence.beforeText, 'before\n');
    assert.strictEqual(result.changes[0].quarantineEvidence.afterText, 'after\n');
    assert.match(result.recorded[0].quarantineEvidence.evidenceRef, /^codesitefs:quarantine:sha256:/);
    assert.strictEqual(result.recorded[0].quarantineId, quarantine.quarantineId);
    const manifest = await readCodeSiteQuarantineManifest(baseDir, 'acme', quarantine.quarantineId);
    assert.strictEqual(manifest.schemaVersion, 'synthi.codesitefs.quarantineManifest.v1');
    assert.strictEqual(manifest.status, 'reviewable');
    assert.strictEqual(manifest.quarantineId, quarantine.quarantineId);
    assert.deepStrictEqual(manifest.changes.map((change) => change.path), ['src/app.js', 'src/new.js']);
    assert.strictEqual(manifest.changes[0].quarantineEvidence.afterText, 'after\n');
    const listed = await listCodeSiteQuarantineManifests(baseDir, 'acme', { transactionId: 'txn-1' });
    assert.deepStrictEqual(listed.map((item) => item.quarantineId), [quarantine.quarantineId]);
    assert.strictEqual(await fs.readFile(path.join(source, 'src', 'app.js'), 'utf8'), 'before\n');
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('normalizes replayable quarantine text changes and rejects unsupported evidence', () => {
  const plan = codeSiteQuarantineReplayPlan([{
    path: 'src/app.js',
    kind: 'modified',
    quarantineEvidence: {
      path: 'src/app.js',
      kind: 'modified',
      beforeText: 'before\n',
      afterText: 'after\n',
      quarantineId: 'qtn-1',
      beforeDigest: 'sha256:before',
      afterDigest: 'sha256:after',
      evidenceRef: 'codesitefs:quarantine:sha256:evidence',
      textDiff: { format: 'line-window-v1', lines: ['-before', '+after'] },
    },
  }]);

  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.rejected.length, 0);
  assert.strictEqual(plan.changes[0].path, 'src/app.js');
  assert.strictEqual(plan.changes[0].quarantineId, 'qtn-1');
  assert.strictEqual(plan.changes[0].beforeText, 'before\n');
  assert.strictEqual(plan.changes[0].afterText, 'after\n');
  assert.deepStrictEqual(plan.changes[0].evidenceRefs, ['codesitefs:quarantine:sha256:evidence']);

  const missingText = codeSiteQuarantineReplayPlan([{
    path: 'src/app.js',
    kind: 'modified',
    quarantineEvidence: { path: 'src/app.js', kind: 'modified' },
  }]);
  assert.strictEqual(missingText.ok, false);
  assert.deepStrictEqual(missingText.rejected[0].reasonCodes, ['quarantine_after_text_required']);

  const deleted = codeSiteQuarantineReplayPlan([{
    path: 'src/old.js',
    kind: 'deleted',
    quarantineEvidence: { path: 'src/old.js', kind: 'deleted', beforeText: 'old\n' },
  }]);
  assert.strictEqual(deleted.ok, false);
  assert.deepStrictEqual(deleted.rejected[0].reasonCodes, ['quarantine_deleted_replay_requires_delete_adapter']);
});

test('raw terminal quarantine replaces symlink escapes before command execution', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-symlink-src-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-symlink-outside-'));
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-symlink-quarantine-'));
  const outsideTarget = path.join(outside, 'outside.txt');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(outsideTarget, 'outside-before\n');
  await fs.symlink(outsideTarget, path.join(source, 'src', 'escape-link.txt'));
  const recordedBodies = [];
  const fetch = async (_url, options) => {
    recordedBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      ok: false,
      quarantined: true,
      policyDecision: { reasonCodes: ['raw_terminal_quarantine'] },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-symlink',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  try {
    const quarantine = await createCodeSiteQuarantineWorkspace(context, source, {
      baseDir,
      operation: 'exec',
    });
    assert.deepStrictEqual(quarantine.symlinkSanitization.sanitized.map((item) => item.path), ['src/escape-link.txt']);
    const overlayLinkPath = path.join(quarantine.cwd, 'src', 'escape-link.txt');
    const overlayStat = await fs.lstat(overlayLinkPath);
    assert.strictEqual(overlayStat.isSymbolicLink(), false);

    await fs.writeFile(overlayLinkPath, 'overlay-only\n');
    const result = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, { fetch });

    assert.strictEqual(await fs.readFile(outsideTarget, 'utf8'), 'outside-before\n');
    assert.deepStrictEqual(result.changes.map((change) => change.path), ['src/escape-link.txt']);
    assert.strictEqual(result.changes[0].quarantineEvidence.afterText, 'overlay-only\n');
    const manifest = await readCodeSiteQuarantineManifest(baseDir, 'acme', quarantine.quarantineId);
    assert.deepStrictEqual(manifest.symlinkSanitization.sanitized.map((item) => item.path), ['src/escape-link.txt']);
    assert.strictEqual(manifest.changes[0].path, 'src/escape-link.txt');
    assert.strictEqual(recordedBodies[0].codesiteFsEvent.details.quarantine_evidence.afterText, 'overlay-only\n');
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test('can record headless terminal quarantine evidence without closing the overlay', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-headless-src-'));
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-headless-quarantine-'));
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src', 'app.js'), 'before\n');
  const recordedBodies = [];
  const fetch = async (_url, options) => {
    recordedBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      ok: false,
      quarantined: true,
      policyDecision: { reasonCodes: ['raw_terminal_quarantine'] },
    }), { status: 200 });
  };
  const context = {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-headless',
    mutationLeaseId: 'lease-1',
    allowedPaths: ['src/**'],
    controlPlaneUrl: 'http://app.test/api/workspace/acme/codesite',
  };

  try {
    const quarantine = await createCodeSiteQuarantineWorkspace(context, source, {
      baseDir,
      operation: 'exec-terminal',
    });
    await fs.writeFile(path.join(quarantine.cwd, 'src', 'app.js'), 'after-one\n');

    const first = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, {
      fetch,
      cleanup: false,
      resetBaseline: true,
    });

    assert.deepStrictEqual(first.changes.map((change) => change.path), ['src/app.js']);
    assert.ok(await fs.stat(quarantine.cwd), 'quarantine cwd remains available for terminal reattachment');

    const second = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, {
      fetch,
      cleanup: false,
      resetBaseline: true,
    });
    assert.deepStrictEqual(second.changes, [], 'unchanged overlay is not reported twice');

    await fs.writeFile(path.join(quarantine.cwd, 'src', 'later.js'), 'later\n');
    const third = await finalizeCodeSiteQuarantineWorkspace(context, quarantine, {
      fetch,
      cleanup: true,
    });
    assert.deepStrictEqual(third.changes.map((change) => change.path), ['src/later.js']);
    assert.deepStrictEqual(recordedBodies.map((body) => body.path), ['src/app.js', 'src/later.js']);
    assert.match(recordedBodies[0].codesiteFsEvent.details.quarantine_evidence.evidenceRef, /^codesitefs:quarantine:sha256:/);
    assert.match(first.changes[0].beforeDigest, /^sha256:/);
    assert.match(first.changes[0].afterDigest, /^sha256:/);
    await assert.rejects(() => fs.stat(quarantine.cwd));
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
