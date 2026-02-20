/**
 * @fileoverview Hook for pop-out window (detached browser window) management.
 * Uses BroadcastChannel API for state synchronization.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { popoutTabAction, dockPopoutAction, selectPopouts, selectTabs } from '../state/layout-slice';
import { POPOUT_CHANNEL_NAME } from '../types';

/**
 * Hook for managing pop-out windows.
 * Handles opening browser windows and syncing state via BroadcastChannel.
 *
 * @param {Object} options
 * @param {string} [options.channelName] - BroadcastChannel name
 * @returns {Object}
 */
export function usePopout({ channelName = POPOUT_CHANNEL_NAME } = {}) {
  const dispatch = useDispatch();
  const popouts = useSelector(selectPopouts);
  const tabs = useSelector(selectTabs);
  const channelRef = useRef(null);
  const windowsRef = useRef(new Map());
  const [isSupported] = useState(() =>
    typeof window !== 'undefined' && 'BroadcastChannel' in window
  );

  // Initialize BroadcastChannel
  useEffect(() => {
    if (!isSupported) return;

    const channel = new BroadcastChannel(channelName);
    channelRef.current = channel;

    channel.onmessage = (event) => {
      const { type, payload } = event.data;

      switch (type) {
        case 'POPOUT_READY':
          // Child window is ready — send it the tab data
          sendToPopout(payload.windowName, {
            type: 'POPOUT_INIT',
            payload: {
              tabId: payload.tabId,
              tab: tabs[payload.tabId],
            },
          });
          break;

        case 'POPOUT_CLOSED':
          // Child window was closed — dock it back
          const popoutEntry = Object.values(popouts).find(
            (p) => p.windowName === payload.windowName
          );
          if (popoutEntry) {
            dispatch(
              dockPopoutAction({
                popoutId: popoutEntry.id,
                targetTabGroupId: payload.targetTabGroupId || null,
              })
            );
          }
          break;

        case 'POPOUT_ACTION':
          // Forward an action from the popout window
          if (payload.action) {
            dispatch(payload.action);
          }
          break;
      }
    };

    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [isSupported, channelName, dispatch, popouts, tabs]);

  /**
   * Send a message to a specific popout window.
   */
  const sendToPopout = useCallback(
    (windowName, message) => {
      channelRef.current?.postMessage(message);
    },
    []
  );

  /**
   * Open a tab in a new browser window.
   */
  const openPopout = useCallback(
    (tabId, opts = {}) => {
      if (!isSupported) {
        console.warn('[docking-wm] BroadcastChannel not supported');
        return;
      }

      const windowName = `synthi-popout-${tabId}-${Date.now()}`;
      const width = opts.width || 800;
      const height = opts.height || 600;
      const left = opts.left ?? (window.screenX + 50);
      const top = opts.top ?? (window.screenY + 50);

      const features = [
        `width=${width}`,
        `height=${height}`,
        `left=${left}`,
        `top=${top}`,
        'menubar=no',
        'toolbar=no',
        'location=no',
        'status=no',
        'resizable=yes',
      ].join(',');

      // Open a minimal HTML page that will connect back via BroadcastChannel
      const popoutUrl = `/workspace/popout?tab=${encodeURIComponent(tabId)}&window=${encodeURIComponent(windowName)}`;
      const win = window.open(popoutUrl, windowName, features);

      if (win) {
        windowsRef.current.set(windowName, win);

        // Dispatch popout action
        dispatch(
          popoutTabAction({
            tabId,
            windowName,
            width,
            height,
          })
        );

        // Monitor for window close
        const checkClosed = setInterval(() => {
          if (win.closed) {
            clearInterval(checkClosed);
            windowsRef.current.delete(windowName);

            channelRef.current?.postMessage({
              type: 'POPOUT_CLOSED',
              payload: { windowName, tabId },
            });
          }
        }, 500);
      }
    },
    [isSupported, dispatch]
  );

  /**
   * Close and dock back a popout window.
   */
  const closePopout = useCallback(
    (popoutId, targetTabGroupId) => {
      const popoutEntry = popouts[popoutId];
      if (!popoutEntry) return;

      const win = windowsRef.current.get(popoutEntry.windowName);
      if (win && !win.closed) {
        win.close();
      }
      windowsRef.current.delete(popoutEntry.windowName);

      dispatch(
        dockPopoutAction({
          popoutId,
          targetTabGroupId,
        })
      );
    },
    [popouts, dispatch]
  );

  /**
   * Close all popout windows.
   */
  const closeAllPopouts = useCallback(() => {
    for (const [name, win] of windowsRef.current) {
      if (win && !win.closed) win.close();
    }
    windowsRef.current.clear();
  }, []);

  // Close all popouts on page unload
  useEffect(() => {
    const handleUnload = () => closeAllPopouts();
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [closeAllPopouts]);

  return {
    isSupported,
    openPopout,
    closePopout,
    closeAllPopouts,
    sendToPopout,
  };
}

export default usePopout;
