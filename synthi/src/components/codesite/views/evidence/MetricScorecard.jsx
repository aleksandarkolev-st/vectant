import { Pill, SignalBar } from "../../ui";
import { asArray, formatMetricValue, metricProgress, metricTargetLabel, metricTone, toneLabel } from "../../lib/format";

export default function MetricScorecard({ metric }) {
  const tone = metricTone(metric);
  const evidenceCount =
    asArray(metric?.evidenceRefs).length || metric?.sampleSize || 0;
  return (
    <div
      data-testid={`codesite-slo-${metric?.key || "metric"}`}
      className="grid min-h-[118px] content-between rounded-md border px-3 py-2.5 text-xs"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 84%, var(--accent-primary) 16%)",
        background:
          "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 84%, var(--bg-editor) 16%))",
      }}
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div
            className="min-w-0 break-words text-[11px] font-semibold leading-4"
            title={metric?.label}
          >
            {metric?.label || "Metric"}
          </div>
          <Pill tone={tone}>{toneLabel(tone)}</Pill>
        </div>
        <div
          className="mt-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xl font-semibold leading-none tabular-nums @min-[28rem]/panel:text-2xl"
          title={formatMetricValue(metric)}
          style={{ color: "var(--text-primary)" }}
        >
          {formatMetricValue(metric)}
        </div>
      </div>
      <div className="mt-3 grid gap-1.5">
        <SignalBar
          value={metricProgress(metric)}
          tone={tone}
          label={`${metric?.label || "metric"} progress`}
        />
        <div
          className="flex min-w-0 items-center justify-between gap-2 text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="min-w-0 truncate">{metricTargetLabel(metric)}</span>
          <span className="shrink-0 font-mono tabular-nums">
            {evidenceCount} refs
          </span>
        </div>
      </div>
    </div>
  );
}
