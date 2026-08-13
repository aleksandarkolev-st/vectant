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
  resolveFlag = resolveWorkspaceInstructionProjectionFlag,
  serviceFactory = (options) => new WorkspaceInstructionProjectionService(options),
} = {}) {
  if (!metadataStore || typeof metadataStore.get !== 'function' || typeof metadataStore.set !== 'function') {
    throw new TypeError('workspace_instruction_projection_metadata_store_required');
  }

  async function canonical(workspaceId) {
    return metadataStore.get(workspaceId);
  }

  async function reconcile({ workspaceId, repositoryRoot, activeWorkspacePath = '', isInternalWorkspace = false } = {}) {
    const opened = await resolveOpenedWorkspaceRoot({ repositoryRoot, activeWorkspacePath, fsApi });
    const flag = resolveFlag({ workspaceId, isInternalWorkspace });
    if (!flag.enabled) {
      return Object.freeze({
        skipped: true,
        reason: flag.reason,
        rollout: flag,
        ...opened,
        projections: [],
      });
    }

    const instructions = await canonical(workspaceId);
    const service = serviceFactory({
      featureEnabled: true,
      canonicalInstructionsProvider: () => instructions,
      gitAdapter,
      fsApi,
      logger,
    });
    const result = await service.reconcileWorkspace({
      workspaceId,
      activeWorkspaceRoot: opened.activeWorkspaceRoot,
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
  }

  async function updateCanonicalInstructions(workspaceId, update) {
    return metadataStore.set(workspaceId, update);
  }

  async function cleanup({ workspaceId, repositoryRoot, activeWorkspacePath = '' } = {}) {
    const opened = await resolveOpenedWorkspaceRoot({ repositoryRoot, activeWorkspacePath, fsApi });
    const service = serviceFactory({
      featureEnabled: true,
      canonicalInstructionsProvider: () => canonical(workspaceId),
      gitAdapter,
      fsApi,
      logger,
    });
    return service.cleanupWorkspace({ workspaceId, activeWorkspaceRoot: opened.activeWorkspaceRoot });
  }

  return Object.freeze({
    cleanup,
    reconcile,
    resolveOpenedWorkspaceRoot: (input) => resolveOpenedWorkspaceRoot({ ...input, fsApi }),
    updateCanonicalInstructions,
  });
}

module.exports = {
  createWorkspaceInstructionGitAdapter,
  createWorkspaceInstructionProjectionRuntime,
  normalizedActiveWorkspacePath,
  resolveOpenedWorkspaceRoot,
};
