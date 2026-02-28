// src/components/healing/aiNotifications.js
// Notification utilities for AI-detected fixes.
//
// When the AI finds high-severity issues, these helpers can:
// 1. Flash the editor border as a visual alert
// 2. Show a browser Notification (if permitted)
// 3. Play a subtle alert sound (if permitted)
//
// Usage:
//   import { notifyAIFixes } from './aiNotifications';
//   notifyAIFixes(fixes, { sound: true, flash: editorRef.current });

const SEVERITY_PRIORITY = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  trivial: 0,
};

/**
 * Flash the editor DOM element border briefly.
 * @param {HTMLElement|null} editorElement
 * @param {'critical'|'high'|'moderate'} severity
 */
function flashBorder(editorElement, severity = 'high') {
  if (!editorElement) return;

  const color =
    severity === 'critical' ? 'rgba(239,68,68,0.6)' :
    severity === 'high'     ? 'rgba(251,146,60,0.5)' :
                              'rgba(250,204,21,0.3)';

  const prev = editorElement.style.boxShadow;
  editorElement.style.boxShadow = `inset 0 0 0 2px ${color}`;
  editorElement.style.transition = 'box-shadow 0.3s ease';

  setTimeout(() => {
    editorElement.style.boxShadow = prev || 'none';
  }, 1200);
}

/**
 * Show a browser notification for critical/high-severity AI fixes.
 * @param {Array} fixes
 */
function showBrowserNotification(fixes) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    // Request permission silently — don't block
    Notification.requestPermission().catch(() => {});
    return;
  }

  const critical = fixes.filter((f) => (f.severity || 'moderate') === 'critical');
  const high = fixes.filter((f) => (f.severity || 'moderate') === 'high');

  const count = critical.length + high.length;
  if (count === 0) return;

  const severity = critical.length > 0 ? 'Critical' : 'High';
  const body = fixes
    .slice(0, 3)
    .map((f) => `L${f.line ?? '?'}: ${f.description || 'AI-detected issue'}`)
    .join('\n');

  try {
    new Notification(`${severity}: ${count} AI issue${count > 1 ? 's' : ''} found`, {
      body,
      icon: '/favicon.ico',
      tag: 'ai-healing',
      requireInteraction: false,
    });
  } catch {
    // Browser may block in certain contexts
  }
}


/**
 * Notify the user about AI-detected fixes.
 *
 * @param {Array}   fixes
 * @param {Object}  options
 * @param {boolean} [options.browserNotify=true] — show browser notification for high/critical
 * @param {HTMLElement|null} [options.flash=null] — DOM element to flash
 * @param {number}  [options.minSeverityForFlash=2] — minimum severity level (0–4) to flash
 */
export function notifyAIFixes(fixes, options = {}) {
  if (!fixes || fixes.length === 0) return;

  const {
    browserNotify = true,
    flash = null,
    minSeverityForFlash = 2,
  } = options;

  // Find the highest severity
  let maxSev = 'trivial';
  let maxPriority = 0;
  for (const fix of fixes) {
    const sev = fix.severity || 'moderate';
    const p = SEVERITY_PRIORITY[sev] ?? 0;
    if (p > maxPriority) {
      maxPriority = p;
      maxSev = sev;
    }
  }

  // Flash editor border
  if (flash && maxPriority >= minSeverityForFlash) {
    flashBorder(flash, maxSev);
  }

  // Browser notification for high/critical
  if (browserNotify && maxPriority >= 3) {
    showBrowserNotification(fixes);
  }
}


/**
 * Request notification permission proactively.
 * Call this early (e.g., on first AI analysis).
 */
export function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}
