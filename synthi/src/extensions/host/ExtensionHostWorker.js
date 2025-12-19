/**
 * Synthi Extension System - Extension Host Worker
 * Main entry point for the Web Worker that runs all extensions
 * 
 * CRITICAL: This is the ONLY place extension code executes.
 * No extension JS runs on the main thread.
 */

import { ExtensionHostMain } from './ExtensionHostMain.js';

// Create host instance
const host = new ExtensionHostMain();

// Handle messages from main thread
self.onmessage = (event) => {
  host.handleMessage(event.data);
};

// Signal ready
self.postMessage({
  id: 0,
  type: 'event',
  method: 'workerReady',
  args: []
});

// Export for debugging
self.extensionHost = host;
