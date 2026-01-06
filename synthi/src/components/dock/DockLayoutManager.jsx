'use client';

/**
 * DockLayoutManager
 * 
 * Visual Studio-style docking system with:
 * - Docked/floating/tabbed/auto-hide states
 * - Drag-to-detach with 8px threshold
 * - Dock zone previews (30% opacity, #3A7AFE highlight)
 * - Tab groups with single-row scrollable tabs
 * - State persistence per workspace
 * - Keyboard support (Ctrl+Alt+E, Ctrl+Shift+D, Esc)
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Pin, PinOff, X, Minus, Maximize2, GripHorizontal } from 'lucide-react';

// ============================================================================
// Constants
// ============================================================================

const DOCK_ZONES = ['left', 'right', 'bottom', 'center'];
const DRAG_THRESHOLD = 8; // px to undock
const AUTO_HIDE_EXPAND_DELAY = 150; // ms
const AUTO_HIDE_COLLAPSE_DELAY = 300; // ms
const DOCK_ZONE_OPACITY = 0.3;
const HIGHLIGHT_COLOR = '#3A7AFE';
const BORDER_COLOR = '#3A3A3A';
const HOVER_BRIGHTNESS_INCREASE = 0.08; // 8%

// Panel state types
const PANEL_STATE = {
  DOCKED: 'docked',
  FLOATING: 'floating',
  AUTO_HIDE: 'auto-hide',
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Increase brightness of hex color by percentage
 */
function increaseBrightness(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * percent));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * percent));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Get storage key for workspace
 */
function getStorageKey(workspaceId, panelId) {
  return `synthi-dock-${workspaceId}-${panelId}`;
}

/**
 * Load panel state from localStorage
 */
function loadPanelState(workspaceId, panelId, defaults) {
  if (typeof window === 'undefined') return defaults;
  try {
    const stored = localStorage.getItem(getStorageKey(workspaceId, panelId));
    if (stored) {
      return { ...defaults, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn('Failed to load panel state:', e);
  }
  return defaults;
}

/**
 * Save panel state to localStorage
 */
function savePanelState(workspaceId, panelId, state) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getStorageKey(workspaceId, panelId), JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save panel state:', e);
  }
}

// ============================================================================
// Context
// ============================================================================

const DockContext = createContext(null);

export function useDock() {
  return useContext(DockContext);
}

// ============================================================================
// DockLayoutProvider
// ============================================================================

export function DockLayoutProvider({ children, workspaceId = 'default' }) {
  const [panels, setPanels] = useState(new Map());
  const [activeDrag, setActiveDrag] = useState(null);
  const [dockZoneHighlight, setDockZoneHighlight] = useState(null);
  const [tabGroups, setTabGroups] = useState(new Map());

  // Register a panel
  const registerPanel = useCallback((panelId, config) => {
    setPanels(prev => {
      const next = new Map(prev);
      const defaults = {
        state: PANEL_STATE.DOCKED,
        dockZone: 'bottom',
        position: { x: 100, y: 100 },
        size: { width: 400, height: 300 },
        pinned: true,
        visible: true,
        monitorIndex: 0,
        ...config,
      };
      const loaded = loadPanelState(workspaceId, panelId, defaults);
      next.set(panelId, { id: panelId, ...loaded });
      return next;
    });
  }, [workspaceId]);

  // Unregister a panel
  const unregisterPanel = useCallback((panelId) => {
    setPanels(prev => {
      const next = new Map(prev);
      next.delete(panelId);
      return next;
    });
  }, []);

  // Update panel state
  const updatePanel = useCallback((panelId, updates) => {
    setPanels(prev => {
      const next = new Map(prev);
      const panel = next.get(panelId);
      if (panel) {
        const updated = { ...panel, ...updates };
        next.set(panelId, updated);
        // Persist state
        savePanelState(workspaceId, panelId, updated);
      }
      return next;
    });
  }, [workspaceId]);

  // Toggle docked/floating
  const toggleDockState = useCallback((panelId) => {
    setPanels(prev => {
      const next = new Map(prev);
      const panel = next.get(panelId);
      if (panel) {
        const newState = panel.state === PANEL_STATE.DOCKED 
          ? PANEL_STATE.FLOATING 
          : PANEL_STATE.DOCKED;
        const updated = { ...panel, state: newState };
        next.set(panelId, updated);
        savePanelState(workspaceId, panelId, updated);
      }
      return next;
    });
  }, [workspaceId]);

  // Toggle pinned (auto-hide)
  const togglePinned = useCallback((panelId) => {
    setPanels(prev => {
      const next = new Map(prev);
      const panel = next.get(panelId);
      if (panel) {
        const nowPinned = !panel.pinned;
        const newState = nowPinned ? PANEL_STATE.DOCKED : PANEL_STATE.AUTO_HIDE;
        const updated = { ...panel, pinned: nowPinned, state: newState };
        next.set(panelId, updated);
        savePanelState(workspaceId, panelId, updated);
      }
      return next;
    });
  }, [workspaceId]);

  // Set visibility
  const setVisible = useCallback((panelId, visible) => {
    updatePanel(panelId, { visible });
  }, [updatePanel]);

  // Close panel
  const closePanel = useCallback((panelId) => {
    setVisible(panelId, false);
  }, [setVisible]);

  // Focus panel
  const focusPanel = useCallback((panelId) => {
    setVisible(panelId, true);
    // Additional focus logic can be added here
  }, [setVisible]);

  // Start drag
  const startDrag = useCallback((panelId, startPos, boundaryRect) => {
    setActiveDrag({ panelId, startPos, boundaryRect, hasMoved: false });
  }, []);

  // End drag
  const endDrag = useCallback(() => {
    if (activeDrag && dockZoneHighlight) {
      // Dock to the highlighted zone
      updatePanel(activeDrag.panelId, {
        state: dockZoneHighlight === 'center' ? PANEL_STATE.DOCKED : PANEL_STATE.DOCKED,
        dockZone: dockZoneHighlight,
      });
    }
    setActiveDrag(null);
    setDockZoneHighlight(null);
  }, [activeDrag, dockZoneHighlight, updatePanel]);

  // Context value
  const value = useMemo(() => ({
    panels,
    tabGroups,
    activeDrag,
    dockZoneHighlight,
    registerPanel,
    unregisterPanel,
    updatePanel,
    toggleDockState,
    togglePinned,
    setVisible,
    closePanel,
    focusPanel,
    startDrag,
    endDrag,
    setDockZoneHighlight,
    workspaceId,
  }), [
    panels,
    tabGroups,
    activeDrag,
    dockZoneHighlight,
    registerPanel,
    unregisterPanel,
    updatePanel,
    toggleDockState,
    togglePinned,
    setVisible,
    closePanel,
    focusPanel,
    startDrag,
    endDrag,
    workspaceId,
  ]);

  return (
    <DockContext.Provider value={value}>
      {children}
      {/* Dock zone overlays during drag */}
      {activeDrag && <DockZoneOverlays />}
    </DockContext.Provider>
  );
}

// ============================================================================
// DockZoneOverlays - Visual dock targets during drag
// ============================================================================

function DockZoneOverlays() {
  const { dockZoneHighlight, setDockZoneHighlight, endDrag } = useDock();

  const zones = [
    { id: 'left', style: { left: 0, top: '20%', width: '80px', height: '60%' } },
    { id: 'right', style: { right: 0, top: '20%', width: '80px', height: '60%' } },
    { id: 'bottom', style: { left: '20%', bottom: 0, width: '60%', height: '80px' } },
    { id: 'center', style: { left: '30%', top: '30%', width: '40%', height: '40%' } },
  ];

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[9998]">
      {zones.map(zone => (
        <div
          key={zone.id}
          className="absolute pointer-events-auto transition-all duration-150"
          style={{
            ...zone.style,
            backgroundColor: dockZoneHighlight === zone.id 
              ? `${HIGHLIGHT_COLOR}50` 
              : `${HIGHLIGHT_COLOR}30`,
            border: `2px dashed ${dockZoneHighlight === zone.id ? HIGHLIGHT_COLOR : '#666'}`,
            opacity: DOCK_ZONE_OPACITY + (dockZoneHighlight === zone.id ? 0.3 : 0),
          }}
          onMouseEnter={() => setDockZoneHighlight(zone.id)}
          onMouseLeave={() => setDockZoneHighlight(null)}
          onMouseUp={endDrag}
        >
          <div className="w-full h-full flex items-center justify-center text-white/70 text-sm font-medium uppercase">
            {zone.id === 'center' ? 'Tab' : `Dock ${zone.id}`}
          </div>
        </div>
      ))}
    </div>,
    document.body
  );
}

// ============================================================================
// DockablePanel - The main panel component
// ============================================================================

export function DockablePanel({
  id,
  title,
  children,
  defaultState = PANEL_STATE.DOCKED,
  defaultDockZone = 'bottom',
  defaultSize = { width: 400, height: 300 },
  defaultPosition = { x: 100, y: 100 },
  minSize = { width: 200, height: 150 },
  onClose,
  className,
  headerClassName,
  contentClassName,
}) {
  const dock = useDock();
  const panelRef = useRef(null);
  const headerRef = useRef(null);
  const [isHovered, setIsHovered] = useState(false);
  const [autoHideExpanded, setAutoHideExpanded] = useState(false);
  const expandTimeoutRef = useRef(null);
  const collapseTimeoutRef = useRef(null);
  const dragStartRef = useRef(null);

  // Register panel on mount
  useEffect(() => {
    if (dock) {
      dock.registerPanel(id, {
        state: defaultState,
        dockZone: defaultDockZone,
        size: defaultSize,
        position: defaultPosition,
      });
      return () => dock.unregisterPanel(id);
    }
  }, [dock, id, defaultState, defaultDockZone, defaultSize, defaultPosition]);

  const panel = dock?.panels.get(id);
  if (!panel || !panel.visible) return null;

  const { state, dockZone, position, size, pinned } = panel;
  const isFloating = state === PANEL_STATE.FLOATING;
  const isAutoHide = state === PANEL_STATE.AUTO_HIDE;
  const isDocked = state === PANEL_STATE.DOCKED;

  // Auto-hide expand/collapse logic
  const handleMouseEnter = () => {
    setIsHovered(true);
    if (isAutoHide && !autoHideExpanded) {
      clearTimeout(collapseTimeoutRef.current);
      expandTimeoutRef.current = setTimeout(() => {
        setAutoHideExpanded(true);
      }, AUTO_HIDE_EXPAND_DELAY);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (isAutoHide && autoHideExpanded) {
      clearTimeout(expandTimeoutRef.current);
      collapseTimeoutRef.current = setTimeout(() => {
        setAutoHideExpanded(false);
      }, AUTO_HIDE_COLLAPSE_DELAY);
    }
  };

  // Drag handling
  const handleDragStart = (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      rect,
      wasDocked: isDocked,
    };

    const handleDragMove = (moveEvent) => {
      if (!dragStartRef.current) return;

      const dx = moveEvent.clientX - dragStartRef.current.x;
      const dy = moveEvent.clientY - dragStartRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Check if moved beyond threshold (undock)
      if (dragStartRef.current.wasDocked && distance > DRAG_THRESHOLD) {
        dock.updatePanel(id, {
          state: PANEL_STATE.FLOATING,
          position: {
            x: moveEvent.clientX - dragStartRef.current.rect.width / 2,
            y: moveEvent.clientY - 20,
          },
        });
        dragStartRef.current.wasDocked = false;
        dock.startDrag(id, { x: moveEvent.clientX, y: moveEvent.clientY }, dragStartRef.current.rect);
      }

      // If floating, update position
      if (!dragStartRef.current.wasDocked || isFloating) {
        dock.updatePanel(id, {
          position: {
            x: moveEvent.clientX - dragStartRef.current.rect.width / 2,
            y: moveEvent.clientY - 20,
          },
        });
      }
    };

    const handleDragEnd = () => {
      dragStartRef.current = null;
      dock.endDrag();
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
  };

  // Resize handling for floating windows
  const handleResize = (e, direction) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = { ...size };
    const startPos = { ...position };

    const handleResizeMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      let newSize = { ...startSize };
      let newPos = { ...startPos };

      if (direction.includes('e')) {
        newSize.width = Math.max(minSize.width, startSize.width + dx);
      }
      if (direction.includes('w')) {
        newSize.width = Math.max(minSize.width, startSize.width - dx);
        newPos.x = startPos.x + dx;
      }
      if (direction.includes('s')) {
        newSize.height = Math.max(minSize.height, startSize.height + dy);
      }
      if (direction.includes('n')) {
        newSize.height = Math.max(minSize.height, startSize.height - dy);
        newPos.y = startPos.y + dy;
      }

      dock.updatePanel(id, { size: newSize, position: newPos });
    };

    const handleResizeEnd = () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };

    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
  };

  // Handle close
  const handleClose = () => {
    dock.closePanel(id);
    onClose?.();
  };

  // Auto-hide collapsed strip
  if (isAutoHide && !autoHideExpanded) {
    return (
      <div
        className={cn(
          'fixed z-[100] transition-all duration-150',
          dockZone === 'left' && 'left-0 top-1/2 -translate-y-1/2 w-6 h-24',
          dockZone === 'right' && 'right-0 top-1/2 -translate-y-1/2 w-6 h-24',
          dockZone === 'bottom' && 'bottom-0 left-1/2 -translate-x-1/2 h-6 w-24',
        )}
        style={{
          backgroundColor: '#0D0E14',
          borderColor: BORDER_COLOR,
          borderWidth: 1,
          borderStyle: 'solid',
        }}
        onMouseEnter={handleMouseEnter}
      >
        <div className="w-full h-full flex items-center justify-center cursor-pointer">
          <span className="text-xs text-gray-400 truncate px-1" style={{ writingMode: dockZone === 'bottom' ? 'horizontal-tb' : 'vertical-rl' }}>
            {title}
          </span>
        </div>
      </div>
    );
  }

  // Floating window
  if (isFloating) {
    return createPortal(
      <div
        ref={panelRef}
        className={cn(
          'fixed flex flex-col shadow-2xl overflow-hidden',
          className,
        )}
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
          zIndex: 1000,
          backgroundColor: '#121212',
          border: `1px solid ${BORDER_COLOR}`,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Header / Drag Handle */}
        <div
          ref={headerRef}
          className={cn(
            'flex items-center justify-between px-2 py-1.5 select-none cursor-move',
            headerClassName,
          )}
          style={{
            backgroundColor: isHovered ? increaseBrightness('#0D0E14', HOVER_BRIGHTNESS_INCREASE) : '#0D0E14',
            borderBottom: `1px solid ${BORDER_COLOR}`,
          }}
          onMouseDown={handleDragStart}
        >
          <div className="flex items-center gap-2">
            <GripHorizontal className="w-3 h-3 text-gray-500" />
            <span className="text-xs font-medium text-gray-300">{title}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => dock.togglePinned(id)}
              className="p-1 rounded hover:bg-white/10 text-gray-400"
              title={pinned ? 'Unpin (auto-hide)' : 'Pin'}
            >
              {pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
            </button>
            <button
              onClick={() => dock.toggleDockState(id)}
              className="p-1 rounded hover:bg-white/10 text-gray-400"
              title="Dock"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
            <button
              onClick={handleClose}
              className="p-1 rounded hover:bg-white/10 text-gray-400"
              title="Close"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className={cn('flex-1 overflow-auto', contentClassName)}>
          {children}
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
    );
  }

  // Docked panel (rendered inline)
  return (
    <div
      ref={panelRef}
      className={cn('flex flex-col h-full overflow-hidden', className)}
      style={{
        backgroundColor: '#121212',
        borderColor: BORDER_COLOR,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Header / Drag Handle */}
      <div
        ref={headerRef}
        className={cn(
          'flex items-center justify-between px-2 py-1.5 select-none cursor-move',
          headerClassName,
        )}
        style={{
          backgroundColor: isHovered ? increaseBrightness('#0D0E14', HOVER_BRIGHTNESS_INCREASE) : '#0D0E14',
          borderBottom: `1px solid ${BORDER_COLOR}`,
        }}
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="w-3 h-3 text-gray-500" />
          <span className="text-xs font-medium text-gray-300">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => dock.togglePinned(id)}
            className="p-1 rounded hover:bg-white/10 text-gray-400"
            title={pinned ? 'Unpin (auto-hide)' : 'Pin'}
          >
            {pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
          </button>
          <button
            onClick={() => dock.toggleDockState(id)}
            className="p-1 rounded hover:bg-white/10 text-gray-400"
            title="Float"
          >
            <Minus className="w-3 h-3" />
          </button>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-white/10 text-gray-400"
            title="Close"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={cn('flex-1 overflow-auto', contentClassName)}>
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// useKeyboardShortcuts - Global keyboard handling for dock system
// ============================================================================

export function useDockKeyboardShortcuts(panelId) {
  const dock = useDock();

  useEffect(() => {
    if (!dock) return;

    const handleKeyDown = (e) => {
      // Ctrl + Alt + E - Focus panel
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        dock.focusPanel(panelId);
      }
      // Ctrl + Shift + D - Toggle docked/floating
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        dock.toggleDockState(panelId);
      }
      // Esc - Close panel (only if panel is focused/visible)
      if (e.key === 'Escape') {
        const panel = dock.panels.get(panelId);
        if (panel?.visible && panel?.state === PANEL_STATE.FLOATING) {
          e.preventDefault();
          dock.closePanel(panelId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dock, panelId]);
}

// ============================================================================
// TabGroup - For tabbed panels
// ============================================================================

export function TabGroup({ tabs, activeTab, onTabChange, onTabClose }) {
  const containerRef = useRef(null);

  return (
    <div 
      ref={containerRef}
      className="flex overflow-x-auto no-scrollbar"
      style={{ borderBottom: `1px solid ${BORDER_COLOR}` }}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'flex items-center gap-1 px-3 py-1.5 text-xs whitespace-nowrap transition-colors',
            'border-b-2',
            activeTab === tab.id 
              ? 'text-gray-200 border-[#3A7AFE]' 
              : 'text-gray-500 border-transparent hover:text-gray-300',
          )}
          style={{
            backgroundColor: activeTab === tab.id ? '#0D0E14' : 'transparent',
          }}
        >
          {tab.icon && <tab.icon className="w-3 h-3" />}
          <span>{tab.label}</span>
          {onTabClose && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              className="ml-1 p-0.5 rounded hover:bg-white/10"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          )}
        </button>
      ))}
    </div>
  );
}

export { PANEL_STATE, DOCK_ZONES, HIGHLIGHT_COLOR, BORDER_COLOR, HOVER_BRIGHTNESS_INCREASE, increaseBrightness };
