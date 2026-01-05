'use client';

/**
 * DockableProblemsPanelWrapper
 * 
 * Wraps ProblemsPanel with full Visual Studio-style docking capabilities:
 * - Docked (bottom, left, right)
 * - Floating window with move/resize
 * - Auto-hide with edge strip
 * - State persistence per workspace
 * - Keyboard shortcuts
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ProblemsPanel } from './ProblemsPanel';
import { useDockKeyboardShortcuts } from '@/hooks/useDockKeyboardShortcuts';
import { 
  Pin, 
  PinOff, 
  X, 
  Minus, 
  Maximize2, 
  GripHorizontal,
  AlertCircle,
} from 'lucide-react';

// ============================================================================
// Constants
// ============================================================================

const COLORS = {
  panelBg: '#121212',
  headerBg: '#1a1a1a',
  border: '#3A3A3A',
  accent: '#3A7AFE',
  text: '#E6E6E6',
  mutedText: '#707070',
  errorAccent: '#C6362B',
};

const DRAG_THRESHOLD = 8;
const AUTO_HIDE_EXPAND_DELAY = 150;
const AUTO_HIDE_COLLAPSE_DELAY = 300;

const PANEL_STATE = {
  DOCKED: 'docked',
  FLOATING: 'floating',
  AUTO_HIDE: 'auto-hide',
};

// ============================================================================
// Utility Functions
// ============================================================================

function increaseBrightness(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * percent));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * percent));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function getStorageKey(workspaceId) {
  return `synthi-problems-panel-${workspaceId}`;
}

function loadPanelState(workspaceId, defaults) {
  if (typeof window === 'undefined') return defaults;
  try {
    const stored = localStorage.getItem(getStorageKey(workspaceId));
    if (stored) {
      return { ...defaults, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn('Failed to load panel state:', e);
  }
  return defaults;
}

function savePanelState(workspaceId, state) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getStorageKey(workspaceId), JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save panel state:', e);
  }
}

// ============================================================================
// DockZoneOverlays
// ============================================================================

function DockZoneOverlays({ activeZone, onZoneHover, onZoneDrop }) {
  const zones = [
    { id: 'left', style: { left: 0, top: '20%', width: '80px', height: '60%' } },
    { id: 'right', style: { right: 0, top: '20%', width: '80px', height: '60%' } },
    { id: 'bottom', style: { left: '20%', bottom: 0, width: '60%', height: '80px' } },
  ];

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[9998]">
      {zones.map(zone => (
        <div
          key={zone.id}
          className="absolute pointer-events-auto transition-all duration-150"
          style={{
            ...zone.style,
            backgroundColor: activeZone === zone.id 
              ? `${COLORS.accent}50` 
              : `${COLORS.accent}30`,
            border: `2px dashed ${activeZone === zone.id ? COLORS.accent : '#666'}`,
            opacity: 0.3 + (activeZone === zone.id ? 0.3 : 0),
          }}
          onMouseEnter={() => onZoneHover(zone.id)}
          onMouseLeave={() => onZoneHover(null)}
          onMouseUp={() => onZoneDrop(zone.id)}
        >
          <div className="w-full h-full flex items-center justify-center text-white/70 text-sm font-medium uppercase">
            Dock {zone.id}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function DockableProblemsPanelWrapper({
  diagnostics = [],
  summary = {},
  isAnalyzing = false,
  tierStatus = {},
  filePath,
  onNavigate,
  onRefresh,
  visible,
  onClose,
  workspaceId = 'default',
}) {
  // Panel state
  const [panelState, setPanelState] = useState(() => 
    loadPanelState(workspaceId, {
      mode: PANEL_STATE.DOCKED,
      dockZone: 'bottom',
      position: { x: 100, y: 100 },
      size: { width: 600, height: 300 },
      pinned: true,
    })
  );
  
  const [isHovered, setIsHovered] = useState(false);
  const [autoHideExpanded, setAutoHideExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [activeZone, setActiveZone] = useState(null);
  
  const panelRef = useRef(null);
  const dragStartRef = useRef(null);
  const expandTimeoutRef = useRef(null);
  const collapseTimeoutRef = useRef(null);

  // Persist state changes
  useEffect(() => {
    savePanelState(workspaceId, panelState);
  }, [panelState, workspaceId]);

  // Keyboard shortcuts
  useDockKeyboardShortcuts({
    onFocusPanel: () => {
      if (!visible) {
        onClose?.(); // Toggle - will show panel
      }
    },
    onToggleDockState: () => {
      setPanelState(prev => ({
        ...prev,
        mode: prev.mode === PANEL_STATE.DOCKED ? PANEL_STATE.FLOATING : PANEL_STATE.DOCKED,
      }));
    },
    onClosePanel: onClose,
    isPanelVisible: visible,
    isPanelFloating: panelState.mode === PANEL_STATE.FLOATING,
  });

  // Toggle pin (auto-hide)
  const togglePinned = useCallback(() => {
    setPanelState(prev => {
      const nowPinned = !prev.pinned;
      return {
        ...prev,
        pinned: nowPinned,
        mode: nowPinned ? PANEL_STATE.DOCKED : PANEL_STATE.AUTO_HIDE,
      };
    });
  }, []);

  // Toggle dock/float
  const toggleDockState = useCallback(() => {
    setPanelState(prev => ({
      ...prev,
      mode: prev.mode === PANEL_STATE.DOCKED ? PANEL_STATE.FLOATING : PANEL_STATE.DOCKED,
    }));
  }, []);

  // Auto-hide handlers
  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    if (panelState.mode === PANEL_STATE.AUTO_HIDE && !autoHideExpanded) {
      clearTimeout(collapseTimeoutRef.current);
      expandTimeoutRef.current = setTimeout(() => {
        setAutoHideExpanded(true);
      }, AUTO_HIDE_EXPAND_DELAY);
    }
  }, [panelState.mode, autoHideExpanded]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (panelState.mode === PANEL_STATE.AUTO_HIDE && autoHideExpanded) {
      clearTimeout(expandTimeoutRef.current);
      collapseTimeoutRef.current = setTimeout(() => {
        setAutoHideExpanded(false);
      }, AUTO_HIDE_COLLAPSE_DELAY);
    }
  }, [panelState.mode, autoHideExpanded]);

  // Drag handling
  const handleDragStart = useCallback((e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      rect,
      wasDocked: panelState.mode === PANEL_STATE.DOCKED,
    };

    const handleDragMove = (moveEvent) => {
      if (!dragStartRef.current) return;

      const dx = moveEvent.clientX - dragStartRef.current.x;
      const dy = moveEvent.clientY - dragStartRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Check if moved beyond threshold (undock)
      if (dragStartRef.current.wasDocked && distance > DRAG_THRESHOLD) {
        setIsDragging(true);
        setPanelState(prev => ({
          ...prev,
          mode: PANEL_STATE.FLOATING,
          position: {
            x: moveEvent.clientX - dragStartRef.current.rect.width / 2,
            y: moveEvent.clientY - 20,
          },
        }));
        dragStartRef.current.wasDocked = false;
      }

      // If floating, update position
      if (!dragStartRef.current.wasDocked) {
        setPanelState(prev => ({
          ...prev,
          position: {
            x: moveEvent.clientX - dragStartRef.current.rect.width / 2,
            y: moveEvent.clientY - 20,
          },
        }));
      }
    };

    const handleDragEnd = () => {
      if (activeZone) {
        setPanelState(prev => ({
          ...prev,
          mode: PANEL_STATE.DOCKED,
          dockZone: activeZone,
        }));
      }
      setIsDragging(false);
      setActiveZone(null);
      dragStartRef.current = null;
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
  }, [panelState.mode, activeZone]);

  // Resize handling
  const handleResize = useCallback((e, direction) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = { ...panelState.size };
    const startPos = { ...panelState.position };

    const handleResizeMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newSize = { ...startSize };
      let newPos = { ...startPos };

      if (direction.includes('e')) {
        newSize.width = Math.max(300, startSize.width + dx);
      }
      if (direction.includes('w')) {
        newSize.width = Math.max(300, startSize.width - dx);
        newPos.x = startPos.x + dx;
      }
      if (direction.includes('s')) {
        newSize.height = Math.max(150, startSize.height + dy);
      }
      if (direction.includes('n')) {
        newSize.height = Math.max(150, startSize.height - dy);
        newPos.y = startPos.y + dy;
      }

      setPanelState(prev => ({ ...prev, size: newSize, position: newPos }));
    };

    const handleResizeEnd = () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };

    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
  }, [panelState.size, panelState.position]);

  // Zone handlers for dock overlays
  const handleZoneHover = useCallback((zone) => {
    if (isDragging) {
      setActiveZone(zone);
    }
  }, [isDragging]);

  const handleZoneDrop = useCallback((zone) => {
    setPanelState(prev => ({
      ...prev,
      mode: PANEL_STATE.DOCKED,
      dockZone: zone,
    }));
    setIsDragging(false);
    setActiveZone(null);
  }, []);

  if (!visible) return null;

  const { mode, dockZone, position, size, pinned } = panelState;
  const isFloating = mode === PANEL_STATE.FLOATING;
  const isAutoHide = mode === PANEL_STATE.AUTO_HIDE;
  const headerBgColor = isHovered ? increaseBrightness(COLORS.headerBg, 0.08) : COLORS.headerBg;

  // Auto-hide collapsed strip
  if (isAutoHide && !autoHideExpanded) {
    return (
      <div
        className="fixed z-[100] cursor-pointer transition-all duration-150"
        style={{
          ...(dockZone === 'bottom' 
            ? { bottom: 0, left: '50%', transform: 'translateX(-50%)', height: '24px', width: '120px' }
            : dockZone === 'left'
            ? { left: 0, top: '50%', transform: 'translateY(-50%)', width: '24px', height: '120px' }
            : { right: 0, top: '50%', transform: 'translateY(-50%)', width: '24px', height: '120px' }
          ),
          backgroundColor: COLORS.headerBg,
          border: `1px solid ${COLORS.border}`,
        }}
        onMouseEnter={handleMouseEnter}
      >
        <div className="w-full h-full flex items-center justify-center">
          <AlertCircle className="w-4 h-4" style={{ color: summary.errors > 0 ? COLORS.errorAccent : COLORS.mutedText }} />
          {summary.errors > 0 && (
            <span 
              className="ml-1 text-xs font-medium"
              style={{ 
                color: COLORS.errorAccent,
                writingMode: dockZone === 'bottom' ? 'horizontal-tb' : 'vertical-rl',
              }}
            >
              {summary.errors}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Panel header component
  const PanelHeader = (
    <div
      className="flex items-center justify-between px-2 py-1.5 select-none cursor-move"
      style={{
        backgroundColor: headerBgColor,
        borderBottom: `1px solid ${COLORS.border}`,
      }}
      onMouseDown={handleDragStart}
    >
      <div className="flex items-center gap-2">
        <GripHorizontal className="w-3 h-3" style={{ color: COLORS.mutedText }} />
        <span className="text-xs font-medium" style={{ color: COLORS.text }}>Problems</span>
        {summary.errors > 0 && (
          <span 
            className="px-1.5 py-0.5 rounded text-xs"
            style={{ backgroundColor: `${COLORS.errorAccent}20`, color: COLORS.errorAccent }}
          >
            {summary.errors}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={togglePinned}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: COLORS.mutedText }}
          title={pinned ? 'Unpin (auto-hide)' : 'Pin'}
        >
          {pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
        </button>
        <button
          onClick={toggleDockState}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: COLORS.mutedText }}
          title={isFloating ? 'Dock' : 'Float'}
        >
          {isFloating ? <Maximize2 className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          style={{ color: COLORS.mutedText }}
          title="Close (Esc)"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );

  // Floating window
  if (isFloating) {
    return (
      <>
        {isDragging && (
          <DockZoneOverlays 
            activeZone={activeZone} 
            onZoneHover={handleZoneHover}
            onZoneDrop={handleZoneDrop}
          />
        )}
        {createPortal(
          <div
            ref={panelRef}
            className="fixed flex flex-col shadow-2xl overflow-hidden"
            style={{
              left: position.x,
              top: position.y,
              width: size.width,
              height: size.height,
              zIndex: 1000,
              backgroundColor: COLORS.panelBg,
              border: `1px solid ${COLORS.border}`,
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {PanelHeader}
            <div className="flex-1 overflow-hidden">
              <ProblemsPanel
                diagnostics={diagnostics}
                summary={summary}
                isAnalyzing={isAnalyzing}
                tierStatus={tierStatus}
                filePath={filePath}
                onNavigate={onNavigate}
                onRefresh={onRefresh}
                className="h-full border-0"
              />
            </div>
            
            {/* Resize handles */}
            {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(dir => (
              <div
                key={dir}
                className={cn(
                  'absolute',
                  dir === 'n' && 'top-0 left-2 right-2 h-1 cursor-n-resize',
                  dir === 's' && 'bottom-0 left-2 right-2 h-1 cursor-s-resize',
                  dir === 'e' && 'right-0 top-2 bottom-2 w-1 cursor-e-resize',
                  dir === 'w' && 'left-0 top-2 bottom-2 w-1 cursor-w-resize',
                  dir === 'ne' && 'top-0 right-0 w-2 h-2 cursor-ne-resize',
                  dir === 'nw' && 'top-0 left-0 w-2 h-2 cursor-nw-resize',
                  dir === 'se' && 'bottom-0 right-0 w-2 h-2 cursor-se-resize',
                  dir === 'sw' && 'bottom-0 left-0 w-2 h-2 cursor-sw-resize',
                )}
                onMouseDown={(e) => handleResize(e, dir)}
              />
            ))}
          </div>,
          document.body
        )}
      </>
    );
  }

  // Docked panel (rendered inline by parent)
  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full overflow-hidden"
      style={{
        backgroundColor: COLORS.panelBg,
        borderTop: `1px solid ${COLORS.border}`,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {PanelHeader}
      <div className="flex-1 overflow-hidden">
        <ProblemsPanel
          diagnostics={diagnostics}
          summary={summary}
          isAnalyzing={isAnalyzing}
          tierStatus={tierStatus}
          filePath={filePath}
          onNavigate={onNavigate}
          onRefresh={onRefresh}
          className="h-full border-0"
        />
      </div>
    </div>
  );
}

export default DockableProblemsPanelWrapper;
