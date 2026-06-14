'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;
const EXTENSION_PAGE_SOURCES = ['vectant-oauth-relay-page', 'synthi-oauth-relay-page'];
const EXTENSION_SOURCES = new Set(['vectant-oauth-relay-extension', 'synthi-oauth-relay-extension']);
const EXTENSION_INSTALL_URL =
  process.env.NEXT_PUBLIC_VECTANT_OAUTH_RELAY_EXTENSION_URL ||
  process.env.NEXT_PUBLIC_SYNTHI_OAUTH_RELAY_EXTENSION_URL ||
  '/vectant/extensions/vectant-oauth-relay.zip';
const MOTION_EASE = [0.16, 1, 0.3, 1];
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: MOTION_EASE } },
};
const stepList = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.08 } },
};
const uiFont = "'Inter', 'Geist', 'SF Pro Display', 'Segoe UI', sans-serif";
const monoFont = "'IBM Plex Mono', 'JetBrains Mono', 'SF Mono', monospace";

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
      className={`inline-block h-4 w-4 animate-spin border-2 border-current border-r-transparent ${className}`}
    />
  );
}

function VectantMark() {
  return (
    <div className="relative flex h-9 w-11 items-center justify-center" aria-hidden="true">
      <span className="absolute left-0 top-1 h-7 w-[7px] border-y-2 border-l-2 border-[#5dd6e4]" />
      <span className="absolute right-0 top-1 h-7 w-[7px] border-y-2 border-r-2 border-[#ff9e64]" />
      <img
        src="/vectant/the_V.png"
        alt=""
        className="h-7 w-7 object-contain"
        draggable={false}
      />
    </div>
  );
}

function StepNumber({ value, complete = false }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-[11px] font-semibold ${
        complete
          ? 'border-[#9be8c4] bg-[#101f1b] text-[#9be8c4]'
          : 'border-[#2b2d3e] bg-[#0a0b11] text-[#f4f5f8]'
      }`}
      style={{ fontFamily: monoFont }}
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
    protocol: url.protocol,
    host: normalizeLoopbackHost(url.hostname),
    port: Number(url.port),
    pathPrefix: url.pathname || '/',
  };
}

function combinedUrlParams(parsedUrl) {
  const params = new URLSearchParams(parsedUrl.search);
  const hash = parsedUrl.hash ? parsedUrl.hash.slice(1) : '';
  if (!hash.includes('=')) return params;

  const hashParams = new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash);
  for (const [key, value] of hashParams) {
    if (!params.has(key)) params.append(key, value);
  }
  return params;
}

function getUrlParam(rawUrl, key) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return '';
  return combinedUrlParams(parsed).get(key) || '';
}

function validateOAuthValue(value, { min = 4, max = 4096 } = {}) {
  if (!value || value.length < min) return false;
  if (value.length > max) return false;
  if (value.trim() !== value) return false;
  return !CONTROL_CHAR_RE.test(value);
}

function validateCallbackUrl(value, expectedCallback, expectedState) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'empty',
      message: 'Paste the redirected localhost URL from the browser address bar.',
    };
  }

  const parsed = parseUrl(trimmed);
  if (!parsed) {
    return {
      ok: false,
      reason: 'invalid_url',
      message: 'That does not look like a complete URL.',
    };
  }

  const host = normalizeLoopbackHost(parsed.hostname);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'invalid_protocol',
      message: 'Use the redirected local callback URL from the browser address bar.',
    };
  }
  if (!parsed.port) {
    return {
      ok: false,
      reason: 'missing_port',
      message: 'The callback URL is missing its localhost port.',
    };
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    return {
      ok: false,
      reason: 'not_loopback',
      message: 'This is not a localhost callback URL.',
    };
  }

  if (expectedCallback?.protocol && parsed.protocol !== expectedCallback.protocol) {
    return {
      ok: false,
      reason: 'wrong_protocol',
      message: `This sign-in expects ${expectedCallback.protocol}//${expectedCallback.host}:${expectedCallback.port}.`,
    };
  }

  if (expectedCallback?.port && Number(parsed.port) !== Number(expectedCallback.port)) {
    return {
      ok: false,
      reason: 'wrong_port',
      message: `This sign-in expects ${expectedCallback.host}:${expectedCallback.port}.`,
    };
  }

  if (expectedCallback?.pathPrefix) {
    const expectedPath = expectedCallback.pathPrefix.endsWith('/')
      ? expectedCallback.pathPrefix
      : expectedCallback.pathPrefix;
    const actualPath = parsed.pathname || '/';
    if (expectedPath !== '/' && actualPath !== expectedPath && !actualPath.startsWith(`${expectedPath}/`)) {
      return {
        ok: false,
        reason: 'wrong_path',
        message: `This sign-in expects ${expectedPath}.`,
      };
    }
  }

  const params = combinedUrlParams(parsed);
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  if (!validateOAuthValue(code, { min: 8 })) {
    return {
      ok: false,
      reason: 'missing_code',
      message: 'The callback URL is missing a complete authorization code.',
    };
  }
  if (expectedState && !validateOAuthValue(state, { min: 4, max: 4096 })) {
    return {
      ok: false,
      reason: 'missing_state',
      message: 'The callback URL is missing a complete state value.',
    };
  }
  if (!expectedState && state && !validateOAuthValue(state, { min: 4, max: 4096 })) {
    return {
      ok: false,
      reason: 'invalid_state',
      message: 'The callback URL contains an incomplete state value.',
    };
  }
  if (expectedState && state !== expectedState) {
    return {
      ok: false,
      reason: 'state_mismatch',
      message: 'The callback state does not match this terminal sign-in.',
    };
  }

  return {
    ok: true,
    reason: 'valid',
    message: 'Ready to send to the workspace.',
    url: trimmed,
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
      if (!data || !EXTENSION_SOURCES.has(data.source) || data.messageId !== messageId) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data.payload || null);
    }

    window.addEventListener('message', onMessage);
    for (const source of EXTENSION_PAGE_SOURCES) {
      window.postMessage({
        source,
        type,
        messageId,
        payload,
      }, window.location.origin);
    }
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
  const expectedState = useMemo(() => getUrlParam(authUrl, 'state'), [authUrl]);
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
  const openButtonRef = useRef(null);
  const callbackInputRef = useRef(null);
  const lastClipboardCandidateRef = useRef('');
  const submittingRef = useRef(false);
  const completedRef = useRef(false);

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

  const callbackValidation = useMemo(
    () => validateCallbackUrl(callbackUrl, expectedCallback, expectedState),
    [callbackUrl, expectedCallback, expectedState],
  );

  const complete = useCallback(async (candidateUrl = callbackUrl, options = {}) => {
    if (submittingRef.current || completedRef.current) return;
    setMessage('');
    const trimmedCallbackUrl = String(candidateUrl || '').trim();
    const validation = validateCallbackUrl(trimmedCallbackUrl, expectedCallback, expectedState);

    if (!relaySession?.sessionId) {
      setStatus('error');
      setMessageTone('error');
      setMessage('The relay session is not ready yet.');
      return;
    }
    if (!validation.ok) {
      setStatus('error');
      setMessageTone('error');
      setMessage(validation.message);
      return;
    }

    setCallbackUrl(trimmedCallbackUrl);
    setStatus('loading');
    submittingRef.current = true;
    try {
      await postJson('/api/oauth-relay/callback', {
        sessionId: relaySession.sessionId,
        workspaceSlug,
        callbackUrl: trimmedCallbackUrl,
      });
      completedRef.current = true;
      setStatus('success');
      setMessageTone('success');
      notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status: 'success' });
      setMessage(options.source === 'clipboard'
        ? 'Callback detected from your clipboard and delivered to the workspace. Return to the terminal.'
        : 'The callback was delivered to the workspace. Return to the terminal. If the CLI stays on the same screen, restart the command; many CLIs will now see the saved credentials.');
    } catch (err) {
      setStatus('error');
      setMessageTone('error');
      setMessage(err?.message || 'Failed to send the callback to the workspace.');
    } finally {
      submittingRef.current = false;
    }
  }, [callbackUrl, expectedCallback, expectedState, relaySession, runtimeScope, terminalId, workspaceSlug]);

  const tryCompleteCandidate = useCallback((candidateUrl, source) => {
    const trimmed = String(candidateUrl || '').trim();
    if (!trimmed || status === 'success' || status === 'loading') return false;
    setCallbackUrl(trimmed);
    const validation = validateCallbackUrl(trimmed, expectedCallback, expectedState);
    if (!validation.ok || relayStatus !== 'ready') return false;
    complete(trimmed, { source });
    return true;
  }, [complete, expectedCallback, expectedState, relayStatus, status]);

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const submitted = tryCompleteCandidate(text, 'paste');
      if (!submitted) setCallbackUrl(text.trim());
    } catch {
      setMessageTone('error');
      setMessage('Clipboard access was blocked. Paste the callback URL manually.');
    }
  };

  const handleCallbackPaste = (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    const validation = validateCallbackUrl(text, expectedCallback, expectedState);
    if (!validation.ok) return;
    event.preventDefault();
    tryCompleteCandidate(text, 'paste');
  };

  const handleCallbackKeyDown = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (relayStatus === 'ready' && callbackValidation.ok && status !== 'loading') {
      complete(callbackUrl, { source: 'keyboard' });
    }
  };

  useEffect(() => {
    if (status === 'success') return;
    const timer = window.setTimeout(() => {
      if (opened || relayStatus === 'ready') {
        callbackInputRef.current?.focus();
      } else {
        openButtonRef.current?.focus();
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [opened, relayStatus, status]);

  useEffect(() => {
    if (relayStatus !== 'ready' || status === 'success' || status === 'loading') return;
    if (!navigator.clipboard?.readText) return;

    let cancelled = false;
    const inspectClipboard = async () => {
      if (cancelled || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      try {
        const text = await navigator.clipboard.readText();
        const trimmed = String(text || '').trim();
        if (!trimmed || trimmed === lastClipboardCandidateRef.current) return;
        const validation = validateCallbackUrl(trimmed, expectedCallback, expectedState);
        if (!validation.ok) return;
        lastClipboardCandidateRef.current = trimmed;
        setMessageTone('success');
        setMessage('Callback URL found on your clipboard. Sending it to the workspace.');
        tryCompleteCandidate(trimmed, 'clipboard');
      } catch {
        // Browsers may block background clipboard reads. Manual paste remains available.
      }
    };

    const onFocus = () => window.setTimeout(inspectClipboard, 120);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onFocus();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const initialTimer = window.setTimeout(inspectClipboard, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [expectedCallback, expectedState, relayStatus, status, tryCompleteCandidate]);

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

  const hasValidCallback = callbackValidation.ok;
  const isComplete = status === 'success';
  const canSubmit = status !== 'loading' && relayStatus === 'ready' && hasValidCallback && !isComplete;
  const expectedHost = loopbackRedirect ? normalizeLoopbackHost(loopbackRedirect.hostname) : 'localhost';
  const expectedPort = loopbackRedirect?.port || '----';
  const callbackState = isComplete ? 'delivered' : hasValidCallback ? 'ready' : 'pending';
  const sessionState = isComplete
    ? 'complete'
    : relaySession?.sessionId
      ? 'linked'
      : relayStatus === 'loading'
        ? 'arming'
        : 'not linked';
  const callbackHint = loopbackRedirect
    ? `${normalizeLoopbackHost(loopbackRedirect.hostname)}:${loopbackRedirect.port}${loopbackRedirect.pathname || '/'}`
    : 'redirected localhost URL from the browser tab';
  const callbackPlaceholder = loopbackRedirect
    ? `${loopbackRedirect.protocol}//${normalizeLoopbackHost(loopbackRedirect.hostname)}:${loopbackRedirect.port}${loopbackRedirect.pathname || '/'}?code=...&state=...`
    : 'http://localhost:<port>/callback?code=...&state=...';
  const callbackHelperText = callbackUrl.trim()
    ? callbackValidation.message
    : `Expected ${callbackHint}.`;

  const returnToTerminal = () => {
    notifyWorkspaceRelayComplete({ workspaceSlug, runtimeScope, terminalId, status: 'success' });
    try { window.opener?.focus(); } catch {}
    try { window.close(); } catch {}
  };

  return (
    <motion.main
      initial="hidden"
      animate="visible"
      className="relative min-h-screen overflow-hidden bg-[#06060a] px-5 py-12 text-[#f4f5f8] md:py-20"
      style={{ fontFamily: uiFont }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 h-48 opacity-[0.018]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 3px, #f4f5f8 3px, #f4f5f8 4px)',
        }}
      />
      <motion.section
        variants={fadeUp}
        className="relative mx-auto grid w-full max-w-[940px] border border-[#2b2d3e] bg-[#0d0e15]"
      >
        <div className="grid border-b border-[#2b2d3e] md:grid-cols-[1fr_260px]">
          <div className="p-6 md:p-8">
            <div className="flex items-center gap-3">
              <VectantMark />
              <div>
                <div
                  className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#5dd6e4]"
                  style={{ fontFamily: monoFont }}
                >
                  Vectant ADE
                </div>
                <div className="mt-1 text-[12px] text-[#5a6178]">Terminal OAuth relay</div>
              </div>
            </div>
            <h1 className="mt-6 text-[26px] font-semibold leading-tight tracking-normal text-[#f4f5f8] md:text-[34px]">
              Terminal sign-in
            </h1>
            <p className="mt-4 max-w-[620px] text-[14px] leading-6 text-[#a8adc0]">
              Keep this tab open. Sign in with your browser, then copy the redirected localhost URL and send it back to the workspace runtime.
            </p>
          </div>
          <div
            className="hidden border-l border-[#2b2d3e] bg-[#0a0b11] p-4 text-[11px] uppercase leading-5 tracking-[0.08em] text-[#9ba2b8] md:block"
            style={{ fontFamily: monoFont }}
          >
            <div className="mb-3 text-[#5a6178]">Relay status</div>
            <dl className="grid gap-2">
              <div className="grid grid-cols-[86px_1fr] gap-2">
                <dt className="text-[#5a6178]">Listening</dt>
                <dd className="truncate text-[#f4f5f8]">{expectedHost}:{expectedPort}</dd>
              </div>
              <div className="grid grid-cols-[86px_1fr] gap-2">
                <dt className="text-[#5a6178]">Callback</dt>
                <dd className={callbackState === 'delivered' || callbackState === 'ready' ? 'text-[#9be8c4]' : 'text-[#9ba2b8]'}>
                  {callbackState}
                </dd>
              </div>
              <div className="grid grid-cols-[86px_1fr] gap-2">
                <dt className="text-[#5a6178]">Session</dt>
                <dd className={sessionState === 'not linked' ? 'text-[#9ba2b8]' : 'text-[#9be8c4]'}>
                  {sessionState}
                </dd>
              </div>
              <div className="grid grid-cols-[86px_1fr] gap-2">
                <dt className="text-[#5a6178]">Tokens</dt>
                <dd className="text-[#9ba2b8]">not logged</dd>
              </div>
            </dl>
          </div>
        </div>

        <motion.div variants={stepList} className="grid">
          <motion.article
            variants={fadeUp}
            className={`border-b border-[#2b2d3e] bg-[#0a0b11] p-4 transition-opacity md:p-5 ${
              isComplete ? 'opacity-55' : ''
            }`}
          >
            <div className="grid gap-4 md:grid-cols-[28px_1fr_auto] md:items-center">
              <StepNumber value="1" complete={opened || isComplete} />
              <div className="min-w-0">
                <h2
                  className="text-[12px] font-semibold uppercase tracking-[0.1em] text-[#f4f5f8]"
                  style={{ fontFamily: monoFont }}
                >
                  Open sign-in
                </h2>
                <p className="mt-1 text-[13px] leading-5 text-[#9ba2b8]">
                  Copy the redirected localhost URL after browser authorization.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <motion.button
                  type="button"
                  ref={openButtonRef}
                  whileTap={{ scale: 0.98 }}
                  onClick={openAuth}
                  disabled={relayStatus === 'loading' || isComplete}
                  className={`inline-flex h-9 items-center gap-2 border px-3 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                    opened || hasValidCallback || isComplete
                      ? 'border-[#2b2d3e] bg-[#101119] text-[#9ba2b8] hover:bg-[#131420]'
                      : 'border-[#3a3d55] bg-[#131420] text-[#f4f5f8] hover:border-[#5dd6e4] hover:text-[#5dd6e4]'
                  }`}
                  style={{ fontFamily: monoFont }}
                >
                  {relayStatus === 'loading' ? <Spinner /> : <MiniIcon name="external" className="h-4 w-4" />}
                  Open
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.98 }}
                  onClick={openWorkspaceBrowser}
                  disabled={browserStatus === 'loading' || isComplete}
                  className="inline-flex h-9 items-center gap-2 border border-[#2b2d3e] bg-[#101119] px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9ba2b8] transition-colors hover:border-[#3a3d55] hover:text-[#f4f5f8] disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ fontFamily: monoFont }}
                >
                  {browserStatus === 'loading' ? <Spinner /> : <MiniIcon name="browser" className="h-4 w-4" />}
                  Remote browser
                </motion.button>
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
                  className="md:col-start-2 mt-1 inline-flex h-8 w-fit items-center gap-2 border border-[#ff5757] bg-[#261215] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#ff8a8a]"
                  style={{ fontFamily: monoFont }}
                >
                  <MiniIcon name="retry" className="h-3.5 w-3.5" />
                  Retry relay session
                </motion.button>
              )}
            </div>
          </motion.article>

          <motion.article
            variants={fadeUp}
            className={`border-b border-[#2b2d3e] bg-[#0d0e15] p-4 md:p-6 ${
              isComplete ? 'bg-[#0a0b11]' : ''
            }`}
          >
            <div className="grid gap-4 md:grid-cols-[28px_1fr]">
              <StepNumber value="2" complete={isComplete} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-1">
                  <h2
                    className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[#f4f5f8]"
                    style={{ fontFamily: monoFont }}
                  >
                    Provide callback
                  </h2>
                  <p className="text-[13px] leading-5 text-[#9ba2b8]">
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
                      className="mt-5 border border-[#9be8c4] bg-[#10211c] p-3 text-[13px] leading-5 text-[#b8f0db]"
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
                      <div className="border border-[#3a3d55] bg-[#0a0b11]">
                        <div className="flex items-center justify-between gap-3 border-b border-[#2b2d3e] px-3 py-2">
                          <label
                            className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#9ba2b8]"
                            style={{ fontFamily: monoFont }}
                          >
                            <samp>INPUT://LOCALHOST_CALLBACK_URL</samp>
                          </label>
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.98 }}
                            onClick={pasteFromClipboard}
                            className="inline-flex h-7 items-center gap-1.5 border border-[#2b2d3e] bg-[#101119] px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#f4f5f8] transition-colors hover:border-[#5dd6e4] hover:text-[#5dd6e4]"
                            style={{ fontFamily: monoFont }}
                          >
                            <MiniIcon name="clipboard" className="h-3.5 w-3.5" />
                            Paste
                          </motion.button>
                        </div>
                        <textarea
                          ref={callbackInputRef}
                          value={callbackUrl}
                          onChange={(event) => setCallbackUrl(event.target.value)}
                          onPaste={handleCallbackPaste}
                          onKeyDown={handleCallbackKeyDown}
                          spellCheck={false}
                          disabled={isComplete}
                          className="min-h-[88px] w-full resize-y border-0 bg-[#06060a] p-3 text-[13px] leading-5 text-[#f4f5f8] outline-none placeholder:text-[#5a6178]"
                          style={{ fontFamily: monoFont }}
                          placeholder={callbackPlaceholder}
                        />
                      </div>

                      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p
                          className={`text-[11px] uppercase leading-5 tracking-[0.08em] ${
                            callbackValidation.ok
                              ? 'text-[#9be8c4]'
                              : callbackUrl.trim()
                                ? 'text-[#ff8a8a]'
                                : 'text-[#9ba2b8]'
                          }`}
                          style={{ fontFamily: monoFont }}
                        >
                          {callbackHelperText}
                        </p>
                        <motion.button
                          type="button"
                          aria-disabled={!canSubmit}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => complete(callbackUrl, { source: 'button' })}
                          disabled={!canSubmit}
                          className={`inline-flex h-10 items-center justify-center gap-2 border px-4 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                            hasValidCallback
                              ? 'border-[#f4f5f8] bg-[#f4f5f8] text-[#06060a] hover:bg-white'
                              : 'border-[#2b2d3e] bg-[#0a0b11] text-[#5a6178]'
                          }`}
                          style={{ fontFamily: monoFont }}
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
          className="border-b border-[#2b2d3e] bg-[#0a0b11] p-4"
        >
          <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
            <div className="flex gap-3">
              <div>
                <h3
                  className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#f4f5f8]"
                  style={{ fontFamily: monoFont }}
                >
                  Optional extension
                </h3>
                <p className="mt-1 text-[13px] leading-5 text-[#9ba2b8]">
                  Install once to auto-capture matching localhost callbacks. Until the store listing is approved, this downloads the beta package.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <motion.a
                whileTap={{ scale: 0.98 }}
                href={EXTENSION_INSTALL_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center border border-[#2b2d3e] bg-[#101119] px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#9ba2b8] transition-colors hover:border-[#3a3d55] hover:text-[#f4f5f8]"
                style={{ fontFamily: monoFont }}
              >
                Install extension
              </motion.a>
              <motion.button
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={armExtension}
                disabled={extensionBusy || relayStatus !== 'ready' || !extensionStatus.installed || isComplete}
                className="inline-flex h-9 items-center gap-2 border border-[#2b2d3e] bg-[#101119] px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#9ba2b8] transition-colors hover:border-[#3a3d55] hover:text-[#f4f5f8] disabled:cursor-not-allowed disabled:opacity-45"
                style={{ fontFamily: monoFont }}
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
              className={`m-4 border p-3 text-[13px] leading-5 ${
                status === 'success' || messageTone === 'success'
                  ? 'border-[#9be8c4] bg-[#10211c] text-[#b8f0db]'
                  : 'border-[#ff5757] bg-[#261215] text-[#ff8a8a]'
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span>{message}</span>
                {isComplete && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={returnToTerminal}
                    className="inline-flex h-8 shrink-0 items-center justify-center border border-[#f4f5f8] bg-[#f4f5f8] px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#06060a] hover:bg-white"
                    style={{ fontFamily: monoFont }}
                  >
                    Return to terminal
                  </motion.button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="p-4">
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#5a6178] transition-colors hover:text-[#f4f5f8]"
            style={{ fontFamily: monoFont }}
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
                  className="mt-4 grid gap-2 border border-[#2b2d3e] bg-[#0a0b11] p-3 text-[11px] uppercase leading-5 tracking-[0.08em] text-[#9ba2b8] md:grid-cols-3"
                  style={{ fontFamily: monoFont }}
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
