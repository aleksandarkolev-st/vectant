'use client';

/**
 * @fileoverview DockingActivityBar — activity bar wired to the docking system.
 * 
 * Sits outside the docking container on the left edge. Clicking
 * a button toggles/opens the corresponding panel in the docking tree.
 */

import { memo, useMemo, useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Files,
  Search,
  GitBranch,
  GitPullRequest,
  Plug,
  Puzzle,
  Command,
  Settings,
  Sparkles,
  MessageSquare,
  Box,
  Network,
  ChevronRight,
} from 'lucide-react';
import { useActivityBarDocking } from '../hooks/use-activity-bar-docking';
import { selectNodes, selectTabs, selectFocusedTabGroupId, openTab, activateTabAction, setFocusedTabGroup } from '../state/layout-slice';
import { selectContributedContainers } from '@/redux/extensionSlice';
import { IDE_PANEL } from '../panels/panel-types';

const ACTIVITY_BAR_HOVER_EVENT = 'synthi:activitybar-hover';
const SIDEBAR_HINT_SEEN_EVENT = 'synthi:sidebar-hover-hint-seen';
const SIDEBAR_HINT_SEEN_KEY = 'synthi:sidebar-hover-hint-seen';

function hasSeenSidebarHoverHint() {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(SIDEBAR_HINT_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Determine which panel type is currently "active" — i.e. visible and
 * focused in the layout. Used to highlight the matching activity bar button.
 */
function useActivePanelType() {
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const focusedGroupId = useSelector(selectFocusedTabGroupId);

  return useMemo(() => {
    if (!focusedGroupId) return null;
    const group = nodes[focusedGroupId];
    if (!group || !group.activeTabId) return null;
    const tab = tabs[group.activeTabId];
    return tab?.panelType ?? null;
  }, [nodes, tabs, focusedGroupId]);
}

const TOP_ITEMS = [
  { id: 'explorer',   panelType: IDE_PANEL.EXPLORER,   label: 'Explorer',        Icon: Files },
  { id: 'search',     panelType: IDE_PANEL.SEARCH,     label: 'Search',          Icon: Search },
  { id: 'git',        panelType: IDE_PANEL.GIT,        label: 'Source Control',  Icon: GitBranch },
  { id: 'extensions', panelType: IDE_PANEL.EXTENSIONS, label: 'Extensions',      Icon: Puzzle },
  { id: 'programs',   panelType: IDE_PANEL.PROGRAMS,   label: 'Programs',        Icon: Command },
  { id: 'chat',       panelType: IDE_PANEL.CHAT,       label: 'AI Chat',         Icon: MessageSquare },
  { id: 'ai-healing',   panelType: IDE_PANEL.AI_HEALING,   label: 'AI Healing',      Icon: Sparkles },
  { id: 'integrations', panelType: IDE_PANEL.INTEGRATIONS, label: 'Connected Tools', Icon: Plug },
  { id: 'ports',        panelType: IDE_PANEL.PORTS,        label: 'Ports',           Icon: Network },
  { id: 'pullrequests', panelType: IDE_PANEL.PULL_REQUESTS, label: 'Pull Requests', Icon: GitPullRequest },
];

// Bottom items removed — Terminal, Problems, Output are accessed via other means

export const DockingActivityBar = memo(function DockingActivityBar() {
  const handlers = useActivityBarDocking();
  const activePanelType = useActivePanelType();
  const extensionContainers = useSelector(selectContributedContainers) || [];
  const dispatch = useDispatch();
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const [showSidebarHoverHint, setShowSidebarHoverHint] = useState(false);

  useEffect(() => {
    setShowSidebarHoverHint(!hasSeenSidebarHoverHint());

    if (typeof window === 'undefined') return undefined;

    const hideHint = () => setShowSidebarHoverHint(false);
    window.addEventListener(SIDEBAR_HINT_SEEN_EVENT, hideHint);
    return () => {
      window.removeEventListener(SIDEBAR_HINT_SEEN_EVENT, hideHint);
      window.dispatchEvent(new CustomEvent(ACTIVITY_BAR_HOVER_EVENT, { detail: { hovered: false } }));
    };
  }, []);

  const setActivityBarHover = useCallback((hovered) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(ACTIVITY_BAR_HOVER_EVENT, { detail: { hovered } }));
  }, []);

  // Build dynamic extension sidebar items from installed extensions
  const extensionItems = useMemo(() => {
    return extensionContainers
      .filter(c => c.location !== 'panel') // only sidebar containers
      .map(c => ({
        id: `ext:${c.id}`,
        label: c.title,
        extensionIcon: c.icon,
        Icon: Box,
        extensionId: c.extensionId,
        panelType: `extension-view`,
        containerId: c.id,
      }));
  }, [extensionContainers]);

  // Handler for clicking an extension sidebar item
  const handleExtensionClick = useCallback((item) => {
    // Check if a tab for this extension view already exists
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.type !== 'tabgroup') continue;
      for (const tId of node.tabs || []) {
        const t = tabs[tId];
        if (t && t.panelType === 'extension-view' && t.data?.containerId === item.containerId) {
          dispatch(setFocusedTabGroup(nodeId));
          dispatch(activateTabAction({ tabId: tId }));
          return;
        }
      }
    }

    // Find a sidebar group — look for a group that already has sidebar-type tabs
    const groups = Object.entries(nodes).filter(([, n]) => n.type === 'tabgroup');
    const SIDEBAR_PANELS = new Set(['explorer', 'search', 'git', 'extensions', 'programs', 'extension-view', 'chat', 'pullrequests', 'ai-healing', 'integrations', 'ports']);
    let targetGroupId = null;
    for (const [groupId, group] of groups) {
      for (const tId of group.tabs || []) {
        const t = tabs[tId];
        if (t && SIDEBAR_PANELS.has(t.panelType)) {
          targetGroupId = groupId;
          break;
        }
      }
      if (targetGroupId) break;
    }
    // Fallback to first group
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];

    if (targetGroupId) {
      dispatch(openTab({
        panelType: 'extension-view',
        title: item.label,
        targetTabGroupId: targetGroupId,
        data: { containerId: item.containerId, extensionId: item.extensionId },
      }));
      dispatch(setFocusedTabGroup(targetGroupId));
    }
  }, [dispatch, nodes, tabs]);

  const renderButton = ({ id, panelType, label, Icon, extensionIcon, onClick }) => {
    const isActive = activePanelType === panelType;
    const handler = onClick || handlers[id];
    const hasImageIcon = extensionIcon && typeof extensionIcon === 'string' &&
      (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:'));

    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        onClick={handler}
        className={`group relative w-full h-11 flex items-center justify-center transition-all duration-150 ${
          isActive
            ? 'th-bg-panel'
            : 'th-bg-app'
        }`}
        style={isActive ? { color: 'var(--accent-tertiary)' } : { color: 'var(--text-muted)' }}
      >
        {/* Active indicator */}
        <div
          className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full transition-all duration-200 bg-transparent`}
          style={isActive ? { background: 'linear-gradient(to bottom, var(--accent-primary), var(--accent-tertiary))', boxShadow: '0 0 10px color-mix(in srgb, var(--accent-primary) 60%, transparent)' } : {}}
        />

        {id === 'explorer' && showSidebarHoverHint && (
          <span
            aria-hidden="true"
            className="dock-activitybar__hover-hint"
          >
            <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.25} />
          </span>
        )}

        {/* Extension image icon or Lucide fallback */}
        {hasImageIcon ? (
          <img
            src={extensionIcon}
            alt={label}
            className={`w-5 h-5 transition-all ${isActive ? 'opacity-100' : 'opacity-50 group-hover:opacity-80'}`}
            onError={(e) => { e.target.style.display = 'none'; if (e.target.nextSibling) e.target.nextSibling.style.display = 'block'; }}
          />
        ) : null}
        <Icon
          className={`w-5 h-5 transition-all ${
            isActive ? 'opacity-100' : 'opacity-50 group-hover:opacity-80'
          }`}
          strokeWidth={isActive ? 2 : 1.5}
          style={hasImageIcon ? { display: 'none' } : {}}
        />

        {/* Tooltip */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 group-hover:opacity-100 transition shadow-lg"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
        >
          {label}
        </div>
      </button>
    );
  };

  return (
    <div
      className="dock-activitybar-root relative w-12 h-full flex flex-col items-center border-r-2 flex-shrink-0"
      style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}
      onMouseEnter={() => setActivityBarHover(true)}
      onMouseLeave={() => setActivityBarHover(false)}
    >
      {/* Top sidebar items */}
      <div className="dock-activitybar-top w-full flex flex-col pt-1">
        {TOP_ITEMS.map(renderButton)}

        {/* Dynamic extension sidebar items */}
        {extensionItems.length > 0 && (
          <>
            <div className="dock-activitybar-divider mx-3 my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
            {extensionItems.map((item) =>
              renderButton({ ...item, onClick: () => handleExtensionClick(item) })
            )}
          </>
        )}
      </div>

      {/* Bottom items */}
      <div className="dock-activitybar-bottom mt-auto mb-3 flex flex-col items-center w-full">
        {renderButton({ id: 'settings', panelType: IDE_PANEL.SETTINGS, label: 'Settings', Icon: Settings })}
        <div
          className="w-7 h-7 rounded-lg border flex items-center justify-center cursor-pointer transition-all group mt-2"
          style={{ background: 'color-mix(in srgb, var(--accent-primary) 7%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 19%, transparent)' }}
          title="Vectant AI"
        >
          <Sparkles className="w-3.5 h-3.5 opacity-70 group-hover:opacity-100" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
});

export default DockingActivityBar;
