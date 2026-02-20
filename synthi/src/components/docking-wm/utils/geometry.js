/**
 * @fileoverview Drop zone geometry hit-testing.
 * Determines which drop zone a cursor is hovering over based on
 * the element's bounding rect and cursor position.
 */

import { DROP_ZONE, DROP_ZONE_EDGE_THRESHOLD, TAB_HEIGHT } from '../types';

/**
 * @typedef {Object} ZoneHitResult
 * @property {string} zone - DROP_ZONE value
 * @property {number} strength - 0 to 1, how deep into the zone
 */

/**
 * Determine which drop zone the cursor is within.
 * Returns null if outside the element.
 *
 * Zone layout (looking at the element rect):
 *
 *   ┌───────────────────────────┐
 *   │         TOP (25%)         │
 *   ├──────┬────────────┬──────┤
 *   │      │            │      │
 *   │ LEFT │   CENTER   │RIGHT │
 *   │(25%) │            │(25%) │
 *   │      │            │      │
 *   ├──────┴────────────┴──────┤
 *   │       BOTTOM (25%)       │
 *   └───────────────────────────┘
 *
 * @param {DOMRect} rect - bounding rect of the drop target element
 * @param {number} clientX - cursor X
 * @param {number} clientY - cursor Y
 * @param {number} [threshold] - fraction of edge that triggers split zones
 * @returns {ZoneHitResult|null}
 */
export function hitTestDropZone(rect, clientX, clientY, threshold = DROP_ZONE_EDGE_THRESHOLD) {
  const { left, top, width, height } = rect;

  // Relative position within the element (0 to 1)
  const relX = (clientX - left) / width;
  const relY = (clientY - top) / height;

  // Out of bounds check
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
    return null;
  }

  // Check if in tab bar region (top ~35px)
  if (clientY - top <= TAB_HEIGHT) {
    return { zone: DROP_ZONE.TAB_BAR, strength: 1 - relY };
  }

  // Edge zones
  const inLeft = relX < threshold;
  const inRight = relX > 1 - threshold;
  const inTop = relY < threshold;
  const inBottom = relY > 1 - threshold;

  // Corner disambiguation: pick the axis with stronger pull
  if (inLeft && inTop) {
    return relX / threshold < relY / threshold
      ? { zone: DROP_ZONE.LEFT, strength: 1 - relX / threshold }
      : { zone: DROP_ZONE.TOP, strength: 1 - relY / threshold };
  }
  if (inRight && inTop) {
    return (1 - relX) / threshold < relY / threshold
      ? { zone: DROP_ZONE.RIGHT, strength: (relX - (1 - threshold)) / threshold }
      : { zone: DROP_ZONE.TOP, strength: 1 - relY / threshold };
  }
  if (inLeft && inBottom) {
    return relX / threshold < (1 - relY) / threshold
      ? { zone: DROP_ZONE.LEFT, strength: 1 - relX / threshold }
      : { zone: DROP_ZONE.BOTTOM, strength: (relY - (1 - threshold)) / threshold };
  }
  if (inRight && inBottom) {
    return (1 - relX) / threshold < (1 - relY) / threshold
      ? { zone: DROP_ZONE.RIGHT, strength: (relX - (1 - threshold)) / threshold }
      : { zone: DROP_ZONE.BOTTOM, strength: (relY - (1 - threshold)) / threshold };
  }

  // Single edge
  if (inLeft) return { zone: DROP_ZONE.LEFT, strength: 1 - relX / threshold };
  if (inRight) return { zone: DROP_ZONE.RIGHT, strength: (relX - (1 - threshold)) / threshold };
  if (inTop) return { zone: DROP_ZONE.TOP, strength: 1 - relY / threshold };
  if (inBottom) return { zone: DROP_ZONE.BOTTOM, strength: (relY - (1 - threshold)) / threshold };

  // Center
  return { zone: DROP_ZONE.CENTER, strength: 0 };
}

/**
 * Calculate the CSS rect for a drop zone overlay preview.
 * Returns the percentage-based region to highlight.
 *
 * @param {string} zone - DROP_ZONE value
 * @param {number} [ratio] - how much of the area to show (default 0.5 = 50%)
 * @returns {{ top: string, left: string, width: string, height: string }}
 */
export function getDropZonePreviewRect(zone, ratio = 0.5) {
  switch (zone) {
    case DROP_ZONE.LEFT:
      return { top: '0%', left: '0%', width: `${ratio * 100}%`, height: '100%' };
    case DROP_ZONE.RIGHT:
      return { top: '0%', left: `${(1 - ratio) * 100}%`, width: `${ratio * 100}%`, height: '100%' };
    case DROP_ZONE.TOP:
      return { top: '0%', left: '0%', width: '100%', height: `${ratio * 100}%` };
    case DROP_ZONE.BOTTOM:
      return { top: `${(1 - ratio) * 100}%`, left: '0%', width: '100%', height: `${ratio * 100}%` };
    case DROP_ZONE.CENTER:
    case DROP_ZONE.TAB_BAR:
    default:
      return { top: '0%', left: '0%', width: '100%', height: '100%' };
  }
}

/**
 * Calculate tab insertion index from cursor position in the tab bar.
 *
 * @param {HTMLElement} tabBarElement - the tab bar container element
 * @param {number} clientX - cursor X position
 * @returns {number} insertion index
 */
export function getTabInsertIndex(tabBarElement, clientX) {
  if (!tabBarElement) return 0;

  const tabs = Array.from(tabBarElement.querySelectorAll('[data-tab-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (clientX < midX) return i;
  }
  return tabs.length;
}

/**
 * Get the compass direction icon/indicator for a drop zone.
 * @param {string} zone
 * @returns {string}
 */
export function getDropZoneLabel(zone) {
  const labels = {
    [DROP_ZONE.LEFT]: '← Split Left',
    [DROP_ZONE.RIGHT]: 'Split Right →',
    [DROP_ZONE.TOP]: '↑ Split Top',
    [DROP_ZONE.BOTTOM]: 'Split Bottom ↓',
    [DROP_ZONE.CENTER]: 'Add to Tabs',
    [DROP_ZONE.TAB_BAR]: 'Insert Tab',
  };
  return labels[zone] || zone;
}
