'use client';
import React, { useEffect, useRef } from 'react';

export default function TerminalPane() {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const initializedRef = useRef(false);
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
      fitAddon.fit();

      try {
        console.debug('TerminalPane connecting to', MACHINE_WS);
        ws = new WebSocket(MACHINE_WS);
      } catch (e) {
        console.error('Failed to construct WebSocket with', MACHINE_WS, e);
        ws = null;
      }
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer'; // Handle binary data

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

      // Send user input to backend
      term.onData((data) => {
        // Don't send data while resizing
        if (isResizing) return;

        if (ws.readyState === WebSocket.OPEN) {
          // Convert string to Uint8Array for binary transmission
          const encoder = new TextEncoder();
          ws.send(encoder.encode(data));
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

      // Prefer session-scoped streaming events; fall back to generic build-log events
      window.addEventListener('synthi:build-stream', buildLogListener);
      window.addEventListener('synthi:build-log', buildLogListener);
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
          window.removeEventListener('synthi:build-log', listener);
        }
      } catch (e) {}
    };
  }, []);

  return (
    <div className="h-full w-full bg-[#1e1e1e] overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}