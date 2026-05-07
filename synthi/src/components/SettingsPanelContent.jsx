'use client';

/**
 * @fileoverview SettingsPanelContent — shared settings panel used in both
 * the legacy sidebar (page.jsx) and the docking WM (SettingsPanelWrapper).
 *
 * Contains toggle controls for Auto Save, AI Auto Completion,
 * a button to open the Theme Picker, and per-user GitHub Token management.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
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
import { Key, Eye, EyeOff, Check, Trash2, AlertCircle, FlaskConical, Loader2, X } from 'lucide-react';

// ── Server-side per-user PAT API ───────────────────────────────────
async function apiSaveToken(token) {
  const res = await fetch('/api/user/github-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { valid: false, error: data?.message || data?.error || `Server returned ${res.status}` };
  }
  return { valid: true, login: data.login, name: data.name };
}

async function apiClearToken() {
  const res = await fetch('/api/user/github-token', { method: 'DELETE' });
  return res.ok;
}

// ── Hardcoded end-to-end token test ────────────────────────────────
// Exercises the full read→auth→scope→rate-limit→list path against the
// real GitHub API using whatever token the user saved in the settings
// panel above. Each step pushes a result so the user can see exactly
// where the token works and where it falls over.
async function runTokenTestPlan(token, onStep) {
  const GH = 'https://api.github.com';
  const required = ['repo'];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Source check (confirms the panel resolved a token from session/PAT)
  onStep({
    key: 'storage',
    label: 'Resolve token from session',
    status: 'ok',
    detail: `Found ${token.length}-char token, prefix "${token.slice(0, 4)}…"`,
  });

  // 2. GET /user — verifies the token authenticates at all
  let userRes;
  try {
    userRes = await fetch(`${GH}/user`, { headers });
  } catch (e) {
    onStep({ key: 'auth', label: 'GET /user (authenticate)', status: 'fail', detail: `Network error: ${e.message}` });
    return;
  }
  let user = null;
  try { user = await userRes.json(); } catch {}
  if (!userRes.ok) {
    onStep({
      key: 'auth',
      label: 'GET /user (authenticate)',
      status: 'fail',
      detail: `HTTP ${userRes.status} — ${user?.message || userRes.statusText}`,
    });
    return;
  }
  onStep({
    key: 'auth',
    label: 'GET /user (authenticate)',
    status: 'ok',
    detail: `Authenticated as ${user.login}${user.name ? ` (${user.name})` : ''} · id=${user.id}`,
  });

  // 3. Inspect X-OAuth-Scopes header — verifies the token has `repo`
  // (Fine-grained tokens omit this header — treat that as a soft warning.)
  const scopeHeader = userRes.headers.get('x-oauth-scopes');
  if (scopeHeader === null) {
    onStep({
      key: 'scopes',
      label: 'Verify token scopes',
      status: 'warn',
      detail: 'No X-OAuth-Scopes header — likely a fine-grained PAT. Synthi assumes `repo` scope; verify manually that the token can read/write the target repo.',
    });
  } else {
    const scopes = scopeHeader.split(',').map(s => s.trim()).filter(Boolean);
    const missing = required.filter(r => !scopes.includes(r) && !scopes.some(s => s === 'repo'));
    if (missing.length) {
      onStep({
        key: 'scopes',
        label: 'Verify token scopes',
        status: 'fail',
        detail: `Missing required scope(s): ${missing.join(', ')}. Got: [${scopes.join(', ') || '∅'}]`,
      });
    } else {
      onStep({
        key: 'scopes',
        label: 'Verify token scopes',
        status: 'ok',
        detail: `Scopes: [${scopes.join(', ')}]`,
      });
    }
  }

  // 4. GET /rate_limit — surfaces remaining budget so a failing push
  //    doesn't get blamed on the token when it's actually a 403/rate.
  try {
    const rlRes = await fetch(`${GH}/rate_limit`, { headers });
    const rl = await rlRes.json();
    if (rlRes.ok && rl?.resources?.core) {
      const c = rl.resources.core;
      const reset = new Date(c.reset * 1000).toLocaleTimeString();
      onStep({
        key: 'budget',
        label: 'GET /rate_limit (API budget)',
        status: c.remaining < 50 ? 'warn' : 'ok',
        detail: `core: ${c.remaining}/${c.limit} remaining, resets at ${reset}`,
      });
    } else {
      onStep({ key: 'budget', label: 'GET /rate_limit (API budget)', status: 'warn', detail: `Could not read rate limit (HTTP ${rlRes.status})` });
    }
  } catch (e) {
    onStep({ key: 'budget', label: 'GET /rate_limit (API budget)', status: 'warn', detail: `Network error: ${e.message}` });
  }

  // 5. GET /user/repos — exercises the same call gitClient/prClient need:
  //    list a repo to prove the token can actually see something.
  try {
    const repoRes = await fetch(`${GH}/user/repos?per_page=1&sort=updated`, { headers });
    const repos = await repoRes.json();
    if (!repoRes.ok) {
      onStep({
        key: 'list',
        label: 'GET /user/repos (list permission)',
        status: 'fail',
        detail: `HTTP ${repoRes.status} — ${repos?.message || repoRes.statusText}`,
      });
      return;
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      onStep({
        key: 'list',
        label: 'GET /user/repos (list permission)',
        status: 'warn',
        detail: 'Token works, but no accessible repos — push/pull will fail until a repo is reachable.',
      });
    } else {
      const r = repos[0];
      onStep({
        key: 'list',
        label: 'GET /user/repos (list permission)',
        status: 'ok',
        detail: `Most recent: ${r.full_name} (${r.private ? 'private' : 'public'}, default=${r.default_branch})`,
      });
    }
  } catch (e) {
    onStep({ key: 'list', label: 'GET /user/repos (list permission)', status: 'fail', detail: `Network error: ${e.message}` });
  }
}

export function SettingsPanelContent() {
  const dispatch = useAppDispatch();
  const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
  const autoCompletionEnabled = useAppSelector(selectAutoCompletionEnabled);
  const byorEnabled = useAppSelector(selectBringYourOwnRunnerEnabled);
  const { open: openThemePicker } = useThemePicker();
  const { data: session, status: sessionStatus, update: refreshSession } = useSession();

  // ── Per-user GitHub Token state ─────
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [testRunning, setTestRunning] = useState(false);
  const [testResults, setTestResults] = useState(null); // null | array of step results

  // Whether the user has a server-side PAT configured
  const hasStoredToken = session?.githubTokenSource === 'pat';
  // Whatever token will currently be used for git/PR ops (PAT > OAuth)
  const activeToken = session?.githubToken || null;
  const tokenUser = session?.githubLogin
    ? { login: session.githubLogin, name: null }
    : null;
  const tokenSource = session?.githubTokenSource || null;

  const handleSaveToken = useCallback(async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    setTokenSaving(true);
    setTokenError('');
    const result = await apiSaveToken(trimmed);
    setTokenSaving(false);
    if (result.valid) {
      setTokenInput('');
      // Refresh the session so session.githubToken / session.githubLogin update
      try { await refreshSession(); } catch (_) {}
      toast.success(`GitHub token saved — authenticated as ${result.login}`);
    } else {
      setTokenError(result.error || 'Validation failed');
    }
  }, [tokenInput, refreshSession]);

  const handleClearToken = useCallback(async () => {
    const ok = await apiClearToken();
    if (ok) {
      setTokenInput('');
      setTokenError('');
      setTestResults(null);
      try { await refreshSession(); } catch (_) {}
      toast('GitHub token removed');
    } else {
      toast.error('Failed to remove token');
    }
  }, [refreshSession]);

  const handleRunTest = useCallback(async () => {
    const token = (tokenInput.trim() || activeToken || '').trim();
    if (!token) {
      setTestResults([{ key: 'storage', label: 'Resolve token from session', status: 'fail', detail: 'No token configured — save one first or sign in with GitHub.' }]);
      return;
    }
    setTestRunning(true);
    setTestResults([]);
    const collected = [];
    await runTokenTestPlan(token, step => {
      collected.push(step);
      setTestResults([...collected]);
    });
    setTestRunning(false);
    const failed = collected.filter(s => s.status === 'fail').length;
    const warned = collected.filter(s => s.status === 'warn').length;
    if (failed > 0) toast.error(`Token test failed (${failed} failure${failed > 1 ? 's' : ''})`);
    else if (warned > 0) toast(`Token test passed with ${warned} warning${warned > 1 ? 's' : ''}`);
    else toast.success('Token test passed — all checks green');
  }, [tokenInput, activeToken]);

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

      {/* ── Per-user GitHub Token ─────────────────── */}
      <div className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--text-muted)' }}>
        GitHub Token
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        A Personal Access Token tied to your account, used for git push, pull, fetch and PR operations.
        Stored encrypted on the server; never written to localStorage. If you signed in with GitHub, your OAuth token is used unless you save a PAT here.
      </p>

      {/* Token status */}
      {sessionStatus === 'authenticated' && tokenSource === 'pat' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', color: 'var(--text-primary)' }}>
          <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <span>PAT active{tokenUser?.login ? <> — authenticated as <strong>{tokenUser.login}</strong></> : null}</span>
        </div>
      )}
      {sessionStatus === 'authenticated' && tokenSource === 'oauth' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-input, var(--bg-editor))', color: 'var(--text-primary)' }}>
          <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <span>Using GitHub OAuth token from sign-in. Save a PAT below to override.</span>
        </div>
      )}
      {sessionStatus === 'authenticated' && !tokenSource && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: 'color-mix(in srgb, #ef4444 6%, transparent)', color: 'var(--text-primary)' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#f87171' }} />
          <span>No GitHub access. Save a PAT below to enable git/PR features.</span>
        </div>
      )}
      {sessionStatus === 'unauthenticated' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-input, var(--bg-editor))', color: 'var(--text-muted)' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>Sign in to manage your GitHub token.</span>
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
          disabled={!tokenInput.trim() || tokenSaving || sessionStatus !== 'authenticated'}
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
            title="Remove PAT (OAuth token, if any, will be used as fallback)"
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

      {/* Hardcoded end-to-end test — verifies the saved token against the real
          GitHub API: storage → auth → scopes → rate limit → list permission. */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleRunTest}
          disabled={testRunning || (!tokenInput.trim() && !activeToken)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          title="Run a hardcoded end-to-end test against the GitHub API using the saved token"
        >
          {testRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />}
          {testRunning ? 'Testing…' : 'Test Token'}
        </button>
        {testResults && !testRunning && (
          <button
            onClick={() => setTestResults(null)}
            className="p-1.5 rounded border transition-colors hover:opacity-80"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
            title="Clear test results"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {testResults && testResults.length > 0 && (
        <div
          className="flex flex-col gap-1 px-2 py-2 rounded border text-[11px] font-mono"
          style={{ background: 'var(--bg-input, var(--bg-editor))', borderColor: 'var(--border-subtle)' }}
        >
          {testResults.map((step, i) => {
            const colour =
              step.status === 'ok' ? '#4ade80' :
              step.status === 'warn' ? '#fbbf24' :
              step.status === 'fail' ? '#f87171' : 'var(--text-muted)';
            const glyph =
              step.status === 'ok' ? '✓' :
              step.status === 'warn' ? '!' :
              step.status === 'fail' ? '✕' : '·';
            return (
              <div key={`${step.key}-${i}`} className="flex gap-2">
                <span style={{ color: colour, width: '1ch', flexShrink: 0 }}>{glyph}</span>
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span style={{ color: 'var(--text-primary)' }}>{step.label}</span>
                  <span className="break-words" style={{ color: 'var(--text-muted)' }}>{step.detail}</span>
                </div>
              </div>
            );
          })}
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
