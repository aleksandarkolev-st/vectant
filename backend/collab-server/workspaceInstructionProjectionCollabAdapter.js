'use strict';

/**
 * Presentation boundary for the collab HTTP API.  The terminal filesystem is
 * allowed to contain a passive managed block; the IDE never needs to retain or
 * display it.  Keeping this small adapter free of HTTP and Git makes each
 * caller opt in explicitly and keeps unmanaged files byte-for-byte untouched.
 */

const {
  filterInstructionProjectionsFromIdeTree,
  mergeInstructionProjectionWriteFromIde,
  readInstructionProjectionForIde,
} = require('./workspaceInstructionIdePresentation');

const IDE_PROJECTION_ACTIONS = Object.freeze(new Set([
  'files',
  'files-meta',
  'file',
  'write-file',
  'write-files-batch',
  'sync',
]));

function shouldReconcileInstructionProjection(action) {
  return IDE_PROJECTION_ACTIONS.has(String(action || ''));
}

function metadataFromProjectionResult(result) {
  if (!result || result.skipped || !Array.isArray(result.projections)) return null;
  return {
    projections: Object.fromEntries(result.projections.map((projection) => [projection.path, {
      ownership: projection.ownership,
      // A projection the service skipped (e.g. a symlinked target) is not a
      // managed document: it must not be hidden from the tree, stripped, or
      // have the managed block merged into an IDE write.
      external: Boolean(projection.skipped || projection.external),
    }])),
  };
}

function presentFileTreeForIde(files, projectionResult) {
  if (!projectionResult || projectionResult.skipped) return files;
  if (!Array.isArray(files)) return files;
  const wrapped = files.map((entry) => typeof entry === 'string' ? { path: entry, entry } : entry);
  const filtered = filterInstructionProjectionsFromIdeTree(wrapped, {
    projectionMetadata: metadataFromProjectionResult(projectionResult),
  });
  return filtered.map((entry) => Object.prototype.hasOwnProperty.call(entry || {}, 'entry') ? entry.entry : entry);
}

function presentFileContentForIde({ path, physicalContent, projectionResult }) {
  if (!projectionResult || projectionResult.skipped) return String(physicalContent ?? '');
  return readInstructionProjectionForIde({ path, physicalContent }).content;
}

function prepareFileContentForIdeWrite({ path, userContent, projectionResult }) {
  if (!projectionResult || projectionResult.skipped) return String(userContent ?? '');
  if (!projectionResult.canonicalBlock) {
    throw new Error('workspace_instruction_projection_canonical_block_unavailable');
  }
  return mergeInstructionProjectionWriteFromIde({
    path,
    userContent,
    canonicalBlock: projectionResult.canonicalBlock,
    projectionMetadata: metadataFromProjectionResult(projectionResult),
  }).content;
}

module.exports = {
  IDE_PROJECTION_ACTIONS,
  metadataFromProjectionResult,
  prepareFileContentForIdeWrite,
  presentFileContentForIde,
  presentFileTreeForIde,
  shouldReconcileInstructionProjection,
};
