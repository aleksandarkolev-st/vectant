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
import { cn } from "@/lib/utils";

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
      data-slot="context-menu-content"
      className={cn(
        "bg-popover text-popover-foreground fixed z-50 min-w-[8rem]",
        "overflow-hidden rounded-md border p-1 shadow-md",
        "animate-in fade-in-0 zoom-in-95 duration-75",
      )}
      style={{
        left: adjusted.x,
        top: adjusted.y,
        zIndex: 99999,
      }}
    >
      {items.map((item) => (
        <div key={item.id}>
          <button
            role="menuitem"
            disabled={item.disabled}
            data-slot="context-menu-item"
            data-disabled={item.disabled ? "" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            className={cn(
              "relative flex w-full cursor-default select-none items-center gap-2",
              "rounded-sm px-2 py-1.5 text-sm outline-hidden",
              "hover:bg-accent hover:text-accent-foreground",
              "focus:bg-accent focus:text-accent-foreground",
              "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            )}
          >
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span
                data-slot="context-menu-shortcut"
                className="text-muted-foreground ml-auto text-xs tracking-widest"
              >
                {item.shortcut}
              </span>
            )}
          </button>
          {item.dividerAfter && (
            <div
              role="separator"
              data-slot="context-menu-separator"
              className="bg-border -mx-1 my-1 h-px"
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
