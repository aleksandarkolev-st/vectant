import { motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../lib/motion";
import { CodeSiteIcons } from "../icons";

export default function MobileSectionTabs({ sections, activeSection, onSelect }) {
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    sections.findIndex((section) => section.key === activeSection),
  );
  return (
    <div
      data-testid="codesite-mobile-section-tabs"
      className="sticky top-0 z-20 border-b px-3 py-1.5 @min-[34rem]/panel:hidden"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
        background:
          "color-mix(in srgb, var(--bg-sidebar) 96%, var(--accent-primary) 4%)",
      }}
    >
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
          return (
            <motion.button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={activeSection === section.key}
              aria-controls={`codesite-section-${section.key}`}
              data-testid="codesite-mobile-section-tab"
              data-codesite-section-key={section.key}
              onClick={() => onSelect(section.key)}
              whileTap={reduceMotion ? undefined : { scale: 0.985 }}
              className="relative inline-flex h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-[11px] font-semibold transition-[background,border-color,color] active:scale-[0.98]"
              style={{
                borderColor:
                  activeSection === section.key
                    ? "color-mix(in srgb, var(--accent-primary) 54%, var(--border-subtle))"
                    : "var(--border-subtle)",
                background:
                  activeSection === section.key
                    ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
                    : "var(--bg-elevated)",
                color: "var(--text-primary)",
                transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            >
              {activeSection === section.key && !reduceMotion ? (
                <motion.span
                  layoutId="codesite-mobile-active-section"
                  className="absolute inset-0 rounded-md"
                  style={{
                    border:
                      "1px solid color-mix(in srgb, var(--accent-primary) 54%, transparent)",
                  }}
                  transition={{ duration: 0.2, ease: MOTION_EASE }}
                />
              ) : null}
              <Icon
                className="relative h-3.5 w-3.5 shrink-0"
                style={{ color: "var(--accent-primary)" }}
              />
              <span className="relative">{section.label}</span>
              <span
                className="relative h-1.5 w-1.5 rounded-full"
                style={{
                  background:
                    activeSection === section.key
                      ? "var(--accent-primary)"
                      : "var(--border-subtle)",
                }}
              />
            </motion.button>
          );
        })}
      </div>
      <div
        data-testid="codesite-mobile-action-drawer"
        className="mt-2 grid gap-2 rounded-lg border p-2 text-[11px]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background:
            "color-mix(in srgb, var(--bg-elevated) 92%, var(--bg-editor) 8%)",
          color: "var(--text-muted)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span>Section</span>
          <span
            className="font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {sections.find((section) => section.key === activeSection)?.label ||
              "Scope"}
          </span>
        </div>
        <div
          className="h-1 overflow-hidden rounded-full"
          style={{ background: "var(--bg-editor)" }}
        >
          <motion.div
            className="h-full w-full rounded-full"
            style={{
              background: "var(--accent-primary)",
              transformOrigin: "left center",
            }}
            initial={false}
            animate={{
              scaleX: (activeIndex + 1) / Math.max(1, sections.length),
            }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: MOTION_EASE }}
          />
        </div>
        <span className="sr-only">
          {reduceMotion
            ? "Reduced motion active"
            : "Animated section jump active"}
        </span>
      </div>
    </div>
  );
}
