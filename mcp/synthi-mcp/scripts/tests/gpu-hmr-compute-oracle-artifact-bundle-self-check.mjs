import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { writeArtifactToCas } from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION,
  COMPUTE_ORACLE_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  COMPUTE_ORACLE_ARTIFACT_SET_SCHEMA_VERSION,
  COMPUTE_ORACLE_PROVENANCE_SCHEMA_VERSION,
  COMPUTE_PACKED_LAYOUT_SCHEMA_VERSION,
  COMPUTE_PROOF_CARD_BINDING_SCHEMA_VERSION,
  COMPUTE_READBACK_SCHEMA_VERSION,
  COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION,
  COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION,
  deterministicComputeProofCardRendererIdentity,
  renderDeterministicComputeProofCard,
} from '../lib/gpu-hmr-compute-oracle-artifact-bundle.mjs';
import {
  computeOracleArtifactsFromFiles,
  verifyComputeOracleArtifactBundle,
} from '../lib/gpu-hmr-validation-proof-artifact.mjs';

const SUPPORT_AUTHORITY = 'compute_oracle_before_after_artifact_bytes_only_not_gpu_hmr_acceptance';
const PHASES = ['before', 'after'];
const ROLE_SPECS = Object.freeze({
  rawReadback: {
    suffix: 'raw_readback',
    artifactKind: 'compute_readback',
    mediaType: 'application/octet-stream',
  },
  readbackSchema: {
    suffix: 'readback_schema',
    artifactKind: 'compute_readback_schema',
    mediaType: 'application/json',
  },
  renderedCard: {
    suffix: 'rendered_card',
    artifactKind: 'compute_proof_card',
    mediaType: 'image/png',
  },
});

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashText(value) {
  return sha256(Buffer.from(String(value), 'utf8'));
}

function hashObject(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

async function hashFile(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    digest.update(chunk);
  }
  return `sha256:${digest.digest('hex')}`;
}

function contextMaterial(context) {
  const material = structuredClone(context);
  delete material.contextHash;
  delete material.context_hash;
  return material;
}

function makeRuntimeContext(phase, overrides = {}) {
  const isBefore = phase === 'before';
  const context = {
    schemaVersion: COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION,
    sourceManifestHash: hashText(`source:${isBefore ? '10' : '11'}`),
    editId: `edit:${isBefore ? '10' : '11'}`,
    editHash: hashText(`edit:${isBefore ? '10' : '11'}`),
    changedArtifactHash: hashText(`artifact:${isBefore ? '10' : '11'}`),
    processId: 'pid:4100',
    runtimeSession: 'runtime:4100',
    epoch: `epoch:${isBefore ? '10' : '11'}`,
    dispatchId: `dispatch:${isBefore ? '10' : '11'}`,
    outputTarget: 'output:primary',
    oracleCodeHash: hashText('oracle:code'),
    dispatchTimestampMonotonicNs: isBefore ? '1000000' : '1001000',
    timestampAfterDispatchMonotonicNs: isBefore ? '1000100' : '1001100',
    ...overrides,
  };
  context.contextHash = hashObject(contextMaterial(context));
  return context;
}

function refreshContextHash(context) {
  context.contextHash = hashObject(contextMaterial(context));
  delete context.context_hash;
  return context;
}

function proofCardBindingMaterial(binding) {
  return {
    schemaVersion: COMPUTE_PROOF_CARD_BINDING_SCHEMA_VERSION,
    rawReadbackHash: binding.rawReadbackHash,
    deterministicSliceHash: binding.deterministicSliceHash,
    schemaDerivationHash: binding.schemaDerivationHash,
    renderedCardHash: binding.renderedCardHash,
    rendererExecutable: binding.rendererExecutable,
    derivationHash: binding.derivationHash,
  };
}

function refreshProofCardBindingHash(binding) {
  binding.bindingHash = hashObject(proofCardBindingMaterial(binding));
  delete binding.binding_hash;
  return binding;
}

function rendererIdentityMaterial(identity) {
  return {
    schemaVersion: COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION,
    rendererKind: identity.rendererKind,
    rendererContractVersion: identity.rendererContractVersion,
    moduleHash: identity.moduleHash,
    sharpVersion: identity.sharpVersion,
    vipsVersion: identity.vipsVersion,
  };
}

function refreshRendererIdentity(identity) {
  identity.executableHash = hashObject(rendererIdentityMaterial(identity));
  identity.artifactId = `artifact:${identity.executableHash}`;
  return identity;
}

function codecContractMaterial(contract) {
  return {
    schemaVersion: COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION,
    dtypeName: contract.dtypeName,
    byteWidth: contract.byteWidth,
    byteOrder: contract.byteOrder,
    layoutKind: contract.layoutKind,
    executableHash: contract.executableHash,
    artifactId: contract.artifactId,
  };
}

function makeCodecContract({
  dtypeName = 'opaque16',
  byteWidth = 2,
  byteOrder = 'little_endian',
} = {}) {
  const executableHash = hashText(`codec:${dtypeName}:${byteWidth}:${byteOrder}`);
  const contract = {
    schemaVersion: COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION,
    dtypeName,
    byteWidth,
    byteOrder,
    layoutKind: 'packed',
    executableHash,
    artifactId: `artifact:${executableHash}`,
  };
  contract.contractHash = hashObject(codecContractMaterial(contract));
  return contract;
}

function hasReason(result, code) {
  return result.reasons?.includes(code)
    && result.failedGates?.some((gate) => gate.code === code);
}

function assertSupportOnly(result) {
  assert.equal(result.acceptedForGpuHmr, false);
  assert.equal(result.gpuHmrSuccess, false);
  assert.equal(result.canSatisfyRuntimeProof, false);
  assert.equal(result.canSatisfyDispatchProof, false);
  assert.equal(result.fullRuntimeProven, false);
  assert.equal(result.strictRuntimeProofAccepted, false);
  assert.equal(result.proofAuthority, SUPPORT_AUTHORITY);
}

function assertAccepted(result) {
  assert.equal(result.accepted, true, JSON.stringify(result.reasons));
  assert.equal(result.acceptedAsComputeOracleArtifactEvidence, true);
  assertSupportOnly(result);
}

function assertRefused(result, ...codes) {
  assert.equal(result.accepted, false);
  assert.equal(result.acceptedAsComputeOracleArtifactEvidence, false);
  assertSupportOnly(result);
  for (const code of codes) assert.ok(hasReason(result, code), `${code}: ${JSON.stringify(result.reasons)}`);
}

async function readSlice(filePath, offset, length) {
  const handle = await open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    assert.equal(bytesRead, length);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writePhase({
  directory,
  phase,
  rawBytes = null,
  rawPath = null,
  context,
  dtypeName = 'u32',
  byteWidth = 4,
  byteOrder = 'little_endian',
  codecContract = null,
  shape = null,
  elementCount = null,
  sliceOffset = 8,
  sliceLength = 32,
  mutateSchemaBeforeRender = null,
  mutateSchemaAfterRender = null,
  mutateBinding = null,
  cardBytes = null,
} = {}) {
  const phaseRawPath = rawPath ?? path.join(directory, `${phase}.bin`);
  if (rawBytes !== null) await writeFile(phaseRawPath, rawBytes);
  const rawStats = await stat(phaseRawPath);
  const rawHash = await hashFile(phaseRawPath);
  const inferredElementCount = elementCount ?? (rawStats.size / byteWidth);
  const inferredShape = shape ?? [inferredElementCount];
  const sliceBytes = await readSlice(phaseRawPath, sliceOffset, sliceLength);
  const schema = {
    schemaVersion: COMPUTE_READBACK_SCHEMA_VERSION,
    dtype: {
      name: dtypeName,
      byteWidth,
      ...(codecContract ? { codecContract: structuredClone(codecContract) } : {}),
    },
    shape: inferredShape,
    elementCount: inferredElementCount,
    byteLength: rawStats.size,
    byteOrder,
    layout: {
      schemaVersion: COMPUTE_PACKED_LAYOUT_SCHEMA_VERSION,
      kind: 'packed',
      elementStrideBytes: byteWidth,
      paddingBytes: 0,
      contiguous: true,
    },
    rawReadbackHash: rawHash,
    deterministicSlice: {
      offset: sliceOffset,
      length: sliceLength,
      hash: sha256(sliceBytes),
    },
    runtimeContext: structuredClone(context),
  };
  if (mutateSchemaBeforeRender) await mutateSchemaBeforeRender(schema);
  const rendered = await renderDeterministicComputeProofCard({
    readbackSchema: schema,
    deterministicSliceBytes: sliceBytes,
  });
  schema.proofCardBinding = structuredClone(rendered.binding);
  if (mutateBinding) await mutateBinding(schema.proofCardBinding, rendered);
  if (mutateSchemaAfterRender) await mutateSchemaAfterRender(schema, rendered);
  const finalCardBytes = cardBytes ?? rendered.bytes;
  const schemaBytes = Buffer.from(`${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  const schemaPath = path.join(directory, `${phase}.schema.json`);
  const cardPath = path.join(directory, `${phase}.card.png`);
  await writeFile(schemaPath, schemaBytes);
  await writeFile(cardPath, finalCardBytes);
  return {
    phase,
    rawPath: phaseRawPath,
    rawHash,
    rawByteLength: rawStats.size,
    sliceBytes,
    schema,
    schemaPath,
    schemaBytes,
    cardPath,
    cardBytes: finalCardBytes,
    rendered,
  };
}

function directDeclaration(bytes, filePath) {
  return {
    path: filePath,
    contentHash: sha256(bytes),
    byteLength: bytes.length,
  };
}

function directArtifactSet(phase) {
  return {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_SET_SCHEMA_VERSION,
    rawReadback: {
      path: phase.rawPath,
      contentHash: phase.rawHash,
      byteLength: phase.rawByteLength,
    },
    readbackSchema: directDeclaration(phase.schemaBytes, phase.schemaPath),
    renderedCard: directDeclaration(phase.cardBytes, phase.cardPath),
  };
}

let sequence = 0;

async function materializeDirectBundle(root, options = {}) {
  sequence += 1;
  const directory = path.join(root, `case-${String(sequence).padStart(4, '0')}`);
  await mkdir(directory, { recursive: true });
  const beforeContext = options.beforeContext ?? makeRuntimeContext('before');
  const afterContext = options.afterContext ?? makeRuntimeContext('after');
  const beforeRaw = options.beforeRaw ?? Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const afterRaw = options.afterRaw ?? Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 3 + 17) % 256));
  const before = await writePhase({
    directory,
    phase: 'before',
    rawBytes: beforeRaw,
    context: beforeContext,
    ...(options.sharedPhase ?? {}),
    ...(options.beforePhase ?? {}),
  });
  const after = await writePhase({
    directory,
    phase: 'after',
    rawBytes: afterRaw,
    context: afterContext,
    ...(options.sharedPhase ?? {}),
    ...(options.afterPhase ?? {}),
  });
  const bundle = {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    before: directArtifactSet(before),
    after: directArtifactSet(after),
    provenance: {
      schemaVersion: COMPUTE_ORACLE_PROVENANCE_SCHEMA_VERSION,
      producerId: 'successor.capture',
      producerArtifactHash: hashText('producer:artifact'),
      sessionNamespace: 'capture:session',
      evidenceRefs: [hashText('evidence:one')],
    },
    proofAuthority: SUPPORT_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    fullRuntimeProven: false,
    strictRuntimeProofAccepted: false,
    status: 'captured',
  };
  return { directory, bundle, before, after, beforeContext, afterContext };
}

function verifyOptions(materialized, overrides = {}) {
  return {
    baseDir: materialized.directory,
    allowedRoots: [materialized.directory],
    expectedBeforeRuntimeContext: structuredClone(materialized.beforeContext),
    expectedAfterRuntimeContext: structuredClone(materialized.afterContext),
    ...overrides,
  };
}

async function verifyDirect(materialized, overrides = {}) {
  return verifyComputeOracleArtifactBundle(
    materialized.bundle,
    verifyOptions(materialized, overrides),
  );
}

async function rewriteSchema(materialized, phase, mutate) {
  const phaseData = materialized[phase];
  await mutate(phaseData.schema);
  phaseData.schemaBytes = Buffer.from(`${JSON.stringify(phaseData.schema, null, 2)}\n`, 'utf8');
  await writeFile(phaseData.schemaPath, phaseData.schemaBytes);
  materialized.bundle[phase].readbackSchema = directDeclaration(
    phaseData.schemaBytes,
    phaseData.schemaPath,
  );
}

async function rewriteCard(materialized, phase, bytes, { bindHash = true } = {}) {
  const phaseData = materialized[phase];
  phaseData.cardBytes = bytes;
  await writeFile(phaseData.cardPath, bytes);
  materialized.bundle[phase].renderedCard = directDeclaration(bytes, phaseData.cardPath);
  if (bindHash) {
    phaseData.schema.proofCardBinding.renderedCardHash = sha256(bytes);
    refreshProofCardBindingHash(phaseData.schema.proofCardBinding);
    await rewriteSchema(materialized, phase, () => {});
  }
}

async function colorfulPng({ alpha = 255, oneVisiblePixel = false, uniform = false } = {}) {
  const width = 64;
  const height = 32;
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const visible = !oneVisiblePixel || pixel === 0;
    const offset = pixel * 4;
    pixels[offset] = visible ? (uniform ? 88 : (pixel * 7) % 256) : 0;
    pixels[offset + 1] = visible ? (uniform ? 88 : (pixel * 11 + 23) % 256) : 0;
    pixels[offset + 2] = visible ? (uniform ? 88 : (pixel * 13 + 47) % 256) : 0;
    pixels[offset + 3] = visible ? alpha : 0;
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

function casRole(phase, key) {
  return `${phase}_${ROLE_SPECS[key].suffix}`;
}

async function toCasBundle(materialized, casRoot, {
  mode = 'inline',
  portable = true,
  producerName = 'capture_worker',
  producerKind = 'worker',
  sessionNamespace = 'capture_session',
  transportKind = 'cas_shared_volume',
  locatorPaddingBytes = 0,
} = {}) {
  const bundle = structuredClone(materialized.bundle);
  const locators = [];
  const locatorPaths = {};
  for (const phase of PHASES) {
    const phaseData = materialized[phase];
    const bytesByKey = {
      rawReadback: await readFile(phaseData.rawPath),
      readbackSchema: phaseData.schemaBytes,
      renderedCard: phaseData.cardBytes,
    };
    for (const [key, spec] of Object.entries(ROLE_SPECS)) {
      const role = casRole(phase, key);
      const locator = await writeArtifactToCas(bytesByKey[key], {
        artifactRoot: casRoot,
        role,
        artifactKind: spec.artifactKind,
        mediaType: spec.mediaType,
        producer: { name: producerName, kind: producerKind },
        producerSubsystem: producerName,
        sessionNamespace,
        transportKind,
        portable,
        includeLocalPath: !portable,
      });
      locators.push(locator);
      const declaration = {
        contentHash: locator.contentHash,
        byteLength: locator.byteLength,
      };
      if (mode === 'inline') {
        declaration.casLocator = locator;
      } else if (mode === 'manifest') {
        const locatorPath = path.join(materialized.directory, `${role}.locator.json`);
        const padding = locatorPaddingBytes > 0 ? ' '.repeat(locatorPaddingBytes) : '';
        await writeFile(locatorPath, `${JSON.stringify(locator)}${padding}`, 'utf8');
        declaration.casLocatorManifestPath = locatorPath;
        locatorPaths[role] = locatorPath;
      }
      bundle[phase][key] = declaration;
    }
  }
  if (mode === 'embedded') bundle.artifactCasLocators = locators;
  return { bundle, locators, locatorPaths, casRoot };
}

function casVerifyOptions(materialized, casRoot, overrides = {}) {
  return verifyOptions(materialized, {
    allowedRoots: [materialized.directory, casRoot],
    allowedCasRoots: [casRoot],
    casRoot,
    ...overrides,
  });
}

function refreshLocatorManifestHash(locator) {
  const material = { ...locator, manifestHash: undefined };
  locator.manifestHash = hashObject(material);
  return locator;
}

function locatorFor(casMaterialized, role) {
  const locator = casMaterialized.locators.find((entry) => entry.role === role);
  assert.ok(locator, role);
  return locator;
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-compute-bundle-'));
  let portableRetargetChecks = 0;
  try {
    const rendererIdentity = await deterministicComputeProofCardRendererIdentity();
    assert.equal(rendererIdentity.schemaVersion, COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION);
    assert.equal(rendererIdentity.artifactId, `artifact:${rendererIdentity.executableHash}`);

    const direct = await materializeDirectBundle(root);
    const directResult = await verifyDirect(direct);
    assertAccepted(directResult);
    assert.match(directResult.verificationId, /^compute-oracle-artifact-bundle:sha256:[0-9a-f]{64}$/);
    assert.equal(directResult.checksums.checksumBefore, direct.before.rawHash);
    assert.equal(directResult.checksums.checksumAfter, direct.after.rawHash);
    assert.equal(directResult.checksums.checksumBeforeSource, 'verified_before_readback_bytes');
    assert.equal(directResult.checksums.checksumAfterSource, 'verified_after_readback_bytes');
    assert.equal(directResult.checksums.declarationAccepted, false);
    assert.equal(directResult.before.readback.streamed, true);
    assert.equal(directResult.after.readback.streamed, true);
    assert.equal(directResult.before.proofCard.visual.supportOnly, true);
    assert.ok(directResult.before.proofCard.visual.visiblePixels > 64);
    assert.equal(directResult.provenance.producerId, 'successor.capture');

    const fileUrl = await materializeDirectBundle(root);
    fileUrl.bundle.before.rawReadback.path = pathToFileURL(fileUrl.before.rawPath);
    assertAccepted(await verifyDirect(fileUrl));

    const scalar = await materializeDirectBundle(root, {
      beforeRaw: Buffer.from([1, 0, 0, 0]),
      afterRaw: Buffer.from([2, 0, 0, 0]),
      sharedPhase: {
        shape: [],
        elementCount: 1,
        sliceOffset: 0,
        sliceLength: 4,
      },
    });
    const scalarResult = await verifyDirect(scalar);
    assertAccepted(scalarResult);
    assert.deepEqual(scalarResult.before.schema.shape, []);
    assert.equal(scalarResult.before.schema.elementCount, 1);

    const codecContract = makeCodecContract();
    const opaque = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: codecContract.dtypeName,
        byteWidth: codecContract.byteWidth,
        byteOrder: codecContract.byteOrder,
        codecContract,
        shape: [32],
        elementCount: 32,
      },
    });
    const opaqueResult = await verifyDirect(opaque, { trustedCodecContracts: [codecContract] });
    assertAccepted(opaqueResult);
    assert.equal(
      opaqueResult.before.schema.dtype.codecContract.contractHash,
      codecContract.contractHash,
    );

    const unrelatedCard = await materializeDirectBundle(root);
    await rewriteCard(unrelatedCard, 'after', await colorfulPng());
    assertRefused(
      await verifyDirect(unrelatedCard),
      'compute_oracle_after_proof_card_deterministic_rerender_byte_mismatch',
    );

    const fakeRenderer = await materializeDirectBundle(root);
    await rewriteSchema(fakeRenderer, 'after', (schema) => {
      const identity = schema.proofCardBinding.rendererExecutable;
      identity.moduleHash = hashText('different-renderer-module');
      refreshRendererIdentity(identity);
      refreshProofCardBindingHash(schema.proofCardBinding);
    });
    assertRefused(
      await verifyDirect(fakeRenderer),
      'compute_oracle_after_proof_card_renderer_identity_not_trusted',
    );

    const staleBinding = await materializeDirectBundle(root);
    await rewriteSchema(staleBinding, 'after', (schema) => {
      schema.proofCardBinding.derivationHash = hashText('stale-card-derivation');
      refreshProofCardBindingHash(schema.proofCardBinding);
    });
    assertRefused(
      await verifyDirect(staleBinding),
      'compute_oracle_after_proof_card_binding_derivation_hash_mismatch',
    );

    const uniformCard = await materializeDirectBundle(root);
    await rewriteCard(uniformCard, 'after', await colorfulPng({ uniform: true }));
    assertRefused(
      await verifyDirect(uniformCard),
      'compute_oracle_after_proof_card_uniform_or_low_information',
    );

    const transparentCard = await materializeDirectBundle(root);
    await rewriteCard(transparentCard, 'after', await colorfulPng({ alpha: 1 }));
    assertRefused(
      await verifyDirect(transparentCard),
      'compute_oracle_after_proof_card_almost_transparent',
      'compute_oracle_after_proof_card_visible_pixel_threshold_failed',
    );

    const onePixelCard = await materializeDirectBundle(root);
    await rewriteCard(onePixelCard, 'after', await colorfulPng({ oneVisiblePixel: true }));
    assertRefused(
      await verifyDirect(onePixelCard),
      'compute_oracle_after_proof_card_visible_pixel_threshold_failed',
    );

    const invalidPng = await materializeDirectBundle(root);
    await rewriteCard(invalidPng, 'after', Buffer.from('not-a-png', 'utf8'));
    assertRefused(
      await verifyDirect(invalidPng),
      'compute_oracle_after_proof_card_png_signature_invalid',
      'compute_oracle_after_proof_card_decode_failed',
    );

    const v1Schema = await materializeDirectBundle(root);
    await rewriteSchema(v1Schema, 'after', (schema) => {
      schema.schemaVersion = 'synthi.gpu.hmr.compute_readback_schema.v1';
    });
    assertRefused(
      await verifyDirect(v1Schema),
      'compute_oracle_after_readback_schema_schema_version_invalid',
    );

    const missingBefore = await materializeDirectBundle(root);
    delete missingBefore.bundle.before;
    assertRefused(await verifyDirect(missingBefore), 'compute_oracle_before_missing');

    const missingBeforeBytes = await materializeDirectBundle(root);
    missingBeforeBytes.bundle.before.rawReadback = {};
    assertRefused(
      await verifyDirect(missingBeforeBytes),
      'compute_oracle_before_raw_readback_source_missing',
    );

    const declaredChecksum = await materializeDirectBundle(root);
    declaredChecksum.bundle.checksumBefore = declaredChecksum.before.rawHash;
    assertRefused(
      await verifyDirect(declaredChecksum),
      'compute_oracle_artifact_bundle_unknown_fields',
    );

    const malformedSchema = await materializeDirectBundle(root);
    malformedSchema.after.schemaBytes = Buffer.from('{"schemaVersion":', 'utf8');
    await writeFile(malformedSchema.after.schemaPath, malformedSchema.after.schemaBytes);
    malformedSchema.bundle.after.readbackSchema = directDeclaration(
      malformedSchema.after.schemaBytes,
      malformedSchema.after.schemaPath,
    );
    assertRefused(
      await verifyDirect(malformedSchema),
      'compute_oracle_after_readback_schema_json_invalid',
    );

    const mismatchedShape = await materializeDirectBundle(root);
    await rewriteSchema(mismatchedShape, 'after', (schema) => {
      schema.shape = [2, 2];
    });
    assertRefused(
      await verifyDirect(mismatchedShape),
      'compute_oracle_after_readback_schema_shape_element_count_mismatch',
    );

    const mismatchedSlice = await materializeDirectBundle(root);
    await rewriteSchema(mismatchedSlice, 'after', (schema) => {
      schema.deterministicSlice.hash = hashText('wrong-slice');
    });
    assertRefused(
      await verifyDirect(mismatchedSlice),
      'compute_oracle_after_readback_schema_slice_hash_mismatch',
    );

    const missingSchemaBindings = await materializeDirectBundle(root);
    await rewriteSchema(missingSchemaBindings, 'after', (schema) => {
      delete schema.rawReadbackHash;
      delete schema.deterministicSlice;
    });
    const missingSchemaBindingsResult = await verifyDirect(missingSchemaBindings);
    assertRefused(
      missingSchemaBindingsResult,
      'compute_oracle_after_readback_schema_raw_readback_hash_missing',
      'compute_oracle_after_readback_schema_deterministic_slice_missing',
    );

    const forgedRawDeclaration = await materializeDirectBundle(root);
    forgedRawDeclaration.bundle.after.rawReadback.contentHash = hashText('forged-raw');
    assertRefused(
      await verifyDirect(forgedRawDeclaration),
      'compute_oracle_after_raw_readback_content_hash_mismatch',
    );

    const sameDelta = await materializeDirectBundle(root, {
      beforeRaw: Buffer.alloc(64, 7),
      afterRaw: Buffer.alloc(64, 7),
    });
    assertRefused(
      await verifyDirect(sameDelta),
      'compute_oracle_transition_raw_readback_unchanged',
      'compute_oracle_transition_deterministic_slice_unchanged',
    );

    const runtimeFields = [
      ['sourceManifestHash', 'source_manifest_hash', hashText('replay-source')],
      ['editId', 'edit_id', 'edit:replay'],
      ['editHash', 'edit_hash', hashText('replay-edit')],
      ['changedArtifactHash', 'changed_artifact_hash', hashText('replay-artifact')],
      ['processId', 'process_id', 'pid:replay'],
      ['runtimeSession', 'runtime_session', 'runtime:replay'],
      ['epoch', 'epoch', 'epoch:replay'],
      ['dispatchId', 'dispatch_id', 'dispatch:replay'],
      ['outputTarget', 'output_target', 'output:replay'],
      ['oracleCodeHash', 'oracle_code_hash', hashText('replay-oracle')],
      ['dispatchTimestampMonotonicNs', 'dispatch_timestamp_monotonic_ns', '1001001'],
      ['timestampAfterDispatchMonotonicNs', 'timestamp_after_dispatch_monotonic_ns', '1001101'],
    ];
    for (const [field, snake, replayValue] of runtimeFields) {
      const replay = structuredClone(direct.afterContext);
      replay[field] = replayValue;
      refreshContextHash(replay);
      const replayResult = await verifyDirect(direct, { expectedAfterRuntimeContext: replay });
      assertRefused(replayResult, `compute_oracle_after_runtime_context_${snake}_mismatch`);
    }

    const changedProcess = await materializeDirectBundle(root, {
      afterContext: makeRuntimeContext('after', { processId: 'pid:other' }),
    });
    assertRefused(
      await verifyDirect(changedProcess),
      'compute_oracle_transition_process_id_changed',
    );

    const runtimeAlias = await materializeDirectBundle(root);
    const conflictingExpected = structuredClone(runtimeAlias.afterContext);
    conflictingExpected.source_manifest_hash = hashText('conflicting-source');
    assertRefused(
      await verifyDirect(runtimeAlias, { expectedAfterRuntimeContext: conflictingExpected }),
      'compute_oracle_alias_conflict',
    );

    const schemaObjectAlias = await materializeDirectBundle(root);
    await rewriteSchema(schemaObjectAlias, 'after', (schema) => {
      schema.runtime_context = {
        ...structuredClone(schema.runtimeContext),
        processId: 'pid:conflict',
      };
    });
    assertRefused(
      await verifyDirect(schemaObjectAlias),
      'compute_oracle_after_readback_schema_alias_conflict',
    );

    const authorityBase = await materializeDirectBundle(root);
    const authorityCases = [
      ['acceptedForGpuHmr', true],
      ['gpuHmrSuccess', 'false'],
      ['canSatisfyRuntimeProof', 1],
      ['canSatisfyDispatchProof', null],
      ['fullRuntimeProven', 'yes'],
      ['strictRuntimeProofAccepted', {}],
      ['runtimeProofAuthority', 'runtime'],
      ['outputOracleAuthority', 'output'],
      ['status', 'success'],
      ['verdict', 'accepted'],
      ['resultState', 'proven'],
    ];
    for (const [field, value] of authorityCases) {
      const bundle = structuredClone(authorityBase.bundle);
      bundle[field] = value;
      const result = await verifyComputeOracleArtifactBundle(bundle, verifyOptions(authorityBase));
      assertRefused(result, 'compute_oracle_artifact_bundle_claims_authority');
    }
    const falseAuthorityMetadata = structuredClone(authorityBase.bundle);
    falseAuthorityMetadata.runtimeProofAuthority = false;
    falseAuthorityMetadata.outputOracleAuthority = false;
    assertAccepted(await verifyComputeOracleArtifactBundle(
      falseAuthorityMetadata,
      verifyOptions(authorityBase),
    ));

    const unknownDtype = await materializeDirectBundle(root, {
      sharedPhase: { dtypeName: 'opaque16', byteWidth: 2, shape: [32], elementCount: 32 },
    });
    assertRefused(
      await verifyDirect(unknownDtype),
      'compute_oracle_before_readback_schema_opaque_dtype_codec_contract_required',
      'compute_oracle_after_readback_schema_opaque_dtype_codec_contract_required',
    );

    const untrustedCodec = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: codecContract.dtypeName,
        byteWidth: codecContract.byteWidth,
        byteOrder: codecContract.byteOrder,
        codecContract,
        shape: [32],
        elementCount: 32,
      },
    });
    assertRefused(
      await verifyDirect(untrustedCodec),
      'compute_oracle_before_readback_schema_dtype_codec_contract_not_trusted',
      'compute_oracle_after_readback_schema_dtype_codec_contract_not_trusted',
    );

    const wrongWidth = await materializeDirectBundle(root);
    await rewriteSchema(wrongWidth, 'after', (schema) => {
      schema.dtype.byteWidth = 8;
    });
    assertRefused(
      await verifyDirect(wrongWidth),
      'compute_oracle_after_readback_schema_dtype_width_registry_mismatch',
    );

    const wrongEndian = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [64],
        elementCount: 64,
      },
    });
    await rewriteSchema(wrongEndian, 'after', (schema) => {
      schema.byteOrder = 'little_endian';
    });
    assertRefused(
      await verifyDirect(wrongEndian),
      'compute_oracle_after_readback_schema_single_byte_dtype_byte_order_invalid',
    );

    const badLayout = await materializeDirectBundle(root);
    await rewriteSchema(badLayout, 'after', (schema) => {
      schema.layout.paddingBytes = 4;
      schema.layout.elementStrideBytes = 8;
      schema.layout.contiguous = false;
    });
    const badLayoutResult = await verifyDirect(badLayout);
    assertRefused(
      badLayoutResult,
      'compute_oracle_after_readback_schema_layout_padding_not_zero',
      'compute_oracle_after_readback_schema_layout_stride_mismatch',
      'compute_oracle_after_readback_schema_layout_contiguous_required',
    );

    const overflowingShape = await materializeDirectBundle(root);
    await rewriteSchema(overflowingShape, 'after', (schema) => {
      schema.shape = [Number.MAX_SAFE_INTEGER, 2];
      schema.elementCount = Number.MAX_SAFE_INTEGER;
    });
    assertRefused(
      await verifyDirect(overflowingShape),
      'compute_oracle_after_readback_schema_shape_element_count_overflow',
      'compute_oracle_after_readback_schema_packed_byte_length_overflow',
    );

    const rawLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(rawLimit, { maxRawReadbackBytes: 16 }),
      'compute_oracle_before_raw_readback_size_limit_exceeded',
      'compute_oracle_after_raw_readback_size_limit_exceeded',
    );

    const schemaLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(schemaLimit, { maxReadbackSchemaBytes: 32 }),
      'compute_oracle_before_readback_schema_size_limit_exceeded',
      'compute_oracle_after_readback_schema_size_limit_exceeded',
    );

    const cardLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(cardLimit, { maxRenderedCardBytes: 32 }),
      'compute_oracle_before_rendered_card_size_limit_exceeded',
      'compute_oracle_after_rendered_card_size_limit_exceeded',
    );

    const sliceLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(sliceLimit, { maxDeterministicSliceBytes: 8 }),
      'compute_oracle_before_readback_schema_deterministic_slice_size_limit_exceeded',
      'compute_oracle_after_readback_schema_deterministic_slice_size_limit_exceeded',
    );

    const stringLimit = await materializeDirectBundle(root);
    stringLimit.bundle.provenance.producerId = 'a'.repeat(200);
    const stringLimitResult = await verifyDirect(stringLimit, { maxStringBytes: 128 });
    assertRefused(
      stringLimitResult,
      'compute_oracle_artifact_bundle_string_byte_limit_exceeded',
    );

    const entryLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(entryLimit, { maxJsonEntries: 16 }),
      'compute_oracle_artifact_bundle_json_entry_limit_exceeded',
    );

    const serializedLimit = await materializeDirectBundle(root);
    serializedLimit.bundle.provenance.evidenceRefs = Array.from(
      { length: 64 },
      (_, index) => hashText(`serialized:${index}`),
    );
    assertRefused(
      await verifyDirect(serializedLimit, { maxSerializedJsonBytes: 1024 }),
      'compute_oracle_artifact_bundle_serialized_json_byte_limit_exceeded',
    );

    const depthLimit = await materializeDirectBundle(root);
    let nested = hashText('depth-leaf');
    for (let index = 0; index < 12; index += 1) nested = [nested];
    depthLimit.bundle.provenance.evidenceRefs = nested;
    assertRefused(
      await verifyDirect(depthLimit, { maxJsonDepth: 8 }),
      'compute_oracle_artifact_bundle_json_depth_limit_exceeded',
    );

    const schemaDepthLimit = await materializeDirectBundle(root);
    await rewriteSchema(schemaDepthLimit, 'after', (schema) => {
      let value = 'leaf';
      for (let index = 0; index < 12; index += 1) value = { next: value };
      schema.unrecognized = value;
    });
    assertRefused(
      await verifyDirect(schemaDepthLimit, { maxJsonDepth: 8 }),
      'compute_oracle_after_readback_schema_json_depth_limit_exceeded',
    );

    const allocationLimit = await materializeDirectBundle(root);
    assertRefused(
      await verifyDirect(allocationLimit, { hashChunkBytes: 32 * 1024 * 1024 }),
      'compute_oracle_limit_hash_chunk_bytes_hard_maximum_exceeded',
    );

    const malformedUrl = await materializeDirectBundle(root);
    malformedUrl.bundle.after.rawReadback.path = 'file:///%ZZ';
    assertRefused(
      await verifyDirect(malformedUrl),
      'compute_oracle_after_raw_readback_malformed_file_url',
    );

    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-compute-outside-'));
    try {
      const escaped = await materializeDirectBundle(root);
      const escapedPath = path.join(outsideRoot, 'readback.bin');
      const escapedBytes = await readFile(escaped.after.rawPath);
      await writeFile(escapedPath, escapedBytes);
      escaped.bundle.after.rawReadback = directDeclaration(escapedBytes, escapedPath);
      assertRefused(
        await verifyDirect(escaped),
        'compute_oracle_after_raw_readback_lexical_path_outside_allowed_roots',
      );

      const linked = await materializeDirectBundle(root);
      const linkedPath = path.join(linked.directory, 'linked-readback.bin');
      let linkCreated = false;
      try {
        await symlink(escapedPath, linkedPath, 'file');
        linkCreated = true;
      } catch (error) {
        assert.ok(['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code), error?.message);
      }
      if (linkCreated) {
        linked.bundle.after.rawReadback = directDeclaration(escapedBytes, linkedPath);
        assertRefused(
          await verifyDirect(linked),
          'compute_oracle_after_raw_readback_path_contains_link_or_reparse_point',
        );
      }
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }

    const casRoot = path.join(root, 'cas-a');
    await mkdir(casRoot, { recursive: true });
    const casSource = await materializeDirectBundle(root);
    const inlineCas = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    for (const locator of inlineCas.locators) {
      assert.equal(Object.prototype.hasOwnProperty.call(locator.storage, 'localPath'), false);
      assert.match(locator.manifestHash, /^sha256:[0-9a-f]{64}$/);
    }
    const inlineCasResult = await verifyComputeOracleArtifactBundle(
      inlineCas.bundle,
      casVerifyOptions(casSource, casRoot),
    );
    assertAccepted(inlineCasResult);
    for (const artifact of Object.values(inlineCasResult.artifacts)) {
      assert.equal(artifact.sourceKind, 'cas_locator');
      assert.equal(artifact.casIdentity.identityHash.startsWith('sha256:'), true);
      assert.equal(artifact.identity.accepted, true);
    }

    const materializerRawBytes = Buffer.from(
      Array.from({ length: 64 }, (_, index) => (index * 5 + 29) % 256),
    );
    const materializerRawLocator = await writeArtifactToCas(materializerRawBytes, {
      artifactRoot: casRoot,
      role: 'raw_readback',
      artifactKind: 'compute_readback',
      mediaType: 'application/octet-stream',
      producer: { name: 'snapshot_consumer_check', kind: 'worker' },
      producerSubsystem: 'snapshot_consumer_check',
      sessionNamespace: 'snapshot_consumer_check',
      transportKind: 'cas_shared_volume',
      portable: true,
      includeLocalPath: false,
    });
    const materializerSchemaLocator = await writeArtifactToCas(casSource.after.schemaBytes, {
      artifactRoot: casRoot,
      role: 'readback_schema',
      artifactKind: 'compute_readback_schema',
      mediaType: 'application/json',
      producer: { name: 'snapshot_consumer_check', kind: 'worker' },
      producerSubsystem: 'snapshot_consumer_check',
      sessionNamespace: 'snapshot_consumer_check',
      transportKind: 'cas_shared_volume',
      portable: true,
      includeLocalPath: false,
    });
    const materializerInput = {
      raw_readback_locator: materializerRawLocator,
      readback_schema_locator: materializerSchemaLocator,
      raw_readback_hash: materializerRawLocator.contentHash,
      readback_schema_hash: materializerSchemaLocator.contentHash,
      deterministic_slice: {
        offset: 0,
        length: materializerRawBytes.byteLength,
        hash: sha256(materializerRawBytes),
      },
    };
    const materializerOptions = {
      allowedRoots: [casRoot],
      artifactRoot: casRoot,
    };
    const materializedSnapshots = await computeOracleArtifactsFromFiles(
      materializerInput,
      materializerOptions,
    );
    assert.equal(materializedSnapshots.compute_artifact_cas_resolution.accepted, true);
    assert.deepEqual(materializedSnapshots.raw_readback_locator, materializerRawLocator);
    assert.deepEqual(materializedSnapshots.readback_schema_locator, materializerSchemaLocator);
    assert.equal(materializedSnapshots.raw_readback_bin, undefined);
    assert.equal(materializedSnapshots.rawReadbackBin, undefined);
    assert.equal(materializedSnapshots.readback_schema_json, undefined);
    assert.equal(materializedSnapshots.readbackSchemaJson, undefined);
    assert.equal(materializedSnapshots.raw_readback_hash_verified, true);
    assert.equal(materializedSnapshots.readback_schema_hash, materializerSchemaLocator.contentHash);
    for (const entry of materializedSnapshots.compute_artifact_cas_resolution.entries) {
      assert.equal(entry.accepted, true);
      assert.equal(entry.path, null);
      assert.equal(entry.localPath, null);
      assert.equal(entry.local_path, null);
      assert.equal(entry.pathReusableAsProof, false);
      assert.equal(entry.pathProofAuthority, 'support_locator_only');
      assert.equal(typeof entry.supportPath, 'string');
      assert.equal(entry.supportPath.length > 0, true);
      assert.ok(entry.verifiedSnapshotIdentity);
      assert.equal(entry.freshReadHash, entry.verifiedByteHash);
      assert.equal(entry.freshReadByteLength, entry.verifiedByteLength);
      assert.equal(entry.freshReadMatchesSnapshot, true);
      assert.deepEqual(
        entry.postReadSnapshotIdentity.root,
        entry.verifiedSnapshotIdentity.root,
      );
      assert.deepEqual(
        entry.postReadSnapshotIdentity.final,
        entry.verifiedSnapshotIdentity.final,
      );
      assert.deepEqual(
        entry.postReadSnapshotIdentity.components,
        entry.verifiedSnapshotIdentity.components,
      );
      assert.equal(entry.snapshotIdentityStable, true);
    }

    const rawSnapshotEntry = materializedSnapshots.compute_artifact_cas_resolution.entries
      .find((entry) => entry.role === 'raw_readback');
    assert.ok(rawSnapshotEntry);
    try {
      await writeFile(
        rawSnapshotEntry.supportPath,
        Buffer.alloc(materializerRawBytes.byteLength, 0xa5),
      );
      const mutatedSnapshots = await computeOracleArtifactsFromFiles(
        materializerInput,
        materializerOptions,
      );
      assert.equal(mutatedSnapshots.compute_artifact_cas_resolution.accepted, false);
      assert.equal(mutatedSnapshots.raw_readback_hash_verified, undefined);
      assert.equal(mutatedSnapshots.compute_oracle_semantic_verification.accepted, false);
    } finally {
      await writeFile(rawSnapshotEntry.supportPath, materializerRawBytes);
    }

    const embeddedCas = await toCasBundle(casSource, casRoot, { portable: true, mode: 'embedded' });
    assertAccepted(await verifyComputeOracleArtifactBundle(
      embeddedCas.bundle,
      casVerifyOptions(casSource, casRoot),
    ));

    const manifestCas = await toCasBundle(casSource, casRoot, {
      portable: true,
      mode: 'manifest',
    });
    const manifestCasResult = await verifyComputeOracleArtifactBundle(
      manifestCas.bundle,
      casVerifyOptions(casSource, casRoot),
    );
    assertAccepted(manifestCasResult);
    assert.match(
      manifestCasResult.artifacts.before_raw_readback.locatorFileEvidence.contentHash,
      /^sha256:[0-9a-f]{64}$/,
    );

    const casRootB = path.join(root, 'cas-b');
    await mkdir(casRootB, { recursive: true });
    const identityCas = await toCasBundle(casSource, casRootB, {
      portable: true,
      mode: 'inline',
      producerName: 'capture_worker_b',
      producerKind: 'process',
      sessionNamespace: 'capture_session_b',
      transportKind: 'cas_tmpfs',
    });
    const identityCasResult = await verifyComputeOracleArtifactBundle(
      identityCas.bundle,
      casVerifyOptions(casSource, casRootB),
    );
    assertAccepted(identityCasResult);
    assert.notEqual(identityCasResult.verificationId, inlineCasResult.verificationId);
    assert.notEqual(
      identityCasResult.artifacts.after_raw_readback.casIdentity.identityHash,
      inlineCasResult.artifacts.after_raw_readback.casIdentity.identityHash,
    );

    for (const identityVariant of [
      { producerName: 'capture_worker_variant' },
      { sessionNamespace: 'capture_session_variant' },
      { transportKind: 'cas_tmpfs' },
    ]) {
      const variant = await toCasBundle(casSource, casRoot, {
        portable: true,
        mode: 'inline',
        ...identityVariant,
      });
      const variantResult = await verifyComputeOracleArtifactBundle(
        variant.bundle,
        casVerifyOptions(casSource, casRoot),
      );
      assertAccepted(variantResult);
      assert.notEqual(variantResult.verificationId, inlineCasResult.verificationId);
    }

    const paddedManifestCas = await toCasBundle(casSource, casRoot, {
      portable: true,
      mode: 'manifest',
      locatorPaddingBytes: 1,
    });
    const paddedManifestResult = await verifyComputeOracleArtifactBundle(
      paddedManifestCas.bundle,
      casVerifyOptions(casSource, casRoot),
    );
    assertAccepted(paddedManifestResult);
    assert.notEqual(paddedManifestResult.verificationId, manifestCasResult.verificationId);

    const wrongCasRole = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    const wrongRoleLocator = locatorFor(wrongCasRole, 'after_raw_readback');
    wrongRoleLocator.role = 'before_raw_readback';
    refreshLocatorManifestHash(wrongRoleLocator);
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        wrongCasRole.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_after_raw_readback_cas_role_mismatch',
    );

    const wrongCasKind = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    const wrongKindLocator = locatorFor(wrongCasKind, 'after_raw_readback');
    wrongKindLocator.artifactKind = 'compute_proof_card';
    refreshLocatorManifestHash(wrongKindLocator);
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        wrongCasKind.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_after_raw_readback_cas_artifact_kind_mismatch',
    );

    const wrongCasMedia = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    const wrongMediaLocator = locatorFor(wrongCasMedia, 'after_raw_readback');
    wrongMediaLocator.mediaType = 'image/png';
    refreshLocatorManifestHash(wrongMediaLocator);
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        wrongCasMedia.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_after_raw_readback_cas_media_type_mismatch',
    );

    const forgedManifestHash = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    locatorFor(forgedManifestHash, 'after_raw_readback').manifestHash = hashText('forged-manifest');
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        forgedManifestHash.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_after_raw_readback_cas_manifest_hash_mismatch',
    );

    const casAuthority = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    const authorityLocator = locatorFor(casAuthority, 'after_raw_readback');
    authorityLocator.outputOracleAuthority = 'accepted';
    refreshLocatorManifestHash(authorityLocator);
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        casAuthority.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_after_raw_readback_cas_claims_authority',
    );

    const extraLocator = await toCasBundle(casSource, casRoot, { portable: true, mode: 'embedded' });
    extraLocator.bundle.artifactCasLocators.push({
      ...structuredClone(extraLocator.locators[0]),
      role: 'unrecognized_role',
    });
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        extraLocator.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_artifact_cas_locator_role_unrecognized',
    );

    const locatorAlias = await toCasBundle(casSource, casRoot, { portable: true, mode: 'inline' });
    const aliasDeclaration = locatorAlias.bundle.after.rawReadback;
    aliasDeclaration.cas_locator = structuredClone(aliasDeclaration.casLocator);
    aliasDeclaration.cas_locator.producer = { name: 'other', kind: 'worker' };
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        locatorAlias.bundle,
        casVerifyOptions(casSource, casRoot),
      ),
      'compute_oracle_alias_conflict',
      'compute_oracle_after_raw_readback_cas_locator_alias_conflict',
    );

    const oversizedLocator = await toCasBundle(casSource, casRoot, {
      portable: true,
      mode: 'manifest',
      locatorPaddingBytes: 4096,
    });
    assertRefused(
      await verifyComputeOracleArtifactBundle(
        oversizedLocator.bundle,
        casVerifyOptions(casSource, casRoot, { maxLocatorManifestBytes: 1024 }),
      ),
      'compute_oracle_before_raw_readback_cas_locator_manifest_size_limit_exceeded',
    );

    const sparseSize = 48 * 1024 * 1024;
    const sparseSliceOffset = sparseSize - 128;
    async function createSparseRaw(filePath, changedByte = null) {
      const handle = await open(filePath, 'w+');
      try {
        await handle.truncate(sparseSize);
        if (changedByte !== null) {
          await handle.write(Buffer.from([changedByte]), 0, 1, sparseSliceOffset + 7);
        }
      } finally {
        await handle.close();
      }
    }

    const sparseBeforePath = path.join(root, 'sparse-before.bin');
    const sparseAfterPath = path.join(root, 'sparse-after.bin');
    await createSparseRaw(sparseBeforePath);
    await createSparseRaw(sparseAfterPath, 91);
    const sparseBundle = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [sparseSize],
        elementCount: sparseSize,
        sliceOffset: sparseSliceOffset,
        sliceLength: 64,
      },
      beforePhase: { rawBytes: null, rawPath: sparseBeforePath },
      afterPhase: { rawBytes: null, rawPath: sparseAfterPath },
    });
    const sparseResult = await verifyDirect(sparseBundle, {
      allowedRoots: [root],
      hashChunkBytes: 64 * 1024,
    });
    assertAccepted(sparseResult);
    assert.equal(sparseResult.before.readback.byteLength, sparseSize);
    assert.equal(sparseResult.before.readback.sliceByteLength, 64);
    assert.equal(sparseResult.before.readback.hashChunkByteLength, 64 * 1024);

    const mutationBeforePath = path.join(root, 'mutation-before.bin');
    const mutationAfterPath = path.join(root, 'mutation-after.bin');
    await createSparseRaw(mutationBeforePath);
    await createSparseRaw(mutationAfterPath, 33);
    const mutationBundle = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [sparseSize],
        elementCount: sparseSize,
        sliceOffset: sparseSliceOffset,
        sliceLength: 64,
      },
      beforePhase: { rawBytes: null, rawPath: mutationBeforePath },
      afterPhase: { rawBytes: null, rawPath: mutationAfterPath },
    });
    const mutationPromise = verifyDirect(mutationBundle, {
      allowedRoots: [root],
      hashChunkBytes: 4096,
    });
    await delay(50);
    const mutationHandle = await open(mutationAfterPath, 'r+');
    try {
      await mutationHandle.write(Buffer.from([201]), 0, 1, sparseSliceOffset - 1024);
      await mutationHandle.sync();
    } finally {
      await mutationHandle.close();
    }
    const mutationResult = await mutationPromise;
    assertRefused(
      mutationResult,
      'compute_oracle_after_raw_readback_identity_or_resolved_path_changed_during_read',
    );

    const retargetBeforePath = path.join(root, 'retarget-before.bin');
    const retargetAfterPath = path.join(root, 'retarget-after.bin');
    const retargetReplacementPath = path.join(root, 'retarget-replacement.bin');
    const retargetBackupPath = path.join(root, 'retarget-backup.bin');
    await createSparseRaw(retargetBeforePath);
    await createSparseRaw(retargetAfterPath, 44);
    await createSparseRaw(retargetReplacementPath, 45);
    const retargetBundle = await materializeDirectBundle(root, {
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [sparseSize],
        elementCount: sparseSize,
        sliceOffset: sparseSliceOffset,
        sliceLength: 64,
      },
      beforePhase: { rawBytes: null, rawPath: retargetBeforePath },
      afterPhase: { rawBytes: null, rawPath: retargetAfterPath },
    });
    const retargetPromise = verifyDirect(retargetBundle, {
      allowedRoots: [root],
      hashChunkBytes: 4096,
    });
    await delay(50);
    let directRetargeted = false;
    try {
      await rename(retargetAfterPath, retargetBackupPath);
      await rename(retargetReplacementPath, retargetAfterPath);
      directRetargeted = true;
    } catch (error) {
      assert.ok(['EPERM', 'EACCES', 'EBUSY', 'ENOTSUP'].includes(error?.code), error?.message);
    }
    const retargetResult = await retargetPromise;
    if (directRetargeted) {
      portableRetargetChecks += 1;
      assertRefused(
        retargetResult,
        'compute_oracle_after_raw_readback_identity_or_resolved_path_changed_during_read',
      );
    }

    const casRaceRoot = path.join(root, 'cas-race');
    await mkdir(casRaceRoot, { recursive: true });
    const casRaceSource = await materializeDirectBundle(root, {
      beforeRaw: Buffer.alloc(16 * 1024 * 1024, 3),
      afterRaw: Buffer.alloc(16 * 1024 * 1024, 9),
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [16 * 1024 * 1024],
        elementCount: 16 * 1024 * 1024,
        sliceOffset: 8 * 1024 * 1024,
        sliceLength: 64,
      },
    });
    const casRace = await toCasBundle(casRaceSource, casRaceRoot, {
      portable: true,
      mode: 'inline',
    });
    const casRaceLocator = locatorFor(casRace, 'after_raw_readback');
    const casRacePath = path.join(casRaceRoot, ...casRaceLocator.storage.relativePath.split('/'));
    const casMutationPromise = verifyComputeOracleArtifactBundle(
      casRace.bundle,
      casVerifyOptions(casRaceSource, casRaceRoot, { hashChunkBytes: 4096 }),
    );
    await delay(50);
    const casMutationHandle = await open(casRacePath, 'r+');
    try {
      await casMutationHandle.write(Buffer.from([77]), 0, 1, 1024);
      await casMutationHandle.sync();
    } finally {
      await casMutationHandle.close();
    }
    const casMutationResult = await casMutationPromise;
    assertRefused(
      casMutationResult,
      'compute_oracle_after_raw_readback_identity_or_resolved_path_changed_during_read',
    );

    const casRetargetRoot = path.join(root, 'cas-retarget');
    await mkdir(casRetargetRoot, { recursive: true });
    const casRetargetSource = await materializeDirectBundle(root, {
      beforeRaw: Buffer.alloc(16 * 1024 * 1024, 4),
      afterRaw: Buffer.alloc(16 * 1024 * 1024, 10),
      sharedPhase: {
        dtypeName: 'u8',
        byteWidth: 1,
        byteOrder: 'not_applicable',
        shape: [16 * 1024 * 1024],
        elementCount: 16 * 1024 * 1024,
        sliceOffset: 8 * 1024 * 1024,
        sliceLength: 64,
      },
    });
    const casRetarget = await toCasBundle(casRetargetSource, casRetargetRoot, {
      portable: true,
      mode: 'inline',
    });
    const casRetargetLocator = locatorFor(casRetarget, 'after_raw_readback');
    const casRetargetPath = path.join(
      casRetargetRoot,
      ...casRetargetLocator.storage.relativePath.split('/'),
    );
    const casRetargetBackup = `${casRetargetPath}.held`;
    const casRetargetReplacement = `${casRetargetPath}.replacement`;
    await writeFile(casRetargetReplacement, Buffer.alloc(casRetargetLocator.byteLength, 11));
    const casRetargetPromise = verifyComputeOracleArtifactBundle(
      casRetarget.bundle,
      casVerifyOptions(casRetargetSource, casRetargetRoot, { hashChunkBytes: 4096 }),
    );
    await delay(50);
    let casBytesRetargeted = false;
    try {
      await rename(casRetargetPath, casRetargetBackup);
      await rename(casRetargetReplacement, casRetargetPath);
      casBytesRetargeted = true;
    } catch (error) {
      assert.ok(['EPERM', 'EACCES', 'EBUSY', 'ENOTSUP'].includes(error?.code), error?.message);
    }
    const casRetargetResult = await casRetargetPromise;
    if (casBytesRetargeted) {
      portableRetargetChecks += 1;
      assertRefused(
        casRetargetResult,
        'compute_oracle_after_raw_readback_identity_or_resolved_path_changed_during_read',
      );
    }

    const locatorRace = await toCasBundle(casSource, casRoot, {
      portable: true,
      mode: 'manifest',
      locatorPaddingBytes: 256 * 1024,
    });
    const locatorRacePath = locatorRace.locatorPaths.before_raw_readback;
    const locatorRacePromise = verifyComputeOracleArtifactBundle(
      locatorRace.bundle,
      casVerifyOptions(casSource, casRoot, { metadataChunkBytes: 16 }),
    );
    await delay(20);
    const locatorMutationHandle = await open(locatorRacePath, 'r+');
    try {
      const locatorStats = await locatorMutationHandle.stat();
      await locatorMutationHandle.write(Buffer.from('\n'), 0, 1, locatorStats.size - 1);
      await locatorMutationHandle.sync();
    } finally {
      await locatorMutationHandle.close();
    }
    const locatorMutationResult = await locatorRacePromise;
    assertRefused(
      locatorMutationResult,
      'compute_oracle_before_raw_readback_cas_locator_manifest_identity_or_resolved_path_changed_during_read',
    );

    const locatorRetarget = await toCasBundle(casSource, casRoot, {
      portable: true,
      mode: 'manifest',
      locatorPaddingBytes: 256 * 1024,
    });
    const locatorRetargetPath = locatorRetarget.locatorPaths.before_raw_readback;
    const locatorRetargetBackup = `${locatorRetargetPath}.held`;
    const locatorRetargetReplacement = `${locatorRetargetPath}.replacement`;
    await writeFile(locatorRetargetReplacement, await readFile(locatorRetargetPath));
    const locatorRetargetPromise = verifyComputeOracleArtifactBundle(
      locatorRetarget.bundle,
      casVerifyOptions(casSource, casRoot, { metadataChunkBytes: 16 }),
    );
    await delay(20);
    let locatorRetargeted = false;
    try {
      await rename(locatorRetargetPath, locatorRetargetBackup);
      await rename(locatorRetargetReplacement, locatorRetargetPath);
      locatorRetargeted = true;
    } catch (error) {
      assert.ok(['EPERM', 'EACCES', 'EBUSY', 'ENOTSUP'].includes(error?.code), error?.message);
    }
    const locatorRetargetResult = await locatorRetargetPromise;
    if (locatorRetargeted) {
      portableRetargetChecks += 1;
      assertRefused(
        locatorRetargetResult,
        'compute_oracle_before_raw_readback_cas_locator_manifest_identity_or_resolved_path_changed_during_read',
      );
    }

    console.log(JSON.stringify({
      status: 'passed',
      directEvidenceAccepted: directResult.accepted,
      portableCasAccepted: inlineCasResult.accepted,
      sparseBytesStreamedPerReadback: sparseSize,
      portableRetargetChecks,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
