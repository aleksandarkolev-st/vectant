/**
 * @fileoverview PanelGrip — drag affordance for panel headers and title bars.
 * Provides a subtle visual indicator that an element is draggable.
 */

'use client';

import React from 'react';

/**
 * Drag grip indicator — 6 dots arranged in a 2x3 grid.
 * Used in tab bars and floating window title bars.
 *
 * @param {Object} props
 * @param {'horizontal'|'vertical'} [props.orientation] - grip orientation
 * @param {boolean} [props.visible] - controls opacity
 */
export function PanelGrip({ orientation = 'vertical', visible = true }) {
  const isVertical = orientation === 'vertical';
  const dots = isVertical
    ? [
        [0, 0], [4, 0],
        [0, 4], [4, 4],
        [0, 8], [4, 8],
      ]
    : [
        [0, 0], [0, 4],
        [4, 0], [4, 4],
        [8, 0], [8, 4],
      ];

  return (
    <div
      className="dock-panel-grip"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: isVertical ? '12px' : '16px',
        height: isVertical ? '16px' : '12px',
        cursor: 'grab',
        opacity: visible ? 0.35 : 0,
        transition: 'opacity 0.15s ease',
        flexShrink: 0,
      }}
    >
      <svg
        width={isVertical ? 8 : 12}
        height={isVertical ? 12 : 8}
        viewBox={isVertical ? '0 0 8 12' : '0 0 12 8'}
      >
        {dots.map(([x, y], i) => (
          <circle
            key={i}
            cx={x + 1.5}
            cy={y + 1.5}
            r="1"
            fill="var(--dock-tab-fg, #969696)"
          />
        ))}
      </svg>
    </div>
  );
}

export default PanelGrip;
