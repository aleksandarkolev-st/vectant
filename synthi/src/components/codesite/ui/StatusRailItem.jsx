import { indicatorTone, toneLabel } from "../lib/format";
import { CodeSiteIcons } from "../icons";

export default function StatusRailItem({
  label,
  value,
  tone = "idle",
  icon: Icon = CodeSiteIcons.liveState,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-16 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 96%, var(--accent-primary) 3%), color-mix(in srgb, var(--bg-surface) 90%, var(--bg-editor) 10%))",
      }}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-md border"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background:
            "color-mix(in srgb, var(--accent-primary) 9%, transparent)",
        }}
      >
        <Icon
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--accent-primary)" }}
        />
      </span>
      <div className="min-w-0">
        <div
          className="text-[10px] font-medium leading-tight"
          style={{ color: "var(--text-muted)" }}
        >
          {label}
        </div>
        <div
          className="break-words font-mono text-sm font-semibold leading-tight tabular-nums"
          title={String(value)}
          style={{ color: "var(--text-primary)" }}
        >
          {value}
        </div>
      </div>
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[10px] leading-4"
        style={{ color: "var(--text-secondary)" }}
      >
        <span className="h-2 w-2 rounded-full" style={indicatorTone(tone)} />
        <span>{toneLabel(tone)}</span>
      </span>
    </div>
  );
}
