import { EmptyLine, PathList, Pill, SignalBar } from "../../ui";
import { replayCompletenessTone } from "./handovers";
import { asArray, compact, formatPercent, productCopy } from "../../lib/format";

export default function CausalReplayDeck({ handovers }) {
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
            <div className="grid min-w-0 gap-3 @min-[52rem]/panel:grid-cols-[minmax(0,0.95fr)_minmax(260px,0.55fr)]">
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
                <div className="mt-2 grid gap-2 @min-[28rem]/panel:grid-cols-3">
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
                <div className="mt-3 grid min-w-0 gap-3 @min-[44rem]/panel:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
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
