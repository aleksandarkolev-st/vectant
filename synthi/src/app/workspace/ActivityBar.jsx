"use client";

import { Files, Search, GitBranch, GitPullRequest, Puzzle, Settings, Sparkles, Box } from "lucide-react";

/**
 * @param {Object} props
 * @param {string} props.active - Currently active sidebar view id
 * @param {Function} props.onSelect - Called with the item id when clicked
 * @param {Object} props.badges - Map of id → badge count
 * @param {Array} props.extensionContainers - Dynamic containers from extensions
 *   [{ id, title, icon, extensionId }]
 */
export default function ActivityBar({ active = "explorer", onSelect, badges = {}, extensionContainers = [] }) {
  const builtinItems = [
    { id: "explorer", label: "Explorer", Icon: Files },
    { id: "search", label: "Search", Icon: Search },
    { id: "scm", label: "Source Control", Icon: GitBranch },
    { id: "pullrequests", label: "Pull Requests", Icon: GitPullRequest },
    { id: "ai-healing", label: "AI Healing", Icon: Sparkles },
    { id: "extensions", label: "Extensions", Icon: Puzzle },
  ];

  // Build extension-contributed items with fallback icons
  const extensionItems = extensionContainers
    .filter(c => c.location !== 'panel') // only sidebar containers
    .map(c => ({
      id: `ext:${c.id}`,
      label: c.title,
      extensionIcon: c.icon, // could be a URL or relative path
      Icon: Box, // fallback Lucide icon
      extensionId: c.extensionId,
    }));

  const bottomItems = [{ id: "settings", label: "Settings", Icon: Settings }];

  const renderButton = ({ id, label, Icon, extensionIcon, extensionId }) => {
    const isActive = id === active;
    const badge = badges?.[id];

    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        onClick={() => onSelect?.(id)}
        className="group relative w-full h-9 flex items-center justify-center transition-all duration-150"
      >
        {/* Rounded floating pill — the icon container IS the active
            indicator. Brand-gradient hairline at the left edge marks
            the current view. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-1.5 inset-y-1 rounded-md transition-all duration-200"
          style={isActive
            ? {
                background: 'var(--bg-elevated)',
                boxShadow: '0 0 0 1px color-mix(in srgb, var(--attention-purple) 22%, transparent), 0 0 14px -4px color-mix(in srgb, var(--attention-purple) 32%, transparent)',
              }
            : { background: 'transparent' }}
        />
        {/* Active edge marker — 2px brand-gradient bar */}
        {isActive && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full"
            style={{
              background: 'var(--brand-gradient)',
              boxShadow: '0 0 12px -2px color-mix(in srgb, var(--brand-stop-3) 50%, transparent)',
            }}
          />
        )}

        {/* Extension icon (image URL) or Lucide fallback */}
        {extensionIcon && typeof extensionIcon === 'string' && (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:')) ? (
          <img
            src={extensionIcon}
            alt={label}
            className={`relative w-[18px] h-[18px] transition-all ${isActive ? 'opacity-100' : 'opacity-60 group-hover:opacity-95'}`}
            onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
          />
        ) : null}
        <Icon
          className={`relative w-[18px] h-[18px] transition-all ${isActive ? 'opacity-100' : 'opacity-60 group-hover:opacity-95'}`}
          strokeWidth={isActive ? 2 : 1.5}
          style={{
            color: isActive ? 'var(--attention-purple)' : undefined,
            ...(extensionIcon && (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:')) ? { display: 'none' } : {}),
          }}
        />

        {/* Hover label — slides in from the right with depth */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150"
          style={{
            borderColor: 'var(--border-medium)',
            background: 'var(--bg-panel)',
            color: 'var(--text-primary)',
            boxShadow: 'var(--depth-shadow-2)',
          }}
        >
          {label}{extensionId ? <span style={{ color: 'var(--text-muted)' }}> · {extensionId}</span> : null}
        </div>

        {/* Badge — brand gradient, reserved for meaningful counts */}
        {typeof badge === "number" && badge > 0 && (
          <div
            className="absolute right-1 top-1 min-w-3.5 h-3.5 px-1 rounded-full text-white text-[9px] leading-[14px] text-center font-semibold"
            style={{
              background: 'var(--brand-gradient-horizontal)',
              boxShadow: '0 0 8px color-mix(in srgb, var(--brand-stop-3) 45%, transparent)',
            }}
          >
            {badge}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="dock-activitybar-root w-9 h-full flex flex-col items-center" style={{ background: 'var(--bg-app)', borderRight: '1px solid var(--border-subtle)' }}>
      <div className="dock-activitybar-top w-full flex flex-col pt-1.5 gap-0.5">
        {builtinItems.map(renderButton)}
        {/* Extension-contributed activity bar items */}
        {extensionItems.length > 0 && (
          <>
            <div className="dock-activitybar-divider mx-2 my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            {extensionItems.map(renderButton)}
          </>
        )}
      </div>

      {/* Vectant AI Badge */}
      <div className="dock-activitybar-bottom mt-auto mb-2 flex flex-col items-center gap-1">
        {bottomItems.map(renderButton)}
        <div
          onClick={() => onSelect('ai')}
          className="w-6 h-6 rounded-md flex items-center justify-center cursor-pointer transition-all group"
          style={{
            background: 'color-mix(in srgb, var(--brand-stop-3) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--brand-stop-3) 24%, transparent)',
            boxShadow: '0 0 10px -2px color-mix(in srgb, var(--brand-stop-3) 25%, transparent)',
          }}
          title="Vectant AI"
        >
          <Sparkles className="w-3 h-3 opacity-80 group-hover:opacity-100" style={{ color: 'var(--brand-stop-3)' }} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}
