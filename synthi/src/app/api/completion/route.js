import { NextResponse } from 'next/server';
import {
  AI_COMPLETION_MAX_INPUT_CHARS,
  AI_COMPLETION_STOP_SEQUENCE,
  AI_COMPLETION_MAX_OUTPUT_TOKENS,
} from '@/lib/completion';
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const COMPLETION_TIMEOUT_MS = 12_000;
const MAX_BLOCK_CHARS = 2200;
const HALF_BLOCK_CHARS = Math.floor(MAX_BLOCK_CHARS / 2);

const COMPLETION_OPEN = '<|completion|>';
const COMPLETION_CLOSE = '<|/completion|>';

const limitText = (value, { max = MAX_BLOCK_CHARS, fromEnd = false } = {}) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.length <= max) return value;
  return fromEnd ? value.slice(value.length - max) : value.slice(0, max);
};

const withTimeout = (promise, timeoutMs = COMPLETION_TIMEOUT_MS) => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('AI completion timed out')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeoutId); resolve(value); },
      (err)   => { clearTimeout(timeoutId); reject(err); }
    );
  });
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

const buildPrompt = ({ prefix, suffix, language, filePath }) => {
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
    '',
    'OUTPUT FORMAT',
    `Wrap the inserted text in ${COMPLETION_OPEN}...${COMPLETION_CLOSE}. Output nothing else.`,
    '',
    'EXAMPLE',
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
    'BEFORE:',
    prefix,
    'AFTER:',
    suffix,
    '',
    'OUTPUT:',
  ].filter(line => line !== null).join('\n');
};

/**
 * Strip everything outside <|completion|>...<|/completion|>. Falls back gracefully
 * when the model omits the markers (common with Gemini Flash under load).
 */
const extractCompletion = (raw) => {
  if (!raw) return '';

  // Full envelope.
  const tagged = raw.match(/<\|completion\|>([\s\S]*?)<\|\/completion\|>/);
  if (tagged) return tagged[1];

  // Half-open: `<|completion|>foo` — happens when stopSequences=[COMPLETION_CLOSE]
  // truncates the trailing marker before it reaches us.
  const openIdx = raw.indexOf('<|completion|>');
  if (openIdx !== -1) return raw.slice(openIdx + '<|completion|>'.length);

  // Half-close: `foo<|/completion|>` — model omitted the opener.
  const closeIdx = raw.indexOf('<|/completion|>');
  if (closeIdx !== -1) return raw.slice(0, closeIdx);

  // Fallback 1: stripped markdown fence
  const fence = raw.match(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/);
  if (fence) return fence[1];

  // Fallback 2: legacy JSON envelope (in case the model regresses to old prompt style)
  const json = raw.match(/<JSON>([\s\S]*?)<\/JSON>/i);
  if (json) {
    try {
      const parsed = JSON.parse(json[1]);
      if (parsed && typeof parsed.text === 'string') return parsed.text;
    } catch (_) { /* ignore */ }
  }

  // Last resort: return the whole thing minus obvious chatter.
  return raw;
};

/**
 * Clean the completion: strip leading/trailing fences, leading "Here is..." chatter,
 * trailing stop sequences, and de-duplicate any prefix overlap with the cursor's line.
 */
const sanitize = (text, { prefix = '' } = {}) => {
  if (!text) return '';
  let out = String(text);

  // Remove markdown fences if a wrapper slipped through.
  out = out.replace(/^```[a-zA-Z0-9_+-]*\n?/, '').replace(/```\s*$/, '');

  // Strip a leading "OUTPUT:" the model echoed from the prompt template.
  out = out.replace(/^\s*output\s*:\s*/i, '');

  // Strip stray envelope markers if either half slipped through earlier extraction.
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

  // Don't return only whitespace.
  if (!out.trim()) return '';

  // Trim a single trailing newline (Monaco re-adds when it inserts).
  return out.replace(/\n+$/, '\n').replace(/\n$/, '');
};

/**
 * Suppress a suggestion that already appears verbatim in the surrounding context —
 * this is the #1 source of "ugly" inline completions that just echo what the user typed.
 */
const isEcho = (suggestion, prefix, suffix) => {
  if (!suggestion?.trim()) return true;
  const trimmed = suggestion.trim();
  if (prefix && prefix.includes(trimmed)) return true;
  if (suffix && suffix.includes(trimmed)) return true;
  return false;
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
    return NextResponse.json({ completion: '' }, { status: 200 });
  }

  const trimmedPrefix = prefix.length > AI_COMPLETION_MAX_INPUT_CHARS
    ? prefix.slice(-AI_COMPLETION_MAX_INPUT_CHARS)
    : prefix;
  const trimmedSuffix = suffix.length > AI_COMPLETION_MAX_INPUT_CHARS
    ? suffix.slice(0, AI_COMPLETION_MAX_INPUT_CHARS)
    : suffix;

  // Multi-file references were dropped: they polluted the FIM context with
  // unrelated code from sibling files (often dirty buffers), causing the model
  // to echo from refs or hallucinate cross-file symbols. The local prefix/suffix
  // already contains every symbol the user has actually used in this file.
  const prompt = buildPrompt({
    prefix: trimmedPrefix,
    suffix: trimmedSuffix,
    language,
    filePath: body?.contextBlocks?.filePath || null,
  });

  try {
    let completionText = '';
    try {
      // The @google/genai SDK takes generation parameters under `config`, not
      // `generationConfig` (that's the legacy `@google/generative-ai` shape).
      // Passing the wrong key silently drops temperature / maxOutputTokens /
      // stopSequences, which is why completions came back unbounded and
      // wandered far past the requested gap.
      const stream = await withTimeout(
        ai.models.generateContentStream({
          model: 'gemini-3.1-flash-lite-preview',
          contents: prompt,
          config: {
            maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
            temperature: 0.15, // tighter — we want deterministic, focused completions
            stopSequences: [COMPLETION_CLOSE, '\nBEFORE:', '\nAFTER:'],
          },
        }),
        COMPLETION_TIMEOUT_MS
      );
      for await (const chunk of stream) {
        const t = extractText(chunk);
        if (t) completionText += t;
      }
    } catch (streamErr) {
      const response = await withTimeout(
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite-preview',
          contents: prompt,
          config: {
            maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
            temperature: 0.15,
            stopSequences: [COMPLETION_CLOSE, '\nBEFORE:', '\nAFTER:'],
          },
        }),
        COMPLETION_TIMEOUT_MS
      );
      completionText = extractText(response);
    }

    const inner = extractCompletion(completionText);
    const cleaned = sanitize(inner, { prefix: trimmedPrefix });

    if (!cleaned || isEcho(cleaned, trimmedPrefix, trimmedSuffix)) {
      return NextResponse.json({ completion: '' }, { status: 200 });
    }

    return NextResponse.json({ completion: cleaned }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: 'Service error', detail: e.message }, { status: 502 });
  }
}
