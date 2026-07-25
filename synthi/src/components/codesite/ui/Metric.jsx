import { riskTone, toneLabel } from "../lib/format";

export default function Metric({ label, value, tone = null, testId, icon: Icon }) {
  return (
    <div
      data-testid={testId}
      className="min-h-[76px] rounded-md border px-3 py-3 transition-[border-color,background,box-shadow] duration-200"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 92%, var(--accent-primary) 8%)",
        background:
          "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 88%, var(--bg-editor) 12%))",
        boxShadow:
          "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 5%, transparent)",
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div
          className="truncate text-[11px] font-medium leading-tight"
          style={{ color: "var(--text-muted)" }}
          title={label}
        >
          {label}
        </div>
        {Icon ? (
          <Icon
            className="h-3.5 w-3.5 shrink-0"
            style={{ color: "var(--accent-primary)" }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex items-start justify-between gap-2">
        <div
          className="min-w-0 break-words font-mono text-lg font-semibold leading-tight tabular-nums"
          title={String(value)}
          style={{ color: "var(--text-primary)" }}
        >
          {value}
        </div>
        {tone ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4"
            style={{ color: "var(--text-secondary)" }}
          >
            <span className="h-2 w-2 rounded-full" style={riskTone(tone)} />
            <span>{toneLabel(tone)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
