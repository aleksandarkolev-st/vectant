"use client";

/**
 * VectantLogoCollapsed — the closed silhouette of the status island.
 *
 * Renders the three logo parts (left bracket + V + right bracket) in
 * their tight logo formation. The parent StatusBar manages the phase
 * machine ('logo' | 'expanding' | 'expanded' | 'collapsing'); this
 * component applies the appropriate CSS classes to drive:
 *   logo       → V visible, brackets at center
 *   expanding  → V fading out, brackets sliding outward
 *   collapsing → brackets sliding inward, V fading back in
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
  const handleEnter = useCallback(() => onActivate?.('hover'), [onActivate]);
  const handleClick = useCallback(() => onActivate?.('click'), [onActivate]);

  // is-spreading drives the bracket translate-outward in CSS. Active
  // during expanding (forward) and reverses naturally in collapsing
  // (when the class drops, the transition runs in reverse).
  const isSpreading = phase === 'expanding';
  // is-v-fading drives the V fade-out. Active during expanding and
  // also during the early frames of collapsing (we want the V to fade
  // back in as the brackets return, not at the very last frame).
  const isVFading = phase === 'expanding';

  return (
    <button
      type="button"
      aria-label={phase === 'logo' ? 'Open status island' : 'Vectant'}
      onClick={phase === 'logo' ? handleClick : undefined}
      onMouseEnter={phase === 'logo' ? handleEnter : undefined}
      onFocus={phase === 'logo' ? handleEnter : undefined}
      tabIndex={phase === 'logo' ? 0 : -1}
      className={[
        'vectant-logo-button th-focus-ring',
        isSpreading ? 'is-spreading' : '',
        state === 'error' ? 'vectant-logo--error' : '',
        state === 'healing' ? 'vectant-logo--healing' : '',
      ].filter(Boolean).join(' ')}
    >
      {/* Halo behind the V — quiet in normal state, pulses on healing,
          tints red on error. Visually replaces the island's drop shadow
          while collapsed. */}
      <span aria-hidden="true" className="vectant-logo-halo" />

      <img
        src="/vectant/left_bracket_full.png"
        alt=""
        aria-hidden="true"
        className="vectant-logo-bracket vectant-logo-bracket--left"
        draggable={false}
      />
      <img
        src="/vectant/the_V.png"
        alt=""
        aria-hidden="true"
        className={`vectant-logo-v ${isVFading ? 'is-fading' : ''}`}
        draggable={false}
      />
      <img
        src="/vectant/right_bracket_full.png"
        alt=""
        aria-hidden="true"
        className="vectant-logo-bracket vectant-logo-bracket--right"
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
