// src/components/healing/HealingPresetSelector.jsx
// Allows users to quickly switch between healing configuration presets.
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

const PRESETS = [
  {
    id: 'conservative',
    label: 'Conservative',
    icon: '🛡️',
    desc: 'High confidence only (≥ 0.95). Safe whitespace & formatting fixes.',
    color: 'var(--accent-success)',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    icon: '⚖️',
    desc: 'Medium confidence (≥ 0.8). Most common issues auto-fixed.',
    color: 'var(--accent-primary)',
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    icon: '⚡',
    desc: 'Lower confidence (≥ 0.6). Maximum auto-fix coverage.',
    color: 'var(--accent-warning, #f59e0b)',
  },
];

/**
 * Preset selector component for the self-healing system.
 *
 * @param {Object} props
 * @param {string} [props.activePreset] - Currently active preset name
 * @param {(presetId: string) => void} props.onSelect - Called when a preset is selected
 * @param {boolean} [props.loading] - Whether a preset is being applied
 * @param {boolean} [props.compact] - Compact single-row layout
 */
export function HealingPresetSelector({
  activePreset = null,
  onSelect,
  loading = false,
  compact = false,
}) {
  const [hover, setHover] = useState(null);

  const handleSelect = useCallback(
    (id) => {
      if (!loading && onSelect) {
        onSelect(id);
      }
    },
    [loading, onSelect],
  );

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleSelect(p.id)}
            disabled={loading}
            title={p.desc}
            className={`px-2 py-0.5 text-[10px] rounded-full transition-all ${
              activePreset === p.id
                ? 'font-semibold ring-1 ring-current'
                : 'opacity-60 hover:opacity-100'
            }`}
            style={{
              color: activePreset === p.id ? p.color : 'var(--text-muted)',
              background:
                activePreset === p.id
                  ? `color-mix(in srgb, ${p.color} 12%, transparent)`
                  : 'transparent',
            }}
          >
            {p.icon} {p.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="text-xs font-semibold uppercase tracking-wider mb-0.5"
        style={{ color: 'var(--text-muted)' }}
      >
        Quick Presets
      </div>
      {PRESETS.map((p) => {
        const isActive = activePreset === p.id;
        const isHover = hover === p.id;

        return (
          <button
            key={p.id}
            onClick={() => handleSelect(p.id)}
            onMouseEnter={() => setHover(p.id)}
            onMouseLeave={() => setHover(null)}
            disabled={loading}
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-all ${
              isActive
                ? 'ring-1 ring-current'
                : 'hover:bg-[var(--bg-elevated)]'
            }`}
            style={{
              color: isActive ? p.color : 'var(--text-primary)',
              background: isActive
                ? `color-mix(in srgb, ${p.color} 8%, transparent)`
                : undefined,
              opacity: loading ? 0.5 : 1,
            }}
          >
            <span className="text-base leading-none">{p.icon}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{p.label}</div>
              <div
                className="text-[10px] leading-tight truncate"
                style={{ color: isActive || isHover ? 'inherit' : 'var(--text-dim)' }}
              >
                {p.desc}
              </div>
            </div>
            {isActive && (
              <span
                className="text-[10px] font-semibold uppercase px-1 py-px rounded"
                style={{
                  background: `color-mix(in srgb, ${p.color} 20%, transparent)`,
                }}
              >
                Active
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default HealingPresetSelector;
