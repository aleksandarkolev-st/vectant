/**
 * @fileoverview Hook for making elements draggable as panel tabs.
 * Handles the HTML5 Drag & Drop source side.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { setDragSource, floatTabAction } from '../state/layout-slice';
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

      // If the drop didn't land on a valid target, float the tab
      // dropEffect is 'none' when the browser didn't process a drop event
      if (e.dataTransfer.dropEffect === 'none' && tabId) {
        // Use the mouse position as the floating window origin
        // screenX/screenY may be 0 at end; fallback to last known position
        const x = e.clientX > 0 ? e.clientX - 100 : 100;
        const y = e.clientY > 0 ? e.clientY - 20 : 100;
        dispatch(
          floatTabAction({
            tabId,
            x: Math.max(0, x),
            y: Math.max(0, y),
            width: 500,
            height: 400,
          })
        );
      }

      onDragEnd?.(e);
    },
    [tabId, dispatch, onDragEnd]
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
