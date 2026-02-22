/**
 * @fileoverview Hook for splitter resize handles.
 * Handles pointer-based drag interaction for resizing split panels.
 */

'use client';

import { useCallback, useRef, useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { resizeSplitAction } from '../state/layout-slice';
import { DIRECTION, MIN_PANEL_SIZE, SPLITTER_SIZE } from '../types';

/**
 * @typedef {Object} SplitterOptions
 * @property {string} splitNodeId - the parent split node
 * @property {number} splitterIndex - which splitter (between child[i] and child[i+1])
 * @property {string} direction - 'row' (horizontal splitter) | 'column' (vertical splitter)
 * @property {function} [onResizeStart]
 * @property {function} [onResizeEnd]
 */

/**
 * Hook for a single splitter handle in a split container.
 *
 * @param {SplitterOptions} options
 * @returns {{ splitterProps: Object, isResizing: boolean }}
 */
export function useSplitter({
  splitNodeId,
  splitterIndex,
  direction,
  onResizeStart,
  onResizeEnd,
}) {
  const dispatch = useDispatch();
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef(null);
  const startPos = useRef(0);
  const startSizes = useRef(null);

  const isHorizontal = direction === DIRECTION.ROW;

  const handlePointerDown = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();

      setIsResizing(true);
      startPos.current = isHorizontal ? e.clientX : e.clientY;

      // Capture pointer for smooth dragging outside element
      e.target.setPointerCapture(e.pointerId);

      // Find the parent split container to calculate relative sizes
      const splitEl = e.target.closest('[data-split-node-id]');
      if (splitEl) {
        containerRef.current = splitEl;
      }

      onResizeStart?.();
    },
    [isHorizontal, onResizeStart]
  );

  const handlePointerMove = useCallback(
    (e) => {
      if (!isResizing) return;
      e.preventDefault();

      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;

      if (Math.abs(delta) < 1) return;

      // Calculate the delta as a fraction of the container size
      const container = containerRef.current;
      if (!container) return;

      const containerSize = isHorizontal
        ? container.offsetWidth
        : container.offsetHeight;

      if (containerSize <= 0) return;

      const fractionalDelta = delta / containerSize;

      dispatch(
        resizeSplitAction({
          splitNodeId,
          splitterIndex,
          delta: fractionalDelta,
        })
      );

      // Update start position for continuous drag
      startPos.current = currentPos;
    },
    [isResizing, isHorizontal, splitNodeId, splitterIndex, dispatch]
  );

  const handlePointerUp = useCallback(
    (e) => {
      if (!isResizing) return;
      setIsResizing(false);
      onResizeEnd?.();
    },
    [isResizing, onResizeEnd]
  );

  // Global pointer events for dragging outside element
  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e) => handlePointerMove(e);
    const onUp = (e) => handlePointerUp(e);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    // Prevent text selection during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, isHorizontal, handlePointerMove, handlePointerUp]);

  const splitterProps = {
    onPointerDown: handlePointerDown,
    role: 'separator',
    'aria-orientation': isHorizontal ? 'vertical' : 'horizontal',
    'aria-valuenow': undefined, // could be set to current sizes
    tabIndex: 0,
    style: {
      cursor: isHorizontal ? 'col-resize' : 'row-resize',
    },
    'data-splitter-index': splitterIndex,
    'data-splitter-direction': direction,
    'data-resizing': isResizing ? 'true' : undefined,
  };

  return { splitterProps, isResizing };
}

/**
 * Hook for keyboard-based splitter resize.
 * @param {Object} options
 * @param {string} options.splitNodeId
 * @param {number} options.splitterIndex
 * @param {string} options.direction
 * @param {number} [options.stepSize] - fractional step (default 0.02 = 2%)
 */
export function useSplitterKeyboard({
  splitNodeId,
  splitterIndex,
  direction,
  stepSize = 0.02,
}) {
  const dispatch = useDispatch();
  const isHorizontal = direction === DIRECTION.ROW;

  const handleKeyDown = useCallback(
    (e) => {
      let delta = 0;

      if (isHorizontal) {
        if (e.key === 'ArrowLeft') delta = -stepSize;
        else if (e.key === 'ArrowRight') delta = stepSize;
      } else {
        if (e.key === 'ArrowUp') delta = -stepSize;
        else if (e.key === 'ArrowDown') delta = stepSize;
      }

      if (delta !== 0) {
        e.preventDefault();
        dispatch(
          resizeSplitAction({
            splitNodeId,
            splitterIndex,
            delta,
          })
        );
      }
    },
    [dispatch, splitNodeId, splitterIndex, isHorizontal, stepSize]
  );

  return { onKeyDown: handleKeyDown };
}

export default useSplitter;
