import { CodeSiteIcons } from "../icons";
import { compact, productCopy, riskTone, toneLabel } from "../lib/format";
import { displayZoneName, zonePaths, zoneTierLabel } from "../lib/graph";
import { EmptyLine, OperatorPane, PathList, Pill, Row, Section, TagList } from "../ui";
import ScopeTopology from "./graph/ScopeTopology";

export default function GraphView({
  counts,
  collisionForecast,
  risks,
  zones,
  noFlyZones,
  activeFlights,
  agentRegistry = [],
  events,
  inspectionRuns,
  permits,
  documents,
  routeRevisions,
}) {
  const onlineAgentCount = agentRegistry.filter((session) => session.presence === "online").length;

  return (
    <>
      <div className="grid min-w-0 content-start gap-3 p-3 @min-[28rem]/panel:p-4">
        <OperatorPane
          title="Workspace Graph"
          icon={CodeSiteIcons.workspaceGraph}
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

      </div>

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
        title="Agent Sessions"
        icon={CodeSiteIcons.agents}
        count={agentRegistry.length}
        right={<Pill tone={onlineAgentCount ? "active" : "idle"}>{onlineAgentCount} online / {agentRegistry.length}</Pill>}
      >
        {agentRegistry.length === 0 ? (
          <EmptyLine>No attached agent sessions</EmptyLine>
        ) : (
          <div>
            {agentRegistry.map((session, index) => {
              const sessionId = session.id || `session-${index}`;
              const executionBinding = session.terminalSessionId
                ? `terminal ${session.terminalSessionId}`
                : session.runtimeSessionId
                  ? `runtime ${session.runtimeSessionId}`
                  : "no active process";
              return (
                <Row key={sessionId} testId={`codesite-agent-session-${sessionId}`}>
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {compact(session.displayCallsign, "agent")}
                    </div>
                    <div className="truncate text-[10px]" style={{ color: "var(--text-muted)" }}>
                      owner {compact(session.ownerUserId, "unknown")}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate">
                      {compact(session.provider, "custom agent")} · {executionBinding}
                    </div>
                    <TagList items={session.subscriptions} empty="no subscriptions" maxVisible={3} />
                  </div>
                  <div className="justify-self-start @min-[26rem]/panel:justify-self-end">
                    <Pill
                      tone={session.presence === "online" ? "active" : "idle"}
                      testId={`codesite-agent-presence-${sessionId}`}
                    >
                      {session.presence === "online" ? "online" : "offline"}
                    </Pill>
                  </div>
                </Row>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Workstreams"
        icon={CodeSiteIcons.agents}
        count={activeFlights.length}
        hideWhenEmpty
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
        title="Work Scope Zones"
        icon={CodeSiteIcons.scopes}
        count={zones.length}
        hideWhenEmpty
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
    </>
  );
}
