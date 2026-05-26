'use client';

import VectantOrb from './VectantOrb';

/**
 * ChatEmptyState — the first-run / empty-conversation surface.
 * A large idle orb is Vectant's presence. The suggestion chips are exported
 * separately (SuggestionChips) so the hero layout can place them BELOW the
 * composer (orb + title → composer → chips), with the composer as the
 * centered centerpiece.
 */
export const SUGGESTIONS = [
  'Explain this file',
  'Find bugs',
  'Add tests',
  'Refactor this',
];

export function SuggestionChips({ onPick, className = '' }) {
  return (
    <div className={`flex flex-wrap gap-2 justify-center max-w-[300px] mx-auto ${className}`}>
      {SUGGESTIONS.map((s) => (
        <button key={s} type="button" className="vx-chip" onClick={() => onPick?.(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}

export default function ChatEmptyState({ onPick, paused = false, showChips = true }) {
  return (
    <div className="vx-emptystate relative flex flex-col items-center px-5 py-6 text-center">
      <VectantOrb state="idle" size={84} paused={paused} />
      <h3 className="mt-6 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        What can <span className="vt-brand-text font-bold">Vectant</span> help with?
      </h3>
      <p className="mt-1.5 text-[11px] leading-relaxed max-w-[240px]" style={{ color: 'var(--text-muted)' }}>
        Explain code, fix bugs, add features, or refactor your project.
      </p>
      {showChips && <SuggestionChips onPick={onPick} className="mt-5" />}
    </div>
  );
}
