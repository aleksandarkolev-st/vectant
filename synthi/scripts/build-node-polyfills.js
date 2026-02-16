/**
 * Build script: bundles all Node.js browser polyfills into a single file
 * that the extension host worker loads via importScripts().
 * 
 * Usage: node scripts/build-node-polyfills.js
 * Output: public/node-polyfills.js
 */

const { build } = require('esbuild');
const path = require('path');

async function main() {
  const start = Date.now();
  
  await build({
    entryPoints: [path.join(__dirname, 'polyfill-entry.js')],
    bundle: true,
    outfile: path.join(__dirname, '..', 'public', 'node-polyfills.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    // Keep it readable for debugging, minify in prod
    minify: process.argv.includes('--minify'),
    sourcemap: false,
    // Alias Node.js builtins to their browser polyfill packages
    alias: {
      'stream': 'stream-browserify',
      'crypto': 'crypto-browserify',
      '_stream_readable': 'readable-stream/lib/_stream_readable',
      '_stream_writable': 'readable-stream/lib/_stream_writable',
      '_stream_duplex': 'readable-stream/lib/_stream_duplex',
      '_stream_transform': 'readable-stream/lib/_stream_transform',
      '_stream_passthrough': 'readable-stream/lib/_stream_passthrough',
    },
    // Define Node.js globals that polyfill packages expect
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NODE_DEBUG': '""',
    },
    // Ignore truly-node-only modules that some polyfills try to optionally require
    external: [],
    // Log level
    logLevel: 'info',
  });

  const elapsed = Date.now() - start;
  console.log(`✅ Built public/node-polyfills.js in ${elapsed}ms`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
