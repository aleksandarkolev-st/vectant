import { CodeSiteIcons } from "../icons";
import { asArray, compact, formatTime, toneLabel } from "../lib/format";
import { EmptyLine, PathList, Pill, Row, Section, TagList } from "../ui";
import RunwayOccupancyBoard from "./locks/RunwayOccupancyBoard";
import PilotLicenseHealthPanel from "./locks/PilotLicenseHealthPanel";

export default function LocksView({
  runwayOccupancy,
  pilotLicenseHealth,
  activeLeases,
  allowedPaths,
  blockedPaths,
}) {
  return (
    <>
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
              <PathList paths={allowedPaths || []} />
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
              <PathList paths={blockedPaths || []} />
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
