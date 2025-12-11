import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // Fix "Yjs was already imported" error by ensuring a single instance of yjs
    // This happens when both 'yjs' and 'y-websocket' (which depends on yjs) are bundled
    // See: https://github.com/yjs/yjs/issues/438
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // Force all yjs imports to use the same instance
        'yjs': path.resolve(__dirname, 'node_modules/yjs'),
      };
    }
    return config;
  },
};

export default nextConfig;
