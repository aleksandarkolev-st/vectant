"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  FileJson,
  FileSearch,
  GitCommit,
  Inbox,
  Layers,
  Map,
  Plus,
  Radar,
  RefreshCw,
  Route,
  ScrollText,
  ShieldCheck,
  Siren,
  Upload,
} from "lucide-react";
import {
  applyCodeSiteRouteRevision,
  applyCodeSiteQuarantine,
  createCodeSiteProject,
  createEmptyCodeSiteRadarState,
  exportCodeSiteArtifacts,
  fetchCodeSiteLineProvenance,
  fetchCodeSiteRadarState,
  issueCodeSitePermit,
  proposeCodeSiteRouteRevision,
  replayCodeSiteQuarantine,
  resumeCodeSiteMayday,
  reviewCodeSiteDocument,
  reviewCodeSiteRouteRevision,
  simulateCodeSiteShadowMerge,
  subscribeCodeSiteProjectEvents,
} from "./codesiteClient";

const POLL_MS = 5000;
const MOTION_EASE = [0.16, 1, 0.3, 1];
const RADAR_SWEEP_EASE = [0.45, 0, 0.55, 1];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueValues(values) {
  return [
    ...new Set(
      asArray(values)
        .filter(Boolean)
        .map((value) => String(value)),
    ),
  ];
}

function uniqueByEvent(events) {
  const seen = new Set();
  return asArray(events).filter((event, index) => {
    const key =
      event?.id ||
      event?.eventId ||
      `${event?.eventType || "event"}:${event?.createdAt || index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compact(value, fallback = "none") {
  if (value == null || value === "") return fallback;
  return String(value);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0%";
  return `${Math.round(numeric * 100)}%`;
}

function formatDurationMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0s";
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  const seconds = numeric / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatMetricValue(metric) {
  if (!metric || metric.value == null) return "n/a";
  if (metric.unit === "ratio") return formatPercent(metric.value);
  if (metric.unit === "duration_ms") return formatDurationMs(metric.value);
  return String(metric.value);
}

function clampRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function formatCompactNumber(value, fallback = "0") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (Math.abs(numeric) >= 1000) return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(numeric);
  return String(Math.round(numeric * 10) / 10);
}

function metricTone(metric) {
  if (!metric || metric.status === "not_instrumented") return "pending";
  const value = Number(metric.value);
  if (!Number.isFinite(value)) return "idle";
  if (
    /blocked|violation|abort|goAround|red|rollback|drift/i.test(
      metric.key || "",
    )
  )
    return value > 0 ? "holding" : "active";
  return value > 0 ? "active" : "idle";
}

function metricProgress(metric) {
  if (!metric || metric.value == null) return 0;
  const value = Number(metric.value);
  if (!Number.isFinite(value)) return 0;
  if (metric.unit === "ratio") return clampRatio(value);
  if (metric.unit === "duration_ms") return clampRatio(value / 300000);
  return clampRatio(Math.log10(Math.max(1, value) + 1) / 2);
}

function metricTargetLabel(metric = {}) {
  const explicit =
    metric.targetLabel ||
    metric.thresholdLabel ||
    metric.slo ||
    metric.target ||
    metric.threshold;
  if (explicit) return `target ${explicit}`;
  if (metric.key === "lineProvenanceCoverage") return "target 100% traced";
  if (metric.key === "blackBoxCompletenessScore") return "release >=75%";
  if (metric.key === "percentageWritesWithValidClearance")
    return "target 100% cleared";
  if (metric.key === "shadowMergeSimulatorAccuracy") return "target 100%";
  if (
    /blocked|violation|abort|goAround|rollback|drift|red/i.test(
      metric.key || "",
    )
  )
    return "target 0";
  return metric.unit === "ratio" ? "tracked as ratio" : "tracked by evidence";
}

function metricAttentionScore(metric = {}) {
  if (metric.status === "not_instrumented") return 100;
  const value = Number(metric.value);
  const key = String(metric.key || "");
  if (!Number.isFinite(value)) return 20;
  if (/blocked|violation|abort|goAround|rollback|drift|red/i.test(key)) {
    return value > 0 ? 80 + Math.min(15, value) : 8;
  }
  if (/Coverage|Completeness|Accuracy|Clearance/i.test(key)) {
    return Math.round((1 - clampRatio(value, 1)) * 70);
  }
  return value > 0 ? 24 : 6;
}

function metricSectionEntries(sections = {}) {
  return Object.entries(sections)
    .map(([title, rows]) => ({
      title,
      rows: asArray(rows),
    }))
    .filter((section) => section.rows.length);
}

function universeHealthScore(universe = {}) {
  const data = universe || {};
  const risk = clampRatio(data.predictedCollisionRisk);
  const confidence = clampRatio(data.confidence, 0.5);
  const stalePenalty = Math.min(0.28, (Number(data.staleAssumptions) || 0) * 0.07);
  const inspectionPenalty = Math.min(0.18, (Number(data.inspectionCost) || 0) / 100);
  const unresolvedPenalty = Math.min(
    0.24,
    asArray(data.unresolvedRisks).length * 0.08,
  );
  return clampRatio(confidence * 0.42 + (1 - risk) * 0.5 - stalePenalty - inspectionPenalty - unresolvedPenalty);
}

function eventDisplayType(event = {}) {
  return compact(event.eventType || event.type, "event").replaceAll("_", ".");
}

function eventPathLabel(event = {}) {
  return compact(
    event.path ||
      event.details?.path ||
      event.details?.route ||
      event.details?.transactionId ||
      event.displayCallsign,
    "",
  );
}

function countBy(values) {
  return asArray(values).reduce((counts, value) => {
    const key = compact(value, "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function transactionIdentity(transaction = {}) {
  return transaction.id || transaction.transactionId || transaction.txnId || null;
}

function mergeTransactionSources(activeTransactions, mutationTransactions) {
  const byId = new globalThis.Map();
  for (const transaction of [
    ...asArray(mutationTransactions),
    ...asArray(activeTransactions),
  ]) {
    const id = transactionIdentity(transaction);
    if (!id) continue;
    byId.set(id, {
      ...(byId.get(id) || {}),
      ...transaction,
      id,
      live: asArray(activeTransactions).some(
        (active) => transactionIdentity(active) === id,
      ),
    });
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.closedAt || left.openedAt || 0);
    const rightTime = Date.parse(right.closedAt || right.openedAt || 0);
    return rightTime - leftTime;
  });
}

function transactionProofBundle(transaction, proofBundles) {
  const id = transactionIdentity(transaction);
  return (
    asArray(proofBundles).find((bundle) => {
      const trailers = bundle?.trailers || {};
      return (
        bundle?.transactionId === id ||
        bundle?.transaction?.id === id ||
        trailers["CodeSite-Transaction"] === id ||
        bundle?.bundleDigest === transaction?.proofBundleDigest ||
        bundle?.id === transaction?.proofBundleId
      );
    }) || null
  );
}

function transactionEvents(transaction, events) {
  const id = transactionIdentity(transaction);
  if (!id) return [];
  return asArray(events).filter(
    (event) =>
      event?.transactionId === id ||
      event?.details?.transactionId === id ||
      event?.details?.transaction_id === id ||
      event?.actorId === id,
  );
}

function transactionReason(transaction = {}, events = []) {
  const status = String(transaction.status || "").toLowerCase();
  const decision = transaction.commitDecision || {};
  const statusEvents = asArray(events).filter((event) => {
    const type = String(event?.eventType || event?.type || "").toLowerCase();
    if (status === "aborted") return /abort|invalid|stale|blocked/.test(type);
    if (status === "committed") return /commit|validated|landed|black_box/.test(type);
    if (status === "validated") return /validated|read|write/.test(type);
    return true;
  });
  const eventReason = (statusEvents.length ? statusEvents : asArray(events))
    .map(
      (event) =>
        event?.details?.reason ||
        event?.details?.reasonCode ||
        event?.details?.error ||
        event?.details?.message,
    )
    .find(Boolean);
  return (
    decision.reason ||
    decision.reasonCode ||
    decision.status ||
    eventReason ||
    (status === "aborted"
      ? "serializable_validation_rejected"
      : status === "committed"
        ? "serializable_validation_passed"
        : status === "validated"
          ? "read_write_sets_validated"
          : "validation evidence current")
  );
}

function transactionTowerAction(transaction = {}, events = []) {
  const status = String(transaction.status || "").toLowerCase();
  const reason = transactionReason(transaction, events);
  if (status === "aborted" || /invalid|stale|changed|mismatch/i.test(reason)) {
    return "rebase and revalidate assumptions";
  }
  if (["blocked", "quarantined"].includes(status)) {
    return "pause writes and review quarantine";
  }
  if (["open", "validated"].includes(status)) {
    return "observe read set until landing";
  }
  if (status === "committed") return "proof bundle closed";
  return "hold for tower review";
}

function transactionDigestLabel(value) {
  const text = compact(value, "missing");
  if (text.length <= 32) return text;
  return `${text.slice(0, 18)}...${text.slice(-10)}`;
}

function invalidatedAssumptionRows({
  assumptions,
  towerUniverses,
  activeFlights,
  activeLeases,
  events,
}) {
  const invalidated = asArray(assumptions)
    .filter((assumption) =>
      /invalid|stale|expired/i.test(String(assumption?.status || "")),
    )
    .map((assumption) => ({
      id: assumption.id || assumption.assumptionKey,
      assumption: assumption.assumptionKey || assumption.id,
      invalidatedBy: assumption.invalidatedBy || "schema refresh",
      affected: uniqueValues([
        assumption.displayCallsign,
        ...asArray(assumption.usedBy),
      ]),
      dependsOn: asArray(assumption.dependsOn).map(
        (dependency) =>
          dependency?.ref ||
          dependency?.path ||
          dependency?.version ||
          compact(dependency, ""),
      ),
      staleCount: 1,
      evidenceRefs: asArray(assumption.evidenceRefs),
      source: "assumption",
    }));
  if (invalidated.length) return invalidated;

  const holdingFlights = asArray(activeFlights)
    .filter((flight) => /hold|blocked|stale/i.test(String(flight?.status || "")))
    .map((flight) => flight.displayCallsign || flight.id);
  const leaseCallsigns = asArray(activeLeases).map(
    (lease) => lease.displayCallsign || lease.agentSessionId,
  );
  const invalidationEvents = asArray(events).filter((event) =>
    /assumption.*invalid|invalid.*assumption|stale/i.test(
      `${event?.eventType || ""} ${event?.details?.reason || ""}`,
    ),
  );

  return asArray(towerUniverses)
    .filter((universe) => Number(universe?.staleAssumptions) > 0)
    .map((universe) => ({
      id: `simulated-${universe.strategy}`,
      assumption: `${universe.staleAssumptions} stale assumptions`,
      invalidatedBy:
        asArray(universe.reasonCodes).find((code) =>
          /schema|contract|assumption/i.test(code),
        ) || "counterfactual route simulation",
      affected: uniqueValues([
        ...holdingFlights,
        ...leaseCallsigns,
        universe.strategy,
      ]).slice(0, 6),
      dependsOn: asArray(universe.reasonCodes).filter((code) =>
        /schema|contract|assumption|parallel|backend|frontend/i.test(code),
      ),
      staleCount: Number(universe.staleAssumptions) || 0,
      evidenceRefs: uniqueValues([
        ...asArray(universe.evidenceRefs),
        ...invalidationEvents.flatMap((event) => asArray(event.evidenceRefs)),
      ]),
      source: "simulation",
    }));
}

function parseLineRange(lineAnchor) {
  const match = String(lineAnchor || "").match(/#?L(\d+)(?:-L?(\d+))?/i);
  if (!match) return { startLine: null, endLine: null };
  const startLine = Math.max(1, Number(match[1]));
  const endLine = Math.max(startLine, Number(match[2] || match[1]));
  return { startLine, endLine };
}

function lineRange(row = {}) {
  const parsed = parseLineRange(row.lineAnchor);
  const startLine = Number.isFinite(Number(row.startLine))
    ? Number(row.startLine)
    : parsed.startLine;
  const endLine = Number.isFinite(Number(row.endLine))
    ? Number(row.endLine)
    : parsed.endLine || startLine;
  return { startLine, endLine };
}

function lineRangeLabel(row = {}) {
  const range = lineRange(row);
  if (!range.startLine) return compact(row.lineAnchor, "line");
  return range.endLine && range.endLine !== range.startLine
    ? `L${range.startLine}-L${range.endLine}`
    : `L${range.startLine}`;
}

function lineProvenanceKey(row) {
  if (!row) return "line:none";
  return (
    row.id ||
    `${row.filePath || "file"}:${row.lineAnchor || lineRangeLabel(row)}:${row.transactionId || ""}`
  );
}

function pathCoversFile(pattern, filePath) {
  if (!pattern || !filePath) return false;
  if (pattern === filePath) return true;
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -3));
  if (pattern.includes("*")) return filePath.startsWith(pattern.split("*")[0]);
  return false;
}

function inspectionRunRefs(run) {
  return uniqueValues([
    ...asArray(run?.evidenceRefs),
    ...asArray(run?.inspectionSignals).flatMap((signal) =>
      asArray(signal?.evidenceRefs || signal?.evidence_refs),
    ),
    run?.id ? `codesite:inspection:${run.id}` : null,
  ]);
}

function latestCounterfactualSimulation(runs) {
  const latestRun =
    asArray(runs)
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left?.createdAt || "") || 0;
        const rightTime = Date.parse(right?.createdAt || "") || 0;
        if (leftTime !== rightTime) return leftTime - rightTime;
        return String(left?.id || "").localeCompare(String(right?.id || ""));
      })
      .slice(-1)[0] || null;
  const verdict = latestRun?.arbiterVerdict || null;
  if (!verdict) return { run: latestRun, result: null };
  return {
    run: latestRun,
    result: {
      ...verdict,
      universes: asArray(verdict.universes).length
        ? verdict.universes
        : latestRun.universes,
      evidenceRefs: asArray(verdict.evidenceRefs).length
        ? verdict.evidenceRefs
        : latestRun.evidenceRefs,
      shadowJobRef: verdict.shadowJobRef || latestRun.shadowJobRef,
      baseSnapshot: verdict.baseSnapshot || latestRun.baseSnapshot,
    },
  };
}

function documentLabel(document = {}) {
  return compact(
    document.title || document.subject || document.kind,
    "document",
  );
}

function documentNeedsReview(document = {}) {
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

function routeRevisionCanReview(revision = {}) {
  return ["proposed", "pending", "review"].includes(
    String(revision.status || "").toLowerCase(),
  );
}

function routeRevisionCanApply(revision = {}) {
  return ["approved", "accepted", "reviewed"].includes(
    String(revision.status || "").toLowerCase(),
  );
}

function firstRoutePattern(plan = {}) {
  return (
    asArray(plan.route).find(Boolean) ||
    asArray(plan.lease?.allowedPaths).find(Boolean) ||
    "**"
  );
}

function incidentNeedsResume(incident = {}) {
  const status = String(incident.status || "").toLowerCase();
  const category = String(incident.category || "").toLowerCase();
  return (
    category === "mayday" && !["resolved", "closed", "resumed"].includes(status)
  );
}

function inspectionRunRelatesToIncident(run = {}, incident = {}) {
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

function maydayResumeInspectionRefs(incident = {}, inspectionRuns = []) {
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

function actionSeverity(action) {
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

function actionOwner(action) {
  if (action && typeof action === "object") {
    return compact(
      action.owner ||
        action.ownerUserId ||
        action.displayCallsign ||
        action.agentSessionId ||
        action.transactionId ||
        action.documentId ||
        action.eventId,
      "tower",
    );
  }
  const text = String(action || "");
  const [, value] = text.split(":");
  return value || "tower";
}

function actionEntity(action) {
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

function actionEntityId(action) {
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

function actionKind(action) {
  return compact(action?.kind || action?.type || String(action || "").split(":")[0], "action")
    .toLowerCase();
}

function actionHasGovernanceReviewTarget(action) {
  const kind = actionKind(action);
  return Boolean(
    action?.documentId ||
      action?.routeRevisionId ||
      action?.incidentId ||
      /document|rfi|change_order|route|reroute|mayday|ground|resume/.test(kind),
  );
}

function actionEvidenceRefs(action) {
  if (!action || typeof action !== "object") return [];
  return uniqueValues([
    ...asArray(action.evidenceRefs || action.evidence_refs),
    action.evidenceRef || action.evidence_ref,
  ]);
}

function actionLabel(action) {
  if (action && typeof action === "object") {
    return compact(action.title || action.label || action.kind || action.type, "required action");
  }
  return compact(action, "required action");
}

function actionReviewSummary(action) {
  const scope = asArray(action?.scope || action?.paths || action?.route || action?.affectedZones);
  return {
    severity: actionSeverity(action),
    owner: actionOwner(action),
    entity: actionEntity(action),
    evidenceRefs: actionEvidenceRefs(action),
    scope,
  };
}

function findGovernanceEntityRow(attributeName, entityId) {
  if (!entityId || typeof document === "undefined") return null;
  return Array.from(document.querySelectorAll(`[${attributeName}]`)).find(
    (element) => element.getAttribute(attributeName) === entityId,
  );
}

function towerInstructionText(event = {}) {
  const details = event.details || {};
  const eventType = String(event.eventType || "");
  return compact(
    details.towerInstruction ||
      details.instruction ||
      details.summary ||
      details.title ||
      details.reason ||
      details.reasonCode ||
      details.reasonCodes?.[0] ||
      event.message ||
      TOWER_EVENT_LABELS[eventType] ||
      eventDisplayType(event),
    "tower event",
  );
}

const TOWER_EVENT_LABELS = {
  flight_plan_filed: "Flight plan filed",
  clearance_issued: "Clearance issued",
  write_attempted: "Write attempted",
  write_allowed: "Write cleared",
  write_denied: "Write blocked by CodeSiteFS",
  write_quarantined: "Write quarantined for review",
  transaction_opened: "Transaction opened",
  transaction_validated: "Transaction validated",
  transaction_committed: "Transaction landed",
  transaction_aborted: "Transaction aborted",
  proof_bundle_verified: "Proof bundle verified",
  black_box_closed: "Black box closed",
  tower_instruction: "Tower instruction",
  route_deviation: "Route deviation filed",
  ground_stop: "Ground stop issued",
  mayday_resumed: "Ground stop resumed",
  quarantine_reviewed: "Quarantine reviewed",
  quarantine_replayed: "Quarantine replayed",
  quarantine_applied: "Quarantine applied",
};

function towerEventKind(event = {}) {
  return TOWER_EVENT_LABELS[event.eventType] || eventDisplayType(event);
}

function hasEntries(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length,
  );
}

function quarantinePath(change = {}) {
  return compact(change.path || change.quarantineEvidence?.path, "");
}

function quarantineDigest(change = {}, key) {
  const evidence = change.quarantineEvidence || {};
  return compact(
    change[key] ||
      evidence[key] ||
      evidence[key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)],
    "",
  );
}

function quarantineEvidenceRef(change = {}) {
  const evidence = change.quarantineEvidence || {};
  return compact(
    change.evidenceRef ||
      evidence.evidenceRef ||
      asArray(change.evidenceRefs || evidence.evidenceRefs)[0],
    "",
  );
}

function selectedPathKey(paths) {
  return asArray(paths).map(String).sort().join("\n");
}

function quarantineAppliedPaths(record = {}, reviewState = {}) {
  return uniqueValues([
    ...asArray(record.appliedPaths),
    ...asArray(record.applied).map((item) => item.path),
    ...asArray(reviewState.apply?.applied).map((item) => item.path),
  ]);
}

function quarantineRemainingPaths(record = {}, reviewState = {}) {
  const paths = uniqueValues([
    ...asArray(record.paths),
    ...asArray(record.changes).map(quarantinePath),
  ]);
  const applied = new Set(quarantineAppliedPaths(record, reviewState));
  return paths.filter((item) => !applied.has(item));
}

function quarantineDisplayStatus(record = {}, reviewState = {}) {
  const appliedPaths = quarantineAppliedPaths(record, reviewState);
  if (appliedPaths.length > 0) {
    return quarantineRemainingPaths(record, reviewState).length > 0
      ? "partially_applied"
      : "applied";
  }
  if (reviewState.replay?.ok === true) return "replayed";
  return record.status || "reviewable";
}

function quarantineEventId(event = {}) {
  const details = event.details || {};
  const codesiteFsEvent =
    details.codesiteFsEvent || details.codesite_fs_event || {};
  const fsDetails = codesiteFsEvent.details || {};
  const evidence =
    details.quarantineEvidence ||
    details.quarantine_evidence ||
    fsDetails.quarantineEvidence ||
    fsDetails.quarantine_evidence ||
    {};
  return String(
    details.quarantineId ||
      details.quarantine_id ||
      fsDetails.quarantineId ||
      fsDetails.quarantine_id ||
      evidence.quarantineId ||
      evidence.quarantine_id ||
      event.actorId ||
      evidence.evidenceRef ||
      event.id ||
      "unknown-quarantine",
  );
}

function quarantineRecordsFromEvents(events) {
  const records = new globalThis.Map();
  for (const event of asArray(events)) {
    if (
      ![
        "write_quarantined",
        "quarantine_reviewed",
        "quarantine_replayed",
        "quarantine_applied",
      ].includes(event?.eventType)
    )
      continue;
    const details = event.details || {};
    const codesiteFsEvent =
      details.codesiteFsEvent || details.codesite_fs_event || {};
    const fsDetails = codesiteFsEvent.details || {};
    const evidence =
      details.quarantineEvidence ||
      details.quarantine_evidence ||
      fsDetails.quarantineEvidence ||
      fsDetails.quarantine_evidence ||
      {};
    const id = quarantineEventId(event);
    const record = records.get(id) || {
      quarantineId: id,
      status: "reviewable",
      transactionId:
        details.transactionId ||
        details.transaction_id ||
        codesiteFsEvent.transaction_id ||
        null,
      mutationLeaseId:
        event.mutationLeaseId ||
        details.mutationLeaseId ||
        details.mutation_lease_id ||
        null,
      displayCallsign: event.displayCallsign || null,
      paths: [],
      changes: [],
      rejected: [],
      latestReplayAttempt: null,
      replayAttempts: [],
      successfulReplay: null,
      evidenceRefs: [],
      eventRefs: [],
      lifecycle: {
        capturedAt: null,
        reviewedAt: null,
        replayedAt: null,
        appliedAt: null,
      },
      symlinkSanitization:
        fsDetails.symlinkSanitization ||
        fsDetails.symlink_sanitization ||
        details.symlinkSanitization ||
        details.symlink_sanitization ||
        null,
      updatedAt: event.createdAt || null,
    };
    record.eventRefs = uniqueValues([...record.eventRefs, event.id]);
    record.evidenceRefs = uniqueValues([
      ...record.evidenceRefs,
      ...asArray(event.evidenceRefs),
      ...asArray(details.evidenceRefs || details.evidence_refs),
      evidence.evidenceRef,
      ...asArray(evidence.evidenceRefs || evidence.evidence_refs),
    ]);
    record.paths = uniqueValues([
      ...record.paths,
      details.path,
      codesiteFsEvent.path,
      evidence.path,
      ...asArray(
        details.paths || details.changedPaths || details.changed_paths,
      ),
    ]);
    if (event.eventType === "write_quarantined") {
      record.lifecycle.capturedAt =
        record.lifecycle.capturedAt || event.createdAt || null;
      const change = {
        path: evidence.path || details.path || codesiteFsEvent.path,
        kind:
          evidence.kind ||
          details.changeKind ||
          details.change_kind ||
          "modified",
        beforeDigest: evidence.beforeDigest || evidence.before_digest,
        afterDigest: evidence.afterDigest || evidence.after_digest,
        evidenceRef: evidence.evidenceRef,
        quarantineEvidence: evidence,
      };
      if (
        change.path &&
        !record.changes.some(
          (item) =>
            quarantinePath(item) === change.path &&
            quarantineEvidenceRef(item) === quarantineEvidenceRef(change),
        )
      ) {
        record.changes.push(change);
      }
    }
    if (event.eventType === "quarantine_reviewed") {
      record.status = record.status === "applied" ? record.status : "reviewed";
      record.lifecycle.reviewedAt =
        record.lifecycle.reviewedAt || event.createdAt || null;
    }
    if (event.eventType === "quarantine_replayed") {
      const attempt = quarantineReplayAttemptFromEvent(event, details);
      record.latestReplayAttempt = attempt;
      record.replayAttempts = appendUniqueObjects(record.replayAttempts, [
        attempt,
      ]);
      record.rejected = [...record.rejected, ...asArray(details.rejected)];
      if (isSuccessfulQuarantineReplay(attempt)) {
        record.status =
          record.status === "applied" ? record.status : "replayed";
        if (isReplayAttemptBeforeApply(attempt, record.lifecycle)) {
          record.lifecycle.replayedAt =
            attempt.attemptedAt || record.lifecycle.replayedAt || null;
          record.successfulReplay = attempt;
        } else if (!record.successfulReplay) {
          record.successfulReplay = attempt;
        }
      } else if (record.status !== "applied" && record.status !== "replayed") {
        record.status = "blocked";
      }
    }
    if (event.eventType === "quarantine_applied") {
      record.status = "applied";
      record.lifecycle.appliedAt =
        event.createdAt || record.lifecycle.appliedAt;
      record.applied = asArray(details.applied);
    }
    records.set(id, record);
  }
  return [...records.values()];
}

function normalizeQuarantineRecord(record = {}) {
  const changes = asArray(record.changes);
  const paths = uniqueValues([
    ...asArray(record.paths),
    ...changes.map(quarantinePath),
  ]);
  return {
    ...record,
    quarantineId: compact(
      record.quarantineId || record.id,
      "unknown-quarantine",
    ),
    status: compact(record.status, changes.length ? "reviewable" : "pending"),
    paths,
    changes,
    rejected: asArray(record.rejected),
    applied: asArray(record.applied),
    latestReplayAttempt: record.latestReplayAttempt || null,
    replayAttempts: asArray(record.replayAttempts),
    successfulReplay: record.successfulReplay || record.replay || null,
    appliedPaths: uniqueValues([
      ...asArray(record.appliedPaths),
      ...asArray(record.applied).map((item) => item.path),
    ]),
    remainingPaths: asArray(record.remainingPaths),
    evidenceRefs: uniqueValues(record.evidenceRefs),
    eventRefs: uniqueValues(record.eventRefs),
    lifecycle: record.lifecycle || {
      capturedAt: record.createdAt || null,
      reviewedAt: null,
      replayedAt: null,
      appliedAt: null,
    },
    symlinkSanitization:
      record.symlinkSanitization || record.symlink_sanitization || null,
  };
}

function mergeQuarantineRecords(...groups) {
  const merged = new globalThis.Map();
  for (const raw of groups.flatMap((group) => asArray(group))) {
    const record = normalizeQuarantineRecord(raw);
    const previous = merged.get(record.quarantineId);
    if (!previous) {
      merged.set(record.quarantineId, record);
      continue;
    }
    merged.set(record.quarantineId, {
      ...previous,
      ...record,
      changes: [...previous.changes, ...record.changes].filter(
        (change, index, allChanges) => {
          const key = `${quarantinePath(change)}:${quarantineEvidenceRef(change)}`;
          return (
            index ===
            allChanges.findIndex(
              (candidate) =>
                `${quarantinePath(candidate)}:${quarantineEvidenceRef(candidate)}` ===
                key,
            )
          );
        },
      ),
      paths: uniqueValues([...previous.paths, ...record.paths]),
      rejected: [...asArray(previous.rejected), ...asArray(record.rejected)],
      applied: [
        ...asArray(previous.applied),
        ...asArray(record.applied),
      ].filter((item, index, allItems) => {
        const key = `${item?.path || ""}:${item?.evidenceRef || ""}`;
        return (
          index ===
          allItems.findIndex(
            (candidate) =>
              `${candidate?.path || ""}:${candidate?.evidenceRef || ""}` ===
              key,
          )
        );
      }),
      appliedPaths: uniqueValues([
        ...asArray(previous.appliedPaths),
        ...asArray(record.appliedPaths),
      ]),
      remainingPaths: record.remainingPaths?.length
        ? record.remainingPaths
        : previous.remainingPaths,
      latestReplayAttempt:
        record.latestReplayAttempt || previous.latestReplayAttempt || null,
      replayAttempts: appendUniqueObjects(
        previous.replayAttempts,
        record.replayAttempts,
      ),
      successfulReplay:
        previous.successfulReplay || record.successfulReplay || null,
      evidenceRefs: uniqueValues([
        ...previous.evidenceRefs,
        ...record.evidenceRefs,
      ]),
      eventRefs: uniqueValues([...previous.eventRefs, ...record.eventRefs]),
      lifecycle: mergeLifecycle(previous.lifecycle, record.lifecycle),
      symlinkSanitization:
        record.symlinkSanitization || previous.symlinkSanitization,
    });
  }
  return [...merged.values()].sort((left, right) =>
    String(
      right.updatedAt || right.finalizedAt || right.createdAt || "",
    ).localeCompare(
      String(left.updatedAt || left.finalizedAt || left.createdAt || ""),
    ),
  );
}

function quarantineReplayAttemptFromEvent(event, details = {}) {
  return {
    attemptedAt: event.createdAt || null,
    selectedChangeCount: details.selectedChangeCount ?? null,
    replayableChangeCount: details.replayableChangeCount ?? null,
    rejectedChangeCount: details.rejectedChangeCount ?? null,
    paths: asArray(
      details.paths || details.selectedPaths || details.selected_paths,
    ),
    replayablePaths: asArray(
      details.replay || details.replayable || details.prepared,
    )
      .map((item) => item.path)
      .filter(Boolean),
    rejectedPaths: asArray(details.rejected)
      .map((item) => item.path)
      .filter(Boolean),
  };
}

function isSuccessfulQuarantineReplay(attempt = {}) {
  return (
    Number(attempt.replayableChangeCount || 0) > 0 &&
    Number(attempt.rejectedChangeCount || 0) === 0
  );
}

function isReplayAttemptBeforeApply(attempt = {}, lifecycle = {}) {
  if (!lifecycle.appliedAt) return true;
  const attemptedAt = Date.parse(attempt.attemptedAt || "");
  const appliedAt = Date.parse(lifecycle.appliedAt);
  if (Number.isNaN(attemptedAt) || Number.isNaN(appliedAt)) return false;
  return attemptedAt <= appliedAt;
}

function appendUniqueObjects(current, values) {
  const next = [...asArray(current)];
  const seen = new Set(next.map((item) => JSON.stringify(item)));
  for (const value of asArray(values)) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}

function mergeLifecycle(previous = {}, next = {}) {
  return {
    capturedAt: previous.capturedAt || next.capturedAt || null,
    reviewedAt: previous.reviewedAt || next.reviewedAt || null,
    replayedAt: previous.replayedAt || next.replayedAt || null,
    appliedAt: previous.appliedAt || next.appliedAt || null,
  };
}

function quarantineReviewMessage(reviewState = {}) {
  if (reviewState.status === "replaying")
    return "Replaying selected paths against the current workspace.";
  if (reviewState.status === "applying")
    return "Applying replayed paths through the active transaction.";
  const rejected = asArray(
    reviewState.replay?.rejected || reviewState.apply?.rejected,
  );
  if (rejected.length) {
    const paths =
      uniqueValues(rejected.map((item) => item.path)).join(", ") ||
      "selected paths";
    const reasons =
      uniqueValues(
        rejected.flatMap(
          (item) => item.reasonCodes || item.reason_codes || item.error,
        ),
      ).join(", ") || "replay rejected";
    return `Replay blocked for ${paths}: ${reasons}. Refresh the workspace, inspect the changed base, then replay again before applying.`;
  }
  return reviewState.error || "";
}

function formatTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (
    ["active", "cleared", "airborne", "validated", "passed", "ok"].includes(
      normalized,
    )
  ) {
    return {
      background: "color-mix(in srgb, #4ade80 16%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (
    ["holding", "blocked", "denied", "mayday", "failed", "critical"].includes(
      normalized,
    )
  ) {
    return {
      background: "color-mix(in srgb, #ff5757 18%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (
    [
      "pending",
      "filed",
      "preflight",
      "open",
      "running",
      "warning",
      "medium",
      "partially_applied",
    ].includes(normalized)
  ) {
    return {
      background: "color-mix(in srgb, #fbbf24 18%, transparent)",
      color: "var(--text-primary)",
    };
  }
  return { background: "var(--bg-elevated)", color: "var(--text-secondary)" };
}

function riskTone(level) {
  const normalized = String(level || "").toLowerCase();
  if (["critical", "high"].includes(normalized)) {
    return {
      background: "color-mix(in srgb, #ff5757 20%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (["medium", "warning"].includes(normalized)) {
    return {
      background: "color-mix(in srgb, #fbbf24 20%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (["low", "clear", "none"].includes(normalized)) {
    return {
      background: "color-mix(in srgb, #4ade80 16%, transparent)",
      color: "var(--text-primary)",
    };
  }
  return { background: "var(--bg-elevated)", color: "var(--text-secondary)" };
}

function indicatorTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (
    ["critical", "high", "medium", "warning", "low", "clear", "none"].includes(
      normalized,
    )
  )
    return riskTone(value);
  return statusTone(value);
}

function toneLabel(value) {
  return compact(value, "idle").replaceAll("_", " ");
}

function Pill({ children, tone = "idle", className = "", testId }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold leading-4 ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 74%, var(--text-primary) 12%)",
        ...(typeof tone === "string" ? statusTone(tone) : tone),
      }}
    >
      {children}
    </span>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
  variant = "neutral",
  testId,
  type = "button",
}) {
  const active = variant === "primary";
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type={type}
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled || reduceMotion ? undefined : { y: -1 }}
      whileTap={disabled || reduceMotion ? undefined : { scale: 0.985 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: MOTION_EASE }}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold outline-none transition-[background,border-color,opacity] duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: active
          ? "color-mix(in srgb, var(--accent-primary) 62%, var(--border-subtle))"
          : "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
        background: active
          ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
          : "var(--bg-elevated)",
        color: "var(--text-primary)",
        transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {children}
    </motion.button>
  );
}

function Section({ title, icon: Icon, children, right, sectionKey }) {
  return (
    <section
      id={sectionKey ? `codesite-section-${sectionKey}` : undefined}
      data-codesite-section={sectionKey || undefined}
      className="border-t scroll-mt-32 md:scroll-mt-24"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
      }}
    >
      <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 72%, var(--accent-primary) 28%)",
              background:
                "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-elevated))",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
          <h3
            className="truncate text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h3>
        </div>
        {right}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function Metric({ label, value, tone = null, testId }) {
  return (
    <div
      data-testid={testId}
      className="min-h-[76px] rounded-md border px-3 py-3 transition-[border-color,background] duration-200"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 92%, var(--accent-primary) 8%)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        className="text-[11px] font-medium leading-tight"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div className="mt-1 flex items-start justify-between gap-2">
        <div
          className="min-w-0 break-words font-mono text-lg font-semibold leading-tight tabular-nums"
          title={String(value)}
          style={{ color: "var(--text-primary)" }}
        >
          {value}
        </div>
        {tone ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4"
            style={{ color: "var(--text-secondary)" }}
          >
            <span className="h-2 w-2 rounded-full" style={riskTone(tone)} />
            <span>{toneLabel(tone)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatusRailItem({
  label,
  value,
  tone = "idle",
  icon: Icon = Activity,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2.5 py-2"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
        background: "color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%)",
      }}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-md"
        style={{
          background:
            "color-mix(in srgb, var(--accent-primary) 9%, transparent)",
        }}
      >
        <Icon
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--accent-primary)" }}
        />
      </span>
      <div className="min-w-0">
        <div
          className="text-[10px] font-medium leading-tight"
          style={{ color: "var(--text-muted)" }}
        >
          {label}
        </div>
        <div
          className="break-words font-mono text-sm font-semibold leading-tight tabular-nums"
          title={String(value)}
          style={{ color: "var(--text-primary)" }}
        >
          {value}
        </div>
      </div>
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4"
        style={{ color: "var(--text-secondary)" }}
      >
        <span className="h-2 w-2 rounded-full" style={indicatorTone(tone)} />
        <span>{toneLabel(tone)}</span>
      </span>
    </div>
  );
}

function TowerNowStrip({
  towerState,
  streamStatus,
  collisionForecast,
  risks,
  requiredActionCount,
  documents,
  routeRevisions,
  openMaydays,
  runwayOccupancy,
  activeTransactions,
  proofBundles,
  quarantineRecords,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
  const documentsNeedingReview = asArray(documents).filter(documentNeedsReview)
    .length;
  const routeReviews = asArray(routeRevisions).filter(routeRevisionCanReview)
    .length;
  const requiredCount = Math.max(
    Number(requiredActionCount) || 0,
    documentsNeedingReview + routeReviews,
  );
  const forecastRisk = collisionForecast?.riskLevel || "unknown";
  const runwayCount = asArray(runwayOccupancy).length;
  const transactionCount = asArray(activeTransactions).length;
  const proofCount = asArray(proofBundles).length;
  const quarantineCount = asArray(quarantineRecords).length;
  const maydayCount = asArray(openMaydays).length;
  const riskCount = asArray(risks).length;
  const cards = [
    {
      key: "tower",
      label: "Tower",
      value: toneLabel(towerState),
      detail:
        streamStatus === "live"
          ? "Live instruction stream"
          : `Stream ${toneLabel(streamStatus)}`,
      tone: towerState,
      icon: Activity,
      section: "tower",
    },
    {
      key: "collision",
      label: "Collision",
      value: toneLabel(forecastRisk),
      detail: riskCount
        ? `${riskCount} forecasted risk${riskCount === 1 ? "" : "s"}`
        : "No forecasted collisions",
      tone: forecastRisk,
      icon: AlertTriangle,
      section: "radar",
    },
    {
      key: "clearance",
      label: "Clearance",
      value: requiredCount,
      detail: `${documentsNeedingReview} docs / ${routeReviews} reroutes`,
      tone: requiredCount ? "holding" : "active",
      icon: Inbox,
      section: "governance",
    },
    {
      key: "mayday",
      label: "Mayday",
      value: maydayCount,
      detail: maydayCount ? "Resume needs inspection evidence" : "No ground stop",
      tone: maydayCount ? "high" : "active",
      icon: Siren,
      section: "replay",
    },
    {
      key: "runway",
      label: "Runways",
      value: runwayCount,
      detail: transactionCount
        ? `${transactionCount} open transaction${transactionCount === 1 ? "" : "s"}`
        : "No occupied write runway",
      tone: runwayCount || transactionCount ? "holding" : "active",
      icon: Route,
      section: "radar",
    },
    {
      key: "proof",
      label: "Proof",
      value: proofCount,
      detail: quarantineCount
        ? `${quarantineCount} quarantine${quarantineCount === 1 ? "" : "s"} need replay`
        : "Evidence handoff ready",
      tone: quarantineCount ? "warning" : proofCount ? "active" : "idle",
      icon: GitCommit,
      section: "evidence",
    },
  ];

  return (
    <div
      data-testid="codesite-tower-now"
      className="grid grid-cols-3 gap-1.5 rounded-lg border p-1.5 sm:grid-cols-3 xl:grid-cols-6"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 62%, var(--accent-primary) 38%)",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 90%, var(--accent-primary) 7%), color-mix(in srgb, var(--bg-surface) 94%, var(--text-primary) 3%))",
      }}
      aria-label="CodeSite tower now"
    >
      {cards.map((card, index) => {
        const Icon = card.icon;
        const urgent = ["high", "critical", "warning", "holding"].includes(
          String(card.tone || "").toLowerCase(),
        );
        return (
          <button
            key={card.key}
            type="button"
            data-testid={`codesite-tower-now-${card.key}`}
            aria-label={`${card.label}: ${card.value}. ${card.detail}`}
            onClick={() => onSelect?.(card.section)}
            className="group min-w-0 rounded-md border px-2.5 py-1.5 text-left outline-none transition-[background,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 78%, var(--text-primary) 10%)",
              background: urgent
                ? "color-mix(in srgb, var(--bg-editor) 78%, var(--accent-primary) 8%)"
                : "color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%)",
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
                  style={{
                    background:
                      "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
                  }}
                >
                  <Icon
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--accent-primary)" }}
                  />
                </span>
                <span
                  className="truncate text-[10px] font-semibold uppercase"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.label}
                </span>
              </span>
              <motion.span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={indicatorTone(card.tone)}
                animate={
                  urgent && !reduceMotion
                    ? { opacity: [0.52, 1, 0.52], scale: [0.9, 1.18, 0.9] }
                    : undefined
                }
                transition={
                  urgent && !reduceMotion
                    ? {
                        duration: 1.8,
                        ease: RADAR_SWEEP_EASE,
                        repeat: Infinity,
                        delay: index * 0.08,
                      }
                    : undefined
                }
              />
            </div>
            <div
              className="mt-1 break-words font-mono text-sm font-semibold leading-tight tabular-nums sm:text-base"
              style={{ color: "var(--text-primary)" }}
            >
              {card.value}
            </div>
            <div
              className="mt-0.5 hidden min-h-4 text-[10.5px] leading-4 sm:block"
              style={{ color: "var(--text-secondary)" }}
            >
              {card.detail}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function OperatorPane({
  title,
  icon: Icon,
  right,
  sectionKey,
  testId,
  children,
  className = "",
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      id={sectionKey ? `codesite-section-${sectionKey}` : undefined}
      data-codesite-section={sectionKey || undefined}
      data-testid={testId}
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: MOTION_EASE }}
      className={`min-w-0 scroll-mt-32 overflow-hidden rounded-lg border p-1 md:scroll-mt-24 ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 84%, var(--accent-primary) 16%)",
        background: "color-mix(in srgb, var(--bg-surface) 96%, var(--bg-editor) 4%)",
      }}
    >
      <div
        className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 90%, var(--text-primary) 6%)",
          background: "var(--bg-elevated)",
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md"
            style={{
              background:
                "color-mix(in srgb, var(--accent-primary) 8%, transparent)",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
          <h3
            className="truncate text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h3>
        </div>
        {right}
      </div>
      <div className="p-2.5 sm:p-3">{children}</div>
    </motion.section>
  );
}

function MetricRow({ metric }) {
  return (
    <div
      className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t py-2 first:border-t-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="min-w-0">
        <div
          className="truncate text-xs font-medium"
          title={metric.label}
          style={{ color: "var(--text-primary)" }}
        >
          {metric.label}
        </div>
        <div
          className="mt-0.5 truncate text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          {metric.status === "not_instrumented"
            ? "needs instrumentation"
            : `${metric.sampleSize || 0} evidence refs`}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-sm tabular-nums"
          title={formatMetricValue(metric)}
          style={{ color: "var(--text-primary)" }}
        >
          {formatMetricValue(metric)}
        </span>
        <span
          className="inline-flex items-center gap-1 text-[10px] leading-4"
          style={{ color: "var(--text-secondary)" }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={riskTone(metricTone(metric))}
          />
          <span>{toneLabel(metricTone(metric))}</span>
        </span>
      </div>
    </div>
  );
}

function MetricsGroup({ title, rows }) {
  return (
    <div className="min-w-0">
      <div
        className="mb-1 text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {title}
      </div>
      <div className="min-w-0">
        {asArray(rows).map((metric, index) => (
          <MetricRow
            key={metric.key || metric.label || `${title}-metric-${index}`}
            metric={metric}
          />
        ))}
      </div>
    </div>
  );
}

function SignalBar({ value, tone = "active", label = "" }) {
  const width = `${Math.round(clampRatio(value) * 100)}%`;
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full"
      aria-label={label}
      style={{
        background:
          "color-mix(in srgb, var(--border-subtle) 70%, transparent)",
      }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width,
          minWidth: value > 0 ? "12%" : "0",
          background:
            indicatorTone(tone).background || "var(--accent-primary)",
        }}
      />
    </div>
  );
}

function MetricScorecard({ metric }) {
  const tone = metricTone(metric);
  const evidenceCount =
    asArray(metric?.evidenceRefs).length || metric?.sampleSize || 0;
  return (
    <div
      data-testid={`codesite-slo-${metric?.key || "metric"}`}
      className="grid min-h-[118px] content-between rounded-md border px-3 py-2.5 text-xs"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 84%, var(--accent-primary) 16%)",
        background:
          "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 84%, var(--bg-editor) 16%))",
      }}
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div
            className="min-w-0 break-words text-[11px] font-semibold leading-4"
            title={metric?.label}
          >
            {metric?.label || "Metric"}
          </div>
          <Pill tone={tone}>{toneLabel(tone)}</Pill>
        </div>
        <div
          className="mt-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xl font-semibold leading-none tabular-nums sm:text-2xl"
          title={formatMetricValue(metric)}
          style={{ color: "var(--text-primary)" }}
        >
          {formatMetricValue(metric)}
        </div>
      </div>
      <div className="mt-3 grid gap-1.5">
        <SignalBar
          value={metricProgress(metric)}
          tone={tone}
          label={`${metric?.label || "metric"} progress`}
        />
        <div
          className="flex min-w-0 items-center justify-between gap-2 text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="min-w-0 truncate">{metricTargetLabel(metric)}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {evidenceCount} refs
          </span>
        </div>
      </div>
    </div>
  );
}

function SuccessMetricsDeck({ sections, summary }) {
  const sectionEntries = metricSectionEntries(sections);
  const allMetrics = sectionEntries.flatMap((section) => section.rows);
  const watchlist = allMetrics
    .slice()
    .sort((left, right) => metricAttentionScore(right) - metricAttentionScore(left))
    .slice(0, 6);
  const releaseCards = [
    {
      label: "Collisions avoided",
      value: compact(summary.collisionsAvoided, "0"),
      tone: summary.collisionsAvoided ? "active" : "idle",
      target: "tower prevented overlap",
    },
    {
      label: "Blocked writes",
      value: compact(summary.codeSiteFsBlockedWrites, "0"),
      tone: summary.codeSiteFsBlockedWrites ? "holding" : "idle",
      target: "pre-write guard evidence",
    },
    {
      label: "Line coverage",
      value: formatPercent(summary.lineProvenanceCoverage || 0),
      tone: summary.lineProvenanceCoverage ? "active" : "pending",
      target: "target 100% traced",
    },
    {
      label: "Black box",
      value:
        summary.blackBoxCompletenessScore == null
          ? "n/a"
          : formatPercent(summary.blackBoxCompletenessScore),
      tone: summary.blackBoxCompletenessScore ? "active" : "pending",
      target: "release >=75%",
    },
  ];

  return (
    <div
      data-testid="codesite-success-metrics"
      className="grid min-w-0 gap-4"
    >
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 70%, var(--accent-primary) 30%)",
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent-primary) 7%), var(--bg-editor))",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Release SLO posture</div>
              <div
                className="mt-1 max-w-[62ch] text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Measured outcomes tied to CodeSite artifacts, not screen-only
                claims.
              </div>
            </div>
            <Pill tone={watchlist.some((metric) => metricAttentionScore(metric) >= 80) ? "holding" : "active"}>
              {allMetrics.length} signals
            </Pill>
          </div>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-2">
            {releaseCards.map((card) => (
              <div
                key={card.label}
                className="rounded-md border px-3 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="text-[10px] font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.label}
                </div>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <div className="font-mono text-xl font-semibold tabular-nums">
                    {card.value}
                  </div>
                  <span
                    className="mb-1 h-2 w-2 rounded-full"
                    style={indicatorTone(card.tone)}
                  />
                </div>
                <div
                  className="mt-1 truncate text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                  title={card.target}
                >
                  {card.target}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {watchlist.map((metric) => (
            <MetricScorecard key={metric.key || metric.label} metric={metric} />
          ))}
        </div>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-4">
        {sectionEntries.map((section) => (
          <div
            key={section.title}
            className="min-w-0 rounded-lg border px-3 py-2"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <MetricsGroup title={section.title} rows={section.rows} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RunwayOccupancyBoard({ runways }) {
  const rows = asArray(runways);
  if (!rows.length) return <EmptyLine>No occupied runways</EmptyLine>;
  return (
    <div
      data-testid="codesite-runway-occupancy"
      className="min-w-0 overflow-hidden rounded border"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {rows.map((runway, index) => {
        const diffPaths = asArray(
          runway.diffPaths?.length ? runway.diffPaths : runway.route,
        );
        const pendingInspections = asArray(runway.pendingInspections);
        const eligibleFlights = asArray(runway.eligibleFlights);
        return (
          <div
            key={`${runway.mutationLeaseId || runway.runway || "runway"}-${index}`}
            data-testid="codesite-runway-row"
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 lg:grid-cols-[minmax(136px,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]"
            style={{
              borderColor: "var(--border-subtle)",
              background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
            }}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-medium"
                  title={runway.runway || "unassigned runway"}
                >
                  {compact(runway.runway, "unassigned runway")}
                </span>
                <Pill tone={runway.runwayClass === "A" ? "holding" : "active"}>
                  Class {compact(runway.runwayClass, "C")}
                </Pill>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Pill tone="active">
                  {compact(runway.occupiedBy, "occupied")}
                </Pill>
                {runway.mutationLeaseId ? (
                  <Pill>{compact(runway.mutationLeaseId, "lease")}</Pill>
                ) : null}
              </div>
            </div>
            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Diff on runway
              </div>
              <PathList paths={diffPaths} empty="no diff yet" maxVisible={3} />
            </div>
            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Pending inspections
              </div>
              <PathList
                paths={pendingInspections}
                empty="none pending"
                maxVisible={3}
              />
            </div>
            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Can land
              </div>
              <PathList
                paths={eligibleFlights}
                empty="runway locked"
                maxVisible={3}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TowerSimulatorDeck({
  towerSimulation,
  latestSimulation,
  towerUniverses,
  selectedUniverse,
  assumptions,
  activeFlights,
  activeLeases,
  events,
  simulationRun,
  onRun,
  disabled,
}) {
  const reduceMotion = useReducedMotion();
  const selectedSignals = Object.entries(selectedUniverse?.sourceSignals || {})
    .map(([key, value]) => `${key}:${value}`)
    .filter((item) => !item.endsWith(":0"));
  const evidenceRefs = uniqueValues([
    ...asArray(towerSimulation?.evidenceRefs),
    ...asArray(latestSimulation?.run?.evidenceRefs),
    towerSimulation?.shadowJobRef,
    latestSimulation?.run?.shadowJobRef,
  ]);
  const selectedHealth = universeHealthScore(selectedUniverse);

  return (
    <div data-testid="codesite-tower-simulator" className="grid min-w-0 gap-3">
      <div
        className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,0.9fr)_auto]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 70%, var(--accent-primary) 30%)",
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent-primary) 8%), var(--bg-editor))",
        }}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Pill tone={selectedUniverse?.result || simulationRun.status}>
              {compact(
                towerSimulation?.selected,
                simulationRun.status === "running" ? "running" : "not run",
              )}
            </Pill>
            <Pill tone={selectedHealth >= 0.65 ? "active" : "holding"}>
              health {formatPercent(selectedHealth)}
            </Pill>
            {towerUniverses.length ? (
              <Pill>{towerUniverses.length} universes</Pill>
            ) : null}
          </div>
          <div className="mt-2 text-sm font-semibold">
            Counterfactual route board
          </div>
          <div
            className="mt-1 max-w-[70ch] text-xs leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Compares policy-safe routes before landing, using stale
            assumptions, inspection cost, unresolved risks, and proof refs.
          </div>
        </div>
        <IconButton
          title="Run Tower simulation"
          onClick={onRun}
          disabled={disabled}
          testId="codesite-run-tower-simulator"
        >
          <Radar className="h-3.5 w-3.5" />
          Simulate
        </IconButton>
      </div>
      {simulationRun.error ? (
        <div
          className="rounded border px-2 py-1 text-[11px]"
          style={{
            borderColor:
              "color-mix(in srgb, #ff5757 40%, var(--border-subtle))",
            color: "var(--text-primary)",
          }}
        >
          {simulationRun.error}
        </div>
      ) : null}
      {towerUniverses.length === 0 ? (
        <EmptyLine>No simulator run recorded</EmptyLine>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
            <Metric
              label="Selected"
              value={compact(towerSimulation?.selected, "none")}
              tone={selectedUniverse?.result || "idle"}
              testId="codesite-tower-selected"
            />
            <Metric
              label="Collision"
              value={formatPercent(selectedUniverse?.predictedCollisionRisk)}
              tone={selectedUniverse?.result || "idle"}
            />
            <Metric
              label="Inspect"
              value={selectedUniverse?.inspectionCost ?? 0}
            />
            <Metric
              label="Confidence"
              value={formatPercent(selectedUniverse?.confidence)}
            />
          </div>
          <AssumptionInvalidatorPanel
            assumptions={assumptions}
            towerUniverses={towerUniverses}
            activeFlights={activeFlights}
            activeLeases={activeLeases}
            events={events}
          />
          <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
            <div className="grid min-w-0 gap-2">
              {towerUniverses.map((universe, index) => {
                const selected =
                  universe.strategy === towerSimulation?.selected;
                const health = universeHealthScore(universe);
                return (
                  <motion.div
                    key={
                      universe.strategy ||
                      universe.id ||
                      `tower-universe-${index}`
                    }
                    data-testid="codesite-tower-universe"
                    className="rounded-lg border px-3 py-2 text-xs"
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: reduceMotion ? 0 : 0.2,
                      delay: reduceMotion ? 0 : index * 0.03,
                      ease: MOTION_EASE,
                    }}
                    style={{
                      borderColor: selected
                        ? "color-mix(in srgb, var(--accent-primary) 52%, var(--border-subtle))"
                        : "var(--border-subtle)",
                      background: selected
                        ? "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface))"
                        : "var(--bg-surface)",
                    }}
                  >
                    <div className="grid gap-3 sm:grid-cols-[minmax(128px,1fr)_minmax(0,1.4fr)_minmax(118px,0.65fr)] sm:items-center">
                      <div className="min-w-0">
                        <div className="break-words font-medium leading-tight">
                          {compact(universe.strategy, "strategy")}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Pill tone={universe.result}>
                            {compact(universe.result, "review")}
                          </Pill>
                          {selected ? <Pill tone="active">selected</Pill> : null}
                        </div>
                      </div>
                      <div className="grid min-w-0 gap-1">
                        <SignalBar
                          value={health}
                          tone={health >= 0.65 ? "active" : "holding"}
                          label={`${compact(universe.strategy, "strategy")} health`}
                        />
                        <div
                          className="grid gap-1 text-[11px] sm:grid-cols-3"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <span>
                            Risk{" "}
                            <strong className="font-mono tabular-nums">
                              {formatPercent(universe.predictedCollisionRisk)}
                            </strong>
                          </span>
                          <span>
                            Stale{" "}
                            <strong className="font-mono tabular-nums">
                              {universe.staleAssumptions ?? 0}
                            </strong>
                          </span>
                          <span>
                            Cost{" "}
                            <strong className="font-mono tabular-nums">
                              {universe.inspectionCost ?? 0}
                            </strong>
                          </span>
                        </div>
                      </div>
                      <div className="justify-self-start sm:justify-self-end">
                        <Pill
                          tone={
                            universe.unresolvedRisks?.length
                              ? "holding"
                              : "active"
                          }
                        >
                          {asArray(universe.unresolvedRisks).length} unresolved
                        </Pill>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Tower actions
                        </div>
                        <PathList
                          paths={universe.requiredTowerActions || []}
                          empty="none"
                          maxVisible={6}
                        />
                      </div>
                      <div>
                        <div
                          className="text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Reason codes
                        </div>
                        <PathList
                          paths={universe.reasonCodes || []}
                          empty="none"
                          maxVisible={6}
                        />
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
            <div className="grid min-w-0 content-start gap-2">
              <div
                className="rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="mb-1 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Signals used
                </div>
                <PathList
                  paths={selectedSignals}
                  empty="no source signals"
                  maxVisible={10}
                />
              </div>
              <div
                className="rounded-lg border px-3 py-2 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="mb-1 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Evidence
                </div>
                <PathList paths={evidenceRefs} empty="none" maxVisible={10} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AssumptionInvalidatorPanel({
  assumptions,
  towerUniverses,
  activeFlights,
  activeLeases,
  events,
}) {
  const rows = invalidatedAssumptionRows({
    assumptions,
    towerUniverses,
    activeFlights,
    activeLeases,
    events,
  });
  if (!rows.length) {
    return (
      <div
        data-testid="codesite-assumption-invalidator"
        className="rounded-lg border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">Assumption invalidator</span>
          <Pill tone="active">clear</Pill>
        </div>
        <div className="mt-1" style={{ color: "var(--text-muted)" }}>
          No stale assumptions are currently holding writes.
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="codesite-assumption-invalidator"
      className="grid min-w-0 gap-2 rounded-lg border p-3 text-xs"
      style={{
        borderColor:
          "color-mix(in srgb, #fbbf24 34%, var(--border-subtle))",
        background:
          "linear-gradient(180deg, color-mix(in srgb, #fbbf24 8%, var(--bg-surface)), var(--bg-editor))",
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">Assumption invalidator</div>
          <div className="mt-1" style={{ color: "var(--text-muted)" }}>
            Stale reasoning is grounded before writes continue.
          </div>
        </div>
        <Pill tone="holding">
          {rows.reduce((sum, row) => sum + (row.staleCount || 1), 0)} paused
        </Pill>
      </div>
      <div className="grid gap-2 xl:grid-cols-2">
        {rows.slice(0, 4).map((row, index) => (
          <div
            key={row.id || `assumption-${index}`}
            className="rounded-md border px-2 py-2"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words font-medium leading-tight">
                  {compact(row.assumption, "stale assumption")}
                </div>
                <div
                  className="mt-1 break-words font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  invalidated by {compact(row.invalidatedBy, "tower")}
                </div>
              </div>
              <Pill tone="holding">writes paused</Pill>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="min-w-0">
                <div
                  className="text-[10px] font-semibold uppercase tracking-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  Affected
                </div>
                <PathList paths={row.affected} empty="session pending" />
              </div>
              <div className="min-w-0">
                <div
                  className="text-[10px] font-semibold uppercase tracking-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  Depends on
                </div>
                <PathList paths={row.dependsOn} empty="dependency pending" />
              </div>
            </div>
            <div className="mt-2">
              <PathList
                paths={row.evidenceRefs}
                empty="evidence recorded in simulator"
                maxVisible={4}
              />
            </div>
          </div>
        ))}
      </div>
      {rows.length > 4 ? (
        <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          Showing 4 of {rows.length} invalidation groups; export retains the
          full assumption ledger.
        </div>
      ) : null}
    </div>
  );
}

function SerializableIsolationDeck({
  activeTransactions,
  mutationTransactions,
  proofBundles,
  events,
}) {
  const transactions = mergeTransactionSources(
    activeTransactions,
    mutationTransactions,
  );
  const visibleTransactions = transactions.slice(0, 8);
  const hiddenTransactions = transactions.length - visibleTransactions.length;
  const recentBundles = asArray(proofBundles).slice(-3).reverse();

  if (!transactions.length && !recentBundles.length) {
    return <EmptyLine>No serializable transactions recorded</EmptyLine>;
  }

  return (
    <div data-testid="codesite-serializable-isolation" className="grid gap-3">
      <div
        className="grid gap-2 rounded-lg border px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
          background:
            "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
        }}
      >
        <div className="min-w-0">
          <div className="font-semibold">Serializable isolation report</div>
          <div
            className="mt-1 max-w-[76ch] leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Database-style mutation validation with base snapshot, declared
            reads, observed reads, writes, result, reason, and tower action.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:justify-end">
          <Pill>{transactions.length} txns</Pill>
          {hiddenTransactions > 0 ? (
            <Pill tone="holding">+{hiddenTransactions} archived</Pill>
          ) : null}
        </div>
      </div>
      {visibleTransactions.map((transaction, index) => {
        const rowEvents = transactionEvents(transaction, events);
        const proofBundle = transactionProofBundle(transaction, proofBundles);
        const declaredReads = asArray(transaction.readSet);
        const observedReads = asArray(transaction.observedReadSet);
        const writes = asArray(
          transaction.writeSet?.length
            ? transaction.writeSet
            : transaction.observedWriteSet,
        );
        const result = compact(transaction.status, "pending");
        const reason = transactionReason(transaction, rowEvents);
        const towerAction = transactionTowerAction(transaction, rowEvents);
        return (
          <div
            key={transaction.id || `transaction-${index}`}
            className="rounded-lg border p-3 text-xs"
            style={{
              borderColor:
                result === "aborted"
                  ? "color-mix(in srgb, #ff5757 42%, var(--border-subtle))"
                  : "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px]">
                  {compact(transaction.id, "transaction")}
                </div>
                <div
                  className="mt-0.5 text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {transaction.live ? "live" : "recorded"} / opened{" "}
                  {formatTime(transaction.openedAt) || "pending"}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Pill tone={transaction.isolation || "pending"}>
                  {compact(transaction.isolation, "isolation")}
                </Pill>
                <Pill tone={transaction.status}>{result}</Pill>
              </div>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <div className="min-w-0 rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Base snapshot
                </div>
                <div
                  className="truncate font-mono text-[10px]"
                  title={transaction.baseSnapshot || ""}
                >
                  {transactionDigestLabel(transaction.baseSnapshot)}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Declared read set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {declaredReads.length}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Observed read set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {observedReads.length}
                </div>
              </div>
              <div className="rounded-md border px-2 py-1.5" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Write set
                </div>
                <div className="font-mono text-lg font-semibold leading-none">
                  {writes.length}
                </div>
              </div>
            </div>
            <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]">
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <div
                    className="text-[10px] font-semibold uppercase tracking-normal"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Reads
                  </div>
                  <PathList
                    paths={uniqueValues([...declaredReads, ...observedReads])}
                    empty="read set pending"
                    maxVisible={4}
                  />
                </div>
                <div className="min-w-0">
                  <div
                    className="text-[10px] font-semibold uppercase tracking-normal"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Writes
                  </div>
                  <PathList
                    paths={writes}
                    empty="write set pending"
                    maxVisible={4}
                  />
                </div>
              </div>
              <div
                className="min-w-0 rounded-md border px-2 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div
                  className="text-[10px] font-semibold uppercase tracking-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  Result
                </div>
                <div className="mt-1 break-words">
                  Reason:{" "}
                  <span className="font-mono text-[10px]">{reason}</span>
                </div>
                <div className="mt-1 break-words">
                  Tower action:{" "}
                  <span className="font-mono text-[10px]">{towerAction}</span>
                </div>
                <div className="mt-2">
                  <PathList
                    paths={uniqueValues([
                      transaction.proofBundleDigest,
                      proofBundle?.id,
                      proofBundle?.bundleDigest,
                      ...asArray(proofBundle?.evidenceRefs),
                    ])}
                    empty="proof pending"
                    maxVisible={4}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {recentBundles.length ? (
        <div className="grid gap-2">
          {recentBundles.map((bundle, index) => (
            <div
              key={bundle.id || `proof-bundle-${index}`}
              className="rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
              }}
            >
              <div className="grid min-h-10 grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] items-center gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[11px]">
                    {bundle.id}
                  </div>
                  <div
                    className="text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    proof bundle
                  </div>
                </div>
                <div
                  className="min-w-0 truncate font-mono text-[11px]"
                  title={bundle.bundleDigest || bundle.readSetDigest}
                >
                  {bundle.bundleDigest || bundle.readSetDigest}
                </div>
                <div className="justify-self-end">
                  <CheckCircle2
                    className="h-4 w-4"
                    style={{
                      color:
                        "color-mix(in srgb, #4ade80 70%, var(--text-primary))",
                    }}
                  />
                </div>
              </div>
              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                <PathList
                  paths={bundle.evidenceRefs || []}
                  empty="no evidence refs"
                />
                <PathList
                  paths={Object.entries(bundle.trailers || {}).map(
                    ([key, value]) => `${key}: ${value}`,
                  )}
                  empty="no trailers"
                  maxVisible={10}
                />
              </div>
              {bundle.repoState ? (
                <div className="mt-1">
                  <PathList
                    paths={[
                      bundle.repoState.evidenceDigest &&
                        `repo-state:${bundle.repoState.evidenceDigest}`,
                      bundle.repoState.gitHead &&
                        `git-head:${bundle.repoState.gitHead}`,
                      bundle.repoState.worktreeDiffDigest &&
                        `worktree-diff:${bundle.repoState.worktreeDiffDigest}`,
                      ...asArray(bundle.repoState.writeFileDigests).map(
                        (file) => `${file.path}:${file.digest || "missing"}`,
                      ),
                    ].filter(Boolean)}
                    empty="no repo-state evidence"
                    maxVisible={6}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PilotLicenseHealthPanel({ records }) {
  const rows = asArray(records);
  if (!rows.length) return <EmptyLine>No pilot licenses on file</EmptyLine>;
  return (
    <div
      data-testid="codesite-pilot-license-health"
      className="min-w-0 overflow-hidden rounded border"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {rows.map((record, index) => {
        const sourceDrift = record.sourceDrift || {};
        const landingStats = record.landingStats || {};
        const violationStats = record.violationStats || {};
        return (
          <div
            key={
              record.key ||
              record.agentSessionId ||
              record.displayCallsign ||
              index
            }
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 lg:grid-cols-[minmax(124px,0.8fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(96px,0.75fr)]"
            style={{
              borderColor: "var(--border-subtle)",
              background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
            }}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="truncate font-medium"
                  title={
                    record.displayCallsign || record.agentSessionId || "agent"
                  }
                >
                  {compact(
                    record.displayCallsign || record.agentSessionId,
                    "agent",
                  )}
                </span>
                <Pill tone={record.status}>
                  {compact(record.status, "unknown")}
                </Pill>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Pill>{compact(record.level, "Student")}</Pill>
                {sourceDrift.expired ? (
                  <Pill tone="blocked">source drift</Pill>
                ) : null}
                {record.requiredAction ? (
                  <Pill tone="holding">action</Pill>
                ) : null}
              </div>
            </div>
            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Authorized airspace
              </div>
              <PathList
                paths={record.authorizedAirspace || []}
                empty="none filed"
                maxVisible={3}
              />
              <TagList
                items={[
                  record.dojoLicenseRef,
                  record.dojoProofRef,
                  record.dojoDecisionDigest,
                ]}
                empty=""
                maxVisible={3}
              />
            </div>
            <div className="min-w-0">
              <div className="grid grid-cols-3 gap-2">
                {[
                  [
                    "Landings",
                    `${landingStats.passed || 0}/${landingStats.total || 0}`,
                    landingStats.failed || 0 ? "holding" : "active",
                  ],
                  [
                    "Violations",
                    violationStats.total || 0,
                    violationStats.critical || 0
                      ? "blocked"
                      : violationStats.total || 0
                        ? "holding"
                        : "idle",
                  ],
                  [
                    "Radar",
                    asArray(record.requiredRadar).length,
                    asArray(record.requiredRadar).length ? "active" : "idle",
                  ],
                ].map(([label, value, tone]) => (
                  <div
                    key={label}
                    className="min-w-0 border-t pt-1"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <div
                      className="truncate text-[10px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {label}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      <span
                        className="truncate font-mono text-xs tabular-nums"
                        title={String(value)}
                      >
                        {value}
                      </span>
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={riskTone(tone)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Health reasons
              </div>
              <TagList
                items={record.reasonCodes || []}
                empty="clear"
                maxVisible={3}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FilesystemBoundaryProofPanel({ records }) {
  const rows = asArray(records);
  if (!rows.length)
    return <EmptyLine>No filesystem boundary proofs recorded</EmptyLine>;

  return (
    <div
      data-testid="codesite-filesystem-boundary-proof"
      className="min-w-0 overflow-hidden rounded border"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {rows.map((record, index) => {
        const processChain = asArray(record.process?.ancestry);
        const evidenceRefs = uniqueValues([
          ...asArray(record.evidenceRefs),
          ...asArray(record.evidence?.refs),
        ]);
        const inspectedLeaseIds = uniqueValues(
          asArray(record.inspectedLeases).map((lease) => lease.mutationLeaseId),
        );
        const leaseLabel =
          record.mutationLeaseId ||
          record.requestedMutationLeaseId ||
          record.lease?.id ||
          inspectedLeaseIds[0] ||
          record.leaseState ||
          "no_active_clearance";
        const leaseTone = record.mutationLeaseId ? "active" : "holding";
        return (
          <div
            key={record.proofId || `${record.eventId || "event"}-${index}`}
            data-testid="codesite-filesystem-boundary-proof-row"
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 lg:grid-cols-[minmax(126px,0.78fr)_minmax(0,1.18fr)_minmax(0,1.05fr)_minmax(0,1fr)]"
            style={{
              borderColor: "var(--border-subtle)",
              background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
            }}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Pill
                  tone={record.proofComplete ? record.disposition : "holding"}
                >
                  {record.proofComplete ? "complete" : "incomplete"}
                </Pill>
                <Pill tone={record.disposition}>
                  {compact(record.disposition, "write_denied")}
                </Pill>
              </div>
              <div
                className="mt-1 truncate font-medium"
                title={
                  record.displayCallsign ||
                  record.boundary?.source ||
                  "CodeSiteFS"
                }
              >
                {compact(
                  record.displayCallsign || record.boundary?.source,
                  "CodeSiteFS",
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Pill>
                  {compact(
                    record.boundary?.tool || record.boundary?.operation,
                    "write",
                  )}
                </Pill>
                {record.quarantine?.quarantineId ? (
                  <Pill tone="holding">quarantine</Pill>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Path and lease
              </div>
              <ProofValueList
                values={[record.path].filter(Boolean)}
                empty="missing path"
                maxVisible={1}
              />
              <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                <Pill tone={leaseTone}>
                  {compact(record.leaseState, "no_active_clearance")}
                </Pill>
                <code
                  className="max-w-full truncate rounded border px-1.5 py-0.5 text-[10px]"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-surface)",
                    color: "var(--text-secondary)",
                  }}
                  title={leaseLabel}
                >
                  {leaseLabel}
                </code>
                {inspectedLeaseIds.length ? (
                  <Pill tone="idle">{inspectedLeaseIds.length} inspected</Pill>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Reason and process
              </div>
              <TagList
                items={record.reasonCodes || []}
                empty="missing reason"
                maxVisible={3}
              />
              <div
                className="mt-1 truncate font-mono text-[10px]"
                style={{
                  color: processChain.length
                    ? "var(--text-secondary)"
                    : "var(--text-muted)",
                }}
                title={record.process?.display || processChain.join(" <- ")}
              >
                {processChain.length
                  ? processChain.join(" <- ")
                  : "missing process ancestry"}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Evidence
              </div>
              <ProofValueList
                values={evidenceRefs}
                empty="missing evidence"
                maxVisible={3}
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {asArray(record.missingProofFields).map((field) => (
                  <Pill key={field} tone="holding">
                    missing {field}
                  </Pill>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProofValueList({ values, empty = "none", maxVisible = 3 }) {
  const list = asArray(values);
  const visible = list.slice(0, maxVisible);
  if (!visible.length) {
    return <span style={{ color: "var(--text-muted)" }}>{empty}</span>;
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-1">
      {visible.map((value, index) => (
        <code
          key={`${value}-${index}`}
          className="block min-w-0 max-w-full whitespace-normal break-all rounded border px-1.5 py-0.5 text-[10px] leading-4"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
            color: "var(--text-secondary)",
            overflow: "visible",
            textOverflow: "clip",
            whiteSpace: "normal",
            wordBreak: "break-all",
          }}
          title={value}
        >
          {value}
        </code>
      ))}
      {list.length > visible.length ? (
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          +{list.length - visible.length}
        </span>
      ) : null}
    </div>
  );
}

function QuarantineReviewPanel({
  records,
  fetchError,
  selectedId,
  selectedPaths,
  reviewState,
  onSelect,
  onTogglePath,
  onReplay,
  onApply,
  disabled,
}) {
  const rows = asArray(records);
  const selected =
    rows.find((record) => record.quarantineId === selectedId) ||
    rows[0] ||
    null;
  const changes = asArray(selected?.changes);
  const replayOk =
    reviewState.replay?.ok === true &&
    reviewState.replayPathKey === selectedPathKey(selectedPaths);
  const selectedSet = new Set(selectedPaths);
  const reviewMessage = quarantineReviewMessage(reviewState);
  const selectedStatus = selected
    ? quarantineDisplayStatus(selected, reviewState)
    : "reviewable";
  const selectedRemainingPaths = selected
    ? quarantineRemainingPaths(selected, reviewState)
    : [];
  const selectedLifecycle = selected
    ? {
        ...(selected.lifecycle || {}),
        reviewedAt:
          reviewState.replay?.timelineEvents?.reviewed?.createdAt ||
          selected.lifecycle?.reviewedAt,
        replayedAt:
          reviewState.replay?.ok === true
            ? reviewState.replay?.timelineEvents?.replayed?.createdAt ||
              selected.lifecycle?.replayedAt
            : selected.lifecycle?.replayedAt,
        appliedAt:
          reviewState.apply?.timelineEvent?.createdAt ||
          reviewState.apply?.timelineEvents?.applied?.createdAt ||
          selected.lifecycle?.appliedAt,
      }
    : {};
  const totalQueuedPaths = rows.reduce(
    (total, record) =>
      total +
      Math.max(asArray(record.changes).length, asArray(record.paths).length),
    0,
  );
  const queueStatusCounts = Object.entries(
    countBy(
      rows.map((record) =>
        quarantineDisplayStatus(
          record,
          record.quarantineId === selected?.quarantineId
            ? reviewState
            : undefined,
        ),
      ),
    ),
  );
  const queueCallsigns = uniqueValues(
    rows.map((record) => compact(record.displayCallsign, "codesitefs")),
  );
  const quarantineRailStats = [
    ["Manifests", rows.length],
    ["Paths", totalQueuedPaths],
    ["Selected", selectedPaths.length],
    ["Remaining", selectedRemainingPaths.length],
  ];
  const selectedChangeKinds = Object.entries(
    countBy(
      (changes.length
        ? changes
        : asArray(selected?.paths).map((path) => ({ path }))
      ).map((change) => compact(change.kind || change.change_kind, "modified")),
    ),
  );
  const selectedTraceSteps = [
    ["Captured", selectedLifecycle.capturedAt],
    ["Reviewed", selectedLifecycle.reviewedAt],
    ["Replayed", selectedLifecycle.replayedAt],
    ["Applied", selectedLifecycle.appliedAt],
  ];
  const selectedTracePaths = selectedRemainingPaths.length
    ? selectedRemainingPaths
    : selectedPaths;

  if (!rows.length) {
    return fetchError ? (
      <div
        data-testid="codesite-quarantine-fetch-error"
        className="rounded border px-3 py-2 text-xs"
        style={{
          borderColor: "color-mix(in srgb, #ff5757 40%, var(--border-subtle))",
          background: "var(--bg-surface)",
        }}
      >
        Quarantine manifests unavailable:{" "}
        {compact(fetchError.message, "fetch failed")}
      </div>
    ) : (
      <EmptyLine>No CodeSiteFS quarantines waiting for review</EmptyLine>
    );
  }

  return (
    <div
      data-testid="codesite-quarantine-review"
      className="grid min-w-0 gap-3 xl:grid-cols-[minmax(220px,0.78fr)_minmax(0,1.22fr)]"
    >
      <div className="grid min-w-0 gap-2 xl:min-h-full xl:grid-rows-[auto_auto_auto_minmax(180px,1fr)]">
        <div
          className="min-w-0 overflow-hidden rounded border"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          {rows.map((record) => {
            const active = selected?.quarantineId === record.quarantineId;
            const displayStatus = active
              ? quarantineDisplayStatus(record, reviewState)
              : quarantineDisplayStatus(record);
            return (
              <button
                key={record.quarantineId}
                type="button"
                data-testid="codesite-quarantine-row"
                aria-pressed={active}
                onClick={() => onSelect(record)}
                className="block w-full border-t px-3 py-2 text-left text-xs first:border-t-0"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: active
                    ? "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface))"
                    : "var(--bg-surface)",
                  color: "var(--text-primary)",
                }}
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <code
                    className="min-w-0 truncate text-[10px]"
                    title={record.quarantineId}
                  >
                    {record.quarantineId}
                  </code>
                  <Pill tone={displayStatus}>{displayStatus}</Pill>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Pill>{compact(record.displayCallsign, "codesitefs")}</Pill>
                  <Pill>
                    {asArray(record.changes).length ||
                      asArray(record.paths).length}{" "}
                    paths
                  </Pill>
                </div>
                <div className="mt-1">
                  <PathList
                    paths={record.paths}
                    empty="no paths"
                    maxVisible={2}
                  />
                </div>
              </button>
            );
          })}
        </div>

        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background:
              "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">Review queue</span>
            <Pill tone={selectedRemainingPaths.length ? "holding" : "active"}>
              {selectedRemainingPaths.length ? "actionable" : "clear"}
            </Pill>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {quarantineRailStats.map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border px-2 py-1"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {label}
                </div>
                <div className="font-mono text-sm font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {queueStatusCounts.map(([status, count]) => (
              <Pill key={status} tone={status}>
                {status} {count}
              </Pill>
            ))}
          </div>
        </div>

        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
          }}
        >
          <div className="font-semibold">Runtime boundary</div>
          <div
            className="mt-1 leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Raw writes stay outside the source tree until replay validates the
            selected manifest paths.
          </div>
          <div className="mt-2">
            <PathList
              paths={queueCallsigns}
              empty="no active filesystem actors"
              maxVisible={4}
            />
          </div>
        </div>

        <div
          data-testid="codesite-quarantine-rail-trace"
          className="flex min-h-44 flex-col rounded border px-3 py-2 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
            background:
              "radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 44%), var(--bg-surface)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Containment trace</span>
            <Pill tone={selectedStatus}>{selectedStatus}</Pill>
          </div>
          <div className="mt-2 grid gap-1.5">
            {selectedTraceSteps.map(([label, value], index) => (
              <div
                key={label}
                className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border"
                  style={{
                    borderColor: value
                      ? "color-mix(in srgb, #4ade80 72%, var(--border-subtle))"
                      : "var(--border-subtle)",
                    background: value
                      ? "color-mix(in srgb, #4ade80 34%, transparent)"
                      : "var(--bg-editor)",
                    boxShadow:
                      value && index === selectedTraceSteps.length - 1
                        ? "0 0 0 4px color-mix(in srgb, #4ade80 12%, transparent)"
                        : "none",
                  }}
                />
                <div className="min-w-0">
                  <div style={{ color: "var(--text-muted)" }}>{label}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    title={value || ""}
                  >
                    {formatTime(value) || "pending"}
                  </div>
                </div>
                <Pill tone={value ? "active" : "holding"}>
                  {value ? "logged" : "wait"}
                </Pill>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {selectedChangeKinds.map(([kind, count]) => (
              <Pill key={kind}>
                {kind} {count}
              </Pill>
            ))}
          </div>
          <div className="mt-auto pt-3">
            <div
              className="mb-1 text-[10px] uppercase tracking-[0.14em]"
              style={{ color: "var(--text-muted)" }}
            >
              Review path scope
            </div>
            <PathList
              paths={selectedTracePaths}
              empty="no selected paths"
              maxVisible={3}
            />
          </div>
        </div>
      </div>

      <div
        data-testid="codesite-quarantine-detail"
        className="min-w-0 overflow-hidden rounded border p-3 text-xs"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        {!selected ? (
          <EmptyLine>Select a quarantine</EmptyLine>
        ) : (
          <div className="space-y-3">
            <div
              data-testid="codesite-quarantine-summary"
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code
                    className="min-w-0 truncate text-[11px]"
                    title={selected.quarantineId}
                  >
                    {selected.quarantineId}
                  </code>
                  <Pill tone={selectedStatus}>{selectedStatus}</Pill>
                  <Pill>{selectedPaths.length} selected</Pill>
                  {selectedRemainingPaths.length ? (
                    <Pill tone="holding">
                      {selectedRemainingPaths.length} pending
                    </Pill>
                  ) : null}
                </div>
                <div className="mt-1 grid gap-1 text-[11px] sm:grid-cols-2">
                  <div className="min-w-0">
                    <span style={{ color: "var(--text-muted)" }}>
                      Transaction{" "}
                    </span>
                    <code className="truncate" title={selected.transactionId}>
                      {compact(selected.transactionId, "none")}
                    </code>
                  </div>
                  <div className="min-w-0">
                    <span style={{ color: "var(--text-muted)" }}>
                      Clearance{" "}
                    </span>
                    <code className="truncate" title={selected.mutationLeaseId}>
                      {compact(selected.mutationLeaseId, "none")}
                    </code>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 sm:justify-end">
                <IconButton
                  title="Replay selected quarantine paths"
                  onClick={() => onReplay(selected)}
                  disabled={
                    disabled ||
                    !selected.transactionId ||
                    selectedPaths.length === 0
                  }
                  testId="codesite-quarantine-replay-button"
                >
                  <FileSearch className="h-3.5 w-3.5" />
                  Replay
                </IconButton>
                <IconButton
                  title="Apply replayed quarantine paths"
                  onClick={() => onApply(selected)}
                  disabled={disabled || !replayOk || selectedPaths.length === 0}
                  variant={replayOk ? "primary" : "neutral"}
                  testId="codesite-quarantine-apply-button"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Apply
                </IconButton>
              </div>
            </div>

            {reviewMessage ? (
              <div
                role="alert"
                aria-live="polite"
                className="rounded border px-2 py-1 text-[11px]"
                style={{
                  borderColor:
                    "color-mix(in srgb, #ff5757 40%, var(--border-subtle))",
                }}
              >
                {reviewMessage}
              </div>
            ) : null}

            <div className="space-y-1">
              {(changes.length
                ? changes
                : selected.paths.map((path) => ({ path }))
              ).map((change) => {
                const path = quarantinePath(change);
                const checked = selectedSet.has(path);
                return (
                  <label
                    key={`${selected.quarantineId}-${path}-${quarantineEvidenceRef(change)}`}
                    data-testid="codesite-quarantine-change-row"
                    className="grid min-h-12 cursor-pointer grid-cols-[22px_minmax(0,1fr)] gap-2 rounded border px-2 py-1.5"
                    style={{
                      borderColor: checked
                        ? "color-mix(in srgb, var(--accent-primary) 44%, var(--border-subtle))"
                        : "var(--border-subtle)",
                      background: checked
                        ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-editor))"
                        : "var(--bg-editor)",
                    }}
                  >
                    <input
                      data-testid="codesite-quarantine-path-toggle"
                      type="checkbox"
                      checked={checked}
                      onChange={() => onTogglePath(path)}
                      className="mt-1 h-4 w-4"
                    />
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <code
                          className="min-w-0 truncate text-[10px]"
                          title={path}
                        >
                          {path}
                        </code>
                        <Pill>
                          {compact(
                            change.kind || change.change_kind,
                            "modified",
                          )}
                        </Pill>
                      </div>
                      <div className="mt-1 grid gap-1 sm:grid-cols-2">
                        <PathList
                          paths={[
                            quarantineDigest(change, "beforeDigest"),
                            quarantineDigest(change, "expectedDigest"),
                          ].filter(Boolean)}
                          empty="no base digest"
                          maxVisible={2}
                        />
                        <PathList
                          paths={[
                            quarantineDigest(change, "afterDigest"),
                            quarantineEvidenceRef(change),
                          ].filter(Boolean)}
                          empty="no after digest"
                          maxVisible={2}
                        />
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {asArray(selected.symlinkSanitization?.sanitized).length ? (
              <div
                data-testid="codesite-quarantine-symlink-guard"
                className="rounded border px-3 py-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, #fbbf24 36%, var(--border-subtle))",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 text-[11px] font-medium">
                  Symlink Escape Guard
                </div>
                {selected.symlinkSanitization.sanitized.map((item) => (
                  <div
                    key={`${item.path}-${item.resolvedTarget}`}
                    className="grid gap-1 border-t py-1 first:border-t-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]"
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    <code className="truncate text-[10px]" title={item.path}>
                      {item.path}
                    </code>
                    <code
                      className="truncate text-[10px]"
                      title={item.resolvedTarget || item.target}
                    >
                      {item.resolvedTarget || item.target}
                    </code>
                    <Pill tone="holding">
                      {compact(item.reason, "replaced")}
                    </Pill>
                  </div>
                ))}
              </div>
            ) : null}

            {reviewState.replay ? (
              <div
                data-testid="codesite-quarantine-replay-result"
                className="rounded border px-3 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">Replay result</span>
                  <Pill tone={reviewState.replay.ok ? "active" : "failed"}>
                    {reviewState.replay.ok ? "replayable" : "blocked"}
                  </Pill>
                </div>
                <PathList
                  paths={asArray(reviewState.replay.replay).map(
                    (item) => item.path,
                  )}
                  empty="no replayed paths"
                  maxVisible={8}
                />
                {asArray(reviewState.replay.rejected).length ? (
                  <div className="mt-2 space-y-1">
                    {reviewState.replay.rejected.map((item, index) => (
                      <div
                        key={`${item.path || "reject"}-${index}`}
                        data-testid="codesite-quarantine-rejected-row"
                        className="grid gap-2 rounded border px-2 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                        style={{
                          borderColor:
                            "color-mix(in srgb, #ff5757 36%, var(--border-subtle))",
                        }}
                      >
                        <code
                          className="truncate text-[10px]"
                          title={item.path}
                        >
                          {compact(item.path, "path")}
                        </code>
                        <PathList
                          paths={
                            item.reasonCodes ||
                            item.reason_codes ||
                            [item.error].filter(Boolean)
                          }
                          empty="rejected"
                          maxVisible={4}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {reviewState.apply ? (
              <div
                data-testid="codesite-quarantine-apply-result"
                className="rounded border px-3 py-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, #4ade80 36%, var(--border-subtle))",
                  background: "var(--bg-editor)",
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="font-medium">Apply result</span>
                  <Pill tone={reviewState.apply.ok ? "active" : "failed"}>
                    {reviewState.apply.ok ? "applied" : "blocked"}
                  </Pill>
                </div>
                <PathList
                  paths={asArray(reviewState.apply.applied).map(
                    (item) => item.path,
                  )}
                  empty="no applied paths"
                  maxVisible={8}
                />
              </div>
            ) : null}

            <div
              data-testid="codesite-quarantine-timeline"
              className="grid gap-1 text-[11px] sm:grid-cols-4"
            >
              {[
                ["Captured", selectedLifecycle.capturedAt],
                ["Reviewed", selectedLifecycle.reviewedAt],
                ["Replayed", selectedLifecycle.replayedAt],
                ["Applied", selectedLifecycle.appliedAt],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <div style={{ color: "var(--text-muted)" }}>{label}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    title={value || ""}
                  >
                    {formatTime(value) || "pending"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PathList({ paths, empty = "none", maxVisible = 4 }) {
  const list = asArray(paths);
  const visible = list.slice(0, maxVisible);
  if (visible.length === 0) {
    return <span style={{ color: "var(--text-muted)" }}>{empty}</span>;
  }

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-start gap-1 self-start overflow-hidden">
      {visible.map((path, index) => (
        <code
          key={`${path}-${index}`}
          className="inline-block min-w-0 max-w-full break-all rounded border px-1.5 py-0.5 text-[10px] leading-4 whitespace-normal"
          style={{
            maxWidth: "min(100%, 18rem)",
            borderColor: "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-secondary)",
          }}
          title={path}
        >
          {path}
        </code>
      ))}
      {list.length > visible.length ? (
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          +{list.length - visible.length}
        </span>
      ) : null}
    </div>
  );
}

function TagList({ items, empty = null, maxVisible = 5 }) {
  const list = asArray(items).filter(Boolean);
  const visible = list.slice(0, maxVisible);
  if (visible.length === 0)
    return empty ? (
      <span style={{ color: "var(--text-muted)" }}>{empty}</span>
    ) : null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
      {visible.map((item, index) => (
        <code
          key={`${item}-${index}`}
          className="max-w-full break-all rounded border px-1.5 py-0.5 text-[10px] leading-4 whitespace-normal"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-secondary)",
          }}
          title={item}
        >
          {item}
        </code>
      ))}
      {list.length > visible.length ? (
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          +{list.length - visible.length}
        </span>
      ) : null}
    </div>
  );
}

function Row({ children, testId }) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-10 grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] items-center gap-2 border-t py-2 text-xs first:border-t-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {children}
    </div>
  );
}

function EmptyLine({ children = "None" }) {
  return (
    <div
      className="rounded border px-3 py-3 text-xs"
      style={{
        borderColor: "var(--border-subtle)",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function MobileSectionTabs({ sections, activeSection, onSelect }) {
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    sections.findIndex((section) => section.key === activeSection),
  );
  return (
    <div
      data-testid="codesite-mobile-section-tabs"
      className="sticky top-0 z-20 border-b px-3 py-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.16)] md:hidden"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
        background:
          "color-mix(in srgb, var(--bg-sidebar) 96%, var(--accent-primary) 4%)",
      }}
    >
      <div
        className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border p-1"
        role="tablist"
        aria-label="CodeSite sections"
        style={{
          borderColor: "var(--border-subtle)",
          background: "color-mix(in srgb, var(--bg-editor) 76%, transparent)",
        }}
      >
        {sections.map((section) => (
          <motion.button
            key={section.key}
            type="button"
            role="tab"
            aria-selected={activeSection === section.key}
            aria-controls={`codesite-section-${section.key}`}
            data-testid="codesite-mobile-section-tab"
            onClick={() => onSelect(section.key)}
            whileTap={reduceMotion ? undefined : { scale: 0.985 }}
            className="relative inline-flex h-11 shrink-0 items-center rounded-md border px-3 text-[11px] font-semibold transition-[background,border-color,color] active:scale-[0.98]"
            style={{
              borderColor:
                activeSection === section.key
                  ? "color-mix(in srgb, var(--accent-primary) 54%, var(--border-subtle))"
                  : "var(--border-subtle)",
              background:
                activeSection === section.key
                  ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
                  : "var(--bg-elevated)",
              color: "var(--text-primary)",
              transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            {activeSection === section.key && !reduceMotion ? (
              <motion.span
                layoutId="codesite-mobile-active-section"
                className="absolute inset-0 rounded-md"
                style={{
                  border: "1px solid color-mix(in srgb, var(--accent-primary) 54%, transparent)",
                }}
                transition={{ duration: 0.2, ease: MOTION_EASE }}
              />
            ) : null}
            <span className="relative">{section.label}</span>
            <span
              className="relative ml-2 h-1.5 w-1.5 rounded-full"
              style={{
                background:
                  activeSection === section.key
                    ? "var(--accent-primary)"
                    : "var(--border-subtle)",
              }}
            />
          </motion.button>
        ))}
      </div>
      <div
        data-testid="codesite-mobile-action-drawer"
        className="mt-2 grid gap-2 rounded-lg border p-2 text-[11px]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background:
            "color-mix(in srgb, var(--bg-elevated) 92%, var(--bg-editor) 8%)",
          color: "var(--text-muted)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span>Section</span>
          <span
            className="font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {sections.find((section) => section.key === activeSection)?.label ||
              "Radar"}
          </span>
        </div>
        <div
          className="h-1 overflow-hidden rounded-full"
          style={{ background: "var(--bg-editor)" }}
        >
          <motion.div
            className="h-full w-full rounded-full"
            style={{
              background: "var(--accent-primary)",
              transformOrigin: "left center",
            }}
            initial={false}
            animate={{
              scaleX: (activeIndex + 1) / Math.max(1, sections.length),
            }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: MOTION_EASE }}
          />
        </div>
        <span className="sr-only">
          {reduceMotion
            ? "Reduced motion active"
            : "Animated section jump active"}
        </span>
      </div>
    </div>
  );
}

function TowerStreamPanel({ events, streamStatus, condensed = false }) {
  const reduceMotion = useReducedMotion();
  const rows = asArray(events).slice(0, condensed ? 5 : 8);
  return (
    <div
      data-testid="codesite-tower-feed"
      className={
        condensed
          ? "grid min-w-0 gap-2"
          : "grid min-w-0 gap-2 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
      }
    >
      <div
        className="rounded-lg border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 8%), var(--bg-surface))",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Tower stream</div>
            <div
              data-testid="codesite-event-stream-status"
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {streamStatus === "live"
                ? "EventSource live"
                : streamStatus === "reconnecting"
                  ? "Reconnecting to tower stream"
                  : "Polling fallback active"}
            </div>
          </div>
          <Pill
            tone={
              streamStatus === "live"
                ? "active"
                : streamStatus === "reconnecting"
                  ? "warning"
                  : "idle"
            }
          >
            {streamStatus}
          </Pill>
        </div>
        <div
          data-testid="codesite-transponder-stream"
          className="mt-3 grid grid-cols-3 gap-2"
        >
          <Metric
            label="Events"
            value={rows.length}
            tone={rows.length ? "active" : "idle"}
          />
          <Metric
            label="Instructions"
            value={
              rows.filter((event) =>
                String(event.eventType || "").includes("tower"),
              ).length
            }
          />
          <Metric
            label="Blocks"
            value={
              rows.filter((event) =>
                /denied|quarantined|ground_stop/i.test(
                  String(event.eventType || ""),
                ),
              ).length
            }
            tone="holding"
          />
        </div>
      </div>
      <div
        className="min-w-0 overflow-hidden rounded-lg border"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
          background: "var(--bg-surface)",
        }}
      >
        <div
          className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-2 border-b px-3 py-2 text-[10px] font-semibold"
          style={{
            borderColor: "var(--border-subtle)",
            color: "var(--text-muted)",
            background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)",
          }}
        >
          <span>Time</span>
          <span>Instruction</span>
          <span>Actor</span>
        </div>
        <AnimatePresence initial={false}>
          {rows.length ? (
            rows.map((event, index) => (
              <motion.div
                key={
                  event.id ||
                  `${event.eventType || "event"}-${event.createdAt || index}`
                }
                data-testid="codesite-tower-instruction-row"
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: -8 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.22,
                  ease: MOTION_EASE,
                }}
                className="grid min-h-11 grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 text-xs first:border-t-0"
                style={{
                  borderColor: "var(--border-subtle)",
                  background:
                    index === 0
                      ? "color-mix(in srgb, var(--accent-primary) 8%, transparent)"
                      : "transparent",
                }}
              >
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatTime(event.createdAt)}
                </span>
                <span className="min-w-0 break-words">
                  <span className="font-medium">
                    {towerInstructionText(event)}
                  </span>
                  <span
                    className="ml-1 text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {towerEventKind(event)}
                  </span>
                </span>
                <Pill tone={event.eventType}>
                  {compact(event.displayCallsign || event.actorType, "tower")}
                </Pill>
              </motion.div>
            ))
          ) : (
            <div className="p-3">
              <EmptyLine>No tower events received</EmptyLine>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function GovernanceReviewGate({ action, rationale, onRationale, onCancel, onConfirm, disabled }) {
  if (!action) return null;
  const summary = actionReviewSummary(action);
  const canConfirm = String(rationale || "").trim().length >= 12;
  return (
    <motion.div
      layout
      data-testid="codesite-governance-review-gate"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="rounded-lg border p-3"
      style={{
        borderColor:
          summary.severity === "critical"
            ? "color-mix(in srgb, var(--accent-danger) 50%, var(--border-subtle))"
            : "color-mix(in srgb, var(--accent-primary) 38%, var(--border-subtle))",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 6%), var(--bg-surface))",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">Review before tower action</div>
          <div
            className="mt-1 break-words text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            {compact(action.title || action.label, actionLabel(action))}
          </div>
        </div>
        <Pill tone={summary.severity}>{summary.severity}</Pill>
      </div>
      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
        <div>
          <div style={{ color: "var(--text-muted)" }}>Owner</div>
          <div className="mt-1 break-all font-mono">{summary.owner}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)" }}>Target</div>
          <div className="mt-1 break-all font-mono">{summary.entity}</div>
        </div>
        <div>
          <div style={{ color: "var(--text-muted)" }}>Evidence</div>
          <div className="mt-1 break-all font-mono">
            {summary.evidenceRefs[0] || action.evidenceRefs?.[0] || "required"}
          </div>
        </div>
      </div>
      {summary.scope.length ? (
        <div className="mt-2">
          <div className="mb-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Scope
          </div>
          <PathList paths={summary.scope} maxVisible={6} />
        </div>
      ) : null}
      <label
        className="mt-3 grid gap-1 text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        Operator rationale
        <textarea
          data-testid="codesite-governance-review-rationale"
          value={rationale}
          onChange={(event) => onRationale(event.target.value)}
          rows={3}
          className="min-h-24 rounded border px-2 py-2 text-xs outline-none"
          placeholder="Confirm replay, evidence, and impact before issuing this action."
          style={{
            borderColor: canConfirm
              ? "color-mix(in srgb, var(--accent-primary) 38%, var(--border-subtle))"
              : "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-primary)",
          }}
        />
      </label>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <IconButton
          title="Cancel tower action"
          disabled={disabled}
          onClick={onCancel}
          testId="codesite-governance-review-cancel"
        >
          Cancel
        </IconButton>
        <IconButton
          title="Confirm tower action"
          variant="primary"
          disabled={disabled || !canConfirm}
          onClick={() => onConfirm(rationale)}
          testId="codesite-governance-review-confirm"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Confirm
        </IconButton>
      </div>
    </motion.div>
  );
}

function GovernanceConsole({
  project,
  activeFlights,
  activeLeases,
  incidents,
  permitDraft,
  routeDraft,
  onPermitDraft,
  onRouteDraft,
  onIssuePermit,
  onReviewDocument,
  onProposeRouteRevision,
  onReviewRouteRevision,
  onApplyRouteRevision,
  onResumeMayday,
  actionState,
  disabled,
  inspectionRuns,
  condensed = false,
}) {
  const reduceMotion = useReducedMotion();
  const permits = asArray(project?.permits);
  const documents = asArray(project?.documents);
  const routeRevisions = asArray(project?.routeRevisions);
  const openDocuments = documents.filter(documentNeedsReview);
  const maydayIncidents = incidents.filter(incidentNeedsResume);
  const primaryPlan =
    activeFlights[0] || asArray(project?.executionPlans)[0] || {};
  const lease = activeLeases[0] || {};
  const defaultPermitRoute = firstRoutePattern(primaryPlan);
  const draftRoute = permitDraft.route || defaultPermitRoute;
  const permitAllowedPaths = draftRoute ? [draftRoute] : [];
  const [pendingReview, setPendingReview] = useState(null);
  const [reviewRationale, setReviewRationale] = useState("");
  const queueGovernanceAction = useCallback((action) => {
    setPendingReview(action);
    setReviewRationale("");
  }, []);
  const confirmGovernanceAction = useCallback(async (rationale) => {
    if (!pendingReview?.execute) return;
    const trimmed = String(rationale || "").trim();
    const result = await pendingReview.execute(trimmed);
    setPendingReview(null);
    setReviewRationale("");
    return result;
  }, [pendingReview]);

  return (
    <div
      data-testid="codesite-governance-console"
      className={
        condensed
          ? "grid min-w-0 gap-3"
          : "grid min-w-0 gap-3 xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.18fr)]"
      }
    >
      <motion.form
        layout={!reduceMotion}
        onSubmit={(event) => {
          event.preventDefault();
          const payload = {
            title:
              permitDraft.title ||
              `Restricted work permit for ${compact(primaryPlan.displayCallsign, "flight")}`,
            permitType: permitDraft.permitType || "restricted_route",
            executionPlanId: primaryPlan.id || null,
            mutationLeaseId: lease.id || null,
            allowedPaths: permitAllowedPaths,
            route: permitAllowedPaths,
            scope: {
              allowedPaths: permitAllowedPaths,
              route: permitAllowedPaths,
            },
            approval: { source: "codesite_governance_console" },
            evidenceRefs: [`codesite:ui:permit:${project?.id || "project"}`],
          };
          queueGovernanceAction({
            kind: "permit",
            title: payload.title,
            entity: payload.mutationLeaseId || payload.executionPlanId,
            owner: primaryPlan.displayCallsign || lease.displayCallsign,
            severity: "high",
            scope: permitAllowedPaths,
            evidenceRefs: payload.evidenceRefs,
            execute: (rationale) =>
              onIssuePermit({
                ...payload,
                approval: {
                  ...payload.approval,
                  rationale,
                  reviewedAt: new Date().toISOString(),
                },
              }),
          });
        }}
        className="rounded border p-3"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 7%), var(--bg-surface))",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Restricted work permit</div>
            <div
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Issue governance evidence for Class A/B paths before clearance.
            </div>
          </div>
          <Pill tone={permits.length ? "active" : "holding"}>
            {permits.length}
          </Pill>
        </div>
        <div className="mt-3 grid gap-2">
          <label
            className="grid gap-1 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Permit title
            <input
              data-testid="codesite-permit-title-input"
              value={permitDraft.title}
              onChange={(event) =>
                onPermitDraft({ ...permitDraft, title: event.target.value })
              }
              placeholder={`Permit for ${compact(primaryPlan.displayCallsign, "flight")}`}
              className="h-10 rounded border px-2 text-xs outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
              }}
            />
          </label>
          <label
            className="grid gap-1 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Route scope
            <input
              data-testid="codesite-permit-route-input"
              value={draftRoute}
              onChange={(event) =>
                onPermitDraft({ ...permitDraft, route: event.target.value })
              }
              placeholder="synthi/prisma/**"
              className="h-10 rounded border px-2 font-mono text-xs outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
              }}
            />
          </label>
          <IconButton
            title="Issue permit"
            type="submit"
            variant="primary"
            disabled={disabled || !project?.id}
            testId="codesite-issue-permit-button"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Issue permit
          </IconButton>
        </div>
      </motion.form>

      <GovernanceReviewGate
        action={pendingReview}
        rationale={reviewRationale}
        onRationale={setReviewRationale}
        onCancel={() => {
          setPendingReview(null);
          setReviewRationale("");
        }}
        onConfirm={confirmGovernanceAction}
        disabled={disabled || actionState.status === "running"}
      />

      <div className="grid min-w-0 gap-3">
        <div className={condensed ? "grid gap-2" : "grid gap-2 md:grid-cols-2"}>
          <div
            className="rounded-lg border p-2"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">Documents</div>
              <Pill tone={openDocuments.length ? "holding" : "active"}>
                {openDocuments.length} open
              </Pill>
            </div>
            {documents.length ? (
              <>
              {documents.slice(0, 5).map((document) => (
                <div
                  key={document.id}
                  data-testid="codesite-document-row"
                  data-codesite-document-id={document.id || ""}
                  className="rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
                    background:
                      "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 82%, var(--bg-surface) 18%))",
                  }}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <span className="min-w-0 truncate font-medium">
                      {documentLabel(document)}
                    </span>
                    <Pill
                      tone={document.status}
                      className="max-w-[8.5rem] justify-center break-words text-center whitespace-normal sm:max-w-none"
                    >
                      {compact(document.status, "open")}
                    </Pill>
                  </div>
                  <div
                    className="mt-1 flex flex-wrap items-center gap-1"
                    data-testid="codesite-document-review-actions"
                  >
                    <IconButton
                      title="Approve document"
                      disabled={disabled || !documentNeedsReview(document)}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "document_review",
                          title: `Approve ${documentLabel(document)}`,
                          entity: document.id,
                          owner: document.fromSessionId || document.fromSession || "tower",
                          severity: document.blocking ? "high" : "medium",
                          evidenceRefs: uniqueValues([
                            ...asArray(document.evidenceRefs),
                            `codesite:ui:document-review:${document.id}`,
                          ]),
                          execute: (rationale) =>
                            onReviewDocument(document, "approved", rationale),
                        })
                      }
                      testId="codesite-document-approve-button"
                    >
                      <ClipboardCheck className="h-3.5 w-3.5" />
                      Approve
                    </IconButton>
                    <IconButton
                      title="Reject document"
                      disabled={disabled || !documentNeedsReview(document)}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "document_review",
                          title: `Reject ${documentLabel(document)}`,
                          entity: document.id,
                          owner: document.fromSessionId || document.fromSession || "tower",
                          severity: "high",
                          evidenceRefs: uniqueValues([
                            ...asArray(document.evidenceRefs),
                            `codesite:ui:document-review:${document.id}`,
                          ]),
                          execute: (rationale) =>
                            onReviewDocument(document, "rejected", rationale),
                        })
                      }
                      testId="codesite-document-reject-button"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Reject
                    </IconButton>
                  </div>
                </div>
              ))}
              {documents.length > 5 ? (
                <details
                  data-testid="codesite-documents-show-all"
                  className="rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <summary className="cursor-pointer font-semibold">
                    Show all documents ({documents.length})
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {documents.slice(5).map((document) => (
                      <div
                        key={`hidden-${document.id}`}
                        className="flex min-w-0 items-center justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {documentLabel(document)}
                        </span>
                        <Pill tone={document.status}>
                          {compact(document.status, "open")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              </>
            ) : (
              <EmptyLine>No RFIs or change orders filed</EmptyLine>
            )}
          </div>

          <div
            className="rounded-lg border p-2"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">Route revisions</div>
              <Pill tone={routeRevisions.length ? "holding" : "idle"}>
                {routeRevisions.length}
              </Pill>
            </div>
            <form
              className="mb-2 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const payload = {
                  proposedRoute: [routeDraft.route || defaultPermitRoute],
                  reason: routeDraft.reason || "operator_reroute",
                  affectedLeases: lease.id ? [lease.id] : [],
                  evidenceRefs: [
                    `codesite:ui:route-revision:${project?.id || "project"}`,
                  ],
                };
                queueGovernanceAction({
                  kind: "route_revision",
                  title: `Propose reroute for ${compact(primaryPlan.displayCallsign, "flight")}`,
                  entity: primaryPlan.id,
                  owner: primaryPlan.displayCallsign || lease.displayCallsign,
                  severity: "high",
                  scope: payload.proposedRoute,
                  evidenceRefs: payload.evidenceRefs,
                  execute: (rationale) =>
                    onProposeRouteRevision(primaryPlan, {
                      ...payload,
                      reason: `${payload.reason}: ${rationale}`,
                    }),
                });
              }}
            >
              <input
                data-testid="codesite-route-revision-input"
                value={routeDraft.route}
                onChange={(event) =>
                  onRouteDraft({ ...routeDraft, route: event.target.value })
                }
                placeholder={defaultPermitRoute}
                className="h-10 rounded border px-2 font-mono text-xs outline-none"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                  color: "var(--text-primary)",
                }}
              />
              <IconButton
                title="Propose route revision"
                type="submit"
                disabled={disabled || !primaryPlan.id}
                testId="codesite-route-propose-button"
              >
                <Route className="h-3.5 w-3.5" />
                Propose reroute
              </IconButton>
            </form>
            {routeRevisions.length
              ? (
                <>
                {routeRevisions.slice(0, 5).map((revision) => (
                  <div
                    key={revision.id}
                    data-testid="codesite-route-revision-row"
                    data-codesite-route-revision-id={revision.id || ""}
                    className="rounded-md border px-2 py-2 text-xs"
                    style={{
                      borderColor:
                        "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
                      background:
                        "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 82%, var(--bg-surface) 18%))",
                    }}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                      <code className="min-w-0 break-all text-[10px] leading-4 whitespace-normal">
                        {asArray(revision.proposedRoute).join(", ") ||
                          "route pending"}
                      </code>
                      <Pill
                        tone={revision.status}
                        className="max-w-[8.5rem] justify-center break-words text-center whitespace-normal sm:max-w-none"
                      >
                        {compact(revision.status, "proposed")}
                      </Pill>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <IconButton
                        title="Approve route revision"
                        disabled={disabled || !routeRevisionCanReview(revision)}
                        onClick={() =>
                          queueGovernanceAction({
                            kind: "route_revision_review",
                            title: "Approve route revision",
                            entity: revision.id,
                            owner: revision.displayCallsign || revision.executionPlanId,
                            severity: "high",
                            scope: revision.proposedRoute,
                            evidenceRefs: uniqueValues([
                              ...asArray(revision.evidenceRefs),
                              `codesite:ui:route-review:${revision.id}`,
                            ]),
                            execute: (rationale) =>
                              onReviewRouteRevision(
                                revision,
                                "approved",
                                rationale,
                              ),
                          })
                        }
                        testId="codesite-route-review-button"
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" />
                        Approve
                      </IconButton>
                      <IconButton
                        title="Apply route revision"
                        disabled={disabled || !routeRevisionCanApply(revision)}
                        onClick={() =>
                          queueGovernanceAction({
                            kind: "route_revision_apply",
                            title: "Apply route revision",
                            entity: revision.id,
                            owner: revision.displayCallsign || revision.executionPlanId,
                            severity: "critical",
                            scope: revision.proposedRoute,
                            evidenceRefs: uniqueValues([
                              ...asArray(revision.evidenceRefs),
                              `codesite:ui:route-apply:${revision.id}`,
                            ]),
                            execute: (rationale) =>
                              onApplyRouteRevision(revision, rationale),
                          })
                        }
                        testId="codesite-route-apply-button"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Apply
                      </IconButton>
                    </div>
                  </div>
                ))}
                {routeRevisions.length > 5 ? (
                  <details
                    data-testid="codesite-route-revisions-show-all"
                    className="rounded-md border px-2 py-2 text-xs"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <summary className="cursor-pointer font-semibold">
                      Show all route revisions ({routeRevisions.length})
                    </summary>
                    <div className="mt-2 grid gap-1">
                      {routeRevisions.slice(5).map((revision) => (
                        <div
                          key={`hidden-route-${revision.id}`}
                          className="flex min-w-0 items-start justify-between gap-2"
                        >
                          <code className="min-w-0 break-all text-[10px]">
                            {asArray(revision.proposedRoute).join(", ") ||
                              "route pending"}
                          </code>
                          <Pill tone={revision.status}>
                            {compact(revision.status, "proposed")}
                          </Pill>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
                </>
              )
              : null}
          </div>
        </div>

        <div
          data-testid="codesite-mayday-banner"
          className="rounded-lg border p-3"
          style={{
            borderColor: maydayIncidents.length
              ? "color-mix(in srgb, #ff5757 42%, var(--border-subtle))"
              : "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background: maydayIncidents.length
              ? "linear-gradient(180deg, color-mix(in srgb, #ff5757 10%, var(--bg-surface)), var(--bg-surface))"
              : "var(--bg-surface)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">
                Mayday and ground stop recovery
              </div>
              <div
                className="mt-1 truncate text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Resume only after replay, inspection, and recovery evidence.
              </div>
            </div>
            <Pill tone={maydayIncidents.length ? "critical" : "active"}>
              {maydayIncidents.length} open
            </Pill>
          </div>
          {maydayIncidents.length
            ? (
              <>
              {maydayIncidents.slice(0, 3).map((incident) => {
                const inspectionRunIds = maydayResumeInspectionRefs(
                  incident,
                  inspectionRuns,
                );
                return (
                  <div
                    key={incident.id}
                    data-testid="codesite-ground-stop-row"
                    data-codesite-mayday-id={incident.id || ""}
                    className="mt-2 grid gap-2 rounded border px-2 py-1.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto]"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {compact(incident.category, "mayday")}
                      </div>
                      <PathList
                        paths={incident.affectedZones}
                        empty="no affected zones"
                        maxVisible={4}
                      />
                      <div
                        className="mt-1 truncate text-[10px]"
                        style={{
                          color: inspectionRunIds.length
                            ? "var(--text-muted)"
                            : "#ff8f8f",
                        }}
                      >
                        {inspectionRunIds.length
                          ? `inspection: ${inspectionRunIds.join(", ")}`
                          : "inspection evidence required"}
                      </div>
                    </div>
                    <IconButton
                      title="Resume mayday"
                      disabled={disabled || inspectionRunIds.length === 0}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "mayday_resume",
                          title: `Resume ${compact(incident.category, "mayday")}`,
                          entity: incident.id,
                          owner: asArray(incident.participants)[0] || "tower",
                          severity: "critical",
                          scope: incident.affectedZones,
                          evidenceRefs: uniqueValues([
                            ...asArray(incident.evidenceRefs),
                            incident.replayDigest,
                            `codesite:ui:mayday-resume:${incident.id}`,
                          ]),
                          execute: (rationale) =>
                            onResumeMayday(
                              incident,
                              inspectionRunIds,
                              rationale,
                            ),
                        })
                      }
                      testId="codesite-resume-mayday-submit"
                    >
                      <Siren className="h-3.5 w-3.5" />
                      Resume
                    </IconButton>
                  </div>
                );
              })}
              {maydayIncidents.length > 3 ? (
                <details
                  data-testid="codesite-maydays-show-all"
                  className="mt-2 rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <summary className="cursor-pointer font-semibold">
                    Show all ground stops ({maydayIncidents.length})
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {maydayIncidents.slice(3).map((incident) => (
                      <div
                        key={`hidden-mayday-${incident.id}`}
                        className="flex min-w-0 items-start justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {compact(incident.category, "mayday")} /{" "}
                          {compact(incident.id, "incident")}
                        </span>
                        <Pill tone={incident.severity || incident.status}>
                          {compact(incident.severity || incident.status, "open")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              </>
            )
            : null}
        </div>

        {actionState.error || actionState.result ? (
          <div
            data-testid="codesite-governance-action-result"
            className="rounded border px-3 py-2 text-xs"
            style={{
              borderColor: actionState.error
                ? "color-mix(in srgb, #ff5757 40%, var(--border-subtle))"
                : "color-mix(in srgb, #4ade80 40%, var(--border-subtle))",
              background: "var(--bg-surface)",
            }}
          >
            {actionState.error ||
              compact(
                actionState.result?.event?.eventType ||
                  actionState.result?.routeRevision?.status ||
                  actionState.result?.permit?.status ||
                  actionState.status,
                "updated",
              )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-3" data-testid="codesite-loading">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-16 rounded border"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
            opacity: 0.75,
          }}
        />
      ))}
    </div>
  );
}

function zoneClass(zone) {
  return compact(
    zone?.class || zone?.zoneClass || zone?.risk || "C",
  ).toUpperCase();
}

function zoneName(zone, index) {
  return compact(
    zone?.label || zone?.zoneKey || zone?.id || `zone-${index + 1}`,
  );
}

function zonePaths(zone) {
  return asArray(zone?.paths || zone?.route || zone?.allowedPaths);
}

function pathPatternSegments(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
}

function remainingPatternCanBeEmpty(segments, start) {
  return segments.slice(start).every((segment) => segment === "**");
}

function globSegmentRegex(segment) {
  const escaped = String(segment).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
}

function pathSegmentsMayOverlap(left, right) {
  if (left === right) return true;
  const leftGlob = /[*?]/.test(left);
  const rightGlob = /[*?]/.test(right);
  if (leftGlob && !rightGlob) return globSegmentRegex(left).test(right);
  if (rightGlob && !leftGlob) return globSegmentRegex(right).test(left);
  return leftGlob && rightGlob;
}

function pathPatternsMayOverlap(
  leftSegments,
  rightSegments,
  leftIndex = 0,
  rightIndex = 0,
  seen = new Set(),
) {
  const key = `${leftIndex}:${rightIndex}`;
  if (seen.has(key)) return false;
  seen.add(key);

  if (leftIndex >= leftSegments.length && rightIndex >= rightSegments.length)
    return true;
  if (leftIndex >= leftSegments.length)
    return remainingPatternCanBeEmpty(rightSegments, rightIndex);
  if (rightIndex >= rightSegments.length)
    return remainingPatternCanBeEmpty(leftSegments, leftIndex);

  const left = leftSegments[leftIndex];
  const right = rightSegments[rightIndex];
  if (left === "**") {
    return (
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex + 1,
        rightIndex,
        new Set(seen),
      ) ||
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex,
        rightIndex + 1,
        new Set(seen),
      )
    );
  }
  if (right === "**") {
    return (
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex,
        rightIndex + 1,
        new Set(seen),
      ) ||
      pathPatternsMayOverlap(
        leftSegments,
        rightSegments,
        leftIndex + 1,
        rightIndex,
        new Set(seen),
      )
    );
  }
  return (
    pathSegmentsMayOverlap(left, right) &&
    pathPatternsMayOverlap(
      leftSegments,
      rightSegments,
      leftIndex + 1,
      rightIndex + 1,
      new Set(seen),
    )
  );
}

function pathsLikelyOverlap(left, right) {
  const leftSegments = pathPatternSegments(left);
  const rightSegments = pathPatternSegments(right);
  if (!leftSegments.length || !rightSegments.length) return false;
  return pathPatternsMayOverlap(leftSegments, rightSegments);
}

function normalizedZoneToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function zoneHasFlight(zone, flight) {
  const paths = zonePaths(zone);
  const route = asArray(flight?.route);
  return (
    paths.length > 0 &&
    route.some((path) =>
      paths.some((zonePath) => pathsLikelyOverlap(path, zonePath)),
    )
  );
}

function riskTouchesZone(risk, zone) {
  const riskPaths = [
    risk?.conflictZone,
    risk?.path,
    risk?.zoneKey,
    ...asArray(risk?.affectedZones),
  ].filter(Boolean);
  const paths = zonePaths(zone);
  const zoneTokens = new Set(
    [zone?.zoneKey, zone?.key, zone?.id, zoneName(zone, 0)]
      .map(normalizedZoneToken)
      .filter(Boolean),
  );
  return (
    riskPaths.some((riskPath) =>
      paths.some((zonePath) => pathsLikelyOverlap(riskPath, zonePath)),
    ) ||
    riskPaths.some((riskPath) => zoneTokens.has(normalizedZoneToken(riskPath)))
  );
}

function riskTouchesFlight(risk, flight) {
  const riskPaths = [
    risk?.conflictZone,
    risk?.path,
    risk?.zoneKey,
    ...asArray(risk?.affectedZones),
  ].filter(Boolean);
  return asArray(flight?.route).some((routePath) =>
    riskPaths.some((riskPath) => pathsLikelyOverlap(routePath, riskPath)),
  );
}

function radarPoint(angle, radius) {
  const radians = (angle - 90) * (Math.PI / 180);
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius,
  };
}

function sectorPath(index, total, outer = 45) {
  const startAngle = (360 / total) * index;
  const endAngle = (360 / total) * (index + 1);
  const start = radarPoint(startAngle, outer);
  const end = radarPoint(endAngle, outer);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M 50 50 L ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${outer} ${outer} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)} Z`;
}

function plotFlight(flight, index, zones, totalFlights) {
  const matchedZoneIndex = zones.findIndex((zone) =>
    zoneHasFlight(zone, flight),
  );
  const zoneIndex =
    matchedZoneIndex === -1
      ? index % Math.max(1, zones.length || totalFlights)
      : matchedZoneIndex;
  const baseAngle = zones.length
    ? (360 / zones.length) * zoneIndex
    : (360 / Math.max(1, totalFlights)) * index;
  const angle =
    baseAngle +
    18 +
    ((index * 17) %
      Math.max(26, 360 / Math.max(1, zones.length || totalFlights)));
  const radius = 18 + (index % 3) * 9;
  return radarPoint(angle, radius);
}

function eventPoint(event, index, total) {
  const seed = String(event?.eventType || event?.id || index)
    .split("")
    .reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const angle = (seed + index * 29) % 360;
  const radius = 12 + (index % Math.max(1, total)) * (34 / Math.max(1, total));
  return radarPoint(angle, radius);
}

function radarColor(status, riskLevel = null) {
  const risk = String(riskLevel || "").toLowerCase();
  if (["critical", "high"].includes(risk)) return "#ff5757";
  if (["medium", "warning"].includes(risk)) return "#fbbf24";
  const normalized = String(status || "").toLowerCase();
  if (
    ["holding", "blocked", "denied", "mayday", "failed", "critical"].includes(
      normalized,
    )
  )
    return "#ff5757";
  if (
    [
      "pending",
      "filed",
      "preflight",
      "open",
      "running",
      "warning",
      "medium",
    ].includes(normalized)
  )
    return "#fbbf24";
  return "#4ade80";
}

function replayTailFromNewestFirst(events) {
  return events.slice(0, 7).reverse();
}

function causalReplayHandovers(incidents, proofBundles) {
  return asArray(incidents)
    .filter((incident) => incident?.replayDigest || incident?.incidentReplay)
    .map((incident) => {
      const replay = incident.incidentReplay || {};
      const transactionId =
        replay.transaction?.id ||
        replay.transactionId ||
        asArray(replay.causalEvents)
          .map((event) => event.transactionId || event.details?.transactionId)
          .find(Boolean) ||
        null;
      const proofBundle =
        asArray(proofBundles).find(
          (bundle) =>
            bundle.incidentReplayDigest === incident.replayDigest ||
            bundle.id === replay.proofBundle?.id ||
            (transactionId && bundle.transactionId === transactionId),
        ) || null;
      const codeSiteBlackBox =
        proofBundle?.trailers?.["CodeSite-Black-Box"] ||
        proofBundle?.incidentReplayDigest ||
        incident.replayDigest ||
        replay.proofBundle?.incidentReplayDigest ||
        null;
      const exportPaths = uniqueValues([
        ...asArray(replay.handover?.exportPaths),
        `incidents/incident-replay-${incident.id}.jsonl`,
        "handover.md",
        proofBundle?.id && `proof-bundles/${proofBundle.id}.proof.json`,
        proofBundle?.id && `proof-bundles/${proofBundle.id}.trailers.txt`,
      ]);
      return {
        incident,
        replay,
        transactionId,
        proofBundle,
        codeSiteBlackBox,
        exportPaths,
        causalEvents: asArray(replay.causalEvents),
        completeness: replay.completeness || null,
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.incident.createdAt || 0) -
        Date.parse(left.incident.createdAt || 0),
    );
}

function replayCompletenessTone(completeness) {
  const score = Number(completeness?.score);
  if (!Number.isFinite(score)) return "pending";
  if (score >= 0.75) return "active";
  if (score >= 0.45) return "warning";
  return "blocked";
}

function CausalReplayDeck({ handovers }) {
  const rows = asArray(handovers);
  if (!rows.length) return <EmptyLine>No black-box handover closed yet</EmptyLine>;
  const visibleRows = rows.slice(0, 3);
  const hiddenRows = rows.length - visibleRows.length;

  return (
    <div
      data-testid="codesite-causal-replay-handover"
      className="grid min-w-0 gap-3"
    >
      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--bg-surface)",
        }}
      >
        <span className="font-semibold">Replay coverage queue</span>
        <div className="flex flex-wrap gap-1">
          <Pill>{rows.length} handovers</Pill>
          {hiddenRows > 0 ? (
            <Pill tone="holding">+{hiddenRows} archived</Pill>
          ) : null}
        </div>
      </div>
      {visibleRows.map((handover, index) => {
        const score = Number(handover.completeness?.score);
        const eventTypes = handover.causalEvents
          .map((event) => event.type)
          .filter(Boolean);
        const latestEvents = handover.causalEvents.slice(-8);
        const hiddenEvents = handover.causalEvents.length - latestEvents.length;
        const tone = replayCompletenessTone(handover.completeness);
        const coverageTypes =
          handover.completeness?.presentEventTypes || eventTypes;
        const missingTypes = handover.completeness?.missingEventTypes || [];
        return (
          <div
            key={
              handover.incident.id ||
              handover.transactionId ||
              `handover-${index}`
            }
            className="rounded-lg border p-3 text-xs"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
              background:
                "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 84%, var(--bg-editor) 16%))",
            }}
          >
            <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(260px,0.55fr)]">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-medium">
                    {compact(handover.transactionId, handover.incident.category)}
                  </span>
                  <Pill tone={handover.incident.severity}>
                    {handover.incident.severity}
                  </Pill>
                  <Pill tone={tone}>
                    {Number.isFinite(score) ? formatPercent(score) : "pending"}
                  </Pill>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {[
                    ["Replay digest", handover.incident.replayDigest],
                    ["Proof bundle", handover.proofBundle?.id],
                    ["CodeSite-Black-Box", handover.codeSiteBlackBox],
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0 rounded-md border px-2 py-1.5" style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}>
                      <div
                        className="text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {label}
                      </div>
                      <div
                        className="break-all font-mono text-[10px]"
                        title={value || "missing"}
                      >
                        {compact(value, "missing")}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
                  <div className="min-w-0 rounded-md border px-2 py-2" style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}>
                    <div
                      className="mb-1 text-[10px] font-semibold uppercase tracking-normal"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Coverage
                    </div>
                    <PathList
                      paths={coverageTypes}
                      empty="no present event types"
                      maxVisible={8}
                    />
                    <div className="mt-1">
                      <PathList
                        paths={missingTypes}
                        empty="no missing event types"
                        maxVisible={8}
                      />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div
                      className="mb-1 text-[10px] font-semibold uppercase tracking-normal"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Causal timeline
                    </div>
                    {latestEvents.length === 0 ? (
                      <EmptyLine>No replay events indexed</EmptyLine>
                    ) : (
                      <div className="space-y-1">
                        {latestEvents.map((event, eventIndex) => (
                          <div
                            key={`${handover.incident.id}-${event.eventId || eventIndex}`}
                            className="grid min-h-8 grid-cols-[42px_minmax(0,1fr)_minmax(86px,auto)] items-center gap-2 rounded-md border px-2 py-1"
                            style={{
                              borderColor: "var(--border-subtle)",
                              background: "var(--bg-editor)",
                            }}
                          >
                            <span
                              className="font-mono text-[10px]"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {event.logicalTime || eventIndex + 1}
                            </span>
                            <span className="min-w-0 truncate">
                              {compact(event.type, "event")}
                            </span>
                            <span
                              className="min-w-0 truncate text-right font-mono text-[10px]"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {compact(
                                event.path || event.displayCallsign,
                                "",
                              )}
                            </span>
                          </div>
                        ))}
                        {hiddenEvents > 0 ? (
                          <div
                            className="rounded-md border px-2 py-1 text-[10px]"
                            style={{
                              borderColor: "var(--border-subtle)",
                              background: "var(--bg-editor)",
                              color: "var(--text-muted)",
                            }}
                          >
                            Showing latest 8 of {handover.causalEvents.length}{" "}
                            replay events; export retains full timeline.
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="min-w-0 rounded-md border px-3 py-2" style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
              }}>
                <div
                  className="mb-1 text-[10px] font-semibold uppercase tracking-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  Export refs
                </div>
                <PathList
                  paths={handover.exportPaths}
                  empty="no export refs"
                  maxVisible={7}
                />
                <div className="mt-3">
                  <SignalBar
                    value={Number.isFinite(score) ? score : 0}
                    tone={tone}
                    label="Replay completeness"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BlackBoxFlightRecorder({ events }) {
  const rows = asArray(events);
  if (!rows.length) return <EmptyLine>No events recorded</EmptyLine>;
  const typeCounts = Object.entries(
    countBy(rows.map((event) => eventDisplayType(event))),
  )
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const actors = Object.keys(
    countBy(rows.map((event) => event.displayCallsign || event.actorType)),
  );

  return (
    <div data-testid="codesite-black-box-recorder" className="grid gap-3">
      <div
        className="grid gap-2 rounded-lg border px-3 py-2 text-xs lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background: "var(--bg-surface)",
        }}
      >
        <div className="min-w-0">
          <div className="font-semibold">Flight recorder stream</div>
          <div
            className="mt-1 max-w-[65ch] leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Ordered event evidence with actor, logical time, path, and payload
            preview for black-box replay.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 lg:justify-end">
          <Pill>{rows.length} events</Pill>
          <Pill>{actors.length} actors</Pill>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(220px,0.35fr)]">
        <div className="space-y-1">
          {rows.map((event, index) => (
            <div
              key={
                event.id ||
                event.eventId ||
                `${event.eventType || "event"}-${index}`
              }
              className="rounded-md border px-2 py-1.5 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
              }}
            >
              <div className="grid min-h-9 grid-cols-[52px_minmax(0,1fr)_minmax(88px,auto)] items-center gap-2">
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatTime(event.createdAt)}
                </span>
                <div className="min-w-0">
                  <div className="truncate">{eventDisplayType(event)}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {eventPathLabel(event)}
                  </div>
                </div>
                <span
                  className="max-w-[110px] truncate text-right text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {event.displayCallsign || event.actorType || ""}
                </span>
              </div>
              {hasEntries(event.details) || asArray(event.evidenceRefs).length ? (
                <div className="mt-1">
                  <JsonPreview
                    value={{
                      eventId: event.id,
                      logicalTime: event.logicalTime,
                      details: event.details || {},
                      evidenceRefs: event.evidenceRefs || [],
                    }}
                    maxLines={10}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="grid min-w-0 content-start gap-2">
          {typeCounts.map(([type, count]) => (
            <div
              key={type}
              className="rounded-md border px-2 py-1.5 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{type}</span>
                <span className="font-mono tabular-nums">
                  {formatCompactNumber(count)}
                </span>
              </div>
              <div className="mt-1">
                <SignalBar
                  value={count / rows.length}
                  tone={count > 1 ? "holding" : "active"}
                  label={`${type} event share`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LineProvenanceDeck({
  rows,
  selectedLineRow,
  selectedLineTransaction,
  selectedLineLease,
  selectedLineProof,
  selectedLineEvidenceRefs,
  selectedLineInspectionRefs,
  selectedLineDojoRefs,
  lineInspector,
  onInspectLine,
}) {
  const provenanceRows = asArray(rows);
  if (!provenanceRows.length) {
    return <EmptyLine>No line provenance indexed</EmptyLine>;
  }
  const visibleRows = provenanceRows.slice(-10).reverse();
  const hiddenRows = provenanceRows.length - visibleRows.length;
  const fileCount = new Set(provenanceRows.map((row) => row.filePath).filter(Boolean)).size;
  const transactionCount = new Set(
    provenanceRows.map((row) => row.transactionId).filter(Boolean),
  ).size;
  const evidenceCount = uniqueValues(
    provenanceRows.flatMap((row) => asArray(row.evidenceRefs)),
  ).length;
  const sourceContext =
    selectedLineRow?.diffHunk ||
    selectedLineRow?.diffSnippet ||
    selectedLineRow?.sourceSnippet ||
    selectedLineRow?.promptSummary;
  const causalSteps = selectedLineRow
    ? [
        {
          label: "Clearance",
          value: `${compact(
            selectedLineLease?.displayCallsign || selectedLineRow.displayCallsign,
            "agent",
          )} / ${compact(
            selectedLineLease?.id || selectedLineTransaction?.mutationLeaseId,
            "lease",
          )}`,
          tone: selectedLineLease ? "active" : "pending",
        },
        {
          label: "Transaction",
          value: compact(selectedLineRow.transactionId, "transaction"),
          tone: selectedLineTransaction?.status || "active",
        },
        {
          label: "Proof",
          value: compact(
            selectedLineProof?.bundleDigest || selectedLineRow.proofBundleId,
            "none",
          ),
          tone: selectedLineProof ? "active" : "pending",
        },
        {
          label: "Evidence",
          value: `${selectedLineEvidenceRefs.length} refs`,
          tone: selectedLineEvidenceRefs.length ? "active" : "pending",
        },
        {
          label: "Inspection",
          value: `${selectedLineInspectionRefs.length} refs`,
          tone: selectedLineInspectionRefs.length ? "active" : "holding",
        },
      ]
    : [];

  return (
    <div
      data-testid="codesite-line-provenance-deck"
      className="grid min-w-0 gap-3"
    >
      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 80%, var(--accent-primary) 20%)",
          background: "var(--bg-surface)",
        }}
      >
        <span className="font-semibold">Line provenance ledger</span>
        <div className="flex flex-wrap gap-1">
          <Pill>{provenanceRows.length} rows</Pill>
          {hiddenRows > 0 ? (
            <Pill tone="holding">+{hiddenRows} archived</Pill>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
        <Metric label="Files" value={fileCount} />
        <Metric label="Transactions" value={transactionCount} />
        <Metric label="Evidence refs" value={evidenceCount} />
        <Metric
          label="Selected"
          value={selectedLineRow ? lineRangeLabel(selectedLineRow) : "none"}
          tone={selectedLineRow ? "active" : "idle"}
        />
      </div>
      <div className="grid min-w-0 gap-3 overflow-hidden xl:grid-cols-[minmax(0,0.95fr)_minmax(300px,0.8fr)]">
        <div className="min-w-0 space-y-1">
          {visibleRows.map((row, index) => {
            const selected =
              lineProvenanceKey(row) === lineProvenanceKey(selectedLineRow);
            return (
              <button
                key={
                  lineProvenanceKey(row) ||
                  `${row.filePath || "line"}-${index}`
                }
                type="button"
                data-testid="codesite-line-provenance-row"
                aria-pressed={selected}
                onClick={() => onInspectLine(row)}
                className="block w-full min-w-0 overflow-hidden rounded-md border px-2.5 py-2 text-left text-xs transition-colors"
                style={{
                  borderColor: selected
                    ? "color-mix(in srgb, var(--accent-primary) 52%, var(--border-subtle))"
                    : "var(--border-subtle)",
                  background: selected
                    ? "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-surface))"
                    : "var(--bg-surface)",
                  color: "var(--text-primary)",
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-1.5">
                  <code
                    className="min-w-0 flex-1 basis-[11rem] break-all text-[10px] leading-4 whitespace-normal"
                    title={row.filePath}
                  >
                    {row.filePath}
                  </code>
                  <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1">
                    <Pill>{lineRangeLabel(row)}</Pill>
                    <Pill className="max-w-[8rem] truncate">
                      {compact(row.displayCallsign, "agent")}
                    </Pill>
                  </div>
                </div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <PathList
                    paths={[row.reasonRef, row.proofBundleId].filter(Boolean)}
                    empty="no reason"
                  />
                  <PathList
                    paths={asArray(row.evidenceRefs)}
                    empty="no evidence refs"
                    maxVisible={5}
                  />
                </div>
              </button>
            );
          })}
        </div>
        <div
          data-testid="codesite-line-inspector"
          className="min-h-[220px] min-w-0 overflow-hidden rounded-lg border p-3 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background:
              "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
          }}
        >
          {!selectedLineRow ? (
            <EmptyLine>Select a changed line</EmptyLine>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="break-words font-medium leading-tight">
                    {lineRangeLabel(selectedLineRow)} causal trace
                  </div>
                  <code
                    className="mt-0.5 block break-all text-[10px] leading-4 whitespace-normal"
                    title={selectedLineRow.filePath}
                    style={{ color: "var(--text-muted)" }}
                  >
                    {selectedLineRow.filePath}
                  </code>
                </div>
                <Pill
                  testId="codesite-line-inspector-status"
                  tone={
                    lineInspector.status === "error"
                      ? "failed"
                      : lineInspector.status === "loading"
                        ? "running"
                        : "active"
                  }
                >
                  {lineInspector.status === "loading" &&
                  lineInspector.rows.length === 0
                    ? "loading"
                    : `${lineInspector.rows.length || 1} rows`}
                </Pill>
              </div>
              <div className="grid gap-1.5">
                {causalSteps.map((step) => (
                  <div
                    key={step.label}
                    className="grid min-h-8 grid-cols-[86px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-1"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <span style={{ color: "var(--text-muted)" }}>
                      {step.label}
                    </span>
                    <code
                      className="min-w-0 break-all whitespace-normal"
                      title={step.value}
                    >
                      {step.value}
                    </code>
                    <span
                      className="h-2 w-2 rounded-full"
                      style={indicatorTone(step.tone)}
                    />
                  </div>
                ))}
              </div>
              <div className="grid gap-2 text-[11px]">
                <div>
                  <div style={{ color: "var(--text-muted)" }}>Reason</div>
                  <code
                    className="break-all whitespace-normal"
                    title={selectedLineRow.reasonRef}
                  >
                    {compact(selectedLineRow.reasonRef, "none")}
                  </code>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Evidence refs
                  </div>
                  <PathList
                    paths={selectedLineEvidenceRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Inspection/test approvals
                  </div>
                  <PathList
                    paths={selectedLineInspectionRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Dojo/source refs
                  </div>
                  <PathList
                    paths={selectedLineDojoRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Process ancestry
                  </div>
                  <PathList
                    paths={asArray(selectedLineRow.processAncestry)}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                {sourceContext ? (
                  <div>
                    <div style={{ color: "var(--text-muted)" }}>
                      Source context
                    </div>
                    <pre
                      className="mt-1 max-h-36 overflow-auto rounded-md border px-2 py-1 text-[11px] leading-5 whitespace-pre-wrap"
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-editor)",
                      }}
                    >
                      {sourceContext}
                    </pre>
                  </div>
                ) : null}
                {lineInspector.error ? (
                  <div
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{
                      borderColor:
                        "color-mix(in srgb, #ff5757 40%, var(--border-subtle))",
                      color: "var(--text-primary)",
                    }}
                  >
                    {lineInspector.error}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AirspaceMap({
  zones,
  noFlyZones,
  flights,
  risks,
  events = [],
  inspections = [],
  condensed = false,
}) {
  const reduceMotion = useReducedMotion();
  const lanes = zones.length
    ? zones
    : [
        {
          label: "Allowed route",
          class: "C",
          paths: flights.flatMap((flight) => asArray(flight.route)).slice(0, 4),
        },
      ];
  const visibleFlights = flights.slice(0, condensed ? 8 : 12);
  const visibleRisks = risks.slice(0, condensed ? 6 : 8);
  const flightOverflow = Math.max(0, flights.length - visibleFlights.length);
  const riskOverflow = Math.max(0, risks.length - visibleRisks.length);
  const replayEvents = replayTailFromNewestFirst(events);
  const replayPoints = replayEvents.map((event, index) =>
    eventPoint(event, index, replayEvents.length),
  );
  const replayPath = replayPoints
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const landingRuns = asArray(inspections).slice(-4).reverse();
  const priorityFlights = flights
    .slice()
    .sort((left, right) => {
      const leftRisk = risks.some((risk) => riskTouchesFlight(risk, left))
        ? 2
        : ["holding", "blocked", "preflight"].includes(
              String(left.status || "").toLowerCase(),
            )
          ? 1
          : 0;
      const rightRisk = risks.some((risk) => riskTouchesFlight(risk, right))
        ? 2
        : ["holding", "blocked", "preflight"].includes(
              String(right.status || "").toLowerCase(),
            )
          ? 1
          : 0;
      return rightRisk - leftRisk;
    })
    .slice(0, condensed ? 4 : 6);

  return (
    <div className="space-y-2">
      <div
        data-testid="codesite-radar-graph"
        className={
          condensed
            ? "overflow-hidden rounded-lg border p-2"
            : "overflow-hidden rounded-lg border p-3"
        }
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
          background: "var(--bg-surface)",
        }}
      >
        <div
          className={
            condensed
              ? "grid gap-2 lg:grid-cols-[minmax(300px,0.96fr)_minmax(0,1.04fr)]"
              : "grid gap-3 lg:grid-cols-[minmax(320px,0.92fr)_minmax(0,1.08fr)]"
          }
        >
          <div
            className={
              condensed
                ? "relative min-h-[272px] overflow-hidden rounded-lg border"
                : "relative min-h-[340px] overflow-hidden rounded-lg border"
            }
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
              background:
                "linear-gradient(90deg, color-mix(in srgb, var(--border-subtle) 16%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border-subtle) 14%, transparent) 1px, transparent 1px), radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent-primary) 9%, transparent), transparent 62%), color-mix(in srgb, var(--bg-editor) 90%, transparent)",
              backgroundSize: "20px 20px, 20px 20px, auto, auto",
            }}
          >
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              role="img"
              aria-label="CodeSite radar graph with flights, risks, and replay trace"
            >
              <defs>
                <radialGradient
                  id="codesite-radar-sweep"
                  cx="50%"
                  cy="50%"
                  r="50%"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--accent-primary)"
                    stopOpacity="0.18"
                  />
                  <stop
                    offset="66%"
                    stopColor="var(--accent-primary)"
                    stopOpacity="0.04"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--accent-primary)"
                    stopOpacity="0"
                  />
                </radialGradient>
              </defs>
              <rect
                width="100"
                height="100"
                fill="url(#codesite-radar-sweep)"
                opacity="0.72"
              />
              <circle
                cx="50"
                cy="50"
                r="47"
                fill="none"
                stroke="color-mix(in srgb, var(--accent-primary) 28%, transparent)"
                strokeWidth="0.55"
              />
              {[14, 27, 40].map((radius) => (
                <circle
                  key={radius}
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke="var(--border-subtle)"
                  strokeWidth="0.35"
                />
              ))}
              {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
                const end = radarPoint(angle, 45);
                return (
                  <line
                    key={angle}
                    x1="50"
                    y1="50"
                    x2={end.x}
                    y2={end.y}
                    stroke="var(--border-subtle)"
                    strokeWidth="0.25"
                  />
                );
              })}
              <motion.g
                data-testid="codesite-radar-sweep"
                style={{ transformOrigin: "50% 50%" }}
                animate={reduceMotion ? { rotate: 0 } : { rotate: 360 }}
                transition={{
                  duration: 8,
                  repeat: reduceMotion ? 0 : Infinity,
                  ease: RADAR_SWEEP_EASE,
                }}
              >
                <path
                  d="M 50 50 L 50 5 A 45 45 0 0 1 72 11 Z"
                  fill="color-mix(in srgb, var(--accent-primary) 42%, transparent)"
                  opacity="0.22"
                />
                <line
                  x1="50"
                  y1="50"
                  x2="50"
                  y2="5"
                  stroke="color-mix(in srgb, var(--accent-primary) 76%, #8fd9ff)"
                  strokeWidth="0.45"
                />
              </motion.g>
              {lanes.slice(0, 6).map((zone, index) => {
                const hasRisk = risks.some((risk) =>
                  riskTouchesZone(risk, zone),
                );
                return (
                  <path
                    key={`sector-${zone.zoneKey || zone.id || index}`}
                    d={sectorPath(
                      index,
                      Math.max(1, Math.min(6, lanes.length)),
                    )}
                    fill={hasRisk ? "#ff5757" : "var(--accent-primary)"}
                    opacity={hasRisk ? "0.16" : "0.06"}
                    stroke={hasRisk ? "#ff5757" : "var(--border-subtle)"}
                    strokeWidth="0.35"
                  />
                );
              })}
              {visibleRisks.map((risk, index) => {
                const angle = 24 + index * 68;
                const left = radarPoint(angle - 13, 44);
                const right = radarPoint(angle + 18, 44);
                return (
                  <path
                    key={`risk-cone-${index}`}
                    data-testid="codesite-risk-cone"
                    d={`M 50 50 L ${left.x.toFixed(2)} ${left.y.toFixed(2)} L ${right.x.toFixed(2)} ${right.y.toFixed(2)} Z`}
                    fill={radarColor(null, risk.severity || risk.riskLevel)}
                    opacity="0.24"
                  />
                );
              })}
              {replayPoints.length > 1 ? (
                <polyline
                  data-testid="codesite-replay-trace"
                  points={replayPath}
                  fill="none"
                  stroke="color-mix(in srgb, var(--accent-primary) 72%, #8fd9ff)"
                  strokeWidth="0.9"
                  strokeDasharray="2.4 1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}
              {visibleFlights.map((flight, index) => {
                const point = plotFlight(
                  flight,
                  index,
                  lanes,
                  visibleFlights.length,
                );
                const hasRisk = risks.some((risk) =>
                  riskTouchesFlight(risk, flight),
                );
                const color = radarColor(
                  flight.status,
                  hasRisk ? "high" : null,
                );
                const holding = ["holding", "blocked", "preflight"].includes(
                  String(flight.status || "").toLowerCase(),
                );
                return (
                  <motion.g
                    key={`flight-dot-${flight.id || flight.displayCallsign || index}`}
                    data-testid="codesite-flight-blip"
                    initial={{ opacity: 0.72, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      duration: 0.24,
                      delay: reduceMotion ? 0 : index * 0.04,
                      ease: MOTION_EASE,
                    }}
                    style={{ transformOrigin: `${point.x}px ${point.y}px` }}
                  >
                    {holding ? (
                      <motion.circle
                        data-testid="codesite-holding-pattern"
                        cx={point.x}
                        cy={point.y}
                        r="4.5"
                        fill="none"
                        stroke={color}
                        strokeWidth="0.45"
                        strokeDasharray="1.4 1.2"
                        opacity="0.92"
                        animate={reduceMotion ? { rotate: 0 } : { rotate: 360 }}
                        transition={{
                          duration: 3.2,
                          repeat: reduceMotion ? 0 : Infinity,
                          ease: RADAR_SWEEP_EASE,
                        }}
                        style={{ transformOrigin: `${point.x}px ${point.y}px` }}
                      />
                    ) : null}
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r="2.2"
                      fill={color}
                      stroke="var(--bg-surface)"
                      strokeWidth="0.8"
                    />
                    <text
                      x={Math.min(86, point.x + 3.4)}
                      y={Math.max(9, point.y - 2.4)}
                      fill="var(--text-primary)"
                      fontSize="3.1"
                      fontFamily="monospace"
                    >
                      {compact(flight.displayCallsign, "agent").slice(0, 10)}
                    </text>
                  </motion.g>
                );
              })}
              <circle cx="50" cy="50" r="1.4" fill="var(--accent-primary)" />
            </svg>
            <div
              className="pointer-events-none absolute inset-x-3 top-3 flex items-center justify-between gap-3 text-[10px] font-medium"
              style={{ color: "var(--text-muted)" }}
            >
              <span>Risk cone</span>
              <span>Replay trace</span>
              <span>Holding pattern</span>
            </div>
            <div
              className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1 text-[10px]"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
                background:
                  "color-mix(in srgb, var(--bg-surface) 76%, transparent)",
                color: "var(--text-muted)",
              }}
            >
              <span>
                {visibleFlights.length} flights tracked
                {flightOverflow ? ` (+${flightOverflow})` : ""}
              </span>
              <span>
                {visibleRisks.length || "no"} active risk cones
                {riskOverflow ? ` (+${riskOverflow})` : ""}
              </span>
            </div>
          </div>

          <div className="grid content-start gap-2">
            <div className="grid gap-1">
              {lanes.slice(0, 4).map((zone, index) => {
                const relatedFlights = visibleFlights.filter((flight) => {
                  return zoneHasFlight(zone, flight);
                });
                const visibleRelatedFlights = relatedFlights.slice(0, 3);
                const hiddenRelatedFlightCount =
                  relatedFlights.length - visibleRelatedFlights.length;
                const hasRisk = risks.some((risk) =>
                  riskTouchesZone(risk, zone),
                );
                return (
                  <div
                    key={zone.zoneKey || zone.id || index}
                    data-testid="codesite-airspace-lane"
                    className="grid min-h-[66px] gap-2 rounded-md border px-2 py-2 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] sm:grid-cols-[minmax(96px,0.72fr)_minmax(0,1.4fr)_minmax(108px,0.68fr)] sm:items-start"
                    style={{
                      borderColor: hasRisk
                        ? "color-mix(in srgb, #ff5757 36%, var(--border-subtle))"
                        : "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
                      background: hasRisk
                        ? "color-mix(in srgb, #ff5757 12%, var(--bg-editor))"
                        : "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 82%, var(--bg-surface) 18%))",
                    }}
                  >
                    <div className="min-w-0 self-start">
                      <div className="break-words text-[11px] font-semibold leading-tight">
                        {zoneName(zone, index)}
                      </div>
                      <div
                        className="text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        Class {zoneClass(zone)}
                      </div>
                    </div>
                    <div className="min-w-0 self-start">
                      <PathList paths={zonePaths(zone)} empty="route pending" />
                    </div>
                    <div className="flex min-w-0 flex-wrap gap-1 self-start sm:justify-end">
                      {relatedFlights.length ? (
                        <>
                          {visibleRelatedFlights.map((flight, flightIndex) => (
                            <Pill
                              key={
                                flight.id ||
                                flight.displayCallsign ||
                                `related-flight-${flightIndex}`
                              }
                              tone={flight.status}
                              className={
                                hasRisk
                                  ? "max-w-[86px] motion-safe:animate-pulse"
                                  : "max-w-[86px]"
                              }
                            >
                              {compact(flight.displayCallsign, "agent")}
                            </Pill>
                          ))}
                          {hiddenRelatedFlightCount > 0 ? (
                            <Pill tone={hasRisk ? "blocked" : "default"}>
                              +{hiddenRelatedFlightCount}
                            </Pill>
                          ) : null}
                        </>
                      ) : (
                        <Pill>clear</Pill>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 84%, var(--bg-surface) 16%))",
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Landing queue</span>
                <Pill
                  tone={
                    landingRuns.some((run) =>
                      String(run.status).includes("failed"),
                    )
                      ? "failed"
                      : "active"
                  }
                >
                  {landingRuns.length}
                </Pill>
              </div>
              {landingRuns.length ? (
                landingRuns.map((run, runIndex) => (
                  <div
                    key={run.id || `landing-run-${runIndex}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-0.5"
                  >
                    <span className="min-w-0 break-words">
                      {compact(run.displayCallsign, "inspection")}
                    </span>
                    <span
                      className="break-words text-[10px] leading-4"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {compact(run.status, "pending")}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ color: "var(--text-muted)" }}>No landings</div>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 84%, var(--bg-surface) 16%))",
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Priority traffic</span>
                <Pill
                  tone={
                    priorityFlights.some((flight) =>
                      risks.some((risk) => riskTouchesFlight(risk, flight)),
                    )
                      ? "holding"
                      : "active"
                  }
                >
                  {priorityFlights.length}
                </Pill>
              </div>
              {priorityFlights.length ? (
                <div className="space-y-1">
                  {priorityFlights.map((flight, flightIndex) => {
                    const hasRisk = risks.some((risk) =>
                      riskTouchesFlight(risk, flight),
                    );
                    return (
                      <div
                        key={
                          flight.id ||
                          flight.displayCallsign ||
                          `priority-${flightIndex}`
                        }
                        className="grid grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)_auto] items-center gap-2"
                      >
                        <span className="min-w-0 truncate font-medium">
                          {compact(flight.displayCallsign, "agent")}
                        </span>
                        <span
                          className="min-w-0 truncate font-mono text-[10px]"
                          style={{ color: "var(--text-muted)" }}
                          title={asArray(flight.route).join(", ")}
                        >
                          {asArray(flight.route).slice(0, 2).join(", ") ||
                            compact(flight.domain, "route")}
                        </span>
                        <Pill tone={hasRisk ? "holding" : flight.status}>
                          {hasRisk ? "risk" : compact(flight.status, "active")}
                        </Pill>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: "var(--text-muted)" }}>
                  No active traffic
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div
        className={
          condensed
            ? "grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2 text-xs"
            : "grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-xs"
        }
      >
        <div
          className="rounded-lg border px-3 py-2"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ color: "var(--text-muted)" }}>No-fly zones</div>
          <div className="mt-1">
            <PathList paths={noFlyZones} empty="none" />
          </div>
        </div>
        <div
          className="rounded-lg border px-3 py-2"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background: "var(--bg-surface)",
          }}
        >
          <div style={{ color: "var(--text-muted)" }}>Radar layers</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {["clearance", "transaction", "inspection", "proof"].map(
              (layer) => (
                <Pill key={layer}>{layer}</Pill>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JsonPreview({ value, maxLines = 10 }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  const lines = text.split("\n").slice(0, maxLines).join("\n");
  return (
    <pre
      aria-label="CodeSite JSON proof details"
      className="max-h-44 overflow-auto rounded border p-2 text-[10px] leading-4"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-editor)",
        color: "var(--text-secondary)",
      }}
      tabIndex={0}
    >
      {lines}
    </pre>
  );
}

export default function CodeSitePanel({ workspaceSlug }) {
  const reduceMotion = useReducedMotion();
  const scrollContainerRef = useRef(null);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [radarState, setRadarState] = useState(() =>
    createEmptyCodeSiteRadarState(workspaceSlug),
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [exportResult, setExportResult] = useState(null);
  const [lineInspector, setLineInspector] = useState({
    status: "idle",
    row: null,
    rows: [],
    error: null,
  });
  const [simulationRun, setSimulationRun] = useState({
    status: "idle",
    result: null,
    error: null,
  });
  const [quarantineReview, setQuarantineReview] = useState({
    selectedId: null,
    selectedPaths: [],
    status: "idle",
    replay: null,
    replayPathKey: "",
    apply: null,
    error: null,
  });
  const [streamStatus, setStreamStatus] = useState("polling");
  const [streamEvents, setStreamEvents] = useState([]);
  const [activeSection, setActiveSection] = useState("radar");
  const [permitDraft, setPermitDraft] = useState({
    title: "",
    permitType: "restricted_route",
    route: "",
  });
  const [routeDraft, setRouteDraft] = useState({ route: "", reason: "" });
  const [governanceAction, setGovernanceAction] = useState({
    status: "idle",
    result: null,
    error: null,
  });

  const loadRadar = useCallback(
    async ({ silent = false, projectId = selectedProjectId } = {}) => {
      if (!workspaceSlug) {
        setRadarState(createEmptyCodeSiteRadarState(workspaceSlug));
        setLoading(false);
        return;
      }

      if (!silent) setLoading(true);

      try {
        const next = await fetchCodeSiteRadarState(workspaceSlug, projectId);
        setRadarState(next);
        setError(null);
        if (
          next.selectedProjectId &&
          next.selectedProjectId !== selectedProjectId
        ) {
          setSelectedProjectId(next.selectedProjectId);
        }
      } catch (nextError) {
        setError({
          status: nextError.status,
          message: nextError.message || "codesite_request_failed",
        });
      } finally {
        setLoading(false);
      }
    },
    [selectedProjectId, workspaceSlug],
  );

  useEffect(() => {
    loadRadar();
  }, [loadRadar]);

  useEffect(() => {
    if (!workspaceSlug || !radarState.selectedProjectId) return undefined;
    const timer = window.setInterval(() => {
      loadRadar({ silent: true, projectId: radarState.selectedProjectId });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRadar, radarState.selectedProjectId, workspaceSlug]);

  useEffect(() => {
    setStreamEvents([]);
    if (!workspaceSlug || !radarState.selectedProjectId) {
      setStreamStatus("polling");
      return undefined;
    }
    return subscribeCodeSiteProjectEvents(
      workspaceSlug,
      radarState.selectedProjectId,
      {
        onStatus: setStreamStatus,
        onEvent: (event) => {
          setStreamEvents((current) => {
            const id =
              event?.id ||
              event?.eventId ||
              `${event?.eventType || "event"}:${event?.createdAt || current.length}`;
            const withoutDuplicate = current.filter(
              (item) => (item?.id || item?.eventId) !== id,
            );
            return [event, ...withoutDuplicate].slice(0, 12);
          });
        },
      },
    );
  }, [radarState.selectedProjectId, workspaceSlug]);

  const handleSelectSection = useCallback(
    (sectionKey) => {
      setActiveSection(sectionKey);
      if (typeof document !== "undefined") {
        const target = document.querySelector(
          `[data-codesite-section="${sectionKey}"]`,
        );
        const scrollContainer = scrollContainerRef.current;
        if (!target || !scrollContainer) {
          target?.scrollIntoView({
            behavior: "auto",
            block: "start",
          });
          return;
        }
        const stickyTabs = scrollContainer.querySelector(
          '[data-testid="codesite-mobile-section-tabs"]',
        );
        if (typeof scrollContainer.scrollTo !== "function") {
          target?.scrollIntoView?.({
            behavior: "auto",
            block: "start",
          });
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const stickyHeight = stickyTabs?.getBoundingClientRect().height || 0;
        scrollContainer.scrollTo({
          top: Math.max(
            0,
            scrollContainer.scrollTop +
              targetRect.top -
              containerRect.top -
              stickyHeight -
              12,
          ),
          behavior: "auto",
        });
      }
    },
    [],
  );

  const handleRequiredActionReview = useCallback(
    (action) => {
      handleSelectSection("governance");
      const kind = actionKind(action);
      const entityId = actionEntityId(action);
      window.setTimeout(() => {
        const candidates = [];
        if (action?.documentId || /document|rfi|change_order/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-document-id",
            action?.documentId || entityId,
          );
          const button = row?.querySelector(
            '[data-testid="codesite-document-approve-button"]',
          );
          if (button) candidates.push(button);
        }
        if (action?.routeRevisionId || /route|reroute/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-route-revision-id",
            action?.routeRevisionId || entityId,
          );
          const button =
            row?.querySelector('[data-testid="codesite-route-apply-button"]') ||
            row?.querySelector('[data-testid="codesite-route-review-button"]');
          if (button) candidates.push(button);
        }
        if (action?.incidentId || /mayday|ground|resume/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-mayday-id",
            action?.incidentId || entityId,
          );
          const button = row?.querySelector(
            '[data-testid="codesite-resume-mayday-submit"]',
          );
          if (button) candidates.push(button);
        }

        const target = candidates.find((button) => !button.disabled);
        if (target) {
          target.focus({ preventScroll: true });
          target.click();
          return;
        }

        const console = document.querySelector(
          '[data-testid="codesite-governance-console"]',
        );
        console?.scrollIntoView?.({ behavior: "auto", block: "start" });
        console?.focus?.({ preventScroll: true });
      }, 0);
    },
    [handleSelectSection],
  );

  const handleCreateProject = useCallback(
    async (event) => {
      event?.preventDefault?.();
      if (!workspaceSlug || acting) return;

      const title = newProjectTitle.trim() || "Coordination run";
      setActing(true);
      try {
        const project = await createCodeSiteProject(workspaceSlug, {
          title,
          request: title,
          zonePolicy: {
            zones: [],
            noFlyZones: [],
            classRules: {},
          },
        });
        setNewProjectTitle("");
        setSelectedProjectId(project?.id || null);
        await loadRadar({ projectId: project?.id || null });
      } catch (nextError) {
        setError({
          status: nextError.status,
          message: nextError.message || "codesite_create_failed",
        });
      } finally {
        setActing(false);
      }
    },
    [acting, loadRadar, newProjectTitle, workspaceSlug],
  );

  const handleExportArtifacts = useCallback(async () => {
    if (!workspaceSlug || !radarState.selectedProjectId || acting) return;

    setActing(true);
    try {
      const result = await exportCodeSiteArtifacts(
        workspaceSlug,
        radarState.selectedProjectId,
      );
      setExportResult(result);
      await loadRadar({
        silent: true,
        projectId: radarState.selectedProjectId,
      });
    } catch (nextError) {
      setError({
        status: nextError.status,
        message: nextError.message || "codesite_artifact_export_failed",
      });
    } finally {
      setActing(false);
    }
  }, [acting, loadRadar, radarState.selectedProjectId, workspaceSlug]);

  const handleRunTowerSimulation = useCallback(async () => {
    if (!workspaceSlug || !radarState.selectedProjectId || acting) return;

    setActing(true);
    setSimulationRun({
      status: "running",
      result: simulationRun.result,
      error: null,
    });
    try {
      const result = await simulateCodeSiteShadowMerge(
        workspaceSlug,
        radarState.selectedProjectId,
      );
      setSimulationRun({ status: "ready", result, error: null });
      await loadRadar({
        silent: true,
        projectId: radarState.selectedProjectId,
      });
    } catch (nextError) {
      setSimulationRun({
        status: "error",
        result: simulationRun.result,
        error: nextError.message || "codesite_tower_simulation_failed",
      });
    } finally {
      setActing(false);
    }
  }, [
    acting,
    loadRadar,
    radarState.selectedProjectId,
    simulationRun.result,
    workspaceSlug,
  ]);

  const runGovernanceAction = useCallback(
    async (operation) => {
      if (!workspaceSlug || acting) return;
      setActing(true);
      setGovernanceAction({ status: "running", result: null, error: null });
      try {
        const result = await operation();
        setGovernanceAction({ status: "ready", result, error: null });
        await loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        });
      } catch (nextError) {
        setGovernanceAction({
          status: "error",
          result: nextError.body || null,
          error: nextError.message || "codesite_governance_action_failed",
        });
      } finally {
        setActing(false);
      }
    },
    [acting, loadRadar, radarState.selectedProjectId, workspaceSlug],
  );

  const handleIssuePermit = useCallback(
    (payload) => {
      if (!radarState.selectedProjectId) return;
      return runGovernanceAction(() =>
        issueCodeSitePermit(
          workspaceSlug,
          radarState.selectedProjectId,
          payload,
        ),
      );
    },
    [radarState.selectedProjectId, runGovernanceAction, workspaceSlug],
  );

  const handleReviewDocument = useCallback(
    (documentRecord, decision, rationale = "") => {
      if (!documentRecord?.id) return;
      return runGovernanceAction(() =>
        reviewCodeSiteDocument(workspaceSlug, documentRecord.id, {
          decision,
          summary:
            rationale ||
            `Reviewed from CodeSite governance console as ${decision}.`,
          reviewTimeMs: 90_000,
          baselineReviewTimeMs: 300_000,
          evidenceRefs: [`codesite:ui:document-review:${documentRecord.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleProposeRouteRevision = useCallback(
    (plan, payload) => {
      if (!plan?.id) return;
      return runGovernanceAction(() =>
        proposeCodeSiteRouteRevision(workspaceSlug, plan.id, payload),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleReviewRouteRevision = useCallback(
    (revision, decision, rationale = "") => {
      if (!revision?.id) return;
      return runGovernanceAction(() =>
        reviewCodeSiteRouteRevision(workspaceSlug, revision.id, {
          decision,
          reason:
            rationale ||
            `Route revision ${decision} from CodeSite governance console.`,
          evidenceRefs: [`codesite:ui:route-review:${revision.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleApplyRouteRevision = useCallback(
    (revision, rationale = "") => {
      if (!revision?.id) return;
      return runGovernanceAction(() =>
        applyCodeSiteRouteRevision(workspaceSlug, revision.id, {
          appliedBy: "codesite_governance_console",
          rationale:
            rationale ||
            "Operator reviewed route scope, affected leases, and evidence.",
          evidenceRefs: [`codesite:ui:route-apply:${revision.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleResumeMayday = useCallback(
    (incident, inspectionRunIds = [], reviewRationale = "") => {
      if (!incident?.id) return;
      const rationale =
        reviewRationale ||
        "Operator reviewed incident replay, stop-work document, suspended clearances, and passing inspection evidence.";
      return runGovernanceAction(() =>
        resumeCodeSiteMayday(workspaceSlug, incident.id, {
          approved: true,
          humanApproval: true,
          rationale,
          summary: rationale,
          inspectionRunIds,
          replayRefs: uniqueValues([
            incident.replayDigest,
            incident.incidentReplay?.replayDigest,
          ]),
          evidenceRefs: [`codesite:ui:mayday-resume:${incident.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const currentProject = radarState.project;
  const controlState = radarState.controlState;
  const metrics = radarState.metrics;
  const metricSections = metrics?.sections || {};
  const metricSummary = metrics?.summary || {};
  const hasProjects = radarState.projects.length > 0;
  const collisionForecast =
    radarState.collisionForecast || controlState?.collisionForecast || {};
  const risks = asArray(collisionForecast.risks);
  const runwayOccupancy = asArray(
    collisionForecast.runwayOccupancy ||
      controlState?.collisionForecast?.runwayOccupancy,
  );
  const activeFlights = asArray(controlState?.activeFlights);
  const activeLeases = asArray(controlState?.activeMutationLeases);
  const activeTransactions = asArray(controlState?.activeTransactions);
  const pilotLicenseHealth = asArray(controlState?.pilotLicenseHealth);
  const filesystemBoundaryProofs = asArray(
    controlState?.filesystemBoundaryProofs,
  );
  const mutationTransactions = asArray(currentProject?.mutationTxns);
  const assumptions = asArray(currentProject?.assumptions);
  const proofBundles = asArray(currentProject?.proofBundles);
  const inspectionRuns = asArray(currentProject?.inspectionRuns);
  const incidents = asArray(currentProject?.incidents);
  const replayHandovers = useMemo(
    () => causalReplayHandovers(incidents, proofBundles),
    [incidents, proofBundles],
  );
  const inboxItems = asArray(currentProject?.inboxItems);
  const documents = asArray(currentProject?.documents);
  const permits = asArray(currentProject?.permits);
  const routeRevisions = asArray(currentProject?.routeRevisions);
  const openMaydays = incidents.filter(incidentNeedsResume);
  const counterfactualRuns = asArray(currentProject?.counterfactualRuns);
  const artifacts = asArray(radarState.artifactPreview?.files);
  const events = uniqueByEvent([
    ...streamEvents,
    ...asArray(radarState.events).slice().reverse(),
  ]).slice(0, 24);
  const allEvents = asArray(radarState.events);
  const quarantineRecords = useMemo(
    () =>
      mergeQuarantineRecords(
        radarState.quarantines,
        controlState?.pendingQuarantines,
        quarantineRecordsFromEvents(allEvents),
      ),
    [allEvents, controlState?.pendingQuarantines, radarState.quarantines],
  );
  const actionableQuarantineRecords = useMemo(
    () =>
      quarantineRecords.filter(
        (record) =>
          asArray(record.changes).length ||
          asArray(record.paths).length ||
          asArray(record.remainingPaths).length,
      ),
    [quarantineRecords],
  );
  const selectedQuarantine =
    actionableQuarantineRecords.find(
      (record) => record.quarantineId === quarantineReview.selectedId,
    ) ||
    actionableQuarantineRecords[0] ||
    null;
  const zones = asArray(currentProject?.zonePolicy?.zones);
  const noFlyZones = asArray(
    currentProject?.zonePolicy?.noFlyZones || currentProject?.zonePolicy?.noFly,
  )
    .map((zone) =>
      typeof zone === "string" ? zone : zone?.pattern || zone?.path || zone?.id,
    )
    .filter(Boolean);
  const lineProvenance = asArray(currentProject?.lineProvenance);
  const selectedLineRow = lineInspector.row;
  const selectedLineTransaction = selectedLineRow
    ? selectedLineRow.transaction ||
      activeTransactions.find(
        (txn) => txn.id === selectedLineRow.transactionId,
      ) ||
      mutationTransactions.find(
        (txn) => txn.id === selectedLineRow.transactionId,
      ) ||
      null
    : null;
  const selectedLineLease = selectedLineRow
    ? selectedLineRow.mutationLease ||
      activeLeases.find(
        (lease) => lease.id === selectedLineTransaction?.mutationLeaseId,
      ) ||
      asArray(currentProject?.mutationLeases).find(
        (lease) => lease.id === selectedLineTransaction?.mutationLeaseId,
      ) ||
      null
    : null;
  const selectedLineProof = selectedLineRow
    ? selectedLineRow.proofBundleId
      ? asArray(selectedLineRow.proofBundles).find(
          (bundle) => bundle.id === selectedLineRow.proofBundleId,
        ) ||
        proofBundles.find(
          (bundle) => bundle.id === selectedLineRow.proofBundleId,
        ) ||
        null
      : asArray(selectedLineRow.proofBundles)[0] || null
    : null;
  const selectedLineEvidenceRefs = selectedLineRow
    ? uniqueValues([
        ...asArray(selectedLineRow.evidenceRefs),
        ...asArray(selectedLineProof?.evidenceRefs),
      ])
    : [];
  const selectedLineInspectionRefs = selectedLineRow
    ? uniqueValues(
        inspectionRuns
          .filter((run) =>
            asArray(run.changedPaths).some((changedPath) =>
              pathCoversFile(changedPath, selectedLineRow.filePath),
            ),
          )
          .flatMap(inspectionRunRefs),
      )
    : [];
  const selectedLineDojoRefs = selectedLineRow
    ? uniqueValues([
        ...asArray(selectedLineRow.dojoSourceRefs),
        selectedLineLease?.dojoProofRef,
        selectedLineLease?.dojoLicenseRef,
        ...asArray(selectedLineLease?.dojoEvidenceRefs),
      ])
    : [];
  const artifactContent = artifacts.find(
    (file) => file.contentPreview,
  )?.contentPreview;
  const artifactContentPath = artifacts.find(
    (file) => file.contentPreview,
  )?.path;
  const latestSimulation = latestCounterfactualSimulation(counterfactualRuns);
  const towerSimulation = simulationRun.result || latestSimulation.result;
  const towerUniverses = asArray(towerSimulation?.universes);
  const selectedUniverse =
    towerUniverses.find(
      (universe) => universe.strategy === towerSimulation?.selected,
    ) ||
    towerUniverses[0] ||
    null;

  useEffect(() => {
    setLineInspector({ status: "idle", row: null, rows: [], error: null });
    setSimulationRun({ status: "idle", result: null, error: null });
    setQuarantineReview({
      selectedId: null,
      selectedPaths: [],
      status: "idle",
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    });
    setPermitDraft({ title: "", permitType: "restricted_route", route: "" });
    setRouteDraft({ route: "", reason: "" });
    setGovernanceAction({ status: "idle", result: null, error: null });
  }, [currentProject?.id]);

  useEffect(() => {
    if (!selectedQuarantine) return;
    if (quarantineReview.selectedId === selectedQuarantine.quarantineId) return;
    setQuarantineReview((current) => ({
      ...current,
      selectedId: selectedQuarantine.quarantineId,
      selectedPaths: [],
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    }));
  }, [quarantineReview.selectedId, selectedQuarantine]);

  const handleInspectLine = useCallback(
    async (row) => {
      if (!row?.filePath) return;
      const range = lineRange(row);
      setLineInspector({ status: "loading", row, rows: [], error: null });
      try {
        const rows = await fetchCodeSiteLineProvenance(workspaceSlug, {
          projectId: currentProject?.id,
          filePath: row.filePath,
          lineAnchor: row.lineAnchor,
          lineNumber: range.startLine,
        });
        const nextRows = rows.length ? rows : [row];
        setLineInspector({
          status: "ready",
          row: nextRows[0],
          rows: nextRows,
          error: null,
        });
      } catch (nextError) {
        setLineInspector({
          status: "error",
          row,
          rows: [row],
          error: nextError.message || "line_provenance_lookup_failed",
        });
      }
    },
    [currentProject?.id, workspaceSlug],
  );

  const handleSelectQuarantine = useCallback((record) => {
    setQuarantineReview({
      selectedId: record?.quarantineId || null,
      selectedPaths: [],
      status: "idle",
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    });
  }, []);

  const handleToggleQuarantinePath = useCallback((path) => {
    if (!path) return;
    setQuarantineReview((current) => {
      const currentPaths = new Set(current.selectedPaths);
      if (currentPaths.has(path)) currentPaths.delete(path);
      else currentPaths.add(path);
      return {
        ...current,
        selectedPaths: [...currentPaths],
        replay: null,
        replayPathKey: "",
        apply: null,
        error: null,
      };
    });
  }, []);

  const handleReplayQuarantine = useCallback(
    async (record) => {
      if (!workspaceSlug || !record?.quarantineId || acting) return;
      const paths = quarantineReview.selectedPaths;
      if (!paths.length) {
        setQuarantineReview((current) => ({
          ...current,
          error: "Select at least one quarantined path before replay.",
        }));
        return;
      }
      setActing(true);
      setQuarantineReview((current) => ({
        ...current,
        status: "replaying",
        error: null,
        replay: null,
        replayPathKey: selectedPathKey(paths),
        apply: null,
      }));
      try {
        const result = await replayCodeSiteQuarantine(
          workspaceSlug,
          record.quarantineId,
          {
            transactionId: record.transactionId,
            mutationLeaseId: record.mutationLeaseId,
            agentSessionId: record.agentSessionId,
            displayCallsign: record.displayCallsign,
            paths,
          },
        );
        setQuarantineReview((current) => ({
          ...current,
          status: "replayed",
          replay: result,
          replayPathKey: selectedPathKey(paths),
          error: null,
        }));
        void loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        }).catch((nextError) => {
          setError({
            status: nextError.status,
            message: nextError.message || "codesite_quarantine_refresh_failed",
          });
        });
      } catch (nextError) {
        setQuarantineReview((current) => ({
          ...current,
          status: "error",
          replay: nextError.body || null,
          replayPathKey: selectedPathKey(paths),
          error: nextError.message || "codesite_quarantine_replay_failed",
        }));
      } finally {
        setActing(false);
      }
    },
    [
      acting,
      loadRadar,
      quarantineReview.selectedPaths,
      radarState.selectedProjectId,
      workspaceSlug,
    ],
  );

  const handleApplyQuarantine = useCallback(
    async (record) => {
      if (!workspaceSlug || !record?.quarantineId || acting) return;
      const paths = quarantineReview.selectedPaths;
      if (
        !paths.length ||
        quarantineReview.replay?.ok !== true ||
        quarantineReview.replayPathKey !== selectedPathKey(paths)
      ) {
        setQuarantineReview((current) => ({
          ...current,
          error: "Replay the selected quarantined paths before apply.",
        }));
        return;
      }
      setActing(true);
      setQuarantineReview((current) => ({
        ...current,
        status: "applying",
        error: null,
        apply: null,
      }));
      try {
        const result = await applyCodeSiteQuarantine(
          workspaceSlug,
          record.quarantineId,
          {
            transactionId: record.transactionId,
            mutationLeaseId: record.mutationLeaseId,
            agentSessionId: record.agentSessionId,
            displayCallsign: record.displayCallsign,
            paths,
          },
        );
        setQuarantineReview((current) => ({
          ...current,
          status: "applied",
          apply: result,
          error: null,
        }));
        void loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        }).catch((nextError) => {
          setError({
            status: nextError.status,
            message: nextError.message || "codesite_quarantine_refresh_failed",
          });
        });
      } catch (nextError) {
        setQuarantineReview((current) => ({
          ...current,
          status: "error",
          apply: nextError.body || null,
          error: nextError.message || "codesite_quarantine_apply_failed",
        }));
      } finally {
        setActing(false);
      }
    },
    [
      acting,
      loadRadar,
      quarantineReview.replay,
      quarantineReview.replayPathKey,
      quarantineReview.selectedPaths,
      radarState.selectedProjectId,
      workspaceSlug,
    ],
  );

  const latestStatus = useMemo(() => {
    if (error?.status === 401) return "auth";
    if (error?.status === 404) return "missing";
    if (error) return "error";
    return controlState?.towerState || currentProject?.status || "idle";
  }, [controlState?.towerState, currentProject?.status, error]);
  const mobileSections = useMemo(
    () => [
      { key: "radar", label: "Radar" },
      { key: "tower", label: "Tower" },
      { key: "governance", label: "Governance" },
      { key: "evidence", label: "Metrics" },
      { key: "simulator", label: "Simulator" },
      { key: "quarantine", label: "Quarantine" },
      { key: "replay", label: "Replay" },
      { key: "lineage", label: "Lineage" },
      { key: "runway", label: "Runway" },
    ],
    [],
  );

  return (
    <div
      data-testid="codesite-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{
        "--text-muted":
          "color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary) 22%)",
        "--codesite-panel-line":
          "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--bg-sidebar) 98%, var(--bg-editor) 2%), var(--bg-sidebar) 44%, color-mix(in srgb, var(--bg-sidebar) 94%, var(--bg-editor) 6%))",
        color: "var(--text-primary)",
      }}
    >
      <div
        className="shrink-0 border-b px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.12)]"
        style={{
          borderColor: "var(--codesite-panel-line)",
          background: "color-mix(in srgb, var(--bg-sidebar) 96%, var(--bg-elevated) 4%)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "color-mix(in srgb, var(--accent-primary) 9%, var(--bg-elevated))",
              }}
            >
              <Radar
                className="h-4 w-4"
                style={{ color: "var(--accent-primary)" }}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">CodeSite</div>
              <div
                className="truncate text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                {compact(workspaceSlug, "No workspace")}
              </div>
            </div>
          </div>
          <Pill tone={latestStatus}>{latestStatus}</Pill>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasProjects ? (
            <div className="min-w-0 basis-full sm:min-w-[220px] sm:basis-0 sm:flex-1">
              <label htmlFor="codesite-project-select" className="sr-only">
                CodeSite project
              </label>
              <select
                id="codesite-project-select"
                data-testid="codesite-project-select"
                value={radarState.selectedProjectId || ""}
                onChange={(event) =>
                  setSelectedProjectId(event.target.value || null)
                }
                className="h-11 w-full min-w-0 truncate rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                }}
              >
                {radarState.projects.map((project, index) => (
                  <option
                    key={project.id || project.slug || `project-${index}`}
                    value={project.id}
                  >
                    {project.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <IconButton
            title="Refresh"
            onClick={() => loadRadar()}
            disabled={loading || acting}
            testId="codesite-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </IconButton>
          <IconButton
            title="Export artifacts"
            onClick={handleExportArtifacts}
            disabled={!radarState.selectedProjectId || loading || acting}
            testId="codesite-export"
          >
            <Upload className="h-3.5 w-3.5" />
            Export
          </IconButton>
        </div>
      </div>

      {loading && !currentProject && !error ? (
        <LoadingSkeleton />
      ) : (
        <div
          ref={scrollContainerRef}
          data-testid="codesite-panel-scroll"
          className="min-h-0 flex-1 overflow-y-auto pb-16"
          tabIndex={0}
          aria-label="CodeSite evidence sections"
          style={{
            background:
              "linear-gradient(90deg, color-mix(in srgb, var(--border-subtle) 20%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border-subtle) 14%, transparent) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        >
          <MobileSectionTabs
            sections={mobileSections}
            activeSection={activeSection}
            onSelect={handleSelectSection}
          />
          {error ? (
            <div
              data-testid="codesite-error-state"
              className="m-3 grid gap-3 rounded-lg border px-3 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              style={{
                borderColor:
                  "color-mix(in srgb, #ff5757 38%, var(--border-subtle))",
                color: "var(--text-primary)",
                background:
                  "color-mix(in srgb, var(--bg-surface) 90%, #ff5757 4%)",
              }}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>CodeSite tower link interrupted</span>
                </div>
                <div
                  className="mt-1 break-words leading-5"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {error.status ? `${error.status}: ` : null}
                  {error.message}
                </div>
              </div>
              <IconButton
                title="Retry CodeSite link"
                onClick={() => loadRadar()}
                disabled={loading || acting}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </IconButton>
            </div>
          ) : null}

          {!hasProjects ? (
            <div className="p-3">
              <form
                data-testid="codesite-empty-state"
                onSubmit={handleCreateProject}
                className="grid gap-4 rounded-lg border p-4"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--border-subtle) 64%, var(--accent-primary) 36%)",
                  background:
                    "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 7%), var(--bg-editor))",
                }}
              >
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border"
                        style={{
                          borderColor:
                            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
                          background:
                            "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
                        }}
                      >
                        <Radar
                          className="h-3.5 w-3.5"
                          style={{ color: "var(--accent-primary)" }}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          Airspace not opened
                        </div>
                        <div
                          className="mt-1 text-xs leading-5"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Start a governed construction run for this workspace.
                        </div>
                      </div>
                    </div>
                  </div>
                  <Pill tone="idle">awaiting clearance</Pill>
                </div>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="codesite-new-project-title"
                      className="mb-1 block text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Project title
                    </label>
                    <input
                      id="codesite-new-project-title"
                      value={newProjectTitle}
                      onChange={(event) =>
                        setNewProjectTitle(event.target.value)
                      }
                      placeholder="Coordination run"
                      className="h-8 w-full min-w-0 rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-editor)",
                        color: "var(--text-primary)",
                      }}
                    />
                  </div>
                  <IconButton
                    title="Open project"
                    variant="primary"
                    disabled={acting || !workspaceSlug}
                    type="submit"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Open
                  </IconButton>
                </div>
              </form>
            </div>
          ) : null}

          {currentProject ? (
            <>
              <motion.div
                data-testid="codesite-operator-cockpit"
                className="grid gap-3 p-3 sm:p-4"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.24,
                  ease: MOTION_EASE,
                }}
              >
                <div
                  data-testid="codesite-mission-control-header"
                  className="grid gap-3 rounded-lg border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] xl:grid-cols-[minmax(0,1fr)_minmax(460px,0.82fr)] xl:items-center"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--border-subtle) 58%, var(--accent-primary) 42%)",
                    background:
                      "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 9%), color-mix(in srgb, var(--bg-editor) 92%, var(--text-primary) 4%))",
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Pill tone={latestStatus}>{latestStatus}</Pill>
                      <Pill
                        tone={
                          streamStatus === "live"
                            ? "active"
                            : streamStatus === "reconnecting"
                              ? "warning"
                              : "idle"
                        }
                      >
                        {streamStatus}
                      </Pill>
                      {collisionForecast.riskLevel ? (
                        <Pill tone={collisionForecast.riskLevel}>
                          {collisionForecast.riskLevel}
                        </Pill>
                      ) : null}
                    </div>
                    <h2
                      className="mt-2 max-w-[760px] break-words text-2xl font-semibold leading-tight sm:text-3xl"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {currentProject.title}
                    </h2>
                    <p
                      className="mt-1.5 max-w-[72ch] text-sm leading-6"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {currentProject.request}
                    </p>
                  </div>
                  <div
                    data-testid="codesite-status-rail"
                    className="grid grid-cols-2 gap-2 xl:grid-cols-4"
                  >
                    <StatusRailItem
                      label="Flights"
                      value={radarState.counts.activeFlights}
                      tone={activeFlights.length ? "active" : "idle"}
                      icon={Activity}
                      testId="codesite-status-flights"
                    />
                    <StatusRailItem
                      label="Required"
                      value={radarState.counts.requiredActions}
                      tone={radarState.counts.requiredActions ? "high" : "low"}
                      icon={Inbox}
                      testId="codesite-status-required"
                    />
                    <StatusRailItem
                      label="Permits"
                      value={permits.length}
                      tone={permits.length ? "active" : "holding"}
                      icon={ShieldCheck}
                      testId="codesite-status-permits"
                    />
                    <StatusRailItem
                      label="Reroutes"
                      value={routeRevisions.length}
                      tone={
                        routeRevisions.filter(routeRevisionCanReview).length
                          ? "warning"
                          : "active"
                      }
                      icon={Route}
                      testId="codesite-status-reroutes"
                    />
                  </div>
                </div>

                <TowerNowStrip
                  towerState={latestStatus}
                  streamStatus={streamStatus}
                  collisionForecast={collisionForecast}
                  risks={risks}
                  requiredActionCount={radarState.counts.requiredActions}
                  documents={documents}
                  routeRevisions={routeRevisions}
                  openMaydays={openMaydays}
                  runwayOccupancy={runwayOccupancy}
                  activeTransactions={activeTransactions}
                  proofBundles={proofBundles}
                  quarantineRecords={quarantineRecords}
                  onSelect={handleSelectSection}
                />

                <div
                  data-testid="codesite-responsive-proof-target"
                  className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)] xl:items-start"
                >
                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Airspace Map"
                      icon={Map}
                      sectionKey="radar"
                      testId="codesite-operator-airspace-pane"
                      right={
                        <Pill>{zones.length || activeFlights.length}</Pill>
                      }
                    >
                      <AirspaceMap
                        zones={zones}
                        noFlyZones={noFlyZones}
                        flights={activeFlights}
                        risks={risks}
                        events={events}
                        inspections={inspectionRuns}
                        condensed
                      />
                    </OperatorPane>

                    <div
                      data-testid="codesite-metric-rail"
                      className="grid grid-cols-[repeat(auto-fit,minmax(126px,1fr))] gap-2"
                    >
                      <Metric
                        label="Flights"
                        value={radarState.counts.activeFlights}
                        testId="codesite-metric-flights"
                      />
                      <Metric
                        label="Leases"
                        value={radarState.counts.activeMutationLeases}
                      />
                      <Metric
                        label="Transactions"
                        value={radarState.counts.activeTransactions}
                      />
                      <Metric
                        label="Required"
                        value={radarState.counts.requiredActions}
                        tone={
                          radarState.counts.requiredActions ? "high" : "low"
                        }
                      />
                      <Metric
                        label="Risk"
                        value={compact(collisionForecast.riskLevel, "unknown")}
                        tone={collisionForecast.riskLevel}
                      />
                      <Metric
                        label="Permits"
                        value={permits.length}
                        tone={permits.length ? "active" : "idle"}
                        testId="codesite-metric-permits"
                      />
                      <Metric
                        label="Documents"
                        value={documents.length}
                        tone={
                          documents.filter(documentNeedsReview).length
                            ? "holding"
                            : "active"
                        }
                      />
                      <Metric
                        label="Reroutes"
                        value={routeRevisions.length}
                        tone={
                          routeRevisions.filter(routeRevisionCanReview).length
                            ? "holding"
                            : "idle"
                        }
                      />
                    </div>
                  </div>

                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Tower Feed"
                      icon={Radar}
                      sectionKey="tower"
                      testId="codesite-operator-tower-pane"
                      right={
                        <Pill
                          tone={
                            streamStatus === "live"
                              ? "active"
                              : streamStatus === "reconnecting"
                                ? "warning"
                                : "idle"
                          }
                        >
                          {streamStatus}
                        </Pill>
                      }
                    >
                      <TowerStreamPanel
                        events={events}
                        streamStatus={streamStatus}
                        condensed
                      />
                    </OperatorPane>

                    <OperatorPane
                      title="Governance Console"
                      icon={ClipboardCheck}
                      sectionKey="governance"
                      testId="codesite-operator-governance-pane"
                      right={
                        <Pill
                          tone={
                            documents.filter(documentNeedsReview).length ||
                            routeRevisions.filter(routeRevisionCanReview)
                              .length ||
                            openMaydays.length
                              ? "holding"
                              : "active"
                          }
                        >
                          {permits.length}/{documents.length}/
                          {routeRevisions.length}
                        </Pill>
                      }
                    >
                      <GovernanceConsole
                        project={currentProject}
                        activeFlights={activeFlights}
                        activeLeases={activeLeases}
                        incidents={incidents}
                        inspectionRuns={inspectionRuns}
                        permitDraft={permitDraft}
                        routeDraft={routeDraft}
                        onPermitDraft={setPermitDraft}
                        onRouteDraft={setRouteDraft}
                        onIssuePermit={handleIssuePermit}
                        onReviewDocument={handleReviewDocument}
                        onProposeRouteRevision={handleProposeRouteRevision}
                        onReviewRouteRevision={handleReviewRouteRevision}
                        onApplyRouteRevision={handleApplyRouteRevision}
                        onResumeMayday={handleResumeMayday}
                        actionState={governanceAction}
                        disabled={acting}
                        condensed
                      />
                    </OperatorPane>
                  </div>
                </div>
              </motion.div>

              <Section
                title="Success Metrics"
                icon={BarChart3}
                sectionKey="evidence"
                right={
                  <Pill tone={metrics?.status || "pending"}>
                    {metrics ? "measured" : "no data"}
                  </Pill>
                }
              >
                {metrics ? (
                  <SuccessMetricsDeck
                    sections={metricSections}
                    summary={metricSummary}
                  />
                ) : (
                  <EmptyLine>No success metrics exported yet</EmptyLine>
                )}
              </Section>

              <Section
                title="Runway Occupancy"
                icon={Route}
                sectionKey="runway"
                right={
                  <Pill tone={runwayOccupancy.length ? "holding" : "active"}>
                    {runwayOccupancy.length}
                  </Pill>
                }
              >
                <RunwayOccupancyBoard runways={runwayOccupancy} />
              </Section>

              <Section
                title="Pilot License Health"
                icon={ShieldCheck}
                right={
                  <Pill
                    tone={
                      pilotLicenseHealth.some(
                        (record) => record.status !== "active",
                      )
                        ? "holding"
                        : "active"
                    }
                  >
                    {pilotLicenseHealth.length}
                  </Pill>
                }
              >
                <PilotLicenseHealthPanel records={pilotLicenseHealth} />
              </Section>

              <Section
                title="Filesystem Boundary Proofs"
                icon={FileSearch}
                right={
                  <Pill
                    tone={
                      filesystemBoundaryProofs.some(
                        (record) => !record.proofComplete,
                      )
                        ? "holding"
                        : filesystemBoundaryProofs.length
                          ? "active"
                          : "idle"
                    }
                  >
                    {filesystemBoundaryProofs.length}
                  </Pill>
                }
              >
                <FilesystemBoundaryProofPanel
                  records={filesystemBoundaryProofs}
                />
              </Section>

              <Section
                title="Quarantine Review"
                icon={FileSearch}
                sectionKey="quarantine"
                right={
                  <Pill
                    tone={
                      actionableQuarantineRecords.length ? "holding" : "active"
                    }
                  >
                    {actionableQuarantineRecords.length}
                  </Pill>
                }
              >
                <QuarantineReviewPanel
                  records={actionableQuarantineRecords}
                  fetchError={radarState.quarantineError}
                  selectedId={
                    selectedQuarantine?.quarantineId ||
                    quarantineReview.selectedId
                  }
                  selectedPaths={quarantineReview.selectedPaths}
                  reviewState={quarantineReview}
                  onSelect={handleSelectQuarantine}
                  onTogglePath={handleToggleQuarantinePath}
                  onReplay={handleReplayQuarantine}
                  onApply={handleApplyQuarantine}
                  disabled={acting}
                />
              </Section>

              <Section
                title="Collision Forecast"
                icon={AlertTriangle}
                right={
                  <Pill tone={riskTone(collisionForecast.riskLevel)}>
                    {compact(collisionForecast.riskLevel, "unknown")}
                  </Pill>
                }
              >
                {risks.length === 0 ? (
                  <EmptyLine>No forecasted collisions</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {risks.map((risk, index) => (
                      <div
                        key={`${risk.risk || risk.type || "risk"}-${index}`}
                        className="rounded border px-3 py-2 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {compact(risk.risk || risk.type, "collision")}
                          </span>
                          <Pill tone={risk.severity || risk.riskLevel}>
                            {compact(risk.severity || risk.riskLevel, "risk")}
                          </Pill>
                        </div>
                        <div
                          className="mt-1 truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {compact(
                            risk.conflictZone || risk.path || risk.zoneKey,
                            "unknown zone",
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Tower Simulator"
                icon={Activity}
                sectionKey="simulator"
                right={
                  <Pill tone={selectedUniverse?.result || simulationRun.status}>
                    {compact(
                      towerSimulation?.selected,
                      simulationRun.status === "running"
                        ? "running"
                        : "not run",
                    )}
                  </Pill>
                }
              >
                <TowerSimulatorDeck
                  towerSimulation={towerSimulation}
                  latestSimulation={latestSimulation}
                  towerUniverses={towerUniverses}
                  selectedUniverse={selectedUniverse}
                  assumptions={assumptions}
                  activeFlights={activeFlights}
                  activeLeases={activeLeases}
                  events={allEvents}
                  simulationRun={simulationRun}
                  onRun={handleRunTowerSimulation}
                  disabled={!radarState.selectedProjectId || loading || acting}
                />
              </Section>

              <Section
                title="Flights"
                icon={Route}
                right={<Pill>{activeFlights.length}</Pill>}
              >
                {activeFlights.length === 0 ? (
                  <EmptyLine>No active flights</EmptyLine>
                ) : (
                  <div>
                    {activeFlights.map((plan, index) => (
                      <Row
                        key={
                          plan.id || plan.displayCallsign || `flight-${index}`
                        }
                        testId={`codesite-flight-${plan.id || index}`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {compact(plan.displayCallsign, "agent")}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {compact(plan.domain, "implementation")}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate">
                            {compact(plan.mission, "Code mutation flight")}
                          </div>
                          <PathList paths={plan.route || []} />
                        </div>
                        <div className="justify-self-end">
                          <Pill tone={plan.status}>{plan.status}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Clearances"
                icon={ShieldCheck}
                right={<Pill>{activeLeases.length}</Pill>}
              >
                {activeLeases.length === 0 ? (
                  <EmptyLine>No active clearances</EmptyLine>
                ) : (
                  <div>
                    {activeLeases.map((lease, index) => (
                      <Row
                        key={
                          lease.id || lease.displayCallsign || `lease-${index}`
                        }
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {compact(lease.displayCallsign, "agent")}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {formatTime(lease.expiresAt) || "open"}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <PathList
                            paths={lease.lease?.allowedPaths || []}
                            empty="route pending"
                          />
                          <TagList
                            items={[
                              lease.dojoProofRef,
                              lease.dojoLicenseRef,
                              ...asArray(lease.dojoEvidenceRefs),
                              lease.dojoLedgerCheckpointHash,
                              lease.dojoDecisionDigest,
                            ]}
                            empty=""
                          />
                          <TagList
                            items={[
                              lease.pilotLicenseHealth?.status
                                ? `pilot:${lease.pilotLicenseHealth.status}`
                                : null,
                              lease.pilotLicenseHealth?.level
                                ? `level:${lease.pilotLicenseHealth.level}`
                                : null,
                              lease.pilotLicenseRequirement?.minimumLevel
                                ? `min:${lease.pilotLicenseRequirement.minimumLevel}`
                                : null,
                            ]}
                            empty=""
                          />
                        </div>
                        <div className="justify-self-end">
                          <Pill tone={lease.status}>{lease.status}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Transactions And Proof"
                icon={GitCommit}
                right={
                  <Pill>
                    {mergeTransactionSources(activeTransactions, mutationTransactions).length}/
                    {proofBundles.length}
                  </Pill>
                }
              >
                <SerializableIsolationDeck
                  activeTransactions={activeTransactions}
                  mutationTransactions={mutationTransactions}
                  proofBundles={proofBundles}
                  events={allEvents}
                />
              </Section>

              <Section
                title="Inspections And Incidents"
                icon={Siren}
                right={
                  <Pill tone={incidents.length ? "blocked" : "active"}>
                    {incidents.length}
                  </Pill>
                }
              >
                {inspectionRuns.length === 0 && incidents.length === 0 ? (
                  <EmptyLine>No inspections or incidents</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {inspectionRuns
                      .slice(-3)
                      .reverse()
                      .map((run, index) => (
                        <div
                          key={run.id || `inspection-run-${index}`}
                          className="rounded border px-3 py-2 text-xs"
                          style={{
                            borderColor: "var(--border-subtle)",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {compact(run.displayCallsign, "inspection")}
                            </span>
                            <Pill tone={run.status}>{run.status}</Pill>
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={run.changedPaths || []}
                              empty="no changed paths"
                            />
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {asArray(run.inspectionSignals)
                              .slice(0, 3)
                              .map((signal, index) => (
                                <Pill
                                  key={`${run.id}-signal-${index}`}
                                  tone={signal.status || run.status}
                                >
                                  {compact(
                                    signal.key || signal.type || signal.kind,
                                    "signal",
                                  )}
                                </Pill>
                              ))}
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={run.evidenceRefs || []}
                              empty="no evidence refs"
                            />
                          </div>
                        </div>
                      ))}
                    {incidents
                      .slice(-3)
                      .reverse()
                      .map((incident, index) => (
                        <div
                          key={incident.id || `incident-${index}`}
                          className="rounded border px-3 py-2 text-xs"
                          style={{
                            borderColor:
                              "color-mix(in srgb, #ff5757 36%, var(--border-subtle))",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {compact(incident.category, "incident")}
                            </span>
                            <Pill tone={incident.severity}>
                              {incident.severity}
                            </Pill>
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={incident.affectedZones || []}
                              empty="no affected zones"
                            />
                          </div>
                          <div className="mt-1 grid gap-1 sm:grid-cols-2">
                            <PathList
                              paths={incident.participants || []}
                              empty="no participants"
                            />
                            <PathList
                              paths={incident.evidenceRefs || []}
                              empty="no evidence refs"
                            />
                          </div>
                          <div
                            className="mt-1 truncate font-mono text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {incident.replayDigest ||
                              compact(
                                incident.incidentReplay?.summary,
                                "no replay digest",
                              )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </Section>

              <Section
                title="Causal Replay Handover"
                icon={ScrollText}
                sectionKey="replay"
                right={
                  <Pill
                    tone={
                      replayHandovers.length
                        ? replayCompletenessTone(
                            replayHandovers[0].completeness,
                          )
                        : "pending"
                    }
                  >
                    {replayHandovers.length}
                  </Pill>
                }
              >
                <CausalReplayDeck handovers={replayHandovers} />
              </Section>

              <Section
                title="Artifact Projection"
                icon={FileJson}
                right={<Pill>{artifacts.length}</Pill>}
              >
                {exportResult ? (
                  <div
                    className="mb-2 rounded border px-3 py-2 text-xs"
                    style={{
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {exportResult.written
                      ? "Artifacts written"
                      : "Preview only"}
                    {exportResult.root ? `: ${exportResult.root}` : ""}
                  </div>
                ) : null}
                {artifacts.length === 0 ? (
                  <EmptyLine>No artifact preview</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {artifacts.slice(0, 10).map((file, index) => (
                      <div
                        key={file.path || `artifact-${index}`}
                        className="flex items-center justify-between gap-3 rounded border px-2 py-1.5 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <code
                          className="min-w-0 truncate text-[10px]"
                          title={file.path}
                        >
                          {file.path}
                        </code>
                        <span
                          className="shrink-0 font-mono text-[10px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {file.bytes}b
                        </span>
                      </div>
                    ))}
                    {artifactContent ? (
                      <div className="pt-2">
                        <div
                          className="mb-1 flex items-center gap-2 text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <FileSearch className="h-3.5 w-3.5" />
                          <span className="min-w-0 truncate">
                            {artifactContentPath}
                          </span>
                        </div>
                        <JsonPreview value={artifactContent} maxLines={12} />
                      </div>
                    ) : null}
                  </div>
                )}
              </Section>

              <Section
                title="Black Box"
                icon={ScrollText}
                right={<Pill>{events.length}</Pill>}
              >
                <BlackBoxFlightRecorder events={events} />
              </Section>

              <Section
                title="Required Actions"
                icon={Inbox}
                right={
                  <Pill
                    tone={
                      radarState.counts.requiredActions ? "holding" : "active"
                    }
                  >
                    {radarState.counts.requiredActions}
                  </Pill>
                }
              >
                {asArray(controlState?.requiredActions).length === 0 ? (
                  <EmptyLine>No blocking actions</EmptyLine>
                ) : (
                  <div className="space-y-1" data-testid="codesite-required-actions-list">
                    {controlState.requiredActions.map((action, index) => (
                      <div
                        key={`${actionLabel(action)}-${index}`}
                        data-testid="codesite-required-action-row"
                        className="rounded border px-2 py-2 text-[11px]"
                        style={{
                          borderColor:
                            "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                          background:
                            "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
                        }}
                      >
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <Pill tone={actionSeverity(action)}>
                                {actionSeverity(action)}
                              </Pill>
                              <span className="min-w-0 break-words font-semibold">
                                {actionLabel(action)}
                              </span>
                            </div>
                            <div
                              className="mt-1 grid gap-1 font-mono text-[10px] sm:grid-cols-2"
                              style={{ color: "var(--text-muted)" }}
                            >
                              <span className="min-w-0 break-all">
                                owner: {actionOwner(action)}
                              </span>
                              <span className="min-w-0 break-all">
                                entity: {actionEntity(action)}
                              </span>
                            </div>
                            {actionEvidenceRefs(action).length ? (
                              <TagList
                                items={actionEvidenceRefs(action)}
                                maxVisible={3}
                              />
                            ) : null}
                          </div>
                          <button
                            type="button"
                            data-testid="codesite-required-action-review"
                            aria-label={`${actionHasGovernanceReviewTarget(action) ? "Review" : "Locate"} ${actionLabel(action)}`}
                            onClick={() => handleRequiredActionReview(action)}
                            className="inline-flex min-h-11 items-center justify-center rounded-md border px-3 text-xs font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                            style={{
                              borderColor:
                                "color-mix(in srgb, var(--accent-primary) 45%, var(--border-subtle))",
                              background:
                                "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-elevated))",
                              color: "var(--text-primary)",
                            }}
                          >
                            {actionHasGovernanceReviewTarget(action)
                              ? "Review"
                              : "Locate"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Agent Inbox"
                icon={Inbox}
                right={
                  <Pill
                    tone={
                      inboxItems.some((item) => item.status === "pending")
                        ? "holding"
                        : "active"
                    }
                  >
                    {inboxItems.length}
                  </Pill>
                }
              >
                {inboxItems.length === 0 ? (
                  <EmptyLine>No routed inbox items</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {inboxItems
                      .slice(-5)
                      .reverse()
                      .map((item, index) => (
                        <div
                          key={
                            item.id ||
                            item.eventId ||
                            `${item.kind || "inbox"}-${index}`
                          }
                          className="rounded border px-2 py-1.5 text-xs"
                          style={{
                            borderColor: "var(--border-subtle)",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {compact(item.kind, "inbox")}
                              </div>
                              <div
                                className="truncate font-mono text-[10px]"
                                style={{ color: "var(--text-muted)" }}
                              >
                                {compact(item.agentSessionId, "session")} /{" "}
                                {compact(item.eventId, "event")}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {item.requiresResponse ? (
                                <Pill tone="holding">response</Pill>
                              ) : null}
                              <Pill tone={item.status}>
                                {compact(item.status, "pending")}
                              </Pill>
                            </div>
                          </div>
                          {hasEntries(item.redactedPayload) ? (
                            <div className="mt-1">
                              <JsonPreview
                                value={item.redactedPayload}
                                maxLines={6}
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                  </div>
                )}
              </Section>

              <Section
                title="Inspections Queue"
                icon={ClipboardCheck}
                right={<Pill>{inspectionRuns.length}</Pill>}
              >
                <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
                  <Metric label="Runs" value={inspectionRuns.length} />
                  <Metric
                    label="Incidents"
                    value={incidents.length}
                    tone={incidents.length ? "high" : "low"}
                  />
                  <Metric label="Events" value={radarState.counts.events} />
                  <Metric
                    label="Proof"
                    value={radarState.counts.proofBundles}
                  />
                </div>
              </Section>

              <Section
                title="Line Provenance"
                icon={FileSearch}
                sectionKey="lineage"
                right={<Pill>{lineProvenance.length}</Pill>}
              >
                <LineProvenanceDeck
                  rows={lineProvenance}
                  selectedLineRow={selectedLineRow}
                  selectedLineTransaction={selectedLineTransaction}
                  selectedLineLease={selectedLineLease}
                  selectedLineProof={selectedLineProof}
                  selectedLineEvidenceRefs={selectedLineEvidenceRefs}
                  selectedLineInspectionRefs={selectedLineInspectionRefs}
                  selectedLineDojoRefs={selectedLineDojoRefs}
                  lineInspector={lineInspector}
                  onInspectLine={handleInspectLine}
                />
              </Section>

              <Section
                title="Airspace Zones"
                icon={Layers}
                right={<Pill>{zones.length}</Pill>}
              >
                {zones.length === 0 ? (
                  <EmptyLine>No classified zones</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {zones.slice(0, 6).map((zone, index) => (
                      <div
                        key={zone.zoneKey || zone.id || index}
                        className="grid min-h-10 grid-cols-[minmax(76px,0.8fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border px-2 py-1.5 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {zoneName(zone, index)}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Class {zoneClass(zone)}
                          </div>
                        </div>
                        <PathList paths={zonePaths(zone)} empty="no paths" />
                        <Pill tone={zone.risk || "medium"}>
                          {compact(zone.risk, "risk")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Radar Sources" icon={Activity}>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-xs">
                  <div
                    className="rounded border px-3 py-2"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-surface)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>
                      Allowed paths
                    </div>
                    <div className="mt-1">
                      <PathList paths={controlState?.allowedPaths || []} />
                    </div>
                  </div>
                  <div
                    className="rounded border px-3 py-2"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-surface)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>
                      Blocked paths
                    </div>
                    <div className="mt-1">
                      <PathList paths={controlState?.blockedPaths || []} />
                    </div>
                  </div>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
