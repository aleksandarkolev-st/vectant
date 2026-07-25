import { graphNodeStyle } from "../../lib/graph";

export default function WorkGraphNode({
  eyebrow,
  title,
  tone = "idle",
  icon: Icon,
  children,
  testId,
}) {
  return (
    <div
      data-testid={testId}
      className="min-w-0 rounded-md border px-3 py-2 text-xs"
      style={graphNodeStyle(tone, "raised")}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div
            className="text-[10px] font-semibold uppercase"
            style={{ color: "var(--text-muted)" }}
          >
            {eyebrow}
          </div>
          <div
            className="mt-1 min-w-0 break-words font-semibold leading-tight"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </div>
        </div>
        {Icon ? (
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 76%, var(--accent-primary) 24%)",
              background:
                "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
        ) : null}
      </div>
      <div className="mt-2 min-w-0">{children}</div>
    </div>
  );
}
