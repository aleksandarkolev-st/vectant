import { asArray, productCopy, uniqueValues } from "./format";
import {
  actionEntityId,
  actionKind,
  documentLabel,
  documentNeedsReview,
  incidentNeedsResume,
  maydayResumeInspectionRefs,
  routeRevisionCanApply,
  routeRevisionCanReview,
} from "./governance";

/**
 * Payload builders for queueGovernanceAction.
 *
 * Both the console's buttons and the required-action pending-target path call
 * these, so the two cannot drift. Every field here is byte-identical to the
 * inline literal it replaced in GovernanceConsole.
 */

export function documentReviewAction(document, decision, { onReviewDocument }) {
  const verb = decision === "approved" ? "Approve" : "Reject";
  return {
    kind: "document_review",
    title: `${verb} ${documentLabel(document)}`,
    entity: document.id,
    owner: document.fromSessionId || document.fromSession || "coordinator",
    severity: decision === "approved" ? (document.blocking ? "high" : "medium") : "high",
    evidenceRefs: uniqueValues([
      ...asArray(document.evidenceRefs),
      `codesite:ui:document-review:${document.id}`,
    ]),
    execute: (rationale) => onReviewDocument(document, decision, rationale),
  };
}

export function routeReviewAction(revision, { onReviewRouteRevision }) {
  return {
    kind: "route_revision_review",
    title: "Approve plan change",
    entity: revision.id,
    owner: revision.displayCallsign || revision.executionPlanId,
    severity: "high",
    scope: revision.proposedRoute,
    evidenceRefs: uniqueValues([
      ...asArray(revision.evidenceRefs),
      `codesite:ui:route-review:${revision.id}`,
    ]),
    execute: (rationale) => onReviewRouteRevision(revision, "approved", rationale),
  };
}

export function routeApplyAction(revision, { onApplyRouteRevision }) {
  return {
    kind: "route_revision_apply",
    title: "Apply plan change",
    entity: revision.id,
    owner: revision.displayCallsign || revision.executionPlanId,
    severity: "critical",
    scope: revision.proposedRoute,
    evidenceRefs: uniqueValues([
      ...asArray(revision.evidenceRefs),
      `codesite:ui:route-apply:${revision.id}`,
    ]),
    execute: (rationale) => onApplyRouteRevision(revision, rationale),
  };
}

export function maydayResumeAction(incident, inspectionRunIds, { onResumeMayday }) {
  return {
    kind: "mayday_resume",
    title: `Resume ${productCopy(incident.category, "paused incident")}`,
    entity: incident.id,
    owner: asArray(incident.participants)[0] || "coordinator",
    severity: "critical",
    scope: incident.affectedZones,
    evidenceRefs: uniqueValues([
      ...asArray(incident.evidenceRefs),
      incident.replayDigest,
      `codesite:ui:mayday-resume:${incident.id}`,
    ]),
    execute: (rationale) => onResumeMayday(incident, inspectionRunIds, rationale),
  };
}

/**
 * Ordered candidate descriptors for a required action, mirroring the branch order
 * of the handler this replaces: document, then route, then mayday.
 */
export function governanceReviewCandidates(action) {
  const kind = actionKind(action);
  const entityId = actionEntityId(action);
  const candidates = [];

  if (action?.documentId || /document|rfi|change_order/.test(kind)) {
    candidates.push({
      entity: "document",
      entityId: action?.documentId || entityId,
      intent: "approve",
    });
  }
  if (action?.routeRevisionId || /route|reroute/.test(kind)) {
    const id = action?.routeRevisionId || entityId;
    // Apply first, matching the original preference; review is the fallback.
    candidates.push({ entity: "routeRevision", entityId: id, intent: "apply" });
    candidates.push({ entity: "routeRevision", entityId: id, intent: "review" });
  }
  if (action?.incidentId || /mayday|ground|resume/.test(kind)) {
    candidates.push({
      entity: "incident",
      entityId: action?.incidentId || entityId,
      intent: "resume",
    });
  }
  return candidates;
}

function candidateIsActionable(candidate, data) {
  const { documents = [], routeRevisions = [], openMaydays = [], inspectionRuns = [] } = data;
  if (!candidate.entityId) return false;

  if (candidate.entity === "document") {
    const document = documents.find((row) => row.id === candidate.entityId);
    return Boolean(document) && documentNeedsReview(document);
  }
  if (candidate.entity === "routeRevision") {
    const revision = routeRevisions.find((row) => row.id === candidate.entityId);
    if (!revision) return false;
    return candidate.intent === "apply"
      ? routeRevisionCanApply(revision)
      : routeRevisionCanReview(revision);
  }
  if (candidate.entity === "incident") {
    const incident = openMaydays.find((row) => row.id === candidate.entityId);
    if (!incident || !incidentNeedsResume(incident)) return false;
    return maydayResumeInspectionRefs(incident, inspectionRuns).length > 0;
  }
  return false;
}

/**
 * The data-driven replacement for the old DOM walk: pick the first candidate
 * that is actually actionable given current state. Returns null when nothing is,
 * which the caller treats the same way the old fallback did.
 */
export function resolveGovernanceReviewTarget(action, data = {}) {
  const target = governanceReviewCandidates(action).find((candidate) =>
    candidateIsActionable(candidate, data),
  );
  return target || null;
}
