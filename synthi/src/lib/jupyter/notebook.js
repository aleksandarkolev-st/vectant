const MAX_NOTEBOOK_BYTES = 25 * 1024 * 1024;
const MAX_CELL_SOURCE = 512 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export class NotebookValidationError extends Error {
  constructor(message, code = 'invalid_notebook') { super(message); this.code = code; }
}

export function sha256(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

export function parseNotebook(raw) {
  if (typeof raw !== 'string') throw new NotebookValidationError('Notebook content must be text');
  if (raw.length > MAX_NOTEBOOK_BYTES) throw new NotebookValidationError('Notebook exceeds the 25 MiB limit', 'notebook_too_large');
  let notebook;
  try { notebook = JSON.parse(raw); } catch { throw new NotebookValidationError('Notebook JSON is malformed'); }
  return normalizeNotebook(notebook);
}

export function normalizeNotebook(notebook) {
  if (!notebook || typeof notebook !== 'object' || Array.isArray(notebook)) throw new NotebookValidationError('Notebook must be an object');
  if (!Number.isInteger(notebook.nbformat) || notebook.nbformat < 3) throw new NotebookValidationError('Unsupported notebook format');
  if (!Array.isArray(notebook.cells)) throw new NotebookValidationError('Notebook cells must be an array');
  const cells = notebook.cells.map((cell, index) => normalizeCell(cell, index));
  return { ...notebook, cells, metadata: isObject(notebook.metadata) ? notebook.metadata : {} };
}

function normalizeCell(cell, index) {
  if (!isObject(cell) || !['code', 'markdown', 'raw'].includes(cell.cell_type)) throw new NotebookValidationError(`Cell ${index + 1} has an unsupported type`);
  const source = toText(cell.source);
  if (source.length > MAX_CELL_SOURCE) throw new NotebookValidationError(`Cell ${index + 1} is too large`, 'cell_too_large');
  const normalized = { ...cell, id: typeof cell.id === 'string' && cell.id ? cell.id : `vectant-${index}-${sha256(source)}`, source, metadata: isObject(cell.metadata) ? cell.metadata : {} };
  if (cell.cell_type === 'code') normalized.outputs = Array.isArray(cell.outputs) ? cell.outputs.map(normalizeOutput) : [];
  return normalized;
}

function normalizeOutput(output) {
  if (!isObject(output)) return { output_type: 'error', ename: 'InvalidOutput', evalue: 'Malformed output omitted', traceback: [] };
  const copy = { ...output };
  if (isObject(copy.data)) {
    copy.data = Object.fromEntries(Object.entries(copy.data).map(([mime, data]) => [mime, truncateData(data)]));
  }
  copy.text = truncateData(copy.text);
  copy.traceback = Array.isArray(copy.traceback) ? copy.traceback.map((line) => String(line).slice(0, 16_384)) : [];
  return copy;
}
function truncateData(value) { const text = toText(value); return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[output truncated]` : text; }
function toText(value) { return Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : value == null ? '' : String(value); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function serializeNotebook(notebook, space = 1) { return `${JSON.stringify(normalizeNotebook(notebook), null, space)}\n`; }
export function revisionOf(raw) { return { hash: sha256(raw), bytes: new TextEncoder().encode(raw).byteLength }; }

