'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  INSTRUCTION_PROJECTIONS,
  WORKSPACE_INSTRUCTION_METADATA_RELATIVE_PATH,
  canonicalWorkspaceInstructionsFromMetadata,
  createCanonicalWorkspaceInstructions,
  createWorkspaceInstructionProjectionMetadataStore,
  enabledInstructionProjections,
  resolveActiveWorkspaceRoot,
  resolveInstructionProjectionPath,
  resolveWorkspaceInstructionProjectionFlag,
} = require('../workspaceInstructionProjectionConfig');

async function tempDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vectant-instruction-config-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('uses a passive declarative instruction registry', () => {
  assert.deepEqual(INSTRUCTION_PROJECTIONS, [
    { path: 'AGENTS.md', enabled: true },
    { path: 'CLAUDE.md', enabled: true },
    { path: 'GEMINI.md', enabled: true },
  ]);
  assert.deepEqual(enabledInstructionProjections([{ path: 'AGENTS.md', enabled: false }, { path: 'TEAM.md', enabled: true }]), [
    { path: 'TEAM.md', enabled: true },
  ]);
});

test('canonical workspace instructions have a stable set ID and content hash', () => {
  const instructions = createCanonicalWorkspaceInstructions({
    workspaceId: 'workspace_123',
    content: 'Use the Vectant environment.\n',
    version: 4,
  });

  assert.equal(instructions.instructionSetId, 'workspace_123:v4');
  assert.equal(instructions.version, 4);
  assert.match(instructions.hash, /^[a-f0-9]{64}$/);
  assert.equal(instructions.hash, createCanonicalWorkspaceInstructions({
    workspaceId: 'workspace_123',
    content: 'Use the Vectant environment.\n',
    version: 4,
  }).hash);
});

test('takes canonical instructions from durable workspace metadata with the existing protocol as a default', () => {
  const explicit = canonicalWorkspaceInstructionsFromMetadata({
    id: 'database-id',
    workspaceInstructions: { content: 'Do not delete workspace resources.', version: 7 },
  });
  assert.equal(explicit.workspaceId, 'database-id');
  assert.equal(explicit.version, 7);
  assert.equal(explicit.content, 'Do not delete workspace resources.');

  const defaulted = canonicalWorkspaceInstructionsFromMetadata({ slug: 'workspace-slug' });
  assert.equal(defaulted.workspaceId, 'workspace-slug');
  assert.match(defaulted.content, /Synthi Atomic Agent Protocol/);
});

test('resolves the exact nested opened directory and never substitutes its Git ancestor', async (t) => {
  const repository = await tempDirectory(t);
  const opened = path.join(repository, 'packages', 'backend');
  await fs.promises.mkdir(opened, { recursive: true });
  await fs.promises.mkdir(path.join(repository, '.git'));

  const activeRoot = await resolveActiveWorkspaceRoot(opened);
  assert.equal(activeRoot, await fs.promises.realpath(opened));
  assert.equal(resolveInstructionProjectionPath(activeRoot, 'AGENTS.md'), path.join(activeRoot, 'AGENTS.md'));
  assert.notEqual(resolveInstructionProjectionPath(activeRoot, 'AGENTS.md'), path.join(repository, 'AGENTS.md'));
  await assert.rejects(() => resolveActiveWorkspaceRoot(''), { code: 'workspace_instruction_projection_active_root_required' });
  assert.throws(() => resolveInstructionProjectionPath(activeRoot, '../AGENTS.md'), /instruction_projection_path_invalid/);
});

test('feature rollout is off by default, trusts internal markers only for internal rollout, and buckets deterministically', () => {
  assert.equal(resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'one', env: {} }).enabled, false);
  const internal = resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'one', rollout: 'internal', isInternalWorkspace: true, env: {} });
  assert.equal(internal.feature, 'workspace_instruction_projection');
  assert.equal(internal.enabled, true);
  assert.equal(internal.mode, 'internal');
  assert.equal(internal.reason, 'internal_workspace');
  assert.equal(internal.percentage, 0);
  assert.equal(typeof internal.bucket, 'number');
  assert.equal(resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'one', rollout: 'internal', env: {} }).enabled, false);

  const first = resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'stable', rollout: 'percentage', percentage: 50, env: {} });
  const second = resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'stable', rollout: 'percentage', percentage: 50, env: {} });
  assert.equal(first.bucket, second.bucket);
  assert.equal(first.enabled, second.enabled);
  assert.equal(resolveWorkspaceInstructionProjectionFlag({ workspaceId: 'any', rollout: 'full', env: {} }).enabled, true);
});

test('projection state is durable under the exact active root and does not write terminal instruction files', async (t) => {
  const root = await tempDirectory(t);
  const store = await createWorkspaceInstructionProjectionMetadataStore({ activeWorkspaceRoot: root });
  const saved = await store.save({
    workspaceId: 'workspace_456',
    instructions: { workspaceId: 'workspace_456', content: 'Instruction A', version: 2 },
    projections: {
      'AGENTS.md': { ownership: 'synthetic-only', existedBeforeProjection: false },
    },
  });

  assert.equal(saved.activeWorkspaceRoot, await fs.promises.realpath(root));
  assert.equal(saved.instructionSet.id, 'workspace_456:v2');
  assert.deepEqual(await store.load(), saved);
  await assert.rejects(fs.promises.access(path.join(root, 'AGENTS.md')));
  assert.equal(store.metadataPath, path.join(root, ...WORKSPACE_INSTRUCTION_METADATA_RELATIVE_PATH.split('/')));
});

test('metadata persistence fails safely rather than following a hostile .synthi symlink', async (t) => {
  const root = await tempDirectory(t);
  const outside = await tempDirectory(t);
  const target = path.join(root, '.synthi');
  try {
    await fs.promises.symlink(outside, target, 'junction');
  } catch (error) {
    t.skip(`symlinks unavailable: ${error.code || error.message}`);
    return;
  }
  const store = await createWorkspaceInstructionProjectionMetadataStore({ activeWorkspaceRoot: root });
  await assert.rejects(
    () => store.save({ workspaceId: 'workspace_789' }),
    { code: 'workspace_instruction_projection_metadata_directory_unsafe' },
  );
  await assert.rejects(fs.promises.access(path.join(outside, 'workspace-instruction-projections.json')));
});
