/**
 * @fileoverview Hook for floating window interactions.
 * Handles dragging, resizing, and z-ordering of floating panels.
 */

'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { updateFloatAction, bringFloatToFrontAction, dockFloatAction } from '../state/layout-slice';
import { FLOATING_MIN_WIDTH, FLOATING_MIN_HEIGHT } from '../types';

/**
 * @typedef {'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw'} ResizeDirection
 */

/**
 * Hook for managing a floating window's position, size, and interactions.
 *
 * @param {Object} options
 * @param {string} options.floatId
 * @param {import('../types').FloatingWindow} options.floatingWindow
 * @returns {Object}
 */
export function useFloatingWindow({ floatId, floatingWindow }) {
  const dispatch = useDispatch();
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDir, setResizeDir] = useState(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const initialRect = useRef(null);
  const initialMousePos = useRef(null);

  // ── Title bar drag ─────────────────────────────────

  const handleTitleMouseDown = useCallback(
    (e) => {
      if (e.target.closest('[data-no-drag]')) return;
      e.preventDefault();
      setIsDragging(true);
      dragOffset.current = {
        x: e.clientX - floatingWindow.x,
        y: e.clientY - floatingWindow.y,
      };
      dispatch(bringFloatToFrontAction({ floatId }));
    },
    [floatId, floatingWindow.x, floatingWindow.y, dispatch]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const newX = Math.max(0, e.clientX - dragOffset.current.x);
      const newY = Math.max(0, e.clientY - dragOffset.current.y);
      dispatch(
        updateFloatAction({ floatId, x: newX, y: newY })
      );
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, floatId, dispatch]);

  // ── Edge resize ────────────────────────────────────

  const handleResizeMouseDown = useCallback(
    (dir) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      setResizeDir(dir);
      initialRect.current = {
        x: floatingWindow.x,
        y: floatingWindow.y,
        width: floatingWindow.width,
        height: floatingWindow.height,
      };
      initialMousePos.current = { x: e.clientX, y: e.clientY };
      dispatch(bringFloatToFrontAction({ floatId }));
    },
    [floatId, floatingWindow, dispatch]
  );

  useEffect(() => {
    if (!isResizing || !resizeDir) return;

    const handleMouseMove = (e) => {
      const { x: startX, y: startY } = initialMousePos.current;
      const { x, y, width, height } = initialRect.current;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newX = x, newY = y, newW = width, newH = height;

      // Directional resize calculations
      if (resizeDir.includes('e')) newW = Math.max(FLOATING_MIN_WIDTH, width + deltaX);
      if (resizeDir.includes('w')) {
        newW = Math.max(FLOATING_MIN_WIDTH, width - deltaX);
        newX = x + (width - newW);
      }
      if (resizeDir.includes('s')) newH = Math.max(FLOATING_MIN_HEIGHT, height + deltaY);
      if (resizeDir.includes('n')) {
        newH = Math.max(FLOATING_MIN_HEIGHT, height - deltaY);
        newY = y + (height - newH);
      }

      dispatch(
        updateFloatAction({
          floatId,
          x: Math.max(0, newX),
          y: Math.max(0, newY),
          width: newW,
          height: newH,
        })
      );
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setResizeDir(null);
    };

    const cursors = {
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      nw: 'nwse-resize', se: 'nwse-resize',
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = cursors[resizeDir] || 'default';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, resizeDir, floatId, dispatch]);

  // ── Focus on click ─────────────────────────────────

  const handleFocus = useCallback(() => {
    dispatch(bringFloatToFrontAction({ floatId }));
  }, [floatId, dispatch]);

  return {
    isDragging,
    isResizing,
    handleTitleMouseDown,
    handleResizeMouseDown,
    handleFocus,
  };
}

export default useFloatingWindow;
