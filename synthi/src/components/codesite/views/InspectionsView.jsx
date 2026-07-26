import { CodeSiteIcons } from "../icons";
import { asArray, compact, productCopy, toneLabel } from "../lib/format";
import { EmptyLine, Metric, PathList, Pill, Section } from "../ui";

export default function InspectionsView({ inspectionRuns, incidents, counts }) {
  return (
    <>
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
                  <div className="mt-1 grid gap-1 @min-[28rem]/panel:grid-cols-2">
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
        title="Inspections Queue"
        icon={CodeSiteIcons.inspections}
        count={inspectionRuns.length}
        hideWhenEmpty
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
            value={counts.events}
            icon={CodeSiteIcons.activity}
          />
          <Metric
            label="Evidence"
            value={counts.proofBundles}
            icon={CodeSiteIcons.evidence}
          />
        </div>
      </Section>
    </>
  );
}
