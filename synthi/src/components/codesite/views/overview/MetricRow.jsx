import { formatMetricValue, metricTone, riskTone, toneLabel } from "../../lib/format";

export default function MetricRow({ metric }) {
  return (
    <div
      className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t py-2 first:border-t-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div className="min-w-0">
        <div
          className="truncate text-xs font-medium"
          title={metric.label}
          style={{ color: "var(--text-primary)" }}
        >
          {metric.label}
        </div>
        <div
          className="mt-0.5 truncate text-[10px]"
          style={{ color: "var(--text-muted)" }}
        >
          {metric.status === "not_instrumented"
            ? "needs instrumentation"
            : `${metric.sampleSize || 0} evidence refs`}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-sm tabular-nums"
          title={formatMetricValue(metric)}
          style={{ color: "var(--text-primary)" }}
        >
          {formatMetricValue(metric)}
        </span>
        <span
          className="inline-flex items-center gap-1 text-[10px] leading-4"
          style={{ color: "var(--text-secondary)" }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={riskTone(metricTone(metric))}
          />
          <span>{toneLabel(metricTone(metric))}</span>
        </span>
      </div>
    </div>
  );
}
