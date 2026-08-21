'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_INSTRUCTION_BYTES,
  createWorkspaceInstructionMetadataStore,
  defaultMetadataDirectory,
  filenameForWorkspace,
} = require('../workspaceInstructionMetadataStore');

async function temporaryStore(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vectant-instruction-metadata-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return { directory, store: createWorkspaceInstructionMetadataStore({ directory, defaultContent: 'Default instructions.' }) };
}

test('defaults canonical metadata to private data storage instead of the application directory', () => {
  const repositoryDirectory = path.join(os.tmpdir(), 'vectant-service-data', 'repos');
  assert.equal(
    defaultMetadataDirectory({
      environment: {
        WORKSPACE_INSTRUCTION_METADATA_DIR: path.join(os.tmpdir(), 'vectant-explicit-instructions'),
        REPOS_DIR: repositoryDirectory,
      },
      homeDirectory: path.join(os.tmpdir(), 'unused-home'),
    }),
    path.join(os.tmpdir(), 'vectant-explicit-instructions'),
  );
  assert.equal(
    defaultMetadataDirectory({
      environment: { REPOS_DIR: repositoryDirectory },
      homeDirectory: path.join(os.tmpdir(), 'unused-home'),
    }),
    path.join(os.tmpdir(), 'vectant-service-data', '.vectant-workspace-instruction-metadata'),
  );
  assert.equal(
    defaultMetadataDirectory({
      environment: {},
      homeDirectory: path.join(os.tmpdir(), 'vectant-service-home'),
    }),
    path.join(os.tmpdir(), 'vectant-service-home', '.vectant-workspace-instruction-metadata'),
  );
});

test('stores one canonical instruction payload outside the checkout and versions content changes', async (t) => {
  const { directory, store } = await temporaryStore(t);
  const defaultInstructions = await store.get('workspace_123');
  assert.equal(defaultInstructions.content, 'Default instructions.');
  assert.equal(defaultInstructions.version, 1);

  const first = await store.set('workspace_123', { content: 'Use the workspace runtime.' });
  const unchanged = await store.set('workspace_123', { content: 'Use the workspace runtime.' });
  const second = await store.set('workspace_123', { content: 'Use the Vectant runtime.' });

  assert.equal(first.version, 1);
  assert.equal(unchanged.version, 1);
  assert.equal(second.version, 2);
  assert.equal((await store.get('workspace_123')).content, 'Use the Vectant runtime.');
  assert.equal(path.dirname(path.join(directory, filenameForWorkspace('workspace_123'))), directory);
});

test('rejects unsafe IDs, oversized content, and a hostile metadata symlink', async (t) => {
  const { directory, store } = await temporaryStore(t);
  await assert.rejects(() => store.get('../escape'), { code: 'workspace_instruction_metadata_invalid_workspace_id' });
  await assert.rejects(() => store.set('workspace_123', { content: 'x'.repeat(MAX_INSTRUCTION_BYTES + 1) }), { code: 'workspace_instruction_metadata_content_too_large' });

  // This Windows test environment cannot create symlinks without elevated
  // privileges.  Exercise the same lstat security boundary with a filesystem
  // adapter so the safety behavior remains portable.
  const unsafeTarget = path.join(directory, filenameForWorkspace('workspace_123'));
  const unsafeStore = createWorkspaceInstructionMetadataStore({
    directory,
    defaultContent: 'Default instructions.',
    fsApi: {
      ...fs.promises,
      lstat: async (target) => target === unsafeTarget
        ? { isSymbolicLink: () => true, isFile: () => false }
        : fs.promises.lstat(target),
    },
  });
  await assert.rejects(() => unsafeStore.get('workspace_123'), { code: 'workspace_instruction_metadata_store_file_unsafe' });
});
