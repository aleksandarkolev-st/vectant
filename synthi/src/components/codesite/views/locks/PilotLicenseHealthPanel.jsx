import { EmptyLine, PathList, Pill, TagList } from "../../ui";
import { asArray, compact, riskTone } from "../../lib/format";

export default function PilotLicenseHealthPanel({ records }) {
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
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 @min-[44rem]/panel:grid-cols-[minmax(124px,0.8fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(96px,0.75fr)]"
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
