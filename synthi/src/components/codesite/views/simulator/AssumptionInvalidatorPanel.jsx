import { PathList, Pill } from "../../ui";
import { compact, invalidatedAssumptionRows } from "../../lib/format";

export default function AssumptionInvalidatorPanel({
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
      <div className="grid gap-2 @min-[52rem]/panel:grid-cols-2">
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
            <div className="mt-2 grid gap-2 @min-[28rem]/panel:grid-cols-2">
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
