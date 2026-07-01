const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config');
const gitService = require('../gitService');

function uniqueSlug(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function codeSiteContext(slug, overrides = {}) {
  return {
    active: true,
    workspaceSlug: slug,
    transactionId: 'txn-direct-1',
    mutationLeaseId: 'lease-direct-1',
    controlPlaneUrl: `http://codesite.test/api/workspace/${slug}/codesite`,
    allowedPaths: ['forged-client-path/**'],
    allowedTools: ['file_write', 'file_delete', 'file_rename'],
    evidenceRefs: ['context:proof'],
    processAncestry: ['unit-test'],
    ...overrides,
  };
}

function createCodeSiteFetch({ writeSet = ['src/**'], recordBodies = [] } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/transactions/txn-direct-1')) {
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-direct-1',
          status: 'open',
          mutationLeaseId: 'lease-direct-1',
          agentSessionId: 'agent-direct-1',
          writeSet,
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-direct-1/record-write')) {
      const body = JSON.parse(options.body || '{}');
      recordBodies.push(body);
      return new Response(JSON.stringify({ ok: true, eventId: `event-${recordBodies.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected_url' }), { status: 404 });
  };
  return { fetch, calls, recordBodies };
}

async function withTempGitService(t, slug, userId, fn) {
  const previousBaseDir = gitService.baseDir;
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitservice-codesite-'));
  gitService.baseDir = baseDir;
  const repoPath = gitService.getEffectiveRepoPath(slug, userId);
  await fs.mkdir(repoPath, { recursive: true });
  t.after(async () => {
    gitService.baseDir = previousBaseDir;
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(path.join(config.REPO_CACHE_DIR, slug), { recursive: true, force: true });
  });
  return fn({ baseDir, repoPath });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test('legacy direct gitService.writeFile still writes without CodeSite context', async (t) => {
  const slug = uniqueSlug('legacy-write');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await gitService.writeFile(slug, 'src/app.js', 'legacy write\n', userId);

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'legacy write\n');
    assert.strictEqual(gitService.safeWriteFile, undefined);
  });
});

test('direct gitService.writeFile records CodeSiteFS evidence before mutating', async (t) => {
  const slug = uniqueSlug('codesite-write');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    const recordBodies = [];
    const { fetch, calls } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const context = codeSiteContext(slug);

    await gitService.writeFile(slug, 'src/app.js', 'codesite write\n', userId, {
      codesiteContext: context,
      fetch,
      evidenceRefs: ['direct:write'],
      processAncestry: ['gitService.writeFile'],
      lineProvenance: [{ filePath: 'src/app.js', startLine: 1, endLine: 1, lineAnchor: 'src/app.js#L1-L1' }],
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'codesite write\n');
    assert.ok(calls.some((call) => String(call.url).endsWith('/transactions/txn-direct-1')));
    assert.strictEqual(recordBodies.length, 1);
    assert.strictEqual(recordBodies[0].path, 'src/app.js');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_allowed');
    assert.deepStrictEqual(recordBodies[0].evidenceRefs, ['context:proof', 'direct:write']);
    assert.deepStrictEqual(recordBodies[0].processAncestry, ['unit-test', 'gitService.writeFile']);
    assert.strictEqual(recordBodies[0].lineProvenance[0].lineAnchor, 'src/app.js#L1-L1');
  });
});

test('direct gitService.writeFilesBatch blocks mixed CodeSite batches before partial writes', async (t) => {
  const slug = uniqueSlug('codesite-batch');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/allowed.js'), 'before\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.writeFilesBatch(slug, [
        { path: 'src/allowed.js', content: 'after\n' },
        { path: 'api/auth/signup.ts', content: 'blocked\n' },
      ], {
        userId,
        codesiteContext: codeSiteContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/allowed.js'), 'utf8'), 'before\n');
    assert.strictEqual(await exists(path.join(repoPath, 'api/auth/signup.ts')), false);
    assert.deepStrictEqual(recordBodies.map((body) => body.path), ['api/auth/signup.ts']);
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_denied');
  });
});

test('direct gitService.renameItem blocks symlink-parent escapes before moving source', async (t) => {
  const slug = uniqueSlug('codesite-rename-symlink');
  const userId = 'user-1';
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitservice-codesite-outside-'));
  t.after(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'inside\n');
    await fs.symlink(outside, path.join(repoPath, 'linked-outside'));
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**', 'linked-outside/**'], recordBodies });

    await assert.rejects(
      () => gitService.renameItem(slug, 'src/app.js', 'linked-outside/app.js', userId, {
        codesiteContext: codeSiteContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'linked-outside/app.js'
        && error.event.details.reason_codes.includes('repo_parent_symlink_escape'),
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'inside\n');
    assert.strictEqual(await exists(path.join(outside, 'app.js')), false);
    assert.deepStrictEqual(recordBodies.map((body) => body.path), ['linked-outside/app.js']);
  });
});

test('direct gitService.writeFile blocks inside-repo symlink aliases before write-set bypass', async (t) => {
  const slug = uniqueSlug('codesite-symlink-alias');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'secret'), { recursive: true });
    await fs.symlink(path.join(repoPath, 'secret'), path.join(repoPath, 'allowed-link'));
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['allowed-link/**'], recordBodies });

    await assert.rejects(
      () => gitService.writeFile(slug, 'allowed-link/new.js', 'alias write\n', userId, {
        codesiteContext: codeSiteContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'allowed-link/new.js'
        && error.event.details.reason_codes.includes('repo_path_symlink_alias'),
    );

    assert.strictEqual(await exists(path.join(repoPath, 'secret/new.js')), false);
    assert.deepStrictEqual(recordBodies.map((body) => body.path), ['allowed-link/new.js']);
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_denied');
  });
});

test('direct gitService.syncFile and deleteItem use CodeSiteFS boundary metadata', async (t) => {
  const slug = uniqueSlug('codesite-sync-delete');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/old.js'), 'old\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.syncFile(slug, 'src/synced.js', 'synced\n', userId, {
      codesiteContext: codeSiteContext(slug),
      fetch,
      evidenceRefs: ['direct:sync'],
    });
    await gitService.deleteItem(slug, 'src/old.js', userId, {
      codesiteContext: codeSiteContext(slug),
      fetch,
      evidenceRefs: ['direct:delete'],
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/synced.js'), 'utf8'), 'synced\n');
    assert.strictEqual(await exists(path.join(repoPath, 'src/old.js')), false);
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.tool]), [
      ['src/synced.js', 'file_write'],
      ['src/old.js', 'file_delete'],
    ]);
    assert.deepStrictEqual(recordBodies.map((body) => body.codesiteFsEvent.type), ['write_allowed', 'write_allowed']);
  });
});

test('direct gitService.createDirectory can be required to fail closed without CodeSite context', async (t) => {
  const slug = uniqueSlug('codesite-required');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await assert.rejects(
      () => gitService.createDirectory(slug, 'src/new-dir', userId, { requireCodeSiteBoundary: true }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.details.reason_codes.includes('codesite_context_required'),
    );

    assert.strictEqual(await exists(path.join(repoPath, 'src/new-dir')), false);
  });
});

test('nested CodeSite options can override authoritative hydration', async (t) => {
  const slug = uniqueSlug('codesite-nested-options');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (String(url).endsWith('/transactions/txn-direct-1')) {
        return new Response(JSON.stringify({ error: 'unexpected_hydration' }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await gitService.writeFile(slug, 'src/monitor.js', 'nested option write\n', userId, {
      codesiteContext: codeSiteContext(slug, {
        allowedPaths: ['src/**'],
      }),
      codesiteOptions: {
        fetch,
        requireAuthoritativeContext: false,
      },
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/monitor.js'), 'utf8'), 'nested option write\n');
    assert.strictEqual(calls.some((call) => String(call.url).endsWith('/transactions/txn-direct-1')), false);
    assert.strictEqual(calls.some((call) => String(call.url).endsWith('/transactions/txn-direct-1/record-write')), true);
  });
});
