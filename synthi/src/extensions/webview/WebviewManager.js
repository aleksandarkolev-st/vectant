/**
 * Synthi Extension System - Webview Manager
 * Manages webview iframes with strict security
 */

// Strict Content Security Policy for webviews
const WEBVIEW_CSP = [
  "default-src 'none'",
  "img-src https: data:",
  "script-src 'unsafe-inline'",  // Required for VS Code webview scripts
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "connect-src https:",
  "frame-src https:"
].join('; ');

/**
 * Webview manager
 */
export class WebviewManager {
  constructor() {
    /** @type {Map<string, WebviewInstance>} */
    this.webviews = new Map();
    
    /** @type {HTMLElement|null} */
    this.container = null;
    
    /** @type {Map<string, Function[]>} */
    this.messageHandlers = new Map();
    
    /** @type {number} Message rate limit per webview (per second) */
    this.messageRateLimit = 100;
    
    /** @type {Map<string, number[]>} Message timestamps for rate limiting */
    this.messageTimestamps = new Map();
    
    /** @type {Set<string>} Hidden webviews */
    this.hiddenWebviews = new Set();

    // Listen for messages from webviews
    this._setupMessageListener();
  }

  /**
   * Set the container element for webviews
   * @param {HTMLElement} container
   */
  setContainer(container) {
    this.container = container;
  }

  /**
   * Create a webview
   * @param {string} viewId
   * @param {string} viewType
   * @param {string} title
   * @param {object} options
   * @returns {WebviewInstance}
   */
  create(viewId, viewType, title, options = {}) {
    if (this.webviews.has(viewId)) {
      console.warn(`[WebviewManager] Webview ${viewId} already exists`);
      return this.webviews.get(viewId);
    }

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.id = `webview-${viewId}`;
    iframe.className = 'synthi-webview';
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads';
    iframe.allow = 'clipboard-read; clipboard-write;';
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: var(--bg-editor, #1e1e1e);
    `;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.id = `webview-wrapper-${viewId}`;
    wrapper.className = 'synthi-webview-wrapper';
    wrapper.style.cssText = `
      display: none;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    `;
    wrapper.appendChild(iframe);

    // Add to container
    if (this.container) {
      this.container.appendChild(wrapper);
    }

    const instance = new WebviewInstance(viewId, viewType, title, iframe, wrapper, options);
    this.webviews.set(viewId, instance);
    this.messageTimestamps.set(viewId, []);

    return instance;
  }

  /**
   * Get a webview
   * @param {string} viewId
   * @returns {WebviewInstance|undefined}
   */
  get(viewId) {
    return this.webviews.get(viewId);
  }

  /**
   * Show a webview
   * @param {string} viewId
   */
  show(viewId) {
    const instance = this.webviews.get(viewId);
    if (instance) {
      instance.show();
      this.hiddenWebviews.delete(viewId);
    }
  }

  /**
   * Hide a webview
   * @param {string} viewId
   */
  hide(viewId) {
    const instance = this.webviews.get(viewId);
    if (instance) {
      instance.hide();
      this.hiddenWebviews.add(viewId);
    }
  }

  /**
   * Dispose a webview
   * @param {string} viewId
   */
  dispose(viewId) {
    const instance = this.webviews.get(viewId);
    if (instance) {
      instance.dispose();
      this.webviews.delete(viewId);
      this.messageHandlers.delete(viewId);
      this.messageTimestamps.delete(viewId);
      this.hiddenWebviews.delete(viewId);
    }
  }

  /**
   * Post message to webview
   * @param {string} viewId
   * @param {any} message
   * @returns {boolean}
   */
  postMessage(viewId, message) {
    // Check if hidden - drop message
    if (this.hiddenWebviews.has(viewId)) {
      console.debug(`[WebviewManager] Dropping message for hidden webview: ${viewId}`);
      return false;
    }

    // Rate limiting
    if (!this._checkRateLimit(viewId)) {
      console.warn(`[WebviewManager] Rate limit exceeded for webview: ${viewId}`);
      return false;
    }

    const instance = this.webviews.get(viewId);
    if (!instance) return false;

    return instance.postMessage(message);
  }

  /**
   * Register message handler
   * @param {string} viewId
   * @param {Function} handler
   * @returns {Function} Unregister function
   */
  onMessage(viewId, handler) {
    if (!this.messageHandlers.has(viewId)) {
      this.messageHandlers.set(viewId, []);
    }
    this.messageHandlers.get(viewId).push(handler);

    return () => {
      const handlers = this.messageHandlers.get(viewId);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Set up message listener for webview messages
   */
  _setupMessageListener() {
    window.addEventListener('message', (event) => {
      // Validate origin
      if (!this._isValidOrigin(event.origin)) {
        return;
      }

      const data = event.data;
      if (!data || !data.viewId || !data.type) return;

      // Rate limit incoming messages
      if (!this._checkRateLimit(data.viewId)) {
        console.warn(`[WebviewManager] Incoming rate limit exceeded: ${data.viewId}`);
        return;
      }

      // Dispatch to handlers
      const handlers = this.messageHandlers.get(data.viewId);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(data.message);
          } catch (err) {
            console.error(`[WebviewManager] Handler error:`, err);
          }
        }
      }
    });
  }

  /**
   * Check if origin is valid
   * @param {string} origin
   * @returns {boolean}
   */
  _isValidOrigin(origin) {
    // Allow same origin and null (sandboxed iframes)
    return origin === window.location.origin || origin === 'null';
  }

  /**
   * Check rate limit
   * @param {string} viewId
   * @returns {boolean}
   */
  _checkRateLimit(viewId) {
    const timestamps = this.messageTimestamps.get(viewId);
    if (!timestamps) return true;

    const now = Date.now();
    const oneSecondAgo = now - 1000;

    // Remove old timestamps
    while (timestamps.length > 0 && timestamps[0] < oneSecondAgo) {
      timestamps.shift();
    }

    if (timestamps.length >= this.messageRateLimit) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /**
   * Get all webview IDs
   * @returns {string[]}
   */
  getAllIds() {
    return Array.from(this.webviews.keys());
  }

  /**
   * Dispose all webviews
   */
  disposeAll() {
    for (const viewId of this.webviews.keys()) {
      this.dispose(viewId);
    }
  }
}

/**
 * Individual webview instance
 */
class WebviewInstance {
  /**
   * @param {string} viewId
   * @param {string} viewType
   * @param {string} title
   * @param {HTMLIFrameElement} iframe
   * @param {HTMLElement} wrapper
   * @param {object} options
   */
  constructor(viewId, viewType, title, iframe, wrapper, options) {
    this.viewId = viewId;
    this.viewType = viewType;
    this.title = title;
    this.iframe = iframe;
    this.wrapper = wrapper;
    this.options = options;
    this._html = '';
    this._visible = false;
    this._disposed = false;
  }

  /**
   * Get HTML
   * @returns {string}
   */
  get html() {
    return this._html;
  }

  /**
   * Set HTML
   * @param {string} value
   */
  set html(value) {
    this._html = value;
    this._updateContent();
  }

  /**
   * Update iframe content
   */
  _updateContent() {
    if (this._disposed) return;

    // If the extension provides a full HTML document (has <html> or <!DOCTYPE),
    // use it directly. Otherwise wrap in our boilerplate.
    const isFullDocument = /^\s*<!DOCTYPE|^\s*<html/i.test(this._html);

    let fullHtml;
    if (isFullDocument) {
      // Full HTML document from the extension — inject our vscode API shim
      // if it doesn't already define acquireVsCodeApi
      const vsCodeShim = `
        <script>
          if (typeof acquireVsCodeApi === 'undefined') {
            window.acquireVsCodeApi = function() {
              return {
                postMessage: (message) => {
                  parent.postMessage({ viewId: '${this.viewId}', type: 'message', message }, '*');
                },
                getState: () => {
                  try { return JSON.parse(sessionStorage.getItem('webviewState') || 'null'); } catch { return null; }
                },
                setState: (state) => {
                  sessionStorage.setItem('webviewState', JSON.stringify(state));
                  return state;
                }
              };
            };
          }
        </script>
      `;

      // Inject the shim before </head> or at the start of <body>
      if (this._html.includes('</head>')) {
        fullHtml = this._html.replace('</head>', vsCodeShim + '</head>');
      } else if (this._html.includes('<body')) {
        fullHtml = this._html.replace(/<body([^>]*)>/, `<body$1>${vsCodeShim}`);
      } else {
        fullHtml = vsCodeShim + this._html;
      }
    } else {
      // Fragment — wrap in our full document
      fullHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="${WEBVIEW_CSP}">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                margin: 0;
                padding: 0;
                background: var(--vscode-editor-background, #1e1e1e);
                color: var(--vscode-editor-foreground, #d4d4d4);
                font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
                font-size: var(--vscode-font-size, 13px);
              }
            </style>
            <script>
              const vscode = acquireVsCodeApi();
              window.addEventListener('message', event => {
                const message = event.data;
                window.dispatchEvent(new CustomEvent('vscode-message', { detail: message }));
              });
              
              function acquireVsCodeApi() {
                return {
                  postMessage: (message) => {
                    parent.postMessage({ viewId: '${this.viewId}', type: 'message', message }, '*');
                  },
                  getState: () => {
                    try {
                      return JSON.parse(sessionStorage.getItem('webviewState') || 'null');
                    } catch { return null; }
                  },
                  setState: (state) => {
                    sessionStorage.setItem('webviewState', JSON.stringify(state));
                    return state;
                  }
                };
              }
            </script>
          </head>
          <body>
            ${this._html}
          </body>
        </html>
      `;
    }

    // Use srcdoc for security
    this.iframe.srcdoc = fullHtml;
  }

  /**
   * Post message to webview
   * @param {any} message
   * @returns {boolean}
   */
  postMessage(message) {
    if (this._disposed || !this.iframe.contentWindow) {
      return false;
    }

    try {
      this.iframe.contentWindow.postMessage(message, '*');
      return true;
    } catch (err) {
      console.error(`[WebviewInstance] postMessage error:`, err);
      return false;
    }
  }

  /**
   * Show the webview
   */
  show() {
    if (!this._disposed) {
      this.wrapper.style.display = 'block';
      this._visible = true;
    }
  }

  /**
   * Hide the webview
   */
  hide() {
    if (!this._disposed) {
      this.wrapper.style.display = 'none';
      this._visible = false;
    }
  }

  /**
   * Check if visible
   * @returns {boolean}
   */
  isVisible() {
    return this._visible;
  }

  /**
   * Dispose the webview
   */
  dispose() {
    if (this._disposed) return;

    this._disposed = true;
    this._visible = false;

    // Remove from DOM
    if (this.wrapper.parentNode) {
      this.wrapper.parentNode.removeChild(this.wrapper);
    }

    // Clear references
    this.iframe = null;
    this.wrapper = null;
  }
}

// Singleton
let instance = null;

/**
 * Get WebviewManager singleton
 * @returns {WebviewManager}
 */
export function getWebviewManager() {
  if (!instance) {
    instance = new WebviewManager();
  }
  return instance;
}
