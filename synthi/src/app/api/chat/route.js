import { NextResponse } from 'next/server';

const encoder = new TextEncoder();
const OPENAI_BASE =
    (process.env.OPENAI_API_BASE || process.env.AI_PROXY_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const ANTHROPIC_BASE =
    (process.env.ANTHROPIC_API_BASE || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const GEMINI_BASE =
    (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

const DEFAULT_GEMINI_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const UPSTREAM_TIMEOUT_MS = 45_000;

const buildUserContent = ({ prompt, code, files, lang, focusPath }) => {
    const parts = [];
    if (prompt) parts.push(String(prompt));
    if (focusPath) parts.push(`Focus path: ${focusPath}`);
    if (lang) parts.push(`Language: ${lang}`);
    if (code) parts.push(`ACTIVE FILE:\n${code}`);
    if (Array.isArray(files)) {
        for (const file of files) {
            const name = file?.path || file?.name || 'file';
            const content =
                typeof file?.content === 'string'
                    ? file.content
                    : typeof file?.text === 'string'
                        ? file.text
                        : typeof file?.value === 'string'
                            ? file.value
                            : '';
            if (content) {
                parts.push(`FILE: ${name}\n${content}`);
            }
        }
    }
    return parts.filter(Boolean).join('\n\n').trim();
};

const streamOpenAI = async ({ model, apiKey, userContent, signal }) => {
    const key = apiKey || process.env.OPENAI_API_KEY || '';
    if (!key) throw new Error('OpenAI API key is not configured');
    const upstream = await fetch(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
            model: model || DEFAULT_OPENAI_MODEL,
            stream: true,
            messages: [{ role: 'user', content: userContent }],
        }),
        signal,
    });

    if (!upstream.ok || !upstream.body) {
        throw new Error(`Upstream error ${upstream.status}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    return new ReadableStream({
        async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
                controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                controller.close();
                return;
            }
            if (!value) return;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(Boolean);
            for (const raw of lines) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(line);
                    const delta = parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.text || '';
                    if (delta) {
                        controller.enqueue(encoder.encode(JSON.stringify({ delta }) + '\n'));
                    }
                    const finish = parsed?.choices?.[0]?.finish_reason;
                    if (finish) {
                        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                    }
                } catch (e) {
                    // ignore malformed lines
                }
            }
        },
        cancel() {
            try {
                reader.cancel();
            } catch (e) {}
        },
    });
};

const streamAnthropic = async ({ model, apiKey, userContent, signal }) => {
    const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!key) throw new Error('Anthropic API key is not configured');
    const upstream = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: model || DEFAULT_ANTHROPIC_MODEL,
            max_tokens: 4096,
            stream: true,
            messages: [{ role: 'user', content: userContent }],
        }),
        signal,
    });

    if (!upstream.ok || !upstream.body) {
        throw new Error(`Upstream error ${upstream.status}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    return new ReadableStream({
        async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
                controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                controller.close();
                return;
            }
            if (!value) return;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(Boolean);
            for (const raw of lines) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(line);
                    const textDelta =
                        parsed?.delta?.text ||
                        parsed?.content_block?.text ||
                        parsed?.content_block_delta?.text ||
                        parsed?.content?.[0]?.text ||
                        '';
                    if (textDelta) {
                        controller.enqueue(encoder.encode(JSON.stringify({ delta: textDelta }) + '\n'));
                    }
                    if (parsed?.stop_reason || parsed?.type === 'message_stop') {
                        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                    }
                } catch (e) {
                    // ignore malformed lines
                }
            }
        },
        cancel() {
            try {
                reader.cancel();
            } catch (e) {}
        },
    });
};

const streamGemini = async ({ model, apiKey, userContent, signal }) => {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) {
        throw new Error('Gemini API key is not configured');
    }
    const targetModel = model || DEFAULT_GEMINI_MODEL;
    const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:streamGenerateContent?alt=sse&key=${key}`;

    const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
        },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            generationConfig: { maxOutputTokens: 4096, temperature: 0.2 },
        }),
        signal,
    });

    if (!upstream.ok || !upstream.body) {
        throw new Error(`Upstream error ${upstream.status}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return new ReadableStream({
        async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
                controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                controller.close();
                return;
            }
            if (!value) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const raw of lines) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(line);
                    const candidate = parsed?.candidates?.[0] || {};
                    const contentParts = candidate?.content?.parts || [];
                    const deltaParts = candidate?.delta?.content || candidate?.delta?.parts || [];
                    const textDelta =
                        contentParts.map((p) => p?.text || '').join('') ||
                        deltaParts.map((p) => (p?.parts ? p.parts.map((x) => x?.text || '').join('') : p?.text || '')).join('');
                    if (textDelta) {
                        controller.enqueue(encoder.encode(JSON.stringify({ delta: textDelta }) + '\n'));
                    }
                    if (candidate?.finishReason) {
                        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                    }
                } catch (e) {
                    // ignore malformed lines
                }
            }
        },
        cancel() {
            try {
                reader.cancel();
            } catch (e) {}
        },
    });
};

const withTimeoutSignal = (requestSignal, timeoutMs = UPSTREAM_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error('upstream-timeout'));
    }, timeoutMs);

    if (requestSignal) {
        const onAbort = () => {
            controller.abort(requestSignal.reason || new Error('client-abort'));
        };
        try {
            requestSignal.addEventListener('abort', onAbort, { once: true });
        } catch (e) {
            /* ignore */
        }
    }

    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
    };
};

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const {
        prompt = '',
        code = '',
        files = [],
        lang = 'plaintext',
        focusPath = '',
        model = '',
        apiKey = '',
        provider = '',
    } = body || {};

    const userContent = buildUserContent({ prompt, code, files, lang, focusPath });
    if (!userContent) {
        return NextResponse.json({ error: 'Empty prompt' }, { status: 400 });
    }

    const useAnthropic =
        provider.toLowerCase() === 'anthropic' || String(model || '').toLowerCase().includes('claude');
    const useOpenAI =
        provider.toLowerCase() === 'openai' ||
        String(model || '').toLowerCase().includes('gpt') ||
        String(model || '').toLowerCase().includes('o1');

    const { signal, dispose } = withTimeoutSignal(request.signal);

    try {
        const stream = await (useAnthropic
            ? streamAnthropic({ model, apiKey, userContent, signal })
            : useOpenAI
                ? streamOpenAI({ model, apiKey, userContent, signal })
                : streamGemini({ model, apiKey, userContent, signal }));

        return new NextResponse(stream, {
            headers: {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-cache',
            },
        });
    } catch (e) {
        const isTimeout = String(e?.message || '').includes('timeout');
        const status = String(e?.message || '').includes('401') ? 401 : 502;
        return NextResponse.json(
            { error: isTimeout ? 'Upstream timeout' : 'Upstream failure', detail: e?.message || 'stream failed' },
            { status }
        );
    } finally {
        dispose();
    }
}
