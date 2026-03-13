/**
 * @fileoverview FloatingWindow — a draggable/resizable window overlay.
 * Rendered as a portal over the main layout.
 */

'use client';

import React, { useMemo, memo } from 'react';
import { useSelector } from 'react-redux';
import { selectTabs } from '../state/layout-slice';
import { useFloatingWindow } from '../hooks/use-floating-window';
import { useDockingActions } from '../hooks/use-docking';
import { useDragPanel } from '../hooks/use-drag-panel';
import { PanelContainer } from './PanelContainer';
import { PanelGrip } from './PanelGrip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, ArrowDownToLine, X, Minimize2, Maximize2 } from 'lucide-react';

/**
 * @param {Object} props
 * @param {import('../types').FloatingWindow} props.floatingWindow
 */
export const FloatingWindow = memo(function FloatingWindow({ floatingWindow }) {
  const { id, tabId, x, y, width, height, zIndex, isMinimized } = floatingWindow;
  const tabs = useSelector(selectTabs);
  const tab = tabs[tabId];
  const { dockFloat, closeTab, registry } = useDockingActions();

  const {
    isDragging,
    isResizing,
    handleTitleMouseDown,
    handleResizeMouseDown,
    handleFocus,
  } = useFloatingWindow({ floatId: id, floatingWindow });

  const { dragProps } = useDragPanel({
    tabId,
    tabGroupId: `float-${id}`,
  });

  const panelDef = tab ? registry.get(tab.panelType) : null;

  if (!tab) return null;

  // Resize handle positions
  const resizeHandles = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

  const resizeHandleStyles = {
    n: { top: -2, left: 4, right: 4, height: 4, cursor: 'ns-resize' },
    ne: { top: -2, right: -2, width: 8, height: 8, cursor: 'nesw-resize' },
    e: { top: 4, right: -2, bottom: 4, width: 4, cursor: 'ew-resize' },
    se: { bottom: -2, right: -2, width: 8, height: 8, cursor: 'nwse-resize' },
    s: { bottom: -2, left: 4, right: 4, height: 4, cursor: 'ns-resize' },
    sw: { bottom: -2, left: -2, width: 8, height: 8, cursor: 'nesw-resize' },
    w: { top: 4, left: -2, bottom: 4, width: 4, cursor: 'ew-resize' },
    nw: { top: -2, left: -2, width: 8, height: 8, cursor: 'nwse-resize' },
  };

  return (
    <div
      className={`dock-floating-window ${isDragging ? 'dock-floating-window--dragging' : ''}`}
      onMouseDown={handleFocus}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: isMinimized ? '35px' : `${height}px`,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '6px',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
        border: '1px solid var(--dock-border, #2d2d2d)',
        backgroundColor: 'var(--dock-panel-bg, #1e1e1e)',
      }}
    >
      {/* Title bar */}
      <div
        className="dock-floating-window__titlebar"
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          height: '35px',
          minHeight: '35px',
          padding: '0 8px',
          backgroundColor: 'var(--dock-tab-bar-bg, #252526)',
          borderBottom: '1px solid var(--dock-border, #2d2d2d)',
          cursor: 'move',
          userSelect: 'none',
          fontSize: '12px',
          color: 'var(--dock-tab-active-fg, #fff)',
        }}
      >
        <div
          {...dragProps}
          data-no-drag
          title="Drag to dock"
          style={{ cursor: 'grab', display: 'flex', alignItems: 'center' }}
        >
          <PanelGrip orientation="vertical" visible={true} />
        </div>

        {/* Icon */}
        {(tab.icon || panelDef?.icon) && (
          <span
            className={`codicon codicon-${tab.icon || panelDef?.icon}`}
            style={{ fontSize: '14px', opacity: 0.8 }}
          />
        )}

        {/* Title */}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tab.title}
        </span>

        {/* Window actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-no-drag
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              title="Window actions"
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
                padding: 0,
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={4}
            className="min-w-[140px] bg-[#1e1e1e] border-[#2d2d2d] text-[#ccc]"
            style={{ zIndex: 99999 }}
          >
            <DropdownMenuItem
              onClick={() => dockFloat(id, null)}
              className="gap-2 text-xs cursor-pointer hover:bg-[#2a2d2e] focus:bg-[#2a2d2e]"
            >
              <ArrowDownToLine size={14} />
              Dock back
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[#2d2d2d]" />
            {tab.closable !== false && (
              <DropdownMenuItem
                onClick={() => closeTab(tabId)}
                variant="destructive"
                className="gap-2 text-xs cursor-pointer hover:bg-[#2a2d2e] focus:bg-[#2a2d2e]"
              >
                <X size={14} />
                Close
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          <PanelContainer tab={tab} isActive={true} tabGroupId={`float-${id}`} />
        </div>
      )}

      {/* Resize handles */}
      {!isMinimized &&
        resizeHandles.map((dir) => (
          <div
            key={dir}
            onMouseDown={handleResizeMouseDown(dir)}
            style={{
              position: 'absolute',
              ...resizeHandleStyles[dir],
              zIndex: 1,
            }}
          />
        ))}
    </div>
  );
});

export default FloatingWindow;
