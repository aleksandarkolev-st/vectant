import { CodeSiteIcons } from "../icons";

/**
 * Second navigation level: the sections inside the active group.
 *
 * `codesite-desktop-section-tab` and `data-codesite-section-key` must stay on
 * these buttons — the first is in the locked test-id baseline, and the panel
 * tests select a view by that attribute pair.
 */
export default function ViewStrip({ sections, activeSection, onSelect }) {
  if (sections.length < 2) return null;
  return (
    <div
      data-testid="codesite-view-strip"
      className="sticky top-0 z-10 flex min-w-0 flex-wrap gap-1 border-b px-3 py-1.5"
      style={{ borderColor: "var(--border-subtle)" }}
      role="tablist"
      aria-label="CodeSite sections"
    >
      {sections.map((section) => {
        const active = activeSection === section.key;
        const Icon = section.icon || CodeSiteIcons.liveState;
        return (
          <button
            key={section.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`codesite-section-${section.key}`}
            data-testid="codesite-desktop-section-tab"
            data-codesite-section-key={section.key}
            onClick={() => onSelect?.(section.key)}
            className="th-focus-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[11px] transition-[background,border-color]"
            style={{
              borderColor: active
                ? "color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))"
                : "color-mix(in srgb, var(--border-subtle) 74%, transparent)",
              background: active
                ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))"
                : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />
            <span className="truncate">{section.label}</span>
          </button>
        );
      })}
    </div>
  );
}
