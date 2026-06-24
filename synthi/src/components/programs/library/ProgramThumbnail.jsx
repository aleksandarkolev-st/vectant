'use client';

import { Monitor } from 'lucide-react';

/**
 * Static visual block for a webGui program's card.
 *
 * A *live* snapshot needs a server-side screenshot endpoint, which doesn't exist:
 * the previous implementation polled `/wsport/<slug>/<port>/?thumb=<n>` as an <img>,
 * but the /wsport proxy forwards to the KasmVNC HTML app and serves no such image —
 * so every running GUI card 404-spammed every few seconds and thrashed React. Until
 * a real snapshot endpoint exists, this is a calm static placeholder; opening the
 * program shows the live stream. Props are accepted (and ignored) for compatibility.
 */
export default function ProgramThumbnail() {
  return (
    <div
      data-testid="thumb-placeholder"
      className="flex items-center justify-center"
      style={{
        height: '54px',
        borderRadius: '7px',
        border: '1px solid var(--border-subtle)',
        background: 'radial-gradient(120% 80% at 30% 20%, #16203a, #07080d)',
        color: 'var(--text-muted)',
      }}
    >
      <Monitor className="w-4 h-4" aria-hidden="true" />
    </div>
  );
}
