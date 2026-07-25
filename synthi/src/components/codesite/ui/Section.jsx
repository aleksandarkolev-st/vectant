

export default function Section({ title, icon: Icon, children, right }) {
  return (
    <section
      className="border-t"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 86%, var(--accent-primary) 14%)",
      }}
    >
      <div
        className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-3"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 82%, var(--bg-editor) 18%), color-mix(in srgb, var(--bg-surface) 96%, transparent))",
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border shadow-[inset_0_1px_0_rgba(255,255,255,0.055)]"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 72%, var(--accent-primary) 28%)",
              background:
                "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-elevated))",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
          <h3
            className="truncate text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h3>
        </div>
        {right}
      </div>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
