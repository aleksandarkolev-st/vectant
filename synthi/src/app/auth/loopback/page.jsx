'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Loader2,
  MonitorUp,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function normalizeLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '[::1]' ? '::1' : host;
}

function isLoopbackCallback(value) {
  const parsed = parseUrl(value);
  return Boolean(
    parsed &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.port &&
    LOOPBACK_HOSTS.has(normalizeLoopbackHost(parsed.hostname)),
  );
}

function findLoopbackRedirect(authUrl) {
  const parsed = parseUrl(authUrl);
  if (!parsed) return null;

  const inspectParams = (params) => {
    for (const [key, value] of params) {
      if (!CALLBACK_PARAM_RE.test(key)) continue;
      if (isLoopbackCallback(value)) return parseUrl(value);
    }
    return null;
  };

  const fromSearch = inspectParams(parsed.searchParams);
  if (fromSearch) return fromSearch;

  const hash = parsed.hash ? parsed.hash.slice(1) : '';
  if (!hash.includes('=')) return null;
  return inspectParams(new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash));
}

function expectedCallbackFromUrl(url) {
  if (!url) return null;
  return {
    host: normalizeLoopbackHost(url.hostname),
    port: Number(url.port),
    pathPrefix: url.pathname || '/',
  };
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

function runtimeHeaders(context) {
  return Object.fromEntries(
    Object.entries({
      'x-synthi-runtime-scope': context.runtimeScope,
      'x-synthi-workspace-slug': context.workspaceSlug,
      'x-synthi-runtime-kind': context.runtimeKind,
      'x-synthi-filesystem-user-id': context.filesystemUserId,
      'x-synthi-actor-user-id': context.actorUserId,
      'x-synthi-collab-session-id': context.collabSessionId,
    }).filter(([, value]) => Boolean(value)),
  );
}

function LoopbackAuthPage() {
  const searchParams = useSearchParams();
  const runtimeScope = searchParams.get('runtimeScope') || '';
  const authUrl = searchParams.get('authUrl') || '';
  const workspaceSlug = searchParams.get('workspaceSlug') || '';
  const terminalId = searchParams.get('terminalId') || '';
  const runtimeKind = searchParams.get('runtimeKind') || 'private';
  const filesystemUserId = searchParams.get('filesystemUserId') || '';
  const actorUserId = searchParams.get('actorUserId') || '';
  const collabSessionId = searchParams.get('collabSessionId') || '';
  const loopbackRedirect = useMemo(() => findLoopbackRedirect(authUrl), [authUrl]);
  const expectedCallback = useMemo(() => expectedCallbackFromUrl(loopbackRedirect), [loopbackRedirect]);
  const [relaySession, setRelaySession] = useState(null);
  const [relayStatus, setRelayStatus] = useState('idle');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [browserStatus, setBrowserStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [opened, setOpened] = useState(false);

  const context = useMemo(() => ({
    workspaceSlug,
    runtimeScope,
    runtimeKind,
    filesystemUserId,
    actorUserId,
    collabSessionId,
  }), [workspaceSlug, runtimeScope, runtimeKind, filesystemUserId, actorUserId, collabSessionId]);

  const createRelaySession = useCallback(async () => {
    if (relaySession?.sessionId) return relaySession;
    if (!workspaceSlug || !runtimeScope || !authUrl) {
      throw new Error('This sign-in bridge is missing its workspace or runtime context.');
    }

    setRelayStatus('loading');
    const session = await postJson('/api/oauth-relay/session', {
      workspaceSlug,
      runtimeScope,
      runtimeKind,
      terminalId,
      collabSessionId,
      authUrl,
      expectedCallback,
    });
    setRelaySession(session);
    setRelayStatus('ready');
    return session;
  }, [authUrl, collabSessionId, expectedCallback, relaySession, runtimeKind, runtimeScope, terminalId, workspaceSlug]);

  useEffect(() => {
    if (!authUrl || relaySession || relayStatus === 'loading' || relayStatus === 'error') return;
    createRelaySession().catch((err) => {
      setRelayStatus('error');
      setMessage(err?.message || 'Failed to create a relay session.');
    });
  }, [authUrl, createRelaySession, relaySession, relayStatus]);

  const openAuth = useCallback(async () => {
    setMessage('');
    try {
      await createRelaySession();
      setOpened(true);
      window.open(authUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setRelayStatus('error');
      setMessage(err?.message || 'Failed to start terminal sign-in.');
    }
  }, [authUrl, createRelaySession]);

  useEffect(() => {
    if (!authUrl || opened || !relaySession?.sessionId) return;
    const key = `synthi.loopbackAuth.opened:${relaySession.sessionId.slice(0, 64)}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    const timer = setTimeout(openAuth, 300);
    return () => clearTimeout(timer);
  }, [authUrl, openAuth, opened, relaySession]);

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setCallbackUrl(text.trim());
    } catch {
      setMessage('Clipboard access was blocked. Paste the callback URL manually.');
    }
  };

  const complete = async () => {
    setMessage('');
    if (!relaySession?.sessionId) {
      setStatus('error');
      setMessage('The relay session is not ready yet.');
      return;
    }
    if (!isLoopbackCallback(callbackUrl)) {
      setStatus('error');
      setMessage('Paste the full localhost callback URL from the failed browser tab.');
      return;
    }

    setStatus('loading');
    try {
      await postJson('/api/oauth-relay/callback', {
        sessionId: relaySession.sessionId,
        workspaceSlug,
        callbackUrl,
      });
      setStatus('success');
      setMessage('The callback was sent to the workspace. Return to the terminal.');
    } catch (err) {
      setStatus('error');
      setMessage(err?.message || 'Failed to send the callback to the workspace.');
    }
  };

  const openWorkspaceBrowser = async () => {
    setBrowserStatus('loading');
    setMessage('');
    try {
      const response = await fetch('/api/browser-workflows/open-external', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...runtimeHeaders(context),
        },
        body: JSON.stringify({ url: authUrl }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.workspaceBrowser?.url) {
        throw new Error(data?.error || 'workspace_browser_unavailable');
      }
      window.open(data.workspaceBrowser.url, '_blank', 'noopener,noreferrer');
      setBrowserStatus('idle');
    } catch (err) {
      setBrowserStatus('error');
      setMessage(err?.message || 'Workspace browser is unavailable.');
    }
  };

  const canSubmit = status !== 'loading' && relayStatus === 'ready';
  const callbackHint = loopbackRedirect
    ? `${normalizeLoopbackHost(loopbackRedirect.hostname)}:${loopbackRedirect.port}${loopbackRedirect.pathname || '/'}`
    : 'localhost callback from the failed browser tab';

  return (
    <main className="min-h-screen bg-[#08090d] text-[#f5f4ef] flex items-center justify-center p-6">
      <section className="w-full max-w-[720px] border border-[#34313a] bg-[#101119] rounded-[8px] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-[#55d6be]">Workspace auth</div>
            <h1 className="mt-3 text-2xl font-semibold">Complete terminal sign-in</h1>
          </div>
          <ShieldAlert className="mt-1 h-6 w-6 text-[#55d6be]" />
        </div>

        <div className="mt-6 rounded-[6px] border border-[#2b3340] bg-[#0b0d13] p-4 text-sm leading-6 text-[#c6c2bd]">
          <p>Keep this tab open. Sign in in the tab that opens.</p>
          <p className="mt-2">
            If that tab ends on a localhost error, copy its full address and paste it below.
            Synthi will send that callback to the workspace runtime.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#8f8a84]">
            <span className="rounded-[4px] border border-[#303846] px-2 py-1">workspace {workspaceSlug || 'missing'}</span>
            <span className="rounded-[4px] border border-[#303846] px-2 py-1">runtime {runtimeScope || 'missing'}</span>
            <span className="rounded-[4px] border border-[#303846] px-2 py-1">expects {callbackHint}</span>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={openAuth}
            disabled={relayStatus === 'loading'}
            className="inline-flex items-center gap-2 rounded-[6px] bg-[#55d6be] px-4 py-2 text-sm font-semibold text-[#07110f] hover:bg-[#72ead5] disabled:opacity-60"
          >
            {relayStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            Open sign-in
          </button>
          <button
            type="button"
            onClick={pasteFromClipboard}
            className="inline-flex items-center gap-2 rounded-[6px] border border-[#3a4452] px-4 py-2 text-sm font-semibold text-[#e8e4dc] hover:bg-[#181b25]"
          >
            <Clipboard className="h-4 w-4" />
            Paste URL
          </button>
          <button
            type="button"
            onClick={openWorkspaceBrowser}
            disabled={browserStatus === 'loading'}
            className="inline-flex items-center gap-2 rounded-[6px] border border-[#3a4452] px-4 py-2 text-sm font-semibold text-[#e8e4dc] hover:bg-[#181b25] disabled:opacity-60"
          >
            {browserStatus === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorUp className="h-4 w-4" />}
            Workspace browser
          </button>
        </div>

        {relayStatus === 'error' && (
          <button
            type="button"
            onClick={() => {
              setRelayStatus('idle');
              setRelaySession(null);
              setMessage('');
            }}
            className="mt-3 inline-flex items-center gap-2 rounded-[6px] border border-[#5b4a33] px-3 py-2 text-xs font-semibold text-[#f2c078] hover:bg-[#1d1710]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry relay session
          </button>
        )}

        <label className="mt-6 block text-xs uppercase tracking-[0.16em] text-[#8f8a84]">
          Localhost callback URL
        </label>
        <textarea
          value={callbackUrl}
          onChange={(event) => setCallbackUrl(event.target.value)}
          spellCheck={false}
          className="mt-2 min-h-[112px] w-full resize-y rounded-[6px] border border-[#3a3440] bg-[#06070b] p-3 font-mono text-sm text-[#f5f4ef] outline-none focus:border-[#55d6be]"
          placeholder="http://localhost:1455/auth/callback?code=..."
        />

        <button
          type="button"
          onClick={complete}
          disabled={!canSubmit}
          className="mt-4 inline-flex items-center gap-2 rounded-[6px] bg-[#f5f4ef] px-4 py-2 text-sm font-semibold text-[#090a0e] disabled:opacity-60"
        >
          {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Send to workspace
        </button>

        {message && (
          <div
            className={`mt-4 rounded-[6px] border p-3 text-sm ${
              status === 'success'
                ? 'border-[#245f50] bg-[#0d221d] text-[#9ef2df]'
                : 'border-[#612c33] bg-[#241014] text-[#ff9aa8]'
            }`}
          >
            {message}
          </div>
        )}
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoopbackAuthPage />
    </Suspense>
  );
}
