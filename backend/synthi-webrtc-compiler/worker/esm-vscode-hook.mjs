/**
 * ESM Loader Hook for intercepting `import('vscode')`.
 *
 * Node.js 20.6+ supports `module.register()` to install custom ESM
 * loader hooks.  These hooks run in a separate worker thread and can
 * intercept ES module resolution and loading.
 *
 * This hook intercepts `import 'vscode'` and wraps the returned module
 * to notify the ext-host-preload.js script that the vscode API was
 * loaded via ESM (so it can apply its observation wrappers).
 *
 * Registration (from ext-host-preload.js):
 *   import { register } from 'node:module';
 *   register('./esm-vscode-hook.mjs', import.meta.url);
 *
 * Or via CJS:
 *   const { register } = require('node:module');
 *   register(new URL('./esm-vscode-hook.mjs', `file://${__filename}`));
 */

/**
 * resolve hook — intercept resolution of 'vscode' specifier.
 * We don't change the resolution, just add metadata to track it.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    // Let VS Code's resolver handle it, but tag it
    const result = await nextResolve(specifier, context);
    return {
      ...result,
      shortCircuit: result.shortCircuit,
    };
  }
  return nextResolve(specifier, context);
}

/**
 * load hook — intercept loading of 'vscode' module.
 * After VS Code's loader provides the real vscode API, we signal
 * the main thread via a port message so ext-host-preload can wrap it.
 */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  // If this is the vscode module, signal the main thread
  if (url === 'vscode' || url.endsWith('/vscode') || context.importAttributes?.vscode) {
    // We can't directly access the main thread's globals from here,
    // but we can use process.stderr to signal the preload script
    try {
      process.stderr.write('[esm-vscode-hook] vscode module loaded via ESM\n');
    } catch (_) {}
  }

  return result;
}
