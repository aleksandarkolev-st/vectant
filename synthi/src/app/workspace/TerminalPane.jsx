'use client';
import React, { useEffect, useRef, useState } from 'react';
import { WifiOff, RefreshCw, Terminal, AlertCircle, Zap, EyeOff } from 'lucide-react';
import { useSessionPermissions } from '@/hooks/useCollabSession';

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

const TERMINAL_SERVER_URL =
  typeof window !== 'undefined' &&
  typeof process !== 'undefined' &&
  process?.env?.NEXT_PUBLIC_TERMINAL_URL
    ? process.env.NEXT_PUBLIC_TERMINAL_URL
    : (typeof window !== 'undefined' &&
       typeof process !== 'undefined' &&
       process?.env?.NEXT_PUBLIC_COLLAB_SERVER_URL
         ? process.env.NEXT_PUBLIC_COLLAB_SERVER_URL.replace(/^http/, 'ws')
         : 'ws://localhost:1234');

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000]; // Exponential backoff
const MAX_RECONNECT_ATTEMPTS = 4;

// ─── Synthi Dark Theme ──────────────────────────────────────────────────────

const SYNTHI_THEME = {
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

export default function TerminalPane({ terminalId = 'default', paneSide = 'main', workspaceSlug = '', onFsChange, fixedSessionId = null }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);   // { term, fitAddon, dispose() }
  const wsRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const initializedRef = useRef(false);
  const [connectionState, setConnectionState] = useState('connecting'); // 'connecting' | 'connected' | 'error' | 'closed'
  const [errorMessage, setErrorMessage] = useState('');
  const reconnectAttemptsRef = useRef(0);
  const { canTerminal, role } = useSessionPermissions();
  const canTerminalRef = useRef(canTerminal);
  canTerminalRef.current = canTerminal;
  const isGuest = role === 'guest';
  // Use the same SIGNAL URL as compilerClient when available, fallback to localhost
  const MACHINE_WS = typeof process !== 'undefined' && process?.env?.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    ? process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    : 'https://lumpish-undevoutly-sonja.ngrok-free.dev/';
  const sessionIdRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const mountedRef = useRef(true);

  const [state, setState] = useState('connecting'); // connecting | connected | error | closed
  const [shellInfo, setShellInfo] = useState('');

  // Stable session key: survives re-renders, unique per terminal tab + pane side
  const sessionKey = `${terminalId}-${paneSide}`;

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

      if (disposed || !containerRef.current) return;

      // ── Create xterm instance ───────────────────────────────────────
      const term = new Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        theme: SYNTHI_THEME,
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

      // Initial fit
      try { fitAddon.fit(); } catch (_) {}

      terminalRef.current = { term, fitAddon };

      // ── Connect WebSocket ─────────────────────────────────────────
      connectWS(term, fitAddon);

      // ── Resize handling ───────────────────────────────────────────
      let resizeRaf = null;
      const doFit = () => {
        if (disposed || !terminalRef.current) return;
        try {
          fitAddon.fit();
          sendResize(term.cols, term.rows);
        } catch (_) {}
      };

      const scheduleResize = () => {
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(doFit);
      };

      const resizeObserver = new ResizeObserver(scheduleResize);
      if (containerRef.current) resizeObserver.observe(containerRef.current);
      window.addEventListener('resize', scheduleResize);

      // Store teardown
      terminalRef.current.dispose = () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', scheduleResize);
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
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
      const params = new URLSearchParams({
        sessionId: sid,
        workspace: workspaceSlug,
        cols: String(cols),
        rows: String(rows),
      });

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
        if (isResizing) return;

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

      // ── xterm → WebSocket (keystroke hot path) ────────────────────
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send raw binary for minimum latency
          ws.send(new TextEncoder().encode(data));
        }
      });

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
  }, [sessionKey, workspaceSlug, fixedSessionId]); // Re-connect if terminal tab or workspace changes

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

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="h-full w-full bg-[#0a0b10] overflow-hidden relative">
      <div ref={containerRef} className="h-full w-full" />

      {/* Session: View-only terminal overlay for guests without canTerminal */}
      {isGuest && !canTerminal && connectionState === 'connected' && (
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center px-4 py-1.5 bg-[#fbbf2415] border-t border-[#fbbf2430] z-10">
          <div className="flex items-center gap-2">
            <EyeOff className="w-3.5 h-3.5 text-[#fbbf24]" />
            <span className="text-xs text-[#fbbf24] font-medium">
              Terminal is view-only — Ask the host for terminal access
            </span>
          </div>
        </div>
      )}
      
      {/* Synthi Branded Error Overlay */}
      {(connectionState === 'error' || connectionState === 'closed') && (
        <div className="absolute inset-0 bg-[#0a0b10]/98 backdrop-blur-md flex items-center justify-center z-10">
          <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
            {/* Title with gradient */}
            <h3 className="text-xl font-bold bg-gradient-to-r from-[#f0f2f5] to-[#a8adc0] bg-clip-text text-transparent">
              Terminal Disconnected
      {/* xterm container */}
      <div
        ref={containerRef}
        className="h-full w-full"
      />

      {/* Connection status overlay */}
      {(state === 'error' || state === 'closed') && (
        <div className="absolute inset-0 bg-[#0a0b10]/95 backdrop-blur-sm flex items-center justify-center z-10">
          <div className="flex flex-col items-center gap-4 p-8 max-w-sm text-center">
            <div className="w-12 h-12 rounded-full bg-[#1a1b24] flex items-center justify-center">
              <WifiOff className="w-5 h-5 text-[#6b7089]" />
            </div>

            <h3 className="text-base font-semibold text-[#f0f2f5]">
              {state === 'closed' ? 'Session Ended' : 'Terminal Disconnected'}
            </h3>

            <p className="text-xs text-[#6b7089] leading-relaxed">
              {state === 'closed'
                ? 'The shell process has exited.'
                : 'Unable to reach the terminal server. Make sure the collab-server is running.'}
            </p>

            <button
              onClick={handleReconnect}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium
                         bg-[#327464] text-white hover:bg-[#3d8b78] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {state === 'closed' ? 'New Session' : 'Reconnect'}
            </button>
          </div>
        </div>
      )}

      {/* Connecting indicator */}
      {state === 'connecting' && (
        <div className="absolute bottom-2 right-3 flex items-center gap-1.5 text-[10px] text-[#6b7089] z-10">
          <Zap className="w-3 h-3 animate-pulse text-[#327464]" />
          <span>Connecting…</span>
        </div>
      )}
    </div>
  );
}