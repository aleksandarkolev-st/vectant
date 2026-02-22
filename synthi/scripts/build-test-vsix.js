#!/usr/bin/env node
/**
 * Build a minimal test .vsix file for testing the extension install flow.
 * 
 * Usage:  node scripts/build-test-vsix.js
 * Output: public/test-extension.vsix
 * 
 * A .vsix is just a ZIP with:
 *   extension/package.json   ← manifest
 *   extension/extension.js   ← entry point
 *   [Content_Types].xml      ← required by VSIX spec
 */

const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const manifest = {
  name: 'test-vsix-extension',
  displayName: 'Test VSIX Extension',
  description: 'A minimal .vsix extension to verify the install-from-file pipeline works.',
  version: '0.1.0',
  publisher: 'synthi-test',
  engines: { vscode: '^1.80.0' },
  activationEvents: ['onCommand:testVsix.greet'],
  main: './extension.js',
  contributes: {
    commands: [
      { command: 'testVsix.greet', title: 'Test VSIX: Greet' },
    ],
  },
};

const extensionCode = `
// Test VSIX Extension
function activate(context) {
  console.log('[TestVSIX] Extension activated!');

  const disposable = vscode.commands.registerCommand('testVsix.greet', () => {
    vscode.window.showInformationMessage('Hello from the Test VSIX extension! 🎉 Install from .vsix works!');
    return 'Greetings!';
  });

  context.subscriptions.push(disposable);
  vscode.window.showInformationMessage('Test VSIX extension loaded successfully from .vsix file!');
}

function deactivate() {
  console.log('[TestVSIX] Extension deactivated');
}

module.exports = { activate, deactivate };
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
</Types>`;

async function main() {
  const zip = new JSZip();

  zip.file('extension/package.json', JSON.stringify(manifest, null, 2));
  zip.file('extension/extension.js', extensionCode);
  zip.file('[Content_Types].xml', contentTypes);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const outPath = path.join(__dirname, '..', 'public', 'test-extension.vsix');
  fs.writeFileSync(outPath, buffer);

  console.log(`✅ Built test VSIX: ${outPath} (${buffer.length} bytes)`);
  console.log('');
  console.log('To test:');
  console.log('  1. Open the workspace in the browser');
  console.log('  2. Click the Extensions puzzle icon in the Activity Bar');
  console.log('  3. Click the + button → drop or browse for public/test-extension.vsix');
  console.log('  4. Or download it from http://localhost:3000/test-extension.vsix');
}

main().catch(err => { console.error(err); process.exit(1); });
