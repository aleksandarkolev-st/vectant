'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const config = require('../config');
const repoCache = require('../repoCache');

function activeCodeSiteContext(slug, userId, allowedPaths) {
  return {
    active: true,
    mode: 'enforce',
    workspaceSlug: slug,
    actorUserId: userId,
    effectiveUserId: userId,
    transactionId: `txn-${slug}`,
    mutationLeaseId: `lease-${slug}`,
    allowedPaths,
    allowedTools: ['git_provisioning'],
    evidenceRefs: ['test:repo-cache-codesite-boundary'],
    processAncestry: ['node:test:repoCacheCodesiteBoundary'],
  };
}

test('active CodeSite repo cache materialization requires explicit repo-wide provisioning clearance', async () => {
  const slug = `codesite-cache-${process.pid}-${Date.now()}`;
  const userId = 'user-1';
  const slugRoot = path.join(config.REPO_CACHE_DIR, slug);
  const userRepoPath = path.join(slugRoot, userId);

  await fs.rm(slugRoot, { recursive: true, force: true });
  try {
    await assert.rejects(
      () => repoCache.acquire(slug, userId, {
        codesiteContext: activeCodeSiteContext(slug, userId, ['src/**']),
      }),
      (error) => {
        assert.equal(error.code, 'CODESITE_WRITE_DENIED');
        assert.ok(error.event?.details?.reason_codes?.includes('repo_provisioning_clearance_required'));
        return true;
      },
    );

    await assert.rejects(
      () => fs.stat(userRepoPath),
      (error) => error.code === 'ENOENT',
    );

    const repoPath = await repoCache.acquire(slug, userId, {
      codesiteContext: activeCodeSiteContext(slug, userId, ['**']),
    });
    assert.equal(repoPath, userRepoPath);
    assert.ok(await fs.stat(userRepoPath).then((stat) => stat.isDirectory()));
  } finally {
    repoCache.release(slug, userId);
    await fs.rm(slugRoot, { recursive: true, force: true });
  }
});
