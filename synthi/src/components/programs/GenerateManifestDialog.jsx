'use client';

import { useMemo, useState } from 'react';

/**
 * Preview + edit dialog for an AI-generated vectant.programs.json. The user
 * reviews/edits the JSON; Save parses it and hands the object up (the server
 * re-validates fail-closed before writing). Save is disabled while the JSON is
 * unparseable. Renders nothing when closed.
 */
export default function GenerateManifestDialog({ open, manifest, errors, onSave, onCancel }) {
  const seed = useMemo(() => {
    try { return JSON.stringify(manifest || {}, null, 2); } catch { return '{}'; }
  }, [manifest]);
  const [text, setText] = useState(seed);
  const [dirtySeed, setDirtySeed] = useState(seed);
  // Re-seed the editor when a fresh manifest arrives (open toggled / new generate).
  if (seed !== dirtySeed) {
    setDirtySeed(seed);
    setText(seed);
  }

  const parsed = useMemo(() => {
    try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: e.message }; }
  }, [text]);

  if (!open) return null;

  return (
    <div role="dialog" aria-label="Review generated manifest" style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,0.6)', zIndex: 1000 }}>
      <div style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary, #e8e8ea)', width: 'min(720px, 92vw)', padding: 20, borderRadius: 12, display: 'grid', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Review generated <code>vectant.programs.json</code></h2>
        {Array.isArray(errors) && errors.length ? (
          <div style={{ fontSize: 12, color: '#d9534f' }}>The draft didn’t fully validate — fix it below before saving: {errors.map((e) => e.message).join('; ')}</div>
        ) : (
          <div style={{ fontSize: 12, opacity: 0.7 }}>Edit if needed, then Save to write it into your workspace.</div>
        )}
        <textarea
          data-testid="manifest-editor"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{ width: '100%', minHeight: 280, fontFamily: 'monospace', fontSize: 12, padding: 10, borderRadius: 8, background: 'var(--bg-panel, #0d0d12)', color: 'inherit', border: '1px solid var(--border-subtle)' }}
        />
        {!parsed.ok ? <div style={{ fontSize: 12, color: '#d9534f' }}>Invalid JSON: {parsed.error}</div> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" data-testid="manifest-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" data-testid="manifest-save" disabled={!parsed.ok} onClick={() => parsed.ok && onSave(parsed.value)}>Save to workspace</button>
        </div>
      </div>
    </div>
  );
}
