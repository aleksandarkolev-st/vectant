/**
 * Synthi Extension System - Debug API
 * vscode.debug namespace implementation
 *
 * Provides debug session management, breakpoints, and debug adapter
 * protocol integration that routes through the main thread to the
 * remote VS Code Server when available.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create debug API namespace
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createDebugAPI(extensionId, host) {
  const breakpoints = [];
  const debugAdapterFactories = new Map();

  const onDidChangeActiveDebugSessionListeners = [];
  const onDidStartDebugSessionListeners = [];
  const onDidTerminateDebugSessionListeners = [];
  const onDidReceiveDebugSessionCustomEventListeners = [];
  const onDidChangeBreakpointsListeners = [];

  return {
    get activeDebugSession() {
      return host._activeDebugSession || undefined;
    },

    get breakpoints() {
      return [...breakpoints];
    },

    async startDebugging(folder, nameOrConfiguration, parentSessionOrOptions) {
      const config = typeof nameOrConfiguration === 'string'
        ? { name: nameOrConfiguration, type: '', request: 'launch' }
        : nameOrConfiguration;

      try {
        const result = await host.request(WorkerToMainMethods.DEBUG_START_SESSION, [
          extensionId, config, folder?.uri?.toString()
        ]);
        return !!result?.success;
      } catch {
        return false;
      }
    },

    async stopDebugging(session) {
      try {
        await host.request(WorkerToMainMethods.DEBUG_STOP_SESSION, [
          session?.id || host._activeDebugSession?.id
        ]);
      } catch { /* best effort */ }
    },

    addBreakpoints(bps) {
      breakpoints.push(...bps);
      host.emit(WorkerToMainMethods.DEBUG_ADD_BREAKPOINT, bps.map(bp => ({
        id: bp.id,
        enabled: bp.enabled,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
        location: bp.location ? {
          uri: bp.location.uri?.toString(),
          range: bp.location.range
        } : undefined
      })));
      _fireEvent(onDidChangeBreakpointsListeners, { added: bps, removed: [], changed: [] });
    },

    removeBreakpoints(bps) {
      for (const bp of bps) {
        const idx = breakpoints.indexOf(bp);
        if (idx >= 0) breakpoints.splice(idx, 1);
      }
      host.emit(WorkerToMainMethods.DEBUG_REMOVE_BREAKPOINT, bps.map(bp => bp.id));
      _fireEvent(onDidChangeBreakpointsListeners, { added: [], removed: bps, changed: [] });
    },

    registerDebugConfigurationProvider(debugType, provider, triggerKind) {
      console.log(`[debug] Registered debug configuration provider for ${debugType}`);
      return { dispose() {} };
    },

    registerDebugAdapterDescriptorFactory(debugType, factory) {
      debugAdapterFactories.set(debugType, factory);
      host.emit(WorkerToMainMethods.DEBUG_REGISTER_PROVIDER, extensionId, debugType, 'descriptorFactory');
      console.log(`[debug] Registered debug adapter descriptor factory for ${debugType}`);
      return {
        dispose() { debugAdapterFactories.delete(debugType); }
      };
    },

    registerDebugAdapterTrackerFactory(debugType, factory) {
      console.log(`[debug] Registered debug adapter tracker factory for ${debugType}`);
      return { dispose() {} };
    },

    asDebugSourceUri(source, session) {
      if (source.path) {
        return { scheme: 'file', path: source.path, fsPath: source.path, toString: () => `file://${source.path}` };
      }
      return undefined;
    },

    onDidChangeActiveDebugSession: _createEvent(onDidChangeActiveDebugSessionListeners),
    onDidStartDebugSession: _createEvent(onDidStartDebugSessionListeners),
    onDidTerminateDebugSession: _createEvent(onDidTerminateDebugSessionListeners),
    onDidReceiveDebugSessionCustomEvent: _createEvent(onDidReceiveDebugSessionCustomEventListeners),
    onDidChangeBreakpoints: _createEvent(onDidChangeBreakpointsListeners),

    // Expose listener arrays for main thread to fire events
    _listeners: {
      onDidChangeActiveDebugSession: onDidChangeActiveDebugSessionListeners,
      onDidStartDebugSession: onDidStartDebugSessionListeners,
      onDidTerminateDebugSession: onDidTerminateDebugSessionListeners,
      onDidReceiveDebugSessionCustomEvent: onDidReceiveDebugSessionCustomEventListeners,
    }
  };
}

function _createEvent(listeners) {
  return (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    listeners.push(bound);
    const disposable = {
      dispose() {
        const idx = listeners.indexOf(bound);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}

function _fireEvent(listeners, data) {
  for (const l of listeners) {
    try { l(data); } catch (e) { console.error('[debug] Event handler error:', e); }
  }
}
