import { clampRatio, indicatorTone } from "../lib/format";

export default function SignalBar({ value, tone = "active", label = "" }) {
  const width = `${Math.round(clampRatio(value) * 100)}%`;
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full"
      aria-label={label}
      style={{
        background:
          "color-mix(in srgb, var(--border-subtle) 70%, transparent)",
      }}
    >
      <div
        className="h-full rounded-full"
        style={{
          width,
          minWidth: value > 0 ? "12%" : "0",
          background:
            indicatorTone(tone).background || "var(--accent-primary)",
        }}
      />
    </div>
  );
}
