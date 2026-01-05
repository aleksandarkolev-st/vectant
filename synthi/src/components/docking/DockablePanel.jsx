'use client';

/**
 * DockablePanel - Visual Studio-style dockable panel system
 * 
 * Supports:
 * - Docked: Panel is attached to a dock zone (left, right, bottom)
 * - Floating: Panel is a separate draggable window
 * - Tabbed: Multiple panels merged into tab groups
 * - Auto-hide: Panel collapses to thin edge strip
 * 
 * COLOR PALETTE (exact, no deviations):
 * - Error background: #2B0F12
 * - Error text: #E6E6E6
 * - Error accent: #C6362B
 * - Warning background: #2A1E0A
 * - Warning accent: #D4A017
 * - Info background: #121212
 * - Info accent: #3A7AFE
 * - Borders: #3A3A3A
 * - Hover: +8% brightness only
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { X, Pin, PinOff, Maximize2, Minimize2, GripHorizontal } from 'lucide-react';

// Constants
const UNDOCK_THRESHOLD = 8; // pixels to drag before undocking
const AUTO_HIDE_EXPAND_DELAY = 150; // ms
const AUTO_HIDE_COLLAPSE_DELAY = 300; // ms
const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 150;

// Panel state types
export const PANEL_STATE = {
  DOCKED: 'docked',
  FLOATING: 'floating',
  AUTO_HIDE: 'auto-hide',
};

// Dock positions
export const DOCK_POSITION = {
  LEFT: 'left',
  RIGHT: 'right',
  BOTTOM: 'bottom',
  CENTER: 'center', // For tab merging
};

// Context for dock zone management
const DockContext = createContext(null);

/**
 * Dock zone indicator shown during drag operations
 */
function DockZoneIndicator({ position, isActive, onDrop }) {
  const positionStyles = {
    [DOCK_POSITION.LEFT]: 'left-0 top-0 bottom-0 w-24',
    [DOCK_POSITION.RIGHT]: 'right-0 top-0 bottom-0 w-24',
    [DOCK_POSITION.BOTTOM]: 'bottom-0 left-0 right-0 h-24',
    [DOCK_POSITION.CENTER]: 'inset-0 m-auto w-32 h-32',
  };

  return (
    <div
      className={cn(
        'absolute transition-all duration-150 pointer-events-auto',
        'border-2 border-dashed rounded-lg',
        positionStyles[position],
        isActive
          ? 'bg-[#3A7AFE]/40 border-[#3A7AFE]'
          : 'bg-[#3A7AFE]/20 border-[#3A7AFE]/50 opacity-30 hover:opacity-60',
      )}
      onMouseUp={onDrop}
      onMouseEnter={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs text-[#E6E6E6] font-medium uppercase tracking-wide opacity-80">
          {position === DOCK_POSITION.CENTER ? 'Tab' : `Dock ${position}`}
        </span>
      </div>
    </div>
  );
}

/**
 * Floating panel window
 */
function FloatingWindow({
  children,
  title,
  position,
  size,
  onMove,
  onResize,
  onClose,
  onDock,
  zIndex = 1000,
  isVisible = true,
}) {
  const windowRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  // Handle window drag
  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.resize-handle')) return;
    e.preventDefault();
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  }, [position]);

  const handleMouseMove = useCallback((e) => {
    if (isDragging) {
      onMove({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    }
    if (isResizing) {
      const deltaX = e.clientX - resizeStart.x;
      const deltaY = e.clientY - resizeStart.y;
      onResize({
        width: Math.max(MIN_PANEL_WIDTH, resizeStart.width + deltaX),
        height: Math.max(MIN_PANEL_HEIGHT, resizeStart.height + deltaY),
      });
    }
  }, [isDragging, isResizing, dragOffset, resizeStart, onMove, onResize]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(false);
  }, []);

  // Handle resize
  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    });
  }, [size]);

  useEffect(() => {
    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, isResizing, handleMouseMove, handleMouseUp]);

  if (!isVisible) return null;

  return createPortal(
    <div
      ref={windowRef}
      className={cn(
        'fixed bg-[#0d0e14] border border-[#3A3A3A] rounded-lg shadow-2xl overflow-hidden',
        'flex flex-col',
        isDragging && 'cursor-move',
      )}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex,
      }}
    >
      {/* Window header - drag handle */}
      <div
        className={cn(
          'flex items-center justify-between px-3 py-2',
          'bg-[#0d0e14]',
          'cursor-move select-none',
        )}
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="h-4 w-4 text-[#666]" />
          <span className="text-sm font-medium text-[#E6E6E6]">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onDock}
            className="p-1 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#E6E6E6] transition-colors"
            title="Dock panel (Ctrl+Shift+D)"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#E6E6E6] transition-colors"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">{children}</div>

      {/* Resize handle */}
      <div
        className="resize-handle absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={handleResizeStart}
      >
        <svg
          className="absolute bottom-1 right-1 w-2 h-2 text-[#666]"
          viewBox="0 0 6 6"
        >
          <circle cx="5" cy="1" r="0.75" fill="currentColor" />
          <circle cx="5" cy="3" r="0.75" fill="currentColor" />
          <circle cx="3" cy="5" r="0.75" fill="currentColor" />
          <circle cx="5" cy="5" r="0.75" fill="currentColor" />
          <circle cx="1" cy="5" r="0.75" fill="currentColor" />
        </svg>
      </div>
    </div>,
    document.body
  );
}

/**
 * Auto-hide edge strip
 */
function AutoHideStrip({ position, title, isExpanded, onExpand, onCollapse }) {
  const [isHovering, setIsHovering] = useState(false);
  const expandTimeoutRef = useRef(null);
  const collapseTimeoutRef = useRef(null);

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true);
    collapseTimeoutRef.current && clearTimeout(collapseTimeoutRef.current);
    expandTimeoutRef.current = setTimeout(onExpand, AUTO_HIDE_EXPAND_DELAY);
  }, [onExpand]);

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
    expandTimeoutRef.current && clearTimeout(expandTimeoutRef.current);
    collapseTimeoutRef.current = setTimeout(onCollapse, AUTO_HIDE_COLLAPSE_DELAY);
  }, [onCollapse]);

  useEffect(() => {
    return () => {
      expandTimeoutRef.current && clearTimeout(expandTimeoutRef.current);
      collapseTimeoutRef.current && clearTimeout(collapseTimeoutRef.current);
    };
  }, []);

  const stripStyles = {
    [DOCK_POSITION.LEFT]: 'left-0 top-1/2 -translate-y-1/2 w-6 h-32 rounded-r-lg',
    [DOCK_POSITION.RIGHT]: 'right-0 top-1/2 -translate-y-1/2 w-6 h-32 rounded-l-lg',
    [DOCK_POSITION.BOTTOM]: 'bottom-0 left-1/2 -translate-x-1/2 h-6 w-32 rounded-t-lg',
  };

  const textOrientation = {
    [DOCK_POSITION.LEFT]: 'writing-mode-vertical-rl rotate-180',
    [DOCK_POSITION.RIGHT]: 'writing-mode-vertical-rl',
    [DOCK_POSITION.BOTTOM]: '',
  };

  return (
    <div
      className={cn(
        'fixed z-50 bg-[#1a1a1a] border border-[#3A3A3A]',
        'flex items-center justify-center cursor-pointer',
        'transition-all duration-150',
        stripStyles[position],
        isHovering && 'bg-[#252525] border-[#3A7AFE]',
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span
        className={cn(
          'text-xs text-[#888] font-medium truncate',
          textOrientation[position],
        )}
        style={{ writingMode: position !== DOCK_POSITION.BOTTOM ? 'vertical-rl' : undefined }}
      >
        {title}
      </span>
    </div>
  );
}

/**
 * Tab bar for merged panels
 */
function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onReorderTabs }) {
  const tabBarRef = useRef(null);

  return (
    <div
      ref={tabBarRef}
      className="flex items-center bg-[#1a1a1a] border-b border-[#3A3A3A] overflow-x-auto scrollbar-none"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelectTab(tab.id)}
          className={cn(
            'flex items-center gap-2 px-3 py-2 text-sm whitespace-nowrap',
            'border-r border-[#3A3A3A] transition-colors',
            activeTabId === tab.id
              ? 'bg-[#121212] text-[#E6E6E6] border-b-2 border-b-[#3A7AFE]'
              : 'text-[#888] hover:bg-[#252525] hover:text-[#E6E6E6]',
          )}
        >
          {tab.icon && <tab.icon className="h-4 w-4" />}
          <span>{tab.title}</span>
          {tab.closable !== false && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              className="ml-1 p-0.5 rounded hover:bg-[#3a3a3a] text-[#666] hover:text-[#E6E6E6]"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Main DockablePanel component
 */
export function DockablePanel({
  id,
  title,
  icon: Icon,
  children,
  defaultState = PANEL_STATE.DOCKED,
  defaultPosition = DOCK_POSITION.BOTTOM,
  defaultFloatingPosition = { x: 100, y: 100 },
  defaultFloatingSize = { width: 400, height: 300 },
  isPinned: defaultPinned = true,
  isOpen: externalIsOpen,
  onOpenChange,
  onStateChange,
  onDockedChange, // Callback: tells parent if panel is docked (true) or floating/auto-hide (false)
  workspaceId,
  dockSlotId, // ID of the DOM element to portal docked content into
  className,
}) {
  // State
  const [panelState, setPanelState] = useState(defaultState);
  const [dockPosition, setDockPosition] = useState(defaultPosition);
  const [floatingPosition, setFloatingPosition] = useState(defaultFloatingPosition);
  const [floatingSize, setFloatingSize] = useState(defaultFloatingSize);
  const [isPinned, setIsPinned] = useState(defaultPinned);
  const [isOpen, setIsOpen] = useState(externalIsOpen ?? true);
  const [isAutoHideExpanded, setIsAutoHideExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showDockZones, setShowDockZones] = useState(false);
  const [activeDockZone, setActiveDockZone] = useState(null);
  const [dockSlot, setDockSlot] = useState(null);

  // Refs
  const panelRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const originalPositionRef = useRef(null);

  // Controlled open state
  useEffect(() => {
    if (externalIsOpen !== undefined) {
      setIsOpen(externalIsOpen);
    }
  }, [externalIsOpen]);

  // Find dock slot element when dockSlotId provided
  useEffect(() => {
    if (!dockSlotId) return;
    
    // Use RAF to ensure DOM is ready
    const findSlot = () => {
      const slot = document.getElementById(dockSlotId);
      if (slot) {
        setDockSlot(slot);
      } else {
        // Retry on next frame if not found
        requestAnimationFrame(findSlot);
      }
    };
    
    findSlot();
    
    // Also observe for the slot being added/removed
    const observer = new MutationObserver(() => {
      const slot = document.getElementById(dockSlotId);
      setDockSlot(slot || null);
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    
    return () => observer.disconnect();
  }, [dockSlotId, panelState, isOpen]);

  // Notify parent of docked state changes
  useEffect(() => {
    const isDocked = panelState === PANEL_STATE.DOCKED && isOpen;
    onDockedChange?.(isDocked);
  }, [panelState, isOpen, onDockedChange]);

  // State change handler
  const changeState = useCallback((newState) => {
    setPanelState(newState);
    onStateChange?.(newState);
  }, [onStateChange]);

  // Persist state to localStorage (NOT isOpen - parent controls that)
  useEffect(() => {
    if (!workspaceId) return;
    const key = `synthi-panel-${id}-${workspaceId}`;
    const savedState = localStorage.getItem(key);
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        setPanelState(parsed.panelState ?? defaultState);
        setDockPosition(parsed.dockPosition ?? defaultPosition);
        setFloatingPosition(parsed.floatingPosition ?? defaultFloatingPosition);
        setFloatingSize(parsed.floatingSize ?? defaultFloatingSize);
        setIsPinned(parsed.isPinned ?? defaultPinned);
        // Note: isOpen is NOT restored - controlled by parent
      } catch (e) {
        console.error('Failed to parse panel state:', e);
      }
    }
  }, [id, workspaceId]);

  // Save state on change (NOT isOpen - parent controls that)
  useEffect(() => {
    if (!workspaceId) return;
    const key = `synthi-panel-${id}-${workspaceId}`;
    const state = {
      panelState,
      dockPosition,
      floatingPosition,
      floatingSize,
      isPinned,
    };
    localStorage.setItem(key, JSON.stringify(state));
  }, [id, workspaceId, panelState, dockPosition, floatingPosition, floatingSize, isPinned]);

  // Handle drag-to-detach
  const handleHeaderMouseDown = useCallback((e) => {
    if (panelState === PANEL_STATE.FLOATING) return;
    
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    originalPositionRef.current = panelRef.current?.getBoundingClientRect();

    const handleMouseMove = (moveEvent) => {
      const deltaX = Math.abs(moveEvent.clientX - dragStartRef.current.x);
      const deltaY = Math.abs(moveEvent.clientY - dragStartRef.current.y);

      if (deltaX > UNDOCK_THRESHOLD || deltaY > UNDOCK_THRESHOLD) {
        // Undock with smooth transition
        setIsDragging(true);
        setShowDockZones(true);
        setFloatingPosition({
          x: moveEvent.clientX - 100,
          y: moveEvent.clientY - 20,
        });
        changeState(PANEL_STATE.FLOATING);
        document.body.style.cursor = 'move';
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setShowDockZones(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [panelState, changeState]);

  // Handle dock zone drop
  const handleDockZoneDrop = useCallback((zone) => {
    setShowDockZones(false);
    setIsDragging(false);
    if (zone === DOCK_POSITION.CENTER) {
      // Tab merge - would be handled by parent context
      changeState(PANEL_STATE.DOCKED);
    } else {
      setDockPosition(zone);
      changeState(PANEL_STATE.DOCKED);
    }
  }, [changeState]);

  // Toggle floating
  const handleToggleFloat = useCallback(() => {
    const newState = panelState === PANEL_STATE.FLOATING
      ? PANEL_STATE.DOCKED
      : PANEL_STATE.FLOATING;
    changeState(newState);
  }, [panelState, changeState]);

  // Toggle pin
  const handleTogglePin = useCallback(() => {
    if (isPinned) {
      setIsPinned(false);
      setPanelState(PANEL_STATE.AUTO_HIDE);
    } else {
      setIsPinned(true);
      setPanelState(PANEL_STATE.DOCKED);
    }
  }, [isPinned]);

  // Close panel
  const handleClose = useCallback(() => {
    setIsOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+Alt+E - Focus panel
      if (e.ctrlKey && e.altKey && e.key === 'e') {
        e.preventDefault();
        setIsOpen(true);
        onOpenChange?.(true);
        panelRef.current?.focus();
      }
      // Ctrl+Shift+D - Toggle docked/floating
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        handleToggleFloat();
      }
      // Escape - Close panel
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleToggleFloat, handleClose, onOpenChange]);

  // Render dock zones overlay
  const renderDockZones = () => {
    if (!showDockZones) return null;

    return createPortal(
      <div className="fixed inset-0 z-[9999] pointer-events-none">
        <div className="relative w-full h-full pointer-events-auto">
          {Object.values(DOCK_POSITION).map((pos) => (
            <DockZoneIndicator
              key={pos}
              position={pos}
              isActive={activeDockZone === pos}
              onDrop={() => handleDockZoneDrop(pos)}
            />
          ))}
        </div>
      </div>,
      document.body
    );
  };

  // Render panel content (shared between docked and floating)
  const renderPanelContent = (isFloating = false) => (
    <div
      ref={panelRef}
      className={cn(
        'flex flex-col bg-[#121212] border border-[#3A3A3A] overflow-hidden h-full',
        className,
      )}
      tabIndex={-1}
    >
      {/* Header - drag handle */}
      <div
        className={cn(
          'flex items-center justify-between px-3 py-2',
          'bg-[#1a1a1a] border-b border-[#3A3A3A]',
          'cursor-grab select-none',
        )}
        onMouseDown={!isFloating ? handleHeaderMouseDown : undefined}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="h-4 w-4 text-[#666]" />
          {Icon && <Icon className="h-4 w-4 text-[#888]" />}
          <span className="text-sm font-medium text-[#E6E6E6]">{title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleTogglePin}
            className="p-1 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#E6E6E6] transition-colors"
            title={isPinned ? 'Auto-hide panel' : 'Pin panel'}
          >
            {isPinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
          </button>
          <button
            onClick={handleToggleFloat}
            className="p-1 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#E6E6E6] transition-colors"
            title={isFloating ? 'Dock panel (Ctrl+Shift+D)' : 'Float panel (Ctrl+Shift+D)'}
          >
            {isFloating ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-[#2a2a2a] text-[#888] hover:text-[#E6E6E6] transition-colors"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  );

  // Auto-hide state
  if (panelState === PANEL_STATE.AUTO_HIDE && !isAutoHideExpanded) {
    return (
      <>
        <AutoHideStrip
          position={dockPosition}
          title={title}
          isExpanded={isAutoHideExpanded}
          onExpand={() => setIsAutoHideExpanded(true)}
          onCollapse={() => setIsAutoHideExpanded(false)}
        />
        {renderDockZones()}
      </>
    );
  }

  // Floating state
  if (panelState === PANEL_STATE.FLOATING && isOpen) {
    return (
      <>
        <FloatingWindow
          title={title}
          position={floatingPosition}
          size={floatingSize}
          onMove={setFloatingPosition}
          onResize={setFloatingSize}
          onClose={handleClose}
          onDock={() => handleDockZoneDrop(dockPosition)}
          zIndex={isDragging ? 10001 : 1000}
        >
          {children}
        </FloatingWindow>
        {renderDockZones()}
      </>
    );
  }

  // Docked state
  if (!isOpen) return null;

  // If dockSlotId is provided, render into that slot via portal
  if (dockSlotId && dockSlot) {
    return (
      <>
        {createPortal(renderPanelContent(false), dockSlot)}
        {renderDockZones()}
      </>
    );
  }

  // Fallback: render inline
  return (
    <>
      {renderPanelContent(false)}
      {renderDockZones()}
    </>
  );
}

/**
 * Provider for managing multiple dockable panels
 */
export function DockablePanelProvider({ children, workspaceId }) {
  const [panels, setPanels] = useState(new Map());
  const [tabGroups, setTabGroups] = useState(new Map());

  const registerPanel = useCallback((id, config) => {
    setPanels((prev) => new Map(prev).set(id, config));
  }, []);

  const unregisterPanel = useCallback((id) => {
    setPanels((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const contextValue = useMemo(
    () => ({
      panels,
      tabGroups,
      registerPanel,
      unregisterPanel,
      workspaceId,
    }),
    [panels, tabGroups, registerPanel, unregisterPanel, workspaceId]
  );

  return (
    <DockContext.Provider value={contextValue}>
      {children}
    </DockContext.Provider>
  );
}

export function useDockContext() {
  return useContext(DockContext);
}

export default DockablePanel;
