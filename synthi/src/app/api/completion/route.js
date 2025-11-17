import { NextResponse } from 'next/server';
import {
  AI_COMPLETION_MAX_INPUT_CHARS,
  AI_COMPLETION_STOP_SEQUENCE,
} from '@/lib/completion';

const STREAM_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:streamGenerateContent?key=AQ.Ab8RN6LLjx5TxSQcFesUti-r3nkAlrt1ETEkWNKMVqKZwRKRQQ`;

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

const buildPrompt = (context, language) =>
  [
    'You are an expert code completion assistant.',
    'Output only the code and nothing else.',
    `Language: ${language}`,
    'Use the context below and continue from the cursor position.',
    'Insert the stop marker exactly once at the end of your completion:',
    AI_COMPLETION_STOP_SEQUENCE,
    'Context:',
    context,
    'Completion:',
  ].join('\n');

const buildPayload = prompt => ({
  contents: [
    {
    "role": "user",
      parts: [{ text: prompt }],
    },
  ],
});

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

const formatParts = parts =>
  (parts || [])
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('');

const extractAgentText = chunk => {
  if (!chunk || typeof chunk !== 'object') return '';

  const candidates =
    chunk?.response?.candidates ||
    chunk?.candidates ||
    (Array.isArray(chunk?.content?.parts) ? [{ content: chunk.content }] : []);

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (candidate.content?.parts?.length) {
      const text = formatParts(candidate.content.parts);
      if (text) return text;
    }

    if (candidate.output && typeof candidate.output === 'string') {
      return candidate.output;
    }
  }

  if (chunk?.content?.parts?.length) {
    const text = formatParts(chunk.content.parts);
    if (text) return text;
  }

  if (typeof chunk.text === 'string') {
    return chunk.text;
  }

  return '';
};

const parseAgentStream = raw => {
  if (!raw) return '';

  const lines = raw.split(/\r?\n/);
  let out = '';

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    out += extractAgentText(parsed);

    if (
      parsed?.event === 'final' ||
      parsed?.response?.metadata?.is_final === true
    ) {
      break;
    }
  }

  return out;
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
  } catch (e) {
    return NextResponse.json(
      { error: 'Bad payload', detail: e.message },
      { status: 400 }
    );
  }

  const rawContext = gatherContext(body);
  if (!rawContext) {
    return NextResponse.json({ completion: '' }, { status: 200 });
  }

  const context = trimContext(rawContext);

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim()
      : 'plaintext';

  const prompt = buildPrompt(context, language);
  const payload = JSON.stringify(buildPayload(prompt));

  let response;
  try {
    response = await fetch(STREAM_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: payload,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'Service unreachable', detail: e.message },
      { status: 502 }
    );
  }

  const raw = await response.text();
  if (!response.ok) {
    return NextResponse.json(
      { error: 'Service error', detail: raw || 'No body' },
      { status: 502 }
    );
  }

  const parsed = parseAgentStream(raw);
  const cleaned = sanitize(parsed);
  const completion = cleaned || parsed || raw || '';

  return NextResponse.json({ completion });
}
