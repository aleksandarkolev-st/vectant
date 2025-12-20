/**
 * Synthi Extension System - Runtime API Enforcer
 * CRITICAL: Static compatibility checks are not enough
 * 
 * Enforcement rules:
 * - Access to never-supported APIs must throw synchronously
 * - Access to experimental APIs must log + increment violation counter
 * - ≥3 violations → quarantine
 * 
 * Do not warn silently.
 */

import { FailureType } from './ExtensionState.js';

/**
 * API support levels
 */
export const APISupport = Object.freeze({
  /** Fully supported, use freely */
  STABLE: 'stable',
  
  /** Works but may change, log usage */
  EXPERIMENTAL: 'experimental',
  
  /** Deprecated, warn but allow */
  DEPRECATED: 'deprecated',
  
  /** Not implemented, throw immediately */
  NOT_IMPLEMENTED: 'not_implemented',
  
  /** Security risk, throw + potential quarantine */
  FORBIDDEN: 'forbidden'
});

/**
 * API definitions with enforcement rules
 */
const API_REGISTRY = {
  // =========================================================================
  // STABLE APIs - fully supported
  // =========================================================================
  'vscode.commands.registerCommand': APISupport.STABLE,
  'vscode.commands.executeCommand': APISupport.STABLE,
  'vscode.commands.getCommands': APISupport.STABLE,
  
  'vscode.window.showInformationMessage': APISupport.STABLE,
  'vscode.window.showWarningMessage': APISupport.STABLE,
  'vscode.window.showErrorMessage': APISupport.STABLE,
  'vscode.window.showQuickPick': APISupport.STABLE,
  'vscode.window.showInputBox': APISupport.STABLE,
  'vscode.window.createStatusBarItem': APISupport.STABLE,
  'vscode.window.createOutputChannel': APISupport.STABLE,
  
  'vscode.workspace.getConfiguration': APISupport.STABLE,
  'vscode.workspace.onDidChangeConfiguration': APISupport.STABLE,
  'vscode.workspace.workspaceFolders': APISupport.STABLE,
  'vscode.workspace.onDidOpenTextDocument': APISupport.STABLE,
  'vscode.workspace.onDidCloseTextDocument': APISupport.STABLE,
  'vscode.workspace.onDidSaveTextDocument': APISupport.STABLE,
  
  'vscode.Uri.file': APISupport.STABLE,
  'vscode.Uri.parse': APISupport.STABLE,
  
  'vscode.Range': APISupport.STABLE,
  'vscode.Position': APISupport.STABLE,
  'vscode.Selection': APISupport.STABLE,
  
  // =========================================================================
  // EXPERIMENTAL APIs - work but may change
  // =========================================================================
  'vscode.languages.registerCompletionItemProvider': APISupport.EXPERIMENTAL,
  'vscode.languages.registerHoverProvider': APISupport.EXPERIMENTAL,
  'vscode.languages.registerDefinitionProvider': APISupport.EXPERIMENTAL,
  'vscode.languages.registerDocumentFormattingEditProvider': APISupport.EXPERIMENTAL,
  'vscode.languages.createDiagnosticCollection': APISupport.EXPERIMENTAL,
  
  'vscode.window.createWebviewPanel': APISupport.EXPERIMENTAL,
  'vscode.window.registerWebviewViewProvider': APISupport.EXPERIMENTAL,
  'vscode.window.createTreeView': APISupport.EXPERIMENTAL,
  'vscode.window.registerTreeDataProvider': APISupport.EXPERIMENTAL,
  
  'vscode.workspace.fs.readFile': APISupport.EXPERIMENTAL,
  'vscode.workspace.fs.writeFile': APISupport.EXPERIMENTAL,
  'vscode.workspace.fs.delete': APISupport.EXPERIMENTAL,
  'vscode.workspace.fs.createDirectory': APISupport.EXPERIMENTAL,
  
  // =========================================================================
  // DEPRECATED APIs - warn but allow
  // =========================================================================
  'vscode.workspace.rootPath': APISupport.DEPRECATED, // Use workspaceFolders
  'vscode.window.showTextDocument': APISupport.DEPRECATED, // Limited support
  
  // =========================================================================
  // NOT IMPLEMENTED - throw immediately
  // =========================================================================
  'vscode.debug.startDebugging': APISupport.NOT_IMPLEMENTED,
  'vscode.debug.stopDebugging': APISupport.NOT_IMPLEMENTED,
  'vscode.debug.registerDebugAdapterDescriptorFactory': APISupport.NOT_IMPLEMENTED,
  'vscode.debug.registerDebugConfigurationProvider': APISupport.NOT_IMPLEMENTED,
  
  'vscode.tasks.registerTaskProvider': APISupport.NOT_IMPLEMENTED,
  'vscode.tasks.executeTask': APISupport.NOT_IMPLEMENTED,
  
  'vscode.scm.createSourceControl': APISupport.NOT_IMPLEMENTED,
  
  'vscode.tests.createTestController': APISupport.NOT_IMPLEMENTED,
  
  'vscode.notebooks.createNotebookController': APISupport.NOT_IMPLEMENTED,
  
  'vscode.authentication.getSession': APISupport.NOT_IMPLEMENTED,
  'vscode.authentication.registerAuthenticationProvider': APISupport.NOT_IMPLEMENTED,
  
  // =========================================================================
  // FORBIDDEN APIs - security risk, throw + may quarantine
  // =========================================================================
  'vscode.env.shell': APISupport.FORBIDDEN, // No shell access
  'vscode.env.openExternal': APISupport.FORBIDDEN, // Limited, security risk
  
  'require': APISupport.FORBIDDEN, // No CommonJS require
  'process': APISupport.FORBIDDEN, // No Node.js process
  'child_process': APISupport.FORBIDDEN, // No spawning
  '__dirname': APISupport.FORBIDDEN, // No filesystem paths
  '__filename': APISupport.FORBIDDEN,
  
  'eval': APISupport.FORBIDDEN, // No dynamic code execution
  'Function': APISupport.FORBIDDEN, // No dynamic function creation
  
  'XMLHttpRequest': APISupport.FORBIDDEN, // Use fetch via proxy
  'WebSocket': APISupport.FORBIDDEN, // Use approved channels only
  
  'localStorage': APISupport.FORBIDDEN, // Use workspace storage
  'sessionStorage': APISupport.FORBIDDEN,
  'indexedDB': APISupport.FORBIDDEN, // Use extension storage
  
  'document': APISupport.FORBIDDEN, // No DOM access
  'window': APISupport.FORBIDDEN, // No global window
};

/**
 * Violation record
 * @typedef {Object} Violation
 * @property {string} extensionId
 * @property {string} api
 * @property {APISupport} level
 * @property {number} timestamp
 * @property {string|null} stackTrace
 */

/**
 * Runtime API Enforcer
 */
export class RuntimeAPIEnforcer {
  /**
   * @param {Object} options
   * @param {number} [options.maxViolationsBeforeQuarantine=3]
   * @param {(extensionId: string, reason: string) => void} [options.onQuarantine]
   */
  constructor(options = {}) {
    this.maxViolations = options.maxViolationsBeforeQuarantine || 3;
    this.onQuarantine = options.onQuarantine || (() => {});
    
    /** @type {Map<string, number>} - extensionId -> violation count */
    this.violationCounts = new Map();
    
    /** @type {Violation[]} */
    this.violationHistory = [];
    
    /** @type {number} */
    this.maxHistorySize = 1000;
    
    /** @type {Set<string>} - extensionIds that have been quarantine-reported */
    this.reportedForQuarantine = new Set();
  }

  /**
   * Check API access - SYNCHRONOUS
   * @param {string} extensionId
   * @param {string} apiPath - e.g., 'vscode.debug.startDebugging'
   * @returns {{allowed: boolean, level: APISupport, error: Error|null}}
   */
  checkAccess(extensionId, apiPath) {
    const level = this._getAPILevel(apiPath);
    
    switch (level) {
      case APISupport.STABLE:
        return { allowed: true, level, error: null };
      
      case APISupport.EXPERIMENTAL:
        this._recordViolation(extensionId, apiPath, level);
        console.warn(`[APIEnforcer] ${extensionId} using experimental API: ${apiPath}`);
        return { allowed: true, level, error: null };
      
      case APISupport.DEPRECATED:
        console.warn(`[APIEnforcer] ${extensionId} using deprecated API: ${apiPath}`);
        return { allowed: true, level, error: null };
      
      case APISupport.NOT_IMPLEMENTED:
        this._recordViolation(extensionId, apiPath, level);
        const notImplError = new Error(
          `API not implemented in Synthi: ${apiPath}. ` +
          `This VS Code API is not available in the browser-based extension host.`
        );
        notImplError.code = 'API_NOT_IMPLEMENTED';
        notImplError.api = apiPath;
        return { allowed: false, level, error: notImplError };
      
      case APISupport.FORBIDDEN:
        this._recordViolation(extensionId, apiPath, level, true);
        const forbiddenError = new Error(
          `SECURITY: Forbidden API access: ${apiPath}. ` +
          `This API is blocked for security reasons.`
        );
        forbiddenError.code = 'API_FORBIDDEN';
        forbiddenError.api = apiPath;
        return { allowed: false, level, error: forbiddenError };
      
      default:
        // Unknown API - allow but log
        console.log(`[APIEnforcer] Unknown API accessed: ${apiPath}`);
        return { allowed: true, level: APISupport.STABLE, error: null };
    }
  }

  /**
   * Enforce API access - THROWS on violation
   * @param {string} extensionId
   * @param {string} apiPath
   * @throws {Error} If API is forbidden or not implemented
   */
  enforceAccess(extensionId, apiPath) {
    const result = this.checkAccess(extensionId, apiPath);
    
    if (!result.allowed && result.error) {
      throw result.error;
    }
  }

  /**
   * Get violation count for extension
   * @param {string} extensionId
   * @returns {number}
   */
  getViolationCount(extensionId) {
    return this.violationCounts.get(extensionId) || 0;
  }

  /**
   * Get violation history for extension
   * @param {string} extensionId
   * @returns {Violation[]}
   */
  getViolationHistory(extensionId) {
    return this.violationHistory.filter(v => v.extensionId === extensionId);
  }

  /**
   * Reset violations for extension
   * @param {string} extensionId
   */
  resetViolations(extensionId) {
    this.violationCounts.delete(extensionId);
    this.reportedForQuarantine.delete(extensionId);
  }

  /**
   * Check if extension should be quarantined
   * @param {string} extensionId
   * @returns {boolean}
   */
  shouldQuarantine(extensionId) {
    const count = this.violationCounts.get(extensionId) || 0;
    return count >= this.maxViolations;
  }

  /**
   * Create a Proxy that enforces API access
   * @param {string} extensionId
   * @param {object} api - The API object to wrap
   * @param {string} [basePath='vscode'] - Base path for API names
   * @returns {Proxy}
   */
  createEnforcedProxy(extensionId, api, basePath = 'vscode') {
    const enforcer = this;
    
    return new Proxy(api, {
      get(target, prop) {
        const apiPath = `${basePath}.${String(prop)}`;
        
        // Check access
        enforcer.enforceAccess(extensionId, apiPath);
        
        const value = target[prop];
        
        // If it's an object, wrap it recursively
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return enforcer.createEnforcedProxy(extensionId, value, apiPath);
        }
        
        // If it's a function, wrap it
        if (typeof value === 'function') {
          return function(...args) {
            // Log experimental API calls
            const level = enforcer._getAPILevel(apiPath);
            if (level === APISupport.EXPERIMENTAL) {
              console.log(`[APIEnforcer] ${extensionId} called experimental: ${apiPath}`);
            }
            return value.apply(target, args);
          };
        }
        
        return value;
      }
    });
  }

  /**
   * Get API support level
   * @param {string} apiPath
   * @returns {APISupport}
   */
  getAPILevel(apiPath) {
    return this._getAPILevel(apiPath);
  }

  /**
   * Get all registered APIs
   * @returns {Object}
   */
  getAPIRegistry() {
    return { ...API_REGISTRY };
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  _getAPILevel(apiPath) {
    // Exact match
    if (API_REGISTRY[apiPath]) {
      return API_REGISTRY[apiPath];
    }
    
    // Check parent paths (e.g., 'vscode.debug' matches 'vscode.debug.startDebugging')
    const parts = apiPath.split('.');
    while (parts.length > 1) {
      parts.pop();
      const parentPath = parts.join('.');
      if (API_REGISTRY[parentPath]) {
        return API_REGISTRY[parentPath];
      }
    }
    
    // Check for known forbidden globals
    const firstPart = apiPath.split('.')[0];
    if (API_REGISTRY[firstPart] === APISupport.FORBIDDEN) {
      return APISupport.FORBIDDEN;
    }
    
    // Unknown API - assume stable (permissive for unknown vscode APIs)
    if (apiPath.startsWith('vscode.')) {
      return APISupport.EXPERIMENTAL; // Unknown vscode APIs are experimental
    }
    
    return APISupport.STABLE;
  }

  _recordViolation(extensionId, apiPath, level, isSevere = false) {
    // Increment count
    const currentCount = this.violationCounts.get(extensionId) || 0;
    this.violationCounts.set(extensionId, currentCount + 1);
    
    // Record in history
    const violation = {
      extensionId,
      api: apiPath,
      level,
      timestamp: Date.now(),
      stackTrace: isSevere ? new Error().stack : null
    };
    
    this.violationHistory.push(violation);
    
    // Trim history if needed
    if (this.violationHistory.length > this.maxHistorySize) {
      this.violationHistory = this.violationHistory.slice(-this.maxHistorySize / 2);
    }
    
    // Check for quarantine
    const newCount = currentCount + 1;
    if (newCount >= this.maxViolations && !this.reportedForQuarantine.has(extensionId)) {
      this.reportedForQuarantine.add(extensionId);
      
      console.error(
        `[APIEnforcer] Extension ${extensionId} has ${newCount} API violations. ` +
        `Recommending quarantine.`
      );
      
      this.onQuarantine(extensionId, `${newCount} API violations (latest: ${apiPath})`);
    }
  }
}

// Singleton
let enforcerInstance = null;

/**
 * Get singleton RuntimeAPIEnforcer
 * @param {Object} [options]
 * @returns {RuntimeAPIEnforcer}
 */
export function getRuntimeAPIEnforcer(options = {}) {
  if (!enforcerInstance) {
    enforcerInstance = new RuntimeAPIEnforcer(options);
  }
  return enforcerInstance;
}

/**
 * Create new RuntimeAPIEnforcer (for testing)
 * @param {Object} [options]
 * @returns {RuntimeAPIEnforcer}
 */
export function createRuntimeAPIEnforcer(options = {}) {
  return new RuntimeAPIEnforcer(options);
}
