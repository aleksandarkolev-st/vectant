/**
 * Synthi Extension System - VSIX Compatibility Classifier
 * PHASE C: Real VSIX Compatibility Control
 * 
 * This module analyzes VSIX packages and classifies them as:
 * - SUPPORTED: Full compatibility expected
 * - PARTIALLY_SUPPORTED: Some features may not work
 * - UNSUPPORTED: Cannot run in Synthi
 * 
 * Classification is based on:
 * - Activation events used
 * - APIs referenced
 * - Native dependencies
 * - Node.js usage
 * - Webview reliance
 */

/**
 * Compatibility levels
 * @readonly
 * @enum {string}
 */
export const CompatibilityLevel = Object.freeze({
  SUPPORTED: 'supported',
  PARTIALLY_SUPPORTED: 'partially_supported',
  UNSUPPORTED: 'unsupported'
});

/**
 * Supported activation events
 */
const SUPPORTED_ACTIVATION_EVENTS = new Set([
  '*',
  'onStartupFinished',
  'onCommand',
  'onLanguage',
  'onView',
  'onUri',
  'onWebviewPanel',
  'workspaceContains'
]);

/**
 * Partially supported activation events
 */
const PARTIAL_ACTIVATION_EVENTS = new Set([
  'onFileSystem',
  'onSearch',
  'onNotebook',
  'onAuthenticationRequest'
]);

/**
 * Never supported activation events
 */
const UNSUPPORTED_ACTIVATION_EVENTS = new Set([
  'onDebug',
  'onDebugResolve',
  'onDebugInitialConfigurations',
  'onDebugDynamicConfigurations',
  'onDebugAdapterProtocolTracker',
  'onTerminalProfile',
  'onRenderer',
  'onCustomEditor'
]);

/**
 * API namespaces and their support level
 */
const API_SUPPORT = {
  // Fully supported
  supported: new Set([
    'vscode.commands',
    'vscode.window.showInformationMessage',
    'vscode.window.showWarningMessage',
    'vscode.window.showErrorMessage',
    'vscode.window.createWebviewPanel',
    'vscode.window.createOutputChannel',
    'vscode.window.setStatusBarMessage',
    'vscode.workspace.getConfiguration',
    'vscode.EventEmitter',
    'vscode.Disposable',
    'vscode.Uri',
    'vscode.Position',
    'vscode.Range'
  ]),
  
  // Partially supported (stubs that may not fully work)
  partial: new Set([
    'vscode.languages.registerCompletionItemProvider',
    'vscode.languages.registerHoverProvider',
    'vscode.languages.registerDefinitionProvider',
    'vscode.languages.createDiagnosticCollection',
    'vscode.workspace.workspaceFolders',
    'vscode.workspace.name',
    'vscode.workspace.onDidChangeConfiguration',
    'vscode.window.createStatusBarItem',
    'vscode.window.showQuickPick',
    'vscode.window.showInputBox',
    'vscode.window.createTreeView',
    'vscode.window.registerTreeDataProvider'
  ]),
  
  // Not supported at all
  unsupported: new Set([
    'vscode.debug',
    'vscode.tasks',
    'vscode.scm',
    'vscode.comments',
    'vscode.authentication',
    'vscode.notebooks',
    'vscode.testing',
    'vscode.l10n',
    'vscode.extensions.getExtension',
    'vscode.env.clipboard',
    'vscode.env.shell',
    'vscode.env.openExternal',
    'vscode.workspace.fs',
    'vscode.window.createTerminal',
    'vscode.window.registerCustomEditorProvider',
    'vscode.window.registerWebviewViewProvider'
  ])
};

/**
 * Node.js built-in modules that indicate native dependency
 */
const NODE_BUILTIN_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'worker_threads',
  'crypto',
  'zlib'
]);

/**
 * Patterns that indicate native modules
 */
const NATIVE_MODULE_PATTERNS = [
  /\.node$/,
  /^native-/,
  /^node-gyp/,
  /node_modules.*\.node$/,
  /binding\.gyp/,
  /prebuild-install/,
  /node-addon-api/
];

/**
 * @typedef {Object} CompatibilityIssue
 * @property {'error'|'warning'|'info'} severity
 * @property {string} code
 * @property {string} message
 * @property {string} [suggestion]
 */

/**
 * @typedef {Object} CompatibilityReport
 * @property {CompatibilityLevel} level
 * @property {CompatibilityIssue[]} issues
 * @property {string[]} supportedFeatures
 * @property {string[]} partialFeatures
 * @property {string[]} unsupportedFeatures
 * @property {boolean} canInstall
 * @property {string} summary
 */

/**
 * Classify a VSIX extension's compatibility
 */
export class VSIXCompatibilityClassifier {
  constructor() {
    /** @type {CompatibilityIssue[]} */
    this.issues = [];
    
    /** @type {string[]} */
    this.supportedFeatures = [];
    
    /** @type {string[]} */
    this.partialFeatures = [];
    
    /** @type {string[]} */
    this.unsupportedFeatures = [];
  }

  /**
   * Classify an extension
   * @param {object} manifest - package.json contents
   * @param {string} [entrypointCode] - Main entry point code (optional)
   * @returns {CompatibilityReport}
   */
  classify(manifest, entrypointCode = null) {
    this.issues = [];
    this.supportedFeatures = [];
    this.partialFeatures = [];
    this.unsupportedFeatures = [];

    // Check activation events
    this._checkActivationEvents(manifest.activationEvents || []);

    // Check contributes
    this._checkContributes(manifest.contributes || {});

    // Check engines
    this._checkEngines(manifest.engines || {});

    // Check dependencies
    this._checkDependencies(manifest.dependencies || {});
    this._checkDependencies(manifest.devDependencies || {}, true);

    // Check for native deps indicators
    this._checkNativeIndicators(manifest);

    // If we have the code, analyze it
    if (entrypointCode) {
      this._analyzeCode(entrypointCode);
    }

    // Determine final level
    const level = this._determineLevel();

    return {
      level,
      issues: this.issues,
      supportedFeatures: this.supportedFeatures,
      partialFeatures: this.partialFeatures,
      unsupportedFeatures: this.unsupportedFeatures,
      canInstall: level !== CompatibilityLevel.UNSUPPORTED,
      summary: this._generateSummary(level)
    };
  }

  _checkActivationEvents(events) {
    if (!events || events.length === 0) {
      this.issues.push({
        severity: 'warning',
        code: 'NO_ACTIVATION_EVENTS',
        message: 'No activation events specified',
        suggestion: 'Extension will be activated immediately'
      });
      return;
    }

    for (const event of events) {
      // Parse event type (e.g., 'onCommand:foo.bar' -> 'onCommand')
      const eventType = event.split(':')[0];

      if (SUPPORTED_ACTIVATION_EVENTS.has(eventType)) {
        this.supportedFeatures.push(`Activation: ${eventType}`);
      } else if (PARTIAL_ACTIVATION_EVENTS.has(eventType)) {
        this.partialFeatures.push(`Activation: ${eventType}`);
        this.issues.push({
          severity: 'warning',
          code: 'PARTIAL_ACTIVATION',
          message: `Activation event '${eventType}' has limited support`,
          suggestion: 'Some functionality may not work as expected'
        });
      } else if (UNSUPPORTED_ACTIVATION_EVENTS.has(eventType)) {
        this.unsupportedFeatures.push(`Activation: ${eventType}`);
        this.issues.push({
          severity: 'error',
          code: 'UNSUPPORTED_ACTIVATION',
          message: `Activation event '${eventType}' is not supported`,
          suggestion: 'This extension cannot run in Synthi'
        });
      } else {
        this.issues.push({
          severity: 'info',
          code: 'UNKNOWN_ACTIVATION',
          message: `Unknown activation event: ${eventType}`,
          suggestion: 'May or may not work'
        });
      }
    }
  }

  _checkContributes(contributes) {
    // Commands - fully supported
    if (contributes.commands?.length > 0) {
      this.supportedFeatures.push(`${contributes.commands.length} commands`);
    }

    // Configuration - fully supported
    if (contributes.configuration) {
      this.supportedFeatures.push('Configuration settings');
    }

    // Languages - partially supported
    if (contributes.languages?.length > 0) {
      this.partialFeatures.push(`${contributes.languages.length} language definitions`);
      this.issues.push({
        severity: 'warning',
        code: 'PARTIAL_LANGUAGES',
        message: 'Language contributions have limited support',
        suggestion: 'Basic syntax highlighting should work'
      });
    }

    // Grammars - partially supported
    if (contributes.grammars?.length > 0) {
      this.partialFeatures.push(`${contributes.grammars.length} grammars`);
    }

    // Themes - partially supported
    if (contributes.themes?.length > 0) {
      this.partialFeatures.push(`${contributes.themes.length} themes`);
    }

    // Snippets - partially supported
    if (contributes.snippets?.length > 0) {
      this.partialFeatures.push(`${contributes.snippets.length} snippet files`);
    }

    // Views - partially supported
    if (contributes.views) {
      const viewCount = Object.values(contributes.views).flat().length;
      this.partialFeatures.push(`${viewCount} views`);
      this.issues.push({
        severity: 'warning',
        code: 'PARTIAL_VIEWS',
        message: 'View contributions have limited support',
        suggestion: 'Views may not render correctly'
      });
    }

    // Menus - partially supported
    if (contributes.menus) {
      this.partialFeatures.push('Menu contributions');
    }

    // Debuggers - not supported
    if (contributes.debuggers?.length > 0) {
      this.unsupportedFeatures.push(`${contributes.debuggers.length} debuggers`);
      this.issues.push({
        severity: 'error',
        code: 'UNSUPPORTED_DEBUGGERS',
        message: 'Debug adapters are not supported',
        suggestion: 'Debugging features will not work'
      });
    }

    // Task providers - not supported
    if (contributes.taskDefinitions?.length > 0) {
      this.unsupportedFeatures.push('Task definitions');
      this.issues.push({
        severity: 'error',
        code: 'UNSUPPORTED_TASKS',
        message: 'Task providers are not supported',
        suggestion: 'Task-related features will not work'
      });
    }

    // Terminal profiles - not supported
    if (contributes.terminal) {
      this.unsupportedFeatures.push('Terminal contributions');
      this.issues.push({
        severity: 'error',
        code: 'UNSUPPORTED_TERMINAL',
        message: 'Terminal contributions are not supported'
      });
    }

    // Custom editors - not supported
    if (contributes.customEditors?.length > 0) {
      this.unsupportedFeatures.push('Custom editors');
      this.issues.push({
        severity: 'error',
        code: 'UNSUPPORTED_CUSTOM_EDITOR',
        message: 'Custom editors are not supported'
      });
    }

    // Notebooks - not supported
    if (contributes.notebooks?.length > 0) {
      this.unsupportedFeatures.push('Notebooks');
      this.issues.push({
        severity: 'error',
        code: 'UNSUPPORTED_NOTEBOOKS',
        message: 'Notebook contributions are not supported'
      });
    }
  }

  _checkEngines(engines) {
    const vscodeVersion = engines.vscode;
    if (vscodeVersion) {
      // Parse version requirement
      const minVersion = vscodeVersion.replace(/[^0-9.]/g, '').split('.')[0];
      if (parseInt(minVersion) > 1) {
        this.issues.push({
          severity: 'warning',
          code: 'HIGH_VSCODE_VERSION',
          message: `Extension requires VS Code ${vscodeVersion}`,
          suggestion: 'Some APIs may not be available'
        });
      }
    }

    // Check for Node.js version requirement
    if (engines.node) {
      this.issues.push({
        severity: 'warning',
        code: 'NODE_REQUIRED',
        message: `Extension specifies Node.js ${engines.node}`,
        suggestion: 'Node.js APIs are not available in browser context'
      });
    }
  }

  _checkDependencies(deps, isDev = false) {
    const prefix = isDev ? 'dev:' : '';
    
    for (const [name, version] of Object.entries(deps)) {
      // Check for known problematic packages
      if (NODE_BUILTIN_MODULES.has(name)) {
        this.unsupportedFeatures.push(`${prefix}${name}`);
        this.issues.push({
          severity: 'error',
          code: 'NODE_BUILTIN_DEP',
          message: `Dependency on Node.js builtin '${name}'`,
          suggestion: 'This package requires Node.js runtime'
        });
        continue;
      }

      // Check for native module patterns
      for (const pattern of NATIVE_MODULE_PATTERNS) {
        if (pattern.test(name)) {
          this.unsupportedFeatures.push(`${prefix}${name}`);
          this.issues.push({
            severity: 'error',
            code: 'NATIVE_DEP',
            message: `Native dependency detected: ${name}`,
            suggestion: 'Native modules cannot run in browser'
          });
          break;
        }
      }

      // Known problematic packages
      const problematicPackages = {
        'vscode-languageclient': { level: 'partial', reason: 'LSP requires server process' },
        'vscode-languageserver': { level: 'unsupported', reason: 'Requires Node.js process' },
        'tree-sitter': { level: 'unsupported', reason: 'Native WASM required' },
        'fsevents': { level: 'unsupported', reason: 'macOS native module' },
        'node-pty': { level: 'unsupported', reason: 'Terminal emulation requires Node.js' },
        'sqlite3': { level: 'unsupported', reason: 'Native database driver' },
        'sharp': { level: 'unsupported', reason: 'Native image processing' },
        'esbuild': { level: 'partial', reason: 'Build tool, may not be needed at runtime' },
        'webpack': { level: 'partial', reason: 'Build tool, may not be needed at runtime' }
      };

      const known = problematicPackages[name];
      if (known) {
        if (known.level === 'unsupported') {
          this.unsupportedFeatures.push(`${prefix}${name}`);
          this.issues.push({
            severity: 'error',
            code: 'KNOWN_UNSUPPORTED_DEP',
            message: `Unsupported dependency: ${name}`,
            suggestion: known.reason
          });
        } else if (known.level === 'partial') {
          this.partialFeatures.push(`${prefix}${name}`);
          this.issues.push({
            severity: 'warning',
            code: 'KNOWN_PARTIAL_DEP',
            message: `Dependency may have issues: ${name}`,
            suggestion: known.reason
          });
        }
      }
    }
  }

  _checkNativeIndicators(manifest) {
    // Check for scripts that suggest native compilation
    const scripts = manifest.scripts || {};
    const nativeScriptPatterns = ['node-gyp', 'prebuild', 'postinstall', 'node-pre-gyp'];
    
    for (const [name, script] of Object.entries(scripts)) {
      for (const pattern of nativeScriptPatterns) {
        if (script.includes(pattern)) {
          this.issues.push({
            severity: 'error',
            code: 'NATIVE_BUILD_SCRIPT',
            message: `Native build script detected: ${name}`,
            suggestion: 'Extension may require native compilation'
          });
          this.unsupportedFeatures.push('Native build');
          break;
        }
      }
    }

    // Check for browser field
    if (manifest.browser) {
      this.supportedFeatures.push('Browser entry point');
      this.issues.push({
        severity: 'info',
        code: 'HAS_BROWSER_ENTRY',
        message: 'Extension provides browser-specific entry point',
        suggestion: 'This improves compatibility'
      });
    }
  }

  _analyzeCode(code) {
    // Check for require() calls to Node.js modules
    const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requirePattern.exec(code)) !== null) {
      const moduleName = match[1];
      if (NODE_BUILTIN_MODULES.has(moduleName)) {
        this.issues.push({
          severity: 'error',
          code: 'CODE_NODE_REQUIRE',
          message: `Code requires Node.js module: ${moduleName}`,
          suggestion: 'This functionality will not work in browser'
        });
        this.unsupportedFeatures.push(`require('${moduleName}')`);
      }
    }

    // Check for fs operations
    if (/\bfs\.(read|write|unlink|mkdir|rmdir|stat|access)/.test(code)) {
      this.issues.push({
        severity: 'error',
        code: 'CODE_FS_USAGE',
        message: 'Code uses Node.js filesystem APIs',
        suggestion: 'File operations require workspace FS API'
      });
      this.unsupportedFeatures.push('Node.js fs module');
    }

    // Check for child_process
    if (/child_process|exec\(|spawn\(|fork\(/.test(code)) {
      this.issues.push({
        severity: 'error',
        code: 'CODE_CHILD_PROCESS',
        message: 'Code spawns child processes',
        suggestion: 'Process spawning is not available in browser'
      });
      this.unsupportedFeatures.push('child_process');
    }

    // Check for unsupported VS Code APIs
    for (const api of API_SUPPORT.unsupported) {
      const apiPattern = api.replace(/\./g, '\\.').replace('vscode', 'vscode');
      if (new RegExp(apiPattern).test(code)) {
        this.issues.push({
          severity: 'error',
          code: 'CODE_UNSUPPORTED_API',
          message: `Code uses unsupported API: ${api}`,
          suggestion: 'This API is not implemented in Synthi'
        });
        this.unsupportedFeatures.push(api);
      }
    }

    // Check for WebView usage patterns
    if (/createWebviewPanel|WebviewPanel/.test(code)) {
      this.partialFeatures.push('Webview');
      this.issues.push({
        severity: 'warning',
        code: 'CODE_WEBVIEW_USAGE',
        message: 'Extension uses webviews',
        suggestion: 'Webviews run in sandboxed iframes with some limitations'
      });
    }
  }

  _determineLevel() {
    const hasErrors = this.issues.some(i => i.severity === 'error');
    const hasWarnings = this.issues.some(i => i.severity === 'warning');
    const hasUnsupported = this.unsupportedFeatures.length > 0;

    if (hasErrors || hasUnsupported) {
      return CompatibilityLevel.UNSUPPORTED;
    }

    if (hasWarnings || this.partialFeatures.length > 0) {
      return CompatibilityLevel.PARTIALLY_SUPPORTED;
    }

    return CompatibilityLevel.SUPPORTED;
  }

  _generateSummary(level) {
    const errorCount = this.issues.filter(i => i.severity === 'error').length;
    const warningCount = this.issues.filter(i => i.severity === 'warning').length;

    switch (level) {
      case CompatibilityLevel.SUPPORTED:
        return 'Extension is fully compatible with Synthi';
      case CompatibilityLevel.PARTIALLY_SUPPORTED:
        return `Extension may work with ${warningCount} potential issue(s)`;
      case CompatibilityLevel.UNSUPPORTED:
        return `Extension cannot run in Synthi: ${errorCount} blocking issue(s)`;
      default:
        return 'Unknown compatibility level';
    }
  }
}

/**
 * Quick check if an extension is likely compatible
 * @param {object} manifest
 * @returns {boolean}
 */
export function quickCompatibilityCheck(manifest) {
  // Immediate disqualifiers
  const activationEvents = manifest.activationEvents || [];
  for (const event of activationEvents) {
    const eventType = event.split(':')[0];
    if (UNSUPPORTED_ACTIVATION_EVENTS.has(eventType)) {
      return false;
    }
  }

  const contributes = manifest.contributes || {};
  if (contributes.debuggers?.length > 0 ||
      contributes.taskDefinitions?.length > 0 ||
      contributes.customEditors?.length > 0 ||
      contributes.notebooks?.length > 0) {
    return false;
  }

  return true;
}

// Singleton
let classifierInstance = null;

/**
 * Get the singleton classifier
 * @returns {VSIXCompatibilityClassifier}
 */
export function getVSIXClassifier() {
  if (!classifierInstance) {
    classifierInstance = new VSIXCompatibilityClassifier();
  }
  return classifierInstance;
}
