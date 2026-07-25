import { asArray, compact, uniqueValues } from "./format";
import { pathsLikelyOverlap } from "./graph";

export function documentLabel(document = {}) {
  return compact(
    document.title || document.subject || document.kind,
    "document",
  );
}

export function documentNeedsReview(document = {}) {
  const status = String(document.status || "").toLowerCase();
  return ![
    "approved",
    "resolved",
    "closed",
    "accepted",
    "answered",
    "rejected",
  ].includes(status);
}

export function routeRevisionCanReview(revision = {}) {
  return ["proposed", "pending", "review"].includes(
    String(revision.status || "").toLowerCase(),
  );
}

export function routeRevisionCanApply(revision = {}) {
  return ["approved", "accepted", "reviewed"].includes(
    String(revision.status || "").toLowerCase(),
  );
}

export function firstRoutePattern(plan = {}) {
  return (
    asArray(plan.route).find(Boolean) ||
    asArray(plan.lease?.allowedPaths).find(Boolean) ||
    "**"
  );
}

export function incidentNeedsResume(incident = {}) {
  const status = String(incident.status || "").toLowerCase();
  const category = String(incident.category || "").toLowerCase();
  return (
    category === "mayday" && !["resolved", "closed", "resumed"].includes(status)
  );
}

export function inspectionRunRelatesToIncident(run = {}, incident = {}) {
  const affectedZones = asArray(incident.affectedZones);
  const changedPaths = asArray(run.changedPaths);
  const evidenceRefs = new Set(asArray(incident.evidenceRefs));
  if (
    affectedZones.length &&
    changedPaths.some((path) =>
      affectedZones.some((zone) => pathsLikelyOverlap(path, zone)),
    )
  )
    return true;
  return asArray(run.evidenceRefs).some((ref) => evidenceRefs.has(ref));
}

export function maydayResumeInspectionRefs(incident = {}, inspectionRuns = []) {
  const replay = incident.incidentReplay || {};
  const workflow = replay.maydayWorkflow || replay.mayday_workflow || {};
  const explicitRefs = uniqueValues([
    workflow.inspectorRunId,
    workflow.inspectionRunId,
    workflow.inspection_run_id,
    ...asArray(workflow.inspectionRunIds || workflow.inspection_run_ids),
    ...asArray(incident.inspectionRunIds || incident.inspection_run_ids),
  ]);
  if (explicitRefs.length) return explicitRefs;
  return uniqueValues(
    asArray(inspectionRuns)
      .filter((run) => inspectionRunRelatesToIncident(run, incident))
      .map((run) => run.id),
  );
}

export function actionSeverity(action) {
  if (action && typeof action === "object" && action.severity) {
    return String(action.severity).toLowerCase();
  }
  const text = String(action?.kind || action?.type || action || "").toLowerCase();
  if (/mayday|ground|revoke|stop|resume|critical|secret|prod/.test(text))
    return "critical";
  if (/commit|apply|permit|route|write|clearance/.test(text)) return "high";
  if (/ack|inbox|rfi|document|change/.test(text)) return "medium";
  return "low";
}

export function actionOwner(action) {
  if (action && typeof action === "object") {
    return compact(
      action.owner ||
        action.ownerUserId ||
        action.displayCallsign ||
        action.agentSessionId ||
        action.transactionId ||
        action.documentId ||
        action.eventId,
      "coordinator",
    );
  }
  const text = String(action || "");
  const [, value] = text.split(":");
  return value || "coordinator";
}

export function actionEntity(action) {
  if (action && typeof action === "object") {
    return compact(
      action.entity ||
        action.documentId ||
        action.eventId ||
        action.transactionId ||
        action.mutationLeaseId ||
        action.routeRevisionId ||
        action.id,
      "project",
    );
  }
  return compact(String(action || "").split(":")[0], "action");
}

export function actionEntityId(action) {
  if (action && typeof action === "object") {
    return compact(
      action.documentId ||
        action.routeRevisionId ||
        action.incidentId ||
        action.eventId ||
        action.entity ||
        action.id,
      "",
    );
  }
  const [, value] = String(action || "").split(":");
  return compact(value, "");
}

export function actionKind(action) {
  return compact(action?.kind || action?.type || String(action || "").split(":")[0], "action")
    .toLowerCase();
}

export function actionHasGovernanceReviewTarget(action) {
  const kind = actionKind(action);
  return Boolean(
    action?.documentId ||
      action?.routeRevisionId ||
      action?.incidentId ||
      /document|rfi|change_order|route|reroute|mayday|ground|resume/.test(kind),
  );
}

export function actionEvidenceRefs(action) {
  if (!action || typeof action !== "object") return [];
  return uniqueValues([
    ...asArray(action.evidenceRefs || action.evidence_refs),
    action.evidenceRef || action.evidence_ref,
  ]);
}

export function actionLabel(action) {
  if (action && typeof action === "object") {
    return compact(action.title || action.label || action.kind || action.type, "required action");
  }
  return compact(action, "required action");
}

export function actionReviewSummary(action) {
  const scope = asArray(action?.scope || action?.paths || action?.route || action?.affectedZones);
  return {
    severity: actionSeverity(action),
    owner: actionOwner(action),
    entity: actionEntity(action),
    evidenceRefs: actionEvidenceRefs(action),
    scope,
  };
}
