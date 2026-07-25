import { Pill } from "../ui";
import { motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../lib/motion";
import { toneLabel } from "../lib/format";
import { CodeSiteIcons } from "../icons";

export default function DesktopSectionRail({ sections, activeSection, onSelect, status, streamStatus }) {
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    sections.findIndex((section) => section.key === activeSection),
  );
  return (
    <div
      data-testid="codesite-desktop-section-rail"
      className="sticky top-0 z-20 hidden border-b px-4 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.14)] md:block"
      style={{
        borderColor: "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
        background: "color-mix(in srgb, var(--bg-sidebar) 96%, var(--accent-primary) 4%)",
      }}
    >
      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-center">
        <div
          className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border p-1"
          role="tablist"
          aria-label="CodeSite sections"
          style={{
            borderColor: "var(--border-subtle)",
            background: "color-mix(in srgb, var(--bg-editor) 76%, transparent)",
          }}
        >
          {sections.map((section) => {
            const Icon = section.icon || CodeSiteIcons.liveState;
            const active = activeSection === section.key;
            return (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`codesite-section-${section.key}`}
                data-testid="codesite-desktop-section-tab"
                onClick={() => onSelect(section.key)}
                className="relative inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold transition-[background,border-color,transform] hover:-translate-y-px"
                style={{
                  borderColor: active
                    ? "color-mix(in srgb, var(--accent-primary) 54%, var(--border-subtle))"
                    : "var(--border-subtle)",
                  background: active
                    ? "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated))"
                    : "var(--bg-elevated)",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {active && !reduceMotion ? (
                  <motion.span
                    layoutId="codesite-desktop-active-section"
                    className="absolute inset-0 rounded-md"
                    style={{
                      border: "1px solid color-mix(in srgb, var(--accent-primary) 48%, transparent)",
                    }}
                    transition={{ duration: 0.2, ease: MOTION_EASE }}
                  />
                ) : null}
                <Icon className="relative h-3.5 w-3.5 shrink-0" />
                <span className="relative">{section.label}</span>
              </button>
            );
          })}
        </div>
        <div
          className="grid gap-1 rounded-lg border px-3 py-2 text-[11px]"
          style={{
            borderColor: "var(--border-subtle)",
            background: "color-mix(in srgb, var(--bg-elevated) 78%, transparent)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span style={{ color: "var(--text-muted)" }}>Focused section</span>
            <Pill tone={status}>{toneLabel(status)}</Pill>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-semibold">
              {sections.find((section) => section.key === activeSection)?.label || "Graph"}
            </span>
            <span className="font-mono" style={{ color: "var(--text-muted)" }}>
              {streamStatus}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full" style={{ background: "var(--bg-editor)" }}>
            <motion.div
              className="h-full rounded-full"
              style={{
                background: "var(--accent-primary)",
                transformOrigin: "left center",
              }}
              initial={false}
              animate={{ scaleX: (activeIndex + 1) / Math.max(1, sections.length) }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: MOTION_EASE }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
