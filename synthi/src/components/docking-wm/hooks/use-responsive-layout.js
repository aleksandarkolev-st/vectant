'use client';

/**
 * @fileoverview Responsive layout adaptation hook.
 *
 * Detects container/viewport size and provides layout hints for
 * the docking system to adapt on smaller screens:
 * - Auto-collapse sidebar below certain width
 * - Stack panels vertically on narrow screens
 * - Disable DnD on touch-only devices
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ────────────────────────────────────────────────────────
//  Breakpoints
// ────────────────────────────────────────────────────────

/** @enum {string} */
export const BREAKPOINT = Object.freeze({
  XS: 'xs',   // < 480px
  SM: 'sm',   // 480–768px
  MD: 'md',   // 768–1024px
  LG: 'lg',   // 1024–1440px
  XL: 'xl',   // > 1440px
});

/** Breakpoint pixel thresholds */
const THRESHOLDS = [480, 768, 1024, 1440];
const BP_LIST = [BREAKPOINT.XS, BREAKPOINT.SM, BREAKPOINT.MD, BREAKPOINT.LG, BREAKPOINT.XL];

function widthToBreakpoint(width) {
  for (let i = 0; i < THRESHOLDS.length; i++) {
    if (width < THRESHOLDS[i]) return BP_LIST[i];
  }
  return BREAKPOINT.XL;
}

// ────────────────────────────────────────────────────────
//  Hook
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResponsiveHints
 * @property {string}  breakpoint      - Current breakpoint name
 * @property {number}  width           - Container width in px
 * @property {number}  height          - Container height in px
 * @property {boolean} isMobile        - xs or sm
 * @property {boolean} isTablet        - md
 * @property {boolean} isDesktop       - lg or xl
 * @property {boolean} shouldStackPanels    - True when panels should stack vertically
 * @property {boolean} shouldCollapseSidebar - True when sidebar should auto-collapse
 * @property {boolean} shouldDisableDnD      - True when DnD should be disabled (touch)
 * @property {boolean} isTouch               - Device has touch capability
 */

/**
 * Monitor container size and return responsive layout hints.
 *
 * @param {React.RefObject} containerRef - Ref to the docking container element
 * @param {Object} [options]
 * @param {number} [options.sidebarCollapseWidth=640] - Width below which sidebar collapses
 * @param {number} [options.stackWidth=480] - Width below which panels stack
 * @returns {ResponsiveHints}
 */
export function useResponsiveLayout(containerRef, options = {}) {
  const {
    sidebarCollapseWidth = 640,
    stackWidth = 480,
  } = options;

  const [hints, setHints] = useState({
    breakpoint: BREAKPOINT.LG,
    width: 1200,
    height: 800,
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    shouldStackPanels: false,
    shouldCollapseSidebar: false,
    shouldDisableDnD: false,
    isTouch: false,
  });

  const observerRef = useRef(null);

  const updateHints = useCallback((width, height) => {
    const bp = widthToBreakpoint(width);
    const isTouch = typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    setHints({
      breakpoint: bp,
      width,
      height,
      isMobile: bp === BREAKPOINT.XS || bp === BREAKPOINT.SM,
      isTablet: bp === BREAKPOINT.MD,
      isDesktop: bp === BREAKPOINT.LG || bp === BREAKPOINT.XL,
      shouldStackPanels: width < stackWidth,
      shouldCollapseSidebar: width < sidebarCollapseWidth,
      shouldDisableDnD: isTouch && width < stackWidth,
      isTouch,
    });
  }, [sidebarCollapseWidth, stackWidth]);

  useEffect(() => {
    const el = containerRef?.current;
    if (!el) return;

    // Use ResizeObserver for accurate container-level measurement
    if (typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          updateHints(width, height);
        }
      });
      observerRef.current.observe(el);
    } else {
      // Fallback to window resize
      const handleResize = () => {
        updateHints(el.offsetWidth, el.offsetHeight);
      };
      handleResize();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }

    return () => {
      observerRef.current?.disconnect();
    };
  }, [containerRef, updateHints]);

  return hints;
}
