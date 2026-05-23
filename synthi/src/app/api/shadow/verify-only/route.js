import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import { withInternalAiAuth } from '@/lib/internalAiAuth';

/**
 * Synthi Genome — POST /api/shadow/verify-only
 *
 * "Verify-only" mode (master plan §22). Runs lint/type/tests on the
 * user's own edits with no LLM in the loop. Returns the same
 * `{ jobId, tier }` envelope as /shadow/run so the frontend can
 * subscribe to the same SSE stream.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function POST(request) {
    let userId = null;
    try {
        const session = await getServerSession(authOptions);
        userId = session?.user?.id || session?.user?.email || null;
    } catch (_) { /* tolerate */ }

    let body;
    try {
        body = await request.json();
    } catch (_) {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }

    if (!body?.workspace_path || !Array.isArray(body?.patches) || body.patches.length === 0) {
        return NextResponse.json(
            { error: 'workspace_path and non-empty patches[] are required' },
            { status: 400 }
        );
    }

    try {
        const res = await fetch(`${AI_ENGINE_BASE}/shadow/verify-only`, {
            method: 'POST',
            headers: withInternalAiAuth({ 'content-type': 'application/json' }),
            body: JSON.stringify({
                workspace_path: body.workspace_path,
                patches: body.patches,
                tier: body.tier || 'quick',
                user_id: userId,
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            return NextResponse.json({ error: json?.detail || 'ai-engine error' }, { status: 502 });
        }
        return NextResponse.json(json);
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
