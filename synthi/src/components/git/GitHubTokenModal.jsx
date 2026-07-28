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
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[color-mix(in_srgb,black_72%,transparent)] backdrop-blur-sm">
      <div className="vt-dialog-surface relative mx-4 w-full max-w-md overflow-hidden">
        <button
          onClick={onClose}
          className="vt-icon-button th-focus-ring absolute right-3 top-3 h-7 min-w-7"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="vt-agent-card flex h-9 w-9 items-center justify-center">
              <Key className="h-4 w-4 text-[var(--attention-purple)]" />
            </div>
            <div>
              <h2 className="vt-panel-title">GitHub Authentication</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Configure your token in Settings
              </p>
            </div>
          </div>

          <p className="mb-4 text-xs leading-relaxed text-[var(--text-secondary)]">
            Your GitHub access is now managed per user. Open <strong>Settings</strong>
            {' '}to add or replace your Personal Access Token. If you signed in with GitHub,
            your OAuth token is used automatically — no PAT required for basic operations.
          </p>

          <p className="mb-4 text-xs text-[var(--text-muted)]">
            Need a new token?{' '}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-[var(--attention-purple)] underline"
            >
              Create one on GitHub <ExternalLink className="w-3 h-3" />
            </a>
            {' '}with the <code className="font-mono">repo</code> scope.
          </p>

          <button
            onClick={onClose}
            className="th-focus-ring th-btn-primary w-full py-2 text-sm font-medium"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
