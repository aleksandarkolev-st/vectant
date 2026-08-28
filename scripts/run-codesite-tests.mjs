#!/usr/bin/env node
// Runs the CodeSite control-plane + route test suites from source with a
// pinned standalone Vitest harness. Mirrors the local isolated-harness flow:
// the monorepo lockfile does not reliably install the frontend's Vitest, so CI
// materializes a minimal runner in a temp dir and points it at the repo tests.
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const synthiRoot = path.join(repoRoot, 'synthi');

const HARNESS_PACKAGE = JSON.stringify({
  name: 'vectant-vitest-ci',
  private: true,
  type: 'module',
  dependencies: {
    vitest: '4.1.9',
  },
});

const HARNESS_CONFIG = `
import path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(synthiRoot.replace(/\\/g, '/'))},
  resolve: {
    alias: {
      '@': ${JSON.stringify(synthiRoot.replace(/\\/g, '/'))} + '/src',
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/lib/codesite/__tests__/*.test.js',
      'src/app/api/workspace/[slug]/codesite/__tests__/*.test.js',
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
`;

function main() {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-vitest-ci-'));
  console.log(`[ci] harness: ${harnessDir}`);
  fs.writeFileSync(path.join(harnessDir, 'package.json'), HARNESS_PACKAGE);
  fs.writeFileSync(path.join(harnessDir, 'vitest.config.mjs'), HARNESS_CONFIG);
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  execFileSync(npmBin, ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
    cwd: harnessDir,
    stdio: 'inherit',
    // Node >= 18.20 requires shell:true to spawn .cmd shims (CVE-2024-27980).
    shell: isWin,
  });
  const vitest = path.join(harnessDir, 'node_modules', '.bin', isWin ? 'vitest.cmd' : 'vitest');
  try {
    execFileSync(vitest, ['run', '--config', 'vitest.config.mjs', '--reporter=dot'], {
      cwd: harnessDir,
      stdio: 'inherit',
      shell: isWin,
    });
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

main();
