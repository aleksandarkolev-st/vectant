'use client';

import { useEffect, useState } from 'react';

const REFRESH_MS = 5000;

/** Live-ish snapshot of a webGui program's /wsport stream. Snapshot, not iframe:
 *  periodically re-fetches the stream root as an <img>. Reduced-motion → one frame. */
export default function ProgramThumbnail({ slug, port }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!slug || !port) return undefined;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduced) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [slug, port]);

  const base = {
    height: '54px',
    borderRadius: '7px',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden',
    position: 'relative',
  };

  if (!slug || !port) {
    return (
      <div
        data-testid="thumb-placeholder"
        style={{ ...base, background: 'radial-gradient(120% 80% at 30% 20%, #16203a, #07080d)' }}
      />
    );
  }

  return (
    <div style={{ ...base, background: '#07080d' }}>
      <img
        alt=""
        aria-hidden="true"
        src={`/wsport/${encodeURIComponent(slug)}/${port}/?thumb=${tick}`}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
      />
      <span
        style={{ position: 'absolute', top: '5px', left: '6px', fontSize: '8px', color: '#bfe7cf', background: 'rgba(74,222,128,0.16)', borderRadius: '4px', padding: '1px 5px' }}
      >
        live
      </span>
    </div>
  );
}
