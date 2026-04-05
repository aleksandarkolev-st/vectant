import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = { eslint: { ignoreDuringBuilds: true },
  // Produce a self-contained build in .next/standalone for Docker deployment.
  // This copies only the files needed to run the app (~150 MB vs full node_modules).
  output: 'standalone',
  // Turbopack-specific configuration (used by `next dev --turbopack`)
  turbopack: {
    root: __dirname,
    resolveAlias: {
      // Ensure a single Monaco instance: monaco-languageclient uses
      // @codingame/monaco-vscode-editor-api internally; the editor must
      // use the same instance for LSP features to work.
      'monaco-editor': '@codingame/monaco-vscode-editor-api',
      // Yjs dedup
      'yjs': './node_modules/yjs/dist/yjs.mjs',
    },
  },
  // Webpack fallback (used by `next build` without turbopack)
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // Force all yjs imports to use the same instance
        // See: https://github.com/yjs/yjs/issues/438
        'yjs': path.resolve(__dirname, 'node_modules/yjs/dist/yjs.mjs'),
        // CRITICAL: Ensure a single Monaco instance across the app.
        // monaco-languageclient uses @codingame/monaco-vscode-editor-api internally;
        // the editor must use the same instance for LSP features (completions,
        // hover, go-to-definition, etc.) to work.
        // The '$' suffix means EXACT match only — sub-path imports like
        // 'monaco-editor/esm/vs/language/...' (used for Web Workers) still
        // resolve to the original monaco-editor package.
        'monaco-editor$': path.resolve(__dirname, 'node_modules/@codingame/monaco-vscode-editor-api'),
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
