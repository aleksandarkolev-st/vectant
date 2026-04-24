'use client';

/**
 * @fileoverview SettingsPanelContent — shared settings panel used in both
 * the legacy sidebar (page.jsx) and the docking WM (SettingsPanelWrapper).
 *
 * Contains toggle controls for Auto Save, AI Auto Completion,
 * a button to open the Theme Picker, and Global GitHub Token management.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
  toggleAutoSave,
  selectAutoSaveEnabled,
  toggleAutoCompletion,
  selectAutoCompletionEnabled,
  toggleBringYourOwnRunner,
  selectBringYourOwnRunnerEnabled,
} from '@/redux/uiSlice';
import { useThemePicker } from '@/components/ThemePicker';
import { toast } from 'sonner';
import { selectHealingEnabled } from '@/redux/healingSelectors';
import { toggleHealing } from '@/redux/healingSlice';
import { HealingSettingsPanel } from '@/components/healing/HealingSettingsPanel';
import { Key, Eye, EyeOff, Check, Trash2, AlertCircle } from 'lucide-react';

// ── Global token helpers ────────────────────────────────────────────
const GLOBAL_TOKEN_KEY = 'synthi:global-github-token';

function getGlobalToken() {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(GLOBAL_TOKEN_KEY) || '';
}
function setGlobalToken(token) {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(GLOBAL_TOKEN_KEY, token);
  else localStorage.removeItem(GLOBAL_TOKEN_KEY);
}

async function validateGitHubToken(token) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = await res.json();
      return { valid: true, login: data.login, name: data.name };
    }
    return { valid: false, error: res.status === 401 ? 'Invalid token' : `GitHub returned ${res.status}` };
  } catch {
    return { valid: false, error: 'Network error' };
  }
}

export function SettingsPanelContent() {
  const dispatch = useAppDispatch();
  const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
  const autoCompletionEnabled = useAppSelector(selectAutoCompletionEnabled);
  const healingEnabled = useAppSelector(selectHealingEnabled);
  const byorEnabled = useAppSelector(selectBringYourOwnRunnerEnabled);
  const { open: openThemePicker } = useThemePicker();

  // ── Global GitHub Token state ───────
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenUser, setTokenUser] = useState(null); // { login, name }
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const hasStoredToken = !!getGlobalToken();

  // Load token info on mount
  useEffect(() => {
    const stored = getGlobalToken();
    if (stored) {
      setTokenInput(stored);
      validateGitHubToken(stored).then(result => {
        if (result.valid) setTokenUser({ login: result.login, name: result.name });
      });
    }
  }, []);

  const handleSaveToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    setTokenSaving(true);
    setTokenError('');
    const result = await validateGitHubToken(tokenInput.trim());
    setTokenSaving(false);
    if (result.valid) {
      setGlobalToken(tokenInput.trim());
      setTokenUser({ login: result.login, name: result.name });
      toast.success(`GitHub token saved — authenticated as ${result.login}`);
    } else {
      setTokenError(result.error || 'Validation failed');
    }
  }, [tokenInput]);

  const handleClearToken = useCallback(() => {
    setGlobalToken('');
    setTokenInput('');
    setTokenUser(null);
    setTokenError('');
    toast('GitHub token removed');
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3" style={{ color: 'var(--text-primary)' }}>
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        Settings
      </div>

      {/* Auto-save toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">Auto Save</span>
        <button
          onClick={() => dispatch(toggleAutoSave())}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoSaveEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              autoSaveEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* AI Auto-completion toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">AI Auto Completion</span>
        <button
          onClick={() => {
            dispatch(toggleAutoCompletion());
            toast(autoCompletionEnabled ? 'AI Auto Completion disabled' : 'AI Auto Completion enabled', {
              duration: 2000,
            });
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${autoCompletionEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              autoCompletionEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Self-Healing — expanded into the rich settings panel so users
          can access boldness, rules, triggers, stats, and history without
          leaving the main settings drawer. */}
      <div
        className="rounded-md"
        style={{
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-sidebar)',
        }}
      >
        <HealingSettingsPanel />
      </div>

      {/* ULTRAPLAN Phase 8: Bring Your Own Runner toggle. When ON, the
          worker preserves any host_runner.cpp that starts with the
          `// SYNTHI_USER_RUNNER` sentinel instead of regenerating it
          on the next AI split. Power-user opt-in. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-sm">Bring Your Own Runner</span>
          <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Preserve your own <code className="font-mono">host_runner.cpp</code> instead of regenerating it.
            Requires <code className="font-mono">// SYNTHI_USER_RUNNER</code> on the first non-blank line.
          </span>
        </div>
        <button
          onClick={() => {
            dispatch(toggleBringYourOwnRunner());
            toast(byorEnabled ? 'Bring Your Own Runner disabled' : 'Bring Your Own Runner enabled', {
              duration: 2000,
            });
          }}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all flex-shrink-0 mt-0.5 ${byorEnabled ? 'th-toggle-on' : 'th-toggle-off'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              byorEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />

      {/* Theme picker */}
      <button
        onClick={openThemePicker}
        className="flex items-center justify-between w-full text-left text-sm px-2 py-2 th-action rounded-lg transition-colors"
      >
        <span>Color Theme</span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Ctrl+K Ctrl+T</span>
      </button>

      <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />

      {/* ── Global GitHub Token ─────────────────── */}
      <div className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--text-muted)' }}>
        GitHub Token
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Set a Personal Access Token used for git push, pull, fetch and PR operations.
        Without a token, git operations rely on your system's credential manager.
      </p>

      {/* Token status */}
      {tokenUser && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-primary)' }}>
          <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <span>Authenticated as <strong>{tokenUser.login}</strong>{tokenUser.name ? ` (${tokenUser.name})` : ''}</span>
        </div>
      )}

      {/* Token input */}
      <div className="flex gap-1.5 items-center">
        <div className="relative flex-1">
          <Key className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: 'var(--text-disabled)' }} />
          <input
            type={showToken ? 'text' : 'password'}
            value={tokenInput}
            onChange={e => { setTokenInput(e.target.value); setTokenError(''); }}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            className="w-full pl-7 pr-8 py-1.5 text-xs rounded border font-mono focus:outline-none transition-colors"
            style={{
              background: 'var(--bg-input, var(--bg-editor))',
              borderColor: tokenError ? '#ef4444' : 'var(--border-subtle)',
              color: 'var(--text-primary)',
            }}
            onKeyDown={e => e.key === 'Enter' && handleSaveToken()}
          />
          <button
            onClick={() => setShowToken(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-50 hover:opacity-80 transition"
            type="button"
            title={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
        <button
          onClick={handleSaveToken}
          disabled={!tokenInput.trim() || tokenSaving}
          className="px-2.5 py-1.5 text-xs rounded border transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)' }}
        >
          {tokenSaving ? '…' : 'Save'}
        </button>
        {hasStoredToken && (
          <button
            onClick={handleClearToken}
            className="p-1.5 rounded border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
            title="Remove token"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {tokenError && (
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: '#f87171' }}>
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {tokenError}
        </div>
      )}

      <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-disabled)' }}>
        Token requires <code className="px-1 rounded" style={{ background: 'var(--bg-input, var(--bg-editor))' }}>repo</code> scope.
        Create one at{' '}
        <button
          onClick={() => window.open('https://github.com/settings/tokens/new?scopes=repo&description=Synthi+IDE', '_blank')}
          className="underline hover:opacity-80"
          style={{ color: 'var(--accent-primary)' }}
        >
          github.com/settings/tokens
        </button>.
      </p>
    </div>
  );
}

export default SettingsPanelContent;
