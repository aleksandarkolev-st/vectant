import CommandStrip from "./CommandStrip";

/**
 * The wide-dock first level. Keeps `codesite-desktop-section-rail`, which is in
 * the locked test-id baseline.
 *
 * Replaces a flat strip of ten tabs plus a 280px status card that existed only
 * to name the section you were already on — the command tiles carry that
 * information themselves now.
 *
 * The second level (ViewStrip) is rendered by the panel rather than nested here,
 * so it stays reachable below 34rem where this component is hidden.
 */
export default function DesktopSectionRail({ groups, activeGroup, onSelect }) {
  return (
    <div
      data-testid="codesite-desktop-section-rail"
      className="sticky top-0 z-20 hidden border-b px-3 py-2 @min-[34rem]/panel:block"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <CommandStrip groups={groups} activeGroup={activeGroup} onSelect={onSelect} />
    </div>
  );
}
