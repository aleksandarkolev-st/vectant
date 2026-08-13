'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * The complete passive-instruction convention registry.  Adding a convention
 * is data-only: callers use the returned paths without branching on an agent
 * name or runtime.
 */
const INSTRUCTION_PROJECTIONS = Object.freeze([
  Object.freeze({ path: 'AGENTS.md', enabled: true }),
  Object.freeze({ path: 'CLAUDE.md', enabled: true }),
  Object.freeze({ path: 'GEMINI.md', enabled: true }),
]);

const VECTANT_MANAGED_INSTRUCTIONS_BEGIN = '<!-- Vectant_MANAGED_INSTRUCTIONS_BEGIN';
const VECTANT_MANAGED_INSTRUCTIONS_END = '<!-- Vectant_MANAGED_INSTRUCTIONS_END -->';
const INSTRUCTION_SET_ID_KEY = 'Vectant_INSTRUCTION_SET_ID';
const USER_CONTENT_SEPARATOR_KEY = 'user-content-separator-lines';
const DUPLICATE_INSTRUCTION_NOTICE = 'If this same Vectant instruction-set ID appears in another instruction file, treat the duplicate as the same instruction set, not additional instructions.';

function normalizeProjectionPath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('instruction_projection_path_required');
  }

  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/')
    || path.posix.isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError('instruction_projection_path_invalid');
  }
  return normalized;
}

/**
 * Validate a declarative projection list once at its boundary.  The returned
 * values are immutable so later workspace operations cannot accidentally
 * mutate the global convention registry.
 */
function createInstructionProjectionRegistry(entries = INSTRUCTION_PROJECTIONS) {
  if (!Array.isArray(entries)) {
    throw new TypeError('instruction_projection_registry_array_required');
  }

  const seenPaths = new Set();
  return Object.freeze(entries.map((entry) => {
    const projectionPath = normalizeProjectionPath(entry?.path);
    const comparablePath = projectionPath.toLocaleLowerCase('en-US');
    if (seenPaths.has(comparablePath)) {
      throw new TypeError('instruction_projection_path_duplicate');
    }
    seenPaths.add(comparablePath);
    return Object.freeze({
      path: projectionPath,
      enabled: entry?.enabled !== false,
    });
  }));
}

function getEnabledInstructionProjections(entries = INSTRUCTION_PROJECTIONS) {
  return createInstructionProjectionRegistry(entries).filter((entry) => entry.enabled);
}

function isInstructionProjectionPath(candidatePath, entries = INSTRUCTION_PROJECTIONS) {
  let normalizedCandidate;
  try {
    normalizedCandidate = normalizeProjectionPath(candidatePath);
  } catch {
    return false;
  }
  return getEnabledInstructionProjections(entries)
    .some((entry) => entry.path === normalizedCandidate);
}

function detectLineEnding(value) {
  return String(value || '').includes('\r\n') ? '\r\n' : '\n';
}

function normalizeLineEndings(value, lineEnding) {
  return String(value || '').replace(/\r\n|\r|\n/g, lineEnding);
}

function requireInstructionField(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new TypeError(`vectant_instruction_${fieldName}_required`);
  }
  return normalized;
}

function instructionHash(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function normalizeSeparatorLines(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 8 ? parsed : 0;
}

/**
 * Builds the one canonical managed block. `content` is deliberately supplied
 * by the workspace metadata layer; this parser never owns workspace policy.
 */
function buildVectantBlock(instructions, options = {}) {
  if (!instructions || typeof instructions !== 'object') {
    throw new TypeError('vectant_instructions_required');
  }

  const workspaceId = requireInstructionField(instructions.workspaceId, 'workspace_id');
  const version = requireInstructionField(instructions.version, 'version');
  const content = String(instructions.content ?? '');
  const lineEnding = options.lineEnding === '\r\n' ? '\r\n' : '\n';
  const normalizedContent = normalizeLineEndings(content, lineEnding);
  const hash = requireInstructionField(instructions.hash || instructionHash(normalizedContent), 'hash');
  const instructionSetId = requireInstructionField(
    instructions.instructionSetId || `${workspaceId}:v${version}`,
    'set_id',
  );
  const separatorLines = normalizeSeparatorLines(options.userContentSeparatorLines);

  return [
    VECTANT_MANAGED_INSTRUCTIONS_BEGIN,
    `id: ${workspaceId}`,
    `version: ${version}`,
    `hash: ${hash}`,
    `${INSTRUCTION_SET_ID_KEY}=${instructionSetId}`,
    `${USER_CONTENT_SEPARATOR_KEY}: ${separatorLines}`,
    '-->',
    '',
    'Vectant workspace instructions:',
    '',
    normalizedContent,
    '',
    DUPLICATE_INSTRUCTION_NOTICE,
    '',
    VECTANT_MANAGED_INSTRUCTIONS_END,
  ].join(lineEnding);
}

function readHeaderValue(header, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|\\r?\\n)${escapedKey}:\\s*([^\\r\\n]+)`));
  return match ? match[1].trim() : null;
}

function readAssignmentValue(header, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|\\r?\\n)${escapedKey}=([^\\r\\n]+)`));
  return match ? match[1].trim() : null;
}

function isLineStart(content, offset) {
  return offset === 0 || content[offset - 1] === '\n';
}

function nextLineStartMatch(content, needle, offset) {
  let index = content.indexOf(needle, offset);
  while (index >= 0 && !isLineStart(content, index)) {
    index = content.indexOf(needle, index + needle.length);
  }
  return index;
}

function extractPayload(blockText, headerEndOffset, endOffset, lineEnding) {
  const bodyStart = headerEndOffset + 3;
  let body = blockText.slice(bodyStart, endOffset);
  const prefix = `${lineEnding}${lineEnding}Vectant workspace instructions:${lineEnding}${lineEnding}`;
  const suffix = `${lineEnding}${lineEnding}${DUPLICATE_INSTRUCTION_NOTICE}${lineEnding}${lineEnding}`;
  if (body.startsWith(prefix) && body.endsWith(suffix)) {
    return body.slice(prefix.length, -suffix.length);
  }
  return body;
}

/**
 * Locates only complete, well-formed Vectant blocks. Incomplete or ambiguous
 * marker sequences remain user content, which is the conservative recovery
 * behavior required after a partial terminal edit or crash.
 */
function extractVectantBlocks(content) {
  const raw = String(content ?? '');
  const blocks = [];
  let searchOffset = 0;

  while (searchOffset < raw.length) {
    const start = nextLineStartMatch(raw, VECTANT_MANAGED_INSTRUCTIONS_BEGIN, searchOffset);
    if (start < 0) break;

    const headerEnd = raw.indexOf('-->', start + VECTANT_MANAGED_INSTRUCTIONS_BEGIN.length);
    if (headerEnd < 0) break;
    const header = raw.slice(start + VECTANT_MANAGED_INSTRUCTIONS_BEGIN.length, headerEnd);
    const nextBegin = nextLineStartMatch(raw, VECTANT_MANAGED_INSTRUCTIONS_BEGIN, headerEnd + 3);
    const end = nextLineStartMatch(raw, VECTANT_MANAGED_INSTRUCTIONS_END, headerEnd + 3);
    if (end < 0) {
      searchOffset = headerEnd + 3;
      continue;
    }
    if (nextBegin >= 0 && nextBegin < end) {
      // An unclosed marker cannot own a later complete block.
      searchOffset = nextBegin;
      continue;
    }

    const workspaceId = readHeaderValue(header, 'id');
    const version = readHeaderValue(header, 'version');
    const hash = readHeaderValue(header, 'hash');
    if (!workspaceId || !version || !hash) {
      searchOffset = headerEnd + 3;
      continue;
    }

    const blockEnd = end + VECTANT_MANAGED_INSTRUCTIONS_END.length;
    const rawBlock = raw.slice(start, blockEnd);
    const lineEnding = detectLineEnding(rawBlock);
    blocks.push(Object.freeze({
      raw: rawBlock,
      start,
      end: blockEnd,
      header,
      workspaceId,
      version,
      hash,
      instructionSetId: readAssignmentValue(header, INSTRUCTION_SET_ID_KEY) || `${workspaceId}:v${version}`,
      userContentSeparatorLines: normalizeSeparatorLines(readHeaderValue(header, USER_CONTENT_SEPARATOR_KEY)),
      content: extractPayload(raw, headerEnd, end, lineEnding),
      lineEnding,
    }));
    searchOffset = blockEnd;
  }

  return Object.freeze(blocks);
}

function extractVectantBlock(content) {
  return extractVectantBlocks(content)[0] || null;
}

function separatorBeforeBlock(raw, block) {
  const count = block.userContentSeparatorLines;
  if (!count) return block.start;
  const separator = block.lineEnding.repeat(count);
  const separatorStart = block.start - separator.length;
  return separatorStart >= 0 && raw.slice(separatorStart, block.start) === separator
    ? separatorStart
    : block.start;
}

/** Remove every complete Vectant block, including only its recorded separator. */
function stripVectantBlock(content) {
  const raw = String(content ?? '');
  const blocks = extractVectantBlocks(raw);
  if (!blocks.length) return raw;

  let result = raw;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    result = result.slice(0, separatorBeforeBlock(raw, block)) + result.slice(block.end);
  }
  return result;
}

function replaceSeparatorMetadata(block, separatorLines) {
  const parsed = extractVectantBlock(block);
  if (!parsed || parsed.start !== 0 || parsed.end !== String(block).length) {
    throw new TypeError('vectant_managed_block_required');
  }
  const replacement = `${USER_CONTENT_SEPARATOR_KEY}: ${normalizeSeparatorLines(separatorLines)}`;
  const marker = new RegExp(`(^|\\r?\\n)${USER_CONTENT_SEPARATOR_KEY}:\\s*[^\\r\\n]*`);
  if (marker.test(block)) return String(block).replace(marker, `$1${replacement}`);

  const headerClose = String(block).indexOf('-->');
  const lineEnding = parsed.lineEnding;
  return `${String(block).slice(0, headerClose)}${lineEnding}${replacement}${String(block).slice(headerClose)}`;
}

/**
 * Reconciliation primitive: preserve all non-managed bytes, collapse every
 * complete older Vectant block, then append exactly one current block.
 */
function mergeVectantBlock(userContent, block) {
  const rawUserContent = stripVectantBlock(userContent);
  const parsedBlock = extractVectantBlock(block);
  if (!parsedBlock || parsedBlock.start !== 0 || parsedBlock.end !== String(block).length) {
    throw new TypeError('vectant_managed_block_required');
  }
  if (!rawUserContent.length) {
    return replaceSeparatorMetadata(block, 0);
  }

  const lineEnding = detectLineEnding(rawUserContent);
  const normalizedBlock = normalizeLineEndings(block, lineEnding);
  return `${rawUserContent}${lineEnding.repeat(2)}${replaceSeparatorMetadata(normalizedBlock, 2)}`;
}

function containsUserContent(content) {
  return stripVectantBlock(content).trim().length > 0;
}

// `hasUserContent` is the ownership-oriented spelling used by lifecycle code.
// Keep `containsUserContent` as the explicit predicate for direct callers.
const hasUserContent = containsUserContent;

module.exports = {
  DUPLICATE_INSTRUCTION_NOTICE,
  INSTRUCTION_PROJECTIONS,
  INSTRUCTION_SET_ID_KEY,
  USER_CONTENT_SEPARATOR_KEY,
  VECTANT_MANAGED_INSTRUCTIONS_BEGIN,
  VECTANT_MANAGED_INSTRUCTIONS_END,
  buildVectantBlock,
  containsUserContent,
  createInstructionProjectionRegistry,
  detectLineEnding,
  extractVectantBlock,
  extractVectantBlocks,
  getEnabledInstructionProjections,
  hasUserContent,
  instructionHash,
  isInstructionProjectionPath,
  mergeVectantBlock,
  normalizeProjectionPath,
  stripVectantBlock,
};
