/**
 * @fileoverview PopoutWindow — content for a detached browser window.
 * This component runs inside the pop-out window.
 */

'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { POPOUT_CHANNEL_NAME } from '../types';
import { PanelContainer } from './PanelContainer';
import { usePanelRegistry } from '../state/panel-registry';

/**
 * PopoutWindowContent — renders panel content in a detached browser window.
 * Communicates with the parent window via BroadcastChannel.
 *
 * URL params expected: ?tab=<tabId>&window=<windowName>
 */
export function PopoutWindowContent() {
  const [tab, setTab] = useState(null);
  const [windowName, setWindowName] = useState(null);
  const [connected, setConnected] = useState(false);
  const registry = usePanelRegistry();

  useEffect(() => {
    // Parse URL params
    const params = new URLSearchParams(window.location.search);
    const tabId = params.get('tab');
    const winName = params.get('window');
    setWindowName(winName);

    if (!tabId || !winName) return;

    // Connect to parent via BroadcastChannel
    const channel = new BroadcastChannel(POPOUT_CHANNEL_NAME);

    channel.onmessage = (event) => {
      const { type, payload } = event.data;

      switch (type) {
        case 'POPOUT_INIT':
          if (payload.tabId === tabId) {
            setTab(payload.tab);
            setConnected(true);
          }
          break;

        case 'POPOUT_STATE_UPDATE':
          // Could receive state updates from parent
          if (payload.tab) {
            setTab((prev) => ({ ...prev, ...payload.tab }));
          }
          break;
      }
    };

    // Signal readiness to parent
    channel.postMessage({
      type: 'POPOUT_READY',
      payload: { tabId, windowName: winName },
    });

    // Handle window close
    const handleBeforeUnload = () => {
      channel.postMessage({
        type: 'POPOUT_CLOSED',
        payload: { windowName: winName, tabId },
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      channel.close();
    };
  }, []);

  // Inject dark theme
  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.backgroundColor = '#1e1e1e';
    document.body.style.color = '#d4d4d4';
    document.body.style.fontFamily =
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    document.body.style.overflow = 'hidden';
  }, []);

  if (!connected || !tab) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: '#969696',
          fontSize: '14px',
          backgroundColor: '#1e1e1e',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: '8px', fontSize: '16px' }}>
            Connecting to Synthi...
          </div>
          <div style={{ opacity: 0.5 }}>
            Waiting for parent window
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        backgroundColor: '#1e1e1e',
      }}
    >
      {/* Minimal title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '32px',
          padding: '0 12px',
          backgroundColor: '#252526',
          borderBottom: '1px solid #2d2d2d',
          fontSize: '12px',
          color: '#d4d4d4',
          gap: '8px',
          WebkitAppRegion: 'drag',
        }}
      >
        <span style={{ opacity: 0.5 }}>Synthi</span>
        <span style={{ opacity: 0.3 }}>|</span>
        <span>{tab.title}</span>
      </div>

      {/* Panel content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <PanelContainer
          tab={tab}
          isActive={true}
          tabGroupId={`popout-${windowName}`}
        />
      </div>
    </div>
  );
}

export default PopoutWindowContent;
