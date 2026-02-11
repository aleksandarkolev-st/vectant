/**
 * Synthi Extension System - Main Thread Bridge
 * Coordinates extension system on the main thread.
 * Routes extensions to either the local web worker or the remote
 * Node.js extension host via WebRTC.
 */

import { WorkerProxy, getWorkerProxy } from './WorkerProxy.js';
import { WorkerToMainMethods } from './MessageProtocol.js';
import { RemoteExtHostProxy } from './RemoteExtHostProxy.js';
import { fetchNodeCodeForExtension } from '../loader/ExtensionInstaller.js';

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

    // ── Remote Extension Host ──────────────────────────────────
    /** @type {RemoteExtHostProxy|null} */
    this.remoteProxy = null;

    /** @type {Set<string>} Extension IDs routed to the remote host */
    this.remoteExtensions = new Set();

    /** @type {boolean} */
    this.remoteHandlersRegistered = false;

    /** @type {Function|null} Callback for extension state changes from rehydration */
    this.onExtensionStateChanged = null;
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

  /**
   * Connect the remote Node.js extension host via a WebRTC DataChannel.
   * Call this once the CompilerClient is connected.
   *
   * @param {RTCDataChannel} channel - DataChannel created by compilerClient.createExtHostChannel()
   * @returns {Promise<void>}
   */
  async connectRemoteHost(channel) {
    if (this.remoteProxy) {
      // If we already have a connected proxy, skip
      if (this.remoteProxy.ready) {
        console.warn('[MainThreadBridge] Remote host already connected and ready');
        return;
      }
      // If we have a proxy but it's still connecting or terminated,
      // clean it up and try fresh
      console.warn('[MainThreadBridge] Cleaning up stale remoteProxy (state:', this.remoteProxy.state, ')');
      try { this.remoteProxy.terminate(); } catch (_) {}
      this.remoteProxy = null;
      this.remoteHandlersRegistered = false;
    }

    console.log('[MainThreadBridge] connectRemoteHost: creating RemoteExtHostProxy, channel state:', channel.readyState, 'label:', channel.label);
    this.remoteProxy = new RemoteExtHostProxy(channel);
    this._setupRemoteEventHandlers();

    try {
      console.log('[MainThreadBridge] connectRemoteHost: waiting for remote host to signal ready (25s timeout)...');
      await this.remoteProxy.waitForReady(25000);
      console.log('[MainThreadBridge] Remote extension host connected');

      // Re-route Node-only extensions that were loaded as stubs because the
      // remote host wasn't available at restore time.
      await this._rehydrateNodeOnlyExtensions();
    } catch (err) {
      console.error('[MainThreadBridge] Remote extension host failed to connect:', err);
      try { this.remoteProxy.terminate(); } catch (_) {}
      this.remoteProxy = null;
      this.remoteHandlersRegistered = false;
      throw err;
    }
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

      // Eligible: Node-only extensions, OR large-bundle extensions with main entry
      const isNodeOnly = info.manifest?.main && !info.manifest?.browser;
      const isTooLarge = info.code?.length > 500_000 && info.manifest?.main;
      if (!isNodeOnly && !isTooLarge) continue;
      toRehydrate.push(info);
    }

    if (toRehydrate.length === 0) return;
    console.log(`[MainThreadBridge] Loading ${toRehydrate.length} Node-only extension(s) on remote host:`,
      toRehydrate.map(i => i.id).join(', '));

    for (const info of toRehydrate) {
      try {
        let nodeCode = info.manifest._nodeCode;

        // If no nodeCode is cached, try to re-fetch from Open VSX
        if (!nodeCode) {
          console.log(`[MainThreadBridge] ${info.id}: no nodeCode cached, fetching from Open VSX...`);
          nodeCode = await fetchNodeCodeForExtension(info.id, info.manifest);
          if (nodeCode) {
            info.manifest._nodeCode = nodeCode;
          } else {
            console.warn(`[MainThreadBridge] ${info.id}: could not fetch nodeCode, skipping`);
            this.onExtensionStateChanged?.(info.id, 'crashed', 'No Node.js code available');
            continue;
          }
        }

        // Mark as remote
        info.remote = true;
        this.remoteExtensions.add(info.id);

        // Load + activate on remote host with real Node.js code
        this.onExtensionStateChanged?.(info.id, 'activating');
        await this.remoteProxy.loadExtension(info.id, nodeCode, info.manifest);
        await this.remoteProxy.request('activateExtension', [info.id]);
        info.isActive = true;
        this.onExtensionStateChanged?.(info.id, 'active');
        console.log(`[MainThreadBridge] ✓ ${info.id} loaded on remote host`);
      } catch (err) {
        const isTransport = this._isTransportError(err);
        if (isTransport) {
          // Transport failure (DC closed / reset) — the extension itself is fine.
          // Undo remote marking so it's eligible for rehydration on the next
          // remote host connection.
          console.warn(`[MainThreadBridge] ${info.id}: transport error during remote load, will retry:`, err.message);
          info.remote = false;
          info.isActive = false;
          this.remoteExtensions.delete(info.id);
          this.onExtensionStateChanged?.(info.id, 'pending-remote');
        } else {
          console.warn(`[MainThreadBridge] Failed to load ${info.id} on remote host:`, err.message);
          this.onExtensionStateChanged?.(info.id, 'crashed', err.message);
        }
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
   * Set up handlers for events from the remote extension host.
   * Mirrors _setupEventHandlers but wired to this.remoteProxy.
   */
  _setupRemoteEventHandlers() {
    if (this.remoteHandlersRegistered || !this.remoteProxy) return;

    const proxy = this.remoteProxy;

    // Command registration
    proxy.on('registerCommand', (commandId, extensionId) => {
      this.extensionCommands.add(commandId);
      console.log(`[MainThreadBridge/remote] Command registered: ${commandId} (${extensionId})`);
    });

    proxy.on('unregisterCommand', (commandId) => {
      this.extensionCommands.delete(commandId);
    });

    // Messages
    proxy.on('showMessage', (type, message, options) => {
      if (this.onShowMessage) {
        this.onShowMessage(type, message, options);
      } else {
        if (type === 'error') console.error(message);
        else if (type === 'warning') console.warn(message);
        else console.log(message);
      }
    });

    // Diagnostics
    proxy.on('setDiagnostics', (uri, diagnostics, source) => {
      if (this.onSetDiagnostics) {
        this.onSetDiagnostics(uri, diagnostics, source);
      }
    });

    // Webviews
    proxy.on('createWebview', (viewId, viewType, title, extensionId) => {
      if (this.onCreateWebview) {
        this.onCreateWebview(viewId, viewType, title, { extensionId });
      }
      this._emitRemoteContribution?.('createWebview', { viewId, viewType, title, extensionId });
    });

    proxy.on('updateWebview', (viewId, html) => {
      this._emitRemoteContribution?.('updateWebview', { viewId, html });
    });

    proxy.on('disposeWebview', (viewId) => {
      this._emitRemoteContribution?.('disposeWebview', { viewId });
    });

    proxy.on('postWebviewMessage', (viewId, message) => {
      this._emitRemoteContribution?.('postWebviewMessage', { viewId, message });
    });

    // Tree views
    proxy.on('registerTreeView', (viewId, extensionId) => {
      console.log(`[MainThreadBridge/remote] Tree view registered: ${viewId} by ${extensionId}`);
      this._emitRemoteContribution?.('registerTreeView', { viewId, extensionId });
    });

    proxy.on('treeData', (viewId, data) => {
      console.log(`[MainThreadBridge/remote] Tree data: ${viewId} (${data?.length || 0} items)`);
      this._emitRemoteContribution?.('treeData', { viewId, data });
    });

    // Status bar
    proxy.on('setStatusBar', (text, timeout) => {
      this._emitRemoteContribution?.('setStatusBar', { text, timeout });
    });

    // Output channel
    proxy.on('outputChannel', (name, line) => {
      console.log(`[Ext/${name}] ${line}`);
    });

    // Open external URI
    proxy.on('openExternal', (uri) => {
      try { window.open(uri, '_blank'); } catch (_) {}
    });

    // Error event from the remote host process
    proxy.on('error', (message) => {
      console.error('[MainThreadBridge/remote] Extension host error:', message);
    });

    // DataChannel closed — the remote host is gone (e.g. WebRTC reset).
    // Clean up so a new ext-host DC can be created on reconnect.
    // IMPORTANT: We captured `proxy` above. If the bridge already replaced
    // this.remoteProxy with a newer instance (reconnect in-flight), the
    // stale proxy's disconnect must NOT tear down the replacement.
    proxy.on('disconnected', () => {
      if (this.remoteProxy && this.remoteProxy !== proxy) {
        console.log('[MainThreadBridge/remote] Ignoring disconnect from replaced (stale) proxy');
        return;
      }
      console.warn('[MainThreadBridge/remote] Remote extension host disconnected, cleaning up');
      // Mark all remote-loaded extensions as pending-remote again
      for (const [id, info] of this.extensions) {
        if (info.remote && info.isActive) {
          info.isActive = false;
          info.remote = false;
          this.remoteExtensions.delete(id);
          this.onExtensionStateChanged?.(id, 'pending-remote');
        }
      }
      // Tear down the dead proxy
      try { this.remoteProxy?.terminate(); } catch (_) {}
      this.remoteProxy = null;
      this.remoteHandlersRegistered = false;
      // Notify the hook so remoteHostConnectedRef gets reset
      this.onRemoteDisconnected?.();
    });

    this.remoteHandlersRegistered = true;
  }

  /**
   * Determine if an extension should run on the remote host.
   * Returns true if the extension has a Node.js entry (main) but no browser entry,
   * OR if it's explicitly marked as workspace-kind.
   */
  _shouldRunRemote(manifest) {
    if (!this.remoteProxy) return false;

    // If the extension has a browser entry, run it locally in the web worker
    // UNLESS its code is too large for the worker to eval.
    if (manifest.browser) {
      // Check if this extension was flagged as too large
      const info = this.extensions.get(manifest.__extensionId || `${manifest.publisher}.${manifest.name}`);
      const codeLen = info?.code?.length || 0;
      if (codeLen > 500_000 && manifest.main) {
        return true; // route to remote — browser bundle is too large
      }
      return false;
    }

    // Node-only extensions: have "main" but no "browser"
    if (manifest.main) return true;

    // Extensions with extensionKind that prefers workspace
    if (manifest.extensionKind) {
      const kinds = Array.isArray(manifest.extensionKind) ? manifest.extensionKind : [manifest.extensionKind];
      if (kinds.includes('workspace') && !kinds.includes('ui')) return true;
    }

    return false;
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

    // ── Route decision: local worker vs remote Node.js host ──
    const useRemote = this._shouldRunRemote(manifest);
    const isNodeOnly = manifest.main && !manifest.browser;
    const isTooLargeForWorker = code && code.length > 500_000 && manifest.main;

    // Node-only extensions OR extensions with huge browser bundles:
    // just store info, don't load into the web worker.
    // They'll be loaded when the remote host connects via _rehydrateNodeOnlyExtensions.
    if ((isNodeOnly || isTooLargeForWorker) && !useRemote) {
      console.log(
        `[MainThreadBridge] ${extensionId}: ${isNodeOnly ? 'Node-only' : `bundle too large (${code.length} chars)`}, ` +
        'stored (waiting for remote host)'
      );
      return;
    }

    const proxy = useRemote ? this.remoteProxy : this.workerProxy;
    const label = useRemote ? 'remote' : 'worker';

    // For remote host, use the real Node.js code
    const codeForHost = useRemote ? (manifest._nodeCode || code) : code;

    if (useRemote) {
      this.remoteExtensions.add(extensionId);
      const info = this.extensions.get(extensionId);
      if (info) info.remote = true;

      if (!manifest._nodeCode) {
        console.warn(
          `[MainThreadBridge] ${extensionId}: routed to remote host but no nodeCode available. ` +
          'Extension will run with passed code — re-install to get full functionality.'
        );
      }
    }

    // Load into the chosen host — if this times out, handle accordingly.
    try {
      await proxy.loadExtension(extensionId, codeForHost, manifest);
    } catch (loadErr) {
      if (loadErr.message && loadErr.message.includes('timeout')) {
        console.error(
          `[MainThreadBridge] loadExtension timeout for ${extensionId} (${label}). ` +
          'The extension\'s bundle hung during eval. ' +
          (useRemote ? 'Remote host may need restart.' : 'Restarting worker.')
        );
        this._markExtensionFailed(extensionId, `Load timeout: bundle hung during eval (${label})`);

        if (!useRemote) {
          // Restart worker to unblock remaining extensions
          await this._restartWorker(extensionId, 'load_timeout');
        }
        // Bubble up so caller knows it failed
        throw new Error(`Load timeout: ${extensionId} bundle hung during eval (${label}${useRemote ? '' : ', worker restarted'})`);
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

    // Route to the correct proxy
    const proxy = this.remoteExtensions.has(extensionId) ? this.remoteProxy : this.workerProxy;

    try {
      return await proxy.activateExtension(extensionId);
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

    const proxy = this.remoteExtensions.has(extensionId) ? this.remoteProxy : this.workerProxy;
    await proxy.deactivateExtension(extensionId);
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

    // Try remote first if any remote extensions are loaded, then fall back to worker
    if (this.remoteProxy && this.remoteExtensions.size > 0) {
      try {
        return await this.remoteProxy.executeCommand(commandId, ...args);
      } catch (remoteErr) {
        // If the remote host doesn't know this command, try the local worker
        if (remoteErr.message && remoteErr.message.includes('Unknown command')) {
          return this.workerProxy.executeCommand(commandId, ...args);
        }
        throw remoteErr;
      }
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
    
    // Send to both worker and remote host
    this.workerProxy.notifyDocumentOpen(document);
    if (this.remoteProxy && this.remoteExtensions.size > 0) {
      this.remoteProxy.notifyDocumentOpen(document);
    }
  }

  /**
   * Notify extensions of document change
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  notifyDocumentChange(uri, changes, version) {
    this.workerProxy.notifyDocumentChange(uri, changes, version);
    if (this.remoteProxy && this.remoteExtensions.size > 0) {
      this.remoteProxy.notifyDocumentChange(uri, changes, version);
    }
  }

  /**
   * Notify extensions of document close
   * @param {string} uri
   */
  notifyDocumentClose(uri) {
    this.workerProxy.notifyDocumentClose(uri);
    if (this.remoteProxy && this.remoteExtensions.size > 0) {
      this.remoteProxy.notifyDocumentClose(uri);
    }
  }

  /**
   * Notify extensions of selection change
   * @param {string} uri
   * @param {object[]} selections
   */
  notifySelectionChange(uri, selections) {
    this.workerProxy.notifySelectionChange(uri, selections);
    if (this.remoteProxy && this.remoteExtensions.size > 0) {
      this.remoteProxy.notifySelectionChange(uri, selections);
    }
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
        remote: this.remoteExtensions.has(id),
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

    // Terminate remote host
    if (this.remoteProxy) {
      this.remoteProxy.terminate();
      this.remoteProxy = null;
    }

    this.extensions.clear();
    this.extensionCommands.clear();
    this.pendingActivations.clear();
    this.remoteExtensions.clear();
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

        // Skip extensions routed to the remote host
        if (this.remoteExtensions.has(id)) continue;

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
