/**
 * Node.js Test Runner for Extension System
 * Run with: node --experimental-vm-modules test-node.mjs
 * 
 * This tests the core extension functionality without a browser.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test extension code
const HELLO_WORLD_CODE = `
function activate(context) {
  console.log('[HelloWorld] activate() called!');
  
  const disposable = vscode.commands.registerCommand('helloWorld.sayHello', () => {
    console.log('[HelloWorld] Command executed: sayHello');
    return 'Hello from extension!';
  });
  
  context.subscriptions.push(disposable);
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
  version: '1.0.0',
  publisher: 'synthi',
  activationEvents: ['onCommand:helloWorld.sayHello'],
  contributes: {
    commands: [{ command: 'helloWorld.sayHello', title: 'Say Hello' }]
  }
};

// Message ID counter
let messageId = 0;

function createRequest(method, args = []) {
  return { id: ++messageId, type: 'request', method, args };
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('Extension System Node.js Test');
  console.log('='.repeat(60));
  console.log('');

  // Note: Web Workers don't exist in Node.js
  // This test validates the protocol and code structure
  console.log('⚠️  Note: Full worker tests require a browser environment.');
  console.log('   This script validates the extension code structure.');
  console.log('');

  // Test 1: Extension code is valid JavaScript
  console.log('Test 1: Extension code is valid JavaScript');
  try {
    new Function('vscode', 'module', HELLO_WORLD_CODE);
    console.log('  ✓ Extension code parses successfully');
  } catch (err) {
    console.log('  ✗ Extension code parse error:', err.message);
    process.exit(1);
  }

  // Test 2: Extension has activate function
  console.log('Test 2: Extension has activate function');
  try {
    const exports = {};
    const module = { exports };
    
    // Create mock vscode
    const mockVscode = {
      commands: {
        registerCommand: (id, handler) => {
          console.log(`    Registered command: ${id}`);
          return { dispose: () => {} };
        }
      },
      window: {
        showInformationMessage: (msg) => console.log(`    Message: ${msg}`)
      }
    };
    
    // Execute the extension code
    const factory = new Function('vscode', 'module', HELLO_WORLD_CODE);
    factory(mockVscode, module);
    
    if (typeof module.exports.activate === 'function') {
      console.log('  ✓ Extension exports activate()');
    } else {
      console.log('  ✗ Extension does not export activate()');
      process.exit(1);
    }
  } catch (err) {
    console.log('  ✗ Error:', err.message);
    process.exit(1);
  }

  // Test 3: Activation works
  console.log('Test 3: Extension activation');
  try {
    const exports = {};
    const module = { exports };
    const subscriptions = [];
    const context = { subscriptions };
    
    const registeredCommands = new Map();
    
    const mockVscode = {
      commands: {
        registerCommand: (id, handler) => {
          registeredCommands.set(id, handler);
          const disposable = { dispose: () => registeredCommands.delete(id) };
          return disposable;
        }
      },
      window: {
        showInformationMessage: (msg) => console.log(`    [UI] ${msg}`)
      }
    };
    
    const factory = new Function('vscode', 'module', HELLO_WORLD_CODE);
    factory(mockVscode, module);
    
    // Call activate
    module.exports.activate(context);
    
    if (registeredCommands.has('helloWorld.sayHello')) {
      console.log('  ✓ Command registered');
    } else {
      console.log('  ✗ Command not registered');
      process.exit(1);
    }
    
    if (subscriptions.length > 0) {
      console.log(`  ✓ ${subscriptions.length} subscription(s) added to context`);
    } else {
      console.log('  ✗ No subscriptions added');
      process.exit(1);
    }
  } catch (err) {
    console.log('  ✗ Activation error:', err.message);
    process.exit(1);
  }

  // Test 4: Command execution
  console.log('Test 4: Command execution');
  try {
    const exports = {};
    const module = { exports };
    const registeredCommands = new Map();
    
    const mockVscode = {
      commands: {
        registerCommand: (id, handler) => {
          registeredCommands.set(id, handler);
          return { dispose: () => {} };
        }
      },
      window: {
        showInformationMessage: (msg) => console.log(`    [UI] ${msg}`)
      }
    };
    
    const factory = new Function('vscode', 'module', HELLO_WORLD_CODE);
    factory(mockVscode, module);
    module.exports.activate({ subscriptions: [] });
    
    const handler = registeredCommands.get('helloWorld.sayHello');
    if (handler) {
      const result = handler();
      console.log(`  ✓ Command returned: "${result}"`);
    } else {
      console.log('  ✗ Command handler not found');
      process.exit(1);
    }
  } catch (err) {
    console.log('  ✗ Command error:', err.message);
    process.exit(1);
  }

  // Test 5: Message protocol
  console.log('Test 5: Message protocol');
  const loadMsg = createRequest('loadExtension', ['synthi.hello-world', HELLO_WORLD_CODE, HELLO_WORLD_MANIFEST]);
  const activateMsg = createRequest('activateExtension', ['synthi.hello-world']);
  const executeMsg = createRequest('executeCommand', ['helloWorld.sayHello']);
  
  console.log('  ✓ loadExtension message:', JSON.stringify(loadMsg).substring(0, 60) + '...');
  console.log('  ✓ activateExtension message:', JSON.stringify(activateMsg));
  console.log('  ✓ executeCommand message:', JSON.stringify(executeMsg));

  console.log('');
  console.log('='.repeat(60));
  console.log('All tests passed!');
  console.log('');
  console.log('To test in browser:');
  console.log('  1. Run: npx serve -l 3333 src/extensions/test');
  console.log('  2. Open: http://localhost:3333/test.html');
  console.log('='.repeat(60));
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
