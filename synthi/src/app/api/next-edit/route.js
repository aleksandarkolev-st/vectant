import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import {
  REPLACE_BOUNDARY,
  SEARCH_OPEN_KEYWORD,
  SEARCH_OPEN_ALL_KEYWORD,
  REPLACE_DIVIDER,
} from '@/lib/nextEdit';

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
// might emit a SEARCH against. We accept up to ~6 KB total and split that
// budget across the supplied files (most-recently-edited first).
const NEP_FILES_BUDGET_CHARS = 6000;
const NEP_PER_FILE_CHARS = 2000;

const RECENT_EDITS_OPEN = '<recent_edits>';
const RECENT_EDITS_CLOSE = '</recent_edits>';

const limit = (text, max) => {
  if (typeof text !== 'string' || !text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
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

const renderFiles = (files) => {
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
    const snippet = limit(content, remaining);
    sections.push(`<file path="${path}">\n${snippet}\n</file>`);
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

const buildPrompt = ({ recentEditsBlock, filesBlock, contextBlock, language, activePath, cursor }) => {
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
    '- Multiple blocks may chase a refactor across files. Emit them in dependency order (where the user will likely accept first comes first).',
    '- If no high-confidence next edit exists, emit nothing. An empty response is correct when the user’s trajectory does not predict a clear follow-up.',
    '- No markdown fences. No commentary. No explanations. Just the block(s).',
    '',
    '---',
    '',
    recentEditsBlock || null,
    recentEditsBlock ? '' : null,
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
  const filesBlock = renderFiles(body?.files || {});
  const contextBlock = renderContext(body?.references || []);

  // Bail early: NEP needs at least a recent-edits trajectory or the file
  // contents to predict against. Without either, the model is just guessing.
  if (!recentEditsBlock && !filesBlock) {
    return new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const prompt = buildPrompt({
    recentEditsBlock,
    filesBlock,
    contextBlock,
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
          const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: prompt,
            config: {
              maxOutputTokens: NEP_MAX_OUTPUT_TOKENS,
              temperature: 0.2,
            },
          });
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
        controller.close();
      } catch (e) {
        cancel(e);
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
