'use client';
import React, { useEffect, useRef } from 'react';

export default function TerminalPane() {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const initializedRef = useRef(false);
  // Use the same SIGNAL URL as compilerClient when available, fallback to localhost
  // Normalize HTTP(S) urls to WS(S) so `new WebSocket(...)` uses the correct scheme.
  const rawSignalUrl = typeof process !== 'undefined' && process?.env?.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    ? process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    : 'http://localhost:9000';

  const normalizeToWs = (url) => {
    if (!url) return null;
    // Already a ws/wss URL
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    if (url.startsWith('http://')) return 'ws://' + url.slice('http://'.length);
    if (url.startsWith('https://')) return 'wss://' + url.slice('https://'.length);
    // No scheme provided: assume wss for production-like hosts, ws for localhost
    if (url.includes('localhost') || url.startsWith('127.') || url.startsWith('::1')) return 'ws://' + url;
    return 'wss://' + url;
  };

  const MACHINE_WS = normalizeToWs(rawSignalUrl);


  useEffect(() => {
    // Prevent multiple initializations
    if (initializedRef.current) return;
    initializedRef.current = true;

    let term;
    let fitAddon;
    let ws;

    const init = async () => {
      const { Terminal } = await import('xterm');
      const { FitAddon } = await import('xterm-addon-fit');

      term = new Terminal({
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
        cursorBlink: true,
        allowTransparency: false,
        cols: 80,
        rows: 24,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      // Ensure terminal receives keyboard focus so `onData` fires when user types.
      try {
        if (containerRef.current && containerRef.current instanceof HTMLElement) {
          containerRef.current.tabIndex = 0; // make focusable and focusable by click
        }
      } catch (e) {}
      try { term.focus(); } catch (e) {}
      fitAddon.fit();

      try {
        console.debug('TerminalPane connecting to', MACHINE_WS);
        ws = new WebSocket(MACHINE_WS);
      } catch (e) {
        console.error('Failed to construct WebSocket with', MACHINE_WS, e);
        ws = null;
      }
      wsRef.current = ws;
      if (ws) {
        try { ws.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }
      } else {
        // If we couldn't create a WebSocket, write a helpful message into the
        // terminal so the user sees why the pane is not connected.
        try {
          const { term } = termRef.current || {};
          if (term && typeof term.write === 'function') {
            term.write('\r\n\x1b[31mWebSocket: failed to create connection to ' + String(MACHINE_WS) + '\x1b[0m\r\n');
          }
        } catch (e) { /* ignore */ }
      }

      ws.onopen = () => {
        console.log('WebSocket connected');
        // Optionally send initial terminal size
        const { cols, rows } = term;
        console.log(`Terminal size: ${cols}x${rows}`);
      };

      // Display backend output in terminal
      if (ws) {
        ws.onmessage = (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              const decoder = new TextDecoder();
              const text = decoder.decode(new Uint8Array(event.data));
              term.write(text);
            } else if (typeof event.data === 'string') {
              term.write(event.data);
            } else {
              // fallback
              term.write(String(event.data));
            }
          } catch (e) {
            console.error('Error handling ws message in TerminalPane', e);
          }
        };
      }

      ws.onerror = (error) => {
        term.write('\r\n\x1b[31mWebSocket connection error. Terminal unavailable.\x1b[0m\r\n');
        console.error('WebSocket error:', error);
        console.error('WebSocket readyState:', ws.readyState);
        console.error('WebSocket url:', ws.url);
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed');
        console.log('Close code:', event.code);
        console.log('Close reason:', event.reason);
        console.log('Was clean:', event.wasClean);
      };
      
      let isResizing = false;
      let resizeTimeout = null;

      // Send user input to backend by emitting a synthi:terminal-input event.
      // This lets `compilerClient` forward the input over the WebRTC `terminal`
      // datachannel to the worker, which will route it to the running process's stdin.
      term.onData((data) => {
        // Don't send data while resizing
        if (isResizing) return;

        try {
          // Diagnostic log: show typed data and current session id
          try { console.debug('[TerminalPane] onData', { data, sessionId: currentSessionIdRef.current }); } catch (e) {}

          // Handle input carefully to avoid writing raw escape/control sequences
          // directly into xterm which can cause parsing errors.
          // Maintain a small local input buffer for echoing printable characters
          let buf = inputBufferRef.current || '';

          // Data may contain multiple chars; process one by one
          for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            const code = ch.charCodeAt(0);

            // Carriage return / Enter: echo CRLF and send '\n' to remote
            if (ch === '\r' || ch === '\n') {
              try { term.write('\r\n'); } catch (_) {}
              buf = '';
              const ev = new CustomEvent('synthi:terminal-input', { detail: { sessionId: currentSessionIdRef.current, data: '\n' } });
              window.dispatchEvent(ev);
              continue;
            }

            // Backspace (DEL or BS): remove last local char and erase on terminal
            if (code === 127 || code === 8) {
              if (buf.length > 0) {
                buf = buf.slice(0, -1);
                try { term.write('\b \b'); } catch (_) {}
              } else {
                // nothing to erase locally; still forward backspace to remote
              }
              const ev = new CustomEvent('synthi:terminal-input', { detail: { sessionId: currentSessionIdRef.current, data: ch } });
              window.dispatchEvent(ev);
              continue;
            }

            // Escape sequences / control characters (non-printable except tab) - forward, do not echo
            if (code < 32 && code !== 9) {
              // send as-is
              const ev = new CustomEvent('synthi:terminal-input', { detail: { sessionId: currentSessionIdRef.current, data: ch } });
              window.dispatchEvent(ev);
              continue;
            }

            // Printable characters: local echo and buffer
            buf += ch;
            try { term.write(ch); } catch (_) {}
            const ev = new CustomEvent('synthi:terminal-input', { detail: { sessionId: currentSessionIdRef.current, data: ch } });
            window.dispatchEvent(ev);
          }

          inputBufferRef.current = buf;
        } catch (e) {
          console.error('Failed to dispatch terminal input event', e);
        }
      });

      // Debounced resize handler
      const handleResize = () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (fitAddon && term && containerRef.current) {
            try {
              fitAddon.fit();
              const { cols, rows } = term;
              console.log(`Terminal resized: ${cols}x${rows}`);
            } catch (e) {
              console.error('Resize error:', e);
            }
          }
        }, 100); // 100ms debounce
      };

      const resizeObserver = new ResizeObserver(() => {
        // Use requestAnimationFrame to batch resize events
        requestAnimationFrame(() => {
          handleResize();
        });
      });
      let clickHandler = null;
      let keydownHandler = null;
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
        // clicking the container should focus the terminal so keyboard input works
        clickHandler = () => { try { term.focus(); } catch (e) {} };
        keydownHandler = (ev) => { try { console.debug('[TerminalPane] container keydown', ev.key); } catch (_) {} };
        containerRef.current.addEventListener('click', clickHandler);
        containerRef.current.addEventListener('keydown', keydownHandler);
      }

      window.addEventListener('resize', handleResize);
      
      // Listen for resize events to disable input only while dragging
      const handleResizeStart = () => {
        isResizing = true;
      };
      const handleResizeEnd = () => {
        isResizing = false;
      };

      document.addEventListener('pointerdown', (e) => {
        if (e.target?.closest('[data-resizable-handle]')) {
          handleResizeStart();
        }
      });
      document.addEventListener('pointerup', handleResizeEnd);
      document.addEventListener('pointercancel', handleResizeEnd);

      // Initial fit after a short delay to ensure DOM is ready
      setTimeout(() => handleResize(), 100);

      // Store for cleanup (include buildLogListener reference)
      termRef.current = { term, fitAddon, handleResize, resizeObserver };

      // Listen for build log events from compilerClient and write to terminal
      const buildLogListener = (ev) => {
        try {
          const data = ev?.detail;
          if (!data) return;

          // Track most recent sessionId so user input can be forwarded to the
          // correct running compilation/process.
          if (data.sessionId) {
            currentSessionIdRef.current = data.sessionId;
          }

          // Determine the raw string payload (may be a string or an object with `line`)
          let rawLine = null;
          if (typeof data === 'string') rawLine = data;
          else if (data && typeof data === 'object' && data.line !== undefined) rawLine = data.line;
          else rawLine = String(data);

          // The rawLine itself may be a JSON string emitted by the worker.
          // Try to parse it and extract the inner `line` if present.
          let out = rawLine;
          if (typeof rawLine === 'string') {
            try {
              const p = JSON.parse(rawLine);
              if (p && typeof p === 'object' && p.line !== undefined) {
                out = p.line;
              }
            } catch (_) {
              // not JSON, keep rawLine
            }
          }

          // Ensure we write a newline-terminated string to the terminal
          const toWrite = typeof out === 'string' ? (out.endsWith('\n') ? out : out + '\r\n') : String(out) + '\r\n';
          term.write(toWrite);
        } catch (e) {
          console.error('Error writing build log to terminal', e);
        }
      };

      // Prefer session-scoped streaming events. Listen only to the unified stream
      // event to avoid duplicate writes (older code also emitted `synthi:build-log`).
      window.addEventListener('synthi:build-stream', buildLogListener);
      // keep listener reference for cleanup
      termRef.current.buildLogListener = buildLogListener;
    };

    init();

    return () => {
      if (termRef.current) {
        const { term, handleResize, resizeObserver } = termRef.current;
        window.removeEventListener('resize', handleResize);
        if (resizeObserver) resizeObserver.disconnect();
        if (term) term.dispose();
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      try {
        const listener = termRef.current?.buildLogListener;
        if (listener) {
          window.removeEventListener('synthi:build-stream', listener);
        }
      } catch (e) {}
      try {
        if (containerRef.current) {
          if (typeof clickHandler === 'function') containerRef.current.removeEventListener('click', clickHandler);
          if (typeof keydownHandler === 'function') containerRef.current.removeEventListener('keydown', keydownHandler);
        }
      } catch (_) {}
    };
  }, []);

  return (
    <div className="h-full w-full bg-[#1e1e1e] overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}