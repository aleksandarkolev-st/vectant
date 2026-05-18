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

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const CODE_SCOPE_RE = /^\s*(?:(?:export|pub|private|protected|public|static|async|virtual|inline|constexpr)\s+)*(?:class|struct|enum|interface|type|function|fn|def|impl|trait|namespace)\s+[A-Za-z_][A-Za-z0-9_:<>.]*/;

export const extractContextIdentifiers = (text, limit = 16) => {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const out = [];
  IDENT_RE.lastIndex = 0;
  let match;
  while ((match = IDENT_RE.exec(text))) {
    const ident = match[0];
    if (seen.has(ident)) continue;
    seen.add(ident);
    out.push(ident);
    if (out.length >= limit) break;
  }
  return out;
};

const findEnclosingScope = ({ fullDocument, cursorOffset, maxLines = 120 }) => {
  if (typeof fullDocument !== 'string' || !fullDocument) return [];
  const before = fullDocument.slice(0, Math.max(0, cursorOffset));
  const lines = before.split(/\r?\n/);
  const start = Math.max(0, lines.length - maxLines);
  const scopes = [];
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i] || '';
    if (!CODE_SCOPE_RE.test(line)) continue;
    scopes.unshift({ line: i + 1, text: line.trim() });
    if (scopes.length >= 4) break;
  }
  return scopes;
};

const collectNearbyDiagnostics = ({ monacoInstance, model, cursorPosition, radius = 20 }) => {
  if (!monacoInstance?.editor?.getModelMarkers || !model?.uri || !cursorPosition) return [];
  try {
    const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri }) || [];
    const cursorLine = cursorPosition.lineNumber || 1;
    return markers
      .filter((marker) => Math.abs((marker.startLineNumber || 1) - cursorLine) <= radius)
      .slice(0, 8)
      .map((marker) => ({
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity: marker.severity,
        message: marker.message,
      }));
  } catch (_) {
    return [];
  }
};

const pathDir = (path) => {
  if (!path || !path.includes('/')) return '';
  return path.slice(0, path.lastIndexOf('/'));
};

const pathExt = (path) => {
  const file = (path || '').split('/').pop() || '';
  const idx = file.lastIndexOf('.');
  return idx >= 0 ? file.slice(idx + 1).toLowerCase() : '';
};

const countIdentifierHits = (content, identifiers) => {
  if (!content || !identifiers.length) return 0;
  let hits = 0;
  for (const ident of identifiers) {
    if (content.includes(ident)) hits += 1;
  }
  return hits;
};

export const buildAutocompleteContextPacket = ({
  activeFile,
  activeLanguage,
  breadcrumb,
  rawContext,
  fallbackCode = '',
  editorInstance,
  monacoInstance = null,
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
  const enclosingScopes = findEnclosingScope({ fullDocument, cursorOffset });
  const nearbyDiagnostics = collectNearbyDiagnostics({ monacoInstance, model, cursorPosition });

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
        codeIntel: {
          enclosingScopes,
          nearbyDiagnostics,
          cursorIdentifiers: extractContextIdentifiers(beforeCursor.slice(-600), 8),
        },
      },
    },
  };
};

export const buildNepContextPacket = ({
  activePath,
  activeContent,
  cacheEntries,
  recentEdits = [],
  maxFiles = 16,
}) => {
  const files = {};
  if (activePath && typeof activeContent === 'string') {
    files[activePath] = activeContent;
  }

  const recentPaths = new Set((recentEdits || []).map((entry) => entry?.path).filter(Boolean));
  const editText = (recentEdits || [])
    .map((entry) => [
      entry?.snippet,
      entry?.searchText,
      entry?.replaceText,
      entry?.insertedText,
    ].filter(Boolean).join('\n'))
    .join('\n');
  const touchedIdentifiers = extractContextIdentifiers(editText, 24);
  const activeDir = pathDir(activePath);
  const activeExt = pathExt(activePath);

  const ranked = [];
  for (const [path, content] of normalizeCacheEntries(cacheEntries)) {
    if (!path || typeof content !== 'string') continue;
    if (path === activePath) continue;
    let score = 0;
    if (recentPaths.has(path)) score += 30;
    if (pathDir(path) === activeDir) score += 12;
    if (pathExt(path) === activeExt) score += 4;
    score += countIdentifierHits(content, touchedIdentifiers) * 6;
    if (score <= 0 && ranked.length >= maxFiles) continue;
    ranked.push({ path, content, score });
  }

  ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles)
    .forEach(({ path, content }) => {
      files[path] = content;
    });

  return {
    files,
    codeIntel: {
      touchedIdentifiers,
      rankedFilePaths: ranked.slice(0, maxFiles).map(({ path, score }) => ({ path, score })),
      activeDir,
      activeExt,
    },
  };
};

export const renderCodeIntelHints = (codeIntel = {}) => {
  const lines = [];
  if (Array.isArray(codeIntel.enclosingScopes) && codeIntel.enclosingScopes.length) {
    lines.push('Enclosing scopes:');
    for (const scope of codeIntel.enclosingScopes) {
      lines.push(`- L${scope.line}: ${scope.text}`);
    }
  }
  if (Array.isArray(codeIntel.nearbyDiagnostics) && codeIntel.nearbyDiagnostics.length) {
    lines.push('Nearby diagnostics:');
    for (const diagnostic of codeIntel.nearbyDiagnostics) {
      lines.push(`- L${diagnostic.line}: ${diagnostic.message}`);
    }
  }
  if (Array.isArray(codeIntel.cursorIdentifiers) && codeIntel.cursorIdentifiers.length) {
    lines.push(`Cursor identifiers: ${codeIntel.cursorIdentifiers.join(', ')}`);
  }
  if (Array.isArray(codeIntel.touchedIdentifiers) && codeIntel.touchedIdentifiers.length) {
    lines.push(`Touched identifiers: ${codeIntel.touchedIdentifiers.join(', ')}`);
  }
  if (Array.isArray(codeIntel.rankedFilePaths) && codeIntel.rankedFilePaths.length) {
    lines.push('Ranked context files:');
    for (const file of codeIntel.rankedFilePaths.slice(0, 8)) {
      lines.push(`- ${file.path} score=${file.score}`);
    }
  }
  return lines.join('\n');
};
