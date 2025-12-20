/**
 * Synthi Extension System - Env API
 * vscode.env namespace implementation
 */

/**
 * Create env API
 * @param {string} extensionId
 * @param {import('../host/ExtensionHostMain.js').ExtensionHostMain} host
 * @returns {object}
 */
export function createEnvAPI(extensionId, host) {
  // Generate a session ID
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : 
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

  // Machine ID (persistent)
  const machineId = localStorage?.getItem('synthi.machineId') || (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : sessionId;
    try { localStorage?.setItem('synthi.machineId', id); } catch(e) {}
    return id;
  })();

  return {
    /**
     * Application name
     */
    appName: 'Synthi IDE',

    /**
     * Application root
     */
    appRoot: '/',

    /**
     * Application host
     */
    appHost: 'web',

    /**
     * UI kind
     */
    uiKind: 2, // UIKind.Web

    /**
     * Language
     */
    language: navigator?.language || 'en',

    /**
     * Is new app install
     */
    isNewAppInstall: false,

    /**
     * Is telemetry enabled
     */
    isTelemetryEnabled: false,

    /**
     * Telemetry level
     */
    telemetryLevel: 0, // off

    /**
     * Session ID
     */
    sessionId,

    /**
     * Machine ID
     */
    machineId,

    /**
     * Remote name (undefined for local)
     */
    remoteName: undefined,

    /**
     * Shell
     */
    shell: '/bin/sh',

    /**
     * Log level
     */
    logLevel: 2, // Info

    /**
     * Open external URI
     * @param {any} target
     * @returns {Promise<boolean>}
     */
    async openExternal(target) {
      const url = typeof target === 'string' ? target : target.toString();
      
      // Security check - only allow http(s) URLs
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        console.warn(`[env.openExternal] Blocked non-http URL: ${url}`);
        return false;
      }

      try {
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      } catch (err) {
        console.error('[env.openExternal] Failed:', err);
        return false;
      }
    },

    /**
     * As external URI
     * @param {any} target
     * @returns {Promise<any>}
     */
    async asExternalUri(target) {
      // For web, just return the URI as-is
      return target;
    },

    /**
     * Read from clipboard
     * @returns {Promise<string>}
     */
    async clipboard$readText() {
      try {
        return await navigator.clipboard.readText();
      } catch (err) {
        console.warn('[env.clipboard.readText] Failed:', err);
        return '';
      }
    },

    /**
     * Write to clipboard
     * @param {string} value
     * @returns {Promise<void>}
     */
    async clipboard$writeText(value) {
      try {
        await navigator.clipboard.writeText(value);
      } catch (err) {
        console.warn('[env.clipboard.writeText] Failed:', err);
      }
    },

    /**
     * Clipboard object
     */
    clipboard: {
      async readText() {
        try {
          return await navigator.clipboard.readText();
        } catch (err) {
          console.warn('[env.clipboard.readText] Failed:', err);
          return '';
        }
      },

      async writeText(value) {
        try {
          await navigator.clipboard.writeText(value);
        } catch (err) {
          console.warn('[env.clipboard.writeText] Failed:', err);
        }
      }
    },

    /**
     * Create telemetry logger (no-op)
     * @param {any} sender
     * @param {object} [options]
     * @returns {object}
     */
    createTelemetryLogger(sender, options) {
      return {
        logUsage() {},
        logError() {},
        dispose() {},
        onDidChangeEnableStates: createNoOpEvent()
      };
    },

    /**
     * Event: telemetry enabled changed
     */
    onDidChangeTelemetryEnabled: createNoOpEvent(),

    /**
     * Event: shell changed
     */
    onDidChangeShell: createNoOpEvent(),

    /**
     * Event: log level changed
     */
    onDidChangeLogLevel: createNoOpEvent()
  };
}

/**
 * Create a no-op event
 * @returns {Function}
 */
function createNoOpEvent() {
  return (listener, thisArgs, disposables) => {
    const disposable = { dispose() {} };
    if (disposables) disposables.push(disposable);
    return disposable;
  };
}
