import { NextResponse } from 'next/server';

/**
 * Synthi Genome — /api/shadow/cost
 *
 * GET  → fetch the per-workspace cost dashboard snapshot.
 * POST → update the daily cap.
 *
 * Master plan §17 + §22.
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
            `${AI_ENGINE_BASE}/shadow/cost/state?workspace_path=${encodeURIComponent(workspace_path)}`,
            { method: 'GET' }
        );
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}

export async function POST(request) {
    let body = {};
    try {
        body = await request.json();
    } catch (_) {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body?.workspace_path || typeof body.daily_cap_usd !== 'number') {
        return NextResponse.json(
            { error: 'workspace_path and numeric daily_cap_usd are required' },
            { status: 400 }
        );
    }
    try {
        const res = await fetch(`${AI_ENGINE_BASE}/shadow/cost/cap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                workspace_path: body.workspace_path,
                daily_cap_usd: body.daily_cap_usd,
            }),
        });
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
