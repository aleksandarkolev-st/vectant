// src/hooks/useAIHealingKeyboard.js
// Keyboard shortcuts for the AI healing subsystem.
//
// Shortcuts (all Ctrl+Shift):
//   I — Run AI analysis on current file
//   Y — Apply all safe AI fixes
//   N — Dismiss all AI fixes
//   M — Toggle AI mode (ai ↔ hybrid)
'use client';

import { useEffect, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectAIEnabled,
  selectAIMode,
} from '@/redux/healingSelectors';
import {
  setAIEnabled,
  setAIMode,
  enqueueToast,
} from '@/redux/healingSlice';


/**
 * @param {Object}  opts
 * @param {Object}  opts.aiHealing  – return value of useAIHealing()
 */
export function useAIHealingKeyboard({ aiHealing } = {}) {
  const dispatch = useDispatch();
  const aiEnabled = useSelector(selectAIEnabled);
  const aiMode = useSelector(selectAIMode);

  const handleKeyDown = useCallback(
    (e) => {
      // All AI shortcuts use Ctrl+Shift (Cmd+Shift on Mac)
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;

      switch (e.key.toUpperCase()) {
        // ── Ctrl+Shift+I — Trigger AI analysis ────────────────────
        case 'I': {
          e.preventDefault();
          if (!aiEnabled) {
            dispatch(enqueueToast({ message: 'AI Healing is disabled', type: 'info' }));
            return;
          }
          if (aiHealing?.isAnalyzing) return; // already running
          aiHealing?.analyze?.();
          break;
        }

        // ── Ctrl+Shift+Y — Apply all safe AI fixes ───────────────
        case 'Y': {
          e.preventDefault();
          if (!aiEnabled) return;
          const count = aiHealing?.applyAllSafe?.() ?? 0;
          if (count === 0) {
            dispatch(enqueueToast({ message: 'No safe AI fixes to apply', type: 'info' }));
          }
          break;
        }

        // ── Ctrl+Shift+N — Dismiss all AI fixes ──────────────────
        case 'N': {
          e.preventDefault();
          if (!aiEnabled) return;
          aiHealing?.dismissAll?.();
          dispatch(enqueueToast({ message: 'All AI fixes dismissed', type: 'info' }));
          break;
        }

        // ── Ctrl+Shift+M — Toggle AI mode ────────────────────────
        case 'M': {
          e.preventDefault();
          const newMode = aiMode === 'ai' ? 'hybrid' : 'ai';
          dispatch(setAIMode(newMode));
          dispatch(enqueueToast({
            message: `AI mode: ${newMode === 'hybrid' ? 'Hybrid (regex + AI)' : 'AI only'}`,
            type: 'info',
          }));
          break;
        }

        default:
          break;
      }
    },
    [dispatch, aiEnabled, aiMode, aiHealing]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return {
    aiEnabled,
    aiMode,
    shortcuts: [
      { key: 'Ctrl+Shift+I', action: 'Run AI analysis' },
      { key: 'Ctrl+Shift+Y', action: 'Apply all safe AI fixes' },
      { key: 'Ctrl+Shift+N', action: 'Dismiss all AI fixes' },
      { key: 'Ctrl+Shift+M', action: 'Toggle AI mode (ai/hybrid)' },
    ],
  };
}
