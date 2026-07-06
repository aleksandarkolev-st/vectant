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
const proofJsonPath = path.join(proofDir, 'codesite-gitservice-worktree-proof.json');
const proofHtmlPath = path.join(proofDir, 'codesite-gitservice-worktree-proof.html');
const proofPngPath = path.join(proofDir, 'codesite-gitservice-worktree-proof.png');
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
    transactionId: 'txn-worktree-1',
    mutationLeaseId: 'lease-worktree-1',
    agentSessionId: 'agent-worktree-1',
    actorUserId: 'proof-user',
    effectiveUserId: 'proof-user',
    controlPlaneUrl: `http://codesite.test/api/workspace/${slugValue}/codesite`,
    controlPlaneTrusted: true,
    allowedTools: ['git_worktree'],
    evidenceRefs: ['proof:worktree-context'],
    processAncestry: ['worktree-proof-runner'],
    ...overrides,
  };
}

function createCodeSiteFetch({ writeSet = ['src/**'], recordBodies = [] } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const transaction = {
      id: 'txn-worktree-1',
      status: 'open',
      mutationLeaseId: 'lease-worktree-1',
      agentSessionId: 'agent-worktree-1',
      actorUserId: 'proof-user',
      effectiveUserId: 'proof-user',
      writeSet,
      observedWriteSet: [],
    };
    if (String(url).endsWith('/transactions/active')) {
      return new Response(JSON.stringify({ activeTransactions: [transaction] }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-worktree-1')) {
      return new Response(JSON.stringify({ transaction }), { status: 200 });
    }
    if (String(url).endsWith('/transactions/txn-worktree-1/record-write')) {
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
  const baseDir = await fs.mkdtemp(path.join(tempRoot, 'codesite-gitservice-worktree-'));
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

async function runProof() {
  const userId = 'proof-user';
  const assertions = [];
  const scenarios = [];

  const discardSlug = slug('worktree-discard');
  await withTempGitService(discardSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.discardChange(discardSlug, 'src/app.js', userId, {
      codesiteContext: contextFor(discardSlug),
      fetch,
      evidenceRefs: ['proof:discard'],
    });
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, content === 'before\n', 'discardChange reverts only after CodeSiteFS allows git_worktree', {
      digest: sha256(content),
      event: recordBodies[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Path-scoped discard',
      notes: ['A direct tracked-file discard recorded git_worktree before checkout restored the file.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        evidenceRefs: body.evidenceRefs,
      })),
    });
  });

  const linesSlug = slug('worktree-discard-lines');
  await withTempGitService(linesSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'one\ntwo\nthree\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'one\nTWO\nthree\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'src/app.js']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.discardLines(linesSlug, 'src/app.js', patch, userId, {
      codesiteContext: contextFor(linesSlug),
      fetch,
      evidenceRefs: ['proof:discard-lines'],
    });
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, content === 'one\ntwo\nthree\n', 'discardLines reverse-applies patch only after boundary event', {
      digest: sha256(content),
      event: recordBodies[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Patch hunk discard',
      notes: ['A direct reverse patch used the same CodeSiteFS path-scoped git_worktree attempt as the route layer.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        evidenceRefs: body.evidenceRefs,
      })),
    });
  });

  const forgedLinesSlug = slug('worktree-discard-lines-forged');
  await withTempGitService(forgedLinesSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'src before\n',
      'api/auth/signup.ts': 'api before\n',
    });
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'api after\n');
    const { stdout: patch } = await git(repoPath, ['diff', '--unified=0', '--', 'api/auth/signup.ts']);
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const denied = await expectReject(() => gitService.discardLines(forgedLinesSlug, 'src/app.js', patch, userId, {
      codesiteContext: contextFor(forgedLinesSlug),
      fetch,
      evidenceRefs: ['proof:discard-lines-forged'],
    }));
    const content = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, denied.event?.path === 'api/auth/signup.ts' && content === 'api after\n', 'discardLines gates the patch header target, not the claimed filePath', {
      operation: denied.event?.details?.operation,
      reasonCodes: denied.event?.details?.reason_codes,
    });
    scenarios.push({
      name: 'Patch target authenticity',
      notes: ['A forged discardLines request claimed src/app.js, but the patch targeted api/auth/signup.ts, so CodeSiteFS denied the actual patch target before apply.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        operation: body.codesiteFsEvent?.details?.operation,
        reasonCodes: body.codesiteFsEvent?.details?.reason_codes,
      })),
    });
  });

  const branchNameSlug = slug('worktree-discard-branch-name');
  await withTempGitService(branchNameSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    await git(repoPath, ['checkout', '-b', 'src/app.js']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'branch\n');
    await git(repoPath, ['add', 'src/app.js']);
    await git(repoPath, ['commit', '-m', 'branch same as file path']);
    await git(repoPath, ['checkout', 'main']);
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    await gitService.discardChange(branchNameSlug, 'src/app.js', userId, {
      codesiteContext: contextFor(branchNameSlug),
      fetch,
      evidenceRefs: ['proof:discard-branch-name'],
    });
    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, currentBranch.trim() === 'main' && content === 'main\n', 'discardChange uses file checkout even when a branch shares the path name', {
      event: recordBodies[0]?.codesiteFsEvent?.type,
      operation: recordBodies[0]?.codesiteFsEvent?.details?.operation,
    });
    scenarios.push({
      name: 'File checkout disambiguation',
      notes: ['A branch named src/app.js existed, but discardChange stayed on main and restored the file path using git checkout -- path.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        evidenceRefs: body.evidenceRefs,
      })),
    });
  });

  const allSlug = slug('worktree-discard-all');
  await withTempGitService(allSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'before\n',
      'api/auth/signup.ts': 'before\n',
    });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'after\n');
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'after\n');
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.discardAll(allSlug, userId, {
      codesiteContext: contextFor(allSlug),
      fetch: deniedFetch,
    }));
    const srcAfterDenied = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    const apiAfterDenied = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, denied.event?.path === '**' && srcAfterDenied === 'after\n' && apiAfterDenied === 'after\n', 'discardAll is denied without broad repo clearance and makes no changes', {
      reasonCodes: denied.event?.details?.reason_codes,
    });

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowedRecords });
    await gitService.discardAll(allSlug, userId, {
      codesiteContext: contextFor(allSlug),
      fetch: allowedFetch,
    });
    const srcAfterAllowed = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    const apiAfterAllowed = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, srcAfterAllowed === 'before\n' && apiAfterAllowed === 'before\n', 'discardAll with ** clearance reverts repo-wide changes', {
      event: allowedRecords[0]?.codesiteFsEvent?.type,
    });
    scenarios.push({
      name: 'Repo-wide discardAll gate',
      notes: ['A repo-wide discard is blocked by a path-scoped write set and allowed only with ** clearance.'],
      mutations: [
        {
          path: denied.event?.path,
          disposition: denied.event?.type,
          reasonCodes: denied.event?.details?.reason_codes,
        },
        ...allowedRecords.map((body) => ({
          path: body.path,
          disposition: body.codesiteFsEvent?.type,
          tool: body.tool,
        })),
      ],
    });
  });

  const conflictSlug = slug('worktree-conflict');
  await withTempGitService(conflictSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'api/auth/signup.ts': 'before\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    for (const [method, label] of [
      ['resolveConflictOurs', 'resolve-ours'],
      ['resolveConflictTheirs', 'resolve-theirs'],
      ['markResolved', 'mark-resolved'],
    ]) {
      const error = await expectReject(() => gitService[method](conflictSlug, 'api/auth/signup.ts', userId, {
        codesiteContext: contextFor(conflictSlug),
        fetch,
      }));
      proofAssert(assertions, error.event?.details?.operation === label, `${label} fails closed outside write set`, {
        path: error.event?.path,
        reasonCodes: error.event?.details?.reason_codes,
      });
    }
    scenarios.push({
      name: 'Conflict operation preflight',
      notes: ['Conflict checkout/add methods reject outside-route paths before any git checkout or git add can run.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        operation: body.codesiteFsEvent?.details?.operation,
        reasonCodes: body.codesiteFsEvent?.details?.reason_codes,
      })),
    });
  });

  const checkoutSlug = slug('worktree-checkout');
  await withTempGitService(checkoutSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, {
      'src/app.js': 'main\n',
      'api/auth/signup.ts': 'main\n',
    });
    await git(repoPath, ['checkout', '-b', 'feature/auth']);
    await fs.writeFile(path.join(repoPath, 'api/auth/signup.ts'), 'feature\n');
    await git(repoPath, ['add', 'api/auth/signup.ts']);
    await git(repoPath, ['commit', '-m', 'feature auth']);
    await git(repoPath, ['checkout', 'main']);

    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.checkout(checkoutSlug, 'feature/auth', false, userId, 'normal', null, [], {
      codesiteContext: contextFor(checkoutSlug),
      fetch: deniedFetch,
    }));
    const { stdout: deniedBranch } = await git(repoPath, ['branch', '--show-current']);
    const deniedContent = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, denied.event?.path === '**' && deniedBranch.trim() === 'main' && deniedContent === 'main\n', 'checkout is blocked before branch switch without ** clearance', {
      operation: denied.event?.details?.operation,
      reasonCodes: denied.event?.details?.reason_codes,
    });

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowedRecords });
    await gitService.checkout(checkoutSlug, 'feature/auth', false, userId, 'normal', null, [], {
      codesiteContext: contextFor(checkoutSlug),
      fetch: allowedFetch,
      evidenceRefs: ['proof:checkout'],
    });
    const { stdout: allowedBranch } = await git(repoPath, ['branch', '--show-current']);
    const allowedContent = await fs.readFile(path.join(repoPath, 'api/auth/signup.ts'), 'utf8');
    proofAssert(assertions, allowedBranch.trim() === 'feature/auth' && allowedContent === 'feature\n', 'checkout with ** clearance records and switches worktree', {
      event: allowedRecords[0]?.codesiteFsEvent?.type,
      operation: allowedRecords[0]?.codesiteFsEvent?.details?.operation,
    });
    scenarios.push({
      name: 'Branch checkout broad gate',
      notes: ['Direct branch checkout rejects path-scoped leases and switches branches only after a repo-wide git_worktree clearance.'],
      mutations: [
        {
          path: denied.event?.path,
          disposition: denied.event?.type,
          operation: denied.event?.details?.operation,
          reasonCodes: denied.event?.details?.reason_codes,
        },
        ...allowedRecords.map((body) => ({
          path: body.path,
          disposition: body.codesiteFsEvent?.type,
          tool: body.tool,
          operation: body.codesiteFsEvent?.details?.operation,
        })),
      ],
    });
  });

  const stashSlug = slug('worktree-stash-pop');
  await withTempGitService(stashSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'before\n' });
    await fs.writeFile(path.join(repoPath, 'src/app.js'), 'stashed\n');
    await git(repoPath, ['stash', 'push', '-m', 'saved change']);
    const deniedRecords = [];
    const { fetch: deniedFetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies: deniedRecords });
    const denied = await expectReject(() => gitService.stashPop(stashSlug, 0, userId, null, {
      codesiteContext: contextFor(stashSlug),
      fetch: deniedFetch,
    }));
    const afterDenied = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    const { stdout: stashAfterDeny } = await git(repoPath, ['stash', 'list']);
    proofAssert(assertions, denied.event?.path === '**' && afterDenied === 'before\n' && stashAfterDeny.includes('saved change'), 'stashPop is blocked before applying stash without ** clearance', {
      operation: denied.event?.details?.operation,
      reasonCodes: denied.event?.details?.reason_codes,
    });

    const allowedRecords = [];
    const { fetch: allowedFetch } = createCodeSiteFetch({ writeSet: ['**'], recordBodies: allowedRecords });
    await gitService.stashPop(stashSlug, 0, userId, null, {
      codesiteContext: contextFor(stashSlug),
      fetch: allowedFetch,
    });
    const afterAllowed = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    const { stdout: stashAfterAllow } = await git(repoPath, ['stash', 'list']);
    proofAssert(assertions, afterAllowed === 'stashed\n' && stashAfterAllow.trim() === '', 'stashPop with ** clearance records and applies stash', {
      event: allowedRecords[0]?.codesiteFsEvent?.type,
      operation: allowedRecords[0]?.codesiteFsEvent?.details?.operation,
    });
    scenarios.push({
      name: 'Stash pop broad gate',
      notes: ['Direct stash pop keeps the stash intact under path-scoped clearance and applies it only with repo-wide worktree clearance.'],
      mutations: [
        {
          path: denied.event?.path,
          disposition: denied.event?.type,
          operation: denied.event?.details?.operation,
          reasonCodes: denied.event?.details?.reason_codes,
        },
        ...allowedRecords.map((body) => ({
          path: body.path,
          disposition: body.codesiteFsEvent?.type,
          tool: body.tool,
          operation: body.codesiteFsEvent?.details?.operation,
        })),
      ],
    });
  });

  const mergeSlug = slug('worktree-merge');
  await withTempGitService(mergeSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const denied = await expectReject(() => gitService.mergeBranch(mergeSlug, 'feature/auth', userId, null, null, [], null, {
      codesiteContext: contextFor(mergeSlug),
      fetch,
    }));
    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, denied.event?.path === '**' && currentBranch.trim() === 'main' && content === 'main\n', 'mergeBranch is denied before fetch or merge without ** clearance', {
      operation: denied.event?.details?.operation,
      reasonCodes: denied.event?.details?.reason_codes,
    });
    scenarios.push({
      name: 'Merge branch broad gate',
      notes: ['Direct mergeBranch performs a CodeSiteFS preflight before fetch or merge can mutate the worktree.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        operation: body.codesiteFsEvent?.details?.operation,
        reasonCodes: body.codesiteFsEvent?.details?.reason_codes,
      })),
    });
  });

  const pullSlug = slug('worktree-pull');
  await withTempGitService(pullSlug, userId, async ({ gitService, repoPath }) => {
    await initTrackedRepo(repoPath, { 'src/app.js': 'main\n' });
    const recordBodies = [];
    const { fetch } = createCodeSiteFetch({ writeSet: ['src/**'], recordBodies });
    const denied = await expectReject(() => gitService.pull(pullSlug, userId, null, null, [], null, {
      codesiteContext: contextFor(pullSlug),
      fetch,
    }));
    const { stdout: currentBranch } = await git(repoPath, ['branch', '--show-current']);
    const content = await fs.readFile(path.join(repoPath, 'src/app.js'), 'utf8');
    proofAssert(assertions, denied.event?.path === '**' && currentBranch.trim() === 'main' && content === 'main\n', 'pull is denied before remote worktree mutation without ** clearance', {
      operation: denied.event?.details?.operation,
      reasonCodes: denied.event?.details?.reason_codes,
    });
    scenarios.push({
      name: 'Pull broad gate',
      notes: ['Direct pull performs a CodeSiteFS preflight before any remote merge can change the worktree.'],
      mutations: recordBodies.map((body) => ({
        path: body.path,
        disposition: body.codesiteFsEvent?.type,
        tool: body.tool,
        operation: body.codesiteFsEvent?.details?.operation,
        reasonCodes: body.codesiteFsEvent?.details?.reason_codes,
      })),
    });
  });

  return {
    schemaVersion: 'synthi.codesite.gitServiceWorktreeProof.v1',
    generatedAt: new Date().toISOString(),
    source: 'scripts/codesite-gitservice-worktree-proof.mjs',
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
    <thead><tr><th>Path</th><th>Disposition</th><th>Operation / Evidence</th></tr></thead>
    <tbody>
      ${scenario.mutations.map((mutation) => `
      <tr>
        <td><code>${escapeHtml(mutation.path || '')}</code></td>
        <td>${escapeHtml(mutation.disposition || '')}</td>
        <td><code>${escapeHtml(JSON.stringify(mutation.operation || mutation.reasonCodes || mutation.evidenceRefs || mutation))}</code></td>
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
<title>CodeSite gitService Worktree Proof</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0d12;color:#f4f7fb}
body{margin:0;background:#0a0d12;padding:28px}
main{max-width:1160px;margin:0 auto;display:grid;gap:16px}
.hero,.card{border:1px solid #293345;border-radius:8px;background:#111822;padding:18px}
h1{font-size:28px;line-height:1.15;margin:0;letter-spacing:0}
h2{font-size:16px;margin:0;letter-spacing:0}
p{margin:8px 0 0;color:#aeb9ca;line-height:1.5}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:12px}
.metric{border:1px solid #293345;border-radius:8px;padding:12px;background:#0c1119}
.label{font-size:12px;color:#8d98aa}.value{margin-top:5px;font-size:18px;font-weight:700}
.pass,.fail{display:inline-block;border-radius:6px;padding:4px 8px;font-size:12px;font-weight:800}
.pass{background:#123b27;color:#9ef0bc}.fail{background:#4a1414;color:#ffb8b8}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th,td{border-top:1px solid #293345;padding:8px;text-align:left;vertical-align:top}
th{color:#aeb9ca;font-weight:700}
code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:#d8e1f1;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="pass">PASS</span>
    <h1>CodeSite gitService Worktree Proof</h1>
    <p>Direct git worktree mutation APIs were exercised against real git repositories. Path-scoped operations recorded CodeSiteFS events before checkout/apply/add, and repo-wide checkout, stash, merge, pull, and discard flows required explicit ** clearance.</p>
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
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
  if (proof.summary.status !== 'pass') throw new Error('CodeSite gitService worktree proof failed');
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
