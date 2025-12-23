/**
 * Extension Test Runner
 * Handles initialization and testing of the extension system
 */

import { MainThreadBridge } from '../bridge/MainThreadBridge.js';

// Inline extension code (loaded as strings)
const HELLO_WORLD_CODE = `
function activate(context) {
  console.log('[HelloWorld] activate() called!');
  
  const disposable = vscode.commands.registerCommand('helloWorld.sayHello', () => {
    console.log('[HelloWorld] Command executed: sayHello');
    vscode.window.showInformationMessage('Hello from Hello World Extension!');
    return 'Hello executed successfully!';
  });
  
  context.subscriptions.push(disposable);
  
  const webviewCmd = vscode.commands.registerCommand('helloWorld.openWebview', () => {
    console.log('[HelloWorld] Command executed: openWebview');
    
    const panel = vscode.window.createWebviewPanel(
      'helloWorldWebview',
      'Hello World Webview',
      { viewColumn: 1 },
      { enableScripts: true }
    );
    
    panel.webview.html = '<html><body><h1>Hello from Webview!</h1></body></html>';
    return panel;
  });
  
  context.subscriptions.push(webviewCmd);
  
  console.log('[HelloWorld] Activation complete');
}

function deactivate() {
  console.log('[HelloWorld] deactivate() called!');
}

module.exports = { activate, deactivate };
`;

const HELLO_WORLD_MANIFEST = {
  name: 'hello-world',
  displayName: 'Hello World',
  description: 'Test extension',
  version: '1.0.0',
  publisher: 'synthi',
  engines: { vscode: '^1.80.0' },
  activationEvents: ['onCommand:helloWorld.sayHello'],
  main: './extension.js',
  contributes: {
    commands: [
      { command: 'helloWorld.sayHello', title: 'Hello World: Say Hello' },
      { command: 'helloWorld.openWebview', title: 'Hello World: Open Webview' }
    ]
  }
};

const BAD_EXTENSION_CODE = `
function activate(context) {
  console.log('[BadExtension] activate() called - starting infinite loop');
  while (true) {
    // This should be killed by timeout
  }
  console.log('[BadExtension] THIS SHOULD NEVER PRINT');
}

function deactivate() {}

module.exports = { activate, deactivate };
`;

const BAD_EXTENSION_MANIFEST = {
  name: 'bad-extension',
  displayName: 'Bad Extension',
  description: 'Test extension with infinite loop',
  version: '1.0.0',
  publisher: 'synthi',
  engines: { vscode: '^1.80.0' },
  activationEvents: ['onCommand:badExtension.freeze'],
  main: './extension.js',
  contributes: {
    commands: [
      { command: 'badExtension.freeze', title: 'Bad Extension: Freeze' }
    ]
  }
};

export class ExtensionTestRunner {
  constructor() {
    /** @type {MainThreadBridge|null} */
    this.bridge = null;
    
    /** @type {boolean} */
    this.initialized = false;
  }

  /**
   * Initialize the extension system
   */
  async init() {
    if (this.initialized) {
      throw new Error('Already initialized');
    }

    // Create bridge
    this.bridge = new MainThreadBridge();
    
    // Build worker URL from module
    const workerUrl = new URL('../host/ExtensionHostWorker.js', import.meta.url).href;
    
    console.log('[TestRunner] Worker URL:', workerUrl);
    
    // Initialize with worker URL
    await this.bridge.init(workerUrl);
    
    // Set up message handlers
    this.bridge.onShowMessage = (type, message, options) => {
      console.log(`[Message:${type}] ${message}`);
      if (type === 'info') {
        // Could show a toast notification here
      }
    };
    
    this.bridge.onCreateWebview = (viewId, viewType, title, options) => {
      console.log(`[Webview] Created: ${viewId} - ${title}`);
    };
    
    this.initialized = true;
    console.log('[TestRunner] Initialized');
  }

  /**
   * Load the Hello World test extension
   */
  async loadHelloWorldExtension() {
    if (!this.bridge) throw new Error('Not initialized');
    
    await this.bridge.registerExtension(
      'synthi.hello-world',
      HELLO_WORLD_MANIFEST,
      HELLO_WORLD_CODE
    );
    
    console.log('[TestRunner] Hello World extension loaded');
  }

  /**
   * Load the bad test extension
   */
  async loadBadExtension() {
    if (!this.bridge) throw new Error('Not initialized');
    
    await this.bridge.registerExtension(
      'synthi.bad-extension',
      BAD_EXTENSION_MANIFEST,
      BAD_EXTENSION_CODE
    );
    
    console.log('[TestRunner] Bad extension loaded');
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number }>}
   */
  async activateExtension(extensionId) {
    if (!this.bridge) throw new Error('Not initialized');
    return this.bridge.activateExtension(extensionId);
  }

  /**
   * Execute a command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async executeCommand(commandId, ...args) {
    if (!this.bridge) throw new Error('Not initialized');
    return this.bridge.executeCommand(commandId, ...args);
  }

  /**
   * Get all extensions
   * @returns {Array}
   */
  getExtensions() {
    if (!this.bridge) return [];
    return this.bridge.getExtensions();
  }

  /**
   * Get extension info
   * @param {string} extensionId
   * @returns {object|undefined}
   */
  getExtension(extensionId) {
    if (!this.bridge) return undefined;
    return this.bridge.getExtension(extensionId);
  }

  /**
   * Shutdown
   */
  async shutdown() {
    if (this.bridge) {
      await this.bridge.shutdown();
      this.bridge = null;
    }
    this.initialized = false;
  }
}
