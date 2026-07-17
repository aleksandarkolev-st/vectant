#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  buildSourceFirstInitialCompileRequest,
  captureSourceFirstVisualEvidence,
  coldAiSplitProofFromSeed,
  coldSourceProfileRequestIdentitySnapshot,
  deriveSourceFirstRequestIntent,
  providerCallChallengeHash,
  providerCallFileManifestFromCompileArgs,
  providerCallProducerReceiptHash,
  providerCallReceiptHash,
  providerCallRequestHash,
  recomputeColdSourceProducerEvidence,
  recomputeGpuCompileProofArtifactId,
  validateColdSourceLauncherSupportManifest,
} from '../gpu-hmr-agent-split-workspace-test.mjs';
import { writeArtifactToCas } from '../lib/gpu-hmr-artifact-cas.mjs';
import { visualArtifactTransportEvidence } from '../lib/gpu-hmr-visual-evidence.mjs';
import { visualEvidenceArtifactsFromFiles } from '../lib/gpu-hmr-validation-proof-artifact.mjs';

const execFileAsync = promisify(execFileCallback);

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

async function launcherManifestRoundTrip() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-launcher-round-trip-'));
  let generatedManifestPath = null;
  try {
    await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
    await writeFile(
      path.join(sourceRoot, 'src', 'main.cpp'),
      'int main() { return 0; }\n',
    );
    await writeFile(
      path.join(sourceRoot, 'CMakeLists.txt'),
      'cmake_minimum_required(VERSION 3.20)\nproject(cold_source_round_trip)\n',
    );
    for (const args of [
      ['init'],
      ['config', 'user.email', 'cold-source-round-trip@example.invalid'],
      ['config', 'user.name', 'Cold Source Round Trip'],
      ['config', 'core.autocrlf', 'false'],
      ['add', '.'],
      ['commit', '-m', 'cold source manifest input'],
    ]) {
      await execFileAsync('git', ['-C', sourceRoot, ...args], { windowsHide: true });
    }
    const { stdout: commitStdout } = await execFileAsync(
      'git',
      ['-C', sourceRoot, 'rev-parse', 'HEAD'],
      { windowsHide: true },
    );
    const launcherPath = fileURLToPath(
      new URL('../gpu-hmr-source-first-visual-proof.mjs', import.meta.url),
    );
    const { stdout } = await execFileAsync(process.execPath, [
      launcherPath,
      '--source-root', sourceRoot,
      '--source-commit', commitStdout.trim(),
      '--source-entry', 'src/main.cpp',
      '--source-file', 'src/main.cpp',
      '--build-file', 'CMakeLists.txt',
      '--source-authority', 'user_source_files',
      '--output-oracle-kind', 'compute_oracle',
      '--prepare-source-manifest-only',
    ], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        SYNTHI_GPU_AGENT_FIXTURE: '',
        SYNTHI_GPU_AGENT_PROFILE_PATH: '',
      },
    });
    const jsonStart = stdout.indexOf('{\n  "manifestPath"');
    assert.notEqual(jsonStart, -1, stdout);
    const launcherResult = JSON.parse(stdout.slice(jsonStart));
    generatedManifestPath = launcherResult.manifestPath;
    const manifest = JSON.parse(await readFile(generatedManifestPath, 'utf8'));
    const support = validateColdSourceLauncherSupportManifest(manifest);
    assert.equal(
      support.entryInferenceEvidence.schemaVersion,
      'synthi.gpu_hmr.source_root_entry_inference.v1',
    );
    assert.equal(support.entryInferenceEvidence.accepted, true);
    assert.equal(
      support.outputOracleRequest.schemaVersion,
      'synthi.gpu_hmr.direct_source_output_oracle_request.v1',
    );
    assert.equal(support.outputOracleRequest.outputOracleKind, 'compute_oracle');
    assert.equal(support.acceptedForGpuHmr, false);
    assert.equal(support.gpuHmrSuccess, false);
    assert.equal(support.canSatisfyRuntimeProof, false);
    assert.equal(support.canSatisfyDispatchProof, false);

    const unknownAuthority = structuredClone(manifest);
    const replaceEntryInferenceAuthority = (value) => {
      if (Array.isArray(value)) {
        value.forEach(replaceEntryInferenceAuthority);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (
        (value.schemaVersion ?? value.schema_version)
        === 'synthi.gpu_hmr.source_root_entry_inference.v1'
      ) {
        value.proofAuthority = 'unknown_support_authority';
        value.proof_authority = 'unknown_support_authority';
      }
      Object.values(value).forEach(replaceEntryInferenceAuthority);
    };
    replaceEntryInferenceAuthority(unknownAuthority);
    assert.throws(
      () => validateColdSourceLauncherSupportManifest(unknownAuthority),
      /cold_source_authority_claim_rejected|launcher_support_invalid/,
    );

    const successClaim = structuredClone(manifest);
    const injectOutputOracleSuccess = (value) => {
      if (Array.isArray(value)) {
        value.forEach(injectOutputOracleSuccess);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (
        (value.schemaVersion ?? value.schema_version)
        === 'synthi.gpu_hmr.direct_source_output_oracle_request.v1'
      ) {
        value.acceptedForGpuHmr = true;
        value.accepted_for_gpu_hmr = true;
      }
      Object.values(value).forEach(injectOutputOracleSuccess);
    };
    injectOutputOracleSuccess(successClaim);
    assert.throws(
      () => validateColdSourceLauncherSupportManifest(successClaim),
      /cold_source_authority_claim_rejected|launcher_support_invalid/,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    if (generatedManifestPath) await rm(generatedManifestPath, { force: true });
  }
}

function providerReceipt(initialCompileArgs) {
  const provider = String(initialCompileArgs.ai_provider).toLowerCase();
  const model = String(initialCompileArgs.ai_model);
  const fileManifest = providerCallFileManifestFromCompileArgs(initialCompileArgs);
  const binding = {
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
    extra_instructions_hash: sha256('opaque-instructions'),
  };
  const requestHash = providerCallRequestHash(binding);
  const challenge = {
    schema_version: 'synthi.ai.provider_call_challenge.v1',
    request_nonce: binding.nonce,
    request_hash: requestHash,
    prompt_payload_hash: sha256('opaque-prompt'),
  };
  challenge.challenge_hash = providerCallChallengeHash(challenge);
  const receipt = {
    schema_version: 'synthi.ai.provider_call_receipt.v1',
    proof_authority: 'request_bound_provider_call_only_not_gpu_hmr_success',
    accepted: true,
    provider_call_used: true,
    request_binding: binding,
    request_nonce: binding.nonce,
    request_hash: requestHash,
    response_hash: sha256('opaque-response'),
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

async function canonicalFixture(outputOracleKind, artifactRoot) {
  const source = 'extern "C" __global__ void entry(float* out) { out[0] = 1.0f; }\n';
  const entryPath = 'src/entry.hip';
  const generatedPath = '.synthi/generated/gpu/device.hip';
  const generatedSource = 'extern "C" __global__ void generated(float* out) { out[0] = 1.0f; }\n';
  const files = [{ kind: 'source', path: entryPath, name: entryPath, content: source }];
  const typedOracleIntent = outputOracleKind === 'visual_oracle'
    ? { outputOracleKind, visualSceneManifestHash: sha256('opaque-visual-contract') }
    : { outputOracleKind, runtimeExpectationHash: sha256('opaque-compute-contract') };
  const requestIntent = deriveSourceFirstRequestIntent({
    entryPath,
    files,
    typedOracleIntent,
  });
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
      ai_provider_call_nonce: 'provider-call:0123456789abcdef0123456789abcdef',
      ai_provider: `provider-${sha256('provider').slice(7, 23)}`,
      ai_model: `model-${sha256('model').slice(7, 23)}`,
      gpu_mode: 'rocm',
      gpu_arch: 'gfx1201',
      gpu_arch_source: 'focused_self_check',
      slug: 'cold-source-modality-self-check',
    },
  }).initialCompileArgs;
  const receipt = providerReceipt(initialCompileArgs);
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
  const manifest = {
    profile_id: `profile:${sha256('generated-profile').slice(7)}`,
    target_id: `target:${sha256('generated-target').slice(7)}`,
    module_files: { device: generatedPath },
    gpu: {
      vendor: 'rocm',
      device_compiler: 'hipcc',
      device_roles: [{ id: 'device', path: generatedPath, compiler: 'hipcc', arch: ['gfx1201'] }],
    },
  };
  const split = {
    files: { [generatedPath]: generatedSource },
    roles: {
      device: generatedPath,
      allPaths: [generatedPath],
      deviceRoles: [{ id: 'device', path: generatedPath, compiler: 'hipcc', arch: ['gfx1201'] }],
    },
    manifest,
    sidecar,
    sidecarRaw: stableJson(sidecar),
  };
  const compiledArtifactBytes = Buffer.from('opaque-compiled-device-bytes');
  const compiledArtifactPath = '.synthi/generated/gpu/device.bin';
  const materializedArtifactPath = path.join(
    artifactRoot,
    ...compiledArtifactPath.split('/'),
  );
  await mkdir(path.dirname(materializedArtifactPath), { recursive: true });
  await writeFile(materializedArtifactPath, compiledArtifactBytes);
  const observedCompiledArtifactBytes = await readFile(materializedArtifactPath);
  const artifactHash = sha256(observedCompiledArtifactBytes);
  const artifactId = `device:${artifactHash}`;
  const generatedSourceHash = sha256(generatedSource);
  const generatedSourceBytes = Buffer.byteLength(generatedSource, 'utf8');
  const preprocessorInput = Buffer.from('opaque-preprocessor-input');
  const compilerInput = Buffer.from('opaque-compiler-input');
  const proofArtifact = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    proofId: null,
    workspaceSlug: initialCompileArgs.slug,
    runtimeSessionId: 'runtime-session:cold-source-modality',
    sourceEditId: 'source-edit:cold-source-modality',
    selectedArtifactId: artifactId,
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
        artifactUri: artifactId,
        filePath: compiledArtifactPath,
        metadata: { artifactBytes: observedCompiledArtifactBytes.length },
      },
      {
        evidenceId: 'evidence:device-compiler',
        kind: 'device-compiler-output',
        metadata: {
          compileProvenance: {
            compilerExecutable: '/opt/toolchain/bin/hipcc',
            compilerIdentity: `compiler:${sha256('compiler-identity')}`,
            compilerExecutableHash: sha256('compiler-executable'),
            compilerIdentityMethod: 'held_compiler_driver_entry_file_sha256+version_output',
            deviceCompiler: 'hipcc',
            gpuVendor: 'rocm',
            gpuArch: ['gfx1201'],
            targetTriple: 'amdgcn-amd-amdhsa',
            effectiveDeviceFlags: [],
            sourceFilename: generatedPath,
            compileCommandHash: sha256('compile-command'),
            compileCommandHashScope:
              'explicit_preprocess_and_compile_program_args_cwd_environment_overrides_piped_input_hashes_and_stdout_artifact_transport',
            preprocessorCommandHash: sha256('preprocessor-command'),
            requestSourceSha256: generatedSourceHash,
            requestSourceBytes: generatedSourceBytes,
            transformedSourceSha256: generatedSourceHash,
            transformedSourceBytes: generatedSourceBytes,
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
  const proofId = recomputeGpuCompileProofArtifactId(proofArtifact);
  proofArtifact.proofId = proofId;
  const producerMaterial = {
    source,
    entryPath,
    initialCompileArgs,
    split,
    typedOracleIntent,
    compileProducerMaterial: {
      proofArtifact,
      proofArtifactPath: '.synthi/gpu-hmr/proofs/cold-source.json',
      expectedProofId: proofId,
      expectedWorkspaceSlug: initialCompileArgs.slug,
      expectedVendor: 'rocm',
      expectedCompiler: 'hipcc',
      expectedArch: 'gfx1201',
      expectedSourcePath: generatedPath,
      syntheticArtifactBytes: observedCompiledArtifactBytes,
      syntheticArtifactFilePath: compiledArtifactPath,
    },
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
      metricClock: 'monotonic_ns',
      metricScope: 'cold',
      cacheState: 'clean',
      editId: 'initial-ai-split',
      editHash: sha256(source),
      editKind: 'cold_split',
      differentEdit: false,
      timings: {
        device_compile_wall_time: 10,
        runtime_probe_time: 20,
        total_validator_wall_time: 30,
      },
    },
  };
  producerMaterial.profileRequestIdentitySnapshot =
    coldSourceProfileRequestIdentitySnapshot({
      profileId: manifest.profile_id,
      profileHash: sha256('profile-material'),
      profileSource: 'focused_self_check_profile_material',
      sourceAuthority: 'focused_self_check_source_material',
      sourceManifestHash: requestIntent.sourceManifestHash,
      sourceContentHash: sha256(source),
      entryPath,
      requestIntentHash: requestIntent.intentHash,
      outputOracleKind,
      generatedSplitProfileId: manifest.profile_id,
      generatedSplitTargetId: manifest.target_id,
      evidenceRefs: [requestIntent.intentHash, requestIntent.sourceManifestHash],
    });
  const recomputed = recomputeColdSourceProducerEvidence(producerMaterial);
  const seed = {
    outputOracleKind,
    generatedArtifactHashes: recomputed.generatedArtifactHashes,
    sourceFirstIngestion: recomputed.sourceFirstIngestion,
    coldAiProviderCallEvidence: recomputed.providerCallEvidence,
    coldDeviceCompileProvenance: recomputed.deviceCompileProvenance,
    unvalidatedPayload: { retained: false },
  };
  return { producerMaterial, recomputed, requestIntent, seed };
}

async function visualFixture(root) {
  const width = 320;
  const height = 240;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      raw[offset] = (x * 5 + y) % 256;
      raw[offset + 1] = (y * 7 + x) % 256;
      raw[offset + 2] = (x * 3 + y * 11) % 256;
    }
  }
  const imagePath = path.join(root, 'frame.png');
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(imagePath);
  const bytes = await readFile(imagePath);
  const [imageEvidence] = await visualEvidenceArtifactsFromFiles([imagePath]);
  assert.equal(imageEvidence.acceptedAsImageEvidence, true);
  const casRoot = path.join(root, 'cas');
  await mkdir(casRoot, { recursive: true });
  const locator = await writeArtifactToCas(bytes, {
    artifactRoot: casRoot,
    mediaType: 'image/png',
    artifactKind: 'visual_frame',
    role: 'after_frame',
    sessionNamespace: 'cold-source-modality-self-check',
    producer: { name: 'focused_self_check', kind: 'visual_proof_worker' },
    producerSubsystem: 'cold_source_modality_self_check',
  });
  const transport = await visualArtifactTransportEvidence({
    artifactCasLocators: [locator],
  }, {
    artifactRoot: casRoot,
    allowedRoots: [root, casRoot],
    requireReadableBytes: true,
  });
  return {
    imagePath,
    producerVisual: { allowedRoots: [root, casRoot], casRoot },
    seedVisual: {
      coldSingleFrameVisual: {
        width: imageEvidence.width,
        height: imageEvidence.height,
        bytes: imageEvidence.bytes,
        visiblePixels: imageEvidence.visiblePixels,
        meanLuma: imageEvidence.meanLuma,
      },
      visualArtifacts: {
        afterImage: imagePath,
        afterImageHash: imageEvidence.contentHash,
        artifactCasLocators: [locator],
        visualArtifactTransportEvidence: transport,
      },
      visualMetrics: {
        visiblePixelCount: imageEvidence.visiblePixels,
        meanLuma8bit: imageEvidence.meanLuma,
      },
    },
  };
}

await launcherManifestRoundTrip();

const syntheticRoot = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-cold-source-material-'));
const compute = await canonicalFixture('compute_oracle', syntheticRoot);
let screenshotCalls = 0;
for (const stage of ['cold', 'hot_delta_1_after', 'hot_delta_2_before', 'hot_delta_2_after']) {
  const capture = await captureSourceFirstVisualEvidence({
    requestIntent: compute.requestIntent,
    stage,
    capture: async () => {
      screenshotCalls += 1;
      throw new Error(`compute source-first invoked screenshot sentinel at ${stage}`);
    },
  });
  assert.equal(capture, null);
}
assert.equal(screenshotCalls, 0);

await assert.rejects(
  captureSourceFirstVisualEvidence({
    requestIntent: {
      ...compute.requestIntent,
      output_oracle_kind: 'visual_oracle',
    },
    stage: 'alias-conflict-sentinel',
    capture: async () => {
      screenshotCalls += 1;
      throw new Error('conflicting modality aliases invoked screenshot sentinel');
    },
  }),
  /cold_source_alias_conflict/,
);
assert.equal(screenshotCalls, 0);

const computeProof = await coldAiSplitProofFromSeed(compute.seed, compute.producerMaterial);
assert.equal(computeProof.acceptedAsColdAiSplitEvidence, false);
assert.equal(computeProof.syntheticOrReplayIneligible, true);
assert.equal(computeProof.coldSplitProven, false);
assert.equal(computeProof.outputOracleKind, 'compute_oracle');
assert.equal(
  computeProof.schemaVersion,
  'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
);
assert.equal(computeProof.acceptedForGpuHmr, false);
assert.equal(computeProof.gpuHmrSuccess, false);
assert.equal(computeProof.canSatisfyRuntimeProof, false);
assert.equal(computeProof.canSatisfyDispatchProof, false);
assert.equal(computeProof.canSatisfyOutputOracleProof, false);
assert.equal(
  computeProof.validationMatrixEligibility,
  'not_counted_until_cold_source_modality_ingestion',
);
assert.equal(Object.hasOwn(computeProof, 'visualArtifacts'), false);
assert.equal(Object.hasOwn(computeProof, 'unvalidatedPayload'), false);
assert.equal(computeProof.coldAiProviderCallEvidence.accepted, false);
assert.equal(
  computeProof.coldAiProviderCallEvidence.acceptedAsColdAiProviderCallEvidence,
  false,
);
assert.equal(
  computeProof.coldAiProviderCallEvidence.canonicalProviderReceiptVerified,
  true,
);
assert.equal(computeProof.coldDeviceCompileProvenance.accepted, false);
assert.equal(computeProof.coldDeviceCompileProvenance.byteObservationVerified, true);
assert.ok(
  computeProof.generatedArtifactHashes.includes(
    computeProof.coldDeviceCompileProvenance.artifactHash,
  ),
);
assert.equal(
  computeProof.requestedModalityBinding.sourceContentHash,
  computeProof.sourceFirstIngestion.sourceContentHash,
);
assert.equal(
  computeProof.requestedModalityBinding.providerCallEvidenceHash,
  computeProof.coldAiProviderCallEvidence.evidenceHash,
);
assert.equal(
  computeProof.requestedModalityBinding.deviceCompileArtifactHash,
  computeProof.coldDeviceCompileProvenance.artifactHash,
);
assert.equal(
  computeProof.requestedModalityBinding.timingEvidenceHash,
  computeProof.timingMetrics.evidenceHash,
);
assert.equal(
  computeProof.requestedModalityBinding.profileRequestIdentityHash,
  compute.recomputed.profileRequestIdentity.identityHash,
);
assert.equal(
  computeProof.coldSourceDerivationChain.derivationChainHash,
  computeProof.requestedModalityBinding.derivationChainHash,
);
assert.equal(
  computeProof.coldSourceDerivationChain.generatedDeviceSourceHash,
  computeProof.coldDeviceCompileProvenance.generatedSourceHash,
);
assert.equal(
  computeProof.coldSourceDerivationChain.compileProofArtifactPath,
  computeProof.coldDeviceCompileProvenance.proofArtifactPath,
);
assert.equal(
  computeProof.coldSourceDerivationChain.compileCommandInputBindingHash,
  computeProof.coldDeviceCompileProvenance.compileCommandInputBindingHash,
);
assert.equal(
  computeProof.coldSourceDerivationChain.compileDependencyInputBindingHash,
  computeProof.coldDeviceCompileProvenance.dependencyInputBindingHash,
);
assert.equal(computeProof.coldSourceDerivationChain.acceptedForGpuHmr, false);
assert.equal(computeProof.coldSourceDerivationChain.gpuHmrSuccess, false);

const canonicalReceipt = compute.producerMaterial.split.sidecar.provider_call_receipt;
const canonicalReceiptHash = providerCallReceiptHash(canonicalReceipt);
const producerReceiptHash = providerCallProducerReceiptHash(canonicalReceipt);
for (const [field, rejectedValue] of [
  ['accepted', false],
  ['provider_call_used', false],
  ['challenge_echo_verified', false],
  ['hard_infra_failure', true],
]) {
  const mutatedReceipt = structuredClone(canonicalReceipt);
  mutatedReceipt[field] = rejectedValue;
  assert.notEqual(
    providerCallReceiptHash(mutatedReceipt),
    canonicalReceiptHash,
    `canonical receipt hash ignored ${field}`,
  );
  assert.equal(
    providerCallProducerReceiptHash(mutatedReceipt),
    producerReceiptHash,
    `producer compatibility hash unexpectedly changed for ${field}`,
  );
  const mutatedProducer = structuredClone(compute.producerMaterial);
  mutatedProducer.split.sidecar.provider_call_receipt = mutatedReceipt;
  assert.throws(
    () => recomputeColdSourceProducerEvidence(mutatedProducer),
    /provider_receipt_rejected/,
    field,
  );
}
const equivalentReceiptAliases = {
  ...structuredClone(canonicalReceipt),
  providerCallUsed: true,
  challengeEchoVerified: true,
  hardInfraFailure: false,
};
assert.equal(providerCallReceiptHash(equivalentReceiptAliases), canonicalReceiptHash);
const conflictingReceiptAliases = {
  ...structuredClone(canonicalReceipt),
  providerCallUsed: false,
};
assert.throws(
  () => providerCallReceiptHash(conflictingReceiptAliases),
  /cold_source_alias_conflict/,
);

const staleIntent = structuredClone(compute.producerMaterial);
staleIntent.initialCompileArgs.source_first_request_intent.intentHash = sha256('stale-intent');
staleIntent.initialCompileArgs.source_first_request_intent.intent_hash = sha256('stale-intent');
assert.throws(
  () => recomputeColdSourceProducerEvidence(staleIntent),
  /canonical_evidence_mismatch:source_first_request_intent/,
);

const providerReplay = structuredClone(compute.producerMaterial);
providerReplay.initialCompileArgs.ai_provider_call_nonce =
  'provider-call:fedcba9876543210fedcba9876543210';
assert.throws(
  () => recomputeColdSourceProducerEvidence(providerReplay),
  /provider_receipt_rejected/,
);
const providerResponseSplice = structuredClone(compute.producerMaterial);
const responseSpliceReceipt = providerResponseSplice.split.sidecar.provider_call_receipt;
responseSpliceReceipt.response_hash = sha256('spliced-provider-response');
responseSpliceReceipt.receipt_hash = providerCallProducerReceiptHash(responseSpliceReceipt);
responseSpliceReceipt.call_id = `provider-call:${responseSpliceReceipt.receipt_hash}`;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, providerResponseSplice),
  /canonical_evidence_mismatch:provider_call_evidence/,
);
const providerChallengeSplice = structuredClone(compute.producerMaterial);
const challengeSpliceReceipt = providerChallengeSplice.split.sidecar.provider_call_receipt;
challengeSpliceReceipt.challenge.prompt_payload_hash = sha256('spliced-provider-challenge');
challengeSpliceReceipt.challenge.challenge_hash = providerCallChallengeHash(
  challengeSpliceReceipt.challenge,
);
challengeSpliceReceipt.challenge_hash = challengeSpliceReceipt.challenge.challenge_hash;
challengeSpliceReceipt.receipt_hash = providerCallProducerReceiptHash(challengeSpliceReceipt);
challengeSpliceReceipt.call_id = `provider-call:${challengeSpliceReceipt.receipt_hash}`;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, providerChallengeSplice),
  /canonical_evidence_mismatch:provider_call_evidence/,
);

const compileMismatch = structuredClone(compute.seed);
compileMismatch.generatedArtifactHashes = compileMismatch.generatedArtifactHashes.filter(
  (value) => value !== compileMismatch.coldDeviceCompileProvenance.artifactHash,
);
await assert.rejects(
  coldAiSplitProofFromSeed(compileMismatch, compute.producerMaterial),
  /generated_artifact_hashes_mismatch|compile_artifact_not_in_generated/,
);
const compileReplay = structuredClone(compute.producerMaterial);
const replayedArtifactHash = sha256('replayed-compiled-device-bytes');
const replayedArtifactId = `device:${replayedArtifactHash}`;
compileReplay.compileProducerMaterial.proofArtifact.selectedArtifactId = replayedArtifactId;
compileReplay.compileProducerMaterial.proofArtifact.evidenceRefs[0].contentHash =
  replayedArtifactHash;
compileReplay.compileProducerMaterial.proofArtifact.evidenceRefs[0].artifactUri =
  replayedArtifactId;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, compileReplay),
  /artifact_observed_hash_mismatch|compile_evidence_rejected/,
);
const metadataOnlyCompile = structuredClone(compute.producerMaterial);
delete metadataOnlyCompile.compileProducerMaterial.syntheticArtifactBytes;
assert.throws(
  () => recomputeColdSourceProducerEvidence(metadataOnlyCompile),
  /artifact_bytes_unobserved|compile_evidence_rejected/,
);
const compileLengthMismatch = structuredClone(compute.producerMaterial);
compileLengthMismatch.compileProducerMaterial.proofArtifact
  .evidenceRefs[0].metadata.artifactBytes += 1;
assert.throws(
  () => recomputeColdSourceProducerEvidence(compileLengthMismatch),
  /artifact_observed_length_mismatch|compile_evidence_rejected/,
);
const generatedSourceContentSplice = structuredClone(compute.producerMaterial);
const generatedSourcePath = generatedSourceContentSplice.split.roles.device;
generatedSourceContentSplice.split.files[generatedSourcePath] += '\n// spliced generated bytes';
assert.throws(
  () => recomputeColdSourceProducerEvidence(generatedSourceContentSplice),
  /generated_source_content_mismatch|compile_evidence_rejected/,
);

const mcpRequestHashSplice = structuredClone(compute.producerMaterial);
mcpRequestHashSplice.initialCompileArgs.width = 777;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, mcpRequestHashSplice),
  /canonical_evidence_mismatch:(?:source_first_ingestion|device_compile_provenance)/,
);

const proofPathSplice = structuredClone(compute.producerMaterial);
proofPathSplice.compileProducerMaterial.proofArtifactPath =
  '.synthi/gpu-hmr/proofs/spliced-cold-source.json';
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, proofPathSplice),
  /canonical_evidence_mismatch:device_compile_provenance/,
);

const compileCommandSplice = structuredClone(compute.producerMaterial);
const compileCommandProof = compileCommandSplice.compileProducerMaterial.proofArtifact;
compileCommandProof.evidenceRefs[1].metadata.compileProvenance.compileCommandHash =
  sha256('spliced-compile-command');
compileCommandProof.proofId = recomputeGpuCompileProofArtifactId(compileCommandProof);
compileCommandSplice.compileProducerMaterial.expectedProofId = compileCommandProof.proofId;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, compileCommandSplice),
  /canonical_evidence_mismatch:device_compile_provenance/,
);

const dependencyInputSplice = structuredClone(compute.producerMaterial);
const dependencyProof = dependencyInputSplice.compileProducerMaterial.proofArtifact;
const dependencyProvenance = dependencyProof.evidenceRefs[1].metadata.compileProvenance;
dependencyProvenance.compiledSourceSha256 = sha256('spliced-compiler-input');
dependencyProvenance.dependencyHash = dependencyProvenance.compiledSourceSha256;
dependencyProof.proofId = recomputeGpuCompileProofArtifactId(dependencyProof);
dependencyInputSplice.compileProducerMaterial.expectedProofId = dependencyProof.proofId;
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, dependencyInputSplice),
  /canonical_evidence_mismatch:device_compile_provenance/,
);

const sourceReplay = structuredClone(compute.producerMaterial);
sourceReplay.source = `${sourceReplay.source}\n// changed source bytes`;
assert.throws(
  () => recomputeColdSourceProducerEvidence(sourceReplay),
  /profile_request_identity_binding_mismatch|ingestion_rejected/,
);
const sourceProofReplay = structuredClone(compute.seed);
const replayedSourceProofId =
  `agent-split-source-first-ingestion:sha256:${'e'.repeat(64)}`;
sourceProofReplay.sourceFirstIngestion.proofId = replayedSourceProofId;
sourceProofReplay.sourceFirstIngestion.proof_id = replayedSourceProofId;
await assert.rejects(
  coldAiSplitProofFromSeed(sourceProofReplay, compute.producerMaterial),
  /canonical_evidence_mismatch:source_first_ingestion/,
);

const crossProfileReplay = structuredClone(compute.producerMaterial);
crossProfileReplay.profileRequestIdentitySnapshot =
  coldSourceProfileRequestIdentitySnapshot({
    ...crossProfileReplay.profileRequestIdentitySnapshot,
    profileId: `profile:${sha256('replayed-profile').slice(7)}`,
    profile_id: `profile:${sha256('replayed-profile').slice(7)}`,
  });
await assert.rejects(
  coldAiSplitProofFromSeed(compute.seed, crossProfileReplay),
  /canonical_evidence_mismatch:source_first_ingestion|profile_request_identity/,
);

const aliasConflict = structuredClone(compute.seed);
aliasConflict.output_oracle_kind = 'visual_oracle';
await assert.rejects(
  coldAiSplitProofFromSeed(aliasConflict, compute.producerMaterial),
  /cold_source_alias_conflict/,
);
const nestedAliasConflict = structuredClone(compute.seed);
nestedAliasConflict.sourceFirstIngestion.proof_id =
  `agent-split-source-first-ingestion:sha256:${'f'.repeat(64)}`;
await assert.rejects(
  coldAiSplitProofFromSeed(nestedAliasConflict, compute.producerMaterial),
  /cold_source_alias_conflict/,
);
for (const injection of [
  { fullRuntimeProven: true },
  { strictRuntimeProofAccepted: 'yes' },
  { gpuHmrSuccess: 'false' },
  { outputAuthority: 'runtime_output' },
  { nested: { runtimeAuthority: {} } },
  { nested: { dispatchAuthority: null } },
  { nested: { proofAuthority: 'transport_integrity_only' } },
]) {
  await assert.rejects(
    coldAiSplitProofFromSeed({ ...compute.seed, ...injection }, compute.producerMaterial),
    /cold_source_authority_claim_rejected/,
  );
}
const requestAuthorityInjection = structuredClone(compute.producerMaterial);
requestAuthorityInjection.typedOracleIntent.proofAuthority = 'transport_integrity_only';
assert.throws(
  () => recomputeColdSourceProducerEvidence(requestAuthorityInjection),
  /cold_source_authority_claim_rejected:coldSource.requestEnvelope/,
);

const visual = await canonicalFixture('visual_oracle', syntheticRoot);
await assert.rejects(
  coldAiSplitProofFromSeed(visual.seed, visual.producerMaterial),
  /protocol_field_missing:visualArtifacts/,
);
await assert.rejects(
  coldAiSplitProofFromSeed(
    { ...compute.seed, outputOracleKind: 'visual_oracle' },
    compute.producerMaterial,
  ),
  /output_oracle_kind_mismatch/,
);

const root = await mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-cold-source-modality-'));
try {
  const visualBytes = await visualFixture(root);
  visual.producerMaterial.visual = visualBytes.producerVisual;
  Object.assign(visual.seed, visualBytes.seedVisual);
  const visualProof = await coldAiSplitProofFromSeed(visual.seed, visual.producerMaterial);
  assert.equal(visualProof.acceptedAsColdAiSplitEvidence, false);
  assert.equal(visualProof.syntheticOrReplayIneligible, true);
  assert.equal(visualProof.acceptedForGpuHmr, false);
  assert.equal(
    visualProof.visualArtifacts.byteVerifiedVisualArtifact.acceptedAsImageEvidence,
    true,
  );
  assert.equal(
    visualProof.visualArtifacts.byteVerifiedVisualArtifact.immutableSingleRead,
    true,
  );

  const hashMismatch = structuredClone(visual.seed);
  hashMismatch.visualArtifacts.afterImageHash = sha256('forged-image-hash');
  await assert.rejects(
    coldAiSplitProofFromSeed(hashMismatch, visual.producerMaterial),
    /visual_png_hash_or_bytes_invalid/,
  );

  const metricMismatch = structuredClone(visual.seed);
  metricMismatch.visualMetrics.visiblePixelCount += 1;
  await assert.rejects(
    coldAiSplitProofFromSeed(metricMismatch, visual.producerMaterial),
    /visual_metrics_recompute_mismatch/,
  );

  const originalFramePath = visualBytes.imagePath;
  const retainedFramePath = path.join(root, 'retained-frame.png');
  const replacementFramePath = path.join(root, 'replacement-frame.png');
  await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 250, g: 20, b: 20 },
    },
  }).png().toFile(replacementFramePath);
  await rename(originalFramePath, retainedFramePath);
  let retargetTestSupported = true;
  try {
    await symlink(replacementFramePath, originalFramePath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error?.code)) {
      retargetTestSupported = false;
      await rename(retainedFramePath, originalFramePath);
    } else {
      throw error;
    }
  }
  if (retargetTestSupported) {
    try {
      await assert.rejects(
        coldAiSplitProofFromSeed(visual.seed, visual.producerMaterial),
        /visual_link_or_reparse_traversal/,
      );
    } finally {
      await rm(originalFramePath, { force: true });
      await rename(retainedFramePath, originalFramePath);
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(syntheticRoot, { recursive: true, force: true });
}

const runnerSource = await readFile(
  new URL('../gpu-hmr-agent-split-workspace-test.mjs', import.meta.url),
  'utf8',
);
for (const captureVariable of [
  'baselineShot',
  'afterShot',
  'hotDelta2BaselineShot',
  'afterHotDelta2Shot',
]) {
  assert.match(
    runnerSource,
    new RegExp(`const ${captureVariable} = await capture(?:ColdSource|SourceFirst)VisualEvidence\\(`),
  );
}
assert.doesNotMatch(runnerSource, /const afterShot = await assertMcpScreenshot\(/);
assert.doesNotMatch(runnerSource, /const afterHotDelta2Shot = await assertMcpScreenshot\(/);
assert.match(
  runnerSource,
  /const artifactBytes = await readWorkerFileBytes\(split\.workspacePath, artifactFilePath\);/,
);
assert.match(runnerSource, /LIVE_MCP_COMPILE_CAPABILITY_SLOT/);
assert.match(runnerSource, /LIVE_COLD_SOURCE_CAPABILITY_SLOT/);
assert.match(runnerSource, /bytes = await handle\.readFile\(\);/);
assert.match(runnerSource, /analyzeGpuHmrImageEvidence\(frame\.bytes\)/);
const recomputeSource = runnerSource.slice(
  runnerSource.indexOf('export function recomputeColdSourceProducerEvidence'),
  runnerSource.indexOf('function coldSourceModalityBinding'),
);
assert.doesNotMatch(recomputeSource, /ACTIVE_AGENT_PROFILE/);
assert.doesNotMatch(
  recomputeSource,
  /generatedArtifactHashes\s*=\s*uniqueSortedStrings\(\[\s*\.\.\.sourceFirstIngestion\.generatedArtifactHashes/,
);
const launcherSource = await readFile(
  new URL('../gpu-hmr-source-first-visual-proof.mjs', import.meta.url),
  'utf8',
);
assert.match(
  launcherSource,
  /if \(outputOracleKind === 'compute_oracle'\) \{\s*process\.env\.SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS = '0';/,
);
assert.doesNotMatch(
  launcherSource,
  /if \(outputOracleKind === 'compute_oracle'\) \{\s*setDefaultEnv\('SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS', '1'\)/,
);

console.log('gpu-hmr cold source modality self-check passed');
