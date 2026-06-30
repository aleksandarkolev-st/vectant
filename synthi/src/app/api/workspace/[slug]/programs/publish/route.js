import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canWriteScope } from '@/lib/integrations/scope';
import { canPublish } from '@/lib/programs/entitlements';
import { submitForReview, processSubmission } from '@/lib/programs/reviewOrchestrator';
import { discoverManifest } from '@/lib/programs/runtimeClient';

export const runtime = 'nodejs';

// POST /api/workspace/:slug/programs/publish
// Owner/admin (+ canPublish): submit this workspace's recipe + image ref to the
// review gate. The version is NOT listed until it reaches `published`.
export async function POST(req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (!(await canWriteScope(actor, { scope: 'workspace', workspaceSlug: slug }))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!canPublish(actor)) {
    return NextResponse.json({ error: 'publish_not_entitled' }, { status: 403 });
  }

  let body = {};
  try { body = (await req.json()) || {}; } catch { body = {}; }
  const sourceImageRef = typeof body.sourceImageRef === 'string' && body.sourceImageRef.trim() ? body.sourceImageRef.trim() : null;

  let discovered;
  try {
    // Pass the actor's workspaceUserId so per-user workspace repos resolve correctly.
    discovered = await discoverManifest(slug, actor.workspaceUserId);
  } catch (error) {
    if (error?.name === 'ProgramManifestError') {
      return NextResponse.json({ error: 'manifest_invalid', code: error.code, field: error.field, message: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'program_runtime_unreachable', message: error?.message || 'program runtime error' }, { status: 502 });
  }
  if (!discovered) {
    return NextResponse.json({ error: 'manifest_not_found' }, { status: 404 });
  }

  const submission = await submitForReview({
    workspaceSlug: slug,
    config: discovered.config,
    sourceImageRef,
    submittedByUserId: actor.userId,
  });

  // Image submissions come back queued (`submitted`); kick off processing without
  // blocking the response. The cron `process-pending` sweep is the durable backstop
  // if this instance dies mid-pipeline.
  if (submission?.reviewState === 'submitted' && submission.versionId) {
    void processSubmission(submission.versionId).catch(() => {});
  }

  return NextResponse.json({ submission });
}
