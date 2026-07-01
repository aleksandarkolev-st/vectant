const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('../config');
const gitService = require('../gitService');

const execFileAsync = promisify(execFile);

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

function codeSiteWorktreeContext(slug, overrides = {}) {
  return codeSiteContext(slug, {
    allowedTools: ['git_worktree'],
    ...overrides,
  });
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

async function git(repoPath, args) {
  return execFileAsync('git', ['-C', repoPath, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

async function initTrackedRepo(repoPath, files = { 'src/app.js': 'before\n' }) {
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'test@example.com']);
  await git(repoPath, ['config', 'user.name', 'CodeSite Test']);
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repoPath, relPath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, relPath), content);
  }
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'initial']);
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

test('direct gitService.discardChange records git_worktree before reverting a tracked file', async (t) => {
  const slug = uniqueSlug('codesite-discard-change');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.discardChange(slug, 'src/app.js', userId, {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch,
      evidenceRefs: ['direct:discard'],
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'before\n');
    assert.strictEqual(recordBodies.length, 1);
    assert.strictEqual(recordBodies[0].path, 'src/app.js');
    assert.strictEqual(recordBodies[0].tool, 'git_worktree');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_allowed');
  });
});

test('direct gitService.discardChange blocks unauthorized worktree reverts before git checkout', async (t) => {
  const slug = uniqueSlug('codesite-discard-denied');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.discardChange(slug, 'api/auth/signup.ts', userId, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'after\n');
    assert.deepStrictEqual(recordBodies.map((body) => body.path), ['api/auth/signup.ts']);
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_denied');
  });
});

test('direct gitService.discardLines records boundary before reverse-applying a patch hunk', async (t) => {
  const slug = uniqueSlug('codesite-discard-lines');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'one\ntwo\nthree\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.discardLines(slug, 'src/app.js', patch, userId, {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch,
      evidenceRefs: ['direct:discard-lines'],
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'one\ntwo\nthree\n');
    assert.strictEqual(recordBodies[0].path, 'src/app.js');
    assert.strictEqual(recordBodies[0].tool, 'git_worktree');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_allowed');
  });
});

test('direct gitService.discardLines gates the actual patch target, not the claimed filePath', async (t) => {
  const slug = uniqueSlug('codesite-discard-lines-forged');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'src before\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.discardLines(slug, 'src/app.js', patch, userId, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.operation === 'discard-lines'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'api after\n');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['api/auth/signup.ts', 'git_worktree', 'write_denied', 'discard-lines'],
    ]);
  });
});

test('direct gitService.discardChange disambiguates file checkout from same-name branches', async (t) => {
  const slug = uniqueSlug('codesite-discard-branch-name');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    await git(repoPath, ['checkout', '-b', 'src/app.js']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'branch\n');
    await git(repoPath, ['add', 'src/app.js']);
    await git(repoPath, ['commit', '-m', 'branch same as file path']);
    await git(repoPath, ['checkout', 'main']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.discardChange(slug, 'src/app.js', userId, {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch,
    });

    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    assert.strictEqual(currentBranch.trim(), 'main');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'main\n');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_allowed');
  });
});

test('direct gitService.discardAll requires broad worktree clearance', async (t) => {
  const slug = uniqueSlug('codesite-discard-all');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.discardAll(slug, userId, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'after\n');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'after\n');
    assert.strictEqual(recordBodies[0].path, '**');

    const allowAllRecords = [];
    const { fetch: allowAllFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowAllRecords });
    await gitService.discardAll(slug, userId, {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch: allowAllFetch,
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'before\n');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'before\n');
    assert.deepStrictEqual(allowAllRecords.map((body) => [body.path, body.tool, body.codesiteFsEvent.type]), [
      ['**', 'git_worktree', 'write_allowed'],
    ]);
  });
});

test('direct gitService conflict operations block outside write-set before git checkout/add', async (t) => {
  const slug = uniqueSlug('codesite-conflict-denied');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'api/auth/signup.ts': 'before\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    for (const [method, expectedKind] of [
      ['resolveConflictOurs', 'resolve-ours'],
      ['resolveConflictTheirs', 'resolve-theirs'],
      ['markResolved', 'mark-resolved'],
    ]) {
      await assert.rejects(
        () => gitService[method](slug, 'api/auth/signup.ts', userId, {
          codesiteContext: codeSiteWorktreeContext(slug),
          fetch,
        }),
        (error) => error.code === 'CODESITE_WRITE_DENIED'
          && error.event.path === 'api/auth/signup.ts'
          && error.event.details.operation === expectedKind
          && error.event.details.reason_codes.includes('outside_clearance_route'),
      );
    }

    assert.deepStrictEqual(recordBodies.map((body) => body.codesiteFsEvent.details.operation), [
      'resolve-ours',
      'resolve-theirs',
      'mark-resolved',
    ]);
  });
});

test('direct gitService.checkout requires broad worktree clearance before switching branches', async (t) => {
  const slug = uniqueSlug('codesite-checkout-broad');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'main\n',
      'api/auth/signup.ts': 'main\n',
    });
    await git(repoPath, ['checkout', '-b', 'feature/auth']);
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'feature\n');
    await git(repoPath, ['add', 'api/auth/signup.ts']);
    await git(repoPath, ['commit', '-m', 'feature auth']);
    await git(repoPath, ['checkout', 'main']);

    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.checkout(slug, 'feature/auth', false, userId, 'normal', null, [], {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'checkout'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: currentBranchAfterDeny } = await git(repoPath, ['branch', '--show-current']);
    assert.strictEqual(currentBranchAfterDeny.trim(), 'main');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'main\n');
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.codesiteFsEvent.type]), [
      ['**', 'write_denied'],
    ]);

    const allowAllRecords = [];
    const { fetch: allowAllFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowAllRecords });
    await gitService.checkout(slug, 'feature/auth', false, userId, 'normal', null, [], {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch: allowAllFetch,
      evidenceRefs: ['direct:checkout'],
    });

    const { stdout: currentBranchAfterAllow } = await git(repoPath, ['branch', '--show-current']);
    assert.strictEqual(currentBranchAfterAllow.trim(), 'feature/auth');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'feature\n');
    assert.deepStrictEqual(allowAllRecords.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_worktree', 'write_allowed', 'checkout'],
    ]);
  });
});

test('direct gitService.stashPop requires broad worktree clearance before applying stash', async (t) => {
  const slug = uniqueSlug('codesite-stash-pop-broad');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'stashed\n');
    await git(repoPath, ['stash', 'push', '-m', 'saved change']);
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'before\n');

    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.stashPop(slug, 0, userId, null, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'stash-pop',
    );

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'before\n');
    const { stdout: stashAfterDeny } = await git(repoPath, ['stash', 'list']);
    assert.match(stashAfterDeny, /saved change/);

    const allowAllRecords = [];
    const { fetch: allowAllFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowAllRecords });
    await gitService.stashPop(slug, 0, userId, null, {
      codesiteContext: codeSiteWorktreeContext(slug),
      fetch: allowAllFetch,
    });

    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'stashed\n');
    const { stdout: stashAfterAllow } = await git(repoPath, ['stash', 'list']);
    assert.strictEqual(stashAfterAllow.trim(), '');
    assert.deepStrictEqual(allowAllRecords.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_worktree', 'write_allowed', 'stash-pop'],
    ]);
  });
});

test('direct gitService.mergeBranch blocks before fetch or merge without broad clearance', async (t) => {
  const slug = uniqueSlug('codesite-merge-broad');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.mergeBranch(slug, 'feature/auth', userId, null, null, [], null, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'merge-branch'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    assert.strictEqual(currentBranch.trim(), 'main');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'main\n');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_worktree', 'write_denied', 'merge-branch'],
    ]);
  });
});

test('direct gitService.pull blocks before remote worktree changes without broad clearance', async (t) => {
  const slug = uniqueSlug('codesite-pull-broad');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.pull(slug, userId, null, null, [], null, {
        codesiteContext: codeSiteWorktreeContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'pull'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    assert.strictEqual(currentBranch.trim(), 'main');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'main\n');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_worktree', 'write_denied', 'pull'],
    ]);
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
