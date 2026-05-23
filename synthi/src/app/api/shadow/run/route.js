import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import { withInternalAiAuth } from '@/lib/internalAiAuth';

/**
 * Synthi Genome — POST /api/shadow/run
 *
 * Forwards a shadow-run request to the ai-engine. Returns
 * `{ jobId, tier, estimated_cost_usd }`.
 *
 * Wave 1 of synthi-genome-master-plan.md.
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
    } catch (_) {
        // Tolerate auth misconfig — Wave 1 just logs and proceeds without identity.
    }

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
        const res = await fetch(`${AI_ENGINE_BASE}/shadow/run`, {
            method: 'POST',
            headers: withInternalAiAuth({ 'content-type': 'application/json' }),
            body: JSON.stringify({
                workspace_path: body.workspace_path,
                conversation_id: body.conversation_id || null,
                intent: body.intent || 'fix',
                user_request: body.user_request || '',
                patches: body.patches,
                tier: body.tier || 'standard',
                user_id: userId,
                models: body.models || null,
            }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            return NextResponse.json({ error: json?.detail || 'ai-engine error', status: res.status }, { status: 502 });
        }
        return NextResponse.json(json);
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
