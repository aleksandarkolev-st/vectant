import { EmptyLine, Pill, TagList } from "../../ui";
import { asArray, compact, uniqueValues } from "../../lib/format";
import ProofValueList from "./ProofValueList";

export default function FilesystemBoundaryProofPanel({ records }) {
  const rows = asArray(records);
  if (!rows.length)
    return <EmptyLine>No filesystem boundary evidence recorded</EmptyLine>;

  return (
    <div
      data-testid="codesite-filesystem-boundary-proof"
      className="min-w-0 overflow-hidden rounded border"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {rows.map((record, index) => {
        const processChain = asArray(record.process?.ancestry);
        const evidenceRefs = uniqueValues([
          ...asArray(record.evidenceRefs),
          ...asArray(record.evidence?.refs),
        ]);
        const inspectedLeaseIds = uniqueValues(
          asArray(record.inspectedLeases).map((lease) => lease.mutationLeaseId),
        );
        const leaseLabel =
          record.mutationLeaseId ||
          record.requestedMutationLeaseId ||
          record.lease?.id ||
          inspectedLeaseIds[0] ||
          record.leaseState ||
          "no_active_clearance";
        const leaseTone = record.mutationLeaseId ? "active" : "holding";
        return (
          <div
            key={record.proofId || `${record.eventId || "event"}-${index}`}
            data-testid="codesite-filesystem-boundary-proof-row"
            className="grid gap-3 border-t px-3 py-2 text-xs first:border-t-0 lg:grid-cols-[minmax(126px,0.78fr)_minmax(0,1.18fr)_minmax(0,1.05fr)_minmax(0,1fr)]"
            style={{
              borderColor: "var(--border-subtle)",
              background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
            }}
          >
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Pill
                  tone={record.proofComplete ? record.disposition : "holding"}
                >
                  {record.proofComplete ? "complete" : "incomplete"}
                </Pill>
                <Pill tone={record.disposition}>
                  {compact(record.disposition, "write_denied")}
                </Pill>
              </div>
              <div
                className="mt-1 truncate font-medium"
                title={
                  record.displayCallsign ||
                  record.boundary?.source ||
                  "CodeSiteFS"
                }
              >
                {compact(
                  record.displayCallsign || record.boundary?.source,
                  "CodeSiteFS",
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Pill>
                  {compact(
                    record.boundary?.tool || record.boundary?.operation,
                    "write",
                  )}
                </Pill>
                {record.quarantine?.quarantineId ? (
                  <Pill tone="holding">quarantine</Pill>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Path and lease
              </div>
              <ProofValueList
                values={[record.path].filter(Boolean)}
                empty="missing path"
                maxVisible={1}
              />
              <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                <Pill tone={leaseTone}>
                  {compact(record.leaseState, "no_active_clearance")}
                </Pill>
                <code
                  className="max-w-full truncate rounded border px-1.5 py-0.5 text-[10px]"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-surface)",
                    color: "var(--text-secondary)",
                  }}
                  title={leaseLabel}
                >
                  {leaseLabel}
                </code>
                {inspectedLeaseIds.length ? (
                  <Pill tone="idle">{inspectedLeaseIds.length} inspected</Pill>
                ) : null}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Reason and process
              </div>
              <TagList
                items={record.reasonCodes || []}
                empty="missing reason"
                maxVisible={3}
              />
              <div
                className="mt-1 truncate font-mono text-[10px]"
                style={{
                  color: processChain.length
                    ? "var(--text-secondary)"
                    : "var(--text-muted)",
                }}
                title={record.process?.display || processChain.join(" <- ")}
              >
                {processChain.length
                  ? processChain.join(" <- ")
                  : "missing process ancestry"}
              </div>
            </div>

            <div className="min-w-0">
              <div
                className="text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Evidence
              </div>
              <ProofValueList
                values={evidenceRefs}
                empty="missing evidence"
                maxVisible={3}
              />
              <div className="mt-1 flex flex-wrap gap-1">
                {asArray(record.missingProofFields).map((field) => (
                  <Pill key={field} tone="holding">
                    missing {field}
                  </Pill>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
