'use client';

/**
 * @fileoverview Keyboard navigation for the docking window manager.
 *
 * Provides global keyboard shortcuts for:
 * - Moving focus between panel groups (Ctrl+Arrow)
 * - Cycling tabs within a group (Ctrl+Tab / Ctrl+Shift+Tab)
 * - Closing the active tab (Ctrl+W)
 * - Maximizing / restoring a panel (Ctrl+Shift+M)
 * - Resetting the layout (Ctrl+Shift+R)
 * - Quick panel access (Ctrl+B toggle sidebar, Ctrl+J toggle bottom)
 * - Splitting (Ctrl+\ for horizontal, Ctrl+Shift+\ for vertical)
 *
 * All shortcuts use Cmd on macOS (detected at runtime).
 *
 * The hook registers at the window level and cleans up on unmount.
 */

import { useCallback, useEffect, useRef } from 'react';

// ────────────────────────────────────────────────────────
//  Platform detection
// ────────────────────────────────────────────────────────

function isMac() {
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.platform || navigator.userAgent);
}

/**
 * @param {KeyboardEvent} e
 * @returns {boolean} true when Ctrl (or Cmd on macOS) is held
 */
function hasCtrl(e) {
  return isMac() ? e.metaKey : e.ctrlKey;
}

// ────────────────────────────────────────────────────────
//  Direction helpers
// ────────────────────────────────────────────────────────

/** Map arrow-key code to direction vector { dx, dy } */
const ARROWS = {
  ArrowLeft:  { dx: -1, dy: 0 },
  ArrowRight: { dx: 1,  dy: 0 },
  ArrowUp:    { dx: 0,  dy: -1 },
  ArrowDown:  { dx: 0,  dy: 1 },
};

// ────────────────────────────────────────────────────────
//  Focus movement across tab groups
// ────────────────────────────────────────────────────────

/**
 * Collect bounding rects of all `.docking-tab-group` elements.
 * @returns {Array<{ id: string, rect: DOMRect }>}
 */
function getTabGroupRects() {
  const groups = document.querySelectorAll('[data-tabgroup-id]');
  return Array.from(groups).map(el => ({
    id: el.dataset.tabgroupId,
    rect: el.getBoundingClientRect(),
  }));
}

/**
 * Given the currently focused group ID and a direction vector,
 * find the nearest neighbour tab group in that direction.
 *
 * Uses centre-point distance weighted by axis alignment.
 *
 * @param {string} currentId
 * @param {{ dx: number, dy: number }} dir
 * @returns {string | null} neighbour ID or null
 */
function findNeighbour(currentId, dir) {
  const rects = getTabGroupRects();
  const current = rects.find(r => r.id === currentId);
  if (!current) return rects[0]?.id ?? null;

  const cx = current.rect.left + current.rect.width / 2;
  const cy = current.rect.top + current.rect.height / 2;

  let best = null;
  let bestScore = Infinity;

  for (const candidate of rects) {
    if (candidate.id === currentId) continue;

    const nx = candidate.rect.left + candidate.rect.width / 2;
    const ny = candidate.rect.top + candidate.rect.height / 2;

    // Vector from current centre to candidate centre
    const vx = nx - cx;
    const vy = ny - cy;

    // Must be in the general direction (positive dot product)
    const dot = vx * dir.dx + vy * dir.dy;
    if (dot <= 0) continue;

    // Score: prefer close neighbours aligned with the direction
    const dist = Math.sqrt(vx * vx + vy * vy);
    // Cross component penalty (orthogonal distance)
    const cross = Math.abs(vx * dir.dy - vy * dir.dx);
    const score = dist + cross * 2;

    if (score < bestScore) {
      bestScore = score;
      best = candidate.id;
    }
  }

  return best;
}

// ────────────────────────────────────────────────────────
//  Tab cycling
// ────────────────────────────────────────────────────────

/**
 * Get ordered tab IDs for a tab group from the DOM.
 * @param {string} groupId
 * @returns {string[]}
 */
function getTabOrder(groupId) {
  const group = document.querySelector(`[data-tabgroup-id="${groupId}"]`);
  if (!group) return [];
  const tabs = group.querySelectorAll('[data-tab-id]');
  return Array.from(tabs).map(el => el.dataset.tabId);
}

// ────────────────────────────────────────────────────────
//  Hook: useKeyboardNavigation
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyboardActions
 * @property {function(string): void}  setFocusedGroup   - Focus a tab group by ID
 * @property {function(string): void}  activateTab        - Activate a tab by ID
 * @property {function(string): void}  closeTab           - Close a tab by ID
 * @property {function(): void}        toggleMaximize     - Maximize / restore focused group
 * @property {function(): void}        resetLayout        - Reset layout to default
 * @property {function(string, 'row' | 'column'): void} splitGroup - Split the group
 * @property {function(): string|null} getFocusedGroup    - Get the currently focused group ID
 * @property {function(string): string|null} getActiveTab - Get active tab ID in a group
 */

/**
 * Register global docking keyboard shortcuts.
 *
 * @param {KeyboardActions} actions - Callbacks wired to docking state
 * @param {Object}  options
 * @param {boolean} [options.enabled=true] - Set false to disable all shortcuts
 * @returns {void}
 */
export function useKeyboardNavigation(actions, options = {}) {
  const { enabled = true } = options;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const handleKeyDown = useCallback((e) => {
    if (!actionsRef.current) return;

    const ctrl = hasCtrl(e);
    const shift = e.shiftKey;
    const alt = e.altKey;
    const key = e.key;
    const a = actionsRef.current;

    // ── Focus movement: Ctrl+Arrow ──
    if (ctrl && !shift && !alt && ARROWS[key]) {
      e.preventDefault();
      const currentId = a.getFocusedGroup?.();
      if (!currentId) return;
      const next = findNeighbour(currentId, ARROWS[key]);
      if (next) a.setFocusedGroup(next);
      return;
    }

    // ── Tab cycling: Ctrl+Tab / Ctrl+Shift+Tab ──
    if (ctrl && key === 'Tab') {
      e.preventDefault();
      const groupId = a.getFocusedGroup?.();
      if (!groupId) return;
      const tabs = getTabOrder(groupId);
      const activeId = a.getActiveTab?.(groupId);
      if (!tabs.length) return;
      const currentIdx = tabs.indexOf(activeId);
      const delta = shift ? -1 : 1;
      const nextIdx = (currentIdx + delta + tabs.length) % tabs.length;
      a.activateTab(tabs[nextIdx]);
      return;
    }

    // ── Close tab: Ctrl+W ──
    if (ctrl && !shift && !alt && key === 'w') {
      // Don't capture if the user is in an input/textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      e.preventDefault();
      const groupId = a.getFocusedGroup?.();
      if (!groupId) return;
      const activeId = a.getActiveTab?.(groupId);
      if (activeId) a.closeTab(activeId);
      return;
    }

    // ── Maximize/Restore: Ctrl+Shift+M ──
    if (ctrl && shift && !alt && key === 'M') {
      e.preventDefault();
      a.toggleMaximize?.();
      return;
    }

    // ── Reset layout: Ctrl+Shift+R ──
    if (ctrl && shift && !alt && key === 'R') {
      e.preventDefault();
      a.resetLayout?.();
      return;
    }

    // ── Split horizontal: Ctrl+\  ──
    if (ctrl && !shift && !alt && key === '\\') {
      e.preventDefault();
      const groupId = a.getFocusedGroup?.();
      if (groupId) a.splitGroup?.(groupId, 'row');
      return;
    }

    // ── Split vertical: Ctrl+Shift+\  ──
    if (ctrl && shift && !alt && key === '\\') {
      e.preventDefault();
      const groupId = a.getFocusedGroup?.();
      if (groupId) a.splitGroup?.(groupId, 'column');
      return;
    }

    // ── Toggle sidebar: Ctrl+B ──
    if (ctrl && !shift && !alt && key === 'b') {
      e.preventDefault();
      // Dispatch custom event; the workspace page can handle it
      window.dispatchEvent(new CustomEvent('docking:toggle-sidebar'));
      return;
    }

    // ── Toggle bottom panel: Ctrl+J ──
    if (ctrl && !shift && !alt && key === 'j') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('docking:toggle-bottom'));
      return;
    }

    // ── Focus next group: F6 ──
    if (!ctrl && !shift && !alt && key === 'F6') {
      e.preventDefault();
      const rects = getTabGroupRects();
      const currentId = a.getFocusedGroup?.();
      const idx = rects.findIndex(r => r.id === currentId);
      const next = rects[(idx + 1) % rects.length];
      if (next) a.setFocusedGroup(next.id);
      return;
    }

    // ── Focus previous group: Shift+F6 ──
    if (!ctrl && shift && !alt && key === 'F6') {
      e.preventDefault();
      const rects = getTabGroupRects();
      const currentId = a.getFocusedGroup?.();
      const idx = rects.findIndex(r => r.id === currentId);
      const next = rects[(idx - 1 + rects.length) % rects.length];
      if (next) a.setFocusedGroup(next.id);
      return;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, handleKeyDown]);
}

// ────────────────────────────────────────────────────────
//  Hook: useFocusIndicator
// ────────────────────────────────────────────────────────

/**
 * Adds / removes a CSS class on the focused tab group element
 * so it gets a visual focus ring.
 *
 * @param {string | null} focusedGroupId
 */
export function useFocusIndicator(focusedGroupId) {
  const prevRef = useRef(null);

  useEffect(() => {
    // Remove from previous
    if (prevRef.current) {
      const prev = document.querySelector(`[data-tabgroup-id="${prevRef.current}"]`);
      prev?.classList.remove('docking-tabgroup--focused');
    }
    // Add to current
    if (focusedGroupId) {
      const el = document.querySelector(`[data-tabgroup-id="${focusedGroupId}"]`);
      el?.classList.add('docking-tabgroup--focused');
    }
    prevRef.current = focusedGroupId;
  }, [focusedGroupId]);
}
