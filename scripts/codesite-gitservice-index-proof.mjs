import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const proofDir = path.join(repoRoot, 'tmp', 'codesite-dojo-proof');
const proofJsonPath = path.join(proofDir, 'codesite-gitservice-index-proof.json');
const proofHtmlPath = path.join(proofDir, 'codesite-gitservice-index-proof.html');
const proofPngPath = path.join(proofDir, 'codesite-gitservice-index-proof.png');
const args = new Set(process.argv.slice(2));

function proofTempRoot() {
  return path.resolve(process.env.CODESITE_PROOF_TMPDIR || path.join(proofDir, '.tmp'));
}

async function ensureProofTempRoot() {
  const tempRoot = proofTempRoot();
  await fs.mkdir(tempRoot, { recursive: true });
  return tempRoot;
}

async function ensureBrowserTempRoot() {
  const tempRoot = path.resolve(process.env.CODESITE_BROWSER_TMPDIR || '/tmp/codesite-playwright');
  await fs.mkdir(tempRoot, { recursive: true });
  process.env.TMPDIR = tempRoot;
  return tempRoot;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function slug(prefix) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function contextFor(slugValue, overrides = {}) {
  return {
    active: true,
    workspaceSlug: slugValue,
    transactionId: 'txn-index-1',
    mutationLeaseId: 'lease-index-1',
    agentSessionId: 'agent-index-1',
    actorUserId: 'proof-user',
    effectiveUserId: 'proof-user',
    controlPlaneUrl: `http://codesite.test/api/workspace/${slugValue}/codesite`,
    controlPlaneTrusted: true,
    allowedTools: ['git_index'],
    evidenceRefs: ['proof:index-context'],
    processAncestry: ['index-proof-runner'],
    ...overrides,
  };
}

function createCodeSiteFetch({ writeSet = ['src/**'], recordBodies = [] } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const transaction = {
      id: 'txn-index-1',
      status: 'open',
      mutationLeaseId: 'lease-index-1',
      agentSessionId: 'agent-index-1',
      actorUserId: 'proof-user',
      effectiveUserId: 'proof-user',
      writeSet,
      observedWriteSet: [],
    };
    if (String(url).endsWith('/transactions/active')) {
      return new Response(JSON.stringify({ activeTransactions: [transaction] }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-index-1')) {
      return new Response(JSON.stringify({ transaction }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-index-1/record-write')) {
      const body = JSON.parse(options.body || '{}');
      recordBodies.push(body);
      return new Response(JSON.stringify({ ok: true, eventId: `event-${recordBodies.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected_url', url }), { status: 404 });
  };
  return { fetch, calls, recordBodies };
}

async function git(repoPath, gitArgs) {
  return execFileAsync('git', ['-C', repoPath, ...gitArgs], { maxBuffer: 8 * 1024 * 1024 });
}

async function initTrackedRepo(repoPath, files) {
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'proof@example.com']);
  await git(repoPath, ['config', 'user.name', 'CodeSite Proof']);
  for (const [relPath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repoPath, relPath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, relPath), content, 'utf8');
  }
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'initial']);
}

async function gitNames(repoPath, argsForDiff) {
  const { stdout } = await git(repoPath, argsForDiff);
  return stdout.trim() ? stdout.trim().split('\n').sort() : [];
}

async function expectReject(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to reject');
}

async function withTempGitService(slugValue, userId, fn) {
  const gitService = require('../backend/collab-server/gitService');
  const config = require('../backend/collab-server/config');
  const previousBaseDir = gitService.baseDir;
  const tempRoot = await ensureProofTempRoot();
  const baseDir = await fs.mkdtemp(path.join(tempRoot, 'codesite-gitservice-index-'));
  gitService.baseDir = baseDir;
  const repoPath = gitService.getEffectiveRepoPath(slugValue, userId);
  await fs.mkdir(repoPath, { recursive: true });
  try {
    return await fn({ gitService, config, repoPath });
  } finally {
    gitService.baseDir = previousBaseDir;
    await fs.rm(baseDir, { recursive: true, force: true });
    await fs.rm(path.join(config.REPO_CACHE_DIR, slugValue), { recursive: true, force: true }).catch(() => {});
  }
}

function proofAssert(assertions, ok, name, detail = {}) {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) {
    const error = new Error(`proof assertion failed: ${name}`);
    error.detail = detail;
    throw error;
  }
}

function eventRows(...recordGroups) {
  return recordGroups.flatMap((recordBodies) => recordBodies.map((body) => ({
      path: body.path,
      disposition: body.codesiteFsEvent?.type,
      tool: body.tool,
      operation: body.codesiteFsEvent?.details?.operation,
      evidenceRefs: body.evidenceRefs,
      reasonCodes: body.codesiteFsEvent?.details?.reason_codes,
    })));
}

async function runProof() {
  const userId = 'proof-user';
  const assertions = [];
  const scenarios = [];

  const stageFileSlug = slug('index-stage-file');
  await withTempGitService(stageFileSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n', 'utf8');

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: allowedRecords });
    await gitService.stageFile(stageFileSlug, 'src/app.js', userId, {
      codesiteContext: contextFor(stageFileSlug),
      fetch: allowedFetch,
      evidenceRefs: ['proof:stage-file'],
    });
    const cachedAfterAllow = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, cachedAfterAllow.join('\n') === 'src/app.js', 'stageFile records git_index before staging an allowed path', {
      cachedAfterAllow,
      event: allowedRecords[0]?.codesiteFsEvent?.type,
      tool: allowedRecords[0]?.tool,
    });

    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.stageFile(stageFileSlug, 'api/auth/signup.ts', userId, {
      codesiteContext: contextFor(stageFileSlug),
      fetch: deniedFetch,
    }));
    const cachedAfterDeny = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const apiContent = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, denied.event?.path === 'api/auth/signup.ts' && cachedAfterDeny.join('\n') === 'src/app.js' && apiContent === 'after\n', 'stageFile denial preserves the index for paths outside clearance', {
      deniedPath: denied.event?.path,
      cachedAfterDeny,
      reasonCodes: denied.event?.details?.reason_codes,
      digest: sha256(apiContent),
    });

    scenarios.push({
      name: 'Path-scoped stageFile',
      notes: [
        'A direct stageFile call recorded a git_index event before staging src/app.js.',
        'A second call targeting api/auth/signup.ts was denied before the index changed.',
      ],
      mutations: eventRows(allowedRecords, deniedRecords),
    });
  });

  const stageLinesSlug = slug('index-stage-lines');
  await withTempGitService(stageLinesSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'one\ntwo\nthree\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n', 'utf8');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.stageLines(stageLinesSlug, 'src/app.js', patch, userId, {
      codesiteContext: contextFor(stageLinesSlug),
      fetch,
      evidenceRefs: ['proof:stage-lines'],
    });
    const cachedNames = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const worktreeNames = await gitNames(repoPath, ['diff', '--name-only']);
    proofAssert(assertions, cachedNames.join('\n') === 'src/app.js' && worktreeNames.length === 0, 'stageLines stages approved hunks only after git_index clearance', {
      cachedNames,
      worktreeNames,
      event: recordBodies[0]?.codesiteFsEvent?.type,
      operation: recordBodies[0]?.codesiteFsEvent?.details?.operation,
    });
    scenarios.push({
      name: 'Patch hunk stage',
      notes: ['A real unified diff hunk was applied to the index only after CodeSiteFS recorded a path-scoped git_index allowance.'],
      mutations: eventRows(recordBodies),
    });
  });

  const forgedStageSlug = slug('index-stage-lines-forged');
  await withTempGitService(forgedStageSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'src before\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n', 'utf8');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const denied = await expectReject(() => gitService.stageLines(forgedStageSlug, 'src/app.js', patch, userId, {
      codesiteContext: contextFor(forgedStageSlug),
      fetch,
      evidenceRefs: ['proof:stage-lines-forged'],
    }));
    const cachedNames = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const apiContent = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, denied.event?.path === 'api/auth/signup.ts' && cachedNames.length === 0 && apiContent === 'api after\n', 'stageLines gates the patch header target instead of the claimed filePath', {
      deniedPath: denied.event?.path,
      cachedNames,
      reasonCodes: denied.event?.details?.reason_codes,
      digest: sha256(apiContent),
    });
    scenarios.push({
      name: 'Forged stageLines target',
      notes: ['The request claimed src/app.js, but the unified diff header targeted api/auth/signup.ts. The service denied the actual patch target before git apply --cached.'],
      mutations: eventRows(recordBodies),
    });
  });

  const mismatchStageSlug = slug('index-stage-lines-mismatch');
  await withTempGitService(mismatchStageSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'app before\n',
      'src/other.js': 'other before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/other.js'), 'other after\n', 'utf8');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/other.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const mismatch = await expectReject(() => gitService.stageLines(mismatchStageSlug, 'src/app.js', patch, userId, {
      codesiteContext: contextFor(mismatchStageSlug),
      fetch,
      evidenceRefs: ['proof:stage-lines-mismatch'],
    }));
    const cachedNames = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, mismatch.code === 'PATCH_PATH_MISMATCH' && cachedNames.length === 0, 'stageLines rejects same-route patch/filePath mismatches before applying', {
      expectedPath: mismatch.details?.expectedPath,
      patchPaths: mismatch.details?.patchPaths,
      cachedNames,
      event: recordBodies[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Same-route patch mismatch',
      notes: ['A patch targeting src/other.js was inside the write set, but the request claimed src/app.js. The boundary allowed the real path, then the service rejected the mismatch before git apply --cached.'],
      mutations: eventRows(recordBodies),
    });
  });

  const unstageFileSlug = slug('index-unstage-file');
  await withTempGitService(unstageFileSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'main\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await git(repoPath, ['checkout', '-b', 'src/app.js']);
    await git(repoPath, ['checkout', 'main']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n', 'utf8');
    await git(repoPath, ['add', '--', 'src/app.js']);
    const allowedRecords = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: allowedRecords });
    await gitService.unstageFile(unstageFileSlug, 'src/app.js', userId, {
      codesiteContext: contextFor(unstageFileSlug),
      fetch,
      evidenceRefs: ['proof:unstage-file'],
    });
    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    const cachedNames = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, currentBranch.trim() === 'main' && cachedNames.length === 0 && content === 'after\n', 'unstageFile uses pathspec disambiguation when a branch shares the file name', {
      currentBranch: currentBranch.trim(),
      cachedNames,
      event: allowedRecords[0]?.codesiteFsEvent?.type,
    });

    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n', 'utf8');
    await git(repoPath, ['add', '--', 'api/auth/signup.ts']);
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.unstageFile(unstageFileSlug, 'api/auth/signup.ts', userId, {
      codesiteContext: contextFor(unstageFileSlug),
      fetch: deniedFetch,
      evidenceRefs: ['proof:unstage-file-denied'],
    }));
    const cachedAfterDeny = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, denied.event?.path === 'api/auth/signup.ts' && cachedAfterDeny.join('\n') === 'api/auth/signup.ts', 'unstageFile denial preserves cached entries outside clearance', {
      deniedPath: denied.event?.path,
      cachedAfterDeny,
      reasonCodes: denied.event?.details?.reason_codes,
    });

    scenarios.push({
      name: 'Unstage file pathspec',
      notes: [
        'A branch named src/app.js existed. unstageFile stayed on main and unstaged the file path using an explicit pathspec separator.',
        'A denied unstageFile request outside clearance left the cached entry intact.',
      ],
      mutations: eventRows(allowedRecords, deniedRecords),
    });
  });

  const unstageLinesSlug = slug('index-unstage-lines');
  await withTempGitService(unstageLinesSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'one\ntwo\nthree\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n', 'utf8');
    await git(repoPath, ['add', '--', 'src/app.js']);
    const { stdout: allowedPatch } = await git(repoPath, ['diff', '--cached', '--unified=0', '--', 'src/app.js']);
    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: allowedRecords });
    await gitService.unstageLines(unstageLinesSlug, 'src/app.js', allowedPatch, userId, {
      codesiteContext: contextFor(unstageLinesSlug),
      fetch: allowedFetch,
      evidenceRefs: ['proof:unstage-lines'],
    });
    const cachedAfterAllow = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const worktreeAfterAllow = await gitNames(repoPath, ['diff', '--name-only']);
    proofAssert(assertions, cachedAfterAllow.length === 0 && worktreeAfterAllow.join('\n') === 'src/app.js', 'unstageLines removes approved hunks from index and keeps worktree edits', {
      cachedAfterAllow,
      worktreeAfterAllow,
      event: allowedRecords[0]?.codesiteFsEvent?.type,
    });

    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n', 'utf8');
    await git(repoPath, ['add', '--', 'api/auth/signup.ts']);
    const { stdout: forgedPatch } = await git(repoPath, ['diff', '--cached', '--unified=0', '--', 'api/auth/signup.ts']);
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.unstageLines(unstageLinesSlug, 'src/app.js', forgedPatch, userId, {
      codesiteContext: contextFor(unstageLinesSlug),
      fetch: deniedFetch,
      evidenceRefs: ['proof:unstage-lines-forged'],
    }));
    const cachedAfterDeny = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, denied.event?.path === 'api/auth/signup.ts' && cachedAfterDeny.join('\n') === 'api/auth/signup.ts', 'unstageLines forged patch denial preserves the cached target', {
      deniedPath: denied.event?.path,
      cachedAfterDeny,
      reasonCodes: denied.event?.details?.reason_codes,
    });
    scenarios.push({
      name: 'Unstage hunk gate',
      notes: [
        'An approved staged hunk was removed from the index while the worktree edit remained.',
        'A forged unstageLines patch targeting api/auth/signup.ts was denied before cached content changed.',
      ],
      mutations: eventRows(allowedRecords, deniedRecords),
    });
  });

  const stageAllSlug = slug('index-stage-all');
  await withTempGitService(stageAllSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n', 'utf8');
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.stageAll(stageAllSlug, userId, {
      codesiteContext: contextFor(stageAllSlug),
      fetch: deniedFetch,
    }));
    const cachedAfterDeny = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, denied.event?.path === '**' && cachedAfterDeny.length === 0, 'stageAll is denied without broad index clearance and leaves the index untouched', {
      reasonCodes: denied.event?.details?.reason_codes,
      cachedAfterDeny,
    });

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowedRecords });
    await gitService.stageAll(stageAllSlug, userId, {
      codesiteContext: contextFor(stageAllSlug),
      fetch: allowedFetch,
      evidenceRefs: ['proof:stage-all'],
    });
    const cachedAfterAllow = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, cachedAfterAllow.join('\n') === 'api/auth/signup.ts\nsrc/app.js', 'stageAll with broad clearance stages every changed path', {
      cachedAfterAllow,
      event: allowedRecords[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Repo-wide stageAll gate',
      notes: ['A path-scoped lease cannot stage the whole repository. The same direct service call succeeds only after ** git_index clearance.'],
      mutations: eventRows(deniedRecords, allowedRecords),
    });
  });

  const unstageAllSlug = slug('index-unstage-all');
  await withTempGitService(unstageAllSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n', 'utf8');
    await git(repoPath, ['add', '--', 'src/app.js', 'api/auth/signup.ts']);
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.unstageAll(unstageAllSlug, userId, {
      codesiteContext: contextFor(unstageAllSlug),
      fetch: deniedFetch,
    }));
    const cachedAfterDeny = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    proofAssert(assertions, denied.event?.path === '**' && cachedAfterDeny.join('\n') === 'api/auth/signup.ts\nsrc/app.js', 'unstageAll is denied without broad index clearance and keeps staged entries', {
      reasonCodes: denied.event?.details?.reason_codes,
      cachedAfterDeny,
    });

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowedRecords });
    await gitService.unstageAll(unstageAllSlug, userId, {
      codesiteContext: contextFor(unstageAllSlug),
      fetch: allowedFetch,
      evidenceRefs: ['proof:unstage-all'],
    });
    const cachedAfterAllow = await gitNames(repoPath, ['diff', '--cached', '--name-only']);
    const worktreeAfterAllow = await gitNames(repoPath, ['diff', '--name-only']);
    proofAssert(assertions, cachedAfterAllow.length === 0 && worktreeAfterAllow.join('\n') === 'api/auth/signup.ts\nsrc/app.js', 'unstageAll with broad clearance moves all staged entries back to the worktree', {
      cachedAfterAllow,
      worktreeAfterAllow,
      event: allowedRecords[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Repo-wide unstageAll gate',
      notes: ['A direct unstageAll call is blocked under path-scoped clearance and succeeds only after a broad git_index write set is granted.'],
      mutations: eventRows(deniedRecords, allowedRecords),
    });
  });

  return {
    schemaVersion: 'synthi.codesite.gitServiceIndexProof.v1',
    generatedAt: new Date().toISOString(),
    source: 'scripts/codesite-gitservice-index-proof.mjs',
    scenarios,
    assertions,
    summary: {
      status: assertions.every((item) => item.ok) ? 'pass' : 'fail',
      scenarioCount: scenarios.length,
      assertionCount: assertions.length,
    },
  };
}

function proofHtml(proof) {
  const scenarioCards = proof.scenarios.map((scenario) => `
<section class="card">
  <div class="card-head"><h2>${escapeHtml(scenario.name)}</h2><span class="pass">PASS</span></div>
  <p>${escapeHtml(scenario.notes.join(' '))}</p>
  <table>
    <thead><tr><th>Path</th><th>Disposition</th><th>Operation</th><th>Evidence</th></tr></thead>
    <tbody>
      ${scenario.mutations.map((mutation) => `
      <tr>
        <td><code>${escapeHtml(mutation.path || '')}</code></td>
        <td>${escapeHtml(mutation.disposition || '')}</td>
        <td><code>${escapeHtml(mutation.operation || '')}</code></td>
        <td><code>${escapeHtml(JSON.stringify(mutation.reasonCodes || mutation.evidenceRefs || mutation))}</code></td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>`).join('');
  const assertionRows = proof.assertions.map((assertion) => `
<tr>
  <td><span class="${assertion.ok ? 'pass' : 'fail'}">${assertion.ok ? 'PASS' : 'FAIL'}</span></td>
  <td>${escapeHtml(assertion.name)}</td>
  <td><code>${escapeHtml(JSON.stringify(assertion.detail))}</code></td>
</tr>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite gitService Index Proof</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0f14;color:#f2f5f9}
body{margin:0;background:#0b0f14;padding:28px}
main{max-width:1180px;margin:0 auto;display:grid;gap:16px}
.hero,.card{border:1px solid #2a3443;border-radius:8px;background:#121923;padding:18px}
h1{font-size:29px;line-height:1.16;margin:8px 0 0;letter-spacing:0}
h2{font-size:16px;margin:0;letter-spacing:0}
p{margin:8px 0 0;color:#adbac9;line-height:1.5;max-width:96ch}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:14px}
.metric{border:1px solid #2a3443;border-radius:8px;padding:12px;background:#0d131b}
.label{font-size:12px;color:#8d99aa}.value{margin-top:5px;font-size:18px;font-weight:760}
.pass,.fail{display:inline-block;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:800}
.pass{background:#123d2a;color:#9cf1bc}.fail{background:#4b1515;color:#ffb9b9}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;table-layout:fixed}
th,td{border-top:1px solid #2a3443;padding:8px;text-align:left;vertical-align:top}
th{color:#adbac9;font-weight:700}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:#d7e0ef;overflow-wrap:anywhere}
@media (max-width:760px){body{padding:16px}table{font-size:12px}.hero,.card{padding:14px}}
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pass">PASS</span>
    <h1>CodeSite gitService Index Proof</h1>
    <p>Direct git index mutation APIs were exercised against real Git repositories. File, hunk, and repo-wide staging flows recorded CodeSiteFS git_index events before the index changed, and denied attempts left cached entries untouched.</p>
    <div class="meta">
      <div class="metric"><div class="label">Scenarios</div><div class="value">${proof.summary.scenarioCount}</div></div>
      <div class="metric"><div class="label">Assertions</div><div class="value">${proof.summary.assertionCount}</div></div>
      <div class="metric"><div class="label">Generated</div><div class="value">${escapeHtml(proof.generatedAt)}</div></div>
    </div>
  </section>
  ${scenarioCards}
  <section class="card">
    <div class="card-head"><h2>Assertions</h2><span class="pass">ALL PASS</span></div>
    <table>
      <thead><tr><th>Status</th><th>Assertion</th><th>Evidence</th></tr></thead>
      <tbody>${assertionRows}</tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}

async function screenshot() {
  await ensureBrowserTempRoot();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1180 }, deviceScaleFactor: 1 });
    await page.goto(`file://${proofHtmlPath}`, { waitUntil: 'load' });
    await page.screenshot({ path: proofPngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  await fs.mkdir(proofDir, { recursive: true });
  await ensureProofTempRoot();
  if (args.has('--screenshot-only')) {
    await screenshot();
    return;
  }
  const proof = await runProof();
  if (proof.summary.status !== 'pass') throw new Error('CodeSite gitService index proof failed');
  await fs.writeFile(proofJsonPath, JSON.stringify(proof, null, 2), 'utf8');
  await fs.writeFile(proofHtmlPath, proofHtml(proof).replace(/[ \t]+$/gm, ''), 'utf8');
  if (!args.has('--no-screenshot')) await screenshot();
  console.log(JSON.stringify({
    ok: true,
    proofJsonPath,
    proofHtmlPath,
    proofPngPath: args.has('--no-screenshot') ? null : proofPngPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
