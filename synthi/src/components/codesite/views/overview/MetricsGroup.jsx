import { asArray } from "../../lib/format";
import MetricRow from "./MetricRow";

export default function MetricsGroup({ title, rows }) {
  return (
    <div className="min-w-0">
      <div
        className="mb-1 text-[11px] font-semibold uppercase"
        style={{ color: "var(--text-muted)" }}
      >
        {title}
      </div>
      <div className="min-w-0">
        {asArray(rows).map((metric, index) => (
          <MetricRow
            key={metric.key || metric.label || `${title}-metric-${index}`}
            metric={metric}
          />
        ))}
      </div>
    </div>
  );
}
