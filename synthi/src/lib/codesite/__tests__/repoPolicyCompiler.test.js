import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepoPolicySignals } from '../repoPolicyCompiler.js';

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
    write(root, 'openapi/auth.yaml', 'openapi: 3.1.0\npaths: {}\n');
    write(root, 'synthi/prisma/schema.prisma', 'model User { id String @id }\n');
    write(root, 'synthi/prisma/migrations/20260630000000_add_user/migration.sql', 'CREATE TABLE "User" (id text primary key);\n');
    write(root, 'packages/contracts/package.json', JSON.stringify({
      name: '@acme/contracts',
      exports: {
        '.': './src/index.ts',
      },
    }, null, 2));
    write(root, 'packages/contracts/src/index.ts', 'export type Signup = { email: string };\n');
    write(root, 'apps/web/signup/SignupForm.tsx', 'import type { Signup } from "../../../packages/contracts/src/index";\nexport const form = {} as Signup;\n');
    write(root, 'apps/web/signup/SignupForm.test.tsx', 'import { form } from "./SignupForm";\n');
    write(root, 'infra/prod/kustomization.yaml', 'resources: []\n');
    write(root, '.env.example', 'TOKEN=redacted\n');

    const signals = discoverRepoPolicySignals({ root });

    expect(signals.repoRoot).toBe(root);
    expect(signals.codeowners).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: 'api/auth/**', owners: ['@security'] }),
    ]));
    expect(signals.openapi).toEqual([{ path: 'openapi/auth.yaml' }]);
    expect(signals.prisma.schemas).toEqual([{ path: 'synthi/prisma/schema.prisma' }]);
    expect(signals.prisma.migrations).toEqual([{ path: 'synthi/prisma/migrations' }]);
    expect(signals.packageExports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        packageName: '@acme/contracts',
        root: 'packages/contracts',
        exports: ['packages/contracts/src/index.ts'],
      }),
    ]));
    expect(signals.deployment).toEqual([{ path: 'infra/prod/kustomization.yaml' }]);
    expect(signals.secretPatterns).toEqual(expect.arrayContaining(['**/.env', 'secrets/**']));
    expect(signals.importEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'apps/web/signup/SignupForm.tsx',
        imports: expect.arrayContaining(['packages/contracts/src/index.ts']),
      }),
    ]));
    expect(signals.testOwnership).toEqual(expect.arrayContaining([
      expect.objectContaining({
        testPath: 'apps/web/signup/SignupForm.test.tsx',
        covers: expect.arrayContaining(['apps/web/signup/SignupForm.tsx']),
      }),
    ]));
    expect(signals.digest).toMatch(/^sha256:/);
  });
});
