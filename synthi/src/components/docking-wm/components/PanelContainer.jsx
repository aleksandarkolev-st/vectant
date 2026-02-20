/**
 * @fileoverview PanelContainer — wrapper around the actual panel content.
 * Resolves the panel component from the registry and renders it.
 */

'use client';

import React, { memo, Suspense, useMemo } from 'react';
import { usePanelRegistry } from '../state/panel-registry';

/**
 * Renders the panel component for a given tab.
 * Looks up the panel type in the registry and renders the component.
 *
 * @param {Object} props
 * @param {import('../types').TabDefinition} props.tab - the tab definition
 * @param {boolean} props.isActive - whether this tab is the active/visible one
 * @param {string} props.tabGroupId - parent tab group ID
 */
export const PanelContainer = memo(function PanelContainer({
  tab,
  isActive,
  tabGroupId,
}) {
  const registry = usePanelRegistry();
  const panelDef = registry.get(tab.panelType);

  const panelProps = useMemo(
    () => ({
      tabId: tab.id,
      panelType: tab.panelType,
      tabGroupId,
      data: tab.data || {},
      isActive,
    }),
    [tab.id, tab.panelType, tab.data, tabGroupId, isActive]
  );

  if (!panelDef) {
    return (
      <div
        className="dock-panel-missing"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--dock-tab-fg, #969696)',
          fontSize: '13px',
          fontFamily: 'var(--dock-font, inherit)',
        }}
      >
        <span>
          Panel type &quot;{tab.panelType}&quot; not registered
        </span>
      </div>
    );
  }

  const PanelComponent = panelDef.component;

  if (!PanelComponent) {
    return (
      <div
        className="dock-panel-missing"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--dock-tab-fg, #969696)',
          fontSize: '13px',
          fontFamily: 'var(--dock-font, inherit)',
        }}
      >
        <span>
          Panel &quot;{tab.panelType}&quot; has no component
        </span>
      </div>
    );
  }

  return (
    <div
      className="dock-panel-container"
      role="tabpanel"
      aria-labelledby={tab.id}
      style={{
        // Each tab's content fills the area, hidden when not active
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Suspense
        fallback={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--dock-tab-fg, #969696)',
            }}
          >
            Loading...
          </div>
        }
      >
        <PanelComponent {...panelProps} />
      </Suspense>
    </div>
  );
});

/**
 * Renders panel content for all tabs in a group.
 * Keeps inactive panels mounted but hidden (display: none) for state preservation.
 *
 * @param {Object} props
 * @param {import('../types').TabDefinition[]} props.tabs
 * @param {string|null} props.activeTabId
 * @param {string} props.tabGroupId
 */
export function PanelContentArea({ tabs, activeTabId, tabGroupId }) {
  return (
    <div
      className="dock-panel-content-area"
      style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        minHeight: 0,
        minWidth: 0,
        position: 'relative',
      }}
    >
      {tabs.map((tab) => (
        <PanelContainer
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          tabGroupId={tabGroupId}
        />
      ))}
    </div>
  );
}

export default PanelContainer;
