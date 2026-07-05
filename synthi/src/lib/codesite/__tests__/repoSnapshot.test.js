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

  it('records a repo-wide manifest digest for serializable evidence', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['api/auth/signup.ts'], {
      repoRoot: root,
      scope: 'repo_wide',
    });

    expect(snapshot.scope).toBe('repo_wide');
    expect(snapshot.repoManifestDigest).toMatch(/^sha256:/);
    expect(snapshot.repoManifestFileCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.repoManifestScannedEntries).toBeGreaterThanOrEqual(snapshot.repoManifestFileCount);
    expect(snapshot.snapshotDigest).toMatch(/^sha256:/);
  });

  it('detects unrelated raw file drift through the repo-wide manifest', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['api/auth/signup.ts'], {
      repoRoot: root,
      scope: 'repo_wide',
    });

    await fs.writeFile(path.join(root, 'README.md'), 'raw host edit outside read set\n', 'utf8');

    const validation = await validateReadSnapshotEvidence(snapshot, { repoRoot: root });

    expect(validation.ok).toBe(false);
    expect(validation.reasonCodes).toEqual(expect.arrayContaining([
      'repo_snapshot_drift_detected',
      'repo_snapshot_repo_manifest_drift_detected',
    ]));
    expect(validation.repoManifestDrifted).toBe(true);
  });

  it('keeps skipped evidence directories out of repo-wide content drift', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['api/auth/signup.ts'], {
      repoRoot: root,
      scope: 'repo_wide',
    });

    await fs.mkdir(path.join(root, '.synthi', 'codesite', 'projects', 'proof'), { recursive: true });
    await fs.writeFile(path.join(root, '.synthi', 'codesite', 'projects', 'proof', 'control-state.json'), '{}\n', 'utf8');

    const validation = await validateReadSnapshotEvidence(snapshot, { repoRoot: root });

    expect(validation).toMatchObject({
      ok: true,
      reasonCodes: ['repo_snapshot_stable'],
      driftedPaths: [],
    });
    expect(validation.current.repoManifestScannedEntries).toBeGreaterThan(snapshot.repoManifestScannedEntries);
  });

  it('excludes declared write paths from repo-wide manifest drift only', async () => {
    const root = await tempRepo();
    const writePath = 'api/auth/signup.ts';
    const snapshot = await buildReadSnapshotEvidence(['packages/schemas/auth/signup.ts'], {
      repoRoot: root,
      scope: 'repo_wide',
      excludePaths: [writePath],
    });

    await fs.writeFile(path.join(root, writePath), 'export const route = "updated by transaction";\n', 'utf8');

    const allowedValidation = await validateReadSnapshotEvidence(snapshot, {
      repoRoot: root,
      excludePaths: [writePath],
    });

    expect(snapshot.repoManifestExcludedPaths).toEqual([writePath]);
    expect(allowedValidation).toMatchObject({
      ok: true,
      reasonCodes: ['repo_snapshot_stable'],
      driftedPaths: [],
    });

    await fs.writeFile(path.join(root, 'README.md'), 'raw edit outside write set\n', 'utf8');

    const blockedValidation = await validateReadSnapshotEvidence(snapshot, {
      repoRoot: root,
      excludePaths: [writePath],
    });

    expect(blockedValidation.ok).toBe(false);
    expect(blockedValidation.reasonCodes).toEqual(expect.arrayContaining([
      'repo_snapshot_drift_detected',
      'repo_snapshot_repo_manifest_drift_detected',
    ]));
  });

  it('marks truncated repo-wide manifests for serializable validation', async () => {
    const root = await tempRepo();
    const snapshot = await buildReadSnapshotEvidence(['api/auth/signup.ts'], {
      repoRoot: root,
      scope: 'repo_wide',
      maxFiles: 1,
    });

    expect(snapshot.repoManifestTruncated || snapshot.truncated).toBe(true);
    expect(snapshot.repoManifestFileCount).toBeLessThanOrEqual(1);
  });
});
