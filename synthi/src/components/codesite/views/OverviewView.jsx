import { motion, useReducedMotion } from "framer-motion";
import { CodeSiteIcons } from "../icons";
import { MOTION_EASE } from "../lib/motion";
import { toneLabel } from "../lib/format";
import { routeRevisionCanReview } from "../lib/governance";
import { Pill, StatusRailItem } from "../ui";
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
  runwayOccupancy,
  proofBundles,
  quarantineRecords,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
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
