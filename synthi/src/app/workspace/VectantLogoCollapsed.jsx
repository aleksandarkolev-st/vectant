"use client";

/**
 * VectantLogoCollapsed — the V at the center of the collapsed silhouette.
 *
 * The brackets are no longer rendered here — they live as siblings of
 * the pill inside the StatusBar stage so they auto-track the pill's
 * width during the expand/collapse morph (right:100%+2px / left:100%+2px
 * relative to the inline-block stage). This component now only owns the
 * V mark + its halo + pending-count badge.
 *
 * Phase machine ('logo' | 'expanding' | 'expanded' | 'collapsing'):
 *   logo       → V visible
 *   expanding  → V fading out
 *   collapsing → V fading back in (with delay so brackets close first)
 *   expanded   → (component is unmounted by parent)
 *
 * State signals (from props.state):
 *   'normal'   → V at full opacity, no tint
 *   'error'    → V tinted red (via filter)
 *   'healing'  → V plays brand-glow pulse, count chip if pendingCount > 0
 */

import { useCallback } from 'react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

const MENU_PRESET_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'left-rail', label: 'Left rail' },
  { id: 'right-rail', label: 'Right rail' },
];

export default function VectantLogoCollapsed({
  state = 'normal',
  phase = 'logo',
  pendingCount = 0,
  onActivate,
  onSecondaryDragStart,
  isCompact = false,
  onSetCompact,
  isPositionLocked = false,
  onSetPositionLocked,
  dockPreset = 'center',
  onDockPresetChange,
  activePresetId = 'custom',
  onPresetChange,
  canResetPosition = false,
  onResetPosition,
  onOpenFullSettings,
  isDragging = false,
}) {
  const handleClick = useCallback(() => onActivate?.(), [onActivate]);
  const handleMouseDown = useCallback((event) => {
    if (phase !== 'logo' || event.button !== 2) return;
    onSecondaryDragStart?.(event);
  }, [onSecondaryDragStart, phase]);
  // is-v-fading drives the V fade-out. Active during expanding only.
  const isVFading = phase === 'expanding';

  const button = (
    <button
      type="button"
      aria-label={phase === 'logo' ? 'Open status island' : 'Vectant'}
      onClick={phase === 'logo' ? handleClick : undefined}
      onMouseDown={handleMouseDown}
      tabIndex={phase === 'logo' ? 0 : -1}
      title={phase === 'logo'
        ? (isPositionLocked
            ? 'Left click to open. Right click for actions. Movement locked.'
            : 'Left click to open. Right click for actions. Right-drag to move.')
        : undefined}
      className={[
        'vectant-logo-button th-focus-ring',
        phase === 'logo' && !isPositionLocked ? 'vectant-logo-button--movable' : '',
        isDragging ? 'is-dragging' : '',
        state === 'error' ? 'vectant-logo--error' : '',
        state === 'healing' ? 'vectant-logo--healing' : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Halo behind the V — quiet in normal state, pulses on healing,
          tints red on error. Visually replaces the island's drop shadow
          while collapsed. */}
      <span aria-hidden="true" className="vectant-logo-halo" />

      <img
        src="/vectant/the_V.png"
        alt=""
        aria-hidden="true"
        className={`vectant-logo-v ${isVFading ? 'is-fading' : ''}`}
        draggable={false}
      />

      {/* Pending-fix count chip — only when there's actually pending work.
          Sits on the bottom-right corner of the logo as a small dot+number. */}
      {pendingCount > 0 && phase === 'logo' && (
        <span className="vectant-logo-badge" title={`${pendingCount} pending fix${pendingCount === 1 ? '' : 'es'}`}>
          {pendingCount > 9 ? '9+' : pendingCount}
        </span>
      )}
    </button>
  );

  if (phase !== 'logo') return button;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {button}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-medium)',
          color: 'var(--text-primary)',
        }}
      >
        <ContextMenuLabel inset>Status island</ContextMenuLabel>
        <ContextMenuItem onSelect={() => onActivate?.()}>
          Open island
        </ContextMenuItem>
        <ContextMenuCheckboxItem
          checked={isCompact}
          onCheckedChange={(checked) => onSetCompact?.(Boolean(checked))}
        >
          Compact labels
        </ContextMenuCheckboxItem>
        <ContextMenuCheckboxItem
          checked={isPositionLocked}
          onCheckedChange={(checked) => onSetPositionLocked?.(Boolean(checked))}
        >
          Lock movement
        </ContextMenuCheckboxItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger inset>
            Presets
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-medium)',
              color: 'var(--text-primary)',
            }}
          >
            <ContextMenuRadioGroup value={activePresetId} onValueChange={(value) => onPresetChange?.(value)}>
              {MENU_PRESET_OPTIONS.map((preset) => (
                <ContextMenuRadioItem key={preset.id} value={preset.id}>
                  {preset.label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger inset>
            Dock position
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-medium)',
              color: 'var(--text-primary)',
            }}
          >
            <ContextMenuRadioGroup value={dockPreset} onValueChange={(value) => onDockPresetChange?.(value)}>
              <ContextMenuRadioItem value="free">Free position</ContextMenuRadioItem>
              <ContextMenuRadioItem value="left">Bottom left</ContextMenuRadioItem>
              <ContextMenuRadioItem value="center">Bottom center</ContextMenuRadioItem>
              <ContextMenuRadioItem value="right">Bottom right</ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onOpenFullSettings?.()}>
          Open full settings
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canResetPosition}
          onSelect={() => onResetPosition?.()}
        >
          Reset position
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
