'use strict';

/**
 * IDE-facing presentation helpers for passive workspace instructions.
 *
 * The projection lifecycle owns the physical terminal-visible documents.
 * This module deliberately performs no I/O and has no knowledge of HTTP,
 * Git, or a particular editor.  Collab-server callers can apply it at their
 * file-tree, read, and write boundaries without creating a second filesystem
 * implementation.
 */

const {
  INSTRUCTION_PROJECTIONS,
  buildVectantBlock,
  detectLineEnding,
  getEnabledInstructionProjections,
  isInstructionProjectionPath,
  mergeVectantBlock,
  normalizeProjectionPath,
  stripVectantBlock,
} = require('./workspaceInstructionProjection');
const {
  PROJECTION_OWNERSHIP,
} = require('./workspaceInstructionProjectionConfig');

function normalizeIdePath(value) {
  try {
    return normalizeProjectionPath(value);
  } catch {
    return null;
  }
}

function projectionStateForPath(projectionMetadata, projectionPath) {
  if (!projectionMetadata || typeof projectionMetadata !== 'object' || !projectionPath) {
    return null;
  }

  const states = projectionMetadata.projections
    && typeof projectionMetadata.projections === 'object'
    ? projectionMetadata.projections
    : projectionMetadata;
  const candidate = states[projectionPath];
  return candidate && typeof candidate === 'object' ? candidate : null;
}

function validOwnership(value) {
  return value === PROJECTION_OWNERSHIP.SYNTHETIC_ONLY
    || value === PROJECTION_OWNERSHIP.EXISTING_USER_FILE
    ? value
    : null;
}

function classifierResult(classifyProjection, input, fallback) {
  if (typeof classifyProjection !== 'function') return fallback;
  const result = classifyProjection(Object.freeze({ ...input, projection: fallback }));
  if (typeof result === 'string') return { ownership: result };
  return result && typeof result === 'object' ? result : fallback;
}

/**
 * Classify a path for IDE presentation.  The registry is always authoritative:
 * a caller cannot cause an unrelated user file to disappear simply by marking
 * it synthetic in metadata.  Likewise, unknown/missing ownership is visible
 * by default to avoid hiding a user-owned file after state loss.
 */
function classifyInstructionProjectionForIde({
  path,
  projectionMetadata = null,
  classifyProjection = null,
  registry = INSTRUCTION_PROJECTIONS,
} = {}) {
  const normalizedPath = normalizeIdePath(path);
  const enabledRegistry = getEnabledInstructionProjections(registry);
  const isInstructionProjection = Boolean(
    normalizedPath && isInstructionProjectionPath(normalizedPath, enabledRegistry),
  );
  const state = isInstructionProjection
    ? projectionStateForPath(projectionMetadata, normalizedPath)
    : null;
  // A registered path the projection service skipped (a symlink it must not
  // follow) is treated as a plain user file: not hidden, not stripped, not
  // merged into on write.
  const externalProjection = Boolean(state && state.external === true);
  const managedProjection = isInstructionProjection && !externalProjection;
  const classified = classifierResult(classifyProjection, {
    path: normalizedPath || String(path || ''),
    projectionMetadata,
    registry: enabledRegistry,
  }, state);
  const ownership = managedProjection ? validOwnership(classified?.ownership) : null;
  const syntheticOnly = managedProjection
    && ownership === PROJECTION_OWNERSHIP.SYNTHETIC_ONLY;

  return Object.freeze({
    path: normalizedPath || String(path || ''),
    isInstructionProjection: managedProjection,
    ownership,
    syntheticOnly,
    hideFromExplorer: syntheticOnly,
    externalProjection,
  });
}

/**
 * The collab file listing is flat (`[{ path, ...metadata }]`) before Synthi
 * builds its explorer tree.  Keep that shape and never mutate caller entries.
 */
function filterInstructionProjectionsFromIdeTree(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new TypeError('workspace_instruction_ide_tree_entries_array_required');
  }
  return entries.filter((entry) => !classifyInstructionProjectionForIde({
    ...options,
    path: entry?.path,
  }).hideFromExplorer);
}

/**
 * Present physical terminal-visible content to an IDE editor.  Vectant blocks
 * are stripped only from registered passive instruction documents; arbitrary
 * files that happen to contain the marker text are returned unchanged.
 */
function readInstructionProjectionForIde({
  path,
  physicalContent,
  registry = INSTRUCTION_PROJECTIONS,
} = {}) {
  const presentation = classifyInstructionProjectionForIde({ path, registry });
  const content = String(physicalContent ?? '');
  return Object.freeze({
    ...presentation,
    content: presentation.isInstructionProjection ? stripVectantBlock(content) : content,
  });
}

function canonicalBlockForIdeWrite({ canonicalBlock, canonicalInstructions, userContent }) {
  if (canonicalBlock != null) return String(canonicalBlock);
  if (!canonicalInstructions || typeof canonicalInstructions !== 'object') {
    throw new TypeError('workspace_instruction_ide_canonical_block_required');
  }
  return buildVectantBlock(canonicalInstructions, {
    lineEnding: detectLineEnding(userContent),
  });
}

/**
 * Reassemble a terminal-visible projection after an IDE edit.  The frontend
 * sends only its user-visible text and never has to retain the hidden block.
 * Non-projection writes pass through untouched and do not require instruction
 * metadata, which makes this safe to place in a generic write endpoint.
 */
function mergeInstructionProjectionWriteFromIde({
  path,
  userContent,
  canonicalBlock = null,
  canonicalInstructions = null,
  projectionMetadata = null,
  classifyProjection = null,
  registry = INSTRUCTION_PROJECTIONS,
} = {}) {
  const presentation = classifyInstructionProjectionForIde({
    path,
    projectionMetadata,
    classifyProjection,
    registry,
  });
  const content = String(userContent ?? '');
  if (!presentation.isInstructionProjection) {
    return Object.freeze({ ...presentation, content, mergedManagedBlock: false });
  }

  const block = canonicalBlockForIdeWrite({ canonicalBlock, canonicalInstructions, userContent: content });
  return Object.freeze({
    ...presentation,
    content: mergeVectantBlock(content, block),
    mergedManagedBlock: true,
  });
}

module.exports = {
  canonicalBlockForIdeWrite,
  classifyInstructionProjectionForIde,
  filterInstructionProjectionsFromIdeTree,
  mergeInstructionProjectionWriteFromIde,
  projectionStateForPath,
  readInstructionProjectionForIde,
};
