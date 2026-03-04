'use client';
import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { Key, ExternalLink, Eye, EyeOff, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { validateToken, setHasToken } from '@/redux/prSlice';
import { storeToken, clearToken } from '@/services/prClient';

/**
 * Modal for entering / managing a GitHub Personal Access Token.
 * The token is validated against the GitHub API before saving.
 */
export function GitHubTokenModal({ slug, onClose, onSuccess }) {
  const dispatch = useDispatch();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleSave = async () => {
    if (!token.trim()) return;
    setValidating(true);
    setError(null);
    setSuccess(null);

    const result = await dispatch(validateToken({ slug, token: token.trim() }));
    setValidating(false);

    if (validateToken.fulfilled.match(result)) {
      storeToken(slug, token.trim());
      dispatch(setHasToken(true));
      setSuccess(`Authenticated as @${result.payload.user.login}`);
      setTimeout(() => {
        onSuccess?.();
        onClose?.();
      }, 800);
    } else {
      setError(result.payload?.error || 'Invalid token. Check your PAT and try again.');
    }
  };

  const handleClear = () => {
    clearToken(slug);
    dispatch(setHasToken(false));
    setToken('');
    setSuccess(null);
    setError(null);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div
        className="relative w-full max-w-md mx-4 rounded-xl border shadow-2xl"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-1 rounded-md opacity-60 hover:opacity-100 transition"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-5">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}
            >
              <Key className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <div>
              <h2 className="text-sm font-semibold">GitHub Authentication</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Add a Personal Access Token to manage Pull Requests
              </p>
            </div>
          </div>

          {/* Instructions */}
          <div
            className="rounded-lg p-3 mb-4 text-xs space-y-1.5"
            style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)', border: '1px solid' }}
          >
            <p style={{ color: 'var(--text-muted)' }}>
              Create a token at{' '}
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
                style={{ color: 'var(--accent-primary)' }}
              >
                github.com/settings/tokens <ExternalLink className="w-3 h-3" />
              </a>{' '}
              with these scopes:
            </p>
            <ul className="ml-2 space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
              <li>• <code className="font-mono">repo</code> — full repository access</li>
              <li>• <code className="font-mono">pull_requests</code> — read/write PRs</li>
            </ul>
          </div>

          {/* Token input */}
          <div className="relative mb-4">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={e => setToken(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full px-3 py-2 pr-10 rounded-lg text-sm font-mono border outline-none transition"
              style={{
                background: 'var(--bg-app)',
                borderColor: error ? 'var(--error, #ef4444)' : 'var(--border-medium)',
                color: 'var(--text-primary)',
              }}
              autoFocus
            />
            <button
              onClick={() => setShowToken(v => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 opacity-50 hover:opacity-90 transition"
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Feedback */}
          {error && (
            <div className="flex items-center gap-2 mb-3 text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 mb-3 text-xs text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              {success}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!token.trim() || validating}
              className="flex-1 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              style={{ background: 'var(--accent-primary)', color: '#fff' }}
            >
              {validating ? 'Validating…' : 'Save Token'}
            </button>
            <button
              onClick={handleClear}
              className="px-4 py-2 rounded-lg text-sm border transition hover:opacity-80"
              style={{ borderColor: 'var(--border-medium)', color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
