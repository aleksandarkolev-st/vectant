'use client';
import React from 'react';
import { Key, ExternalLink, X } from 'lucide-react';

/**
 * Stub modal that points the user at Settings, where the per-user GitHub PAT
 * is now managed (server-side, encrypted). The historical per-workspace token
 * concept has been removed — tokens are scoped to the authenticated user.
 *
 * Kept as a component (rather than deleted) so existing call sites that
 * trigger it on missing-token errors still surface a useful prompt.
 */
export function GitHubTokenModal({ onClose }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div
        className="relative w-full max-w-md mx-4 rounded-xl border shadow-2xl"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-md opacity-60 hover:opacity-100 transition"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}
            >
              <Key className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold">GitHub Authentication</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Configure your token in Settings
              </p>
            </div>
          </div>

          <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
            Your GitHub access is now managed per user. Open <strong>Settings</strong>
            {' '}to add or replace your Personal Access Token. If you signed in with GitHub,
            your OAuth token is used automatically — no PAT required for basic operations.
          </p>

          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Need a new token?{' '}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="underline inline-flex items-center gap-0.5"
              style={{ color: 'var(--accent-primary)' }}
            >
              Create one on GitHub <ExternalLink className="w-3 h-3" />
            </a>
            {' '}with the <code className="font-mono">repo</code> scope.
          </p>

          <button
            onClick={onClose}
            className="w-full py-2 rounded-lg text-sm font-medium transition"
            style={{ background: 'var(--accent-primary)', color: '#fff' }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
