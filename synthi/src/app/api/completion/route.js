import { NextResponse } from 'next/server';
import {
  AI_COMPLETION_MAX_INPUT_CHARS,
  AI_COMPLETION_STOP_SEQUENCE,
  AI_COMPLETION_MAX_OUTPUT_TOKENS,
} from '@/lib/completion';
import { GoogleGenAI } from "@google/genai";

// Initialize the client with explicit API key from environment variable
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});
const COMPLETION_TIMEOUT_MS = 12_000;
// Smaller blocks mean less prompt size and faster responses.
const MAX_BLOCK_CHARS = 2000;
const HALF_BLOCK_CHARS = Math.floor(MAX_BLOCK_CHARS / 2);

const limitText = (value, { max = MAX_BLOCK_CHARS, fromEnd = false } = {}) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value.length <= max) return value;
  return fromEnd ? value.slice(value.length - max) : value.slice(0, max);
};

const buildStructuredContext = (blocks = {}) => {
  if (!blocks || typeof blocks !== 'object') return '';

  const segments = [];
  if (blocks.filePath) segments.push(`File: ${blocks.filePath}`);
  if (Array.isArray(blocks.breadcrumbs) && blocks.breadcrumbs.length) {
    segments.push(`Breadcrumb: ${blocks.breadcrumbs.join(' / ')}`);
  }
  if (blocks.languageHint) segments.push(`Language hint: ${blocks.languageHint}`);
  if (blocks.fileHeader) {
    segments.push(`File header:\n${limitText(blocks.fileHeader)}`);
  }

  const before = limitText(blocks.beforeCursor, { max: HALF_BLOCK_CHARS, fromEnd: true });
  const after = limitText(blocks.afterCursor, { max: HALF_BLOCK_CHARS, fromEnd: false });
  if (before || after) {
    segments.push(`${before}<<CURSOR>>${after}`);
  }

  if (blocks.selection) {
    segments.push(`User selection:\n${limitText(blocks.selection, { max: HALF_BLOCK_CHARS })}`);
  }
  if (blocks.fileTail) {
    segments.push(`File tail:\n${limitText(blocks.fileTail)}`);
  }
  if (blocks.notes) {
    segments.push(`Notes:\n${limitText(blocks.notes)}`);
  }

  return segments.filter(Boolean).join('\n\n').trim();
};

const withTimeout = (promise, timeoutMs = COMPLETION_TIMEOUT_MS) => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('AI completion timed out'));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
};

const trimContext = code => {
  if (code.length <= AI_COMPLETION_MAX_INPUT_CHARS) return code;
  return code.slice(-AI_COMPLETION_MAX_INPUT_CHARS);
};

const collectFileText = file => {
  if (!file || typeof file !== 'object') return '';
  if (typeof file.content === 'string') return file.content;
  if (typeof file.text === 'string') return file.text;
  if (typeof file.value === 'string') return file.value;
  if (typeof file.source === 'string') return file.source;
  return '';
};

const buildPrompt = (context, language, cursor) =>
  [
    'You are a code assistant.Return a JSON object that has the following fields:\n  - "text": string — the replacement text to insert at the requested location.\n  - "start": { "line": number, "column": number } or null — 1-based inclusive start position of the replacement.\n  - "end": { "line": number, "column": number } or null — 1-based inclusive end position of the replacement.\nIf no replacement is needed, return {"text": "", "start": null, "end": null}. Do not output any comments, unless user has specified so.\n',
    `Language: ${language}`,
    'Do NOT repeat or restate code already present in the context. Provide only the next code the user likely wants to add.',
    'Other files may be provided as reference; use them for facts (types, function names), but do NOT copy their code verbatim. Generate code only for the active file around the cursor.',
    'If the best answer is already present in the provided context, respond with {"text":"","start":null,"end":null}.',
    'Use the context below and continue from the cursor position. The cursor position is indicated by the special marker `<<CURSOR>>` inside the context when available. If the marker is not present, use the provided cursor coordinates to continue from the appropriate place.',
    cursor && typeof cursor === 'object' ? `Cursor: line ${cursor.line || '?'} column ${cursor.column || '?'}` : null,
    'Context:',
    context,
    'Important: wrap your single JSON output in <JSON>...</JSON> with no extra explanation.',
  ].filter(Boolean).join('\n');

const gatherContext = body => {
  if (!body || typeof body !== 'object') return '';

  const parts = [];

  if (typeof body.code === 'string' && body.code.trim()) {
    parts.push(body.code);
  }

  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    parts.push(body.prompt);
  }

  if (Array.isArray(body.files)) {
    for (const file of body.files) {
      const fileText = collectFileText(file);
      if (fileText.trim()) {
        parts.push(fileText);
      }
    }
  }

  return parts.join('\n\n').trim();
};

const sanitize = raw => {
  if (!raw) return '';
  const beforeMarker = raw.split(AI_COMPLETION_STOP_SEQUENCE)[0];
  if (!beforeMarker.trim()) {
    return raw.trimEnd();
  }
  return beforeMarker.replace(/\r/g, '').trimEnd();
};

const suppressEcho = (suggestion = '', context = '') => {
  if (!suggestion?.trim()) return '';
  if (typeof context !== 'string' || !context.trim()) return suggestion;

  // If the suggestion already appears verbatim in the provided context, skip it.
  if (context.includes(suggestion.trim())) return '';

  const suggTokens = suggestion.split(/\s+/).filter(Boolean);
  const ctxTokens = context.split(/\s+/).filter(Boolean);
  if (suggTokens.length && ctxTokens.length) {
    const ctxSet = new Set(ctxTokens);
    const overlap = suggTokens.filter((t) => ctxSet.has(t)).length / suggTokens.length;
    if (overlap >= 0.8) return '';
  }
  return suggestion;
};

const extractText = (resp) => {
  if (!resp) return '';
  
  // First try to extract from candidates/parts (safest approach)
  const parts =
    resp?.response?.candidates?.[0]?.content?.parts ||
    resp?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    return parts.map((p) => p?.text || '').join('');
  }
  
  // Check finish_reason - if it's 1 (STOP) with no parts, return empty
  const finishReason = 
    resp?.response?.candidates?.[0]?.finishReason ||
    resp?.candidates?.[0]?.finishReason;
  if (finishReason && !parts?.length) {
    return '';
  }
  
  // Try .text accessor with try-catch (throws if no valid parts)
  try {
    const direct = resp.text || resp.output_text || resp.outputText;
    if (direct) return direct;
  } catch (e) {
    // .text accessor threw - response has no valid parts
  }
  
  try {
    const nested = resp.response;
    const nestedText = nested?.text || nested?.output_text || nested?.outputText;
    if (nestedText) return nestedText;
  } catch (e) {
    // nested .text accessor threw - response has no valid parts
  }
  
  return '';
};

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json({ error: 'Bad payload', detail: err.message }, { status: 400 });
  }

  // Build context, inserting a cursor marker when cursor + code provided
  let bodyForContext = body;
  try {
    if (body && typeof body === 'object' && body.cursor && typeof body.cursor === 'object' && typeof body.code === 'string') {
      const { line, column } = body.cursor;
      const lines = body.code.split(/\r?\n/);
      const li = Math.max(0, Math.min(lines.length - 1, (Number(line) || 1) - 1));
      const colIndex = Math.max(0, (Number(column) || 1) - 1);
      const targetLine = lines[li] || '';
      const insertAt = Math.max(0, Math.min(targetLine.length, colIndex));
      const newLine = targetLine.slice(0, insertAt) + '<<CURSOR>>' + targetLine.slice(insertAt);
      const newLines = [...lines];
      newLines[li] = newLine;
      bodyForContext = { ...body, code: newLines.join('\n') };
    }
  } catch (e) {
    bodyForContext = body;
  }

  const structured = buildStructuredContext(body?.contextBlocks);
  const rawContext = [structured, gatherContext(bodyForContext)].filter(Boolean).join('\n\n').trim();
  if (!rawContext) return NextResponse.json({ completion: '' }, { status: 200 });

  const context = trimContext(rawContext);
  const language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'plaintext';
  const prompt = buildPrompt(context, language, body?.cursor);

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: prompt,
        generationConfig: {
          maxOutputTokens: AI_COMPLETION_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        },
      }),
      COMPLETION_TIMEOUT_MS
    );
    const completionText = extractText(response);
    const cleaned = sanitize(completionText);
    const dedupedCleaned = suppressEcho(cleaned, typeof bodyForContext?.code === 'string' ? bodyForContext.code : '');

    // Extract JSON between <JSON>...</JSON> markers
    let parsed = null;
    try {
      const markerMatch = cleaned.match(/<JSON>[\s\S]*?<\/JSON>/i);
      if (markerMatch) {
        const jsonText = markerMatch[0].replace(/^<JSON>/i, '').replace(/<\/JSON>$/i, '');
        parsed = JSON.parse(jsonText);
      }
    } catch (e) {
      parsed = null;
    }

    // Strict fallback: if parse failed, return cleaned+deduped text so the UI still shows something.
    if (!parsed || typeof parsed !== 'object' || !('text' in parsed)) {
      console.warn('[completion] parse failed; returning cleaned text fallback', dedupedCleaned?.slice(0, 240));
      return NextResponse.json({ completion: dedupedCleaned || '' }, { status: 200 });
    }

    const dedupedParsed = suppressEcho(String(parsed.text || ''), typeof bodyForContext?.code === 'string' ? bodyForContext.code : '');
    const result = { completion: dedupedParsed };
    if (parsed.start && parsed.end) {
      try {
        const sLine = Number(parsed.start.line) || null;
        const sCol = Number(parsed.start.column) || null;
        const eLine = Number(parsed.end.line) || null;
        const eCol = Number(parsed.end.column) || null;
        if (sLine && sCol && eLine && eCol) {
          const lines = (bodyForContext && typeof bodyForContext.code === 'string') ? bodyForContext.code.split(/\r?\n/) : [];
          const maxLines = Math.max(1, lines.length);
          const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

          const sl = clamp(sLine, 1, maxLines);
          const el = clamp(eLine, 1, maxLines);
          const sc = clamp(sCol, 1, (lines[sl - 1] ? lines[sl - 1].length + 1 : 1));
          const ec = clamp(eCol, 1, (lines[el - 1] ? lines[el - 1].length + 1 : 1));

          const calcOffset = (ln, col) => {
            try { return lines.slice(0, ln - 1).reduce((acc, ln) => acc + ln.length + 1, 0) + (col - 1); } catch (e) { return 0; }
          };

          let startPos = { lineNumber: sl, column: sc };
          let endPos = { lineNumber: el, column: ec };
          const startOff = calcOffset(startPos.lineNumber, startPos.column);
          const endOff = calcOffset(endPos.lineNumber, endPos.column);
          if (endOff < startOff) endPos = startPos;

          result.suggestionRange = { start: startPos, end: endPos };
        }
      } catch (e) { /* ignore validation issues */ }
    }

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: 'Service error', detail: e.message }, { status: 502 });
  }
}
