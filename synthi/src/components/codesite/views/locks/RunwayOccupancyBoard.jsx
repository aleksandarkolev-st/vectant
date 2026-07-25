import { EmptyLine, PathList, Pill } from "../../ui";
import { asArray, compact } from "../../lib/format";
import { zoneClass, zoneTierLabel } from "../../lib/graph";

export default function RunwayOccupancyBoard({ runways }) {
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
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 @min-[44rem]/panel:grid-cols-[minmax(136px,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]"
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
