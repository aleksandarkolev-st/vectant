/**
 * @fileoverview Drives the community-app review state machine.
 *   submitted → scanning → pending_review                     (Phase 1, AI off)
 *   submitted → scanning → ai_review → pending_review         (Phase 2, manual triage)
 *   submitted → scanning → ai_review → approved → rehosting → published  (Phase 2, auto)
 *   submitted → rejected                                      (hard-gate fail)
 *   scanning  → rejected                                      (over-threshold CVE)
 *   pending_review → approved → rehosting → published         (admin approve)
 *   pending_review → rejected                                 (admin reject)
 * Deps are injected so unit tests never touch prisma/trivy/crane/ai-engine.
 * The AI layer (PROGRAM_AI_REVIEW_ENABLED) is advisory + fail-closed: hard gates
 * + CVE scan still run first, and any AI failure → manual review. Approval (human
 * or auto) shares ONE re-host-by-digest + pin + publish path so installers always
 * run exactly what we reviewed. Approval enforces admin ≠ submitter.
 */

import * as storeModule from './store';
import { runHardGates } from './hardGates';
import { scanImage } from './imageScanner';
import { reHostImage, communityImageTarget, pinManifestImage } from './reHoster';
import { assessSubmission, aiDecision } from './aiReviewer';

const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);

function defaultDeps() {
  return {
    store: storeModule,
    hardGates: runHardGates,
    scanner: scanImage,
    reHost: reHostImage,
    target: communityImageTarget,
    pin: pinManifestImage,
    aiReview: assessSubmission,
    aiDecide: aiDecision,
    aiEnabled: process.env.PROGRAM_AI_REVIEW_ENABLED === 'true',
  };
}

/** Shared tail: re-host (if image) by digest, pin the manifest, publish. */
async function rehostAndPublish(row, config, actorUserId, deps) {
  const { store, reHost, target, pin } = deps;
  let hostedImageDigest = null;
  let publishedConfig = config;
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && row.sourceImageRef) {
    const dst = target({ publisher: row.program.publisher, packageId: config.packageId });
    const { ref, digest } = await reHost(row.sourceImageRef, dst, {});
    hostedImageDigest = digest;
    publishedConfig = pin(config, row.sourceImageRef, ref);
  }
  await store.publishApprovedVersion(row.id, {
    programId: row.program.id, version: row.version, actorUserId,
    hostedImageDigest, publishedManifestJson: JSON.stringify(publishedConfig),
  });
  return { versionId: row.id, reviewState: 'published', hostedImageDigest };
}

/**
 * Terminal step after a clean scan. Phase 1 (AI off) → pending_review. Phase 2
 * (AI on) → ai_review → conservative auto-approve, else pending_review.
 */
async function finishAfterScan(versionId, { config, sourceImageRef, scanSummary, scanPatch = {} }, deps) {
  const { store, aiReview, aiDecide, aiEnabled } = deps;
  if (!aiEnabled) {
    await store.transitionReview(versionId, { fromState: 'scanning', toState: 'pending_review', actorUserId: null, patch: scanPatch });
    return { versionId, reviewState: 'pending_review' };
  }

  const ai = await aiReview({ config, scanSummary, sourceImageRef, description: config.description || '' });
  const aiRiskJson = JSON.stringify(ai);
  await store.transitionReview(versionId, { fromState: 'scanning', toState: 'ai_review', actorUserId: null, patch: { ...scanPatch, aiRiskJson } });

  if (aiDecide(ai, config) === 'auto_approve') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'approved', actorUserId: 'system' });
    await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: 'system' });
    const row = await store.getReviewVersionById(versionId);
    return rehostAndPublish(row, JSON.parse(row.manifestJson), 'system', deps);
  }

  await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'pending_review', actorUserId: null, patch: { aiRiskJson } });
  return { versionId, reviewState: 'pending_review' };
}

/** Submit a community app: hard gates → (scan) → [AI] → pending_review | published | rejected. */
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
    const scanPatch = { scanReportJson: JSON.stringify(scan.summary || {}) };
    if (!scan.ok) {
      await store.transitionReview(version.id, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason: [{ code: 'cve_over_threshold', message: 'image failed CVE scan' }], patch: scanPatch });
      return { versionId: version.id, reviewState: 'rejected', reasons: [{ code: 'cve_over_threshold' }] };
    }
    return finishAfterScan(version.id, { config, sourceImageRef, scanSummary: scan.summary, scanPatch }, deps);
  }

  return finishAfterScan(version.id, { config, sourceImageRef, scanSummary: null, scanPatch: {} }, deps);
}

/** Admin approve: rehost (if image) + pin manifest + publish. Admin ≠ submitter. */
export async function approveSubmission({ versionId, adminUserId }, deps = defaultDeps()) {
  const { store } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (row.submittedByUserId && row.submittedByUserId === adminUserId) return { error: 'self_review_forbidden' };
  if (row.reviewState !== 'pending_review') return { error: 'invalid_state', reviewState: row.reviewState };

  await store.transitionReview(versionId, { fromState: 'pending_review', toState: 'approved', actorUserId: adminUserId });
  await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: adminUserId });
  return rehostAndPublish(row, JSON.parse(row.manifestJson), adminUserId, deps);
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
