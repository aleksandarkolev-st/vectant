import { Pill } from "../../ui";
import { compact, formatPercent, indicatorTone, metricAttentionScore, metricSectionEntries } from "../../lib/format";
import MetricsGroup from "../overview/MetricsGroup";
import MetricScorecard from "./MetricScorecard";

export default function SuccessMetricsDeck({ sections, summary }) {
  const sectionEntries = metricSectionEntries(sections);
  const allMetrics = sectionEntries.flatMap((section) => section.rows);
  const watchlist = allMetrics
    .slice()
    .sort((left, right) => metricAttentionScore(right) - metricAttentionScore(left))
    .slice(0, 6);
  const releaseCards = [
    {
      label: "Collisions avoided",
      value: compact(summary.collisionsAvoided, "0"),
      tone: summary.collisionsAvoided ? "active" : "idle",
      target: "coordinator prevented overlap",
    },
    {
      label: "Blocked writes",
      value: compact(summary.codeSiteFsBlockedWrites, "0"),
      tone: summary.codeSiteFsBlockedWrites ? "holding" : "idle",
      target: "pre-write guard evidence",
    },
    {
      label: "Line coverage",
      value: formatPercent(summary.lineProvenanceCoverage || 0),
      tone: summary.lineProvenanceCoverage ? "active" : "pending",
      target: "target 100% traced",
    },
    {
      label: "Black box",
      value:
        summary.blackBoxCompletenessScore == null
          ? "n/a"
          : formatPercent(summary.blackBoxCompletenessScore),
      tone: summary.blackBoxCompletenessScore ? "active" : "pending",
      target: "release >=75%",
    },
  ];

  return (
    <div
      data-testid="codesite-success-metrics"
      className="grid min-w-0 gap-4"
    >
      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor:
              "color-mix(in srgb, var(--border-subtle) 70%, var(--accent-primary) 30%)",
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent-primary) 7%), var(--bg-editor))",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Release SLO posture</div>
              <div
                className="mt-1 max-w-[62ch] text-xs leading-5"
                style={{ color: "var(--text-muted)" }}
              >
                Measured outcomes tied to CodeSite artifacts, not screen-only
                claims.
              </div>
            </div>
            <Pill tone={watchlist.some((metric) => metricAttentionScore(metric) >= 80) ? "holding" : "active"}>
              {allMetrics.length} signals
            </Pill>
          </div>
          <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-2">
            {releaseCards.map((card) => (
              <div
                key={card.label}
                className="rounded-md border px-3 py-2"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-surface)",
                }}
              >
                <div
                  className="text-[10px] font-medium"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.label}
                </div>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <div className="font-mono text-xl font-semibold tabular-nums">
                    {card.value}
                  </div>
                  <span
                    className="mb-1 h-2 w-2 rounded-full"
                    style={indicatorTone(card.tone)}
                  />
                </div>
                <div
                  className="mt-1 truncate text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                  title={card.target}
                >
                  {card.target}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {watchlist.map((metric) => (
            <MetricScorecard key={metric.key || metric.label} metric={metric} />
          ))}
        </div>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-4">
        {sectionEntries.map((section) => (
          <div
            key={section.title}
            className="min-w-0 rounded-lg border px-3 py-2"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <MetricsGroup title={section.title} rows={section.rows} />
          </div>
        ))}
      </div>
    </div>
  );
}
