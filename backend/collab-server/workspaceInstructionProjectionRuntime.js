'use strict';

/**
 * Server lifecycle bridge for passive workspace instruction projections.
 *
 * The projection service deliberately does not know where canonical metadata
 * lives or how a directory was selected.  This module joins those boundaries
 * without ever substituting a repository root for the directory the user
 * opened.  Its result is intentionally presentation-safe: callers receive a
 * canonical fingerprint and block for server-side merging, never instruction
 * text in an explorer response.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { buildVectantBlock, stripVectantBlock } = require('./workspaceInstructionProjection');
const {
  resolveActiveWorkspaceRoot,
  resolveWorkspaceInstructionProjectionFlag,
} = require('./workspaceInstructionProjectionConfig');
const {
  WorkspaceInstructionProjectionService,
} = require('./workspaceInstructionProjectionService');
const {
  createWorkspaceInstructionMetadataStore,
} = require('./workspaceInstructionMetadataStore');
const {
  configureWorkspaceInstructionGitIsolation,
  refreshTrackedProjectionStat,
  removeWorkspaceInstructionGitIsolation,
} = require('./workspaceInstructionGitIsolation');
const {
  createWorkspaceInstructionProjectionObservability,
} = require('./workspaceInstructionProjectionObservability');

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizedActiveWorkspacePath(value) {
  if (value == null || value === '') return '';
  const normalized = String(value).trim().replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '';
  if (normalized.startsWith('/') || path.win32.isAbsolute(normalized)) {
    throw runtimeError('workspace_instruction_projection_active_path_invalid');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw runtimeError('workspace_instruction_projection_active_path_invalid');
  }
  return parts.join('/');
}

async function resolveOpenedWorkspaceRoot({ repositoryRoot, activeWorkspacePath = '', fsApi = fs.promises } = {}) {
  if (!repositoryRoot) throw runtimeError('workspace_instruction_projection_repository_root_required');
  const repository = await resolveActiveWorkspaceRoot(repositoryRoot, { fsApi });
  const relativePath = normalizedActiveWorkspacePath(activeWorkspacePath);
  const candidate = path.resolve(repository, ...relativePath.split('/').filter(Boolean));
  const relative = path.relative(repository, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw runtimeError('workspace_instruction_projection_active_path_escape');
  }
  return {
    activeWorkspaceRoot: await resolveActiveWorkspaceRoot(candidate, { fsApi }),
    activeWorkspacePath: relativePath,
    repositoryRoot: repository,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function createWorkspaceInstructionGitAdapter({ logger = null } = {}) {
  async function reconcileWorkspace({ workspaceId, activeWorkspaceRoot, block, projections }) {
    const configured = await configureWorkspaceInstructionGitIsolation({
      workspaceId,
      activeWorkspaceRoot,
      block,
      projections,
    });
    if (!configured.configured) return configured;

    for (const projection of configured.projections) {
      if (!projection.tracked) continue;
      const physicalPath = path.resolve(activeWorkspaceRoot, ...projection.path.split('/'));
      const physicalContent = await fs.promises.readFile(physicalPath, 'utf8');
      const refresh = await refreshTrackedProjectionStat({
        workspaceId,
        activeWorkspaceRoot,
        projectionPath: projection.path,
        expectedUserHash: sha256(stripVectantBlock(physicalContent)),
      });
      if (!refresh.refreshed && logger?.warn) {
        logger.warn('workspace_instruction_projection_git_status_refresh_skipped', {
          workspaceId,
          path: projection.path,
          reason: refresh.reason,
        });
      }
    }
    return configured;
  }

  return Object.freeze({
    reconcileWorkspace,
    async reconcileProjection(context) {
      return reconcileWorkspace({ ...context, projections: [context.projection] });
    },
    async removeWorkspace({ workspaceId, activeWorkspaceRoot }) {
      return removeWorkspaceInstructionGitIsolation({ workspaceId, activeWorkspaceRoot });
    },
  });
}

/**
 * This runtime is instantiated by the collaboration server.  It is purposefully
 * generic: workspace identity, an exact opened directory, and a private
 * canonical metadata store are its only inputs.
 */
function createWorkspaceInstructionProjectionRuntime({
  metadataStore = createWorkspaceInstructionMetadataStore(),
  fsApi = fs.promises,
  logger = null,
  gitAdapter = createWorkspaceInstructionGitAdapter({ logger }),
  observability = createWorkspaceInstructionProjectionObservability({ logger }),
  resolveFlag = resolveWorkspaceInstructionProjectionFlag,
  serviceFactory = (options) => new WorkspaceInstructionProjectionService(options),
} = {}) {
  if (!metadataStore || typeof metadataStore.get !== 'function' || typeof metadataStore.set !== 'function') {
    throw new TypeError('workspace_instruction_projection_metadata_store_required');
  }

  async function canonical(workspaceId) {
    const current = await metadataStore.get(workspaceId);
    // Materialize the default v1 into the private metadata store when a
    // workspace first opens.  Subsequent canonical updates can therefore
    // advance a durable version without treating the default as implicit.
    return metadataStore.set(workspaceId, {
      content: current.content,
      version: current.version,
    });
  }

  const reconciliationLocks = new Map();
  const knownWorkspaceRoots = new Map();

  async function serialize(key, operation) {
    const prior = reconciliationLocks.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    reconciliationLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (reconciliationLocks.get(key) === next) reconciliationLocks.delete(key);
    }
  }

  async function reconcile({ workspaceId, repositoryRoot, activeWorkspacePath = '', isInternalWorkspace = false } = {}) {
    const flag = resolveFlag({ workspaceId, isInternalWorkspace });
    const normalizedPath = normalizedActiveWorkspacePath(activeWorkspacePath);
    // A disabled rollout must not create a checkout simply to clean it up.
    // For an already-opened directory, however, it is a lifecycle transition:
    // remove only Vectant's block (and synthetic-only files) so the flag does
    // not leave a stale projection behind.
    if (!flag.enabled) {
      let cleanup = null;
      const candidateRoot = repositoryRoot ? path.resolve(String(repositoryRoot)) : null;
      let candidateExists = false;
      if (candidateRoot && workspaceId) {
        try {
          const stat = await fsApi.lstat(candidateRoot);
          candidateExists = stat.isDirectory() || stat.isSymbolicLink();
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      if (candidateExists) {
        const opened = await resolveOpenedWorkspaceRoot({ repositoryRoot: candidateRoot, activeWorkspacePath: normalizedPath, fsApi });
        const key = `${String(workspaceId)}\u0000${opened.activeWorkspaceRoot}`;
        cleanup = await serialize(key, async () => {
          const service = serviceFactory({
            // Cleanup deliberately remains available after rollout is disabled.
            // The service needs no canonical payload to remove a projection.
            featureEnabled: true,
            canonicalInstructionsProvider: () => canonical(workspaceId),
            gitAdapter,
            fsApi,
            logger,
            onEvent: (event, details) => observability.record(event, details),
          });
          const result = await service.cleanupWorkspace({ workspaceId, activeWorkspaceRoot: opened.activeWorkspaceRoot });
          const roots = knownWorkspaceRoots.get(workspaceId);
          roots?.delete(opened.activeWorkspaceRoot);
          if (roots?.size === 0) knownWorkspaceRoots.delete(workspaceId);
          observability.record('workspace_instruction_projection_cleaned_up', {
            workspaceId,
            root: opened.activeWorkspaceRoot,
            reason: flag.reason,
          });
          return result;
        });
      }
      observability.record('workspace_instruction_projection_skipped', { workspaceId, reason: flag.reason, mode: flag.mode });
      return Object.freeze({
        skipped: true,
        reason: flag.reason,
        rollout: flag,
        repositoryRoot: candidateRoot,
        activeWorkspacePath: normalizedPath,
        projections: cleanup?.projections || [],
        cleanup,
      });
    }

    const opened = await resolveOpenedWorkspaceRoot({ repositoryRoot, activeWorkspacePath: normalizedPath, fsApi });
    const key = `${String(workspaceId || '')}\u0000${opened.activeWorkspaceRoot}`;
    return serialize(key, async () => {

      const instructions = await canonical(workspaceId);
      const service = serviceFactory({
        featureEnabled: true,
        canonicalInstructionsProvider: () => instructions,
        gitAdapter,
        fsApi,
        logger,
        onEvent: (event, details) => observability.record(event, details),
      });
      const result = await service.reconcileWorkspace({
        workspaceId,
        activeWorkspaceRoot: opened.activeWorkspaceRoot,
      });
      const remembered = {
        workspaceId,
        repositoryRoot: opened.repositoryRoot,
        activeWorkspacePath: opened.activeWorkspacePath,
        isInternalWorkspace,
      };
      const roots = knownWorkspaceRoots.get(workspaceId) || new Map();
      roots.set(opened.activeWorkspaceRoot, remembered);
      knownWorkspaceRoots.set(workspaceId, roots);
      observability.record('workspace_instruction_projection_runtime_reconciled', {
        workspaceId,
        root: opened.activeWorkspaceRoot,
        activeWorkspacePath: opened.activeWorkspacePath || '.',
        instructionVersion: instructions.version,
      });
      return Object.freeze({
        ...result,
        ...opened,
        rollout: flag,
        canonical: Object.freeze({
          instructionSetId: instructions.instructionSetId,
          version: instructions.version,
          hash: instructions.hash,
        }),
        // This remains server-only.  HTTP boundaries must never serialize it.
        canonicalBlock: buildVectantBlock(instructions),
      });
    });
  }

  async function updateCanonicalInstructions(workspaceId, update, { reconcileOpenWorkspaces = true } = {}) {
    const instructions = await metadataStore.set(workspaceId, update);
    if (!reconcileOpenWorkspaces) return Object.freeze({ instructions, reconciliations: [] });
    const known = Array.from(knownWorkspaceRoots.get(workspaceId)?.values() || []);
    const reconciliations = [];
    for (const workspace of known) {
      reconciliations.push(await reconcile(workspace));
    }
    observability.record('workspace_instruction_projection_canonical_updated', {
      workspaceId,
      instructionVersion: instructions.version,
      reconciledRoots: reconciliations.length,
    });
    return Object.freeze({ instructions, reconciliations });
  }

  async function cleanup({ workspaceId, repositoryRoot, activeWorkspacePath = '' } = {}) {
    const opened = await resolveOpenedWorkspaceRoot({ repositoryRoot, activeWorkspacePath, fsApi });
    const service = serviceFactory({
      featureEnabled: true,
      canonicalInstructionsProvider: () => canonical(workspaceId),
      gitAdapter,
      fsApi,
      logger,
      onEvent: (event, details) => observability.record(event, details),
    });
    const result = await service.cleanupWorkspace({ workspaceId, activeWorkspaceRoot: opened.activeWorkspaceRoot });
    const roots = knownWorkspaceRoots.get(workspaceId);
    roots?.delete(opened.activeWorkspaceRoot);
    if (roots?.size === 0) knownWorkspaceRoots.delete(workspaceId);
    observability.record('workspace_instruction_projection_cleaned_up', { workspaceId, root: opened.activeWorkspaceRoot });
    return result;
  }

  return Object.freeze({
    cleanup,
    reconcile,
    resolveOpenedWorkspaceRoot: (input) => resolveOpenedWorkspaceRoot({ ...input, fsApi }),
    metrics: () => observability.snapshot(),
    updateCanonicalInstructions,
  });
}

module.exports = {
  createWorkspaceInstructionGitAdapter,
  createWorkspaceInstructionProjectionRuntime,
  normalizedActiveWorkspacePath,
  resolveOpenedWorkspaceRoot,
};
