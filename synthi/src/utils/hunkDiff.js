/**
 * Compute a minimal line-range hunk between two strings.
 *
 * The result mirrors the backend HunkModel:
 *   { startLine, endLine, newLines }   // 0-indexed, [start, end)
 *
 * Algorithm: trim the longest common prefix and longest common suffix at
 * line granularity, then emit a single hunk for the diverging middle.
 *
 * This is suboptimal for multi-region edits (paste, large refactor) but
 * handles the dominant case (one cursor edit) optimally — which is exactly
 * the case where saving payload bytes matters most. For multi-region
 * edits the heuristic in shouldUseHunks falls back to full content.
 */
export function computeHunks(oldContent, newContent) {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const startLine = prefix;
  const endLine = oldLines.length - suffix;
  const replacement = newLines.slice(prefix, newLines.length - suffix);

  if (startLine === endLine && replacement.length === 0) return [];

  return [{
    startLine,
    endLine,
    newLines: replacement,
  }];
}

/**
 * Heuristic: is sending hunks meaningfully smaller than sending full content?
 *
 * A hunk's wire size is dominated by its newLines payload. If that's
 * within ~70% of the full content, just send full content — it's simpler,
 * avoids the round-trip-on-mismatch cost, and the savings aren't worth the
 * fallback risk. Threshold tuned to match common typing edits cleanly while
 * sending big paste/refactor diffs as full content.
 */
export function shouldUseHunks(hunks, newContent, threshold = 0.7) {
  if (!hunks.length) return false;
  let hunkBytes = 0;
  for (const h of hunks) {
    for (const line of h.newLines) hunkBytes += line.length + 1;
    hunkBytes += 16;
  }
  return hunkBytes < newContent.length * threshold;
}

/**
 * Browser-compatible content hash matching the backend's truncated SHA-256.
 * Returns a 16-char hex string. Async because SubtleCrypto.digest is async.
 */
export async function computeContentHashAsync(content) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = new TextEncoder().encode(content);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(hash);
    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
  // Fallback: simple non-cryptographic hash so the value still differs on
  // change. The backend treats this as opaque except for equality, but
  // verification against base_hash will fail and force a full-content
  // resend — which is the safe behavior when SubtleCrypto is unavailable.
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    h = (h ^ content.charCodeAt(i)) >>> 0;
    h = ((h * 16777619) >>> 0);
  }
  return h.toString(16).padStart(16, '0');
}
