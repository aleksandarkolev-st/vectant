#!/usr/bin/env node
// Generic source-first visual GPU-HMR proof launcher.
//
// This file selects runner inputs only. It does not authorize GPU-HMR success:
// acceptance still comes from the source-first runner, strict runtime ledger,
// epoch/dispatch proof, output oracle bytes, and validation-matrix recompute.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeExactCommitGitBlobSnapshot,
} from './lib/gpu-hmr-direct-source-git-identity.mjs';
import {
  gpuHmrSourceExtensionMetadata,
  isGpuHmrAutomaticEntryCandidate,
  isGpuHmrSourcePath,
} from './lib/gpu-hmr-source-extension-registry.mjs';

function readOption(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) return args[index + 1] ?? '';
    if (typeof value === 'string' && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return '';
}

function readOptions(args, name) {
  const prefix = `${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      const next = args[index + 1];
      if (typeof next !== 'string' || !next || next.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      values.push(next);
      index += 1;
    } else if (typeof value === 'string' && value.startsWith(prefix)) {
      const inline = value.slice(prefix.length);
      if (!inline) throw new Error(`${name} requires a value`);
      values.push(inline);
    }
  }
  return values;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function setDefaultEnv(name, value) {
  if (process.env[name] == null || process.env[name] === '') {
    process.env[name] = value;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function contentHashForText(value) {
  return `sha256:${sha256Hex(String(value ?? ''))}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sourceFilesManifestHash(files) {
  const projection = files.map((entry) => ({
    path: entry.path,
    contentHash: entry.contentHash,
    content_hash: entry.content_hash,
    byteLength: entry.byteLength,
    byte_length: entry.byte_length,
  }));
  return `sha256:${sha256Hex(stableJson(projection))}`;
}

function uniqueSortedStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )].sort();
}

function cleanRel(value) {
  const text = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const normalized = path.posix.normalize(text);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`invalid source path ${value}`);
  }
  return normalized;
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const IGNORED_SOURCE_DIRS = new Set([
  '.cache',
  '.git',
  '.gpu-hmr-test-logs',
  '.synthi',
  '.svn',
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'cmake-build-debug',
  'cmake-build-release',
  'dist',
  'node_modules',
  'out',
  'target',
  'third_party',
  'vendor',
]);

const ENTRY_PRIORITY = [
  'src/main.cpp',
  'main.cpp',
  'src/main.cc',
  'main.cc',
  'src/main.cxx',
  'main.cxx',
  'src/main.hip',
  'main.hip',
  'src/main.cu',
  'main.cu',
  'src/main.cl',
  'main.cl',
  'src/main.wgsl',
  'main.wgsl',
  'src/lib.rs',
  'lib.rs',
];
const DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.direct_source_runtime_contract_expectation.v1';
const DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY =
  'direct_source_runtime_contract_expectation_only_not_gpu_hmr_success';
const DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_SCHEMA_VERSION =
  'synthi.gpu_hmr.direct_source_output_oracle_request.v1';
const DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_AUTHORITY =
  'direct_source_output_oracle_request_only_not_gpu_hmr_success';
const DIRECT_SOURCE_OUTPUT_ORACLE_KINDS = new Set([
  'compute_oracle',
  'visual_oracle',
]);
const DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES = [
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
];

function contentAddressedSha256(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value ?? '').trim());
}

function normalizedDirectSourceOutputOracleKind(value, source) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  if (!DIRECT_SOURCE_OUTPUT_ORACLE_KINDS.has(normalized)) {
    throw new Error(
      `${source} must be one of ${[...DIRECT_SOURCE_OUTPUT_ORACLE_KINDS].join(', ')}`,
    );
  }
  return normalized;
}

function supportMaterialClaimsAuthority(value) {
  const authorityKeys = new Set([
    'acceptedForGpuHmr',
    'accepted_for_gpu_hmr',
    'gpuHmrSuccess',
    'gpu_hmr_success',
    'canSatisfyRuntimeProof',
    'can_satisfy_runtime_proof',
    'canSatisfyDispatchProof',
    'can_satisfy_dispatch_proof',
    'canSatisfyOutputOracleProof',
    'can_satisfy_output_oracle_proof',
  ]);
  const inspect = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    if (Array.isArray(candidate)) return candidate.some(inspect);
    return Object.entries(candidate).some(([key, nested]) => (
      (authorityKeys.has(key) && nested === true) || inspect(nested)
    ));
  };
  return inspect(value);
}

function visualRequestMaterialFromProfile(profilePath) {
  if (!profilePath) {
    throw new Error(
      'visual_oracle direct-source intent requires a profile with content-addressed visual evidence',
    );
  }
  const resolvedProfilePath = path.isAbsolute(profilePath)
    ? profilePath
    : path.resolve(process.cwd(), profilePath);
  if (!existsSync(resolvedProfilePath)) {
    throw new Error(`visual oracle profile not found: ${resolvedProfilePath}`);
  }
  const profileText = readFileSync(resolvedProfilePath, 'utf8').replace(/^\uFEFF/, '');
  const profile = JSON.parse(profileText);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('visual oracle profile must be a JSON object');
  }
  if (supportMaterialClaimsAuthority(profile)) {
    throw new Error('visual oracle profile material cannot claim GPU HMR or runtime proof authority');
  }
  const manifest = profile.visualSceneManifest
    ?? profile.visual_scene_manifest
    ?? profile.renderSceneManifest
    ?? profile.render_scene_manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(
      'visual_oracle direct-source intent requires a non-empty visual scene manifest',
    );
  }
  if (Object.keys(manifest).length === 0) {
    throw new Error(
      'visual_oracle direct-source intent requires a non-empty visual scene manifest',
    );
  }
  const declaredManifestHash = String(
    profile.visualSceneManifestHash
      ?? profile.visual_scene_manifest_hash
      ?? profile.renderSceneManifestHash
      ?? profile.render_scene_manifest_hash
      ?? '',
  ).trim().toLowerCase();
  if (!contentAddressedSha256(declaredManifestHash)) {
    throw new Error(
      'visual_oracle direct-source intent requires an explicit content-addressed visual scene manifest hash',
    );
  }
  const manifestHash = `sha256:${sha256Hex(stableJson(manifest))}`;
  if (declaredManifestHash !== manifestHash) {
    throw new Error(
      `visual oracle scene manifest hash mismatch: declared ${declaredManifestHash} actual ${manifestHash}`,
    );
  }
  const profileHash = contentHashForText(profileText);
  return {
    manifest,
    manifestHash,
    manifest_hash: manifestHash,
    profileHash,
    profile_hash: profileHash,
    evidenceRef: `evidence:direct-source-visual-scene-manifest:${manifestHash}`,
    evidence_ref: `evidence:direct-source-visual-scene-manifest:${manifestHash}`,
  };
}

function directSourceOutputOracleRequest({ outputOracleKind, visualProfilePath }) {
  if (!outputOracleKind) return { request: null, visualMaterial: null };
  const visualMaterial = outputOracleKind === 'visual_oracle'
    ? visualRequestMaterialFromProfile(visualProfilePath)
    : null;
  const requiredProofKinds = outputOracleKind === 'visual_oracle'
    ? [
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'content_addressed_before_after_diff_images',
        'deterministic_visual_controls',
        'post_dispatch_frame_gate',
        'strict_proof_ledger',
      ]
    : [
        'artifact_transport',
        'epoch_publication',
        'dispatch_trace',
        'host_identity',
        'raw_readback_bytes',
        'readback_schema',
        'deterministic_slice',
        'before_after_checksums',
        'strict_proof_ledger',
      ];
  const evidenceRefs = uniqueSortedStrings([
    visualMaterial?.manifestHash,
    visualMaterial?.profileHash,
    visualMaterial?.evidenceRef,
  ]);
  const seed = {
    schemaVersion: DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_SCHEMA_VERSION,
    outputOracleKind,
    visualSceneManifestHash: visualMaterial?.manifestHash ?? null,
    visualProfileHash: visualMaterial?.profileHash ?? null,
    requiredProofKinds,
    evidenceRefs,
  };
  const requestHash = `sha256:${sha256Hex(stableJson(seed))}`;
  const request = {
    schemaVersion: DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_SCHEMA_VERSION,
    schema_version: DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_SCHEMA_VERSION,
    proofAuthority: DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_AUTHORITY,
    proof_authority: DIRECT_SOURCE_OUTPUT_ORACLE_REQUEST_AUTHORITY,
    accepted: false,
    acceptedAsRequestIntent: true,
    accepted_as_request_intent: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    canSatisfyOutputOracleProof: false,
    can_satisfy_output_oracle_proof: false,
    outputOracleKind,
    output_oracle_kind: outputOracleKind,
    kind: outputOracleKind,
    oracleIntent: outputOracleKind,
    oracle_intent: outputOracleKind,
    visualSceneManifestHash: visualMaterial?.manifestHash ?? null,
    visual_scene_manifest_hash: visualMaterial?.manifestHash ?? null,
    visualProfileHash: visualMaterial?.profileHash ?? null,
    visual_profile_hash: visualMaterial?.profileHash ?? null,
    requiredProofKinds,
    required_proof_kinds: requiredProofKinds,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    requestHash,
    request_hash: requestHash,
  };
  return { request, visualMaterial };
}

function assertInsideRoot(filePath, rootPath) {
  const rootReal = realpathSync(rootPath);
  const fileReal = realpathSync(filePath);
  const rel = path.relative(rootReal, fileReal);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`source root scan escaped root: ${filePath}`);
}

function sourceFilesForRoot(sourceRoot) {
  const root = realpathSync(path.resolve(sourceRoot));
  const maxFiles = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_FILES', 512);
  const maxTotalBytes = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_TOTAL_BYTES', 12 * 1024 * 1024);
  const maxFileBytes = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_FILE_BYTES', 2 * 1024 * 1024);
  const files = [];
  let totalBytes = 0;
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isGpuHmrSourcePath(entry.name)) continue;
      assertInsideRoot(fullPath, root);
      const stat = statSync(fullPath);
      if (stat.size > maxFileBytes) {
        throw new Error(
          `source file ${fullPath} exceeds ${maxFileBytes} bytes; provide --source-manifest with the intended source set`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `source root ${root} exceeds ${maxTotalBytes} bytes of source input; provide --source-manifest with the intended source set`,
        );
      }
      if (files.length >= maxFiles) {
        throw new Error(
          `source root ${root} has more than ${maxFiles} source files; provide --source-manifest with the intended source set`,
        );
      }
      const relativePath = cleanRel(path.relative(root, fullPath));
      const content = readFileSync(fullPath, 'utf8');
      files.push({
        path: relativePath,
        sourcePath: relativePath,
        source_path: relativePath,
        contentHash: contentHashForText(content),
        content_hash: contentHashForText(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
        byte_length: Buffer.byteLength(content, 'utf8'),
      });
    }
  };
  walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function inferEntryPath(files, requestedEntry) {
  if (requestedEntry) {
    const entryPath = cleanRel(requestedEntry);
    if (!files.some((file) => file.path === entryPath)) {
      throw new Error(`--source-entry ${entryPath} is not present in the scanned source root`);
    }
    return entryPath;
  }
  const byPriority = ENTRY_PRIORITY.find((entryPath) =>
    files.some((file) => file.path === entryPath)
  );
  if (byPriority) return byPriority;
  const mainCandidates = files.filter((file) => {
    const base = path.posix.basename(file.path).toLowerCase();
    const extensionMetadata = gpuHmrSourceExtensionMetadata(base);
    return extensionMetadata?.automaticEntryCandidate === true
      && base === `main${extensionMetadata.extension}`;
  });
  if (mainCandidates.length === 1) return mainCandidates[0].path;
  if (mainCandidates.length > 1) {
    throw new Error(
      `source root has multiple main entry candidates (${mainCandidates.map((file) => file.path).join(', ')}); provide --source-entry or --source-manifest`,
    );
  }
  const entryCandidates = files.filter((file) => isGpuHmrAutomaticEntryCandidate(file.path));
  if (entryCandidates.length === 1) return entryCandidates[0].path;
  throw new Error('source root entry is ambiguous; provide --source-entry or --source-manifest');
}

function synthesizeSourceManifestFromRoot({
  sourceRoot,
  sourceEntry,
  sourceAuthority,
  sourceCommit,
  sourceRootRelativePath = '.',
  selectedSourcePaths = [],
  selectedBuildPaths = [],
  inputChannels = [],
  outputOracleKind = '',
  visualProfilePath = '',
}) {
  if (!sourceRoot) throw new Error('source root is required');
  const root = realpathSync(path.resolve(sourceRoot));
  if (!existsSync(root)) throw new Error(`source root not found: ${root}`);
  const explicitSourcePaths = uniqueSortedStrings(selectedSourcePaths).map(cleanRel);
  const explicitBuildPaths = uniqueSortedStrings(selectedBuildPaths).map(cleanRel);
  const explicitSelection = explicitSourcePaths.length > 0 || explicitBuildPaths.length > 0;
  const scannedFiles = explicitSelection ? [] : sourceFilesForRoot(root);
  if (!explicitSelection && scannedFiles.length === 0) {
    throw new Error(`source root ${root} contains no supported source files`);
  }
  if (explicitSelection && explicitSourcePaths.length === 0) {
    throw new Error('exact-commit source selection requires at least one --source-file');
  }
  const directSourceAuthority = sourceAuthority || 'direct_local_git_repo_path';
  if (!sourceCommit) {
    throw new Error('auto-scanned --source-root requires an explicit full --source-commit');
  }
  const sourceKind = directSourceAuthority === 'direct_local_git_repo_path'
    ? 'local_repo_path_commit'
    : directSourceAuthority === 'direct_source_url_commit'
      ? 'source_url_commit'
      : 'source_tree_files';
  const repositoryRoot = realpathSync(String(execFileSync(
    'git',
    ['-C', root, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', windowsHide: true },
  )).trim());
  const inferredSourceRootRelativePath = path.relative(repositoryRoot, root).replace(/\\/g, '/') || '.';
  const requestedSourceRootRelativePath = sourceRootRelativePath === '.'
    ? inferredSourceRootRelativePath
    : cleanRel(sourceRootRelativePath);
  const sourcePaths = explicitSelection
    ? explicitSourcePaths
    : scannedFiles.map((file) => file.path);
  const immutableSnapshot = materializeExactCommitGitBlobSnapshot({
    repositoryRoot,
    commitOid: sourceCommit,
    sourceRootRelativePath: requestedSourceRootRelativePath,
    sourcePaths,
    buildPaths: explicitBuildPaths,
  });
  const files = immutableSnapshot.files.map((entry) => ({
    ...entry,
    name: entry.path,
  }));
  const sourceFiles = files.filter((entry) => entry.kind === 'source');
  const entryPath = inferEntryPath(sourceFiles, sourceEntry);
  const fileManifest = files.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    contentHash: entry.contentHash,
    content_hash: entry.content_hash,
    byteLength: entry.byteLength,
    byte_length: entry.byte_length,
  }));
  const manifestHash = sourceFilesManifestHash(files);
  const immutableSourceIdentity = immutableSnapshot.identity;
  const immutableCommit = immutableSourceIdentity.commitOid;
  const directSourceInputChannels = uniqueSortedStrings(inputChannels);
  const {
    request: outputOracleRequest,
    visualMaterial: visualRequestMaterial,
  } = directSourceOutputOracleRequest({ outputOracleKind, visualProfilePath });
  const entryInferenceEvidence = {
    schemaVersion: 'synthi.gpu_hmr.source_root_entry_inference.v1',
    schema_version: 'synthi.gpu_hmr.source_root_entry_inference.v1',
    proofAuthority: 'source_root_entry_inference_only_not_runtime_contract',
    proof_authority: 'source_root_entry_inference_only_not_runtime_contract',
    accepted: true,
    selectedEntryPath: entryPath,
    selected_entry_path: entryPath,
    requestedEntryPath: sourceEntry || null,
    requested_entry_path: sourceEntry || null,
    candidateFileCount: files.length,
    candidate_file_count: files.length,
    targetNameIndependent: true,
    target_name_independent: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
  };
  const runtimeContractExpectation = {
    schemaVersion: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION,
    schema_version: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_SCHEMA_VERSION,
    proofAuthority: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY,
    proof_authority: DIRECT_SOURCE_RUNTIME_CONTRACT_EXPECTATION_AUTHORITY,
    accepted: false,
    acceptedAsRuntimeContractExpectation: false,
    accepted_as_runtime_contract_expectation: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    targetNameIndependent: true,
    target_name_independent: true,
    entryInferenceEvidence,
    entry_inference_evidence: entryInferenceEvidence,
    runtimeBoundaryStagesRequired: DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES,
    runtime_boundary_stages_required: DIRECT_SOURCE_RUNTIME_BOUNDARY_STAGES,
    declaredRuntimeBoundaryStages: [],
    declared_runtime_boundary_stages: [],
    outputOracleKind: outputOracleRequest?.outputOracleKind ?? null,
    output_oracle_kind: outputOracleRequest?.output_oracle_kind ?? null,
    outputOracle: outputOracleRequest,
    output_oracle: outputOracleRequest,
    blockingGaps: [
      'direct_source_runtime_contract_backend_missing',
      'direct_source_runtime_contract_build_metadata_missing',
      'direct_source_runtime_contract_boundary_stages_incomplete',
      outputOracleRequest ? null : 'direct_source_runtime_contract_output_oracle_missing',
      'direct_source_runtime_contract_declared_device_edits_missing',
    ].filter(Boolean),
    blocking_gaps: [
      'direct_source_runtime_contract_backend_missing',
      'direct_source_runtime_contract_build_metadata_missing',
      'direct_source_runtime_contract_boundary_stages_incomplete',
      outputOracleRequest ? null : 'direct_source_runtime_contract_output_oracle_missing',
      'direct_source_runtime_contract_declared_device_edits_missing',
    ].filter(Boolean),
  };
  const manifest = {
    schemaVersion: 'synthi.gpu_hmr.agent_split_direct_source_manifest.v1',
    schema_version: 'synthi.gpu_hmr.agent_split_direct_source_manifest.v1',
    proofAuthority: 'source_root_scan_manifest_only_not_gpu_hmr_success',
    proof_authority: 'source_root_scan_manifest_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceAuthority: directSourceAuthority,
    source_authority: directSourceAuthority,
    sourceKind,
    source_kind: sourceKind,
    sourceRoot: repositoryRoot,
    source_root: repositoryRoot,
    repoPath: repositoryRoot,
    repo_path: repositoryRoot,
    immutableCommit,
    immutable_commit: immutableCommit,
    immutableSourceIdentity,
    immutable_source_identity: immutableSourceIdentity,
    exactCommitGitBlobIdentity: immutableSourceIdentity,
    exact_commit_git_blob_identity: immutableSourceIdentity,
    exactCommitSnapshotManifestHash: immutableSnapshot.manifestHash,
    exact_commit_snapshot_manifest_hash: immutableSnapshot.manifestHash,
    sourceRootRelativePath: requestedSourceRootRelativePath,
    source_root_relative_path: requestedSourceRootRelativePath,
    directSourceInputChannels,
    direct_source_input_channels: directSourceInputChannels,
    entryInferenceEvidence,
    entry_inference_evidence: entryInferenceEvidence,
    runtimeContractExpectation,
    runtime_contract_expectation: runtimeContractExpectation,
    outputOracleRequest,
    output_oracle_request: outputOracleRequest,
    outputOracleKind: outputOracleRequest?.outputOracleKind ?? null,
    output_oracle_kind: outputOracleRequest?.output_oracle_kind ?? null,
    visualSceneManifest: visualRequestMaterial?.manifest ?? null,
    visual_scene_manifest: visualRequestMaterial?.manifest ?? null,
    visualSceneManifestHash: visualRequestMaterial?.manifestHash ?? null,
    visual_scene_manifest_hash: visualRequestMaterial?.manifest_hash ?? null,
    visualSceneManifestEvidenceRef: visualRequestMaterial?.evidenceRef ?? null,
    visual_scene_manifest_evidence_ref: visualRequestMaterial?.evidence_ref ?? null,
    entryPath,
    entry_path: entryPath,
    manifestHash,
    manifest_hash: manifestHash,
    fileManifest,
    file_manifest: fileManifest,
    files,
    source: {
      sourceAuthority: directSourceAuthority,
      source_authority: directSourceAuthority,
      sourceKind,
      source_kind: sourceKind,
      sourceRoot: repositoryRoot,
      source_root: repositoryRoot,
      repoPath: repositoryRoot,
      repo_path: repositoryRoot,
      immutableCommit,
      immutable_commit: immutableCommit,
      immutableSourceIdentity,
      immutable_source_identity: immutableSourceIdentity,
      exactCommitGitBlobIdentity: immutableSourceIdentity,
      exact_commit_git_blob_identity: immutableSourceIdentity,
      exactCommitSnapshotManifestHash: immutableSnapshot.manifestHash,
      exact_commit_snapshot_manifest_hash: immutableSnapshot.manifestHash,
      sourceRootRelativePath: requestedSourceRootRelativePath,
      source_root_relative_path: requestedSourceRootRelativePath,
      directSourceInputChannels,
      direct_source_input_channels: directSourceInputChannels,
      entryInferenceEvidence,
      entry_inference_evidence: entryInferenceEvidence,
      runtimeContractExpectation,
      runtime_contract_expectation: runtimeContractExpectation,
      outputOracle: outputOracleRequest,
      output_oracle: outputOracleRequest,
      outputOracleKind: outputOracleRequest?.outputOracleKind ?? null,
      output_oracle_kind: outputOracleRequest?.output_oracle_kind ?? null,
      visualSceneManifest: visualRequestMaterial?.manifest ?? null,
      visual_scene_manifest: visualRequestMaterial?.manifest ?? null,
      visualSceneManifestHash: visualRequestMaterial?.manifestHash ?? null,
      visual_scene_manifest_hash: visualRequestMaterial?.manifest_hash ?? null,
      visualSceneManifestEvidenceRef: visualRequestMaterial?.evidenceRef ?? null,
      visual_scene_manifest_evidence_ref: visualRequestMaterial?.evidence_ref ?? null,
      entryPath,
      entry_path: entryPath,
      files,
    },
  };
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.resolve(scriptDir, '..', '.gpu-hmr-test-logs', 'direct-source-manifests', 'generated');
  mkdirSync(outputDir, { recursive: true });
  const identityHash = immutableSourceIdentity.identityHash;
  const manifestPath = path.join(
    outputDir,
    `source-root-${identityHash.slice('sha256:'.length, 'sha256:'.length + 16)}-${manifestHash.slice('sha256:'.length, 'sha256:'.length + 16)}.json`,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifest,
    manifestPath,
  };
}

function selfCheckSourceRootManifest() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'synthi-source-root-manifest-'));
  try {
    mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    writeFileSync(path.join(tmpRoot, 'src', 'main.cpp'), '#include "scene_config.h"\nint main(){return 0;}\n');
    writeFileSync(path.join(tmpRoot, 'src', 'scene_config.h'), '#pragma once\nconstexpr int kPixels = 16;\n');
    for (const fileName of [
      'alternate.C++',
      'context.H++',
      'kernel.GEOM',
      'kernel.HLSL',
      'kernel.METAL',
      'kernel.OPENCL',
      'kernel.SLANG',
      'kernel.TESC',
      'kernel.TESE',
      'template.IPP',
      'template.TPP',
      'tool.ZIG',
    ]) {
      writeFileSync(path.join(tmpRoot, 'src', fileName), `${fileName}\n`);
    }
    writeFileSync(path.join(tmpRoot, 'src', 'ignored.opaque'), 'unknown extension\n');
    writeFileSync(path.join(tmpRoot, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(cold_source)\n');
    const scannedPaths = sourceFilesForRoot(tmpRoot).map((entry) => entry.path);
    const expectedRegistryPaths = [
      'src/alternate.C++',
      'src/context.H++',
      'src/kernel.GEOM',
      'src/kernel.HLSL',
      'src/kernel.METAL',
      'src/kernel.OPENCL',
      'src/kernel.SLANG',
      'src/kernel.TESC',
      'src/kernel.TESE',
      'src/template.IPP',
      'src/template.TPP',
      'src/tool.ZIG',
    ];
    if (
      expectedRegistryPaths.some((filePath) => !scannedPaths.includes(filePath))
      || scannedPaths.includes('src/ignored.opaque')
      || scannedPaths.includes('CMakeLists.txt')
      || scannedPaths.join('\n') !== [...scannedPaths].sort((left, right) => left.localeCompare(right)).join('\n')
    ) {
      throw new Error('source-root manifest self-check failed: extension registry scan mismatch');
    }
    for (const gitArgs of [
      ['init'],
      ['config', 'user.email', 'gpu-hmr-self-check@example.invalid'],
      ['config', 'user.name', 'GPU HMR Self Check'],
      ['config', 'core.autocrlf', 'false'],
      ['add', '.'],
      ['commit', '-m', 'immutable source-root fixture'],
    ]) {
      execFileSync('git', ['-C', tmpRoot, ...gitArgs], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    }
    const sourceCommit = String(execFileSync('git', ['-C', tmpRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    })).trim();
    writeFileSync(path.join(tmpRoot, 'src', 'main.cpp'), 'int dirty_worktree_must_not_reach_provider = 1;\n');
    const generated = synthesizeSourceManifestFromRoot({
      sourceRoot: tmpRoot,
      sourceEntry: 'src/main.cpp',
      sourceAuthority: 'user_source_files',
      sourceCommit,
      selectedSourcePaths: ['src/main.cpp', 'src/scene_config.h'],
      selectedBuildPaths: ['CMakeLists.txt'],
      inputChannels: [
        'cli_arg:source-root',
        'cli_arg:source-entry',
        'cli_arg:source-authority',
        'cli_arg:source-commit',
      ],
    });
    if (!existsSync(generated.manifestPath)) {
      throw new Error('source-root manifest self-check failed: manifest not written');
    }
    if (generated.manifest.entryPath !== 'src/main.cpp') {
      throw new Error('source-root manifest self-check failed: entry not preserved');
    }
    if (generated.manifest.files.length !== 3) {
      throw new Error('source-root manifest self-check failed: source file count mismatch');
    }
    if (
      generated.manifest.immutableCommit !== sourceCommit
      || generated.manifest.immutableSourceIdentity?.commitOid !== sourceCommit
      || generated.manifest.immutableSourceIdentity?.sourceBytesOrigin !== 'git_objects_only'
      || generated.manifest.immutableSourceIdentity?.worktreeStateInspected !== false
      || generated.manifest.immutableSourceIdentity?.sourceFileCount !== 2
      || generated.manifest.immutableSourceIdentity?.buildFileCount !== 1
      || generated.manifest.files.find((entry) => entry.path === 'src/main.cpp')?.inline
        !== '#include "scene_config.h"\nint main(){return 0;}\n'
    ) {
      throw new Error('source-root manifest self-check failed: exact-commit Git identity missing');
    }
    if (generated.manifest.acceptedForGpuHmr !== false || generated.manifest.gpuHmrSuccess !== false) {
      throw new Error('source-root manifest self-check failed: manifest claimed GPU HMR authority');
    }
    if (
      generated.manifest.runtimeContractExpectation?.accepted !== false
      || generated.manifest.runtimeContractExpectation?.canSatisfyRuntimeProof !== false
      || !generated.manifest.runtimeContractExpectation?.blockingGaps
        ?.includes('direct_source_runtime_contract_boundary_stages_incomplete')
      || generated.manifest.entryInferenceEvidence?.accepted !== true
    ) {
      throw new Error('source-root manifest self-check failed: runtime contract expectation shape mismatch');
    }
    writeFileSync(path.join(tmpRoot, 'README.md'), 'identity-only commit change\n');
    execFileSync('git', ['-C', tmpRoot, 'add', 'README.md'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync('git', ['-C', tmpRoot, 'commit', '-m', 'advance immutable identity'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const secondSourceCommit = String(execFileSync('git', ['-C', tmpRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    })).trim();
    const secondGenerated = synthesizeSourceManifestFromRoot({
      sourceRoot: tmpRoot,
      sourceEntry: 'src/main.cpp',
      sourceAuthority: 'user_source_files',
      sourceCommit: secondSourceCommit,
      selectedSourcePaths: ['src/main.cpp', 'src/scene_config.h'],
      selectedBuildPaths: ['CMakeLists.txt'],
      inputChannels: ['cli_arg:source-root', 'cli_arg:source-commit'],
    });
    if (
      secondGenerated.manifest.manifestHash !== generated.manifest.manifestHash
      || secondGenerated.manifest.immutableSourceIdentity?.identityHash
        === generated.manifest.immutableSourceIdentity?.identityHash
      || secondGenerated.manifestPath === generated.manifestPath
    ) {
      throw new Error('source-root manifest self-check failed: immutable identities reused a manifest path');
    }
    console.log(`source-root manifest self-check passed: ${generated.manifestPath}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function resolveLauncherInputs(args, env = process.env) {
  const fixtureArg = readOption(args, '--fixture');
  const profileArg = readOption(args, '--profile');
  const outputOracleKindArgs = readOptions(args, '--output-oracle-kind');
  if (outputOracleKindArgs.length > 1) {
    throw new Error('--output-oracle-kind may be provided only once');
  }
  const outputOracleKindArg = normalizedDirectSourceOutputOracleKind(
    outputOracleKindArgs[0] ?? '',
    '--output-oracle-kind',
  );
  const outputOracleKindEnv = normalizedDirectSourceOutputOracleKind(
    env.SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND ?? '',
    'SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND',
  );
  if (
    outputOracleKindArg
    && outputOracleKindEnv
    && outputOracleKindArg !== outputOracleKindEnv
  ) {
    throw new Error(
      '--output-oracle-kind conflicts with SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND',
    );
  }
  const outputOracleKind = outputOracleKindArg || outputOracleKindEnv;
  const sourceManifestArg = readOption(args, '--source-manifest');
  const sourceRootArg = readOption(args, '--source-root');
  const sourceEntryArg = readOption(args, '--source-entry');
  const sourceAuthorityArg = readOption(args, '--source-authority');
  const sourceCommitArg = readOption(args, '--source-commit');
  const sourceRootRelativePathArg = readOption(args, '--source-subtree');
  const sourceFileArgs = readOptions(args, '--source-file');
  const buildFileArgs = readOptions(args, '--build-file');
  const directSourceRequested = Boolean(
    sourceManifestArg
    || sourceRootArg
    || env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
    || env.SYNTHI_GPU_AGENT_SOURCE_ROOT
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
    || sourceFileArgs.length > 0
    || buildFileArgs.length > 0
  );
  const fixture = directSourceRequested && !fixtureArg
    ? ''
    : fixtureArg || env.SYNTHI_GPU_AGENT_FIXTURE || '';
  const profile = profileArg || env.SYNTHI_GPU_AGENT_PROFILE_PATH || '';
  const sourceManifest =
    sourceManifestArg
    || env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
    || '';
  const sourceRoot =
    sourceRootArg
    || env.SYNTHI_GPU_AGENT_SOURCE_ROOT
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
    || '';
  const sourceEntry =
    sourceEntryArg
    || env.SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH
    || '';
  const sourceAuthority =
    sourceAuthorityArg
    || env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY
    || '';
  const sourceCommit =
    sourceCommitArg
    || env.SYNTHI_GPU_AGENT_SOURCE_COMMIT
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_COMMIT
    || '';
  const sourceRootRelativePath =
    sourceRootRelativePathArg
    || env.SYNTHI_GPU_AGENT_SOURCE_SUBTREE
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_SUBTREE
    || '.';
  const selectedSourcePaths = sourceFileArgs.length > 0
    ? sourceFileArgs
    : uniqueSortedStrings(String(
        env.SYNTHI_GPU_AGENT_SOURCE_FILES
        || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_FILES
        || '',
      ).split(',').map((value) => value.trim()));
  const selectedBuildPaths = buildFileArgs.length > 0
    ? buildFileArgs
    : uniqueSortedStrings(String(
        env.SYNTHI_GPU_AGENT_BUILD_FILES
        || env.SYNTHI_GPU_AGENT_DIRECT_BUILD_FILES
        || '',
      ).split(',').map((value) => value.trim()));
  const vendor = readOption(args, '--vendor') || env.SYNTHI_GPU_VENDOR || 'rocm';

  if (fixture && profile) {
    throw new Error('choose either --fixture or --profile, not both');
  }
  if (fixtureArg && directSourceRequested) {
    throw new Error('choose either --fixture or direct source inputs, not both');
  }
  if (sourceCommit && !sourceRoot) {
    throw new Error('--source-commit requires --source-root or SYNTHI_GPU_AGENT_SOURCE_ROOT');
  }
  if (sourceRoot && !sourceManifest && !sourceCommit) {
    throw new Error('--source-root requires an explicit full --source-commit');
  }
  if (sourceCommit && sourceManifest) {
    throw new Error('--source-commit cannot override an existing direct source manifest');
  }
  if ((selectedSourcePaths.length > 0 || selectedBuildPaths.length > 0) && !sourceRoot) {
    throw new Error('--source-file/--build-file require --source-root');
  }
  if ((selectedSourcePaths.length > 0 || selectedBuildPaths.length > 0) && !sourceCommit) {
    throw new Error('--source-file/--build-file require an explicit full --source-commit');
  }
  if (outputOracleKind && !sourceRoot) {
    throw new Error(
      '--output-oracle-kind requires --source-root so the request can be sealed into the synthesized source manifest',
    );
  }

  return {
    fixtureArg,
    profileArg,
    outputOracleKindArg,
    outputOracleKindEnv,
    outputOracleKind,
    sourceManifestArg,
    sourceRootArg,
    sourceEntryArg,
    sourceAuthorityArg,
    sourceCommitArg,
    sourceRootRelativePathArg,
    sourceFileArgs,
    buildFileArgs,
    directSourceRequested,
    fixture,
    profile,
    sourceManifest,
    sourceRoot,
    sourceEntry,
    sourceAuthority,
    sourceCommit,
    sourceRootRelativePath,
    selectedSourcePaths,
    selectedBuildPaths,
    vendor,
  };
}

function applyLauncherInputs(inputs, env = process.env) {
  const {
    fixture,
    profile,
    sourceManifest,
    sourceRoot,
    sourceEntry,
    sourceAuthority,
    sourceCommit,
  } = inputs;
  if (fixture) env.SYNTHI_GPU_AGENT_FIXTURE = fixture;
  if (profile) env.SYNTHI_GPU_AGENT_PROFILE_PATH = profile;
  if (sourceManifest || sourceRoot) {
    delete env.SYNTHI_GPU_AGENT_FIXTURE;
  }
  if (sourceManifest) {
    env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH = sourceManifest;
    env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH = sourceManifest;
  }
  if (sourceRoot) {
    env.SYNTHI_GPU_AGENT_SOURCE_ROOT = sourceRoot;
    env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT = sourceRoot;
  }
  if (sourceEntry) {
    env.SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH = sourceEntry;
    env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH = sourceEntry;
  }
  if (sourceAuthority) {
    env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY = sourceAuthority;
    env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY = sourceAuthority;
  }
  if (sourceCommit) {
    env.SYNTHI_GPU_AGENT_SOURCE_COMMIT = sourceCommit;
    env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_COMMIT = sourceCommit;
  }
}

function selfCheckProfileDirectSourceOverlayPolicy() {
  const profilePath = 'scripts/profiles/agent-realistic-raytrace-scene.json';
  const inputs = resolveLauncherInputs([
    '--profile',
    profilePath,
    '--source-root',
    'user-project-src',
    '--source-entry',
    'src/main.cpp',
    '--source-authority',
    'user_source_files',
    '--source-commit',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ], {});
  const env = {
    SYNTHI_GPU_AGENT_FIXTURE: 'flow',
  };
  applyLauncherInputs({
    ...inputs,
    sourceManifest: 'generated-direct-source-manifest.json',
  }, env);
  if (
    inputs.profile !== profilePath
    || inputs.fixture !== ''
    || inputs.directSourceRequested !== true
    || env.SYNTHI_GPU_AGENT_PROFILE_PATH !== profilePath
    || env.SYNTHI_GPU_AGENT_FIXTURE !== undefined
    || env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH !== 'generated-direct-source-manifest.json'
    || env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH !== 'generated-direct-source-manifest.json'
    || env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY !== 'user_source_files'
  ) {
    throw new Error('profile plus direct source overlay launcher policy self-check failed');
  }
  let fixtureRejected = false;
  try {
    resolveLauncherInputs([
      '--fixture',
      'flow',
      '--source-root',
      'user-project-src',
    ], {});
  } catch (error) {
    fixtureRejected = String(error?.message ?? '').includes('direct source inputs');
  }
  if (!fixtureRejected) {
    throw new Error('fixture plus direct source launcher policy self-check failed');
  }
  console.log('profile plus direct source launcher policy self-check passed');
}

const args = process.argv.slice(2);
const selfCheck = hasFlag(args, '--self-check');
const prepareSourceManifestOnly = hasFlag(args, '--prepare-source-manifest-only');
const coldAiSplitOnly = hasFlag(args, '--cold-ai-split-only');
if (coldAiSplitOnly) {
  process.env.SYNTHI_GPU_AGENT_MODE = 'cold-ai-split';
}
const configuredAgentMode = String(process.env.SYNTHI_GPU_AGENT_MODE ?? 'validate')
  .trim()
  .toLowerCase();
const requireFreshAiSplit = coldAiSplitOnly
  || hasFlag(args, '--require-fresh-ai-split')
  || process.env.SYNTHI_GPU_AGENT_REQUIRE_FRESH_AI_SPLIT === '1'
  || configuredAgentMode === 'cold-ai-split';
process.env.SYNTHI_GPU_AGENT_REQUIRE_FRESH_AI_SPLIT = requireFreshAiSplit ? '1' : '0';
const sourceFirstExecutionPolicy = {
  schemaVersion: 'synthi.gpu_hmr.source_first_execution_request.v1',
  schema_version: 'synthi.gpu_hmr.source_first_execution_request.v1',
  proofAuthority: 'caller_execution_request_only_not_gpu_hmr_success',
  proof_authority: 'caller_execution_request_only_not_gpu_hmr_success',
  mode: configuredAgentMode,
  requireFreshAiSplit,
  require_fresh_ai_split: requireFreshAiSplit,
  terminalAfterColdSplit: configuredAgentMode === 'cold-ai-split',
  terminal_after_cold_split: configuredAgentMode === 'cold-ai-split',
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
};
const launcherInputs = resolveLauncherInputs(args);
const {
  fixture,
  profile,
  sourceRoot,
  sourceEntry,
  sourceAuthority,
  sourceCommit,
  sourceRootRelativePath,
  selectedSourcePaths,
  selectedBuildPaths,
  sourceRootArg,
  sourceEntryArg,
  sourceAuthorityArg,
  sourceCommitArg,
  sourceRootRelativePathArg,
  sourceFileArgs,
  buildFileArgs,
  outputOracleKindArg,
  outputOracleKindEnv,
  outputOracleKind,
  vendor,
} = launcherInputs;
let { sourceManifest } = launcherInputs;

if (selfCheck) {
  selfCheckSourceRootManifest();
  selfCheckProfileDirectSourceOverlayPolicy();
}

if (!fixture && !profile && !sourceManifest && !sourceRoot && !selfCheck) {
  throw new Error('source-first visual proof requires --fixture, --profile, --source-manifest, or --source-root');
}

let generatedSourceManifest = null;
if (!sourceManifest && sourceRoot) {
  const directSourceInputChannels = [
    sourceRootArg ? 'cli_arg:source-root' : null,
    !sourceRootArg && (process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT)
      ? 'env:SYNTHI_GPU_AGENT_SOURCE_ROOT'
      : null,
    sourceEntryArg ? 'cli_arg:source-entry' : null,
    !sourceEntryArg && (process.env.SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH)
      ? 'env:SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH'
      : null,
    sourceAuthorityArg ? 'cli_arg:source-authority' : null,
    !sourceAuthorityArg && (process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY)
      ? 'env:SYNTHI_GPU_AGENT_SOURCE_AUTHORITY'
      : null,
    sourceCommitArg ? 'cli_arg:source-commit' : null,
    !sourceCommitArg && (process.env.SYNTHI_GPU_AGENT_SOURCE_COMMIT || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_COMMIT)
      ? 'env:SYNTHI_GPU_AGENT_SOURCE_COMMIT'
      : null,
    sourceRootRelativePathArg ? 'cli_arg:source-subtree' : null,
    sourceFileArgs.length > 0 ? 'cli_arg:source-file' : null,
    buildFileArgs.length > 0 ? 'cli_arg:build-file' : null,
    outputOracleKindArg ? 'cli_arg:output-oracle-kind' : null,
    !outputOracleKindArg && outputOracleKindEnv
      ? 'env:SYNTHI_GPU_AGENT_OUTPUT_ORACLE_KIND'
      : null,
  ];
  generatedSourceManifest = synthesizeSourceManifestFromRoot({
    sourceRoot,
    sourceEntry,
    sourceAuthority,
    sourceCommit,
    sourceRootRelativePath,
    selectedSourcePaths,
    selectedBuildPaths,
    inputChannels: directSourceInputChannels,
    outputOracleKind,
    visualProfilePath: profile,
  });
  sourceManifest = generatedSourceManifest.manifestPath;
  console.log(`source-root direct source manifest: ${sourceManifest}`);
}

if (prepareSourceManifestOnly) {
  console.log(JSON.stringify({
    manifestPath: sourceManifest || null,
    manifest: generatedSourceManifest?.manifest ?? null,
    sourceFirstExecutionPolicy,
    source_first_execution_policy: sourceFirstExecutionPolicy,
  }, null, 2));
  process.exit(0);
}

applyLauncherInputs({
  ...launcherInputs,
  sourceManifest,
});

setDefaultEnv('SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS', '1');
setDefaultEnv('SYNTHI_SYNC_TO_GCS', '0');
setDefaultEnv('SYNTHI_VALIDATION_AUTHLESS_WORKSPACE', '1');
setDefaultEnv('SYNTHI_GPU_HMR_STRICT_PROOF_RETRY_TIMEOUT_MS', '240000');
setDefaultEnv('SYNTHI_GPU_VENDOR', vendor);

const agentSplitRunner = await import('./gpu-hmr-agent-split-workspace-test.mjs');
if (typeof agentSplitRunner.main !== 'function') {
  throw new Error('source-first visual proof child runner does not export main()');
}
await agentSplitRunner.main();
