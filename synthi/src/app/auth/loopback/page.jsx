'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;
const EXTENSION_PAGE_SOURCE = 'synthi-oauth-relay-page';
const EXTENSION_SOURCE = 'synthi-oauth-relay-extension';
const EXTENSION_INSTALL_URL =
  process.env.NEXT_PUBLIC_SYNTHI_OAUTH_RELAY_EXTENSION_URL ||
  'https://github.com/vectant/vectant-ade/tree/main/extensions/synthi-oauth-relay';
const MOTION_EASE = [0.16, 1, 0.3, 1];
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: MOTION_EASE } },
};
const stepList = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.08 } },
};

function MiniIcon({ name, className = '' }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  };

  if (name === 'external') {
    return (
      <svg {...common}>
        <path d="M14 5h5v5" />
        <path d="M19 5l-9 9" />
        <path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
      </svg>
    );
  }
  if (name === 'clipboard') {
    return (
      <svg {...common}>
        <path d="M9 5h6" />
        <path d="M9 4h6a1 1 0 0 1 1 1v2H8V5a1 1 0 0 1 1-1Z" />
        <path d="M7 6H5.8A1.8 1.8 0 0 0 4 7.8v10.4A1.8 1.8 0 0 0 5.8 20h12.4a1.8 1.8 0 0 0 1.8-1.8V7.8A1.8 1.8 0 0 0 18.2 6H17" />
      </svg>
    );
  }
  if (name === 'browser') {
    return (
      <svg {...common}>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M4 9h16" />
        <path d="M8 15h8" />
      </svg>
    );
  }
  if (name === 'plug') {
    return (
      <svg {...common}>
        <path d="M9 7V3" />
        <path d="M15 7V3" />
        <path d="M7 7h10v4a5 5 0 0 1-10 0V7Z" />
        <path d="M12 16v5" />
      </svg>
    );
  }
  if (name === 'check') {
    return (
      <svg {...common}>
        <path d="M20 7 10 17l-5-5" />
      </svg>
    );
  }
  if (name === 'retry') {
    return (
      <svg {...common}>
        <path d="M20 7v5h-5" />
        <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8" />
      </svg>
    );
  }
  if (name === 'shield') {
    return (
      <svg {...common}>
        <path d="M12 3 19 6v5c0 4.2-2.7 7.7-7 10-4.3-2.3-7-5.8-7-10V6l7-3Z" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
    );
  }
  return null;
}

function Spinner({ className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-4 w-4 animate-spin rounded-[999px] border-2 border-current border-r-transparent ${className}`}
    />
  );
}

function StepNumber({ value, complete = false }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[999px] border text-xs font-semibold ${
        complete
          ? 'border-[#1f8075] bg-[#0f2f2d] text-[#74efe0]'
          : 'border-[#303443] bg-[#0b0d13] text-[#c6c2bd]'
      }`}
    >
      {complete ? <MiniIcon name="check" className="h-3.5 w-3.5" /> : value}
    </span>
  );
}

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

function sendExtensionMessage(type, payload = {}, timeoutMs = 900) {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const messageId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(null);
    }, timeoutMs);

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== EXTENSION_SOURCE || data.messageId !== messageId) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data.payload || null);
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: EXTENSION_PAGE_SOURCE,
      type,
      messageId,
      payload,
    }, window.location.origin);
  });
}

function notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status }) {
  if (typeof window === 'undefined') return;
  const payload = {
    type: 'synthi.oauthRelay.complete',
    workspaceSlug,
    runtimeScope,
    terminalId,
    status,
    at: Date.now(),
  };

  try {
    const channel = new BroadcastChannel('synthi-oauth-relay');
    channel.postMessage(payload);
    channel.close();
  } catch {}

  try {
    window.localStorage.setItem('synthi.oauthRelay.lastComplete', JSON.stringify(payload));
  } catch {}

  try {
    window.opener?.postMessage(payload, window.location.origin);
  } catch {}
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
  const [extensionStatus, setExtensionStatus] = useState({ installed: false, armed: false });
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState('error');
  const [opened, setOpened] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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

  const refreshExtensionStatus = useCallback(async () => {
    const response = await sendExtensionMessage('SYNTHI_OAUTH_RELAY_STATUS', {
      sessionId: relaySession?.sessionId || '',
    });
    if (!response?.installed) {
      setExtensionStatus({ installed: false, armed: false });
      return null;
    }
    setExtensionStatus(response);
    return response;
  }, [relaySession]);

  useEffect(() => {
    if (!authUrl || relaySession || relayStatus === 'loading' || relayStatus === 'error') return;
    createRelaySession().catch((err) => {
      setRelayStatus('error');
      setMessageTone('error');
      setMessage(err?.message || 'Failed to create a relay session.');
    });
  }, [authUrl, createRelaySession, relaySession, relayStatus]);

  useEffect(() => {
    refreshExtensionStatus();
  }, [refreshExtensionStatus]);

  useEffect(() => {
    if (!extensionStatus.installed || !relaySession?.sessionId) return;
    const timer = window.setInterval(async () => {
      const statusResult = await refreshExtensionStatus();
      const last = statusResult?.lastSubmission;
      if (last?.sessionId === relaySession.sessionId && last.ok) {
        setStatus('success');
        setMessageTone('success');
        notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status: 'success' });
        setMessage('The extension sent the callback to the workspace. Return to the terminal.');
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [extensionStatus.installed, refreshExtensionStatus, relaySession]);

  const openAuth = useCallback(async () => {
    setMessage('');
    try {
      await createRelaySession();
      setOpened(true);
      window.open(authUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setRelayStatus('error');
      setMessageTone('error');
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
      setMessageTone('error');
      setMessage('Clipboard access was blocked. Paste the callback URL manually.');
    }
  };

  const complete = async () => {
    setMessage('');
    if (!relaySession?.sessionId) {
      setStatus('error');
      setMessageTone('error');
      setMessage('The relay session is not ready yet.');
      return;
    }
    if (!isLoopbackCallback(callbackUrl)) {
      setStatus('error');
      setMessageTone('error');
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
      setMessageTone('success');
      notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status: 'success' });
      setMessage('The callback was delivered to the workspace. Return to the terminal. If the CLI stays on the same screen, restart the command; many CLIs will now see the saved credentials.');
    } catch (err) {
      setStatus('error');
      setMessageTone('error');
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
      setMessageTone('error');
      setMessage(err?.message || 'Workspace browser is unavailable.');
    }
  };

  const armExtension = async () => {
    setExtensionBusy(true);
    setMessage('');
    try {
      const session = await createRelaySession();
      const response = await sendExtensionMessage('SYNTHI_OAUTH_RELAY_ARM', {
        sessionId: session.sessionId,
        workspaceSlug,
        runtimeScope,
        terminalId,
        expectedCallback: session.expectedCallback || expectedCallback,
        expiresAt: session.expiresAt,
        endpoint: `${window.location.origin}/api/oauth-relay/callback`,
      }, 1500);
      if (!response?.ok) {
        throw new Error(response?.error || 'oauth_relay_extension_unavailable');
      }
      setExtensionStatus({ installed: true, armed: true, lastSubmission: response.lastSubmission || null });
      setMessageTone('success');
      setMessage('Automatic callback capture is enabled for this sign-in.');
    } catch (err) {
      setMessageTone('error');
      setMessage(err?.message || 'Could not enable automatic callback capture.');
    } finally {
      setExtensionBusy(false);
    }
  };

  const hasValidCallback = isLoopbackCallback(callbackUrl);
  const isComplete = status === 'success';
  const canSubmit = status !== 'loading' && relayStatus === 'ready' && hasValidCallback && !isComplete;
  const callbackHint = loopbackRedirect
    ? `${normalizeLoopbackHost(loopbackRedirect.hostname)}:${loopbackRedirect.port}${loopbackRedirect.pathname || '/'}`
    : 'redirected localhost URL from the browser tab';

  const returnToTerminal = () => {
    notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status: 'success' });
    try { window.opener?.focus(); } catch {}
    try { window.close(); } catch {}
  };

  return (
    <motion.main
      initial="hidden"
      animate="visible"
      className="min-h-screen bg-[#07080c] px-5 py-16 text-[#f5f4ef] md:py-24"
      style={{ fontFamily: "'SF Pro Display', 'Geist Sans', 'Helvetica Neue', sans-serif" }}
    >
      <motion.section
        variants={fadeUp}
        className="relative mx-auto w-full max-w-[920px] rounded-[12px] border border-[#2a2f3d] bg-[#11121a] p-6 md:p-10"
      >
        <div className="flex items-start justify-between gap-6 border-b border-[#262b38] pb-8">
          <div className="max-w-2xl">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#55d6be]">
              Workspace auth
            </div>
            <h1
              className="mt-4 text-[38px] font-semibold leading-[1.06] tracking-[-0.03em] text-[#f5f4ef] md:text-[54px]"
            >
              Complete terminal sign-in
            </h1>
            <p className="mt-5 max-w-[620px] text-[15px] leading-[1.7] text-[#c6c2bd]">
              Keep this tab open. Sign in with your normal browser, then copy the redirected localhost URL and send it back to the workspace.
            </p>
          </div>
          <div className="hidden h-10 w-10 items-center justify-center rounded-[10px] border border-[#303443] bg-[#0b0d13] text-[#55d6be] md:flex">
            <MiniIcon name="shield" className="h-5 w-5" />
          </div>
        </div>

        <motion.div variants={stepList} className="mt-8 grid gap-4">
          <motion.article
            variants={fadeUp}
            className={`rounded-[12px] border border-[#303443] bg-[#0b0d13] p-5 transition-opacity md:p-6 ${
              isComplete ? 'opacity-55' : ''
            }`}
          >
            <div className="flex gap-4">
              <StepNumber value="1" complete={opened || isComplete} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-[#f5f4ef]">
                      Open the sign-in page
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-[#a5a29d]">
                      Sign in, then copy the redirected localhost URL from the browser address bar.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.98 }}
                      onClick={openAuth}
                      disabled={relayStatus === 'loading' || isComplete}
                      className={`inline-flex h-10 items-center gap-2 rounded-[6px] px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                        hasValidCallback || isComplete
                          ? 'border border-[#303443] bg-[#101119] text-[#f5f4ef] hover:bg-[#181b25]'
                          : 'bg-[#55d6be] text-[#07110f] hover:bg-[#72ead5]'
                      }`}
                    >
                      {relayStatus === 'loading' ? <Spinner /> : <MiniIcon name="external" className="h-4 w-4" />}
                      Open sign-in
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.98 }}
                      onClick={openWorkspaceBrowser}
                      disabled={browserStatus === 'loading' || isComplete}
                      className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#303443] bg-[#101119] px-4 text-sm font-semibold text-[#f5f4ef] transition-colors hover:bg-[#181b25] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {browserStatus === 'loading' ? <Spinner /> : <MiniIcon name="browser" className="h-4 w-4" />}
                      Workspace browser
                    </motion.button>
                  </div>
                </div>

                {relayStatus === 'error' && (
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => {
                      setRelayStatus('idle');
                      setRelaySession(null);
                      setMessageTone('error');
                      setMessage('');
                    }}
                    className="mt-4 inline-flex h-9 items-center gap-2 rounded-[6px] border border-[#3c3524] bg-[#17150e] px-3 text-xs font-semibold text-[#d3b46b]"
                  >
                    <MiniIcon name="retry" className="h-3.5 w-3.5" />
                    Retry relay session
                  </motion.button>
                )}
              </div>
            </div>
          </motion.article>

          <motion.article
            variants={fadeUp}
            className={`rounded-[12px] border border-[#303443] bg-[#11121a] p-5 md:p-6 ${
              isComplete ? 'bg-[#0b0d13]' : ''
            }`}
          >
            <div className="flex gap-4">
              <StepNumber value="2" complete={isComplete} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-1">
                  <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-[#f5f4ef]">
                    Provide the callback
                  </h2>
                  <p className="text-sm leading-6 text-[#a5a29d]">
                    Paste the full localhost callback URL from the browser address bar.
                  </p>
                </div>

                <AnimatePresence mode="wait">
                  {isComplete ? (
                    <motion.div
                      key="complete"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.35, ease: MOTION_EASE }}
                      className="mt-5 rounded-[8px] border border-[#1f8075] bg-[#0b2a25] p-4 text-sm leading-6 text-[#7df3df]"
                    >
                      Callback delivered. Your workspace terminal has been notified.
                    </motion.div>
                  ) : (
                    <motion.div
                      key="form"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.35, ease: MOTION_EASE }}
                      className="mt-5"
                    >
                      <div className="overflow-hidden rounded-[8px] border border-[#303443] bg-[#0b0d13]">
                        <div className="flex items-center justify-between gap-3 border-b border-[#303443] px-3 py-2">
                          <label className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a5a29d]">
                            Localhost callback URL
                          </label>
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.98 }}
                            onClick={pasteFromClipboard}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-[#303443] bg-[#101119] px-2.5 text-xs font-semibold text-[#f5f4ef] transition-colors hover:bg-[#181b25]"
                          >
                            <MiniIcon name="clipboard" className="h-3.5 w-3.5" />
                            Paste
                          </motion.button>
                        </div>
                        <textarea
                          value={callbackUrl}
                          onChange={(event) => setCallbackUrl(event.target.value)}
                          spellCheck={false}
                          className="min-h-[132px] w-full resize-y border-0 bg-[#050609] p-4 text-[13px] leading-6 text-[#f5f4ef] outline-none placeholder:text-[#6f6c75]"
                          style={{ fontFamily: "'Geist Mono', 'SF Mono', 'JetBrains Mono', monospace" }}
                          placeholder="http://localhost:1455/auth/callback?code=..."
                        />
                      </div>

                      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs leading-5 text-[#a5a29d]">
                          {hasValidCallback ? 'Ready to deliver to the workspace.' : `Expected ${callbackHint}.`}
                        </p>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.98 }}
                          onClick={complete}
                          disabled={!canSubmit}
                          className={`inline-flex h-11 items-center justify-center gap-2 rounded-[6px] px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                            hasValidCallback
                              ? 'bg-[#f5f4ef] text-[#07110f] hover:bg-[#ffffff]'
                              : 'border border-[#303443] bg-[#101119] text-[#8f8a84]'
                          }`}
                        >
                          {status === 'loading' ? <Spinner /> : <MiniIcon name="check" className="h-4 w-4" />}
                          Send to workspace
                        </motion.button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.article>
        </motion.div>

        <motion.div
          variants={fadeUp}
          className="mt-4 rounded-[12px] border border-[#303443] bg-[#0b0d13] p-5"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#102926] text-[#55d6be]">
                <MiniIcon name="plug" className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-[#f5f4ef]">
                  Skip copy and paste next time
                </h3>
                <p className="mt-1 text-sm leading-6 text-[#a5a29d]">
                  Install the Synthi OAuth Relay extension to capture matching localhost callbacks automatically.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <motion.a
                whileTap={{ scale: 0.98 }}
                href={EXTENSION_INSTALL_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center rounded-[6px] border border-[#303443] bg-[#101119] px-4 text-sm font-semibold text-[#f5f4ef] transition-colors hover:bg-[#181b25]"
              >
                View setup
              </motion.a>
              <motion.button
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={armExtension}
                disabled={extensionBusy || relayStatus !== 'ready' || !extensionStatus.installed || isComplete}
                className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#303443] bg-[#101119] px-4 text-sm font-semibold text-[#f5f4ef] transition-colors hover:bg-[#181b25] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {extensionBusy ? <Spinner /> : <MiniIcon name="plug" className="h-4 w-4" />}
                {extensionStatus.armed ? 'Auto-capture on' : extensionStatus.installed ? 'Enable' : 'Not detected'}
              </motion.button>
            </div>
          </div>
        </motion.div>

        <AnimatePresence>
          {message && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: MOTION_EASE }}
              className={`mt-4 rounded-[8px] border p-4 text-sm leading-6 ${
                status === 'success' || messageTone === 'success'
                  ? 'border-[#1f8075] bg-[#0b2a25] text-[#7df3df]'
                  : 'border-[#6f3434] bg-[#2c1115] text-[#ff8e8e]'
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{message}</span>
                {isComplete && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={returnToTerminal}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] bg-[#f5f4ef] px-3 text-xs font-semibold text-[#07110f] hover:bg-[#ffffff]"
                  >
                    Return to terminal
                  </motion.button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-6 border-t border-[#262b38] pt-4">
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8f8a84] transition-colors hover:text-[#f5f4ef]"
          >
            {showDetails ? 'Hide connection details' : 'Show connection details'}
          </button>
          <AnimatePresence initial={false}>
            {showDetails && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: MOTION_EASE }}
                className="overflow-hidden"
              >
                <div
                  className="mt-4 grid gap-2 rounded-[8px] border border-[#303443] bg-[#0b0d13] p-3 text-xs leading-5 text-[#a5a29d] md:grid-cols-3"
                  style={{ fontFamily: "'Geist Mono', 'SF Mono', 'JetBrains Mono', monospace" }}
                >
                  <div>workspace {workspaceSlug || 'missing'}</div>
                  <div>runtime {runtimeScope || 'missing'}</div>
                  <div>expects {callbackHint}</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.section>
    </motion.main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoopbackAuthPage />
    </Suspense>
  );
}
