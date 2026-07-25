import { CodeSiteIcons } from "../icons";
import { mergeTransactionSources } from "../lib/format";
import { EmptyLine, JsonPreview, Pill, Section } from "../ui";
import SuccessMetricsDeck from "./evidence/SuccessMetricsDeck";
import SerializableIsolationDeck from "./evidence/SerializableIsolationDeck";

export default function EvidenceView({
  metrics,
  metricSections,
  metricSummary,
  activeTransactions,
  mutationTransactions,
  proofBundles,
  allEvents,
  artifacts,
  artifactContent,
  artifactContentPath,
  exportResult,
}) {
  return (
    <>
      <Section
        title="Success Metrics"
        icon={CodeSiteIcons.metrics}
        sectionKey="evidence"
        right={
          <Pill tone={metrics?.status || "pending"}>
            {metrics ? "measured" : "no data"}
          </Pill>
        }
      >
        {metrics ? (
          <SuccessMetricsDeck
            sections={metricSections}
            summary={metricSummary}
          />
        ) : (
          <EmptyLine>No success metrics exported yet</EmptyLine>
        )}
      </Section>

      <Section
        title="Transactions & Evidence"
        icon={CodeSiteIcons.transactions}
        right={
          <Pill>
            {mergeTransactionSources(activeTransactions, mutationTransactions).length}/
            {proofBundles.length}
          </Pill>
        }
      >
        <SerializableIsolationDeck
          activeTransactions={activeTransactions}
          mutationTransactions={mutationTransactions}
          proofBundles={proofBundles}
          events={allEvents}
        />
      </Section>

      <Section
        title="Artifact Export Preview"
        icon={CodeSiteIcons.artifacts}
        right={<Pill>{artifacts.length}</Pill>}
      >
        {exportResult ? (
          <div
            className="mb-2 rounded border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            {exportResult.written
              ? "Artifacts written"
              : "Preview only"}
            {exportResult.root ? `: ${exportResult.root}` : ""}
          </div>
        ) : null}
        {artifacts.length === 0 ? (
          <EmptyLine>No artifact preview</EmptyLine>
        ) : (
          <div className="space-y-1">
            {artifacts.slice(0, 10).map((file, index) => (
              <div
                key={file.path || `artifact-${index}`}
                className="flex items-center justify-between gap-3 rounded border px-2 py-1.5 text-xs"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <code
                  className="min-w-0 truncate text-[10px]"
                  title={file.path}
                >
                  {file.path}
                </code>
                <span
                  className="shrink-0 font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {file.bytes}b
                </span>
              </div>
            ))}
            {artifactContent ? (
              <div className="pt-2">
                <div
                  className="mb-1 flex items-center gap-2 text-[11px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  <CodeSiteIcons.lineage className="h-3.5 w-3.5" />
                  <span className="min-w-0 truncate">
                    {artifactContentPath}
                  </span>
                </div>
                <JsonPreview value={artifactContent} maxLines={12} />
              </div>
            ) : null}
          </div>
        )}
      </Section>
    </>
  );
}
