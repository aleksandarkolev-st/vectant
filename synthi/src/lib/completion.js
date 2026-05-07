// Shared constants and helpers for the AI code completion flow.
export const AI_COMPLETION_STOP_SEQUENCE = '<!-- ai-completion-stop -->';
// Generous ceiling. The model's actual delivered output is structurally
// capped client-side by truncateToFirstUnit (one unit, then stop), so this
// value matters mainly as a safety net against runaway streams. 256 used to
// truncate full-method predictions mid-body; 512 is comfortably above any
// single coherent unit we'd ever surface.
export const AI_COMPLETION_MAX_OUTPUT_TOKENS = 512;
// Limit context size to reduce latency without losing the local neighborhood.
export const AI_COMPLETION_MAX_INPUT_CHARS = 3500;
export const API_COMPLETION_ROUTE = '/api/completion';

export const COMPLETION_OPEN = '<|completion|>';
export const COMPLETION_CLOSE = '<|/completion|>';

/**
 * Strip the `<|completion|>...<|/completion|>` envelope when the model
 * uses it. Tolerates half-open / half-close output (the close marker is in
 * stopSequences, so it routinely truncates) and a couple of legacy fallbacks.
 *
 * Pure / side-effect free — used in both the API route and the client streamer.
 */
export const extractCompletion = (raw) => {
  if (!raw) return '';

  const tagged = raw.match(/<\|completion\|>([\s\S]*?)<\|\/completion\|>/);
  if (tagged) return tagged[1];

  const openIdx = raw.indexOf('<|completion|>');
  if (openIdx !== -1) return raw.slice(openIdx + '<|completion|>'.length);

  const closeIdx = raw.indexOf('<|/completion|>');
  if (closeIdx !== -1) return raw.slice(0, closeIdx);

  const fence = raw.match(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/);
  if (fence) return fence[1];

  const json = raw.match(/<JSON>([\s\S]*?)<\/JSON>/i);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]);
      if (parsed && typeof parsed.text === 'string') return parsed.text;
    } catch (_) { /* ignore */ }
  }

  return raw;
};

/**
 * Strip leading prelude chatter, stray envelope markers, markdown fences,
 * and any prefix overlap with the cursor's line. Trims a single trailing
 * newline so Monaco doesn't double-up on insert.
 */
export const sanitizeCompletion = (text, { prefix = '' } = {}) => {
  if (!text) return '';
  let out = String(text);

  // Strip markdown fences if a wrapper slipped through.
  out = out.replace(/^```[a-zA-Z0-9_+-]*\n?/, '').replace(/```\s*$/, '');

  // Strip a leading "OUTPUT:" the model echoed from the prompt template.
  out = out.replace(/^\s*output\s*:\s*/i, '');

  // Strip stray envelope markers if either half slipped through extraction.
  out = out.replace(/<\|\/?completion\|>/g, '');

  // Drop leading "Here's the completion:" style preludes.
  out = out.replace(/^\s*(here(?:'s| is)|the completion|sure[,!:])[^\n]*\n/i, '');

  // Strip the explicit stop sequence we inject.
  out = out.split(AI_COMPLETION_STOP_SEQUENCE)[0];

  // Normalise carriage returns.
  out = out.replace(/\r/g, '');

  // De-duplicate: if the model started by re-printing the tail of the prefix, trim it.
  if (prefix && out.length) {
    const tail = prefix.slice(-Math.min(prefix.length, 80));
    for (let n = Math.min(tail.length, out.length); n >= 4; n--) {
      if (out.startsWith(tail.slice(-n))) {
        out = out.slice(n);
        break;
      }
    }
  }

  if (!out.trim()) return '';

  // Trim a single trailing newline (Monaco re-adds when it inserts).
  return out.replace(/\n+$/, '\n').replace(/\n$/, '');
};

/**
 * Suppress a suggestion that already appears verbatim in the surrounding
 * context — the #1 source of "ugly" inline completions that just echo what
 * the user typed.
 */
export const isCompletionEcho = (suggestion, prefix, suffix) => {
  if (!suggestion?.trim()) return true;
  const trimmed = suggestion.trim();
  if (prefix && prefix.includes(trimmed)) return true;
  if (suffix && suffix.includes(trimmed)) return true;
  return false;
};

// Hard cap on lines we'll ever surface, regardless of structural boundary.
// Anything beyond this is the model on a roll outside the prompt's "one
// unit at most" budget — almost always speculation we don't want to show.
const TRUNCATE_HARD_LINE_CAP = 14;

const detectBaselineIndent = (prefix) => {
  if (!prefix) return 0;
  const lines = prefix.split('\n');
  // The cursor sits at the end of `prefix`. If the cursor's own line has
  // any non-whitespace content (mid-line cursor), use its indent. Otherwise
  // the cursor is on a blank line — walk back to the most recent non-empty
  // line and use that as the surrounding scope's indent.
  const cursorLine = lines[lines.length - 1] ?? '';
  if (cursorLine.trim()) {
    return cursorLine.length - cursorLine.trimStart().length;
  }
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i];
    if (line.trim()) return line.length - line.trimStart().length;
  }
  return 0;
};

/**
 * Hard-cap a suggestion at the first natural unit boundary.
 *
 * The prompt asks for "AT MOST ONE new unit per response", but soft prompt
 * limits do not bind on Gemini Flash — once the model has the pattern, it
 * routinely fans out into 2–3 sibling methods. We enforce structurally:
 *
 *  - Compute baselineIndent = the indent of the cursor's surrounding scope.
 *  - Walk lines top-down. After the first non-blank line:
 *      · `}` (with optional `;`/`,`/`)` trailers) at indent ≤ baselineIndent
 *        → include line & stop. Covers both "new sibling unit complete"
 *        (close at the cursor's own indent) and "tail of the unit the
 *        cursor sits in has been finished" (close at a lower indent).
 *      · Any other non-blank line at indent ≤ baselineIndent → drop trailing
 *        blanks, stop WITHOUT including (the model started a sibling /
 *        moved out of scope).
 *      · Anything at deeper indent → body line, include & continue.
 *  - Backstop at TRUNCATE_HARD_LINE_CAP for outliers without a structural
 *    boundary (e.g., expression continuations the model padded out).
 *
 * Single-line continuations and short blocks pass through untouched.
 *
 * Side benefit: callers using line-count telemetry get a stable signal —
 * "lines = N" reflects what the user sees, not what the model produced.
 */
export const truncateToFirstUnit = (text, { prefix = '' } = {}) => {
  if (!text || !text.includes('\n')) return text;

  const baselineIndent = detectBaselineIndent(prefix);
  const lines = text.split('\n');
  const out = [];
  let firstCodeSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      if (out.length >= TRUNCATE_HARD_LINE_CAP) return out.join('\n');
      continue;
    }

    const indent = line.length - line.trimStart().length;
    // `}` optionally followed by `;`/`,`/`)` and/or a line comment — covers
    // C++-style `};`, JS `}`, Rust `})` chained closes, etc.
    const isClose = /^\}[\s;,)]*(\s*\/\/.*)?$/.test(trimmed);

    if (firstCodeSeen && indent <= baselineIndent) {
      if (isClose) {
        out.push(line);
        return out.join('\n');
      }
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out.join('\n');
    }

    out.push(line);
    firstCodeSeen = true;
    if (out.length >= TRUNCATE_HARD_LINE_CAP) return out.join('\n');
  }

  return out.join('\n');
};

/**
 * Count visible lines for telemetry. Trailing whitespace doesn't count —
 * a suggestion ending in `\n` shouldn't read as an extra line vs. one that
 * doesn't.
 */
export const countSuggestionLines = (text) => {
  if (!text) return 0;
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return 0;
  return trimmed.split('\n').length;
};

/**
 * Walk a multi-line suggestion from end to start and return the longest
 * prefix that ends on a complete statement boundary — the last line whose
 * non-comment content ends in `;` or `}`.
 *
 * Used as the accept-time fallback when the user Tab-applies a suggestion
 * that's still streaming (cache.stable === false) and is multi-line. Lets
 * the user keep their snappy Tab-accept reflex without committing to a
 * syntactically-open tail like `int add() {\n    if (a) {`. If there's no
 * complete prefix at all, returns '' and the caller blocks the accept.
 *
 * Single-line suggestions don't go through this — the user can see all of
 * the suggestion before pressing Tab, so accept-as-is is fine.
 */
export const lastCompletePrefix = (text) => {
  if (!text) return '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip a trailing line comment so `foo();  // note` still counts.
    const noComment = lines[i].replace(/\s*\/\/.*$/, '');
    const trimmed = noComment.trimEnd();
    if (!trimmed) continue;
    const lastCh = trimmed[trimmed.length - 1];
    if (lastCh === ';' || lastCh === '}') {
      return lines.slice(0, i + 1).join('\n');
    }
  }
  return '';
};
