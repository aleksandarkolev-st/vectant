/**
 * Synthi Extension System - Frozen API Surface
 * PHASE C: API Contract Definition
 * 
 * This file defines the STABLE API surface for extensions.
 * Once frozen, breaking changes require a major version bump.
 * 
 * API Tiers:
 * - STABLE: Guaranteed to work, breaking changes = major version
 * - EXPERIMENTAL: May change, use at your own risk
 * - NEVER_SUPPORTED: Will never be implemented
 */

/**
 * API Stability levels
 * @readonly
 * @enum {string}
 */
export const APIStability = Object.freeze({
  STABLE: 'stable',
  EXPERIMENTAL: 'experimental',
  DEPRECATED: 'deprecated',
  NEVER_SUPPORTED: 'never_supported'
});

/**
 * The frozen API definition
 * Version: 1.0.0
 * 
 * DO NOT MODIFY THIS WITHOUT A MAJOR VERSION BUMP
 */
export const FROZEN_API_V1 = Object.freeze({
  version: '1.0.0',
  frozenAt: '2024-12-18',
  
  // =========================================================================
  // STABLE APIs - Guaranteed to work
  // =========================================================================
  stable: {
    // Commands
    'vscode.commands.registerCommand': {
      signature: '(commandId: string, handler: (...args) => any) => Disposable',
      description: 'Register a command handler',
      notes: 'Core functionality, fully supported'
    },
    'vscode.commands.executeCommand': {
      signature: '(commandId: string, ...args) => Promise<any>',
      description: 'Execute a registered command',
      notes: 'Only extension-registered commands are supported'
    },
    'vscode.commands.getCommands': {
      signature: '(filterInternal?: boolean) => Promise<string[]>',
      description: 'Get list of registered commands',
      notes: 'Returns only extension-registered commands'
    },

    // Window - Messages
    'vscode.window.showInformationMessage': {
      signature: '(message: string, ...items) => Promise<string|undefined>',
      description: 'Show an information message',
      notes: 'Items selection not fully implemented'
    },
    'vscode.window.showWarningMessage': {
      signature: '(message: string, ...items) => Promise<string|undefined>',
      description: 'Show a warning message',
      notes: 'Items selection not fully implemented'
    },
    'vscode.window.showErrorMessage': {
      signature: '(message: string, ...items) => Promise<string|undefined>',
      description: 'Show an error message',
      notes: 'Items selection not fully implemented'
    },

    // Window - Webviews
    'vscode.window.createWebviewPanel': {
      signature: '(viewType: string, title: string, showOptions, options?) => WebviewPanel',
      description: 'Create a webview panel',
      notes: 'Webviews run in sandboxed iframes'
    },

    // Window - Output
    'vscode.window.createOutputChannel': {
      signature: '(name: string) => OutputChannel',
      description: 'Create an output channel',
      notes: 'Outputs to console in current implementation'
    },
    'vscode.window.setStatusBarMessage': {
      signature: '(text: string, hideAfterTimeout?: number) => Disposable',
      description: 'Set a status bar message',
      notes: 'Full support'
    },

    // Classes
    'vscode.EventEmitter': {
      signature: 'class EventEmitter<T>',
      description: 'Event emitter for creating events',
      notes: 'Full support'
    },
    'vscode.Disposable': {
      signature: 'class Disposable',
      description: 'Represents a disposable resource',
      notes: 'Full support'
    },
    'vscode.Uri': {
      signature: 'class Uri',
      description: 'URI utility class',
      notes: 'Basic parse() and file() methods supported'
    },
    'vscode.Position': {
      signature: 'class Position',
      description: 'Text position',
      notes: 'Full support'
    },
    'vscode.Range': {
      signature: 'class Range',
      description: 'Text range',
      notes: 'Full support'
    },

    // Configuration
    'vscode.workspace.getConfiguration': {
      signature: '(section?: string) => WorkspaceConfiguration',
      description: 'Get configuration values',
      notes: 'Returns defaults only in current implementation'
    }
  },

  // =========================================================================
  // EXPERIMENTAL APIs - May change
  // =========================================================================
  experimental: {
    // Language features (stubs)
    'vscode.languages.registerCompletionItemProvider': {
      signature: '(selector, provider, ...triggerCharacters) => Disposable',
      description: 'Register a completion provider',
      notes: 'Stub implementation - completions not shown yet',
      plannedStableVersion: '2.0.0'
    },
    'vscode.languages.registerHoverProvider': {
      signature: '(selector, provider) => Disposable',
      description: 'Register a hover provider',
      notes: 'Stub implementation',
      plannedStableVersion: '2.0.0'
    },
    'vscode.languages.registerDefinitionProvider': {
      signature: '(selector, provider) => Disposable',
      description: 'Register a go-to-definition provider',
      notes: 'Stub implementation',
      plannedStableVersion: '2.0.0'
    },
    'vscode.languages.createDiagnosticCollection': {
      signature: '(name?: string) => DiagnosticCollection',
      description: 'Create a diagnostic collection',
      notes: 'Diagnostics stored but not displayed yet',
      plannedStableVersion: '2.0.0'
    },

    // Window - Quick input
    'vscode.window.showQuickPick': {
      signature: '(items, options?) => Promise<string|undefined>',
      description: 'Show a quick pick',
      notes: 'Not yet implemented',
      plannedStableVersion: '1.5.0'
    },
    'vscode.window.showInputBox': {
      signature: '(options?) => Promise<string|undefined>',
      description: 'Show an input box',
      notes: 'Not yet implemented',
      plannedStableVersion: '1.5.0'
    },

    // Status bar items
    'vscode.window.createStatusBarItem': {
      signature: '(alignment?, priority?) => StatusBarItem',
      description: 'Create a status bar item',
      notes: 'Not yet implemented',
      plannedStableVersion: '1.5.0'
    },

    // Tree views
    'vscode.window.createTreeView': {
      signature: '(viewId, options) => TreeView',
      description: 'Create a tree view',
      notes: 'Not yet implemented',
      plannedStableVersion: '2.0.0'
    },
    'vscode.window.registerTreeDataProvider': {
      signature: '(viewId, provider) => Disposable',
      description: 'Register a tree data provider',
      notes: 'Not yet implemented',
      plannedStableVersion: '2.0.0'
    },

    // Workspace
    'vscode.workspace.workspaceFolders': {
      signature: 'WorkspaceFolder[] | undefined',
      description: 'Workspace folders',
      notes: 'Returns empty array currently',
      plannedStableVersion: '1.5.0'
    },
    'vscode.workspace.onDidChangeConfiguration': {
      signature: 'Event<ConfigurationChangeEvent>',
      description: 'Configuration change event',
      notes: 'Event fires but configuration is static',
      plannedStableVersion: '1.5.0'
    }
  },

  // =========================================================================
  // DEPRECATED APIs - Avoid using
  // =========================================================================
  deprecated: {
    // None yet
  },

  // =========================================================================
  // NEVER SUPPORTED APIs - Will not be implemented
  // =========================================================================
  neverSupported: {
    // Debug
    'vscode.debug': {
      reason: 'Debug adapters require Node.js process communication',
      alternative: 'Use web-based debugging tools'
    },
    'vscode.debug.startDebugging': {
      reason: 'Cannot spawn debug processes in browser',
      alternative: null
    },
    'vscode.debug.registerDebugAdapterProvider': {
      reason: 'Debug adapters are Node.js processes',
      alternative: null
    },

    // Tasks
    'vscode.tasks': {
      reason: 'Tasks require shell/process execution',
      alternative: 'Use terminal integration when available'
    },
    'vscode.tasks.registerTaskProvider': {
      reason: 'Cannot spawn shell processes in browser',
      alternative: null
    },

    // Terminal
    'vscode.window.createTerminal': {
      reason: 'Requires PTY and shell process',
      alternative: 'Use integrated terminal when available'
    },

    // SCM
    'vscode.scm': {
      reason: 'SCM requires file system and git process access',
      alternative: 'Use web-based git integration'
    },

    // Authentication
    'vscode.authentication': {
      reason: 'OAuth flows require server-side component',
      alternative: 'Use application-level authentication'
    },

    // Comments
    'vscode.comments': {
      reason: 'Comment threads require deep editor integration',
      alternative: null
    },

    // Notebooks
    'vscode.notebooks': {
      reason: 'Notebook rendering requires kernel processes',
      alternative: null
    },

    // Testing
    'vscode.testing': {
      reason: 'Test discovery/execution requires process spawning',
      alternative: 'Use web-based test runners'
    },

    // Localization
    'vscode.l10n': {
      reason: 'Localization bundle loading not implemented',
      alternative: 'Bundle translations in extension'
    },

    // Extension access
    'vscode.extensions.getExtension': {
      reason: 'Extensions are isolated, cannot access each other',
      alternative: 'Use command registration for inter-extension communication'
    },

    // Environment
    'vscode.env.clipboard': {
      reason: 'Clipboard requires user gesture in browsers',
      alternative: 'Use document.execCommand in webviews'
    },
    'vscode.env.shell': {
      reason: 'No shell access in browser',
      alternative: null
    },
    'vscode.env.openExternal': {
      reason: 'Opening external URLs blocked by browser security',
      alternative: 'Use links in webviews'
    },

    // File System
    'vscode.workspace.fs': {
      reason: 'Direct file system access not available in browser',
      alternative: 'Use workspace file APIs when available'
    },

    // Custom editors
    'vscode.window.registerCustomEditorProvider': {
      reason: 'Custom editors require deep integration',
      alternative: 'Use webview panels'
    },
    'vscode.window.registerWebviewViewProvider': {
      reason: 'Webview views not implemented',
      alternative: 'Use webview panels'
    }
  }
});

/**
 * Check if an API is supported
 * @param {string} api - API path like 'vscode.commands.registerCommand'
 * @returns {{supported: boolean, stability: APIStability, notes?: string}}
 */
export function checkAPISupport(api) {
  if (FROZEN_API_V1.stable[api]) {
    return {
      supported: true,
      stability: APIStability.STABLE,
      notes: FROZEN_API_V1.stable[api].notes
    };
  }

  if (FROZEN_API_V1.experimental[api]) {
    return {
      supported: true,
      stability: APIStability.EXPERIMENTAL,
      notes: FROZEN_API_V1.experimental[api].notes,
      plannedStableVersion: FROZEN_API_V1.experimental[api].plannedStableVersion
    };
  }

  if (FROZEN_API_V1.deprecated[api]) {
    return {
      supported: true,
      stability: APIStability.DEPRECATED,
      notes: FROZEN_API_V1.deprecated[api].notes
    };
  }

  if (FROZEN_API_V1.neverSupported[api]) {
    return {
      supported: false,
      stability: APIStability.NEVER_SUPPORTED,
      reason: FROZEN_API_V1.neverSupported[api].reason,
      alternative: FROZEN_API_V1.neverSupported[api].alternative
    };
  }

  // Check namespace-level
  const namespace = api.split('.').slice(0, 2).join('.');
  if (FROZEN_API_V1.neverSupported[namespace]) {
    return {
      supported: false,
      stability: APIStability.NEVER_SUPPORTED,
      reason: FROZEN_API_V1.neverSupported[namespace].reason,
      alternative: FROZEN_API_V1.neverSupported[namespace].alternative
    };
  }

  return {
    supported: false,
    stability: APIStability.NEVER_SUPPORTED,
    notes: 'API not in frozen specification'
  };
}

/**
 * Get all stable APIs
 * @returns {string[]}
 */
export function getStableAPIs() {
  return Object.keys(FROZEN_API_V1.stable);
}

/**
 * Get all experimental APIs
 * @returns {string[]}
 */
export function getExperimentalAPIs() {
  return Object.keys(FROZEN_API_V1.experimental);
}

/**
 * Get all never-supported APIs
 * @returns {string[]}
 */
export function getNeverSupportedAPIs() {
  return Object.keys(FROZEN_API_V1.neverSupported);
}

/**
 * Generate API documentation
 * @returns {string}
 */
export function generateAPIDocumentation() {
  let doc = `# Synthi Extension API Reference\n\n`;
  doc += `Version: ${FROZEN_API_V1.version}\n`;
  doc += `Frozen: ${FROZEN_API_V1.frozenAt}\n\n`;

  doc += `## Stable APIs\n\n`;
  doc += `These APIs are guaranteed to work. Breaking changes require a major version bump.\n\n`;
  for (const [api, info] of Object.entries(FROZEN_API_V1.stable)) {
    doc += `### \`${api}\`\n\n`;
    doc += `**Signature:** \`${info.signature}\`\n\n`;
    doc += `${info.description}\n\n`;
    if (info.notes) {
      doc += `> ${info.notes}\n\n`;
    }
  }

  doc += `## Experimental APIs\n\n`;
  doc += `These APIs may change. Use at your own risk.\n\n`;
  for (const [api, info] of Object.entries(FROZEN_API_V1.experimental)) {
    doc += `### \`${api}\` ⚠️\n\n`;
    doc += `**Signature:** \`${info.signature}\`\n\n`;
    doc += `${info.description}\n\n`;
    if (info.notes) {
      doc += `> ${info.notes}\n\n`;
    }
    if (info.plannedStableVersion) {
      doc += `Planned stable in: v${info.plannedStableVersion}\n\n`;
    }
  }

  doc += `## Never Supported APIs\n\n`;
  doc += `These APIs will never be implemented in Synthi.\n\n`;
  for (const [api, info] of Object.entries(FROZEN_API_V1.neverSupported)) {
    doc += `### \`${api}\` ❌\n\n`;
    doc += `**Reason:** ${info.reason}\n\n`;
    if (info.alternative) {
      doc += `**Alternative:** ${info.alternative}\n\n`;
    }
  }

  return doc;
}
