/**
 * API endpoint for approving/rejecting pending AI command executions.
 * 
 * Handles two types of commands:
 * 1. LIVE commands — tool loop is blocked waiting for approval. We resolve
 *    the pending Promise so the tool loop continues.
 * 2. DEFERRED commands — git write commands (add/commit/push) that were
 *    deferred until after the user reviewed FILE: blocks. On approval,
 *    this endpoint executes them directly.
 */
import { NextResponse } from 'next/server';
import { pendingCommandApprovals, deferredCommandsMap } from '../route.js';
import { executeTool } from '../toolDefinitions.js';

export async function POST(request) {
    try {
        const body = await request.json();
        const { id, approved } = body || {};

        if (!id) {
            return NextResponse.json({ error: 'Missing command ID' }, { status: 400 });
        }

        // ── Case 1: Live command (tool loop is blocked waiting) ──
        const pending = pendingCommandApprovals.get(id);
        if (pending) {
            pending.resolve(Boolean(approved));
            pendingCommandApprovals.delete(id);
            return NextResponse.json({ ok: true, approved: Boolean(approved) });
        }

        // ── Case 2: Deferred command (git write, execute on approval) ──
        const deferred = deferredCommandsMap.get(id);
        if (deferred) {
            deferredCommandsMap.delete(id);
            if (!approved) {
                return NextResponse.json({ ok: true, approved: false, deferred: true });
            }
            // Execute the git command now that the user has approved
            try {
                const result = await executeTool(
                    'run_command',
                    { command: deferred.command },
                    deferred.workspacePath,
                    AbortSignal.timeout(35000),
                );
                return NextResponse.json({
                    ok: true,
                    approved: true,
                    deferred: true,
                    result,
                });
            } catch (execErr) {
                return NextResponse.json({
                    ok: false,
                    error: `Command execution failed: ${execErr.message}`,
                    deferred: true,
                }, { status: 500 });
            }
        }

        return NextResponse.json(
            { error: 'No pending command found (may have timed out)' },
            { status: 404 }
        );
    } catch (e) {
        return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }
}
