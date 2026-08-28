import { NextResponse } from 'next/server';
import { withInternalAiAuth } from '@/lib/internalAiAuth';
import { resolveActor } from '@/lib/integrations/session';

/**
 * Synthi Genome — POST /api/shadow/[jobId]/cancel
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function POST(_request, { params }) {
    const actor = await resolveActor();
    if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { jobId } = await params;
    try {
        const res = await fetch(
            `${AI_ENGINE_BASE}/shadow/${encodeURIComponent(jobId)}/cancel`,
            { method: 'POST', headers: withInternalAiAuth() }
        );
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
