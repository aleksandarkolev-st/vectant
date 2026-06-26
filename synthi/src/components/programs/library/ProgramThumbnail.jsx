'use client';

import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';

/**
 * ONE snapshot of a webGui program, taken ~60-90s after it started, via KasmVNC's
 * native `/api/get_screenshot` through the /wsport proxy (which injects the per-session
 * owner credential). It is a single still — never polled — and re-taken whenever this
 * remounts (e.g. the Programs panel is closed and reopened). A program needs ~a minute
 * to boot and render before it's worth capturing; until the capture lands (or if it
 * fails) we show a calm placeholder.
 */
const SNAPSHOT_TARGET_MS = 75_000; // mid-point of the 60-90s window
const SNAPSHOT_WARMUP_MS = 500;    // already past the window (panel reopened later)

export default function ProgramThumbnail({ slug, port, startedAt }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    if (!slug || !port) return undefined;

    const started = Date.parse(startedAt || '') || Date.now();
    const age = Date.now() - started;
    const delay = age >= SNAPSHOT_TARGET_MS ? SNAPSHOT_WARMUP_MS : SNAPSHOT_TARGET_MS - age;

    const id = setTimeout(() => {
      // A unique stamp → exactly one fresh capture per mount (no browser-cache reuse,
      // no polling). KasmVNC ignores the extra `t` param.
      setSrc(`/wsport/${encodeURIComponent(slug)}/${port}/api/get_screenshot?width=320&quality=6&t=${Date.now()}`);
    }, delay);
    return () => clearTimeout(id);
  }, [slug, port, startedAt]);

  const base = {
    height: '54px',
    borderRadius: '7px',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden',
    position: 'relative',
  };

  if (!slug || !port || !src || failed) {
    return (
      <div
        data-testid="thumb-placeholder"
        className="flex items-center justify-center"
        style={{ ...base, background: 'radial-gradient(120% 80% at 30% 20%, #16203a, #07080d)', color: 'var(--text-muted)' }}
      >
        <Monitor className="w-4 h-4" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div style={{ ...base, background: '#07080d' }}>
      <img
        data-testid="thumb-snapshot"
        alt=""
        aria-hidden="true"
        src={src}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
