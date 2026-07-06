'use client';

/**
 * @fileoverview DockingActivityBar — activity bar wired to the docking system.
 * 
 * Sits outside the docking container on the left edge. Clicking
 * a button toggles/opens the corresponding panel in the docking tree.
 */

import { memo, useMemo, useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Files,
  Search,
  GitBranch,
  GitPullRequest,
  Plug,
  Puzzle,
  Command,
  Settings,
  MessageSquare,
  Bot,
  Box,
  Radar,
  Network,
  ChevronRight,
  ChevronDown,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { useActivityBarDocking } from '../hooks/use-activity-bar-docking';
import { selectNodes, selectTabs, selectFocusedTabGroupId, openTab, activateTabAction, setFocusedTabGroup } from '../state/layout-slice';
import { selectContributedContainers } from '@/redux/extensionSlice';
import { IDE_PANEL } from '../panels/panel-types';

const ACTIVITY_BAR_HOVER_EVENT = 'synthi:activitybar-hover';
const SIDEBAR_HINT_SEEN_EVENT = 'synthi:sidebar-hover-hint-seen';
const SIDEBAR_HINT_SEEN_KEY = 'synthi:sidebar-hover-hint-seen';
const SIDEBAR_PREFS_KEY = 'synthi:docking-activitybar-prefs:v1';
const LOCKED_ITEM_IDS = new Set(['explorer', 'settings']);

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

const ACTIVITY_GROUPS = [
  {
    id: 'workspace',
    label: 'Workspace',
    shortLabel: 'WS',
    items: [
      { id: 'explorer', panelType: IDE_PANEL.EXPLORER, label: 'Explorer', Icon: Files },
      { id: 'search', panelType: IDE_PANEL.SEARCH, label: 'Search', Icon: Search },
      { id: 'git', panelType: IDE_PANEL.GIT, label: 'Source Control', Icon: GitBranch },
      { id: 'pullrequests', panelType: IDE_PANEL.PULL_REQUESTS, label: 'Pull Requests', Icon: GitPullRequest },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    shortLabel: 'AI',
    items: [
      { id: 'chat', panelType: IDE_PANEL.CHAT, label: 'AI Chat', Icon: MessageSquare },
      { id: 'workflows', panelType: IDE_PANEL.AGENT_WORKFLOWS, label: 'Workflows', Icon: Bot },
      { id: 'codesite', panelType: IDE_PANEL.CODESITE, label: 'CodeSite', Icon: Radar },
      { id: 'ai-healing', panelType: IDE_PANEL.AI_HEALING, label: 'AI Healing', Icon: ShieldCheck },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    shortLabel: 'IO',
    items: [
      { id: 'extensions', panelType: IDE_PANEL.EXTENSIONS, label: 'Extensions', Icon: Puzzle },
      { id: 'programs', panelType: IDE_PANEL.PROGRAMS, label: 'Programs', Icon: Command },
      { id: 'integrations', panelType: IDE_PANEL.INTEGRATIONS, label: 'Connected Tools', Icon: Plug },
      { id: 'ports', panelType: IDE_PANEL.PORTS, label: 'Ports', Icon: Network },
    ],
  },
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
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [hiddenItemIds, setHiddenItemIds] = useState(() => new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState(() => new Set());

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

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setHiddenItemIds(new Set(Array.isArray(parsed.hiddenItemIds) ? parsed.hiddenItemIds : []));
        setCollapsedGroupIds(new Set(Array.isArray(parsed.collapsedGroupIds) ? parsed.collapsedGroupIds : []));
      }
    } catch {
      // Ignore corrupt local preferences; the customize panel can recreate them.
    } finally {
      setPrefsHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!prefsHydrated || typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      SIDEBAR_PREFS_KEY,
      JSON.stringify({
        hiddenItemIds: [...hiddenItemIds],
        collapsedGroupIds: [...collapsedGroupIds],
      }),
    );
  }, [hiddenItemIds, collapsedGroupIds, prefsHydrated]);

  const setActivityBarHover = useCallback((hovered) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(ACTIVITY_BAR_HOVER_EVENT, { detail: { hovered } }));
  }, []);

  const setItemHidden = useCallback((id, hidden) => {
    if (LOCKED_ITEM_IDS.has(id)) return;
    setHiddenItemIds((current) => {
      const next = new Set(current);
      if (hidden) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleGroupCollapsed = useCallback((id) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const resetSidebarPrefs = useCallback(() => {
    setHiddenItemIds(new Set());
    setCollapsedGroupIds(new Set());
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

  const allGroups = useMemo(() => {
    const groups = [...ACTIVITY_GROUPS];
    if (extensionItems.length > 0) {
      groups.push({
        id: 'extensions-extra',
        label: 'Extensions',
        shortLabel: 'EX',
        items: extensionItems,
      });
    }
    return groups;
  }, [extensionItems]);

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
    const SIDEBAR_PANELS = new Set(['explorer', 'search', 'git', 'extensions', 'programs', 'extension-view', 'chat', 'agent-workflows', 'codesite', 'pullrequests', 'ai-healing', 'integrations', 'ports']);
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

  const renderButton = ({ id, panelType, label, Icon, extensionIcon, onClick, groupLabel }) => {
    const isActive = activePanelType === panelType;
    const handler = onClick || handlers[id];
    const hasImageIcon = extensionIcon && typeof extensionIcon === 'string' &&
      (extensionIcon.startsWith('http') || extensionIcon.startsWith('data:'));
    const canHide = !LOCKED_ITEM_IDS.has(id);

    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        aria-current={isActive ? 'page' : undefined}
        data-active={isActive ? 'true' : 'false'}
        onClick={handler}
        onContextMenu={(event) => {
          if (!canHide) return;
          event.preventDefault();
          setItemHidden(id, true);
          setCustomizeOpen(true);
        }}
        className="dock-activitybar-button th-focus-ring group relative flex h-10 w-full items-center justify-center"
        style={isActive ? { color: 'var(--attention-purple)' } : { color: 'var(--text-muted)' }}
      >
        {/* Active indicator */}
        <div
          className="dock-activitybar-button__bar"
          style={isActive ? { background: 'var(--brand-gradient)', boxShadow: '0 0 12px color-mix(in srgb, var(--attention-purple) 54%, transparent)' } : {}}
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
          className={`relative z-10 w-5 h-5 transition-all ${
            isActive ? 'opacity-100' : 'opacity-50 group-hover:opacity-80'
          }`}
          strokeWidth={isActive ? 1.9 : 1.55}
          style={hasImageIcon ? { display: 'none' } : {}}
        />

        {/* Tooltip */}
        <div
          role="tooltip"
          className="dock-activitybar-tooltip pointer-events-none absolute left-full top-1/2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 transition group-hover:opacity-100"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-overlay)', color: 'var(--text-primary)' }}
        >
          <span>{label}</span>
          {groupLabel ? <span style={{ color: 'var(--text-muted)' }}> · {groupLabel}</span> : null}
        </div>
      </button>
    );
  };

  return (
    <div
      className="dock-activitybar-root vt-ambient-bottom relative w-12 h-full flex flex-col items-center border-r flex-shrink-0"
      style={{ background: 'var(--bg-sidebar)', borderColor: 'var(--border-subtle)' }}
      onMouseEnter={() => setActivityBarHover(true)}
      onMouseLeave={() => setActivityBarHover(false)}
    >
      <div className="dock-activitybar-top no-scrollbar w-full flex-1 overflow-y-auto pt-1.5">
        {allGroups.map((group) => {
          const visibleItems = group.items.filter((item) => !hiddenItemIds.has(item.id));
          const isCollapsed = collapsedGroupIds.has(group.id);
          const visibleCount = visibleItems.length;
          return (
            <div key={group.id} className="dock-activitybar-folder">
              <button
                type="button"
                className="dock-activitybar-folder__label th-focus-ring"
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.label}`}
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroupCollapsed(group.id)}
              >
                <span>{group.shortLabel}</span>
                <ChevronDown className="dock-activitybar-folder__chevron" data-collapsed={isCollapsed ? 'true' : 'false'} strokeWidth={1.8} />
              </button>

              {!isCollapsed && visibleCount > 0 && (
                <div className="dock-activitybar-folder__items">
                  {visibleItems.map((item) => renderButton({
                    ...item,
                    groupLabel: group.label,
                    onClick: item.containerId ? () => handleExtensionClick(item) : undefined,
                  }))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="dock-activitybar-bottom mt-auto mb-2 flex w-full flex-col items-center gap-1 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          aria-label="Customize sidebar"
          aria-expanded={customizeOpen}
          onClick={() => setCustomizeOpen((open) => !open)}
          className={`dock-activitybar-button th-focus-ring group relative flex h-9 w-full items-center justify-center ${customizeOpen ? 'is-active' : ''}`}
          style={customizeOpen ? { color: 'var(--attention-purple)' } : { color: 'var(--text-muted)' }}
        >
          <SlidersHorizontal className="relative z-10 h-[18px] w-[18px]" strokeWidth={1.6} />
          <div
            role="tooltip"
            className="dock-activitybar-tooltip pointer-events-none absolute left-full top-1/2 z-50 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium opacity-0 transition group-hover:opacity-100"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-overlay)', color: 'var(--text-primary)' }}
          >
            Customize sidebar
          </div>
        </button>
        {renderButton({ id: 'settings', panelType: IDE_PANEL.SETTINGS, label: 'Settings', Icon: Settings })}
      </div>

      <AnimatePresence>
        {customizeOpen && (
          <motion.div
            className="dock-activitybar-customizer vt-shell-panel"
            role="dialog"
            aria-label="Customize sidebar"
            initial={{ opacity: 0, x: -6, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: -6, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
          >
            <div className="flex items-start justify-between gap-3 border-b px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
              <div>
                <div className="text-xs font-semibold text-[var(--text-primary)]">Sidebar folders</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">Hide tools or collapse a folder.</div>
              </div>
              <button
                type="button"
                className="th-focus-ring th-btn-ghost rounded-[6px] px-2 py-1 text-[11px] font-semibold"
                onClick={resetSidebarPrefs}
              >
                Reset
              </button>
            </div>
            <div className="max-h-[min(620px,calc(100dvh-96px))] overflow-y-auto p-2">
              {allGroups.map((group) => {
                const isCollapsed = collapsedGroupIds.has(group.id);
                return (
                  <div key={group.id} className="vt-sidebar-group mb-2 last:mb-0">
                    <div className="flex items-center justify-between px-2.5 py-2">
                      <span className="vt-section-label">{group.label}</span>
                      <button
                        type="button"
                        className="th-focus-ring th-btn-ghost rounded-[6px] px-2 py-1 text-[11px]"
                        onClick={() => toggleGroupCollapsed(group.id)}
                      >
                        {isCollapsed ? 'Expand' : 'Collapse'}
                      </button>
                    </div>
                    <div className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      {group.items.map((item) => {
                        const checked = !hiddenItemIds.has(item.id);
                        const locked = LOCKED_ITEM_IDS.has(item.id);
                        const ItemIcon = item.Icon;
                        return (
                          <label key={item.id} className="vt-sidebar-row flex cursor-pointer items-center gap-2 px-2.5 py-2 text-[12px]">
                            <input
                              type="checkbox"
                              className="accent-[var(--attention-purple)]"
                              checked={checked}
                              disabled={locked}
                              onChange={(event) => setItemHidden(item.id, !event.target.checked)}
                            />
                            <ItemIcon className="size-3.5 shrink-0" strokeWidth={1.6} />
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {locked ? <span className="vt-mono text-[10px] text-[var(--text-muted)]">fixed</span> : null}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export default DockingActivityBar;
