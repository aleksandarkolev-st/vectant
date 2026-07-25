import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CodeSiteIcons } from "../icons";
import { MOTION_EASE } from "../lib/motion";
import { compact, productCopy, toneLabel } from "../lib/format";
import {
  actionEntityId,
  actionLabel,
  actionSeverity,
  documentNeedsReview,
  routeRevisionCanReview,
} from "../lib/governance";
import {
  EmptyLine,
  IconButton,
  Metric,
  Pill,
  Row,
  Section,
  StatusRailItem,
} from "../ui";
import TowerNowStrip from "./overview/TowerNowStrip";
import CodeSiteOperatingModel from "./overview/CodeSiteOperatingModel";

export default function OverviewView({
  project,
  counts,
  status,
  streamStatus,
  collisionForecast,
  risks,
  activeFlights,
  activeLeases,
  activeTransactions,
  permits,
  documents,
  routeRevisions,
  openMaydays,
  requiredActions,
  actionableQuarantineRecords,
  runwayOccupancy,
  proofBundles,
  quarantineRecords,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
  const attentionItems = useMemo(
    () => [
      ...requiredActions.map((action, index) => ({
        id: `action-${actionEntityId(action) || index}`,
        label: actionLabel(action),
        severity: actionSeverity(action),
        viewKey: "governance",
        viewLabel: "Governance",
      })),
      ...openMaydays.map((incident) => ({
        id: `mayday-${incident.id}`,
        label: `Resume ${productCopy(incident.category, "paused incident")}`,
        severity: "critical",
        viewKey: "governance",
        viewLabel: "Governance",
      })),
      ...actionableQuarantineRecords.map((record) => ({
        id: `quarantine-${record.quarantineId}`,
        label: `Quarantined change: ${record.quarantineId}`,
        severity: "high",
        viewKey: "quarantine",
        viewLabel: "Quarantine",
      })),
    ],
    [requiredActions, openMaydays, actionableQuarantineRecords],
  );
  return (
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
            <Pill tone={status}>{toneLabel(status)}</Pill>
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
            {project.title}
          </h2>
          <p
            className="mt-1.5 max-w-[72ch] text-sm leading-6"
            style={{ color: "var(--text-muted)" }}
          >
            {project.request}
          </p>
        </div>
        <div
          data-testid="codesite-status-rail"
          className="grid grid-cols-2 gap-2 xl:grid-cols-4"
        >
          <StatusRailItem
            label="Workstreams"
            value={counts.activeFlights}
            tone={activeFlights.length ? "active" : "idle"}
            icon={CodeSiteIcons.agents}
            testId="codesite-status-flights"
          />
          <StatusRailItem
            label="Actions"
            value={counts.requiredActions}
            tone={counts.requiredActions ? "high" : "low"}
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

      <div
        data-testid="codesite-metric-rail"
        className="grid grid-cols-[repeat(auto-fit,minmax(126px,1fr))] gap-2"
      >
        <Metric
          label="Workstreams"
          value={counts.activeFlights}
          testId="codesite-metric-flights"
          icon={CodeSiteIcons.agents}
        />
        <Metric
          label="Path locks"
          value={counts.activeMutationLeases}
          icon={CodeSiteIcons.pathLocks}
        />
        <Metric
          label="Transactions"
          value={counts.activeTransactions}
          icon={CodeSiteIcons.transactions}
        />
        <Metric
          label="Actions"
          value={counts.requiredActions}
          tone={
            counts.requiredActions ? "high" : "low"
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

      <Section
        title="Needs Attention"
        icon={CodeSiteIcons.actions}
        right={
          <Pill tone={attentionItems.length ? "holding" : "active"}>
            {attentionItems.length}
          </Pill>
        }
      >
        <div className="grid gap-1" data-testid="codesite-overview-attention">
          {attentionItems.length === 0 ? (
            <EmptyLine>Nothing is waiting on you.</EmptyLine>
          ) : (
            attentionItems.slice(0, 5).map((item) => (
              <Row key={item.id}>
                <Pill tone={item.severity}>{item.severity}</Pill>
                <span className="min-w-0 break-words font-medium">
                  {item.label}
                </span>
                <IconButton
                  title={`Open ${item.label} in ${item.viewLabel}`}
                  onClick={() => onSelect(item.viewKey)}
                  testId="codesite-overview-attention-drill"
                >
                  Open
                </IconButton>
              </Row>
            ))
          )}
        </div>
      </Section>

      <TowerNowStrip
        towerState={status}
        streamStatus={streamStatus}
        collisionForecast={collisionForecast}
        risks={risks}
        requiredActionCount={counts.requiredActions}
        documents={documents}
        routeRevisions={routeRevisions}
        openMaydays={openMaydays}
        runwayOccupancy={runwayOccupancy}
        activeTransactions={activeTransactions}
        proofBundles={proofBundles}
        quarantineRecords={quarantineRecords}
        onSelect={onSelect}
      />

      <CodeSiteOperatingModel
        activeFlights={activeFlights}
        activeLeases={activeLeases}
        documents={documents}
        routeRevisions={routeRevisions}
        proofBundles={proofBundles}
        onSelect={onSelect}
      />
    </motion.div>
  );
}
