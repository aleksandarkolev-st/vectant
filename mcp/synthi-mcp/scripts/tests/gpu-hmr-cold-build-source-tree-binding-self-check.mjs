import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY,
  COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA,
  computeColdBuildSourceTreeBinding,
  verifyColdBuildSourceTreeBindingEvidence,
} from '../lib/gpu-hmr-cold-build-source-tree-binding.mjs';

const LIMITS = {
  maxEntryCount: 1024,
  maxByteLength: 16 * 1024 * 1024,
};

async function writeTree(root) {
  await mkdir(path.join(root, 'opaque-a', 'opaque-b'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'entry.one'), 'entry bytes\n', 'utf8'),
    writeFile(
      path.join(root, 'opaque-a', 'opaque-b', 'payload.two'),
      'nested payload bytes\n',
      'utf8',
    ),
  ]);
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-source-binding-'));
  const firstRoot = path.join(temporaryRoot, 'first arbitrary tree \u03a9');
  const secondRoot = path.join(temporaryRoot, 'second opaque tree');
  try {
    await Promise.all([writeTree(firstRoot), writeTree(secondRoot)]);
    const first = await computeColdBuildSourceTreeBinding(firstRoot, LIMITS);
    const second = await computeColdBuildSourceTreeBinding(secondRoot, LIMITS);
    assert.equal(first.schemaVersion, COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA);
    assert.equal(first.proofAuthority, COLD_BUILD_SOURCE_TREE_BINDING_AUTHORITY);
    assert.equal(first.acceptedAsSourceTreeBindingEvidence, true);
    assert.equal(first.acceptedForGpuHmr, false);
    assert.equal(first.gpuHmrSuccess, false);
    assert.equal(first.canSatisfyRuntimeProof, false);
    assert.equal(first.canSatisfyDispatchProof, false);
    assert.equal(first.sourceBindingHash, second.sourceBindingHash);
    assert.notEqual(first.sourcePathIdentityHash, second.sourcePathIdentityHash);
    assert.equal(verifyColdBuildSourceTreeBindingEvidence(first, firstRoot), first);
    assert.equal(verifyColdBuildSourceTreeBindingEvidence(second, secondRoot), second);

    const nestedPath = path.join(firstRoot, 'opaque-a', 'opaque-b', 'payload.two');
    await writeFile(nestedPath, 'mutated nested payload\n', 'utf8');
    const mutated = await computeColdBuildSourceTreeBinding(firstRoot, LIMITS);
    assert.notEqual(mutated.sourceBindingHash, first.sourceBindingHash);
    await writeFile(nestedPath, 'nested payload bytes\n', 'utf8');
    const restored = await computeColdBuildSourceTreeBinding(firstRoot, LIMITS);
    assert.equal(restored.sourceBindingHash, first.sourceBindingHash);

    const originalPath = path.join(firstRoot, 'entry.one');
    const renamedPath = path.join(firstRoot, 'opaque-name');
    await rename(originalPath, renamedPath);
    const renamed = await computeColdBuildSourceTreeBinding(firstRoot, LIMITS);
    assert.notEqual(renamed.sourceBindingHash, first.sourceBindingHash);
    await rename(renamedPath, originalPath);

    assert.throws(
      () => verifyColdBuildSourceTreeBindingEvidence({
        ...first,
        acceptedForGpuHmr: true,
      }, firstRoot),
      /source_tree_binding_evidence_invalid/,
    );
    const forgedEntry = structuredClone(first);
    forgedEntry.entries.find((entry) => entry.kind === 'file').contentHash =
      `sha256:${'0'.repeat(64)}`;
    assert.throws(
      () => verifyColdBuildSourceTreeBindingEvidence(forgedEntry, firstRoot),
      /source_tree_binding_evidence_invalid/,
    );
    assert.throws(
      () => verifyColdBuildSourceTreeBindingEvidence(first, secondRoot),
      /source_tree_binding_evidence_invalid/,
    );
    await assert.rejects(
      () => computeColdBuildSourceTreeBinding(firstRoot, {
        ...LIMITS,
        maxEntryCount: 1,
      }),
      /entry_limit_exceeded/,
    );
    await assert.rejects(
      () => computeColdBuildSourceTreeBinding(firstRoot, {
        ...LIMITS,
        maxByteLength: 1,
      }),
      /byte_limit_exceeded/,
    );

    if (process.platform !== 'win32') {
      await symlink('../outside', path.join(firstRoot, 'escape-link'));
      await assert.rejects(
        () => computeColdBuildSourceTreeBinding(firstRoot, LIMITS),
        /symlink_escape/,
      );
    }

    console.log(JSON.stringify({
      status: 'self_check_passed',
      schemaVersion: COLD_BUILD_SOURCE_TREE_BINDING_SCHEMA,
      sourceBindingHash: first.sourceBindingHash,
      entryCount: first.entryCount,
      nestedMutationRefused: true,
      opaqueRootNameInvariant: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    }, null, 2));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
