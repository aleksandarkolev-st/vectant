'use client';

/**
 * useSidebarAutoCollapse
 *
 * Watches mouseenter/leave on a sidebar TabGroup and toggles a
 * "collapsed" boolean after the configured delay. The collapsed state
 * is purely visual — the layout slice is not mutated, so the user's
 * docked widths are preserved when they hover back in.
 *
 * Returns { isCollapsed, bind } where `bind` is a set of mouse handlers
 * the caller spreads onto the group's root element.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  selectSidebarAutoCollapseEnabled,
  selectSidebarAutoCollapseDelay,
  selectPinnedSidebarPanelTypes,
} from '@/redux/uiSlice';
import { IDE_PANEL } from '../panels/panel-types';

const ACTIVITY_BAR_HOVER_EVENT = 'synthi:activitybar-hover';
const SIDEBAR_HINT_SEEN_EVENT = 'synthi:sidebar-hover-hint-seen';
const SIDEBAR_HINT_SEEN_KEY = 'synthi:sidebar-hover-hint-seen';
const DOCK_LAYOUT_RESIZE_EVENT = 'synthi:dock-layout-resize';

function hasSeenSidebarHoverHint() {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return localStorage.getItem(SIDEBAR_HINT_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function markSidebarHoverHintSeen() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(SIDEBAR_HINT_SEEN_KEY, 'true');
  } catch {
    // Ignore storage failures; the runtime signal still hides the hint.
  }
  window.dispatchEvent(new CustomEvent(SIDEBAR_HINT_SEEN_EVENT));
}

// These mirror the panel categories declared in use-activity-bar-docking.js
const SIDEBAR_PANEL_TYPES = new Set([
  IDE_PANEL.EXPLORER,
  IDE_PANEL.SEARCH,
  IDE_PANEL.GIT,
  IDE_PANEL.EXTENSIONS,
  IDE_PANEL.EXTENSION_VIEW,
  IDE_PANEL.CHAT,
  IDE_PANEL.AGENT_WORKFLOWS,
  IDE_PANEL.SETTINGS,
  IDE_PANEL.PULL_REQUESTS,
  IDE_PANEL.AI_HEALING,
  IDE_PANEL.THEME_EDITOR,
]);

/**
 * @param {object[]} tabs   the resolved tab objects in the group
 * @returns {boolean} whether every visible tab in this group is a sidebar panel
 */
function tabsAreSidebar(tabs) {
  if (!tabs || tabs.length === 0) return false;
  return tabs.every((tab) => SIDEBAR_PANEL_TYPES.has(tab?.panelType));
}

export function useSidebarAutoCollapse({ tabs, isFocused, activeTabId, sidebarEdge }) {
  const enabled = useSelector(selectSidebarAutoCollapseEnabled);
  const delay = useSelector(selectSidebarAutoCollapseDelay);
  const pinnedPanelTypes = useSelector(selectPinnedSidebarPanelTypes);

  const isSidebar = useMemo(() => tabsAreSidebar(tabs), [tabs]);
  // If the active tab's panelType is user-pinned, the group is held open.
  // We treat "pinned" as binding to the visible content rather than every
  // docked sibling — keeps the toggle predictable when multiple panels
  // share a group.
  const activeTab = useMemo(
    () => tabs?.find?.((t) => t?.id === activeTabId) || tabs?.[0] || null,
    [tabs, activeTabId],
  );
  const isPinned = useMemo(() => {
    if (!isSidebar || !activeTab) return false;
    return pinnedPanelTypes.includes(activeTab.panelType);
  }, [isSidebar, activeTab, pinnedPanelTypes]);
  const [isCollapsed, setCollapsed] = useState(false);
  const [isActivityBarHovered, setActivityBarHovered] = useState(false);
  const timerRef = useRef(null);
  const activityBarHoveredRef = useRef(false);
  const hasInitializedDefaultCollapseRef = useRef(false);
  const hasSeenHoverHintRef = useRef(hasSeenSidebarHoverHint());
  const previousFocusedRef = useRef(isFocused);
  const isSideEdgeSidebar = isSidebar && (sidebarEdge === 'left' || sidebarEdge === 'right');
  const isLeftSidebar = isSidebar && sidebarEdge === 'left';

  useEffect(() => {
    activityBarHoveredRef.current = isActivityBarHovered;
  }, [isActivityBarHovered]);

  // When the user clicks an ActivityBar icon (or any other path that
  // shifts focus to this group), wake it up immediately. This is how
  // the user "re-summons" a collapsed sidebar even though its hover
  // zone has been reduced to a hairline.
  useEffect(() => {
    const becameFocused = !previousFocusedRef.current && isFocused;
    previousFocusedRef.current = isFocused;

    if (becameFocused && isCollapsed) {
      setCollapsed(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, activeTabId]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const revealViaCursor = useCallback(() => {
    clearTimer();
    setCollapsed(false);
    if (isLeftSidebar && !hasSeenHoverHintRef.current) {
      hasSeenHoverHintRef.current = true;
      markSidebarHoverHintSeen();
    }
  }, [clearTimer, isLeftSidebar]);

  useEffect(() => {
    if (!enabled || !isSideEdgeSidebar || hasInitializedDefaultCollapseRef.current) return;
    if (isPinned) return;
    hasInitializedDefaultCollapseRef.current = true;
    setCollapsed(true);
  }, [enabled, isSideEdgeSidebar, isPinned]);

  // When the user pins the active panel mid-session, wake the group up.
  useEffect(() => {
    if (isPinned && isCollapsed) {
      setCollapsed(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [isPinned, isCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSideEdgeSidebar) return undefined;

    const emitResize = () => {
      window.dispatchEvent(new CustomEvent(DOCK_LAYOUT_RESIZE_EVENT));
    };

    emitResize();
    const nextFrame = window.requestAnimationFrame(emitResize);
    const settleTimer = window.setTimeout(emitResize, delay > 0 ? Math.min(delay, 300) : 260);

    return () => {
      window.cancelAnimationFrame(nextFrame);
      window.clearTimeout(settleTimer);
    };
  }, [delay, isCollapsed, isSideEdgeSidebar]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleActivityBarHover = (event) => {
      const hovered = Boolean(event.detail?.hovered);
      setActivityBarHovered(hovered);
      if (hovered && enabled && isLeftSidebar) {
        revealViaCursor();
      }
    };

    window.addEventListener(ACTIVITY_BAR_HOVER_EVENT, handleActivityBarHover);
    return () => {
      window.removeEventListener(ACTIVITY_BAR_HOVER_EVENT, handleActivityBarHover);
    };
  }, [enabled, isLeftSidebar, revealViaCursor]);

  const onMouseEnter = useCallback(() => {
    if (!enabled || !isSidebar) return;
    revealViaCursor();
  }, [enabled, isSidebar, revealViaCursor]);

  const onMouseLeave = useCallback((event) => {
    if (!enabled || !isSidebar) return;
    if (isPinned) return;
    if (isLeftSidebar && activityBarHoveredRef.current) return;
    // Don't collapse out from under an active interaction: if focus is
    // still inside the group (e.g. the user is typing in the commit
    // composer), a stray mouseleave shouldn't tuck the panel away.
    const groupEl = event?.currentTarget;
    const focusStillInside = () =>
      groupEl && typeof groupEl.contains === 'function'
        ? groupEl.contains(document.activeElement)
        : false;
    if (focusStillInside()) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (isLeftSidebar && activityBarHoveredRef.current) return;
      if (focusStillInside()) return;
      setCollapsed(true);
    }, delay);
  }, [enabled, isSidebar, clearTimer, delay, isLeftSidebar, isPinned]);

  // If the user disables the feature mid-session, immediately uncollapse
  useEffect(() => {
    if (!enabled && isCollapsed) {
      setCollapsed(false);
      clearTimer();
    }
  }, [enabled, isCollapsed, clearTimer]);

  // If the group becomes a non-sidebar (e.g., user dragged an editor tab
  // into it), wake it up so we don't strand a collapsed pane behind code
  useEffect(() => {
    if (!isSidebar && isCollapsed) {
      setCollapsed(false);
      clearTimer();
    }
  }, [isSidebar, isCollapsed, clearTimer]);

  // Clean up on unmount
  useEffect(() => clearTimer, [clearTimer]);

  return {
    isCollapsed: isSidebar && enabled && isCollapsed && !isPinned,
    isSidebar,
    isPinned,
    bind: { onMouseEnter, onMouseLeave },
  };
}
