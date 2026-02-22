/**
 * Synthi Extension System - Authentication API
 * vscode.authentication namespace implementation
 *
 * Routes authentication sessions through the main thread to the
 * remote VS Code Server for secure credential management.
 */

import { WorkerToMainMethods } from '../bridge/MessageProtocol.js';

/**
 * Create authentication API namespace
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createAuthenticationAPI(extensionId, host) {
  const providers = new Map();
  const onDidChangeSessionsListeners = [];

  return {
    async getSession(providerId, scopes, options = {}) {
      try {
        const result = await host.request(WorkerToMainMethods.AUTH_GET_SESSION, [
          extensionId, providerId, scopes, {
            createIfNone: options.createIfNone,
            forceNewSession: options.forceNewSession,
            silent: options.silent,
            clearSessionPreference: options.clearSessionPreference
          }
        ]);
        return result || undefined;
      } catch (e) {
        if (options.createIfNone) throw e;
        return undefined;
      }
    },

    registerAuthenticationProvider(id, label, provider, options) {
      providers.set(id, { label, provider, options });
      host.emit(WorkerToMainMethods.AUTH_REGISTER_PROVIDER, extensionId, id, label, {
        supportsMultipleAccounts: options?.supportsMultipleAccounts
      });
      console.log(`[auth] Registered auth provider: ${label} (${id})`);
      return {
        dispose() { providers.delete(id); }
      };
    },

    onDidChangeSessions: _createEvent(onDidChangeSessionsListeners),

    _listeners: {
      onDidChangeSessions: onDidChangeSessionsListeners
    },
    _providers: providers,
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
