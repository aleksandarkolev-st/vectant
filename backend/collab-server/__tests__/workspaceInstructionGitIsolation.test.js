'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  configureWorkspaceInstructionGitIsolation,
  refreshTrackedProjectionStat,
  removeWorkspaceInstructionGitIsolation,
} = require('../workspaceInstructionGitIsolation');
const {
  appendCanonicalInstructionBlock,
  stripManagedInstructionBlocks,
} = require('../workspaceInstructionGitFilter');

const execFileAsync = promisify(execFile);

async function git(repo, args) {
  return execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

async function gitText(repo, args) {
  const { stdout } = await git(repo, args);
  return stdout;
}

function instructionBlock(workspaceId = 'workspace-test', version = 1) {
  return [
    '<!-- Vectant_MANAGED_INSTRUCTIONS_BEGIN',
    `id: ${workspaceId}`,
    `version: ${version}`,
    '-->',
    '',
    'Vectant workspace instructions:',
    '',
    'Use the active Vectant environment.',
    '',
    `Vectant_INSTRUCTION_SET_ID=${workspaceId}:v${version}`,
    '<!-- Vectant_MANAGED_INSTRUCTIONS_END -->',
  ].join('\n');
}

function userHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function createRepository(t) {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vectant-instruction-git-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 'vectant@example.test']);
  await git(repo, ['config', 'user.name', 'Vectant Test']);
  await fs.promises.writeFile(path.join(repo, 'README.md'), 'fixture\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function configure(repo, projections, workspaceId = 'workspace-test', options = {}) {
  return configureWorkspaceInstructionGitIsolation({
    activeWorkspaceRoot: options.activeWorkspaceRoot || repo,
    workspaceId,
    block: options.block || instructionBlock(workspaceId),
    separator: options.separator || '\n\n',
    projections,
  });
}

test('tracked instruction filters refresh clean status only after verified user bytes and preserve all Git operations', async (t) => {
  const repo = await createRepository(t);
  const source = 'Use pnpm.\nRun tests before committing.\n';
  const block = instructionBlock();
  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), source);
  await git(repo, ['add', 'AGENTS.md']);
  await git(repo, ['commit', '-m', 'user agents']);

  const configured = await configure(repo, [{ path: 'AGENTS.md', ownership: 'existing-user-file' }]);
  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), appendCanonicalInstructionBlock(source, block));

  // Git applies the clean filter for content comparisons (the diff is empty),
  // but status first flags the physical smudged worktree file by stat.
  assert.equal(await gitText(repo, ['status', '--porcelain']), ' M AGENTS.md\n');
  assert.equal(await gitText(repo, ['diff', '--', 'AGENTS.md']), '');
  assert.deepEqual(configured.trackedStatusIsolation, {
    requiresRefreshAfterProjection: true,
    limitation: 'git_status_reports_smudged_tracked_projection_modified',
  });
  assert.deepEqual(await refreshTrackedProjectionStat({
    activeWorkspaceRoot: repo,
    workspaceId: 'workspace-test',
    projectionPath: 'AGENTS.md',
    expectedUserHash: userHash(source),
  }), { refreshed: true, repoRelativePath: 'AGENTS.md' });
  assert.equal(await gitText(repo, ['status', '--porcelain']), '');

  const changedUserContent = 'Use bun.\nRun the focused tests.\n';
  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), appendCanonicalInstructionBlock(changedUserContent, block));
  assert.deepEqual(await refreshTrackedProjectionStat({
    activeWorkspaceRoot: repo,
    workspaceId: 'workspace-test',
    projectionPath: 'AGENTS.md',
    expectedUserHash: userHash(source),
  }), { refreshed: false, reason: 'not_refreshed_user_content_changed' });
  assert.equal(await gitText(repo, ['diff', '--cached', '--', 'AGENTS.md']), '');
  const unstagedDiff = await gitText(repo, ['diff', '--', 'AGENTS.md']);
  assert.match(unstagedDiff, /Use bun\./);
  assert.doesNotMatch(unstagedDiff, /Vectant_MANAGED_INSTRUCTIONS/);

  await git(repo, ['add', 'AGENTS.md']);
  const cachedDiff = await gitText(repo, ['diff', '--cached', '--', 'AGENTS.md']);
  assert.match(cachedDiff, /Use bun\./);
  assert.doesNotMatch(cachedDiff, /Vectant_MANAGED_INSTRUCTIONS/);
  await git(repo, ['commit', '-m', 'update user instructions']);
  const committed = await gitText(repo, ['show', 'HEAD:AGENTS.md']);
  assert.equal(committed, changedUserContent);
  assert.doesNotMatch(committed, /Vectant_MANAGED_INSTRUCTIONS/);

  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), 'temporary terminal edit\n');
  await git(repo, ['checkout', '--', 'AGENTS.md']);
  assert.equal(await fs.promises.readFile(path.join(repo, 'AGENTS.md'), 'utf8'), appendCanonicalInstructionBlock(changedUserContent, block).toString('utf8'));

  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), 'another terminal edit\n');
  await git(repo, ['restore', '--source=HEAD', '--', 'AGENTS.md']);
  assert.equal(await fs.promises.readFile(path.join(repo, 'AGENTS.md'), 'utf8'), appendCanonicalInstructionBlock(changedUserContent, block).toString('utf8'));

  await fs.promises.writeFile(path.join(repo, 'AGENTS.md'), 'third terminal edit\n');
  await git(repo, ['reset', '--hard', 'HEAD']);
  assert.equal(await fs.promises.readFile(path.join(repo, 'AGENTS.md'), 'utf8'), appendCanonicalInstructionBlock(changedUserContent, block).toString('utf8'));
  assert.equal(await gitText(repo, ['status', '--porcelain']), '');

  await removeWorkspaceInstructionGitIsolation({ activeWorkspaceRoot: repo, workspaceId: 'workspace-test' });
  assert.equal(configured.projections[0].tracked, true);
});

test('pre-existing untracked instructions remain untracked and clean filtering applies when they are added', async (t) => {
  const repo = await createRepository(t);
  const source = 'Use Python 3.13.\n';
  const block = instructionBlock('untracked-workspace');
  await fs.promises.writeFile(path.join(repo, 'CLAUDE.md'), source);

  const configured = await configure(repo, [{ path: 'CLAUDE.md', ownership: 'existing-user-file' }], 'untracked-workspace');
  await fs.promises.writeFile(path.join(repo, 'CLAUDE.md'), appendCanonicalInstructionBlock(source, block));

  assert.equal(await gitText(repo, ['status', '--porcelain']), '?? CLAUDE.md\n');
  await git(repo, ['add', 'CLAUDE.md']);
  assert.equal(await gitText(repo, ['show', ':CLAUDE.md']), source);
  const cachedDiff = await gitText(repo, ['diff', '--cached', '--', 'CLAUDE.md']);
  assert.doesNotMatch(cachedDiff, /Vectant_MANAGED_INSTRUCTIONS/);
  await git(repo, ['commit', '-m', 'add user claude instructions']);
  assert.equal(await gitText(repo, ['show', 'HEAD:CLAUDE.md']), source);
  assert.equal(configured.projections[0].tracked, false);
});

test('synthetic projections are locally excluded, then become ordinary user files without committing Vectant content', async (t) => {
  const repo = await createRepository(t);
  const workspaceRoot = path.join(repo, 'workspace');
  await fs.promises.mkdir(workspaceRoot);
  const block = instructionBlock('synthetic-workspace');
  const target = path.join(workspaceRoot, 'GEMINI.md');

  const first = await configure(repo, [{ path: 'GEMINI.md', ownership: 'synthetic-only' }], 'synthetic-workspace', { activeWorkspaceRoot: workspaceRoot });
  await fs.promises.writeFile(target, block);
  assert.equal(await gitText(repo, ['status', '--porcelain']), '');
  const excludes = await fs.promises.readFile(first.excludePath, 'utf8');
  assert.match(excludes, /^\/workspace\/GEMINI\.md$/m);

  const userContent = '# My Gemini instructions\n';
  await fs.promises.writeFile(target, appendCanonicalInstructionBlock(userContent, block));
  await configure(repo, [{ path: 'GEMINI.md', ownership: 'existing-user-file' }], 'synthetic-workspace', { activeWorkspaceRoot: workspaceRoot });
  assert.equal(await gitText(repo, ['status', '--porcelain']), '?? workspace/\n');
  await git(repo, ['add', 'workspace/GEMINI.md']);
  assert.equal(await gitText(repo, ['show', ':workspace/GEMINI.md']), userContent);
  await git(repo, ['commit', '-m', 'user gemini instructions']);
  assert.equal(await gitText(repo, ['show', 'HEAD:workspace/GEMINI.md']), userContent);
});

test('nested active roots only receive repo-relative attributes and cleanup preserves unrelated local configuration', async (t) => {
  const repo = await createRepository(t);
  const nested = path.join(repo, 'packages', 'backend');
  await fs.promises.mkdir(nested, { recursive: true });
  await fs.promises.writeFile(path.join(repo, '.git', 'info', 'attributes'), 'README.md filter=user-filter\n');
  await fs.promises.writeFile(path.join(repo, '.git', 'info', 'exclude'), '# user local ignore\n.cache/\n');
  await git(repo, ['config', '--local', 'color.ui', 'always']);

  const configured = await configure(repo, [
    { path: 'AGENTS.md', ownership: 'synthetic-only' },
    { path: 'CLAUDE.md', ownership: 'existing-user-file' },
  ], 'nested-workspace', { activeWorkspaceRoot: nested });
  const attributes = await fs.promises.readFile(configured.attributesPath, 'utf8');
  assert.match(attributes, /^README\.md filter=user-filter$/m);
  assert.match(attributes, /^packages\/backend\/AGENTS\.md filter=/m);
  assert.match(attributes, /^packages\/backend\/CLAUDE\.md filter=/m);
  assert.doesNotMatch(attributes, /^AGENTS\.md filter=vectant/m);
  assert.equal(await gitText(repo, ['config', '--local', '--get', 'color.ui']), 'always\n');

  await removeWorkspaceInstructionGitIsolation({ activeWorkspaceRoot: nested, workspaceId: 'nested-workspace' });
  const cleanedAttributes = await fs.promises.readFile(configured.attributesPath, 'utf8');
  const cleanedExcludes = await fs.promises.readFile(configured.excludePath, 'utf8');
  assert.equal(cleanedAttributes, 'README.md filter=user-filter\n');
  assert.equal(cleanedExcludes, '# user local ignore\n.cache/\n');
  assert.equal(await gitText(repo, ['config', '--local', '--get', 'color.ui']), 'always\n');
});

test('cleanup is a no-op when a workspace has no configured instruction filter', async (t) => {
  const repo = await createRepository(t);
  await assert.doesNotReject(() => removeWorkspaceInstructionGitIsolation({
    activeWorkspaceRoot: repo,
    workspaceId: 'unconfigured-workspace',
  }));
});

test('filter block stripping preserves CRLF user bytes and malformed markers stay untouched', () => {
  const block = instructionBlock('crlf').replace(/\n/g, '\r\n');
  const source = Buffer.from('Use pnpm.\r\n', 'utf8');
  const projected = appendCanonicalInstructionBlock(source, block, '\r\n\r\n');
  assert.deepEqual(stripManagedInstructionBlocks(projected, '\r\n\r\n'), source);

  const malformed = Buffer.from('User content\n<!-- Vectant_MANAGED_INSTRUCTIONS_BEGIN\nnot closed', 'utf8');
  assert.deepEqual(stripManagedInstructionBlocks(malformed), malformed);
});
