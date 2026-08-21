'use strict';

/**
 * The configuration boundary for passive workspace instruction projections.
 *
 * Projection code must take the opened directory from this module rather than
 * discovering a Git root.  A repository can surround the opened directory,
 * but it is not the workspace that the user chose to open.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ATOMIC_AGENT_PROTOCOL } = require('./workspaceAgentProtocol');
const {
  INSTRUCTION_PROJECTIONS,
  getEnabledInstructionProjections,
} = require('./workspaceInstructionProjection');

const WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG = 'workspace_instruction_projection';
const WORKSPACE_INSTRUCTION_METADATA_RELATIVE_PATH = '.synthi/workspace-instruction-projections.json';
const WORKSPACE_INSTRUCTION_STATE_VERSION = 1;

const ROLLOUT_ENV = 'WORKSPACE_INSTRUCTION_PROJECTION_ROLLOUT';
const PERCENTAGE_ENV = 'WORKSPACE_INSTRUCTION_PROJECTION_PERCENTAGE';
const INTERNAL_WORKSPACES_ENV = 'WORKSPACE_INSTRUCTION_PROJECTION_INTERNAL_WORKSPACE_IDS';
const DEFAULT_ROLLOUT_MODE = 'full';

const PROJECTION_OWNERSHIP = Object.freeze({
  EXISTING_USER_FILE: 'existing-user-file',
  SYNTHETIC_ONLY: 'synthetic-only',
});

function projectionConfigError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function requireNonEmptyString(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw projectionConfigError(code, code);
  }
  return normalized;
}

function normalizeWorkspaceId(workspaceId) {
  return requireNonEmptyString(workspaceId, 'workspace_instruction_projection_workspace_id_required');
}

function normalizeInstructionVersion(version) {
  if (version == null || version === '') return 1;
  const normalized = Number(version);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw projectionConfigError('workspace_instruction_projection_invalid_instruction_version');
  }
  return normalized;
}

function contentHash(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

/**
 * Produce the sole instruction payload consumed by the projection engine.
 * `content` deliberately defaults to the existing Synthi atomic protocol so
 * callers that have not yet stored workspace-specific instructions retain the
 * currently shipped behavior.  The returned value stores no secrets.
 */
function createCanonicalWorkspaceInstructions({ workspaceId, content = ATOMIC_AGENT_PROTOCOL, version = 1 } = {}) {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const normalizedContent = String(content == null ? '' : content);
  if (!normalizedContent.trim()) {
    throw projectionConfigError('workspace_instruction_projection_content_required');
  }
  const normalizedVersion = normalizeInstructionVersion(version);
  const hash = contentHash(normalizedContent);

  return Object.freeze({
    workspaceId: normalizedWorkspaceId,
    content: normalizedContent,
    version: normalizedVersion,
    hash,
    instructionSetId: `${normalizedWorkspaceId}:v${normalizedVersion}`,
  });
}

/**
 * Reads canonical instruction fields from the workspace metadata shape without
 * making a particular database schema the source of truth.  The persistent
 * workspace record can store `workspaceInstructions`; callers may also pass a
 * legacy `vectantInstructions` object while data is migrated.
 */
function canonicalWorkspaceInstructionsFromMetadata(workspace = {}, overrides = {}) {
  const metadata = workspace && typeof workspace === 'object' ? workspace : {};
  const source = metadata.workspaceInstructions
    || metadata.vectantInstructions
    || metadata.instructionProjection?.instructions
    || {};
  return createCanonicalWorkspaceInstructions({
    workspaceId: overrides.workspaceId || source.workspaceId || metadata.id || metadata.slug,
    content: Object.prototype.hasOwnProperty.call(overrides, 'content')
      ? overrides.content
      : (Object.prototype.hasOwnProperty.call(source, 'content') ? source.content : ATOMIC_AGENT_PROTOCOL),
    version: Object.prototype.hasOwnProperty.call(overrides, 'version')
      ? overrides.version
      : (source.version == null ? 1 : source.version),
  });
}

function enabledInstructionProjections(registry = INSTRUCTION_PROJECTIONS) {
  return getEnabledInstructionProjections(registry);
}

/**
 * Resolve the exact opened directory.  This function intentionally accepts no
 * fallback (especially not a Git root): missing active-root information is a
 * caller error rather than an invitation to project into another directory.
 */
async function resolveActiveWorkspaceRoot(activeWorkspaceRoot, { fsApi = fs.promises } = {}) {
  const requestedRoot = requireNonEmptyString(activeWorkspaceRoot, 'workspace_instruction_projection_active_root_required');
  const absoluteRoot = path.resolve(requestedRoot);
  let resolvedRoot;
  try {
    resolvedRoot = await fsApi.realpath(absoluteRoot);
  } catch (error) {
    const wrapped = projectionConfigError('workspace_instruction_projection_active_root_unavailable');
    wrapped.cause = error;
    throw wrapped;
  }

  let stat;
  try {
    stat = await fsApi.stat(resolvedRoot);
  } catch (error) {
    const wrapped = projectionConfigError('workspace_instruction_projection_active_root_unavailable');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!stat.isDirectory()) {
    throw projectionConfigError('workspace_instruction_projection_active_root_not_directory');
  }
  return resolvedRoot;
}

function resolvePathInsideActiveWorkspace(activeWorkspaceRoot, relativePath) {
  const root = path.resolve(requireNonEmptyString(activeWorkspaceRoot, 'workspace_instruction_projection_active_root_required'));
  const requestedPath = String(relativePath || '').replace(/\\/g, path.sep);
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw projectionConfigError('workspace_instruction_projection_invalid_projection_path');
  }
  const target = path.resolve(root, requestedPath);
  const relation = path.relative(root, target);
  if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw projectionConfigError('workspace_instruction_projection_path_escape');
  }
  return target;
}

function resolveInstructionProjectionPath(activeWorkspaceRoot, projection) {
  const configured = typeof projection === 'string' ? { path: projection } : projection;
  const entries = getEnabledInstructionProjections([configured]);
  if (entries.length !== 1) {
    throw projectionConfigError('workspace_instruction_projection_disabled_projection');
  }
  return resolvePathInsideActiveWorkspace(activeWorkspaceRoot, entries[0].path);
}

function normalizeRolloutMode(mode) {
  const normalized = String(mode == null ? DEFAULT_ROLLOUT_MODE : mode).trim().toLowerCase();
  if (normalized === 'off' || normalized === 'disabled') return 'off';
  if (normalized === 'internal' || normalized === 'internal-testing') return 'internal';
  if (normalized === 'percentage' || normalized === 'percent') return 'percentage';
  if (normalized === 'full' || normalized === 'on' || normalized === 'enabled') return 'full';
  return 'off';
}

function normalizePercentage(value) {
  const percentage = Number(value == null || value === '' ? 0 : value);
  if (!Number.isFinite(percentage)) return 0;
  return Math.min(100, Math.max(0, percentage));
}

function normalizedIdSet(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean));
}

function rolloutBucket(workspaceId) {
  const digest = crypto.createHash('sha256').update(normalizeWorkspaceId(workspaceId), 'utf8').digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Feature flag resolution is deterministic by workspace ID so a percentage
 * rollout does not flap between reconciliation attempts.  An internal list
 * or caller-provided trusted internal marker gates the internal-testing mode.
 */
function resolveWorkspaceInstructionProjectionFlag({
  workspaceId,
  rollout,
  percentage,
  isInternalWorkspace = false,
  internalWorkspaceIds,
  env = process.env,
} = {}) {
  const mode = normalizeRolloutMode(rollout == null ? env[ROLLOUT_ENV] : rollout);
  const normalizedPercentage = normalizePercentage(percentage == null ? env[PERCENTAGE_ENV] : percentage);
  const internalIds = normalizedIdSet(internalWorkspaceIds == null ? env[INTERNAL_WORKSPACES_ENV] : internalWorkspaceIds);
  const id = workspaceId == null || workspaceId === '' ? null : normalizeWorkspaceId(workspaceId);
  const bucket = id ? rolloutBucket(id) : null;
  const internal = Boolean(isInternalWorkspace) || Boolean(id && internalIds.has(id));

  if (mode === 'full') {
    return Object.freeze({ feature: WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG, enabled: true, mode, reason: 'full_rollout', percentage: normalizedPercentage, bucket });
  }
  if (mode === 'internal') {
    return Object.freeze({ feature: WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG, enabled: internal, mode, reason: internal ? 'internal_workspace' : 'not_internal_workspace', percentage: normalizedPercentage, bucket });
  }
  if (mode === 'percentage') {
    const enabled = bucket != null && bucket < normalizedPercentage;
    return Object.freeze({ feature: WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG, enabled, mode, reason: enabled ? 'percentage_rollout' : 'outside_percentage_rollout', percentage: normalizedPercentage, bucket });
  }
  return Object.freeze({ feature: WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG, enabled: false, mode: 'off', reason: 'feature_disabled', percentage: normalizedPercentage, bucket });
}

async function lstatOrNull(targetPath, fsApi) {
  try {
    return await fsApi.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeDirectory(targetPath, fsApi) {
  const existing = await lstatOrNull(targetPath, fsApi);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw projectionConfigError('workspace_instruction_projection_metadata_directory_unsafe');
    }
    return;
  }
  await fsApi.mkdir(targetPath, { recursive: true, mode: 0o700 });
  const created = await fsApi.lstat(targetPath);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw projectionConfigError('workspace_instruction_projection_metadata_directory_unsafe');
  }
}

async function readJsonIfPresent(metadataPath, fsApi) {
  const stat = await lstatOrNull(metadataPath, fsApi);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw projectionConfigError('workspace_instruction_projection_metadata_file_unsafe');
  }
  try {
    return JSON.parse(await fsApi.readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const wrapped = projectionConfigError('workspace_instruction_projection_metadata_invalid');
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

async function writeJsonAtomically(metadataPath, value, fsApi) {
  const existing = await lstatOrNull(metadataPath, fsApi);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw projectionConfigError('workspace_instruction_projection_metadata_file_unsafe');
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = path.join(
    path.dirname(metadataPath),
    `.${path.basename(metadataPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  let handle;
  try {
    handle = await fsApi.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    try { await handle.sync(); } catch (_) { /* unsupported on some filesystems */ }
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fsApi.rename(temporaryPath, metadataPath);
  } catch (error) {
    await fsApi.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function normalizeProjectionState(value, { workspaceId, activeWorkspaceRoot } = {}) {
  const supplied = value && typeof value === 'object' ? value : {};
  const root = requireNonEmptyString(activeWorkspaceRoot || supplied.activeWorkspaceRoot, 'workspace_instruction_projection_active_root_required');
  const id = normalizeWorkspaceId(workspaceId || supplied.workspaceId);
  const canonical = supplied.instructions
    ? createCanonicalWorkspaceInstructions(supplied.instructions)
    : null;
  return {
    schemaVersion: WORKSPACE_INSTRUCTION_STATE_VERSION,
    workspaceId: id,
    activeWorkspaceRoot: root,
    instructionSet: canonical ? {
      id: canonical.instructionSetId,
      version: canonical.version,
      hash: canonical.hash,
    } : (supplied.instructionSet && typeof supplied.instructionSet === 'object' ? { ...supplied.instructionSet } : null),
    projections: supplied.projections && typeof supplied.projections === 'object' ? { ...supplied.projections } : {},
    updatedAt: supplied.updatedAt || new Date().toISOString(),
  };
}

/**
 * Creates the durable private-state seam used by the projection lifecycle.
 * It records ownership and the last canonical instruction fingerprint, but
 * never writes a terminal-visible instruction document itself.
 */
async function createWorkspaceInstructionProjectionMetadataStore({
  activeWorkspaceRoot,
  fsApi = fs.promises,
  metadataRelativePath = WORKSPACE_INSTRUCTION_METADATA_RELATIVE_PATH,
} = {}) {
  const root = await resolveActiveWorkspaceRoot(activeWorkspaceRoot, { fsApi });
  const metadataPath = resolvePathInsideActiveWorkspace(root, metadataRelativePath);
  const metadataDirectory = path.dirname(metadataPath);

  return Object.freeze({
    activeWorkspaceRoot: root,
    metadataPath,
    async load() {
      return readJsonIfPresent(metadataPath, fsApi);
    },
    async save(state) {
      await ensureSafeDirectory(metadataDirectory, fsApi);
      const normalized = normalizeProjectionState(state, {
        activeWorkspaceRoot: root,
      });
      await writeJsonAtomically(metadataPath, normalized, fsApi);
      return normalized;
    },
    async update(workspaceId, updater) {
      const current = await readJsonIfPresent(metadataPath, fsApi);
      const next = await updater(current);
      return this.save({
        ...(next || {}),
        workspaceId: workspaceId || next?.workspaceId || current?.workspaceId,
        activeWorkspaceRoot: root,
      });
    },
  });
}

module.exports = {
  INSTRUCTION_PROJECTIONS,
  INTERNAL_WORKSPACES_ENV,
  DEFAULT_ROLLOUT_MODE,
  PERCENTAGE_ENV,
  PROJECTION_OWNERSHIP,
  ROLLOUT_ENV,
  WORKSPACE_INSTRUCTION_METADATA_RELATIVE_PATH,
  WORKSPACE_INSTRUCTION_PROJECTION_FEATURE_FLAG,
  WORKSPACE_INSTRUCTION_STATE_VERSION,
  canonicalWorkspaceInstructionsFromMetadata,
  contentHash,
  createCanonicalWorkspaceInstructions,
  createWorkspaceInstructionProjectionMetadataStore,
  enabledInstructionProjections,
  normalizeInstructionVersion,
  normalizeRolloutMode,
  resolveActiveWorkspaceRoot,
  resolveInstructionProjectionPath,
  resolvePathInsideActiveWorkspace,
  resolveWorkspaceInstructionProjectionFlag,
  rolloutBucket,
};
