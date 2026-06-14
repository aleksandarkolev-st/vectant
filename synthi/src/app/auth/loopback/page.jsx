'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Clipboard, ExternalLink, Loader2, ShieldAlert } from 'lucide-react';
import { resolveCollabHttpUrl } from '@/lib/collab-url';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function isLoopbackCallback(value) {
  const parsed = parseUrl(value);
  return Boolean(
    parsed &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.port &&
    LOOPBACK_HOSTS.has(parsed.hostname),
  );
}

function findLoopbackRedirect(authUrl) {
  const parsed = parseUrl(authUrl);
  if (!parsed) return null;

  for (const [key, value] of parsed.searchParams) {
    if (!/(redirect|callback|return|continue|next|url|uri)/i.test(key)) continue;
    if (isLoopbackCallback(value)) return parseUrl(value);
  }

  const hash = parsed.hash ? parsed.hash.slice(1) : '';
  if (hash.includes('=')) {
    const params = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
    for (const [key, value] of params) {
      if (!/(redirect|callback|return|continue|next|url|uri)/i.test(key)) continue;
      if (isLoopbackCallback(value)) return parseUrl(value);
    }
  }

  return null;
}

function LoopbackAuthPage() {
  const searchParams = useSearchParams();
  const runtimeScope = searchParams.get('runtimeScope') || '';
  const authUrl = searchParams.get('authUrl') || '';
  const loopbackRedirect = useMemo(() => findLoopbackRedirect(authUrl), [authUrl]);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [opened, setOpened] = useState(false);

  const openAuth = () => {
    if (!authUrl) return;
    setOpened(true);
    window.open(authUrl, '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    if (!authUrl || opened) return;
    const key = `synthi.loopbackAuth.opened:${runtimeScope}:${authUrl.slice(0, 80)}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    const timer = setTimeout(openAuth, 300);
    return () => clearTimeout(timer);
  }, [authUrl, opened, runtimeScope]);

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
    if (!runtimeScope || !authUrl) {
      setStatus('error');
      setMessage('This sign-in bridge is missing its runtime context.');
      return;
    }
    if (!isLoopbackCallback(callbackUrl)) {
      setStatus('error');
      setMessage('Paste the full localhost callback URL from the failed browser tab.');
      return;
    }

    setStatus('loading');
    try {
      const res = await fetch(`${resolveCollabHttpUrl().replace(/\/+$/, '')}/runtime-callback`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtimeScope, callbackUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `Workspace callback returned ${body.statusCode || res.status}`);
      }
      setStatus('success');
      setMessage('The callback was sent to the workspace. Return to the terminal.');
    } catch (err) {
      setStatus('error');
      setMessage(err?.message || 'Failed to send the callback to the workspace.');
    }
  };

  return (
    <main className="min-h-screen bg-[#08090d] text-[#f5f4ef] flex items-center justify-center p-6">
      <section className="w-full max-w-[680px] border border-[#34313a] bg-[#101119] rounded-[8px] p-6 shadow-2xl">
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
          {loopbackRedirect && (
            <p className="mt-2 text-[#8f8a84]">
              Expected callback: {loopbackRedirect.hostname}:{loopbackRedirect.port}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={openAuth}
            className="inline-flex items-center gap-2 rounded-[6px] bg-[#55d6be] px-4 py-2 text-sm font-semibold text-[#07110f] hover:bg-[#72ead5]"
          >
            <ExternalLink className="h-4 w-4" />
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
        </div>

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
          disabled={status === 'loading'}
          className="mt-4 inline-flex items-center gap-2 rounded-[6px] bg-[#f5f4ef] px-4 py-2 text-sm font-semibold text-[#090a0e] disabled:opacity-60"
        >
          {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          Complete sign-in
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
