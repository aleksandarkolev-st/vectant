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

// Total budget for `references` content. Caps the worst-case prompt size
// even if the client over-shares; the client also clamps below this.
const MAX_REFS_CHARS = 1400;

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
      ? '- The CONTEXT block below shows symbols and recent edits from OTHER files. Use it for type and signature info ONLY. Do not copy from it.'
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

  const references = Array.isArray(body?.references) ? body.references : [];
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
          const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite-preview',
            contents: prompt,
            config: {
              maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
              temperature: 0.15,
              stopSequences: [COMPLETION_CLOSE, '\nBEFORE:', '\nAFTER:'],
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
