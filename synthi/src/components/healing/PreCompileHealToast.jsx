// src/components/healing/PreCompileHealToast.jsx
// Shows a brief toast notification when the pre-compile healer fixes
// syntax issues before HMR compilation. Listens for the
// `synthi:pre-compile-heal` custom event dispatched by page.jsx.
'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

// Category → human-readable label
const CATEGORY_LABELS = {
  missing_colon: 'Missing colon',
  missing_semicolon: 'Missing semicolon',
  missing_bracket: 'Missing bracket',
  unclosed_string: 'Unclosed string',
};

function formatCategory(cat) {
  return CATEGORY_LABELS[cat] || cat?.replace(/_/g, ' ') || 'Syntax fix';
}

/**
 * PreCompileHealToast – invisible component that watches for pre-compile
 * heal events and renders toast notifications.
 */
export function PreCompileHealToast() {
  useEffect(() => {
    const handler = (e) => {
      const { fixes, filename, elapsedMs } = e.detail || {};
      if (!fixes || fixes.length === 0) return;

      // Build summary: "Fixed 2 issues: Missing colon (L5), Missing semicolon (L12)"
      const fixDescriptions = fixes
        .slice(0, 3) // Show max 3 in toast
        .map(f => `${formatCategory(f.category)} (L${f.line})`)
        .join(', ');

      const extra = fixes.length > 3 ? ` +${fixes.length - 3} more` : '';
      const shortName = filename ? filename.split('/').pop() : '';

      toast.success(
        `Pre-compile: fixed ${fixes.length} issue${fixes.length > 1 ? 's' : ''}`,
        {
          description: `${fixDescriptions}${extra}${shortName ? ` in ${shortName}` : ''}`,
          duration: 3000,
          icon: '⚡',
        }
      );
    };

    window.addEventListener('synthi:pre-compile-heal', handler);
    return () => window.removeEventListener('synthi:pre-compile-heal', handler);
  }, []);

  return null; // Invisible — just listens for events
}
