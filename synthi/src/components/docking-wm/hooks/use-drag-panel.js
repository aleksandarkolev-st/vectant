/**
 * @fileoverview Hook for making elements draggable as panel tabs.
 * Handles the HTML5 Drag & Drop source side.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { setDragSource } from '../state/layout-slice';
import { DRAG_START_THRESHOLD } from '../types';

/**
 * @typedef {Object} DragPanelOptions
 * @property {string} tabId - the tab being dragged
 * @property {string} tabGroupId - the source tab group
 * @property {number} [tabIndex] - index within tab group
 * @property {function} [onDragStart] - callback when drag starts
 * @property {function} [onDragEnd] - callback when drag ends
 */

/**
 * Hook that makes an element draggable as a docking tab.
 * Attach the returned props to the draggable element.
 *
 * @param {DragPanelOptions} options
 * @returns {{ dragProps: Object, isDragging: boolean }}
 */
export function useDragPanel({ tabId, tabGroupId, tabIndex, onDragStart, onDragEnd }) {
  const dispatch = useDispatch();
  const [isDragging, setIsDragging] = useState(false);
  const startPos = useRef(null);
  const dragStarted = useRef(false);

  const handleDragStart = useCallback(
    (e) => {
      // Set drag data
      const payload = JSON.stringify({
        type: 'tab',
        tabId,
        sourceTabGroupId: tabGroupId,
        sourceTabIndex: tabIndex,
      });

      e.dataTransfer.setData('application/synthi-dock', payload);
      e.dataTransfer.effectAllowed = 'move';

      // Set a translucent drag image
      if (e.target) {
        const rect = e.target.getBoundingClientRect();
        const ghostEl = e.target.cloneNode(true);
        ghostEl.style.position = 'absolute';
        ghostEl.style.top = '-9999px';
        ghostEl.style.left = '-9999px';
        ghostEl.style.opacity = '0.7';
        ghostEl.style.width = `${rect.width}px`;
        ghostEl.style.pointerEvents = 'none';
        document.body.appendChild(ghostEl);
        e.dataTransfer.setDragImage(ghostEl, e.clientX - rect.left, e.clientY - rect.top);
        // Clean up ghost after a tick
        requestAnimationFrame(() => {
          document.body.removeChild(ghostEl);
        });
      }

      setIsDragging(true);
      dispatch(setDragSource({ tabId }));
      onDragStart?.(e);
    },
    [tabId, tabGroupId, tabIndex, dispatch, onDragStart]
  );

  const handleDragEnd = useCallback(
    (e) => {
      setIsDragging(false);
      dispatch(setDragSource(null));
      onDragEnd?.(e);
    },
    [dispatch, onDragEnd]
  );

  const dragProps = {
    draggable: true,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    'data-drag-tab-id': tabId,
  };

  return { dragProps, isDragging };
}

/**
 * Parse drag data from a drop event.
 * @param {DragEvent} e
 * @returns {import('../types').DragPayload|null}
 */
export function parseDragPayload(e) {
  try {
    const data = e.dataTransfer.getData('application/synthi-dock');
    if (!data) return null;
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export default useDragPanel;
