/**
 * @fileoverview TabBar — horizontal row of draggable tabs.
 * Includes add-tab button and overflow scrolling.
 */

'use client';

import React, { useCallback, useRef, memo } from 'react';
import { Tab } from './Tab';
import { useDocking } from '../hooks/use-docking';
import { TAB_HEIGHT } from '../types';

/**
 * Tab bar for a tab group.
 *
 * @param {Object} props
 * @param {string} props.tabGroupId
 * @param {import('../types').TabDefinition[]} props.tabs
 * @param {string|null} props.activeTabId
 * @param {boolean} props.isFocused
 * @param {function} [props.onContextMenu]
 */
export const TabBar = memo(function TabBar({
  tabGroupId,
  tabs,
  activeTabId,
  isFocused,
  onContextMenu,
}) {
  const { toggleMaximize, setFocusedTabGroup } = useDocking();
  const scrollRef = useRef(null);

  const handleFocus = useCallback(() => {
    setFocusedTabGroup(tabGroupId);
  }, [setFocusedTabGroup, tabGroupId]);

  const handleDoubleClickEmpty = useCallback(
    (e) => {
      // Double-click empty area to maximize
      if (e.target === e.currentTarget || e.target === scrollRef.current) {
        toggleMaximize(tabGroupId);
      }
    },
    [toggleMaximize, tabGroupId]
  );

  return (
    <div
      data-tab-bar
      className={`dock-tab-bar ${isFocused ? 'dock-tab-bar--focused' : ''}`}
      onClick={handleFocus}
      onDoubleClick={handleDoubleClickEmpty}
      onContextMenu={onContextMenu}
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: `${TAB_HEIGHT}px`,
        minHeight: `${TAB_HEIGHT}px`,
        backgroundColor: 'var(--dock-tab-bar-bg, #252526)',
        borderBottom: '1px solid var(--dock-border, #2d2d2d)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {/* Scrollable tab area */}
      <div
        ref={scrollRef}
        className="dock-tab-bar__scroll"
        style={{
          display: 'flex',
          alignItems: 'stretch',
          flex: 1,
          overflow: 'hidden',
          overflowX: 'auto',
          scrollbarWidth: 'none', // Firefox
        }}
      >
        {tabs.map((tab, idx) => (
          <Tab
            key={tab.id}
            tab={tab}
            tabGroupId={tabGroupId}
            index={idx}
            isActive={tab.id === activeTabId}
            isFocusedGroup={isFocused}
          />
        ))}
      </div>

      {/* Tab bar actions */}
      <div
        className="dock-tab-bar__actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          padding: '0 4px',
          flexShrink: 0,
        }}
      >
        {/* Maximize/restore button */}
        <button
          data-no-drag
          className="dock-tab-bar__action"
          onClick={(e) => {
            e.stopPropagation();
            toggleMaximize(tabGroupId);
          }}
          title="Toggle maximize"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '22px',
            height: '22px',
            border: 'none',
            borderRadius: '3px',
            backgroundColor: 'transparent',
            color: 'var(--dock-tab-fg, #969696)',
            cursor: 'pointer',
            opacity: 0.6,
            padding: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect
              x="1.5"
              y="1.5"
              width="9"
              height="9"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
            />
          </svg>
        </button>
      </div>
    </div>
  );
});

export default TabBar;
