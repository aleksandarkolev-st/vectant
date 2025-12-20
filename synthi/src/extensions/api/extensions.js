/**
 * Synthi Extension System - Extensions API
 * vscode.extensions namespace implementation
 */

/**
 * Create extensions API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createExtensionsAPI(extensionId, host) {
  const onDidChangeListeners = [];

  return {
    /**
     * Get all extensions
     */
    get all() {
      const result = [];
      
      for (const [id, ext] of host.loadedExtensions) {
        result.push(createExtensionProxy(id, ext, host));
      }
      
      return result;
    },

    /**
     * Get extension by ID
     * @param {string} extensionId
     * @returns {object|undefined}
     */
    getExtension(targetExtensionId) {
      const ext = host.loadedExtensions.get(targetExtensionId);
      if (!ext) return undefined;
      
      return createExtensionProxy(targetExtensionId, ext, host);
    },

    /**
     * Event: extension changed
     */
    onDidChange: (listener, thisArgs, disposables) => {
      const bound = thisArgs ? listener.bind(thisArgs) : listener;
      onDidChangeListeners.push(bound);
      
      const disposable = {
        dispose() {
          const idx = onDidChangeListeners.indexOf(bound);
          if (idx !== -1) onDidChangeListeners.splice(idx, 1);
        }
      };
      
      if (disposables) disposables.push(disposable);
      return disposable;
    }
  };
}

/**
 * Create extension proxy object
 * @param {string} extensionId
 * @param {object} ext
 * @param {object} host
 * @returns {object}
 */
function createExtensionProxy(extensionId, ext, host) {
  const context = host.getContext(extensionId);
  
  return {
    /**
     * Extension ID
     */
    id: extensionId,

    /**
     * Extension URI
     */
    extensionUri: {
      scheme: 'extension',
      authority: '',
      path: `/${extensionId}`,
      query: '',
      fragment: '',
      fsPath: `/${extensionId}`,
      toString() {
        return `extension:///${extensionId}`;
      }
    },

    /**
     * Extension path
     */
    extensionPath: `/${extensionId}`,

    /**
     * Is active
     */
    get isActive() {
      return host.getContext(extensionId) != null;
    },

    /**
     * Package JSON
     */
    packageJSON: ext.manifest,

    /**
     * Extension kind
     */
    extensionKind: 2, // Workspace

    /**
     * Exports
     */
    get exports() {
      if (!this.isActive) return undefined;
      return ext.module;
    },

    /**
     * Activate the extension
     * @returns {Promise<any>}
     */
    async activate() {
      if (this.isActive) {
        return this.exports;
      }
      
      await host.activationManager.activate(extensionId);
      return this.exports;
    }
  };
}
