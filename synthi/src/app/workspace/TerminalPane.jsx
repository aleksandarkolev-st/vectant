'use client';
import React, { useEffect, useRef, useState, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from 'next-auth/react';
import { WifiOff, RefreshCw, Terminal, AlertCircle, Zap, EyeOff, ClipboardPaste } from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { useSessionPermissions } from '@/hooks/useCollabSession';
import { resolveCollabWsUrl } from '@/lib/collab-url';

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

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000]; // Exponential backoff
const MAX_RECONNECT_ATTEMPTS = 4;

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
  const inputBufferRef = useRef('');
  const initializedRef = useRef(false);
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

  const [state, setState] = useState('connecting'); // connecting | connected | error | closed
  const [shellInfo, setShellInfo] = useState('');
  // Multi-line paste confirmation: null when no pending paste, otherwise
  // { text, lineCount, charCount } describing the clipboard payload.
  const [pasteConfirm, setPasteConfirm] = useState(null);

  // Stable session key: survives re-renders, unique per terminal tab + pane side
  const sessionKey = `${terminalId}-${paneSide}`;

  // ─── Live terminal theme sync ─────────────────────────────────────────
  useEffect(() => {
    if (terminalRef.current?.term && terminalTheme) {
      const term = terminalRef.current.term;
      term.options.theme = terminalTheme;
      // Force an immediate full repaint so colors apply without delay
      try { term.refresh(0, term.rows - 1); } catch (_) {}
    }
  }, [terminalTheme]);

  // ─── Cleanup helper ───────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(1000); } catch (_) {}
      wsRef.current = null;
    }
    if (terminalRef.current?.term) {
      try { terminalRef.current.term.dispose(); } catch (_) {}
    }
    terminalRef.current = null;
    sessionIdRef.current = null;
  }, []);

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

    const init = async () => {
      // Dynamic import to avoid SSR issues
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('xterm'),
        import('xterm-addon-fit'),
        import('xterm-addon-web-links'),
      ]);

      // PERF: Attempt to load WebGL renderer addon for GPU-accelerated
      // terminal rendering. Falls back to the default canvas renderer
      // if WebGL is unavailable (e.g., software rendering, privacy mode).
      let WebglAddon = null;
      try {
        const webglModule = await import('xterm-addon-webgl');
        WebglAddon = webglModule.WebglAddon;
      } catch (_) {
        console.log('[Terminal] WebGL addon not available, using canvas renderer');
      }

      if (disposed || !containerRef.current) return;

      // ── Create xterm instance ───────────────────────────────────────
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: terminalTheme || SYNTHI_THEME_FALLBACK,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        allowTransparency: false,
        convertEol: true,   // Required on Windows — ConPTY can emit bare \n
      });

      const fitAddon = new FitAddon();
      const linksAddon = new WebLinksAddon();
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
      const handleContextMenu = async (e) => {
        e.preventDefault();
        if (!canTerminalRef.current && canTerminalRef.current !== undefined) {
          return; // View-only guest
        }
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;
          const hasEmbeddedNewline = text.replace(/\r?\n$/, '').includes('\n');
          if (hasEmbeddedNewline) {
            const lineCount = text.split(/\r?\n/).length;
            setPasteConfirm({ text, lineCount, charCount: text.length });
          } else {
            term.paste(text);
          }
        } catch (_) {
          // Clipboard read can fail (permission denied, insecure context,
          // user gesture lost). Stay silent — the user can fall back to
          // Ctrl/Cmd+V.
        }
      };
      containerRef.current.addEventListener('contextmenu', handleContextMenu);

      // ── Connect WebSocket ─────────────────────────────────────────
      connectWS(term, fitAddon);

      // ── Resize handling ───────────────────────────────────────────
      let resizeRaf = null;
      const doFit = () => {
        if (disposed || !terminalRef.current) return;
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
          containerEl.removeEventListener('contextmenu', handleContextMenu);
        }
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        if (webglAddon) try { webglAddon.dispose(); } catch (_) {}
        linksAddon.dispose();
        fitAddon.dispose();
        term.dispose();
      };
    };

    // ── WebSocket connection logic (also used for reconnect) ──────────
    function connectWS(term, fitAddon) {
      if (disposed) return;

      // Use the fixed session ID (from AI terminal) or generate a new one
      const sid = fixedSessionId || (sessionKey + '-' + Date.now().toString(36));
      sessionIdRef.current = sid;

      const { cols, rows } = term;
      const termUserId = authSessionRef.current?.user?.id || authSessionRef.current?.user?.email || '';
      const params = new URLSearchParams({
        sessionId: sid,
        workspace: workspaceSlug,
        userId: termUserId,
        cols: String(cols),
        rows: String(rows),
      });
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
      term.onData((data) => {
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
      term.onBinary((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          const buffer = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) buffer[i] = data.charCodeAt(i);
          ws.send(buffer);
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
      if (terminalRef.current?.dispose) {
        try { terminalRef.current.dispose(); } catch (_) {}
      }
    };
  }, [sessionKey, workspaceSlug, fixedSessionId, shellType]); // Re-connect if terminal tab, workspace, or shell type changes

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

  // ─── Multi-line paste confirmation actions ────────────────────────────
  const confirmPaste = useCallback(() => {
    const pending = pasteConfirm;
    setPasteConfirm(null);
    if (!pending) return;
    const term = terminalRef.current?.term;
    if (!term) return;
    try { term.paste(pending.text); } catch (_) {}
    // Hand focus back to the PTY — the dialog stole it on mount.
    try { term.focus(); } catch (_) {}
  }, [pasteConfirm]);

  const cancelPaste = useCallback(() => {
    setPasteConfirm(null);
    try { terminalRef.current?.term?.focus(); } catch (_) {}
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="terminal-pane-shell h-full w-full overflow-hidden relative" style={{ background: 'var(--bg-app)' }}>
      <div ref={containerRef} className="h-full w-full" />

      {pasteConfirm && (
        <MultiLinePasteDialog
          text={pasteConfirm.text}
          lineCount={pasteConfirm.lineCount}
          charCount={pasteConfirm.charCount}
          onConfirm={confirmPaste}
          onCancel={cancelPaste}
        />
      )}

      {/* Session: View-only terminal overlay for guests without canTerminal */}
      {isGuest && !canTerminal && state === 'connected' && (
        <div
          className="absolute bottom-0 left-0 right-0 flex items-center justify-center px-4 py-1.5 z-10"
          style={{
            background: 'color-mix(in srgb, var(--accent-warning) 8%, transparent)',
            borderTop: '1px solid color-mix(in srgb, var(--accent-warning) 24%, transparent)',
          }}
        >
          <div className="flex items-center gap-2">
            <EyeOff className="w-3.5 h-3.5" style={{ color: 'var(--accent-warning)' }} />
            <span className="text-xs font-medium" style={{ color: 'var(--accent-warning)' }}>
              Terminal is view-only — Ask the host for terminal access
            </span>
          </div>
        </div>
      )}

      {/* Connection status overlay */}
      {(state === 'error' || state === 'closed') && (
        <div className="absolute inset-0 backdrop-blur-sm flex items-center justify-center z-10" style={{ background: 'color-mix(in srgb, var(--bg-app) 95%, transparent)' }}>
          <div className="flex flex-col items-center gap-4 p-8 max-w-sm text-center">
            <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-elevated)' }}>
              <WifiOff className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
            </div>

            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {state === 'closed' ? 'Session Ended' : 'Terminal Disconnected'}
            </h3>

            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {state === 'closed'
                ? 'The shell process has exited.'
                : 'Unable to reach the terminal server. Make sure the collab-server is running.'}
            </p>

            <button
              onClick={handleReconnect}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium
                         text-white transition-colors"
              style={{ background: 'var(--accent-primary)' }}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {state === 'closed' ? 'New Session' : 'Reconnect'}
            </button>
          </div>
        </div>
      )}

      {/* Connecting indicator */}
      {state === 'connecting' && (
        <div className="absolute bottom-2 right-3 flex items-center gap-1.5 text-[10px] z-10" style={{ color: 'var(--text-muted)' }}>
          <Zap className="w-3 h-3 animate-pulse" style={{ color: 'var(--accent-primary)' }} />
          <span>Connecting…</span>
        </div>
      )}
    </div>
  );
}, /* freeze — never re-render from parent */ () => true);

/**
 * MultiLinePasteDialog — confirmation modal shown when the user right-clicks
 * to paste a multi-line clipboard payload into the terminal. Multi-line
 * pastes can immediately execute each line (newline = Enter), so we surface
 * the text and the line count before sending it to the PTY.
 *
 * Keyboard: Enter confirms, Escape cancels. The Cancel button autofocuses
 * so an accidental Enter doesn't paste a hostile clipboard payload.
 */
function MultiLinePasteDialog({ text, lineCount, charCount, onConfirm, onCancel }) {
  // Preview is truncated for very large pastes so the modal stays usable.
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

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'rgba(0,0,0,0.55)', zIndex: 2147483646 }}
      onClick={onCancel}
    >
      <div
        className="w-[440px] max-w-[92%] rounded-xl border shadow-2xl p-4"
        style={{ background: 'var(--bg-elevated, #18181b)', borderColor: 'var(--border-medium, #3f3f46)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 mb-3">
          <ClipboardPaste className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-warning, #fbbf24)' }} />
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e4e4e7)' }}>
              Paste multi-line text?
            </h3>
            <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
              This clipboard contains {lineCount} lines ({charCount} chars). Each newline
              will be sent as Enter and may execute immediately.
            </p>
          </div>
        </div>

        <pre
          className="font-mono text-[11px] leading-snug whitespace-pre overflow-auto rounded-md p-2 mb-3 max-h-56"
          style={{
            background: 'var(--bg-app, #0a0b10)',
            border: '1px solid var(--border-subtle, #2a2b38)',
            color: 'var(--text-primary, #e4e4e7)',
          }}
        >
          {preview}
        </pre>

        {truncated && (
          <p className="text-[10px] mb-2 -mt-2" style={{ color: 'var(--text-muted, #6b7089)' }}>
            Preview truncated — full payload will still be pasted.
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            autoFocus
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors border"
            style={{ borderColor: 'var(--border-medium, #3f3f46)', color: 'var(--text-secondary, #a1a1aa)' }}
          >
            Cancel
            <span className="ml-1.5 text-[10px] opacity-60">Esc</span>
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-md text-xs font-semibold transition-colors text-white"
            style={{ background: 'var(--accent-warning, #d97706)' }}
          >
            Paste
            <span className="ml-1.5 text-[10px] opacity-80">Ctrl+Enter</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default TerminalPane;