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

export default function VectantLogoCollapsed({
  state = 'normal',
  phase = 'logo',
  pendingCount = 0,
  onActivate,
}) {
  const handleClick = useCallback(() => onActivate?.(), [onActivate]);
  // is-v-fading drives the V fade-out. Active during expanding only.
  const isVFading = phase === 'expanding';

  return (
    <button
      type="button"
      aria-label={phase === 'logo' ? 'Open status island' : 'Vectant'}
      onClick={phase === 'logo' ? handleClick : undefined}
      tabIndex={phase === 'logo' ? 0 : -1}
      className={[
        'vectant-logo-button th-focus-ring',
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
}
