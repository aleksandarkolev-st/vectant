/**
 * @fileoverview DropOverlay — translucent overlay showing where a panel will land.
 * Rendered inside a tab group when a drag is hovering over it.
 */

'use client';

import React from 'react';
import { getDropZonePreviewRect, getDropZoneLabel } from '../utils/geometry';
import { DROP_ZONE } from '../types';

/**
 * A translucent overlay showing the drop zone preview.
 * Renders on top of a PanelContainer when a drag is active.
 *
 * @param {Object} props
 * @param {string|null} props.zone - current DROP_ZONE or null
 * @param {boolean} props.visible
 */
export function DropOverlay({ zone, visible }) {
  if (!visible || !zone) return null;

  const rect = getDropZonePreviewRect(zone, 0.5);
  const isCenter = zone === DROP_ZONE.CENTER || zone === DROP_ZONE.TAB_BAR;

  return (
    <div
      className="dock-drop-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 50,
        overflow: 'hidden',
      }}
    >
      {/* Zone highlight */}
      <div
        className="dock-drop-overlay__zone"
        style={{
          position: 'absolute',
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          backgroundColor: isCenter
            ? 'rgba(0, 122, 204, 0.15)'
            : 'rgba(0, 122, 204, 0.20)',
          border: `2px solid rgba(0, 122, 204, ${isCenter ? 0.4 : 0.6})`,
          borderRadius: '2px',
          transition: 'all 0.1s ease-out',
        }}
      />

      {/* Compass indicator dots */}
      <DropZoneIndicators activeZone={zone} />
    </div>
  );
}

/**
 * Compass-style indicators showing possible drop zones.
 * A small diamond/circle at each edge and center.
 */
function DropZoneIndicators({ activeZone }) {
  const zones = [
    { zone: DROP_ZONE.LEFT, style: { top: '50%', left: '12%', transform: 'translate(-50%, -50%)' } },
    { zone: DROP_ZONE.RIGHT, style: { top: '50%', right: '12%', transform: 'translate(50%, -50%)' } },
    { zone: DROP_ZONE.TOP, style: { top: '12%', left: '50%', transform: 'translate(-50%, -50%)' } },
    { zone: DROP_ZONE.BOTTOM, style: { bottom: '12%', left: '50%', transform: 'translate(-50%, 50%)' } },
    { zone: DROP_ZONE.CENTER, style: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } },
  ];

  return (
    <>
      {zones.map(({ zone, style }) => {
        const isActive = activeZone === zone;
        return (
          <div
            key={zone}
            style={{
              position: 'absolute',
              ...style,
              width: isActive ? '28px' : '24px',
              height: isActive ? '28px' : '24px',
              borderRadius: zone === DROP_ZONE.CENTER ? '4px' : '50%',
              backgroundColor: isActive
                ? 'rgba(0, 122, 204, 0.9)'
                : 'rgba(255, 255, 255, 0.08)',
              border: `1.5px solid ${
                isActive ? 'rgba(0, 122, 204, 1)' : 'rgba(255, 255, 255, 0.15)'
              }`,
              transition: 'all 0.12s ease-out',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            {isActive && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                style={{ opacity: 0.95 }}
              >
                {zone === DROP_ZONE.CENTER ? (
                  <rect x="2" y="2" width="8" height="8" rx="1" fill="white" />
                ) : zone === DROP_ZONE.LEFT ? (
                  <path d="M8 2L4 6L8 10" stroke="white" strokeWidth="2" fill="none" />
                ) : zone === DROP_ZONE.RIGHT ? (
                  <path d="M4 2L8 6L4 10" stroke="white" strokeWidth="2" fill="none" />
                ) : zone === DROP_ZONE.TOP ? (
                  <path d="M2 8L6 4L10 8" stroke="white" strokeWidth="2" fill="none" />
                ) : zone === DROP_ZONE.BOTTOM ? (
                  <path d="M2 4L6 8L10 4" stroke="white" strokeWidth="2" fill="none" />
                ) : null}
              </svg>
            )}
          </div>
        );
      })}
    </>
  );
}

export default DropOverlay;
