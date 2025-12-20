'use client';
import React, { useEffect, useRef, useState } from 'react';
import { WifiOff, RefreshCw, Terminal, AlertCircle, Zap } from 'lucide-react';

export default function TerminalPane() {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const currentSessionIdRef = useRef(null);
  const inputBufferRef = useRef('');
  const initializedRef = useRef(false);
  const [connectionState, setConnectionState] = useState('connecting'); // 'connecting' | 'connected' | 'error' | 'closed'
  const [errorMessage, setErrorMessage] = useState('');
  const reconnectAttemptsRef = useRef(0);
  // Use the same SIGNAL URL as compilerClient when available, fallback to localhost
  const MACHINE_WS = typeof process !== 'undefined' && process?.env?.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    ? process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    : 'https://lumpish-undevoutly-sonja.ngrok-free.dev/';


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
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        theme: { 
          // Synthi dark blue-gray theme with teal accent
          background: '#0a0b10',
          foreground: '#f0f2f5',
          cursor: '#327464',
          cursorAccent: '#0a0b10',
          selectionBackground: 'rgba(50, 116, 100, 0.3)',
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
          brightWhite: '#ffffff'
        },
        cursorBlink: true,
        allowTransparency: false,
        cols: 80,
        rows: 24,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      
      if (!containerRef.current) {
        console.warn('TerminalPane: containerRef is null, aborting open');
        return;
      }
      term.open(containerRef.current);
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
        ws.onopen = () => {
          console.log('WebSocket connected');
          setConnectionState('connected');
          setErrorMessage('');
          reconnectAttemptsRef.current = 0;
          try {
            const { cols, rows } = term;
            console.log(`Terminal size: ${cols}x${rows}`);
          } catch (_) {}
        };
        ws.onmessage = (event) => {
          try {
            if (event.data instanceof ArrayBuffer) {
              const decoder = new TextDecoder();
              const text = decoder.decode(new Uint8Array(event.data));
              term.write(text);
            } else if (typeof event.data === 'string') {
              term.write(event.data);
            } else {
              term.write(String(event.data));
            }
          } catch (e) {
            console.error('Error handling ws message in TerminalPane', e);
          }
        };
        ws.onerror = (error) => {
          setConnectionState('error');
          setErrorMessage('Connection failed. The terminal server may be unavailable.');
          console.error('WebSocket error:', error);
        };
        ws.onclose = (event) => {
          console.log('WebSocket closed', event.code, event.reason, event.wasClean);
          setConnectionState('closed');
        };
      } else {
        setConnectionState('error');
        setErrorMessage(`Failed to connect to ${MACHINE_WS}`);
      }
      
      let isResizing = false;
      let resizeTimeout = null;

      // Send user input to backend and forward to WebRTC path.
      // Also provide a local-echo fallback when no backend is connected so
      // the user sees their keystrokes while offline/disconnected.
      term.onData((data) => {
        if (isResizing) return;
        const wsLocal = wsRef.current;

        // Dispatch `synthi:terminal-input` for the WebRTC/compile path.
        // Include current session id when available so the handler can
        // associate input with the right run session.
        try {
          const detail = { data, sessionId: currentSessionIdRef.current };
          window.dispatchEvent(new CustomEvent('synthi:terminal-input', { detail }));
        } catch (e) {
          // ignore dispatch errors
        }

        // If the pane WebSocket is open, send raw bytes there as well.
        if (wsLocal && wsLocal.readyState === WebSocket.OPEN) {
          try {
            const encoder = new TextEncoder();
            wsLocal.send(encoder.encode(data));
          } catch (e) { /* ignore send errors */ }
        } else {
          // Local echo fallback so user can see typed characters when no
          // backend is connected (prevents 'cannot type' appearance).
          try { term.write(data); } catch (_) { /* ignore */ }
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
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
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

          // If `data` is a string, try to parse JSON from it; otherwise treat
          // it as an object. We support two shapes from the worker:
          // 1) { sessionId, type, line }  -- streaming chunks
          // 2) { sessionId, status: 'done', stage, success, code, start_time, end_time, elapsed }
          let obj = null;
          if (typeof data === 'string') {
            // try parse JSON, otherwise write raw string
            try { obj = JSON.parse(data); } catch (_) { term.write(data); return; }
          } else if (typeof data === 'object') {
            obj = data;
          } else {
            term.write(String(data));
            return;
          }

          if (obj.sessionId) currentSessionIdRef.current = obj.sessionId;

          // Streaming chunk
          if (obj.line !== undefined) {
            const chunk = String(obj.line);
            const t = obj.type || '';
            if (t === 'stderr' || t === 'run-stderr') {
              term.write('\x1b[31m' + chunk + '\x1b[0m');
            } else if (t !== 'lsp-err' && t !== 'lsp-out' && t.includes('lsp') === false) {
              term.write(chunk);
            }
            return;
          }

          // Final status
          if (obj.status !== undefined) {
            const stage = obj.stage || 'unknown';
            const success = !!obj.success;
            const start = obj.start_time;
            const end = obj.end_time;
            const elapsed = obj.elapsed;
            if (success) {
              term.write('\r\n\x1b[32m[done] ' + stage + ' (success)\x1b[0m');
            } else {
              const code = obj.code !== undefined ? String(obj.code) : 'unknown';
              term.write('\r\n\x1b[31m[done] ' + stage + ' (failure, code=' + code + ')\x1b[0m');
            }
            if (start) term.write(' \x1b[36m(start: ' + String(start) + ')\x1b[0m');
            if (end) term.write(' \x1b[36m(end: ' + String(end) + ')\x1b[0m');
            if (elapsed) term.write(' \x1b[33m(elapsed: ' + String(elapsed) + ')\x1b[0m');
            term.write('\r\n');
            return;
          }

          // run-start
          if (obj.type === 'run-start' || obj.start_time) {
            const st = obj.start_time || '';
            term.write('\r\n\x1b[36m[run] started at ' + String(st) + '\x1b[0m\r\n');
            return;
          }

          // fallback
          term.write(JSON.stringify(obj) + '\r\n');
        } catch (e) {
          console.error('Error writing build log to terminal', e);
        }
      };
      window.addEventListener('synthi:build-log', buildLogListener);
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
        if (listener) window.removeEventListener('synthi:build-log', listener);
      } catch (e) {}
    };
  }, []);

  const handleReconnect = () => {
    setConnectionState('connecting');
    setErrorMessage('');
    reconnectAttemptsRef.current += 1;
    
    // Close existing connection
    if (wsRef.current) {
      try { wsRef.current.close(); } catch (e) {}
    }
    
    // Re-initialize
    initializedRef.current = false;
    
    // Force re-mount by triggering useEffect
    setTimeout(() => {
      window.location.reload();
    }, 100);
  };

  return (
    <div className="h-full w-full bg-[#0a0b10] overflow-hidden relative">
      <div ref={containerRef} className="h-full w-full" />
      
      {/* Synthi Branded Error Overlay */}
      {(connectionState === 'error' || connectionState === 'closed') && (
        <div className="absolute inset-0 bg-[#0a0b10]/98 backdrop-blur-md flex items-center justify-center z-10">
          <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
            {/* Title with gradient */}
            <h3 className="text-xl font-bold bg-gradient-to-r from-[#f0f2f5] to-[#a8adc0] bg-clip-text text-transparent">
              Terminal Disconnected
            </h3>
            
            {/* Message */}
            <p className="text-sm text-[#6b7089] leading-relaxed">
              {errorMessage || 'The connection to the Synthi terminal server was lost. This may be due to network issues or server maintenance.'}
            </p>
          
          </div>
        </div>
      )}
    </div>
  );
}