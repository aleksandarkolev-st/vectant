import { NextResponse } from 'next/server';
import { withInternalAiAuth } from '@/lib/internalAiAuth';

/**
 * Synthi Genome — POST /api/shadow/[jobId]/apply
 *
 * Forwards apply requests to the ai-engine. Wave 1 returns the
 * ai-engine's structured `{ applied, files, merge_strategy }` response;
 * actual Yjs-aware merging is handled by the collab-server endpoint
 * that the frontend hits next (master plan §8.4).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function POST(request, { params }) {
    const { jobId } = await params;
    let body = {};
    try {
        body = await request.json();
    } catch (_) {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body?.universeId) {
        return NextResponse.json({ error: 'universeId is required' }, { status: 400 });
    }

    try {
        const res = await fetch(
            `${AI_ENGINE_BASE}/shadow/${encodeURIComponent(jobId)}/apply`,
            {
                method: 'POST',
                headers: withInternalAiAuth({ 'content-type': 'application/json' }),
                body: JSON.stringify({ universeId: body.universeId }),
            }
        );
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
