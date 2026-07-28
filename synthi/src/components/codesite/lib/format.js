export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function uniqueValues(values) {
  return [
    ...new Set(
      asArray(values)
        .filter(Boolean)
        .map((value) => String(value)),
    ),
  ];
}

export function uniqueByEvent(events) {
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

export function compact(value, fallback = "none") {
  if (value == null || value === "") return fallback;
  return String(value);
}

export function productCopy(value, fallback = "none") {
  return compact(value, fallback)
    .replace(/\bAirspace\b/g, "Work scope")
    .replace(/\bairspace\b/g, "work scope")
    .replace(/\bTower\b/g, "Coordinator")
    .replace(/\btower\b/g, "coordinator")
    .replace(/\bFlights\b/g, "Workstreams")
    .replace(/\bflights\b/g, "workstreams")
    .replace(/\bFlight\b/g, "Workstream")
    .replace(/\bflight\b/g, "workstream")
    .replace(/\bRunways\b/g, "Path locks")
    .replace(/\brunways\b/g, "path locks")
    .replace(/\bRunway\b/g, "Path lock")
    .replace(/\brunway\b/g, "path lock")
    .replace(/\bClearances\b/g, "Approvals")
    .replace(/\bclearances\b/g, "approvals")
    .replace(/\bClearance\b/g, "Approval")
    .replace(/\bclearance\b/g, "approval")
    .replace(/\bReroutes\b/g, "Plan changes")
    .replace(/\breroutes\b/g, "plan changes")
    .replace(/\bReroute\b/g, "Plan change")
    .replace(/\breroute\b/g, "plan change")
    .replace(/\bMayday\b/g, "Paused incident")
    .replace(/\bmayday\b/g, "paused incident")
    .replace(/\bGround stop\b/g, "Stop-work hold")
    .replace(/\bground stop\b/g, "stop-work hold")
    .replace(/\bLanding\b/g, "Commit")
    .replace(/\blanding\b/g, "commit")
    .replace(/\bLandings\b/g, "Commits")
    .replace(/\blandings\b/g, "commits")
    .replace(/\bRadar\b/g, "Signals")
    .replace(/\bradar\b/g, "signals")
    .replace(/\bPilot\b/g, "Agent")
    .replace(/\bpilot\b/g, "agent");
}

export function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0%";
  return `${Math.round(numeric * 100)}%`;
}

export function formatDurationMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "0s";
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  const seconds = numeric / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function formatMetricValue(metric) {
  if (!metric || metric.value == null) return "n/a";
  if (metric.unit === "ratio") return formatPercent(metric.value);
  if (metric.unit === "duration_ms") return formatDurationMs(metric.value);
  return String(metric.value);
}

export function clampRatio(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

export function formatCompactNumber(value, fallback = "0") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (Math.abs(numeric) >= 1000) return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(numeric);
  return String(Math.round(numeric * 10) / 10);
}

export function metricTone(metric) {
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

export function metricProgress(metric) {
  if (!metric || metric.value == null) return 0;
  const value = Number(metric.value);
  if (!Number.isFinite(value)) return 0;
  if (metric.unit === "ratio") return clampRatio(value);
  if (metric.unit === "duration_ms") return clampRatio(value / 300000);
  return clampRatio(Math.log10(Math.max(1, value) + 1) / 2);
}

export function metricTargetLabel(metric = {}) {
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
    return "target 100% approved";
  if (metric.key === "shadowMergeSimulatorAccuracy") return "target 100%";
  if (
    /blocked|violation|abort|goAround|rollback|drift|red/i.test(
      metric.key || "",
    )
  )
    return "target 0";
  return metric.unit === "ratio" ? "tracked as ratio" : "tracked by evidence";
}

export function metricAttentionScore(metric = {}) {
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

export function metricSectionEntries(sections = {}) {
  return Object.entries(sections)
    .map(([title, rows]) => ({
      title,
      rows: asArray(rows),
    }))
    .filter((section) => section.rows.length);
}

export function universeHealthScore(universe = {}) {
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

export function eventDisplayType(event = {}) {
  return compact(event.eventType || event.type, "event").replaceAll("_", ".");
}

export function eventPathLabel(event = {}) {
  return compact(
    event.path ||
      event.details?.path ||
      event.details?.route ||
      event.details?.transactionId ||
      event.displayCallsign,
    "",
  );
}

export function countBy(values) {
  return asArray(values).reduce((counts, value) => {
    const key = compact(value, "unknown");
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export function transactionIdentity(transaction = {}) {
  return transaction.id || transaction.transactionId || transaction.txnId || null;
}

export function mergeTransactionSources(activeTransactions, mutationTransactions) {
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

export function transactionProofBundle(transaction, proofBundles) {
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

export function transactionEvents(transaction, events) {
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

export function transactionReason(transaction = {}, events = []) {
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

export function transactionTowerAction(transaction = {}, events = []) {
  const status = String(transaction.status || "").toLowerCase();
  const reason = transactionReason(transaction, events);
  if (status === "aborted" || /invalid|stale|changed|mismatch/i.test(reason)) {
    return "rebase and revalidate assumptions";
  }
  if (["blocked", "quarantined"].includes(status)) {
    return "pause writes and review quarantine";
  }
  if (["open", "validated"].includes(status)) {
    return "observe read set until commit";
  }
  if (status === "committed") return "evidence bundle closed";
  return "hold for coordinator review";
}

export function transactionDigestLabel(value) {
  const text = compact(value, "missing");
  if (text.length <= 32) return text;
  return `${text.slice(0, 18)}...${text.slice(-10)}`;
}

export function invalidatedAssumptionRows({
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

export function parseLineRange(lineAnchor) {
  const match = String(lineAnchor || "").match(/#?L(\d+)(?:-L?(\d+))?/i);
  if (!match) return { startLine: null, endLine: null };
  const startLine = Math.max(1, Number(match[1]));
  const endLine = Math.max(startLine, Number(match[2] || match[1]));
  return { startLine, endLine };
}

export function lineRange(row = {}) {
  const parsed = parseLineRange(row.lineAnchor);
  const startLine = Number.isFinite(Number(row.startLine))
    ? Number(row.startLine)
    : parsed.startLine;
  const endLine = Number.isFinite(Number(row.endLine))
    ? Number(row.endLine)
    : parsed.endLine || startLine;
  return { startLine, endLine };
}

export function lineRangeLabel(row = {}) {
  const range = lineRange(row);
  if (!range.startLine) return compact(row.lineAnchor, "line");
  return range.endLine && range.endLine !== range.startLine
    ? `L${range.startLine}-L${range.endLine}`
    : `L${range.startLine}`;
}

export function lineProvenanceKey(row) {
  if (!row) return "line:none";
  return (
    row.id ||
    `${row.filePath || "file"}:${row.lineAnchor || lineRangeLabel(row)}:${row.transactionId || ""}`
  );
}

export function pathCoversFile(pattern, filePath) {
  if (!pattern || !filePath) return false;
  if (pattern === filePath) return true;
  if (pattern.endsWith("/**")) return filePath.startsWith(pattern.slice(0, -3));
  if (pattern.includes("*")) return filePath.startsWith(pattern.split("*")[0]);
  return false;
}

export function inspectionRunRefs(run) {
  return uniqueValues([
    ...asArray(run?.evidenceRefs),
    ...asArray(run?.inspectionSignals).flatMap((signal) =>
      asArray(signal?.evidenceRefs || signal?.evidence_refs),
    ),
    run?.id ? `codesite:inspection:${run.id}` : null,
  ]);
}

export function latestCounterfactualSimulation(runs) {
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

export function towerInstructionText(event = {}) {
  const details = event.details || {};
  const eventType = String(event.eventType || "");
  return productCopy(
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
    "coordination event",
  );
}

export const TOWER_EVENT_LABELS = {
  flight_plan_filed: "Work plan filed",
  clearance_issued: "Write approval issued",
  write_attempted: "Write attempted",
  write_allowed: "Write approved",
  write_denied: "Write blocked by CodeSiteFS",
  write_quarantined: "Write quarantined for review",
  transaction_opened: "Transaction opened",
  transaction_validated: "Transaction validated",
  transaction_committed: "Transaction committed",
  transaction_aborted: "Transaction aborted",
  proof_bundle_verified: "Evidence bundle verified",
  black_box_closed: "Event recorder closed",
  tower_instruction: "Coordination instruction",
  route_deviation: "Plan change filed",
  ground_stop: "Recovery hold issued",
  mayday_resumed: "Recovery resumed",
  quarantine_reviewed: "Quarantine reviewed",
  quarantine_replayed: "Quarantine replayed",
  quarantine_applied: "Quarantine applied",
};

export function towerEventKind(event = {}) {
  return TOWER_EVENT_LABELS[event.eventType] || eventDisplayType(event);
}

export function formatTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toneColor(status, riskLevel = null) {
  const risk = String(riskLevel || "").toLowerCase();
  if (["critical", "high"].includes(risk)) return "var(--codesite-danger)";
  if (["medium", "warning"].includes(risk)) return "var(--codesite-warning)";
  const normalized = String(status || "").toLowerCase();
  if (
    ["holding", "blocked", "denied", "mayday", "failed", "critical"].includes(
      normalized,
    )
  )
    return "var(--codesite-danger)";
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
  )
    return "var(--codesite-warning)";
  if (["idle", "unknown", "missing"].includes(normalized))
    return "var(--codesite-muted-accent)";
  return "var(--codesite-success)";
}

export function statusTone(status) {
  const normalized = String(status || "").toLowerCase();
  if (
    ["active", "cleared", "airborne", "validated", "passed", "ok"].includes(
      normalized,
    )
  ) {
    return {
      background:
        "color-mix(in srgb, var(--codesite-success) 16%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (
    ["holding", "blocked", "denied", "mayday", "failed", "critical"].includes(
      normalized,
    )
  ) {
    return {
      background: "color-mix(in srgb, var(--codesite-danger) 18%, transparent)",
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
      background:
        "color-mix(in srgb, var(--codesite-warning) 18%, transparent)",
      color: "var(--text-primary)",
    };
  }
  return { background: "var(--bg-elevated)", color: "var(--text-secondary)" };
}

export function riskTone(level) {
  const normalized = String(level || "").toLowerCase();
  if (["critical", "high"].includes(normalized)) {
    return {
      background: "color-mix(in srgb, var(--codesite-danger) 20%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (["medium", "warning"].includes(normalized)) {
    return {
      background:
        "color-mix(in srgb, var(--codesite-warning) 20%, transparent)",
      color: "var(--text-primary)",
    };
  }
  if (["low", "clear", "none"].includes(normalized)) {
    return {
      background:
        "color-mix(in srgb, var(--codesite-success) 16%, transparent)",
      color: "var(--text-primary)",
    };
  }
  return { background: "var(--bg-elevated)", color: "var(--text-secondary)" };
}

export function indicatorTone(value) {
  const normalized = String(value || "").toLowerCase();
  if (
    ["critical", "high", "medium", "warning", "low", "clear", "none"].includes(
      normalized,
    )
  )
    return riskTone(value);
  return statusTone(value);
}

export function toneLabel(value) {
  return productCopy(compact(value, "idle").replaceAll("_", " "))
    .replace(/\bairborne\b/g, "active")
    .replace(/\bpreflight\b/g, "precheck")
    .replace(/\bcleared\b/g, "approved")
    .replace(/\bholding\b/g, "review hold");
}
