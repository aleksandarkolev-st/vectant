import { statusTone } from "../lib/format";
import { statusColor } from "../lib/graph";

export default function Pill({ children, tone = "idle", className = "", testId }) {
  const toneStyle = typeof tone === "string" ? statusTone(tone) : tone;
  return (
    <span
      data-testid={testId}
      className={`inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-md border px-2 text-[11px] font-semibold leading-4 ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 74%, var(--text-primary) 12%)",
        ...toneStyle,
      }}
    >
      {typeof tone === "string" ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: statusColor(tone) }}
        />
      ) : null}
      {children}
    </span>
  );
}
