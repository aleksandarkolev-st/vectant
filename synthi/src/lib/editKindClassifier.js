// Edit-kind classifier — Phase 2.
//
// Runs client-side on an APPLIED edit (not on a prediction): given a SEARCH
// text and its REPLACE text, classify the change into one of five kinds.
// The kind drives different impact-graph queries on the backend (rename →
// pull all call sites; signature_change → pull all callers + override sites;
// import_change → pull all files that import the same module; etc).
//
// Heuristic by design (Plan Q3): build the eval set first, switch to a
// classifier model only if the heuristic falls below 85% on labeled data.
// Five-way classification on a structured input (a diff) — heuristics on
// structured inputs almost always beat small models on this kind of task.

export const EDIT_KIND = Object.freeze({
  RENAME: 'rename',
  SIGNATURE_CHANGE: 'signature_change',
  IMPORT_CHANGE: 'import_change',
  TYPE_CHANGE: 'type_change',
  LOCAL_LOGIC: 'local_logic',
});

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const IMPORT_LINE_RE = /^\s*(?:import\b|from\b|#include\b|require\(|use\b|using\b)/m;
const SIGNATURE_RE = /\b(?:function|def|fn|func|public|private|protected|static)\b[^=]*\([^)]*\)/;
const PARAM_LIST_RE = /\(([^)]*)\)/;
const TYPE_ANNOTATION_RE = /:\s*[A-Za-z_][A-Za-z0-9_<>,\s|&[\]]*\b/;
const DECLARATION_RE = /^\s*(?:const|let|var|int|float|double|long|short|char|bool|string|auto|void|String|Number|Boolean)\b/m;

const tokens = (s) => {
  const out = [];
  if (!s) return out;
  let m;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(s))) out.push(m[0]);
  return out;
};

const setOf = (arr) => new Set(arr);
const diff = (a, b) => {
  const sb = setOf(b);
  return [...a].filter((x) => !sb.has(x));
};

const stripWs = (s) => s.replace(/\s+/g, '');

/**
 * Classify an applied edit. Returns `{ kind, confidence, signals }` — confidence
 * is 0..1 and is informational. The heuristic doesn't hard-fail when
 * confidence is low; it still emits a kind, and the caller decides whether to
 * trust it for impact-graph routing (low confidence → fall back to
 * default-depth BFS, which is already conservative).
 */
export const classifyEdit = ({ search, replace, path } = {}) => {
  if (typeof search !== 'string' || typeof replace !== 'string' || !search) {
    return { kind: EDIT_KIND.LOCAL_LOGIC, confidence: 0, signals: ['empty_input'] };
  }

  const signals = [];

  // 1. Import change. Either side touches an import-shaped line. This is
  // checked first because import-changes can also look like type-changes
  // (moving a type import) or local_logic (adding a using directive); all
  // those cases want the import-change impact path.
  if (IMPORT_LINE_RE.test(search) || IMPORT_LINE_RE.test(replace)) {
    signals.push('import_keyword');
    return { kind: EDIT_KIND.IMPORT_CHANGE, confidence: 0.9, signals };
  }

  const sToks = tokens(search);
  const rToks = tokens(replace);
  const removed = diff(sToks, rToks);
  const added = diff(rToks, sToks);

  // 2. Rename. The shape is: search and replace are identical EXCEPT for
  // exactly one identifier that swapped one→one. We test by replacing every
  // word-boundary occurrence of the dropped token with the new token in the
  // search and seeing whether (modulo whitespace) the result equals replace.
  if (removed.length === 1 && added.length === 1) {
    const old = removed[0];
    const neu = added[0];
    const re = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const projected = search.replace(re, neu);
    if (stripWs(projected) === stripWs(replace)) {
      signals.push(`rename:${old}->${neu}`);
      return { kind: EDIT_KIND.RENAME, confidence: 0.95, signals };
    }
  }

  // 3. Signature change. Both sides look like function signatures and the
  // parameter list differs (or the return-type prefix differs). This is the
  // "added/removed/typed a parameter" case — drives a callers-pull on the
  // impact graph.
  if (SIGNATURE_RE.test(search) || SIGNATURE_RE.test(replace)) {
    const ms = search.match(PARAM_LIST_RE);
    const mr = replace.match(PARAM_LIST_RE);
    const sParams = ms ? ms[1].trim() : null;
    const rParams = mr ? mr[1].trim() : null;
    if (sParams !== null && rParams !== null && sParams !== rParams) {
      signals.push('param_list_differs');
      return { kind: EDIT_KIND.SIGNATURE_CHANGE, confidence: 0.85, signals };
    }
    const sPrefix = ms ? search.slice(0, search.indexOf(ms[0])).trim() : '';
    const rPrefix = mr ? replace.slice(0, replace.indexOf(mr[0])).trim() : '';
    if (sPrefix !== rPrefix) {
      signals.push('signature_prefix_differs');
      return { kind: EDIT_KIND.SIGNATURE_CHANGE, confidence: 0.75, signals };
    }
  }

  // 4. Type change. A type annotation (`: T`) or a typed declaration
  // (`int x`, `const x: T`) was modified. This is the weakest of the
  // structural checks — a lot of real "type changes" are actually
  // signature-changes, so we only land here when neither (1) nor (3) fires.
  if (TYPE_ANNOTATION_RE.test(search) && TYPE_ANNOTATION_RE.test(replace)) {
    const sType = (search.match(TYPE_ANNOTATION_RE) || [''])[0];
    const rType = (replace.match(TYPE_ANNOTATION_RE) || [''])[0];
    if (sType !== rType) {
      signals.push('type_annotation_differs');
      return { kind: EDIT_KIND.TYPE_CHANGE, confidence: 0.7, signals };
    }
  }
  if (DECLARATION_RE.test(search) && DECLARATION_RE.test(replace)) {
    const sDecl = (search.match(DECLARATION_RE) || [''])[0].trim();
    const rDecl = (replace.match(DECLARATION_RE) || [''])[0].trim();
    if (sDecl !== rDecl) {
      signals.push('declaration_keyword_differs');
      return { kind: EDIT_KIND.TYPE_CHANGE, confidence: 0.65, signals };
    }
  }

  // 5. Default: local_logic. Anything else — body changes, condition
  // tweaks, refactors that don't fit the above buckets. Impact graph
  // gets a depth-1 query rather than depth-2, since local-logic edits
  // don't usually propagate.
  signals.push('default_local_logic');
  return { kind: EDIT_KIND.LOCAL_LOGIC, confidence: 0.5, signals };
};

/**
 * Extract candidate identifiers the impact-graph query should seed from.
 * Renames and signature-changes seed from the OLD name (the thing that's
 * being changed); local_logic seeds from any identifier in the SEARCH;
 * import_change seeds from the imported module path.
 */
export const seedSymbolsForEdit = ({ kind, search, replace }) => {
  if (kind === EDIT_KIND.RENAME) {
    const sToks = tokens(search);
    const rToks = tokens(replace);
    const removed = diff(sToks, rToks);
    return removed.length === 1 ? [removed[0]] : sToks.slice(0, 3);
  }
  if (kind === EDIT_KIND.SIGNATURE_CHANGE) {
    const m = search.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    return m ? [m[1]] : tokens(search).slice(0, 3);
  }
  if (kind === EDIT_KIND.IMPORT_CHANGE) {
    const quoted = search.match(/['"]([^'"]+)['"]/) || replace.match(/['"]([^'"]+)['"]/);
    if (quoted) return [quoted[1]];
    return tokens(search);
  }
  return tokens(search).slice(0, 3);
};
