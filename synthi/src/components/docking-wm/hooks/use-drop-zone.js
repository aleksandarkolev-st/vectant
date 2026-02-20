/**
 * @fileoverview Hook for making elements drop targets for docking.
 * Handles the HTML5 Drag & Drop target side with zone detection.
 */

'use client';

import { useCallback, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { handleDropAction, selectDragSourceTabId } from '../state/layout-slice';
import { hitTestDropZone, getTabInsertIndex } from '../utils/geometry';
import { parseDragPayload } from './use-drag-panel';

/**
 * @typedef {Object} DropZoneOptions
 * @property {string} nodeId - the target node ID (tab group or split)
 * @property {boolean} [disabled] - disable drop zone
 * @property {function} [onDrop] - callback after drop
 */

/**
 * Hook that makes an element a drop target for docking operations.
 * Returns props to attach to the drop target element and the current
 * hover zone state for rendering overlays.
 *
 * @param {DropZoneOptions} options
 * @returns {{ dropProps: Object, hoverZone: string|null, isOver: boolean }}
 */
export function useDropZone({ nodeId, disabled = false, onDrop }) {
  const dispatch = useDispatch();
  const dragSourceTabId = useSelector(selectDragSourceTabId);
  const [hoverZone, setHoverZone] = useState(null);
  const [isOver, setIsOver] = useState(false);
  const elementRef = useRef(null);
  const dragCounter = useRef(0); // Handle nested enter/leave events

  const handleDragEnter = useCallback(
    (e) => {
      if (disabled) return;
      e.preventDefault();
      dragCounter.current++;

      if (dragCounter.current === 1) {
        setIsOver(true);
      }
    },
    [disabled]
  );

  const handleDragOver = useCallback(
    (e) => {
      if (disabled) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const target = elementRef.current || e.currentTarget;
      const rect = target.getBoundingClientRect();
      const hit = hitTestDropZone(rect, e.clientX, e.clientY);

      if (hit) {
        setHoverZone(hit.zone);
      }
    },
    [disabled]
  );

  const handleDragLeave = useCallback(
    (e) => {
      if (disabled) return;
      dragCounter.current--;

      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setIsOver(false);
        setHoverZone(null);
      }
    },
    [disabled]
  );

  const handleDrop = useCallback(
    (e) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      dragCounter.current = 0;
      setIsOver(false);
      setHoverZone(null);

      const payload = parseDragPayload(e);
      if (!payload) return;

      const target = elementRef.current || e.currentTarget;
      const rect = target.getBoundingClientRect();
      const hit = hitTestDropZone(rect, e.clientX, e.clientY);

      if (!hit) return;

      // For tab bar drops, calculate insertion index
      let tabIndex;
      if (hit.zone === 'tab-bar') {
        const tabBar = target.querySelector('[data-tab-bar]');
        if (tabBar) {
          tabIndex = getTabInsertIndex(tabBar, e.clientX);
        }
      }

      const dropTarget = {
        nodeId,
        zone: hit.zone,
        tabIndex,
      };

      dispatch(
        handleDropAction({
          drag: payload,
          target: dropTarget,
        })
      );

      onDrop?.(payload, dropTarget);
    },
    [nodeId, disabled, dispatch, onDrop]
  );

  const dropProps = {
    ref: elementRef,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
    'data-drop-node-id': nodeId,
  };

  return {
    dropProps,
    hoverZone,
    isOver: isOver && !!dragSourceTabId,
  };
}

export default useDropZone;
