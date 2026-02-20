/**
 * @fileoverview ARIA attribute helpers for the docking system.
 *
 * Ensures the docking UI is navigable by screen readers and
 * conforms to WAI-ARIA tab, tabpanel, and splitter patterns.
 */

// ────────────────────────────────────────────────────────
//  Tab ARIA roles
// ────────────────────────────────────────────────────────

/**
 * Generate ARIA attributes for a tab element.
 *
 * @param {Object} params
 * @param {string} params.tabId     - Unique tab identifier
 * @param {string} params.panelId   - Associated tabpanel ID
 * @param {boolean} params.isActive - Whether this tab is the selected tab
 * @param {number} params.index     - Position in the tab list (0-based)
 * @param {number} params.total     - Total number of tabs
 * @returns {Object} ARIA props to spread on the tab element
 */
export function getTabAriaProps({ tabId, panelId, isActive, index, total }) {
  return {
    role: 'tab',
    id: `tab-${tabId}`,
    'aria-controls': `tabpanel-${panelId}`,
    'aria-selected': isActive,
    tabIndex: isActive ? 0 : -1,
    'aria-setsize': total,
    'aria-posinset': index + 1,
  };
}

/**
 * ARIA attributes for the tab list (tab bar container).
 *
 * @param {Object} params
 * @param {string} params.groupId  - Tab group identifier
 * @param {string} [params.label]  - Accessible label for the tab list
 * @returns {Object}
 */
export function getTabListAriaProps({ groupId, label }) {
  return {
    role: 'tablist',
    'aria-label': label || 'Panel tabs',
    'aria-orientation': 'horizontal',
    id: `tablist-${groupId}`,
  };
}

/**
 * ARIA attributes for the tab panel content area.
 *
 * @param {Object} params
 * @param {string} params.tabId   - The active tab's ID
 * @param {string} params.panelId - Unique panel ID
 * @param {string} [params.label] - Accessible label
 * @returns {Object}
 */
export function getTabPanelAriaProps({ tabId, panelId, label }) {
  return {
    role: 'tabpanel',
    id: `tabpanel-${panelId}`,
    'aria-labelledby': `tab-${tabId}`,
    'aria-label': label,
    tabIndex: 0,
  };
}

// ────────────────────────────────────────────────────────
//  Splitter ARIA roles
// ────────────────────────────────────────────────────────

/**
 * ARIA attributes for a resize splitter.
 *
 * @param {Object} params
 * @param {string}  params.direction    - 'row' or 'column'
 * @param {number}  params.valueNow     - Current size as percentage (0-100)
 * @param {number}  [params.valueMin=0]
 * @param {number}  [params.valueMax=100]
 * @param {string}  [params.label]
 * @returns {Object}
 */
export function getSplitterAriaProps({
  direction,
  valueNow,
  valueMin = 0,
  valueMax = 100,
  label,
}) {
  return {
    role: 'separator',
    'aria-orientation': direction === 'row' ? 'vertical' : 'horizontal',
    'aria-valuenow': Math.round(valueNow),
    'aria-valuemin': valueMin,
    'aria-valuemax': valueMax,
    'aria-label': label || (direction === 'row' ? 'Resize horizontal' : 'Resize vertical'),
    tabIndex: 0,
  };
}

// ────────────────────────────────────────────────────────
//  Floating window ARIA
// ────────────────────────────────────────────────────────

/**
 * ARIA attributes for a floating window.
 *
 * @param {Object} params
 * @param {string} params.title - Window title
 * @returns {Object}
 */
export function getFloatingWindowAriaProps({ title }) {
  return {
    role: 'dialog',
    'aria-label': title || 'Floating panel',
    'aria-modal': false,
  };
}

// ────────────────────────────────────────────────────────
//  Drop zone ARIA (live region for DnD announcements)
// ────────────────────────────────────────────────────────

/**
 * ARIA attributes for a drag-and-drop live region.
 * Attach to a visually-hidden element that announces DnD state.
 *
 * @returns {Object}
 */
export function getDnDLiveRegionProps() {
  return {
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': true,
    className: 'sr-only', // Tailwind screen-reader only class
  };
}
