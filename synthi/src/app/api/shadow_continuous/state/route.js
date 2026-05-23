import { NextResponse } from 'next/server';
import { withInternalAiAuth } from '@/lib/internalAiAuth';

/**
 * GET /api/shadow_continuous/state?workspace_path=...
 *
 * Snapshot of the watcher state for a workspace: last findings,
 * pending paths, debounce window, opt-out + spend.
 *
 * Master plan §14 + §17.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function GET(request) {
    const url = new URL(request.url);
    const workspace_path = url.searchParams.get('workspace_path');
    if (!workspace_path) {
        return NextResponse.json({ error: 'workspace_path is required' }, { status: 400 });
    }
    try {
        const res = await fetch(
            `${AI_ENGINE_BASE}/shadow_continuous/${encodeURIComponent(workspace_path)}/state`,
            { method: 'GET', headers: withInternalAiAuth() }
        );
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
