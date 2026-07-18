'use client';

import { useState } from 'react';

/** Per-user localStorage key for "has seen the first-publish tutorial". */
export function firstPublishSeenKey(userId) {
  return `vectant.programs.firstPublishSeen.${userId || 'anon'}`;
}

const STEPS = [
  { title: 'Bring a pullable image', body: 'Push your app image to a registry we can pull (e.g. ghcr.io / Docker Hub). Web/CLI apps need only a manifest — no image.' },
  { title: 'We review every submission', body: 'Automated hard gates + a CVE scan run first, then a human reviews it. Updates re-run the full review.' },
  { title: 'What we check', body: 'Manifest validity, requested scopes, host-escape attempts, and known CVEs. We re-host approved images into our registry pinned by digest, so installers run exactly what we reviewed.' },
  { title: 'Timelines', body: 'Most reviews complete within a few business days. You can track status from the Programs panel.' },
];

/**
 * One-time guided overlay for the publish flow. Renders nothing once the
 * per-user seen flag is set. Calling the CTA sets the flag + invokes onClose.
 */
export function FirstPublishTutorial({ userId, open, onClose }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return window.localStorage.getItem(firstPublishSeenKey(userId)) === '1'; } catch { return false; }
  });
  if (!open || dismissed) return null;

  const finish = () => {
    try { window.localStorage.setItem(firstPublishSeenKey(userId), '1'); } catch { /* ignore */ }
    setDismissed(true);
    if (onClose) onClose();
  };

  return (
    <div role="dialog" aria-label="Publishing a community app" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary, #e8e8ea)', maxWidth: 520, padding: 24, borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Publishing a community app</h2>
        <ol style={{ paddingLeft: 18, display: 'grid', gap: 12 }}>
          {STEPS.map((s) => (
            <li key={s.title}>
              <strong>{s.title}</strong>
              <div style={{ opacity: 0.8 }}>{s.body}</div>
            </li>
          ))}
        </ol>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={finish}>Start publishing</button>
        </div>
      </div>
    </div>
  );
}

export default FirstPublishTutorial;
