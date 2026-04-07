/**
 * @fileoverview Tab — individual tab in a tab bar.
 * Draggable, closable, with context menu support.
 */

"use client";

import React, { useCallback, memo } from "react";
import { useDragPanel } from "../hooks/use-drag-panel";
import { useDockingActions } from "../hooks/use-docking";

/**
 * A single tab element in the tab bar.
 *
 * @param {Object} props
 * @param {import('../types').TabDefinition} props.tab
 * @param {string} props.tabGroupId
 * @param {number} props.index
 * @param {boolean} props.isActive
 * @param {boolean} props.isFocusedGroup
 */
export const Tab = memo(function Tab({
  tab,
  tabGroupId,
  index,
  isActive,
  isFocusedGroup,
}) {
  const { closeTab, activateTab, floatTab, registry } = useDockingActions();

  // Check if this tab's panel type is non-draggable (e.g. editor)
  const panelDef = registry.get(tab.panelType);
  const isFixed = tab.closable === false || panelDef?.draggable === false;

  const { dragProps, isDragging } = useDragPanel({
    tabId: tab.id,
    tabGroupId,
    tabIndex: index,
    disabled: isFixed,
  });

  const handleClick = useCallback(
    (e) => {
      e.stopPropagation();
      activateTab(tabGroupId, tab.id);
    },
    [activateTab, tabGroupId, tab.id],
  );

  const handleClose = useCallback(
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeTab(tab.id);
    },
    [closeTab, tab.id],
  );

  const handleMiddleClick = useCallback(
    (e) => {
      if (e.button === 1 && tab.closable !== false) {
        e.preventDefault();
        closeTab(tab.id);
      }
    },
    [closeTab, tab.id, tab.closable],
  );

  const handleDoubleClick = useCallback(
    (e) => {
      e.stopPropagation();
      // Don't float fixed tabs (e.g. editor)
      if (isFixed) return;
      // Double-click to float
      const rect = e.currentTarget
        .closest("[data-drop-node-id]")
        ?.getBoundingClientRect();
      if (rect) {
        floatTab(tab.id, {
          x: rect.left + 50,
          y: rect.top + 50,
          width: Math.max(400, rect.width * 0.6),
          height: Math.max(300, rect.height * 0.6),
        });
      }
    },
    [floatTab, tab.id, isFixed],
  );

  // Get icon from registry
  const icon = tab.icon || panelDef?.icon;

  return (
    <div
      {...dragProps}
      data-tab-id={tab.id}
      className={`dock-tab ${isActive ? "dock-tab--active" : ""} ${
        isDragging ? "dock-tab--dragging" : ""
      } ${isFocusedGroup && isActive ? "dock-tab--focused" : ""}`}
      onClick={handleClick}
      onMouseDown={handleMiddleClick}
      onDoubleClick={handleDoubleClick}
      title={tab.title}
      role="tab"
      aria-selected={isActive}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        height: "100%",
        padding: "0 10px",
        fontSize: "12px",
        color: isActive
          ? "var(--dock-tab-active-fg, #fff)"
          : "var(--dock-tab-fg, #969696)",
        backgroundColor: isActive
          ? "var(--dock-tab-active-bg, #1e1e1e)"
          : "transparent",
        borderBottom:
          isActive && isFocusedGroup
            ? "1px solid var(--dock-accent, #007acc)"
            : "1px solid transparent",
        cursor: "pointer",
        userSelect: "none",
        opacity: isDragging ? 0.5 : 1,
        whiteSpace: "nowrap",
        maxWidth: "160px",
        position: "relative",
        flexShrink: 0,
      }}
    >
      {/* Icon */}
      {icon && (
        <span
          className={`codicon codicon-${icon}`}
          style={{ fontSize: "14px", flexShrink: 0 }}
        />
      )}

      {/* Title */}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {tab.title}
      </span>

      {/* Pin indicator */}
      {tab.pinned && (
        <span
          className="codicon codicon-pinned"
          style={{ fontSize: "10px", opacity: 0.5 }}
        />
      )}

      {/* Close button */}
      {tab.closable !== false && !tab.pinned && (
        <button
          data-no-drag
          className="dock-tab__close"
          onClick={handleClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={`Close ${tab.title}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "18px",
            height: "18px",
            padding: 0,
            border: "none",
            borderRadius: "3px",
            backgroundColor: "transparent",
            color: "inherit",
            cursor: "pointer",
            opacity: isActive ? 0.7 : 0,
            flexShrink: 0,
            marginLeft: "2px",
            marginRight: "-4px",
            transition: "opacity 0.1s",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M1 1L9 9M9 1L1 9"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
});

export default Tab;
