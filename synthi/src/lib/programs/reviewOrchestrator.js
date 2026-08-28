/**
 * @fileoverview Drives the community-app review state machine, autonomously.
 *   submitted → scanning → pending_review                     (AI off, manual)
 *   submitted → scanning → ai_review → pending_review         (AI: uncertain middle)
 *   submitted → scanning → ai_review → approved → rehosting → published  (AI auto-approve)
 *   submitted → scanning → ai_review → rejected               (AI auto-reject)
 *   submitted → rejected                                      (hard-gate fail)
 *   scanning  → rejected                                      (over-threshold CVE)
 *   pending_review → approved → rehosting → published         (admin approve)
 *   pending_review → rejected                                 (admin reject)
 *
 * Execution is HYBRID: no-image (web/CLI/TUI) submissions run the pipeline
 * inline; image (container/GUI) submissions are queued (`submitted`) and driven
 * by `processSubmission` (fire-and-forget from the publish route + a cron sweep).
 * `runPipeline` is idempotent/resumable via guarded store transitions, so a
 * double-trigger never double-publishes. Deps are injected so unit tests never
 * touch prisma/trivy/crane/ai-engine. The AI layer is advisory + fail-closed:
 * hard gates + CVE scan run first and the AI never overrides a static reject.
 */

import * as storeModule from './store';
import { runHardGates } from './hardGates';
import { scanImage } from './imageScanner';
import { evaluateImageSize } from './imageSize';
import { reHostImage, communityImageTarget, pinManifestImage } from './reHoster';
import { assessSubmission, aiDecision } from './aiReviewer';

const IMAGE_RUNTIME_TYPES = new Set(['container', 'gui']);
const NONTERMINAL_QUEUEABLE = new Set(['submitted', 'scanning', 'ai_review']);

function defaultDeps() {
  return {
    store: storeModule,
    hardGates: runHardGates,
    scanner: scanImage,
    sizer: evaluateImageSize,
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
 * Terminal step after a clean scan. AI off → pending_review. AI on → ai_review →
 * three-way decision: auto-approve (publish), auto-reject (with reasons), else
 * the human queue.
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

  const decision = aiDecide(ai, config);
  if (decision === 'auto_approve') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'approved', actorUserId: 'system' });
    await store.transitionReview(versionId, { fromState: 'approved', toState: 'rehosting', actorUserId: 'system' });
    const row = await store.getReviewVersionById(versionId);
    return rehostAndPublish(row, JSON.parse(row.manifestJson), 'system', deps);
  }
  if (decision === 'auto_reject') {
    await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'rejected', actorUserId: 'system', reason: [{ code: 'ai_auto_reject', message: (ai.flags || []).join(', ') || 'high risk' }], patch: { aiRiskJson } });
    return { versionId, reviewState: 'rejected', reasons: [{ code: 'ai_auto_reject' }] };
  }
  await store.transitionReview(versionId, { fromState: 'ai_review', toState: 'pending_review', actorUserId: null, patch: { aiRiskJson } });
  return { versionId, reviewState: 'pending_review' };
}

/**
 * Run the full pipeline for a created submission: hard gates → CVE scan →
 * AI/decide. Idempotent via guarded transitions, so re-driving an already-
 * advanced row is safe.
 */
async function runPipeline(versionId, { config, sourceImageRef }, deps) {
  const { store, hardGates, scanner, sizer } = deps;
  const gate = hardGates({ config, sourceImageRef });
  if (!gate.ok) {
    await store.transitionReview(versionId, { fromState: 'submitted', toState: 'rejected', actorUserId: null, reason: gate.reasons });
    return { versionId, reviewState: 'rejected', reasons: gate.reasons };
  }
  await store.transitionReview(versionId, { fromState: 'submitted', toState: 'scanning', actorUserId: null });

  let scanSummary = null;
  let scanPatch = {};
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    const scan = await scanner(sourceImageRef, {});
    scanSummary = scan.summary;
    scanPatch = { scanReportJson: JSON.stringify(scan.summary || {}) };
    if (!scan.ok) {
      await store.transitionReview(versionId, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason: [{ code: 'cve_over_threshold', message: 'image failed CVE scan' }], patch: scanPatch });
      return { versionId, reviewState: 'rejected', reasons: [{ code: 'cve_over_threshold' }] };
    }

    // Deterministic size gate: reject oversized (or unmeasurable) images before the
    // AI ever sees them. Fail-closed like the CVE gate — see imageSize.js.
    const size = await sizer(sourceImageRef, {});
    if (!size.ok) {
      const reason = size.summary?.error
        ? [{ code: 'image_size_error', message: `could not determine image size: ${size.summary.error}` }]
        : [{ code: 'image_too_large', message: `image exceeds size limit (${size.summary.sizeBytes} > ${size.summary.limitBytes} bytes)` }];
      await store.transitionReview(versionId, { fromState: 'scanning', toState: 'rejected', actorUserId: null, reason, patch: scanPatch });
      return { versionId, reviewState: 'rejected', reasons: reason };
    }
  }
  return finishAfterScan(versionId, { config, sourceImageRef, scanSummary, scanPatch }, deps);
}

/**
 * Submit a community app. Always records the submission; then HYBRID-routes:
 * no-image → run the pipeline inline (fast); image → return queued (`submitted`)
 * for the worker (`processSubmission`) to drive.
 */
export async function submitForReview({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }, deps = defaultDeps()) {
  const { store } = deps;
  const { version } = await store.createSubmission({ workspaceSlug, config, sourceImageRef, submittedByUserId });
  if (IMAGE_RUNTIME_TYPES.has(config.runtimeType) && sourceImageRef) {
    return { versionId: version.id, reviewState: 'submitted' };
  }
  return runPipeline(version.id, { config, sourceImageRef }, deps);
}

/**
 * Worker entry: drive one queued/in-flight submission toward a terminal state.
 * Resumable — a row already in a human queue or terminal state is left untouched.
 */
export async function processSubmission(versionId, deps = defaultDeps()) {
  const { store } = deps;
  const row = await store.getReviewVersionById(versionId);
  if (!row) return { error: 'not_found' };
  if (!NONTERMINAL_QUEUEABLE.has(row.reviewState)) return { versionId, reviewState: row.reviewState };
  return runPipeline(versionId, { config: JSON.parse(row.manifestJson), sourceImageRef: row.sourceImageRef }, deps);
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
