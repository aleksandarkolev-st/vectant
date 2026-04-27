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

const FIM_PREFIX = '<|fim_prefix|>';
const FIM_SUFFIX = '<|fim_suffix|>';
const FIM_MIDDLE = '<|fim_middle|>';
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

const collectFileText = (file) => {
  if (!file || typeof file !== 'object') return '';
  if (typeof file.content === 'string') return file.content;
  if (typeof file.text    === 'string') return file.text;
  if (typeof file.value   === 'string') return file.value;
  if (typeof file.source  === 'string') return file.source;
  return '';
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

const collectReferenceFiles = (body) => {
  const refs = [];
  if (Array.isArray(body?.files)) {
    for (const file of body.files) {
      const text = collectFileText(file);
      if (!text.trim()) continue;
      const path = file?.path || file?.name || 'unknown';
      refs.push({ path, text: limitText(text, { max: 1200 }) });
    }
  }
  return refs.slice(0, 3); // hard cap — references add noise quickly
};

const buildPrompt = ({ prefix, suffix, language, filePath, references }) => {
  const refSection = references.length
    ? references.map(r => `// === reference: ${r.path} ===\n${r.text}`).join('\n\n')
    : '';

  return [
    'You are an expert programmer providing a single inline code completion.',
    `Language: ${language}`,
    filePath ? `File: ${filePath}` : null,
    '',
    'TASK',
    `Produce ONLY the text that fills the gap between ${FIM_PREFIX} and ${FIM_SUFFIX}.`,
    'Do not repeat any code from the prefix or suffix. Do not add explanations, comments, or backticks.',
    'Stop as soon as a single coherent unit (statement, expression, or block) is finished — usually one to a few lines.',
    'If nothing useful can be added (e.g. the surrounding code is already complete), respond with an empty completion.',
    'Match the existing indentation and code style exactly.',
    '',
    'OUTPUT FORMAT',
    `Wrap the completion in ${COMPLETION_OPEN}...${COMPLETION_CLOSE}. No other output.`,
    '',
    refSection ? `REFERENCES (read-only — for symbol/type names only)\n${refSection}\n` : null,
    'CONTEXT',
    `${FIM_PREFIX}${prefix}${FIM_SUFFIX}${suffix}${FIM_MIDDLE}`,
  ].filter(Boolean).join('\n');
};

/**
 * Strip everything outside <|completion|>...<|/completion|>. Falls back gracefully
 * when the model omits the markers (common with Gemini Flash under load).
 */
const extractCompletion = (raw) => {
  if (!raw) return '';
  const tagged = raw.match(/<\|completion\|>([\s\S]*?)<\|\/completion\|>/);
  if (tagged) return tagged[1];

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

  const references = collectReferenceFiles(body);
  const prompt = buildPrompt({
    prefix: trimmedPrefix,
    suffix: trimmedSuffix,
    language,
    filePath: body?.contextBlocks?.filePath || null,
    references,
  });

  try {
    let completionText = '';
    try {
      const stream = await withTimeout(
        ai.models.generateContentStream({
          model: 'gemini-3.1-flash-lite-preview',
          contents: prompt,
          generationConfig: {
            maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
            temperature: 0.15, // tighter — we want deterministic, focused completions
            stopSequences: [COMPLETION_CLOSE, FIM_PREFIX, FIM_SUFFIX],
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
          generationConfig: {
            maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
            temperature: 0.15,
            stopSequences: [COMPLETION_CLOSE, FIM_PREFIX, FIM_SUFFIX],
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
