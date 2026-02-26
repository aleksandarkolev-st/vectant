// src/components/healing/HealingToast.jsx
// Bridges the Redux healing toast queue to the Sonner toast system.
// Automatically dequeues and renders toast notifications when healing
// fixes are applied, undone, or encounter errors.
'use client';

import { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { toast } from 'sonner';
import { selectNextToast, selectHealingEnabled } from '@/redux/healingSelectors';
import { dequeueToast } from '@/redux/healingSlice';

// Category → human-readable label
const CATEGORY_LABELS = {
  missing_colon: 'Missing colon',
  missing_semicolon: 'Missing semicolon',
  missing_bracket: 'Missing bracket',
  unused_import: 'Unused import',
  missing_import: 'Missing import',
  duplicate_import: 'Duplicate import',
  trailing_whitespace: 'Trailing whitespace',
  missing_newline_eof: 'Missing newline at EOF',
  unclosed_string: 'Unclosed string',
  mismatched_quotes: 'Mismatched quotes',
  none_comparison: 'None comparison style',
  trailing_comma: 'Trailing comma',
  missing_include: 'Missing #include',
};

function formatCategory(cat) {
  return CATEGORY_LABELS[cat] || cat?.replace(/_/g, ' ') || 'Issue';
}

/**
 * HealingToast – renders as an invisible component that watches the
 * Redux toast queue and calls `toast()` from Sonner.
 *
 * @param {Object} props
 * @param {Function} [props.onUndo] – callback when user clicks "Undo" on a toast
 */
export function HealingToast({ onUndo }) {
  const dispatch = useDispatch();
  const nextToast = useSelector(selectNextToast);
  const enabled = useSelector(selectHealingEnabled);
  const lastToastId = useRef(null);

  useEffect(() => {
    if (!nextToast || !enabled) return;
    // Prevent showing same toast twice
    if (nextToast.id === lastToastId.current) return;
    lastToastId.current = nextToast.id;

    const { type, message, details, fixCount, undoable } = nextToast;

    // Determine toast variant based on type
    if (type === 'healing') {
      toast.success(message, {
        description: details ? formatCategory(details) : undefined,
        duration: 4000,
        action: undoable && onUndo
          ? {
              label: 'Undo',
              onClick: () => onUndo(),
            }
          : undefined,
        icon: '🩹',
      });
    } else if (type === 'healing-undo') {
      toast.info(message, {
        duration: 3000,
        icon: '↩️',
      });
    } else if (type === 'healing-error') {
      toast.error(message, {
        description: details,
        duration: 5000,
        icon: '⚠️',
      });
    } else {
      toast(message, {
        description: details,
        duration: 4000,
      });
    }

    // Dequeue after rendering
    dispatch(dequeueToast());
  }, [nextToast, enabled, onUndo, dispatch]);

  // This component renders nothing visible – it's a toast bridge
  return null;
}

export default HealingToast;
