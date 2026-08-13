'use strict';

/**
 * Physical projection lifecycle for passive workspace instruction documents.
 *
 * This deliberately has no knowledge of a workspace database, Git command
 * implementation, or server lifecycle.  The host supplies canonical workspace
 * instructions and may supply a Git adapter.  Keeping those boundaries here
 * lets the same exact-active-root implementation serve local and container
 * workspaces without discovering a repository root or an agent runtime.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  INSTRUCTION_PROJECTIONS,
  buildVectantBlock,
  containsUserContent,
  getEnabledInstructionProjections,
  instructionHash,
  mergeVectantBlock,
  normalizeProjectionPath,
  stripVectantBlock,
} = require('./workspaceInstructionProjection');

const PROJECTION_OWNERSHIP = Object.freeze({
  EXISTING_USER_FILE: 'existing-user-file',
  SYNTHETIC_ONLY: 'synthetic-only',
});

const WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH = '.synthi/workspace-instruction-projection-state.json';
const WORKSPACE_INSTRUCTION_PROJECTION_STATE_VERSION = 1;
const DEFAULT_MAX_WRITE_RETRIES = 3;

function projectionError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requireWorkspaceContext(workspace) {
  if (!workspace || typeof workspace !== 'object') {
    throw projectionError('workspace_instruction_projection_workspace_required');
  }
  const activeWorkspaceRoot = String(workspace.activeWorkspaceRoot || '').trim();
  if (!activeWorkspaceRoot) {
    throw projectionError('workspace_instruction_projection_active_root_required');
  }
  return activeWorkspaceRoot;
}

function requireWorkspaceId(workspaceId) {
  const normalized = String(workspaceId || '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw projectionError('workspace_instruction_projection_workspace_id_required');
  }
  return normalized;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveProjectionTarget(activeWorkspaceRoot, relativePath) {
  const normalizedRelativePath = normalizeProjectionPath(relativePath);
  const target = path.resolve(activeWorkspaceRoot, ...normalizedRelativePath.split('/'));
  if (!pathIsInside(activeWorkspaceRoot, target)) {
    throw projectionError('workspace_instruction_projection_path_escape');
  }
  return { normalizedRelativePath, target };
}

function sameSnapshot(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.exists === right.exists
    && (!left.exists || (left.hash === right.hash && left.mode === right.mode));
}

function normalizeStateEntry(value) {
  if (!value || typeof value !== 'object') return null;
  if (
    value.ownership !== PROJECTION_OWNERSHIP.EXISTING_USER_FILE
    && value.ownership !== PROJECTION_OWNERSHIP.SYNTHETIC_ONLY
  ) return null;
  return {
    ownership: value.ownership,
    existedBeforeProjection: Boolean(value.existedBeforeProjection),
    originallyTrackedByGit: Boolean(value.originallyTrackedByGit),
    originallyUntrackedByGit: Boolean(value.originallyUntrackedByGit),
    instructionSetId: typeof value.instructionSetId === 'string' ? value.instructionSetId : null,
    instructionVersion: value.instructionVersion == null ? null : value.instructionVersion,
    instructionHash: typeof value.instructionHash === 'string' ? value.instructionHash : null,
    lastUserContentHash: typeof value.lastUserContentHash === 'string' ? value.lastUserContentHash : null,
  };
}

function freshState(workspaceId, activeWorkspaceRoot) {
  return {
    schemaVersion: WORKSPACE_INSTRUCTION_PROJECTION_STATE_VERSION,
    workspaceId,
    activeWorkspaceRoot,
    projections: {},
  };
}

class WorkspaceInstructionProjectionService {
  /**
   * @param {object} options
   * @param {boolean} options.featureEnabled Explicit rollout decision.  A host
   *   computes percentage/internal rollout elsewhere and passes the result.
   * @param {(workspace: object) => Promise<object>|object} options.canonicalInstructionsProvider
   *   Returns the one canonical `{ workspaceId, content, version, ... }` set.
   * @param {object} [options.gitAdapter] Optional integration boundary.  When
   *   present it may expose `reconcileWorkspace(context)` and
   *   `removeWorkspace(context)`.
   */
  constructor({
    featureEnabled,
    canonicalInstructionsProvider,
    gitAdapter = null,
    projections = INSTRUCTION_PROJECTIONS,
    fsApi = fs.promises,
    stateRelativePath = WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH,
    maxWriteRetries = DEFAULT_MAX_WRITE_RETRIES,
    logger = null,
    onEvent = null,
  } = {}) {
    if (typeof featureEnabled !== 'boolean') {
      throw new TypeError('workspace_instruction_projection_feature_enabled_boolean_required');
    }
    if (typeof canonicalInstructionsProvider !== 'function') {
      throw new TypeError('workspace_instruction_projection_canonical_provider_required');
    }
    if (!fsApi || typeof fsApi.readFile !== 'function' || typeof fsApi.lstat !== 'function') {
      throw new TypeError('workspace_instruction_projection_fs_api_required');
    }
    const retries = Number(maxWriteRetries);
    if (!Number.isSafeInteger(retries) || retries < 1 || retries > 16) {
      throw new TypeError('workspace_instruction_projection_invalid_write_retries');
    }

    this.featureEnabled = featureEnabled;
    this.canonicalInstructionsProvider = canonicalInstructionsProvider;
    this.gitAdapter = gitAdapter;
    this.projections = getEnabledInstructionProjections(projections);
    this.fs = fsApi;
    this.stateRelativePath = normalizeProjectionPath(stateRelativePath);
    this.maxWriteRetries = retries;
    this.logger = logger;
    this.onEvent = onEvent;
  }

  _emit(event, details = {}) {
    const safeDetails = { ...details };
    // Instruction payloads must never be emitted by lifecycle logging.
    delete safeDetails.content;
    delete safeDetails.block;
    try {
      if (typeof this.onEvent === 'function') this.onEvent(event, safeDetails);
      if (this.logger && typeof this.logger.info === 'function') this.logger.info(event, safeDetails);
    } catch (_) {
      // Instrumentation must not prevent the filesystem recovery path.
    }
  }

  async _resolveActiveRoot(workspace) {
    const requestedRoot = requireWorkspaceContext(workspace);
    const absoluteRoot = path.resolve(requestedRoot);
    let realRoot;
    try {
      realRoot = await this.fs.realpath(absoluteRoot);
    } catch (error) {
      throw projectionError('workspace_instruction_projection_active_root_unavailable', error);
    }
    let stat;
    try {
      stat = await this.fs.lstat(realRoot);
    } catch (error) {
      throw projectionError('workspace_instruction_projection_active_root_unavailable', error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw projectionError('workspace_instruction_projection_active_root_not_directory');
    }
    return realRoot;
  }

  async _lstatOrNull(targetPath) {
    try {
      return await this.fs.lstat(targetPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _assertSafeTarget(activeWorkspaceRoot, targetPath, { createParent = false } = {}) {
    if (!pathIsInside(activeWorkspaceRoot, targetPath)) {
      throw projectionError('workspace_instruction_projection_path_escape');
    }
    const relative = path.relative(activeWorkspaceRoot, targetPath);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = activeWorkspaceRoot;
    for (let index = 0; index < segments.length; index += 1) {
      const isTarget = index === segments.length - 1;
      current = path.join(current, segments[index]);
      let stat = await this._lstatOrNull(current);
      if (!isTarget && !stat && createParent) {
        await this.fs.mkdir(current, { recursive: false, mode: 0o700 });
        stat = await this._lstatOrNull(current);
      }
      if (!stat) {
        // A missing parent also proves the final target is missing.  It will be
        // created safely on the atomic-write path when requested.
        return null;
      }
      if (stat.isSymbolicLink()) {
        throw projectionError(
          isTarget
            ? 'workspace_instruction_projection_target_symlink_refused'
            : 'workspace_instruction_projection_unsafe_directory',
        );
      }
      if (!isTarget && !stat.isDirectory()) {
        throw projectionError('workspace_instruction_projection_unsafe_directory');
      }
      if (isTarget && !stat.isFile()) {
        throw projectionError('workspace_instruction_projection_target_not_file');
      }
      if (isTarget) return stat;
    }
    return null;
  }

  async _readSnapshot(activeWorkspaceRoot, targetPath) {
    const stat = await this._assertSafeTarget(activeWorkspaceRoot, targetPath);
    if (!stat) {
      return { exists: false, content: '', hash: null, mode: null };
    }
    const content = await this.fs.readFile(targetPath, 'utf8');
    // Ensure a terminal-side replacement did not turn the file into a symlink
    // between lstat and read.  A change is retried by the caller.
    const after = await this._assertSafeTarget(activeWorkspaceRoot, targetPath);
    if (!after || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw projectionError('workspace_instruction_projection_source_changed');
    }
    return {
      exists: true,
      content,
      hash: hash(content),
      mode: stat.mode & 0o777,
    };
  }

  async _atomicReplace(activeWorkspaceRoot, targetPath, expectedSnapshot, content) {
    await this._assertSafeTarget(activeWorkspaceRoot, targetPath, { createParent: true });
    const immediatelyBeforeWrite = await this._readSnapshot(activeWorkspaceRoot, targetPath);
    if (!sameSnapshot(expectedSnapshot, immediatelyBeforeWrite)) {
      throw projectionError('workspace_instruction_projection_conflict');
    }

    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.vectant-projection-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const mode = expectedSnapshot.exists ? expectedSnapshot.mode : 0o644;
    let handle;
    try {
      handle = await this.fs.open(temporaryPath, 'wx', mode);
      await handle.writeFile(content, 'utf8');
      try { await handle.sync(); } catch (_) { /* filesystems may not support fsync */ }
    } finally {
      if (handle) await handle.close();
    }

    try {
      // A final compare immediately before rename makes a terminal writer win;
      // reconciliation will rebase instead of overwriting that user edit.
      const beforeRename = await this._readSnapshot(activeWorkspaceRoot, targetPath);
      if (!sameSnapshot(expectedSnapshot, beforeRename)) {
        throw projectionError('workspace_instruction_projection_conflict');
      }
      await this.fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await this.fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }

    const written = await this._readSnapshot(activeWorkspaceRoot, targetPath);
    if (!written.exists || written.hash !== hash(content)) {
      throw projectionError('workspace_instruction_projection_write_verification_failed');
    }
    return written;
  }

  async _writeWithOptimisticRetry(activeWorkspaceRoot, targetPath, transform, { rebaseOnConflict }) {
    let lastConflict = null;
    for (let attempt = 0; attempt < this.maxWriteRetries; attempt += 1) {
      let snapshot;
      try {
        snapshot = await this._readSnapshot(activeWorkspaceRoot, targetPath);
      } catch (error) {
        if (error.code === 'workspace_instruction_projection_source_changed' && rebaseOnConflict) {
          lastConflict = error;
          continue;
        }
        throw error;
      }
      const nextContent = await transform(snapshot, attempt);
      if (nextContent === snapshot.content) return { before: snapshot, after: snapshot, changed: false };
      try {
        const after = await this._atomicReplace(activeWorkspaceRoot, targetPath, snapshot, nextContent);
        return { before: snapshot, after, changed: true };
      } catch (error) {
        if (
          error.code !== 'workspace_instruction_projection_conflict'
          && error.code !== 'workspace_instruction_projection_source_changed'
        ) throw error;
        lastConflict = error;
        if (!rebaseOnConflict) break;
      }
    }
    throw lastConflict || projectionError('workspace_instruction_projection_conflict');
  }

  async _loadCanonicalInstructions(workspace) {
    const instructions = await this.canonicalInstructionsProvider(workspace);
    if (!instructions || typeof instructions !== 'object') {
      throw projectionError('workspace_instruction_projection_canonical_instructions_required');
    }
    const workspaceId = requireWorkspaceId(instructions.workspaceId);
    const block = buildVectantBlock(instructions);
    return { instructions, workspaceId, block };
  }

  _statePath(activeWorkspaceRoot) {
    return resolveProjectionTarget(activeWorkspaceRoot, this.stateRelativePath).target;
  }

  async _loadState(activeWorkspaceRoot, workspaceId) {
    const statePath = this._statePath(activeWorkspaceRoot);
    const stat = await this._assertSafeTarget(activeWorkspaceRoot, statePath);
    if (!stat) return freshState(workspaceId, activeWorkspaceRoot);
    let parsed;
    try {
      parsed = JSON.parse(await this.fs.readFile(statePath, 'utf8'));
    } catch (error) {
      // State is an optimization/recovery hint, never permission to discard
      // ambiguous user content.  Treat malformed state as absent.
      this._emit('workspace_instruction_projection_state_invalid', { workspaceId, path: statePath });
      return freshState(workspaceId, activeWorkspaceRoot);
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.workspaceId !== workspaceId
      || parsed.activeWorkspaceRoot !== activeWorkspaceRoot
      || !parsed.projections
      || typeof parsed.projections !== 'object'
    ) return freshState(workspaceId, activeWorkspaceRoot);

    const state = freshState(workspaceId, activeWorkspaceRoot);
    for (const [projectionPath, entry] of Object.entries(parsed.projections)) {
      try {
        const normalizedPath = normalizeProjectionPath(projectionPath);
        const normalizedEntry = normalizeStateEntry(entry);
        if (normalizedEntry) state.projections[normalizedPath] = normalizedEntry;
      } catch (_) {
        // Ignore one broken entry; recovery must preserve the corresponding file.
      }
    }
    return state;
  }

  async _saveState(activeWorkspaceRoot, state) {
    const statePath = this._statePath(activeWorkspaceRoot);
    const serializable = {
      schemaVersion: WORKSPACE_INSTRUCTION_PROJECTION_STATE_VERSION,
      workspaceId: state.workspaceId,
      activeWorkspaceRoot,
      projections: state.projections,
      updatedAt: new Date().toISOString(),
    };
    const existing = await this._readSnapshot(activeWorkspaceRoot, statePath);
    await this._writeWithOptimisticRetry(
      activeWorkspaceRoot,
      statePath,
      () => `${JSON.stringify(serializable, null, 2)}\n`,
      { rebaseOnConflict: true },
    );
    return { path: statePath, changed: existing.content !== `${JSON.stringify(serializable, null, 2)}\n` };
  }

  _projectionForPath(relativePath) {
    const normalized = normalizeProjectionPath(relativePath);
    const projection = this.projections.find((entry) => entry.path === normalized);
    if (!projection) throw projectionError('workspace_instruction_projection_not_registered');
    return projection;
  }

  _ownershipForSnapshot(previous, snapshot) {
    if (previous?.ownership === PROJECTION_OWNERSHIP.EXISTING_USER_FILE) {
      return PROJECTION_OWNERSHIP.EXISTING_USER_FILE;
    }
    if (previous?.ownership === PROJECTION_OWNERSHIP.SYNTHETIC_ONLY) {
      return containsUserContent(snapshot.content)
        ? PROJECTION_OWNERSHIP.EXISTING_USER_FILE
        : PROJECTION_OWNERSHIP.SYNTHETIC_ONLY;
    }
    // Missing state is ambiguous.  An existing file is conservatively user
    // owned even if it currently contains only an old managed block.
    return snapshot.exists
      ? PROJECTION_OWNERSHIP.EXISTING_USER_FILE
      : PROJECTION_OWNERSHIP.SYNTHETIC_ONLY;
  }

  _nextStateEntry(previous, snapshot, canonical) {
    const ownership = this._ownershipForSnapshot(previous, snapshot);
    return {
      ownership,
      existedBeforeProjection: previous ? previous.existedBeforeProjection : snapshot.exists,
      originallyTrackedByGit: previous ? previous.originallyTrackedByGit : false,
      originallyUntrackedByGit: previous ? previous.originallyUntrackedByGit : false,
      instructionSetId: canonical.instructions.instructionSetId || `${canonical.workspaceId}:v${canonical.instructions.version}`,
      instructionVersion: canonical.instructions.version,
      instructionHash: canonical.instructions.hash || instructionHash(canonical.instructions.content),
      lastUserContentHash: hash(stripVectantBlock(snapshot.content)),
    };
  }

  async _reconcileProjection(activeWorkspaceRoot, state, canonical, projection) {
    const { normalizedRelativePath, target } = resolveProjectionTarget(activeWorkspaceRoot, projection.path);
    const previous = state.projections[normalizedRelativePath] || null;
    const write = await this._writeWithOptimisticRetry(
      activeWorkspaceRoot,
      target,
      (snapshot) => mergeVectantBlock(snapshot.content, canonical.block),
      { rebaseOnConflict: true },
    );
    // Ownership is decided from what existed before reconciliation.  A newly
    // created block-only document is synthetic; a terminal edit observed
    // before reconciliation promotes an existing synthetic file to user-owned.
    const entry = this._nextStateEntry(previous, write.before, canonical);
    state.projections[normalizedRelativePath] = entry;
    const result = {
      path: normalizedRelativePath,
      target,
      ownership: entry.ownership,
      changed: write.changed,
    };
    this._emit(write.changed ? 'workspace_instruction_projection_updated' : 'workspace_instruction_projection_reconciled', {
      workspaceId: canonical.workspaceId,
      path: normalizedRelativePath,
      ownership: entry.ownership,
      instructionVersion: canonical.instructions.version,
      instructionHash: entry.instructionHash,
    });
    return result;
  }

  async reconcileWorkspace(workspace) {
    if (!this.featureEnabled) return { skipped: true, reason: 'feature_disabled', projections: [] };
    const activeWorkspaceRoot = await this._resolveActiveRoot(workspace);
    const canonical = await this._loadCanonicalInstructions({ ...workspace, activeWorkspaceRoot });
    const state = await this._loadState(activeWorkspaceRoot, canonical.workspaceId);
    const results = [];
    for (const projection of this.projections) {
      const result = await this._reconcileProjection(activeWorkspaceRoot, state, canonical, projection);
      results.push(result);
      // Persist after each projection so a crash cannot turn a known synthetic
      // document into ambiguous state during later cleanup.
      await this._saveState(activeWorkspaceRoot, state);
    }
    if (this.gitAdapter && typeof this.gitAdapter.reconcileWorkspace === 'function') {
      await this.gitAdapter.reconcileWorkspace({
        workspaceId: canonical.workspaceId,
        activeWorkspaceRoot,
        instructions: canonical.instructions,
        block: canonical.block,
        projections: results.map(({ path: projectionPath, ownership }) => ({ path: projectionPath, ownership })),
      });
    }
    return { skipped: false, activeWorkspaceRoot, workspaceId: canonical.workspaceId, projections: results };
  }

  // A deliberate alias for lifecycle callers that call their open action
  // "reconcile all" rather than "reconcile workspace".
  async reconcileAll(workspace) {
    return this.reconcileWorkspace(workspace);
  }

  async reconcileProjection(workspace, relativePath) {
    if (!this.featureEnabled) return { skipped: true, reason: 'feature_disabled' };
    const projection = this._projectionForPath(relativePath);
    const activeWorkspaceRoot = await this._resolveActiveRoot(workspace);
    const canonical = await this._loadCanonicalInstructions({ ...workspace, activeWorkspaceRoot });
    const state = await this._loadState(activeWorkspaceRoot, canonical.workspaceId);
    const result = await this._reconcileProjection(activeWorkspaceRoot, state, canonical, projection);
    await this._saveState(activeWorkspaceRoot, state);
    if (this.gitAdapter && typeof this.gitAdapter.reconcileProjection === 'function') {
      await this.gitAdapter.reconcileProjection({
        workspaceId: canonical.workspaceId,
        activeWorkspaceRoot,
        instructions: canonical.instructions,
        block: canonical.block,
        projection: { path: result.path, ownership: result.ownership },
      });
    }
    return { skipped: false, activeWorkspaceRoot, workspaceId: canonical.workspaceId, ...result };
  }

  async readForIde(workspace, relativePath) {
    const projection = this._projectionForPath(relativePath);
    const activeWorkspaceRoot = await this._resolveActiveRoot(workspace);
    const { target } = resolveProjectionTarget(activeWorkspaceRoot, projection.path);
    const snapshot = await this._readSnapshot(activeWorkspaceRoot, target);
    if (!snapshot.exists) throw projectionError('workspace_instruction_projection_not_found');
    return this.featureEnabled ? stripVectantBlock(snapshot.content) : snapshot.content;
  }

  async writeFromIde(workspace, relativePath, userContent) {
    if (!this.featureEnabled) return { skipped: true, reason: 'feature_disabled' };
    const projection = this._projectionForPath(relativePath);
    const activeWorkspaceRoot = await this._resolveActiveRoot(workspace);
    const canonical = await this._loadCanonicalInstructions({ ...workspace, activeWorkspaceRoot });
    const state = await this._loadState(activeWorkspaceRoot, canonical.workspaceId);
    const { normalizedRelativePath, target } = resolveProjectionTarget(activeWorkspaceRoot, projection.path);
    const previous = state.projections[normalizedRelativePath] || null;
    const value = String(userContent == null ? '' : userContent);
    const write = await this._writeWithOptimisticRetry(
      activeWorkspaceRoot,
      target,
      () => mergeVectantBlock(value, canonical.block),
      // An IDE write must not silently replace terminal-side content.  It has a
      // bounded retry loop for transient reads, then returns a conflict.
      { rebaseOnConflict: false },
    );
    // IDE content is user-originated.  Use the terminal result when it has
    // user bytes (promotion), otherwise retain the pre-write synthetic state.
    const entry = this._nextStateEntry(
      previous,
      containsUserContent(write.after.content) ? write.after : write.before,
      canonical,
    );
    state.projections[normalizedRelativePath] = entry;
    await this._saveState(activeWorkspaceRoot, state);
    this._emit('workspace_instruction_projection_ide_write', {
      workspaceId: canonical.workspaceId,
      path: normalizedRelativePath,
      ownership: entry.ownership,
      instructionVersion: canonical.instructions.version,
      instructionHash: entry.instructionHash,
    });
    return { skipped: false, path: normalizedRelativePath, ownership: entry.ownership, changed: write.changed };
  }

  async _removeStateFile(activeWorkspaceRoot) {
    const statePath = this._statePath(activeWorkspaceRoot);
    const stat = await this._assertSafeTarget(activeWorkspaceRoot, statePath);
    if (stat) await this.fs.unlink(statePath);
  }

  async removeWorkspaceProjection(workspace) {
    const activeWorkspaceRoot = await this._resolveActiveRoot(workspace);
    const requestedWorkspaceId = workspace.workspaceId || workspace.id || null;
    const state = await this._loadState(activeWorkspaceRoot, requireWorkspaceId(requestedWorkspaceId));
    const results = [];
    for (const projection of this.projections) {
      const { normalizedRelativePath, target } = resolveProjectionTarget(activeWorkspaceRoot, projection.path);
      const snapshot = await this._readSnapshot(activeWorkspaceRoot, target);
      if (!snapshot.exists) {
        results.push({ path: normalizedRelativePath, removed: false, missing: true });
        continue;
      }
      const entry = state.projections[normalizedRelativePath] || null;
      const ownership = this._ownershipForSnapshot(entry, snapshot);
      if (ownership === PROJECTION_OWNERSHIP.SYNTHETIC_ONLY && !containsUserContent(snapshot.content)) {
        await this._assertSafeTarget(activeWorkspaceRoot, target);
        await this.fs.unlink(target);
        results.push({ path: normalizedRelativePath, removed: true, ownership });
        this._emit('workspace_instruction_projection_removed', { workspaceId: state.workspaceId, path: normalizedRelativePath, ownership });
        continue;
      }
      const write = await this._writeWithOptimisticRetry(
        activeWorkspaceRoot,
        target,
        (current) => stripVectantBlock(current.content),
        { rebaseOnConflict: true },
      );
      results.push({ path: normalizedRelativePath, removed: false, ownership, changed: write.changed });
      this._emit('workspace_instruction_projection_removed', { workspaceId: state.workspaceId, path: normalizedRelativePath, ownership });
    }
    if (this.gitAdapter && typeof this.gitAdapter.removeWorkspace === 'function') {
      await this.gitAdapter.removeWorkspace({
        workspaceId: state.workspaceId,
        activeWorkspaceRoot,
        projections: results,
      });
    }
    await this._removeStateFile(activeWorkspaceRoot);
    return { activeWorkspaceRoot, workspaceId: state.workspaceId, projections: results };
  }

  async cleanupWorkspace(workspace) {
    return this.removeWorkspaceProjection(workspace);
  }
}

module.exports = {
  DEFAULT_MAX_WRITE_RETRIES,
  PROJECTION_OWNERSHIP,
  WORKSPACE_INSTRUCTION_PROJECTION_STATE_PATH,
  WORKSPACE_INSTRUCTION_PROJECTION_STATE_VERSION,
  WorkspaceInstructionProjectionService,
};
