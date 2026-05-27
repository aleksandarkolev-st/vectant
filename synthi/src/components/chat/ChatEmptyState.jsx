'use client';

import VectantOrb from './VectantOrb';

/**
 * ChatEmptyState — the first-run / empty-conversation surface.
 * A large idle orb is Vectant's presence; suggestion chips prefill the
 * composer so the user gets a one-click start.
 */
const SUGGESTIONS = [
  'Explain this file',
  'Find bugs',
  'Add tests',
  'Refactor this',
];

export default function ChatEmptyState({ onPick, paused = false }) {
  return (
    <div className="vx-emptystate relative flex flex-col items-center justify-center h-full px-5 py-10 text-center">
      <VectantOrb state="idle" size={84} paused={paused} />
      <h3 className="mt-6 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        What can <span className="vt-brand-text font-bold">Vectant</span> help with?
      </h3>
      <p className="mt-1.5 text-[11px] leading-relaxed max-w-[240px]" style={{ color: 'var(--text-muted)' }}>
        Explain code, fix bugs, add features, or refactor your project.
      </p>
      <div className="mt-5 flex flex-wrap gap-2 justify-center max-w-[300px]">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="vx-chip" onClick={() => onPick?.(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
