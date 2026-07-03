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

function codeSiteIndexContext(slug, overrides = {}) {
  return codeSiteContext(slug, {
    allowedTools: ['git_index'],
    ...overrides,
  });
}

function createCodeSiteFetch({
  writeSet = ['src/**'],
  readSet = [],
  recordBodies = [],
  readBodies = [],
  commitBodies = [],
  proofBundle = null,
  commitResponse = null,
  commitStatus = 200,
} = {}) {
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
          readSet,
          observedReadSet: [],
          writeSet,
          observedWriteSet: [],
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-direct-1/record-read')) {
      const body = JSON.parse(options.body || '{}');
      readBodies.push(body);
      return new Response(JSON.stringify({
        transaction: {
          id: 'txn-direct-1',
          status: 'open',
          readSet: [body.path],
          observedReadSet: [body.path],
        },
      }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-direct-1/record-write')) {
      const body = JSON.parse(options.body || '{}');
      recordBodies.push(body);
      return new Response(JSON.stringify({ ok: true, eventId: `event-${recordBodies.length}` }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-direct-1/commit')) {
      const body = JSON.parse(options.body || '{}');
      commitBodies.push(body);
      if (commitResponse) {
        return new Response(JSON.stringify(commitResponse), { status: commitStatus });
      }
      return new Response(JSON.stringify({
        transaction: { id: 'txn-direct-1' },
        proofBundle: proofBundle || {
          projectId: 'project-direct',
          displayCallsign: 'ATLAS-DIRECT',
          transactionId: 'txn-direct-1',
          mutationLeaseId: 'lease-direct-1',
          readSetDigest: 'sha256:read-direct',
          writeSetDigest: 'sha256:write-direct',
          bundleDigest: 'sha256:bundle-direct',
          portableDigest: 'sha256:portable-direct',
          invariants: ['unit:pass'],
          landingStatus: 'landed',
          proofSignature: {
            keyId: 'codesite-test-authority',
            signature: 'hmac-sha256:test-signature',
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected_url' }), { status: 404 });
  };
  return { fetch, calls, recordBodies, readBodies, commitBodies };
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

test('direct gitService.readFile records managed filesystem reads through CodeSiteFS', async (t) => {
  const slug = uniqueSlug('codesite-read');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'contract.ts'), 'export const version = 1;\n');
    const readBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: [], readBodies });

    const content = await gitService.readFile(slug, 'src/contract.ts', userId, {
      codesiteContext: codeSiteContext(slug, {
        allowedTools: ['file_write'],
        processAncestry: ['codex:read-test'],
      }),
      fetch,
      evidenceRefs: ['direct:read-file'],
      processAncestry: ['gitService:readFile'],
      tool: 'file_read',
    });

    assert.strictEqual(content, 'export const version = 1;\n');
    assert.strictEqual(readBodies.length, 1);
    assert.strictEqual(readBodies[0].path, 'src/contract.ts');
    assert.strictEqual(readBodies[0].tool, 'file_read');
    assert.strictEqual(readBodies[0].codesiteFsEvent.type, 'read_observed');
    assert.deepStrictEqual(readBodies[0].processAncestry, ['codex:read-test', 'gitService:readFile']);
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

test('direct gitService.stageFile records git_index before staging a path', async (t) => {
  const slug = uniqueSlug('codesite-stage-file');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.stageFile(slug, 'src/app.js', userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch,
      evidenceRefs: ['direct:stage-file'],
    });

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), 'src/app.js');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['src/app.js', 'git_index', 'write_allowed', 'stage'],
    ]);
  });
});

test('direct gitService.stageFile blocks unauthorized index writes before staging', async (t) => {
  const slug = uniqueSlug('codesite-stage-file-denied');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'api/auth/signup.ts': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.stageFile(slug, 'api/auth/signup.ts', userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.operation === 'stage'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), '');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8'), 'after\n');
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.tool, body.codesiteFsEvent.type]), [
      ['api/auth/signup.ts', 'git_index', 'write_denied'],
    ]);
  });
});

test('direct gitService.commit without CodeSite context stays a plain user commit', async (t) => {
  const slug = uniqueSlug('plain-commit');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'plain after\n');
    await git(repoPath, ['add', 'src/app.js']);
    const { fetch, calls } = createCodeSiteFetch();

    await gitService.commit(slug, 'Plain user commit', userId, false, null, { fetch });

    const { stdout: message } = await git(repoPath, ['log', '-1', '--pretty=%B']);
    assert.match(message, /Plain user commit/);
    assert.doesNotMatch(message, /CodeSite-Transaction:/);
    assert.doesNotMatch(message, /CodeSite-Proof-Digest:/);
    assert.strictEqual(calls.length, 0);
  });
});

test('direct gitService.commit completes CodeSite proof and writes portable trailers', async (t) => {
  const slug = uniqueSlug('codesite-commit-proof');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await git(repoPath, ['add', 'src/app.js']);
    const commitBodies = [];
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], commitBodies, recordBodies });

    await gitService.commit(slug, 'Land CodeSite transaction', userId, false, null, {
      codesiteContext: codeSiteContext(slug, { allowedTools: ['git_refs'] }),
      fetch,
      evidenceRefs: ['direct:commit'],
      data: {
        evidenceRefs: ['payload:evidence'],
        repoState: { supplied: true },
      },
    });

    const { stdout: message } = await git(repoPath, ['log', '-1', '--pretty=%B']);
    assert.match(message, /Land CodeSite transaction/);
    assert.match(message, /CodeSite-Clearance: lease-direct-1/);
    assert.match(message, /CodeSite-Transaction: txn-direct-1/);
    assert.match(message, /CodeSite-Lease: lease-direct-1/);
    assert.match(message, /CodeSite-Read-Set: sha256:read-direct/);
    assert.match(message, /CodeSite-Write-Set: sha256:write-direct/);
    assert.match(message, /CodeSite-Black-Box: sha256:bundle-direct/);
    assert.match(message, /CodeSite-Proof-Digest: sha256:portable-direct/);
    assert.match(message, /CodeSite-Proof-Authority: codesite-test-authority/);
    assert.match(message, /CodeSite-Proof-Signature: hmac-sha256:test-signature/);
    assert.strictEqual(commitBodies.length, 1);
    assert.deepStrictEqual(commitBodies[0].evidenceRefs, ['payload:evidence', 'direct:commit']);
    assert.deepStrictEqual(commitBodies[0].repoState, { supplied: true });
    assert.strictEqual(recordBodies.length, 1);
    assert.strictEqual(recordBodies[0].path, '**');
    assert.strictEqual(recordBodies[0].tool, 'git_refs');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.type, 'write_allowed');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.details.operation, 'commit');
  });
});

test('direct gitService.commit blocks managed CodeSite commits without a transaction', async (t) => {
  const slug = uniqueSlug('codesite-commit-no-transaction');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await git(repoPath, ['add', 'src/app.js']);

    await assert.rejects(
      () => gitService.commit(slug, 'Plain managed commit', userId, false, null, {
        codesiteContext: codeSiteContext(slug, {
          transactionId: null,
          agentSessionId: 'agent-direct-1',
          managedAgent: true,
        }),
      }),
      (error) => error.code === 'CODESITE_COMMIT_BLOCKED'
        && error.details.reasonCodes.includes('codesite_transaction_required'),
    );

    const { stdout: lastMessage } = await git(repoPath, ['log', '-1', '--pretty=%s']);
    assert.strictEqual(lastMessage.trim(), 'initial');
  });
});

test('direct gitService.commit leaves HEAD unchanged when proof validation rejects', async (t) => {
  const slug = uniqueSlug('codesite-commit-proof-rejected');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    const { stdout: beforeHead } = await git(repoPath, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after rejected\n');
    await git(repoPath, ['add', 'src/app.js']);
    const commitBodies = [];
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({
      writeSet: ['src/**'],
      commitBodies,
      recordBodies,
      commitResponse: { decision: { ok: false, reasonCodes: ['landing_inspection_required'] } },
    });

    await assert.rejects(
      () => gitService.commit(slug, 'Rejected CodeSite transaction', userId, false, null, {
        codesiteContext: codeSiteContext(slug, { allowedTools: ['git_refs'] }),
        fetch,
      }),
      (error) => error.code === 'CODESITE_COMMIT_BLOCKED'
        && error.details.reasonCodes.includes('landing_inspection_required'),
    );

    const { stdout: afterHead } = await git(repoPath, ['rev-parse', 'HEAD']);
    assert.strictEqual(afterHead.trim(), beforeHead.trim());
    assert.strictEqual(commitBodies.length, 1);
    assert.strictEqual(recordBodies.length, 0);
  });
});

test('direct gitService.stageLines records git_index before staging approved hunks', async (t) => {
  const slug = uniqueSlug('codesite-stage-lines');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'one\ntwo\nthree\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.stageLines(slug, 'src/app.js', patch, userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch,
      evidenceRefs: ['direct:stage-lines'],
    });

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    const { stdout: worktreeNames } = await git(repoPath, ['diff', '--name-only']);
    assert.strictEqual(cachedNames.trim(), 'src/app.js');
    assert.strictEqual(worktreeNames.trim(), '');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['src/app.js', 'git_index', 'write_allowed', 'stage-lines'],
    ]);
  });
});

test('direct gitService.stageLines gates the actual patch target before staging hunks', async (t) => {
  const slug = uniqueSlug('codesite-stage-lines-forged');
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
      () => gitService.stageLines(slug, 'src/app.js', patch, userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.operation === 'stage-lines'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), '');
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.tool, body.codesiteFsEvent.type]), [
      ['api/auth/signup.ts', 'git_index', 'write_denied'],
    ]);
  });
});

test('direct gitService.stageLines rejects mismatched patch targets even inside the write set', async (t) => {
  const slug = uniqueSlug('codesite-stage-lines-mismatch');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'app before\n',
      'src/other.js': 'other before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/other.js'), 'other after\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/other.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.stageLines(slug, 'src/app.js', patch, userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'PATCH_PATH_MISMATCH'
        && error.details.expectedPath === 'src/app.js'
        && error.details.patchPaths.includes('src/other.js'),
    );

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), '');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['src/other.js', 'git_index', 'write_allowed', 'stage-lines'],
    ]);
  });
});

test('direct gitService.unstageFile records git_index and disambiguates same-name branches', async (t) => {
  const slug = uniqueSlug('codesite-unstage-file');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    await git(repoPath, ['checkout', '-b', 'src/app.js']);
    await git(repoPath, ['checkout', 'main']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await git(repoPath, ['add', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.unstageFile(slug, 'src/app.js', userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch,
    });

    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(currentBranch.trim(), 'main');
    assert.strictEqual(cachedNames.trim(), '');
    assert.strictEqual(await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8'), 'after\n');
    assert.strictEqual(recordBodies[0].codesiteFsEvent.details.operation, 'unstage');
  });
});

test('direct gitService.unstageFile blocks unauthorized paths before mutating the index', async (t) => {
  const slug = uniqueSlug('codesite-unstage-file-denied');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'api/auth/signup.ts': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    await git(repoPath, ['add', '--', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.unstageFile(slug, 'api/auth/signup.ts', userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.operation === 'unstage'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), 'api/auth/signup.ts');
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.tool, body.codesiteFsEvent.type]), [
      ['api/auth/signup.ts', 'git_index', 'write_denied'],
    ]);
  });
});

test('direct gitService.unstageLines gates patch targets and unstages only after CodeSiteFS allows', async (t) => {
  const slug = uniqueSlug('codesite-unstage-lines');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'one\ntwo\nthree\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n');
    await git(repoPath, ['add', 'src/app.js']);
    const { stdout: patch } = await git(repoPath, ['diff', '--cached', '--unified=0', '--', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await gitService.unstageLines(slug, 'src/app.js', patch, userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch,
      evidenceRefs: ['direct:unstage-lines'],
    });

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    const { stdout: worktreeNames } = await git(repoPath, ['diff', '--name-only']);
    assert.strictEqual(cachedNames.trim(), '');
    assert.strictEqual(worktreeNames.trim(), 'src/app.js');
    assert.deepStrictEqual(recordBodies.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['src/app.js', 'git_index', 'write_allowed', 'unstage-lines'],
    ]);
  });
});

test('direct gitService.unstageLines denies forged patch targets before mutating the index', async (t) => {
  const slug = uniqueSlug('codesite-unstage-lines-forged');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'src before\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n');
    await git(repoPath, ['add', '--', 'api/auth/signup.ts']);
    const { stdout: patch } = await git(repoPath, ['diff', '--cached', '--unified=0', '--', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.unstageLines(slug, 'src/app.js', patch, userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === 'api/auth/signup.ts'
        && error.event.details.operation === 'unstage-lines'
        && error.event.details.reason_codes.includes('outside_clearance_route'),
    );

    const { stdout: cachedNames } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedNames.trim(), 'api/auth/signup.ts');
    assert.deepStrictEqual(recordBodies.map((body) => [body.path, body.tool, body.codesiteFsEvent.type]), [
      ['api/auth/signup.ts', 'git_index', 'write_denied'],
    ]);
  });
});

test('direct gitService.stageAll requires broad index clearance before staging everything', async (t) => {
  const slug = uniqueSlug('codesite-stage-all');
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
      () => gitService.stageAll(slug, userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'stage-all',
    );

    const { stdout: cachedAfterDeny } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.strictEqual(cachedAfterDeny.trim(), '');

    const allowAllRecords = [];
    const { fetch: allowAllFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowAllRecords });
    await gitService.stageAll(slug, userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch: allowAllFetch,
    });

    const { stdout: cachedAfterAllow } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.deepStrictEqual(cachedAfterAllow.trim().split('\n').sort(), ['api/auth/signup.ts', 'src/app.js']);
    assert.deepStrictEqual(allowAllRecords.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_index', 'write_allowed', 'stage-all'],
    ]);
  });
});

test('direct gitService.unstageAll requires broad index clearance before unstaging everything', async (t) => {
  const slug = uniqueSlug('codesite-unstage-all');
  const userId = 'user-1';
  await withTempGitService(t, slug, userId, async ({ repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    await git(repoPath, ['add', '--', 'src/app.js', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });

    await assert.rejects(
      () => gitService.unstageAll(slug, userId, {
        codesiteContext: codeSiteIndexContext(slug),
        fetch,
      }),
      (error) => error.code === 'CODESITE_WRITE_DENIED'
        && error.event.path === '**'
        && error.event.details.operation === 'unstage-all',
    );

    const { stdout: cachedAfterDeny } = await git(repoPath, ['diff', '--cached', '--name-only']);
    assert.deepStrictEqual(cachedAfterDeny.trim().split('\n').sort(), ['api/auth/signup.ts', 'src/app.js']);

    const allowAllRecords = [];
    const { fetch: allowAllFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowAllRecords });
    await gitService.unstageAll(slug, userId, {
      codesiteContext: codeSiteIndexContext(slug),
      fetch: allowAllFetch,
    });

    const { stdout: cachedAfterAllow } = await git(repoPath, ['diff', '--cached', '--name-only']);
    const { stdout: worktreeAfterAllow } = await git(repoPath, ['diff', '--name-only']);
    assert.strictEqual(cachedAfterAllow.trim(), '');
    assert.deepStrictEqual(worktreeAfterAllow.trim().split('\n').sort(), ['api/auth/signup.ts', 'src/app.js']);
    assert.deepStrictEqual(allowAllRecords.map((body) => [
      body.path,
      body.tool,
      body.codesiteFsEvent.type,
      body.codesiteFsEvent.details.operation,
    ]), [
      ['**', 'git_index', 'write_allowed', 'unstage-all'],
    ]);
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
