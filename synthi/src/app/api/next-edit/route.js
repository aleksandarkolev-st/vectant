import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import {
  REPLACE_BOUNDARY,
  SEARCH_OPEN_KEYWORD,
  SEARCH_OPEN_ALL_KEYWORD,
  REPLACE_DIVIDER,
} from '@/lib/nextEdit';
import { withInternalAiAuth } from '@/lib/internalAiAuth';
import { renderCodeIntelHints } from '@/utils/aiContextBroker';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// NEP runs on its own request lifecycle (Section 8 of the plan: never blocks
// the inline-completion path). The timeout is generous because a refactor
// chain can take a beat to stream — but tight enough that a stuck stream
// doesn't pile up if a user goes idle and comes back.
const NEP_TIMEOUT_MS = 18_000;

// Output budget: 1 KB per block × ~6 blocks. Flash handles 32k; we cap at
// 1024 tokens to keep latency bounded for the common case (1–2 blocks). A
// big refactor that exceeds this just gets truncated — the parser drops the
// trailing partial via `parse_error` in telemetry.
const NEP_MAX_OUTPUT_TOKENS = 1024;

// NEP-side context budget. Smaller than the completion path's 5 KB because the
// recent-edits headliner does the heavy lifting — model needs trajectory more
// than reference for predicting the next edit. Per Section 5 of the plan.
const NEP_CONTEXT_CHARS = 3000;

// Files block — the model needs to see the current contents of any file it
// might emit a SEARCH against. The total budget is split across cached
// files (sent by the client) and impact-candidate files (hydrated server-
// side from the symbol graph). Per-file cap is on the smaller side so
// adding cross-file context doesn't push the active file out of the prompt.
const NEP_FILES_BUDGET_CHARS = 8000;
const NEP_PER_FILE_CHARS = 1500;

// Phase 2: cross-file impact endpoint hookup. When the client sends an
// `appliedEdit` (the edit the user just accepted), we ping ai-backend's
// /code-intel/edit-impact for ranked follow-up sites and inject them into
// the prompt as <impact_candidates>. The endpoint is best-effort and
// timeout-bounded — NEP must never wait on it.
const CODE_INTEL_URL = process.env.CODE_INTEL_URL
  || process.env.NEXT_PUBLIC_CODE_INTEL_URL
  || 'http://localhost:8000';
const CODE_INTEL_API_KEY = process.env.CODE_INTEL_API_KEY || '';
const NEP_IMPACT_TIMEOUT_MS = 350;
const NEP_IMPACT_MAX_CANDIDATES = 8;
// Wall-clock cap on the COMBINED candidates + content fetch chain.
// Without this, the worst case is 350ms (candidates) + 400ms (contents) =
// 750ms of pre-model latency, all of which the user feels as keystroke
// lag because the route hasn't started streaming Gemini yet. Capping at
// 500ms cuts that worst case by a third — when contents would have
// finished anyway it's a no-op, and when contents would have run long
// we trade some cross-file recall for snappier streams.
const NEP_PRE_MODEL_BUDGET_MS = 500;

// Collab-server is the source of truth for workspace file contents. After
// /code-intel/edit-impact returns a ranked list of cross-file candidates,
// we hydrate the top-N with actual content here so the model can emit
// SEARCH blocks against files the user has never opened. Without this the
// prompt only contains the cached files the client knows about — the very
// constraint the Phase 2 design ("predictions can chase a refactor across
// files") was meant to lift.
const COLLAB_URL = process.env.COLLAB_URL
  || process.env.NEXT_PUBLIC_COLLAB_URL
  || 'http://localhost:1234';
const NEP_IMPACT_CONTENT_TOPN = 4;
const NEP_IMPACT_CONTENT_TIMEOUT_MS = 400;

const RECENT_EDITS_OPEN = '<recent_edits>';
const RECENT_EDITS_CLOSE = '</recent_edits>';

const limit = (text, max) => {
  if (typeof text !== 'string' || !text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
};

const NEP_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

const extractIdentifiers = (text) => {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const out = [];
  NEP_IDENT_RE.lastIndex = 0;
  let m;
  while ((m = NEP_IDENT_RE.exec(text))) {
    const ident = m[0];
    if (seen.has(ident)) continue;
    seen.add(ident);
    out.push(ident);
    if (out.length >= 12) break;
  }
  return out;
};

const lineToOffset = (content, line) => {
  const target = Math.max(1, Number(line) || 1);
  if (target <= 1) return 0;
  let current = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      current += 1;
      if (current === target) return i + 1;
    }
  }
  return content.length;
};

const offsetToLine = (content, offset) => {
  let line = 1;
  const end = Math.max(0, Math.min(content.length, offset));
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
};

const exactSliceAround = (content, centerOffset, max) => {
  if (content.length <= max) {
    return { snippet: content, startLine: 1, truncated: false };
  }

  const center = Math.max(0, Math.min(content.length, Number(centerOffset) || 0));
  let start = Math.max(0, center - Math.floor(max / 2));
  if (start > 0) {
    const nl = content.indexOf('\n', start);
    if (nl !== -1 && nl < center) start = nl + 1;
  }
  let end = Math.min(content.length, start + max);
  if (end < content.length) {
    const nl = content.lastIndexOf('\n', end);
    if (nl > start && nl >= center) end = nl;
  }
  if (end <= start) end = Math.min(content.length, start + max);
  return {
    snippet: content.slice(start, end),
    startLine: offsetToLine(content, start),
    truncated: start > 0 || end < content.length,
  };
};

const chooseFileSlice = ({ path, content, activePath, cursor, appliedEdit, impactCandidates, max }) => {
  if (typeof content !== 'string') return { snippet: '', startLine: 1, truncated: false };
  let center = 0;

  if (path && path === activePath && cursor?.line) {
    center = lineToOffset(content, cursor.line);
  } else {
    const candidate = Array.isArray(impactCandidates)
      ? impactCandidates.find((c) => c?.file === path)
      : null;
    const symbols = [
      candidate?.symbol,
      ...extractIdentifiers(appliedEdit?.search || ''),
      ...extractIdentifiers(appliedEdit?.replace || ''),
    ].filter(Boolean);
    for (const symbol of symbols) {
      const idx = content.indexOf(symbol);
      if (idx !== -1) {
        center = idx;
        break;
      }
    }
  }

  return exactSliceAround(content, center, max);
};

/**
 * Render the recent-edits ring buffer block. The client either sends the
 * snippets pre-rendered (one diff per entry, headers preserved) or sends raw
 * entries — both paths produce the same `<recent_edits>` wrapper.
 */
const renderRecentEdits = (recentEdits) => {
  if (!Array.isArray(recentEdits) || !recentEdits.length) return '';
  const sections = recentEdits
    .map((e) => (typeof e === 'string' ? e : e?.snippet || ''))
    .filter(Boolean);
  if (!sections.length) return '';
  return [RECENT_EDITS_OPEN, ...sections, RECENT_EDITS_CLOSE].join('\n');
};

const renderFiles = (files, opts = {}) => {
  if (!files || typeof files !== 'object') return '';
  const entries = Array.isArray(files)
    ? files
    : Object.entries(files).map(([path, content]) => ({ path, content }));
  if (!entries.length) return '';

  let used = 0;
  const sections = [];
  for (const { path, content } of entries) {
    if (!path || typeof content !== 'string' || !content) continue;
    if (used >= NEP_FILES_BUDGET_CHARS) break;
    const remaining = Math.min(NEP_PER_FILE_CHARS, NEP_FILES_BUDGET_CHARS - used);
    if (remaining <= 0) break;
    const { snippet, startLine, truncated } = chooseFileSlice({
      path,
      content,
      activePath: opts.activePath,
      cursor: opts.cursor,
      appliedEdit: opts.appliedEdit,
      impactCandidates: opts.impactCandidates,
      max: remaining,
    });
    if (!snippet) continue;
    const attrs = [
      `path="${path}"`,
      truncated ? 'truncated="true"' : null,
      startLine && startLine > 1 ? `startLine="${startLine}"` : null,
    ].filter(Boolean).join(' ');
    sections.push(`<file ${attrs}>\n${snippet}\n</file>`);
    used += snippet.length + path.length + 24;
  }
  return sections.join('\n');
};

/**
 * Render a small CONTEXT block of related symbol declarations. NEP cares less
 * about reference than the completion path does — refactor intent comes from
 * `<recent_edits>` — so we cap this at ~3 KB.
 */
const renderContext = (references) => {
  if (!Array.isArray(references) || !references.length) return '';
  let used = 0;
  const sections = [];
  for (const ref of references) {
    if (!ref || typeof ref.snippet !== 'string' || !ref.snippet.trim()) continue;
    if (used >= NEP_CONTEXT_CHARS) break;
    const room = NEP_CONTEXT_CHARS - used;
    const snippet = ref.snippet.length > room
      ? ref.snippet.slice(0, room) + '\n…'
      : ref.snippet;
    const tag = `${ref.symbol ? `symbol ${ref.symbol} · ` : ''}${ref.path || 'unknown'}${ref.startLine ? ` (line ${ref.startLine})` : ''}`;
    sections.push(`// === ${tag} ===\n${snippet}`);
    used += snippet.length;
  }
  return sections.join('\n\n');
};

/**
 * Hit ai-backend's /code-intel/edit-impact for ranked follow-up sites.
 * Returns [] on timeout / error / no-applied-edit. Logged at debug only —
 * the prompt simply omits the <impact_candidates> block.
 */
const fetchImpactCandidates = async ({ workspaceSlug, appliedEdit }) => {
  if (!workspaceSlug || !appliedEdit?.path || !appliedEdit?.search) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('impact-timeout'), NEP_IMPACT_TIMEOUT_MS);
  try {
    const res = await fetch(`${CODE_INTEL_URL}/code-intel/edit-impact`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: withInternalAiAuth({
        'content-type': 'application/json',
        ...(CODE_INTEL_API_KEY ? { 'x-code-intel-key': CODE_INTEL_API_KEY } : {}),
      }),
      body: JSON.stringify({
        workspace_path: workspaceSlug,
        file_path: appliedEdit.path,
        search: appliedEdit.search,
        replace: appliedEdit.replace || '',
        edit_kind: appliedEdit.kind || null,
        max_candidates: NEP_IMPACT_MAX_CANDIDATES,
        max_depth: appliedEdit.kind === 'local_logic' ? 1 : 2,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.candidates) ? data.candidates : [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Hydrate the top-N impact candidates with their file contents from the
 * collab-server. Bounded by a hard timeout so a slow/dead collab-server can
 * never stall the NEP request — on miss we just skip that candidate's
 * content (the path still appears in <impact_candidates> as a hint).
 *
 * Returns a `{ path: content }` map of successfully fetched files.
 */
const fetchImpactCandidateContents = async ({ workspaceSlug, candidates, skipPaths, timeoutMs }) => {
  if (!workspaceSlug || !Array.isArray(candidates) || !candidates.length) return {};
  const skip = skipPaths instanceof Set ? skipPaths : new Set(skipPaths || []);
  const targets = [];
  for (const c of candidates) {
    if (!c?.file || skip.has(c.file)) continue;
    targets.push(c.file);
    if (targets.length >= NEP_IMPACT_CONTENT_TOPN) break;
  }
  if (!targets.length) return {};

  const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0
    ? Math.min(timeoutMs, NEP_IMPACT_CONTENT_TIMEOUT_MS)
    : NEP_IMPACT_CONTENT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('impact-content-timeout'), effectiveTimeout);
  try {
    const results = await Promise.all(targets.map(async (path) => {
      try {
        const res = await fetch(`${COLLAB_URL}/git/${encodeURIComponent(workspaceSlug)}/file`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!res.ok) return [path, null];
        const data = await res.json();
        return [path, typeof data?.content === 'string' ? data.content : null];
      } catch (_) {
        return [path, null];
      }
    }));
    const out = {};
    for (const [p, c] of results) {
      if (typeof c === 'string') out[p] = c;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

const renderImpactBlock = (candidates) => {
  if (!Array.isArray(candidates) || !candidates.length) return '';
  // Compact format. The model treats these as hints about which OTHER files
  // are likely to need follow-up edits, not as authoritative content. Score
  // is rounded; reasons joined with `+`.
  const lines = candidates.map((c) => {
    const sym = c.symbol ? `:${c.symbol}` : '';
    const reasons = Array.isArray(c.reasons) ? c.reasons.join('+') : '';
    const score = typeof c.score === 'number' ? c.score.toFixed(2) : c.score;
    return `- ${c.file}${sym}  (score=${score}, ${reasons || 'unknown'})`;
  });
  return ['<impact_candidates>', ...lines, '</impact_candidates>'].join('\n');
};

const buildPrompt = ({ recentEditsBlock, filesBlock, contextBlock, impactBlock, codeIntelBlock, language, activePath, cursor }) => {
  // The format spec teaches the model both `SEARCH` and `SEARCH ALL` so the
  // wire format is in distribution from day one — Phase 1 logs `SEARCH ALL`
  // with `phase2_required` instead of executing it (Section 1 / Section 5).
  return [
    'You are a Next-Edit Prediction engine. Predict the user’s NEXT edit (or chain of edits) given their recent edits and the current file contents.',
    'Your output is a sequence of search-replace blocks the editor will apply.',
    `Language: ${language || 'plaintext'}`,
    activePath ? `Active file: ${activePath}` : null,
    cursor ? `Cursor: line ${cursor.line ?? '?'}, column ${cursor.column ?? '?'}` : null,
    '',
    'OUTPUT FORMAT (strict)',
    'For each edit, emit a block in this exact form:',
    '',
    '{relative_path}',
    SEARCH_OPEN_KEYWORD,
    '{1–5 lines of EXISTING code copied byte-for-byte from the file}',
    REPLACE_DIVIDER,
    '{replacement text}',
    REPLACE_BOUNDARY,
    '',
    'For an edit that should be applied at EVERY occurrence of the same token / line / region, use the SEARCH ALL variant:',
    '',
    '{relative_path}',
    SEARCH_OPEN_ALL_KEYWORD,
    '{token, line, or region}',
    REPLACE_DIVIDER,
    '{replacement}',
    REPLACE_BOUNDARY,
    '',
    'RULES',
    '- The SEARCH text MUST appear in the named file EXACTLY ONCE (whitespace included). Choose 1–5 lines that uniquely anchor the edit.',
    '- Prefer lines containing identifiers (function names, types, distinctive symbols). AVOID pure-punctuation lines (`}`, `);`, etc) — they appear many times and will fail uniqueness.',
    '- Copy whitespace and indentation from the file as-is. Do not normalize.',
    '- If the recent edits suggest a refactor that touches multiple sites in one file with the same change, use SEARCH ALL once instead of N copies of SEARCH.',
    '- CROSS-FILE FOLLOW-UPS ARE THE PRIMARY USE CASE. When the user just renamed/changed a symbol in the active file and OTHER files in CURRENT FILE CONTENTS still reference the OLD form, your highest-priority output is SEARCH blocks against THOSE files updating the call sites. Emit cross-file blocks BEFORE same-file follow-ups. The `{relative_path}` in the block header MUST be the file path string from `<file path="...">`, not the active file.',
    '- Multiple blocks may chase a refactor across files. Emit them in dependency order (where the user will likely accept first comes first).',
    '- If no high-confidence next edit exists, emit nothing. An empty response is correct when the user’s trajectory does not predict a clear follow-up. But if recent edits show a rename/signature change AND another file in CURRENT FILE CONTENTS contains the old form, that IS a high-confidence next edit — emit it.',
    '- No markdown fences. No commentary. No explanations. Just the block(s).',
    '',
    '---',
    '',
    recentEditsBlock || null,
    recentEditsBlock ? '' : null,
    codeIntelBlock ? 'IDE SIGNALS (read-only, deterministic context ranking and symbols):' : null,
    codeIntelBlock || null,
    codeIntelBlock ? '' : null,
    impactBlock ? 'CROSS-FILE IMPACT CANDIDATES (read-only, ranked by symbol-graph proximity to the user’s last accepted edit; emit blocks against these files when the trajectory suggests a refactor chain):' : null,
    impactBlock || null,
    impactBlock ? '' : null,
    filesBlock ? 'CURRENT FILE CONTENTS (read-only):' : null,
    filesBlock || null,
    filesBlock ? '' : null,
    contextBlock ? 'RELATED SYMBOLS (read-only, for type/signature context):' : null,
    contextBlock || null,
    contextBlock ? '' : null,
    'OUTPUT:',
  ].filter((line) => line !== null).join('\n');
};

const extractText = (resp) => {
  if (!resp) return '';
  const parts =
    resp?.response?.candidates?.[0]?.content?.parts ||
    resp?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    return parts.map((p) => p?.text || '').join('');
  }
  try {
    const direct = resp.text || resp.output_text || resp.outputText;
    if (direct) return direct;
  } catch (_) { /* accessor threw */ }
  try {
    const nested = resp.response;
    const t = nested?.text || nested?.output_text || nested?.outputText;
    if (t) return t;
  } catch (_) { /* accessor threw */ }
  return '';
};

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: 'Bad payload', detail: err.message }, { status: 400 });
  }

  const language = typeof body.language === 'string' && body.language.trim()
    ? body.language.trim()
    : 'plaintext';
  const activePath = typeof body.activePath === 'string' ? body.activePath : null;
  const cursor = body?.cursor && typeof body.cursor === 'object' ? body.cursor : null;

  const recentEditsBlock = renderRecentEdits(body?.recentEdits || []);
  const contextBlock = renderContext(body?.references || []);
  const codeIntelBlock = renderCodeIntelHints(body?.codeIntel || {});

  // Bail early: NEP needs at least a recent-edits trajectory or the file
  // contents to predict against. Without either, the model is just guessing.
  const cachedFiles = (body?.files && typeof body.files === 'object') ? body.files : {};
  const hasAnyContent = recentEditsBlock || Object.keys(cachedFiles).length > 0;
  if (!hasAnyContent) {
    return new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Phase 2: optional cross-file impact lookup. Race a hard 350 ms timeout —
  // if the symbol index is cold or unreachable, the prompt simply omits
  // <impact_candidates>. The model still has the recent-edits trajectory and
  // the file contents to work from.
  const appliedEdit = body?.appliedEdit && typeof body.appliedEdit === 'object'
    ? body.appliedEdit
    : null;
  const workspaceSlug = typeof body?.workspaceSlug === 'string' ? body.workspaceSlug : '';

  // Wall-clock budget for the full impact chain. If candidates take 340 ms,
  // contents only get 160 ms before being abandoned — bounding total
  // pre-model latency rather than letting two cascading 350+400 ms
  // timeouts compound into a 750 ms tax on every NEP fire.
  const preModelStart = Date.now();
  const remainingBudget = () => Math.max(0, NEP_PRE_MODEL_BUDGET_MS - (Date.now() - preModelStart));

  const impactCandidates = appliedEdit
    ? await fetchImpactCandidates({ workspaceSlug, appliedEdit })
    : [];

  // Hydrate the top impact candidates with their actual contents so the
  // model can emit precise SEARCH blocks against files outside the user's
  // open tabs. Skip candidates we already have cached (the client already
  // sent those) so we spend the budget on genuinely new files.
  // Skip the contents fetch entirely if we've already burnt the wall-clock
  // budget on candidates — the prompt still has the candidate file paths
  // (renderImpactBlock) so the model gets the hint even without contents.
  const contentsBudget = remainingBudget();
  const impactContents = (impactCandidates.length && contentsBudget > 50)
    ? await fetchImpactCandidateContents({
        workspaceSlug,
        candidates: impactCandidates,
        skipPaths: Object.keys(cachedFiles),
        timeoutMs: contentsBudget,
      })
    : {};

  // Cached files first (most-relevant: the user has them open or recently
  // touched), then impact-candidate hydration. renderFiles applies the
  // shared budget in this order, so cached content always wins on contention.
  const filesForPrompt = { ...cachedFiles, ...impactContents };
  const filesBlock = renderFiles(filesForPrompt, {
    activePath,
    cursor,
    appliedEdit,
    impactCandidates,
  });

  const impactBlock = renderImpactBlock(impactCandidates);

  const prompt = buildPrompt({
    recentEditsBlock,
    filesBlock,
    contextBlock,
    impactBlock,
    codeIntelBlock,
    language,
    activePath,
    cursor,
  });

  // Stream the response — same shape as /api/completion. The client owns
  // parsing/validation (logic in @/lib/nextEdit) so it can render jump-hint
  // dots progressively as each `>>>>>>> REPLACE` boundary lands.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let timer = null;
      let cancelled = false;
      const cancel = (err) => {
        if (cancelled) return;
        cancelled = true;
        if (timer) clearTimeout(timer);
        try { controller.error(err); } catch (_) { /* already closed */ }
      };
      timer = setTimeout(() => cancel(new Error('NEP request timed out')), NEP_TIMEOUT_MS);

      // Hook the client's AbortController. Superseded NEP fires (the user
      // typed again, the workspace switched) need to actually cut the
      // stream — without this we keep generating into a closed socket and
      // burning Gemini tokens.
      const onClientAbort = () => cancel(new Error('client aborted'));
      const clientSignal = request.signal;
      if (clientSignal) {
        if (clientSignal.aborted) {
          cancel(new Error('client aborted before start'));
          return;
        }
        try { clientSignal.addEventListener('abort', onClientAbort); } catch (_) { /* unsupported */ }
      }

      try {
        let geminiStream;
        try {
          geminiStream = await ai.models.generateContentStream({
            model: 'gemini-3.1-flash-lite-preview',
            contents: prompt,
            config: {
              maxOutputTokens: NEP_MAX_OUTPUT_TOKENS,
              // Slightly higher than completion (0.15) — refactor prediction
              // benefits from a touch more variety, and the validator hard-
              // rejects anything that doesn't match the file.
              temperature: 0.2,
            },
          });
        } catch (streamErr) {
          // SDK didn't stream — fall back to a single shot.
          if (cancelled) return;
          const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: prompt,
            config: {
              maxOutputTokens: NEP_MAX_OUTPUT_TOKENS,
              temperature: 0.2,
            },
          });
          if (cancelled) return;
          const text = extractText(response);
          if (text) controller.enqueue(encoder.encode(text));
          if (timer) clearTimeout(timer);
          controller.close();
          return;
        }

        for await (const chunk of geminiStream) {
          if (cancelled) return;
          const t = extractText(chunk);
          if (t) controller.enqueue(encoder.encode(t));
        }
        if (timer) clearTimeout(timer);
        if (!cancelled) controller.close();
      } catch (e) {
        cancel(e);
      } finally {
        if (clientSignal) {
          try { clientSignal.removeEventListener('abort', onClientAbort); } catch (_) { /* ignored */ }
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
