import { EmptyLine, Metric, PathList, Pill } from "../../ui";
import { asArray, compact, indicatorTone, lineProvenanceKey, lineRangeLabel, uniqueValues } from "../../lib/format";

export default function LineProvenanceDeck({
  rows,
  selectedLineRow,
  selectedLineTransaction,
  selectedLineLease,
  selectedLineProof,
  selectedLineEvidenceRefs,
  selectedLineInspectionRefs,
  selectedLineDojoRefs,
  lineInspector,
  onInspectLine,
}) {
  const provenanceRows = asArray(rows);
  if (!provenanceRows.length) {
    return <EmptyLine>No lineage evidence indexed</EmptyLine>;
  }
  const visibleRows = provenanceRows.slice(-10).reverse();
  const hiddenRows = provenanceRows.length - visibleRows.length;
  const fileCount = new Set(provenanceRows.map((row) => row.filePath).filter(Boolean)).size;
  const transactionCount = new Set(
    provenanceRows.map((row) => row.transactionId).filter(Boolean),
  ).size;
  const evidenceCount = uniqueValues(
    provenanceRows.flatMap((row) => asArray(row.evidenceRefs)),
  ).length;
  const sourceContext =
    selectedLineRow?.diffHunk ||
    selectedLineRow?.diffSnippet ||
    selectedLineRow?.sourceSnippet ||
    selectedLineRow?.promptSummary;
  const causalSteps = selectedLineRow
    ? [
        {
          label: "Approval",
          value: `${compact(
            selectedLineLease?.displayCallsign || selectedLineRow.displayCallsign,
            "agent",
          )} / ${compact(
            selectedLineLease?.id || selectedLineTransaction?.mutationLeaseId,
            "lease",
          )}`,
          tone: selectedLineLease ? "active" : "pending",
        },
        {
          label: "Transaction",
          value: compact(selectedLineRow.transactionId, "transaction"),
          tone: selectedLineTransaction?.status || "active",
        },
        {
          label: "Proof",
          value: compact(
            selectedLineProof?.bundleDigest || selectedLineRow.proofBundleId,
            "none",
          ),
          tone: selectedLineProof ? "active" : "pending",
        },
        {
          label: "Evidence",
          value: `${selectedLineEvidenceRefs.length} refs`,
          tone: selectedLineEvidenceRefs.length ? "active" : "pending",
        },
        {
          label: "Inspection",
          value: `${selectedLineInspectionRefs.length} refs`,
          tone: selectedLineInspectionRefs.length ? "active" : "holding",
        },
      ]
    : [];

  return (
    <div
      data-testid="codesite-lineage-deck"
      className="grid min-w-0 gap-3"
    >
      <div
        className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 80%, var(--accent-primary) 20%)",
          background: "var(--bg-surface)",
        }}
      >
        <span className="font-semibold">Lineage evidence ledger</span>
        <div className="flex flex-wrap gap-1">
          <Pill>{provenanceRows.length} rows</Pill>
          {hiddenRows > 0 ? (
            <Pill tone="holding">+{hiddenRows} archived</Pill>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-2">
        <Metric label="Files" value={fileCount} />
        <Metric label="Transactions" value={transactionCount} />
        <Metric label="Evidence refs" value={evidenceCount} />
        <Metric
          label="Selected"
          value={selectedLineRow ? lineRangeLabel(selectedLineRow) : "none"}
          tone={selectedLineRow ? "active" : "idle"}
        />
      </div>
      <div className="grid min-w-0 gap-3 overflow-hidden xl:grid-cols-[minmax(0,0.95fr)_minmax(300px,0.8fr)]">
        <div className="min-w-0 space-y-1">
          {visibleRows.map((row, index) => {
            const selected =
              lineProvenanceKey(row) === lineProvenanceKey(selectedLineRow);
            return (
              <button
                key={
                  lineProvenanceKey(row) ||
                  `${row.filePath || "line"}-${index}`
                }
                type="button"
                data-testid="codesite-lineage-row"
                aria-pressed={selected}
                onClick={() => onInspectLine(row)}
                className="block w-full min-w-0 overflow-hidden rounded-md border px-2.5 py-2 text-left text-xs transition-colors"
                style={{
                  borderColor: selected
                    ? "color-mix(in srgb, var(--accent-primary) 52%, var(--border-subtle))"
                    : "var(--border-subtle)",
                  background: selected
                    ? "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-surface))"
                    : "var(--bg-surface)",
                  color: "var(--text-primary)",
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-1.5">
                  <code
                    className="min-w-0 flex-1 basis-[11rem] break-all text-[10px] leading-4 whitespace-normal"
                    title={row.filePath}
                  >
                    {row.filePath}
                  </code>
                  <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1">
                    <Pill>{lineRangeLabel(row)}</Pill>
                    <Pill className="max-w-[8rem] truncate">
                      {compact(row.displayCallsign, "agent")}
                    </Pill>
                  </div>
                </div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <PathList
                    paths={[row.reasonRef, row.proofBundleId].filter(Boolean)}
                    empty="no reason"
                  />
                  <PathList
                    paths={asArray(row.evidenceRefs)}
                    empty="no evidence refs"
                    maxVisible={5}
                  />
                </div>
              </button>
            );
          })}
        </div>
        <div
          data-testid="codesite-line-inspector"
          className="min-h-[220px] min-w-0 overflow-hidden rounded-lg border p-3 text-xs"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background:
              "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
          }}
        >
          {!selectedLineRow ? (
            <EmptyLine>Select a changed line</EmptyLine>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="break-words font-medium leading-tight">
                    {lineRangeLabel(selectedLineRow)} causal trace
                  </div>
                  <code
                    className="mt-0.5 block break-all text-[10px] leading-4 whitespace-normal"
                    title={selectedLineRow.filePath}
                    style={{ color: "var(--text-muted)" }}
                  >
                    {selectedLineRow.filePath}
                  </code>
                </div>
                <Pill
                  testId="codesite-line-inspector-status"
                  tone={
                    lineInspector.status === "error"
                      ? "failed"
                      : lineInspector.status === "loading"
                        ? "running"
                        : "active"
                  }
                >
                  {lineInspector.status === "loading" &&
                  lineInspector.rows.length === 0
                    ? "loading"
                    : `${lineInspector.rows.length || 1} rows`}
                </Pill>
              </div>
              <div className="grid gap-1.5">
                {causalSteps.map((step) => (
                  <div
                    key={step.label}
                    className="grid min-h-8 grid-cols-[86px_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-1"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <span style={{ color: "var(--text-muted)" }}>
                      {step.label}
                    </span>
                    <code
                      className="min-w-0 break-all whitespace-normal"
                      title={step.value}
                    >
                      {step.value}
                    </code>
                    <span
                      className="h-2 w-2 rounded-full"
                      style={indicatorTone(step.tone)}
                    />
                  </div>
                ))}
              </div>
              <div className="grid gap-2 text-[11px]">
                <div>
                  <div style={{ color: "var(--text-muted)" }}>Reason</div>
                  <code
                    className="break-all whitespace-normal"
                    title={selectedLineRow.reasonRef}
                  >
                    {compact(selectedLineRow.reasonRef, "none")}
                  </code>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Evidence refs
                  </div>
                  <PathList
                    paths={selectedLineEvidenceRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Inspection/test approvals
                  </div>
                  <PathList
                    paths={selectedLineInspectionRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Dojo/source refs
                  </div>
                  <PathList
                    paths={selectedLineDojoRefs}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)" }}>
                    Process ancestry
                  </div>
                  <PathList
                    paths={asArray(selectedLineRow.processAncestry)}
                    empty="none"
                    maxVisible={8}
                  />
                </div>
                {sourceContext ? (
                  <div>
                    <div style={{ color: "var(--text-muted)" }}>
                      Source context
                    </div>
                    <pre
                      className="mt-1 max-h-36 overflow-auto rounded-md border px-2 py-1 text-[11px] leading-5 whitespace-pre-wrap"
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-editor)",
                      }}
                    >
                      {sourceContext}
                    </pre>
                  </div>
                ) : null}
                {lineInspector.error ? (
                  <div
                    className="rounded border px-2 py-1 text-[11px]"
                    style={{
                      borderColor:
                        "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))",
                      color: "var(--text-primary)",
                    }}
                  >
                    {lineInspector.error}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
