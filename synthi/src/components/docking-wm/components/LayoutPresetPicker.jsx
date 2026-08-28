'use client';

/**
 * @fileoverview Layout preset picker component.
 *
 * Renders a grid of layout thumbnails that users can click to
 * switch their workspace layout. Shown inside WorkspaceProfileManager
 * or standalone via a toolbar button.
 */

import { memo, useCallback, useState } from 'react';
import { motion } from 'framer-motion';
import { LAYOUT_PRESETS, createLayoutFromPreset } from '../panels/layout-presets';

// ────────────────────────────────────────────────────────
//  Layout thumbnail SVGs (simplified mini-wireframes)
// ────────────────────────────────────────────────────────

const presetIcons = {
  classic: (
    <svg viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="1" y="1" width="12" height="34" fill="currentColor" fillOpacity="0.15" />
      <line x1="13" y1="1" x2="13" y2="35" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="13" y1="25" x2="47" y2="25" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="14" y="1" width="33" height="24" fill="currentColor" fillOpacity="0.08" />
      <rect x="14" y="26" width="33" height="9" fill="currentColor" fillOpacity="0.12" />
    </svg>
  ),
  focus: (
    <svg viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="1" y="1" width="46" height="34" fill="currentColor" fillOpacity="0.10" />
      <rect x="14" y="10" width="20" height="4" rx="1" fill="currentColor" fillOpacity="0.3" />
      <rect x="14" y="17" width="16" height="2" rx="1" fill="currentColor" fillOpacity="0.15" />
      <rect x="14" y="22" width="18" height="2" rx="1" fill="currentColor" fillOpacity="0.15" />
    </svg>
  ),
  'side-by-side': (
    <svg viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="1" y="1" width="10" height="34" fill="currentColor" fillOpacity="0.15" />
      <line x1="11" y1="1" x2="11" y2="35" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="29" y1="1" x2="29" y2="27" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="11" y1="27" x2="47" y2="27" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="12" y="1" width="17" height="26" fill="currentColor" fillOpacity="0.08" />
      <rect x="30" y="1" width="17" height="26" fill="currentColor" fillOpacity="0.08" />
      <rect x="12" y="28" width="35" height="7" fill="currentColor" fillOpacity="0.12" />
    </svg>
  ),
  'ai-assisted': (
    <svg viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="1" y="1" width="10" height="34" fill="currentColor" fillOpacity="0.15" />
      <line x1="11" y1="1" x2="11" y2="35" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="34" y1="1" x2="34" y2="27" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="11" y1="27" x2="47" y2="27" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="12" y="1" width="22" height="26" fill="currentColor" fillOpacity="0.08" />
      <rect x="35" y="1" width="12" height="26" fill="currentColor" fillOpacity="0.18" />
      <circle cx="41" cy="8" r="3" fill="currentColor" fillOpacity="0.25" />
    </svg>
  ),
  'three-column': (
    <svg viewBox="0 0 48 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="1" y="1" width="10" height="34" fill="currentColor" fillOpacity="0.15" />
      <line x1="11" y1="1" x2="11" y2="35" stroke="currentColor" strokeOpacity="0.3" />
      <line x1="32" y1="1" x2="32" y2="35" stroke="currentColor" strokeOpacity="0.3" />
      <rect x="12" y="1" width="20" height="34" fill="currentColor" fillOpacity="0.08" />
      <rect x="33" y="1" width="14" height="34" fill="currentColor" fillOpacity="0.12" />
    </svg>
  ),
};

// ────────────────────────────────────────────────────────
//  Preset Card
// ────────────────────────────────────────────────────────

const PresetCard = memo(function PresetCard({ preset, isActive, onSelect }) {
  return (
    <motion.button
      onClick={() => onSelect(preset.id)}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.985 }}
      transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
      className={`vt-agent-card group relative flex flex-col items-center gap-2 p-3 ${isActive ? 'is-active' : ''}`}
      title={preset.description}
    >
      {/* Thumbnail */}
      <div className="w-full text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
        {presetIcons[preset.id] || (
          <div className="h-9 w-12 rounded border border-zinc-600/40 bg-zinc-800/40" />
        )}
      </div>

      {/* Label */}
      <span className={`text-center text-[11px] leading-tight ${
        isActive ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'
      }`}>
        {preset.name}
      </span>

      {/* Active indicator */}
      {isActive && (
        <div className="vt-state-dot absolute right-1.5 top-1.5" />
      )}
    </motion.button>
  );
});

// ────────────────────────────────────────────────────────
//  Layout Preset Picker
// ────────────────────────────────────────────────────────

/**
 * @param {Object} props
 * @param {string}   [props.activePresetId] - Currently active preset ID
 * @param {function} props.onSelect         - Called with (presetId) when user selects a preset
 * @param {boolean}  [props.showConfirm=true] - Show confirmation before switching
 * @param {string}   [props.className]
 */
export const LayoutPresetPicker = memo(function LayoutPresetPicker({
  activePresetId,
  onSelect,
  showConfirm = true,
  className = '',
}) {
  const [pendingId, setPendingId] = useState(null);

  const handleSelect = useCallback(
    (id) => {
      if (id === activePresetId) return;
      if (showConfirm) {
        setPendingId(id);
      } else {
        onSelect(id);
      }
    },
    [activePresetId, showConfirm, onSelect],
  );

  const confirmSwitch = useCallback(() => {
    if (pendingId) {
      onSelect(pendingId);
      setPendingId(null);
    }
  }, [pendingId, onSelect]);

  const cancelSwitch = useCallback(() => setPendingId(null), []);

  return (
    <div className={className}>
      {/* Preset grid */}
      <div className="grid grid-cols-3 gap-2">
        {LAYOUT_PRESETS.map((preset) => (
          <PresetCard
            key={preset.id}
            preset={preset}
            isActive={preset.id === activePresetId}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* Confirmation banner */}
      {pendingId && (
        <div className="vt-agent-card mt-3 flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)]">
          <span className="flex-1">
            Switch to <strong>{LAYOUT_PRESETS.find(p => p.id === pendingId)?.name}</strong>?
            This will replace your current layout.
          </span>
          <button
            onClick={confirmSwitch}
            className="th-focus-ring th-btn-primary px-3 py-1 text-xs font-medium"
          >
            Apply
          </button>
          <button
            onClick={cancelSwitch}
            className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] px-3 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
});
