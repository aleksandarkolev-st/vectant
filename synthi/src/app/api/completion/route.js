import { NextResponse } from 'next/server';
import {
  AI_COMPLETION_MAX_INPUT_CHARS,
  AI_COMPLETION_STOP_SEQUENCE,
} from '@/lib/completion';
import { GoogleGenAI } from "@google/genai";

// Initialize the client with explicit API key from environment variable
const ai = new GoogleGenAI({apiKey: process.env.GEMINI_API_KEY});

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
    'You are a code assistant. Return ONLY a JSON object wrapped between the markers <JSON> and </JSON>. The content between the markers MUST be valid JSON. The JSON object must have the following fields:\n  - "text": string — the replacement text to insert at the requested location.\n  - "start": { "line": number, "column": number } or null — 1-based inclusive start position of the replacement.\n  - "end": { "line": number, "column": number } or null — 1-based inclusive end position of the replacement.\nIf no replacement is needed, return {"text": "", "start": null, "end": null}. Do NOT output any other text outside the <JSON>...</JSON> markers. Do not output any comments\n',
    `Language: ${language}`,
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

  const rawContext = gatherContext(bodyForContext);
  if (!rawContext) return NextResponse.json({ completion: '' }, { status: 200 });

  const context = trimContext(rawContext);
  const language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'plaintext';
  const prompt = buildPrompt(context, language, body?.cursor);

  try {
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash-lite', contents: prompt });
    const completionText = response.text || '';
    const cleaned = sanitize(completionText);

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

    // Strict fallback: if parse failed, return empty completion (avoid bad edits)
    if (!parsed || typeof parsed !== 'object' || !('text' in parsed)) {
      return NextResponse.json({ completion: '' }, { status: 200 });
    }

    const result = { completion: String(parsed.text || '') };
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