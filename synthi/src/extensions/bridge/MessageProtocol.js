/**
 * Synthi Extension System - Message Protocol
 * Typed message protocol for Main Thread ↔ Worker communication
 */

let messageIdCounter = 0;

/**
 * Create a unique message ID
 * @returns {number}
 */
export function createMessageId() {
  return ++messageIdCounter;
}

/**
 * Create a request message
 * @param {string} method - Method name
 * @param {any[]} args - Arguments
 * @returns {{ id: number, type: 'request', method: string, args: any[] }}
 */
export function createRequest(method, args = []) {
  return {
    id: createMessageId(),
    type: 'request',
    method,
    args
  };
}

/**
 * Create a response message
 * @param {number} id - Request ID
 * @param {any} result - Result value
 * @param {{ message: string, stack?: string }|null} error - Error if any
 * @param {number} [generation] - Optional worker generation for stale reply fencing
 * @returns {{ id: number, type: 'response', result?: any, error?: object, generation?: number }}
 */
export function createResponse(id, result, error = null, generation) {
  const msg = { id, type: 'response' };
  if (typeof generation === 'number') {
    msg.generation = generation;
  }
  if (error) {
    msg.error = { message: error.message, stack: error.stack };
  } else {
    msg.result = result;
  }
  return msg;
}

/**
 * Create an event message (no response expected)
 * @param {string} method - Event name
 * @param {any[]} args - Event data
 * @returns {{ id: number, type: 'event', method: string, args: any[] }}
 */
export function createEvent(method, args = []) {
  return {
    id: createMessageId(),
    type: 'event',
    method,
    args
  };
}

/**
 * Validate incoming message structure
 * @param {any} msg - Message to validate
 * @returns {boolean}
 */
export function isValidMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.id !== 'number') return false;
  if (!['request', 'response', 'event'].includes(msg.type)) return false;
  if (msg.type === 'request' || msg.type === 'event') {
    if (typeof msg.method !== 'string') return false;
  }
  return true;
}

// Method names for Main → Worker communication
export const MainToWorkerMethods = {
  // Extension lifecycle
  ACTIVATE_EXTENSION: 'activateExtension',
  DEACTIVATE_EXTENSION: 'deactivateExtension',
  LOAD_EXTENSION: 'loadExtension',
  
  // Commands
  EXECUTE_COMMAND: 'executeCommand',
  
  // Document events
  TEXT_DOCUMENT_OPEN: 'textDocument/open',
  TEXT_DOCUMENT_CLOSE: 'textDocument/close',
  TEXT_DOCUMENT_CHANGE: 'textDocument/change',
  SELECTION_CHANGE: 'selectionChange',
  
  // Configuration
  CONFIGURATION_CHANGE: 'configurationChange',
  
  // Webview
  WEBVIEW_MESSAGE: 'webview/message',
  WEBVIEW_VISIBILITY: 'webview/visibility',
  WEBVIEW_DISPOSE: 'webview/dispose',
  
  // Performance
  GET_METRICS: 'getMetrics',
  SUSPEND_EXTENSION: 'suspendExtension',
  RESUME_EXTENSION: 'resumeExtension',
  KILL_EXTENSION: 'killExtension'
};

// Method names for Worker → Main communication
export const WorkerToMainMethods = {
  // Initialization
  WORKER_READY: 'workerReady',
  
  // Text edits
  APPLY_EDIT: 'applyEdit',
  
  // UI
  SHOW_MESSAGE: 'showMessage',
  SHOW_QUICK_PICK: 'showQuickPick',
  SHOW_INPUT_BOX: 'showInputBox',
  SET_STATUS_BAR: 'setStatusBar',
  
  // Commands
  REGISTER_COMMAND: 'registerCommand',
  UNREGISTER_COMMAND: 'unregisterCommand',
  
  // Webviews
  CREATE_WEBVIEW: 'createWebview',
  UPDATE_WEBVIEW: 'updateWebview',
  POST_WEBVIEW_MESSAGE: 'postWebviewMessage',
  DISPOSE_WEBVIEW: 'disposeWebview',
  
  // Diagnostics
  SET_DIAGNOSTICS: 'setDiagnostics',
  CLEAR_DIAGNOSTICS: 'clearDiagnostics',
  
  // Decorations
  SET_DECORATIONS: 'setDecorations',
  DISPOSE_DECORATION_TYPE: 'disposeDecorationType',
  
  // Output
  OUTPUT_APPEND: 'output/append',
  OUTPUT_CLEAR: 'output/clear',
  OUTPUT_SHOW: 'output/show',
  
  // Storage
  STORAGE_GET: 'storage/get',
  STORAGE_SET: 'storage/set',
  STORAGE_DELETE: 'storage/delete',
  
  // File system
  FS_READ_FILE: 'fs/readFile',
  FS_WRITE_FILE: 'fs/writeFile',
  FS_DELETE: 'fs/delete',
  FS_RENAME: 'fs/rename',
  FS_STAT: 'fs/stat',
  FS_READ_DIR: 'fs/readDir',
  
  // Performance reporting
  REPORT_METRICS: 'reportMetrics',
  ACTIVATION_COMPLETE: 'activationComplete'
};
