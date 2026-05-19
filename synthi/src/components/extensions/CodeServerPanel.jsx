'use client';

/**
 * CodeServerPanel
 *
 * Embeds the code-server UI in an iframe at /__vscode-proxy__/.
 * The Service Worker intercepts these requests and tunnels them through
 * BroadcastChannel → vscodeTunnelService → VSCodeServerProxy → DataChannel
 * → vscode-server-manager → code-server.
 *
 * No controllerchange required — BroadcastChannel works without SW control.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Loader2, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react';

const PROXY_PREFIX = '/__vscode-proxy__';

export default function CodeServerPanel({
  tunnelService,
  workspacePath = '/workspace',
  sidebarOnly = false,
  focusViewId = null,
  className = '',
  style = {},
}) {
  const iframeRef = useRef(null);
  const [state, setState] = useState('initializing'); // initializing | loading | ready | error
  const [errorMsg, setErrorMsg] = useState(null);

  const getIframeSrc = useCallback(() => {
    const params = new URLSearchParams();
    if (workspacePath) params.set('folder', workspacePath);
    if (sidebarOnly) {
      params.set('sidebarOnly', 'true');
      if (focusViewId) params.set('focusView', focusViewId);
    }
    const query = params.toString();
    return `${PROXY_PREFIX}/${query ? '?' + query : ''}`;
  }, [workspacePath, sidebarOnly, focusViewId]);

  const getIframeOrigin = useCallback(() => {
    if (typeof window === 'undefined') return null;
    try {
      const origin = new URL(getIframeSrc(), window.location.href).origin;
      return origin === 'null' ? null : origin;
    } catch (_) {
      return null;
    }
  }, [getIframeSrc]);

  // Initialize: ensure SW is registered and proxy is attached
  useEffect(() => {
    if (!tunnelService) {
      setState('error');
      setErrorMsg('Tunnel service not provided');
      return;
    }

    let cancelled = false;

    async function init() {
      setState('initializing');
      console.log('[CodeServerPanel] Initializing...');

      // Register the SW (idempotent, fast — no controllerchange wait)
      const registered = await tunnelService.register();
      if (cancelled) return;

      if (!registered) {
        setState('error');
        setErrorMsg('Service Worker registration failed. Ensure HTTPS or localhost.');
        return;
      }
      console.log('[CodeServerPanel] SW registered');

      // Wait for tunnel to be fully ready: SW registered + proxy attached +
      // DataChannel open + server-manager workerReady received
      let attempts = 0;
      while (!tunnelService.isReady && attempts < 40) {
        await new Promise(r => setTimeout(r, 250));
        if (cancelled) return;
        attempts++;
      }

      if (!tunnelService.isReady) {
        const proxy = tunnelService.proxy;
        const detail = !proxy ? 'Proxy not attached'
          : proxy.channel?.readyState !== 'open' ? `DataChannel ${proxy.channel?.readyState || 'missing'}`
          : !proxy.ready ? 'Server manager not ready'
          : 'Unknown';
        setState('error');
        setErrorMsg(`VS Code Server not ready: ${detail}. Check WebRTC connection.`);
        return;
      }

      console.log('[CodeServerPanel] Tunnel ready, loading iframe');
      setState('loading');
    }

    init();
    return () => { cancelled = true; };
  }, [tunnelService]);

  // =========================================================================
  // WebSocket tunnel bridge: iframe postMessage ↔ VSCodeServerProxy
  // =========================================================================

  useEffect(() => {
    const proxy = tunnelService?.proxy;
    if (!proxy || (state !== 'ready' && state !== 'loading')) return;
    const iframeOrigin = getIframeOrigin();
    if (!iframeOrigin) return;

    // Track active WS tunnel subscriptions so we can clean up
    const unsubs = [];

    function postToIframe(message) {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage(message, iframeOrigin);
    }

    function onMessage(evt) {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || evt.source !== iframe.contentWindow) return;
      if (evt.origin !== iframeOrigin) return;

      const msg = evt.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (!msg.type.startsWith('synthi-ws-')) return;

      if (msg.type === 'synthi-ws-connect') {
        console.log('[CodeServerPanel] WS connect request:', msg.path);
        proxy.wsConnect(msg.path)
          .then(result => {
            const tunnelId = result.tunnelId;
            console.log('[CodeServerPanel] WS tunnel opened:', tunnelId);

            // Send connected message to iframe
            postToIframe({
              type: 'synthi-ws-connected',
              tunnelId,
              path: msg.path,
            });

            // Forward ws:data events to iframe
            const unData = proxy.on('ws:data', (tid, data, encoding) => {
              if (tid !== tunnelId) return;
              postToIframe({
                type: 'synthi-ws-data',
                tunnelId,
                data,
                binary: encoding === 'binary',
              });
            });
            unsubs.push(unData);

            // Forward ws:close events to iframe
            const unClose = proxy.on('ws:close', (tid, code) => {
              if (tid !== tunnelId) return;
              postToIframe({
                type: 'synthi-ws-close',
                tunnelId,
                code,
              });
            });
            unsubs.push(unClose);

            // Forward ws:error events to iframe
            const unError = proxy.on('ws:error', (tid, message) => {
              if (tid !== tunnelId) return;
              postToIframe({
                type: 'synthi-ws-error',
                tunnelId,
                message,
              });
            });
            unsubs.push(unError);
          })
          .catch(err => {
            console.error('[CodeServerPanel] WS connect failed:', err);
            postToIframe({
              type: 'synthi-ws-error',
              tunnelId: -1,
              message: err.message,
            });
          });
        return;
      }

      if (msg.type === 'synthi-ws-send' && msg.tunnelId != null) {
        proxy.wsSend(msg.tunnelId, msg.data, msg.binary).catch(err => {
          console.error('[CodeServerPanel] WS send failed:', err);
        });
        return;
      }

      if (msg.type === 'synthi-ws-close' && msg.tunnelId != null) {
        proxy.wsClose(msg.tunnelId, msg.code).catch(() => {});
        return;
      }
    }

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      for (const unsub of unsubs) { try { unsub(); } catch (_) {} }
    };
  }, [tunnelService, state, getIframeOrigin]);

  // Handle iframe events
  const handleLoad = useCallback(() => {
    console.log('[CodeServerPanel] iframe loaded');
    setState('ready');
  }, []);

  const handleError = useCallback(() => {
    console.error('[CodeServerPanel] iframe error');
    setState('error');
    setErrorMsg('Failed to load code-server UI');
  }, []);

  // Timeout: if iframe doesn't load within 30s, show error
  useEffect(() => {
    if (state !== 'loading') return;
    const timer = setTimeout(() => {
      setState((prev) => {
        if (prev === 'loading') {
          setErrorMsg('code-server UI timed out. Check console for Service Worker errors.');
          return 'error';
        }
        return prev;
      });
    }, 30000);
    return () => clearTimeout(timer);
  }, [state]);

  const retry = useCallback(() => {
    setState('initializing');
    if (iframeRef.current) {
      iframeRef.current.src = 'about:blank';
    }
    // Re-trigger init
    setTimeout(() => {
      if (iframeRef.current) {
        iframeRef.current.src = getIframeSrc();
        setState('loading');
      }
    }, 300);
  }, [getIframeSrc]);

  const popOut = useCallback(() => {
    window.open(getIframeSrc(), '_blank', 'width=1200,height=800');
  }, [getIframeSrc]);

  return (
    <div className={`relative flex flex-col bg-[#1e1e1e] ${className}`} style={style}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 bg-[#252526] border-b border-[#1a1b24] text-[11px] text-[#9ba2b8] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${
            state === 'ready' ? 'bg-emerald-400' :
            state === 'loading' || state === 'initializing' ? 'bg-blue-400 animate-pulse' :
            'bg-red-400'
          }`} />
          <span>
            {state === 'ready' ? 'VS Code Server — Connected' :
             state === 'loading' ? 'Loading code-server UI…' :
             state === 'initializing' ? 'Initializing tunnel…' :
             'Connection Error'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={retry}
            className="p-1 rounded hover:bg-[#3c3c3c] transition-colors"
            title="Reload"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={popOut}
            className="p-1 rounded hover:bg-[#3c3c3c] transition-colors"
            title="Open in new window"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 relative">
        {(state === 'initializing' || state === 'error') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center z-10 bg-[#1e1e1e]">
            {state === 'initializing' ? (
              <>
                <Loader2 className="w-8 h-8 text-blue-400 mb-3 animate-spin" />
                <div className="text-[13px] text-[#e8eaed] mb-1">Connecting to VS Code Server</div>
                <div className="text-[11px] text-[#6b7280]">
                  Registering HTTP tunnel…
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-8 h-8 text-red-400 mb-3" />
                <div className="text-[13px] text-[#e8eaed] mb-1">Connection Failed</div>
                <div className="text-[11px] text-[#6b7280] mb-3 text-center max-w-[300px]">
                  {errorMsg}
                </div>
                <button
                  onClick={retry}
                  className="px-3 py-1.5 text-[12px] bg-[#0e639c] text-white rounded hover:bg-[#1177bb] transition-colors"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}

        {state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#1e1e1e]/80">
            <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
          </div>
        )}

        {(state === 'loading' || state === 'ready') && (
          <iframe
            ref={iframeRef}
            src={getIframeSrc()}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write"
            onLoad={handleLoad}
            onError={handleError}
            title="VS Code Server"
          />
        )}
      </div>
    </div>
  );
}
