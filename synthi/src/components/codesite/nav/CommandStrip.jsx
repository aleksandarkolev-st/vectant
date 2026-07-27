import { CodeSiteIcons } from "../icons";

/**
 * The panel's first navigation level. Deliberately close to Workflows'
 * WorkflowCommandStrip, because CodeSite sits beside it in the Agents group of
 * the activity bar. Container queries rather than sm: — this is a dock, and its
 * width is independent of the viewport.
 */
export default function CommandStrip({ groups, activeGroup, onSelect }) {
  return (
    <div
      data-testid="codesite-command-strip"
      className="grid gap-1 rounded-md border p-1 @min-[26rem]/panel:grid-cols-2 @min-[44rem]/panel:grid-cols-4"
      style={{
        borderColor: "var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
      }}
      role="tablist"
      aria-label="CodeSite section groups"
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
            data-testid="codesite-command-tile"
            data-codesite-group-key={group.key}
            onClick={() => onSelect?.(group.key)}
            className="th-focus-ring grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--radius-control)] border px-2 text-left text-[11px] transition-[background,border-color,transform] hover:-translate-y-px"
            style={{
              borderColor: active
                ? "color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))"
                : "color-mix(in srgb, var(--border-subtle) 74%, transparent)",
              background: active
                ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))"
                : "color-mix(in srgb, var(--bg-app) 34%, transparent)",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{group.label}</span>
              <span
                className="block truncate font-mono text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                {group.detail}
              </span>
            </span>
            <span
              className="font-mono text-[10px]"
              style={{ color: active ? "var(--accent-primary)" : "var(--text-muted)" }}
            >
              {group.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
