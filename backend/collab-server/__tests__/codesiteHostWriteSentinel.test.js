'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodeSiteHostWriteSentinel } = require('../codesiteHostWriteSentinel');

async function makeRepo(prefix = 'codesite-host-sentinel-') {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'src/app.js'), 'export const version = 1;\n', 'utf8');
  return repoRoot;
}

function activeContext(overrides = {}) {
  return {
    active: true,
    workspaceSlug: 'acme',
    transactionId: 'txn-host-1',
    mutationLeaseId: 'lease-host-1',
    agentSessionId: 'agent-host-1',
    displayCallsign: 'CODEX-04',
    actorUserId: 'owner-1',
    effectiveUserId: 'fs-1',
    processAncestry: ['codex-cli'],
    controlPlaneUrl: 'http://codesite.test/api/workspace/acme/codesite',
    controlPlaneTrusted: true,
    ...overrides,
  };
}

test('quarantines and restores direct host writes without path-specific logic', async () => {
  const repoRoot = await makeRepo();
  const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-host-sentinel-records-'));
  const calls = [];
  const sentinel = createCodeSiteHostWriteSentinel({
    repoRoot,
    baseDir: sentinelDir,
    sentinelId: 'sentinel-test-1',
    codeSiteContext: activeContext(),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  try {
    await sentinel.start({ watch: false });
    await fs.writeFile(path.join(repoRoot, 'src/app.js'), 'export const version = 2;\n', 'utf8');
    await fs.writeFile(path.join(repoRoot, 'src/rogue.js'), 'export const rogue = true;\n', 'utf8');

    const result = await sentinel.scanNow({ reason: 'test_direct_host_write' });

    assert.equal(result.ok, true);
    assert.equal(result.quarantined.length, 2);
    assert.equal(await fs.readFile(path.join(repoRoot, 'src/app.js'), 'utf8'), 'export const version = 1;\n');
    await assert.rejects(() => fs.stat(path.join(repoRoot, 'src/rogue.js')), (error) => error.code === 'ENOENT');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url.endsWith('/transactions/txn-host-1/record-write')));
    assert.deepEqual(
      calls.map((call) => call.body.codesiteFsEvent.type).sort(),
      ['write_quarantined', 'write_quarantined'],
    );
    assert.ok(calls.every((call) => call.body.codesiteFsEvent.details.reason_codes.includes('host_direct_write_quarantined')));
    assert.ok(calls.every((call) => call.body.codesiteFsEvent.details.restored === true));
    assert.ok(calls.every((call) => call.body.osProcessAncestry?.schemaVersion === 'synthi.codesite.processAncestry.v1'));
    assert.ok(calls.every((call) => call.body.codesiteFsEvent.details.os_process_ancestry?.schemaVersion === 'synthi.codesite.processAncestry.v1'));
    assert.ok(calls.every((call) => call.body.processAncestry.includes('codesite-host-write-sentinel')));
    assert.ok(calls.every((call) => call.body.codesiteFsEvent.details.host_mutation_provenance.writer_process_attribution.available === false));
    assert.ok(calls.every((call) => call.body.codesiteFsEvent.details.host_mutation_provenance.after_stat));

    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.kind, 'codesite_host_write_sentinel');
    assert.equal(manifest.status, 'quarantined');
    assert.equal(manifest.quarantined.length, 2);
    assert.equal(manifest.osProcessAncestry.schemaVersion, 'synthi.codesite.processAncestry.v1');
    assert.ok(manifest.quarantined.every((record) => record.hostMutationProvenance.writer_process_attribution.available === false));
  } finally {
    sentinel.stop();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(sentinelDir, { recursive: true, force: true });
  }
});

test('restores deleted baseline files from the private baseline copy', async () => {
  const repoRoot = await makeRepo('codesite-host-sentinel-delete-');
  const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-host-sentinel-delete-records-'));
  const sentinel = createCodeSiteHostWriteSentinel({
    repoRoot,
    baseDir: sentinelDir,
    sentinelId: 'sentinel-test-delete',
    codeSiteContext: activeContext({ transactionId: 'txn-delete-1' }),
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    await sentinel.start({ watch: false });
    await fs.rm(path.join(repoRoot, 'src/app.js'));

    const result = await sentinel.scanNow({ reason: 'test_direct_delete' });

    assert.equal(result.ok, true);
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0].restoreAction, 'restored_from_baseline_copy');
    assert.equal(await fs.readFile(path.join(repoRoot, 'src/app.js'), 'utf8'), 'export const version = 1;\n');
  } finally {
    sentinel.stop();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(sentinelDir, { recursive: true, force: true });
  }
});

test('baseline refresh marks managed writes as the new authorized state', async () => {
  const repoRoot = await makeRepo('codesite-host-sentinel-refresh-');
  const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesite-host-sentinel-refresh-records-'));
  const sentinel = createCodeSiteHostWriteSentinel({
    repoRoot,
    baseDir: sentinelDir,
    sentinelId: 'sentinel-test-refresh',
    codeSiteContext: activeContext({ transactionId: 'txn-refresh-1' }),
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    await sentinel.start({ watch: false });
    await fs.writeFile(path.join(repoRoot, 'src/app.js'), 'export const version = 3;\n', 'utf8');
    await sentinel.refreshBaseline({ reason: 'managed_codesitefs_write' });

    const clean = await sentinel.scanNow({ reason: 'post_managed_write_scan' });

    assert.equal(clean.ok, true);
    assert.deepEqual(clean.quarantined, []);
    assert.equal(await fs.readFile(path.join(repoRoot, 'src/app.js'), 'utf8'), 'export const version = 3;\n');
  } finally {
    sentinel.stop();
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(sentinelDir, { recursive: true, force: true });
  }
});
