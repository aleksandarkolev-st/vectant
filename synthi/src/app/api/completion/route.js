import { NextResponse } from 'next/server';
import {
  AI_COMPLETION_MAX_INPUT_CHARS,
  AI_COMPLETION_MAX_OUTPUT_TOKENS,
  COMPLETION_OPEN,
  COMPLETION_CLOSE,
} from '@/lib/completion';
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const COMPLETION_TIMEOUT_MS = 12_000;
// We dropped the multi-file references, so we have token budget back.
// 4.8 KB total context fits flash-lite comfortably and gives the model
// enough header/class context for typed languages like C++.
const MAX_BLOCK_CHARS = 4800;
const HALF_BLOCK_CHARS = Math.floor(MAX_BLOCK_CHARS / 2);

// ── RAG fast-context wiring ──────────────────────────────────────────────
// We call ai-backend's /code-intel/context/fast endpoint to pull hybrid
// (BM25 + dense + symbol) snippets from the workspace's index. The endpoint
// is LLM-free and benchmarks at ~50–250ms (the upper end is when an inline
// query embedding has to be computed; cache hits are sub-30ms). We still
// cap the wait so a slow backend can't hold up the keystroke path.
const CODE_INTEL_URL = process.env.CODE_INTEL_URL
  || process.env.NEXT_PUBLIC_CODE_INTEL_URL
  || 'http://localhost:8000';
const CODE_INTEL_API_KEY = process.env.CODE_INTEL_API_KEY || '';
// 350ms gives the inline-embed step room (~120ms cap server-side) plus
// retrieval and round-trip without the user feeling the wait. Cache hits
// return well under this regardless.
const RAG_FETCH_TIMEOUT_MS = 350;
// Server-side embed budget. The first time we see a new query fingerprint
// the backend pays this cost; every subsequent keystroke within ~30s reuses
// the cached embedding. 0 disables inline embedding entirely.
const RAG_EMBED_TIMEOUT_MS = 120;
const RAG_CACHE_TTL_MS = 30_000;
const RAG_CACHE_MAX_ENTRIES = 256;

// Tiny LRU keyed by workspace + a fingerprint of the query. Cursor / Copilot
// hide their per-keystroke retrieval cost behind exactly this kind of cache —
// pay the latency tax once per ~30s window, then it's free for every
// subsequent completion that hits a similar query.
const ragCache = new Map();
const ragInflight = new Map(); // dedup concurrent requests for the same key

const ragCacheGet = (key) => {
  const entry = ragCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > RAG_CACHE_TTL_MS) {
    ragCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  ragCache.delete(key);
  ragCache.set(key, entry);
  return entry.value;
};

const ragCacheSet = (key, value) => {
  ragCache.set(key, { value, ts: Date.now() });
  while (ragCache.size > RAG_CACHE_MAX_ENTRIES) {
    const oldest = ragCache.keys().next().value;
    if (oldest === undefined) break;
    ragCache.delete(oldest);
  }
};

// Fingerprint just enough of the prefix that small typing changes hit the
// same cache entry. We slice to the last ~120 chars and strip whitespace —
// this means typing one extra character usually still cache-hits.
const fingerprintQuery = (query) => {
  const s = (query || '').replace(/\s+/g, ' ').trim();
  return s.slice(Math.max(0, s.length - 120));
};

const RAG_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{1,}/g;
const extractQuerySymbols = (text) => {
  if (!text) return [];
  const seen = new Map();
  let m;
  RAG_IDENT_RE.lastIndex = 0;
  // Walk back-to-front so the cursor's neighborhood biases the symbol list.
  const slice = text.slice(Math.max(0, text.length - 600));
  while ((m = RAG_IDENT_RE.exec(slice))) {
    const ident = m[0];
    if (ident.length < 3) continue;
    seen.set(ident, (seen.get(ident) || 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s]) => s);
};

/**
 * Hit /code-intel/context/fast with a hard timeout. Returns an array of
 * reference shapes ready for buildPrompt, or [] on miss / timeout / failure —
 * inline completions never block on this path.
 */
const fetchRagReferences = async ({ workspaceSlug, query, language }) => {
  if (!workspaceSlug || !query) return [];

  const key = `${workspaceSlug}::${language || ''}::${fingerprintQuery(query)}`;
  const cached = ragCacheGet(key);
  if (cached) return cached;

  const inflight = ragInflight.get(key);
  if (inflight) return inflight;

  const symbols = extractQuerySymbols(query);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('rag-timeout'), RAG_FETCH_TIMEOUT_MS);

  const promise = (async () => {
    try {
      const res = await fetch(`${CODE_INTEL_URL}/code-intel/context/fast`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...(CODE_INTEL_API_KEY ? { 'x-code-intel-key': CODE_INTEL_API_KEY } : {}),
        },
        body: JSON.stringify({
          workspace_path: workspaceSlug,
          query,
          symbols,
          language: language || null,
          // 8 chunks * up to 480 chars each gives the merge step diverse
          // candidates to dedup/MMR over while staying under the 5 KB refs
          // budget rendered into the prompt.
          max_chunks: 8,
          max_chars_per_chunk: 480,
          embed_timeout_ms: RAG_EMBED_TIMEOUT_MS,
        }),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const refs = Array.isArray(data?.chunks)
        ? data.chunks.map((c) => ({
            path: c.file || 'unknown',
            snippet: c.snippet || '',
            startLine: c.start_line || 0,
            symbol: c.symbol || '',
            kind: 'rag',
          }))
        : [];
      ragCacheSet(key, refs);
      return refs;
    } catch (_) {
      // Timeout, network, or upstream failure — silent. The local refs the
      // client already attached are sufficient.
      return [];
    } finally {
      clearTimeout(timer);
      ragInflight.delete(key);
    }
  })();

  ragInflight.set(key, promise);
  return promise;
};

/**
 * Merge client-supplied (local-grep) references with RAG-supplied references,
 * dedup by `path + symbol` (or `path + startLine` for recent-edit shapes),
 * and prefer the entry with more useful metadata when both sides cover the
 * same chunk.
 */
const mergeReferences = (clientRefs = [], ragRefs = []) => {
  const out = [];
  const seen = new Set();
  const keyOf = (r) => {
    if (!r) return '';
    if (r.symbol) return `${r.path || ''}::${r.symbol}`;
    return `${r.path || ''}::${r.startLine || 0}`;
  };
  // Recent-edit refs go first (strongest "what's relevant right now" signal),
  // then RAG (workspace-wide), then local symbol greps (subset of RAG most
  // of the time but cheap insurance).
  const recentEdits = clientRefs.filter((r) => r?.kind === 'recent-edit');
  const localSymbols = clientRefs.filter((r) => r?.kind !== 'recent-edit');
  for (const r of [...recentEdits, ...ragRefs, ...localSymbols]) {
    const k = keyOf(r);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
};

const limitText = (value, { max = MAX_BLOCK_CHARS, fromEnd = false } = {}) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.length <= max) return value;
  return fromEnd ? value.slice(value.length - max) : value.slice(0, max);
};

const extractText = (resp) => {
  if (!resp) return '';
  const parts =
    resp?.response?.candidates?.[0]?.content?.parts ||
    resp?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    return parts.map((p) => p?.text || '').join('');
  }
  const finishReason =
    resp?.response?.candidates?.[0]?.finishReason ||
    resp?.candidates?.[0]?.finishReason;
  if (finishReason && !parts?.length) return '';
  try {
    const direct = resp.text || resp.output_text || resp.outputText;
    if (direct) return direct;
  } catch (_) { /* .text accessor threw */ }
  try {
    const nested = resp.response;
    const t = nested?.text || nested?.output_text || nested?.outputText;
    if (t) return t;
  } catch (_) { /* nested .text accessor threw */ }
  return '';
};

/**
 * Build a fill-in-the-middle context. The model sees prefix + suffix and is asked
 * to produce only what goes in the middle. This is far more reliable than a free-form
 * "continue from cursor" prompt because the suffix prevents the model from re-generating
 * code the user already wrote on the next lines.
 */
const buildFimContext = (blocks = {}, body = {}) => {
  let beforeCursor = blocks.beforeCursor || '';
  let afterCursor  = blocks.afterCursor  || '';

  // Fall back to splitting the full document around the cursor when block context wasn't supplied.
  if ((!beforeCursor || !afterCursor) && typeof body.code === 'string' && body.cursor) {
    const lines = body.code.split(/\r?\n/);
    const li  = Math.max(0, Math.min(lines.length - 1, (Number(body.cursor.line) || 1) - 1));
    const col = Math.max(0, (Number(body.cursor.column) || 1) - 1);
    const before = [...lines.slice(0, li), lines[li]?.slice(0, col) ?? ''].join('\n');
    const after  = [lines[li]?.slice(col) ?? '', ...lines.slice(li + 1)].join('\n');
    beforeCursor ||= before;
    afterCursor  ||= after;
  }

  return {
    prefix: limitText(beforeCursor, { max: HALF_BLOCK_CHARS, fromEnd: true }),
    suffix: limitText(afterCursor,  { max: HALF_BLOCK_CHARS, fromEnd: false }),
  };
};

// Total budget for `references` content rendered into the CONTEXT block.
// Flash-Lite happily eats 32k+ tokens; modern inline-completion pipelines
// (Cursor, Continue) routinely ship 4–10 KB of retrieval context. 5 KB hits
// the sweet spot between recall and prompt cost.
const MAX_REFS_CHARS = 5000;

/**
 * Render a small set of caller-supplied references (symbol declarations and
 * recent edits in OTHER files) into a compact CONTEXT block. We get one
 * targeted snippet per relevant symbol — never a whole file — so the model
 * sees the type/signature info without the noise that the previous
 * "ship every open file" payload caused.
 */
const formatReferences = (refs) => {
  if (!Array.isArray(refs) || !refs.length) return '';
  const sections = [];
  let used = 0;
  for (const ref of refs) {
    if (!ref || typeof ref.snippet !== 'string' || !ref.snippet.trim()) continue;
    if (used >= MAX_REFS_CHARS) break;
    const remaining = MAX_REFS_CHARS - used;
    const snippet = ref.snippet.length > remaining
      ? ref.snippet.slice(0, remaining) + '\n…'
      : ref.snippet;
    const tag = ref.kind === 'recent-edit'
      ? `recent edit · ${ref.path || 'unknown'}`
      : `${ref.symbol ? `symbol ${ref.symbol} · ` : ''}${ref.path || 'unknown'}${ref.startLine ? ` (line ${ref.startLine})` : ''}`;
    sections.push(`// === ${tag} ===\n${snippet}`);
    used += snippet.length;
  }
  return sections.join('\n\n');
};

const buildPrompt = ({ prefix, suffix, language, filePath, references }) => {
  const refBlock = formatReferences(references);
  return [
    'You are an inline code completion engine. Continue the code at the cursor.',
    `Language: ${language}`,
    filePath ? `File: ${filePath}` : null,
    '',
    'RULES',
    '- Output ONLY the text that goes between BEFORE and AFTER. Never repeat code from either side.',
    '- Stop after one coherent unit (a statement, expression, or short block) — usually 1–3 lines.',
    '- If nothing useful would fit (the surrounding code is already complete), output an empty completion.',
    '- Match the existing indentation and code style exactly.',
    '- No explanations, no markdown fences, no commentary.',
    refBlock
      ? '- The CONTEXT block below shows related symbols (for type/signature info — do not copy literally) and recent-edit hunks (lines marked with `+ ` show what was just typed elsewhere — they signal user intent and may suggest matching patterns).'
      : null,
    '',
    'OUTPUT FORMAT',
    `Wrap the inserted text in ${COMPLETION_OPEN}...${COMPLETION_CLOSE}. Output nothing else.`,
    '',
    'EXAMPLE (illustrative — match the actual language above, not this one)',
    'BEFORE:',
    'function add(a, b) {',
    '  return ',
    'AFTER:',
    '}',
    '',
    `OUTPUT: ${COMPLETION_OPEN}a + b;${COMPLETION_CLOSE}`,
    '',
    '---',
    '',
    refBlock ? 'CONTEXT (read-only, from other files):' : null,
    refBlock || null,
    refBlock ? '' : null,
    'BEFORE:',
    prefix,
    'AFTER:',
    suffix,
    '',
    'OUTPUT:',
  ].filter(line => line !== null).join('\n');
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

  const { prefix, suffix } = buildFimContext(body?.contextBlocks, body);

  if (!prefix && !suffix) {
    return new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const trimmedPrefix = prefix.length > AI_COMPLETION_MAX_INPUT_CHARS
    ? prefix.slice(-AI_COMPLETION_MAX_INPUT_CHARS)
    : prefix;
  const trimmedSuffix = suffix.length > AI_COMPLETION_MAX_INPUT_CHARS
    ? suffix.slice(0, AI_COMPLETION_MAX_INPUT_CHARS)
    : suffix;

  const clientRefs = Array.isArray(body?.references) ? body.references : [];

  // RAG fast-context fetch: hit ai-backend's /code-intel/context/fast in
  // parallel with prompt prep. Cache hits return synchronously; misses race
  // a 200ms timeout. We use the trailing prefix as the query so the index's
  // BM25 + symbol search can rank chunks by what the user is currently
  // working on.
  const workspaceSlug = typeof body?.workspaceSlug === 'string' ? body.workspaceSlug : '';
  const ragQuery = trimmedPrefix.slice(Math.max(0, trimmedPrefix.length - 600));
  const ragRefs = workspaceSlug
    ? await fetchRagReferences({ workspaceSlug, query: ragQuery, language })
    : [];

  const references = mergeReferences(clientRefs, ragRefs);
  const prompt = buildPrompt({
    prefix: trimmedPrefix,
    suffix: trimmedSuffix,
    language,
    filePath: body?.contextBlocks?.filePath || null,
    references,
  });

  // Streaming response: pipe each Gemini chunk straight to the client. The
  // client owns extraction/sanitization (logic lives in @/lib/completion) so
  // it can render partial text while the stream is still arriving — Cursor /
  // Copilot style. The full-buffer fallback path collapses to a single push
  // when streaming isn't supported.
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

      timer = setTimeout(() => cancel(new Error('AI completion timed out')), COMPLETION_TIMEOUT_MS);

      // Hook the client's AbortController so superseded keystrokes and
      // navigation actually tear down the stream and stop the Gemini token
      // bill. Without this the route keeps generating into a closed socket.
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
              maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
              temperature: 0.15,
              stopSequences: [COMPLETION_CLOSE, '\nBEFORE:', '\nAFTER:'],
            },
          });
        } catch (streamErr) {
          // SDK didn't stream — fall back to a single shot and emit it as one chunk.
          if (cancelled) return;
          const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: prompt,
            config: {
              maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
              temperature: 0.15,
              stopSequences: [COMPLETION_CLOSE, '\nBEFORE:', '\nAFTER:'],
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
