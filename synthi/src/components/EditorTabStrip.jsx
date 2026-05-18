'use client';

/**
 * EditorTabStrip
 *
 * Click-only horizontal strip of file tabs, designed to live inside the
 * TopNav row. It does NOT participate in the docking-wm drag system —
 * splits are still possible via the editor's right-click menu and
 * keyboard shortcuts, but tabs in this strip cannot be torn off here.
 *
 * Visual contract:
 *   - Each tab: file icon + name + close button (visible on hover/active)
 *   - Active tab: brighter text + a gray baseline underline that can
 *     animate into the brand gradient on hover
 *   - Hover timing matches the docking tabs used in terminal/output
 *   - Both ends of the strip fade into the surrounding TopNav chrome
 *     via a CSS mask so tabs never hit a hard cutoff
 *   - Horizontally scrollable with the restored custom scrollbar thumb
 *     living in its own 3px lane just below the navbar border
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { selectActiveFile, selectOpenFiles, selectFileThunk } from '@/redux/workspaceSlice';
import { closeFile } from '@/redux/workspaceSlice';
import { getFileIcon } from '@/utils/fileIcons';

function EditorTabStripImpl() {
  const dispatch = useAppDispatch();
  const openFiles = useAppSelector(selectOpenFiles);
  const activeFile = useAppSelector(selectActiveFile);
  const tabsContainerRef = useRef(null);
  const scrollbarThumbRef = useRef(null);
  const activeTabRef = useRef(null);
  const scrollTimeoutRef = useRef(null);
  const tabRefs = useRef({});
  const [hoveredTabPath, setHoveredTabPath] = useState(null);
  const [isStripHovered, setStripHovered] = useState(false);
  const [isScrollbarActive, setScrollbarActive] = useState(false);
  const [tabIndicator, setTabIndicator] = useState({
    left: 0,
    width: 0,
    visible: false,
    isHovered: false,
  });

  const handleSelect = useCallback((file) => {
    if (!file || file.path === activeFile?.path) return;
    dispatch(selectFileThunk(file));
  }, [dispatch, activeFile?.path]);

  const handleClose = useCallback((e, file) => {
    e.stopPropagation();
    e.preventDefault();
    if (!file) return;
    dispatch(closeFile(file.path));
  }, [dispatch]);

  const updateScrollbar = useCallback(() => {
    const container = tabsContainerRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!container || !thumb) return;

    const { scrollWidth, clientWidth, scrollLeft } = container;
    if (scrollWidth <= clientWidth + 1) {
      thumb.style.display = 'none';
      return;
    }

    thumb.style.display = 'block';

    const thumbWidth = Math.max((clientWidth / scrollWidth) * clientWidth, 20);
    const maxScrollLeft = scrollWidth - clientWidth;
    const maxThumbLeft = clientWidth - thumbWidth;
    const thumbLeft = maxScrollLeft > 0 ? (scrollLeft / maxScrollLeft) * maxThumbLeft : 0;

    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${thumbLeft}px)`;
  }, []);

  const updateIndicator = useCallback(() => {
    const container = tabsContainerRef.current;
    const targetPath = hoveredTabPath || activeFile?.path;

    if (!container || !targetPath) {
      setTabIndicator((current) => current.visible
        ? { ...current, visible: false, isHovered: false }
        : current);
      return;
    }

    const target = tabRefs.current[targetPath];
    if (!target) return;

    const left = target.offsetLeft + 10;
    const width = Math.max(target.offsetWidth - 20, 0);

    setTabIndicator({
      left,
      width,
      visible: true,
      isHovered: Boolean(hoveredTabPath),
    });
  }, [activeFile?.path, hoveredTabPath]);

  const pulseScrollbar = useCallback(() => {
    setScrollbarActive(true);
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      setScrollbarActive(false);
    }, 1000);
  }, []);

  const handleScroll = useCallback(() => {
    updateIndicator();
    updateScrollbar();
    pulseScrollbar();
  }, [pulseScrollbar, updateIndicator, updateScrollbar]);

  const handleThumbMouseDown = useCallback((event) => {
    event.preventDefault();

    const container = tabsContainerRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!container || !thumb) return;

    const startX = event.clientX;
    const startScrollLeft = container.scrollLeft;
    const { scrollWidth, clientWidth } = container;
    const maxScrollLeft = scrollWidth - clientWidth;
    const thumbWidth = thumb.clientWidth;
    const maxThumbLeft = clientWidth - thumbWidth;

    const handleMouseMove = (moveEvent) => {
      if (maxThumbLeft <= 0) return;
      const deltaX = moveEvent.clientX - startX;
      const scrollDelta = (deltaX / maxThumbLeft) * maxScrollLeft;
      container.scrollLeft = startScrollLeft + scrollDelta;
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Scroll the active tab into view when it changes (Ctrl+P, etc.)
  useEffect(() => {
    if (activeTabRef.current?.scrollIntoView) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeFile?.path]);

  useLayoutEffect(() => {
    window.requestAnimationFrame(() => {
      updateIndicator();
      updateScrollbar();
    });
  }, [openFiles, activeFile?.path, hoveredTabPath, updateIndicator, updateScrollbar]);

  useEffect(() => {
    const container = tabsContainerRef.current;
    if (!container) return undefined;

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        updateIndicator();
        updateScrollbar();
      });
    });

    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
    };
  }, [updateIndicator, updateScrollbar]);

  useEffect(() => () => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
  }, []);

  if (!openFiles || openFiles.length === 0) {
    return null;
  }

  return (
    <div
      className="editor-tab-strip relative h-full min-w-0 flex-1 overflow-visible"
      onMouseEnter={() => setStripHovered(true)}
      onMouseLeave={() => setStripHovered(false)}
    >
      <div
        className="relative h-full min-w-0 overflow-hidden"
        style={{
          maskImage:
            'linear-gradient(to right, transparent 0, black 18px, black calc(100% - 18px), transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to right, transparent 0, black 18px, black calc(100% - 18px), transparent 100%)',
        }}
      >
        <div
          ref={tabsContainerRef}
          onScroll={handleScroll}
          className="relative flex h-full items-stretch overflow-x-auto overflow-y-hidden no-scrollbar"
          style={{
            scrollbarWidth: 'none',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {openFiles.map((file) => {
            const isActive = activeFile && file.path === activeFile.path;
            const isHovered = hoveredTabPath === file.path;
            const fileName = file.name || file.path?.split('/').pop() || 'untitled';
            const icon = getFileIcon(fileName);

            return (
              <button
                key={file.path}
                ref={(element) => {
                  tabRefs.current[file.path] = element;
                  if (isActive) {
                    activeTabRef.current = element;
                  }
                }}
                type="button"
                onClick={() => handleSelect(file)}
                onMouseEnter={() => setHoveredTabPath(file.path)}
                onMouseLeave={() => {
                  setHoveredTabPath((current) => (current === file.path ? null : current));
                }}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    handleClose(e, file);
                  }
                }}
                title={file.path}
                className="relative shrink-0 flex h-full items-center gap-1.5 px-2.5 text-[12px] cursor-pointer"
                style={{
                  color: isActive || isHovered
                    ? 'var(--dock-tab-active-fg, var(--text-primary))'
                    : 'var(--dock-tab-fg, var(--text-muted))',
                  fontWeight: isActive ? 600 : 400,
                  background: isActive
                    ? 'var(--dock-tab-active-bg, color-mix(in srgb, var(--bg-elevated) 60%, transparent))'
                    : isHovered
                      ? 'rgba(255, 255, 255, 0.04)'
                      : 'transparent',
                  transition: 'background-color 0.1s, color 0.1s',
                }}
              >
                <span className="text-base leading-none flex-shrink-0">{icon}</span>

                <span className="whitespace-nowrap">{fileName}</span>

                {file.isUnsaved && (
                  <span
                    aria-hidden="true"
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: 'var(--attention-purple)' }}
                  />
                )}

                <button
                  type="button"
                  onClick={(e) => handleClose(e, file)}
                  aria-label={`Close ${fileName}`}
                  className="flex-shrink-0 w-4 h-4 rounded flex items-center justify-center transition-all duration-150"
                  style={{
                    color: 'var(--text-secondary)',
                    opacity: isActive || isHovered ? 0.72 : 0,
                  }}
                >
                  <X className="w-3 h-3" strokeWidth={2} />
                </button>
              </button>
            );
          })}

          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 h-[2px] rounded-t-full"
            style={{
              left: tabIndicator.left,
              width: tabIndicator.width,
              opacity: tabIndicator.visible ? 1 : 0,
              backgroundImage: [
                'var(--brand-gradient-horizontal)',
                'linear-gradient(90deg, color-mix(in srgb, var(--text-muted) 72%, transparent), color-mix(in srgb, var(--text-muted) 72%, transparent))',
              ].join(', '),
              backgroundRepeat: 'no-repeat, no-repeat',
              backgroundPosition: 'left bottom, left bottom',
              backgroundSize: `${tabIndicator.isHovered ? '100% 100%' : '0% 100%'}, 100% 100%`,
              boxShadow: tabIndicator.isHovered
                ? '0 0 8px -2px color-mix(in srgb, var(--brand-stop-3) 55%, transparent)'
                : 'none',
              transition: 'left 0.15s cubic-bezier(0.4, 0, 0.2, 1), width 0.15s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.1s ease, background-size 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.15s ease',
            }}
          />
        </div>
      </div>

      <div
        className="pointer-events-none absolute left-0 right-0 h-[3px]"
        style={{ bottom: '-3px' }}
      >
        <div
          ref={scrollbarThumbRef}
          className="pointer-events-auto absolute inset-y-0 left-0 rounded-[3px] cursor-pointer"
          style={{
            display: 'none',
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--brand-stop-3) 35%, transparent), color-mix(in srgb, var(--brand-stop-4) 35%, transparent))',
            opacity: isStripHovered || isScrollbarActive ? 1 : 0,
            transition: 'opacity 0.2s ease',
          }}
          onMouseDown={handleThumbMouseDown}
        />
      </div>
    </div>
  );
}

export const EditorTabStrip = memo(EditorTabStripImpl);
export default EditorTabStrip;
