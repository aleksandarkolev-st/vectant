// NEP recent-edit ring buffer — Section 4 of the plan.
//
// Separate from the primary completion's 4-entry / 60s buffer. NEP needs a
// richer trajectory because refactor detection is the headliner signal.
//
//   - Size-bounded FIFO, ~8 KB total. Eviction pops oldest until the new entry
//     fits. Bounded by BYTES, not entry count: 12 large diffs ≠ 12 one-liners,
//     and we want the model to see the trajectory rather than 12 token-bombs.
//   - Each entry is a diff hunk in the same `@@ path L{a}-{b} @@` + `+`/' '
//     format the primary completion buffer uses, so the model only has one
//     dialect to learn.
//   - Rendered under a `<recent_edits>` block at the TOP of the NEP prompt
//     (above retrieved context). Refactor intent dominates symbol references
//     for predicting the next edit.

export const NEP_BUFFER_BYTES = 8 * 1024;

// Per-entry hard cap. Diffs longer than this get head-truncated with `…` so
// a single huge edit can't blow the byte budget alone, but we never drop the
// header line — that's how the model knows where the edit landed.
export const NEP_PER_ENTRY_BYTES = 1500;

const utf8len = (s) => {
  // Cheap UTF-8 byte estimator. Non-ASCII counts as 2-3 bytes; we err on the
  // side of overcounting so the buffer never overflows the budget. TextEncoder
  // is exact but allocates — this is in the keystroke path.
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else n += 3;
  }
  return n;
};

const trimEntry = (snippet) => {
  if (utf8len(snippet) <= NEP_PER_ENTRY_BYTES) return snippet;
  // Diffs start with `@@`. Keep the header + as many inserted (`+ `) lines as
  // fit; surrounding context lines fill any remaining room. This mirrors the
  // truncation logic in completionContext.pushRecentEdit but with a larger
  // budget tuned to NEP's headliner role.
  const lines = snippet.split('\n');
  const header = lines[0] || '';
  if (!header.startsWith('@@')) {
    // Non-diff payload — head-slice and ellipsis.
    return snippet.slice(0, NEP_PER_ENTRY_BYTES - 1) + '…';
  }
  const inserted = [];
  const context = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('+ ')) inserted.push(line);
    else context.push(line);
  }
  const out = [header];
  let used = utf8len(header) + 1; // +1 for the trailing newline join cost
  const fit = (line) => {
    const room = NEP_PER_ENTRY_BYTES - used - 1;
    if (room <= 0) return false;
    const need = utf8len(line) + 1;
    if (need <= room) {
      out.push(line);
      used += need;
      return true;
    }
    // Single line over budget — keep its head, drop the tail with `…`. We'd
    // rather see partial intent than nothing, and the early bytes of an
    // inserted line carry the strongest signal.
    out.push(line.slice(0, room - 1) + '…');
    used += room;
    return false;
  };
  for (const line of inserted) {
    if (!fit(line)) break;
  }
  for (const line of context) {
    if (!fit(line)) break;
  }
  return out.join('\n');
};

/**
 * Push an entry into the buffer. Returns the new buffer (immutable update —
 * caller stores the result back in their ref).
 *
 * Eviction order: oldest entries pop first. We do NOT coalesce by path the way
 * the primary completion buffer does, because NEP wants the trajectory: if the
 * user touched A, then B, then A again, all three should be visible.
 *
 * @param {Array<{path:string,snippet:string,ts:number}>} buffer
 * @param {{path:string,snippet:string,ts?:number}} entry
 */
export const pushNepEdit = (buffer, entry) => {
  if (!Array.isArray(buffer)) buffer = [];
  if (!entry?.path || !entry?.snippet) return buffer;
  const trimmed = trimEntry(entry.snippet);
  const next = buffer.slice();
  next.push({
    path: entry.path,
    snippet: trimmed,
    ts: entry.ts ?? Date.now(),
    // Preserve insertedText when supplied so NEP can synthesise an
    // appliedEdit for the impact endpoint without re-parsing the snippet.
    // Optional — falls through to undefined for callers that don't pass it.
    insertedText: typeof entry.insertedText === 'string' ? entry.insertedText : undefined,
  });

  // Evict from the FRONT (oldest) until the byte budget fits. The newest
  // entry is the most informative; if even one entry exceeds the total budget
  // (shouldn't happen with NEP_PER_ENTRY_BYTES enforced) we still keep it,
  // because dropping the freshest signal to satisfy a budget is worse than
  // mildly overflowing for one cycle.
  let total = next.reduce((acc, e) => acc + utf8len(e.snippet), 0);
  while (total > NEP_BUFFER_BYTES && next.length > 1) {
    const evicted = next.shift();
    total -= utf8len(evicted.snippet);
  }
  return next;
};

/**
 * Reset the buffer. Called on workspace switch — see plan Q1: NEP and the
 * primary buffer share the workspace-lifecycle hook to avoid two places
 * forgetting to clear.
 */
export const resetNepBuffer = () => [];

/**
 * Render the buffer into the `<recent_edits>` headliner block for the NEP
 * prompt. Newest entries last, so the model reads the trajectory in order.
 */
export const renderRecentEditsBlock = (buffer) => {
  if (!Array.isArray(buffer) || !buffer.length) return '';
  const sections = buffer.map((e) => e.snippet).filter(Boolean);
  if (!sections.length) return '';
  return ['<recent_edits>', ...sections, '</recent_edits>'].join('\n');
};

/**
 * Total bytes currently held — used by tests and debug overlays. The
 * eviction loop above is the source of truth; this is just a read.
 */
export const bufferBytes = (buffer) =>
  Array.isArray(buffer) ? buffer.reduce((acc, e) => acc + utf8len(e.snippet || ''), 0) : 0;
