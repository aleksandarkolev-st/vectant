import { motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../lib/motion";
import { CodeSiteIcons } from "../icons";

/**
 * The narrow-dock first level. Shows the four groups rather than all ten
 * sections, which is what let the old version overflow into a horizontal
 * scroller. The second level (ViewStrip) renders below this, from the panel.
 *
 * Keeps three baseline test ids: codesite-mobile-section-tabs,
 * codesite-mobile-section-tab and codesite-mobile-action-drawer.
 */
export default function MobileSectionTabs({
  groups,
  activeGroup,
  onSelect,
  activeSectionLabel,
}) {
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    groups.findIndex((group) => group.key === activeGroup),
  );
  return (
    <div
      data-testid="codesite-mobile-section-tabs"
      className="sticky top-0 z-20 border-b px-3 py-1.5 @min-[34rem]/panel:hidden"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <div
        className="grid min-w-0 grid-cols-2 gap-1 rounded-md border p-1"
        role="tablist"
        aria-label="CodeSite section groups"
        style={{
          borderColor: "var(--border-subtle)",
          background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
        }}
      >
        {groups.map((group) => {
          const active = activeGroup === group.key;
          const Icon = group.icon || CodeSiteIcons.liveState;
          return (
            <button
              key={group.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid="codesite-mobile-section-tab"
              data-codesite-group-key={group.key}
              onClick={() => onSelect?.(group.key)}
              className="th-focus-ring grid min-h-10 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-1.5 rounded-[var(--radius-control)] border px-2 text-left text-[11px] transition-[background,border-color]"
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
              <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span className="truncate font-semibold">{group.label}</span>
              <span
                className="font-mono text-[10px]"
                style={{
                  color: active ? "var(--accent-primary)" : "var(--text-muted)",
                }}
              >
                {group.count}
              </span>
            </button>
          );
        })}
      </div>
      <div
        data-testid="codesite-mobile-action-drawer"
        className="mt-1.5 grid gap-1.5 rounded-md border p-2 text-[11px]"
        style={{
          borderColor: "var(--border-subtle)",
          background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
          color: "var(--text-muted)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span>Section</span>
          <span className="truncate font-semibold" style={{ color: "var(--text-primary)" }}>
            {activeSectionLabel || "Overview"}
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
            animate={{ scaleX: (activeIndex + 1) / Math.max(1, groups.length) }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: MOTION_EASE }}
          />
        </div>
        <span className="sr-only">
          {reduceMotion ? "Reduced motion active" : "Animated section jump active"}
        </span>
      </div>
    </div>
  );
}
