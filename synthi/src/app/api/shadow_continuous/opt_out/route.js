import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AI_ENGINE_BASE =
    process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

export async function POST(request) {
    let body = {};
    try {
        body = await request.json();
    } catch (_) {
        return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body?.workspace_path || typeof body?.opted_out !== 'boolean') {
        return NextResponse.json(
            { error: 'workspace_path and boolean opted_out are required' },
            { status: 400 }
        );
    }
    try {
        const res = await fetch(`${AI_ENGINE_BASE}/shadow_continuous/opt_out`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return NextResponse.json(json, { status: res.status });
    } catch (e) {
        return NextResponse.json({ error: String(e?.message || e) }, { status: 502 });
    }
}
