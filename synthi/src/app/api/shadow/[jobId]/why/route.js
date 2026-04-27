import { NextResponse } from 'next/server';

/**
 * Synthi Genome — POST /api/shadow/[jobId]/why
 *
 * `[Why?]` follow-up. Forwards a user question to the ai-engine, which
 * re-runs the Arbiter against its cached evidence bundle. The response
 * is a fresh verdict the frontend can render with the same components.
 *
 * Master plan §22.
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
    const question = typeof body?.question === 'string' ? body.question : '';
    if (!question.trim()) {
        return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }

    try {
        const res = await fetch(
            `${AI_ENGINE_BASE}/shadow/${encodeURIComponent(jobId)}/why`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ question }),
            }
        );
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
