import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
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
  COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY,
  COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_AUTHORITY,
  COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA,
  COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA,
  computeColdBuildSourceTreeBinding,
  createColdBuildSourceTreeSnapshotReceipt,
  materializeColdBuildSourceTreeSnapshot,
  verifyColdBuildSourceTreeBindingEvidence,
  verifyColdBuildSourceTreeSnapshot,
  verifyColdBuildSourceTreeSnapshotReceipt,
} from '../lib/gpu-hmr-cold-build-source-tree-binding.mjs';

const LIMITS = {
  maxEntryCount: 1024,
  maxByteLength: 16 * 1024 * 1024,
};

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function contentHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function resealEvidence(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  evidence.evidenceHash = contentHash(stableJson(projection));
}

function resealSourceTreeBindingEvidence(evidence) {
  evidence.sourceBindingHash = contentHash(stableJson({
    schemaVersion: evidence.schemaVersion,
    entries: evidence.entries,
    entryCount: evidence.entryCount,
    fileCount: evidence.fileCount,
    directoryCount: evidence.directoryCount,
    symbolicLinkCount: evidence.symbolicLinkCount,
    totalByteLength: evidence.totalByteLength,
  }));
  resealEvidence(evidence);
}

function containsText(value, text) {
  if (typeof value === 'string') return value.includes(text);
  if (Array.isArray(value)) return value.some((entry) => containsText(entry, text));
  return value && typeof value === 'object'
    ? Object.values(value).some((entry) => containsText(entry, text))
    : false;
}

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
  const snapshotsRoot = path.join(temporaryRoot, 'private snapshots');
  try {
    await Promise.all([
      writeTree(firstRoot),
      writeTree(secondRoot),
      mkdir(snapshotsRoot, { recursive: false }),
    ]);
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

    const snapshotPath = path.join(snapshotsRoot, 'content-bound input');
    const snapshot = await materializeColdBuildSourceTreeSnapshot(
      firstRoot,
      snapshotPath,
      LIMITS,
    );
    assert.equal(snapshot.evidence.schemaVersion, COLD_BUILD_SOURCE_TREE_SNAPSHOT_SCHEMA);
    assert.equal(snapshot.evidence.proofAuthority, COLD_BUILD_SOURCE_TREE_SNAPSHOT_AUTHORITY);
    assert.equal(snapshot.evidence.acceptedForGpuHmr, false);
    assert.equal(snapshot.evidence.gpuHmrSuccess, false);
    assert.equal(
      verifyColdBuildSourceTreeSnapshot(snapshot, firstRoot, snapshot.snapshotHostPath),
      snapshot,
    );
    const snapshotReceipt = createColdBuildSourceTreeSnapshotReceipt(snapshot);
    const retainedSnapshotReceipt = JSON.parse(JSON.stringify(snapshotReceipt));
    assert.equal(
      snapshotReceipt.schemaVersion,
      COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA,
    );
    assert.equal(
      snapshotReceipt.proofAuthority,
      COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_AUTHORITY,
    );
    assert.equal(
      snapshotReceipt.sourceTreeBindingEvidence.evidenceHash,
      snapshot.evidence.sourceTreeBindingEvidenceHash,
    );
    assert.equal(
      snapshotReceipt.sourceTreePostBindingEvidence.evidenceHash,
      snapshot.evidence.sourceTreePostBindingEvidenceHash,
    );
    assert.equal(
      snapshotReceipt.snapshotTreeBindingEvidence.evidenceHash,
      snapshot.evidence.snapshotTreeBindingEvidenceHash,
    );
    assert.equal(snapshotReceipt.acceptedAsSourceTreeSnapshotReceipt, true);
    assert.equal(snapshotReceipt.acceptedForGpuHmr, false);
    assert.equal(snapshotReceipt.gpuHmrSuccess, false);
    assert.equal(snapshotReceipt.canSatisfyRuntimeProof, false);
    assert.equal(snapshotReceipt.canSatisfyDispatchProof, false);
    assert.equal(Object.hasOwn(snapshotReceipt, 'snapshotHostPath'), false);
    assert.equal(containsText(snapshotReceipt, firstRoot), false);
    assert.equal(containsText(snapshotReceipt, 'nested payload bytes'), false);
    assert.ok(!JSON.stringify(snapshotReceipt).match(
      /project[_-]?name|profile[_-]?name|repo(?:sitory)?[_-]?name|backend[_-]?name/i,
    ));
    assert.equal(
      verifyColdBuildSourceTreeSnapshotReceipt(retainedSnapshotReceipt),
      retainedSnapshotReceipt,
    );
    assert.throws(
      () => createColdBuildSourceTreeSnapshotReceipt(structuredClone(snapshot)),
      /snapshot_receipt_source_invalid/,
    );

    const manifestMutation = structuredClone(retainedSnapshotReceipt);
    manifestMutation.sourceTreeBindingEvidence.entries
      .find((entry) => entry.kind === 'file').contentHash = `sha256:${'0'.repeat(64)}`;
    resealEvidence(manifestMutation.sourceTreeBindingEvidence);
    manifestMutation.snapshotEvidence.sourceTreeBindingEvidenceHash =
      manifestMutation.sourceTreeBindingEvidence.evidenceHash;
    resealEvidence(manifestMutation.snapshotEvidence);
    resealEvidence(manifestMutation);
    assert.throws(
      () => verifyColdBuildSourceTreeSnapshotReceipt(manifestMutation),
      /snapshot_receipt_invalid/,
    );

    const escapingSymlink = structuredClone(retainedSnapshotReceipt);
    for (const field of [
      'sourceTreeBindingEvidence',
      'sourceTreePostBindingEvidence',
      'snapshotTreeBindingEvidence',
    ]) {
      const binding = escapingSymlink[field];
      const entryIndex = binding.entries.findIndex(
        (entry) => entry.path === 'opaque-a/opaque-b/payload.two',
      );
      const previousEntry = binding.entries[entryIndex];
      assert.equal(previousEntry.kind, 'file');
      binding.entries[entryIndex] = {
        path: previousEntry.path,
        kind: 'symbolic_link',
        target: '../../../outside-source-tree',
      };
      binding.fileCount -= 1;
      binding.symbolicLinkCount += 1;
      binding.totalByteLength -= previousEntry.byteLength;
      resealSourceTreeBindingEvidence(binding);
    }
    escapingSymlink.snapshotEvidence.sourceBindingHash =
      escapingSymlink.sourceTreeBindingEvidence.sourceBindingHash;
    escapingSymlink.snapshotEvidence.sourceTreeBindingEvidenceHash =
      escapingSymlink.sourceTreeBindingEvidence.evidenceHash;
    escapingSymlink.snapshotEvidence.sourceTreePostBindingEvidenceHash =
      escapingSymlink.sourceTreePostBindingEvidence.evidenceHash;
    escapingSymlink.snapshotEvidence.snapshotTreeBindingEvidenceHash =
      escapingSymlink.snapshotTreeBindingEvidence.evidenceHash;
    escapingSymlink.snapshotEvidence.totalByteLength =
      escapingSymlink.sourceTreeBindingEvidence.totalByteLength;
    resealEvidence(escapingSymlink.snapshotEvidence);
    resealEvidence(escapingSymlink);
    assert.throws(
      () => verifyColdBuildSourceTreeSnapshotReceipt(escapingSymlink),
      /snapshot_receipt_invalid/,
    );

    const crossLinkMismatch = structuredClone(retainedSnapshotReceipt);
    crossLinkMismatch.sourceTreePostBindingEvidence = structuredClone(second);
    crossLinkMismatch.snapshotEvidence.sourceTreePostBindingEvidenceHash = second.evidenceHash;
    resealEvidence(crossLinkMismatch.snapshotEvidence);
    resealEvidence(crossLinkMismatch);
    assert.throws(
      () => verifyColdBuildSourceTreeSnapshotReceipt(crossLinkMismatch),
      /snapshot_receipt_invalid/,
    );

    const successAuthorityForgery = structuredClone(retainedSnapshotReceipt);
    successAuthorityForgery.snapshotEvidence.gpuHmrSuccess = true;
    resealEvidence(successAuthorityForgery.snapshotEvidence);
    resealEvidence(successAuthorityForgery);
    assert.throws(
      () => verifyColdBuildSourceTreeSnapshotReceipt(successAuthorityForgery),
      /snapshot_receipt_invalid/,
    );
    for (const authorityFlag of [
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
    ]) {
      const authorityForgery = structuredClone(retainedSnapshotReceipt);
      authorityForgery[authorityFlag] = true;
      resealEvidence(authorityForgery);
      assert.throws(
        () => verifyColdBuildSourceTreeSnapshotReceipt(authorityForgery),
        /snapshot_receipt_invalid/,
      );
    }

    await writeFile(nestedPath, 'transient unbound bytes\n', 'utf8');
    assert.equal(
      await readFile(
        path.join(snapshot.snapshotHostPath, 'opaque-a', 'opaque-b', 'payload.two'),
        'utf8',
      ),
      'nested payload bytes\n',
    );
    const snapshotAfterSourceMutation = await computeColdBuildSourceTreeBinding(
      snapshot.snapshotHostPath,
      LIMITS,
    );
    assert.equal(
      snapshotAfterSourceMutation.sourceBindingHash,
      snapshot.evidence.sourceBindingHash,
    );
    await writeFile(nestedPath, 'nested payload bytes\n', 'utf8');

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
      snapshotReceiptSchemaVersion: COLD_BUILD_SOURCE_TREE_SNAPSHOT_RECEIPT_SCHEMA,
      snapshotReceiptEvidenceHash: snapshotReceipt.evidenceHash,
      jsonReplayVerified: true,
      manifestMutationRefused: true,
      escapingSymlinkRefused: true,
      crossLinkMismatchRefused: true,
      successAuthorityForgeryRefused: true,
      opaqueRootNameInvariant: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    }, null, 2));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
