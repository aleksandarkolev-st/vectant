/**
 * Synthi Extension System - Main Thread Bridge
 * Coordinates extension system on the main thread.
 * Routes extensions to either the local web worker or the remote
 * Node.js extension host via WebRTC.
 */

import { WorkerProxy, getWorkerProxy } from './WorkerProxy.js';
import { WorkerToMainMethods } from './MessageProtocol.js';
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

    // ── VS Code Server (real Extension Host) ─────────────────
    /** @type {VSCodeServerProxy|null} */
    this.vscodeServerProxy = null;

    /** @type {boolean} */
    this.vscodeServerConnected = false;

    /** @type {Set<string>} Extension IDs installed on the VS Code Server */
    this.vscodeServerExtensions = new Set();

    /** @type {Function|null} Callback when server disconnects */
    this.onVSCodeServerDisconnected = null;
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
   * @returns {Promise<{success: boolean, extensionId: string}>}
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
   * Get connection info for the VS Code Server WebSocket endpoint.
   * @returns {Promise<object|null>}
   */
  async getVSCodeServerConnectionInfo() {
    if (!this.vscodeServerProxy?.isReady()) return null;
    return this.vscodeServerProxy.getConnectionInfo();
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
      if (this.vscodeServerExtensions.has(id)) continue; // already on VS Code Server

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
        const result = await this.installMarketplaceExtensionOnServer(info.id);
        if (result.success) {
          info.isActive = true;
          this.onExtensionStateChanged?.(info.id, 'active');
          console.log(`[MainThreadBridge] ✓ ${info.id} installed on VS Code Server`);

          // Emit synthetic webview events for webview-type views
          this._emitSyntheticWebviewEvents(info.id, info.manifest);
        } else {
          this.onExtensionStateChanged?.(info.id, 'pending-remote');
          console.warn(`[MainThreadBridge] ${info.id}: VS Code Server install returned unsuccessful`);
        }
      } catch (err) {
        console.warn(`[MainThreadBridge] ${info.id}: VS Code Server install failed:`, err.message);
        this.onExtensionStateChanged?.(info.id, 'pending-remote');
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

    // Forward tree view data from VS Code Server → UI
    this.vscodeServerProxy.on('treeData', (viewId, data) => {
      console.log(`[MainThreadBridge/vscode-server] treeData for ${viewId} (${data?.length || 0} items)`);
      this._emitRemoteContribution?.('treeData', { viewId, data });
    });

    // Forward webview creation from VS Code Server → UI
    this.vscodeServerProxy.on('createWebview', (viewId, viewType, title, opts) => {
      console.log(`[MainThreadBridge/vscode-server] createWebview: ${viewId}`);
      const extIdMatch = viewId.match(/^(.+?)\.(webview|webviewView)\./);
      const extensionId = extIdMatch ? extIdMatch[1] : opts?.extensionId;
      this._emitRemoteContribution?.('createWebview', { viewId, viewType, title, opts, extensionId });
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

    console.log('[MainThreadBridge] VS Code Server event handlers wired');
  }

  /**
   * After installing a Node-only extension on the VS Code Server, emit
   * synthetic webview events for any webview-type views defined in the
   * extension's manifest. This makes the UI show the webview panel (even if
   * we can't populate it with real HTML from code-server's Extension Host yet).
   *
   * @param {string} extensionId
   * @param {object} manifest
   */
  _emitSyntheticWebviewEvents(extensionId, manifest) {
    if (!manifest?.contributes?.views) return;

    for (const [containerId, views] of Object.entries(manifest.contributes.views)) {
      for (const view of views) {
        if (view.type === 'webview') {
          const viewId = `${extensionId}.webviewView.${view.id}`;
          console.log(`[MainThreadBridge] Emitting synthetic createWebview for ${viewId}`);
          this._emitRemoteContribution?.('createWebview', {
            viewId,
            viewType: view.id,
            title: view.name || view.id,
            opts: {},
            extensionId,
          });

          // Set a placeholder HTML indicating the extension runs on the server
          const placeholderHtml = `
            <html>
            <body style="font-family: system-ui, sans-serif; color: #ccc; padding: 16px; text-align: center;">
              <p style="font-size: 13px; margin-top: 40px;">
                This view is provided by <strong>${manifest.displayName || extensionId}</strong>
                running on the VS Code Server.
              </p>
              <p style="font-size: 11px; color: #888;">
                Extension Host bridge integration pending.
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
   * Determine if an extension should run on a remote host (VS Code Server or
   * legacy remote-ext-host).  Delegates to getExtensionHostTarget() so that
   * routing logic is defined in exactly one place.
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

    this.handlersRegistered = true;
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
