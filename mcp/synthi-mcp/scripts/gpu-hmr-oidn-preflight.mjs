#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildComputeOracleArtifactsFromByteEvidence,
  buildRuntimeBoundaryRunModeProof,
} from './lib/gpu-hmr-runtime-boundary-proof-adapter.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

const OIDN_OUTPUT_ORACLE_SCHEMA = 'synthi.gpu_hmr.oidn_output_oracle.v1';
const OIDN_OUTPUT_ORACLE_AUTHORITY = 'oidn_output_oracle_file_bytes_only_not_gpu_hmr_success';
const OIDN_OUTPUT_ORACLE_ROLES = [
  {
    role: 'noisy_input',
    pathKeys: ['noisyInputPath', 'noisy_input_path', 'inputNoisyPath', 'input_noisy_path', 'inputPath', 'input_path'],
    shaKeys: ['noisyInputSha256', 'noisy_input_sha256', 'inputNoisySha256', 'input_noisy_sha256', 'inputSha256', 'input_sha256'],
    outputPathKey: 'noisyInputPath',
    outputShaKey: 'noisyInputSha256',
  },
  {
    role: 'denoised_output',
    pathKeys: ['denoisedOutputPath', 'denoised_output_path', 'outputPath', 'output_path', 'afterPath', 'after_path'],
    shaKeys: ['denoisedOutputSha256', 'denoised_output_sha256', 'outputSha256', 'output_sha256', 'afterSha256', 'after_sha256'],
    outputPathKey: 'denoisedOutputPath',
    outputShaKey: 'denoisedOutputSha256',
  },
  {
    role: 'expected_output',
    pathKeys: ['expectedOutputPath', 'expected_output_path'],
    shaKeys: ['expectedOutputSha256', 'expected_output_sha256'],
    outputPathKey: 'expectedOutputPath',
    outputShaKey: 'expectedOutputSha256',
  },
];

function argValue(name) {
  const eq = `${name}=`;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === name) return rawArgs[index + 1] ?? '';
    if (arg.startsWith(eq)) return arg.slice(eq.length);
  }
  return '';
}

const CFG = {
  workerContainer: process.env.SYNTHI_OIDN_WORKER_CONTAINER
    ?? process.env.WORKER_CONTAINER
    ?? process.env.SYNTHI_WORKER_CONTAINER
    ?? '',
  repoPath: process.env.SYNTHI_OIDN_REPO_PATH ?? '',
  oidnTestPath: process.env.SYNTHI_OIDN_TEST_PATH
    ?? process.env.SYNTHI_OIDNTEST_PATH
    ?? argValue('--oidn-test-path')
    ?? '',
  hipDeviceLibraryPath: process.env.SYNTHI_OIDN_HIP_DEVICE_LIBRARY_PATH
    ?? process.env.SYNTHI_OIDN_HIP_LIBRARY_PATH
    ?? argValue('--hip-device-library-path')
    ?? '',
  slug: process.env.SLUG
    ?? process.env.SYNTHI_OIDN_PREFLIGHT_SLUG
    ?? `oidn-preflight-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  outputDir: process.env.SYNTHI_OIDN_PREFLIGHT_OUTPUT_DIR
    ?? path.resolve(__dirname, '../.gpu-hmr-test-artifacts/oidn-preflight'),
  timeoutMs: Number(process.env.SYNTHI_OIDN_PREFLIGHT_TIMEOUT_MS ?? 120000),
  seed: process.env.SYNTHI_OIDN_RNG_SEED ?? '12345',
  requireHip: process.env.SYNTHI_OIDN_REQUIRE_HIP === '1',
  allowRejected: process.env.SYNTHI_OIDN_ALLOW_REJECTED === '1',
  outputOracleManifestPath: process.env.SYNTHI_OIDN_OUTPUT_ORACLE_MANIFEST_PATH
    ?? argValue('--output-oracle-manifest')
    ?? '',
  workerOutputOracleManifestPath: process.env.SYNTHI_OIDN_WORKER_OUTPUT_ORACLE_MANIFEST_PATH
    ?? process.env.SYNTHI_OIDN_WORKER_OUTPUT_ORACLE_MANIFEST
    ?? argValue('--worker-output-oracle-manifest')
    ?? '',
  workerOutputOracleAllowedRoots: process.env.SYNTHI_OIDN_WORKER_OUTPUT_ORACLE_ALLOWED_ROOTS ?? '',
  runtimeBoundaryEventsPath: process.env.SYNTHI_OIDN_RUNTIME_BOUNDARY_EVENTS_PATH
    ?? process.env.SYNTHI_OIDN_RUNTIME_BOUNDARY_EVENT_MANIFEST_PATH
    ?? argValue('--runtime-boundary-events')
    ?? argValue('--runtime-boundary-event-manifest')
    ?? '',
  outputOracleAllowedRoots: process.env.SYNTHI_OIDN_OUTPUT_ORACLE_ALLOWED_ROOTS ?? '',
};

function failConfig(message) {
  throw new Error(`${message}. Set SYNTHI_OIDN_WORKER_CONTAINER and SYNTHI_OIDN_REPO_PATH explicitly for live preflight.`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cleanToken(value) {
  return String(value || 'oidn-preflight').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'oidn-preflight';
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableJson(value[key]);
    return out;
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex');
}

function sha256Stable(value) {
  return `sha256:${sha256Json(value)}`;
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(text);
  return match ? `sha256:${match[1]}` : null;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function authorityClaimsSuccess(object) {
  if (!object || typeof object !== 'object') return false;
  return object.acceptedForGpuHmr === true
    || object.accepted_for_gpu_hmr === true
    || object.gpuHmrSuccess === true
    || object.gpu_hmr_success === true
    || object.canSatisfyRuntimeProof === true
    || object.can_satisfy_runtime_proof === true;
}

function runtimeBoundaryManifestClaimsSuccess(object) {
  if (!object || typeof object !== 'object') return false;
  if (authorityClaimsSuccess(object)) return true;
  const events = [
    ...(Array.isArray(object.runtimeBoundaryEvents) ? object.runtimeBoundaryEvents : []),
    ...(Array.isArray(object.runtime_boundary_events) ? object.runtime_boundary_events : []),
    ...(Array.isArray(object.adapterRuntimeBoundaryEvents) ? object.adapterRuntimeBoundaryEvents : []),
    ...(Array.isArray(object.adapter_runtime_boundary_events) ? object.adapter_runtime_boundary_events : []),
    ...(Array.isArray(object.events) ? object.events : []),
  ];
  return events.some((event) => authorityClaimsSuccess(event));
}

function isPathInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPosixPathInside(child, root) {
  const normalizedChild = path.posix.normalize(String(child || ''));
  const normalizedRoot = path.posix.normalize(String(root || ''));
  if (!normalizedChild || !normalizedRoot || !path.posix.isAbsolute(normalizedChild) || !path.posix.isAbsolute(normalizedRoot)) {
    return false;
  }
  return normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot.replace(/\/+$/, '')}/`);
}

function manifestText(manifest, keys) {
  return firstText(...keys.map((key) => manifest?.[key]));
}

function workerManifestFilePath(manifestDir, value) {
  const text = firstText(value);
  if (!text) return '';
  return path.posix.isAbsolute(text)
    ? path.posix.normalize(text)
    : path.posix.normalize(path.posix.join(manifestDir, text));
}

function safeLocalArtifactName(role, workerPath) {
  const base = cleanToken(path.posix.basename(workerPath || role)) || `${role}.bin`;
  return `${role}-${base}`;
}

async function safeRealpath(value) {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

async function outputOracleAllowedRoots(manifestPath) {
  const configured = CFG.outputOracleAllowedRoots
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = [
    path.dirname(path.resolve(manifestPath)),
    path.resolve(CFG.outputDir),
    ...configured.map((entry) => path.resolve(entry)),
  ];
  const resolved = [];
  for (const root of roots) {
    const real = await safeRealpath(root);
    if (real && !resolved.includes(real)) resolved.push(real);
  }
  return resolved;
}

async function resolveOutputOraclePath(manifestPath, value, allowedRoots) {
  const text = firstText(value);
  if (!text) {
    return { path: null, resolvedPath: null, accepted: false, failedGates: ['oidn_output_oracle_path_missing'] };
  }
  const candidate = path.isAbsolute(text)
    ? text
    : path.resolve(path.dirname(path.resolve(manifestPath)), text);
  const resolved = await safeRealpath(candidate);
  if (!resolved) {
    return { path: candidate, resolvedPath: null, accepted: false, failedGates: ['oidn_output_oracle_file_unreadable'] };
  }
  const inside = allowedRoots.some((root) => isPathInside(resolved, root));
  if (!inside) {
    return { path: candidate, resolvedPath: resolved, accepted: false, failedGates: ['oidn_output_oracle_path_outside_allowed_roots'] };
  }
  return { path: candidate, resolvedPath: resolved, accepted: true, failedGates: [] };
}

async function verifyOutputOracleFile({ role, manifestPath, value, declaredSha256, allowedRoots }) {
  const resolved = await resolveOutputOraclePath(manifestPath, value, allowedRoots);
  if (!resolved.accepted) {
    return {
      role,
      ...resolved,
      byteLength: 0,
      sha256: null,
      declaredSha256: normalizeSha256(declaredSha256),
      accepted: false,
      failedGates: resolved.failedGates.map((code) => `${role}:${code}`),
    };
  }
  try {
    const bytes = await readFile(resolved.resolvedPath);
    const sha256 = `sha256:${sha256Buffer(bytes)}`;
    const declared = normalizeSha256(declaredSha256);
    const failedGates = [];
    if (bytes.length <= 0) failedGates.push(`${role}:oidn_output_oracle_file_empty`);
    if (declared && declared !== sha256) failedGates.push(`${role}:oidn_output_oracle_hash_mismatch`);
    return {
      role,
      path: resolved.path,
      resolvedPath: resolved.resolvedPath,
      resolved_path: resolved.resolvedPath,
      byteLength: bytes.length,
      byte_length: bytes.length,
      sha256,
      declaredSha256: declared,
      declared_sha256: declared,
      accepted: failedGates.length === 0,
      failedGates,
      failed_gates: failedGates,
    };
  } catch {
    return {
      role,
      path: resolved.path,
      resolvedPath: resolved.resolvedPath,
      resolved_path: resolved.resolvedPath,
      byteLength: 0,
      byte_length: 0,
      sha256: null,
      declaredSha256: normalizeSha256(declaredSha256),
      declared_sha256: normalizeSha256(declaredSha256),
      accepted: false,
      failedGates: [`${role}:oidn_output_oracle_file_unreadable`],
      failed_gates: [`${role}:oidn_output_oracle_file_unreadable`],
    };
  }
}

async function buildOidnOutputOracleEvidence(manifestPath) {
  if (!manifestPath) return null;
  const resolvedManifestPath = path.resolve(manifestPath);
  const failedGates = [];
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await readFile(resolvedManifestPath);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return {
      schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
      proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
      accepted: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      manifestPath: resolvedManifestPath,
      manifest_path: resolvedManifestPath,
      failedGates: ['oidn_output_oracle_manifest_unreadable'],
      failed_gates: ['oidn_output_oracle_manifest_unreadable'],
    };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failedGates.push('oidn_output_oracle_manifest_not_object');
    manifest = {};
  }
  const schema = firstText(manifest.schemaVersion, manifest.schema_version, manifest.schema);
  if (schema !== OIDN_OUTPUT_ORACLE_SCHEMA) failedGates.push('oidn_output_oracle_schema_mismatch');
  const authority = firstText(manifest.proofAuthority, manifest.proof_authority);
  if (authority && authority !== OIDN_OUTPUT_ORACLE_AUTHORITY) {
    failedGates.push('oidn_output_oracle_authority_mismatch');
  }
  if (authorityClaimsSuccess(manifest)) failedGates.push('oidn_output_oracle_claims_gpu_hmr_success');
  const backend = firstText(manifest.backend, manifest.backendFamily, manifest.backend_family);
  if (backend && backend !== 'oidn_hip') failedGates.push('oidn_output_oracle_backend_mismatch');
  const device = firstText(manifest.device, manifest.runtimeDevice, manifest.runtime_device);
  if (device && device !== 'hip') failedGates.push('oidn_output_oracle_device_mismatch');
  const allowedRoots = await outputOracleAllowedRoots(resolvedManifestPath);
  const noisy = await verifyOutputOracleFile({
    role: 'noisy_input',
    manifestPath: resolvedManifestPath,
    value: firstText(
      manifest.noisyInputPath,
      manifest.noisy_input_path,
      manifest.inputNoisyPath,
      manifest.input_noisy_path,
      manifest.inputPath,
      manifest.input_path,
    ),
    declaredSha256: firstText(
      manifest.noisyInputSha256,
      manifest.noisy_input_sha256,
      manifest.inputNoisySha256,
      manifest.input_noisy_sha256,
      manifest.inputSha256,
      manifest.input_sha256,
    ),
    allowedRoots,
  });
  const denoised = await verifyOutputOracleFile({
    role: 'denoised_output',
    manifestPath: resolvedManifestPath,
    value: firstText(
      manifest.denoisedOutputPath,
      manifest.denoised_output_path,
      manifest.outputPath,
      manifest.output_path,
      manifest.afterPath,
      manifest.after_path,
    ),
    declaredSha256: firstText(
      manifest.denoisedOutputSha256,
      manifest.denoised_output_sha256,
      manifest.outputSha256,
      manifest.output_sha256,
      manifest.afterSha256,
      manifest.after_sha256,
    ),
    allowedRoots,
  });
  const expectedPath = firstText(manifest.expectedOutputPath, manifest.expected_output_path);
  const expectedSha256 = normalizeSha256(firstText(
    manifest.expectedOutputSha256,
    manifest.expected_output_sha256,
  ));
  const expected = expectedPath
    ? await verifyOutputOracleFile({
      role: 'expected_output',
      manifestPath: resolvedManifestPath,
      value: expectedPath,
      declaredSha256: expectedSha256,
      allowedRoots,
    })
    : null;
  failedGates.push(...noisy.failedGates, ...denoised.failedGates, ...(expected?.failedGates ?? []));
  const outputDistinctFromInput = Boolean(noisy.sha256 && denoised.sha256 && noisy.sha256 !== denoised.sha256);
  if (!outputDistinctFromInput) failedGates.push('oidn_output_oracle_output_equals_input');
  const expectedHash = expected?.sha256 ?? expectedSha256;
  if (!expectedHash) {
    failedGates.push('oidn_expected_output_hash_missing');
  } else if (denoised.sha256 && denoised.sha256 !== expectedHash) {
    failedGates.push('oidn_expected_output_hash_mismatch');
  }
  const accepted = failedGates.length === 0;
  const evidenceRefs = accepted
    ? [
      `oidn-output-oracle-manifest:sha256:${sha256Buffer(manifestBytes)}`,
      `oidn-output-oracle-noisy:${noisy.sha256}`,
      `oidn-output-oracle-denoised:${denoised.sha256}`,
      `oidn-output-oracle-expected:${expectedHash}`,
    ]
    : [];
  const facetBase = {
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    schema_version: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    proof_authority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    backend: 'oidn_hip',
    device: 'hip',
    manifestPath: resolvedManifestPath,
    manifest_path: resolvedManifestPath,
    manifestSha256: `sha256:${sha256Buffer(manifestBytes)}`,
    manifest_sha256: `sha256:${sha256Buffer(manifestBytes)}`,
    allowedRoots,
    allowed_roots: allowedRoots,
    files: [noisy, denoised, ...(expected ? [expected] : [])],
    outputDistinctFromInput,
    output_distinct_from_input: outputDistinctFromInput,
    expectedOutputSha256: expectedHash,
    expected_output_sha256: expectedHash,
    expectedOutputMatched: accepted,
    expected_output_matched: accepted,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates: [...new Set(failedGates)].map((code) => ({ code })),
    failed_gates: [...new Set(failedGates)].map((code) => ({ code })),
  };
  return {
    ...facetBase,
    outputOracleHash: `sha256:${sha256Json(facetBase)}`,
    output_oracle_hash: `sha256:${sha256Json(facetBase)}`,
  };
}

function oidnOutputOracleFile(outputOracle, role) {
  const files = Array.isArray(outputOracle?.files) ? outputOracle.files : [];
  return files.find((file) => file?.role === role) ?? null;
}

function timestampValue(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
  }
  return null;
}

function runtimeBoundaryOutputEvent(events = []) {
  return (Array.isArray(events) ? events : []).find((event) => {
    const kind = firstText(event?.kind, event?.eventKind, event?.event_kind, event?.stage, event?.stageKind, event?.stage_kind)
      ?.toLowerCase()
      .replace(/-/g, '_');
    return ['output_oracle', 'compute_oracle', 'visual_oracle', 'readback_oracle'].includes(kind);
  }) ?? null;
}

function oidnComputeOracleArtifactsFromOutputOracle(outputOracle, runtimeOutputEvent = null) {
  if (!outputOracle?.accepted) return null;
  const noisy = oidnOutputOracleFile(outputOracle, 'noisy_input');
  const denoised = oidnOutputOracleFile(outputOracle, 'denoised_output');
  const expected = oidnOutputOracleFile(outputOracle, 'expected_output');
  if (!denoised?.sha256 || !denoised?.byteLength) return null;
  return buildComputeOracleArtifactsFromByteEvidence({
    rawReadbackHash: denoised.sha256,
    rawReadbackByteLength: denoised.byteLength,
    checksumBefore: noisy?.sha256 ?? outputOracle.expectedOutputSha256,
    checksumAfter: denoised.sha256,
    deterministicSliceHash: expected?.sha256 ?? outputOracle.expectedOutputSha256 ?? denoised.sha256,
    sliceOffset: 0,
    sliceLength: denoised.byteLength,
    timestampAfterDispatch: timestampValue(
      outputOracle.timestampAfterDispatch,
      outputOracle.timestamp_after_dispatch,
      runtimeOutputEvent?.timestampMonotonicNs,
      runtimeOutputEvent?.timestamp_monotonic_ns,
      runtimeOutputEvent?.timestamp,
      runtimeOutputEvent?.timestampNs,
      runtimeOutputEvent?.timestamp_ns,
    ),
    epoch: firstText(outputOracle.epoch, outputOracle.epoch_id, runtimeOutputEvent?.epoch, runtimeOutputEvent?.epochId, runtimeOutputEvent?.epoch_id),
    rawReadbackSource: 'runtime_readback',
    producer: 'oidn_runtime_output_oracle',
    rawReadbackHashVerified: true,
    deterministicSliceHashVerified: true,
    expectedOutputVerified: outputOracle.expectedOutputMatched === true || outputOracle.expected_output_matched === true,
    expectedOutputHash: outputOracle.expectedOutputSha256 ?? outputOracle.expected_output_sha256,
    expectedOutputChange: outputOracle.outputDistinctFromInput === true || outputOracle.output_distinct_from_input === true,
    evidenceRefs: outputOracle.evidenceRefs ?? outputOracle.evidence_refs ?? [],
  });
}

async function readOidnRuntimeBoundaryManifest(manifestPath) {
  if (!manifestPath) {
    return {
      present: false,
      accepted: false,
      manifestPath: null,
      manifest_path: null,
      events: [],
      metadata: {},
      failedGates: ['oidn_runtime_boundary_event_manifest_missing'],
      failed_gates: ['oidn_runtime_boundary_event_manifest_missing'],
    };
  }
  const resolvedPath = path.resolve(manifestPath);
  try {
    const bytes = await readFile(resolvedPath);
    const manifest = JSON.parse(bytes.toString('utf8'));
    const failedGates = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      failedGates.push('oidn_runtime_boundary_event_manifest_not_object');
    }
    if (runtimeBoundaryManifestClaimsSuccess(manifest)) {
      failedGates.push('oidn_runtime_boundary_event_manifest_claims_gpu_hmr_success');
    }
    const events = [
      ...(Array.isArray(manifest.runtimeBoundaryEvents) ? manifest.runtimeBoundaryEvents : []),
      ...(Array.isArray(manifest.runtime_boundary_events) ? manifest.runtime_boundary_events : []),
      ...(Array.isArray(manifest.adapterRuntimeBoundaryEvents) ? manifest.adapterRuntimeBoundaryEvents : []),
      ...(Array.isArray(manifest.adapter_runtime_boundary_events) ? manifest.adapter_runtime_boundary_events : []),
      ...(Array.isArray(manifest.events) ? manifest.events : []),
    ];
    if (events.length === 0) failedGates.push('oidn_runtime_boundary_event_manifest_events_missing');
    return {
      present: true,
      accepted: failedGates.length === 0,
      manifestPath: resolvedPath,
      manifest_path: resolvedPath,
      manifestSha256: `sha256:${sha256Buffer(bytes)}`,
      manifest_sha256: `sha256:${sha256Buffer(bytes)}`,
      events,
      metadata: manifest,
      failedGates,
      failed_gates: failedGates,
    };
  } catch {
    return {
      present: true,
      accepted: false,
      manifestPath: resolvedPath,
      manifest_path: resolvedPath,
      events: [],
      metadata: {},
      failedGates: ['oidn_runtime_boundary_event_manifest_unreadable'],
      failed_gates: ['oidn_runtime_boundary_event_manifest_unreadable'],
    };
  }
}

async function buildOidnRuntimeBoundaryRunModeProof({ outputOracle, classification }) {
  const manifest = await readOidnRuntimeBoundaryManifest(CFG.runtimeBoundaryEventsPath);
  if (!manifest.present) return null;
  const metadata = manifest.metadata ?? {};
  const computeOracleArtifacts = oidnComputeOracleArtifactsFromOutputOracle(
    outputOracle,
    runtimeBoundaryOutputEvent(manifest.events),
  );
  const failedGates = [
    ...manifest.failedGates,
    outputOracle?.accepted === true ? null : 'oidn_output_oracle_not_accepted_for_runtime_boundary',
    classification?.oidnHipRuntimePreflightAccepted === true
      ? null
      : 'oidn_hip_runtime_preflight_not_accepted_for_runtime_boundary',
    computeOracleArtifacts ? null : 'oidn_compute_oracle_artifacts_not_derived',
  ].filter(Boolean);
  const proof = failedGates.length === 0
    ? buildRuntimeBoundaryRunModeProof({
      backend: firstText(metadata.backend, metadata.gpuBackend, metadata.gpu_backend, 'hip'),
      projectId: firstText(metadata.projectId, metadata.project_id, metadata.workspaceSlug, metadata.workspace_slug),
      editId: firstText(metadata.editId, metadata.edit_id, metadata.sourceEditId, metadata.source_edit_id),
      targetId: firstText(metadata.targetId, metadata.target_id, metadata.validationTargetId, metadata.validation_target_id),
      sourcePaths: Array.isArray(metadata.sourcePaths)
        ? metadata.sourcePaths
        : Array.isArray(metadata.source_paths)
          ? metadata.source_paths
          : [],
      entryPoint: firstText(metadata.entryPoint, metadata.entry_point, metadata.kernelName, metadata.kernel_name),
      compileTarget: firstText(metadata.compileTarget, metadata.compile_target, metadata.gpuArch, metadata.gpu_arch),
      compiler: firstText(metadata.compiler),
      compilerArgsHash: firstText(metadata.compilerArgsHash, metadata.compiler_args_hash),
      artifactHashBefore: firstText(metadata.artifactHashBefore, metadata.artifact_hash_before),
      artifactHashAfter: firstText(metadata.artifactHashAfter, metadata.artifact_hash_after),
      contractHash: firstText(metadata.contractHash, metadata.contract_hash),
      runtimeBoundaryEvents: manifest.events,
      computeOracleArtifacts,
      metricScope: firstText(metadata.metricScope, metadata.metric_scope, 'hot_delta_1'),
      cacheState: firstText(metadata.cacheState, metadata.cache_state, 'compiler_cache_warm'),
      timings: metadata.timings,
      modelProvenance: metadata.modelProvenance ?? metadata.model_provenance,
    })
    : null;
  const adapterGates = proof?.runtimeBoundaryProofAdapter?.failedGates ?? proof?.runtime_boundary_proof_adapter?.failed_gates ?? [];
  return {
    schemaVersion: 'synthi.gpu_hmr.oidn_runtime_boundary_bridge.v1',
    schema_version: 'synthi.gpu_hmr.oidn_runtime_boundary_bridge.v1',
    proofAuthority: 'oidn_output_oracle_to_generic_runtime_boundary_adapter_not_success_authority',
    proof_authority: 'oidn_output_oracle_to_generic_runtime_boundary_adapter_not_success_authority',
    accepted: proof?.accepted === true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: proof?.accepted === true,
    can_satisfy_runtime_proof: proof?.accepted === true,
    manifest,
    runtimeBoundaryRunModeProof: proof,
    runtime_boundary_run_mode_proof: proof,
    computeOracleArtifacts,
    compute_oracle_artifacts: computeOracleArtifacts,
    failedGates: [...new Set([...failedGates, ...adapterGates])],
    failed_gates: [...new Set([...failedGates, ...adapterGates])],
  };
}

function execDockerShell(command, timeoutMs = CFG.timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile(
      'docker',
      ['exec', CFG.workerContainer, 'sh', '-lc', command],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ended = process.hrtime.bigint();
        resolve({
          exitCode: typeof err?.code === 'number' ? err.code : 0,
          signal: err?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          durationMs: Number(ended - started) / 1_000_000,
          timedOut: err?.killed === true && err?.signal === 'SIGTERM',
        });
      },
    );
  });
}

function execDockerCpFromWorker(workerPath, localPath, timeoutMs = CFG.timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile(
      'docker',
      ['cp', `${CFG.workerContainer}:${workerPath}`, localPath],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ended = process.hrtime.bigint();
        resolve({
          exitCode: typeof err?.code === 'number' ? err.code : 0,
          signal: err?.signal ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          durationMs: Number(ended - started) / 1_000_000,
          timedOut: err?.killed === true && err?.signal === 'SIGTERM',
        });
      },
    );
  });
}

async function workerRealpath(workerPath) {
  if (!workerPath) return null;
  const result = await execDockerShell(
    `p=${shellQuote(workerPath)}; if [ -e "$p" ]; then readlink -f "$p"; fi`,
    30000,
  );
  const resolved = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return path.posix.isAbsolute(resolved) ? path.posix.normalize(resolved) : null;
}

async function workerAllowedRoots(manifestPath) {
  const manifestDir = path.posix.dirname(path.posix.normalize(manifestPath));
  const configured = CFG.workerOutputOracleAllowedRoots
    .split(/[;:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [
    manifestDir,
    CFG.repoPath,
    ...configured,
  ].filter(Boolean);
  const roots = [];
  for (const candidate of candidates) {
    const resolved = await workerRealpath(candidate);
    if (resolved && !roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

async function copyWorkerOutputOracleFile({ roleConfig, manifest, workerManifestDir, localDir, allowedRoots }) {
  const declaredPath = manifestText(manifest, roleConfig.pathKeys);
  const declaredSha256 = normalizeSha256(manifestText(manifest, roleConfig.shaKeys));
  if (!declaredPath) {
    return {
      role: roleConfig.role,
      accepted: false,
      workerPath: null,
      worker_path: null,
      workerResolvedPath: null,
      worker_resolved_path: null,
      localPath: null,
      local_path: null,
      relativePath: null,
      relative_path: null,
      byteLength: 0,
      byte_length: 0,
      sha256: null,
      declaredSha256,
      declared_sha256: declaredSha256,
      failedGates: [`${roleConfig.role}:oidn_worker_output_oracle_path_missing`],
      failed_gates: [`${roleConfig.role}:oidn_worker_output_oracle_path_missing`],
    };
  }
  const workerPath = workerManifestFilePath(workerManifestDir, declaredPath);
  const workerResolvedPath = await workerRealpath(workerPath);
  const failedGates = [];
  if (!workerResolvedPath) {
    failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_file_unreadable`);
  } else if (!allowedRoots.some((root) => isPosixPathInside(workerResolvedPath, root))) {
    failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_path_outside_allowed_roots`);
  }
  let localPath = null;
  let relativePath = null;
  let byteLength = 0;
  let sha256 = null;
  let copyResult = null;
  if (failedGates.length === 0) {
    relativePath = safeLocalArtifactName(roleConfig.role, workerResolvedPath);
    localPath = path.join(localDir, relativePath);
    copyResult = await execDockerCpFromWorker(workerResolvedPath, localPath);
    if (copyResult.exitCode !== 0) {
      failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_copy_failed`);
    } else {
      try {
        const bytes = await readFile(localPath);
        byteLength = bytes.length;
        sha256 = `sha256:${sha256Buffer(bytes)}`;
        if (bytes.length <= 0) failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_file_empty`);
        if (declaredSha256 && declaredSha256 !== sha256) {
          failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_declared_hash_mismatch`);
        }
      } catch {
        failedGates.push(`${roleConfig.role}:oidn_worker_output_oracle_local_file_unreadable`);
      }
    }
  }
  const accepted = failedGates.length === 0;
  return {
    role: roleConfig.role,
    accepted,
    workerPath,
    worker_path: workerPath,
    workerResolvedPath,
    worker_resolved_path: workerResolvedPath,
    localPath,
    local_path: localPath,
    relativePath,
    relative_path: relativePath,
    byteLength,
    byte_length: byteLength,
    sha256,
    declaredSha256,
    declared_sha256: declaredSha256,
    copyResult: copyResult ? summarizeCommand(copyResult) : null,
    copy_result: copyResult ? summarizeCommand(copyResult) : null,
    failedGates,
    failed_gates: failedGates,
  };
}

function copiedOutputOracleManifest(manifest, copiedFiles) {
  const byRole = new Map(copiedFiles.filter((file) => file.accepted).map((file) => [file.role, file]));
  const output = {
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
  };
  for (const roleConfig of OIDN_OUTPUT_ORACLE_ROLES) {
    const copied = byRole.get(roleConfig.role);
    if (copied?.relativePath && copied?.sha256) {
      output[roleConfig.outputPathKey] = copied.relativePath;
      output[roleConfig.outputShaKey] = copied.sha256;
    }
  }
  const expected = byRole.get('expected_output');
  const declaredExpected = normalizeSha256(manifestText(manifest, ['expectedOutputSha256', 'expected_output_sha256']));
  if (!output.expectedOutputSha256 && (expected?.sha256 || declaredExpected)) {
    output.expectedOutputSha256 = expected?.sha256 ?? declaredExpected;
  }
  for (const key of ['epoch', 'epochId', 'epoch_id', 'timestampAfterDispatch', 'timestamp_after_dispatch']) {
    const value = manifest?.[key];
    if (value !== undefined && value !== null && value !== '') output[key] = value;
  }
  return output;
}

function workerOutputOracleManifestStaticGates(manifest) {
  const failedGates = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['oidn_worker_output_oracle_manifest_not_object'];
  }
  if (authorityClaimsSuccess(manifest)) {
    failedGates.push('oidn_worker_output_oracle_manifest_claims_gpu_hmr_success');
  }
  const schema = firstText(manifest.schemaVersion, manifest.schema_version, manifest.schema);
  if (schema && schema !== OIDN_OUTPUT_ORACLE_SCHEMA) {
    failedGates.push('oidn_worker_output_oracle_schema_mismatch');
  }
  const authority = firstText(manifest.proofAuthority, manifest.proof_authority);
  if (authority && authority !== OIDN_OUTPUT_ORACLE_AUTHORITY) {
    failedGates.push('oidn_worker_output_oracle_authority_mismatch');
  }
  return failedGates;
}

async function stageWorkerOutputOracleManifest(workerManifestPath) {
  if (!workerManifestPath) return null;
  const workerManifestCandidate = workerManifestFilePath(CFG.repoPath || '/', workerManifestPath);
  const workerManifestResolved = await workerRealpath(workerManifestCandidate);
  const failedGates = [];
  if (!workerManifestResolved) {
    return {
      schemaVersion: 'synthi.gpu_hmr.oidn_worker_output_oracle_transport.v1',
      proofAuthority: 'worker_output_oracle_transport_only_not_gpu_hmr_success',
      accepted: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      workerManifestPath: workerManifestCandidate,
      worker_manifest_path: workerManifestCandidate,
      failedGates: ['oidn_worker_output_oracle_manifest_unreadable'],
      failed_gates: ['oidn_worker_output_oracle_manifest_unreadable'],
    };
  }
  const cat = await execDockerShell(`cat ${shellQuote(workerManifestResolved)}`, 30000);
  if (cat.exitCode !== 0) {
    failedGates.push('oidn_worker_output_oracle_manifest_unreadable');
  }
  let manifest = {};
  const manifestBytes = Buffer.from(cat.stdout ?? '', 'utf8');
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    failedGates.push('oidn_worker_output_oracle_manifest_not_json');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failedGates.push('oidn_worker_output_oracle_manifest_not_object');
    manifest = {};
  }
  failedGates.push(...workerOutputOracleManifestStaticGates(manifest));
  const allowedRoots = await workerAllowedRoots(workerManifestResolved);
  const localDir = path.join(CFG.outputDir, `${cleanToken(CFG.slug)}-worker-output-oracle`);
  await mkdir(localDir, { recursive: true });
  const workerManifestDir = path.posix.dirname(workerManifestResolved);
  const copiedFiles = [];
  for (const roleConfig of OIDN_OUTPUT_ORACLE_ROLES) {
    const declaredPath = manifestText(manifest, roleConfig.pathKeys);
    const declaredHash = normalizeSha256(manifestText(manifest, roleConfig.shaKeys));
    if (!declaredPath && roleConfig.role === 'expected_output' && declaredHash) continue;
    const copied = await copyWorkerOutputOracleFile({
      roleConfig,
      manifest,
      workerManifestDir,
      localDir,
      allowedRoots,
    });
    copiedFiles.push(copied);
    failedGates.push(...copied.failedGates);
  }
  const expectedCopied = copiedFiles.find((file) => file.role === 'expected_output' && file.accepted);
  const expectedDeclared = normalizeSha256(manifestText(manifest, ['expectedOutputSha256', 'expected_output_sha256']));
  if (!expectedCopied && !expectedDeclared) {
    failedGates.push('expected_output:oidn_worker_output_oracle_expected_missing');
  }
  const uniqueFailedGates = [...new Set(failedGates)];
  let localManifestPath = null;
  let localManifestSha256 = null;
  if (uniqueFailedGates.length === 0) {
    localManifestPath = path.join(localDir, 'oracle.json');
    const localManifest = copiedOutputOracleManifest(manifest, copiedFiles);
    const localManifestBytes = Buffer.from(`${JSON.stringify(localManifest, null, 2)}\n`, 'utf8');
    await writeFile(localManifestPath, localManifestBytes);
    localManifestSha256 = `sha256:${sha256Buffer(localManifestBytes)}`;
  }
  const evidenceRefs = uniqueFailedGates.length === 0
    ? [
      `oidn-worker-output-oracle-manifest:sha256:${sha256Buffer(manifestBytes)}`,
      `oidn-worker-output-oracle-local-manifest:${localManifestSha256}`,
      ...copiedFiles.filter((file) => file.accepted).map((file) => `oidn-worker-output-oracle-${file.role}:${file.sha256}`),
    ]
    : [];
  return {
    schemaVersion: 'synthi.gpu_hmr.oidn_worker_output_oracle_transport.v1',
    schema_version: 'synthi.gpu_hmr.oidn_worker_output_oracle_transport.v1',
    proofAuthority: 'worker_output_oracle_transport_only_not_gpu_hmr_success',
    proof_authority: 'worker_output_oracle_transport_only_not_gpu_hmr_success',
    accepted: uniqueFailedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    workerManifestPath: workerManifestResolved,
    worker_manifest_path: workerManifestResolved,
    workerManifestSha256: `sha256:${sha256Buffer(manifestBytes)}`,
    worker_manifest_sha256: `sha256:${sha256Buffer(manifestBytes)}`,
    localManifestPath,
    local_manifest_path: localManifestPath,
    localManifestSha256,
    local_manifest_sha256: localManifestSha256,
    allowedRoots,
    allowed_roots: allowedRoots,
    copiedFiles,
    copied_files: copiedFiles,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates: uniqueFailedGates,
    failed_gates: uniqueFailedGates,
  };
}

async function findTool() {
  const repo = shellQuote(CFG.repoPath);
  const configuredTool = shellQuote(CFG.oidnTestPath);
  const probe = [
    `cd ${repo}`,
    CFG.oidnTestPath
      ? `p=${configuredTool}; if [ -x "$p" ]; then printf "%s\\n" "$p"; exit 0; fi`
      : '',
    'if command -v oidnTest >/dev/null 2>&1; then command -v oidnTest; exit 0; fi',
    'if [ -x build/_deps/oidnbinaries-src/bin/oidnTest ]; then printf "%s\\n" build/_deps/oidnbinaries-src/bin/oidnTest; exit 0; fi',
    'find . -path "*/bin/oidnTest" -type f -perm -111 2>/dev/null | sort | head -n 1',
  ].filter(Boolean).join(' && ');
  const result = await execDockerShell(probe, 30000);
  const tool = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return { tool, probe: summarizeCommand(result) };
}

async function findHipDeviceLibrary() {
  const repo = shellQuote(CFG.repoPath);
  const configuredLibrary = shellQuote(CFG.hipDeviceLibraryPath);
  const probe = [
    `cd ${repo}`,
    CFG.hipDeviceLibraryPath
      ? `p=${configuredLibrary}; if [ -f "$p" ]; then printf "%s\\n" "$p"; exit 0; fi`
      : '',
    'if command -v ldconfig >/dev/null 2>&1; then ldconfig -p 2>/dev/null | awk \'/libOpenImageDenoise_device_hip\\.so/{print $NF; exit}\' | head -n 1; fi',
    'find . -name "libOpenImageDenoise_device_hip.so*" -type f 2>/dev/null | sort | head -n 1',
  ].filter(Boolean).join(' && ');
  const result = await execDockerShell(probe, 30000);
  const library = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  return { library, probe: summarizeCommand(result) };
}

function decodeBase64Field(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return Buffer.from(text, 'base64').toString('utf8');
}

async function inspectWorkerPath(workerPath, kind) {
  if (!workerPath) {
    return {
      kind,
      path: null,
      found: false,
      resolvedPath: null,
      isSymlink: false,
      fileType: null,
      sha256: null,
      wrapperOrShimDetected: false,
      probe: null,
    };
  }
  const repo = shellQuote(CFG.repoPath);
  const cmd = [
    `cd ${repo}`,
    `p=${shellQuote(workerPath)}`,
    'if [ ! -e "$p" ]; then printf "SYNTHI_OIDN_PATH_INSPECTION found=0 kind=%s path_b64=%s\\n" '
      + `${shellQuote(kind)} "$(printf '%s' "$p" | base64 | tr -d '\\n')"; exit 0; fi`,
    'resolved="$(readlink -f "$p" 2>/dev/null || printf "%s" "$p")"',
    'file_type="$(file -b "$p" 2>/dev/null || printf unknown)"',
    'sha="$(sha256sum "$p" 2>/dev/null | awk \'{print $1}\')"',
    'is_symlink=0; if [ -L "$p" ]; then is_symlink=1; fi',
    'printf "SYNTHI_OIDN_PATH_INSPECTION found=1 kind=%s path_b64=%s resolved_b64=%s is_symlink=%s file_b64=%s sha256=%s\\n" '
      + `${shellQuote(kind)} "$(printf '%s' "$p" | base64 | tr -d '\\n')" "$(printf '%s' "$resolved" | base64 | tr -d '\\n')" "$is_symlink" "$(printf '%s' "$file_type" | base64 | tr -d '\\n')" "$sha"`,
  ].join(' && ');
  const result = await execDockerShell(cmd, 30000);
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
    .find((entry) => entry.includes('SYNTHI_OIDN_PATH_INSPECTION')) ?? '';
  const found = /\bfound=1\b/.test(line);
  const isSymlink = /\bis_symlink=1\b/.test(line);
  const fileType = decodeBase64Field(/\bfile_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]);
  const pathValue = decodeBase64Field(/\bpath_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]) || workerPath;
  const resolvedPath = decodeBase64Field(/\bresolved_b64=([A-Za-z0-9+/=]+)/.exec(line)?.[1]) || null;
  const sha = /\bsha256=([0-9a-fA-F]{64})\b/.exec(line)?.[1] ?? null;
  const expectedElf = kind === 'oidn_tool' || kind === 'oidn_hip_device_library';
  const wrapperOrShimDetected = found && expectedElf && !/\bELF\b/i.test(fileType);
  return {
    kind,
    path: pathValue,
    found,
    resolvedPath,
    resolved_path: resolvedPath,
    isSymlink,
    is_symlink: isSymlink,
    fileType,
    file_type: fileType,
    sha256: sha ? `sha256:${sha}` : null,
    wrapperOrShimDetected,
    wrapper_or_shim_detected: wrapperOrShimDetected,
    probe: summarizeCommand(result),
  };
}

async function buildPathIntegrity({ tool, library }) {
  const inspections = [
    await inspectWorkerPath(tool, 'oidn_tool'),
    await inspectWorkerPath(library, 'oidn_hip_device_library'),
  ];
  const inspectedExisting = inspections.filter((entry) => entry.found);
  const symlinkedPaths = inspectedExisting.filter((entry) => entry.isSymlink).map((entry) => entry.path);
  const wrapperPaths = inspectedExisting
    .filter((entry) => entry.wrapperOrShimDetected)
    .map((entry) => ({ path: entry.path, fileType: entry.fileType }));
  const noShimApplied = wrapperPaths.length === 0;
  const noSymlinkApplied = symlinkedPaths.length === 0;
  return {
    schemaVersion: 'synthi.gpu_hmr.oidn_path_integrity.v1',
    inspections,
    noShimApplied,
    no_shim_applied: noShimApplied,
    noSymlinkApplied,
    no_symlink_applied: noSymlinkApplied,
    noSynthesizedRuntime: noShimApplied && noSymlinkApplied,
    no_synthesized_runtime: noShimApplied && noSymlinkApplied,
    symlinkedPaths,
    symlinked_paths: symlinkedPaths,
    wrapperOrShimPaths: wrapperPaths,
    wrapper_or_shim_paths: wrapperPaths,
    failedGates: [
      ...(noShimApplied ? [] : ['oidn_wrapper_or_shim_detected']),
      ...(noSymlinkApplied ? [] : ['oidn_symlinked_runtime_artifact_detected']),
    ],
    failed_gates: [
      ...(noShimApplied ? [] : ['oidn_wrapper_or_shim_detected']),
      ...(noSymlinkApplied ? [] : ['oidn_symlinked_runtime_artifact_detected']),
    ],
  };
}

function summarizeCommand(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Number(result.durationMs.toFixed(3)),
    timedOut: result.timedOut,
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-4000),
  };
}

async function runOidnTest(tool, name, device) {
  const repo = shellQuote(CFG.repoPath);
  const cmd = [
    `cd ${repo}`,
    `${shellQuote(tool)} ${shellQuote(name)} --device ${shellQuote(device)} --success --durations yes --rng-seed ${shellQuote(CFG.seed)}`,
  ].join(' && ');
  const result = await execDockerShell(cmd, CFG.timeoutMs);
  return {
    name,
    device,
    command: `oidnTest ${JSON.stringify(name)} --device ${device} --success --durations yes --rng-seed ${CFG.seed}`,
    passed: result.exitCode === 0,
    ...summarizeCommand(result),
  };
}

async function runLdd(library) {
  if (!library) {
    return {
      library: null,
      found: false,
      missingLibraries: [],
      command: null,
      result: null,
    };
  }
  const repo = shellQuote(CFG.repoPath);
  const cmd = `cd ${repo} && ldd ${shellQuote(library)}`;
  const result = await execDockerShell(cmd, 30000);
  const text = `${result.stdout}\n${result.stderr}`;
  return {
    library,
    found: true,
    missingLibraries: missingLibrariesFromLdd(text),
    command: `ldd ${library}`,
    result: summarizeCommand(result),
  };
}

function missingLibrariesFromLdd(text) {
  const missing = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s=>]+)\s*=>\s*not found\b/);
    if (match) missing.add(match[1]);
  }
  return [...missing].sort();
}

function classifyPreflight({ oidnTool, tests, ldd, pathIntegrity = null, outputOracle = null }) {
  const hipTests = tests.filter((test) => test.device === 'hip');
  const cpuTests = tests.filter((test) => test.device === 'cpu');
  const hipTestsPassed = hipTests.length > 0 && hipTests.every((test) => test.passed);
  const pathIntegrityAccepted =
    pathIntegrity === null
    || (
      pathIntegrity.noShimApplied === true
      && pathIntegrity.noSymlinkApplied === true
      && pathIntegrity.noSynthesizedRuntime === true
    );
  const oidnHipRuntimePreflightAccepted = hipTestsPassed && pathIntegrityAccepted;
  const cpuPassed = cpuTests.length > 0 && cpuTests.every((test) => test.passed);
  const missingLibs = ldd?.missingLibraries ?? [];
  const unsupportedReasons = [];
  if (!oidnTool) unsupportedReasons.push('oidnTest_not_found');
  for (const test of hipTests.filter((entry) => !entry.passed)) {
    unsupportedReasons.push(`oidn_hip_${test.name.replace(/[^a-zA-Z0-9]+/g, '_')}_failed`);
  }
  for (const lib of missingLibs) {
    unsupportedReasons.push(`missing_dependency:${lib}`);
  }
  for (const gate of pathIntegrity?.failedGates ?? pathIntegrity?.failed_gates ?? []) {
    unsupportedReasons.push(gate);
  }
  const outputOracleAccepted = outputOracle?.accepted === true;
  const outputProofGaps = outputOracleAccepted
    ? []
    : ['oidn_output_oracle_not_proven'];
  const openGaps = oidnHipRuntimePreflightAccepted
    ? (outputOracleAccepted ? ['oidn_full_runtime_hmr_ledger_not_proven'] : outputProofGaps)
    : [...new Set(unsupportedReasons)].sort();
  return {
    oidnHipRuntimePreflightAccepted,
    oidnHipOutputProofAccepted: oidnHipRuntimePreflightAccepted && outputOracleAccepted,
    oidnHipOutputOracleProven: oidnHipRuntimePreflightAccepted && outputOracleAccepted,
    oidnHipTestsPassed: hipTestsPassed,
    oidnCpuDiagnosticsPassed: cpuPassed,
    resultState: oidnHipRuntimePreflightAccepted
      ? (
        outputOracleAccepted
          ? 'oidn-hip-output-oracle-accepted-preflight-only'
          : 'oidn-hip-runtime-preflight-accepted'
      )
      : 'oidn-hip-rejected',
    unsupportedReasons: [...new Set(unsupportedReasons)].sort(),
    outputProofGaps,
    output_proof_gaps: outputProofGaps,
    openGaps,
    open_gaps: openGaps,
    missingLibraries: missingLibs,
    outputOracleAccepted,
    output_oracle_accepted: outputOracleAccepted,
  };
}

function preflightBackendEvidence({ toolProbe, libraryProbe, tests, ldd, pathIntegrity }) {
  const evidenceRefs = [
    'probe:oidn_tool',
    'probe:oidn_hip_device_library',
    'probe:oidn_hip_tests',
    'probe:oidn_cpu_diagnostics',
    'probe:oidn_hip_ldd',
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs,
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs,
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      workerContainer: CFG.workerContainer,
      repoPath: CFG.repoPath,
      configuredOidnTestPath: CFG.oidnTestPath || null,
      configured_oidn_test_path: CFG.oidnTestPath || null,
      configuredHipDeviceLibraryPath: CFG.hipDeviceLibraryPath || null,
      configured_hip_device_library_path: CFG.hipDeviceLibraryPath || null,
      configuredOutputOracleManifestPath: CFG.outputOracleManifestPath || null,
      configured_output_oracle_manifest_path: CFG.outputOracleManifestPath || null,
      configuredWorkerOutputOracleManifestPath: CFG.workerOutputOracleManifestPath || null,
      configured_worker_output_oracle_manifest_path: CFG.workerOutputOracleManifestPath || null,
      toolFound: Boolean(toolProbe.tool),
      hipDeviceLibraryFound: Boolean(libraryProbe.library),
      hipTestCount: tests.filter((test) => test.device === 'hip').length,
      cpuDiagnosticCount: tests.filter((test) => test.device === 'cpu').length,
      missingLibraries: ldd?.missingLibraries ?? [],
      noShimApplied: pathIntegrity.noShimApplied,
      noSymlinkApplied: pathIntegrity.noSymlinkApplied,
      noSynthesizedRuntime: pathIntegrity.noSynthesizedRuntime,
      pathIntegrity,
      evidenceRefs,
    },
    evidenceRefs,
  };
}

function oidnPreflightTimingMetrics({ durationNs, classification }) {
  const editHash = sha256Stable({
    workerContainer: CFG.workerContainer,
    repoPath: CFG.repoPath,
    configuredOidnTestPath: CFG.oidnTestPath || null,
    configured_oidn_test_path: CFG.oidnTestPath || null,
    configuredHipDeviceLibraryPath: CFG.hipDeviceLibraryPath || null,
    configured_hip_device_library_path: CFG.hipDeviceLibraryPath || null,
    seed: CFG.seed,
    outputOracleManifestPath: CFG.outputOracleManifestPath || null,
    workerOutputOracleManifestPath: CFG.workerOutputOracleManifestPath || null,
  });
  return {
    schemaVersion: 'synthi.gpu.hmr.runner_timing_metrics.v1',
    schema_version: 'synthi.gpu.hmr.runner_timing_metrics.v1',
    proofAuthority: 'oidn_preflight_timing_telemetry_only_not_gpu_hmr_success',
    proof_authority: 'oidn_preflight_timing_telemetry_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    metricClock: 'monotonic_ns',
    metric_clock: 'monotonic_ns',
    metricScope: 'cold',
    metric_scope: 'cold',
    cacheState: 'clean',
    cache_state: 'clean',
    editId: `${cleanToken(CFG.slug)}:oidn-runtime-preflight`,
    edit_id: `${cleanToken(CFG.slug)}:oidn-runtime-preflight`,
    editHash,
    edit_hash: editHash,
    editKind: 'runtime_preflight',
    edit_kind: 'runtime_preflight',
    differentEdit: false,
    different_edit: false,
    resultState: classification?.resultState ?? null,
    result_state: classification?.resultState ?? null,
    timings: {
      runtime_probe_time: durationNs,
      total_validator_wall_time: durationNs,
    },
  };
}

async function buildProof() {
  if (!CFG.workerContainer) failConfig('OIDN preflight requires a worker container');
  if (!CFG.repoPath) failConfig('OIDN preflight requires the HIPRT/OIDN repo path inside the worker');

  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const toolProbe = await findTool();
  const libraryProbe = await findHipDeviceLibrary();
  const pathIntegrity = await buildPathIntegrity({
    tool: toolProbe.tool,
    library: libraryProbe.library,
  });
  const tests = [];
  if (toolProbe.tool) {
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'hip'));
    tests.push(await runOidnTest(toolProbe.tool, 'device creation', 'cpu'));
    tests.push(await runOidnTest(toolProbe.tool, 'buffer read/write', 'cpu'));
  }
  const ldd = await runLdd(libraryProbe.library);
  const workerOutputOracleTransport = await stageWorkerOutputOracleManifest(CFG.workerOutputOracleManifestPath);
  const outputOracleManifestPath = CFG.outputOracleManifestPath
    || (workerOutputOracleTransport?.accepted === true ? workerOutputOracleTransport.localManifestPath : '');
  const outputOracle = await buildOidnOutputOracleEvidence(outputOracleManifestPath);
  const classification = classifyPreflight({
    oidnTool: toolProbe.tool,
    tests,
    ldd,
    pathIntegrity,
    outputOracle,
  });
  const runtimeBoundaryBridge = await buildOidnRuntimeBoundaryRunModeProof({
    outputOracle,
    classification,
  });
  const ended = process.hrtime.bigint();
  const durationNs = Number(ended - started);
  const timingMetrics = oidnPreflightTimingMetrics({ durationNs, classification });
  const proofBase = {
    schema: 'synthi.gpu_hmr.oidn_preflight.v1',
    slug: CFG.slug,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Number((durationNs / 1_000_000).toFixed(3)),
    timingMetrics,
    timing_metrics: timingMetrics,
    workerContainer: CFG.workerContainer,
    repoPath: CFG.repoPath,
    seed: CFG.seed,
    oidnTool: toolProbe.tool || null,
    oidnToolProbe: toolProbe.probe,
    hipDeviceLibrary: libraryProbe.library || null,
    hipDeviceLibraryProbe: libraryProbe.probe,
    pathIntegrity,
    path_integrity: pathIntegrity,
    ldd,
    tests,
    backendEvidence: preflightBackendEvidence({
      toolProbe,
      libraryProbe,
      tests,
      ldd,
      pathIntegrity,
    }),
    outputOracle,
    output_oracle: outputOracle,
    workerOutputOracleTransport,
    worker_output_oracle_transport: workerOutputOracleTransport,
    runtimeBoundaryBridge,
    runtime_boundary_bridge: runtimeBoundaryBridge,
    runtimeBoundaryRunModeProof: runtimeBoundaryBridge?.runtimeBoundaryRunModeProof ?? null,
    runtime_boundary_run_mode_proof: runtimeBoundaryBridge?.runtimeBoundaryRunModeProof ?? null,
    classification,
    acceptance: {
      acceptedForOidnHipRuntimePreflight: classification.oidnHipRuntimePreflightAccepted,
      acceptedForHipOutputProof: classification.oidnHipOutputProofAccepted,
      acceptedForOidnHipOutputProof: classification.oidnHipOutputProofAccepted,
      outputOracleProven: classification.oidnHipOutputOracleProven,
      output_oracle_proven: classification.oidnHipOutputOracleProven,
      runtimeBoundaryProofAccepted: runtimeBoundaryBridge?.accepted === true,
      runtime_boundary_proof_accepted: runtimeBoundaryBridge?.accepted === true,
      gpuHmrSuccess: false,
      reason: classification.oidnHipOutputProofAccepted
        ? 'preflight_output_oracle_only_full_runtime_hmr_ledger_still_required'
        : (
          classification.oidnHipRuntimePreflightAccepted
            ? 'preflight_only_oidn_output_oracle_still_required'
            : 'oidn_hip_runtime_preflight_rejected'
        ),
      openGaps: classification.openGaps,
      open_gaps: classification.openGaps,
      cpuDiagnosticOnly:
        classification.oidnCpuDiagnosticsPassed
        && !classification.oidnHipRuntimePreflightAccepted,
      noShimApplied: pathIntegrity.noShimApplied,
      noSymlinkApplied: pathIntegrity.noSymlinkApplied,
      noSynthesizedRuntime: pathIntegrity.noSynthesizedRuntime,
    },
  };
  const proofId = `oidn-preflight-proof:sha256:${sha256Json(proofBase)}`;
  return { ...proofBase, proofId };
}

async function writeProof(proof) {
  await mkdir(CFG.outputDir, { recursive: true });
  const base = cleanToken(CFG.slug);
  const jsonPath = path.join(CFG.outputDir, `${base}-proof.json`);
  const txtPath = path.join(CFG.outputDir, `${base}-summary.txt`);
  const summary = [
    `proof_id=${proof.proofId}`,
    `result_state=${proof.classification.resultState}`,
    `oidn_tool=${proof.oidnTool ?? 'missing'}`,
    `hip_device_library=${proof.hipDeviceLibrary ?? 'missing'}`,
    `oidn_hip_runtime_preflight_accepted=${proof.classification.oidnHipRuntimePreflightAccepted}`,
    `oidn_hip_output_proof_accepted=${proof.classification.oidnHipOutputProofAccepted}`,
    `oidn_output_oracle_manifest=${proof.outputOracle?.manifestPath ?? 'none'}`,
    `oidn_output_oracle_accepted=${proof.outputOracle?.accepted ?? false}`,
    `oidn_worker_output_oracle_transport=${proof.workerOutputOracleTransport?.accepted ?? false}`,
    `oidn_worker_output_oracle_manifest=${proof.workerOutputOracleTransport?.workerManifestPath ?? 'none'}`,
    `oidn_runtime_boundary_manifest=${proof.runtimeBoundaryBridge?.manifest?.manifestPath ?? 'none'}`,
    `oidn_runtime_boundary_accepted=${proof.runtimeBoundaryBridge?.accepted ?? false}`,
    `oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`,
    `open_gaps=${proof.classification.openGaps.join(',') || 'none'}`,
    `missing_libraries=${proof.classification.missingLibraries.join(',') || 'none'}`,
    `unsupported_reasons=${proof.classification.unsupportedReasons.join(',') || 'none'}`,
    `no_shim_applied=${proof.acceptance.noShimApplied}`,
    `no_symlink_applied=${proof.acceptance.noSymlinkApplied}`,
    `no_synthesized_runtime=${proof.acceptance.noSynthesizedRuntime}`,
  ].join('\n') + '\n';
  await writeFile(jsonPath, JSON.stringify(proof, null, 2));
  await writeFile(txtPath, summary);
  return { jsonPath, txtPath };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfCheck() {
  const missing = missingLibrariesFromLdd(`
    linux-vdso.so.1 (0x00007fff)
    libamdhip64.so.5 => not found
    libOpenImageDenoise.so.2 => /x/libOpenImageDenoise.so.2
    libfoo.so => not found
  `);
  assert(JSON.stringify(missing) === JSON.stringify(['libamdhip64.so.5', 'libfoo.so']), 'ldd missing library parser failed');
  const rejected = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: false },
      { name: 'buffer read/write', device: 'hip', passed: false },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: ['libamdhip64.so.5'] },
  });
  assert(rejected.resultState === 'oidn-hip-rejected', 'rejected state not classified');
  assert(rejected.oidnCpuDiagnosticsPassed === true, 'cpu diagnostic classification failed');
  assert(rejected.unsupportedReasons.includes('missing_dependency:libamdhip64.so.5'), 'missing dependency reason absent');
  const accepted = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
  });
  assert(accepted.resultState === 'oidn-hip-runtime-preflight-accepted', 'runtime preflight state not classified');
  assert(accepted.oidnHipRuntimePreflightAccepted === true, 'HIP runtime preflight should be accepted');
  assert(accepted.oidnHipOutputProofAccepted === false, 'OIDN HIP runtime preflight must not imply output proof');
  const outputAccepted = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
    outputOracle: { accepted: true },
  });
  assert(
    outputAccepted.resultState === 'oidn-hip-output-oracle-accepted-preflight-only',
    'accepted output oracle state not classified',
  );
  assert(outputAccepted.oidnHipOutputProofAccepted === true, 'accepted output oracle should satisfy OIDN output proof');
  assert(
    outputAccepted.openGaps.includes('oidn_full_runtime_hmr_ledger_not_proven'),
    'accepted OIDN output proof must still require full runtime ledger',
  );
  const timingMetrics = oidnPreflightTimingMetrics({
    durationNs: 123456789,
    classification: outputAccepted,
  });
  assert(timingMetrics.metricClock === 'monotonic_ns', 'OIDN timing metric clock must be monotonic_ns');
  assert(timingMetrics.metricScope === 'cold', 'OIDN preflight timing must use the accepted cold scope');
  assert(timingMetrics.editKind === 'runtime_preflight', 'OIDN timing edit kind must identify runtime preflight');
  assert(timingMetrics.timings.runtime_probe_time === 123456789, 'OIDN runtime probe timing missing');
  assert(timingMetrics.acceptedForGpuHmr === false, 'OIDN timing cannot claim GPU HMR acceptance');
  assert(timingMetrics.gpuHmrSuccess === false, 'OIDN timing cannot claim GPU HMR success');
  assert(timingMetrics.canSatisfyRuntimeProof === false, 'OIDN timing cannot satisfy runtime proof');
  const shimRejected = classifyPreflight({
    oidnTool: './bin/oidnTest',
    tests: [
      { name: 'device creation', device: 'hip', passed: true },
      { name: 'buffer read/write', device: 'hip', passed: true },
      { name: 'device creation', device: 'cpu', passed: true },
      { name: 'buffer read/write', device: 'cpu', passed: true },
    ],
    ldd: { missingLibraries: [] },
    pathIntegrity: {
      noShimApplied: false,
      noSymlinkApplied: true,
      noSynthesizedRuntime: false,
      failedGates: ['oidn_wrapper_or_shim_detected'],
    },
  });
  assert(shimRejected.resultState === 'oidn-hip-rejected', 'shimmed OIDN path must reject HIP acceptance');
  assert(
    shimRejected.unsupportedReasons.includes('oidn_wrapper_or_shim_detected'),
    'shim rejection reason absent',
  );
  return runOutputOracleSelfCheck().then(() => {
    console.log('[ok] OIDN preflight self-check passed');
  });
}

async function runOutputOracleSelfCheck() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synthi-oidn-oracle-'));
  const noisyPath = path.join(dir, 'noisy.bin');
  const denoisedPath = path.join(dir, 'denoised.bin');
  const expectedPath = path.join(dir, 'expected.bin');
  await writeFile(noisyPath, Buffer.from([0, 1, 2, 3, 4, 5]));
  await writeFile(denoisedPath, Buffer.from([0, 2, 4, 6, 8, 10]));
  await writeFile(expectedPath, Buffer.from([0, 2, 4, 6, 8, 10]));
  const denoisedHash = normalizeSha256(sha256Buffer(await readFile(denoisedPath)));
  const manifestPath = path.join(dir, 'oracle.json');
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
    noisyInputPath: noisyPath,
    denoisedOutputPath: denoisedPath,
    expectedOutputPath: expectedPath,
    expectedOutputSha256: denoisedHash,
  }, null, 2));
  const accepted = await buildOidnOutputOracleEvidence(manifestPath);
  assert(accepted.accepted === true, `OIDN output oracle should accept: ${JSON.stringify(accepted.failedGates)}`);
  assert(accepted.acceptedForGpuHmr === false, 'OIDN output oracle cannot claim GPU HMR acceptance');
  assert(accepted.gpuHmrSuccess === false, 'OIDN output oracle cannot claim GPU HMR success');

  const forgedPath = path.join(dir, 'forged.json');
  await writeFile(forgedPath, JSON.stringify({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
    noisyInputPath: noisyPath,
    denoisedOutputPath: denoisedPath,
    expectedOutputSha256: `sha256:${'0'.repeat(64)}`,
    gpuHmrSuccess: true,
  }, null, 2));
  const forged = await buildOidnOutputOracleEvidence(forgedPath);
  const forgedGates = forged.failedGates.map((gate) => gate.code);
  assert(forged.accepted === false, 'forged OIDN output oracle should reject');
  assert(
    forgedGates.includes('oidn_output_oracle_claims_gpu_hmr_success'),
    `forged success gate missing: ${forgedGates.join(',')}`,
  );
  assert(
    forgedGates.includes('oidn_expected_output_hash_mismatch'),
    `forged expected hash gate missing: ${forgedGates.join(',')}`,
  );

  const noisyHash = normalizeSha256(sha256Buffer(await readFile(noisyPath)));
  const copiedManifest = copiedOutputOracleManifest(
    {
      schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
      proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
      backend: 'oidn_hip',
      device: 'hip',
      gpuHmrSuccess: true,
      epoch: 'epoch-transport-self-check',
    },
    [
      {
        role: 'noisy_input',
        accepted: true,
        relativePath: 'noisy.bin',
        sha256: noisyHash,
      },
      {
        role: 'denoised_output',
        accepted: true,
        relativePath: 'denoised.bin',
        sha256: denoisedHash,
      },
      {
        role: 'expected_output',
        accepted: true,
        relativePath: 'expected.bin',
        sha256: denoisedHash,
      },
    ],
  );
  assert(copiedManifest.gpuHmrSuccess === undefined, 'copied worker manifest must not preserve GPU HMR success claims');
  assert(copiedManifest.backend === 'oidn_hip', 'copied worker manifest should preserve generic OIDN backend');
  assert(copiedManifest.expectedOutputSha256 === denoisedHash, 'copied worker manifest expected hash missing');
  const staticGates = workerOutputOracleManifestStaticGates({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    gpuHmrSuccess: true,
  });
  assert(
    staticGates.includes('oidn_worker_output_oracle_manifest_claims_gpu_hmr_success'),
    `worker success-claim gate missing: ${staticGates.join(',')}`,
  );
  assert(isPosixPathInside('/tmp/oidn/oracle/noisy.bin', '/tmp/oidn'), 'worker POSIX root check should accept child paths');
  assert(!isPosixPathInside('/tmp/oidn-other/noisy.bin', '/tmp/oidn'), 'worker POSIX root check should reject prefix escapes');
}

function syntheticHash(label) {
  return `sha256:${sha256Buffer(Buffer.from(label))}`;
}

async function runRuntimeBoundaryBridgeSelfCheck() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synthi-oidn-runtime-boundary-'));
  const noisyPath = path.join(dir, 'noisy.bin');
  const denoisedPath = path.join(dir, 'denoised.bin');
  const expectedPath = path.join(dir, 'expected.bin');
  await writeFile(noisyPath, Buffer.from([1, 2, 3, 4, 5, 6]));
  await writeFile(denoisedPath, Buffer.from([2, 4, 6, 8, 10, 12]));
  await writeFile(expectedPath, Buffer.from([2, 4, 6, 8, 10, 12]));
  const denoisedHash = normalizeSha256(sha256Buffer(await readFile(denoisedPath)));
  const oraclePath = path.join(dir, 'oracle.json');
  await writeFile(oraclePath, JSON.stringify({
    schemaVersion: OIDN_OUTPUT_ORACLE_SCHEMA,
    proofAuthority: OIDN_OUTPUT_ORACLE_AUTHORITY,
    backend: 'oidn_hip',
    device: 'hip',
    noisyInputPath: noisyPath,
    denoisedOutputPath: denoisedPath,
    expectedOutputPath: expectedPath,
    expectedOutputSha256: denoisedHash,
  }, null, 2));
  const outputOracle = await buildOidnOutputOracleEvidence(oraclePath);
  const artifactBefore = syntheticHash('oidn-runtime-artifact-before');
  const artifactAfter = syntheticHash('oidn-runtime-artifact-after');
  const contractHash = syntheticHash('oidn-runtime-contract');
  const compilerArgsHash = syntheticHash('oidn-runtime-compile-args');
  const dispatchTableBefore = syntheticHash('oidn-runtime-dispatch-table-before');
  const dispatchTableAfter = syntheticHash('oidn-runtime-dispatch-table-after');
  const runtimeBoundaryPath = path.join(dir, 'runtime-boundary.json');
  const runtimeSession = 'oidn-runtime-session-1';
  const dispatchId = 'oidn-dispatch-1';
  const processId = 'pid-oidn-1';
  await writeFile(runtimeBoundaryPath, JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.runtime_boundary_event_manifest.v1',
    proofAuthority: 'runtime_boundary_event_manifest_only_not_gpu_hmr_success',
    backend: 'hip',
    projectId: 'oidn-runtime-boundary-self-check',
    editId: 'oidn-gpu-artifact-edit',
    targetId: 'oidn-runtime-boundary-target',
    sourcePaths: ['runtime-boundary://oidn-device-source'],
    entryPoint: 'oidn_hip_denoise_kernel',
    compileTarget: 'gfx1201',
    compiler: 'hipcc',
    compilerArgsHash,
    artifactHashBefore: artifactBefore,
    artifactHashAfter: artifactAfter,
    contractHash,
    runtimeBoundaryEvents: [
      {
        kind: 'artifact_transport',
        eventId: 'oidn-load-1',
        artifactHash: artifactAfter,
        processId,
        runtimeSession,
        timestampMonotonicNs: 100,
        evidenceRefs: ['runtime-boundary:oidn:artifact-transport'],
      },
      {
        kind: 'epoch_publication',
        eventId: 'oidn-publish-1',
        artifactHash: artifactAfter,
        epoch: 'epoch-oidn-2',
        processId,
        runtimeSession,
        timestampMonotonicNs: 200,
        dispatchTableHashBefore: dispatchTableBefore,
        dispatchTableHashAfter: dispatchTableAfter,
        evidenceRefs: ['runtime-boundary:oidn:epoch-publication'],
      },
      {
        kind: 'synthi_gpu_launch',
        eventId: dispatchId,
        artifactHash: artifactAfter,
        epoch: 'epoch-oidn-2',
        dispatchId,
        processId,
        runtimeSession,
        stream: 'stream-oidn-1',
        dispatchTableEntry: 'oidn_hip_denoise_kernel:epoch-oidn-2',
        timestampMonotonicNs: 300,
        evidenceRefs: [
          `worker-log:synthi_gpu_launch:${runtimeSession}:${dispatchId}`,
          `worker-log:launch_arg_provenance:${runtimeSession}:${dispatchId}:output`,
        ],
      },
      {
        kind: 'host_identity',
        eventId: 'oidn-host-1',
        processId,
        runtimeSession,
        deviceUuid: 'device-oidn-1',
        contextId: 'ctx-oidn-1',
        stream: 'stream-oidn-1',
        timestampMonotonicNs: 310,
        evidenceRefs: [
          'worker-log:host_identity:runner_process',
          'worker-log:host_identity:host_state',
          'worker-log:host_identity:stream_context',
          `worker-log:host_identity_snapshot:${runtimeSession}:runner_process:1->2`,
          `worker-log:host_identity_snapshot:${runtimeSession}:host_state:1->2`,
          `worker-log:host_identity_snapshot:${runtimeSession}:stream_context:1->2`,
        ],
      },
      {
        kind: 'output_oracle',
        eventId: 'oidn-output-1',
        artifactHash: artifactAfter,
        epoch: 'epoch-oidn-2',
        afterDispatchId: dispatchId,
        processId,
        runtimeSession,
        outputTargetId: 'oidn-denoised-output',
        oracleKind: 'buffer_checksum',
        timestampMonotonicNs: 400,
        evidenceRefs: [`worker-log:output_oracle:${runtimeSession}:${dispatchId}`],
      },
    ],
  }, null, 2));
  const previousPath = CFG.runtimeBoundaryEventsPath;
  CFG.runtimeBoundaryEventsPath = runtimeBoundaryPath;
  const accepted = await buildOidnRuntimeBoundaryRunModeProof({
    outputOracle,
    classification: {
      oidnHipRuntimePreflightAccepted: true,
    },
  });
  assert(
    accepted.accepted === true,
    `OIDN runtime boundary bridge should accept: ${JSON.stringify({
      failedGates: accepted.failedGates,
      ledgerFailures: accepted.runtimeBoundaryRunModeProof?.runtimeProofArtifact?.proofLedgerQuery?.failedInvariants,
      limitations: accepted.runtimeBoundaryRunModeProof?.runtimeProofArtifact?.limitations,
      computeOracleArtifacts: accepted.computeOracleArtifacts,
    })}`,
  );
  assert(accepted.gpuHmrSuccess === false, 'OIDN bridge facet itself cannot claim GPU HMR success');
  assert(
    accepted.runtimeBoundaryRunModeProof?.runtimeProofArtifact?.gpuHmrSuccess === true,
    'nested generic runtime proof should be strict-gate accepted',
  );

  const forgedPath = path.join(dir, 'runtime-boundary-forged.json');
  const forgedManifest = JSON.parse(await readFile(runtimeBoundaryPath, 'utf8'));
  forgedManifest.gpuHmrSuccess = true;
  await writeFile(forgedPath, JSON.stringify(forgedManifest, null, 2));
  CFG.runtimeBoundaryEventsPath = forgedPath;
  const forged = await buildOidnRuntimeBoundaryRunModeProof({
    outputOracle,
    classification: {
      oidnHipRuntimePreflightAccepted: true,
    },
  });
  CFG.runtimeBoundaryEventsPath = previousPath;
  assert(forged.accepted === false, 'forged OIDN runtime boundary manifest should reject');
  assert(
    forged.failedGates.includes('oidn_runtime_boundary_event_manifest_claims_gpu_hmr_success'),
    `forged manifest gate missing: ${forged.failedGates.join(',')}`,
  );
  console.log('[ok] OIDN runtime-boundary bridge self-check passed');
}

if (args.has('--self-check')) {
  await runSelfCheck();
} else if (args.has('--runtime-boundary-self-check')) {
  await runRuntimeBoundaryBridgeSelfCheck();
} else {
  const proof = await buildProof();
  const paths = await writeProof(proof);
  console.log(`proof_id=${proof.proofId}`);
  console.log(`result_state=${proof.classification.resultState}`);
  console.log(`oidn_hip_runtime_preflight_accepted=${proof.classification.oidnHipRuntimePreflightAccepted}`);
  console.log(`oidn_hip_output_proof_accepted=${proof.classification.oidnHipOutputProofAccepted}`);
  console.log(`oidn_cpu_diagnostics_passed=${proof.classification.oidnCpuDiagnosticsPassed}`);
  console.log(`proof_json=${paths.jsonPath}`);
  console.log(`summary_txt=${paths.txtPath}`);
  if (!proof.classification.oidnHipRuntimePreflightAccepted && (CFG.requireHip || !CFG.allowRejected)) {
    process.exitCode = 1;
  }
}
