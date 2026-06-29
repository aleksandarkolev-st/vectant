/**
 * @fileoverview Drives the community-app review state machine (Phase 1, no AI):
 *   submitted → scanning → pending_review        (clean)
 *   submitted → rejected                         (hard-gate fail)
 *   scanning  → rejected                         (over-threshold CVE)
 *   pending_review → approved → rehosting → published   (admin approve)
 *   pending_review → rejected                    (admin reject)
 * Deps are injected so the unit tests never touch prisma/trivy/crane. Approval
 * enforces admin ≠ submitter. The published manifest is pinned to the AR digest
 * so installers run exactly what we reviewed.
 */

import * as storeModule from './store';
import { runHardGates } from './hardGates';
import { scanImage } from './imageScanner';
import { reHostImage, communityImageTarget, pinManifestImage } from './reHoster';

const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);

function defaultDeps() {
  return {
    store: storeModule,
    hardGates: runHardGates,
    scanner: scanImage,
    reHost: reHostImage,
    target: communityImageTarget,
    pin: pinManifestImage,
  };
}

/** Submit a community app: hard gates → (scan) → pending_review | rejected. */
export async function submitForReview({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }, deps = defaultDeps()) {
  const { store, hardGates, scanner } = deps;
  const { version } = await store.createSubmission({ workspaceSlug, config, sourceImageRef, submittedByUserId });

  const gate = hardGates({ config, sourceImageRef });
  if (!gate.ok) {
    await store.transitionReview(version.id, { fromState: 'submitted', toState: 'rejected', actorUserId: null, reason: gate.reasons });
    return { versionId: version.id, reviewState: 'rejected', reasons: gate.reasons };
  }

  await store.transitionReview(version.id, { fromState: 'submitted', toState: 'scanning', actorUserId: null });

  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    const scan = await scanner(sourceImageRef, {});
    const patch = { scanReportJson: JSON.stringify(scan.summary || {}) };
    if (!scan.ok) {
      await store.transitionReview(version.id, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason: [{ code: 'cve_over_threshold', message: 'image failed CVE scan' }], patch });
      return { versionId: version.id, reviewState: 'rejected', reasons: [{ code: 'cve_over_threshold' }] };
    }
    await store.transitionReview(version.id, { fromState: 'scanning', toState: 'pending_review', actorUserId: null, patch });
    return { versionId: version.id, reviewState: 'pending_review' };
  }

  await store.transitionReview(version.id, { fromState: 'scanning', toState: 'pending_review', actorUserId: null });
  return { versionId: version.id, reviewState: 'pending_review' };
}

/** Admin approve: rehost (if image) + pin manifest + publish. Admin ≠ submitter. */
export async function approveSubmission({ versionId, adminUserId }, deps = defaultDeps()) {
  const { store, reHost, target, pin } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (row.submittedByUserId && row.submittedByUserId === adminUserId) return { error: 'self_review_forbidden' };
  if (row.reviewState !== 'pending_review') return { error: 'invalid_state', reviewState: row.reviewState };

  await store.transitionReview(versionId, { fromState: 'pending_review', toState: 'approved', actorUserId: adminUserId });
  await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: adminUserId });

  const config = JSON.parse(row.manifestJson);
  let hostedImageDigest = null;
  let publishedConfig = config;
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && row.sourceImageRef) {
    const dst = target({ publisher: row.program.publisher, packageId: config.packageId });
    const { ref, digest } = await reHost(row.sourceImageRef, dst, {});
    hostedImageDigest = digest;
    publishedConfig = pin(config, row.sourceImageRef, ref);
  }

  await store.publishApprovedVersion(versionId, {
    programId: row.program.id, version: row.version, actorUserId: adminUserId,
    hostedImageDigest, publishedManifestJson: JSON.stringify(publishedConfig),
  });
  return { versionId, reviewState: 'published', hostedImageDigest };
}

/** Admin reject: record notes + transition to rejected. */
export async function rejectSubmission({ versionId, adminUserId, notes = '' }, deps = defaultDeps()) {
  const { store } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (row.reviewState !== 'pending_review') return { error: 'invalid_state', reviewState: row.reviewState };
  await store.transitionReview(versionId, { fromState: 'pending_review', toState: 'rejected', actorUserId: adminUserId, reason: [{ code: 'manual_reject', message: notes }], patch: { reviewNotes: notes } });
  return { versionId, reviewState: 'rejected' };
}
