import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { buildContentSecurityPolicy } from './src/lib/security/csp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve a dependency's path robustly whether npm hoisted it to the repo-root
// node_modules (npm workspaces) or kept it in synthi/node_modules. Falls back to
// the local path so a non-workspace checkout behaves exactly as before.
function resolveDep(rel) {
  const candidates = [
    path.resolve(__dirname, 'node_modules', rel),
    path.resolve(__dirname, '..', 'node_modules', rel),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

const contentSecurityPolicy = buildContentSecurityPolicy(
  // Use the configured collab URL; only fall back to localhost in non-production
  // so an unset env var never injects a bogus localhost origin into prod headers.
  process.env.NEXT_PUBLIC_COLLAB_SERVER_URL
    || (process.env.NODE_ENV !== 'production' ? 'http://localhost:1234' : ''),
);

/** @type {import('next').NextConfig} */
const nextConfig = { eslint: { ignoreDuringBuilds: true },
  // Produce a self-contained build in .next/standalone for Docker deployment.
  // This copies only the files needed to run the app (~150 MB vs full node_modules).
  output: 'standalone',
  // Monorepo: trace from the repo root so the standalone bundle includes the
  // @synthi/mcp-hub workspace package + hoisted deps (not just synthi/).
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  transpilePackages: ['@synthi/mcp-hub'],
  // Turbopack-specific configuration (used by `next dev --turbopack`)
  turbopack: {
    root: __dirname,
    resolveAlias: {
      // Ensure a single Monaco instance: monaco-languageclient uses
      // @codingame/monaco-vscode-editor-api internally; the editor must
      // use the same instance for LSP features to work.
      'monaco-editor': '@codingame/monaco-vscode-editor-api',
      // Yjs dedup (resolveDep handles workspace hoisting)
      'yjs': resolveDep('yjs/dist/yjs.mjs'),
    },
  },
  // Webpack fallback (used by `next build` without turbopack)
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // Force all yjs imports to use the same instance
        // See: https://github.com/yjs/yjs/issues/438
        'yjs': resolveDep('yjs/dist/yjs.mjs'),
        // CRITICAL: Ensure a single Monaco instance across the app.
        // monaco-languageclient uses @codingame/monaco-vscode-editor-api internally;
        // the editor must use the same instance for LSP features (completions,
        // hover, go-to-definition, etc.) to work.
        // The '$' suffix means EXACT match only — sub-path imports like
        // 'monaco-editor/esm/vs/language/...' (used for Web Workers) still
        // resolve to the original monaco-editor package.
        'monaco-editor$': resolveDep('@codingame/monaco-vscode-editor-api'),
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
          {
            key: 'Content-Security-Policy',
            value: contentSecurityPolicy,
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Referrer-Policy',
            value: 'no-referrer',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), browsing-topics=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
