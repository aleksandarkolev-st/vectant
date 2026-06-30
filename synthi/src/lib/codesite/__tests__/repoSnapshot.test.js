import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildReadSnapshotEvidence, validateReadSnapshotEvidence } from '../repoSnapshot.js';

async function tempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-snapshot-'));
  await fs.mkdir(path.join(root, 'packages', 'schemas', 'auth'), { recursive: true });
  await fs.mkdir(path.join(root, 'api', 'auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'packages', 'schemas', 'auth', 'signup.ts'), 'export const version = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'api', 'auth', 'signup.ts'), 'export const route = true;\n', 'utf8');
  return root;
}

describe('CodeSite repo read snapshots', () => {
  it('records a portable digest of read-set files and verifies stable snapshots', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['packages/schemas/auth/signup.ts'], { repoRoot: root });
    const validation = await validateReadSnapshotEvidence(snapshot, { repoRoot: root });

    expect(snapshot.status).toBe('recorded');
    expect(snapshot.snapshotDigest).toMatch(/^sha256:/);
    expect(snapshot.fileDigests).toEqual([
      expect.objectContaining({
        path: 'packages/schemas/auth/signup.ts',
        exists: true,
        digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(validation).toMatchObject({
      ok: true,
      reasonCodes: ['repo_snapshot_stable'],
      driftedPaths: [],
    });
  });

  it('detects changed files and newly matching glob dependencies', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['packages/schemas/**/*.ts'], { repoRoot: root });

    await fs.writeFile(path.join(root, 'packages', 'schemas', 'auth', 'signup.ts'), 'export const version = 2;\n', 'utf8');
    await fs.writeFile(path.join(root, 'packages', 'schemas', 'auth', 'profile.ts'), 'export const profile = true;\n', 'utf8');

    const validation = await validateReadSnapshotEvidence(snapshot, { repoRoot: root });

    expect(validation.ok).toBe(false);
    expect(validation.reasonCodes).toContain('repo_snapshot_drift_detected');
    expect(validation.driftedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'packages/schemas/auth/signup.ts' }),
      expect.objectContaining({ path: 'packages/schemas/auth/profile.ts' }),
    ]));
  });

  it('refuses path traversal entries instead of reading outside the repo', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['../secrets.env', 'api/auth/signup.ts'], { repoRoot: root });

    expect(snapshot.readSet).toEqual(['api/auth/signup.ts']);
    expect(snapshot.fileDigests).toEqual([expect.objectContaining({ path: 'api/auth/signup.ts' })]);
  });
});
