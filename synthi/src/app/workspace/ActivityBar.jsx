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
        className={`group relative w-full h-12 flex items-center justify-center transition-all duration-150 ${
          isActive 
            ? "th-bg-panel" 
            : "th-bg-app"
        }`}
        style={isActive ? { color: 'var(--accent-tertiary)' } : { color: 'var(--text-muted)' }}
      >
        {/* Active indicator - Strong teal accent bar */}
        <div
          className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full transition-all duration-200 ${
            isActive ? "bg-transparent" : "bg-transparent"
          }`}
          style={isActive ? { background: 'linear-gradient(to bottom, var(--accent-primary), var(--accent-tertiary))', boxShadow: '0 0 10px color-mix(in srgb, var(--accent-primary) 60%, transparent)' } : {}}
        />

        {/* Extension icon (image URL) or Lucide fallback */}
        {extensionIcon && typeof extensionIcon === 'string' && (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:')) ? (
          <img
            src={extensionIcon}
            alt={label}
            className={`w-5 h-5 transition-all ${isActive ? 'opacity-100' : 'opacity-60 group-hover:opacity-90'}`}
            onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }}
          />
        ) : null}
        <Icon
          className={`w-5 h-5 transition-all ${isActive ? 'opacity-100' : 'opacity-60 group-hover:opacity-90'}`}
          strokeWidth={isActive ? 2 : 1.5}
          style={extensionIcon && (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:')) ? { display: 'none' } : {}}
        />

        {/* Hover label */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 group-hover:opacity-100 transition shadow-lg"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
        >
          {label}{extensionId ? ` (${extensionId})` : ''}
        </div>

        {/* Badge */}
        {typeof badge === "number" && badge > 0 && (
          <div className="absolute right-2 top-2 min-w-4 h-4 px-1 rounded-full text-white text-[9px] leading-4 text-center font-semibold" style={{ background: 'linear-gradient(to right, var(--accent-primary), var(--accent-tertiary))', boxShadow: '0 0 8px color-mix(in srgb, var(--accent-primary) 50%, transparent)' }}>
            {badge}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="w-12 h-full flex flex-col items-center border-r-2" style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}>
      <div className="w-full flex flex-col pt-1">
        {builtinItems.map(renderButton)}
        {/* Extension-contributed activity bar items */}
        {extensionItems.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            {extensionItems.map(renderButton)}
          </>
        )}
      </div>
      
      {/* Synthi AI Badge */}
      <div className="mt-auto mb-3 flex flex-col items-center">
        {bottomItems.map(renderButton)}
        <div className="w-7 h-7 rounded-lg border flex items-center justify-center cursor-pointer transition-all group mt-2" style={{ background: 'color-mix(in srgb, var(--accent-primary) 7%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 19%, transparent)' }} title="Synthi AI">
          <Sparkles className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}
