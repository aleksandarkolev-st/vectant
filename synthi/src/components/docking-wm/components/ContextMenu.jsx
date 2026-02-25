"use client";

/**
 * @fileoverview Context menu for docking tab groups and tabs.
 *
 * Rendered as a portal (`position: fixed`) and dismissed on
 * click-outside, Escape, or scroll.
 *
 * Provides common actions:
 *  - Close / Close Others / Close All / Close to the Right
 *  - Split Left / Right / Up / Down
 *  - Maximize / Restore
 *  - Float / Pop out to window
 *  - Move to new group
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ────────────────────────────────────────────────────────
//  Menu item data
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ContextMenuItem
 * @property {string}   id       - Action identifier
 * @property {string}   label    - Display text
 * @property {string}   [shortcut] - Keyboard shortcut hint
 * @property {boolean}  [dividerAfter] - Show divider after this item
 * @property {boolean}  [disabled] - Grey out
 * @property {function} action   - Callback when clicked
 */

/**
 * Build the menu items for a tab context menu.
 *
 * @param {Object} params
 * @param {string} params.tabId
 * @param {string} params.tabGroupId
 * @param {number} params.tabCount    - Total tabs in the group
 * @param {number} params.tabIndex    - Index of this tab in the group
 * @param {boolean} params.isMaximized
 * @param {Object} params.actions     - Callbacks
 * @returns {ContextMenuItem[]}
 */
export function buildTabContextMenu({
  tabId,
  tabGroupId,
  tabCount,
  tabIndex,
  isMaximized,
  isFixed,
  actions,
}) {
  const items = [];

  // Only show close actions for closable tabs
  if (!isFixed) {
    items.push(
      {
        id: "close",
        label: "Close",
        shortcut: "Ctrl+W",
        action: () => actions.closeTab(tabId),
      },
      {
        id: "close-others",
        label: "Close Others",
        disabled: tabCount <= 1,
        action: () => actions.closeOtherTabs(tabId, tabGroupId),
      },
      {
        id: "close-right",
        label: "Close to the Right",
        disabled: tabIndex >= tabCount - 1,
        action: () => actions.closeTabsToRight(tabId, tabGroupId),
      },
      {
        id: "close-all",
        label: "Close All",
        dividerAfter: true,
        action: () => actions.closeAllTabs(tabGroupId),
      },
    );
  }
  // Only show split/float/move actions for non-fixed tabs
  if (!isFixed) {
    items.push(
      {
        id: "split-right",
        label: "Split Right",
        shortcut: "Ctrl+\\",
        action: () => actions.splitTab(tabId, tabGroupId, "row", "after"),
      },
      {
        id: "split-down",
        label: "Split Down",
        shortcut: "Ctrl+Shift+\\",
        action: () => actions.splitTab(tabId, tabGroupId, "column", "after"),
      },
      {
        id: "split-left",
        label: "Split Left",
        action: () => actions.splitTab(tabId, tabGroupId, "row", "before"),
      },
      {
        id: "split-up",
        label: "Split Up",
        dividerAfter: true,
        action: () => actions.splitTab(tabId, tabGroupId, "column", "before"),
      },
    );
  }

  items.push({
    id: "maximize",
    label: isMaximized ? "Restore" : "Maximize",
    shortcut: "Ctrl+Shift+M",
    action: () => actions.toggleMaximize(tabGroupId),
  });

  if (!isFixed) {
    items.push(
      {
        id: "float",
        label: "Float",
        action: () => actions.floatTab(tabId),
      },
      {
        id: "popout",
        label: "Pop Out to Window",
        dividerAfter: true,
        action: () => actions.popoutTab(tabId),
      },
      {
        id: "move-new-group",
        label: "Move to New Group",
        disabled: tabCount <= 1,
        action: () => actions.moveToNewGroup(tabId, tabGroupId),
      },
    );
  }

  return items;
}

// ────────────────────────────────────────────────────────
//  Context Menu Component
// ────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {ContextMenuItem[]} props.items
 * @param {{ x: number, y: number }} props.position
 * @param {function} props.onClose
 */
export function ContextMenu({ items, position, onClose }) {
  const menuRef = useRef(null);
  const [adjusted, setAdjusted] = useState(position);

  // Adjust position so the menu doesn't overflow the viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = position;
    if (x + rect.width > vw - 4) x = vw - rect.width - 4;
    if (y + rect.height > vh - 4) y = vh - rect.height - 4;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    setAdjusted({ x, y });
  }, [position]);

  // Dismiss on outside click, Escape, or scroll
  useEffect(() => {
    const dismiss = () => onClose();
    const handleKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) dismiss();
    };
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("mousedown", handleClick, true);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("mousedown", handleClick, true);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="docking-context-menu"
      style={{
        position: "fixed",
        left: adjusted.x,
        top: adjusted.y,
        zIndex: 99999,
        minWidth: 200,
        maxWidth: 280,
        background: "var(--docking-bg-elevated, #1e1e2e)",
        border: "1px solid var(--docking-border, #333)",
        borderRadius: 6,
        padding: "4px 0",
        boxShadow: "0 8px 32px rgba(0,0,0,.55)",
        fontSize: 13,
        color: "var(--docking-text-primary, #ccc)",
        fontFamily: "inherit",
      }}
    >
      {items.map((item) => (
        <div key={item.id}>
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={(e) => {
              e.stopPropagation();
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "6px 12px",
              background: "none",
              border: "none",
              color: item.disabled
                ? "var(--docking-text-tertiary, #555)"
                : "inherit",
              cursor: item.disabled ? "default" : "pointer",
              textAlign: "left",
              fontSize: "inherit",
              fontFamily: "inherit",
              lineHeight: "1.4",
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) {
                e.currentTarget.style.background =
                  "var(--docking-bg-hover, rgba(255,255,255,.06))";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "none";
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span
                style={{
                  marginLeft: 24,
                  fontSize: 11,
                  color: "var(--docking-text-tertiary, #666)",
                  whiteSpace: "nowrap",
                }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
          {item.dividerAfter && (
            <div
              style={{
                height: 1,
                margin: "4px 8px",
                background: "var(--docking-border, #333)",
              }}
            />
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ────────────────────────────────────────────────────────
//  Hook: useContextMenu
// ────────────────────────────────────────────────────────

/**
 * Returns state and helpers for managing a context menu.
 *
 * ```jsx
 * const { menuState, openMenu, closeMenu } = useContextMenu();
 *
 * <div onContextMenu={(e) => openMenu(e, items)}>…</div>
 * {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}
 * ```
 */
export function useContextMenu() {
  const [menuState, setMenuState] = useState(null);

  const openMenu = useCallback((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuState({ items, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

  return { menuState, openMenu, closeMenu };
}
