/**
 * Test Extension: Hello World
 * This is a minimal VS Code-compatible extension for testing.
 * 
 * It must:
 * 1. Export activate(context)
 * 2. Register one command
 * 3. Prove the system works
 */

function activate(context) {
  console.log('[HelloWorld] activate() called!');
  
  // Register a command
  const disposable = vscode.commands.registerCommand('helloWorld.sayHello', () => {
    console.log('[HelloWorld] Command executed: sayHello');
    vscode.window.showInformationMessage('Hello from Hello World Extension!');
    return 'Hello executed successfully!';
  });
  
  context.subscriptions.push(disposable);
  
  // Register another command for webview testing
  const webviewCmd = vscode.commands.registerCommand('helloWorld.openWebview', () => {
    console.log('[HelloWorld] Command executed: openWebview');
    
    const panel = vscode.window.createWebviewPanel(
      'helloWorldWebview',
      'Hello World Webview',
      { viewColumn: 1 },
      { enableScripts: true }
    );
    
    panel.webview.html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Hello World Webview</title>
          <style>
            body { font-family: sans-serif; padding: 20px; background: #1e1e1e; color: #fff; }
            button { padding: 10px 20px; font-size: 16px; cursor: pointer; }
          </style>
        </head>
        <body>
          <h1>Hello World Extension</h1>
          <p>This webview was opened from the extension!</p>
          <button onclick="sendMessage()">Send Message to Extension</button>
          <div id="output"></div>
          <script>
            const vscode = acquireVsCodeApi();
            function sendMessage() {
              vscode.postMessage({ type: 'hello', text: 'Message from webview!' });
              document.getElementById('output').innerText = 'Message sent!';
            }
            window.addEventListener('message', event => {
              document.getElementById('output').innerText = 'Received: ' + JSON.stringify(event.data);
            });
          </script>
        </body>
      </html>
    `;
    
    panel.webview.onDidReceiveMessage(message => {
      console.log('[HelloWorld] Webview message:', message);
      panel.webview.postMessage({ type: 'response', text: 'Got your message!' });
    });
    
    return panel;
  });
  
  context.subscriptions.push(webviewCmd);
  
  console.log('[HelloWorld] Activation complete, 2 commands registered');
}

function deactivate() {
  console.log('[HelloWorld] deactivate() called!');
}

// Export for CommonJS-style loading
module.exports = { activate, deactivate };
