/**
 * Bad Extension: Infinite Loop
 * This extension intentionally has an infinite loop to test:
 * - Activation timeout kills execution
 * - Scheduler kills runaway code
 * - IDE survives
 * - Extension is marked dead
 */

function activate(context) {
  console.log('[BadExtension] activate() called - about to infinite loop');
  
  // Infinite loop - this MUST be killed by the activation timeout
  while (true) {
    // This should trigger activation timeout at 1000ms
  }
  
  // This code should NEVER execute
  console.log('[BadExtension] THIS SHOULD NEVER PRINT');
}

function deactivate() {
  console.log('[BadExtension] deactivate() called');
}

module.exports = { activate, deactivate };
