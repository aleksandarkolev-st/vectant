'use client';
import React, { useEffect, useRef, useState, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { WifiOff, RefreshCw, Terminal, Zap, EyeOff, ClipboardPaste, X, Palette, RotateCcw, Power, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/components/ThemeProvider';
import { useSessionPermissions } from '@/hooks/useCollabSession';
import { resolveCollabHttpUrl, resolveCollabWsUrl } from '@/lib/collab-url';
import { getWorkspaceRuntimeIdentity } from '@/services/runtimeScope';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';
import {
  isRuntimeLoopbackUrl,
  buildLoopbackCallbackBridgeUrl,
  findTerminalLoopbackAuthLinks,
  parseTerminalUrl,
  resolveTerminalLinkUrl,
  terminalLinkHasNestedLoopbackCallback,
  terminalLinkNeedsRuntimeResolution,
} from '@/lib/terminal-preview-links';
import {
  TERMINAL_COLOR_KEYS,
  getTerminalOverrides,
  setTerminalOverrides,
  subscribeTerminalOverrides,
  applyOverridesToTheme,
} from '@/lib/terminal-color-overrides';

// ─── Session-scoped paste auto-approve ───────────────────────────────────
// When the user ticks "Don't ask again this session" in the multi-line
// paste dialog, we set this module-level flag. It survives across all
// terminal panes (memo-frozen) but resets on a full page reload.
let sessionAutoApprovePaste = false;

/**
 * TerminalPane — Renders a single interactive terminal backed by a real PTY
 * on the collab-server via WebSocket.
 *
 * Props:
 *   terminalId  - Unique identifier for this terminal tab
 *   paneSide    - 'main' | 'split' (used to key the PTY session)
 *   workspaceSlug - Workspace slug for CWD binding
 *
 * Protocol:
 *   The collab-server exposes ws://<host>:1234/terminal?sessionId=X&workspace=slug
 *   - Binary frames  = raw PTY output (server→client) / raw keystrokes (client→server)
 *   - Text frames    = JSON control messages (resize, ready, exit, etc.)
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const TERMINAL_SERVER_URL = process.env.NEXT_PUBLIC_TERMINAL_URL 
  ? process.env.NEXT_PUBLIC_TERMINAL_URL
  : resolveCollabWsUrl();
const TERMINAL_HTTP_URL = resolveCollabHttpUrl();
const LOOPBACK_AUTH_BRIDGE_PATH = process.env.NEXT_PUBLIC_SYNTHI_LOOPBACK_AUTH_BRIDGE_PATH || '/auth/loopback';
const BLOCKED_TERMINAL_LINK_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:']);
const EXPLICIT_TERMINAL_LINK_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const TERMINAL_MOTION_EASE = [0.16, 1, 0.3, 1];

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000]; // Exponential backoff
const MAX_RECONNECT_ATTEMPTS = 4;
const terminalSessionIdCache = new Map();

async function fetchTerminalGatewayToken(workspaceSlug, { collabSessionId = '' } = {}) {
  const params = new URLSearchParams({
    workspaceSlug,
    scopes: 'collab:terminal',
  });
  if (collabSessionId) params.set('collabSessionId', collabSessionId);

  const res = await fetch(`/api/auth/token?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  const text = await res.text().catch(() => '');
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { error: text }; }
  if (!res.ok || !payload.token) {
    throw new Error(payload.error || `terminal_auth_failed_${res.status}`);
  }
  return payload;
}

function getTerminalStorage(storageName) {
  if (typeof window === 'undefined') return null;
  try {
    return window[storageName] || null;
  } catch (_) {
    return null;
  }
}

function safeTerminalSessionPart(value, fallback = 'term') {
  const normalized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return normalized || fallback;
}

function randomTerminalSessionSuffix() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

function getStableTerminalSessionId({
  workspaceSlug,
  terminalId,
  paneSide,
  shellType,
  runtimeScope,
  userId,
}) {
  const scopeKey = [
    workspaceSlug || 'workspace',
    runtimeScope || userId || 'runtime',
    terminalId || 'default',
    paneSide || 'main',
    shellType || 'default',
  ].join(':');

  if (terminalSessionIdCache.has(scopeKey)) {
    return terminalSessionIdCache.get(scopeKey);
  }

  const storageKey = `vectant-terminal-session:${scopeKey}`;
  const localStore = getTerminalStorage('localStorage');
  const sessionStore = getTerminalStorage('sessionStorage');
  try {
    const stored = localStore?.getItem(storageKey) || sessionStore?.getItem(storageKey);
    if (stored) {
      terminalSessionIdCache.set(scopeKey, stored);
      try { localStore?.setItem(storageKey, stored); } catch (_) {}
      try { sessionStore?.setItem(storageKey, stored); } catch (_) {}
      return stored;
    }
  } catch (_) {}

  const sessionId = [
    'term',
    safeTerminalSessionPart(workspaceSlug, 'workspace'),
    safeTerminalSessionPart(terminalId, 'default'),
    safeTerminalSessionPart(paneSide, 'main'),
    randomTerminalSessionSuffix(),
  ].join('-').slice(0, 96);

  terminalSessionIdCache.set(scopeKey, sessionId);
  try {
    localStore?.setItem(storageKey, sessionId);
  } catch (_) {}
  try {
    sessionStore?.setItem(storageKey, sessionId);
  } catch (_) {}
  return sessionId;
}

function resolveLoopbackAuthBridgeBaseUrl(origin) {
  try {
    const url = new URL(LOOPBACK_AUTH_BRIDGE_PATH, `${origin}/`);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return `${origin}/auth/loopback`;
  }
}

function resolveOpenableTerminalLink(rawUri) {
  const uri = typeof rawUri === 'string' ? rawUri.trim() : '';
  const parsed = parseTerminalUrl(uri);
  if (!parsed || BLOCKED_TERMINAL_LINK_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }
  if (!EXPLICIT_TERMINAL_LINK_SCHEME_RE.test(uri) && !isRuntimeLoopbackUrl(parsed)) {
    return null;
  }
  return parsed.href;
}

// ─── Terminal Theme (from ThemeProvider) ───────────────────────────────
// The `useTheme()` hook provides `terminalTheme` generated from the active
// theme JSON. The hardcoded SYNTHI_THEME is kept as a static fallback only for
// the initial render before ThemeProvider hydrates.
const SYNTHI_THEME_FALLBACK = {
  background: '#0a0b10',
  foreground: '#f0f2f5',
  cursor: '#327464',
  cursorAccent: '#0a0b10',
  selectionBackground: 'rgba(50, 116, 100, 0.3)',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: 'rgba(50, 116, 100, 0.15)',
  black: '#0a0b10',
  red: '#ff6b6b',
  green: '#a8e6cf',
  yellow: '#ffd93d',
  blue: '#88c0fc',
  magenta: '#c4b5fd',
  cyan: '#327464',
  white: '#f0f2f5',
  brightBlack: '#6b7089',
  brightRed: '#ff8a8a',
  brightGreen: '#b8f0db',
  brightYellow: '#ffe566',
  brightBlue: '#a8d4ff',
  brightMagenta: '#d8c9fe',
  brightCyan: '#3d8b78',
  brightWhite: '#ffffff',
};

/**
 * TerminalPane is an imperative xterm widget — it should NEVER re-render from
 * parent prop changes.  All communication happens through refs and WebSocket.
 * The freeze comparator always returns true (props are equal → skip re-render).
 */
const TerminalPane = memo(function TerminalPane({ terminalId = 'default', paneSide = 'main', workspaceSlug = '', workspaceName = '', onFsChange, fixedSessionId = null, shellType = null }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);   // { term, fitAddon, dispose() }
  const wsRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const inputDataDisposableRef = useRef(null);
  const inputBinaryDisposableRef = useRef(null);
  const inputBufferRef = useRef('');
  const oauthOutputBufferRef = useRef('');
  const oauthRelaySeenLinksRef = useRef(new Set());
  const openTerminalLinkRef = useRef(null);
  const initializedRef = useRef(false);
  // ─── Ctrl+Z undo stack ───────────────────────────────────────────────
  // Each entry is one undoable input segment: a single typed character or
  // the full content of a paste. Cleared on Enter (command submitted) and
  // on Ctrl+C (line cancelled). Backspace pops one char off the top.
  const undoStackRef = useRef([]);
  const { canTerminal, role } = useSessionPermissions();
  const { data: authSession } = useSession();
  const authSessionRef = useRef(authSession);
  authSessionRef.current = authSession;
  const canTerminalRef = useRef(canTerminal);
  canTerminalRef.current = canTerminal;
  const isGuest = role === 'guest';
  const sessionIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const mountedRef = useRef(true);
  const isResizingRef = useRef(false);

  // Live theme from ThemeProvider
  const { terminalTheme } = useTheme();

  // Selection-mode context menu (only opens when right-click lands on a
  // non-empty xterm selection — like the editor's SelectionContextMenu).
  // Captured in a ref so the imperative DOM-level contextmenu listener
  // inside init() can reach the latest openMenu.
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;

  const [state, setState] = useState('connecting'); // connecting | connected | error | closed
  const [shellInfo, setShellInfo] = useState('');
  // Multi-line paste confirmation: null when no pending paste, otherwise
  // { text, lineCount, charCount } describing the clipboard payload.
  const [pasteConfirm, setPasteConfirm] = useState(null);
  // Color customizer floating panel
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [stoppingRuntime, setStoppingRuntime] = useState(false);
  const [oauthRelayPrompt, setOauthRelayPrompt] = useState(null);
  const oauthRelayPromptRef = useRef(null);
  const oauthRelayLastCompleteRef = useRef('');
  // Live overrides — re-renders when user tweaks colors
  const [colorOverrides, setColorOverrides] = useState(() => getTerminalOverrides());

  // Stable session key: survives re-renders, unique per terminal tab + pane side
  const sessionKey = `${terminalId}-${paneSide}`;

  // ─── Subscribe to override changes from other panes / the customizer ──
  useEffect(() => {
    const unsubscribe = subscribeTerminalOverrides((next) => {
      setColorOverrides(next || {});
    });
    return unsubscribe;
  }, []);

  // ─── Live terminal theme sync (theme + user overrides) ────────────────
  useEffect(() => {
    if (terminalRef.current?.term && terminalTheme) {
      const term = terminalRef.current.term;
      term.options.theme = applyOverridesToTheme(terminalTheme, colorOverrides);
      // Force an immediate full repaint so colors apply without delay
      try { term.refresh(0, term.rows - 1); } catch (_) {}
    }
  }, [terminalTheme, colorOverrides]);

  useEffect(() => {
    oauthRelayPromptRef.current = oauthRelayPrompt;
  }, [oauthRelayPrompt]);

  // OAuth relay helpers live in a separate tab. When a callback is delivered
  // successfully, force a terminal repaint/focus so waiting TUIs are visibly
  // refreshed for the user.
  useEffect(() => {
    const promptMatchesRelayComplete = (prompt, payload) => {
      if (!prompt) return false;
      if (!payload?.runtimeScope) return true;
      try {
        const promptUrl = new URL(prompt.bridgeUrl);
        const promptRuntimeScope = promptUrl.searchParams.get('runtimeScope');
        return !promptRuntimeScope || promptRuntimeScope === payload.runtimeScope;
      } catch (_) {
        return true;
      }
    };

    const handleRelayComplete = (payload) => {
      if (!payload || payload.type !== 'synthi.oauthRelay.complete') return;
      if (payload.workspaceSlug && payload.workspaceSlug !== workspaceSlug) return;
      const activePrompt = oauthRelayPromptRef.current;
      if (!promptMatchesRelayComplete(activePrompt, payload)) return;

      const completeKey = [payload.runtimeScope || '', payload.terminalId || '', payload.at || '', payload.status || ''].join(':');
      if (completeKey && oauthRelayLastCompleteRef.current === completeKey) return;
      oauthRelayLastCompleteRef.current = completeKey;

      const instance = terminalRef.current;
      try { instance?.fitAddon?.fit(); } catch (_) {}
      try { instance?.term?.refresh(0, instance.term.rows - 1); } catch (_) {}
      try { instance?.term?.focus(); } catch (_) {}
      setOauthRelayPrompt(null);
      oauthRelayPromptRef.current = null;
      toast.success('Terminal OAuth callback delivered');
    };
    const onWindowMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      handleRelayComplete(event.data);
    };
    const onStorage = (event) => {
      if (event.key !== 'synthi.oauthRelay.lastComplete' || !event.newValue) return;
      try {
        handleRelayComplete(JSON.parse(event.newValue));
      } catch (_) {}
    };

    let channel = null;
    try {
      channel = new BroadcastChannel('synthi-oauth-relay');
      channel.onmessage = (event) => handleRelayComplete(event.data);
    } catch (_) {}

    window.addEventListener('message', onWindowMessage);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
      window.removeEventListener('storage', onStorage);
      try { channel?.close(); } catch (_) {}
    };
  }, [terminalId, workspaceSlug]);

  const dismissOauthRelayPrompt = useCallback(() => {
    setOauthRelayPrompt(null);
    try { terminalRef.current?.term?.focus(); } catch (_) {}
  }, []);

  const openOauthRelayPrompt = useCallback((event) => {
    event?.preventDefault?.();
    const prompt = oauthRelayPromptRef.current;
    if (!prompt?.bridgeUrl) return;
    setOauthRelayPrompt((current) => (
      current?.id === prompt.id ? { ...current, opened: true } : current
    ));
    try {
      window.open(prompt.bridgeUrl, '_blank', 'noopener,noreferrer');
    } catch (_) {}
  }, []);

  // ─── Cleanup helper ───────────────────────────────────────────────────
  const disposeInputHandlers = useCallback(() => {
    if (inputDataDisposableRef.current) {
      try { inputDataDisposableRef.current.dispose(); } catch (_) {}
      inputDataDisposableRef.current = null;
    }
    if (inputBinaryDisposableRef.current) {
      try { inputBinaryDisposableRef.current.dispose(); } catch (_) {}
      inputBinaryDisposableRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(1000); } catch (_) {}
      wsRef.current = null;
    }
    disposeInputHandlers();
    const terminalInstance = terminalRef.current;
    terminalRef.current = null;
    if (terminalInstance?.dispose) {
      try { terminalInstance.dispose(); } catch (_) {}
    } else if (terminalInstance?.term) {
      try { terminalInstance.term.dispose(); } catch (_) {}
    }
    sessionIdRef.current = null;
    currentSessionIdRef.current = null;
    openTerminalLinkRef.current = null;
  }, [disposeInputHandlers]);

  // ─── Send resize to server ───────────────────────────────────────────
  const sendResize = useCallback((cols, rows) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  // ─── Main effect: initialise xterm + WebSocket ────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    if (isGuest && !canTerminal) {
      cleanup();
      setState('closed');
      return () => { disposed = true; };
    }
    setState('connecting');

    const runtimeLinkContext = () => {
      const termUserId = authSessionRef.current?.user?.id || authSessionRef.current?.user?.email || '';
      const runtimeIdentity = getWorkspaceRuntimeIdentity(workspaceSlug, { userId: termUserId });
      return {
        workspaceSlug,
        terminalId,
        ...runtimeIdentity,
        bridgeBaseUrl: resolveLoopbackAuthBridgeBaseUrl(window.location.origin),
      };
    };

    const surfaceOauthRelayLinks = (outputText) => {
      if (!outputText) return;
      const nextBuffer = `${oauthOutputBufferRef.current}${outputText}`;
      oauthOutputBufferRef.current = nextBuffer.slice(-12000);

      const linkContext = runtimeLinkContext();
      const links = findTerminalLoopbackAuthLinks(oauthOutputBufferRef.current, {
        runtimeScope: linkContext.runtimeScope,
        bridgeBaseUrl: linkContext.bridgeBaseUrl,
        loopbackContext: linkContext,
        limit: 2,
      });

      const nextLink = links.find((link) => !oauthRelaySeenLinksRef.current.has(link.bridgeUrl));
      if (!nextLink) return;

      oauthRelaySeenLinksRef.current.add(nextLink.bridgeUrl);
      setOauthRelayPrompt({
        id: nextLink.bridgeUrl,
        bridgeUrl: nextLink.bridgeUrl,
        originalUrl: nextLink.originalUrl,
        opened: false,
        detectedAt: Date.now(),
      });
    };

    const init = async () => {
      // Dynamic import to avoid SSR issues
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('xterm'),
        import('xterm-addon-fit'),
        import('xterm-addon-web-links'),
      ]);

      // WebGL can race xterm's renderer teardown during pane resizes, which
      // leaves its internal renderer undefined. Keep the reliable canvas
      // renderer as the default; WebGL remains available for deliberate
      // opt-in deployments that have validated it on their target browsers.
      let WebglAddon = null;
      if (process.env.NEXT_PUBLIC_SYNTHI_TERMINAL_WEBGL === '1') {
        try {
          const webglModule = await import('xterm-addon-webgl');
          WebglAddon = webglModule.WebglAddon;
        } catch (_) {
          console.log('[Terminal] WebGL addon not available, using canvas renderer');
        }
      }

      if (disposed || !containerRef.current) return;

      const openLocalBrowserUrl = (uri, popup = null) => {
        if (popup) {
          try { popup.opener = null; } catch {}
          popup.location.href = uri;
          return;
        }
        window.open(uri, '_blank', 'noopener,noreferrer');
      };

      const openManualLoopbackFallback = async (uri, linkContext, popup = null) => {
        const fallbackUrl = await resolveTerminalLinkUrl(uri, linkContext.runtimeScope, {
          terminalHttpUrl: TERMINAL_HTTP_URL,
          windowOrigin: window.location.origin,
          loopbackCallbackBridgeUrl: linkContext.bridgeBaseUrl,
          loopbackContext: linkContext,
        });
        openLocalBrowserUrl(fallbackUrl || uri, popup);
      };

      const openTerminalLink = (uri) => {
        try {
          const localBrowserHref = resolveOpenableTerminalLink(uri);
          if (!localBrowserHref) {
            toast.error('Blocked unsafe terminal link');
            return;
          }

          const linkContext = runtimeLinkContext();
          const parsedLink = parseTerminalUrl(uri);
          const isHttpLink = parsedLink?.protocol === 'http:' || parsedLink?.protocol === 'https:';
          if (isHttpLink && terminalLinkHasNestedLoopbackCallback(uri)) {
            const bridgeUrl = buildLoopbackCallbackBridgeUrl(
              uri,
              linkContext.runtimeScope,
              linkContext.bridgeBaseUrl,
              linkContext,
            );
            if (bridgeUrl) {
              oauthRelaySeenLinksRef.current.add(bridgeUrl);
              setOauthRelayPrompt({
                id: bridgeUrl,
                bridgeUrl,
                originalUrl: uri,
                opened: true,
                detectedAt: Date.now(),
              });
              openLocalBrowserUrl(bridgeUrl);
              return;
            }
            const popup = window.open('about:blank', '_blank');
            openManualLoopbackFallback(uri, linkContext, popup)
              .then(() => {
                toast.success('Opened terminal sign-in helper');
              })
              .catch((err) => {
                console.warn('[Terminal] Sign-in helper open failed:', err);
                toast.warning('Opening the original sign-in link');
                try { openLocalBrowserUrl(localBrowserHref, popup); } catch {}
              });
            return;
          }

          const needsRuntimeResolution = terminalLinkNeedsRuntimeResolution(uri);
          if (!needsRuntimeResolution) {
            openLocalBrowserUrl(localBrowserHref);
            return;
          }

          const popup = window.open('about:blank', '_blank');
          resolveTerminalLinkUrl(uri, linkContext.runtimeScope, {
            terminalHttpUrl: TERMINAL_HTTP_URL,
            windowOrigin: window.location.origin,
            loopbackCallbackBridgeUrl: linkContext.bridgeBaseUrl,
            loopbackContext: linkContext,
          }).then((previewUrl) => {
            openLocalBrowserUrl(previewUrl || localBrowserHref, popup);
          }).catch(() => {
            if (isHttpLink && terminalLinkHasNestedLoopbackCallback(uri)) {
              openManualLoopbackFallback(uri, linkContext, popup).catch(() => {
                try { openLocalBrowserUrl(localBrowserHref, popup); } catch {}
              });
              return;
            }
            openLocalBrowserUrl(localBrowserHref, popup);
          });
        } catch (_) {
          const localBrowserHref = resolveOpenableTerminalLink(uri);
          if (localBrowserHref) {
            try { openLocalBrowserUrl(localBrowserHref); } catch {}
          }
        }
      };
      openTerminalLinkRef.current = openTerminalLink;

      // ── Create xterm instance ───────────────────────────────────────
      const initialTheme = applyOverridesToTheme(
        terminalTheme || SYNTHI_THEME_FALLBACK,
        getTerminalOverrides(),
      );
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: initialTheme,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        allowTransparency: false,
        convertEol: true,   // Required on Windows — ConPTY can emit bare \n
        // Handles OSC 8 hyperlinks emitted by CLIs. Without this, xterm shows
        // its default confirm dialog and opens loopback OAuth links locally.
        linkHandler: {
          allowNonHttpProtocols: true,
          activate: (_event, uri) => openTerminalLink(uri),
        },
      });

      const fitAddon = new FitAddon();
      const linksAddon = new WebLinksAddon((_event, uri) => openTerminalLink(uri));
      term.loadAddon(fitAddon);
      term.loadAddon(linksAddon);
      term.open(containerRef.current);

      // PERF: Activate GPU-accelerated WebGL renderer.
      // This offloads heavy I/O log streaming (thousands of rows/sec) from
      // the CPU canvas to the user's GPU, dramatically reducing main-thread
      // blocking during terminal-heavy operations (build output, streaming logs).
      let webglAddon = null;
      if (WebglAddon) {
        try {
          webglAddon = new WebglAddon();
          // If the WebGL context is lost (GPU driver reset, tab background),
          // gracefully fall back to the canvas renderer.
          webglAddon.onContextLoss(() => {
            console.warn('[Terminal] WebGL context lost, falling back to canvas');
            try { webglAddon.dispose(); } catch (_) {}
          });
          term.loadAddon(webglAddon);
          console.log('[Terminal] WebGL renderer activated — GPU-accelerated');
        } catch (err) {
          console.warn('[Terminal] WebGL renderer failed to activate, using canvas:', err?.message);
          webglAddon = null;
        }
      }

      // Initial fit
      try { fitAddon.fit(); } catch (_) {}

      terminalRef.current = { term, fitAddon, webglAddon };

      // ── Right-click → paste from clipboard ────────────────────────
      // Mirrors the VS Code / Windows Terminal convention: a single
      // right-click drops the OS clipboard text into the PTY. We route
      // through term.paste() so bracketed-paste mode (zsh, fish, etc.)
      // works correctly.
      //
      // Safety: a multi-line clipboard payload typically executes every
      // line the moment it lands in the PTY (newline = Enter). We pop a
      // confirmation modal in that case so the user sees what is about
      // to run. A single trailing newline is fine — that's just `cmd\n`,
      // which is what the user means when they copy a one-liner from a
      // README.
      // Wipe xterm selection across all three timings: synchronously now,
      // on the next animation frame (after xterm finishes its own mouse
      // selection bookkeeping from the right-click), and on a 50ms tail
      // (after the PTY echoes the pasted chars). Without this, a prior
      // double-click selection would be left highlighted on top of the
      // pasted text.
      const clearSelectionAggressive = () => {
        try { term.clearSelection(); } catch (_) {}
        requestAnimationFrame(() => {
          try { term.clearSelection(); } catch (_) {}
        });
        setTimeout(() => {
          try { term.clearSelection(); } catch (_) {}
        }, 50);
      };

      // Track latest selection text. xterm can drop its selection on
      // mousedown before our contextmenu handler runs, so we mirror the
      // selection here and also snapshot it in a capture-phase mousedown
      // handler before xterm sees the right-click. The contextmenu logic
      // reads from this ref instead of calling term.getSelection() at
      // event time.
      const lastSelectionRef = { current: '' };
      try {
        term.onSelectionChange(() => {
          try {
            const s = term.getSelection() || '';
            lastSelectionRef.current = s;
          } catch {}
        });
      } catch {}

      const pasteFromClipboard = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;
          const hasEmbeddedNewline = text.replace(/\r?\n$/, '').includes('\n');
          if (hasEmbeddedNewline && !sessionAutoApprovePaste) {
            setPasteConfirm({ text, lineCount: text.split(/\r?\n/).length, charCount: text.length });
          } else {
            clearSelectionAggressive();
            term.paste(text);
            clearSelectionAggressive();
          }
        } catch {
          // Clipboard read can fail (permission denied, insecure context,
          // user gesture lost). Stay silent — fall back to Ctrl/Cmd+V.
        }
      };

      const handleContextMenu = (e) => {
        e.preventDefault();
        if (!canTerminalRef.current && canTerminalRef.current !== undefined) {
          return; // View-only guest
        }

        // Did the user right-click on selected text? If yes → menu.
        // If no (no selection) → keep existing right-click-to-paste.
        let selectedText = '';
        try { selectedText = term.getSelection?.() || ''; } catch {}
        if (!selectedText) selectedText = lastSelectionRef.current || '';

        if (!selectedText) {
          pasteFromClipboard();
          return;
        }

        e.stopPropagation();
        openMenuRef.current(e, [
          {
            id: 'copy',
            label: 'Copy',
            shortcut: 'Ctrl+Shift+C',
            action: () => {
              navigator.clipboard.writeText(selectedText).then(
                () => toast.success('Copied'),
                () => toast.error('Copy failed'),
              );
              clearSelectionAggressive();
            },
          },
          {
            id: 'paste',
            label: 'Paste',
            shortcut: 'Ctrl+Shift+V',
            dividerAfter: true,
            action: pasteFromClipboard,
          },
          {
            id: 'google',
            label: 'Search on Google',
            action: () => {
              try { window.open(`https://www.google.com/search?q=${encodeURIComponent(selectedText)}`, '_blank', 'noopener,noreferrer'); } catch {}
            },
          },
          {
            id: 'ask-ai',
            label: 'Ask AI',
            action: () => {
              try {
                window.dispatchEvent(new CustomEvent('synthi:ask-ai', {
                  detail: { text: selectedText, language: 'shell', filePath: '', startLine: null, endLine: null },
                }));
              } catch {}
            },
          },
        ]);
      };

      // Snapshot selection on right-mousedown in CAPTURE phase, before
      // xterm's own mousedown handler can possibly clear it.
      const handleRightMouseDownCapture = (e) => {
        if (e.button !== 2) return;
        try {
          const s = term.getSelection?.() || '';
          if (s) lastSelectionRef.current = s;
        } catch {}
      };
      containerRef.current.addEventListener('mousedown', handleRightMouseDownCapture, true);
      containerRef.current.addEventListener('contextmenu', handleContextMenu, true);

      // ── Connect WebSocket ─────────────────────────────────────────
      connectWS(term, fitAddon);

      // ── Resize handling ───────────────────────────────────────────
      let resizeRaf = null;
      const doFit = () => {
        if (
          disposed ||
          terminalRef.current?.term !== term ||
          terminalRef.current?.fitAddon !== fitAddon
        ) {
          return;
        }
        isResizingRef.current = true;
        try {
          fitAddon.fit();
          sendResize(term.cols, term.rows);
        } catch (_) {} finally {
          isResizingRef.current = false;
        }
      };

      const scheduleResize = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(doFit);
      };

      const resizeObserver = new ResizeObserver(scheduleResize);
      if (containerRef.current) resizeObserver.observe(containerRef.current);
      window.addEventListener('resize', scheduleResize);

      // Capture for teardown: containerRef may be nulled before dispose runs.
      const containerEl = containerRef.current;

      // Store teardown
      terminalRef.current.dispose = () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', scheduleResize);
        if (containerEl) {
          containerEl.removeEventListener('contextmenu', handleContextMenu, true);
          containerEl.removeEventListener('mousedown', handleRightMouseDownCapture, true);
        }
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        if (webglAddon) try { webglAddon.dispose(); } catch (_) {}
        linksAddon.dispose();
        fitAddon.dispose();
        term.dispose();
      };
    };

    // ── WebSocket connection logic (also used for reconnect) ──────────
    // Push a single input segment onto the undo stack, or mutate it in
    // response to line-editing keys (Enter, Backspace, Ctrl+C). Called
    // from term.onData before the data is forwarded to the PTY.
    function trackForUndo(data) {
      const stack = undoStackRef.current;

      // Enter — command submitted; the prior input is gone for good.
      if (data === '\r' || data === '\n' || data === '\r\n') {
        stack.length = 0;
        return;
      }

      // Backspace / Delete — drop one char from the top segment so our
      // stack stays in sync with what's actually on the line.
      if (data === '\x7f' || data === '\b') {
        if (stack.length === 0) return;
        const top = stack[stack.length - 1];
        if ([...top].length <= 1) {
          stack.pop();
        } else {
          const cps = [...top];
          cps.pop();
          stack[stack.length - 1] = cps.join('');
        }
        return;
      }

      // Bracketed paste: \x1b[200~...\x1b[201~ — store the inner text
      // so the segment length matches the number of cells rendered.
      if (data.length > 12 && data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
        const content = data.slice(6, -6);
        if (content) stack.push(content);
        return;
      }

      // Other escape sequences (arrows, function keys, etc.) — ignore.
      if (data.charCodeAt(0) === 0x1b) return;

      // Single C0 control char other than tab — ignore, but reset the
      // stack on Ctrl+C since the shell discards the current line.
      if (data.length === 1) {
        const code = data.charCodeAt(0);
        if (code < 0x20 && code !== 0x09) {
          if (code === 0x03) stack.length = 0;
          return;
        }
      }

      // Printable text (typed char or unbracketed paste) → one segment.
      stack.push(data);
    }

    async function connectWS(term, fitAddon) {
      if (disposed) return;

      // Reconnect to the same PTY session. A new PTY behind an old xterm
      // buffer makes typed text appear duplicated or inserted in odd places.
      const { cols, rows } = term;
      const termUserId = authSessionRef.current?.user?.id || authSessionRef.current?.user?.email || '';
      const runtimeIdentity = getWorkspaceRuntimeIdentity(workspaceSlug, { userId: termUserId });
      const sid = fixedSessionId || currentSessionIdRef.current || getStableTerminalSessionId({
        workspaceSlug,
        terminalId,
        paneSide,
        shellType,
        runtimeScope: runtimeIdentity.runtimeScope,
        userId: termUserId,
      });
      currentSessionIdRef.current = sid;
      sessionIdRef.current = sid;
      const params = new URLSearchParams({
        sessionId: sid,
        workspace: workspaceSlug,
        userId: termUserId,
        cols: String(cols),
        rows: String(rows),
      });
      if (runtimeIdentity.runtimeScope) {
        params.set('runtimeScope', runtimeIdentity.runtimeScope);
      }
      if (runtimeIdentity.runtimeKind) {
        params.set('runtimeKind', runtimeIdentity.runtimeKind);
      }
      if (runtimeIdentity.filesystemUserId) {
        params.set('filesystemUserId', runtimeIdentity.filesystemUserId);
      }
      if (runtimeIdentity.collabSessionId) {
        params.set('collabSessionId', runtimeIdentity.collabSessionId);
      }
      // Friendly project name for the PTY prompt (~/<name> $). When the
      // workspace page hasn't loaded the name yet, the backend falls back
      // to the slug, so omitting this is safe.
      if (workspaceName) {
        params.set('name', workspaceName);
      }
      // Include shell type if specified (e.g. 'bash', 'cmd', 'powershell')
      if (shellType) {
        params.set('shell', shellType);
      }

      let gateway;
      try {
        gateway = await fetchTerminalGatewayToken(workspaceSlug, {
          collabSessionId: runtimeIdentity.collabSessionId || '',
        });
      } catch (_) {
        if (mountedRef.current) {
          setState('error');
        }
        scheduleReconnect(term, fitAddon);
        return;
      }
      if (disposed) return;
      params.set('token', gateway.token);
      if (gateway.runtimeScope) params.set('runtimeScope', gateway.runtimeScope);
      if (gateway.filesystemUserId) params.set('filesystemUserId', gateway.filesystemUserId);

      const wsUrl = `${TERMINAL_SERVER_URL}/terminal?${params}`;
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        if (mountedRef.current) {
          setState('error');
        }
        scheduleReconnect(term, fitAddon);
        return;
      }

      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Send user input to backend and forward to WebRTC path.
      // Also provide a local-echo fallback when no backend is connected so
      // the user sees their keystrokes while offline/disconnected.
      disposeInputHandlers();
      inputDataDisposableRef.current = term.onData((data) => {
        if (isResizingRef.current) return;

        // ── Session permission gate ──────────────────────────────────
        // When the user is a Guest without terminal permission, block
        // all keyboard input. The terminal remains view-only.
        if (!canTerminalRef.current && canTerminalRef.current !== undefined) {
          // Still in a session context and terminal is denied
          // Check if we're actually in a guest role (not solo/idle)
          // canTerminalRef will be true for solo users (idle role)
          return;
        }

        // ── Ctrl+Z → local undo (does NOT send SIGTSTP) ──────────────
        // Pop the last input segment off the undo stack and erase it
        // from the shell's line buffer by emitting an equivalent number
        // of backspaces. A typed char pops one segment of length 1 (one
        // backspace); a paste pops the entire paste as one segment.
        if (data === '\x1a') {
          const stack = undoStackRef.current;
          const segment = stack.pop();
          if (!segment) return;
          // Code-point count tracks rendered cells more closely than
          // UTF-16 code units (matters for emoji / surrogate pairs).
          const eraseCount = [...segment].length;
          const wsLocal = wsRef.current;
          if (wsLocal && wsLocal.readyState === WebSocket.OPEN && eraseCount > 0) {
            wsLocal.send(new TextEncoder().encode('\x7f'.repeat(eraseCount)));
          }
          return;
        }

        // ── Track input for undo ─────────────────────────────────────
        trackForUndo(data);

        const wsLocal = wsRef.current;
        if (wsLocal && wsLocal.readyState === WebSocket.OPEN) {
          wsLocal.send(new TextEncoder().encode(data));
        }
      });

      ws.onopen = () => {
        if (disposed) return;
        reconnectCountRef.current = 0;
        setState('connected');
      };

      ws.onmessage = (event) => {
        if (disposed) return;

        // Binary frame → raw PTY output
        if (event.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(new Uint8Array(event.data));
          surfaceOauthRelayLinks(text);
          term.write(text);
          return;
        }

        // Text frame → JSON control message
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case 'ready':
                setShellInfo(`${msg.shell} (pid ${msg.pid})`);
                // Sync actual terminal size now that the PTY is alive
                try {
                  fitAddon.fit();
                  sendResize(term.cols, term.rows);
                } catch (_) {}
                break;
              case 'exit':
                term.write(`\r\n\x1b[90m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
                setState('closed');
                break;
              case 'replay-done':
                // AI terminal: scroll to top so the user sees the command + full output
                if (fixedSessionId) {
                  requestAnimationFrame(() => {
                    try { term.scrollToTop(); } catch (_) {}
                  });
                }
                break;
              case 'error':
                term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
                break;
              case 'pong':
                // Keepalive acknowledged
                break;
              case 'fs-change':
                // Filesystem changed (terminal created/modified/deleted files)
                if (onFsChange) onFsChange(msg);
                break;
              default:
                break;
            }
          } catch (_) {
            // Not JSON — treat as plain text output
            surfaceOauthRelayLinks(event.data);
            term.write(event.data);
          }
        }
      };

      ws.onerror = () => {
        if (disposed) return;
        setState('error');
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        wsRef.current = null;
        // Only reconnect on abnormal closure
        if (ev.code !== 1000) {
          setState('error');
          scheduleReconnect(term, fitAddon);
        } else {
          setState('closed');
        }
      };

      // Also forward binary (paste, etc.)
      inputBinaryDisposableRef.current = term.onBinary((data) => {
        const wsLocal = wsRef.current;
        if (wsLocal && wsLocal.readyState === WebSocket.OPEN) {
          const buffer = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) buffer[i] = data.charCodeAt(i);
          wsLocal.send(buffer);
        }
      });
    }

    function scheduleReconnect(term, fitAddon) {
      if (disposed) return;
      const attempt = reconnectCountRef.current;
      if (attempt >= MAX_RECONNECT_ATTEMPTS) return;

      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      reconnectCountRef.current = attempt + 1;

      reconnectTimerRef.current = setTimeout(() => {
        if (!disposed && mountedRef.current) {
          setState('connecting');
          connectWS(term, fitAddon);
        }
      }, delay);
    }

    init();

    return () => {
      disposed = true;
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try { wsRef.current.close(1000); } catch (_) {}
        wsRef.current = null;
      }
      disposeInputHandlers();
      const terminalInstance = terminalRef.current;
      terminalRef.current = null;
      if (terminalInstance?.dispose) {
        try { terminalInstance.dispose(); } catch (_) {}
      }
    };
  }, [sessionKey, terminalId, workspaceSlug, fixedSessionId, shellType, isGuest, canTerminal, cleanup, disposeInputHandlers]); // Re-connect if terminal tab, workspace, shell type, or terminal permission changes

  // ─── Reconnect button handler ─────────────────────────────────────────
  const handleReconnect = useCallback(() => {
    // Full teardown and re-init by forcing a re-mount
    cleanup();
    reconnectCountRef.current = 0;
    setState('connecting');
    // The useEffect will re-run because cleanup clears terminalRef
    // Force re-mount by key change isn't needed — we just need to re-run init
    // So we trigger a micro state change
    window.location.reload();
  }, [cleanup]);

  const handleStopRuntime = useCallback(async () => {
    if (stoppingRuntime) return;
    const termUserId = authSessionRef.current?.user?.id || authSessionRef.current?.user?.email || '';
    const runtimeIdentity = getWorkspaceRuntimeIdentity(workspaceSlug, { userId: termUserId });
    const runtimeScope = runtimeIdentity.runtimeScope;
    if (!runtimeScope) {
      toast.error('Runtime scope unavailable');
      return;
    }

    setStoppingRuntime(true);
    try {
      const response = await fetch(`${TERMINAL_HTTP_URL}/api/spawner/release`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-runtime-scope': runtimeScope,
        },
        body: JSON.stringify({
          session_id: runtimeScope,
          workspaceSlug,
          reason: 'explicit_release',
        }),
      });
      if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(message || `Runtime stop failed (${response.status})`);
      }

      cleanup();
      reconnectCountRef.current = 0;
      setState('closed');
      toast.success('Runtime stopped');
    } catch (err) {
      console.error('[Terminal] Failed to stop runtime:', err);
      toast.error(err?.message || 'Failed to stop runtime');
    } finally {
      setStoppingRuntime(false);
    }
  }, [cleanup, stoppingRuntime, workspaceSlug]);

  const handleRepairRuntime = useCallback(async () => {
    if (stoppingRuntime) return;
    const termUserId = authSessionRef.current?.user?.id || authSessionRef.current?.user?.email || '';

    setStoppingRuntime(true);
    try {
      const response = await fetch(`${TERMINAL_HTTP_URL}/program-runtime/${encodeURIComponent(workspaceSlug)}/ensure-runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: termUserId }),
      });
      if (!response.ok) {
        let message = '';
        try {
          const payload = await response.json();
          message = payload?.error || '';
        } catch (_) {
          message = await response.text().catch(() => '');
        }
        throw new Error(message || `Runtime repair failed (${response.status})`);
      }

      cleanup();
      reconnectCountRef.current = 0;
      setState('connecting');
      toast.success('Runtime repair started. Opening a fresh terminal.');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (err) {
      console.error('[Terminal] Runtime repair failed:', err);
      setState('error');
      toast.error('Runtime repair could not start. Rebuild the Docker runtime, then try again.');
    } finally {
      setStoppingRuntime(false);
    }
  }, [cleanup, stoppingRuntime, workspaceSlug]);

  // ─── Multi-line paste confirmation actions ────────────────────────────
  const confirmPaste = useCallback((opts) => {
    const pending = pasteConfirm;
    setPasteConfirm(null);
    if (opts?.autoApprove) sessionAutoApprovePaste = true;
    if (!pending) return;
    const term = terminalRef.current?.term;
    if (!term) return;
    // Clear before + after + after-echo so no prior selection leaks through.
    const clear = () => { try { term.clearSelection(); } catch (_) {} };
    clear();
    try { term.paste(pending.text); } catch (_) {}
    clear();
    requestAnimationFrame(clear);
    setTimeout(clear, 50);
    try { term.focus(); } catch (_) {}
  }, [pasteConfirm]);

  const cancelPaste = useCallback(() => {
    setPasteConfirm(null);
    try { terminalRef.current?.term?.focus(); } catch (_) {}
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  if (isGuest && !canTerminal) {
    return (
      <div className="terminal-pane-shell h-full w-full overflow-hidden relative" style={{ background: 'var(--bg-app)' }}>
        <div className="h-full w-full flex items-center justify-center px-6">
          <div
            className="max-w-sm rounded-lg border px-4 py-3 text-center"
            style={{
              background: 'color-mix(in srgb, var(--accent-warning) 7%, var(--bg-elevated))',
              borderColor: 'color-mix(in srgb, var(--accent-warning) 28%, var(--border-medium))',
              color: 'var(--text-secondary)',
            }}
          >
            <EyeOff className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--accent-warning)' }} />
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              Terminal access is off
            </div>
            <div className="text-[11px] leading-relaxed">
              Ask the host to grant terminal permission for this session.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-pane-shell h-full w-full overflow-hidden relative" style={{ background: 'var(--bg-app)' }}>
      <div ref={containerRef} className="h-full w-full" />

      <TerminalUtilityRail
        state={state}
        stoppingRuntime={stoppingRuntime}
        canStop={!fixedSessionId}
        onStopRuntime={handleStopRuntime}
        onOpenColors={() => setColorPickerOpen(true)}
      />

      {pasteConfirm && (
        <MultiLinePasteDialog
          text={pasteConfirm.text}
          lineCount={pasteConfirm.lineCount}
          charCount={pasteConfirm.charCount}
          onConfirm={confirmPaste}
          onCancel={cancelPaste}
        />
      )}

      <TerminalOAuthPrompt
        prompt={oauthRelayPrompt}
        onOpen={openOauthRelayPrompt}
        onDismiss={dismissOauthRelayPrompt}
      />

      {colorPickerOpen && (
        <TerminalColorPanel
          baseTheme={terminalTheme || SYNTHI_THEME_FALLBACK}
          overrides={colorOverrides}
          onClose={() => setColorPickerOpen(false)}
        />
      )}

      {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}

      {/* Connection status — viewport-centred floating panel (portal to body) */}
      <AnimatePresence>
        {(state === 'error' || state === 'closed') && (
          <ConnectionStatusPanel
            key={`terminal-status-${state}`}
            state={state}
            repairing={stoppingRuntime}
            onReconnect={handleReconnect}
            onRepairRuntime={handleRepairRuntime}
          />
        )}
      </AnimatePresence>

      <TerminalActivityHint state={state} stoppingRuntime={stoppingRuntime} />
    </div>
  );
}, /* freeze — never re-render from parent */ () => true);

function terminalStatusMeta(state, stoppingRuntime) {
  if (stoppingRuntime) {
    return { label: 'Stopping', tone: 'warning', color: 'var(--accent-warning, #d89b2b)' };
  }
  if (state === 'connected') {
    return { label: 'Live', tone: 'success', color: 'var(--accent-success, #3d8b78)' };
  }
  if (state === 'connecting') {
    return { label: 'Connecting', tone: 'info', color: 'var(--accent-primary, #6c6885)' };
  }
  if (state === 'closed') {
    return { label: 'Closed', tone: 'muted', color: 'var(--text-muted, #6b7089)' };
  }
  return { label: 'Issue', tone: 'warning', color: 'var(--accent-warning, #d89b2b)' };
}

function TerminalUtilityButton({ title, onClick, disabled = false, children, tone = 'neutral' }) {
  const toneColor = tone === 'danger'
    ? 'var(--accent-error, #d96c6c)'
    : tone === 'active'
      ? 'var(--text-primary, #f4f5f8)'
      : 'var(--text-secondary, #a1a1aa)';

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md border transition-colors hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderColor: 'var(--border-subtle, #2a2b38)',
        color: toneColor,
        background: 'var(--bg-app, #0a0b10)',
      }}
    >
      {children}
    </motion.button>
  );
}

function TerminalUtilityRail({ state, stoppingRuntime, canStop, onStopRuntime, onOpenColors }) {
  const status = terminalStatusMeta(state, stoppingRuntime);

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: TERMINAL_MOTION_EASE }}
      className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-lg border px-1.5 py-1 shadow-none"
      style={{
        background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 88%, var(--bg-app, #0a0b10))',
        borderColor: 'var(--border-subtle, #2a2b38)',
        color: 'var(--text-secondary, #a1a1aa)',
        boxShadow: 'none',
      }}
    >
      <div
        className="flex h-7 items-center gap-2 rounded-md border px-2 text-[10px] font-medium"
        style={{
          borderColor: 'var(--border-subtle, #2a2b38)',
          background: 'color-mix(in srgb, var(--bg-app, #0a0b10) 92%, transparent)',
          color: 'var(--text-secondary, #a1a1aa)',
        }}
      >
        <motion.span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          animate={status.tone === 'info' || status.tone === 'warning' ? { opacity: [0.35, 1, 0.35] } : { opacity: 1 }}
          transition={{ duration: 1.2, repeat: status.tone === 'info' || status.tone === 'warning' ? Infinity : 0 }}
          style={{ background: status.color }}
        />
        <span>{status.label}</span>
      </div>
      <TerminalUtilityButton title="Customize terminal colors" onClick={onOpenColors} tone="active">
        <Palette className="h-3.5 w-3.5" />
      </TerminalUtilityButton>
      {canStop && (
        <TerminalUtilityButton
          title="Stop runtime"
          onClick={onStopRuntime}
          disabled={stoppingRuntime}
          tone="danger"
        >
          <Power className="h-3.5 w-3.5" />
        </TerminalUtilityButton>
      )}
    </motion.div>
  );
}

function TerminalOAuthPrompt({ prompt, onOpen, onDismiss }) {
  return (
    <AnimatePresence>
      {prompt && (
        <motion.div
          key={prompt.id}
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ duration: 0.22, ease: TERMINAL_MOTION_EASE }}
          className="absolute bottom-4 left-4 z-20 w-[390px] max-w-[calc(100%-32px)] overflow-hidden rounded-lg border shadow-none"
          style={{
            background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 91%, var(--bg-app, #0a0b10))',
            borderColor: 'color-mix(in srgb, var(--accent-primary, #6c6885) 34%, var(--border-medium, #3f3f46))',
            color: 'var(--text-primary, #e4e4e7)',
          }}
          role="status"
          aria-live="polite"
        >
          <div
            aria-hidden="true"
            className="h-px w-full"
            style={{ background: 'var(--brand-gradient-horizontal)' }}
          />
          <div className="flex items-start gap-3 px-3 py-3">
            <div
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-primary, #6c6885) 42%, transparent)',
                color: 'var(--text-primary, #f4f5f8)',
                background: 'color-mix(in srgb, var(--bg-app, #0a0b10) 76%, var(--bg-elevated, #18181b))',
              }}
            >
              <Terminal className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="text-[12px] font-semibold">Terminal sign-in detected</div>
                <span
                  className="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                  style={{
                    background: 'color-mix(in srgb, var(--accent-primary, #6c6885) 14%, var(--bg-app, #0a0b10))',
                    color: 'var(--text-secondary, #a1a1aa)',
                  }}
                >
                  helper
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-5" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
                {prompt.opened
                  ? 'Helper opened. Finish browser sign-in, then return to this terminal.'
                  : 'This command is waiting on a local callback. Vectant can route it back into this workspace.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
              style={{ color: 'var(--text-muted, #6b7089)' }}
              aria-label="Dismiss terminal sign-in prompt"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div
            className="flex items-center justify-between gap-2 border-t px-3 py-2.5"
            style={{ borderColor: 'var(--border-subtle, #2a2b38)' }}
          >
            <span className="truncate text-[10px]" style={{ color: 'var(--text-muted, #6b7089)' }}>
              Callback relay is scoped to this terminal session.
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onDismiss}
                className="h-8 rounded-md px-3 text-[11px] font-medium transition-colors hover:bg-white/5"
                style={{ color: 'var(--text-secondary, #a1a1aa)' }}
              >
                Later
              </button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={onOpen}
                className="inline-flex h-8 items-center rounded-md px-3 text-[11px] font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: 'var(--text-primary, #f4f5f8)',
                  color: 'var(--bg-app, #0a0b10)',
                }}
              >
                Open sign-in
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TerminalActivityHint({ state, stoppingRuntime }) {
  const active = state === 'connecting' || stoppingRuntime;
  const label = stoppingRuntime ? 'Stopping runtime' : 'Connecting terminal';

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: TERMINAL_MOTION_EASE }}
          className="absolute bottom-2 right-3 z-10 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[10px]"
          style={{
            background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 92%, var(--bg-app, #0a0b10))',
            borderColor: 'var(--border-subtle, #2a2b38)',
            color: 'var(--text-secondary, #a1a1aa)',
          }}
        >
          <Zap className="h-3 w-3" style={{ color: 'var(--accent-primary, #6c6885)' }} />
          <span>{label}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Reusable: drag a panel by its titlebar within the viewport.
 * Returns { pos, panelRef, onTitleMouseDown }. `pos === null` means the
 * panel should centre itself via CSS until the user starts dragging.
 */
function useDraggableViewportPanel() {
  const [pos, setPos] = useState(null); // { x, y } | null
  const panelRef = useRef(null);
  const dragRef = useRef(null);

  const onTitleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
    };
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      const panel = panelRef.current;
      if (!d || !panel) return;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const x = Math.max(8, Math.min(d.originX + (e.clientX - d.startX), window.innerWidth - w - 8));
      const y = Math.max(8, Math.min(d.originY + (e.clientY - d.startY), window.innerHeight - h - 8));
      setPos({ x, y });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return { pos, panelRef, onTitleMouseDown };
}

/**
 * MultiLinePasteDialog — viewport-centred floating panel (portal to body)
 * shown when the user right-clicks to paste a multi-line clipboard payload.
 *
 * No backdrop dim/blur — the IDE stays interactive behind it.
 * Drag: mousedown on the titlebar.
 * Keyboard: Escape cancels, Ctrl/Cmd+Enter confirms. Cancel autofocuses so
 * a stray Enter doesn't accept a hostile clipboard payload.
 * Auto-approve: a checkbox skips this dialog for the rest of the page
 * session (resets on full reload).
 */
function MultiLinePasteDialog({ text, lineCount, charCount, onConfirm, onCancel }) {
  const PREVIEW_LINE_LIMIT = 40;
  const PREVIEW_CHAR_LIMIT = 4000;
  const lines = text.split(/\r?\n/);
  const previewLines = lines.slice(0, PREVIEW_LINE_LIMIT);
  let preview = previewLines.join('\n');
  if (preview.length > PREVIEW_CHAR_LIMIT) {
    preview = preview.slice(0, PREVIEW_CHAR_LIMIT) + '…';
  }
  const truncated =
    lines.length > PREVIEW_LINE_LIMIT || text.length > PREVIEW_CHAR_LIMIT;

  const [autoApprove, setAutoApprove] = useState(false);
  const { pos, panelRef, onTitleMouseDown } = useDraggableViewportPanel();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onConfirm({ autoApprove });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel, autoApprove]);

  if (typeof document === 'undefined') return null;

  const placement = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return createPortal(
    <div
      ref={panelRef}
      className="fixed"
      style={{
        ...placement,
        width: 480,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
        zIndex: 2147483646,
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.18, ease: TERMINAL_MOTION_EASE }}
        className="flex max-h-[calc(100vh-16px)] flex-col overflow-hidden rounded-lg border shadow-none"
        style={{
          background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 92%, var(--bg-app, #0a0b10))',
          borderColor: 'var(--border-medium, #3f3f46)',
          color: 'var(--text-primary, #e4e4e7)',
        }}
      >
        <div
          aria-hidden="true"
          className="h-px w-full"
          style={{ background: 'var(--brand-gradient-horizontal)' }}
        />
        <div
          onMouseDown={onTitleMouseDown}
          className="flex items-start gap-3 border-b px-3 py-3 select-none"
          style={{
            borderColor: 'var(--border-subtle, #2a2b38)',
            cursor: 'move',
          }}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-warning, #fbbf24) 26%, transparent)',
              color: 'var(--accent-warning, #fbbf24)',
              background: 'color-mix(in srgb, var(--accent-warning, #fbbf24) 8%, var(--bg-app, #0a0b10))',
            }}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold">Review multi-line paste</div>
            <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
              {lineCount} lines, {charCount} characters. Newlines are sent as Enter and may run commands immediately.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Cancel paste"
            className="rounded-md p-1 opacity-70 transition-opacity hover:bg-white/5 hover:opacity-100"
            style={{ color: 'var(--text-muted, #6b7089)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <pre
            className="mb-2 max-h-[220px] overflow-auto rounded-md border p-2 font-mono text-[11px] leading-5 whitespace-pre"
            style={{
              background: 'var(--bg-app, #0a0b10)',
              borderColor: 'var(--border-subtle, #2a2b38)',
              color: 'var(--text-primary, #e4e4e7)',
            }}
          >
            {preview}
          </pre>

          {truncated && (
            <p className="mb-2 text-[10px]" style={{ color: 'var(--text-muted, #6b7089)' }}>
              Preview truncated. The full payload will still be pasted.
            </p>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label
              className="flex items-center gap-2 text-[11px] cursor-pointer select-none"
              style={{ color: 'var(--text-secondary, #a1a1aa)' }}
            >
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                className="cursor-pointer"
              />
              Trust multi-line pastes for this page session
            </label>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                autoFocus
                className="h-8 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-white/[0.04]"
                style={{ borderColor: 'var(--border-medium, #3f3f46)', color: 'var(--text-secondary, #a1a1aa)' }}
              >
                Cancel
                <span className="ml-1.5 text-[10px] opacity-60">Esc</span>
              </button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => onConfirm({ autoApprove })}
                className="h-8 rounded-md px-3 text-xs font-semibold transition-opacity hover:opacity-90"
                style={{
                  background: 'var(--text-primary, #f4f5f8)',
                  color: 'var(--bg-app, #0a0b10)',
                }}
              >
                Paste
                <span className="ml-1.5 text-[10px] opacity-70">Ctrl+Enter</span>
              </motion.button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

/**
 * TerminalColorPanel — viewport-centred floating customizer for the xterm
 * colors. Persists overrides to localStorage and broadcasts them to every
 * mounted TerminalPane so the change is immediate. "Reset" wipes the
 * override layer and falls back to the active ThemeProvider theme.
 */
const COLOR_LABELS = {
  background: 'Background',
  foreground: 'Foreground',
  cursor: 'Cursor',
  cursorAccent: 'Cursor Accent',
  selectionBackground: 'Selection Bg',
  selectionForeground: 'Selection Fg',
  black: 'Black',
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
  magenta: 'Magenta',
  cyan: 'Cyan',
  white: 'White',
  brightBlack: 'Bright Black',
  brightRed: 'Bright Red',
  brightGreen: 'Bright Green',
  brightYellow: 'Bright Yellow',
  brightBlue: 'Bright Blue',
  brightMagenta: 'Bright Magenta',
  brightCyan: 'Bright Cyan',
  brightWhite: 'Bright White',
};

// Strip "rgba(…)" / non-hex inputs that <input type=color> can't display.
function toHexInputValue(value) {
  if (typeof value !== 'string') return '#000000';
  const m = value.trim().match(/^#([0-9a-f]{6})$/i);
  return m ? `#${m[1]}` : '#000000';
}

function TerminalColorPanel({ baseTheme, overrides, onClose }) {
  const { pos, panelRef, onTitleMouseDown } = useDraggableViewportPanel();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateKey = (key, value) => {
    const next = { ...overrides, [key]: value };
    setTerminalOverrides(next);
  };

  const resetKey = (key) => {
    const next = { ...overrides };
    delete next[key];
    setTerminalOverrides(next);
  };

  const resetAll = () => setTerminalOverrides({});

  if (typeof document === 'undefined') return null;

  const placement = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  return createPortal(
    <div
      ref={panelRef}
      className="fixed rounded-lg border shadow-none flex flex-col"
      style={{
        ...placement,
        width: 460,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100vh - 16px)',
        background: 'var(--bg-elevated, #18181b)',
        borderColor: 'var(--border-medium, #3f3f46)',
        zIndex: 2147483646,
      }}
    >
      <div
        onMouseDown={onTitleMouseDown}
        className="flex items-center gap-2 px-3 py-2 border-b rounded-t-lg select-none"
        style={{
          borderColor: 'var(--border-subtle, #2a2b38)',
          background: 'var(--bg-app, #0a0b10)',
          cursor: 'move',
        }}
      >
        <Palette className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-primary, #b545ff)' }} />
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--text-primary, #e4e4e7)' }}>
          Terminal Colors
        </span>
        <button
          type="button"
          onClick={resetAll}
          onMouseDown={(e) => e.stopPropagation()}
          title="Reset all to theme defaults"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/10"
          style={{ color: 'var(--text-muted, #6b7089)' }}
        >
          <RotateCcw className="w-3 h-3" />
          Reset all
        </button>
        <button
          type="button"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label="Close"
          className="rounded p-0.5 hover:bg-white/10"
          style={{ color: 'var(--text-muted, #6b7089)' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-3 overflow-auto flex-1 min-h-0">
        <p className="text-[11px] mb-3 leading-relaxed" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
          Overrides apply on top of the active theme and persist on this device.
          Click ↺ to revert a single color.
        </p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {TERMINAL_COLOR_KEYS.map((key) => {
            const effective = overrides[key] ?? baseTheme[key] ?? '#000000';
            const overridden = Object.prototype.hasOwnProperty.call(overrides, key);
            return (
              <div key={key} className="flex items-center gap-2">
                <input
                  type="color"
                  value={toHexInputValue(effective)}
                  onChange={(e) => updateKey(key, e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent"
                  title={effective}
                />
                <span
                  className="text-[11px] flex-1 truncate"
                  style={{
                    color: overridden ? 'var(--text-primary, #e4e4e7)' : 'var(--text-secondary, #a1a1aa)',
                    fontWeight: overridden ? 600 : 400,
                  }}
                >
                  {COLOR_LABELS[key] || key}
                </span>
                {overridden && (
                  <button
                    type="button"
                    onClick={() => resetKey(key)}
                    title="Revert to theme default"
                    className="rounded p-0.5 hover:bg-white/10"
                    style={{ color: 'var(--text-muted, #6b7089)' }}
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * ConnectionStatusPanel — viewport-centred floating panel (portal to body)
 * shown when the terminal disconnects or the shell exits. No backdrop, so
 * the rest of the IDE stays usable; draggable by the titlebar.
 */
function ConnectionStatusPanel({ state, repairing = false, onReconnect, onRepairRuntime }) {
  const { pos, panelRef, onTitleMouseDown } = useDraggableViewportPanel();
  const reduceMotion = useReducedMotion();

  if (typeof document === 'undefined') return null;

  const placement = pos
    ? { left: pos.x, top: pos.y }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

  const isClosed = state === 'closed';
  const title = isClosed ? 'Terminal session ended' : 'Runtime terminal unavailable';
  const body = isClosed
    ? 'The shell process exited. Workspace files are preserved.'
    : 'The editor is still usable. The workspace runtime is unavailable, so terminal commands cannot start yet.';
  const actionLabel = isClosed ? 'New session' : repairing ? 'Repairing runtime' : 'Repair runtime';
  const actionHandler = isClosed ? onReconnect : onRepairRuntime;
  const statusItems = isClosed
    ? [
        ['Session', 'Exited'],
        ['Workspace', 'Files preserved'],
      ]
    : [
        ['Runtime', 'Unavailable'],
        ['Repair path', 'Restart workspace runtime'],
        ['Workspace', 'Files preserved'],
      ];
  const iconColor = isClosed ? 'var(--text-secondary, #a1a1aa)' : 'var(--accent-warning, #d89b2b)';

  return createPortal(
    <div
      ref={panelRef}
      className="fixed"
      style={{
        ...placement,
        width: 404,
        maxWidth: 'calc(100vw - 16px)',
        zIndex: 120,
      }}
    >
      <motion.div
        role="status"
        aria-live="polite"
        initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.985 }}
        transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: TERMINAL_MOTION_EASE }}
        className="flex flex-col overflow-hidden rounded-lg border shadow-none"
        style={{
          background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 94%, var(--bg-app, #0a0b10))',
          borderColor: 'var(--border-medium, #3f3f46)',
          color: 'var(--text-primary, #e4e4e7)',
          boxShadow: '0 24px 70px color-mix(in srgb, var(--bg-app, #0a0b10) 72%, transparent)',
        }}
      >
        <div
          aria-hidden="true"
          className="h-px w-full"
          style={{ background: 'var(--brand-gradient-horizontal)' }}
        />
        <div
          onMouseDown={onTitleMouseDown}
          className="flex items-start gap-3 border-b px-3.5 py-3.5 select-none"
          style={{
            borderColor: 'var(--border-subtle, #2a2b38)',
            cursor: 'move',
          }}
        >
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-warning, #d89b2b) 26%, var(--border-medium, #3f3f46))',
              color: iconColor,
              background: 'color-mix(in srgb, var(--bg-app, #0a0b10) 76%, var(--bg-elevated, #18181b))',
            }}
          >
            {isClosed ? <Terminal className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[13px] font-semibold">{title}</div>
              <span
                className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  color: iconColor,
                  borderColor: 'color-mix(in srgb, var(--accent-warning, #d89b2b) 26%, var(--border-medium, #3f3f46))',
                  background: 'color-mix(in srgb, var(--accent-warning, #d89b2b) 8%, transparent)',
                }}
              >
                {state}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-5" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
              {body}
            </p>
          </div>
        </div>

        <div className="px-3.5 py-3">
          <div className="grid gap-1.5">
            {statusItems.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[86px_1fr] items-center gap-3 text-[10.5px]">
                <span style={{ color: 'var(--text-muted, #6b7089)' }}>{label}</span>
                <span className="truncate" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 border-t px-3.5 py-2.5"
          style={{ borderColor: 'var(--border-subtle, #2a2b38)' }}
        >
          <span className="text-[10px]" style={{ color: 'var(--text-muted, #6b7089)' }}>
            Workspace stays editable
          </span>
          <motion.button
            type="button"
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            onClick={actionHandler}
            disabled={repairing}
            aria-label={actionLabel}
            className="th-focus-ring flex h-8 items-center gap-2 rounded-md px-3 text-xs font-semibold transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
            style={{
              background: 'var(--text-primary, #f4f5f8)',
              color: 'var(--bg-app, #0a0b10)',
            }}
          >
            {repairing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : isClosed ? (
              <RefreshCw className="h-3.5 w-3.5" />
            ) : (
              <Wrench className="h-3.5 w-3.5" />
            )}
            {actionLabel}
          </motion.button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

export default TerminalPane;
