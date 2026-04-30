// Shared constants and helpers for the AI code completion flow.
export const AI_COMPLETION_STOP_SEQUENCE = '<!-- ai-completion-stop -->';
// Keep completions short so the model responds faster.
export const AI_COMPLETION_MAX_OUTPUT_TOKENS = 256;
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
