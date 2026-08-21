'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');

const { extractVectantBlock, stripVectantBlock } = require('../workspaceInstructionProjection');
const { PASSIVE_WORKSPACE_INSTRUCTIONS } = require('../workspaceAgentProtocol');
const {
  enabledInstructionProjections,
  resolveWorkspaceInstructionProjectionFlag,
} = require('../workspaceInstructionProjectionConfig');
const { createWorkspaceInstructionMetadataStore } = require('../workspaceInstructionMetadataStore');
const {
  createWorkspaceInstructionProjectionRuntime,
  normalizedActiveWorkspacePath,
  resolveOpenedWorkspaceRoot,
} = require('../workspaceInstructionProjectionRuntime');

const execFileAsync = promisify(execFile);

async function temporaryDirectory(t, prefix) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

function fullRollout(input) {
  return { feature: 'workspace_instruction_projection', enabled: true, mode: 'full', reason: 'test', bucket: 0, percentage: 100, ...input };
}

async function createRuntime(t, overrides = {}) {
  const metadataDirectory = await temporaryDirectory(t, 'vectant-instruction-runtime-metadata-');
  return createWorkspaceInstructionProjectionRuntime({
    metadataStore: createWorkspaceInstructionMetadataStore({ directory: metadataDirectory, defaultContent: 'Default Vectant instruction.' }),
    resolveFlag: fullRollout,
    gitAdapter: null,
    ...overrides,
  });
}

test('reconciles the exact nested opened directory from private canonical metadata', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-repo-');
  const opened = path.join(repository, 'packages', 'app');
  await fs.promises.mkdir(opened, { recursive: true });
  await fs.promises.writeFile(path.join(repository, 'AGENTS.md'), 'Outer instructions.\n');
  const runtime = await createRuntime(t);
  await runtime.updateCanonicalInstructions('runtime-workspace', { content: 'Use only the opened workspace.' });

  const result = await runtime.reconcile({
    workspaceId: 'runtime-workspace',
    repositoryRoot: repository,
    activeWorkspacePath: 'packages/app',
  });

  assert.equal(result.activeWorkspaceRoot, await fs.promises.realpath(opened));
  assert.equal(result.activeWorkspacePath, 'packages/app');
  assert.equal(result.canonicalBlock.includes('Use only the opened workspace.'), true);
  assert.equal(await fs.promises.readFile(path.join(repository, 'AGENTS.md'), 'utf8'), 'Outer instructions.\n');
  for (const filename of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const physical = await fs.promises.readFile(path.join(opened, filename), 'utf8');
    assert.equal(extractVectantBlock(physical).content, 'Use only the opened workspace.');
  }
});

test('defaults safely off and never materializes a projection in a disabled rollout', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-off-');
  const runtime = await createRuntime(t, { resolveFlag: () => fullRollout({ enabled: false, reason: 'feature_disabled', mode: 'off' }) });
  const result = await runtime.reconcile({ workspaceId: 'runtime-off', repositoryRoot: repository });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'feature_disabled');
  assert.equal(await fs.promises.stat(path.join(repository, 'AGENTS.md')).then(() => true, () => false), false);
});

test('a blank non-Git workspace receives every enabled passive instruction projection in the shipped rollout', async (t) => {
  const workspace = await temporaryDirectory(t, 'vectant-instruction-runtime-blank-');
  const metadataDirectory = await temporaryDirectory(t, 'vectant-instruction-runtime-blank-metadata-');
  const runtime = createWorkspaceInstructionProjectionRuntime({
    metadataStore: createWorkspaceInstructionMetadataStore({ directory: metadataDirectory }),
    gitAdapter: null,
    // Keep the test hermetic while exercising the real default rollout policy.
    resolveFlag: (input) => resolveWorkspaceInstructionProjectionFlag({ ...input, env: {} }),
  });

  const result = await runtime.reconcile({
    workspaceId: 'runtime-blank-workspace',
    repositoryRoot: workspace,
  });

  assert.equal(result.skipped, false);
  assert.equal(result.rollout.mode, 'full');
  assert.deepEqual(
    result.projections.map((projection) => projection.path).sort(),
    enabledInstructionProjections().map((projection) => projection.path).sort(),
  );

  for (const projection of enabledInstructionProjections()) {
    const physical = await fs.promises.readFile(path.join(workspace, projection.path), 'utf8');
    assert.equal(extractVectantBlock(physical).content, PASSIVE_WORKSPACE_INSTRUCTIONS);
  }
});

test('disabled rollout never resolves a not-yet-created runtime checkout', async (t) => {
  const missingRepository = path.join(await temporaryDirectory(t, 'vectant-instruction-runtime-missing-'), 'not-created');
  const runtime = await createRuntime(t, { resolveFlag: () => fullRollout({ enabled: false, reason: 'feature_disabled', mode: 'off' }) });
  const result = await runtime.reconcile({ workspaceId: 'runtime-off', repositoryRoot: missingRepository });
  assert.equal(result.skipped, true);
  assert.equal(result.repositoryRoot, path.resolve(missingRepository));
});

test('disabling the rollout removes synthetic projections and preserves user content', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-disable-cleanup-');
  let enabled = true;
  const runtime = await createRuntime(t, {
    resolveFlag: () => fullRollout({ enabled, reason: enabled ? 'test' : 'feature_disabled', mode: enabled ? 'full' : 'off' }),
  });
  await runtime.reconcile({ workspaceId: 'runtime-disable-cleanup', repositoryRoot: repository });
  await fs.promises.appendFile(path.join(repository, 'CLAUDE.md'), '\nUse Python 3.13.\n');
  enabled = false;

  const result = await runtime.reconcile({ workspaceId: 'runtime-disable-cleanup', repositoryRoot: repository });
  assert.equal(result.skipped, true);
  assert.equal(result.cleanup.projections.find((entry) => entry.path === 'AGENTS.md').removed, true);
  assert.equal(await fs.promises.stat(path.join(repository, 'AGENTS.md')).then(() => true, () => false), false);
  assert.equal(await fs.promises.readFile(path.join(repository, 'CLAUDE.md'), 'utf8'), '\nUse Python 3.13.\n');
  assert.equal(await fs.promises.stat(path.join(repository, 'GEMINI.md')).then(() => true, () => false), false);
});

test('canonical metadata updates reconcile every previously opened root without a restart', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-update-');
  const left = path.join(repository, 'left');
  const right = path.join(repository, 'right');
  await fs.promises.mkdir(left);
  await fs.promises.mkdir(right);
  const runtime = await createRuntime(t);

  await runtime.reconcile({ workspaceId: 'runtime-update', repositoryRoot: repository, activeWorkspacePath: 'left' });
  await runtime.reconcile({ workspaceId: 'runtime-update', repositoryRoot: repository, activeWorkspacePath: 'right' });
  const update = await runtime.updateCanonicalInstructions('runtime-update', { content: 'The updated canonical instruction.' });

  assert.equal(update.instructions.version, 2);
  assert.equal(update.reconciliations.length, 2);
  for (const root of [left, right]) {
    const physical = await fs.promises.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.equal(extractVectantBlock(physical).version, '2');
    assert.equal(extractVectantBlock(physical).content, 'The updated canonical instruction.');
  }
});

test('reports projection lifecycle metrics without returning canonical instruction content', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-metrics-');
  const runtime = await createRuntime(t);
  await runtime.reconcile({ workspaceId: 'runtime-metrics', repositoryRoot: repository });
  const snapshot = runtime.metrics();
  assert.equal(snapshot.events.workspace_instruction_projection_runtime_reconciled, 1);
  assert.equal(JSON.stringify(snapshot).includes('Default Vectant instruction.'), false);
});

test('rejects active path traversal and preserves a directory outside the opened workspace', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-safe-');
  const outside = await temporaryDirectory(t, 'vectant-instruction-runtime-outside-');
  await assert.rejects(
    resolveOpenedWorkspaceRoot({ repositoryRoot: repository, activeWorkspacePath: '../outside' }),
    { code: 'workspace_instruction_projection_active_path_invalid' },
  );
  assert.equal(normalizedActiveWorkspacePath('nested\\project'), 'nested/project');
  assert.equal(await fs.promises.readdir(outside).then((items) => items.length), 0);
});

test('a tracked user projection is refreshed cleanly without committing the managed block', async (t) => {
  const repository = await temporaryDirectory(t, 'vectant-instruction-runtime-git-');
  const git = (args) => execFileAsync('git', ['-C', repository, ...args], { encoding: 'utf8' });
  await git(['init']);
  await git(['config', 'user.email', 'vectant@example.test']);
  await git(['config', 'user.name', 'Vectant Test']);
  await fs.promises.writeFile(path.join(repository, 'AGENTS.md'), 'Use pnpm.\n');
  await git(['add', 'AGENTS.md']);
  await git(['commit', '-m', 'user instructions']);

  const metadataDirectory = await temporaryDirectory(t, 'vectant-instruction-runtime-git-metadata-');
  const runtime = createWorkspaceInstructionProjectionRuntime({
    metadataStore: createWorkspaceInstructionMetadataStore({ directory: metadataDirectory, defaultContent: 'Use focused tests.' }),
    resolveFlag: fullRollout,
  });
  await runtime.reconcile({ workspaceId: 'runtime-git', repositoryRoot: repository });
  const status = await git(['status', '--porcelain']);
  const physical = await fs.promises.readFile(path.join(repository, 'AGENTS.md'), 'utf8');
  assert.equal(status.stdout, '');
  assert.equal(stripVectantBlock(physical), 'Use pnpm.\n');
  assert.match(physical, /Vectant_MANAGED_INSTRUCTIONS_BEGIN/);
  const shown = await git(['show', 'HEAD:AGENTS.md']);
  assert.equal(shown.stdout, 'Use pnpm.\n');
});
