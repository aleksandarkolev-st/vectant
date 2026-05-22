import { withInternalAiAuth } from '@/lib/internalAiAuth';

/**
 * Synthi Genome — GET /api/shadow/[jobId]/stream
 *
 * Server-sent-events proxy to the ai-engine. We forward the upstream
 * stream byte-for-byte so the browser sees a real SSE feed.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function GET(_request, { params }) {
    const { jobId } = await params;
    if (!jobId) {
        return new Response(JSON.stringify({ error: 'missing jobId' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }

    let upstream;
    try {
        upstream = await fetch(`${AI_ENGINE_BASE}/shadow/${encodeURIComponent(jobId)}/stream`, {
            headers: withInternalAiAuth({ accept: 'text/event-stream' }),
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e?.message || e) }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
        });
    }

    if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '');
        return new Response(text || 'upstream stream unavailable', {
            status: upstream.status || 502,
        });
    }

    return new Response(upstream.body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
            connection: 'keep-alive',
        },
    });
}
