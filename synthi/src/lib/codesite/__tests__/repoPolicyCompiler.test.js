import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepoPolicySignals } from '../repoPolicyCompiler.js';
import { compileZonePolicy } from '../policy.js';

const roots = [];

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('CodeSite repo policy compiler', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers policy signals from a repository layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codesite-policy-repo-'));
    roots.push(root);
    write(root, 'package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] }, null, 2));
    write(root, '.github/CODEOWNERS', [
      'api/auth/** @security',
      'packages/contracts/** @platform',
    ].join('\n'));
    write(root, 'openapi/auth.yaml', [
      'openapi: 3.1.0',
      'paths:',
      '  /auth/signup:',
      '    post:',
      '      operationId: signup',
    ].join('\n'));
    write(root, 'synthi/prisma/schema.prisma', 'model User { id String @id }\n');
    write(root, 'synthi/prisma/migrations/20260630000000_add_user/migration.sql', 'CREATE TABLE "User" (id text primary key);\n');
    write(root, 'packages/contracts/package.json', JSON.stringify({
      name: '@acme/contracts',
      exports: {
        '.': {
          types: './src/index.d.ts',
          import: './src/index.ts',
          require: './dist/index.cjs',
        },
        './server': {
          import: './src/server.ts',
          default: './src/server.ts',
        },
        './features/*': './src/features/*.ts',
      },
    }, null, 2));
    write(root, 'packages/contracts/src/index.ts', 'export type Signup = { email: string };\n');
    write(root, 'packages/contracts/src/server.ts', 'export const server = { runtime: "node" };\n');
    write(root, 'packages/contracts/src/features/audit.ts', 'export const audit = { enabled: true };\n');
    write(root, 'apps/web/signup/SignupForm.tsx', [
      'import React from "react";',
      'import type { Signup } from "@acme/contracts";',
      'import { server } from "@acme/contracts/server";',
      'import { audit } from "@acme/contracts/features/audit";',
      'export const form = { server, audit, React } as unknown as Signup;',
    ].join('\n'));
    write(root, 'apps/web/signup/SignupForm.test.tsx', 'import { form } from "./SignupForm";\n');
    write(root, 'infra/prod/kustomization.yaml', 'resources: []\n');
    write(root, '.env.example', 'TOKEN=redacted\n');

    const signals = discoverRepoPolicySignals({ root });

    expect(signals.repoRoot).toBe(root);
    expect(signals.compilerVersion).toBe('2026-07-01.1');
    expect(signals.fileCount).toBeGreaterThan(0);
    expect(signals.maxFiles).toBe(12000);
    expect(signals.truncated).toBe(false);
    expect(signals.codeowners).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: 'api/auth/**', owners: ['@security'] }),
    ]));
    expect(signals.openapi).toEqual([expect.objectContaining({
      path: 'openapi/auth.yaml',
      contractPaths: ['/auth/signup'],
      routePatterns: expect.arrayContaining(['api/auth/signup/**', 'app/api/auth/signup/**']),
      operations: expect.arrayContaining([
        expect.objectContaining({ path: '/auth/signup', method: 'POST' }),
      ]),
    })]);
    expect(signals.prisma.schemas).toEqual([{ path: 'synthi/prisma/schema.prisma' }]);
    expect(signals.prisma.migrations).toEqual([{ path: 'synthi/prisma/migrations' }]);
    expect(signals.packageExports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        packageName: '@acme/contracts',
        root: 'packages/contracts',
        exports: expect.arrayContaining([
          'packages/contracts/src/index.ts',
          'packages/contracts/src/server.ts',
          'packages/contracts/src/features/*.ts',
        ]),
        exportMap: {
          '.': [
            'packages/contracts/src/index.d.ts',
            'packages/contracts/src/index.ts',
            'packages/contracts/dist/index.cjs',
          ],
          './features/*': ['packages/contracts/src/features/*.ts'],
          './server': [
            'packages/contracts/src/server.ts',
          ],
        },
      }),
    ]));
    expect(signals.deployment).toEqual([{ path: 'infra/prod/kustomization.yaml' }]);
    expect(signals.secretPatterns).toEqual(expect.arrayContaining(['**/.env', 'secrets/**']));
    expect(signals.importEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'apps/web/signup/SignupForm.tsx',
        imports: expect.arrayContaining([
          'packages/contracts/src/index.ts',
          'packages/contracts/src/server.ts',
          'packages/contracts/src/features/audit.ts',
        ]),
      }),
    ]));
    expect(signals.importEdges.find((edge) => edge.from === 'apps/web/signup/SignupForm.tsx')?.imports)
      .not.toContain('react');
    expect(signals.testOwnership).toEqual(expect.arrayContaining([
      expect.objectContaining({
        testPath: 'apps/web/signup/SignupForm.test.tsx',
        covers: expect.arrayContaining(['apps/web/signup/SignupForm.tsx']),
      }),
    ]));
    expect(signals.digest).toMatch(/^sha256:/);

    const policy = compileZonePolicy({ repoSignals: signals });
    expect(policy.policySources).toMatchObject({
      openapi: 1,
      packageExports: 1,
      importEdges: 2,
      testOwnership: 1,
    });
    expect(policy.zones).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'repo_openapi',
        paths: expect.arrayContaining(['openapi/auth.yaml', 'api/auth/signup/**']),
        contractPaths: ['/auth/signup'],
        operations: expect.arrayContaining([
          expect.objectContaining({ path: '/auth/signup', method: 'POST' }),
        ]),
      }),
    ]));
  });
});
