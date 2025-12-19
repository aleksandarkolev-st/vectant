'use client';

/**
 * Extension System Debug Panel
 * A React component for testing the extension system within Synthi IDE
 */

import { useState, useEffect, useCallback } from 'react';

// Test extension code
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
    
    panel.webview.html = '<html><body style="background:#1e1e1e;color:#fff;padding:20px;"><h1>Hello World!</h1><p>Webview is working!</p></body></html>';
    return panel;
  });
  
  context.subscriptions.push(webviewCmd);
  
  console.log('[HelloWorld] Activation complete, 2 commands registered');
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

export default function ExtensionDebugPanel() {
  const [extensionSystem, setExtensionSystem] = useState(null);
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState({
    initialized: false,
    loaded: false,
    activated: false,
    commandExecuted: false
  });
  const [metrics, setMetrics] = useState(null);

  const addLog = useCallback((message, level = 'info') => {
    setLogs(prev => [...prev, { 
      time: new Date().toLocaleTimeString(), 
      message, 
      level 
    }]);
  }, []);

  // Initialize extension system
  const initialize = useCallback(async () => {
    try {
      addLog('Initializing extension system...');
      
      const { initializeExtensionSystem } = await import('@/extensions');
      
      // Worker is served from public folder
      const workerUrl = '/extension-host-worker.js';
      addLog(`Worker URL: ${workerUrl}`);
      
      const system = await initializeExtensionSystem({
        workerUrl,
        workspaceId: 'debug-test'
      });
      
      setExtensionSystem(system);
      setStatus(prev => ({ ...prev, initialized: true }));
      addLog('✓ Extension system initialized', 'success');
    } catch (err) {
      addLog(`✗ Initialization failed: ${err.message}`, 'error');
      console.error(err);
    }
  }, [addLog]);

  // Load extension
  const loadExtension = useCallback(async () => {
    if (!extensionSystem) return;
    
    try {
      addLog('Loading Hello World extension...');
      
      await extensionSystem.registerExtension(
        'synthi.hello-world',
        HELLO_WORLD_MANIFEST,
        HELLO_WORLD_CODE
      );
      
      setStatus(prev => ({ ...prev, loaded: true }));
      addLog('✓ Extension loaded', 'success');
    } catch (err) {
      addLog(`✗ Load failed: ${err.message}`, 'error');
    }
  }, [extensionSystem, addLog]);

  // Activate extension
  const activateExtension = useCallback(async () => {
    if (!extensionSystem) return;
    
    try {
      addLog('Activating extension...');
      
      const result = await extensionSystem.activateExtension('synthi.hello-world');
      
      setStatus(prev => ({ ...prev, activated: result.success }));
      addLog(`✓ Activation complete in ${result.activationTime?.toFixed(1) || '?'}ms`, 'success');
    } catch (err) {
      addLog(`✗ Activation failed: ${err.message}`, 'error');
    }
  }, [extensionSystem, addLog]);

  // Execute command
  const executeCommand = useCallback(async () => {
    if (!extensionSystem) return;
    
    try {
      addLog('Executing command helloWorld.sayHello...');
      
      const result = await extensionSystem.executeCommand('helloWorld.sayHello');
      
      setStatus(prev => ({ ...prev, commandExecuted: true }));
      addLog(`✓ Command returned: ${result}`, 'success');
    } catch (err) {
      addLog(`✗ Command failed: ${err.message}`, 'error');
    }
  }, [extensionSystem, addLog]);

  // Get metrics
  const refreshMetrics = useCallback(() => {
    if (!extensionSystem) return;
    
    try {
      const m = extensionSystem.getMetrics();
      setMetrics(m);
    } catch (err) {
      addLog(`Metrics error: ${err.message}`, 'error');
    }
  }, [extensionSystem, addLog]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (extensionSystem) {
        extensionSystem.dispose();
      }
    };
  }, [extensionSystem]);

  return (
    <div style={{
      fontFamily: 'system-ui, sans-serif',
      background: '#1e1e1e',
      color: '#d4d4d4',
      padding: '20px',
      borderRadius: '8px',
      maxWidth: '800px'
    }}>
      <h2 style={{ color: '#569cd6', margin: '0 0 20px 0' }}>
        🧪 Extension System Debug Panel
      </h2>

      {/* Step-by-step controls */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={initialize} 
            disabled={status.initialized}
            style={buttonStyle(status.initialized)}
          >
            1. Initialize Worker
          </button>
          <StatusBadge ok={status.initialized} />
        </div>

        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={loadExtension} 
            disabled={!status.initialized || status.loaded}
            style={buttonStyle(status.loaded)}
          >
            2. Load Extension
          </button>
          <StatusBadge ok={status.loaded} />
        </div>

        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={activateExtension} 
            disabled={!status.loaded || status.activated}
            style={buttonStyle(status.activated)}
          >
            3. Activate Extension
          </button>
          <StatusBadge ok={status.activated} />
        </div>

        <div style={{ marginBottom: '10px' }}>
          <button 
            onClick={executeCommand} 
            disabled={!status.activated}
            style={buttonStyle(status.commandExecuted)}
          >
            4. Execute Command
          </button>
          <StatusBadge ok={status.commandExecuted} />
        </div>

        <div>
          <button 
            onClick={refreshMetrics} 
            disabled={!status.initialized}
            style={buttonStyle(false)}
          >
            Refresh Metrics
          </button>
        </div>
      </div>

      {/* Metrics display */}
      {metrics && (
        <div style={{ 
          background: '#252526', 
          padding: '10px', 
          borderRadius: '4px',
          marginBottom: '20px' 
        }}>
          <h3 style={{ color: '#4ec9b0', margin: '0 0 10px 0' }}>Metrics</h3>
          <pre style={{ margin: 0, fontSize: '12px', overflow: 'auto' }}>
            {JSON.stringify(metrics, null, 2)}
          </pre>
        </div>
      )}

      {/* Log output */}
      <div style={{ 
        background: '#1e1e1e', 
        border: '1px solid #3c3c3c',
        borderRadius: '4px',
        padding: '10px',
        maxHeight: '300px',
        overflowY: 'auto'
      }}>
        <h3 style={{ color: '#4ec9b0', margin: '0 0 10px 0' }}>Log</h3>
        {logs.map((log, i) => (
          <div key={i} style={{ 
            fontFamily: 'monospace', 
            fontSize: '12px',
            color: log.level === 'error' ? '#f14c4c' : 
                   log.level === 'success' ? '#4ec9b0' : 
                   log.level === 'warn' ? '#ce9178' : '#9cdcfe'
          }}>
            [{log.time}] {log.message}
          </div>
        ))}
        {logs.length === 0 && (
          <div style={{ color: '#6a6a6a', fontStyle: 'italic' }}>
            No logs yet. Click "Initialize Worker" to begin.
          </div>
        )}
      </div>
    </div>
  );
}

function buttonStyle(done) {
  return {
    background: done ? '#2d5a2d' : '#0e639c',
    color: 'white',
    border: 'none',
    padding: '8px 16px',
    marginRight: '10px',
    borderRadius: '4px',
    cursor: done ? 'default' : 'pointer',
    opacity: done ? 0.7 : 1
  };
}

function StatusBadge({ ok }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '3px',
      fontSize: '12px',
      fontWeight: 'bold',
      background: ok ? '#2d5a2d' : '#3c3c3c',
      color: ok ? '#4ec9b0' : '#6a6a6a'
    }}>
      {ok ? '✓' : '○'}
    </span>
  );
}
