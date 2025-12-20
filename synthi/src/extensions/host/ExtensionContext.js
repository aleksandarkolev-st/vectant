/**
 * Synthi Extension System - Extension Context
 * Per-extension context provided to activate()
 */

/**
 * Create extension context
 * @param {string} extensionId
 * @param {object} manifest
 * @param {import('./ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createExtensionContext(extensionId, manifest, host) {
  const subscriptions = [];
  
  // Storage state (workspace-scoped)
  const workspaceState = createMemento(`workspace:${extensionId}`, host);
  
  // Storage state (global)
  const globalState = createMemento(`global:${extensionId}`, host);
  globalState.setKeysForSync = (keys) => {
    // No-op in web context
  };

  // Extension URI
  const extensionUri = {
    scheme: 'extension',
    authority: '',
    path: `/${extensionId}`,
    query: '',
    fragment: '',
    fsPath: `/${extensionId}`,
    toString() {
      return `extension:///${extensionId}`;
    }
  };

  const context = {
    /**
     * Subscriptions to be disposed when extension deactivates
     * @type {Array<{ dispose(): void }>}
     */
    subscriptions,

    /**
     * Workspace-scoped storage
     */
    workspaceState,

    /**
     * Global storage
     */
    globalState,

    /**
     * Secret storage (limited in web)
     */
    secrets: createSecretStorage(extensionId, host),

    /**
     * Extension URI
     */
    extensionUri,

    /**
     * Extension path
     */
    extensionPath: `/${extensionId}`,

    /**
     * Storage path (workspace-scoped)
     */
    storagePath: `/storage/${extensionId}/workspace`,

    /**
     * Global storage path
     */
    globalStoragePath: `/storage/${extensionId}/global`,

    /**
     * Log path
     */
    logPath: `/logs/${extensionId}`,

    /**
     * Extension mode
     */
    extensionMode: 1, // Production

    /**
     * Storage URI
     */
    storageUri: {
      scheme: 'storage',
      authority: '',
      path: `/workspace/${extensionId}`,
      query: '',
      fragment: '',
      fsPath: `/storage/workspace/${extensionId}`,
      toString() {
        return `storage:///workspace/${extensionId}`;
      }
    },

    /**
     * Global storage URI
     */
    globalStorageUri: {
      scheme: 'storage',
      authority: '',
      path: `/global/${extensionId}`,
      query: '',
      fragment: '',
      fsPath: `/storage/global/${extensionId}`,
      toString() {
        return `storage:///global/${extensionId}`;
      }
    },

    /**
     * Log URI
     */
    logUri: {
      scheme: 'log',
      authority: '',
      path: `/${extensionId}`,
      query: '',
      fragment: '',
      fsPath: `/logs/${extensionId}`,
      toString() {
        return `log:///${extensionId}`;
      }
    },

    /**
     * Environment variable collection (no-op)
     */
    environmentVariableCollection: createEnvironmentVariableCollection(),

    /**
     * Extension info
     */
    extension: {
      id: extensionId,
      extensionUri,
      extensionPath: `/${extensionId}`,
      isActive: true,
      packageJSON: manifest,
      extensionKind: 2, // Workspace
      exports: undefined,
      activate() {
        return Promise.resolve(this.exports);
      }
    },

    /**
     * Convert relative path to absolute
     * @param {string} relativePath
     * @returns {string}
     */
    asAbsolutePath(relativePath) {
      return `/${extensionId}/${relativePath}`;
    }
  };

  return context;
}

/**
 * Create memento (key-value storage)
 * @param {string} scope
 * @param {object} host
 * @returns {object}
 */
function createMemento(scope, host) {
  const cache = new Map();
  
  return {
    /**
     * Get all keys
     * @returns {readonly string[]}
     */
    keys() {
      return Array.from(cache.keys());
    },

    /**
     * Get a value
     * @param {string} key
     * @param {any} defaultValue
     * @returns {any}
     */
    get(key, defaultValue) {
      if (cache.has(key)) {
        return cache.get(key);
      }
      return defaultValue;
    },

    /**
     * Update a value
     * @param {string} key
     * @param {any} value
     * @returns {Promise<void>}
     */
    async update(key, value) {
      if (value === undefined) {
        cache.delete(key);
      } else {
        cache.set(key, value);
      }
      
      // Persist to storage service
      // host.emit(WorkerToMainMethods.STORAGE_SET, scope, key, value);
    }
  };
}

/**
 * Create secret storage
 * @param {string} extensionId
 * @param {object} host
 * @returns {object}
 */
function createSecretStorage(extensionId, host) {
  const secrets = new Map();
  const listeners = [];

  return {
    /**
     * Get a secret
     * @param {string} key
     * @returns {Promise<string|undefined>}
     */
    async get(key) {
      return secrets.get(key);
    },

    /**
     * Store a secret
     * @param {string} key
     * @param {string} value
     * @returns {Promise<void>}
     */
    async store(key, value) {
      const oldValue = secrets.get(key);
      secrets.set(key, value);
      
      if (oldValue !== value) {
        listeners.forEach(l => l({ key }));
      }
    },

    /**
     * Delete a secret
     * @param {string} key
     * @returns {Promise<void>}
     */
    async delete(key) {
      if (secrets.has(key)) {
        secrets.delete(key);
        listeners.forEach(l => l({ key }));
      }
    },

    /**
     * Subscribe to changes
     */
    onDidChange: (listener) => {
      listeners.push(listener);
      return {
        dispose() {
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
        }
      };
    }
  };
}

/**
 * Create environment variable collection (no-op stub)
 * @returns {object}
 */
function createEnvironmentVariableCollection() {
  return {
    persistent: false,
    description: undefined,
    replace() {},
    append() {},
    prepend() {},
    get() { return undefined; },
    forEach() {},
    delete() {},
    clear() {},
    [Symbol.iterator]: function* () {}
  };
}
