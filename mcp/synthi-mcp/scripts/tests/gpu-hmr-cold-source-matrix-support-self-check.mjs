#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSourceFirstInitialCompileRequest,
  coldAiSplitProofFromSeed,
  coldSourceProfileRequestIdentitySnapshot,
  deriveSourceFirstRequestIntent,
  providerCallChallengeHash,
  providerCallFileManifestFromCompileArgs,
  providerCallProducerReceiptHash,
  providerCallRequestHash,
  recomputeColdSourceProducerEvidence,
  recomputeGpuCompileProofArtifactId,
} from '../gpu-hmr-agent-split-workspace-test.mjs';
import {
  validateArtifactCasManifest,
  writeArtifactToCas,
} from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  evaluateColdSourceSplitCompileSupport,
  GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_AUTHORITY,
  GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_SCHEMA_VERSION,
} from '../lib/gpu-hmr-cold-source-matrix-support.mjs';
import {
  buildGpuHmrValidationMatrixLedger,
  collectGpuHmrValidationMatrixLedger,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTENT_ID_PATTERN = /^[a-z][a-z-]*:sha256:[a-f0-9]{64}$/;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashValue(value) {
  return sha256(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value));
}

function contentId(kind, value) {
  return `${kind}:${hashValue(value)}`;
}

function setAliases(object, camel, snake, value) {
  object[camel] = value;
  object[snake] = value;
}

function orderedJsonHash(values) {
  return sha256(JSON.stringify(values));
}

function setSupportOnlyFlags(value, { accepted = true } = {}) {
  value.accepted = accepted;
  setAliases(
    value,
    'acceptedForGpuHmr',
    'accepted_for_gpu_hmr',
    false,
  );
  setAliases(value, 'gpuHmrSuccess', 'gpu_hmr_success', false);
  setAliases(
    value,
    'canSatisfyRuntimeProof',
    'can_satisfy_runtime_proof',
    false,
  );
  setAliases(
    value,
    'canSatisfyDispatchProof',
    'can_satisfy_dispatch_proof',
    false,
  );
  setAliases(
    value,
    'canSatisfyOutputOracleProof',
    'can_satisfy_output_oracle_proof',
    false,
  );
}

function providerReceipt(initialCompileArgs, identityHash) {
  const provider = String(initialCompileArgs.ai_provider).toLowerCase();
  const model = String(initialCompileArgs.ai_model);
  const fileManifest = providerCallFileManifestFromCompileArgs(initialCompileArgs);
  const requestBinding = {
    schema_version: 'synthi.ai.provider_call_request.v2',
    nonce: initialCompileArgs.ai_provider_call_nonce,
    mode: 'split',
    request_mode: 'split',
    language: initialCompileArgs.language,
    focus: initialCompileArgs.filename,
    requested_provider: provider,
    requested_model: model,
    gpu_arch: initialCompileArgs.gpu_arch,
    source_hash: sha256(initialCompileArgs.source),
    file_manifest_hash: fileManifest.hash,
    file_count: fileManifest.count,
    extra_instructions_hash: hashValue({ identityHash, kind: 'provider-instructions' }),
  };
  const requestHash = providerCallRequestHash(requestBinding);
  const challenge = {
    schema_version: 'synthi.ai.provider_call_challenge.v1',
    request_nonce: requestBinding.nonce,
    request_hash: requestHash,
    prompt_payload_hash: hashValue({ identityHash, kind: 'provider-prompt' }),
  };
  challenge.challenge_hash = providerCallChallengeHash(challenge);
  const receipt = {
    schema_version: 'synthi.ai.provider_call_receipt.v1',
    proof_authority: 'request_bound_provider_call_only_not_gpu_hmr_success',
    accepted: true,
    provider_call_used: true,
    request_binding: requestBinding,
    request_nonce: requestBinding.nonce,
    request_hash: requestHash,
    response_hash: hashValue({ identityHash, kind: 'provider-response' }),
    challenge,
    challenge_hash: challenge.challenge_hash,
    challenge_echo_verified: true,
    provider,
    requested_model: model,
    actual_model: model,
    request_mode: 'split',
    provider_model_status: 'available',
    fallback_model: null,
    fallback_used: false,
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-07-17T00:00:00.000Z',
    hard_infra_failure: false,
    started_monotonic_ns: '1000',
    completed_monotonic_ns: '2000',
    started_unix_ns: '1800000000000000000',
    completed_unix_ns: '1800000000000001000',
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  };
  receipt.receipt_hash = providerCallProducerReceiptHash(receipt);
  receipt.call_id = `provider-call:${receipt.receipt_hash}`;
  return receipt;
}

function compileEvidenceHash(compile, requestBinding) {
  return hashValue({
    proofArtifactPath: compile.proofArtifactPath,
    proofArtifactIdentity: compile.proofArtifactIdentity,
    proofId: compile.proofArtifactId,
    workspaceSlug: requestBinding.workspaceSlug ?? null,
    selectedArtifactId: compile.selectedArtifactId,
    artifactFilePath: compile.artifactFilePath,
    artifactHash: compile.artifactHash,
    artifactBytes: compile.artifactBytes,
    declaredArtifactHash: compile.declaredArtifactHash,
    declaredArtifactBytes: compile.declaredArtifactBytes,
    artifactObservationKind: 'worker_live_read',
    byteObservationVerified: compile.byteObservationVerified,
    liveObservationAccepted: compile.liveObservationAccepted,
    compiledArtifactCasLocator: compile.compiledArtifactCasLocator,
    compiledArtifactCasBinding: compile.compiledArtifactCasBinding,
    compiledArtifactCasBindingHash: compile.compiledArtifactCasBindingHash,
    compiledArtifactCasRole: compile.compiledArtifactCasRole,
    compiledArtifactCasMediaType: compile.compiledArtifactCasMediaType,
    compiledArtifactCasContentHash: compile.compiledArtifactCasContentHash,
    compiledArtifactCasByteLength: compile.compiledArtifactCasByteLength,
    compiledArtifactCasManifestHash: compile.compiledArtifactCasManifestHash,
    compileInvocationBindingHash: compile.compileInvocationBindingHash,
    mcpRequestHash: compile.mcpRequestHash,
    mcpCompileResponseHash: compile.mcpCompileResponseHash,
    generatedSourcePath: compile.generatedSourcePath,
    generatedSourceHash: compile.generatedSourceHash,
    generatedSourceBytes: compile.generatedSourceBytes,
    compileCommandInputBindingHash: compile.compileCommandInputBindingHash,
    dependencyInputBindingHash: compile.dependencyInputBindingHash,
    compilerExecutable: compile.compilerExecutable,
    deviceCompiler: compile.deviceCompiler,
    gpuVendor: compile.gpuVendor,
    gpuArch: compile.gpuArch,
    sourceFilename: compile.sourceFilename,
    compileCommandHash: compile.compileCommandHash,
    dependencyHash: compile.dependencyHash,
    compilerIdentity: compile.compilerIdentity,
    cacheHit: compile.cacheHit,
    verificationGaps: compile.verificationGaps,
    eligibilityGaps: compile.eligibilityGaps,
    blockingGaps: compile.blockingGaps,
  });
}

function promoteCompileEvidence(compile, producerEvidence) {
  const promoted = structuredClone(compile);
  const mcpRequestHash = producerEvidence.expectedMcpRequestHash;
  const mcpCompileResponseHash = hashValue({
    requestHash: mcpRequestHash,
    proofArtifactId: promoted.proofArtifactId,
    artifactHash: promoted.artifactHash,
  });
  const compileInvocationBindingHash = hashValue({
    schemaVersion: 'synthi.gpu_hmr.fixture_compile_observation_binding.v1',
    requestHash: mcpRequestHash,
    responseHash: mcpCompileResponseHash,
    proofArtifactId: promoted.proofArtifactId,
    proofArtifactPath: promoted.proofArtifactPath,
    generatedSourceHash: promoted.generatedSourceHash,
    artifactHash: promoted.artifactHash,
  });
  setSupportOnlyFlags(promoted);
  setAliases(
    promoted,
    'acceptedAsFreshDeviceCompileEvidence',
    'accepted_as_fresh_device_compile_evidence',
    true,
  );
  setAliases(promoted, 'liveObservationAccepted', 'live_observation_accepted', true);
  setAliases(
    promoted,
    'syntheticOrReplayIneligible',
    'synthetic_or_replay_ineligible',
    false,
  );
  setAliases(
    promoted,
    'compileInvocationBindingHash',
    'compile_invocation_binding_hash',
    compileInvocationBindingHash,
  );
  setAliases(promoted, 'mcpRequestHash', 'mcp_request_hash', mcpRequestHash);
  setAliases(
    promoted,
    'mcpCompileResponseHash',
    'mcp_compile_response_hash',
    mcpCompileResponseHash,
  );
  for (const [camel, snake] of [
    ['verificationGaps', 'verification_gaps'],
    ['eligibilityGaps', 'eligibility_gaps'],
    ['blockingGaps', 'blocking_gaps'],
  ]) {
    setAliases(promoted, camel, snake, []);
  }
  const requestBinding = producerEvidence.initialCompileRequestSupport.requestBinding;
  const evidenceHash = compileEvidenceHash(promoted, requestBinding);
  setAliases(promoted, 'evidenceHash', 'evidence_hash', evidenceHash);
  return promoted;
}

function promoteProviderEvidence(provider) {
  const promoted = structuredClone(provider);
  setSupportOnlyFlags(promoted);
  setAliases(
    promoted,
    'acceptedAsColdAiProviderCallEvidence',
    'accepted_as_cold_ai_provider_call_evidence',
    true,
  );
  setAliases(promoted, 'liveObservationAccepted', 'live_observation_accepted', true);
  setAliases(
    promoted,
    'syntheticOrReplayIneligible',
    'synthetic_or_replay_ineligible',
    false,
  );
  setAliases(promoted, 'blockingGaps', 'blocking_gaps', []);
  return promoted;
}

function derivationChain(row, generatedArtifactManifestHash) {
  const source = row.sourceFirstIngestion;
  const profile = source.profileRequestIdentity;
  const request = source.initialCompileCacheRequestSupport;
  const provider = row.coldAiProviderCallEvidence;
  const compile = row.coldDeviceCompileProvenance;
  const timing = row.timingMetrics;
  const seed = {
    schemaVersion: row.coldSourceDerivationChain.schemaVersion,
    profileRequestIdentityHash: profile.identityHash,
    requestIntentHash: source.initialCompileContract.sourceFirstRequestIntent.intentHash,
    initialCompileRequestIdentity: request.requestIdentity,
    mcpRequestHash: compile.mcpRequestHash,
    sourceFirstProofId: source.proofId,
    sourceContentHash: source.sourceContentHash,
    sourceManifestHash: source.initialManifestHash,
    generatedDeviceSourcePath: compile.generatedSourcePath,
    generatedDeviceSourceHash: compile.generatedSourceHash,
    generatedDeviceSourceBytes: compile.generatedSourceBytes,
    generatedArtifactManifestHash,
    generatedArtifactHashes: [...row.generatedArtifactHashes].sort(),
    sidecarHash: source.sidecarHash,
    compileManifestHash: source.compileManifestHash,
    providerCallReceiptHash: provider.providerCallReceiptHash,
    providerCallProducerReceiptHash: provider.providerCallProducerReceiptHash,
    providerCallRequestHash: provider.providerCallRequestHash,
    providerCallResponseHash: provider.providerCallResponseHash,
    providerCallChallengeHash: provider.providerCallChallengeHash,
    providerProtocolMaterialHash: provider.providerProtocolMaterialHash,
    providerCallEvidenceHash: provider.evidenceHash,
    compileEvidenceHash: compile.evidenceHash,
    compileProofArtifactId: compile.proofArtifactId,
    compileProofArtifactIdentity: compile.proofArtifactIdentity,
    compileProofArtifactPath: compile.proofArtifactPath,
    compileArtifactHash: compile.artifactHash,
    compileArtifactBytes: compile.artifactBytes,
    compileArtifactFilePath: compile.artifactFilePath,
    compileArtifactCasRole: compile.compiledArtifactCasRole,
    compileArtifactCasMediaType: compile.compiledArtifactCasMediaType,
    compileArtifactCasContentHash: compile.compiledArtifactCasContentHash,
    compileArtifactCasByteLength: compile.compiledArtifactCasByteLength,
    compileArtifactCasManifestHash: compile.compiledArtifactCasManifestHash,
    compileArtifactCasBindingHash: compile.compiledArtifactCasBindingHash,
    compileCommandHash: compile.compileCommandHash,
    compileDependencyHash: compile.dependencyHash,
    compileCommandInputBindingHash: compile.compileCommandInputBindingHash,
    compileDependencyInputBindingHash: compile.dependencyInputBindingHash,
    compileInvocationBindingHash: compile.compileInvocationBindingHash,
    compileResponseHash: compile.mcpCompileResponseHash,
    timingEvidenceHash: timing.evidenceHash,
    outputOracleKind: 'compute_oracle',
  };
  const chain = {
    ...seed,
    schema_version: seed.schemaVersion,
    proofAuthority: row.coldSourceDerivationChain.proofAuthority,
    proof_authority: row.coldSourceDerivationChain.proofAuthority,
    derivationChainHash: hashValue(seed),
    acceptedAsCanonicalDerivationChain: true,
    accepted_as_canonical_derivation_chain: true,
  };
  chain.derivation_chain_hash = chain.derivationChainHash;
  setSupportOnlyFlags(chain);
  setAliases(chain, 'blockingGaps', 'blocking_gaps', []);
  return chain;
}

function modalityBinding(row, generatedArtifactManifestHash, derivationHash) {
  const source = row.sourceFirstIngestion;
  const profile = source.profileRequestIdentity;
  const request = source.initialCompileCacheRequestSupport;
  const intent = source.initialCompileContract.sourceFirstRequestIntent;
  const provider = row.coldAiProviderCallEvidence;
  const compile = row.coldDeviceCompileProvenance;
  const timing = row.timingMetrics;
  const seed = {
    schemaVersion: row.requestedModalityBinding.schemaVersion,
    outputOracleKind: 'compute_oracle',
    sourceFirstProofId: source.proofId,
    profileRequestIdentityHash: profile.identityHash,
    sourceContentHash: source.sourceContentHash,
    sourceManifestHash: source.initialManifestHash,
    initialManifestHash: source.initialManifestHash,
    sourcePurityManifestHash: source.sourcePurityManifestHash,
    requestIntentHash: intent.intentHash,
    initialCompileRequestIdentity: request.requestIdentity,
    mcpRequestHash: compile.mcpRequestHash,
    derivationChainHash: derivationHash,
    generatedArtifactHashes: [...row.generatedArtifactHashes].sort(),
    generatedArtifactManifestHash,
    generatedDeviceSourceHash: compile.generatedSourceHash,
    sidecarHash: source.sidecarHash,
    compileManifestHash: source.compileManifestHash,
    providerCallReceiptHash: provider.providerCallReceiptHash,
    providerCallRequestHash: provider.providerCallRequestHash,
    providerCallResponseHash: provider.providerCallResponseHash,
    providerCallChallengeHash: provider.providerCallChallengeHash,
    providerProtocolMaterialHash: provider.providerProtocolMaterialHash,
    providerCallEvidenceHash: provider.evidenceHash,
    deviceCompileArtifactHash: compile.artifactHash,
    deviceCompileEvidenceHash: compile.evidenceHash,
    deviceCompileProofArtifactId: compile.proofArtifactId,
    deviceCompileProofArtifactPath: compile.proofArtifactPath,
    deviceCompileProofArtifactIdentity: compile.proofArtifactIdentity,
    deviceCompileCommandHash: compile.compileCommandHash,
    deviceCompileDependencyHash: compile.dependencyHash,
    deviceCompileCommandInputBindingHash: compile.compileCommandInputBindingHash,
    deviceCompileDependencyInputBindingHash: compile.dependencyInputBindingHash,
    deviceCompileArtifactCasManifestHash: compile.compiledArtifactCasManifestHash,
    deviceCompileArtifactCasBindingHash: compile.compiledArtifactCasBindingHash,
    timingEvidenceHash: timing.evidenceHash,
  };
  const binding = {
    ...seed,
    schema_version: seed.schemaVersion,
    proofAuthority: row.requestedModalityBinding.proofAuthority,
    proof_authority: row.requestedModalityBinding.proofAuthority,
    bindingHash: hashValue(seed),
    acceptedAsRequestedModalityBinding: true,
    accepted_as_requested_modality_binding: true,
  };
  binding.binding_hash = binding.bindingHash;
  setSupportOnlyFlags(binding);
  setAliases(binding, 'blockingGaps', 'blocking_gaps', []);
  return binding;
}

function refreshBindings(row, generatedArtifactManifestHash) {
  const chain = derivationChain(row, generatedArtifactManifestHash);
  setAliases(row, 'coldSourceDerivationChain', 'cold_source_derivation_chain', chain);
  const binding = modalityBinding(
    row,
    generatedArtifactManifestHash,
    chain.derivationChainHash,
  );
  setAliases(row, 'requestedModalityBinding', 'requested_modality_binding', binding);
}

function canonicalProviderSnapshot(template, material) {
  const canonicalJson = stableJson(material);
  const materialHash = sha256(canonicalJson);
  return {
    schemaVersion: template.schemaVersion,
    schema_version: template.schemaVersion,
    proofAuthority: template.proofAuthority,
    proof_authority: template.proofAuthority,
    material,
    canonicalJson,
    canonical_json: canonicalJson,
    materialHash,
    material_hash: materialHash,
    acceptedAsCanonicalProviderProtocolSnapshot: true,
    accepted_as_canonical_provider_protocol_snapshot: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
  };
}

function rehashProviderEvidence(provider, material) {
  const request = material.request;
  const challenge = material.challenge;
  const receipt = material.receipt;
  const requestHash = orderedJsonHash([
    request.schemaVersion,
    request.nonce,
    request.mode,
    request.requestMode,
    request.language,
    request.focus,
    request.requestedProvider,
    request.requestedModel,
    request.gpuArch,
    request.sourceHash,
    request.fileManifestHash,
    request.fileCount,
    request.extraInstructionsHash,
  ]);
  request.requestHash = requestHash;
  challenge.requestNonce = request.nonce;
  challenge.requestHash = requestHash;
  const challengeHash = orderedJsonHash([
    challenge.schemaVersion,
    challenge.requestNonce,
    challenge.requestHash,
    challenge.promptPayloadHash,
  ]);
  challenge.challengeHash = challengeHash;
  receipt.requestNonce = request.nonce;
  receipt.requestHash = requestHash;
  receipt.challengeHash = challengeHash;
  const producerReceiptHash = orderedJsonHash([
    receipt.schemaVersion,
    receipt.proofAuthority,
    receipt.requestNonce,
    receipt.requestHash,
    receipt.responseHash,
    receipt.challengeHash,
    receipt.provider,
    receipt.requestedModel,
    receipt.actualModel,
    receipt.requestMode,
    receipt.providerModelStatus,
    String(receipt.fallbackModel ?? ''),
    receipt.fallbackUsed,
    String(receipt.providerModelAliasResolvedTo ?? ''),
    receipt.providerShutdownOrDeprecationDetected,
    receipt.modelAvailabilityCheckedAt,
    receipt.startedMonotonicNs,
    receipt.completedMonotonicNs,
    receipt.startedUnixNs,
    receipt.completedUnixNs,
  ]);
  receipt.receiptHash = producerReceiptHash;
  receipt.callId = `provider-call:${producerReceiptHash}`;
  const canonicalReceiptHash = orderedJsonHash([
    'synthi.ai.provider_call_receipt.canonical_acceptance_binding.v1',
    producerReceiptHash,
    receipt.accepted,
    receipt.providerCallUsed,
    receipt.challengeEchoVerified,
    receipt.hardInfraFailure,
  ]);
  const snapshot = canonicalProviderSnapshot(provider.providerProtocolSnapshot, material);
  const evidenceSeed = {
    schemaVersion: provider.schemaVersion,
    proofAuthority: provider.proofAuthority,
    requiredByCaller: true,
    providerCallUsed: true,
    provider: String(receipt.provider).toLowerCase(),
    requestedProvider: String(request.requestedProvider).toLowerCase(),
    requestedModel: receipt.requestedModel,
    actualModel: receipt.actualModel,
    providerModelStatus: receipt.providerModelStatus,
    fallbackModel: receipt.fallbackModel,
    fallbackUsed: receipt.fallbackUsed,
    providerModelAliasResolvedTo: receipt.providerModelAliasResolvedTo,
    providerShutdownOrDeprecationDetected: receipt.providerShutdownOrDeprecationDetected,
    hardInfraFailure: receipt.hardInfraFailure === true,
    providerCallId: receipt.callId,
    providerCallReceiptHash: canonicalReceiptHash,
    providerCallProducerReceiptHash: producerReceiptHash,
    providerCallRequestHash: requestHash,
    providerCallResponseHash: receipt.responseHash,
    providerCallChallengeHash: challengeHash,
    providerCallNonce: request.nonce,
    providerProtocolSnapshot: snapshot,
    providerProtocolMaterialHash: snapshot.materialHash,
    blockingGaps: [],
  };
  const evidenceHash = hashValue(evidenceSeed);
  setAliases(provider, 'providerProtocolSnapshot', 'provider_protocol_snapshot', snapshot);
  setAliases(
    provider,
    'providerProtocolMaterialHash',
    'provider_protocol_material_hash',
    snapshot.materialHash,
  );
  for (const [camel, snake, value] of [
    ['providerCallId', 'provider_call_id', receipt.callId],
    ['providerCallReceiptHash', 'provider_call_receipt_hash', canonicalReceiptHash],
    ['providerCallProducerReceiptHash', 'provider_call_producer_receipt_hash', producerReceiptHash],
    ['providerCallRequestHash', 'provider_call_request_hash', requestHash],
    ['providerCallResponseHash', 'provider_call_response_hash', receipt.responseHash],
    ['providerCallChallengeHash', 'provider_call_challenge_hash', challengeHash],
    ['providerCallNonce', 'provider_call_nonce', request.nonce],
    ['evidenceHash', 'evidence_hash', evidenceHash],
    ['evidenceRef', 'evidence_ref', `cold-ai-provider-call:${evidenceHash}`],
  ]) {
    setAliases(provider, camel, snake, value);
  }
  return provider;
}

async function createFixture(root) {
  const source = 'void compute_value(float *output) { output[0] = 1.0f; }\n';
  const entryPath = 'src/compute.c';
  const generatedPath = '.synthi/generated/gpu/device.cl';
  const generatedSource = 'void generated_compute(float *output) { output[0] = 1.0f; }\n';
  const sourceHash = sha256(source);
  const generatedSourceHash = sha256(generatedSource);
  const identityHash = hashValue({ entryPath, sourceHash, generatedPath, generatedSourceHash });
  const files = [{ kind: 'source', path: entryPath, name: entryPath, content: source }];
  const typedOracleIntent = {
    outputOracleKind: 'compute_oracle',
    runtimeExpectationHash: hashValue({ identityHash, kind: 'compute-oracle' }),
  };
  const requestIntent = deriveSourceFirstRequestIntent({
    entryPath,
    files,
    typedOracleIntent,
  });
  const providerName = contentId('provider', { identityHash });
  const modelName = contentId('model', { identityHash });
  const workspaceSlug = contentId('workspace', { identityHash });
  const architecture = `generic-arch-${identityHash.slice(7, 23)}`;
  const initialCompileArgs = buildSourceFirstInitialCompileRequest({
    mode: 'cold-ai-split',
    requireFreshAiSplit: true,
    compileArgs: {
      language: requestIntent.language,
      filename: entryPath,
      source,
      files,
      is_gui: requestIntent.isGui,
      source_first_request_intent: requestIntent,
      use_ai_split: true,
      user_requested_ai: true,
      prefer_gpu_pipeline: true,
      ai_provider_call_nonce: `provider-call:${identityHash.slice(7, 39)}`,
      ai_provider: providerName,
      ai_model: modelName,
      gpu_mode: 'generic_compute',
      gpu_arch: architecture,
      gpu_arch_source: 'content_addressed_request',
      slug: workspaceSlug,
    },
  }).initialCompileArgs;
  const receipt = providerReceipt(initialCompileArgs, identityHash);
  const sidecar = {
    model_provenance: {
      provider_call_used: true,
      provider: receipt.provider,
      requested_model: receipt.requested_model,
      actual_model: receipt.actual_model,
      provider_model_status: receipt.provider_model_status,
      fallback_model: null,
      fallback_used: false,
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: false,
      request_mode: 'split',
      model_availability_checked_at: receipt.model_availability_checked_at,
      hard_infra_failure: false,
    },
    provider_call_receipt: receipt,
  };
  const profileId = contentId('profile', { identityHash, request: requestIntent.intentHash });
  const targetId = contentId('target', { identityHash, generatedSourceHash });
  const manifest = {
    profile_id: profileId,
    target_id: targetId,
    module_files: { device: generatedPath },
    gpu: {
      vendor: 'generic_compute',
      device_compiler: 'cc',
      device_roles: [{
        id: contentId('role', { generatedPath }),
        path: generatedPath,
        compiler: 'cc',
        arch: [architecture],
      }],
    },
  };
  const split = {
    files: { [generatedPath]: generatedSource },
    roles: {
      device: generatedPath,
      allPaths: [generatedPath],
      deviceRoles: manifest.gpu.device_roles,
    },
    manifest,
    sidecar,
    sidecarRaw: stableJson(sidecar),
  };
  const compiledArtifactBytes = Buffer.from(stableJson({
    identityHash,
    generatedSourceHash,
    compiler: 'cc',
  }));
  const compiledArtifactPath = '.synthi/generated/gpu/device.bin';
  const casRoot = path.join(root, 'cas');
  const locator = await writeArtifactToCas(compiledArtifactBytes, {
    artifactRoot: casRoot,
    mediaType: 'application/octet-stream',
    artifactKind: 'compiled_device_artifact',
    role: 'compiled_device_artifact',
    sessionNamespace: `fixture-${hashValue({ identityHash }).slice(7)}`,
    producer: { name: 'protocol_fixture', kind: 'cold_compile_observer' },
    producerSubsystem: 'cold_source_protocol_fixture',
  });
  const casValidation = await validateArtifactCasManifest(locator, {
    artifactRoot: casRoot,
    allowedRoots: [root, casRoot],
    requireReadableBytes: true,
  });
  assert.equal(casValidation.accepted, true, casValidation.reasons.join(','));
  const artifactHash = sha256(compiledArtifactBytes);
  const selectedArtifactId = `device:${artifactHash}`;
  const preprocessorInput = Buffer.from(stableJson({ identityHash, stage: 'preprocess' }));
  const compilerInput = Buffer.from(stableJson({ generatedSourceHash, stage: 'compile' }));
  const proofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    proofId: null,
    workspaceSlug,
    runtimeSessionId: contentId('runtime-session', { identityHash }),
    sourceEditId: contentId('source-edit', { sourceHash }),
    selectedArtifactId,
    resultState: 'gpu-hmr-compile-proven',
    degradedState: null,
    degradedReason: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    stageResults: [{
      stageId: 'device-compile',
      status: 'passed',
      evidenceRefs: ['evidence:device-artifact', 'evidence:device-compiler'],
    }],
    evidenceRefs: [
      {
        evidenceId: 'evidence:device-artifact',
        kind: 'device-artifact',
        contentHash: artifactHash,
        artifactUri: selectedArtifactId,
        filePath: compiledArtifactPath,
        metadata: { artifactBytes: compiledArtifactBytes.length },
      },
      {
        evidenceId: 'evidence:device-compiler',
        kind: 'device-compiler-output',
        metadata: {
          compileProvenance: {
            compilerExecutable: '/toolchain/bin/cc',
            compilerIdentity: contentId('compiler', { executable: 'cc' }),
            compilerExecutableHash: hashValue({ executable: 'cc' }),
            compilerIdentityMethod: 'executable_sha256_and_version_output',
            deviceCompiler: 'cc',
            gpuVendor: 'generic_compute',
            gpuArch: [architecture],
            targetTriple: 'generic-compute-none',
            effectiveDeviceFlags: [],
            sourceFilename: generatedPath,
            compileCommandHash: hashValue({ identityHash, command: 'compile' }),
            compileCommandHashScope:
              'explicit_preprocess_and_compile_program_args_cwd_environment_overrides_piped_input_hashes_and_stdout_artifact_transport',
            preprocessorCommandHash: hashValue({ identityHash, command: 'preprocess' }),
            requestSourceSha256: generatedSourceHash,
            requestSourceBytes: Buffer.byteLength(generatedSource, 'utf8'),
            transformedSourceSha256: generatedSourceHash,
            transformedSourceBytes: Buffer.byteLength(generatedSource, 'utf8'),
            sourceTransforms: [],
            preprocessorInputSha256: sha256(preprocessorInput),
            preprocessorInputBytes: preprocessorInput.length,
            compiledSourceSha256: sha256(compilerInput),
            compiledSourceBytes: compilerInput.length,
            dependencyHash: sha256(compilerInput),
            dependencyMethod: 'compiler_preprocessed_translation_unit_sha256',
            sourceBytesVerifiedAfterExecution: true,
            cacheHit: false,
          },
        },
      },
    ],
    visualEvidenceRefs: [],
  };
  proofArtifact.proofId = recomputeGpuCompileProofArtifactId(proofArtifact);
  const proofArtifactPath = `.synthi/gpu-hmr/proofs/${identityHash.slice(7)}.json`;
  const producerMaterial = {
    source,
    entryPath,
    initialCompileArgs,
    split,
    typedOracleIntent,
    compileProducerMaterial: {
      proofArtifact,
      proofArtifactPath,
      expectedProofId: proofArtifact.proofId,
      expectedWorkspaceSlug: workspaceSlug,
      expectedVendor: 'generic_compute',
      expectedCompiler: 'cc',
      expectedArch: architecture,
      expectedSourcePath: generatedPath,
      compiledArtifactCasLocator: locator,
      syntheticArtifactBytes: compiledArtifactBytes,
      syntheticArtifactFilePath: compiledArtifactPath,
      syntheticArtifactCasRoot: casRoot,
    },
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
      metricClock: 'monotonic_ns',
      metricScope: 'cold',
      cacheState: 'clean',
      editId: contentId('edit', { sourceHash }),
      editHash: sourceHash,
      editKind: 'cold_split',
      differentEdit: false,
      timings: {
        device_compile_wall_time: 10,
        runtime_probe_time: 0,
        total_validator_wall_time: 20,
      },
    },
  };
  producerMaterial.profileRequestIdentitySnapshot =
    coldSourceProfileRequestIdentitySnapshot({
      profileId,
      profileHash: hashValue({ profileId, identityHash }),
      profileSource: 'content_addressed_profile_material',
      sourceAuthority: 'ordinary_source_files',
      sourceManifestHash: requestIntent.sourceManifestHash,
      sourceContentHash: sourceHash,
      entryPath,
      requestIntentHash: requestIntent.intentHash,
      outputOracleKind: 'compute_oracle',
      generatedSplitProfileId: profileId,
      generatedSplitTargetId: targetId,
      evidenceRefs: [requestIntent.intentHash, requestIntent.sourceManifestHash],
    });
  const producerEvidence = recomputeColdSourceProducerEvidence(producerMaterial);
  const seed = {
    outputOracleKind: 'compute_oracle',
    generatedArtifactHashes: producerEvidence.generatedArtifactHashes,
    sourceFirstIngestion: producerEvidence.sourceFirstIngestion,
    coldAiProviderCallEvidence: producerEvidence.providerCallEvidence,
    coldDeviceCompileProvenance: producerEvidence.deviceCompileProvenance,
  };
  const producerProof = await coldAiSplitProofFromSeed(seed, producerMaterial);
  assert.equal(producerProof.acceptedAsColdAiSplitEvidence, false);

  // Live-observation capabilities are private; derive only their content-bound result fields.
  const row = structuredClone(producerProof);
  const sourceFirst = structuredClone(row.sourceFirstIngestion);
  delete sourceFirst.initial_compile_contract;
  const requestIntentProjection = structuredClone(
    sourceFirst.initialCompileContract.sourceFirstRequestIntent,
  );
  const oracleEvidenceRefs = [...new Set(Object.values(
    requestIntentProjection.oracleEvidenceHashes,
  ).filter(Boolean))].sort();
  setAliases(
    requestIntentProjection,
    'oracleEvidenceRefs',
    'oracle_evidence_refs',
    oracleEvidenceRefs,
  );
  setAliases(
    sourceFirst.initialCompileContract,
    'sourceFirstRequestIntent',
    'source_first_request_intent',
    requestIntentProjection,
  );
  setAliases(row, 'sourceFirstIngestion', 'source_first_ingestion', sourceFirst);
  const provider = promoteProviderEvidence(row.coldAiProviderCallEvidence);
  setAliases(row, 'coldAiProviderCallEvidence', 'cold_ai_provider_call_evidence', provider);
  const compile = promoteCompileEvidence(row.coldDeviceCompileProvenance, producerEvidence);
  setAliases(row, 'coldDeviceCompileProvenance', 'cold_device_compile_provenance', compile);
  const timing = structuredClone(row.timingMetrics);
  setAliases(row, 'timingMetrics', 'timing_metrics', timing);
  setAliases(row, 'runMode', 'run_mode', timing);
  for (const [camel, snake] of [
    ['coldSplitProven', 'cold_split_proven'],
    ['canonicalColdSourceMaterialVerified', 'canonical_cold_source_material_verified'],
    ['liveObservationAccepted', 'live_observation_accepted'],
    ['acceptedAsColdAiSplitEvidence', 'accepted_as_cold_ai_split_evidence'],
  ]) {
    setAliases(row, camel, snake, true);
  }
  setAliases(
    row,
    'syntheticOrReplayIneligible',
    'synthetic_or_replay_ineligible',
    false,
  );
  setSupportOnlyFlags(row, { accepted: false });
  delete row.accepted;
  refreshBindings(row, producerEvidence.generatedArtifactManifestHash);

  const sourceFirstFacet = {
    ...sourceFirst,
    initialFiles: sourceFirst.initialCompileContract.initialFiles,
    initial_files: sourceFirst.initialCompileContract.initialFiles,
  };
  const context = {
    baseDir: root,
    allowedCasRoots: [root, casRoot],
    sourceFirstFacet,
  };
  for (const hash of [
    sourceHash,
    requestIntent.sourceManifestHash,
    generatedSourceHash,
    artifactHash,
    locator.contentHash,
    locator.manifestHash,
    producerEvidence.generatedArtifactManifestHash,
  ]) {
    assert.match(hash, SHA256_PATTERN);
  }
  for (const hash of row.generatedArtifactHashes) assert.match(hash, SHA256_PATTERN);
  for (const id of [profileId, targetId, workspaceSlug, providerName, modelName]) {
    assert.match(id, CONTENT_ID_PATTERN);
  }
  return {
    row,
    context,
    casPath: locator.storage.localPath,
    compiledArtifactBytes,
    generatedArtifactManifestHash: producerEvidence.generatedArtifactManifestHash,
  };
}

async function expectRejected(label, row, context, expectedGaps) {
  const result = await evaluateColdSourceSplitCompileSupport(row, context);
  assert.equal(result.accepted, false, `${label} was accepted`);
  assert.equal(result.acceptedForGpuHmr, false, `${label} gained GPU HMR authority`);
  assert.equal(result.gpuHmrSuccess, false, `${label} gained success authority`);
  assert.equal(result.canSatisfyRuntimeProof, false, `${label} gained runtime authority`);
  for (const expected of expectedGaps) {
    assert(
      result.blockingGaps.some((gap) => expected.test(gap)),
      `${label} missing ${expected}; got ${result.blockingGaps.join(',')}`,
    );
  }
  return result;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-cold-source-matrix-support-'));
try {
  const fixture = await createFixture(root);
  const valid = await evaluateColdSourceSplitCompileSupport(fixture.row, fixture.context);
  assert.equal(valid.schemaVersion, GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_SCHEMA_VERSION);
  assert.equal(valid.proofAuthority, GPU_HMR_COLD_SOURCE_SPLIT_COMPILE_SUPPORT_AUTHORITY);
  assert.equal(valid.accepted, true, valid.blockingGaps.join(','));
  assert.equal(valid.acceptedAsColdSourceSplitCompileSupport, true);
  assert.equal(valid.supportOnly, true);
  assert.equal(valid.acceptedForGpuHmr, false);
  assert.equal(valid.gpuHmrSuccess, false);
  assert.equal(valid.canSatisfyRuntimeProof, false);
  assert.equal(valid.canSatisfyDispatchProof, false);
  assert.equal(valid.canSatisfyOutputOracleProof, false);
  assert.equal(valid.compiledArtifactCasAccepted, true);
  assert.deepEqual(valid.blockingGaps, []);
  assert.match(valid.supportHash, SHA256_PATTERN);

  const matrixInputRoot = path.join(root, 'matrix-input');
  await mkdir(matrixInputRoot, { recursive: true });
  await writeFile(
    path.join(matrixInputRoot, 'cold-source-compute.json'),
    `${JSON.stringify(fixture.row, null, 2)}\n`,
  );
  const matrix = await collectGpuHmrValidationMatrixLedger({
    repoRoot: root,
    mcpRoot: root,
    roots: [matrixInputRoot],
    latestPerTarget: false,
    includeUnproven: true,
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  const matrixSupportRows = matrix.rows.filter((row) => row.matrixOutcome === 'support_only');
  assert.equal(matrixSupportRows.length, 1);
  const matrixSupportRow = matrixSupportRows[0];
  assert.equal(matrixSupportRow.safety.accepted, true);
  assert.equal(matrixSupportRow.acceptedForGpuHmr, false);
  assert.equal(matrixSupportRow.gpuHmrSuccess, false);
  assert.equal(matrixSupportRow.proofChainAccepted, false);
  assert.equal(matrixSupportRow.visual.present, false);
  assert.equal(matrixSupportRow.visual.accepted, false);
  assert.equal(matrixSupportRow.outputOracleFacet.accepted, false);
  assert.equal(matrix.summary.supportOnlyRows, 1);
  assert.equal(matrix.summary.acceptedFullRuntimeGpuHmrRows, 0);
  assert.equal(matrix.summary.visualProfileAcceptedRows, 0);

  const forgedMatrixSupport = structuredClone(matrixSupportRow);
  forgedMatrixSupport.coldSourceSplitCompileSupport.gpuHmrSuccess = true;
  forgedMatrixSupport.coldSourceSplitCompileSupport.gpu_hmr_success = true;
  forgedMatrixSupport.visual = {
    present: true,
    accepted: true,
    images: [{ role: 'after', hash: hashValue('forged-matrix-visual') }],
  };
  const forgedMatrix = buildGpuHmrValidationMatrixLedger([forgedMatrixSupport], {
    latestPerTarget: false,
    includeInvalidated: true,
    includeUnproven: true,
    generatedAt: '2026-07-17T00:00:00.000Z',
    repoRoot: root,
    mcpRoot: root,
  });
  assert.equal(forgedMatrix.rows.length, 1);
  assert.equal(forgedMatrix.rows[0].matrixOutcome, 'unproven');
  assert.equal(forgedMatrix.rows[0].safety.accepted, false);
  assert(
    forgedMatrix.rows[0].safety.failedGates.some((failure) =>
      failure.code === 'support_only_row_facet_claimed_runtime_or_gpu_hmr_authority'
    ),
  );
  assert(
    forgedMatrix.rows[0].safety.failedGates.some((failure) =>
      failure.code === 'support_only_row_cannot_carry_accepted_visual_evidence'
    ),
  );

  const successClaim = structuredClone(fixture.row);
  setAliases(successClaim, 'gpuHmrSuccess', 'gpu_hmr_success', true);
  successClaim.fullRuntimeProven = true;
  await expectRejected('runtime success claim', successClaim, fixture.context, [
    /cold_support_envelope_gpuhmrsuccess_must_be_false/,
    /cold_support_envelope_fullruntimeproven_forbidden/,
  ]);

  const authorityClaim = structuredClone(fixture.row);
  authorityClaim.runtimeAuthority = 'recomputed_runtime_acceptance';
  await expectRejected('runtime authority claim', authorityClaim, fixture.context, [
    /cold_support_envelope_runtimeauthority_forbidden/,
  ]);

  const corruptedBytes = Buffer.from(fixture.compiledArtifactBytes);
  corruptedBytes[0] ^= 0xff;
  await writeFile(fixture.casPath, corruptedBytes);
  try {
    const casMismatch = await expectRejected(
      'CAS byte/hash mismatch',
      fixture.row,
      fixture.context,
      [/cold_support_cas:artifact_cas_readable_hash_mismatch/],
    );
    assert.equal(casMismatch.compiledArtifactCasAccepted, false);
  } finally {
    await writeFile(fixture.casPath, fixture.compiledArtifactBytes);
  }

  const staleProvider = structuredClone(fixture.row);
  const staleEvidence = staleProvider.coldAiProviderCallEvidence;
  const staleMaterial = structuredClone(staleEvidence.providerProtocolSnapshot.material);
  staleMaterial.request.nonce = `provider-call:${sha256('stale-provider-request').slice(7, 39)}`;
  rehashProviderEvidence(staleEvidence, staleMaterial);
  setAliases(
    staleProvider,
    'coldAiProviderCallEvidence',
    'cold_ai_provider_call_evidence',
    staleEvidence,
  );
  refreshBindings(staleProvider, fixture.generatedArtifactManifestHash);
  await expectRejected('stale provider receipt/challenge', staleProvider, fixture.context, [
    /cold_support_provider_request_binding_invalid/,
  ]);

  const visualPromotion = structuredClone(fixture.row);
  setAliases(visualPromotion, 'outputOracleKind', 'output_oracle_kind', 'visual_oracle');
  visualPromotion.visualArtifacts = {
    afterImageHash: hashValue({ kind: 'forged-visual-promotion' }),
  };
  await expectRejected('visual promotion', visualPromotion, fixture.context, [
    /cold_support_compute_visual_material_forbidden/,
    /cold_support_output_oracle_kind_not_compute/,
  ]);

  const runtimePromotion = structuredClone(fixture.row);
  runtimePromotion.runtimeProofArtifact = {
    proofId: contentId('runtime-proof', { kind: 'forged-runtime-promotion' }),
  };
  await expectRejected('runtime promotion', runtimePromotion, fixture.context, [
    /cold_support_runtime_authority_carrier_forbidden/,
  ]);

  console.log('gpu-hmr cold-source matrix support self-check passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
