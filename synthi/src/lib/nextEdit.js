// Shared constants, stream parser, and validator for Next-Edit Prediction (NEP).
//
// Wire format is Aider-style search-replace (locked in `inline_completions_nep_plan.md`).
// Each block looks like:
//
//   {relative_path}
//   <<<<<<< SEARCH
//   {1–5 lines of existing code; must be unique in the file}
//   =======
//   {replacement text}
//   >>>>>>> REPLACE
//
// `SEARCH ALL` is reserved on day one to keep it out of telemetry once Phase 2
// adds fan-out. The parser recognises it; the validator rejects it with reason
// `phase2_required` so Phase 1 logs it but never executes.

export const API_NEXT_EDIT_ROUTE = '/api/next-edit';

// Block boundary the model MUST emit at the end of every replacement.
export const REPLACE_BOUNDARY = '>>>>>>> REPLACE';

// Tokens the prompt teaches the model to use.
export const SEARCH_OPEN_KEYWORD = '<<<<<<< SEARCH';
export const SEARCH_OPEN_ALL_KEYWORD = '<<<<<<< SEARCH ALL';
export const REPLACE_DIVIDER = '=======';

// Validator outcome reason codes. Keep stable — these are the keys telemetry
// aggregates against, and the kill-switch `validation_rejection_rate` is a
// breakdown of these. Adding a code is fine; renaming one is a migration.
export const REJECT_REASONS = Object.freeze({
  PARSE_ERROR: 'parse_error',
  NO_MATCH: 'no_match',
  AMBIGUOUS: 'ambiguous',
  PHASE2_REQUIRED: 'phase2_required',
  FILE_MISSING: 'file_missing',
  EMPTY_SEARCH: 'empty_search',
});

export const NEP_BLOCK_KIND = Object.freeze({
  SEARCH: 'SEARCH',
  SEARCH_ALL: 'SEARCH ALL',
});

// ──────────────────────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single complete block — text between the start of a `{path}` line and
 * the boundary `>>>>>>> REPLACE`. Returns `{ ok, block | reason }`.
 *
 * Tolerant of leading whitespace before the keyword tokens but strict about
 * payload bytes — every byte between the divider and the boundary is the
 * replacement, exactly as the model emitted it. The validator decides if the
 * SEARCH text matches the file; we don't try to "fix" anything here.
 */
export const parseBlock = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'empty_block' };
  }

  // The block starts with the relative path on a line by itself, followed by
  // the SEARCH keyword. We accept a few leading blank lines between the path
  // and the keyword — Gemini sometimes inserts them.
  const text = raw.replace(/^\s*\n+/, ''); // strip leading blank lines only
  const lines = text.split('\n');

  if (lines.length < 4) {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'too_short' };
  }

  const path = lines[0].trim();
  if (!path) {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'missing_path' };
  }

  // Find the SEARCH header. Anchor it to the second non-blank line so a stray
  // leading marker in the path field doesn't get parsed as the header.
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const headerLine = lines[i]?.trim() || '';

  let kind;
  if (headerLine === SEARCH_OPEN_ALL_KEYWORD) kind = NEP_BLOCK_KIND.SEARCH_ALL;
  else if (headerLine === SEARCH_OPEN_KEYWORD) kind = NEP_BLOCK_KIND.SEARCH;
  else {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'missing_search_header' };
  }

  // Walk forward to the divider. Everything between header and divider is the
  // SEARCH text — preserved BYTE FOR BYTE (no trim, no normalize).
  i += 1;
  const searchStart = i;
  while (i < lines.length && lines[i] !== REPLACE_DIVIDER) i++;
  if (i >= lines.length) {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'missing_divider' };
  }
  const searchText = lines.slice(searchStart, i).join('\n');

  // Walk forward to the boundary. Same byte-for-byte preservation.
  i += 1;
  const replaceStart = i;
  while (i < lines.length && lines[i] !== REPLACE_BOUNDARY) i++;
  if (i >= lines.length) {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'missing_boundary' };
  }
  const replaceText = lines.slice(replaceStart, i).join('\n');

  if (!searchText) {
    return { ok: false, reason: REJECT_REASONS.EMPTY_SEARCH, detail: 'empty_search' };
  }

  return { ok: true, block: { path, kind, search: searchText, replace: replaceText } };
};

/**
 * Stream parser that emits complete blocks as `>>>>>>> REPLACE` boundaries land
 * in the byte stream. Hold partial blocks until the boundary arrives — this is
 * what lets the UI show jump-hint dots progressively without waiting for the
 * model to finish the whole refactor chain.
 *
 * Usage:
 *   const parser = createStreamParser();
 *   for await (const chunk of stream) {
 *     for (const result of parser.feed(chunk)) {
 *       // result is { ok, block } or { ok: false, reason, detail, raw }
 *     }
 *   }
 *   for (const result of parser.flush()) { ... } // any tail
 */
export const createStreamParser = () => {
  let buffer = '';
  return {
    feed(chunk) {
      buffer += String(chunk ?? '');
      const out = [];
      // Split on the boundary. Everything up to and including the boundary is
      // a candidate block; the tail goes back into the buffer.
      while (true) {
        const idx = buffer.indexOf(REPLACE_BOUNDARY);
        if (idx === -1) break;
        const blockEnd = idx + REPLACE_BOUNDARY.length;
        const raw = buffer.slice(0, blockEnd);
        buffer = buffer.slice(blockEnd).replace(/^\r?\n/, '');
        const parsed = parseBlock(raw);
        out.push(parsed.ok ? parsed : { ...parsed, raw });
      }
      return out;
    },
    flush() {
      const tail = buffer;
      buffer = '';
      if (!tail.trim()) return [];
      // Tail without a closing boundary is a parse error, not a silent drop.
      // Surface it so telemetry can see the `parse_error` rate.
      const parsed = parseBlock(tail);
      return [parsed.ok ? parsed : { ...parsed, raw: tail }];
    },
    // Exposed for tests.
    _peek() { return buffer; },
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Validator (Section 2 of the plan)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Count exact substring matches of `search` in `content`. No whitespace
 * normalization — that's the central guarantee. Two visually-distinct lines
 * MUST not collapse into one.
 */
export const countExactMatches = (content, search) => {
  if (typeof content !== 'string' || typeof search !== 'string') return 0;
  if (!search) return 0;
  let n = 0;
  let from = 0;
  while (true) {
    const i = content.indexOf(search, from);
    if (i === -1) break;
    n += 1;
    // Step forward by 1 to count overlapping matches as separate. Aider's
    // SEARCH text is rarely a self-overlap but the matcher should not lie
    // about uniqueness when it happens.
    from = i + 1;
  }
  return n;
};

/**
 * Indent-tolerant fallback: line-by-line equality after stripping leading
 * spaces/tabs from each side. Trailing whitespace and interior structure
 * are still strict — we don't want to collapse two visually-distinct lines.
 *
 * Returns `{ ok: true, offset, length, fileText }` for a single hit, where
 * `offset`/`length` index into the original (un-normalized) `content` so
 * the caller can splice without re-searching, and `fileText` is the actual
 * file slice (preserved verbatim — it's the indent the user wrote, which
 * applyBlock uses to re-shift the model's REPLACE text). `{ ok: false,
 * matches }` when 0 or >1 matches.
 *
 * The model's most common SEARCH miss is "right text, wrong indent" — when
 * the user opened the file inside a class body and the model copied the
 * symbol declaration without the surrounding namespace's leading indent.
 * This recovery turns that from `no_match` into a clean apply.
 */
export const findIndentTolerantMatch = (content, search) => {
  if (typeof content !== 'string' || typeof search !== 'string') {
    return { ok: false, matches: 0 };
  }
  if (!search) return { ok: false, matches: 0 };
  // The exact path already covers \n=== text. Only fall back when we
  // genuinely have at least one non-whitespace line in SEARCH.
  if (!search.trim()) return { ok: false, matches: 0 };

  const stripIndent = (s) => s.replace(/^[ \t]+/, '');
  const searchLines = search.split('\n');
  const normSearch = searchLines.map(stripIndent);
  const contentLines = content.split('\n');
  if (searchLines.length > contentLines.length) return { ok: false, matches: 0 };

  // Pre-compute line start byte offsets so we can map (line index, col 0) → byte offset.
  const lineStarts = new Array(contentLines.length + 1);
  let acc = 0;
  for (let i = 0; i < contentLines.length; i++) {
    lineStarts[i] = acc;
    acc += contentLines[i].length + 1; // +1 for the newline
  }
  lineStarts[contentLines.length] = acc; // virtual EOF

  let count = 0;
  let firstHit = null;
  const last = contentLines.length - searchLines.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (stripIndent(contentLines[i + j]) !== normSearch[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    count += 1;
    if (firstHit === null) {
      const offset = lineStarts[i];
      let length = 0;
      for (let k = 0; k < searchLines.length; k++) {
        length += contentLines[i + k].length;
        if (k < searchLines.length - 1) length += 1; // newline between matched lines
      }
      const fileText = content.slice(offset, offset + length);
      firstHit = { offset, length, fileText };
    }
    if (count > 1) break; // ambiguous — early exit
  }

  if (count === 1) return { ok: true, ...firstHit, matches: 1 };
  return { ok: false, matches: count };
};

/**
 * When the indent-tolerant matcher finds a SEARCH whose first-line indent
 * differs from the file's, the REPLACE the model emitted carries the
 * model's indent, not the file's. Shift every REPLACE line by the delta so
 * the inserted text sits at the file's column instead of the model's.
 */
export const reindentReplace = (search, replace, fileMatchText) => {
  if (typeof search !== 'string' || typeof replace !== 'string'
      || typeof fileMatchText !== 'string') return replace;
  const m = (s) => (s.match(/^[ \t]*/) || [''])[0];
  const modelIndent = m(search.split('\n')[0] || '');
  const fileIndent = m(fileMatchText.split('\n')[0] || '');
  if (modelIndent === fileIndent) return replace;

  const replaceLines = replace.split('\n');
  const out = replaceLines.map((line) => {
    if (modelIndent && line.startsWith(modelIndent)) {
      return fileIndent + line.slice(modelIndent.length);
    }
    // Line is shallower than the model's base indent (e.g. closing brace
    // at col 0). Leave alone — re-shifting would corrupt the structure.
    return line;
  });
  return out.join('\n');
};

/**
 * Validate a parsed block against the current contents of the named file.
 *
 *   SEARCH:     N=0 → no_match     | N=1 → accept | N>1 → ambiguous
 *   SEARCH ALL: N=0 → no_match     | N>=1 → phase2_required (Phase 1 logs only)
 *
 * `getFileContent(path)` returns the file's current text or `null` if missing.
 * Returning `null` produces `file_missing` — a separate code from `no_match`
 * because the failure mode is different (model named a file we can't open vs.
 * SEARCH text not present in a file we did open).
 */
export const validateBlock = (block, getFileContent) => {
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: REJECT_REASONS.PARSE_ERROR, detail: 'no_block' };
  }
  const { path, kind, search } = block;
  if (!search) {
    return { ok: false, reason: REJECT_REASONS.EMPTY_SEARCH, detail: 'empty_search', path };
  }

  let content;
  try {
    content = getFileContent(path);
  } catch (_) {
    content = null;
  }
  if (typeof content !== 'string') {
    return { ok: false, reason: REJECT_REASONS.FILE_MISSING, path };
  }

  const n = countExactMatches(content, search);

  if (kind === NEP_BLOCK_KIND.SEARCH_ALL) {
    if (n === 0) return { ok: false, reason: REJECT_REASONS.NO_MATCH, path, matches: 0 };
    return { ok: false, reason: REJECT_REASONS.PHASE2_REQUIRED, path, matches: n };
  }

  // Default: SEARCH. Exact path first (the central guarantee — strict
  // byte match never produces a wrong location). Indent-tolerant fallback
  // only when exact gives nothing; ambiguous still rejects so we never
  // silently pick one of multiple visually-distinct matches.
  if (n === 1) return { ok: true, path, matches: 1 };
  if (n > 1) return { ok: false, reason: REJECT_REASONS.AMBIGUOUS, path, matches: n };

  const indentMatch = findIndentTolerantMatch(content, search);
  if (indentMatch.ok) {
    return {
      ok: true,
      path,
      matches: 1,
      // Surface the relaxed match so applyBlock/locateBlock skip the
      // re-search and so telemetry can split the success rate by tier.
      indentTolerant: true,
      offset: indentMatch.offset,
      length: indentMatch.length,
      fileText: indentMatch.fileText,
    };
  }
  if (indentMatch.matches > 1) {
    return { ok: false, reason: REJECT_REASONS.AMBIGUOUS, path, matches: indentMatch.matches };
  }
  return { ok: false, reason: REJECT_REASONS.NO_MATCH, path, matches: 0 };
};

/**
 * Apply a validated SEARCH block to a file's content. Returns the post-edit
 * content; throws if the block doesn't validate (caller should re-validate
 * right before apply — the file may have changed since stream-time validation).
 */
export const applyBlock = (block, getFileContent) => {
  const v = validateBlock(block, getFileContent);
  if (!v.ok) {
    const err = new Error(`apply rejected: ${v.reason}`);
    err.reason = v.reason;
    err.path = v.path;
    throw err;
  }
  const content = getFileContent(block.path);
  if (v.indentTolerant) {
    // Re-shift the model's REPLACE so it lands at the file's actual indent
    // column instead of the column the model hallucinated. Without this
    // step the inserted text would have mismatched indents against its
    // surroundings — visually correct text, structurally broken.
    const adjustedReplace = reindentReplace(block.search, block.replace, v.fileText);
    return content.slice(0, v.offset) + adjustedReplace + content.slice(v.offset + v.length);
  }
  const idx = content.indexOf(block.search);
  return content.slice(0, idx) + block.replace + content.slice(idx + block.search.length);
};

/**
 * Locate the (1-indexed) line number where the SEARCH text begins in a file.
 * Used to position the jump-hint gutter dot. Returns `null` when the SEARCH
 * is missing — the validator should already have rejected, but locate is a
 * pure read so it's safe to call independently.
 */
export const locateBlock = (block, getFileContent) => {
  const content = getFileContent(block.path);
  if (typeof content !== 'string') return null;
  let idx = content.indexOf(block.search);
  if (idx === -1) {
    // Fall back to the indent-tolerant path so the gutter dot still lands
    // at the right line when the model emitted a SEARCH whose only
    // disagreement with the file is leading whitespace.
    const indentMatch = findIndentTolerantMatch(content, block.search);
    if (!indentMatch.ok) return null;
    idx = indentMatch.offset;
  }
  // Line number = 1 + count of newlines before idx.
  let line = 1;
  for (let i = 0; i < idx; i++) if (content.charCodeAt(i) === 10) line += 1;
  return line;
};
