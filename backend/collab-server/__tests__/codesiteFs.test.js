const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  assertCodeSiteWriteAllowed,
  codeSiteCommitMessage,
  codeSiteCommitTrailers,
  codeSiteContextFromRequest,
  codeSiteRuntimeEnv,
  codeSiteRuntimeMetadata,
  completeCodeSiteCommitProof,
  createCodeSiteQuarantineWorkspace,
  enforceCodeSiteWriteAllowed,
  evaluateCodeSiteWrite,
  finalizeCodeSiteQuarantineWorkspace,
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
    processAncestry: ['node', 'collab-server'],
  };

  const result = await enforceCodeSiteWriteAllowed(context, {
    path: 'synthi/src/App.jsx',
    tool: 'file_write',
    kind: 'write-file',
  }, { fetch });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'http://app.test/api/workspace/acme/codesite/transactions/txn-1/record-write');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    path: 'synthi/src/App.jsx',
    tool: 'file_write',
    evidenceRefs: [],
    processAncestry: ['node', 'collab-server'],
    codesiteFsEvent: result.event,
  });
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
    assert.strictEqual(calls.length, 2);
    const firstBody = JSON.parse(calls[0].options.body);
    assert.strictEqual(firstBody.codesiteFsEvent.type, 'write_quarantined');
    assert.deepStrictEqual(firstBody.codesiteFsEvent.details.reason_codes, ['raw_terminal_quarantine']);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_root, /codesite-quarantine/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.beforeDigest, /^sha256:/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.afterDigest, /^sha256:/);
    assert.match(firstBody.codesiteFsEvent.details.quarantine_evidence.evidenceRef, /^codesitefs:quarantine:sha256:/);
    assert.ok(firstBody.codesiteFsEvent.details.quarantine_evidence.textDiff.lines.some((line) => line === '-before'));
    assert.ok(firstBody.codesiteFsEvent.details.quarantine_evidence.textDiff.lines.some((line) => line === '+after'));
    assert.strictEqual(await fs.readFile(path.join(source, 'src', 'app.js'), 'utf8'), 'before\n');
  } finally {
    await fs.rm(source, { recursive: true, force: true });
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
