"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArchiveRestore,
  Bot,
  CheckCircle2,
  CircleGauge,
  Cable,
  ClipboardCheck,
  DatabaseZap,
  FileCheck2,
  FileJson,
  FileStack,
  FolderGit2,
  GitBranch,
  History,
  ListChecks,
  LockKeyhole,
  MapPinned,
  PackageCheck,
  Plus,
  RefreshCw,
  SearchCheck,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Siren,
  SquareActivity,
  Waypoints,
  Workflow,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as fmt from "./lib/format";
import * as gov from "./lib/governance";
import * as qtn from "./lib/quarantine";
import * as graph from "./lib/graph";

// Scaffolding: the helpers above moved to lib/ but their ~1,500 call sites in
// this file are unchanged, so the move stays a reviewable diff. These bindings
// come out as each consumer moves to its own view file.
const {
  asArray, uniqueValues, uniqueByEvent, compact, productCopy, formatPercent,
  formatMetricValue, clampRatio, formatCompactNumber, metricTone,
  metricProgress, metricTargetLabel, metricAttentionScore,
  metricSectionEntries, universeHealthScore, eventDisplayType, eventPathLabel,
  countBy, mergeTransactionSources, transactionProofBundle, transactionEvents,
  transactionReason, transactionTowerAction, transactionDigestLabel,
  invalidatedAssumptionRows, lineRange, lineRangeLabel, lineProvenanceKey,
  pathCoversFile, inspectionRunRefs, latestCounterfactualSimulation,
  towerInstructionText, towerEventKind, formatTime, statusTone, riskTone,
  indicatorTone, toneLabel,
} = fmt;
const {
  documentLabel, documentNeedsReview, routeRevisionCanReview,
  routeRevisionCanApply, firstRoutePattern, incidentNeedsResume,
  maydayResumeInspectionRefs, actionSeverity, actionOwner, actionEntity,
  actionEntityId, actionKind, actionHasGovernanceReviewTarget,
  actionEvidenceRefs, actionLabel, actionReviewSummary,
} = gov;
const {
  hasEntries, quarantinePath, quarantineDigest, quarantineEvidenceRef,
  selectedPathKey, quarantineRemainingPaths, quarantineDisplayStatus,
  quarantineRecordsFromEvents, mergeQuarantineRecords,
  quarantineReviewMessage,
} = qtn;
const {
  zoneClass, displayZoneName, zonePaths, zoneHasFlight, riskTouchesFlight,
  riskTouchesZone, statusColor, replayTailFromNewestFirst, zoneTierLabel,
  graphNodeStyle,
} = graph;

const POLL_MS = 5000;
const MOTION_EASE = [0.16, 1, 0.3, 1];
const STATUS_PULSE_EASE = [0.45, 0, 0.55, 1];

const CodeSiteIcons = Object.freeze({
  control: ServerCog,
  liveState: SquareActivity,
  workspaceGraph: Waypoints,
  paths: FolderGit2,
  agents: Bot,
  actions: ListChecks,
  approvals: ShieldCheck,
  governance: ClipboardCheck,
  planChanges: GitBranch,
  pathLocks: LockKeyhole,
  conflicts: ShieldAlert,
  evidence: FileCheck2,
  transactions: DatabaseZap,
  metrics: CircleGauge,
  activity: History,
  recovery: Siren,
  simulator: Workflow,
  quarantine: ArchiveRestore,
  inspections: ClipboardCheck,
  incidents: ShieldAlert,
  replay: History,
  artifacts: PackageCheck,
  files: FileStack,
  lineage: SearchCheck,
  scopes: MapPinned,
  signals: Cable,
  json: FileJson,
});



function findGovernanceEntityRow(attributeName, entityId) {
  if (!entityId || typeof document === "undefined") return null;
  return Array.from(document.querySelectorAll(`[${attributeName}]`)).find(
    (element) => element.getAttribute(attributeName) === entityId,
  );
}




function Pill({ children, tone = "idle", className = "", testId }) {
  const toneStyle = typeof tone === "string" ? statusTone(tone) : tone;
  return (
    <span
      data-testid={testId}
      className={`inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold leading-4 ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 74%, var(--text-primary) 12%)",
        ...toneStyle,
      }}
    >
      {typeof tone === "string" ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: statusColor(tone) }}
        />
      ) : null}
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
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold outline-none transition-[background,border-color,box-shadow,opacity] duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: active
          ? "color-mix(in srgb, var(--accent-primary) 62%, var(--border-subtle))"
          : "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
        background: active
          ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
          : "var(--bg-elevated)",
        color: "var(--text-primary)",
        boxShadow: active
          ? "inset 0 1px 0 color-mix(in srgb, var(--accent-primary) 28%, transparent)"
          : "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 7%, transparent)",
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
      <div
        className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-3"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 82%, var(--bg-editor) 18%), color-mix(in srgb, var(--bg-surface) 96%, transparent))",
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]"
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

function Metric({ label, value, tone = null, testId, icon: Icon }) {
  return (
    <div
      data-testid={testId}
      className="min-h-[76px] rounded-md border px-3 py-3 transition-[border-color,background,box-shadow] duration-200"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 92%, var(--accent-primary) 8%)",
        background:
          "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 88%, var(--bg-editor) 12%))",
        boxShadow:
          "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent)",
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div
          className="truncate text-[11px] font-medium leading-tight"
          style={{ color: "var(--text-muted)" }}
          title={label}
        >
          {label}
        </div>
        {Icon ? (
          <Icon
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: "var(--accent-primary)" }}
          />
        ) : null}
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
  icon: Icon = CodeSiteIcons.liveState,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 96%, var(--accent-primary) 3%), color-mix(in srgb, var(--bg-surface) 90%, var(--bg-editor) 10%))",
      }}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-md border"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
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
      label: "Live state",
      shortLabel: "Live",
      value: toneLabel(towerState),
      detail:
        streamStatus === "live"
          ? "Live coordination stream"
          : `Stream ${toneLabel(streamStatus)}`,
      tone: towerState,
      icon: CodeSiteIcons.liveState,
      section: "tower",
    },
    {
      key: "collision",
      label: "Conflicts",
      shortLabel: "Risk",
      value: toneLabel(forecastRisk),
      detail: riskCount
        ? `${riskCount} forecasted risk${riskCount === 1 ? "" : "s"}`
        : "No forecasted conflicts",
      tone: forecastRisk,
      icon: CodeSiteIcons.conflicts,
      section: "radar",
    },
    {
      key: "clearance",
      label: "Approvals",
      shortLabel: "Approval",
      value: requiredCount,
      detail: `${documentsNeedingReview} docs / ${routeReviews} plan changes`,
      tone: requiredCount ? "holding" : "active",
      icon: CodeSiteIcons.actions,
      section: "governance",
    },
    {
      key: "mayday",
      label: "Paused incidents",
      shortLabel: "Resume",
      value: maydayCount,
      detail: maydayCount
        ? "Inspection evidence needed before resume"
        : "No paused incidents",
      tone: maydayCount ? "high" : "active",
      icon: CodeSiteIcons.recovery,
      section: "replay",
    },
    {
      key: "runway",
      label: "Path locks",
      shortLabel: "Locks",
      value: runwayCount,
      detail: transactionCount
        ? `${transactionCount} open transaction${transactionCount === 1 ? "" : "s"}`
        : "No occupied write lock",
      tone: runwayCount || transactionCount ? "holding" : "active",
      icon: CodeSiteIcons.pathLocks,
      section: "radar",
    },
    {
      key: "proof",
      label: "Evidence",
      value: proofCount,
      detail: quarantineCount
        ? `${quarantineCount} quarantine${quarantineCount === 1 ? "" : "s"} need replay`
        : "Evidence handoff ready",
      tone: quarantineCount ? "warning" : proofCount ? "active" : "idle",
      icon: CodeSiteIcons.evidence,
      section: "evidence",
    },
  ];

  return (
    <div
      data-testid="codesite-tower-now"
      className="flex gap-1.5 overflow-x-auto rounded-[var(--radius-panel)] border p-1.5"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 62%, var(--accent-primary) 38%)",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 90%, var(--accent-primary) 7%), color-mix(in srgb, var(--bg-surface) 94%, var(--text-primary) 3%))",
      }}
      aria-label="CodeSite live coordination summary"
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
            className="group min-w-[9.25rem] flex-1 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-left outline-none transition-[background,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
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
                  className="truncate text-[10px] font-semibold uppercase sm:hidden"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.shortLabel || card.label}
                </span>
                <span
                  className="hidden truncate text-[10px] font-semibold uppercase sm:inline"
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
                        ease: STATUS_PULSE_EASE,
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

function CodeSiteOperatingModel({
  activeFlights,
  activeLeases,
  documents,
  routeRevisions,
  proofBundles,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
  const flightCount = asArray(activeFlights).length;
  const leaseCount = asArray(activeLeases).length;
  const documentReviewCount = asArray(documents).filter(documentNeedsReview).length;
  const routeReviewCount = asArray(routeRevisions).filter(routeRevisionCanReview).length;
  const proofCount = asArray(proofBundles).length;
  const rows = [
    {
      key: "scope",
      label: "Workstreams",
      status: flightCount ? "active" : "idle",
      owner: asArray(activeFlights).map((flight) => flight.displayCallsign).filter(Boolean).slice(0, 2).join(", ") || "unassigned",
      evidence: `${leaseCount} locks`,
      detail: `${flightCount} active / owned paths and risk areas`,
      icon: CodeSiteIcons.workspaceGraph,
      section: "radar",
    },
    {
      key: "activity",
      label: "Activity",
      status: flightCount ? "live" : "quiet",
      owner: "tower",
      evidence: "event stream",
      detail: "Agent updates, blockers, and system guardrails",
      icon: CodeSiteIcons.activity,
      section: "tower",
    },
    {
      key: "governance",
      label: "Governance",
      status: documentReviewCount + routeReviewCount ? "review" : "clear",
      owner: `${documentReviewCount} docs`,
      evidence: `${routeReviewCount} route reviews`,
      detail: `${leaseCount} approvals / permit and document review`,
      icon: CodeSiteIcons.governance,
      section: "governance",
    },
    {
      key: "evidence",
      label: "Evidence",
      status: proofCount ? "available" : "pending",
      owner: "recorder",
      evidence: `${proofCount} bundles`,
      detail: `${asArray(documents).length} docs / ${asArray(routeRevisions).length} plan changes`,
      icon: CodeSiteIcons.evidence,
      section: "evidence",
    },
  ];

  return (
    <section
      data-testid="codesite-operating-model"
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: "color-mix(in srgb, var(--border-subtle) 84%, transparent)",
        background: "color-mix(in srgb, var(--bg-surface) 92%, transparent)",
      }}
    >
      <div className="grid gap-2 border-b px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" style={{ borderColor: "color-mix(in srgb, var(--border-subtle) 72%, transparent)" }}>
        <div className="min-w-0">
          <div className="text-xs font-semibold">Operating queue</div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
            Saved views for active work, approvals, and replay evidence
          </div>
        </div>
        <div className="flex min-w-0 gap-1 overflow-x-auto" aria-label="CodeSite saved views">
          {["Active", "Review", "Evidence"].map((view) => (
            <button
              key={view}
              type="button"
              className="h-7 shrink-0 rounded-md border px-2 text-[11px]"
              style={{
                borderColor: "var(--border-subtle)",
                background: view === "Active" ? "color-mix(in srgb, var(--primary) 9%, transparent)" : "transparent",
                color: view === "Active" ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {view}
            </button>
          ))}
        </div>
      </div>
      <div className="hidden grid-cols-[1.1fr_0.7fr_0.8fr_1fr_auto] gap-2 border-b px-3 py-2 text-[10px] uppercase tracking-normal md:grid" style={{ borderColor: "color-mix(in srgb, var(--border-subtle) 72%, transparent)", color: "var(--text-muted)" }}>
        <span>Queue</span>
        <span>Status</span>
        <span>Owner</span>
        <span>Evidence</span>
        <span>Open</span>
      </div>
      <div className="divide-y divide-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)]">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <motion.button
              key={row.key}
              type="button"
              onClick={() => onSelect?.(row.section)}
              whileHover={reduceMotion ? undefined : { x: 2 }}
              whileTap={reduceMotion ? undefined : { scale: 0.995 }}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: MOTION_EASE }}
              className="grid min-h-14 w-full gap-2 px-3 py-2 text-left outline-none transition-[background] hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--primary)] md:grid-cols-[1.1fr_0.7fr_0.8fr_1fr_auto] md:items-center"
            >
              <span className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)" }}>
                  <Icon className="h-3.5 w-3.5" style={{ color: "var(--primary)" }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{row.label}</span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{row.detail}</span>
                </span>
              </span>
              <span><Pill tone={row.status}>{row.status}</Pill></span>
              <span className="truncate font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>{row.owner}</span>
              <span className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{row.evidence}</span>
              <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{row.section}</span>
            </motion.button>
          );
        })}
      </div>
    </section>
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
      target: "coordinator prevented overlap",
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
  if (!rows.length) return <EmptyLine>No active path locks</EmptyLine>;
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
                  title={runway.runway || "unassigned path lock"}
                >
                  {compact(runway.runway, "unassigned path lock")}
                </span>
                <Pill tone={runway.runwayClass === "A" ? "holding" : "active"}>
                  {zoneTierLabel({ zoneClass: runway.runwayClass })}
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
                Changed paths
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
                Can write now
              </div>
              <PathList
                paths={eligibleFlights}
                empty="path locked"
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
              <Pill>{towerUniverses.length} options</Pill>
            ) : null}
          </div>
          <div className="mt-2 text-sm font-semibold">
            Counterfactual route board
          </div>
          <div
            className="mt-1 max-w-[70ch] text-xs leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Compares policy-safe routes before commit, using stale
            assumptions, inspection cost, unresolved risks, and proof refs.
          </div>
        </div>
        <IconButton
          title="Run coordination simulation"
          onClick={onRun}
          disabled={disabled}
          testId="codesite-run-tower-simulator"
        >
          <CodeSiteIcons.simulator className="h-3.5 w-3.5" />
          Simulate
        </IconButton>
      </div>
      {simulationRun.error ? (
        <div
          className="rounded border px-2 py-1 text-[11px]"
          style={{
            borderColor:
              "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
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
                          Coordinator actions
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
          "color-mix(in srgb, var(--accent-warning) 34%, var(--border-subtle))",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--accent-warning) 8%, var(--bg-surface)), var(--bg-editor))",
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
                  invalidated by {compact(row.invalidatedBy, "coordinator")}
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
            reads, observed reads, writes, result, reason, and coordinator action.
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
                  ? "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))"
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
                  Coordinator action:{" "}
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
                    empty="evidence pending"
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
                    evidence bundle
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
                        "color-mix(in srgb, var(--accent-success) 70%, var(--text-primary))",
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
  if (!rows.length) return <EmptyLine>No agent readiness records</EmptyLine>;
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
                Authorized scope
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
              <div className="flex flex-wrap gap-2">
                {[
                  [
                    "Commits",
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
                    "Signals",
                    asArray(record.requiredRadar).length,
                    asArray(record.requiredRadar).length ? "active" : "idle",
                  ],
                ].map(([label, value, tone]) => (
                  <div
                    key={label}
                    className="min-w-[5.75rem] flex-1 border-l pl-2"
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
    return <EmptyLine>No filesystem boundary evidence recorded</EmptyLine>;

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
          borderColor: "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
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
                      ? "color-mix(in srgb, var(--accent-success) 72%, var(--border-subtle))"
                      : "var(--border-subtle)",
                    background: value
                      ? "color-mix(in srgb, var(--accent-success) 34%, transparent)"
                      : "var(--bg-editor)",
                    boxShadow:
                      value && index === selectedTraceSteps.length - 1
                        ? "0 0 0 4px color-mix(in srgb, var(--accent-success) 12%, transparent)"
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
                      Approval{" "}
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
                  <CodeSiteIcons.replay className="h-3.5 w-3.5" />
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
                    "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
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
                  <button
                    key={`${selected.quarantineId}-${path}-${quarantineEvidenceRef(change)}`}
                    data-testid="codesite-quarantine-change-row"
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onTogglePath(path)}
                    className="grid min-h-12 cursor-pointer grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-[var(--radius-control)] border px-2 py-1.5 text-left outline-none transition-[background,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                    style={{
                      borderColor: checked
                        ? "color-mix(in srgb, var(--accent-primary) 44%, var(--border-subtle))"
                        : "var(--border-subtle)",
                      background: checked
                        ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-editor))"
                        : "var(--bg-editor)",
                    }}
                  >
                    <span
                      data-testid="codesite-quarantine-path-toggle"
                      className="mt-1 grid h-4 w-4 place-items-center rounded border"
                      style={{
                        borderColor: checked
                          ? "color-mix(in srgb, var(--accent-primary) 66%, var(--border-subtle))"
                          : "var(--border-medium)",
                        background: checked
                          ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
                          : "color-mix(in srgb, var(--bg-panel) 70%, transparent)",
                      }}
                    >
                      {checked ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="h-3 w-3"
                          style={{ color: "var(--accent-primary)" }}
                        />
                      ) : null}
                    </span>
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
                  </button>
                );
              })}
            </div>

            {asArray(selected.symlinkSanitization?.sanitized).length ? (
              <div
                data-testid="codesite-quarantine-symlink-guard"
                className="rounded border px-3 py-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--accent-warning) 36%, var(--border-subtle))",
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
                            "color-mix(in srgb, var(--accent-danger) 36%, var(--border-subtle))",
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
                    "color-mix(in srgb, var(--accent-success) 36%, var(--border-subtle))",
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

function DesktopSectionRail({ sections, activeSection, onSelect, status, streamStatus }) {
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    sections.findIndex((section) => section.key === activeSection),
  );
  return (
    <div
      data-testid="codesite-desktop-section-rail"
      className="sticky top-0 z-20 hidden border-b px-4 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.14)] md:block"
      style={{
        borderColor: "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
        background: "color-mix(in srgb, var(--bg-sidebar) 96%, var(--accent-primary) 4%)",
      }}
    >
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-center">
        <div
          className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border p-1"
          role="tablist"
          aria-label="CodeSite sections"
          style={{
            borderColor: "var(--border-subtle)",
            background: "color-mix(in srgb, var(--bg-editor) 76%, transparent)",
          }}
        >
          {sections.map((section) => {
            const Icon = section.icon || CodeSiteIcons.liveState;
            const active = activeSection === section.key;
            return (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`codesite-section-${section.key}`}
                data-testid="codesite-desktop-section-tab"
                onClick={() => onSelect(section.key)}
                className="relative inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold transition-[background,border-color,transform] hover:-translate-y-px"
                style={{
                  borderColor: active
                    ? "color-mix(in srgb, var(--accent-primary) 54%, var(--border-subtle))"
                    : "var(--border-subtle)",
                  background: active
                    ? "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated))"
                    : "var(--bg-elevated)",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {active && !reduceMotion ? (
                  <motion.span
                    layoutId="codesite-desktop-active-section"
                    className="absolute inset-0 rounded-md"
                    style={{
                      border: "1px solid color-mix(in srgb, var(--accent-primary) 48%, transparent)",
                    }}
                    transition={{ duration: 0.2, ease: MOTION_EASE }}
                  />
                ) : null}
                <Icon className="relative h-3.5 w-3.5 shrink-0" />
                <span className="relative">{section.label}</span>
              </button>
            );
          })}
        </div>
        <div
          className="grid gap-1 rounded-lg border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--border-subtle)",
            background: "color-mix(in srgb, var(--bg-elevated) 78%, transparent)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: "var(--text-muted)" }}>Focused section</span>
            <Pill tone={status}>{toneLabel(status)}</Pill>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-semibold">
              {sections.find((section) => section.key === activeSection)?.label || "Graph"}
            </span>
            <span className="font-mono" style={{ color: "var(--text-muted)" }}>
              {streamStatus}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full" style={{ background: "var(--bg-editor)" }}>
            <motion.div
              className="h-full rounded-full"
              style={{
                background: "var(--accent-primary)",
                transformOrigin: "left center",
              }}
              initial={false}
              animate={{ scaleX: (activeIndex + 1) / Math.max(1, sections.length) }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: MOTION_EASE }}
            />
          </div>
        </div>
      </div>
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
        {sections.map((section) => {
          const Icon = section.icon || CodeSiteIcons.liveState;
          return (
            <motion.button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={activeSection === section.key}
              aria-controls={`codesite-section-${section.key}`}
              data-testid="codesite-mobile-section-tab"
              onClick={() => onSelect(section.key)}
              whileTap={reduceMotion ? undefined : { scale: 0.985 }}
              className="relative inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold transition-[background,border-color,color] active:scale-[0.98]"
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
                    border:
                      "1px solid color-mix(in srgb, var(--accent-primary) 54%, transparent)",
                  }}
                  transition={{ duration: 0.2, ease: MOTION_EASE }}
                />
              ) : null}
              <Icon
                className="relative h-3.5 w-3.5 shrink-0"
                style={{ color: "var(--accent-primary)" }}
              />
              <span className="relative">{section.label}</span>
              <span
                className="relative h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    activeSection === section.key
                      ? "var(--accent-primary)"
                      : "var(--border-subtle)",
                }}
              />
            </motion.button>
          );
        })}
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
              "Scope"}
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
      data-testid="codesite-activity-feed"
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
          <div className="flex min-w-0 items-start gap-2">
            <span
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 76%, var(--accent-primary) 24%)",
                background:
                  "color-mix(in srgb, var(--accent-primary) 9%, transparent)",
              }}
            >
              <CodeSiteIcons.activity
                className="h-3.5 w-3.5"
                style={{ color: "var(--accent-primary)" }}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Activity log</div>
              <div
                className="mt-0.5 text-[10px] uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Agent updates, blockers, and guardrails
              </div>
            </div>
            <div
              data-testid="codesite-event-stream-status"
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {streamStatus === "live"
                ? "Live updates connected"
                : streamStatus === "reconnecting"
                  ? "Reconnecting updates"
                  : "Checking for updates"}
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
            icon={CodeSiteIcons.activity}
          />
          <Metric
            label="Coordination"
            value={
              rows.filter((event) =>
                String(event.eventType || "").includes("tower"),
              ).length
            }
            icon={CodeSiteIcons.governance}
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
            icon={CodeSiteIcons.conflicts}
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
          <span>Update</span>
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
                  {compact(event.displayCallsign || event.actorType, "system")}
                </Pill>
              </motion.div>
            ))
          ) : (
            <div className="p-3">
              <EmptyLine>No activity events received</EmptyLine>
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
          <div className="text-xs font-semibold">Review before governed action</div>
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
          title="Cancel governed action"
          disabled={disabled}
          onClick={onCancel}
          testId="codesite-governance-review-cancel"
        >
          Cancel
        </IconButton>
        <IconButton
          title="Confirm governed action"
          variant="primary"
          disabled={disabled || !canConfirm}
          onClick={() => onConfirm(rationale)}
          testId="codesite-governance-review-confirm"
        >
          <CodeSiteIcons.approvals className="h-3.5 w-3.5" />
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
              `Protected change approval for ${compact(primaryPlan.displayCallsign, "workstream")}`,
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
            <div className="text-sm font-semibold">Protected change approval</div>
            <div
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Issue review evidence for protected and shared paths before approval.
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
              placeholder={`Permit for ${compact(primaryPlan.displayCallsign, "workstream")}`}
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
            Allowed paths
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
            <CodeSiteIcons.approvals className="h-3.5 w-3.5" />
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
                          owner: document.fromSessionId || document.fromSession || "coordinator",
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
                      <CodeSiteIcons.governance className="h-3.5 w-3.5" />
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
                          owner: document.fromSessionId || document.fromSession || "coordinator",
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
                      <CodeSiteIcons.conflicts className="h-3.5 w-3.5" />
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
              <div className="text-xs font-semibold">Plan changes</div>
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
                  title: `Propose plan change for ${compact(primaryPlan.displayCallsign, "workstream")}`,
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
                title="Propose plan change"
                type="submit"
                disabled={disabled || !primaryPlan.id}
                testId="codesite-route-propose-button"
              >
                <CodeSiteIcons.planChanges className="h-3.5 w-3.5" />
                Propose change
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
                        title="Approve plan change"
                        disabled={disabled || !routeRevisionCanReview(revision)}
                        onClick={() =>
                          queueGovernanceAction({
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
                        <CodeSiteIcons.governance className="h-3.5 w-3.5" />
                        Approve
                      </IconButton>
                      <IconButton
                        title="Apply plan change"
                        disabled={disabled || !routeRevisionCanApply(revision)}
                        onClick={() =>
                          queueGovernanceAction({
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
                    Show all plan changes ({routeRevisions.length})
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
              ? "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))"
              : "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background: maydayIncidents.length
              ? "linear-gradient(180deg, color-mix(in srgb, var(--accent-danger) 10%, var(--bg-surface)), var(--bg-surface))"
              : "var(--bg-surface)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">
                Paused incident recovery
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
                        {productCopy(incident.category, "emergency")}
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
                            : "var(--accent-danger)",
                        }}
                      >
                        {inspectionRunIds.length
                          ? `inspection: ${inspectionRunIds.join(", ")}`
                          : "inspection evidence required"}
                      </div>
                    </div>
                    <IconButton
                      title="Resume paused incident"
                      disabled={disabled || inspectionRunIds.length === 0}
                      onClick={() =>
                        queueGovernanceAction({
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
                      <CodeSiteIcons.recovery className="h-3.5 w-3.5" />
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
                    Show all paused incidents ({maydayIncidents.length})
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {maydayIncidents.slice(3).map((incident) => (
                      <div
                        key={`hidden-mayday-${incident.id}`}
                        className="flex min-w-0 items-start justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {productCopy(incident.category, "emergency")} /{" "}
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
                ? "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))"
                : "color-mix(in srgb, var(--accent-success) 40%, var(--border-subtle))",
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


function WorkGraphConnector({ tone = "active", active = false, delay = 0 }) {
  const reduceMotion = useReducedMotion();
  const color = statusColor(tone);
  return (
    <div
      className="hidden min-w-0 items-center justify-center md:flex"
      aria-hidden="true"
    >
      <div className="relative h-6 w-full min-w-[28px]">
        <motion.span
          className="absolute left-0 right-0 top-1/2 h-px origin-left rounded-full"
          style={{
            background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
          }}
          initial={reduceMotion ? false : { scaleX: 0.15, opacity: 0.35 }}
          animate={{ scaleX: 1, opacity: active ? 0.92 : 0.55 }}
          transition={{
            duration: reduceMotion ? 0 : 0.28,
            delay: reduceMotion ? 0 : delay,
            ease: MOTION_EASE,
          }}
        />
        <motion.span
          className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
          }}
          animate={
            !reduceMotion && active
              ? { opacity: [0.62, 1, 0.62], scale: [0.94, 1.16, 0.94] }
              : { opacity: 0.7, scale: 1 }
          }
          transition={{
            duration: 1.8,
            repeat: !reduceMotion && active ? Infinity : 0,
            ease: STATUS_PULSE_EASE,
          }}
        />
      </div>
    </div>
  );
}

function WorkGraphNode({
  eyebrow,
  title,
  tone = "idle",
  icon: Icon,
  children,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      className="min-w-0 rounded-md border px-3 py-2 text-xs"
      style={graphNodeStyle(tone, "raised")}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div
            className="text-[10px] font-semibold uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            {eyebrow}
          </div>
          <div
            className="mt-1 min-w-0 break-words font-semibold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </div>
        </div>
        {Icon ? (
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 76%, var(--accent-primary) 24%)",
              background:
                "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
        ) : null}
      </div>
      <div className="mt-2 min-w-0">{children}</div>
    </div>
  );
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
  if (!rows.length) return <EmptyLine>No replay package closed yet</EmptyLine>;
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
        <span className="font-semibold">Incident replay packages</span>
        <div className="flex flex-wrap gap-1">
          <Pill>{rows.length} packages</Pill>
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
                    {compact(
                      handover.transactionId,
                      productCopy(handover.incident.category, "incident"),
                    )}
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
                    ["Replay artifact", handover.incident.replayDigest],
                    ["Proof bundle", handover.proofBundle?.id],
                    ["Event evidence digest", handover.codeSiteBlackBox],
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
                      Event timeline
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
                  Exported files
                </div>
                <PathList
                  paths={handover.exportPaths}
                  empty="no exported files"
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
          <div className="font-semibold">Event recorder stream</div>
          <div
            className="mt-1 max-w-[65ch] leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Ordered event evidence with actor, logical time, path, and payload
            preview for event replay.
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
    return <EmptyLine>No lineage evidence indexed</EmptyLine>;
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
          label: "Approval",
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
      data-testid="codesite-lineage-deck"
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
        <span className="font-semibold">Lineage evidence ledger</span>
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
                data-testid="codesite-lineage-row"
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
                        "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
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

function ScopeTopology({
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
  const visibleLanes = lanes.slice(0, condensed ? 4 : 5);
  const laneOverflow = Math.max(0, lanes.length - visibleLanes.length);
  const visibleFlights = flights.slice(0, condensed ? 5 : 7);
  const visibleRisks = risks.slice(0, condensed ? 4 : 6);
  const workstreamOverflow = Math.max(
    0,
    flights.length - visibleFlights.length,
  );
  const riskOverflow = Math.max(0, risks.length - visibleRisks.length);
  const replayEvents = replayTailFromNewestFirst(events);
  const landingRuns = asArray(inspections).slice(-4).reverse();
  const failedCommitChecks = landingRuns.some((run) =>
    String(run.status || "").includes("failed"),
  );
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
  const hasBlockedScopes = asArray(noFlyZones).length > 0;
  const guardrailNodes = [
    {
      key: "conflicts",
      label: "Conflicts",
      value: visibleRisks.length ? `${visibleRisks.length} active` : "clear",
      detail: riskOverflow ? `+${riskOverflow} more risks` : "risk forecast",
      tone: visibleRisks.length ? "holding" : "active",
      y: 22,
    },
    {
      key: "checks",
      label: "Commit checks",
      value: landingRuns.length ? `${landingRuns.length} runs` : "none",
      detail: failedCommitChecks
        ? "failed check present"
        : "latest validations",
      tone: failedCommitChecks
        ? "failed"
        : landingRuns.length
          ? "active"
          : "idle",
      y: 50,
    },
    {
      key: "evidence",
      label: "Evidence",
      value: replayEvents.length ? `${replayEvents.length} events` : "none",
      detail: hasBlockedScopes ? "blocked scopes tracked" : "activity history",
      tone: hasBlockedScopes
        ? "warning"
        : replayEvents.length
          ? "active"
          : "idle",
      y: 78,
    },
  ];
  const guardrailNodeForZone = (zone) => {
    if (!zone) return guardrailNodes[2];
    if (risks.some((risk) => riskTouchesZone(risk, zone))) {
      return guardrailNodes[0];
    }
    if (landingRuns.length) return guardrailNodes[1];
    return guardrailNodes[2];
  };
  const graphRows = visibleLanes.map((zone, index) => {
    const relatedFlights = visibleFlights.filter((flight) =>
      zoneHasFlight(zone, flight),
    );
    const hasRisk = risks.some((risk) => riskTouchesZone(risk, zone));
    const guardrail = guardrailNodeForZone(zone);
    return {
      id: zone.zoneKey || zone.id || `scope-${index}`,
      zone,
      relatedFlights,
      relatedRoutes: uniqueValues(
        relatedFlights.flatMap((flight) => asArray(flight.route)),
      ),
      visibleRelatedFlights: relatedFlights.slice(0, 3),
      hiddenRelatedFlightCount: Math.max(0, relatedFlights.length - 3),
      hasRisk,
      guardrail,
      tone: hasRisk ? "holding" : zone.risk || guardrail.tone || "active",
    };
  });

  return (
    <div className="space-y-2">
      <div
        data-testid="codesite-scope-topology"
        className={
          condensed
            ? "overflow-hidden rounded-lg border p-2"
            : "overflow-hidden rounded-lg border p-3"
        }
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
          background:
            "linear-gradient(145deg, color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 7%), color-mix(in srgb, var(--bg-editor) 96%, var(--codesite-accent-secondary) 4%))",
        }}
      >
        <div
          data-testid="codesite-work-graph"
          className={
            condensed
              ? "grid gap-2 2xl:grid-cols-[minmax(0,1.28fr)_minmax(270px,0.72fr)]"
              : "grid gap-3 2xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]"
          }
        >
          <div
            data-testid="codesite-scope-matrix"
            className="overflow-hidden rounded-lg border"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--bg-editor) 88%, var(--accent-primary) 7%), color-mix(in srgb, var(--bg-editor) 94%, var(--bg-surface) 6%))",
            }}
          >
            <div
              className="grid gap-2 border-b px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              style={{
                borderColor: "var(--border-subtle)",
                color: "var(--text-muted)",
              }}
            >
              <div className="min-w-0">
                <div
                  className="text-sm font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  Workspace Graph
                </div>
                <div className="mt-0.5 text-[10px] font-semibold uppercase">
                  Paths -&gt; Agents -&gt; Checks
                </div>
              </div>
              <div className="flex flex-wrap gap-1 sm:justify-end">
                <Pill tone={visibleRisks.length ? "holding" : "active"}>
                  {visibleRisks.length || "no"} conflicts
                </Pill>
                <Pill
                  tone={
                    failedCommitChecks
                      ? "failed"
                      : landingRuns.length
                        ? "active"
                        : "idle"
                  }
                >
                  {landingRuns.length} checks
                </Pill>
              </div>
            </div>
            <div
              className="grid gap-2 p-3"
              style={{
                background:
                  "linear-gradient(90deg, color-mix(in srgb, var(--border-subtle) 18%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border-subtle) 12%, transparent) 1px, transparent 1px)",
                backgroundSize: "34px 34px",
              }}
            >
              <div
                className="hidden grid-cols-[minmax(0,0.95fr)_40px_minmax(0,1.08fr)_40px_minmax(0,0.88fr)] gap-2 px-1 text-[10px] font-semibold uppercase md:grid"
                style={{ color: "var(--text-muted)" }}
                aria-hidden="true"
              >
                <span>Paths</span>
                <span />
                <span>Agents</span>
                <span />
                <span>Checks</span>
              </div>
              {graphRows.map((row, index) => {
                const {
                  zone,
                  relatedFlights,
                  visibleRelatedFlights,
                  hiddenRelatedFlightCount,
                  relatedRoutes,
                  hasRisk,
                  guardrail,
                  tone,
                } = row;
                const connectorTone = hasRisk ? "holding" : guardrail.tone;
                return (
                  <motion.div
                    key={row.id}
                    data-testid="codesite-scope-matrix-row"
                    className="grid gap-2 rounded-md border p-2 text-xs md:grid-cols-[minmax(0,0.95fr)_40px_minmax(0,1.08fr)_40px_minmax(0,0.88fr)] md:items-stretch"
                    style={{
                      ...graphNodeStyle(tone),
                      outline: hasRisk
                        ? "1px solid color-mix(in srgb, var(--codesite-danger) 28%, transparent)"
                        : "1px solid transparent",
                    }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.24,
                      delay: reduceMotion ? 0 : index * 0.04,
                      ease: MOTION_EASE,
                    }}
                  >
                    <WorkGraphNode
                      eyebrow="Path group"
                      title={displayZoneName(zone, index)}
                      tone={tone}
                      icon={CodeSiteIcons.paths}
                      testId="codesite-scope-path-node"
                    >
                      <div className="flex min-w-0 flex-wrap gap-1">
                        <Pill
                          tone={zone.risk || (hasRisk ? "holding" : "active")}
                        >
                          {zoneTierLabel(zone)}
                        </Pill>
                        {hasRisk ? <Pill tone="holding">conflict</Pill> : null}
                      </div>
                      <div className="mt-2">
                        <PathList
                          paths={zonePaths(zone)}
                          empty="path pending"
                        />
                      </div>
                    </WorkGraphNode>

                    <WorkGraphConnector
                      tone={connectorTone}
                      active={hasRisk || relatedFlights.length > 0}
                      delay={index * 0.04}
                    />

                    <WorkGraphNode
                      eyebrow="Assigned agents"
                      title={
                        relatedFlights.length
                          ? `${relatedFlights.length} active`
                          : "Unassigned"
                      }
                      tone={
                        hasRisk
                          ? "holding"
                          : relatedFlights[0]?.status || "idle"
                      }
                      icon={CodeSiteIcons.agents}
                      testId="codesite-scope-agent-node"
                    >
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {visibleRelatedFlights.length ? (
                          visibleRelatedFlights.map((flight, flightIndex) => (
                            <Pill
                              key={
                                flight.id ||
                                flight.displayCallsign ||
                                `scope-agent-${flightIndex}`
                              }
                              tone={hasRisk ? "holding" : flight.status}
                              className="max-w-[9rem]"
                            >
                              {compact(flight.displayCallsign, "agent")}
                            </Pill>
                          ))
                        ) : (
                          <Pill tone="idle">ready for owner</Pill>
                        )}
                        {hiddenRelatedFlightCount > 0 ? (
                          <Pill tone={hasRisk ? "blocked" : "default"}>
                            +{hiddenRelatedFlightCount}
                          </Pill>
                        ) : null}
                      </div>
                      <div className="mt-2">
                        <PathList
                          paths={relatedRoutes}
                          empty="no write route yet"
                          maxVisible={2}
                        />
                      </div>
                    </WorkGraphNode>

                    <WorkGraphConnector
                      tone={connectorTone}
                      active={hasRisk || guardrail.tone === "active"}
                      delay={index * 0.04 + 0.06}
                    />

                    <WorkGraphNode
                      eyebrow="Guardrail checks"
                      title={guardrail.label}
                      tone={connectorTone}
                      icon={CodeSiteIcons.approvals}
                      testId="codesite-scope-guardrail-node"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: statusColor(connectorTone) }}
                        />
                        <span className="font-mono text-[11px] leading-4">
                          {guardrail.value}
                        </span>
                      </div>
                      <div
                        className="mt-1 text-[10px] leading-4"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {guardrail.detail}
                      </div>
                    </WorkGraphNode>
                  </motion.div>
                );
              })}
            </div>
            <div
              className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[10px]"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
                background:
                  "color-mix(in srgb, var(--bg-surface) 76%, transparent)",
                color: "var(--text-muted)",
              }}
            >
              <span>
                {visibleFlights.length} workstreams
                {workstreamOverflow ? " (+" + workstreamOverflow + ")" : ""}
              </span>
              <span>
                {visibleLanes.length} path scopes
                {laneOverflow ? " (+" + laneOverflow + ")" : ""}
              </span>
              <span>
                {visibleRisks.length || "no"} active conflicts
                {riskOverflow ? " (+" + riskOverflow + ")" : ""}
              </span>
            </div>
          </div>

          <div className="grid content-start gap-2">
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--bg-editor) 90%, var(--codesite-accent-secondary) 7%), color-mix(in srgb, var(--bg-surface) 92%, var(--bg-editor) 8%))",
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Priority work</span>
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
                          {hasRisk ? "risk" : toneLabel(flight.status)}
                        </Pill>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: "var(--text-muted)" }}>
                  No priority work
                </div>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--bg-editor) 88%, var(--accent-primary) 6%), color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%))",
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Commit checks</span>
                <Pill
                  tone={
                    failedCommitChecks
                      ? "failed"
                      : landingRuns.length
                        ? "active"
                        : "idle"
                  }
                >
                  {landingRuns.length}
                </Pill>
              </div>
              {landingRuns.length ? (
                landingRuns.map((run, runIndex) => (
                  <div
                    key={run.id || `commit-run-${runIndex}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 py-0.5"
                  >
                    <span className="min-w-0 break-words">
                      {compact(run.displayCallsign, "inspection")}
                    </span>
                    <span
                      className="break-words text-[10px] leading-4"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {toneLabel(run.status)}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ color: "var(--text-muted)" }}>
                  No commit checks
                </div>
              )}
            </div>
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--bg-editor) 90%, var(--codesite-muted-accent) 7%), color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%))",
              }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">Recent evidence</span>
                <Pill tone={replayEvents.length ? "active" : "idle"}>
                  {replayEvents.length}
                </Pill>
              </div>
              {replayEvents.length ? (
                <div className="space-y-1">
                  {replayEvents.slice(0, 4).map((event, eventIndex) => (
                    <div
                      key={event.id || `workspace-event-${eventIndex}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
                    >
                      <span className="min-w-0 truncate">
                        {towerEventKind(event)}
                      </span>
                      <span
                        className="font-mono text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {formatTime(event.createdAt) || event.logicalTime || ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "var(--text-muted)" }}>
                  No evidence events
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
          <div style={{ color: "var(--text-muted)" }}>Blocked scopes</div>
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
          <div style={{ color: "var(--text-muted)" }}>Evidence types</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {["approval", "transaction", "inspection", "evidence"].map(
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
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          return;
        }
        const stickyHeight = [
          '[data-testid="codesite-mobile-section-tabs"]',
          '[data-testid="codesite-desktop-section-rail"]',
        ].reduce((height, selector) => {
          const rail = scrollContainer.querySelector(selector);
          return height + (rail?.getBoundingClientRect().height || 0);
        }, 0);
        if (typeof scrollContainer.scrollTo !== "function") {
          target?.scrollIntoView?.({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        scrollContainer.scrollTo({
          top: Math.max(
            0,
            scrollContainer.scrollTop +
              targetRect.top -
              containerRect.top -
              stickyHeight -
              12,
          ),
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }
    },
    [reduceMotion],
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
          // Both route buttons always render; only their disabled state differs,
          // so `apply || review` always resolved to apply and left review
          // unreachable. Offer both and let the disabled filter below choose —
          // apply first, preserving the original preference.
          const applyButton = row?.querySelector(
            '[data-testid="codesite-route-apply-button"]',
          );
          const reviewButton = row?.querySelector(
            '[data-testid="codesite-route-review-button"]',
          );
          if (applyButton) candidates.push(applyButton);
          if (reviewButton) candidates.push(reviewButton);
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
            `Plan change ${decision} from CodeSite governance console.`,
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
        "Operator reviewed incident replay, stop-work document, suspended approvals, and passing inspection evidence.";
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
      { key: "radar", label: "Graph", icon: CodeSiteIcons.workspaceGraph },
      { key: "tower", label: "Activity", icon: CodeSiteIcons.activity },
      { key: "governance", label: "Governance", icon: CodeSiteIcons.governance },
      { key: "evidence", label: "Evidence", icon: CodeSiteIcons.evidence },
      { key: "simulator", label: "Simulator", icon: CodeSiteIcons.simulator },
      { key: "quarantine", label: "Quarantine", icon: CodeSiteIcons.quarantine },
      { key: "replay", label: "Replay", icon: CodeSiteIcons.replay },
      { key: "lineage", label: "Lineage", icon: CodeSiteIcons.lineage },
      { key: "runway", label: "Locks", icon: CodeSiteIcons.pathLocks },
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
        color: "var(--text-primary)",
      }}
    >
      <div
        className="shrink-0 border-b px-3 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.16)]"
        style={{
          borderColor: "var(--codesite-panel-line)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-sidebar) 94%, var(--bg-elevated) 6%), color-mix(in srgb, var(--bg-sidebar) 98%, var(--bg-editor) 2%))",
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
              <CodeSiteIcons.control
                className="h-4 w-4"
                style={{ color: "var(--accent-primary)" }}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                CodeSite Operations
              </div>
              <div
                className="truncate text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Agent work, path locks, governance, and release evidence
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className="hidden max-w-[18rem] truncate text-[11px] sm:block"
              style={{ color: "var(--text-muted)" }}
              title={workspaceSlug}
            >
              {compact(workspaceSlug, "No workspace")}
            </span>
            <Pill tone={latestStatus}>{toneLabel(latestStatus)}</Pill>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasProjects ? (
            <div className="min-w-0 basis-full sm:min-w-[220px] sm:basis-0 sm:flex-1">
              <label htmlFor="codesite-project-select" className="sr-only">
                CodeSite project
              </label>
              <Select
                value={radarState.selectedProjectId ? String(radarState.selectedProjectId) : undefined}
                onValueChange={(value) => setSelectedProjectId(value || null)}
              >
                <SelectTrigger
                  id="codesite-project-select"
                  data-testid="codesite-project-select"
                  className="h-11 w-full min-w-0 truncate text-xs"
                  aria-label="CodeSite project"
                >
                  <SelectValue placeholder="Select operation" />
                </SelectTrigger>
                <SelectContent align="start" className="min-w-[220px]">
                  {radarState.projects.map((project, index) => {
                    const value = String(project.id || project.slug || `project-${index}`);
                    return (
                      <SelectItem
                        key={value}
                        value={value}
                      >
                        {project.title}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
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
            <CodeSiteIcons.artifacts className="h-3.5 w-3.5" />
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
          aria-label="CodeSite coordination sections"
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
          <DesktopSectionRail
            sections={mobileSections}
            activeSection={activeSection}
            onSelect={handleSelectSection}
            status={latestStatus}
            streamStatus={streamStatus}
          />
          {error ? (
            <div
              data-testid="codesite-error-state"
              className="m-3 grid gap-3 rounded-lg border px-3 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--accent-danger) 38%, var(--border-subtle))",
                color: "var(--text-primary)",
                background:
                  "color-mix(in srgb, var(--bg-surface) 90%, var(--accent-danger) 4%)",
              }}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 font-semibold">
                  <CodeSiteIcons.conflicts className="h-3.5 w-3.5 shrink-0" />
                  <span>CodeSite sync interrupted</span>
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
                title="Retry CodeSite sync"
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
                        <CodeSiteIcons.control
                          className="h-3.5 w-3.5"
                          style={{ color: "var(--accent-primary)" }}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          No coordination project yet
                        </div>
                        <div
                          className="mt-1 text-xs leading-5"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Create a governed workspace for agent workstreams, path locks, approvals, and evidence.
                        </div>
                      </div>
                    </div>
                  </div>
                  <Pill tone="idle">needs setup</Pill>
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
                      placeholder="Coordination project"
                      className="h-8 w-full min-w-0 rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-editor)",
                        color: "var(--text-primary)",
                      }}
                    />
                  </div>
                  <IconButton
                    title="Create project"
                    variant="primary"
                    disabled={acting || !workspaceSlug}
                    type="submit"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create
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
                      <Pill tone={latestStatus}>{toneLabel(latestStatus)}</Pill>
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
                      label="Workstreams"
                      value={radarState.counts.activeFlights}
                      tone={activeFlights.length ? "active" : "idle"}
                      icon={CodeSiteIcons.agents}
                      testId="codesite-status-flights"
                    />
                    <StatusRailItem
                      label="Actions"
                      value={radarState.counts.requiredActions}
                      tone={radarState.counts.requiredActions ? "high" : "low"}
                      icon={CodeSiteIcons.actions}
                      testId="codesite-status-required"
                    />
                    <StatusRailItem
                      label="Approvals"
                      value={permits.length}
                      tone={permits.length ? "active" : "holding"}
                      icon={CodeSiteIcons.approvals}
                      testId="codesite-status-permits"
                    />
                    <StatusRailItem
                      label="Plan changes"
                      value={routeRevisions.length}
                      tone={
                        routeRevisions.filter(routeRevisionCanReview).length
                          ? "warning"
                          : "active"
                      }
                      icon={CodeSiteIcons.planChanges}
                      testId="codesite-status-plan-changes"
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

                <CodeSiteOperatingModel
                  activeFlights={activeFlights}
                  activeLeases={activeLeases}
                  documents={documents}
                  routeRevisions={routeRevisions}
                  proofBundles={proofBundles}
                  onSelect={handleSelectSection}
                />

                <div
                  data-testid="codesite-responsive-proof-target"
                  className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)] xl:items-start"
                >
                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Workspace Graph"
                      icon={CodeSiteIcons.workspaceGraph}
                      sectionKey="radar"
                      testId="codesite-operator-airspace-pane"
                      right={
                        <Pill>{zones.length || activeFlights.length}</Pill>
                      }
                    >
                      <ScopeTopology
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
                        label="Workstreams"
                        value={radarState.counts.activeFlights}
                        testId="codesite-metric-flights"
                        icon={CodeSiteIcons.agents}
                      />
                      <Metric
                        label="Path locks"
                        value={radarState.counts.activeMutationLeases}
                        icon={CodeSiteIcons.pathLocks}
                      />
                      <Metric
                        label="Transactions"
                        value={radarState.counts.activeTransactions}
                        icon={CodeSiteIcons.transactions}
                      />
                      <Metric
                        label="Actions"
                        value={radarState.counts.requiredActions}
                        tone={
                          radarState.counts.requiredActions ? "high" : "low"
                        }
                        icon={CodeSiteIcons.actions}
                      />
                      <Metric
                        label="Conflict"
                        value={compact(collisionForecast.riskLevel, "unknown")}
                        tone={collisionForecast.riskLevel}
                        icon={CodeSiteIcons.conflicts}
                      />
                      <Metric
                        label="Approvals"
                        value={permits.length}
                        tone={permits.length ? "active" : "idle"}
                        testId="codesite-metric-permits"
                        icon={CodeSiteIcons.approvals}
                      />
                      <Metric
                        label="Documents"
                        value={documents.length}
                        tone={
                          documents.filter(documentNeedsReview).length
                            ? "holding"
                            : "active"
                        }
                        icon={CodeSiteIcons.files}
                      />
                      <Metric
                        label="Plan changes"
                        value={routeRevisions.length}
                        tone={
                          routeRevisions.filter(routeRevisionCanReview).length
                            ? "holding"
                            : "idle"
                        }
                        icon={CodeSiteIcons.planChanges}
                      />
                    </div>
                  </div>

                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Activity Feed"
                      icon={CodeSiteIcons.activity}
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
                      icon={CodeSiteIcons.governance}
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
                icon={CodeSiteIcons.metrics}
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
                title="Path Locks"
                icon={CodeSiteIcons.pathLocks}
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
                title="Agent Readiness"
                icon={CodeSiteIcons.agents}
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
                title="Filesystem Boundary Evidence"
                icon={CodeSiteIcons.files}
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
                icon={CodeSiteIcons.quarantine}
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
                title="Conflict Forecast"
                icon={CodeSiteIcons.conflicts}
                right={
                  <Pill tone={riskTone(collisionForecast.riskLevel)}>
                    {compact(collisionForecast.riskLevel, "unknown")}
                  </Pill>
                }
              >
                {risks.length === 0 ? (
                  <EmptyLine>No forecasted conflicts</EmptyLine>
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
                title="Coordination Simulator"
                icon={CodeSiteIcons.simulator}
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
                title="Workstreams"
                icon={CodeSiteIcons.agents}
                right={<Pill>{activeFlights.length}</Pill>}
              >
                {activeFlights.length === 0 ? (
                  <EmptyLine>No active workstreams</EmptyLine>
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
                            {productCopy(plan.mission, "Code mutation workstream")}
                          </div>
                          <PathList paths={plan.route || []} />
                        </div>
                        <div className="justify-self-end">
                          <Pill tone={plan.status}>{toneLabel(plan.status)}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Approvals"
                icon={CodeSiteIcons.approvals}
                right={<Pill>{activeLeases.length}</Pill>}
              >
                {activeLeases.length === 0 ? (
                  <EmptyLine>No active approvals</EmptyLine>
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
                                ? `agent:${lease.pilotLicenseHealth.status}`
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
                          <Pill tone={lease.status}>{toneLabel(lease.status)}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Transactions & Evidence"
                icon={CodeSiteIcons.transactions}
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
                title="Inspections & Incidents"
                icon={CodeSiteIcons.incidents}
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
                            <Pill tone={run.status}>{toneLabel(run.status)}</Pill>
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
                              "color-mix(in srgb, var(--accent-danger) 36%, var(--border-subtle))",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {productCopy(incident.category, "incident")}
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
                title="Replay Handover"
                icon={CodeSiteIcons.replay}
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
                title="Artifact Export Preview"
                icon={CodeSiteIcons.artifacts}
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
                          <CodeSiteIcons.lineage className="h-3.5 w-3.5" />
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
                title="Audit Event Log"
                icon={CodeSiteIcons.activity}
                right={<Pill>{events.length}</Pill>}
              >
                <BlackBoxFlightRecorder events={events} />
              </Section>

              <Section
                title="Required Actions"
                icon={CodeSiteIcons.actions}
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
                icon={CodeSiteIcons.files}
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
                                {toneLabel(item.status)}
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
                icon={CodeSiteIcons.inspections}
                right={<Pill>{inspectionRuns.length}</Pill>}
              >
                <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
                  <Metric label="Runs" value={inspectionRuns.length} />
                  <Metric
                    label="Incidents"
                    value={incidents.length}
                    tone={incidents.length ? "high" : "low"}
                    icon={CodeSiteIcons.incidents}
                  />
                  <Metric
                    label="Events"
                    value={radarState.counts.events}
                    icon={CodeSiteIcons.activity}
                  />
                  <Metric
                    label="Evidence"
                    value={radarState.counts.proofBundles}
                    icon={CodeSiteIcons.evidence}
                  />
                </div>
              </Section>

              <Section
                title="Lineage Inspector"
                icon={CodeSiteIcons.lineage}
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
                title="Work Scope Zones"
                icon={CodeSiteIcons.scopes}
                right={<Pill>{zones.length}</Pill>}
              >
                {zones.length === 0 ? (
                  <EmptyLine>No classified scopes</EmptyLine>
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
                            {displayZoneName(zone, index)}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {zoneTierLabel(zone)}
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

              <Section title="Policy Inputs" icon={CodeSiteIcons.signals}>
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
