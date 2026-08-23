import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const runnerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'codesite-shadow-runner.mjs',
);
const temporaryRoots = [];

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function createRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-shadow-runner-test-'));
  temporaryRoots.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ['init', '--quiet']);
  await git(repoRoot, ['config', 'user.name', 'CodeSite Shadow Test']);
  await git(repoRoot, ['config', 'user.email', 'shadow-test@example.invalid']);
  await fs.writeFile(path.join(repoRoot, 'contract.txt'), 'v1\n', 'utf8');
  await git(repoRoot, ['add', 'contract.txt']);
  await git(repoRoot, ['commit', '--quiet', '-m', 'base']);
  return {
    root,
    repoRoot,
    baseCommit: await git(repoRoot, ['rev-parse', 'HEAD']),
    beforeTree: await git(repoRoot, ['rev-parse', 'HEAD^{tree}']),
  };
}

function unifiedPatch({ before = 'v1', after = 'v2', file = 'contract.txt' } = {}) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '',
  ].join('\n');
}

function runnerInput({ repoRoot, baseCommit, patch, digest = sha256(patch), commands } = {}) {
  return {
    schemaVersion: 'synthi.codesite.shadowRunnerInput.v1',
    workspaceSlug: 'acme',
    projectId: 'project-1',
    shadowJobRef: 'shadow-job-1',
    baseSnapshot: `repo@${baseCommit}`,
    selected: { strategy: 'schema-first' },
    universes: [{ strategy: 'schema-first' }],
    shadowExecutionPlan: {
      repoRoot,
      baseCommit,
      patchArtifacts: [{
        id: 'transaction-patch-1',
        digest,
        content: patch,
      }],
      universes: {
        'schema-first': {
          patchArtifactRefs: ['transaction-patch-1'],
        },
      },
      ...(commands ? { commands } : {}),
    },
  };
}

async function runShadow(input, allowedRoot) {
  const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: path.dirname(runnerPath),
      env: {
        ...process.env,
        SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT: allowedRoot,
        SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS: '0',
        SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  return JSON.parse(stdout);
}

async function expectSourceCheckoutUntouched(repoRoot, { content = 'v1\n', head = null } = {}) {
  await expect(fs.readFile(path.join(repoRoot, 'contract.txt'), 'utf8')).resolves.toBe(content);
  if (head) await expect(git(repoRoot, ['rev-parse', 'HEAD'])).resolves.toBe(head);
  await expect(git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).resolves.toBe('');
  const worktrees = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  expect(worktrees.split(/\r?\n/).filter((line) => line.startsWith('worktree '))).toHaveLength(1);
}

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('CodeSite executable shadow runner Git foundation', () => {
  it('materializes the recorded commit in a detached worktree and applies a digest-verified unified patch', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch();
    await fs.writeFile(path.join(repo.repoRoot, 'contract.txt'), 'source-head-v2\n', 'utf8');
    await git(repo.repoRoot, ['add', 'contract.txt']);
    await git(repo.repoRoot, ['commit', '--quiet', '-m', 'advance source checkout']);
    const sourceHead = await git(repo.repoRoot, ['rev-parse', 'HEAD']);
    expect(sourceHead).not.toBe(repo.baseCommit);

    const result = await runShadow(runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
    }), repo.root);

    expect(result).toMatchObject({
      status: 'completed',
      executionMode: 'git_worktree_patch_execution',
      executed: true,
    });
    expect(result.universes).toHaveLength(1);
    expect(result.universes[0]).toMatchObject({
      strategy: 'schema-first',
      status: 'passed',
      executed: true,
      materialized: true,
      applied: true,
      baseCommit: repo.baseCommit,
      baseCommitEvidence: expect.objectContaining({ status: 'passed', exitCode: 0 }),
      beforeTree: repo.beforeTree,
      changedPaths: ['contract.txt'],
      sourceCheckout: { unchanged: true },
      cleanup: { removed: true, registered: true },
      worktreeRetained: false,
      worktreePath: null,
      reasonCodes: expect.arrayContaining([
        'shadow_universe_executed',
        'shadow_git_worktree_materialized',
        'shadow_patch_digest_verified',
        'shadow_patch_preimage_verified',
        'shadow_patch_applied',
        'shadow_after_tree_captured',
      ]),
    });
    expect(result.universes[0].afterTree).toMatch(/^[a-f0-9]{40}$/);
    expect(result.universes[0].afterTree).not.toBe(repo.beforeTree);
    expect(result.universes[0].patchEvidence).toEqual([
      expect.objectContaining({
        artifactId: 'transaction-patch-1',
        digest: sha256(patch),
        computedDigest: sha256(patch),
        digestVerified: true,
        check: expect.objectContaining({ status: 'passed', exitCode: 0 }),
        apply: expect.objectContaining({ status: 'passed', exitCode: 0 }),
      }),
    ]);
    expect(result.universes[0].evidenceRefs).toEqual(expect.arrayContaining([
      `codesite:shadow-base-commit:${repo.baseCommit}`,
      `codesite:shadow-before-tree:${repo.beforeTree}`,
      `codesite:shadow-after-tree:${result.universes[0].afterTree}`,
      `codesite:shadow-patch:${sha256(patch)}`,
    ]));
    await expectSourceCheckoutUntouched(repo.repoRoot, {
      content: 'source-head-v2\n',
      head: sourceHead,
    });
  });

  it('rejects an artifact whose claimed content address does not match its exact bytes', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch();
    const result = await runShadow(runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
      digest: sha256(`${patch}tampered`),
    }), repo.root);

    expect(result).toMatchObject({
      status: 'failed',
      executionMode: 'git_worktree_patch_execution',
      executed: false,
      universes: [{
        status: 'failed',
        executed: false,
        materialized: false,
        applied: false,
        failurePhase: 'artifact_digest',
        failureCode: 'shadow_patch_artifact_digest_mismatch',
      }],
    });
    expect(result.universes[0].patchEvidence[0]).toMatchObject({
      digestVerified: false,
      digest: sha256(`${patch}tampered`),
      computedDigest: sha256(patch),
      check: null,
      apply: null,
    });
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });

  it('captures exact git-apply conflict evidence and never applies a bad preimage', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch({ before: 'v0', after: 'v2' });
    const result = await runShadow(runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
    }), repo.root);

    expect(result).toMatchObject({
      status: 'failed',
      executionMode: 'git_worktree_patch_execution',
      executed: false,
      universes: [{
        status: 'failed',
        executed: false,
        materialized: true,
        applied: false,
        baseCommit: repo.baseCommit,
        beforeTree: repo.beforeTree,
        afterTree: repo.beforeTree,
        failurePhase: 'preimage_check',
        failureCode: 'shadow_patch_preimage_check_failed',
        sourceCheckout: { unchanged: true },
        cleanup: { removed: true },
        conflictEvidence: {
          artifactDigest: sha256(patch),
          phase: 'preimage_check',
          check: expect.objectContaining({ status: 'failed', exitCode: 1 }),
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      }],
    });
    expect(result.universes[0].patchEvidence[0]).toMatchObject({
      digestVerified: true,
      check: expect.objectContaining({
        status: 'failed',
        stderrDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        stderrTail: expect.stringContaining('patch failed'),
      }),
      apply: null,
    });
    expect(result.universes[0].evidenceRefs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^codesite:shadow-conflict:sha256:[a-f0-9]{64}$/),
    ]));
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });

  it('fails before materialization when the recorded base commit is not present', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch();
    const missingCommit = '0'.repeat(40);
    const result = await runShadow(runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: missingCommit,
      patch,
    }), repo.root);

    expect(result).toMatchObject({
      status: 'failed',
      executed: false,
      universes: [{
        status: 'failed',
        executed: false,
        materialized: false,
        applied: false,
        baseCommit: missingCommit,
        baseCommitEvidence: expect.objectContaining({ status: 'failed' }),
        failurePhase: 'base_commit_verification',
        failureCode: 'shadow_git_base_commit_not_found',
      }],
    });
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });

  it('fails closed instead of executing caller commands in the Git patch foundation', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch();
    const marker = path.join(repo.repoRoot, 'must-not-exist.txt');
    const result = await runShadow(runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
      commands: [{
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`],
      }],
    }), repo.root);

    expect(result).toMatchObject({
      status: 'failed',
      error: 'shadow_git_patch_commands_not_supported',
    });
    expect(result.executed).not.toBe(true);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });

  it('runs opted-in validation commands inside the patched worktree and aggregates their evidence (Workstream E)', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch();
    // The validation command reads the patched file INSIDE the worktree copy —
    // proving commands execute against the patched universe, not the source.
    const checkScript = [
      "import fs from 'node:fs';",
      "const content = fs.readFileSync('contract.txt', 'utf8').trim();",
      "if (content !== 'v2') {",
      "  console.error(`expected v2, received ${content}`);",
      '  process.exit(1);',
      '}',
      "console.log('contract v2 verified');",
      '',
    ].join('\n');
    const scriptPath = path.join(repo.root, 'check-contract.mjs');
    await fs.writeFile(scriptPath, checkScript, 'utf8');

    const input = runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
      commands: [{
        label: 'verify-contract-v2',
        command: process.execPath,
        args: [scriptPath],
      }],
    });
    // Opt-in required for commands in git-patch mode:
    const { stdout, stderr, exitCode } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath], {
        cwd: path.dirname(runnerPath),
        env: {
          ...process.env,
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT: repo.root,
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS: '1',
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_BINARIES_JSON: JSON.stringify([process.execPath]),
          SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout: out, stderr: err, exitCode: code }));
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout);

    expect(result).toMatchObject({
      status: 'completed',
      executionMode: 'git_worktree_patch_execution',
      executed: true,
    });
    expect(result.universes[0]).toMatchObject({
      status: 'passed',
      executed: true,
      materialized: true,
      applied: true,
      durationMs: expect.any(Number),
      reasonCodes: expect.arrayContaining([
        'shadow_universe_executed',
        'shadow_patch_applied',
        'shadow_universe_repo_commands_passed',
      ]),
    });
    expect(result.universes[0].commands).toHaveLength(1);
    expect(result.universes[0].commands[0]).toMatchObject({
      label: 'verify-contract-v2',
      status: 'passed',
      exitCode: 0,
      stdoutTail: expect.stringContaining('contract v2 verified'),
      durationMs: expect.any(Number),
    });
    expect(result.universes[0].evidenceRefs).toEqual(expect.arrayContaining([
      `codesite:shadow-command:schema-first:verify-contract-v2:${result.universes[0].commands[0].evidenceDigest}`,
    ]));
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });

  it('downgrades the universe to near_miss when an opted-in validation command fails after a clean patch apply', async () => {
    const repo = await createRepository();
    const patch = unifiedPatch({ before: 'v1', after: 'v9' });
    const checkScript = [
      "import fs from 'node:fs';",
      "const content = fs.readFileSync('contract.txt', 'utf8').trim();",
      "if (content !== 'v2') { console.error('not v2'); process.exit(3); }",
      '',
    ].join('\n');
    const scriptPath = path.join(repo.root, 'expect-v2.mjs');
    await fs.writeFile(scriptPath, checkScript, 'utf8');

    const input = runnerInput({
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      patch,
      commands: [{
        label: 'expect-v2',
        command: process.execPath,
        args: [scriptPath],
      }],
    });
    const { stdout } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath], {
        cwd: path.dirname(runnerPath),
        env: {
          ...process.env,
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT: repo.root,
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS: '1',
          SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_BINARIES_JSON: JSON.stringify([process.execPath]),
          SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve({ stdout: out }));
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
    const result = JSON.parse(stdout);

    // Patches applied cleanly but the validation command failed: executed
    // stays true (real work happened), status becomes near_miss with the
    // command's exit code surfaced. The runner's top-level status is 'failed'
    // because a completed executed proof requires every command to pass.
    expect(result).toMatchObject({
      executionMode: 'git_worktree_patch_execution',
      executed: false,
      universes: [{
        status: 'near_miss',
        executed: true,
        materialized: true,
        applied: true,
        exitCode: 3,
        reasonCodes: expect.arrayContaining([
          'shadow_universe_executed',
          'shadow_universe_repo_commands_failed',
        ]),
      }],
    });
    expect(result.status).toBe('failed');
    await expectSourceCheckoutUntouched(repo.repoRoot);
  });
});
