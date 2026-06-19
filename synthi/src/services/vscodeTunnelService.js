/**
 * VSCodeTunnelService
 *
 * Bridges the Service Worker (vscode-tunnel-sw.js) with VSCodeServerProxy
 * using BroadcastChannel for communication, avoiding the need for the
 * page to be "controlled" by the SW (eliminates controllerchange hang).
 *
 * Lifecycle:
 *   1. attach(proxy)  - connects to a VSCodeServerProxy instance
 *   2. register()     - registers the SW and starts listening on BroadcastChannel
 *   3. dispose()      - cleans up
 */

const SW_PATH = '/vscode-tunnel-sw.js';
const CHANNEL_NAME = 'vscode-tunnel';
const SW_ACTIVATION_TIMEOUT_MS = 5000;

class VSCodeTunnelService {
  constructor() {
    /** @type {import('../extensions/bridge/VSCodeServerProxy').default | null} */
    this.proxy = null;
    this._registered = false;
    this._channel = null;
  }

  /**
   * Register the Service Worker and set up BroadcastChannel listener.
   * No controllerchange wait — BroadcastChannel works without control.
   * @returns {Promise<boolean>}
   */
  async register() {
    if (this._registered) return true;

    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      console.warn('[VSCodeTunnel] Service Workers not supported');
      return false;
    }

    try {
      console.log('[VSCodeTunnel] Registering Service Worker...');
      const reg = await navigator.serviceWorker.register(SW_PATH, {
        scope: '/',
        updateViaCache: 'none',  // always fetch fresh SW script
      });
      console.log('[VSCodeTunnel] SW registered, scope:', reg.scope);

      // Force update to ensure latest SW code is used
      try { await reg.update(); } catch (_) {}

      // Wait for the SW to become active (but NOT for it to control this page)
      const sw = reg.active || reg.installing || reg.waiting;
      if (sw && sw.state !== 'activated') {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            sw.removeEventListener('statechange', check);
            console.warn('[VSCodeTunnel] SW activation wait timed out at state:', sw.state);
            resolve();
          }, SW_ACTIVATION_TIMEOUT_MS);
          const check = () => {
            if (sw.state === 'activated') {
              clearTimeout(timer);
              sw.removeEventListener('statechange', check);
              resolve();
            }
          };
          sw.addEventListener('statechange', check);
          if (sw.state === 'activated') {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      console.log('[VSCodeTunnel] SW is active');

      // Set up BroadcastChannel to receive proxy requests from SW
      if (this._channel) {
        try { this._channel.close(); } catch (_) {}
      }
      this._channel = new BroadcastChannel(CHANNEL_NAME);
      this._channel.addEventListener('message', (event) => {
        console.log('[VSCodeTunnel] BroadcastChannel message:', event.data?.type, event.data?.id);
        this._onRequest(event.data);
      });

      // FALLBACK: also listen on navigator.serviceWorker.onmessage
      // in case an older cached SW is still using client.postMessage
      navigator.serviceWorker.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg?.type === 'vscode-proxy-request') {
          console.log('[VSCodeTunnel] FALLBACK: Got proxy request via SW postMessage, id:', msg.id);
          this._onRequest(msg);
        }
      });

      this._registered = true;
      console.log('[VSCodeTunnel] BroadcastChannel + fallback listener ready');
      return true;
    } catch (err) {
      console.error('[VSCodeTunnel] Registration failed:', err);
      return false;
    }
  }

  /**
   * Attach a VSCodeServerProxy to forward HTTP requests through.
   * @param {import('../extensions/bridge/VSCodeServerProxy').default} proxy
   */
  attach(proxy) {
    this.proxy = proxy;
    console.log('[VSCodeTunnel] Proxy attached');
  }

  /**
   * Handle proxy request from SW via BroadcastChannel.
   */
  async _onRequest(msg) {
    if (!msg || msg.type !== 'vscode-proxy-request') return;

    const { id, method, path, headers, body } = msg;
    console.log('[VSCodeTunnel] Processing proxy request:', id, method, path);

    // Wait for the proxy to become ready (DataChannel open + workerReady)
    if (!this.proxy || !this.proxy.ready || this.proxy.channel?.readyState !== 'open') {
      // Brief wait: the proxy may still be connecting
      const ready = await this._waitForProxy(8000);
      if (!ready) {
        const reason = !this.proxy ? 'No proxy attached'
          : this.proxy.channel?.readyState !== 'open' ? `DataChannel ${this.proxy.channel?.readyState || 'missing'}`
          : 'Server manager not ready';
        console.warn('[VSCodeTunnel] Proxy not ready for request', id, '-', reason);
        this._respond({
          type: 'vscode-proxy-response',
          id,
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'retry-after': '2' },
          body: btoa(`Tunnel not ready: ${reason}`),
        });
        return;
      }
    }

    try {
      // Strip accept-encoding so code-server returns uncompressed responses.
      // Compressed bodies can't be inspected/injected browser-side.
      const cleanHeaders = { ...(headers || {}) };
      delete cleanHeaders['accept-encoding'];

      const result = await this.proxy.proxyHttp({
        method: method || 'GET',
        path: path || '/',
        headers: cleanHeaders,
        body: body || null,
      });

      const rh = result.headers || {};

      // Rewrite Location headers on redirects to stay within proxy prefix
      if (rh['location'] && result.status >= 300 && result.status < 400) {
        let loc = rh['location'];
        // Strip any absolute origin (http://127.0.0.1:PORT)
        try {
          const locUrl = new URL(loc, 'http://127.0.0.1');
          loc = locUrl.pathname + locUrl.search + locUrl.hash;
        } catch (_) {}
        // Ensure path goes through our proxy prefix
        if (!loc.startsWith('/__vscode-proxy__')) {
          rh['location'] = '/__vscode-proxy__' + (loc.startsWith('/') ? '' : '/') + loc;
          console.log('[VSCodeTunnel] Rewrote redirect Location to:', rh['location']);
        }
      }

      // Strip Content-Security-Policy so our injected WS shim script can execute
      delete rh['content-security-policy'];
      delete rh['content-security-policy-report-only'];

      // Inject WebSocket shim into HTML responses so code-server routes WS
      // through our postMessage tunnel instead of trying real WebSocket
      const ct = rh['content-type'] || '';
      if (ct.includes('text/html') && result.body) {
        try {
          const html = atob(result.body);
          if (html.includes('<head')) {
            let injections = '<script>' + VSCodeTunnelService._wsShimCode() + '</script>';

            // Sidebar-only mode: inject CSS + JS to hide everything except
            // the sidebar panel so we can embed extension views inline.
            if (path && path.includes('sidebarOnly=true')) {
              injections += VSCodeTunnelService._sidebarOnlyCode(path);
            }

            const injected = html.replace(/<head([^>]*)>/i, `<head$1>${injections}`);
            result.body = btoa(injected);
            console.log('[VSCodeTunnel] Injected WS shim into HTML response');
          } else {
            console.log('[VSCodeTunnel] HTML response - no <head> found');
          }
        } catch (injectErr) {
          console.warn('[VSCodeTunnel] WS shim injection failed:', injectErr);
        }
      }

      this._respond({
        type: 'vscode-proxy-response',
        id,
        status: result.status,
        statusText: result.statusText,
        headers: rh,
        body: result.body,
      });
    } catch (err) {
      console.error('[VSCodeTunnel] proxyHttp error:', err);
      this._respond({
        type: 'vscode-proxy-response',
        id,
        status: 502,
        statusText: 'Proxy Error',
        headers: {},
        body: btoa(err.message || 'Unknown error'),
      });
    }
  }

  /**
   * Send response back to SW via BroadcastChannel.
   */
  _respond(message) {
    console.log('[VSCodeTunnel] Sending response, id:', message.id, 'status:', message.status);
    if (this._channel) {
      this._channel.postMessage(message);
    }
    // Also try sending via SW controller in case old SW is listening
    try {
      navigator.serviceWorker?.controller?.postMessage(message);
    } catch (_) {}
  }

  /**
   * Whether the tunnel is ready to serve requests.
   * Checks that the SW is registered, proxy is attached, AND the proxy's
   * DataChannel is open with its server-manager marked ready.
   */
  get isReady() {
    return this._registered && this.proxy != null
      && this.proxy.ready
      && this.proxy.channel?.readyState === 'open';
  }

  /**
   * Wait up to `timeout` ms for the proxy to be fully ready.
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  async _waitForProxy(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.proxy && this.proxy.ready && this.proxy.channel?.readyState === 'open') {
        return true;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  dispose() {
    if (this._channel) {
      this._channel.close();
      this._channel = null;
    }
    this.proxy = null;
    this._registered = false;
  }

  /**
   * Returns the WebSocket shim JavaScript to inject into code-server HTML.
   * Overrides `window.WebSocket` so WS traffic goes through postMessage
   * → parent page → VSCodeServerProxy → DataChannel → backend → code-server.
   */
  static _wsShimCode() {
    return `
(function(){
  if(window.__synthiWsShim) return;
  window.__synthiWsShim = true;

  function TunnelWS(url, protocols){
    var self=this;
    this._tid=null;
    this._url=url;
    this.readyState=0;
    this.bufferedAmount=0;
    this.extensions='';
    this.protocol=typeof protocols==='string'?protocols:(Array.isArray(protocols)&&protocols[0])||'';
    this.binaryType='blob';
    this.onopen=null;
    this.onmessage=null;
    this.onerror=null;
    this.onclose=null;
    this._lsn={};
    this._sendChain=Promise.resolve();

    var parsed;
    try{parsed=new URL(url)}catch(e){parsed={pathname:'/',search:''}}
    var wsPath=parsed.pathname+parsed.search;
    this._path=wsPath;

    window.parent.postMessage({type:'synthi-ws-connect',path:wsPath},'*');

    var handler=function(evt){
      var m=evt.data;
      if(!m||typeof m.type!=='string')return;

      if(m.type==='synthi-ws-connected'&&self._tid===null&&m.path===self._path){
        self._tid=m.tunnelId;
        self.readyState=1;
        var oe=new Event('open');
        if(self.onopen)self.onopen(oe);
        self._fire('open',oe);
        return;
      }
      if(self._tid===null)return;

      if(m.type==='synthi-ws-data'&&m.tunnelId===self._tid){
        var me;
        if(m.binary){
          var b=atob(m.data),a=new Uint8Array(b.length);
          for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
          var d=self.binaryType==='blob'?new Blob([a.buffer]):a.buffer;
          me=new MessageEvent('message',{data:d});
        }else{
          me=new MessageEvent('message',{data:m.data});
        }
        if(self.onmessage)self.onmessage(me);
        self._fire('message',me);
        return;
      }

      if(m.type==='synthi-ws-close'&&m.tunnelId===self._tid){
        self.readyState=3;
        var ce=new CloseEvent('close',{code:m.code||1000,reason:''});
        if(self.onclose)self.onclose(ce);
        self._fire('close',ce);
        window.removeEventListener('message',handler);
        return;
      }

      if(m.type==='synthi-ws-error'&&m.tunnelId===self._tid){
        var ee=new Event('error');
        if(self.onerror)self.onerror(ee);
        self._fire('error',ee);
        return;
      }
    };
    window.addEventListener('message',handler);
  }

  TunnelWS.CONNECTING=0;TunnelWS.OPEN=1;TunnelWS.CLOSING=2;TunnelWS.CLOSED=3;

  function bytesToBase64(u8){
    var parts=[],chunkSize=0x8000;
    for(var i=0;i<u8.length;i+=chunkSize){
      parts.push(String.fromCharCode.apply(null,u8.subarray(i,i+chunkSize)));
    }
    return btoa(parts.join(''));
  }

  TunnelWS.prototype._emitError=function(){
    var ee=new Event('error');
    if(this.onerror)this.onerror(ee);
    this._fire('error',ee);
  };

  TunnelWS.prototype._queueSend=function(task){
    var self=this;
    this._sendChain=this._sendChain.then(function(){
      if(self.readyState!==1)return;
      return task();
    }).catch(function(){
      self._emitError();
    });
  };

  TunnelWS.prototype.send=function(data){
    if(this.readyState!==1)throw new DOMException('WebSocket not open','InvalidStateError');
    var self=this;
    if(typeof data==='string'){
      this._queueSend(function(){
        window.parent.postMessage({type:'synthi-ws-send',tunnelId:self._tid,data:data,binary:false},'*');
      });
    }
    else if(typeof Blob!=='undefined'&&data instanceof Blob){
      this._queueSend(function(){
        return data.arrayBuffer().then(function(buf){
          if(self.readyState!==1)return;
          window.parent.postMessage({type:'synthi-ws-send',tunnelId:self._tid,data:bytesToBase64(new Uint8Array(buf)),binary:true},'*');
        });
      });
    }
    else{
      var u8;
      if(data instanceof ArrayBuffer){
        u8=new Uint8Array(data);
      }else if(ArrayBuffer.isView(data)){
        u8=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      }else{
        throw new TypeError('Unsupported WebSocket payload');
      }
      this._queueSend(function(){
        window.parent.postMessage({type:'synthi-ws-send',tunnelId:self._tid,data:bytesToBase64(u8),binary:true},'*');
      });
    }
  };

  TunnelWS.prototype.close=function(code){
    if(this.readyState>=2)return;
    this.readyState=2;
    var self=this;
    this._sendChain.then(function(){
      window.parent.postMessage({type:'synthi-ws-close',tunnelId:self._tid,code:code||1000},'*');
    });
  };

  TunnelWS.prototype.addEventListener=function(t,fn){
    if(!this._lsn[t])this._lsn[t]=[];this._lsn[t].push(fn);
  };
  TunnelWS.prototype.removeEventListener=function(t,fn){
    if(!this._lsn[t])return;this._lsn[t]=this._lsn[t].filter(function(f){return f!==fn});
  };
  TunnelWS.prototype._fire=function(t,e){
    var a=this._lsn[t]||[];for(var i=0;i<a.length;i++){try{a[i](e)}catch(x){console.error(x)}}
  };

  Object.defineProperty(TunnelWS.prototype,'url',{get:function(){return this._url}});

  window.WebSocket=TunnelWS;
  console.log('[synthi-ws-shim] WebSocket shim installed');
})();
`;
  }

  /**
   * Returns CSS + JS to inject into code-server HTML when sidebarOnly=true.
   * Hides everything except the sidebar panel so the extension's contributed
   * views (tree views, webview panels) are shown inline within our UI.
   *
   * @param {string} path — the request path; may contain focusView= param
   */
  static _sidebarOnlyCode(path) {
    // Extract the focusView parameter (e.g. "github-pull-requests")
    let focusView = '';
    try {
      const match = path.match(/[?&]focusView=([^&]+)/);
      if (match) focusView = decodeURIComponent(match[1]);
    } catch (_) {}

    return `
<style id="synthi-sidebar-only">
  /* ── Hide everything except the sidebar content ────────────── */
  .part.editor,
  .part.panel,
  .part.statusbar,
  .part.titlebar,
  .part.auxiliarybar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
  }
  /* Make sidebar fill the entire viewport */
  .part.sidebar {
    position: fixed !important;
    left: 48px !important;
    top: 0 !important;
    width: calc(100vw - 48px) !important;
    height: 100vh !important;
    max-width: calc(100vw - 48px) !important;
    z-index: 99999 !important;
  }
  /* Keep the activity bar visible so users can still switch containers if
     the focus command doesn't activate the target view immediately. */
  .part.activitybar {
    position: fixed !important;
    left: 0 !important;
    top: 0 !important;
    width: 48px !important;
    height: 100vh !important;
    z-index: 100000 !important;
  }
  /* Ensure sidebar content layers are fully visible */
  .split-view-container,
  .composite.viewlet,
  .composite.viewlet > .content,
  .pane-body,
  .monaco-scrollable-element {
    width: 100% !important;
    max-width: 100% !important;
  }
  /* Hide the sidebar title bar (we show our own header) */
  .composite.title {
    display: none !important;
  }
  /* Transparent background to blend with parent */
  body, .monaco-workbench {
    background: transparent !important;
  }
</style>
<script>
(function(){
  var focusId = ${JSON.stringify(focusView)};
  if (!focusId) return;
  // After VS Code loads, try to focus the extension's sidebar panel
  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    if (attempts > 60) { clearInterval(timer); return; }
    // Try the standard VS Code command API if available
    try {
      if (typeof acquireVsCodeApi === 'function') {
        // running inside a webview, won't work here
      }
      // Use the workbench command palette approach:
      // VS Code exposes commands on the window for code-server
      var cmds = window._commandService || (window.vscode && window.vscode.commands);
      if (cmds && cmds.executeCommand) {
        cmds.executeCommand('workbench.view.extension.' + focusId);
        clearInterval(timer);
        return;
      }
      // Alternative: try accessing the layout service
      var wb = document.querySelector('.monaco-workbench');
      if (wb && wb.__view_container_id !== focusId) {
        // Click the matching activity bar icon if visible
        var icons = document.querySelectorAll('.action-item .codicon');
        if (icons.length > 0) {
          // Sidebar is rendering, wait a bit more for commands
        }
      }
    } catch(e) {}
  }, 500);
})();
</script>`;
  }
}

// Singleton
const vscodeTunnelService = new VSCodeTunnelService();
export default vscodeTunnelService;
