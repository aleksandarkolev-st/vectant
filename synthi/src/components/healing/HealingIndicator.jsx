// src/components/healing/HealingIndicator.jsx
// Status-bar-sized indicator for the self-healing system.
// Shows current state (active/idle/cooldown/off), fix count,
// and provides a quick toggle + popover with recent activity.
'use client';

import { useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectHealingEnabled,
  selectHealingStatus,
  selectHealingSummary,
  selectAppliedFixCount,
  selectPendingFixCount,
  selectIsHealingActive,
} from '@/redux/healingSelectors';
import { toggleHealing } from '@/redux/healingSlice';
import { Heart, HeartOff, Loader2, Pause, Check } from 'lucide-react';

/**
 * Compact indicator for the workspace status bar.
 * Click toggles healing on/off.
 */
export function HealingIndicator() {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const status = useSelector(selectHealingStatus);
  const summary = useSelector(selectHealingSummary);
  const appliedCount = useSelector(selectAppliedFixCount);
  const pendingCount = useSelector(selectPendingFixCount);
  const isActive = useSelector(selectIsHealingActive);

  const handleClick = useCallback(() => {
    dispatch(toggleHealing());
  }, [dispatch]);

  // Determine visual style based on status
  const getStyle = () => {
    if (!enabled) {
      return {
        dotColor: 'var(--text-muted)',
        textColor: 'var(--text-muted)',
        bgColor: 'transparent',
        Icon: HeartOff,
        animate: false,
      };
    }
    switch (status) {
      case 'analyzing':
        return {
          dotColor: 'var(--accent-warning)',
          textColor: 'var(--accent-warning)',
          bgColor: 'color-mix(in srgb, var(--accent-warning) 5%, transparent)',
          Icon: Loader2,
          animate: true,
        };
      case 'applying':
        // AI is actively healing — full signature moment.
        // Brand-gradient text + pulse glow.
        return {
          dotColor: 'var(--brand-stop-3)',
          textColor: 'var(--brand-stop-3)',
          bgColor: 'color-mix(in srgb, var(--brand-stop-3) 8%, transparent)',
          ringStyle: '0 0 0 1px color-mix(in srgb, var(--brand-stop-3) 28%, transparent), 0 0 14px -2px color-mix(in srgb, var(--brand-stop-3) 38%, transparent)',
          pulse: true,
          Icon: Loader2,
          animate: true,
        };
      case 'cooldown':
        return {
          dotColor: 'var(--accent-info, #60a5fa)',
          textColor: 'var(--text-secondary)',
          bgColor: 'transparent',
          Icon: Pause,
          animate: false,
        };
      case 'error':
        return {
          dotColor: 'var(--accent-danger)',
          textColor: 'var(--accent-danger)',
          bgColor: 'color-mix(in srgb, var(--accent-danger) 5%, transparent)',
          Icon: Heart,
          animate: false,
        };
      default: // idle
        return {
          dotColor: 'var(--accent-success)',
          textColor: 'var(--text-secondary)',
          bgColor: 'transparent',
          Icon: appliedCount > 0 ? Check : Heart,
          animate: false,
        };
    }
  };

  const s = getStyle();

  return (
    <div
      onClick={handleClick}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all hover:opacity-80 ${s.pulse ? 'vt-brand-pulse' : ''}`}
      style={{ background: s.bgColor, boxShadow: s.ringStyle }}
      title={`${summary}${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}\nClick to toggle`}
    >
      <s.Icon
        className={`w-3.5 h-3.5 ${s.animate ? 'animate-spin' : ''}`}
        style={{ color: s.dotColor }}
        strokeWidth={2}
      />
      <span
        className="font-semibold text-[11px]"
        style={{ color: s.textColor }}
      >
        {enabled ? (appliedCount > 0 ? `${appliedCount}` : 'Heal') : 'Heal Off'}
      </span>
    </div>
  );
}

export default HealingIndicator;
