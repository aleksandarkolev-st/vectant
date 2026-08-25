'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  buildVectantBlock,
  extractVectantBlock,
  stripVectantBlock,
} = require('../workspaceInstructionProjection');
const {
  PROJECTION_OWNERSHIP,
  WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH,
  WorkspaceInstructionProjectionService,
} = require('../workspaceInstructionProjectionService');

async function temporaryWorkspace(t, prefix = 'vectant-projection-service-') {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return root;
}

function workspace(root, overrides = {}) {
  return { activeWorkspaceRoot: root, workspaceId: 'workspace_service_test', ...overrides };
}

function canonical(overrides = {}) {
  return {
    workspaceId: 'workspace_service_test',
    version: 7,
    content: 'Use the Vectant workspace environment.\nDo not remove Vectant-managed resources.',
    ...overrides,
  };
}

function createService(overrides = {}) {
  return new WorkspaceInstructionProjectionService({
    featureEnabled: true,
    canonicalInstructionsProvider: () => canonical(),
    ...overrides,
  });
}

test('reconciles all passive filenames in the exact opened nested directory and persists ownership state', async (t) => {
  const outerRoot = await temporaryWorkspace(t);
  const activeRoot = path.join(outerRoot, 'workspace');
  await fs.promises.mkdir(activeRoot);
  await fs.promises.writeFile(path.join(outerRoot, 'AGENTS.md'), 'Outer repository instructions.\n', 'utf8');
  await fs.promises.writeFile(path.join(activeRoot, 'AGENTS.md'), 'Use pnpm.\n', 'utf8');

  const result = await createService().reconcileWorkspace(workspace(activeRoot));

  assert.equal(result.activeWorkspaceRoot, await fs.promises.realpath(activeRoot));
  assert.equal(result.projections.length, 3);
  assert.equal(await fs.promises.readFile(path.join(outerRoot, 'AGENTS.md'), 'utf8'), 'Outer repository instructions.\n');
  assert.equal(stripVectantBlock(await fs.promises.readFile(path.join(activeRoot, 'AGENTS.md'), 'utf8')), 'Use pnpm.\n');
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const content = await fs.promises.readFile(path.join(activeRoot, name), 'utf8');
    assert.equal(extractVectantBlock(content).workspaceId, 'workspace_service_test');
  }

  const statePath = path.join(activeRoot, ...WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH.split('/'));
  const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  assert.equal(state.projections['AGENTS.md'].ownership, PROJECTION_OWNERSHIP.EXISTING_USER_FILE);
  assert.equal(state.projections['CLAUDE.md'].ownership, PROJECTION_OWNERSHIP.SYNTHETIC_ONLY);
});

test('IDE reads hide the managed block and IDE writes restore the current canonical block', async (t) => {
  const root = await temporaryWorkspace(t);
  const service = createService();
  await service.reconcileWorkspace(workspace(root));

  assert.equal(await service.readForIde(workspace(root), 'AGENTS.md'), '');
  const result = await service.writeFromIde(workspace(root), 'AGENTS.md', 'Use bun.\nRun unit tests.');
  const terminalContent = await fs.promises.readFile(path.join(root, 'AGENTS.md'), 'utf8');

  assert.equal(result.ownership, PROJECTION_OWNERSHIP.EXISTING_USER_FILE);
  assert.equal(await service.readForIde(workspace(root), 'AGENTS.md'), 'Use bun.\nRun unit tests.');
  assert.equal(stripVectantBlock(terminalContent), 'Use bun.\nRun unit tests.');
  assert.equal(extractVectantBlock(terminalContent).version, '7');
});

test('a synthetic projection becomes user-owned after terminal content and cleanup leaves only user bytes', async (t) => {
  const root = await temporaryWorkspace(t);
  const service = createService();
  await service.reconcileWorkspace(workspace(root));
  const target = path.join(root, 'CLAUDE.md');
  const synthetic = await fs.promises.readFile(target, 'utf8');
  await fs.promises.writeFile(target, `# My Claude instructions\n\n${synthetic}`, 'utf8');

  const reconciled = await service.reconcileProjection(workspace(root), 'CLAUDE.md');
  assert.equal(reconciled.ownership, PROJECTION_OWNERSHIP.EXISTING_USER_FILE);

  await service.cleanupWorkspace(workspace(root));
  assert.equal(await fs.promises.readFile(target, 'utf8'), '# My Claude instructions\n\n');
  assert.equal(await fs.promises.stat(path.join(root, 'AGENTS.md')).then(() => true, () => false), false);
  assert.equal(await fs.promises.stat(path.join(root, 'GEMINI.md')).then(() => true, () => false), false);
});

test('cleanup only deletes state-known synthetic files and treats missing metadata as user-owned recovery state', async (t) => {
  const root = await temporaryWorkspace(t);
  const service = createService();
  await service.reconcileWorkspace(workspace(root));
  const statePath = path.join(root, ...WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH.split('/'));
  await fs.promises.unlink(statePath);

  await service.cleanupWorkspace(workspace(root));

  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    assert.equal(await fs.promises.readFile(path.join(root, name), 'utf8'), '');
  }
});

test('recovery replaces a stale block while preserving content outside it', async (t) => {
  const root = await temporaryWorkspace(t);
  const stale = buildVectantBlock(canonical({ version: 2, content: 'Old Vectant instruction.' }));
  await fs.promises.writeFile(path.join(root, 'GEMINI.md'), `Use TypeScript.\n\n${stale}`, 'utf8');

  await createService().reconcileWorkspace(workspace(root));
  const recovered = await fs.promises.readFile(path.join(root, 'GEMINI.md'), 'utf8');

  // The two separator newlines predated this (stale) block and are therefore
  // conservative user bytes during recovery.
  assert.equal(stripVectantBlock(recovered), 'Use TypeScript.\n\n');
  assert.equal(extractVectantBlock(recovered).version, '7');
  assert.equal(extractVectantBlock(recovered).content, canonical().content);
});

test('canonical instruction updates reconcile every physical projection without a restart', async (t) => {
  const root = await temporaryWorkspace(t);
  let activeInstructions = canonical({ version: 1, content: 'First canonical instruction.' });
  const service = createService({ canonicalInstructionsProvider: () => activeInstructions });
  await service.reconcileWorkspace(workspace(root));

  activeInstructions = canonical({ version: 2, content: 'Updated canonical instruction.' });
  await service.reconcileAll(workspace(root));

  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const current = extractVectantBlock(await fs.promises.readFile(path.join(root, name), 'utf8'));
    assert.equal(current.version, '2');
    assert.equal(current.content, 'Updated canonical instruction.');
  }
});

test('refuses a symlink projection target without following or changing its destination', async (t) => {
  const root = await temporaryWorkspace(t);
  const outside = path.join(root, 'outside.md');
  const projection = path.join(root, 'AGENTS.md');
  await fs.promises.writeFile(outside, 'Do not touch.\n', 'utf8');
  try {
    await fs.promises.symlink(outside, projection, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      // Windows development machines can legitimately forbid symlink creation.
      // Exercise the same lstat safety boundary with an injected filesystem.
      const fsApi = {
        ...fs.promises,
        async lstat(filePath) {
          if (path.resolve(filePath) === projection) {
            return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
          }
          return fs.promises.lstat(filePath);
        },
      };
      await assert.rejects(
        createService({ fsApi }).reconcileWorkspace(workspace(root)),
        (failure) => failure.code === 'workspace_instruction_projection_target_symlink_refused',
      );
      assert.equal(await fs.promises.readFile(outside, 'utf8'), 'Do not touch.\n');
      return;
    }
    throw error;
  }

  await assert.rejects(
    createService().reconcileWorkspace(workspace(root)),
    (error) => error.code === 'workspace_instruction_projection_target_symlink_refused',
  );
  assert.equal(await fs.promises.readFile(outside, 'utf8'), 'Do not touch.\n');
});

test('refuses an intermediate symlink in a future declarative projection path', async (t) => {
  const root = await temporaryWorkspace(t);
  const unsafeDirectory = path.join(root, 'future-convention');
  const fsApi = {
    ...fs.promises,
    async lstat(filePath) {
      if (path.resolve(filePath) === unsafeDirectory) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.promises.lstat(filePath);
    },
  };
  const service = createService({
    fsApi,
    projections: [{ path: 'future-convention/INSTRUCTIONS.md', enabled: true }],
  });

  await assert.rejects(
    service.reconcileWorkspace(workspace(root)),
    (error) => error.code === 'workspace_instruction_projection_unsafe_directory',
  );
});

test('atomic replacement carries forward the existing file mode', async (t) => {
  const root = await temporaryWorkspace(t);
  const target = path.join(root, 'AGENTS.md');
  await fs.promises.writeFile(target, 'Keep the mode.\n', 'utf8');
  await fs.promises.chmod(target, 0o744);
  const expectedMode = (await fs.promises.stat(target)).mode & 0o777;
  let temporaryMode = null;
  const fsApi = {
    ...fs.promises,
    async open(filePath, flags, mode) {
      if (path.dirname(filePath) === root && path.basename(filePath).startsWith('.AGENTS.md.vectant-projection-')) {
        temporaryMode = mode;
      }
      return fs.promises.open(filePath, flags, mode);
    },
  };

  await createService({ fsApi }).reconcileProjection(workspace(root), 'AGENTS.md');
  assert.equal(temporaryMode, expectedMode);
});

test('reconciliation retries a concurrent terminal write and merges it instead of overwriting it', async (t) => {
  const root = await temporaryWorkspace(t);
  const target = path.join(root, 'AGENTS.md');
  await fs.promises.writeFile(target, 'Initial user text.\n', 'utf8');
  let targetReadCount = 0;
  const fsApi = {
    ...fs.promises,
    async readFile(filePath, ...args) {
      const value = await fs.promises.readFile(filePath, ...args);
      if (path.resolve(filePath) === target && ++targetReadCount === 2) {
        await fs.promises.writeFile(target, 'Terminal edit wins.\n', 'utf8');
      }
      return value;
    },
  };

  await createService({ fsApi, maxWriteRetries: 3 }).reconcileWorkspace(workspace(root));
  const content = await fs.promises.readFile(target, 'utf8');
  assert.equal(stripVectantBlock(content), 'Terminal edit wins.\n');
  assert.equal(extractVectantBlock(content).version, '7');
  assert.equal(targetReadCount >= 3, true);
});

test('reconciliation tolerates a competing runtime creating the projection state directory', async (t) => {
  const root = await temporaryWorkspace(t);
  const stateDirectory = path.join(root, '.synthi');
  let raced = false;
  const fsApi = {
    ...fs.promises,
    async mkdir(directory, options) {
      if (!raced && path.resolve(directory) === stateDirectory) {
        raced = true;
        await fs.promises.mkdir(directory, options);
        const error = new Error('directory created by concurrent runtime preparation');
        error.code = 'EEXIST';
        throw error;
      }
      return fs.promises.mkdir(directory, options);
    },
  };

  await createService({ fsApi }).reconcileWorkspace(workspace(root));

  assert.equal(raced, true);
  assert.equal((await fs.promises.lstat(stateDirectory)).isDirectory(), true);
  const statePath = path.join(root, ...WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH.split('/'));
  assert.equal(JSON.parse(await fs.promises.readFile(statePath, 'utf8')).schemaVersion, 1);
});

test('explicit feature gating leaves the terminal filesystem untouched', async (t) => {
  const root = await temporaryWorkspace(t);
  const service = createService({ featureEnabled: false });
  const result = await service.reconcileWorkspace(workspace(root));

  assert.deepEqual(result, { skipped: true, reason: 'feature_disabled', projections: [] });
  assert.equal(await fs.promises.stat(path.join(root, 'AGENTS.md')).then(() => true, () => false), false);
  assert.equal(await fs.promises.stat(path.join(root, '.synthi')).then(() => true, () => false), false);
});

test('Git integration remains an optional injected boundary and receives only projection lifecycle data', async (t) => {
  const root = await temporaryWorkspace(t);
  const calls = [];
  const service = createService({
    gitAdapter: {
      async reconcileWorkspace(context) { calls.push(context); },
    },
  });

  await service.reconcileWorkspace(workspace(root));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].activeWorkspaceRoot, await fs.promises.realpath(root));
  assert.deepEqual(calls[0].projections.map((entry) => entry.path), ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  assert.equal(typeof calls[0].block, 'string');
});
