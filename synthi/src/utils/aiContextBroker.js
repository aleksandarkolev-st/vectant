import { AI_COMPLETION_MAX_INPUT_CHARS } from '@/lib/completion';
import { buildCompletionReferences } from '@/utils/completionContext';

export const CONTEXT_SIDE_CHARS = 1600;
export const MAX_EDGE_LINES = 60;
export const MAX_SELECTION_CHARS = 1200;

export const takeLastChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return value.slice(value.length - max);
};

export const takeFirstChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return value.slice(0, max);
};

export const clampSelection = (text = '') => {
  if (typeof text !== 'string' || !text.trim()) return '';
  if (text.length <= MAX_SELECTION_CHARS) return text;
  return text.slice(-MAX_SELECTION_CHARS);
};

export const trimContextAroundCursor = (code, cursorPosition = null) => {
  if (!code) return '';
  if (code.length <= AI_COMPLETION_MAX_INPUT_CHARS) return code;
  if (!cursorPosition) return code.slice(-AI_COMPLETION_MAX_INPUT_CHARS);

  const lines = code.split(/\r?\n/);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lineIndex = clamp((cursorPosition.lineNumber || 1) - 1, 0, lines.length - 1);
  const columnIndex = clamp((cursorPosition.column || 1) - 1, 0, lines[lineIndex]?.length ?? 0);

  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  offset += columnIndex;

  const halfWindow = Math.floor(AI_COMPLETION_MAX_INPUT_CHARS / 2);
  let start = Math.max(0, offset - halfWindow);
  let end = Math.min(code.length, start + AI_COMPLETION_MAX_INPUT_CHARS);
  if ((end - start) < AI_COMPLETION_MAX_INPUT_CHARS) {
    start = Math.max(0, end - AI_COMPLETION_MAX_INPUT_CHARS);
  }

  const beforeBreak = code.lastIndexOf('\n', start - 1);
  if (beforeBreak !== -1) start = beforeBreak + 1;
  const afterBreak = code.indexOf('\n', end);
  if (afterBreak !== -1 && afterBreak > end) end = afterBreak;

  return code.slice(start, end);
};

export const buildEdgePreview = (lines = [], count = MAX_EDGE_LINES) => {
  if (!Array.isArray(lines) || !lines.length) return { head: '', tail: '' };
  const safeCount = Math.max(1, count);
  return {
    head: lines.slice(0, safeCount).join('\n'),
    tail: lines.slice(-safeCount).join('\n'),
  };
};

const getOffsetAtCursor = ({ model, fullDocument, cursorPosition }) => {
  if (model && cursorPosition) {
    try {
      return model.getOffsetAt(cursorPosition);
    } catch (_) {
      return fullDocument.length;
    }
  }
  return fullDocument.length;
};

const normalizeCacheEntries = (cacheEntries) => {
  if (!cacheEntries) return [];
  return Array.isArray(cacheEntries) ? cacheEntries : Array.from(cacheEntries);
};

export const buildAutocompleteContextPacket = ({
  activeFile,
  activeLanguage,
  breadcrumb,
  rawContext,
  fallbackCode = '',
  editorInstance,
  cursorPosition,
  workspaceSlug = null,
  getFileCacheEntries,
  recentEdits = [],
}) => {
  const activePath = activeFile?.path || activeFile?.name || null;
  const sourceDocument = typeof rawContext === 'string'
    ? rawContext
    : (editorInstance?.getValue?.() ?? fallbackCode ?? '');
  const context = trimContextAroundCursor(sourceDocument, cursorPosition);
  const model = editorInstance?.getModel?.() || null;
  const fullDocument = typeof rawContext === 'string'
    ? rawContext
    : (model?.getValue?.() ?? sourceDocument);
  const cursorOffset = getOffsetAtCursor({ model, fullDocument, cursorPosition });
  const beforeCursor = takeLastChars(fullDocument.slice(0, cursorOffset));
  const afterCursor = takeFirstChars(fullDocument.slice(cursorOffset));

  let selectedText = '';
  try {
    const selectionRange = editorInstance?.getSelection?.();
    if (selectionRange && !selectionRange.isEmpty?.() && model) {
      selectedText = clampSelection(model.getValueInRange(selectionRange));
    }
  } catch (_) {
    selectedText = '';
  }

  let fileHeader = '';
  let fileTail = '';
  try {
    if (model?.getLinesContent) {
      const edges = buildEdgePreview(model.getLinesContent(), MAX_EDGE_LINES);
      fileHeader = takeFirstChars(edges.head, CONTEXT_SIDE_CHARS);
      fileTail = takeLastChars(edges.tail, CONTEXT_SIDE_CHARS);
    }
  } catch (_) {
    fileHeader = '';
    fileTail = '';
  }

  let references = [];
  try {
    const cacheEntries = typeof getFileCacheEntries === 'function'
      ? getFileCacheEntries()
      : [];
    references = buildCompletionReferences({
      prefix: beforeCursor,
      language: activeLanguage,
      activePath,
      cacheEntries,
      recentEdits,
    });
  } catch (_) {
    references = [];
  }

  return {
    activePath,
    context,
    beforeCursor,
    afterCursor,
    references,
    payload: {
      code: context,
      language: activeLanguage,
      workspaceSlug: workspaceSlug || null,
      cursor: cursorPosition ? { line: cursorPosition.lineNumber, column: cursorPosition.column } : null,
      contextBlocks: {
        beforeCursor,
        afterCursor,
        selection: selectedText || null,
        filePath: activePath,
        breadcrumbs: breadcrumb || null,
        languageHint: activeLanguage,
        fileHeader: fileHeader || null,
        fileTail: fileTail || null,
      },
    },
  };
};

export const buildNepContextPacket = ({
  activePath,
  activeContent,
  cacheEntries,
}) => {
  const files = {};
  if (activePath && typeof activeContent === 'string') {
    files[activePath] = activeContent;
  }
  for (const [path, content] of normalizeCacheEntries(cacheEntries)) {
    if (!path || typeof content !== 'string') continue;
    if (path === activePath) continue;
    files[path] = content;
  }
  return { files };
};
