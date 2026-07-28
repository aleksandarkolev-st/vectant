import { MOTION_EASE } from "../../lib/motion";
import { motion, useReducedMotion } from "framer-motion";
import { asArray, compact, formatTime, toneLabel, towerEventKind, uniqueValues } from "../../lib/format";
import { displayZoneName, graphNodeStyle, replayTailFromNewestFirst, riskTouchesFlight, riskTouchesZone, statusColor, zoneHasFlight, zonePaths, zoneTierLabel } from "../../lib/graph";
import { CodeSiteIcons } from "../../icons";
import { PathList, Pill } from "../../ui";
import WorkGraphConnector from "./WorkGraphConnector";
import WorkGraphNode from "./WorkGraphNode";

export default function ScopeTopology({
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
