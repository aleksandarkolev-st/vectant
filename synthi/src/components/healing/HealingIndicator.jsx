// src/components/healing/HealingIndicator.jsx
// Status-bar-sized indicator for the self-healing system.
// Shows current state (active/idle/cooldown/off), fix count,
// and provides a quick toggle + popover with recent activity.
'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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
  // Pull triggers so the tooltip can explain when healing won't fire.
  const triggers = useSelector((s) => s.healing?.config?.triggers || {});

  const handleClick = useCallback(() => {
    dispatch(toggleHealing());
  }, [dispatch]);

  // ── Fix-applied pulse ─────────────────────────────────────────────
  // When the applied-fix count increments, briefly flash the whole pill
  // with a brand glow and bounce-pop the count chip. We track the
  // previous count in a ref so we only fire on increment (not on
  // unrelated re-renders or when counts reset on disable).
  const prevAppliedRef = useRef(appliedCount);
  const [justApplied, setJustApplied] = useState(false);
  useEffect(() => {
    if (appliedCount > prevAppliedRef.current && enabled) {
      setJustApplied(true);
      const timer = window.setTimeout(() => setJustApplied(false), 720);
      prevAppliedRef.current = appliedCount;
      return () => window.clearTimeout(timer);
    }
    prevAppliedRef.current = appliedCount;
  }, [appliedCount, enabled]);

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

  // Build a multi-line diagnostic tooltip so the user can tell at a
  // glance WHY healing isn't firing (off / waiting for save / AI off).
  const tooltip = (() => {
    if (!enabled) {
      return 'Self-healing is OFF.\nClick to enable.';
    }
    const lines = [summary || 'Self-healing is on'];
    if (pendingCount > 0) {
      lines.push(`${pendingCount} pending fix${pendingCount === 1 ? '' : 'es'}`);
    }
    if (status === 'idle') {
      const hints = [];
      if (!triggers.onDiagnosticsStable && triggers.onSave) {
        hints.push('Only runs on save (Ctrl+S). Enable "When diagnostics stabilize" in settings to run on type.');
      }
      if (!triggers.useAIForHard) {
        hints.push('AI escalation is off — typos / logic errors will not be caught. Enable "Also try AI for tricky errors" in settings.');
      }
      if (hints.length) {
        lines.push('—');
        lines.push(...hints);
      }
    }
    lines.push('—');
    lines.push('Click to toggle');
    return lines.join('\n');
  })();

  return (
    <div
      onClick={handleClick}
      className={[
        'flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all hover:opacity-80',
        s.pulse ? 'vt-brand-pulse' : '',
        justApplied ? 'heal-applied-flash' : '',
      ].filter(Boolean).join(' ')}
      style={{ background: s.bgColor, boxShadow: s.ringStyle }}
      title={tooltip}
    >
      <s.Icon
        className={`w-3.5 h-3.5 ${s.animate ? 'animate-spin' : ''}`}
        style={{ color: s.dotColor }}
        strokeWidth={2}
      />
      {/* Counts are always shown (they're number-only and tiny).
          Text labels ("Heal", "Heal Off") hide below xl so cramped
          islands keep just the icon. */}
      {enabled && appliedCount > 0 ? (
        <span
          key={appliedCount /* re-key on change → re-fire pop animation */}
          className={`status-island-number font-semibold text-[11px] ${justApplied ? 'heal-count-pop' : ''}`}
          style={{ color: s.textColor, fontVariantNumeric: 'tabular-nums' }}
        >
          {appliedCount}
        </span>
      ) : (
        <span
          className="status-island-label hidden 2xl:inline font-semibold text-[11px]"
          style={{ color: s.textColor }}
        >
          {enabled ? 'Heal' : 'Heal Off'}
        </span>
      )}
    </div>
  );
}

export default HealingIndicator;
