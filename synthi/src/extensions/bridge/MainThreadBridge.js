/**
 * Synthi Extension System - Main Thread Bridge
 * Coordinates extension system on the main thread.
 * Routes extensions to either the local web worker or the remote
 * Node.js extension host via WebRTC.
 */

import { WorkerProxy, getWorkerProxy } from './WorkerProxy.js';
import { WorkerToMainMethods, MainToWorkerMethodsExtended, createResponse } from './MessageProtocol.js';
import { VSCodeServerProxy } from './VSCodeServerProxy.js';

/**
 * @typedef {Object} ExtensionInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {boolean} isActive
 * @property {boolean} failed
 * @property {string|null} failedReason
 * @property {string[]} activationEvents
 * @property {object} manifest
 * @property {string} code
 */

export class MainThreadBridge {
  constructor() {
    /** @type {WorkerProxy} */
    this.workerProxy = getWorkerProxy();

    /** @type {string|null} */
    this.workerUrl = null;
    
    /** @type {Map<string, ExtensionInfo>} */
    this.extensions = new Map();
    
    /** @type {Map<string, Function>} */
    this.commandHandlers = new Map();
    
    /** @type {Set<string>} */
    this.extensionCommands = new Set();
    
    /** @type {Function|null} */
    this.onApplyEdit = null;
    
    /** @type {Function|null} */
    this.onShowMessage = null;
    
    /** @type {Function|null} */
    this.onSetDiagnostics = null;
    
    /** @type {Function|null} */
    this.onCreateWebview = null;
    
    /** @type {boolean} */
    this.initialized = false;
    
    /** @type {Map<string, object>} */
    this.pendingActivations = new Map();

    /** @type {boolean} */
    this.handlersRegistered = false;

    /** @type {Promise<void>|null} */
    this.restartPromise = null;

    /** @type {Function|null} Callback for extension state changes from rehydration */
    this.onExtensionStateChanged = null;

    /** @type {Function|null} Callback for showing quick pick UI */
    this.onShowQuickPick = null;

    /** @type {Function|null} Callback for showing input box UI */
    this.onShowInputBox = null;

    /** @type {Function|null} Callback for terminal creation */
    this.onCreateTerminal = null;

    /** @type {Function|null} Callback for debug session start */
    this.onStartDebugSession = null;

    /** @type {Function|null} Callback for task execution */
    this.onExecuteTask = null;

    /** @type {Function|null} Callback for FS operations from extensions */
    this.onFSOperation = null;

    /** @type {Function|null} Callback for configuration updates */
    this.onConfigUpdate = null;

    /** @type {import('./LanguageProviderBridge.js').LanguageProviderBridge|null} */
    this.languageProviderBridge = null;

    // ── VS Code Server (real Extension Host) ─────────────────
    /** @type {VSCodeServerProxy|null} */
    this.vscodeServerProxy = null;

    /** @type {boolean} */
    this.vscodeServerConnected = false;

    /** @type {Set<string>} Extension IDs installed on the VS Code Server */
    this.vscodeServerExtensions = new Set();

    /** @type {Function|null} Callback when server disconnects */
    this.onVSCodeServerDisconnected = null;

    /** @type {{treeViews: string[], webviews: string[]}} */
    this._remoteProviderSnapshot = { treeViews: [], webviews: [] };

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._remoteRefreshTimer = null;

    /** @type {number} */
    this._remoteLastRefreshAt = 0;

    /** @type {Map<string, number>} */
    this._emptyTreeRefreshCooldown = new Map();
  }

  /**
   * Initialize the extension system
   * @param {string} workerUrl
   * @returns {Promise<void>}
   */
  async init(workerUrl) {
    if (this.initialized) {
      console.warn('[MainThreadBridge] Already initialized');
      return;
    }

    this.workerUrl = workerUrl;

    // Set up event handlers before initializing worker
    this._setupEventHandlers();

    // Set up request handlers for worker→main RPC calls (showQuickPick, FS, etc.)
    this._setupRequestHandlers();

    // Initialize worker
    await this.workerProxy.init(workerUrl);
    
    this.initialized = true;
    console.log('[MainThreadBridge] Extension system initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VS Code Server (Real Extension Host) — Path A
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to the VS Code Server Manager via a WebRTC DataChannel.
   * The server manager handles downloading/starting the real VS Code Server
   * and installing extensions into it.
   *
   * @param {RTCDataChannel} channel - DataChannel created for the server manager
   * @returns {Promise<void>}
   */
  async connectVSCodeServer(channel) {
    if (this.vscodeServerProxy) {
      if (this.vscodeServerProxy.isReady()) {
        console.warn('[MainThreadBridge] VS Code Server already connected');
        return;
      }
      // Clean up stale proxy — use dispose() to keep DC open for reuse
      try { this.vscodeServerProxy.dispose(); } catch (_) {}
      this.vscodeServerProxy = null;
    }

    console.log('[MainThreadBridge] connectVSCodeServer: creating VSCodeServerProxy');
    this.vscodeServerProxy = new VSCodeServerProxy(channel);

    // Wire events
    this.vscodeServerProxy.on('serverStatus', (status, ...rest) => {
      console.log(`[MainThreadBridge/vscode-server] Status: ${status}`, ...rest);
      if (status === 'running') {
        this.vscodeServerConnected = true;
      } else if (status === 'stopped' || status === 'error') {
        this.vscodeServerConnected = false;
      }
    });

    this.vscodeServerProxy.on('extensionInstalled', (extensionId) => {
      console.log(`[MainThreadBridge/vscode-server] Extension installed: ${extensionId}`);
      this.vscodeServerExtensions.add(extensionId);
      this.onExtensionStateChanged?.(extensionId, 'active');
    });

    this.vscodeServerProxy.on('extensionUninstalled', (extensionId) => {
      console.log(`[MainThreadBridge/vscode-server] Extension uninstalled: ${extensionId}`);
      this.vscodeServerExtensions.delete(extensionId);
      this.onExtensionStateChanged?.(extensionId, 'uninstalled');
    });

    this.vscodeServerProxy.on('extensionInstallFailed', (extensionId, error) => {
      console.error(`[MainThreadBridge/vscode-server] Extension install failed: ${extensionId}:`, error);
      this.onExtensionStateChanged?.(extensionId, 'crashed', `Server install failed: ${error}`);
    });

    this.vscodeServerProxy.on('disconnected', () => {
      console.warn('[MainThreadBridge/vscode-server] Disconnected');
      this.vscodeServerConnected = false;
      this.vscodeServerProxy = null;

      // Mark server-installed extensions as pending
      for (const id of this.vscodeServerExtensions) {
        this.onExtensionStateChanged?.(id, 'pending-remote');
      }

      this.onVSCodeServerDisconnected?.();
    });

    try {
      await this.vscodeServerProxy.waitForReady(30000);
      console.log('[MainThreadBridge] VS Code Server Manager connected');

      // Wire contribution events from VS Code Server → UI
      this._setupRemoteEventHandlers();
    } catch (err) {
      console.error('[MainThreadBridge] VS Code Server Manager failed to connect:', err);
      // dispose() keeps the DataChannel open so retries reuse the same DC
      // and the Rust side doesn't kill & respawn the manager process.
      try { this.vscodeServerProxy.dispose(); } catch (_) {}
      this.vscodeServerProxy = null;
      throw err;
    }
  }

  /**
   * Start the VS Code Server for a workspace.
   * @param {string} slug - Workspace identifier
   * @param {object} [options]
   * @returns {Promise<{port: number, token: string}>}
   */
  async startVSCodeServer(slug, options = {}) {
    if (!this.vscodeServerProxy) {
      throw new Error('VS Code Server Manager not connected');
    }
    // Don't gate on isReady() — the proxy may have connected via getStatus
    // probe without a workerReady event.  The RPC itself will timeout if
    // the manager isn't actually running.
    if (this.vscodeServerProxy.channel?.readyState !== 'open') {
      throw new Error('VS Code Server DataChannel not open');
    }
    return this.vscodeServerProxy.startServer(slug, options);
  }

  /**
   * Install a VSIX into the real VS Code Server.
   * The server's Extension Host will load it automatically.
   *
   * @param {string} extensionId
   * @param {string} vsixBase64 - Base64-encoded VSIX data
   * @returns {Promise<{success: boolean, extensionId: string}>}
   */
  async installExtensionOnServer(extensionId, vsixBase64) {
    if (!this.vscodeServerProxy?.isReady()) {
      throw new Error('VS Code Server not connected');
    }

    const result = await this.vscodeServerProxy.installExtension(extensionId, vsixBase64);
    if (result.success) {
      this.vscodeServerExtensions.add(extensionId);
    }
    return result;
  }

  /**
   * Install an extension from the marketplace into the VS Code Server.
   * @param {string} extensionId - e.g. "dbaeumer.vscode-eslint"
   * @returns {Promise<{success: boolean, extensionId: string, uiBridged?: boolean}>}
   */
  async installMarketplaceExtensionOnServer(extensionId) {
    if (!this.vscodeServerProxy?.isReady()) {
      throw new Error('VS Code Server not connected');
    }

    const result = await this.vscodeServerProxy.installExtensionFromMarketplace(extensionId);
    if (result.success) {
      this.vscodeServerExtensions.add(extensionId);
    }
    return result;
  }

  /**
   * Load an already-installed extension into the Extension Host Bridge
   * for live UI event forwarding (tree data, webview HTML).
   *
   * @param {string} extensionId
   * @returns {Promise<{success: boolean, hasUI: boolean}>}
   */
  async loadExtensionForUI(extensionId) {
    if (!this.vscodeServerProxy?.isReady()) {
      throw new Error('VS Code Server not connected');
    }
    return this.vscodeServerProxy.loadExtensionForUI(extensionId);
  }

  /**
   * Get connection info for the VS Code Server WebSocket endpoint.
   * @returns {Promise<object|null>}
   */
  async getVSCodeServerConnectionInfo() {
    if (!this.vscodeServerProxy?.isReady()) return null;
    return this.vscodeServerProxy.getConnectionInfo();
  }

  /**
   * Install a stored extension candidate on the VS Code Server using the
   * original install source when available.
   *
   * @param {ExtensionInfo & {installSource?: string, vsixBase64?: string}} info
   * @returns {Promise<{success: boolean, extensionId: string, uiBridged?: boolean, error?: string}>}
   */
  async _installOnVSCodeServerFromInfo(info) {
    if (!info?.id) {
      throw new Error('Missing extension info for VS Code Server install');
    }

    if (info.vsixBase64) {
      return this.installExtensionOnServer(info.id, info.vsixBase64);
    }

    if (info.installSource === 'vsix') {
      throw new Error('Local VSIX bytes are unavailable; reinstall the .vsix file to upload it to the server.');
    }

    if (info.installSource === 'manual') {
      throw new Error('Manual code installs cannot run on the VS Code Server without a VSIX package.');
    }

    return this.installMarketplaceExtensionOnServer(info.id);
  }

  /**
   * Determine how a Node-only extension should be handled.
   * Returns 'vscode-server' if the VS Code Server is available,
   * or 'pending' if it's not connected yet.
   *
   * @param {object} manifest
   * @returns {'local'|'vscode-server'|'pending'}
   */
  getExtensionHostTarget(manifest) {
    // Browser extensions always run locally — unless too large for the worker
    if (manifest.browser) {
      const info = this.extensions.get(manifest.__extensionId || `${manifest.publisher}.${manifest.name}`);
      const codeLen = info?.code?.length || 0;
      if (codeLen <= 500_000) return 'local';
    }

    // Node-only or large extensions → VS Code Server only
    if (manifest.main) {
      if (this.vscodeServerProxy?.isReady() && this.vscodeServerConnected) {
        return 'vscode-server';
      }
      return 'pending';
    }

    // Extensions with extensionKind: ['workspace'] preference
    if (manifest.extensionKind) {
      const kinds = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
      if (kinds.includes('workspace') && !kinds.includes('ui')) {
        if (this.vscodeServerProxy?.isReady() && this.vscodeServerConnected) return 'vscode-server';
        return 'pending';
      }
    }

    return 'local';
  }

  /**
   * After the remote host connects, load and activate any Node-only extensions
   * that were waiting (stored but never loaded into any host).
   * If nodeCode is available on the manifest, send the real code.
   * If missing, attempt to re-fetch the VSIX from Open VSX.
   *
   * Calls this.onExtensionStateChanged(id, state) if set, so the hook
   * can update Redux.
   */
  async _rehydrateNodeOnlyExtensions() {
    const toRehydrate = [];
    for (const [id, info] of this.extensions) {
      if (info.remote) continue; // already on remote
      if (info.isActive) continue; // already active locally
      if (this.vscodeServerExtensions.has(id)) {
        // The server can announce/install an extension before Redux has
        // restored the matching frontend row. Do not leave that row stuck in
        // pending-remote; reconcile the bridge state and notify the UI.
        info.isActive = true;
        info.remote = true;
        this.onExtensionStateChanged?.(id, 'active');
        continue;
      }

      // Eligible: Node-only extensions, OR large-bundle extensions with main entry
      const isNodeOnly = info.manifest?.main && !info.manifest?.browser;
      const isTooLarge = info.code?.length > 500_000 && info.manifest?.main;
      if (!isNodeOnly && !isTooLarge) continue;
      toRehydrate.push(info);
    }

    if (toRehydrate.length === 0) return;
    console.log(`[MainThreadBridge] Rehydrating ${toRehydrate.length} Node-only extension(s):`,
      toRehydrate.map(i => i.id).join(', '));

    // ── Route to VS Code Server ───────────────────────────────
    if (!this.vscodeServerProxy?.isReady()) {
      console.warn('[MainThreadBridge] VS Code Server proxy not ready for rehydration — extensions remain pending');
      return;
    }
    if (!this.vscodeServerConnected) {
      console.warn('[MainThreadBridge] VS Code Server not yet started (vscodeServerConnected=false), cannot rehydrate yet');
      return;
    }

    console.log('[MainThreadBridge] VS Code Server available — routing rehydrated extensions there');
    for (const info of toRehydrate) {
      try {
        this.onExtensionStateChanged?.(info.id, 'activating');
        const result = await this._installOnVSCodeServerFromInfo(info);
        if (result.success) {
          info.isActive = true;
          info.remote = true;
          this.onExtensionStateChanged?.(info.id, 'active');
          console.log(`[MainThreadBridge] ✓ ${info.id} installed on VS Code Server`);
          // Emit synthetic webview events so the sidebar shows content
          // immediately while the preload bridge connects
          this._emitSyntheticWebviewEvents(info.id, info.manifest);
        } else {
          const reason = result.error || 'VS Code Server install returned unsuccessful';
          this.onExtensionStateChanged?.(info.id, 'crashed', reason);
          console.warn(`[MainThreadBridge] ${info.id}: ${reason}`);
        }
      } catch (err) {
        console.warn(`[MainThreadBridge] ${info.id}: VS Code Server install failed:`, err.message);
        this.onExtensionStateChanged?.(info.id, 'crashed', err.message);
      }
    }
  }

  /**
   * Check if an error is a WebRTC DataChannel transport failure
   * (as opposed to a real extension crash).
   */
  _isTransportError(err) {
    if (!err) return false;
    const msg = String(err.message || err).toLowerCase();
    return (
      msg.includes('datachannel') ||
      msg.includes('channel closed') ||
      msg.includes('disconnected') ||
      msg.includes('failure to send') ||
      msg.includes('sctp') ||
      msg.includes('transport')
    );
  }

  /**
   * Wire VS Code Server proxy events to the contribution pipeline.
   * Called after connectVSCodeServer succeeds.
   */
  _setupRemoteEventHandlers() {
    if (!this.vscodeServerProxy) return;

    const queueUniversalRefresh = (reason, delayMs = 350) => {
      const proxy = this.vscodeServerProxy;
      if (!proxy?.isReady()) return;

      if (this._remoteRefreshTimer) {
        clearTimeout(this._remoteRefreshTimer);
      }

      this._remoteRefreshTimer = setTimeout(async () => {
        const liveProxy = this.vscodeServerProxy;
        if (!liveProxy?.isReady()) return;

        // Guard against tight loops from rapid context churn.
        const now = Date.now();
        if (now - this._remoteLastRefreshAt < 250) {
          return;
        }
        this._remoteLastRefreshAt = now;

        try {
          await liveProxy.request('refreshAllTrees');
        } catch (err) {
          console.warn(`[MainThreadBridge] refreshAllTrees failed (${reason}):`, err.message);
        }

        // Refresh individual trees as a secondary fallback (some providers
        // react better to explicit per-view refresh requests).
        for (const viewId of this._remoteProviderSnapshot.treeViews || []) {
          liveProxy.request('refreshTreeData', [viewId]).catch(() => {});
        }

        // Always try resolving all registered webviews.
        for (const viewType of this._remoteProviderSnapshot.webviews || []) {
          liveProxy.request('resolveWebviewView', [viewType]).catch(() => {});
        }
      }, Math.max(0, delayMs));
    };

    // Forward tree view registration from VS Code Server → UI
    this.vscodeServerProxy.on('registerTreeView', (viewId, extensionId) => {
      console.log(`[MainThreadBridge/vscode-server] registerTreeView: ${viewId} (ext: ${extensionId})`);
      this._emitRemoteContribution?.('registerTreeView', { viewId, extensionId });
    });

    // Forward tree view data from VS Code Server → UI
    this.vscodeServerProxy.on('treeData', (viewId, data) => {
      console.log(`[MainThreadBridge/vscode-server] treeData for ${viewId} (${data?.length || 0} items)`);
      this._emitRemoteContribution?.('treeData', { viewId, data });

      // Universal fallback: when a provider repeatedly returns empty, ask
      // all providers to refresh after a short cooldown.
      if (Array.isArray(data) && data.length === 0) {
        const now = Date.now();
        const last = this._emptyTreeRefreshCooldown.get(viewId) || 0;
        if (now - last > 2000) {
          this._emptyTreeRefreshCooldown.set(viewId, now);
          queueUniversalRefresh(`empty-tree:${viewId}`, 900);
        }
      }
    });

    // Forward webview creation from VS Code Server → UI
    this.vscodeServerProxy.on('createWebview', (viewId, viewType, title, opts) => {
      console.log(`[MainThreadBridge/vscode-server] createWebview: ${viewId}`);
      const extIdMatch = viewId.match(/^(.+?)\.(webview|webviewView)\./);
      const extensionId = extIdMatch ? extIdMatch[1] : (typeof opts === 'object' ? opts?.extensionId : opts);
      this._emitRemoteContribution?.('createWebview', { viewId, viewType, title, opts: typeof opts === 'object' ? opts : {}, extensionId });
    });

    // Forward webview HTML updates from VS Code Server → UI
    this.vscodeServerProxy.on('updateWebview', (viewId, html) => {
      this._emitRemoteContribution?.('updateWebview', { viewId, html });
    });

    // Forward webview disposal from VS Code Server → UI
    this.vscodeServerProxy.on('disposeWebview', (viewId) => {
      this._emitRemoteContribution?.('disposeWebview', { viewId });
    });

    // Forward status bar items from VS Code Server → UI
    this.vscodeServerProxy.on('setStatusBar', (text, timeout) => {
      this._emitRemoteContribution?.('setStatusBar', { text, timeout });
    });

    // Forward openExternal requests → open URL in browser
    this.vscodeServerProxy.on('openExternal', (url) => {
      console.log(`[MainThreadBridge/vscode-server] openExternal: ${url}`);
      this._emitRemoteContribution?.('openExternal', { url });
      if (url && typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });

    // Forward authentication session requests to the browser.
    // When an extension requests a session with createIfNone/forceNewSession,
    // the headless extension host can't show login UI.  We emit an event
    // so the frontend can display an auth prompt or redirect.
    this.vscodeServerProxy.on('authSessionRequest', (data) => {
      console.log(`[MainThreadBridge/vscode-server] authSessionRequest:`, data);
      this._emitRemoteContribution?.('authSessionRequest', data);
    });

    // Forward extension notification messages → toast in browser
    this.vscodeServerProxy.on('extensionMessage', (data) => {
      console.log(`[MainThreadBridge/vscode-server] extensionMessage:`, data);
      this._emitRemoteContribution?.('extensionMessage', data);
    });

    this.vscodeServerProxy.on('authPrompt', (data) => {
      console.log(`[MainThreadBridge/vscode-server] authPrompt:`, data);
      this._emitRemoteContribution?.('authPrompt', data);
    });

    // Forward quick pick requests → frontend UI
    this.vscodeServerProxy.on('showQuickPick', (data) => {
      console.log(`[MainThreadBridge/vscode-server] showQuickPick:`, data);
      this._emitRemoteContribution?.('showQuickPick', data);
    });

    // Forward input box requests → frontend UI
    this.vscodeServerProxy.on('showInputBox', (data) => {
      console.log(`[MainThreadBridge/vscode-server] showInputBox:`, data);
      this._emitRemoteContribution?.('showInputBox', data);
    });

    // Forward context value changes (setContext) → UI
    // These control when-clause evaluation for view visibility.
    this.vscodeServerProxy.on('setContext', (data) => {
      console.log(`[MainThreadBridge/vscode-server] setContext: ${data?.key} = ${JSON.stringify(data?.value)}`);
      this._emitRemoteContribution?.('setContext', data);
      queueUniversalRefresh(`setContext:${data?.key || 'unknown'}`, 250);
    });

    // Forward clipboard writes → browser clipboard
    this.vscodeServerProxy.on('clipboardWrite', (text) => {
      console.log(`[MainThreadBridge/vscode-server] clipboardWrite: ${String(text).slice(0, 50)}`);
      this._emitRemoteContribution?.('clipboardWrite', { text });
    });

    // Forward explicit auth device codes when backend can extract them
    this.vscodeServerProxy.on('authDeviceCode', (data) => {
      console.log(`[MainThreadBridge/vscode-server] authDeviceCode: ${data?.code || 'unknown'}`);
      this._emitRemoteContribution?.('authDeviceCode', data);
    });

    this.vscodeServerProxy.on('authDeviceCodeMissing', (data) => {
      console.warn(`[MainThreadBridge/vscode-server] authDeviceCodeMissing: provider=${data?.providerId || 'unknown'}`);
      this._emitRemoteContribution?.('authDeviceCodeMissing', data);
    });

    this.vscodeServerProxy.on('uriHandlerRegistered', (data) => {
      console.log(`[MainThreadBridge/vscode-server] uriHandlerRegistered: ${data?.extensionId || 'unknown'}`);
      this._emitRemoteContribution?.('uriHandlerRegistered', data);
    });

    this.vscodeServerProxy.on('uriCallbackResult', (data) => {
      console.log(`[MainThreadBridge/vscode-server] uriCallbackResult: ok=${!!data?.ok} delivered=${data?.delivered || 0}`);
      this._emitRemoteContribution?.('uriCallbackResult', data);
    });

    // Forward extension progress → UI
    this.vscodeServerProxy.on('extensionProgress', (data) => {
      this._emitRemoteContribution?.('extensionProgress', data);
    });

    // Forward auth provider registration → UI
    this.vscodeServerProxy.on('authProviderRegistered', (data) => {
      console.log(`[MainThreadBridge/vscode-server] authProviderRegistered: ${data?.providerId}`);
      this._emitRemoteContribution?.('authProviderRegistered', data);
    });

    // Forward auth session changes → UI
    this.vscodeServerProxy.on('authSessionChanged', (data) => {
      console.log(`[MainThreadBridge/vscode-server] authSessionChanged: ${data?.providerId}`);
      this._emitRemoteContribution?.('authSessionChanged', data);
      queueUniversalRefresh(`authSessionChanged:${data?.providerId || 'unknown'}`, 250);
    });

    // Forward file dialog requests → UI
    this.vscodeServerProxy.on('showFileDialog', (data) => {
      console.log(`[MainThreadBridge/vscode-server] showFileDialog: ${data?.type}`);
      this._emitRemoteContribution?.('showFileDialog', data);
    });

    // Forward command execution failures → UI diagnostics
    this.vscodeServerProxy.on('commandExecutionFailed', (data) => {
      console.warn(`[MainThreadBridge/vscode-server] commandExecutionFailed: ${data?.commandId} (${data?.reason})`);
      this._emitRemoteContribution?.('commandExecutionFailed', data);
    });

    // When we receive a provider list, auto-resolve any webview views.
    // Code-server runs headless, so resolveWebviewView is never called
    // naturally — we explicitly trigger it for each registered provider.
    this.vscodeServerProxy.on('providerList', (treeViews, webviews) => {
      console.log(`[MainThreadBridge/vscode-server] providerList: ${treeViews?.length || 0} trees, ${webviews?.length || 0} webviews`);
      this._remoteProviderSnapshot = {
        treeViews: Array.isArray(treeViews) ? treeViews : [],
        webviews: Array.isArray(webviews) ? webviews : [],
      };

      if (webviews && webviews.length > 0) {
        for (const viewType of webviews) {
          console.log(`[MainThreadBridge/vscode-server] Auto-resolving webview view: ${viewType}`);
        }
      }

      queueUniversalRefresh('providerList', 150);
    });

    console.log('[MainThreadBridge] VS Code Server event handlers wired');
  }

  /**
   * After installing a Node-only extension on the VS Code Server, emit
   * synthetic webview events for any webview-type views defined in the
   * extension's manifest.  This creates the Redux entries and
   * WebviewManager iframes immediately so the sidebar shows content
   * instead of "Webview loading…".
   *
   * Uses viewType as viewId to match the convention used by the
   * ext-host-preload bridge (which also uses viewType as the key).
   * When the preload bridge later sends real HTML via updateWebview,
   * the iframe is updated in-place.
   *
   * @param {string} extensionId
   * @param {object} manifest
   */
  _emitSyntheticWebviewEvents(extensionId, manifest) {
    if (!manifest?.contributes?.views) return;

    for (const [containerId, views] of Object.entries(manifest.contributes.views)) {
      for (const view of views) {
        if (view.type === 'webview') {
          // Use viewType (== view.id) as the viewId — matches what the
          // ext-host-preload bridge sends in webviewProvider messages.
          const viewId = view.id;
          console.log(`[MainThreadBridge] Emitting synthetic createWebview for ${viewId} (ext: ${extensionId})`);
          this._emitRemoteContribution?.('createWebview', {
            viewId,
            viewType: view.id,
            title: view.name || view.id,
            opts: {},
            extensionId,
          });

          // Set a loading placeholder — the real HTML will arrive once
          // the extension activates on code-server and the preload bridge
          // relays the webview content.
          const displayName = manifest.displayName || extensionId;
          const placeholderHtml = `
            <html>
            <body style="font-family: system-ui, sans-serif; color: #9ba2b8; padding: 20px 16px; text-align: center; background: transparent;">
              <div style="margin-top: 24px;">
                <svg width="24" height="24" viewBox="0 0 24 24" style="animation: spin 1.5s linear infinite; margin: 0 auto;">
                  <style>@keyframes spin { 100% { transform: rotate(360deg); } }</style>
                  <circle cx="12" cy="12" r="10" stroke="#4a5060" stroke-width="2" fill="none" stroke-dasharray="40 60" />
                </svg>
              </div>
              <p style="font-size: 12px; margin-top: 12px; color: #e8eaed;">
                <strong>${displayName}</strong>
              </p>
              <p style="font-size: 11px; color: #6b7280; margin-top: 8px;">
                Connecting to remote extension host…
              </p>
            </body>
            </html>`;

          this._emitRemoteContribution?.('updateWebview', {
            viewId,
            html: placeholderHtml,
          });
        }
      }
    }
  }

  /**
   * Determine if an extension should run on a remote host (VS Code Server).
   * Delegates to getExtensionHostTarget() so that routing logic is defined
   * in exactly one place.
   */
  _shouldRunRemote(manifest) {
    const target = this.getExtensionHostTarget(manifest);
    return target !== 'local';
  }

  /**
   * Set up handlers for events from worker
   */
  _setupEventHandlers() {
    if (this.handlersRegistered) {
      return;
    }

    const proxy = this.workerProxy;

    // Command registration
    proxy.on(WorkerToMainMethods.REGISTER_COMMAND, (commandId, extensionId) => {
      this.extensionCommands.add(commandId);
      console.log(`[MainThreadBridge] Command registered: ${commandId} (${extensionId})`);
    });

    proxy.on(WorkerToMainMethods.UNREGISTER_COMMAND, (commandId) => {
      this.extensionCommands.delete(commandId);
    });

    // Text edits
    proxy.on(WorkerToMainMethods.APPLY_EDIT, (uri, edits) => {
      if (this.onApplyEdit) {
        this.onApplyEdit(uri, edits);
      }
    });

    // Messages
    proxy.on(WorkerToMainMethods.SHOW_MESSAGE, (type, message, options) => {
      if (this.onShowMessage) {
        this.onShowMessage(type, message, options);
      } else {
        // Fallback
        if (type === 'error') console.error(message);
        else if (type === 'warning') console.warn(message);
        else console.log(message);
      }
    });

    // Diagnostics
    proxy.on(WorkerToMainMethods.SET_DIAGNOSTICS, (uri, diagnostics, source) => {
      if (this.onSetDiagnostics) {
        this.onSetDiagnostics(uri, diagnostics, source);
      }
    });

    proxy.on(WorkerToMainMethods.CLEAR_DIAGNOSTICS, (uri, source) => {
      if (this.onSetDiagnostics) {
        this.onSetDiagnostics(uri, [], source);
      }
    });

    // Webviews
    proxy.on(WorkerToMainMethods.CREATE_WEBVIEW, (viewId, viewType, title, options) => {
      if (this.onCreateWebview) {
        this.onCreateWebview(viewId, viewType, title, options);
      }
    });

    proxy.on(WorkerToMainMethods.UPDATE_WEBVIEW, (viewId, update) => {
      // HTML content is applied to the WebviewManager iframe in index.js.
      // This handler exists for parity with _setupRemoteEventHandlers.
    });

    // Activation complete
    proxy.on(WorkerToMainMethods.ACTIVATION_COMPLETE, (extensionId, success, time, error) => {
      const info = this.extensions.get(extensionId);
      if (info) {
        info.isActive = success;
      }
      
      const pending = this.pendingActivations.get(extensionId);
      if (pending) {
        this.pendingActivations.delete(extensionId);
        if (success) {
          pending.resolve({ success: true, activationTime: time });
        } else {
          pending.reject(new Error(error || 'Activation failed'));
        }
      }
    });

    // Performance metrics
    proxy.on(WorkerToMainMethods.REPORT_METRICS, (metrics) => {
      this._handleMetrics(metrics);
    });

    // ─── Round-trip UI requests (showQuickPick / showInputBox) ─────────
    // These are 'request' type messages from the worker that expect a response.
    // The WorkerProxy dispatches them as events, but we need to reply via
    // the worker's postMessage with a response message.
    proxy.on(WorkerToMainMethods.SHOW_QUICK_PICK, (...args) => {
      // Worker sends this as a request (type: 'request'), handled here
      // The original message ID is captured by the worker's request() method
      // We handle the UI and respond via the standard response path
    });

    proxy.on(WorkerToMainMethods.SHOW_INPUT_BOX, (...args) => {
      // Same as above — handled by the request path
    });

    // ─── File system operations from extensions ───────────────────────
    proxy.on(WorkerToMainMethods.FS_READ_FILE, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.FS_WRITE_FILE, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.FS_STAT, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.FS_READ_DIR, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.FS_DELETE, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.FS_RENAME, (...args) => {
      // Handled via request path
    });

    // ─── Output channel events ────────────────────────────────────────
    proxy.on(WorkerToMainMethods.OUTPUT_APPEND, (channelName, text) => {
      console.log(`[Output:${channelName}] ${text}`);
    });
    proxy.on(WorkerToMainMethods.OUTPUT_CLEAR, (channelName) => {
      // UI should clear the output panel
    });
    proxy.on(WorkerToMainMethods.OUTPUT_SHOW, (channelName, preserveFocus) => {
      // UI should show the output panel
    });

    // ─── Storage operations ───────────────────────────────────────────
    proxy.on(WorkerToMainMethods.STORAGE_GET, (...args) => {
      // Handled via request path
    });
    proxy.on(WorkerToMainMethods.STORAGE_SET, (...args) => {
      // fire-and-forget
    });

    // ─── Debug namespace events ───────────────────────────────────────
    proxy.on(WorkerToMainMethods.DEBUG_START_SESSION, (config) => {
      if (this.onStartDebugSession) this.onStartDebugSession(config);
    });
    proxy.on(WorkerToMainMethods.DEBUG_STOP_SESSION, (sessionId) => {
      console.log(`[MainThreadBridge] Debug session stop requested: ${sessionId}`);
    });
    proxy.on(WorkerToMainMethods.DEBUG_ADD_BREAKPOINT, (breakpoint) => {
      console.log(`[MainThreadBridge] Debug breakpoint added:`, breakpoint);
    });
    proxy.on(WorkerToMainMethods.DEBUG_REMOVE_BREAKPOINT, (breakpoint) => {
      console.log(`[MainThreadBridge] Debug breakpoint removed:`, breakpoint);
    });
    proxy.on(WorkerToMainMethods.DEBUG_REGISTER_PROVIDER, (type, extensionId) => {
      console.log(`[MainThreadBridge] Debug config provider registered: ${type} by ${extensionId}`);
    });

    // ─── Task namespace events ────────────────────────────────────────
    proxy.on(WorkerToMainMethods.TASK_REGISTER_PROVIDER, (type, extensionId) => {
      console.log(`[MainThreadBridge] Task provider registered: ${type} by ${extensionId}`);
    });
    proxy.on(WorkerToMainMethods.TASK_EXECUTE, (task) => {
      if (this.onExecuteTask) this.onExecuteTask(task);
    });

    // ─── SCM namespace events ─────────────────────────────────────────
    proxy.on(WorkerToMainMethods.SCM_CREATE_SOURCE_CONTROL, (id, label, rootUri) => {
      console.log(`[MainThreadBridge] SCM source control created: ${id} (${label})`);
    });
    proxy.on(WorkerToMainMethods.SCM_UPDATE, (id, update) => {
      console.log(`[MainThreadBridge] SCM update: ${id}`);
    });
    proxy.on(WorkerToMainMethods.SCM_DISPOSE, (id) => {
      console.log(`[MainThreadBridge] SCM disposed: ${id}`);
    });

    // ─── Terminal namespace events ────────────────────────────────────
    proxy.on(WorkerToMainMethods.TERMINAL_CREATE, (terminalId, name, shellPath, shellArgs) => {
      console.log(`[MainThreadBridge] Terminal created: ${name} (${terminalId})`);
      if (this.onCreateTerminal) {
        this.onCreateTerminal(terminalId, name, shellPath, shellArgs);
      }
    });
    proxy.on(WorkerToMainMethods.TERMINAL_SEND_TEXT, (terminalId, text, addNewLine) => {
      console.log(`[MainThreadBridge] Terminal send text: ${terminalId}`);
    });
    proxy.on(WorkerToMainMethods.TERMINAL_DISPOSE, (terminalId) => {
      console.log(`[MainThreadBridge] Terminal disposed: ${terminalId}`);
    });

    // ─── Authentication namespace events ──────────────────────────────
    proxy.on(WorkerToMainMethods.AUTH_REGISTER_PROVIDER, (providerId, extensionId) => {
      console.log(`[MainThreadBridge] Auth provider registered: ${providerId} by ${extensionId}`);
    });

    // ─── Configuration write events ───────────────────────────────────
    proxy.on(WorkerToMainMethods.CONFIG_UPDATE, (section, value, target) => {
      console.log(`[MainThreadBridge] Config update: ${section} = ${JSON.stringify(value)}`);
      if (this.onConfigUpdate) this.onConfigUpdate(section, value, target);
    });

    // ─── Tree view events ─────────────────────────────────────────────
    proxy.on(WorkerToMainMethods.TREE_VIEW_REGISTER, (viewId, extensionId) => {
      console.log(`[MainThreadBridge] Tree view registered: ${viewId} by ${extensionId}`);
      // Already handled by index.js via proxy.on('registerTreeView')
    });
    proxy.on(WorkerToMainMethods.TREE_VIEW_UPDATE, (viewId, data) => {
      // Already handled by index.js via proxy.on('treeData')
    });
    proxy.on(WorkerToMainMethods.TREE_VIEW_REVEAL, (viewId, element) => {
      console.log(`[MainThreadBridge] Tree view reveal: ${viewId}`);
    });

    // ─── Status bar ──────────────────────────────────────────────────
    proxy.on(WorkerToMainMethods.SET_STATUS_BAR, (text, tooltip, command) => {
      // Already handled by index.js via proxy.on('setStatusBar')
    });

    // ─── Webview messages ─────────────────────────────────────────────
    proxy.on(WorkerToMainMethods.POST_WEBVIEW_MESSAGE, (viewId, message) => {
      // Route message to the webview iframe
    });

    this.handlersRegistered = true;
  }

  /**
   * Set up request handlers for worker→main RPC calls.
   * These handle 'request' type messages from the worker that expect a response.
   */
  _setupRequestHandlers() {
    const proxy = this.workerProxy;

    // ─── Round-trip UI: showQuickPick ─────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.SHOW_QUICK_PICK, async (args) => {
      const [items, options] = args;
      if (this.onShowQuickPick) {
        return await this.onShowQuickPick(items, options);
      }
      // Fallback: return first item or undefined
      return items?.[0] || undefined;
    });

    // ─── Round-trip UI: showInputBox ──────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.SHOW_INPUT_BOX, async (args) => {
      const [options] = args;
      if (this.onShowInputBox) {
        return await this.onShowInputBox(options);
      }
      return undefined;
    });

    // ─── Active editor request ────────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.GET_ACTIVE_EDITOR, async () => {
      // Return current editor metadata
      // TODO: wire to MonacoBridge to get actual editor state
      return null;
    });

    // ─── File system operations ───────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.FS_READ_FILE, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('readFile', args);
      throw new Error('FS readFile not supported (no handler registered)');
    });

    proxy.onRequest(WorkerToMainMethods.FS_WRITE_FILE, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('writeFile', args);
      throw new Error('FS writeFile not supported (no handler registered)');
    });

    proxy.onRequest(WorkerToMainMethods.FS_STAT, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('stat', args);
      throw new Error('FS stat not supported (no handler registered)');
    });

    proxy.onRequest(WorkerToMainMethods.FS_READ_DIR, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('readDir', args);
      throw new Error('FS readDir not supported (no handler registered)');
    });

    proxy.onRequest(WorkerToMainMethods.FS_DELETE, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('delete', args);
      throw new Error('FS delete not supported (no handler registered)');
    });

    proxy.onRequest(WorkerToMainMethods.FS_RENAME, async (args) => {
      if (this.onFSOperation) return await this.onFSOperation('rename', args);
      throw new Error('FS rename not supported (no handler registered)');
    });

    // ─── Storage ──────────────────────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.STORAGE_GET, async (args) => {
      const { getStorageService } = await import('../services/StorageService.js');
      const storage = getStorageService();
      return storage.get(args[0] /* key */);
    });

    // ─── Auth session ─────────────────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.AUTH_GET_SESSION, async (args) => {
      const [extensionId, providerId, scopes, options] = args || [];
      if (this.vscodeServerProxy && this.vscodeServerConnected) {
        try {
          return await this.vscodeServerProxy.request('authGetSession', [
            extensionId,
            providerId,
            scopes,
            options || {},
          ]);
        } catch (err) {
          console.warn(`[MainThreadBridge] AUTH_GET_SESSION via vscode-server failed: ${err?.message || err}`);
        }
      }
      return null;
    });

    // ─── Task execution ───────────────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.TASK_EXECUTE, async (args) => {
      if (this.onExecuteTask) return await this.onExecuteTask(args[0]);
      throw new Error('Task execution not supported (no handler registered)');
    });

    // ─── Debug start ──────────────────────────────────────────────────
    proxy.onRequest(WorkerToMainMethods.DEBUG_START_SESSION, async (args) => {
      if (this.onStartDebugSession) return await this.onStartDebugSession(args[0], args[1]);
      throw new Error('Debug not supported (no handler registered)');
    });
  }

  /**
   * Handle performance metrics from extensions
   * @param {object} metrics
   */
  _handleMetrics(metrics) {
    // Check for violations
    if (metrics.violations && metrics.violations.length > 0) {
      for (const violation of metrics.violations) {
        console.warn(
          `[MainThreadBridge] Performance violation: ${violation.extensionId} ` +
          `${violation.type} (${violation.value}/${violation.limit})`
        );

        // Auto-suspend after 3 violations
        const info = this.extensions.get(violation.extensionId);
        if (info && info.violationCount >= 3) {
          console.error(`[MainThreadBridge] Suspending ${violation.extensionId} due to violations`);
          this.suspendExtension(violation.extensionId);
        }
      }
    }
  }

  /**
   * Register an extension
   * @param {string} extensionId
   * @param {object} manifest
   * @param {string} code
   * @returns {Promise<void>}
   */
  async registerExtension(extensionId, manifest, code) {
    if (this.extensions.has(extensionId)) {
      // Already registered — unregister the old version first
      console.log(`[MainThreadBridge] Re-registering ${extensionId} (already loaded)`);
      try {
        await this.deactivateExtension(extensionId);
      } catch (_) { /* may not be active */ }
      this.extensions.delete(extensionId);
    }

    // Store extension info
    this.extensions.set(extensionId, {
      id: extensionId,
      name: manifest.name,
      displayName: manifest.displayName || manifest.name,
      version: manifest.version,
      isActive: false,
      failed: false,
      failedReason: null,
      activationEvents: manifest.activationEvents || [],
      violationCount: 0,
      manifest,
      code,
      remote: false, // set below if routed to remote host
    });

    // ── Route decision: local worker vs VS Code Server ──
    const hostTarget = this.getExtensionHostTarget(manifest);
    const isNodeOnly = manifest.main && !manifest.browser;
    const isTooLargeForWorker = code && code.length > 500_000 && manifest.main;

    // Node-only extensions OR extensions with huge browser bundles:
    // store info — they'll be installed on the VS Code Server
    // via _rehydrateNodeOnlyExtensions when the server connects.
    if (isNodeOnly || isTooLargeForWorker) {
      if (hostTarget === 'vscode-server') {
        // Server is ready — install immediately
        console.log(`[MainThreadBridge] ${extensionId}: installing on VS Code Server`);
        try {
          const result = await this.installMarketplaceExtensionOnServer(extensionId);
          if (result.success) {
            const info = this.extensions.get(extensionId);
            if (info) info.isActive = true;
            return;
          }
        } catch (err) {
          console.warn(`[MainThreadBridge] ${extensionId}: VS Code Server install failed:`, err.message);
        }
      }
      console.log(
        `[MainThreadBridge] ${extensionId}: ${isNodeOnly ? 'Node-only' : `bundle too large (${code.length} chars)`}, ` +
        'stored (waiting for VS Code Server)'
      );
      return;
    }

    const proxy = this.workerProxy;
    const label = 'worker';
    const codeForHost = code;

    // Load into the worker — if this times out, handle accordingly.
    try {
      await proxy.loadExtension(extensionId, codeForHost, manifest);
    } catch (loadErr) {
      if (loadErr.message && loadErr.message.includes('timeout')) {
        console.error(
          `[MainThreadBridge] loadExtension timeout for ${extensionId} (${label}). ` +
          'The extension\'s bundle hung during eval. Restarting worker.'
        );
        this._markExtensionFailed(extensionId, `Load timeout: bundle hung during eval (${label})`);
        await this._restartWorker(extensionId, 'load_timeout');
        throw new Error(`Load timeout: ${extensionId} bundle hung during eval (${label}, worker restarted)`);
      }
      throw loadErr;
    }
    
    console.log(`[MainThreadBridge] Extension registered: ${extensionId}`);
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number }>}
   */
  async activateExtension(extensionId) {
    const info = this.extensions.get(extensionId);
    if (!info) {
      throw new Error(`Extension ${extensionId} not registered`);
    }

    if (info.failed) {
      throw new Error(info.failedReason || `Extension ${extensionId} is permanently disabled after a hard failure`);
    }

    if (info.isActive) {
      return { success: true, activationTime: 0 };
    }

    // Route to the correct proxy (VS Code Server extensions are
    // activated server-side, so only local worker extensions here)
    try {
      return await this.workerProxy.activateExtension(extensionId);
    } catch (err) {
      if (err.code === 'ACTIVATION_TIMEOUT') {
        await this._handleActivationTimeout(extensionId, err);
        throw new Error(
          `Activation hard-timeout for ${extensionId}. Worker was restarted and the extension has been disabled.`
        );
      }
      throw err;
    }
  }

  /**
   * Deactivate an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async deactivateExtension(extensionId) {
    const info = this.extensions.get(extensionId);
    if (!info || !info.isActive) return;

    await this.workerProxy.deactivateExtension(extensionId);
    info.isActive = false;
  }

  /**
   * Suspend an extension (pause execution)
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async suspendExtension(extensionId) {
    await this.workerProxy.suspendExtension(extensionId);
  }

  /**
   * Check if a command is from an extension
   * @param {string} commandId
   * @returns {boolean}
   */
  isExtensionCommand(commandId) {
    return this.extensionCommands.has(commandId);
  }

  /**
   * Execute an extension command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async executeCommand(commandId, ...args) {
    if (!this.extensionCommands.has(commandId)) {
      throw new Error(`Unknown command: ${commandId}`);
    }

    return this.workerProxy.executeCommand(commandId, ...args);
  }

  /**
   * Trigger activation for extensions matching an event
   * @param {string} event - e.g., 'onLanguage:javascript'
   * @returns {Promise<void>}
   */
  async triggerActivation(event) {
    const toActivate = [];

    for (const [id, info] of this.extensions) {
      if (info.isActive) continue;
      if (info.failed) continue;

      for (const activationEvent of info.activationEvents) {
        if (this._matchesActivationEvent(activationEvent, event)) {
          toActivate.push(id);
          break;
        }
      }
    }

    // Activate in parallel
    await Promise.allSettled(
      toActivate.map(id => this.activateExtension(id))
    );
  }

  /**
   * Check if activation event matches
   * @param {string} pattern
   * @param {string} event
   * @returns {boolean}
   */
  _matchesActivationEvent(pattern, event) {
    // Exact match
    if (pattern === event) return true;

    // Pattern matching
    const [patternType, patternValue] = pattern.split(':');
    const [eventType, eventValue] = event.split(':');

    if (patternType !== eventType) return false;
    if (!patternValue) return true;
    if (patternValue === eventValue) return true;

    return false;
  }

  /**
   * Notify extensions of document open
   * @param {object} document
   */
  notifyDocumentOpen(document) {
    // Trigger onLanguage activation
    this.triggerActivation(`onLanguage:${document.languageId}`);
    
    this.workerProxy.notifyDocumentOpen(document);
  }

  /**
   * Notify extensions of document change
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  notifyDocumentChange(uri, changes, version) {
    this.workerProxy.notifyDocumentChange(uri, changes, version);
  }

  /**
   * Notify extensions of document close
   * @param {string} uri
   */
  notifyDocumentClose(uri) {
    this.workerProxy.notifyDocumentClose(uri);
  }

  /**
   * Notify extensions of selection change
   * @param {string} uri
   * @param {object[]} selections
   */
  notifySelectionChange(uri, selections) {
    this.workerProxy.notifySelectionChange(uri, selections);
  }

  /**
   * Get all registered extensions
   * @returns {ExtensionInfo[]}
   */
  getExtensions() {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extension states without hitting the worker (main thread authoritative)
   * @returns {Array<{ extensionId: string, state: string, manifest: object, commands: string[], failedReason: string|null }>}
   */
  getExtensionStates() {
    const states = [];

    for (const [id, info] of this.extensions) {
      const state = info.failed ? 'failed' : (info.isActive ? 'active' : 'loaded');
      const commands = [];

      // Collect contributed commands if present in manifest
      const manifestCommands = info.manifest?.contributes?.commands || [];
      for (const cmd of manifestCommands) {
        if (cmd?.command) {
          commands.push(cmd.command);
        }
      }

      states.push({
        extensionId: id,
        manifest: info.manifest,
        state,
        activationEvents: info.activationEvents,
        commands,
        failedReason: info.failedReason || null,
        remote: this.vscodeServerExtensions.has(id),
      });
    }

    return states;
  }

  /**
   * Get extension info
   * @param {string} extensionId
   * @returns {ExtensionInfo|undefined}
   */
  getExtension(extensionId) {
    return this.extensions.get(extensionId);
  }

  /**
   * Shutdown the extension system
   */
  async shutdown() {
    // Deactivate all extensions
    for (const [id, info] of this.extensions) {
      if (info.isActive) {
        try {
          await this.deactivateExtension(id);
        } catch (err) {
          console.error(`Failed to deactivate ${id}:`, err);
        }
      }
    }

    // Terminate worker
    this.workerProxy.terminate();

    // Terminate VS Code Server proxy
    if (this.vscodeServerProxy) {
      try { await this.vscodeServerProxy.stopServer(); } catch (_) {}
      this.vscodeServerProxy.terminate();
      this.vscodeServerProxy = null;
      this.vscodeServerConnected = false;
    }

    this.extensions.clear();
    this.extensionCommands.clear();
    this.pendingActivations.clear();
    this.vscodeServerExtensions.clear();
    this.initialized = false;
    this.workerUrl = null;
  }

  /**
   * Handle an activation timeout by marking the extension as failed and restarting the worker
   * @param {string} extensionId
   * @param {Error} err
   */
  async _handleActivationTimeout(extensionId, err) {
    console.error(
      `[MainThreadBridge] Activation timeout for ${extensionId}: ${err?.message || 'unknown error'}. ` +
      'Restarting extension host worker.'
    );

    this._markExtensionFailed(extensionId, 'Activation hard timeout');
    await this._restartWorker(extensionId, 'activation_timeout');
  }

  /**
   * Mark an extension as permanently failed
   * @param {string} extensionId
   * @param {string} reason
   */
  _markExtensionFailed(extensionId, reason) {
    const info = this.extensions.get(extensionId);
    if (!info) return;

    info.failed = true;
    info.failedReason = reason;
    info.isActive = false;
  }

  /**
   * Restart the extension host worker and reload healthy extensions
   * @param {string|null} failedExtensionId
   * @param {string} reason
   */
  async _restartWorker(failedExtensionId, reason) {
    if (!this.workerUrl) {
      console.warn('[MainThreadBridge] Cannot restart worker before initialization');
      return;
    }

    if (this.restartPromise) {
      return this.restartPromise;
    }

    const doRestart = async () => {
      this.workerProxy.beginRestart();
      // Clear any pending activation waiters
      this.pendingActivations.clear();
      this.extensionCommands.clear();

      // Terminate poisoned worker
      this.workerProxy.terminate();

      console.warn(
        `[MainThreadBridge] Restarting extension host worker due to ${reason}` +
        (failedExtensionId ? ` (failed: ${failedExtensionId})` : '')
      );

      // Spin up fresh worker
      await this.workerProxy.init(this.workerUrl);

      // Reload healthy extensions (only local worker extensions)
      for (const [id, info] of this.extensions) {
        if (info.failed || id === failedExtensionId) {
          info.isActive = false;
          continue;
        }

        // Skip extensions managed by VS Code Server
        if (this.vscodeServerExtensions.has(id)) continue;

        try {
          // Skip Node-only extensions and large-bundle extensions — they don't belong in the worker
          const isNodeOnly = info.manifest?.main && !info.manifest?.browser;
          const isTooLarge = info.code?.length > 500_000 && info.manifest?.main;
          if (isNodeOnly || isTooLarge) continue;

          await this.workerProxy.loadExtension(id, info.code, info.manifest);
          if (info.isActive) {
            try {
              const result = await this.workerProxy.activateExtension(id);
              info.isActive = !!result?.success;
            } catch (activateErr) {
              console.error(
                `[MainThreadBridge] Failed to reactivate ${id} after restart:`,
                activateErr
              );
              this._markExtensionFailed(
                id,
                `Reactivation failed after worker restart: ${activateErr.message}`
              );
            }
          }
        } catch (err) {
          console.error(`[MainThreadBridge] Failed to reload ${id} after restart:`, err);
          this._markExtensionFailed(
            id,
            `Reload failed after worker restart: ${err.message}`
          );
        }
      }
    };

    this.restartPromise = doRestart().finally(() => {
      this.restartPromise = null;
    });

    return this.restartPromise;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the MainThreadBridge singleton
 * @returns {MainThreadBridge}
 */
export function getMainThreadBridge() {
  if (!instance) {
    instance = new MainThreadBridge();
  }
  return instance;
}

/**
 * Create a new MainThreadBridge (for testing)
 * @returns {MainThreadBridge}
 */
export function createMainThreadBridge() {
  return new MainThreadBridge();
}
