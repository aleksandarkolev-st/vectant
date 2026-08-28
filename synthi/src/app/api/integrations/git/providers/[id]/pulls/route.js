// pulls/route.js
import { loadOwnedProvider, respond } from '@/lib/git/routeHelpers.js';
import { attachProofBundleCommit } from '@/lib/codesite/controlPlane.js';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function POST(req, { params }) {
  const { id } = await params; const g = await loadOwnedProvider(id); if (g.error) return g.error;
  const b = await req.json().catch(() => ({}));
  if (!b.repo || !b.sourceBranch || !b.targetBranch || !b.title) return NextResponse.json({ error: 'repo, sourceBranch, targetBranch, title required' }, { status: 400 });
  let proof = null;
  try {
    proof = await verifyCodeSitePullRequestBoundary(b, g.actor);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  return respond(await g.adapter.createPullRequest(g.conn, {
    repo: b.repo,
    sourceBranch: b.sourceBranch,
    targetBranch: b.targetBranch,
    title: b.title,
    body: codeSitePullRequestBody(b.body || '', proof),
  }), 201);
}

async function verifyCodeSitePullRequestBoundary(body = {}, actor = null) {
  const input = body.codeSite || body.codesite || body.code_site || null;
  const proofBundleId = input?.proofBundleId || input?.proof_bundle_id || body.proofBundleId || body.proof_bundle_id || null;
  const workspaceSlug = input?.workspaceSlug || input?.workspace_slug || body.workspaceSlug || body.workspace_slug || null;
  const commitSha = input?.commitSha || input?.commit_sha || body.commitSha || body.commit_sha || null;
  const commitMessage = input?.commitMessage || input?.commit_message || body.commitMessage || body.commit_message || null;
  const trailers = input?.trailers || input?.commitTrailers || input?.commit_trailers || body.trailers || body.commitTrailers || body.commit_trailers || null;
  const evidenceRefs = input?.evidenceRefs || input?.evidence_refs || body.evidenceRefs || body.evidence_refs || [];
  const hasCodeSiteContext = Boolean(input || proofBundleId || workspaceSlug || commitSha || commitMessage || trailers);
  if (!hasCodeSiteContext) return null;
  if (!workspaceSlug || !proofBundleId || !commitSha || (!commitMessage && !trailers)) {
    throw NextResponse.json({
      error: 'codesite_proof_context_required',
      message: 'CodeSite PR creation requires workspaceSlug, proofBundleId, commitSha, and commitMessage or commit trailers.',
    }, { status: 400 });
  }
  try {
    return await attachProofBundleCommit(workspaceSlug, proofBundleId, {
      commitSha,
      commitMessage,
      trailers,
      evidenceRefs,
    }, actor);
  } catch (error) {
    if (error instanceof Response) throw error;
    throw NextResponse.json({
      error: error?.code || 'codesite_proof_verification_failed',
      message: error?.message || 'CodeSite proof verification failed.',
      detail: error?.detail,
    }, { status: error?.status || 422 });
  }
}

function codeSitePullRequestBody(body, proof) {
  if (!proof) return body;
  const footer = [
    '',
    'CodeSite proof',
    `- Proof bundle: ${proof.id}`,
    `- Commit: ${proof.commitSha}`,
    proof.bundleDigest ? `- Bundle digest: ${proof.bundleDigest}` : null,
    proof.trailers?.['CodeSite-Proof-Digest'] ? `- Proof digest: ${proof.trailers['CodeSite-Proof-Digest']}` : null,
  ].filter(Boolean).join('\n');
  return `${String(body || '').trim()}${footer}`;
}
