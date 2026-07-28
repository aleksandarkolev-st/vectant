// A section is a label over its content, not a framed box. The panel stacks up
// to nine of these in a view, so every pixel of chrome here is multiplied by
// nine. Matches the label-and-count pattern the sibling panels use.
export default function Section({
  title,
  icon: Icon,
  children,
  right,
  count,
  hideWhenEmpty = false,
}) {
  if (hideWhenEmpty && !count) return null;

  return (
    <section className="flex min-w-0 flex-col gap-2 px-3 pb-4 pt-3">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          {Icon ? <Icon className="h-3 w-3 shrink-0" strokeWidth={2} /> : null}
          <span className="truncate">{title}</span>
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}
