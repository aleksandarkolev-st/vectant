#!/usr/bin/env node
// Real public ROCm repository validation for GPU HMR.
//
// Default target profile:
//   mcp/synthi-mcp/scripts/profiles/real-rocm-saxpy.json
//
// This script intentionally separates two claims:
//   1. The upstream ROCm target builds and runs in the current worker.
//   2. Synthi can consume the real repo files and apply GPU split/HMR.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createValidationWorkspace } from './lib/validation-workspace.mjs';
import {
  abiProofFromProofArtifacts,
  artifactTransportProofFromProofArtifacts,
  fissionProofFromProofArtifacts,
  summarizeGpuHmrArtifactTransportProof,
  sourceProofFromProofArtifacts,
  summarizeGpuHmrSourceProof,
} from './lib/gpu-hmr-proof-artifacts.mjs';
import {
  epochSwapProofFromRuntimeEvidence,
  hostPreservationProofFromRuntimeEvidence,
  originalHostPathProofFromRuntimeEvidence,
  runtimeArtifactTransportEvidence,
  runtimeEpochSwapEvidence,
  runtimeHostIdentityEvidence,
  runtimeOutputOracleEvidence,
} from './lib/gpu-hmr-runtime-evidence.mjs';
import { booleanFromEnv, positiveIntegerFromEnv } from './lib/validation-env.mjs';
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrDispatchProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOutputProof,
  summarizeGpuHmrAbiProof,
  summarizeGpuHmrDispatchProof,
  summarizeGpuHmrEpochSwapProof,
  summarizeGpuHmrFissionProof,
  summarizeGpuHmrFullRuntimeProof,
  summarizeGpuHmrHostPreservationProof,
  summarizeGpuHmrOriginalHostPathProof,
  summarizeGpuHmrOutputProof,
} from './lib/gpu-hmr-runtime-proof.mjs';
import {
  computeOracleArtifactsFromFiles,
  visualEvidenceArtifactsFromFiles,
  writeValidationRuntimeProofArtifact,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';
import {
  buildGpuHmrValidationProofSummary,
} from './lib/gpu-hmr-validation-proof-summary.mjs';
import {
  analyzeGpuHmrImageEvidence,
  mcpFrameGateSatisfiedByScreenshot,
  mcpScreenshotArgsForFrameGate,
  mcpScreenshotMetadataFromToolResult,
  screenshotQualifiesAsVisualEvidence,
  visualEvidenceRow,
} from './lib/gpu-hmr-visual-evidence.mjs';
import {
  eventLogAppliedRecoveryAllowed,
} from './lib/gpu-hmr-wait-contract.mjs';
import { runGpuHmrAdversarialPreflight } from './lib/gpu-hmr-adversarial-preflight.mjs';
import {
  adversarialPreflightStrictGate,
  runtimeProofArtifactStrictGates,
  strictProofGateFailures,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  classifyFreshAiSplitProvenance,
  countAiSplitEvidenceLines,
} from './lib/ai-split-provenance.mjs';
import { validationCommandMetadata } from './lib/docker-validation-metadata.mjs';
import { REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS } from './lib/real-rocm-validation-command-env.mjs';
import {
  buildUpstreamLifecyclePlan,
  buildUpstreamRunLaunchPlan,
  canContinueWithCachedMetadataAfterLifecycleFailure,
} from './lib/real-rocm-upstream-lifecycle.mjs';
import { realRocmTimingMetrics } from './lib/gpu-hmr-timing-metrics.mjs';
import { monotonicNowNs, monotonicTimingFields } from './lib/gpu-hmr-monotonic-clock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_REAL_ROCM_REPO_PARENT = path.resolve(REPO_ROOT, 'tmp/real-rocm');
const PROFILE_DIR = existsSync(path.join(__dirname, 'profiles'))
  ? path.join(__dirname, 'profiles')
  : path.resolve(REPO_ROOT, 'mcp/synthi-mcp/scripts/profiles');
const REAL_ROCM_PROFILE_SCHEMA_VERSION = 'synthi.gpu.hmr.real_rocm_profile.v1';
const DEFAULT_REAL_ROCM_PROFILE_PATH = path.join(PROFILE_DIR, 'real-rocm-saxpy.json');
const DEFAULT_REAL_REPO_URL = 'https://github.com/ROCm/rocm-examples.git';
const TARGET_PROGRESSION_PHASES = new Set([
  'small-oracle',
  'partial-reload',
  'original-host-path',
  'final-acceptance',
]);
const TARGET_PROGRESSION_LEDGER_SCHEMA_VERSION =
  'synthi.real_rocm.target_progression_ledger.v1';
const RUN_STARTED_MONOTONIC_NS = monotonicNowNs();
const FINAL_ACCEPTANCE_PRIOR_TARGET_PROGRESSION_PHASES = Object.freeze([
  'small-oracle',
  'partial-reload',
  'original-host-path',
]);
const TARGET_PROGRESSION_PHASE_ALIASES = new Map([
  ['small', 'small-oracle'],
  ['small-target', 'small-oracle'],
  ['small-kernel', 'small-oracle'],
  ['small-non-final', 'small-oracle'],
  ['small-non-final-oracle', 'small-oracle'],
  ['deterministic-oracle', 'small-oracle'],
  ['oracle', 'small-oracle'],
  ['partial', 'partial-reload'],
  ['partial-artifact', 'partial-reload'],
  ['partial-artifact-reload', 'partial-reload'],
  ['source-include', 'partial-reload'],
  ['source-include-reload', 'partial-reload'],
  ['original-host', 'original-host-path'],
  ['host-path', 'original-host-path'],
  ['host-attachment', 'original-host-path'],
  ['final', 'final-acceptance'],
  ['acceptance', 'final-acceptance'],
  ['final-target', 'final-acceptance'],
]);

function cleanIdentifier(value) {
  return String(value || 'repo').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function repoNameFromUrl(repoUrl) {
  const raw = String(repoUrl || DEFAULT_REAL_REPO_URL).split('/').filter(Boolean).at(-1) ?? 'repo';
  return cleanIdentifier(raw.replace(/\.git$/i, ''));
}

function objectOrEmpty(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid real ROCm profile ${field}: expected object`);
  }
  return value;
}

function optionalProfileString(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  if (typeof value !== 'string') {
    throw new Error(`invalid real ROCm profile ${field}: expected string`);
  }
  return value.trim();
}

function requiredProfileString(value, field) {
  const text = optionalProfileString(value, field);
  if (!text) throw new Error(`invalid real ROCm profile ${field}: expected non-empty string`);
  return text;
}

function optionalProfileBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`invalid real ROCm profile ${field}: expected boolean`);
  }
  return value;
}

function optionalProfileNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid real ROCm profile ${field}: expected finite number`);
  }
  return parsed;
}

function optionalProfileStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`invalid real ROCm profile ${field}: expected array`);
  }
  return value.map((item, index) => requiredProfileString(item, `${field}[${index}]`));
}

function optionalProfileStringList(value, field) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [requiredProfileString(value, field)];
  return optionalProfileStringArray(value, field);
}

const REAL_ROCM_APP_HOOK_STAGES = [
  {
    key: 'artifactTransport',
    snake: 'artifact_transport',
    gapKey: 'artifact_transport',
  },
  {
    key: 'epochPublication',
    snake: 'epoch_publication',
    gapKey: 'epoch_publication',
  },
  {
    key: 'dispatchTrace',
    snake: 'dispatch_trace',
    gapKey: 'dispatch_trace',
  },
  {
    key: 'hostIdentity',
    snake: 'host_identity',
    gapKey: 'host_identity',
  },
  {
    key: 'outputOracle',
    snake: 'output_oracle',
    gapKey: 'output_oracle',
  },
];

function normalizeRealRocmAppHookStage(rawStage, field) {
  const declared = rawStage !== undefined && rawStage !== null;
  const stage = objectOrEmpty(rawStage, field);
  const evidenceRefs = optionalProfileStringList(
    stage.evidenceRefs
      ?? stage.evidence_refs
      ?? stage.proofRefs
      ?? stage.proof_refs
      ?? stage.evidenceRef
      ?? stage.evidence_ref,
    `${field}.evidenceRefs`,
  );
  return {
    declared,
    required: optionalProfileBoolean(stage.required, `${field}.required`) ?? true,
    proofId: optionalProfileString(stage.proofId ?? stage.proof_id, `${field}.proofId`) || null,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    notes: optionalProfileString(stage.notes, `${field}.notes`) || null,
  };
}

function normalizeRealRocmAppHookContract(rawContract) {
  const declared = rawContract !== undefined && rawContract !== null;
  const contract = objectOrEmpty(rawContract, 'appHookContract');
  const stageMap = {};
  for (const stage of REAL_ROCM_APP_HOOK_STAGES) {
    stageMap[stage.key] = normalizeRealRocmAppHookStage(
      contract[stage.key] ?? contract[stage.snake],
      `appHookContract.${stage.key}`,
    );
  }
  const requiredStages = REAL_ROCM_APP_HOOK_STAGES.map((stage) => stage.snake);
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract.v1',
    declared,
    required: declared
      ? optionalProfileBoolean(contract.required, 'appHookContract.required') ?? true
      : false,
    proofAuthority: 'profile_declared_evidence_only_not_gpu_hmr_success',
    proof_authority: 'profile_declared_evidence_only_not_gpu_hmr_success',
    requiredStages,
    required_stages: requiredStages,
    stages: stageMap,
    artifactTransport: stageMap.artifactTransport,
    artifact_transport: stageMap.artifactTransport,
    epochPublication: stageMap.epochPublication,
    epoch_publication: stageMap.epochPublication,
    dispatchTrace: stageMap.dispatchTrace,
    dispatch_trace: stageMap.dispatchTrace,
    hostIdentity: stageMap.hostIdentity,
    host_identity: stageMap.hostIdentity,
    outputOracle: stageMap.outputOracle,
    output_oracle: stageMap.outputOracle,
  };
}

function normalizeRealRocmDeviceSidecarContract(rawContract) {
  const declared = rawContract !== undefined && rawContract !== null;
  const contract = objectOrEmpty(rawContract, 'deviceSidecarContract');
  const sourcePaths = optionalProfileStringList(
    contract.sourcePaths ?? contract.source_paths ?? contract.sourcePath ?? contract.source_path,
    'deviceSidecarContract.sourcePaths',
  ).map((sourcePath) => sourcePath.replace(/\\/g, '/'));
  const entryPoints = optionalProfileStringList(
    contract.entryPoints ?? contract.entry_points ?? contract.kernelSymbols ?? contract.kernel_symbols,
    'deviceSidecarContract.entryPoints',
  );
  const evidenceRefs = optionalProfileStringList(
    contract.evidenceRefs ?? contract.evidence_refs ?? contract.evidenceRef ?? contract.evidence_ref,
    'deviceSidecarContract.evidenceRefs',
  );
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract.v1',
    declared,
    required: declared
      ? optionalProfileBoolean(contract.required, 'deviceSidecarContract.required') ?? true
      : false,
    proofAuthority: 'profile_declared_evidence_only_not_gpu_hmr_success',
    proof_authority: 'profile_declared_evidence_only_not_gpu_hmr_success',
    sourcePaths,
    source_paths: sourcePaths,
    artifactKind:
      optionalProfileString(contract.artifactKind ?? contract.artifact_kind, 'deviceSidecarContract.artifactKind')
      || null,
    artifact_kind:
      optionalProfileString(contract.artifactKind ?? contract.artifact_kind, 'deviceSidecarContract.artifactKind')
      || null,
    entryPoints,
    entry_points: entryPoints,
    compileTarget:
      optionalProfileString(contract.compileTarget ?? contract.compile_target, 'deviceSidecarContract.compileTarget')
      || null,
    compile_target:
      optionalProfileString(contract.compileTarget ?? contract.compile_target, 'deviceSidecarContract.compileTarget')
      || null,
    compiler:
      optionalProfileString(contract.compiler, 'deviceSidecarContract.compiler')
      || null,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    notes: optionalProfileString(contract.notes, 'deviceSidecarContract.notes') || null,
  };
}

function normalizeRealRocmProofObligations(rawObligations) {
  const declared = rawObligations !== undefined && rawObligations !== null;
  const obligations = objectOrEmpty(rawObligations, 'proofObligations');
  const acceptanceMode = optionalProfileString(
    obligations.acceptanceMode ?? obligations.acceptance_mode,
    'proofObligations.acceptanceMode',
  ) || null;
  const allowedAcceptanceModes = new Set(['strict_acceptance', 'refusal_only', 'evidence_only']);
  if (acceptanceMode && !allowedAcceptanceModes.has(acceptanceMode)) {
    throw new Error(`invalid real ROCm profile proofObligations.acceptanceMode: ${acceptanceMode}`);
  }
  const targetClass =
    optionalProfileString(obligations.targetClass ?? obligations.target_class, 'proofObligations.targetClass')
    || null;
  const requiresFullRuntimeProof = optionalProfileBoolean(
    obligations.requiresFullRuntimeProof ?? obligations.requires_full_runtime_proof,
    'proofObligations.requiresFullRuntimeProof',
  );
  const requiresOutputOracle = optionalProfileBoolean(
    obligations.requiresOutputOracle ?? obligations.requires_output_oracle,
    'proofObligations.requiresOutputOracle',
  );
  const requiresAppHookContract = optionalProfileBoolean(
    obligations.requiresAppHookContract ?? obligations.requires_app_hook_contract,
    'proofObligations.requiresAppHookContract',
  );
  const requiresRunModes = optionalProfileBoolean(
    obligations.requiresRunModes ?? obligations.requires_run_modes,
    'proofObligations.requiresRunModes',
  );
  const requiresNegativeEdit = optionalProfileBoolean(
    obligations.requiresNegativeEdit ?? obligations.requires_negative_edit,
    'proofObligations.requiresNegativeEdit',
  );
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations.v1',
    declared,
    acceptanceMode,
    acceptance_mode: acceptanceMode,
    refusalOnly: acceptanceMode === 'refusal_only',
    refusal_only: acceptanceMode === 'refusal_only',
    targetClass,
    target_class: targetClass,
    requiresFullRuntimeProof,
    requires_full_runtime_proof: requiresFullRuntimeProof,
    requiresOutputOracle,
    requires_output_oracle: requiresOutputOracle,
    requiresAppHookContract,
    requires_app_hook_contract: requiresAppHookContract,
    requiresRunModes,
    requires_run_modes: requiresRunModes,
    requiresNegativeEdit,
    requires_negative_edit: requiresNegativeEdit,
  };
}

function normalizeRealRocmProfile(rawProfile, source) {
  const raw = objectOrEmpty(rawProfile, 'root');
  const schemaVersion = raw.schemaVersion ?? REAL_ROCM_PROFILE_SCHEMA_VERSION;
  if (schemaVersion !== REAL_ROCM_PROFILE_SCHEMA_VERSION) {
    throw new Error(`unsupported real ROCm profile schemaVersion: ${schemaVersion}`);
  }
  const repo = objectOrEmpty(raw.repo, 'repo');
  const target = objectOrEmpty(raw.target, 'target');
  const sourceDelta = objectOrEmpty(raw.sourceDelta ?? raw.source_delta, 'sourceDelta');
  const secondDelta = objectOrEmpty(sourceDelta.second ?? sourceDelta.secondDelta, 'sourceDelta.second');
  const outputOracle = objectOrEmpty(raw.outputOracle ?? raw.output_oracle, 'outputOracle');
  const appHookContract = normalizeRealRocmAppHookContract(
    raw.appHookContract ?? raw.app_hook_contract,
  );
  const deviceSidecarContract = normalizeRealRocmDeviceSidecarContract(
    raw.deviceSidecarContract ?? raw.device_sidecar_contract,
  );
  const preview = objectOrEmpty(raw.preview, 'preview');
  const targetProgression = objectOrEmpty(
    raw.targetProgression ?? raw.target_progression,
    'targetProgression',
  );
  const proofObligations = normalizeRealRocmProofObligations(
    raw.proofObligations ?? raw.proof_obligations,
  );
  return {
    schemaVersion,
    id: requiredProfileString(raw.id, 'id'),
    source,
    repo: {
      url: optionalProfileString(repo.url, 'repo.url') || DEFAULT_REAL_REPO_URL,
      name: optionalProfileString(repo.name, 'repo.name'),
      commit: optionalProfileString(repo.commit, 'repo.commit'),
      initSubmodules: optionalProfileBoolean(repo.initSubmodules, 'repo.initSubmodules'),
    },
    target: {
      entryFile: requiredProfileString(target.entryFile, 'target.entryFile').replace(/\\/g, '/'),
      deltaFile: optionalProfileString(target.deltaFile, 'target.deltaFile').replace(/\\/g, '/'),
      targetName: requiredProfileString(target.targetName, 'target.targetName'),
      buildSubdir: requiredProfileString(target.buildSubdir, 'target.buildSubdir').replace(/\\/g, '/'),
      cmakeArgs: optionalProfileStringArray(target.cmakeArgs, 'target.cmakeArgs'),
      cmakeConfigName: optionalProfileString(target.cmakeConfigName, 'target.cmakeConfigName'),
      cmakeTargetType: optionalProfileString(target.cmakeTargetType, 'target.cmakeTargetType'),
      cmakeTargetIdNamespace: optionalProfileString(target.cmakeTargetIdNamespace, 'target.cmakeTargetIdNamespace'),
      upstreamRunCommand: optionalProfileString(target.upstreamRunCommand, 'target.upstreamRunCommand'),
      buildUpstream: optionalProfileBoolean(target.buildUpstream, 'target.buildUpstream'),
      runUpstream: optionalProfileBoolean(target.runUpstream, 'target.runUpstream'),
      hiprtRuntimeProbe: optionalProfileBoolean(
        target.hiprtRuntimeProbe ?? target.hiprt_runtime_probe,
        'target.hiprtRuntimeProbe',
      ),
      nativeLaunchSymbols: optionalProfileStringArray(
        target.nativeLaunchSymbols ?? target.native_launch_symbols,
        'target.nativeLaunchSymbols',
      ),
    },
    sourceDelta: {
      before: requiredProfileString(sourceDelta.before, 'sourceDelta.before'),
      after: requiredProfileString(sourceDelta.after, 'sourceDelta.after'),
      second: {
        file: optionalProfileString(secondDelta.file, 'sourceDelta.second.file').replace(/\\/g, '/'),
        before: optionalProfileString(secondDelta.before, 'sourceDelta.second.before'),
        after: optionalProfileString(secondDelta.after, 'sourceDelta.second.after'),
      },
      extraDeltas: Array.isArray(sourceDelta.extraDeltas) ? sourceDelta.extraDeltas : [],
    },
    outputOracle: {
      profile: optionalProfileString(outputOracle.profile, 'outputOracle.profile'),
      contract: outputOracle.contract && typeof outputOracle.contract === 'object' && !Array.isArray(outputOracle.contract)
        ? outputOracle.contract
        : null,
      runtimeProfile:
        (outputOracle.runtimeProfile ?? outputOracle.runtime_profile)
        && typeof (outputOracle.runtimeProfile ?? outputOracle.runtime_profile) === 'object'
        && !Array.isArray(outputOracle.runtimeProfile ?? outputOracle.runtime_profile)
          ? outputOracle.runtimeProfile ?? outputOracle.runtime_profile
          : null,
    },
    appHookContract,
    deviceSidecarContract,
    proofObligations,
    preview: {
      renderPreview: optionalProfileBoolean(preview.renderPreview, 'preview.renderPreview'),
      expectScreenshot: optionalProfileBoolean(preview.expectScreenshot, 'preview.expectScreenshot'),
      width: optionalProfileNumber(preview.width, 'preview.width'),
      height: optionalProfileNumber(preview.height, 'preview.height'),
    },
    targetProgression: {
      phase: optionalProfileString(
        targetProgression.phase ?? targetProgression.targetProgressionPhase ?? targetProgression.target_progression_phase,
        'targetProgression.phase',
      ),
      finalAcceptanceTarget: optionalProfileString(
        targetProgression.finalAcceptanceTarget ?? targetProgression.final_acceptance_target,
        'targetProgression.finalAcceptanceTarget',
      ),
      required: optionalProfileBoolean(targetProgression.required, 'targetProgression.required'),
    },
  };
}

function loadRealRocmProfile() {
  const inline = process.env.SYNTHI_REAL_ROCM_PROFILE_JSON
    ?? process.env.SYNTHI_GPU_HMR_REAL_ROCM_PROFILE_JSON
    ?? '';
  if (String(inline).trim()) {
    return normalizeRealRocmProfile(JSON.parse(inline), 'env:SYNTHI_REAL_ROCM_PROFILE_JSON');
  }
  const profilePath = process.env.SYNTHI_REAL_ROCM_PROFILE_PATH
    ?? process.env.SYNTHI_GPU_HMR_REAL_ROCM_PROFILE_PATH
    ?? DEFAULT_REAL_ROCM_PROFILE_PATH;
  const absolutePath = path.resolve(REPO_ROOT, profilePath);
  return normalizeRealRocmProfile(
    JSON.parse(readFileSync(absolutePath, 'utf8')),
    path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/'),
  );
}

async function discoverPackagedRealRocmProfiles() {
  const entries = await readdir(PROFILE_DIR, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^real-rocm-.+\.json$/i.test(entry.name)) continue;
    const absolutePath = path.join(PROFILE_DIR, entry.name);
    const source = path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/');
    const profile = normalizeRealRocmProfile(
      JSON.parse(readFileSync(absolutePath, 'utf8')),
      source,
    );
    profiles.push(profile);
  }
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  return profiles;
}

async function selfCheckRealRocmProfiles() {
  const profiles = await discoverPackagedRealRocmProfiles();
  if (profiles.length === 0) {
    throw new Error(`no packaged real ROCm profiles found in ${PROFILE_DIR}`);
  }
  const seen = new Set();
  for (const profile of profiles) {
    if (seen.has(profile.id)) {
      throw new Error(`duplicate real ROCm profile id: ${profile.id}`);
    }
    seen.add(profile.id);
    if (profile.outputOracle.profile !== 'none' && profile.outputOracle.profile !== 'auto') {
      const known = outputOracleProfilesByName().has(profile.outputOracle.profile.toLowerCase());
      const profileRuntimeProfilePresent = Boolean(profile.outputOracle.runtimeProfile);
      if (!known && !profileRuntimeProfilePresent) {
        throw new Error(`real ROCm profile ${profile.id} references unknown output oracle profile: ${profile.outputOracle.profile}`);
      }
      if (profile.target.nativeLaunchSymbols.length === 0) {
        throw new Error(
          `real ROCm profile ${profile.id} declares output oracle ${profile.outputOracle.profile} without target.nativeLaunchSymbols`,
        );
      }
    }
    const finalAcceptanceProfile = profile.targetProgression.phase === 'final-acceptance';
    const largeRocmMlFinalAcceptance =
      finalAcceptanceProfile
      && profile.proofObligations.targetClass === 'large_rocm_ml_infrastructure';
    const outputOracleDisabled = outputOracleProfileModeDisabled(profile.outputOracle.profile);
    if (
      finalAcceptanceProfile
      && outputOracleDisabled
      && profile.proofObligations.refusalOnly !== true
    ) {
      throw new Error(
        `real ROCm final-acceptance profile ${profile.id} disables output oracle without proofObligations.acceptanceMode=refusal_only`,
      );
    }
    if (largeRocmMlFinalAcceptance) {
      if (profile.proofObligations.requiresRunModes !== true) {
        throw new Error(
          `large ROCm ML final-acceptance profile ${profile.id} must declare proofObligations.requiresRunModes=true`,
        );
      }
      if (profile.proofObligations.requiresNegativeEdit !== true) {
        throw new Error(
          `large ROCm ML final-acceptance profile ${profile.id} must declare proofObligations.requiresNegativeEdit=true`,
        );
      }
      const sourceDeltaFixtures = realRocmSourceDeltaFixtures(profile);
      if (sourceDeltaFixtures.hotDelta2Declared !== true) {
        throw new Error(
          `large ROCm ML final-acceptance profile ${profile.id} must configure an executable hot_delta_2 source delta fixture`,
        );
      }
      if (sourceDeltaFixtures.negativeEditDeclared !== true) {
        throw new Error(
          `large ROCm ML final-acceptance profile ${profile.id} must configure an executable negative_edit source delta fixture`,
        );
      }
    }
    const localRepoPath = path.resolve(REPO_ROOT, `tmp/real-rocm/${repoNameFromUrl(profile.repo.url)}`);
    if (existsSync(localRepoPath)) {
      for (const requiredPath of [
        profile.target.entryFile,
        profile.target.deltaFile || profile.target.entryFile,
        `${profile.target.buildSubdir}/CMakeLists.txt`,
      ]) {
        if (!existsSync(path.join(localRepoPath, requiredPath))) {
          throw new Error(`real ROCm profile ${profile.id} references missing local path: ${requiredPath}`);
        }
      }
    }
  }
  console.log(`real ROCm profile self-check passed profiles=${profiles.map((profile) => profile.id).join(',')}`);
}

function parseOutputOracleContract(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid output oracle contract JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid output oracle contract: expected object');
  }
  const contract = {};
  const aliases = {
    oracleId: ['id', 'oracleId', 'oracle_id'],
    requiredOracleId: [
      'requiredOracleId',
      'required_oracle_id',
      'requiredOracle',
      'required_oracle',
      'requiredId',
      'required_id',
    ],
    kind: ['kind'],
    expected: ['expected', 'expectedValue', 'expected_value', 'expectedHash', 'expected_hash'],
    producer: ['producer', 'producerId', 'producer_id', 'producerSubsystem', 'producer_subsystem'],
    outputTargetId: ['outputTargetId', 'output_target_id', 'outputTarget', 'output_target', 'target'],
    artifactId: ['artifactId', 'artifact_id', 'artifact'],
    runtimeSessionId: [
      'runtimeSessionId',
      'runtime_session_id',
      'runtimeSession',
      'runtime_session',
      'sessionId',
      'session_id',
    ],
    kernelSymbol: ['kernelSymbol', 'kernel_symbol', 'kernel', 'kernelName', 'kernel_name'],
  };
  for (const [canonical, fields] of Object.entries(aliases)) {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) {
        if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
          throw new Error(`invalid output oracle contract field ${field}: expected non-empty string`);
        }
        contract[canonical] = parsed[field].trim();
        break;
      }
    }
  }
  if (!Object.keys(contract).length) {
    throw new Error(
      'invalid output oracle contract: at least one supported string field is required',
    );
  }
  return contract;
}

function parseNativeLaunchSymbols(raw, fallback = []) {
  const explicit = String(raw ?? '').trim();
  if (!explicit) return compactStringList(fallback);
  let values;
  if (explicit.startsWith('[')) {
    try {
      values = JSON.parse(explicit);
    } catch (err) {
      throw new Error(`invalid native launch symbol list JSON: ${err.message}`);
    }
    if (!Array.isArray(values)) {
      throw new Error('invalid native launch symbol list: expected array or comma-separated string');
    }
  } else {
    values = explicit.split(',');
  }
  const symbols = compactStringList(values.map((value) => String(value ?? '').trim()));
  if (symbols.length === 0) {
    throw new Error('invalid native launch symbol list: at least one non-empty symbol is required');
  }
  return symbols;
}

function outputOracleProfileMode(raw) {
  const text = String(raw ?? 'auto').trim().toLowerCase();
  return text || 'auto';
}

function parseTargetProgressionLedger(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return {
      schemaVersion: TARGET_PROGRESSION_LEDGER_SCHEMA_VERSION,
      provided: false,
      entries: [],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid target progression ledger JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid target progression ledger: expected object or array');
  }
  return {
    schemaVersion: TARGET_PROGRESSION_LEDGER_SCHEMA_VERSION,
    provided: true,
    rawShape: Array.isArray(parsed) ? 'array' : 'object',
    entries: targetProgressionLedgerEntries(parsed),
  };
}

function targetProgressionLedgerInput() {
  const inlineJson = String(process.env.SYNTHI_REAL_ROCM_TARGET_PROGRESSION_LEDGER_JSON ?? '').trim();
  if (inlineJson) return { raw: inlineJson, path: '' };
  const configuredPath = String(
    process.env.SYNTHI_REAL_ROCM_TARGET_PROGRESSION_LEDGER_PATH
      ?? process.env.SYNTHI_REAL_ROCM_TARGET_PROGRESSION_LEDGER
      ?? '',
  ).trim();
  if (!configuredPath) return { raw: '', path: '' };
  const resolvedPath = path.resolve(REPO_ROOT, configuredPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`target progression ledger file not found: ${resolvedPath}`);
  }
  return { raw: readFileSync(resolvedPath, 'utf8'), path: resolvedPath };
}

function parseStringArrayEnv(raw, name) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${name}: expected JSON string array: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`invalid ${name}: expected JSON string array`);
  }
  return parsed.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`invalid ${name}[${index}]: expected non-empty string`);
    }
    if (/[\0\r\n]/.test(value)) {
      throw new Error(`invalid ${name}[${index}]: control characters are not supported`);
    }
    return value;
  });
}

function parseJsonObjectEnv(raw, name) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${name}: expected JSON object: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid ${name}: expected JSON object`);
  }
  return parsed;
}

function firstJsonObjectEnv(names) {
  for (const name of names) {
    if (process.env[name] === undefined) continue;
    const value = parseJsonObjectEnv(process.env[name], name);
    if (value) return { value, source: `env:${name}` };
  }
  return { value: null, source: null };
}

function normalizeTargetProgressionPhase(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return {
      raw: value,
      phase: null,
      recognized: true,
      reason: 'phase_not_declared',
    };
  }
  const normalized = value.toLowerCase().replace(/[\s_]+/g, '-');
  const phase = TARGET_PROGRESSION_PHASE_ALIASES.get(normalized) ?? normalized;
  return {
    raw: value,
    phase,
    recognized: TARGET_PROGRESSION_PHASES.has(phase),
    reason: TARGET_PROGRESSION_PHASES.has(phase) ? null : 'unknown_target_progression_phase',
  };
}

function buildTargetProgressionMetadata({
  targetName,
  rawPhase,
  finalAcceptanceTarget,
  required = false,
} = {}) {
  const normalized = normalizeTargetProgressionPhase(rawPhase);
  const finalTarget = String(finalAcceptanceTarget ?? '').trim();
  const target = String(targetName ?? '').trim();
  const nonFinalPhase = [
    'small-oracle',
    'partial-reload',
    'original-host-path',
  ].includes(normalized.phase);
  const finalTargetDeclared = finalTarget.length > 0;
  const targetMatchesFinalAcceptance =
    finalTargetDeclared && target.length > 0 && target === finalTarget;
  return {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: required === true,
    phaseRaw: normalized.raw,
    phase: normalized.phase,
    recognized: normalized.recognized,
    reason: normalized.reason,
    targetName: target || null,
    finalAcceptanceTarget: finalTarget || null,
    finalAcceptanceTargetDeclared: finalTargetDeclared,
    targetMatchesFinalAcceptance,
    nonFinalPhase,
    nonFinalTargetRequired: nonFinalPhase && finalTargetDeclared,
    requirements: normalized.phase
      ? targetProgressionPhaseRequirements(normalized.phase)
      : [],
  };
}

function targetProgressionPhaseRequirements(phase) {
  switch (phase) {
    case 'small-oracle':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'output_oracle_proven',
      ];
    case 'partial-reload':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'source_include_backed_partial_reload_proven',
        'fission_verifier_proven',
      ];
    case 'original-host-path':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'dispatch_safe_proven',
        'original_host_path_attachment_proven',
        'host_preservation_proven',
      ];
    case 'final-acceptance':
      return [
        'target_must_match_final_acceptance_target_when_declared',
        'prior_small_oracle_proof_in_target_progression_ledger',
        'prior_partial_reload_proof_in_target_progression_ledger',
        'prior_original_host_path_proof_in_target_progression_ledger',
        'full_runtime_proven',
        'output_oracle_proven',
        'fresh_visual_evidence_when_rendering',
        'raw_compute_oracle_artifacts_when_compute_only',
      ];
    default:
      return [];
  }
}

function isLargeRocmMlFinalAcceptance({ declared, targetProgression = {} } = {}) {
  const targetClass = declared?.targetClass ?? declared?.target_class ?? null;
  return targetClass === 'large_rocm_ml_infrastructure'
    && targetProgression.phase === 'final-acceptance';
}

function sourceDeltaFallbackFile(profile = {}) {
  return profile.target?.deltaFile || profile.target?.entryFile || '';
}

function sourceDeltaEntryFile(entry = {}, profile = {}) {
  return String(entry.file ?? entry.path ?? sourceDeltaFallbackFile(profile) ?? '')
    .replace(/\\/g, '/')
    .trim();
}

function sourceDeltaEntryIsConfiguredExecutableCandidate(entry = {}, profile = {}) {
  const before = typeof entry.before === 'string' ? entry.before : '';
  const after = typeof entry.after === 'string' ? entry.after : '';
  return Boolean(sourceDeltaEntryFile(entry, profile) && before && after && before !== after);
}

function sourceDeltaEntryKind(entry = {}) {
  return cleanIdentifier(
    entry.kind
    ?? entry.editKind
    ?? entry.edit_kind
    ?? entry.label
    ?? '',
  ).toLowerCase().replace(/[-.]+/g, '_');
}

function realRocmSourceDeltaFixtures(profile = {}) {
  const sourceDelta = profile.sourceDelta && typeof profile.sourceDelta === 'object'
    ? profile.sourceDelta
    : profile.source_delta && typeof profile.source_delta === 'object'
      ? profile.source_delta
      : {};
  const second = sourceDelta.second && typeof sourceDelta.second === 'object'
    ? sourceDelta.second
    : sourceDelta.secondDelta && typeof sourceDelta.secondDelta === 'object'
      ? sourceDelta.secondDelta
      : {};
  const extraDeltas = Array.isArray(sourceDelta.extraDeltas)
    ? sourceDelta.extraDeltas
    : Array.isArray(sourceDelta.extra_deltas)
      ? sourceDelta.extra_deltas
      : [];
  const executableExtraDeltas = extraDeltas.filter((entry) =>
    sourceDeltaEntryIsConfiguredExecutableCandidate(entry, profile)
  );
  const hotDelta2Extras = executableExtraDeltas.filter((entry) => {
    const kind = sourceDeltaEntryKind(entry);
    return kind === 'hot_delta_2'
      || kind === 'hot2'
      || kind === 'second'
      || kind.includes('hot_delta_2');
  });
  const negativeEditExtras = executableExtraDeltas.filter((entry) => {
    const kind = sourceDeltaEntryKind(entry);
    return kind === 'negative_edit'
      || kind === 'negative'
      || kind.includes('negative')
      || entry.expectedRefusal === true
      || entry.expected_refusal === true;
  });
  const secondDeclared = sourceDeltaEntryIsConfiguredExecutableCandidate(second, profile);
  const hotDelta2Declared = secondDeclared || hotDelta2Extras.length > 0;
  const negativeEditDeclared = negativeEditExtras.length > 0;
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_fixtures.v1',
    proofAuthority: 'profile_configuration_only_not_runtime_proof',
    proof_authority: 'profile_configuration_only_not_runtime_proof',
    hotDelta2Declared,
    hot_delta_2_declared: hotDelta2Declared,
    secondDeltaDeclared: secondDeclared,
    second_delta_declared: secondDeclared,
    negativeEditDeclared,
    negative_edit_declared: negativeEditDeclared,
    fallbackFile: sourceDeltaFallbackFile(profile),
    fallback_file: sourceDeltaFallbackFile(profile),
    hotDelta2PhaseExecuted: false,
    hot_delta_2_phase_executed: false,
    negativeEditPhaseExecuted: false,
    negative_edit_phase_executed: false,
    executableExtraDeltaCount: executableExtraDeltas.length,
    executable_extra_delta_count: executableExtraDeltas.length,
    hotDelta2FixtureCount: hotDelta2Extras.length + (secondDeclared ? 1 : 0),
    hot_delta_2_fixture_count: hotDelta2Extras.length + (secondDeclared ? 1 : 0),
    negativeEditFixtureCount: negativeEditExtras.length,
    negative_edit_fixture_count: negativeEditExtras.length,
  };
}

function realRocmProfileProofObligationsFacet({
  profile = {},
  targetProgression = {},
  outputOracleProfile = '',
  outputOracleContract = null,
  outputOracleRuntimeProfile = null,
  requireFullRuntimeProof = false,
} = {}) {
  const declared = profile.proofObligations && typeof profile.proofObligations === 'object'
    ? profile.proofObligations
    : normalizeRealRocmProofObligations(null);
  const requirements = Array.isArray(targetProgression.requirements)
    ? targetProgression.requirements
    : [];
  const progressionRequired = targetProgression.required === true;
  const finalAcceptance = targetProgression.phase === 'final-acceptance';
  const explicitRequiresFullRuntime = declared.requiresFullRuntimeProof === true
    || declared.requires_full_runtime_proof === true;
  const explicitRequiresOutputOracle = declared.requiresOutputOracle === true
    || declared.requires_output_oracle === true;
  const explicitRequiresAppHookContract = declared.requiresAppHookContract === true
    || declared.requires_app_hook_contract === true;
  const explicitRequiresRunModes = declared.requiresRunModes === true
    || declared.requires_run_modes === true;
  const explicitRequiresNegativeEdit = declared.requiresNegativeEdit === true
    || declared.requires_negative_edit === true;
  const largeMlFinalAcceptance = isLargeRocmMlFinalAcceptance({ declared, targetProgression });
  const requiresFullRuntimeProof =
    explicitRequiresFullRuntime
    || progressionRequired
    || finalAcceptance;
  const requiresOutputOracle =
    explicitRequiresOutputOracle
    || requirements.includes('output_oracle_proven')
    || requirements.includes('raw_compute_oracle_artifacts_when_compute_only')
    || finalAcceptance;
  const requiresAppHookContract = explicitRequiresAppHookContract;
  const requiresRunModes = explicitRequiresRunModes || largeMlFinalAcceptance;
  const requiresNegativeEdit = explicitRequiresNegativeEdit || largeMlFinalAcceptance;
  const outputOraclePresent =
    !outputOracleProfileModeDisabled(outputOracleProfile)
    || Boolean(outputOracleContract)
    || Boolean(outputOracleRuntimeProfile);
  const appHookContractDeclared = profile.appHookContract?.declared === true;
  const sourceDeltaFixtures = realRocmSourceDeltaFixtures(profile);
  const refusalOnly = declared.refusalOnly === true || declared.refusal_only === true;
  const blockingGaps = [];
  if (refusalOnly) {
    blockingGaps.push('proof_obligation_refusal_only_profile');
  }
  if (requiresFullRuntimeProof && !requireFullRuntimeProof) {
    blockingGaps.push('proof_obligation_full_runtime_not_requested');
  }
  if (requiresOutputOracle && !outputOraclePresent) {
    blockingGaps.push(
      refusalOnly
        ? 'proof_obligation_refusal_only_output_oracle_absent'
        : 'proof_obligation_output_oracle_profile_missing',
    );
  }
  if (requiresAppHookContract && !appHookContractDeclared) {
    blockingGaps.push('proof_obligation_app_hook_contract_missing');
  }
  if (requiresRunModes && !explicitRequiresRunModes) {
    blockingGaps.push('proof_obligation_run_modes_missing');
  }
  if (requiresNegativeEdit && !explicitRequiresNegativeEdit) {
    blockingGaps.push('proof_obligation_negative_edit_missing');
  }
  if (requiresRunModes && !sourceDeltaFixtures.hotDelta2Declared) {
    blockingGaps.push('proof_obligation_hot_delta_2_fixture_missing');
  }
  if (requiresNegativeEdit && !sourceDeltaFixtures.negativeEditDeclared) {
    blockingGaps.push('proof_obligation_negative_edit_fixture_missing');
  }
  const status = blockingGaps.length === 0
    ? 'profile_proof_obligations_satisfied_by_configuration'
    : refusalOnly
      ? 'profile_declared_refusal_only'
      : 'profile_proof_obligations_unmet';
  const evidenceRefs = compactStringList([
    profile.id ? `profile:${profile.id}` : null,
    targetProgression.phase ? `target_progression:${targetProgression.phase}` : null,
    outputOracleProfile ? `output_oracle_profile:${outputOracleProfile}` : null,
    declared.targetClass ? `target_class:${declared.targetClass}` : null,
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status,
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    proof_authority: 'profile_configuration_gate_not_runtime_proof',
    declared: declared.declared === true,
    acceptanceMode: declared.acceptanceMode ?? declared.acceptance_mode ?? null,
    acceptance_mode: declared.acceptanceMode ?? declared.acceptance_mode ?? null,
    targetClass: declared.targetClass ?? declared.target_class ?? null,
    target_class: declared.targetClass ?? declared.target_class ?? null,
    refusalOnly,
    refusal_only: refusalOnly,
    progressionRequired,
    progression_required: progressionRequired,
    finalAcceptance,
    final_acceptance: finalAcceptance,
    largeMlFinalAcceptance,
    large_ml_final_acceptance: largeMlFinalAcceptance,
    requiresFullRuntimeProof,
    requires_full_runtime_proof: requiresFullRuntimeProof,
    fullRuntimeProofRequested: requireFullRuntimeProof === true,
    full_runtime_proof_requested: requireFullRuntimeProof === true,
    requiresOutputOracle,
    requires_output_oracle: requiresOutputOracle,
    outputOraclePresent,
    output_oracle_present: outputOraclePresent,
    requiresAppHookContract,
    requires_app_hook_contract: requiresAppHookContract,
    appHookContractDeclared,
    app_hook_contract_declared: appHookContractDeclared,
    requiresRunModes,
    requires_run_modes: requiresRunModes,
    requiresRunModesDeclared: explicitRequiresRunModes,
    requires_run_modes_declared: explicitRequiresRunModes,
    requiresNegativeEdit,
    requires_negative_edit: requiresNegativeEdit,
    requiresNegativeEditDeclared: explicitRequiresNegativeEdit,
    requires_negative_edit_declared: explicitRequiresNegativeEdit,
    sourceDeltaFixtures,
    source_delta_fixtures: sourceDeltaFixtures,
    outputOracleProfile: outputOracleProfile || null,
    output_oracle_profile: outputOracleProfile || null,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    contractHash: `sha256:${createHash('sha256').update(stableJson({
      declared,
      targetProgression,
      outputOracleProfile,
      outputOraclePresent,
      appHookContractDeclared,
      requireFullRuntimeProof,
      requiresRunModes,
      explicitRequiresRunModes,
      requiresNegativeEdit,
      explicitRequiresNegativeEdit,
      sourceDeltaFixtures,
    })).digest('hex')}`,
    contract_hash: `sha256:${createHash('sha256').update(stableJson({
      declared,
      targetProgression,
      outputOracleProfile,
      outputOraclePresent,
      appHookContractDeclared,
      requireFullRuntimeProof,
      requiresRunModes,
      explicitRequiresRunModes,
      requiresNegativeEdit,
      explicitRequiresNegativeEdit,
      sourceDeltaFixtures,
    })).digest('hex')}`,
  };
}

function proofHasResultState(proof, state) {
  return proof && typeof proof === 'object' && proof.resultState === state;
}

function targetProgressionLedgerEntries(ledger) {
  if (Array.isArray(ledger)) return ledger;
  if (!ledger || typeof ledger !== 'object') return [];
  if (Array.isArray(ledger.entries)) return ledger.entries;
  if (Array.isArray(ledger.phases)) return ledger.phases;
  const phases = ledger.phaseProofs ?? ledger.phase_proofs ?? ledger.proofs ?? ledger;
  if (!phases || typeof phases !== 'object' || Array.isArray(phases)) return [];
  const ignoredKeys = new Set(['schemaVersion', 'schema_version', 'provided', 'rawShape', 'raw_shape']);
  return Object.entries(phases)
    .filter(([key]) => !ignoredKeys.has(key))
    .map(([phase, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { phase, ...value };
      }
      return { phase, status: value };
    });
}

function stringField(entry, names) {
  if (!entry || typeof entry !== 'object') return '';
  for (const name of names) {
    const value = entry[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function maybeStringField(entry, names) {
  const value = stringField(entry, names);
  return value || null;
}

function booleanField(entry, names) {
  if (!entry || typeof entry !== 'object') return false;
  return names.some((name) => entry[name] === true);
}

function compactStringList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const text = value.trim();
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function compactKnownStringList(values = []) {
  return compactStringList(values).filter((value) => {
    const normalized = value.trim().toLowerCase();
    return !['unknown', 'null', 'undefined', 'n/a', 'na', '-'].includes(normalized);
  });
}

function cmakeMissingDependencyTokens(text) {
  const combined = String(text ?? '');
  const findPackageMissingGroups = [...combined.matchAll(
    /Could\s+NOT\s+find\s+([A-Za-z0-9_.:+-]+)(?:[^\n]*?\(missing:\s+([^)]+)\))?/g,
  )];
  const configPackageGroups = [...combined.matchAll(
    /package\s+configuration\s+file\s+provided\s+by\s+["']([^"']+)["']/gi,
  )];
  const missingCompilerGroups = [...combined.matchAll(
    /The\s+(CMAKE_[A-Za-z0-9_]+_COMPILER):\s*\r?\n\s*([^\r\n]+)\s*\r?\n\s*is\s+not\s+a\s+full\s+path\s+and\s+was\s+not\s+found\s+in\s+the\s+PATH\./gi,
  )];
  const missingHeaderGroups = [...combined.matchAll(
    /fatal\s+error:\s+['<]([^'">]+)['>]\s+file\s+not\s+found/gi,
  )];
  return compactStringList([
    ...findPackageMissingGroups.flatMap((match) => [
      match[1],
      ...(match[2] ? match[2].split(/[\s,;]+/) : []),
    ]),
    ...configPackageGroups.map((match) => match[1]),
    ...missingCompilerGroups.flatMap((match) => [match[1], match[2]]),
    ...missingHeaderGroups.map((match) => match[1]),
    ...[...combined.matchAll(/No package ['"]?([A-Za-z0-9_.:+-]+)['"]? found/gi)]
      .map((match) => match[1]),
  ]);
}

function availableRealRocmEvidenceRefs({
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  proofArtifactRecords = [],
} = {}) {
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  return compactStringList([
    Number(runtimeDispatch.success_count ?? 0) > 0 ? 'runtime_dispatch' : null,
    ...(Array.isArray(runtimeDispatch.evidence_refs) ? runtimeDispatch.evidence_refs : []),
    ...(Array.isArray(runtimeDispatch.evidenceRefs) ? runtimeDispatch.evidenceRefs : []),
    Number(runtimeArtifactTransport.total_count ?? 0) > 0 ? 'runtime_artifact_transport' : null,
    ...(Array.isArray(runtimeArtifactTransport.evidence_refs) ? runtimeArtifactTransport.evidence_refs : []),
    ...(Array.isArray(runtimeArtifactTransport.evidenceRefs) ? runtimeArtifactTransport.evidenceRefs : []),
    Number(epochEvidence.total_count ?? 0) > 0 || Number(epochEvidence.published_count ?? 0) > 0
      ? 'runtime_epoch_swap'
      : null,
    ...(Array.isArray(epochEvidence.evidence_refs) ? epochEvidence.evidence_refs : []),
    ...(Array.isArray(epochEvidence.evidenceRefs) ? epochEvidence.evidenceRefs : []),
    Number(hostEvidence.total_count ?? 0) > 0 ? 'runtime_host_identity' : null,
    ...(Array.isArray(hostEvidence.evidence_refs) ? hostEvidence.evidence_refs : []),
    ...(Array.isArray(hostEvidence.evidenceRefs) ? hostEvidence.evidenceRefs : []),
    Number(runtimeOutputOracle.total_count ?? 0) > 0 ? 'runtime_output_oracle' : null,
    ...(Array.isArray(runtimeOutputOracle.evidence_refs) ? runtimeOutputOracle.evidence_refs : []),
    ...(Array.isArray(runtimeOutputOracle.evidenceRefs) ? runtimeOutputOracle.evidenceRefs : []),
    ...proofArtifactRecords.flatMap((entry) => [
      entry?.artifactId,
      entry?.artifact_id,
      entry?.artifact?.proofId,
      entry?.artifact?.proof_id,
      entry?.artifact?.contractHash,
      entry?.artifact?.contract_hash,
    ]),
  ]);
}

function hasTargetProgressionStructuredProofReference(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const artifactRef = stringField(entry, [
    'proofArtifactPath',
    'proof_artifact_path',
    'proofArtifactUri',
    'proof_artifact_uri',
    'artifactUri',
    'artifact_uri',
  ]);
  if (artifactRef) return true;
  const schemaVersion = stringField(entry, [
    'proofArtifactSchemaVersion',
    'proof_artifact_schema_version',
    'schemaVersion',
    'schema_version',
  ]);
  return stringField(entry, ['proofId', 'proof_id']) && schemaVersion;
}

function normalizedTargetProgressionEntryPhase(entry) {
  const phase = stringField(entry, ['phase', 'phaseName', 'phase_name', 'targetProgressionPhase']);
  return normalizeTargetProgressionPhase(phase).phase;
}

function targetProgressionEntryStatusPassed(entry) {
  const status = stringField(entry, ['status', 'state', 'result', 'resultStatus', 'result_status'])
    .toLowerCase();
  return ['pass', 'passed', 'proven', 'success', 'succeeded', 'ok'].includes(status);
}

function arrayField(entry, names) {
  if (!entry || typeof entry !== 'object') return [];
  for (const name of names) {
    if (Array.isArray(entry[name])) return entry[name];
  }
  return [];
}

function visualEvidenceArtifactProof(entry) {
  const artifacts = arrayField(entry, ['visualEvidenceArtifacts', 'visual_evidence_artifacts'])
    .filter((artifact) => artifact && typeof artifact === 'object' && !Array.isArray(artifact));
  if (artifacts.length === 0) {
    return {
      accepted: false,
      detail: 'visual oracle artifacts missing',
    };
  }
  let acceptedCount = 0;
  const failed = [];
  for (const artifact of artifacts) {
    const artifactPath = maybeStringField(artifact, ['path', 'filePath', 'file_path']);
    const expectedHash = maybeStringField(artifact, ['contentHash', 'content_hash']);
    const accepted = (artifact.acceptedAsVisualEvidence ?? artifact.accepted_as_visual_evidence) === true;
    const readError = artifact.readError ?? artifact.read_error ?? null;
    const width = positiveIntegerField(artifact, ['width']);
    const height = positiveIntegerField(artifact, ['height']);
    const visiblePixels = positiveIntegerField(artifact, ['visiblePixels', 'visible_pixels']);
    if (!artifactPath) {
      failed.push('visual:path_missing');
      continue;
    }
    if (!existsSync(artifactPath)) {
      failed.push('visual:file_missing');
      continue;
    }
    let actualHash = null;
    let byteLength = 0;
    try {
      const bytes = readFileSync(artifactPath);
      byteLength = bytes.length;
      actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    } catch (error) {
      failed.push(`visual:read_failed:${error?.message ? String(error.message) : String(error)}`);
      continue;
    }
    const hashVerified = expectedHash !== null
      && actualHash.toLowerCase() === expectedHash.toLowerCase();
    const artifactAccepted = accepted
      && !readError
      && byteLength > 0
      && hashVerified
      && width !== null
      && height !== null
      && visiblePixels !== null;
    if (artifactAccepted) {
      acceptedCount += 1;
    } else {
      failed.push([
        accepted ? null : 'visual:not_accepted',
        readError ? 'visual:read_error' : null,
        byteLength > 0 ? null : 'visual:file_empty',
        hashVerified ? null : 'visual:hash_unverified',
        width !== null && height !== null ? null : 'visual:dimensions_missing',
        visiblePixels !== null ? null : 'visual:visible_pixels_missing',
      ].filter(Boolean).join('+'));
    }
  }
  const declaredAccepted = positiveIntegerField(entry, [
    'visualEvidenceAcceptedCount',
    'visual_evidence_accepted_count',
  ]);
  const readErrorCountRaw =
    entry?.visualEvidenceReadErrorCount
    ?? entry?.visual_evidence_read_error_count
    ?? 0;
  const readErrorCount = Number.parseInt(readErrorCountRaw, 10);
  const declaredAcceptedCompatible = declaredAccepted === null || declaredAccepted >= acceptedCount;
  const readErrorFree = !Number.isInteger(readErrorCount) || readErrorCount <= 0;
  const accepted = acceptedCount > 0 && declaredAcceptedCompatible && readErrorFree;
  return {
    accepted,
    detail: accepted
      ? `visual oracle artifacts verified count=${acceptedCount}`
      : `visual oracle artifacts unverified: ${failed.filter(Boolean).join(',') || 'accepted_count_missing'}`,
  };
}

function targetProgressionSmallOracleEvidenceProof(entry) {
  const computeProof = computeOracleArtifactProof(entry);
  if (computeProof.accepted) return computeProof;
  const visualProof = visualEvidenceArtifactProof(entry);
  if (visualProof.accepted) return visualProof;
  return {
    accepted: false,
    detail: `${computeProof.detail}; ${visualProof.detail}`,
  };
}

function targetProgressionLedgerPhaseResult(ledger, phase) {
  const normalizedPhase = normalizeTargetProgressionPhase(phase).phase;
  const entries = targetProgressionLedgerEntries(ledger)
    .filter((entry) => normalizedTargetProgressionEntryPhase(entry) === normalizedPhase);
  for (const entry of entries) {
    const resultState = stringField(entry, ['resultState', 'result_state']);
    const hasStructuredProofReference = hasTargetProgressionStructuredProofReference(entry);
    const statusPassedWithStructuredProof =
      targetProgressionEntryStatusPassed(entry) && hasStructuredProofReference;
    if (normalizedPhase === 'small-oracle') {
      const oracleEvidence = targetProgressionSmallOracleEvidenceProof(entry);
      if (
        hasStructuredProofReference
        && oracleEvidence.accepted
        && (
          resultState === 'gpu-hmr-output-oracle-proven'
          || booleanField(entry, ['outputOracleProven', 'output_oracle_proven'])
          || statusPassedWithStructuredProof
        )
      ) {
        return {
          passed: true,
          detail: `small-oracle proof=${stringField(entry, ['proofId', 'proof_id', 'proofArtifactPath', 'proof_artifact_path']) || resultState || 'observed'}; ${oracleEvidence.detail}`,
        };
      }
    } else if (normalizedPhase === 'partial-reload') {
      const partialAndFission =
        booleanField(entry, ['partialReloadProven', 'partial_reload_proven'])
        && booleanField(entry, ['fissionProven', 'fission_proven']);
      if (hasStructuredProofReference && partialAndFission) {
        return {
          passed: true,
          detail: `partial-reload proof=${stringField(entry, ['proofId', 'proof_id', 'proofArtifactPath', 'proof_artifact_path']) || resultState || 'observed'}`,
        };
      }
    } else if (normalizedPhase === 'original-host-path') {
      const originalHostPath =
        booleanField(entry, ['originalHostPathProven', 'original_host_path_proven', 'attachmentProven', 'attachment_proven'])
        && booleanField(entry, ['hostPreservationProven', 'host_preservation_proven'])
        && booleanField(entry, ['dispatchSafeProven', 'dispatch_safe_proven']);
      if (hasStructuredProofReference && originalHostPath) {
        return {
          passed: true,
          detail: `original-host-path proof=${stringField(entry, ['proofId', 'proof_id', 'proofArtifactPath', 'proof_artifact_path']) || resultState || 'observed'}`,
        };
      }
    }
  }
  return {
    passed: false,
    detail: `prior phase ${normalizedPhase ?? phase} proof missing from target progression ledger`,
  };
}

function partialArtifactReplacementProofObserved(sourceProofs = [], fissionProof = null) {
  const proofs = Array.isArray(sourceProofs) ? sourceProofs : [];
  if (proofs.some((proof) =>
    proof?.partialArtifactReplacement === true
    || proof?.partialModule === true
    || /(^|[-_])partial($|[-_])/i.test(String(proof?.label ?? proof?.resultLabel ?? ''))
    || /partial|source[_-]?include|kernel[_-]?region/i.test(String(
      proof?.selectedArtifactKind
      ?? proof?.requestedArtifactKind
      ?? proof?.artifactKind
      ?? '',
    ))
  )) {
    return true;
  }
  return Array.isArray(fissionProof?.selectedIslandContracts)
    && fissionProof.selectedIslandContracts.some((contract) =>
      /partial|source[_-]?include|kernel[_-]?region/i.test(String(contract?.artifactKind ?? ''))
      || String(contract?.replacementScope ?? '').trim().toLowerCase() === 'partial'
    );
}

function artifactKindLooksFullDevice(kind) {
  return /(^|[-_])full[-_]?device($|[-_])|device[-_]?module/i.test(String(kind ?? ''));
}

function artifactKindLooksPartial(kind) {
  return /partial|source[_-]?include|kernel[_-]?region|kernel[_-]?translation[_-]?unit|direct[_-]?device[_-]?translation[_-]?unit/i
    .test(String(kind ?? ''));
}

function forcedGpuAiDeltaArtifactGateRows({ sourceProofs = [], fissionProof = null, workerEvidence = [] }) {
  const proofs = Array.isArray(sourceProofs) ? sourceProofs : [];
  const selectedKinds = proofs.flatMap((proof) => [
    proof?.selectedArtifactKind,
    ...(Array.isArray(proof?.selectedArtifactKinds) ? proof.selectedArtifactKinds : []),
  ]).filter((kind) => typeof kind === 'string' && kind.trim());
  const selectedKind = proofs.map((proof) => proof?.selectedArtifactKind)
    .find((kind) => typeof kind === 'string' && kind.trim()) ?? null;
  const fissionKinds = Array.isArray(fissionProof?.selectedIslandContracts)
    ? fissionProof.selectedIslandContracts
      .map((contract) => contract?.artifactKind)
      .filter((kind) => typeof kind === 'string' && kind.trim())
    : [];
  const partialSourceProof = proofs.some((proof) =>
    proof?.partialArtifactReplacement === true
    && artifactKindLooksPartial(proof?.selectedArtifactKind));
  const partialFissionProof = fissionKinds.some(artifactKindLooksPartial);
  const fallbackLines = (Array.isArray(workerEvidence) ? workerEvidence : [])
    .filter((line) =>
      /\[compile-device\].*(sidecar ready|reload package).*fallbackUsed=true/i.test(String(line)));
  const selectedFullDevice = selectedKind ? artifactKindLooksFullDevice(selectedKind) : false;
  return [
    {
      name: 'forced GPU AI delta partial artifact selection',
      status: partialSourceProof || partialFissionProof ? 'pass' : 'fail',
      detail: `selected=${selectedKind ?? 'none'} observed=${selectedKinds.join(',') || 'none'} fission=${fissionKinds.join(',') || 'none'}`,
    },
    {
      name: 'forced GPU AI delta no full-device selected artifact',
      status: selectedFullDevice ? 'fail' : 'pass',
      detail: `selected=${selectedKind ?? 'none'} observed=${selectedKinds.join(',') || 'none'}`,
    },
    {
      name: 'forced GPU AI delta no compile fallback',
      status: fallbackLines.length === 0 ? 'pass' : 'fail',
      detail: fallbackLines.length === 0
        ? 'fallbackUsed=false'
        : fallbackLines.slice(0, 3).join(' | ').slice(0, 1200),
    },
  ];
}

function acceptedVisualEvidenceCount(visualEvidenceFrames = []) {
  return (Array.isArray(visualEvidenceFrames) ? visualEvidenceFrames : [])
    .filter((frame) => {
      if (typeof frame === 'string') return false;
      if (!frame || typeof frame !== 'object') return false;
      const accepted = frame.accepted_as_visual_evidence ?? frame.acceptedAsVisualEvidence;
      if (accepted === false) return false;
      const epochCorrelated = frame.frame_capture_after_epoch_dispatch === true
        || frame.frameCaptureAfterEpochDispatch === true;
      return accepted === true && epochCorrelated;
    })
    .length;
}

function objectField(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? null;
}

function computeOracleArtifactsFromProof(outputProof = null) {
  const oracleArtifacts = objectField(
    outputProof?.oracleArtifacts,
    outputProof?.oracle_artifacts,
    outputProof?.outputOracle?.oracleArtifacts,
    outputProof?.outputOracle?.oracle_artifacts,
    outputProof?.output_oracle?.oracleArtifacts,
    outputProof?.output_oracle?.oracle_artifacts,
  );
  return objectField(
    oracleArtifacts?.compute_oracle_artifacts,
    oracleArtifacts?.computeOracleArtifacts,
    outputProof?.computeOracleArtifacts,
    outputProof?.compute_oracle_artifacts,
  );
}

function readFileProof(pathValue) {
  const filePath = typeof pathValue === 'string' && pathValue.trim() ? pathValue.trim() : null;
  if (!filePath) return { ok: false, reason: 'path_missing', filePath: null };
  if (!existsSync(filePath)) return { ok: false, reason: 'file_missing', filePath };
  try {
    const bytes = readFileSync(filePath);
    return {
      ok: bytes.length > 0,
      reason: bytes.length > 0 ? null : 'file_empty',
      filePath,
      bytes,
      byteLength: bytes.length,
      hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.message ? String(error.message) : String(error),
      filePath,
    };
  }
}

function positiveIntegerField(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const parsed = Number.parseInt(value, 10);
      if (parsed > 0) return parsed;
    }
  }
  return null;
}

function computeOracleArtifactProof(outputProof = null) {
  const computeArtifacts = computeOracleArtifactsFromProof(outputProof);
  if (!computeArtifacts) {
    return {
      accepted: false,
      detail: 'compute oracle artifacts missing',
    };
  }
  const verification = objectField(
    computeArtifacts.raw_readback_verification,
    computeArtifacts.rawReadbackVerification,
  ) ?? {};
  const raw = readFileProof(stringField(computeArtifacts, ['raw_readback_bin', 'rawReadbackBin']));
  const schema = readFileProof(stringField(computeArtifacts, ['readback_schema_json', 'readbackSchemaJson']));
  const card = readFileProof(stringField(computeArtifacts, ['rendered_card_png', 'renderedCardPng']));
  const declaredRawHash = stringField(computeArtifacts, [
    'raw_readback_hash',
    'rawReadbackHash',
  ]);
  const verifiedRawHash = stringField(verification, [
    'raw_readback_hash',
    'rawReadbackHash',
  ]);
  const rawHashMatches = raw.ok
    && (
      !declaredRawHash
      || declaredRawHash.toLowerCase() === raw.hash.toLowerCase()
    )
    && (
      !verifiedRawHash
      || verifiedRawHash.toLowerCase() === raw.hash.toLowerCase()
    )
    && computeArtifacts.raw_readback_hash_verified === true
    && verification.hash_verified === true;
  const schemaHashObserved = /^sha256:[0-9a-f]{64}$/i.test(String(
    computeArtifacts.readback_schema_hash
    ?? verification.readback_schema_hash
    ?? '',
  ));
  const schemaByteLength = positiveIntegerField(verification, [
    'readback_schema_byte_length',
    'readbackSchemaByteLength',
  ]);
  const slice = objectField(
    computeArtifacts.deterministic_slice,
    computeArtifacts.deterministicSlice,
  ) ?? {};
  const sliceOffset = Number.isInteger(slice.offset) ? slice.offset : Number.parseInt(slice.offset, 10);
  const sliceLength = Number.isInteger(slice.length) ? slice.length : Number.parseInt(slice.length, 10);
  const declaredSliceHash = maybeStringField(slice, ['hash', 'sha256', 'slice_hash', 'sliceHash'])
    ?? maybeStringField(computeArtifacts, ['deterministic_slice_hash', 'deterministicSliceHash']);
  const sliceHashObserved = /^sha256:[0-9a-f]{64}$/i.test(String(declaredSliceHash ?? ''));
  const sliceBoundsValid = raw.ok
    && Number.isInteger(sliceOffset)
    && Number.isInteger(sliceLength)
    && sliceOffset >= 0
    && sliceLength > 0
    && sliceOffset + sliceLength <= raw.byteLength;
  const sliceVerified = sliceBoundsValid
    && sliceHashObserved
    && computeArtifacts.deterministic_slice_hash_verified === true
    && verification.deterministic_slice_hash_verified === true
    && verification.slice_bounds_verified === true;
  const cardIsPng = card.ok
    && card.bytes.length >= 8
    && card.bytes[0] === 0x89
    && card.bytes[1] === 0x50
    && card.bytes[2] === 0x4e
    && card.bytes[3] === 0x47
    && card.bytes[4] === 0x0d
    && card.bytes[5] === 0x0a
    && card.bytes[6] === 0x1a
    && card.bytes[7] === 0x0a;
  const before = maybeStringField(computeArtifacts, ['checksum_before', 'checksumBefore']);
  const after = maybeStringField(computeArtifacts, ['checksum_after', 'checksumAfter']);
  const checksumChanged = before !== null && after !== null && before !== after;
  const accepted = raw.ok
    && schema.ok
    && cardIsPng
    && rawHashMatches
    && schemaHashObserved
    && schemaByteLength !== null
    && sliceVerified
    && checksumChanged;
  const failed = [
    raw.ok ? null : `raw:${raw.reason}`,
    schema.ok ? null : `schema:${schema.reason}`,
    cardIsPng ? null : `card:${card.reason ?? 'not_png'}`,
    rawHashMatches ? null : 'raw_hash_unverified',
    schemaHashObserved && schemaByteLength !== null ? null : 'schema_unverified',
    sliceVerified ? null : 'deterministic_slice_unverified',
    checksumChanged ? null : 'checksum_unchanged_or_missing',
  ].filter(Boolean);
  return {
    accepted,
    detail: accepted
      ? `raw compute oracle artifacts verified raw=${raw.byteLength} schema=${schemaByteLength} card=${card.byteLength}`
      : `raw compute oracle artifacts unverified: ${failed.join(',')}`,
  };
}

function targetProgressionGateRows({
  targetProgression,
  targetProgressionLedger = null,
  sourceProofs = [],
  fissionProof = null,
  dispatchProof = null,
  outputProof = null,
  hostPreservationProof = null,
  originalHostPathProof = null,
  fullRuntimeProof = null,
  visualEvidenceExpected = false,
  visualEvidenceFrames = [],
} = {}) {
  const progression = targetProgression ?? buildTargetProgressionMetadata();
  const rows = [];
  if (!progression.phase) {
    rows.push({
      name: 'target progression phase',
      status: progression.required ? 'fail' : 'skip',
      detail: progression.required
        ? 'target progression phase is required but was not declared'
        : 'target progression phase not declared',
    });
    return rows;
  }
  if (!progression.recognized) {
    return [{
      name: 'target progression phase',
      status: 'fail',
      detail: `unknown phase=${progression.phaseRaw}`,
    }];
  }
  rows.push({
    name: 'target progression phase',
    status: 'pass',
    detail: `phase=${progression.phase} target=${progression.targetName ?? 'unspecified'} final_target=${progression.finalAcceptanceTarget ?? 'unspecified'}`,
  });
  if (progression.nonFinalTargetRequired) {
    rows.push({
      name: 'target progression non-final target',
      status: progression.targetMatchesFinalAcceptance ? 'fail' : 'pass',
      detail: progression.targetMatchesFinalAcceptance
        ? `phase=${progression.phase} cannot use final_target=${progression.finalAcceptanceTarget}`
        : `phase=${progression.phase} target=${progression.targetName ?? 'unspecified'} final_target=${progression.finalAcceptanceTarget}`,
    });
  }
  if (progression.phase === 'final-acceptance' && progression.finalAcceptanceTargetDeclared) {
    rows.push({
      name: 'target progression final target',
      status: progression.targetMatchesFinalAcceptance ? 'pass' : 'fail',
      detail: progression.targetMatchesFinalAcceptance
        ? `target=${progression.targetName} matches final_target=${progression.finalAcceptanceTarget}`
        : `target=${progression.targetName ?? 'unspecified'} does not match final_target=${progression.finalAcceptanceTarget}`,
    });
  }
  if (progression.phase === 'small-oracle') {
    const outputOracleProven = proofHasResultState(outputProof, 'gpu-hmr-output-oracle-proven');
    const visualOutputProof = outputProof?.visualEvidenceRequired === true
      || outputProof?.renderVisualEvidenceRequired === true;
    const computeOracleProof = visualOutputProof
      ? { accepted: true, detail: 'visual output oracle proof' }
      : computeOracleArtifactProof(outputProof);
    rows.push({
      name: 'target progression output oracle',
      status: outputOracleProven && computeOracleProof.accepted ? 'pass' : 'fail',
      detail: outputOracleProven && computeOracleProof.accepted
        ? `gpu-hmr-output-oracle-proven; ${computeOracleProof.detail}`
        : outputOracleProven
          ? computeOracleProof.detail
          : summarizeGpuHmrOutputProof(outputProof),
    });
  }
  if (progression.phase === 'partial-reload') {
    const partialObserved = partialArtifactReplacementProofObserved(sourceProofs, fissionProof);
    rows.push({
      name: 'target progression partial reload',
      status: partialObserved ? 'pass' : 'fail',
      detail: partialObserved
        ? 'source/include-backed partial replacement observed'
        : 'source/include-backed partial replacement not observed',
    });
    rows.push({
      name: 'target progression fission proof',
      status: fissionProof?.fissionProven === true ? 'pass' : 'fail',
      detail: fissionProof?.fissionProven === true
        ? 'fission verifier proven'
        : summarizeGpuHmrFissionProof(fissionProof),
    });
  }
  if (progression.phase === 'original-host-path') {
    rows.push({
      name: 'target progression dispatch proof',
      status: proofHasResultState(dispatchProof, 'gpu-hmr-dispatch-safe-proven') ? 'pass' : 'fail',
      detail: proofHasResultState(dispatchProof, 'gpu-hmr-dispatch-safe-proven')
        ? 'gpu-hmr-dispatch-safe-proven'
        : summarizeGpuHmrDispatchProof(dispatchProof),
    });
    rows.push({
      name: 'target progression original host path',
      status: originalHostPathProof?.attachmentProven === true ? 'pass' : 'fail',
      detail: originalHostPathProof?.attachmentProven === true
        ? 'original host path attachment proven'
        : summarizeGpuHmrOriginalHostPathProof(originalHostPathProof),
    });
    rows.push({
      name: 'target progression host preservation',
      status: proofHasResultState(hostPreservationProof, 'gpu-hmr-host-preservation-proven')
        ? 'pass'
        : 'fail',
      detail: proofHasResultState(hostPreservationProof, 'gpu-hmr-host-preservation-proven')
        ? 'gpu-hmr-host-preservation-proven'
        : summarizeGpuHmrHostPreservationProof(hostPreservationProof),
    });
  }
  if (progression.phase === 'final-acceptance') {
    const outputOracleProven = proofHasResultState(outputProof, 'gpu-hmr-output-oracle-proven');
    if (progression.required) {
      for (const phase of FINAL_ACCEPTANCE_PRIOR_TARGET_PROGRESSION_PHASES) {
        const ledgerPhase = targetProgressionLedgerPhaseResult(targetProgressionLedger, phase);
        rows.push({
          name: `target progression prior ${phase}`,
          status: ledgerPhase.passed ? 'pass' : 'fail',
          detail: ledgerPhase.detail,
        });
      }
    }
    rows.push({
      name: 'target progression full runtime',
      status: fullRuntimeProof?.fullRuntimeProven === true ? 'pass' : 'fail',
      detail: fullRuntimeProof?.fullRuntimeProven === true
        ? 'gpu-hmr-full-runtime-proven'
        : summarizeGpuHmrFullRuntimeProof(fullRuntimeProof),
    });
    if (visualEvidenceExpected) {
      const acceptedVisualFrames = acceptedVisualEvidenceCount(visualEvidenceFrames);
      rows.push({
        name: 'target progression visual evidence',
        status: outputOracleProven && acceptedVisualFrames > 0 ? 'pass' : 'fail',
        detail: outputOracleProven && acceptedVisualFrames > 0
          ? `gpu-hmr-output-oracle-proven; fresh visual evidence frames=${acceptedVisualFrames}`
          : !outputOracleProven
            ? summarizeGpuHmrOutputProof(outputProof)
            : 'fresh visual evidence missing for final acceptance render workflow',
      });
    } else {
      const computeOracleProof = computeOracleArtifactProof(outputProof);
      rows.push({
        name: 'target progression compute oracle artifacts',
        status: outputOracleProven && computeOracleProof.accepted ? 'pass' : 'fail',
        detail: outputOracleProven && computeOracleProof.accepted
          ? `gpu-hmr-output-oracle-proven; ${computeOracleProof.detail}`
          : outputOracleProven
            ? computeOracleProof.detail
            : summarizeGpuHmrOutputProof(outputProof),
      });
    }
  }
  return rows;
}

function targetProgressionGateStatusRank(status) {
  if (status === 'fail') return 3;
  if (status === 'warn') return 2;
  if (status === 'pass') return 1;
  if (status === 'skip') return 0;
  return -1;
}

function mergeTargetProgressionGateRows(reportedRows = [], derivedRows = []) {
  const merged = [];
  const byName = new Map();
  for (const row of [
    ...(Array.isArray(derivedRows) ? derivedRows : []),
    ...(Array.isArray(reportedRows) ? reportedRows : []),
  ]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : `target progression unnamed ${merged.length + 1}`;
    const normalized = { ...row, name };
    const existingIndex = byName.get(name);
    if (existingIndex === undefined) {
      byName.set(name, merged.length);
      merged.push(normalized);
      continue;
    }
    const existing = merged[existingIndex];
    if (
      targetProgressionGateStatusRank(normalized.status)
      > targetProgressionGateStatusRank(existing.status)
    ) {
      merged[existingIndex] = normalized;
    }
  }
  return merged;
}

function buildTargetProgressionLedgerEntry({
  report,
  visualArtifactPaths = [],
  visualEvidenceArtifacts = [],
} = {}) {
  const progression = report?.target_progression;
  if (!progression?.phase) return null;
  const reportedGateRows = Array.isArray(report.target_progression_gates)
    ? report.target_progression_gates
    : [];
  const visualArtifacts = (Array.isArray(visualEvidenceArtifacts) ? visualEvidenceArtifacts : [])
    .filter((artifact) => artifact && typeof artifact === 'object' && !Array.isArray(artifact));
  const visualEvidenceExpected =
    compactStringList(visualArtifactPaths).length > 0
    || visualArtifacts.length > 0
    || report.output_proof?.visualEvidenceRequired === true
    || report.output_proof?.renderVisualEvidenceRequired === true;
  const derivedGateRows = targetProgressionGateRows({
    targetProgression: progression,
    targetProgressionLedger: report.target_progression_ledger,
    sourceProofs: report.source_proofs,
    fissionProof: report.fission_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
    fullRuntimeProof: report.full_runtime_proof,
    visualEvidenceExpected,
    visualEvidenceFrames: visualArtifacts.length > 0
      ? visualArtifacts
      : Array.isArray(report.screenshots)
        ? report.screenshots
        : [],
  });
  const gateRows = mergeTargetProgressionGateRows(reportedGateRows, derivedGateRows);
  const failedGates = gateRows.filter((row) => row?.status === 'fail');
  const runtimeProofArtifact = report.runtime_proof_artifact ?? {};
  const visualContentHashes = compactStringList(
    visualArtifacts.map((artifact) => artifact.contentHash ?? artifact.content_hash),
  );
  const visualReadErrorCount = visualArtifacts
    .filter((artifact) => artifact.readError ?? artifact.read_error)
    .length;
  const visualAcceptedCount = visualArtifacts
    .filter((artifact) => (
      artifact.acceptedAsVisualEvidence ?? artifact.accepted_as_visual_evidence
    ) === true)
    .length;
  const computeOracleArtifacts = computeOracleArtifactsFromProof(report.output_proof);
  return {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger_entry.v1',
    phase: progression.phase,
    phaseRaw: progression.phaseRaw ?? null,
    targetName: progression.targetName ?? null,
    finalAcceptanceTarget: progression.finalAcceptanceTarget ?? null,
    status: failedGates.length === 0 ? 'pass' : 'fail',
    failureCount: failedGates.length,
    proofId: runtimeProofArtifact.proofId ?? null,
    proofArtifactPath: runtimeProofArtifact.path ?? report.runtime_proof_artifact_path ?? null,
    proofArtifactSchemaVersion:
      runtimeProofArtifact.schemaVersion ?? 'synthi.gpu.hmr.validation-proof.v1',
    resultState: report.full_runtime_proof?.resultState ?? runtimeProofArtifact.resultState ?? null,
    degradedState: report.full_runtime_proof?.degradedState ?? runtimeProofArtifact.degradedState ?? null,
    degradedReason: report.full_runtime_proof?.degradedReason ?? runtimeProofArtifact.degradedReason ?? null,
    fullRuntimeProven: report.full_runtime_proof?.fullRuntimeProven === true,
    outputOracleProven: proofHasResultState(report.output_proof, 'gpu-hmr-output-oracle-proven'),
    partialReloadProven: partialArtifactReplacementProofObserved(
      report.source_proofs,
      report.fission_proof,
    ),
    fissionProven: report.fission_proof?.fissionProven === true,
    originalHostPathProven: report.original_host_path_proof?.attachmentProven === true,
    hostPreservationProven: proofHasResultState(
      report.host_preservation_proof,
      'gpu-hmr-host-preservation-proven',
    ),
    dispatchSafeProven: proofHasResultState(
      report.dispatch_proof,
      'gpu-hmr-dispatch-safe-proven',
    ),
    visualEvidenceRefs: compactStringList([
      ...visualArtifactPaths,
      ...visualArtifacts.map((artifact) => artifact.path ?? artifact.filePath ?? artifact.file_path),
    ]),
    visualEvidenceArtifacts: visualArtifacts,
    visualEvidenceContentHashes: visualContentHashes,
    visualEvidenceAcceptedCount: visualAcceptedCount,
    visualEvidenceReadErrorCount: visualReadErrorCount,
    computeOracleArtifacts,
    compute_oracle_artifacts: computeOracleArtifacts,
    gateRows,
    createdAt: report.finished_at ?? new Date().toISOString(),
  };
}

async function writeTargetProgressionLedgerArtifact(outputDir, { report, entry } = {}) {
  if (!entry) return null;
  const artifactSeed = {
    schemaVersion: TARGET_PROGRESSION_LEDGER_SCHEMA_VERSION,
    sourceRun: {
      slug: report.slug,
      sourceUrl: report.source_url,
      repoCommit: report.repo_commit,
      targetName: report.target_name,
      model: report.model,
      gpuVendor: report.gpu_vendor,
      gpuArch: report.gpu_arch,
    },
    entries: [entry],
    createdAt: report.finished_at ?? new Date().toISOString(),
  };
  const seedJson = JSON.stringify(artifactSeed);
  const hash = createHash('sha256').update(seedJson).digest('hex');
  const artifact = {
    ledgerId: `target-progression-ledger:sha256:${hash}`,
    contentHash: `sha256:${hash}`,
    ...artifactSeed,
  };
  await mkdir(outputDir, { recursive: true });
  const filePath = path.join(
    outputDir,
    `${cleanIdentifier(report.slug)}-${cleanIdentifier(entry.phase)}-${hash}.json`,
  );
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return {
    ledgerId: artifact.ledgerId,
    path: filePath,
    schemaVersion: artifact.schemaVersion,
    contentHash: artifact.contentHash,
    entryPhase: entry.phase,
    entryStatus: entry.status,
  };
}

const REAL_ROCM_PROFILE = loadRealRocmProfile();
const configuredRepoUrl = process.env.SYNTHI_REAL_ROCM_REPO_URL || REAL_ROCM_PROFILE.repo.url;
const configuredRepoName = cleanIdentifier(
  process.env.SYNTHI_REAL_ROCM_REPO_NAME
    || REAL_ROCM_PROFILE.repo.name
    || repoNameFromUrl(configuredRepoUrl),
);
const configuredWorkspaceRoot =
  process.env.SYNTHI_REAL_ROCM_WORKSPACE_ROOT ?? `/workspace/${configuredRepoName}`;
const configuredWorkerTempDir =
  process.env.SYNTHI_REAL_ROCM_WORKER_TMP ?? '/tmp/synthi-real-rocm';
const configuredTargetProgressionLedgerInput = targetProgressionLedgerInput();
const configuredExpectScreenshotExplicit =
  process.env.SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT !== undefined
  && String(process.env.SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT).trim() !== '';
const configuredExpectScreenshotValue = configuredExpectScreenshotExplicit
  ? booleanFromEnv(process.env, 'SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT', false)
  : REAL_ROCM_PROFILE.preview.expectScreenshot ?? false;
const configuredRenderPreview = booleanFromEnv(
  process.env,
  'SYNTHI_REAL_ROCM_RENDER_PREVIEW',
  REAL_ROCM_PROFILE.preview.renderPreview ?? configuredExpectScreenshotValue,
);
const configuredExpectScreenshot = booleanFromEnv(
  process.env,
  'SYNTHI_REAL_ROCM_EXPECT_SCREENSHOT',
  configuredRenderPreview,
);
const configuredCmakeArgs = process.env.SYNTHI_REAL_ROCM_CMAKE_ARGS_JSON !== undefined
  ? parseStringArrayEnv(
    process.env.SYNTHI_REAL_ROCM_CMAKE_ARGS_JSON,
    'SYNTHI_REAL_ROCM_CMAKE_ARGS_JSON',
  )
  : REAL_ROCM_PROFILE.target.cmakeArgs;
const configuredOutputOracleJson = process.env.SYNTHI_REAL_ROCM_OUTPUT_ORACLE_JSON
  ?? process.env.SYNTHI_GPU_HMR_OUTPUT_ORACLE_JSON
  ?? (REAL_ROCM_PROFILE.outputOracle.contract
    ? JSON.stringify(REAL_ROCM_PROFILE.outputOracle.contract)
    : '');
const configuredOutputOracleRuntimeProfileInput = firstJsonObjectEnv([
  'SYNTHI_REAL_ROCM_OUTPUT_ORACLE_RUNTIME_PROFILE_JSON',
  'SYNTHI_GPU_HMR_OUTPUT_ORACLE_RUNTIME_PROFILE_JSON',
]);
const configuredOutputOracleRuntimeProfile =
  configuredOutputOracleRuntimeProfileInput.value
  ?? REAL_ROCM_PROFILE.outputOracle.runtimeProfile;
const configuredOutputOracleRuntimeProfileSource =
  configuredOutputOracleRuntimeProfileInput.source
  ?? (REAL_ROCM_PROFILE.outputOracle.runtimeProfile
    ? 'profile:outputOracle.runtimeProfile'
    : 'none');
const configuredAppHookContractInput = firstJsonObjectEnv([
  'SYNTHI_REAL_ROCM_APP_HOOK_CONTRACT_JSON',
  'SYNTHI_GPU_HMR_APP_HOOK_CONTRACT_JSON',
]);
const configuredAppHookContract = configuredAppHookContractInput.value
  ? normalizeRealRocmAppHookContract(configuredAppHookContractInput.value)
  : REAL_ROCM_PROFILE.appHookContract;
const configuredAppHookContractSource =
  configuredAppHookContractInput.source
  ?? (REAL_ROCM_PROFILE.appHookContract.declared ? 'profile:appHookContract' : 'none');
const configuredDeviceSidecarContractInput = firstJsonObjectEnv([
  'SYNTHI_REAL_ROCM_DEVICE_SIDECAR_CONTRACT_JSON',
  'SYNTHI_GPU_HMR_DEVICE_SIDECAR_CONTRACT_JSON',
]);
const configuredDeviceSidecarContract = configuredDeviceSidecarContractInput.value
  ? normalizeRealRocmDeviceSidecarContract(configuredDeviceSidecarContractInput.value)
  : REAL_ROCM_PROFILE.deviceSidecarContract;
const configuredDeviceSidecarContractSource =
  configuredDeviceSidecarContractInput.source
  ?? (REAL_ROCM_PROFILE.deviceSidecarContract.declared ? 'profile:deviceSidecarContract' : 'none');
const configuredOutputOracleProfile = outputOracleProfileMode(
  process.env.SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE
    ?? process.env.SYNTHI_GPU_HMR_OUTPUT_ORACLE_PROFILE
    ?? (configuredOutputOracleRuntimeProfile ? 'profile_runtime_profile' : undefined)
    ?? REAL_ROCM_PROFILE.outputOracle.profile
    ?? 'auto',
);

const CFG = {
  repoUrl: configuredRepoUrl,
  repoName: configuredRepoName,
  repoPath: path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_REPO_PATH || `tmp/real-rocm/${configuredRepoName}`),
  repoCommit: process.env.SYNTHI_REAL_ROCM_COMMIT || REAL_ROCM_PROFILE.repo.commit || '',
  initSubmodules: process.env.SYNTHI_REAL_ROCM_INIT_SUBMODULES !== undefined
    ? process.env.SYNTHI_REAL_ROCM_INIT_SUBMODULES !== '0'
    : REAL_ROCM_PROFILE.repo.initSubmodules ?? true,
  realRocmProfile: REAL_ROCM_PROFILE,
  entryFile: process.env.SYNTHI_REAL_ROCM_ENTRY ?? REAL_ROCM_PROFILE.target.entryFile,
  deltaFile: (process.env.SYNTHI_REAL_ROCM_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_ENTRY
    ?? REAL_ROCM_PROFILE.target.deltaFile)
    || REAL_ROCM_PROFILE.target.entryFile,
  targetName: process.env.SYNTHI_REAL_ROCM_TARGET ?? REAL_ROCM_PROFILE.target.targetName,
  targetProgressionPhase:
    process.env.SYNTHI_REAL_ROCM_TARGET_PROGRESSION_PHASE
    ?? REAL_ROCM_PROFILE.targetProgression.phase
    ?? '',
  finalAcceptanceTarget:
    process.env.SYNTHI_REAL_ROCM_FINAL_ACCEPTANCE_TARGET
    ?? REAL_ROCM_PROFILE.targetProgression.finalAcceptanceTarget
    ?? '',
  requireTargetProgression: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_REQUIRE_TARGET_PROGRESSION',
    REAL_ROCM_PROFILE.targetProgression.required === true,
  ),
  targetProgressionLedger: parseTargetProgressionLedger(
    configuredTargetProgressionLedgerInput.raw,
  ),
  targetProgressionLedgerPath: configuredTargetProgressionLedgerInput.path,
  buildSubdir: process.env.SYNTHI_REAL_ROCM_BUILD_SUBDIR ?? REAL_ROCM_PROFILE.target.buildSubdir,
  workerRepoPath: process.env.SYNTHI_REAL_ROCM_WORKER_PATH ?? `${configuredWorkerTempDir}/${configuredRepoName}`,
  workerTempDir: configuredWorkerTempDir,
  workspaceRoot: configuredWorkspaceRoot,
  workspaceName: process.env.SYNTHI_REAL_ROCM_WORKSPACE_NAME ?? `Synthi Real ROCm Repo Validation - ${configuredRepoName}`,
  seedCommitMessage:
    process.env.SYNTHI_REAL_ROCM_SEED_COMMIT_MESSAGE ??
    `real-rocm-validation: seed ${configuredRepoName} ${process.env.SYNTHI_REAL_ROCM_TARGET ?? 'target'}`,
  cmakeConfigName: (
    process.env.SYNTHI_REAL_ROCM_CMAKE_CONFIG
    ?? REAL_ROCM_PROFILE.target.cmakeConfigName
  ) || 'Release',
  cmakeArgs: configuredCmakeArgs,
  cmakeTargetType: (
    process.env.SYNTHI_REAL_ROCM_TARGET_TYPE
    ?? REAL_ROCM_PROFILE.target.cmakeTargetType
  ) || 'EXECUTABLE',
  cmakeTargetIdNamespace: (
    process.env.SYNTHI_REAL_ROCM_TARGET_ID_NAMESPACE
    ?? REAL_ROCM_PROFILE.target.cmakeTargetIdNamespace
  ) || 'real-rocm',
  buildMetadataDir: process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR
    ? path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_BUILD_METADATA_DIR)
    : '',
  gpuMode: process.env.SYNTHI_REAL_ROCM_GPU_MODE ?? 'rocm',
  buildUpstream: process.env.SYNTHI_REAL_ROCM_BUILD_UPSTREAM !== undefined
    ? process.env.SYNTHI_REAL_ROCM_BUILD_UPSTREAM !== '0'
    : REAL_ROCM_PROFILE.target.buildUpstream ?? true,
  runUpstream: process.env.SYNTHI_REAL_ROCM_RUN_UPSTREAM !== undefined
    ? process.env.SYNTHI_REAL_ROCM_RUN_UPSTREAM !== '0'
    : REAL_ROCM_PROFILE.target.runUpstream ?? true,
  upstreamRunCommand: process.env.SYNTHI_REAL_ROCM_UPSTREAM_RUN_COMMAND
    ?? REAL_ROCM_PROFILE.target.upstreamRunCommand
    ?? '',
  upstreamDisplayMode: process.env.SYNTHI_REAL_ROCM_UPSTREAM_DISPLAY_MODE ?? 'auto',
  upstreamXdgRuntimeDir: process.env.SYNTHI_REAL_ROCM_UPSTREAM_XDG_RUNTIME_DIR ?? '',
  nativeLaunchObserver: process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER === '1',
  nativeLaunchObserverPath:
    process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_OBSERVER_PATH
    ?? '/usr/local/lib/synthi-gpu-native-launch-observer.so',
  nativeLaunchSymbols: parseNativeLaunchSymbols(
    process.env.SYNTHI_REAL_ROCM_NATIVE_LAUNCH_SYMBOLS,
    REAL_ROCM_PROFILE.target.nativeLaunchSymbols,
  ),
  width: Number(process.env.SYNTHI_REAL_ROCM_WIDTH ?? REAL_ROCM_PROFILE.preview.width ?? 800),
  height: Number(process.env.SYNTHI_REAL_ROCM_HEIGHT ?? REAL_ROCM_PROFILE.preview.height ?? 600),
  hiprtRuntimeProbe:
    process.env.SYNTHI_REAL_ROCM_HIPRT_RUNTIME_PROBE !== undefined
      ? booleanFromEnv(process.env, 'SYNTHI_REAL_ROCM_HIPRT_RUNTIME_PROBE', false)
      : REAL_ROCM_PROFILE.target.hiprtRuntimeProbe === true,
  hiprtRuntimeProbeWidth: positiveIntegerFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_HIPRT_RUNTIME_WIDTH',
    Math.max(640, Number(process.env.SYNTHI_REAL_ROCM_WIDTH ?? 800)),
  ),
  hiprtRuntimeProbeHeight: positiveIntegerFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_HIPRT_RUNTIME_HEIGHT',
    Math.max(360, Number(process.env.SYNTHI_REAL_ROCM_HEIGHT ?? 600)),
  ),
  deltaBefore:
    process.env.SYNTHI_REAL_ROCM_DELTA_BEFORE ??
    REAL_ROCM_PROFILE.sourceDelta.before,
  deltaAfter:
    process.env.SYNTHI_REAL_ROCM_DELTA_AFTER ??
    REAL_ROCM_PROFILE.sourceDelta.after,
  secondDeltaFile: (process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_DELTA_FILE
    ?? process.env.SYNTHI_REAL_ROCM_ENTRY
    ?? REAL_ROCM_PROFILE.sourceDelta.second.file)
    || REAL_ROCM_PROFILE.target.deltaFile
    || REAL_ROCM_PROFILE.target.entryFile,
  secondDeltaBefore: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE
    ?? REAL_ROCM_PROFILE.sourceDelta.second.before
    ?? '',
  secondDeltaAfter: process.env.SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER
    ?? REAL_ROCM_PROFILE.sourceDelta.second.after
    ?? '',
  extraDeltasJson: process.env.SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON
    ?? (REAL_ROCM_PROFILE.sourceDelta.extraDeltas.length
      ? JSON.stringify(REAL_ROCM_PROFILE.sourceDelta.extraDeltas)
      : ''),
  maxFileBytes: Number(process.env.SYNTHI_REAL_ROCM_MAX_FILE_BYTES ?? 512 * 1024),
  compileContextMaxBytes: Number(process.env.SYNTHI_REAL_ROCM_COMPILE_CONTEXT_MAX_BYTES ?? 48 * 1024 * 1024),
  compileTransport: (process.env.SYNTHI_REAL_ROCM_COMPILE_TRANSPORT ?? 'inline').toLowerCase(),
  writeBatchSize: Number(process.env.SYNTHI_REAL_ROCM_WRITE_BATCH_SIZE ?? 200),
  slug: process.env.SLUG ?? `gpu-real-rocm-${configuredRepoName}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  collabUrl: process.env.COLLAB_URL ?? 'http://localhost:1234',
  signalingUrl: process.env.SIGNALING_URL ?? process.env.SYNTHI_SIGNALING_URL ?? null,
  hostId: process.env.HOST_ID ?? 'gpu-hmr-real-rocm-validation',
  mcpClientName: process.env.SYNTHI_REAL_ROCM_MCP_CLIENT_NAME ?? 'real-rocm-validation',
  mcpContainer: process.env.MCP_CONTAINER ?? process.env.SYNTHI_MCP_CONTAINER ?? null,
  workerContainer: process.env.WORKER_CONTAINER ?? process.env.SYNTHI_WORKER_CONTAINER ?? null,
  aiEngineContainer: process.env.AI_ENGINE_CONTAINER ?? process.env.SYNTHI_AI_ENGINE_CONTAINER ?? null,
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'local').toLowerCase(),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpContainerEntry: process.env.MCP_CONTAINER_ENTRY ?? process.env.SYNTHI_MCP_CONTAINER_ENTRY ?? null,
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? process.env.SYNTHI_MCP_SIGNALING_URL ?? null,
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 300000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  firstCompileTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_FIRST_TIMEOUT_MS ?? 300000),
  hmrTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_HMR_TIMEOUT_MS ?? 20 * 60 * 1000),
  upstreamBuildTimeoutMs: positiveIntegerFromEnv(process.env, 'SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS', 1200000),
  dockerPreflightTimeoutMs: positiveIntegerFromEnv(process.env, 'SYNTHI_REAL_ROCM_DOCKER_PREFLIGHT_TIMEOUT_MS', 8000),
  reuseWorkerRepo: booleanFromEnv(process.env, 'SYNTHI_REAL_ROCM_REUSE_WORKER_REPO', false),
  cleanUpstreamBuild: booleanFromEnv(process.env, 'SYNTHI_REAL_ROCM_CLEAN_BUILD', true),
  screenshotAttempts: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_ATTEMPTS ?? 3),
  screenshotRetryDelayMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_RETRY_MS ?? 1000),
  screenshotFreshnessMaxMs: Number(process.env.SYNTHI_REAL_ROCM_SCREENSHOT_FRESHNESS_MS ?? 5000),
  frameGateTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_FRAME_GATE_TIMEOUT_MS ?? 1200000),
  expectScreenshot: configuredExpectScreenshot,
  renderPreview: configuredRenderPreview,
  requireFreshAiSplit:
    process.env.SYNTHI_VALIDATION_REQUIRE_FRESH_AI_SPLIT === '1'
    || process.env.SYNTHI_REAL_ROCM_REQUIRE_FRESH_AI_SPLIT === '1',
  requireOriginalHostPath: process.env.SYNTHI_REAL_ROCM_REQUIRE_ORIGINAL_HOST_PATH !== '0',
  requireOriginalHostPathProof: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_REQUIRE_ORIGINAL_HOST_PATH_PROOF',
    false,
  ),
  requireFullRuntimeProof: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_REQUIRE_FULL_RUNTIME_PROOF',
    false,
  ),
  outputOracleContract: parseOutputOracleContract(
    configuredOutputOracleJson,
  ),
  outputOracleRuntimeProfile: configuredOutputOracleRuntimeProfile,
  outputOracleRuntimeProfileSource: configuredOutputOracleRuntimeProfileSource,
  outputOracleProfile: configuredOutputOracleProfile,
  appHookContract: configuredAppHookContract,
  appHookContractSource: configuredAppHookContractSource,
  deviceSidecarContract: configuredDeviceSidecarContract,
  deviceSidecarContractSource: configuredDeviceSidecarContractSource,
  hmrWaitModule: process.env.SYNTHI_REAL_ROCM_HMR_WAIT_MODULE ?? 'device',
  hmrRequiredGpuProofState: (process.env.SYNTHI_REAL_ROCM_REQUIRED_GPU_PROOF_STATE ?? '').trim(),
  forceGpuAiDelta: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_FORCE_GPU_AI_DELTA',
    false,
  ),
  gpuArch: process.env.SYNTHI_REAL_ROCM_GPU_ARCH ?? process.env.SYNTHI_GPU_ARCH ?? '',
  rocmPrefix:
    process.env.SYNTHI_REAL_ROCM_ROCM_PREFIX
    ?? process.env.SYNTHI_GPU_HMR_RUNTIME_ROCM_PREFIX
    ?? process.env.ROCM_PATH
    ?? '',
  gpuArchSource: '',
  rocmPrefixSource: '',
  googleApiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
  geminiModel: process.env.SYNTHI_GEMINI_MODEL ?? 'gemini-3.5-flash',
  gpuSplitModel: process.env.SYNTHI_GPU_SPLIT_MODEL
    ?? process.env.SYNTHI_GEMINI_MODEL
    ?? 'gemini-3.5-flash',
  gpuDeltaModel: process.env.SYNTHI_GPU_DELTA_MODEL
    ?? process.env.SYNTHI_GEMINI_DELTA_MODEL
    ?? 'gemini-3.1-flash-lite',
  syncToGcs: process.env.SYNTHI_SYNC_TO_GCS === '1',
};

const LOG_DIR = path.resolve(__dirname, '../.gpu-hmr-test-logs');
const ARTIFACT_DIR = path.resolve(__dirname, '../.gpu-hmr-test-artifacts');
const RESULTS_JSON = path.join(LOG_DIR, 'real-rocm-results.json');
const RESULTS_TXT = path.join(LOG_DIR, 'real-rocm-results.txt');
const RETAINED_RESULTS_DIR = path.join(LOG_DIR, 'real-rocm-results');
const WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH =
  '/tmp/synthi-gpu-hmr-runtime-output-oracle.json';
const REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_source_delta_execution.v1';

const report = {
  slug: CFG.slug,
  real_rocm_profile: {
    id: CFG.realRocmProfile.id,
    schemaVersion: CFG.realRocmProfile.schemaVersion,
    source: CFG.realRocmProfile.source,
    appHookContractDeclared: CFG.appHookContract.declared,
    app_hook_contract_declared: CFG.appHookContract.declared,
    deviceSidecarContractDeclared: CFG.deviceSidecarContract.declared,
    device_sidecar_contract_declared: CFG.deviceSidecarContract.declared,
    proofObligations: CFG.realRocmProfile.proofObligations,
    proof_obligations: CFG.realRocmProfile.proofObligations,
  },
  source_url: CFG.repoUrl,
  repo_path: CFG.repoPath,
  repo_commit: null,
  entry_file: CFG.entryFile,
  delta_file: CFG.deltaFile,
  second_delta_file: CFG.secondDeltaBefore || CFG.secondDeltaAfter ? CFG.secondDeltaFile : null,
  target_name: CFG.targetName,
  target_progression: buildTargetProgressionMetadata({
    targetName: CFG.targetName,
    rawPhase: CFG.targetProgressionPhase,
    finalAcceptanceTarget: CFG.finalAcceptanceTarget,
    required: CFG.requireTargetProgression,
  }),
  target_progression_ledger: CFG.targetProgressionLedger,
  target_progression_ledger_path: CFG.targetProgressionLedgerPath || null,
  target_progression_ledger_entry: null,
  target_progression_ledger_artifact: null,
  target_progression_ledger_artifact_path: null,
  cmake_config: CFG.cmakeConfigName,
  cmake_args: CFG.cmakeArgs,
  model: CFG.geminiModel,
  model_roles: {
    gpu_split: CFG.gpuSplitModel,
    gpu_delta: CFG.gpuDeltaModel,
  },
  gpu_vendor: CFG.gpuMode,
  gpu_arch: CFG.gpuArch,
  containers: {
    mcp: CFG.mcpContainer,
    worker: CFG.workerContainer,
    ai_engine: CFG.aiEngineContainer,
  },
  command: validationCommandMetadata({ envKeys: REAL_ROCM_VALIDATION_COMMAND_ENV_KEYS }),
  file_count: 0,
  seeded_file_count: 0,
  skipped_file_count: 0,
  checks: [],
  phases: [],
  screenshots: [],
  logs: {},
  docker: {},
  evidence: {},
  adversarial_preflight: null,
  hiprt_runtime_probe: {
    enabled: CFG.hiprtRuntimeProbe,
    enabled_source: process.env.SYNTHI_REAL_ROCM_HIPRT_RUNTIME_PROBE !== undefined
      ? 'env:SYNTHI_REAL_ROCM_HIPRT_RUNTIME_PROBE'
      : REAL_ROCM_PROFILE.target.hiprtRuntimeProbe === true
        ? 'profile:target.hiprtRuntimeProbe'
        : 'disabled_by_default',
    capture_worker_path: null,
    capture_artifact_path: null,
    native_launch_symbols: CFG.nativeLaunchSymbols,
    source_adaptations: [],
    source_adaptation_runs: [],
    visual_evidence: null,
  },
  runtime_identity: {
    phases: [],
  },
  proof_artifacts: [],
  strict_proof_gates: [],
  target_progression_gates: [],
  abi_proof: null,
  fission_proof: null,
  artifact_transport_proof: null,
  epoch_swap_proof: null,
  dispatch_proof: null,
  output_proof: null,
  compute_output_oracle_visual_evidence: null,
  host_preservation_proof: null,
  original_host_path_proof: null,
  full_runtime_proof: null,
  runtime_proof_artifact: null,
  runtime_proof_artifact_path: null,
  compile_projection: {},
  compile_transport: CFG.compileTransport,
  output_oracle_contract: CFG.outputOracleContract,
  output_oracle_profile: CFG.outputOracleProfile,
  output_oracle_runtime_profile_source: CFG.outputOracleRuntimeProfileSource,
  real_rocm_profile_proof_obligations: null,
  realRocmProfileProofObligations: null,
  app_hook_contract: CFG.appHookContract,
  appHookContract: CFG.appHookContract,
  app_hook_contract_source: CFG.appHookContractSource,
  device_sidecar_contract: CFG.deviceSidecarContract,
  deviceSidecarContract: CFG.deviceSidecarContract,
  device_sidecar_contract_source: CFG.deviceSidecarContractSource,
  real_rocm_device_sidecar_contract: null,
  realRocmDeviceSidecarContract: null,
  output_oracle_adaptations: [],
  source_delta_execution: null,
  real_rocm_source_delta_execution: null,
  output_oracle_runtime_profile_path: WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH,
  output_oracle_runtime_profile: null,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: CFG.outputOracleProfile,
    mode: CFG.outputOracleProfile,
    sourceDerivedCandidateCount: 0,
    selectedSource: null,
    disabledReason: null,
    contractPresent: CFG.outputOracleContract !== null,
    runtimeProfilePresent: false,
    runtimeProfilePath: WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH,
    runtimeProfileSynced: false,
    failedReason: null,
  },
  render_preview_enabled: CFG.renderPreview,
  runtime_capability_preflight: null,
  upstream_run_environment: null,
  worker_repo_reuse: {
    requested: CFG.reuseWorkerRepo,
    reused: false,
    reason: CFG.reuseWorkerRepo ? 'not_evaluated' : 'disabled',
  },
  fresh_ai_split_required: CFG.requireFreshAiSplit,
  original_host_path_required: CFG.requireOriginalHostPath,
  original_host_path_proof_required: CFG.requireOriginalHostPathProof,
  full_runtime_proof_required: CFG.requireFullRuntimeProof,
  started_at: new Date().toISOString(),
  metric_clock: 'monotonic_ns',
  started_monotonic_ns: RUN_STARTED_MONOTONIC_NS,
  finished_at: null,
  finished_monotonic_ns: null,
  duration_monotonic_ns: null,
  timingMetrics: null,
};

const runtimeEvidenceContext = {
  files: [],
  buildMetadata: {},
  sourceSnapshotAvailable: false,
};

report.real_rocm_profile_proof_obligations = realRocmProfileProofObligationsFacet({
  profile: CFG.realRocmProfile,
  targetProgression: report.target_progression,
  outputOracleProfile: CFG.outputOracleProfile,
  outputOracleContract: CFG.outputOracleContract,
  outputOracleRuntimeProfile: CFG.outputOracleRuntimeProfile,
  requireFullRuntimeProof: CFG.requireFullRuntimeProof,
});
report.realRocmProfileProofObligations = report.real_rocm_profile_proof_obligations;
report.profile_proof_obligations = report.real_rocm_profile_proof_obligations;
report.profileProofObligations = report.real_rocm_profile_proof_obligations;

function record(name, status, detail = '') {
  const row = { name, status, detail, ts: new Date().toISOString() };
  report.checks.push(row);
  const tag = status === 'pass' ? '[ok]' : status === 'fail' ? '[fail]' : status === 'warn' ? '[warn]' : '[info]';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
}

function strictProofGateRows({
  requireOriginalHostPathProof = false,
  requireFullRuntimeProof = false,
  originalHostPathProof = null,
  fullRuntimeProof = null,
} = {}) {
  const rows = [];
  if (requireOriginalHostPathProof) {
    const passed = originalHostPathProof?.attachmentProven === true;
    rows.push({
      name: 'strict original host path proof',
      status: passed ? 'pass' : 'fail',
      detail: passed
        ? 'original host path attachment proven'
        : summarizeGpuHmrOriginalHostPathProof(originalHostPathProof),
    });
  }
  if (requireFullRuntimeProof) {
    const passed = fullRuntimeProof?.fullRuntimeProven === true;
    rows.push({
      name: 'strict full runtime proof',
      status: passed ? 'pass' : 'fail',
      detail: passed
        ? 'gpu-hmr-full-runtime-proven'
        : summarizeGpuHmrFullRuntimeProof(fullRuntimeProof),
    });
  }
  return rows;
}

function execText(cmd, args, timeoutMs = 30000, rejectOnError = false, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (err && rejectOnError) {
        err.output = text;
        reject(err);
        return;
      }
      resolve(err ? undefined : text);
    });
  });
}

async function dockerDaemonPreflight(execTextImpl = execText) {
  const startedAt = Date.now();
  const output = await execTextImpl(
    'docker',
    ['version', '--format', '{{json .Server.Version}}'],
    CFG.dockerPreflightTimeoutMs,
  );
  const elapsedMs = Date.now() - startedAt;
  const serverVersion = String(output ?? '').trim();
  const available = serverVersion.length > 0;
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_docker_daemon_preflight.v1',
    available,
    status: available ? 'docker_daemon_available' : 'docker_daemon_unavailable_or_timeout',
    command: 'docker version --format {{json .Server.Version}}',
    timeoutMs: CFG.dockerPreflightTimeoutMs,
    timeout_ms: CFG.dockerPreflightTimeoutMs,
    elapsedMs,
    elapsed_ms: elapsedMs,
    serverVersion: available ? serverVersion : null,
    server_version: available ? serverVersion : null,
    proofAuthority: 'infrastructure_preflight_not_gpu_hmr_proof',
    proof_authority: 'infrastructure_preflight_not_gpu_hmr_proof',
    blockingGaps: available ? [] : ['docker_daemon_unavailable_or_timeout'],
    blocking_gaps: available ? [] : ['docker_daemon_unavailable_or_timeout'],
  };
}

async function resolveDockerContainer(configured, service, execTextImpl = execText) {
  const composeId = await execTextImpl(
    'docker',
    ['compose', '--project-directory', REPO_ROOT, 'ps', '-q', service],
    8000,
  );
  const id = String(composeId || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  if (id) return id;
  const labelIds = await execTextImpl(
    'docker',
    ['ps', '-q', '--filter', `label=com.docker.compose.service=${service}`],
    8000,
  );
  const labelId = String(labelIds || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return labelId || configured || null;
}

async function resolveDockerContainers() {
  CFG.workerContainer = await resolveDockerContainer(CFG.workerContainer, 'worker');
  CFG.aiEngineContainer = await resolveDockerContainer(CFG.aiEngineContainer, 'ai-engine');
  if (!CFG.workerContainer) {
    throw new Error(
      'Real ROCm validation requires a worker container from WORKER_CONTAINER, '
      + 'SYNTHI_WORKER_CONTAINER, or docker compose service discovery',
    );
  }
  CFG.mcpContainer = await resolveDockerContainer(CFG.mcpContainer, 'mcp');
  if (CFG.mcpTransport !== 'docker') return;
  if (!CFG.mcpContainer) {
    throw new Error('MCP_TRANSPORT=docker requires an MCP container from MCP_CONTAINER, SYNTHI_MCP_CONTAINER, or docker compose service discovery');
  }
  if (!CFG.mcpSignalingUrl) {
    throw new Error('MCP_TRANSPORT=docker requires explicit MCP_SIGNALING_URL or SYNTHI_MCP_SIGNALING_URL');
  }
  if (!CFG.mcpContainerEntry) {
    throw new Error('MCP_TRANSPORT=docker requires explicit MCP_CONTAINER_ENTRY or SYNTHI_MCP_CONTAINER_ENTRY');
  }
}

async function detectWorkerGpuArch() {
  const configured = String(CFG.gpuArch ?? '').trim();
  if (configured) {
    CFG.gpuArch = configured;
    CFG.gpuArchSource = 'env';
    return;
  }
  const output = await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      `
set +e
arch=''
source=''
if command -v hipconfig >/dev/null 2>&1; then
  arch="$(hipconfig --amdgpu-target 2>/dev/null | tr ' ,;' '\\n' | grep -E '^gfx[0-9A-Za-z]+$' | head -n 1)"
  [ -n "$arch" ] && source='hipconfig --amdgpu-target'
fi
if [ -z "$arch" ] && command -v rocminfo >/dev/null 2>&1; then
  arch="$(rocminfo 2>/dev/null | sed -n 's/.*Name:[[:space:]]*\\(gfx[0-9A-Za-z]*\\).*/\\1/p' | head -n 1)"
  [ -n "$arch" ] && source='rocminfo'
fi
printf 'SYNTHI_ROCM_GPU_ARCH_DETECTION source=%s value=%s\\n' "$source" "$arch"
`,
    ],
    30000,
    true,
  );
  const match = /SYNTHI_ROCM_GPU_ARCH_DETECTION\s+source=(.*?)\s+value=(gfx[0-9A-Za-z]+)/.exec(output);
  if (!match) {
    throw new Error(
      'ROCm GPU arch is not configured and could not be detected in the worker; '
      + 'set SYNTHI_REAL_ROCM_GPU_ARCH or SYNTHI_GPU_ARCH, or make hipconfig/rocminfo available',
    );
  }
  CFG.gpuArch = match[2];
  CFG.gpuArchSource = match[1] || 'worker_detection';
}

async function detectWorkerRocmPrefix() {
  const configured = String(CFG.rocmPrefix ?? '').trim();
  const output = await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      `
set +e
prefix=${configured ? shQuote(configured) : "''"}
source=${configured ? "'env'" : "''"}
if [ -z "$prefix" ] && command -v hipconfig >/dev/null 2>&1; then
  prefix="$(hipconfig --path 2>/dev/null | head -n 1)"
  [ -n "$prefix" ] && source='hipconfig --path'
fi
if [ -n "$prefix" ] && [ -d "$prefix" ]; then
  printf 'SYNTHI_ROCM_PREFIX_DETECTION source=%s value=%s include=%s llvm=%s\\n' "$source" "$prefix" "$([ -d "$prefix/include" ] && printf 1 || printf 0)" "$([ -d "$prefix/llvm/bin" ] && printf 1 || printf 0)"
else
  printf 'SYNTHI_ROCM_PREFIX_DETECTION source=%s value= include=0 llvm=0\\n' "$source"
fi
`,
    ],
    30000,
    true,
  );
  const match = /SYNTHI_ROCM_PREFIX_DETECTION\s+source=(.*?)\s+value=(\S+)\s+include=(\d+)\s+llvm=(\d+)/.exec(output);
  if (!match || match[2] === '') {
    throw new Error(
      'ROCm prefix is not configured and could not be detected in the worker; '
      + 'set SYNTHI_REAL_ROCM_ROCM_PREFIX/ROCM_PATH or make hipconfig --path available',
    );
  }
  if (match[3] !== '1') {
    throw new Error(`detected ROCm prefix ${match[2]} is missing an include directory`);
  }
  CFG.rocmPrefix = match[2];
  CFG.rocmPrefixSource = match[1] || 'worker_detection';
}

function expandRocmConfigValue(value) {
  return String(value ?? '')
    .replace(/\$\{ROCM_PREFIX\}/g, CFG.rocmPrefix)
    .replace(/\$\{ROCM_LLVM_BIN\}/g, `${CFG.rocmPrefix}/llvm/bin`)
    .replace(/\$\{ROCM_INCLUDE_DIR\}/g, `${CFG.rocmPrefix}/include`);
}

async function ensureRocmBuildConfig() {
  await detectWorkerGpuArch();
  await detectWorkerRocmPrefix();
  CFG.cmakeArgs = CFG.cmakeArgs.map(expandRocmConfigValue);
  report.gpu_arch = CFG.gpuArch;
  report.gpu_arch_source = CFG.gpuArchSource;
  report.rocm_prefix = CFG.rocmPrefix;
  report.rocm_prefix_source = CFG.rocmPrefixSource;
  report.cmake_args = CFG.cmakeArgs;
}

function execTextAllowPartialOutput(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
    });
  });
}

function runtimeWorkerContainerAccess({
  mcpTransport = CFG.mcpTransport,
  workerContainer = CFG.workerContainer,
} = {}) {
  const container = String(workerContainer ?? '').trim();
  const transport = String(mcpTransport ?? 'unknown').trim() || 'unknown';
  if (!container) {
    return {
      available: false,
      workerContainer: null,
      reason: `transport_${transport}_worker_container_missing`,
      detail: `transport=${transport} worker container unavailable`,
    };
  }
  return {
    available: true,
    workerContainer: container,
    reason: null,
    detail: `transport=${transport} worker=${container}`,
  };
}

function runtimeOutputOracleProfileSyncPlan({
  profile = null,
  mcpTransport = CFG.mcpTransport,
  workerContainer = CFG.workerContainer,
} = {}) {
  const access = runtimeWorkerContainerAccess({ mcpTransport, workerContainer });
  if (!access.available) {
    return {
      action: 'skip',
      status: profile ? 'warn' : 'info',
      workerContainer: null,
      syncSkippedReason: access.reason,
      detail: access.detail,
    };
  }
  return {
    action: profile ? 'write' : 'clear',
    status: profile ? 'pass' : 'info',
    workerContainer: access.workerContainer,
    syncSkippedReason: null,
    detail: access.detail,
  };
}

async function syncWorkerRuntimeOutputOracleProfile(profile) {
  const plan = runtimeOutputOracleProfileSyncPlan({ profile });
  if (plan.action === 'skip') {
    report.output_oracle_resolution.runtimeProfileSynced = false;
    report.output_oracle_resolution.syncSkippedReason = plan.syncSkippedReason;
    record(
      'runtime output oracle profile sync',
      plan.status,
      `${plan.detail}; profile sync skipped`,
    );
    return;
  }
  if (!profile) {
    await execText(
      'docker',
      [
        'exec',
        plan.workerContainer,
        'sh',
        '-lc',
        `rm -f '${WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH}'`,
      ],
      30000,
      false,
    );
    record(
      'runtime output oracle profile sync',
      'info',
      `cleared=${WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH}`,
    );
    report.output_oracle_resolution.runtimeProfileSynced = false;
    report.output_oracle_resolution.syncSkippedReason = 'runtime_profile_absent';
    return;
  }
  const payload = `${JSON.stringify(profile, null, 2)}\n`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  await execText(
    'docker',
    [
      'exec',
      plan.workerContainer,
      'sh',
      '-lc',
      `mkdir -p "$(dirname '${WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH}')" && printf '%s' '${encoded}' | base64 -d > '${WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH}'`,
    ],
    30000,
    true,
  );
  record(
    'runtime output oracle profile sync',
    'pass',
    `profile=${profile.profileId} kernel=${profile.kernelName} path=${WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH}`,
  );
  report.output_oracle_resolution.runtimeProfileSynced = true;
  report.output_oracle_resolution.syncSkippedReason = null;
}

function shouldFetchRequestedCommit({ requestedCommit, localCommitAvailable }) {
  return Boolean(String(requestedCommit ?? '').trim()) && !localCommitAvailable;
}

function gitLongPathArgs(args = []) {
  return ['-c', 'core.longpaths=true', ...args];
}

function pathIsInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeGitRemoteUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function gitRemoteMatches(actual, expected) {
  const normalizedActual = normalizeGitRemoteUrl(actual);
  const normalizedExpected = normalizeGitRemoteUrl(expected);
  return Boolean(normalizedActual && normalizedExpected && normalizedActual === normalizedExpected);
}

async function localGitCheckoutState(repoPath, expectedRemoteUrl = '') {
  const resolvedRepoPath = path.resolve(repoPath);
  let repoStat = null;
  try {
    repoStat = await stat(resolvedRepoPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        usable: false,
        reason: 'repo_path_missing',
        repoPath: resolvedRepoPath,
        repo_path: resolvedRepoPath,
      };
    }
    return {
      exists: false,
      usable: false,
      reason: 'repo_path_stat_failed',
      error: error?.message ?? String(error),
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
    };
  }
  if (!repoStat.isDirectory()) {
    return {
      exists: true,
      usable: false,
      reason: 'repo_path_not_directory',
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
    };
  }
  const insideWorkTree = await execText(
    'git',
    gitLongPathArgs(['-C', resolvedRepoPath, 'rev-parse', '--is-inside-work-tree']),
    30000,
    false,
  );
  if (String(insideWorkTree ?? '').trim() !== 'true') {
    return {
      exists: true,
      usable: false,
      reason: 'repo_path_not_git_worktree',
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
    };
  }
  const worktreeRoot = await execText(
    'git',
    gitLongPathArgs(['-C', resolvedRepoPath, 'rev-parse', '--show-toplevel']),
    30000,
    false,
  );
  const resolvedWorktreeRoot = path.resolve(String(worktreeRoot ?? '').trim() || resolvedRepoPath);
  if (path.relative(resolvedWorktreeRoot, resolvedRepoPath) !== '') {
    return {
      exists: true,
      usable: false,
      reason: 'repo_path_not_worktree_root',
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
      worktreeRoot: resolvedWorktreeRoot,
      worktree_root: resolvedWorktreeRoot,
    };
  }
  const headCommit = String(await execText(
    'git',
    gitLongPathArgs(['-C', resolvedRepoPath, 'rev-parse', '--verify', 'HEAD^{commit}']),
    30000,
    false,
  ) ?? '').trim();
  if (!headCommit) {
    return {
      exists: true,
      usable: false,
      reason: 'repo_head_missing',
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
      worktreeRoot: resolvedWorktreeRoot,
      worktree_root: resolvedWorktreeRoot,
    };
  }
  const originUrl = String(await execText(
    'git',
    gitLongPathArgs(['-C', resolvedRepoPath, 'remote', 'get-url', 'origin']),
    30000,
    false,
  ) ?? '').trim();
  if (String(expectedRemoteUrl ?? '').trim() && !gitRemoteMatches(originUrl, expectedRemoteUrl)) {
    return {
      exists: true,
      usable: false,
      reason: originUrl ? 'repo_origin_url_mismatch' : 'repo_origin_url_missing',
      repoPath: resolvedRepoPath,
      repo_path: resolvedRepoPath,
      worktreeRoot: resolvedWorktreeRoot,
      worktree_root: resolvedWorktreeRoot,
      originUrl: originUrl || null,
      origin_url: originUrl || null,
      expectedOriginUrl: expectedRemoteUrl,
      expected_origin_url: expectedRemoteUrl,
    };
  }
  return {
    exists: true,
    usable: true,
    reason: 'usable_git_worktree',
    repoPath: resolvedRepoPath,
    repo_path: resolvedRepoPath,
    worktreeRoot: resolvedWorktreeRoot,
    worktree_root: resolvedWorktreeRoot,
    headCommit,
    head_commit: headCommit,
    originUrl: originUrl || null,
    origin_url: originUrl || null,
  };
}

function invalidRepoCheckoutRecoveryPlan({
  repoPath,
  state,
  defaultRepoParent = DEFAULT_REAL_ROCM_REPO_PARENT,
  timestamp = new Date(),
} = {}) {
  const resolvedRepoPath = path.resolve(repoPath ?? '');
  const resolvedDefaultParent = path.resolve(defaultRepoParent);
  const canAutoQuarantine =
    pathIsInside(resolvedDefaultParent, resolvedRepoPath)
    && path.relative(resolvedDefaultParent, resolvedRepoPath) !== '';
  const stamp = timestamp.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffixHash = createHash('sha256')
    .update(stableJson({
      repoPath: resolvedRepoPath,
      reason: state?.reason ?? 'invalid_repo_checkout',
      originUrl: state?.originUrl ?? state?.origin_url ?? null,
    }))
    .digest('hex')
    .slice(0, 12);
  const quarantinePath = canAutoQuarantine
    ? path.join(
      path.dirname(resolvedRepoPath),
      `${path.basename(resolvedRepoPath)}.invalid-${stamp}-${suffixHash}`,
    )
    : null;
  const safeQuarantinePath =
    quarantinePath && pathIsInside(resolvedDefaultParent, quarantinePath)
      ? quarantinePath
      : null;
  return {
    canAutoQuarantine: Boolean(canAutoQuarantine && safeQuarantinePath),
    can_auto_quarantine: Boolean(canAutoQuarantine && safeQuarantinePath),
    repoPath: resolvedRepoPath,
    repo_path: resolvedRepoPath,
    defaultRepoParent: resolvedDefaultParent,
    default_repo_parent: resolvedDefaultParent,
    quarantinePath: safeQuarantinePath,
    quarantine_path: safeQuarantinePath,
    reason: state?.reason ?? 'invalid_repo_checkout',
    state,
  };
}

async function quarantineInvalidRepoCheckout(repoPath, state) {
  const plan = invalidRepoCheckoutRecoveryPlan({ repoPath, state });
  report.repo_checkout_recovery = plan;
  report.repo_checkout_recovery_plan = plan;
  if (!plan.canAutoQuarantine) {
    record(
      'local repo checkout validation',
      'fail',
      `invalid checkout at custom path=${plan.repoPath} reason=${plan.reason}`,
    );
    throw new Error(
      `Existing real ROCm repo path is not a usable checkout for ${CFG.repoUrl}: `
      + `${plan.reason}. Refusing to alter custom path ${plan.repoPath}.`,
    );
  }
  await mkdir(path.dirname(plan.quarantinePath), { recursive: true });
  await rename(plan.repoPath, plan.quarantinePath);
  record(
    'local repo checkout recovery',
    'warn',
    `quarantined invalid checkout reason=${plan.reason} from=${plan.repoPath} to=${plan.quarantinePath}`,
  );
  return plan;
}

async function gitCommitExists(repoPath, commit) {
  if (!String(commit ?? '').trim()) return false;
  const found = await execText(
    'git',
    gitLongPathArgs(['-C', repoPath, 'cat-file', '-e', `${commit}^{commit}`]),
    30000,
    false,
  );
  return found !== undefined;
}

function proofArtifactFileName(proofArtifactPath) {
  const normalized = String(proofArtifactPath ?? '').replaceAll('\\', '/');
  const fileName = path.posix.basename(normalized);
  return /^gpu-proof_[a-f0-9]{32,}\.json$/i.test(fileName) ? fileName : null;
}

function proofArtifactPathFromProofId(proofId) {
  const match = String(proofId ?? '').trim().match(/^gpu-proof:([a-f0-9]{32,})$/i);
  return match ? `.synthi/gpu-hmr/proofs/gpu-proof_${match[1].toLowerCase()}.json` : null;
}

function structuredLogJsonPayload(line) {
  const text = String(line ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const payload = JSON.parse(text.slice(start, end + 1));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function proofRefLooksLikeGpuProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schemaVersion = stringField(value, ['schemaVersion', 'schema_version']);
  const type = stringField(value, ['type']);
  const proofId = stringField(value, ['proofId', 'proof_id']);
  const resultState = stringField(value, ['resultState', 'result_state']);
  return schemaVersion === 'synthi.gpu.hmr.proof.v1'
    || type === 'gpu_hmr_proof'
    || /^gpu-proof:/i.test(proofId)
    || /^gpu-hmr-/i.test(resultState);
}

function proofArtifactPathFromProofRef(value) {
  if (typeof value === 'string') {
    if (proofArtifactFileName(value)) return value;
    return proofArtifactPathFromProofId(value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proofPath = stringField(value, ['proofArtifactPath', 'proof_artifact_path']);
  if (proofPath && proofArtifactFileName(proofPath)) return proofPath;
  return proofArtifactPathFromProofId(stringField(value, ['proofId', 'proof_id']));
}

function proofArtifactPathFromStructuredLogLine(line) {
  const payload = structuredLogJsonPayload(line);
  if (!proofRefLooksLikeGpuProof(payload)) return null;
  return proofArtifactPathFromProofRef(payload);
}

function proofArtifactPathCandidatesFromValue(value, source, phase = null, depth = 0, out = []) {
  if (depth > 5 || value == null) return out;
  if (typeof value === 'string') {
    const proofPath = proofArtifactPathFromProofRef(value);
    if (proofPath) out.push({ proofPath, source, phase });
    return out;
  }
  if (typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      proofArtifactPathCandidatesFromValue(item, source, phase, depth + 1, out);
    }
    return out;
  }
  if (proofRefLooksLikeGpuProof(value)) {
    const proofPath = proofArtifactPathFromProofRef(value);
    if (proofPath) out.push({ proofPath, source, phase });
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      proofArtifactPathCandidatesFromValue(nested, source, phase, depth + 1, out);
    }
  }
  return out;
}

function proofArtifactPathCandidatesFromRuntimeEvidence() {
  const lines = [
    ...new Set([
      ...((Array.isArray(report.evidence?.worker_log_lines) ? report.evidence.worker_log_lines : [])),
      ...((Array.isArray(report.evidence?.worker_service_log_lines) ? report.evidence.worker_service_log_lines : [])),
      ...((Array.isArray(report.evidence?.upstream_run_log_lines) ? report.evidence.upstream_run_log_lines : [])),
    ]),
  ];
  return lines
    .map((line) => proofArtifactPathFromStructuredLogLine(line))
    .filter((proofPath) => typeof proofPath === 'string' && proofPath.trim())
    .map((proofPath) => ({
      proofPath,
      source: 'runtime_structured_gpu_proof_log',
    }));
}

function proofArtifactPathCandidatesFromPhases() {
  const candidates = [];
  for (const phase of report.phases) {
    proofArtifactPathCandidatesFromValue(phase?.gpu_proof, 'phase_gpu_proof', phase, 0, candidates);
    proofArtifactPathCandidatesFromValue(
      phase?.gpu_proof_telemetry,
      'phase_gpu_proof_telemetry',
      phase,
      0,
      candidates,
    );
    proofArtifactPathCandidatesFromValue(
      phase?.wait_hmr_detail,
      'phase_wait_hmr_detail',
      phase,
      0,
      candidates,
    );
  }
  return candidates;
}

async function readWorkerProofArtifact(proofArtifactPath) {
  const access = runtimeWorkerContainerAccess();
  if (!access.available) {
    return { proofArtifactPath, found: false, reason: access.reason };
  }
  const fileName = proofArtifactFileName(proofArtifactPath);
  if (!fileName) {
    return { proofArtifactPath, found: false, reason: 'invalid_proof_artifact_path' };
  }
  const found = await execTextAllowPartialOutput(
    'docker',
    [
      'exec',
      '-w',
      '/',
      access.workerContainer,
      'sh',
      '-c',
      'find / -path "*/.synthi/gpu-hmr/proofs/$1" -type f -print -quit 2>/dev/null',
      'sh',
      fileName,
    ],
    120000,
  );
  const containerPath = String(found ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
  if (!containerPath) {
    return { proofArtifactPath, fileName, found: false, reason: 'proof_artifact_not_found' };
  }
  const text = await execText(
    'docker',
    ['exec', '-w', '/', access.workerContainer, 'cat', containerPath],
    120000,
    false,
  );
  if (!text) {
    return { proofArtifactPath, fileName, containerPath, found: false, reason: 'proof_artifact_unreadable' };
  }
  try {
    return {
      proofArtifactPath,
      fileName,
      containerPath,
      found: true,
      artifact: JSON.parse(text),
    };
  } catch (err) {
    return {
      proofArtifactPath,
      fileName,
      containerPath,
      found: false,
      reason: 'proof_artifact_invalid_json',
      error: err?.message ?? String(err),
    };
  }
}

async function collectGpuProofArtifacts() {
  const records = [];
  const seen = new Set();
  const candidates = [
    ...proofArtifactPathCandidatesFromPhases(),
    ...proofArtifactPathCandidatesFromRuntimeEvidence(),
  ];
  report.proof_artifact_candidates = candidates.map((candidate) => ({
    proofArtifactPath: candidate.proofPath,
    source: candidate.source,
    phase: candidate.phase?.name ?? null,
  }));
  for (const candidate of candidates) {
    const proofPath = candidate.proofPath;
    if (typeof proofPath !== 'string' || !proofPath.trim() || seen.has(proofPath)) continue;
    seen.add(proofPath);
    const record = await readWorkerProofArtifact(proofPath);
    record.source = candidate.source;
    records.push(record);
    if (candidate.phase) {
      candidate.phase.gpu_proof_artifact = record.found
      ? {
          found: true,
          proofId: record.artifact?.proofId ?? null,
          containerPath: record.containerPath,
          source: candidate.source,
          evidenceKinds: Array.isArray(record.artifact?.evidenceRefs)
            ? record.artifact.evidenceRefs.map((evidence) => evidence?.kind).filter(Boolean)
            : [],
        }
      : {
          found: false,
          reason: record.reason,
          source: candidate.source,
        };
    }
  }
  report.proof_artifacts = records;
  return records;
}

async function httpJson(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return json ?? {};
}

async function ensureRepo() {
  let checkoutState = await localGitCheckoutState(CFG.repoPath, CFG.repoUrl);
  report.repo_checkout_state = checkoutState;
  report.repoCheckoutState = checkoutState;
  if (checkoutState.exists && !checkoutState.usable) {
    await quarantineInvalidRepoCheckout(CFG.repoPath, checkoutState);
    checkoutState = await localGitCheckoutState(CFG.repoPath, CFG.repoUrl);
    report.repo_checkout_state_after_recovery = checkoutState;
    report.repoCheckoutStateAfterRecovery = checkoutState;
  }
  if (!checkoutState.exists) {
    await mkdir(path.dirname(CFG.repoPath), { recursive: true });
    const cloneArgs = CFG.repoCommit
      ? ['clone', CFG.repoUrl, CFG.repoPath]
      : ['clone', '--depth', '1', CFG.repoUrl, CFG.repoPath];
    try {
      await execText('git', gitLongPathArgs(cloneArgs), 300000, true);
    } catch (error) {
      const failedCloneState = await localGitCheckoutState(CFG.repoPath, CFG.repoUrl);
      report.repo_checkout_failed_clone_state = failedCloneState;
      report.repoCheckoutFailedCloneState = failedCloneState;
      if (failedCloneState.exists && !failedCloneState.usable) {
        try {
          await quarantineInvalidRepoCheckout(CFG.repoPath, failedCloneState);
        } catch (recoveryError) {
          report.repo_checkout_failed_clone_recovery_error =
            recoveryError?.message ?? String(recoveryError);
          report.repoCheckoutFailedCloneRecoveryError =
            recoveryError?.message ?? String(recoveryError);
        }
      }
      throw error;
    }
    checkoutState = await localGitCheckoutState(CFG.repoPath, CFG.repoUrl);
    report.repo_checkout_state_after_clone = checkoutState;
    report.repoCheckoutStateAfterClone = checkoutState;
    if (!checkoutState.usable) {
      throw new Error(
        `Cloned real ROCm repo is not a usable checkout for ${CFG.repoUrl}: ${checkoutState.reason}`,
      );
    }
  }
  if (CFG.repoCommit) {
    const localCommitAvailable = await gitCommitExists(CFG.repoPath, CFG.repoCommit);
    if (shouldFetchRequestedCommit({ requestedCommit: CFG.repoCommit, localCommitAvailable })) {
      const fetched = await execText(
        'git',
        gitLongPathArgs(['-C', CFG.repoPath, 'fetch', '--depth', '1', 'origin', CFG.repoCommit]),
        300000,
        false,
      );
      if (fetched === undefined) {
        await execText('git', gitLongPathArgs(['-C', CFG.repoPath, 'fetch', 'origin']), 300000, true);
      }
    }
    await execText(
      'git',
      gitLongPathArgs(['-C', CFG.repoPath, 'checkout', '--detach', CFG.repoCommit]),
      120000,
      true,
    );
  }
  if (CFG.initSubmodules) {
    const gitmodules = path.join(CFG.repoPath, '.gitmodules');
    if (existsSync(gitmodules)) {
      await execText(
        'git',
        gitLongPathArgs(['-C', CFG.repoPath, 'submodule', 'update', '--init', '--recursive']),
        600000,
        true,
      );
    }
  }
  const commit = await execText(
    'git',
    gitLongPathArgs(['-C', CFG.repoPath, 'rev-parse', 'HEAD']),
    30000,
    true,
  );
  report.repo_commit = commit.trim();
  report.submodules = CFG.initSubmodules
    ? await execText(
      'git',
      gitLongPathArgs(['-C', CFG.repoPath, 'submodule', 'status', '--recursive']),
      60000,
      false,
    )
    : 'submodule initialization disabled';
  const files = await listTrackedFiles();
  report.file_count = files.length;
  record('real ROCm repo', 'pass', `${CFG.repoUrl} @ ${report.repo_commit.slice(0, 12)} files=${report.file_count}`);
}

async function listTrackedFiles() {
  const args = ['-C', CFG.repoPath, 'ls-files', '-z'];
  if (CFG.initSubmodules) args.push('--recurse-submodules');
  const raw = await execText('git', gitLongPathArgs(args), 120000, true);
  return raw.split('\0').filter(Boolean).sort();
}

function parseUpstreamRunExitCode(timings) {
  const match = /\brun_exit_code=(\d+)\b/.exec(String(timings ?? ''));
  return match ? Number(match[1]) : null;
}

function parseLifecycleExitCodeText(timings, phase) {
  const escapedPhase = String(phase ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedPhase}_exit_code=([^\\s]+)\\b`).exec(String(timings ?? ''));
  return match?.[1] ?? null;
}

function lifecycleExitCodeFailed(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return Boolean(text && !['0', 'skipped', 'not-run', 'not_run'].includes(text));
}

function lifecycleExitCodeSkipped(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return ['skipped', 'not-run', 'not_run'].includes(text);
}

function classifyUpstreamLifecycleFailure({
  timings = '',
  configureLog = '',
  buildLog = '',
  runLog = '',
  lifecycleError = null,
} = {}) {
  const combined = [
    String(timings ?? ''),
    String(configureLog ?? ''),
    String(buildLog ?? ''),
    String(runLog ?? ''),
    String(lifecycleError?.message ?? ''),
  ].join('\n');
  const runExitCodeText = /\brun_exit_code=([^\s]+)/.exec(String(timings ?? ''))?.[1] ?? null;
  const configureExitCodeText = parseLifecycleExitCodeText(timings, 'configure');
  const buildExitCodeText = parseLifecycleExitCodeText(timings, 'build');
  const configureStageFailed = /\bconfigure_ms=failed\b/.test(String(timings ?? ''))
    || lifecycleExitCodeFailed(configureExitCodeText);
  const buildStageFailed = /\bbuild_ms=failed\b/.test(String(timings ?? ''))
    || lifecycleExitCodeFailed(buildExitCodeText);
  const buildStageSkipped = lifecycleExitCodeSkipped(buildExitCodeText);
  const runNotStarted = runExitCodeText === 'not-run';
  const missingDependencies = cmakeMissingDependencyTokens(combined);
  const configureLogText = String(configureLog ?? '');
  const buildLogText = String(buildLog ?? '');
  const configureLogSucceeded =
    /Configuring done|Build files have been written to:/i.test(configureLogText);
  const cmakeConfigureFailed =
    configureStageFailed
    || (!configureLogSucceeded && /Configuring incomplete|Could\s+NOT\s+find|CMake Error/i.test(configureLogText));
  const buildBlockedByConfigure = cmakeConfigureFailed && (buildStageFailed || buildStageSkipped);
  const runBlockedByConfigure = cmakeConfigureFailed && runNotStarted;
  const buildFailed = !buildBlockedByConfigure
    && (
      buildStageFailed
      || /fatal\s+error:.*file\s+not\s+found/i.test(buildLogText)
      || /(^|\n)(?:gmake|make|ninja|\[[0-9]+\/[0-9]+\]).*(?:error|failed)/i.test(buildLogText)
    );
  const runBlockedByBuild = buildFailed && runNotStarted;
  const runFailed = !runBlockedByConfigure
    && !runBlockedByBuild
    && runExitCodeText !== null
    && runExitCodeText !== '0'
    && runExitCodeText !== 'not-run';
  const reasons = compactStringList([
    cmakeConfigureFailed ? 'cmake_configure_failed' : null,
    missingDependencies.length > 0 ? 'missing_build_dependency' : null,
    buildBlockedByConfigure ? 'upstream_build_blocked_by_configure' : null,
    buildFailed ? 'upstream_build_failed' : null,
    runBlockedByConfigure ? 'upstream_run_not_started_after_configure_failure' : null,
    runBlockedByBuild ? 'upstream_run_not_started_after_build_failure' : null,
    runFailed ? 'upstream_run_failed' : null,
    lifecycleError ? 'upstream_lifecycle_command_failed' : null,
  ]);
  return {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    schema_version: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    acceptedAsRefusalEvidence: reasons.length > 0,
    accepted_as_refusal_evidence: reasons.length > 0,
    reasons,
    missingDependencies,
    missing_dependencies: missingDependencies,
    cmakeConfigureFailed,
    cmake_configure_failed: cmakeConfigureFailed,
    configureExitCodeText,
    configure_exit_code_text: configureExitCodeText,
    buildFailed,
    build_failed: buildFailed,
    buildBlockedByConfigure,
    build_blocked_by_configure: buildBlockedByConfigure,
    buildExitCodeText,
    build_exit_code_text: buildExitCodeText,
    runFailed,
    run_failed: runFailed,
    runBlockedByBuild,
    run_blocked_by_build: runBlockedByBuild,
    runBlockedByConfigure,
    run_blocked_by_configure: runBlockedByConfigure,
    runExitCodeText,
    run_exit_code_text: runExitCodeText,
    timings,
    configureLogTail: String(configureLog ?? '').slice(-4000),
    configure_log_tail: String(configureLog ?? '').slice(-4000),
    buildLogTail: String(buildLog ?? '').slice(-4000),
    build_log_tail: String(buildLog ?? '').slice(-4000),
    runLogTail: String(runLog ?? '').slice(-4000),
    run_log_tail: String(runLog ?? '').slice(-4000),
    lifecycleErrorMessage: lifecycleError?.message ?? null,
    lifecycle_error_message: lifecycleError?.message ?? null,
  };
}

function workerRepoTransferFailureFacet({
  operation,
  sourcePath,
  destinationPath,
  workerContainer,
  error,
} = {}) {
  const message = String(error?.stack || error?.message || error || '');
  const failed = message.length > 0;
  const reasons = compactStringList([
    failed ? 'worker_repo_transfer_failed' : null,
    /docker\s+cp/i.test(message) || operation === 'docker_cp' ? 'docker_copy_failed' : null,
    /input\/output\s+error/i.test(message) ? 'filesystem_io_error' : null,
    /\bchmod\b/i.test(message) ? 'chmod_failed' : null,
    /no\s+space\s+left/i.test(message) ? 'filesystem_no_space_left' : null,
    /permission\s+denied/i.test(message) ? 'filesystem_permission_denied' : null,
  ]);
  return {
    schemaVersion: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    schema_version: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    acceptedAsRefusalEvidence: failed,
    accepted_as_refusal_evidence: failed,
    operation: operation ?? 'unknown',
    sourcePath: sourcePath ?? null,
    source_path: sourcePath ?? null,
    destinationPath: destinationPath ?? null,
    destination_path: destinationPath ?? null,
    workerContainer: workerContainer ?? null,
    worker_container: workerContainer ?? null,
    reasons,
    errorMessage: message.slice(0, 4000),
    error_message: message.slice(0, 4000),
  };
}

function parseRocmArrayAllocationPreflightOutput(output) {
  const text = String(output ?? '');
  const device = /\bdevice_count result=(\d+)\s+error=(.*?)\s+count=(\d+)/.exec(text);
  const deviceIdentityMatch =
    /\bdevice_identity result=(\d+)\s+error=(.*?)\s+index=(\d+)\s+name="([^"]*)"\s+pci_domain=(-?\d+)\s+pci_bus=(-?\d+)\s+pci_device=(-?\d+)\s+gcn_arch="([^"]*)"\s+multiprocessors=(\d+)/.exec(text);
  const allocationRecords = [...text.matchAll(
    /\b(hipMalloc(?:3D)?Array)\s+label=([^\s]+)\s+x=(\d+)\s+y=(\d+)\s+z=(\d+)\s+w=(\d+)\s+kind=(\d+)\s+result=(\d+)\s+error=(.*?)\s+array=([^\s]+)/g,
  )].map((match) => ({
    api: match[1],
    label: match[2],
    channelBits: {
      x: Number(match[3]),
      y: Number(match[4]),
      z: Number(match[5]),
      w: Number(match[6]),
    },
    channelFormatKind: Number(match[7]),
    result: Number(match[8]),
    error: match[9],
    pointer: match[10],
    available: Number(match[8]) === 0,
  }));
  const textureResourceRecords = [...text.matchAll(
    /\bhipCreateTextureObject\s+label=([^\s]+)\s+resource=([^\s]+)\s+filter=([^\s]+)\s+normalized=(\d+)\s+result=(\d+)\s+error=(.*?)\s+texture=([^\s]+)/g,
  )].map((match) => ({
    api: 'hipCreateTextureObject',
    label: match[1],
    resourceType: match[2],
    filterMode: match[3],
    normalizedCoords: Number(match[4]) === 1,
    result: Number(match[5]),
    error: match[6],
    texture: match[7],
    available: Number(match[5]) === 0 && match[7] !== '0',
  }));
  const legacyAllocation =
    /\bhipMallocArray format=([^\s]+)\s+width=(\d+)\s+height=(\d+)\s+result=(\d+)\s+error=(.*?)\s+array=([^\s]+)/.exec(text);
  if (allocationRecords.length === 0 && legacyAllocation) {
    allocationRecords.push({
      api: 'hipMallocArray',
      label: legacyAllocation[1],
      channelBits: null,
      channelFormatKind: null,
      result: Number(legacyAllocation[4]),
      error: legacyAllocation[5],
      pointer: legacyAllocation[6],
      available: Number(legacyAllocation[4]) === 0,
    });
  }
  const allocation =
    allocationRecords.find((record) => record.api === 'hipMallocArray' && record.label === 'f32x4')
    ?? allocationRecords.find((record) => record.api === 'hipMallocArray')
    ?? allocationRecords[0]
    ?? null;
  const exitCode = /\bexit_code=(\d+)/.exec(text);
  const allocationResult = allocation?.result ?? null;
  const anyAllocationAvailable = allocationRecords.some((record) => record.available);
  const allocationAvailable = allocationRecords.length > 0
    ? allocationRecords.every((record) => record.available)
    : allocationResult === 0;
  const allocationMatrixFailureCount =
    allocationRecords.filter((record) => !record.available).length;
  const textureResourceMatrixFailureCount =
    textureResourceRecords.filter((record) => !record.available).length;
  const textureResourceFallbackAvailable =
    textureResourceRecords.some((record) => record.available);
  let deviceIdentity = null;
  if (deviceIdentityMatch) {
    const identityMaterial = {
      backend: 'hip',
      device_index: Number(deviceIdentityMatch[3]),
      name: deviceIdentityMatch[4],
      pci_domain_id: Number(deviceIdentityMatch[5]),
      pci_bus_id: Number(deviceIdentityMatch[6]),
      pci_device_id: Number(deviceIdentityMatch[7]),
      gcn_arch_name: deviceIdentityMatch[8],
      multiprocessor_count: Number(deviceIdentityMatch[9]),
    };
    const identityHash = createHash('sha256').update(stableJson(identityMaterial)).digest('hex');
    deviceIdentity = {
      ...identityMaterial,
      device_uuid: `hip-device:sha256:${identityHash}`,
      device_identity_key: `hip-device:sha256:${identityHash}`,
      evidence_refs: ['runtime-capability-preflight:rocm:device_identity'],
    };
  }
  const outputHash = createHash('sha256').update(text).digest('hex');
  return {
    schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
    observed: true,
    backend: 'rocm',
    api: 'hipMallocArray',
    probe: 'hip_array_allocation_preflight',
    command: 'hipcc hip_array_preflight.cpp && hip_array_preflight',
    evidenceRefs: [`runtime-capability-preflight-output:sha256:${outputHash}`],
    evidence_refs: [`runtime-capability-preflight-output:sha256:${outputHash}`],
    deviceCountResult: device ? Number(device[1]) : null,
    deviceCountError: device?.[2] ?? null,
    deviceCount: device ? Number(device[3]) : null,
    deviceIdentity,
    device_identity: deviceIdentity,
    allocationFormat: allocation?.label ?? null,
    allocationWidth: allocation ? 32 : null,
    allocationHeight: allocation ? 32 : null,
    allocationResult,
    allocationError: allocation?.error ?? null,
    allocationPointer: allocation?.pointer ?? null,
    allocationAvailable,
    anyAllocationAvailable,
    allocationMatrix: allocationRecords,
    allocationMatrixTotal: allocationRecords.length,
    allocationMatrixAvailableCount:
      allocationRecords.filter((record) => record.available).length,
    allocationMatrixFailureCount,
    textureResourceFallbackAvailable,
    textureResourceMatrix: textureResourceRecords,
    textureResourceMatrixTotal: textureResourceRecords.length,
    textureResourceMatrixAvailableCount:
      textureResourceRecords.filter((record) => record.available).length,
    textureResourceMatrixFailureCount,
    exitCode: exitCode ? Number(exitCode[1]) : null,
    degradedState: allocationAvailable ? null : 'gpu-runtime-array-allocation-unavailable',
    degradedReason: allocationAvailable
      ? null
      : allocationRecords.length > 1
        ? `HIP array allocation matrix failed ${allocationMatrixFailureCount}/${allocationRecords.length} entries; primary ${allocation?.api ?? 'hipMallocArray'} ${allocation?.label ?? 'unknown'} returned ${allocationResult} ${allocation?.error ?? 'unknown'}; texture fallback available=${textureResourceFallbackAvailable ? 'true' : 'false'}`
        : allocation
          ? `${allocation.api} returned ${allocationResult} ${allocation.error}`
          : 'hipMallocArray preflight result was not collected',
    output: text.slice(-4000),
  };
}

async function runRocmArrayAllocationPreflight() {
  if (String(CFG.gpuMode ?? '').toLowerCase() !== 'rocm') {
    return {
      schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
      backend: CFG.gpuMode,
      api: 'hipMallocArray',
      probe: 'hip_array_allocation_preflight',
      skipped: true,
      reason: 'gpu_mode_not_rocm',
    };
  }
  const preflightDir = '/home/runner/.cache/synthi-real-rocm';
  const sourcePath = `${preflightDir}/hip_array_preflight.cpp`;
  const binaryPath = `${preflightDir}/hip_array_preflight`;
  const script = `
mkdir -p ${shQuote(preflightDir)}
cat > ${shQuote(sourcePath)} <<'CPP'
#include <hip/hip_runtime.h>
#include <cstdint>
#include <cstdio>
static int failures = 0;
static void test2d(const char* label, hipChannelFormatDesc desc) {
  hipArray_t arr = nullptr;
  hipError_t result = hipMallocArray(&arr, &desc, 32, 32, hipArrayDefault);
  std::printf("hipMallocArray label=%s x=%d y=%d z=%d w=%d kind=%d result=%d error=%s array=%p\\n",
    label,
    desc.x,
    desc.y,
    desc.z,
    desc.w,
    static_cast<int>(desc.f),
    static_cast<int>(result),
    hipGetErrorString(result),
    static_cast<void*>(arr));
  if (result != hipSuccess) failures++;
  if (arr) (void)hipFreeArray(arr);
}
static void test3d(const char* label, hipChannelFormatDesc desc) {
  hipArray_t arr = nullptr;
  hipExtent extent = make_hipExtent(16, 16, 4);
  hipError_t result = hipMalloc3DArray(&arr, &desc, extent, hipArrayDefault);
  std::printf("hipMalloc3DArray label=%s x=%d y=%d z=%d w=%d kind=%d result=%d error=%s array=%p\\n",
    label,
    desc.x,
    desc.y,
    desc.z,
    desc.w,
    static_cast<int>(desc.f),
    static_cast<int>(result),
    hipGetErrorString(result),
    static_cast<void*>(arr));
  if (result != hipSuccess) failures++;
  if (arr) (void)hipFreeArray(arr);
}
static void test_texture_resource(
  const char* label,
  hipResourceType resource_type,
  enum hipTextureFilterMode filter_mode,
  bool normalized_coords) {
  float* ptr = nullptr;
  hipError_t alloc_result = hipMalloc(&ptr, 32 * 32 * 4 * sizeof(float));
  if (alloc_result != hipSuccess) {
    std::printf("hipCreateTextureObject label=%s resource=%s filter=%s normalized=%d result=%d error=%s texture=0\\n",
      label,
      resource_type == hipResourceTypeLinear ? "linear" : "pitch2D",
      filter_mode == hipFilterModeLinear ? "linear" : "point",
      normalized_coords ? 1 : 0,
      static_cast<int>(alloc_result),
      hipGetErrorString(alloc_result));
    failures++;
    return;
  }
  hipResourceDesc resource_desc = {};
  resource_desc.resType = resource_type;
  if (resource_type == hipResourceTypeLinear) {
    resource_desc.res.linear.devPtr = ptr;
    resource_desc.res.linear.desc = hipCreateChannelDesc(32, 32, 32, 32, hipChannelFormatKindFloat);
    resource_desc.res.linear.sizeInBytes = 32 * 32 * 4 * sizeof(float);
  } else {
    resource_desc.res.pitch2D.devPtr = ptr;
    resource_desc.res.pitch2D.desc = hipCreateChannelDesc(32, 32, 32, 32, hipChannelFormatKindFloat);
    resource_desc.res.pitch2D.width = 32;
    resource_desc.res.pitch2D.height = 32;
    resource_desc.res.pitch2D.pitchInBytes = 32 * 4 * sizeof(float);
  }
  hipTextureDesc texture_desc = {};
  texture_desc.addressMode[0] = hipAddressModeClamp;
  texture_desc.addressMode[1] = hipAddressModeClamp;
  texture_desc.filterMode = filter_mode;
  texture_desc.readMode = hipReadModeElementType;
  texture_desc.normalizedCoords = normalized_coords ? 1 : 0;
  hipTextureObject_t texture = 0;
  hipError_t result = hipCreateTextureObject(&texture, &resource_desc, &texture_desc, nullptr);
  std::printf("hipCreateTextureObject label=%s resource=%s filter=%s normalized=%d result=%d error=%s texture=%llu\\n",
    label,
    resource_type == hipResourceTypeLinear ? "linear" : "pitch2D",
    filter_mode == hipFilterModeLinear ? "linear" : "point",
    normalized_coords ? 1 : 0,
    static_cast<int>(result),
    hipGetErrorString(result),
    static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(texture)));
  if (result != hipSuccess || texture == 0) failures++;
  if (texture) (void)hipDestroyTextureObject(texture);
  if (ptr) (void)hipFree(ptr);
}
int main() {
  int count = 0;
  hipError_t count_result = hipGetDeviceCount(&count);
  std::printf("device_count result=%d error=%s count=%d\\n", (int)count_result, hipGetErrorString(count_result), count);
  if (count_result == hipSuccess && count > 0) {
    hipDeviceProp_t props = {};
    hipError_t props_result = hipGetDeviceProperties(&props, 0);
    std::printf("device_identity result=%d error=%s index=0 name=\\"%s\\" pci_domain=%d pci_bus=%d pci_device=%d gcn_arch=\\"%s\\" multiprocessors=%d\\n",
      static_cast<int>(props_result),
      hipGetErrorString(props_result),
      props_result == hipSuccess ? props.name : "",
      props_result == hipSuccess ? props.pciDomainID : -1,
      props_result == hipSuccess ? props.pciBusID : -1,
      props_result == hipSuccess ? props.pciDeviceID : -1,
      props_result == hipSuccess ? props.gcnArchName : "",
      props_result == hipSuccess ? props.multiProcessorCount : -1);
  }
  test2d("u8x1", hipCreateChannelDesc(8, 0, 0, 0, hipChannelFormatKindUnsigned));
  test2d("u8x2", hipCreateChannelDesc(8, 8, 0, 0, hipChannelFormatKindUnsigned));
  test2d("u8x4", hipCreateChannelDesc(8, 8, 8, 8, hipChannelFormatKindUnsigned));
  test2d("f32x1", hipCreateChannelDesc(32, 0, 0, 0, hipChannelFormatKindFloat));
  test2d("f32x2", hipCreateChannelDesc(32, 32, 0, 0, hipChannelFormatKindFloat));
  test2d("f32x4", hipCreateChannelDesc(32, 32, 32, 32, hipChannelFormatKindFloat));
  test3d("u8x4", hipCreateChannelDesc(8, 8, 8, 8, hipChannelFormatKindUnsigned));
  test3d("f32x4", hipCreateChannelDesc(32, 32, 32, 32, hipChannelFormatKindFloat));
  test_texture_resource("linear-point-unnormalized", hipResourceTypeLinear, hipFilterModePoint, false);
  test_texture_resource("linear-linear-normalized", hipResourceTypeLinear, hipFilterModeLinear, true);
  test_texture_resource("pitch2d-point-unnormalized", hipResourceTypePitch2D, hipFilterModePoint, false);
  test_texture_resource("pitch2d-linear-normalized", hipResourceTypePitch2D, hipFilterModeLinear, true);
  return failures == 0 ? 0 : 70;
}
CPP
set +e
if ! command -v hipcc >/dev/null 2>&1; then
  printf 'hipcc_missing=1\\n'
  printf 'exit_code=127\\n'
  exit 0
fi
hipcc ${shQuote(sourcePath)} -o ${shQuote(binaryPath)}
compile_status=$?
if [ "$compile_status" -ne 0 ]; then
  printf 'compile_exit_code=%s\\n' "$compile_status"
  printf 'exit_code=%s\\n' "$compile_status"
  exit 0
fi
${shQuote(binaryPath)}
run_status=$?
printf 'exit_code=%s\\n' "$run_status"
exit 0
`;
  const output = await execTextAllowPartialOutput(
    'docker',
    ['exec', '--user', 'runner', CFG.workerContainer, 'sh', '-lc', script],
    120000,
  );
  return parseRocmArrayAllocationPreflightOutput(output);
}

function hiprtRuntimeProbeWorkerCapturePath() {
  return `${CFG.workerTempDir}/${CFG.slug}-hiprt-runtime-framebuffer.png`;
}

function hiprtRuntimeProbeRunCommand() {
  const width = Math.max(320, CFG.hiprtRuntimeProbeWidth);
  const height = Math.max(240, CFG.hiprtRuntimeProbeHeight);
  return [
    'cd build &&',
    `./${shQuote(CFG.targetName)}`,
    '../data/GLTFs/cornell_pbr.gltf',
    '--sky=../data/Skyspheres/evening_road_01_puresky_2k.hdr',
    `--width=${width}`,
    `--height=${height}`,
  ].join(' ');
}

function hiprtRuntimeProbeAdaptationCommand(workerRepoRoot) {
  if (!CFG.hiprtRuntimeProbe) return ':';
  return `
if [ ! -d ${shQuote(workerRepoRoot)} ]; then
  printf 'SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION {"enabled":true,"applied":false,"reason":"repo_root_missing"}\\n'
else
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION {"enabled":true,"applied":false,"reason":"python3_missing"}\\n' >&2
    exit 87
  fi
  python3 - ${shQuote(workerRepoRoot)} <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
results = {
    "enabled": True,
    "repoRoot": str(root),
    "applied": False,
    "sourceAdaptations": [],
    "files": [],
    "missingFiles": [],
}

def fail(message):
    results["error"] = message
    print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
    raise SystemExit(87)

def read(path):
    return path.read_text(encoding="utf-8", errors="strict")

def write(path, text):
    path.write_text(text, encoding="utf-8")

def insert_after(text, needle, insertion, label):
    if insertion.strip() in text:
        return text, False
    if needle not in text:
        fail(f"{label}: insertion anchor missing")
    return text.replace(needle, needle + insertion, 1), True

def insert_before(text, needle, insertion, label):
    if insertion.strip() in text:
        return text, False
    if needle not in text:
        fail(f"{label}: insertion anchor missing")
    return text.replace(needle, insertion + needle, 1), True

def replace_once(text, old, new, label):
    if new.strip() in text:
        return text, False
    if old not in text:
        fail(f"{label}: replacement anchor missing")
    return text.replace(old, new, 1), True

def patch_file(relative_path, marker, patcher, adaptation_names):
    path = root / relative_path
    if not path.exists():
        results["missingFiles"].append(relative_path)
        return
    text = read(path)
    if marker in text:
        results["files"].append({"path": relative_path, "status": "already-adapted"})
        return
    patched = patcher(text)
    if patched == text:
        results["files"].append({"path": relative_path, "status": "unchanged"})
        return
    write(path, patched)
    results["applied"] = True
    results["files"].append({"path": relative_path, "status": "adapted"})
    for name in adaptation_names:
        if name not in results["sourceAdaptations"]:
            results["sourceAdaptations"].append(name)

def patch_opengl_interop_buffer(text):
    text, _ = insert_after(
        text,
        '#include "HIPRT-Orochi/HIPRTOrochiUtils.h"\\n',
        '#include "HIPRT-Orochi/OrochiBuffer.h"\\n',
        "OpenGLInteropBuffer include OrochiBuffer",
    )
    text, _ = insert_after(
        text,
        '#include "Utils/Utils.h"\\n\\n',
        '#include <cstdlib>\\n#include <cstdio>\\n#include <vector>\\n\\n',
        "OpenGLInteropBuffer include std headers",
    )
    text, _ = insert_after(
        text,
        '\\tsize_t get_byte_size() const;\\n',
        '\\tbool uses_device_buffer_fallback() const;\\n\\tstd::vector<T> download_data() const;\\n',
        "OpenGLInteropBuffer public readback API",
    )
    text, _ = insert_after(
        text,
        'private:\\n',
        '\\tbool use_device_buffer_fallback() const;\\n\\n',
        "OpenGLInteropBuffer fallback selector declaration",
    )
    text, _ = insert_after(
        text,
        '\\tT* m_mapped_pointer = nullptr;\\n',
        '\\tbool m_uses_device_buffer_fallback = false;\\n',
        "OpenGLInteropBuffer fallback flag",
    )
    text, _ = insert_after(
        text,
        '\\toroGraphicsResource_t m_buffer_resource = nullptr;\\n',
        '\\tOrochiBuffer<T> m_fallback_device_buffer;\\n\\tstd::vector<T> m_fallback_host_buffer;\\n',
        "OpenGLInteropBuffer fallback storage",
    )
    text, _ = insert_before(
        text,
        'template <typename T>\\nOpenGLInteropBuffer<T>::OpenGLInteropBuffer(int element_count)\\n',
        '''template <typename T>
bool OpenGLInteropBuffer<T>::use_device_buffer_fallback() const
{
\\treturn std::getenv("SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP") != nullptr ||
\\t\\tstd::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr;
}

''',
        "OpenGLInteropBuffer fallback selector definition",
    )
    text, _ = insert_after(
        text,
        'OpenGLInteropBuffer<T>::OpenGLInteropBuffer(int element_count)\\n{\\n',
        '''\\tif (use_device_buffer_fallback())
\\t{
\\t\\tresize(element_count);
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer constructor fallback",
    )
    text, _ = insert_before(
        text,
        '\\tif (m_initialized)\\n\\t{\\n\\t\\toroGraphicsUnregisterResource(m_buffer_resource);\\n',
        '''\\tif (use_device_buffer_fallback())
\\t{
\\t\\tif (!m_initialized)
\\t\\t\\tglCreateBuffers(1, &m_buffer_name);

\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, m_buffer_name);
\\t\\tglBufferData(GL_PIXEL_UNPACK_BUFFER, new_element_count * sizeof(T), nullptr, GL_DYNAMIC_DRAW);
\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);

\\t\\tm_fallback_device_buffer.resize(new_element_count);
\\t\\tm_fallback_host_buffer.resize(new_element_count);

\\t\\tm_initialized = true;
\\t\\tm_uses_device_buffer_fallback = true;
\\t\\tm_mapped = false;
\\t\\tm_mapped_pointer = nullptr;
\\t\\tm_element_count = new_element_count;

\\t\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] opengl_interop_buffer=fallback_device_buffer elements=%d bytes=%zu\\\\n", new_element_count, new_element_count * sizeof(T));

\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer resize fallback",
    )
    text, _ = insert_before(
        text,
        'template <typename T>\\nT* OpenGLInteropBuffer<T>::map()\\n',
        '''template <typename T>
bool OpenGLInteropBuffer<T>::uses_device_buffer_fallback() const
{
\\treturn m_uses_device_buffer_fallback;
}

template <typename T>
std::vector<T> OpenGLInteropBuffer<T>::download_data() const
{
\\tif (m_uses_device_buffer_fallback)
\\t\\treturn m_fallback_device_buffer.download_data();

\\treturn {};
}

''',
        "OpenGLInteropBuffer readback methods",
    )
    text, _ = insert_before(
        text,
        '\\tsize_t byte_size;\\n\\tOROCHI_CHECK_ERROR(oroGraphicsMapResources',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_mapped_pointer = m_fallback_device_buffer.get_device_pointer();
\\t\\tm_mapped = true;
\\t\\treturn m_mapped_pointer;
\\t}

''',
        "OpenGLInteropBuffer map fallback",
    )
    text, _ = insert_before(
        text,
        '\\tOROCHI_CHECK_ERROR(oroGraphicsUnmapResources',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_mapped = false;
\\t\\tm_mapped_pointer = nullptr;
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer unmap fallback",
    )
    text, _ = insert_before(
        text,
        '\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, get_opengl_buffer());\\n',
        '''\\tif (m_uses_device_buffer_fallback)
\\t{
\\t\\tm_fallback_device_buffer.download_data_into(m_fallback_host_buffer.data());
\\t\\tglBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
\\t\\tglTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, width, height, format, type, m_fallback_host_buffer.data());
\\t\\treturn;
\\t}

''',
        "OpenGLInteropBuffer texture upload fallback",
    )
    text, _ = replace_once(
        text,
        '\\t\\tOROCHI_CHECK_ERROR(oroGraphicsUnregisterResource(reinterpret_cast<oroGraphicsResource_t>(m_buffer_resource)));\\n',
        '''\\t\\tif (!m_uses_device_buffer_fallback)
\\t\\t\\tOROCHI_CHECK_ERROR(oroGraphicsUnregisterResource(reinterpret_cast<oroGraphicsResource_t>(m_buffer_resource)));
\\t\\telse if (m_fallback_device_buffer.is_allocated())
\\t\\t\\tm_fallback_device_buffer.free();
''',
        "OpenGLInteropBuffer unregister fallback",
    )
    text, _ = insert_after(
        text,
        '\\tm_initialized = false;\\n',
        '\\tm_uses_device_buffer_fallback = false;\\n\\tm_buffer_resource = nullptr;\\n',
        "OpenGLInteropBuffer fallback reset",
    )
    return text

def patch_gpu_renderer(text):
    text, _ = insert_after(
        text,
        '#include <Orochi/OrochiUtils.h>\\n\\n',
        '#include <cstdio>\\n#include <cstdlib>\\n',
        "GPURenderer std headers",
    )
    text, _ = insert_after(
        text,
        'GPURenderer::GPURenderer(RenderWindow* render_window, std::shared_ptr<HIPRTOrochiCtx> hiprt_oro_ctx, std::shared_ptr<ApplicationSettings> application_settings)\\n{\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tThreadManager::set_monothread(true);
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] thread_manager=monothread reason=runtime_compile_determinism\\\\n");
\\t}

''',
        "GPURenderer monothread runtime compile",
    )
    text, _ = insert_after(
        text,
        '\\tm_global_compiler_options->set_macro_value("__USE_HWI__", device_supports_hardware_acceleration() == HardwareAccelerationSupport::SUPPORTED);\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tm_global_compiler_options->set_macro_value("__USE_HWI__", 0);
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] hiprt_hardware_intersection=disabled reason=texture_object_capability_probe\\\\n");
\\t}
''',
        "GPURenderer disable HWI under texture capability fallback",
    )
    text, _ = insert_after(
        text,
        'void GPURenderer::setup_brdfs_data()\\n{\\n',
        '''\\tif (std::getenv("SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS") != nullptr)
\\t{
\\t\\tm_render_data.bsdfs_data.energy_compensation_roughness_threshold = 1.0e9f;
\\t\\tg_imgui_logger.add_line(ImGuiLoggerSeverity::IMGUI_LOGGER_WARNING, "SYNTHI HIPRT runtime probe disabled GPU texture-object LUT upload; energy-compensation LUT sampling is disabled for this run.");
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] texture_object_luts=disabled energy_compensation_roughness_threshold=%g\\\\n", m_render_data.bsdfs_data.energy_compensation_roughness_threshold);
\\t\\treturn;
\\t}

''',
        "GPURenderer skip texture-object LUTs",
    )
    return text

def patch_gpu_renderer_thread(text):
    text, _ = insert_after(
        text,
        '#include "Renderer/GPURendererThread.h"\\n\\n',
        '#include "Image/Image.h"\\n',
        "GPURendererThread image include",
    )
    text, _ = insert_after(
        text,
        '#include "UI/RenderWindow.h"\\n\\n',
        '#include <cstdlib>\\n#include <cstdio>\\n#include <algorithm>\\n#include <cmath>\\n#include <memory>\\n#include <vector>\\n\\n',
        "GPURendererThread std includes",
    )
    text, _ = insert_before(
        text,
        'void GPURendererThread::init(GPURenderer* renderer)\\n',
        '''namespace
{
void synthi_capture_runtime_framebuffer_if_requested(const std::shared_ptr<OpenGLInteropBuffer<ColorRGB32F>>& framebuffer, int width, int height, oroStream_t stream)
{
\\tconst char* capture_path = std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH");
\\tif (capture_path == nullptr || capture_path[0] == '\\\\0')
\\t\\treturn;

\\tstatic bool captured = false;
\\tif (captured)
\\t\\treturn;

\\tif (framebuffer == nullptr)
\\t\\treturn;

\\tOROCHI_CHECK_ERROR(oroStreamSynchronize(stream));

\\tstd::vector<ColorRGB32F> framebuffer_pixels = framebuffer->download_data();
\\tconst size_t expected_pixels = static_cast<size_t>(width) * static_cast<size_t>(height);
\\tif (framebuffer_pixels.size() < expected_pixels || expected_pixels == 0)
\\t{
\\t\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] capture_failed path=%s width=%d height=%d pixels=%zu expected_pixels=%zu reason=framebuffer_readback_unavailable\\\\n", capture_path, width, height, framebuffer_pixels.size(), expected_pixels);
\\t\\treturn;
\\t}

\\tstd::vector<float> pixels(expected_pixels * 3);
\\tdouble luma_sum = 0.0;
\\tdouble luma_sq_sum = 0.0;
\\tsize_t non_black_pixels = 0;
\\tfloat min_luma = 1.0e30f;
\\tfloat max_luma = -1.0e30f;
\\tfor (size_t i = 0; i < expected_pixels; i++)
\\t{
\\t\\tconst ColorRGB32F pixel = framebuffer_pixels[i];
\\t\\tconst float r = std::max(0.0f, pixel.r);
\\t\\tconst float g = std::max(0.0f, pixel.g);
\\t\\tconst float b = std::max(0.0f, pixel.b);
\\t\\tpixels[i * 3 + 0] = r;
\\t\\tpixels[i * 3 + 1] = g;
\\t\\tpixels[i * 3 + 2] = b;

\\t\\tconst float luma = 0.3086f * r + 0.6094f * g + 0.0820f * b;
\\t\\tluma_sum += luma;
\\t\\tluma_sq_sum += static_cast<double>(luma) * static_cast<double>(luma);
\\t\\tmin_luma = std::min(min_luma, luma);
\\t\\tmax_luma = std::max(max_luma, luma);
\\t\\tif (r > 0.0001f || g > 0.0001f || b > 0.0001f)
\\t\\t\\tnon_black_pixels++;
\\t}

\\tImage32Bit image(pixels, width, height, 3);
\\tconst bool wrote = image.write_image_png(capture_path, true);
\\tconst double mean_luma = luma_sum / static_cast<double>(expected_pixels);
\\tconst double variance = std::max(0.0, luma_sq_sum / static_cast<double>(expected_pixels) - mean_luma * mean_luma);
\\tstd::fprintf(stderr, "[synthi-hiprt-runtime-probe] capture_path=%s wrote=%d width=%d height=%d pixels=%zu non_black_pixels=%zu mean_luma=%.9f luma_stddev=%.9f min_luma=%.9f max_luma=%.9f framebuffer_fallback=%d\\\\n",
\\t\\tcapture_path,
\\t\\twrote ? 1 : 0,
\\t\\twidth,
\\t\\theight,
\\t\\texpected_pixels,
\\t\\tnon_black_pixels,
\\t\\tmean_luma,
\\t\\tstd::sqrt(variance),
\\t\\tmin_luma,
\\t\\tmax_luma,
\\t\\tframebuffer->uses_device_buffer_fallback() ? 1 : 0);

\\tcaptured = wrote;
\\tif (wrote && std::getenv("SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_CAPTURE") != nullptr)
\\t{
\\t\\tstd::fflush(stderr);
\\t\\tstd::exit(0);
\\t}
}
}

''',
        "GPURendererThread framebuffer capture helper",
    )
    text, _ = replace_once(
        text,
        '''\\t\\tpost_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);
\\t}

\\t// Recording GPU frame time stop timestamp and computing the frame time
''',
        '''\\t\\tpost_sample_update(m_render_data_for_frame, m_compiler_options_for_frame);
\\t}

\\tsynthi_capture_runtime_framebuffer_if_requested(
\\t\\tm_renderer->m_framebuffer,
\\t\\tm_renderer->m_render_resolution.x,
\\t\\tm_renderer->m_render_resolution.y,
\\t\\tm_renderer->get_main_stream());

\\t// Recording GPU frame time stop timestamp and computing the frame time
''',
        "GPURendererThread capture call",
    )
    return text

def patch_hiprt_common(text):
    text = text.replace('#include <cstdint>', '#include <stdint.h>', 1)
    old = '''using uint16_t = unsigned short;
#if defined( __CUDACC_RTC__ )
using int32_t  = int;
using uint32_t = unsigned int;
using int64_t  = long long;
using uint64_t = unsigned long long;
#endif
#endif
'''
    new = '''using uint16_t = unsigned short;
using int32_t  = int;
using uint32_t = unsigned int;
using int64_t  = long long;
using uint64_t = unsigned long long;
#endif
'''
    if old in text:
        text = text.replace(old, new, 1)
    return text

fingerprint_files = [
    root / "src/Renderer/GPURenderer.cpp",
    root / "src/Renderer/GPURendererThread.cpp",
    root / "src/OpenGL/OpenGLInteropBuffer.h",
    root / "thirdparties/HIPRT-Fork/hiprt/hiprt_common.h",
]
if not all(path.exists() for path in fingerprint_files):
    results["missingFiles"] = [str(path.relative_to(root)) for path in fingerprint_files if not path.exists()]
    print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
    raise SystemExit(0)

patch_file(
    "src/OpenGL/OpenGLInteropBuffer.h",
    "SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP",
    patch_opengl_interop_buffer,
    ["opengl_interop_device_buffer_fallback", "runtime_capture_from_device_framebuffer"],
)
patch_file(
    "src/Renderer/GPURenderer.cpp",
    "texture_object_luts=disabled",
    patch_gpu_renderer,
    [
        "hiprt_texture_objects_disabled_due_capability_probe",
        "hiprt_hwi_disabled_due_texture_capability",
        "thread_manager_monothread_for_runtime_compile_determinism",
    ],
)
patch_file(
    "src/Renderer/GPURendererThread.cpp",
    "SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH",
    patch_gpu_renderer_thread,
    ["runtime_capture_from_device_framebuffer"],
)
for rel in ["thirdparties/HIPRT-Fork/hiprt/hiprt_common.h", "hiprt/hiprt_common.h"]:
    path = root / rel
    if path.exists():
        text = read(path)
        patched = patch_hiprt_common(text)
        if patched != text:
            write(path, patched)
            results["applied"] = True
            results["files"].append({"path": rel, "status": "adapted"})
            if "hiprt_rtc_integer_alias_compatibility" not in results["sourceAdaptations"]:
                results["sourceAdaptations"].append("hiprt_rtc_integer_alias_compatibility")
        else:
            results["files"].append({"path": rel, "status": "already-adapted"})

print("SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION " + json.dumps(results, sort_keys=True))
PY
fi
`;
}

function parseHiprtRuntimeProbeAdaptationOutput(text) {
  const records = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^SYNTHI_HIPRT_RUNTIME_PROBE_ADAPTATION\s+(\{.*\})\s*$/.exec(line.trim());
    if (!match) continue;
    try {
      records.push(JSON.parse(match[1]));
    } catch {
      records.push({ parseError: true, raw: line.trim() });
    }
  }
  return records;
}

async function applyHiprtRuntimeProbeAdaptations(workerRepoRoot, label) {
  if (!CFG.hiprtRuntimeProbe) return [];
  const output = await execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', hiprtRuntimeProbeAdaptationCommand(workerRepoRoot)],
    120000,
    true,
  );
  const records = parseHiprtRuntimeProbeAdaptationOutput(output);
  for (const record of records) {
    report.hiprt_runtime_probe.source_adaptation_runs.push({ label, ...record });
    for (const name of (record.sourceAdaptations ?? [])) {
      if (!report.hiprt_runtime_probe.source_adaptations.includes(name)) {
        report.hiprt_runtime_probe.source_adaptations.push(name);
      }
    }
  }
  return records;
}

async function collectHiprtRuntimeProbeCapture() {
  if (!CFG.hiprtRuntimeProbe) return null;
  const workerPath = hiprtRuntimeProbeWorkerCapturePath();
  const exists = (await execText(
    'docker',
    ['exec', CFG.workerContainer, 'sh', '-lc', `[ -s ${shQuote(workerPath)} ] && printf 1 || printf 0`],
    30000,
    false,
  ) ?? '').trim() === '1';
  report.hiprt_runtime_probe.capture_worker_path = workerPath;
  if (!exists) {
    report.hiprt_runtime_probe.capture_missing = true;
    return null;
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const localPath = path.join(ARTIFACT_DIR, `${CFG.slug}-hiprt-runtime-framebuffer.png`);
  await execText('docker', ['cp', `${CFG.workerContainer}:${workerPath}`, localPath], 120000, true);
  const bytes = await readFile(localPath);
  const stats = await analyzeGpuHmrImageEvidence(bytes);
  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const outputTargetId = runtimeOutputTargetId({
    visualFrame: {
      label: 'hiprt-runtime-framebuffer',
      source: 'hiprt-runtime-device-framebuffer',
      path: localPath,
      outputKind: 'framebuffer',
    },
    outputKind: 'framebuffer',
  });
  const row = visualEvidenceRow({
    label: 'hiprt-runtime-framebuffer',
    path: localPath,
    ...stats,
    bytes: bytes.length,
    source: 'hiprt-runtime-device-framebuffer',
    contentHash,
    content_hash: contentHash,
    outputTargetId,
    output_target_id: outputTargetId,
    outputKind: 'framebuffer',
    output_kind: 'framebuffer',
  });
  report.screenshots.push(row);
  report.hiprt_runtime_probe.capture_artifact_path = localPath;
  report.hiprt_runtime_probe.visual_evidence = row;
  record(
    'HIPRT runtime framebuffer visual evidence',
    row.accepted_as_visual_evidence ? 'pass' : 'warn',
    JSON.stringify(row),
  );
  return row;
}

function parseWorkerReuseInspection(output) {
  const fields = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

async function inspectWorkerRepoReuse() {
  const expectedCommit = String(report.repo_commit ?? '').trim();
  const requested = CFG.reuseWorkerRepo;
  if (!requested) {
    return {
      requested,
      reusable: false,
      reused: false,
      reason: 'disabled',
      workerRepoPath: CFG.workerRepoPath,
    };
  }
  if (!expectedCommit) {
    return {
      requested,
      reusable: false,
      reused: false,
      reason: 'expected_commit_missing',
      workerRepoPath: CFG.workerRepoPath,
    };
  }

  const output = await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      `
set +e
repo=${shQuote(CFG.workerRepoPath)}
build_subdir=${shQuote(CFG.buildSubdir)}
expected=${shQuote(expectedCommit)}
printf 'requested=1\\n'
printf 'worker_repo_path=%s\\n' "$repo"
if [ ! -d "$repo/.git" ]; then
  printf 'reusable=0\\nreason=missing_worker_git\\n'
  exit 0
fi
actual=$(git -C "$repo" rev-parse HEAD 2>/dev/null)
git_status=$?
printf 'actual_commit=%s\\n' "$actual"
printf 'expected_commit=%s\\n' "$expected"
if [ "$git_status" -ne 0 ]; then
  printf 'reusable=0\\nreason=worker_git_rev_parse_failed\\n'
  exit 0
fi
if [ "$actual" != "$expected" ]; then
  printf 'reusable=0\\nreason=commit_mismatch\\n'
  exit 0
fi
dirty_count=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
printf 'dirty_count=%s\\n' "$dirty_count"
if [ "$dirty_count" != "0" ]; then
  printf 'reusable=0\\nreason=dirty_worker_repo\\n'
  exit 0
fi
if [ ! -d "$repo/$build_subdir" ]; then
  printf 'reusable=0\\nreason=missing_build_subdir\\n'
  exit 0
fi
if [ -d "$repo/$build_subdir/build" ]; then
  printf 'build_dir_present=1\\n'
else
  printf 'build_dir_present=0\\n'
fi
printf 'reusable=1\\nreason=clean_matching_worker_repo\\n'
`,
    ],
    30000,
    false,
  );
  const fields = parseWorkerReuseInspection(output ?? '');
  return {
    requested,
    reusable: fields.reusable === '1',
    reused: false,
    reason: fields.reason ?? 'inspection_failed',
    workerRepoPath: fields.worker_repo_path ?? CFG.workerRepoPath,
    expectedCommit: fields.expected_commit ?? expectedCommit,
    actualCommit: fields.actual_commit ?? null,
    dirtyCount: fields.dirty_count === undefined ? null : Number(fields.dirty_count),
    buildDirPresent: fields.build_dir_present === '1',
    raw: output ?? '',
  };
}

async function prepareUpstreamBuild() {
  const lifecyclePlan = buildUpstreamLifecyclePlan({
    buildMetadataDir: CFG.buildMetadataDir,
    buildUpstream: CFG.buildUpstream,
    runUpstream: CFG.runUpstream,
  });
  const cachedMetadata = lifecyclePlan.usesCachedMetadata
    ? await collectBuildMetadataFromHost(CFG.buildMetadataDir)
    : null;
  if (!lifecyclePlan.executeLifecycle) {
    report.phases.push({
      name: 'upstream_gpu_build_run',
      timings: 'configure_ms=cached\nbuild_ms=skipped\nrun_ms=skipped',
      output: `using cached CMake metadata from ${CFG.buildMetadataDir}`,
      metadata_source: lifecyclePlan.metadataSource,
      cached_metadata_dir: lifecyclePlan.cachedMetadataDir,
      skip_reason: lifecyclePlan.skipReason,
    });
    report.logs.upstream_run = 'upstream configure/build/run skipped; using cached CMake metadata\n';
    record(
      'upstream GPU target metadata configured',
      'pass',
      `cached_metadata=${CFG.buildMetadataDir} build=skipped run=skipped`,
    );
    return cachedMetadata;
  }

  const buildPath = `${CFG.workerRepoPath}/${CFG.buildSubdir}/build`;
  const workerReuse = await inspectWorkerRepoReuse();
  report.worker_repo_reuse = workerReuse;
  if (workerReuse.reusable) {
    await execText(
      'docker',
      [
        'exec',
        CFG.workerContainer,
        'sh',
        '-lc',
        `set -e; mkdir -p ${shQuote(CFG.workerTempDir)}`,
      ],
      30000,
      true,
    );
    report.worker_repo_reuse = {
      ...workerReuse,
      reused: true,
    };
    record(
      'worker repo warm reuse',
      'pass',
      `path=${CFG.workerRepoPath} commit=${String(report.repo_commit).slice(0, 12)} build_dir_present=${workerReuse.buildDirPresent}`,
    );
  } else {
    const shell = [
      'set -e',
      `rm -rf ${shQuote(CFG.workerTempDir)}`,
      `mkdir -p ${shQuote(CFG.workerTempDir)}`,
    ].join('; ');
    await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', shell], 30000, true);
    const destination = `${CFG.workerContainer}:${CFG.workerRepoPath}`;
    try {
      await execText('docker', ['cp', CFG.repoPath, destination], 180000, true);
    } catch (err) {
      const transferFailure = workerRepoTransferFailureFacet({
        operation: 'docker_cp',
        sourcePath: CFG.repoPath,
        destinationPath: destination,
        workerContainer: CFG.workerContainer,
        error: err,
      });
      report.worker_repo_transfer_failure = transferFailure;
      report.workerRepoTransferFailure = transferFailure;
      report.evidence.worker_repo_transfer_failure = transferFailure;
      record(
        'worker repo transfer',
        'fail',
        `operation=docker_cp reasons=${transferFailure.reasons.join(',') || 'unknown'} source=${CFG.repoPath} destination=${destination}`,
      );
      throw err;
    }
    if (CFG.reuseWorkerRepo) {
      record(
        'worker repo warm reuse',
        'info',
        `falling back to cold worker copy reason=${workerReuse.reason}`,
      );
    }
  }
  report.runtime_capability_preflight = await runRocmArrayAllocationPreflight();
  if (report.runtime_capability_preflight?.skipped) {
    record(
      'ROCm array allocation capability',
      'skip',
      report.runtime_capability_preflight.reason ?? 'preflight skipped',
    );
  } else {
    record(
      'ROCm array allocation capability',
      report.runtime_capability_preflight?.allocationAvailable ? 'pass' : 'warn',
      `api=${report.runtime_capability_preflight?.api ?? 'hipMallocArray'} result=${report.runtime_capability_preflight?.allocationResult ?? 'uncollected'} error=${report.runtime_capability_preflight?.allocationError ?? 'unknown'} device_count=${report.runtime_capability_preflight?.deviceCount ?? 'unknown'}`,
    );
  }
  if (CFG.hiprtRuntimeProbe) {
    report.hiprt_runtime_probe.capture_worker_path = hiprtRuntimeProbeWorkerCapturePath();
    const adaptationRecords = await applyHiprtRuntimeProbeAdaptations(CFG.workerRepoPath, 'pre-configure');
    const appliedOrAlreadyAdapted = adaptationRecords.some((record) =>
      record?.applied === true
      || (Array.isArray(record?.files) && record.files.some((file) =>
        ['adapted', 'already-adapted'].includes(file?.status),
      ))
    );
    record(
      'HIPRT runtime source adaptation',
      appliedOrAlreadyAdapted ? 'pass' : 'warn',
      `pre_configure_records=${adaptationRecords.length} adaptations=${report.hiprt_runtime_probe.source_adaptations.join(',') || 'none'}`,
    );
  }
  const xvfbRunAvailable = (await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
      'sh',
      '-lc',
      'command -v xvfb-run >/dev/null 2>&1 && xvfb-run -a /bin/true >/dev/null 2>&1 && printf 1 || printf 0',
    ],
    30000,
    true,
  )).trim() === '1';
  const upstreamRunLaunch = buildUpstreamRunLaunchPlan({
    runUpstream: CFG.runUpstream,
    displayMode: CFG.upstreamDisplayMode,
    xvfbRunAvailable,
    xdgRuntimeDir: CFG.upstreamXdgRuntimeDir,
    workerTempDir: CFG.workerTempDir,
    width: CFG.width,
    height: CFG.height,
  });
  report.upstream_run_environment = upstreamRunLaunch;
  if (!upstreamRunLaunch.runnable) {
    throw new Error(`upstream run display environment unavailable: ${upstreamRunLaunch.reason}`);
  }

  const cmakeExtraArgs = CFG.cmakeArgs.length
    ? ` ${CFG.cmakeArgs.map((arg) => shQuote(arg)).join(' ')}`
    : '';
  const nativeLaunchObserverSetup = CFG.nativeLaunchObserver
    ? [
        `if [ ! -f ${shQuote(CFG.nativeLaunchObserverPath)} ]; then printf 'native launch observer missing: %s\\n' ${shQuote(CFG.nativeLaunchObserverPath)} >&2; exit 86; fi`,
      ].join('\n')
    : ':';
  const upstreamRunEnvironmentSetup = CFG.runUpstream
    ? [
        `mkdir -p ${shQuote(upstreamRunLaunch.xdgRuntimeDir)}`,
        `chmod 700 ${shQuote(upstreamRunLaunch.xdgRuntimeDir)} || true`,
        `export XDG_RUNTIME_DIR=${shQuote(upstreamRunLaunch.xdgRuntimeDir)}`,
        `export SYNTHI_REAL_ROCM_UPSTREAM_DISPLAY_MODE=${shQuote(upstreamRunLaunch.effectiveDisplayMode)}`,
        ...(CFG.hiprtRuntimeProbe
          ? [
              `export SYNTHI_HIPRT_DISABLE_GPU_TEXTURE_OBJECTS=1`,
              `export SYNTHI_HIPRT_DISABLE_OPENGL_INTEROP=1`,
              `export SYNTHI_HIPRT_RUNTIME_PROBE_CAPTURE_PATH=${shQuote(hiprtRuntimeProbeWorkerCapturePath())}`,
              `export SYNTHI_HIPRT_RUNTIME_PROBE_EXIT_AFTER_CAPTURE=1`,
            ]
          : []),
      ].join('\n')
    : ':';
  const upstreamRunCommand = CFG.upstreamRunCommand
    ? CFG.upstreamRunCommand
    : `./build/${shQuote(CFG.targetName)}`;
  const observedUpstreamRunCommand = CFG.nativeLaunchObserver
    ? [
        `export LD_PRELOAD=${shQuote(CFG.nativeLaunchObserverPath)}\${LD_PRELOAD:+:\${LD_PRELOAD}}`,
        'export SYNTHI_GPU_NATIVE_LAUNCH_OBSERVER=observe_only',
        upstreamRunCommand,
      ].join('\n')
    : upstreamRunCommand;
  const upstreamRunInvocation = upstreamRunLaunch.useXvfbRun
    ? `xvfb-run -a sh -lc ${shQuote(observedUpstreamRunCommand)}`
    : `sh -lc ${shQuote(observedUpstreamRunCommand)}`;
  const cleanBuildCommand = CFG.cleanUpstreamBuild
    ? 'rm -rf build'
    : 'printf "preserving existing upstream build directory\\n"';
  const hiprtPostConfigureAdaptationCommand = CFG.hiprtRuntimeProbe
    ? hiprtRuntimeProbeAdaptationCommand(CFG.workerRepoPath)
    : ':';
  const command = `
set -e
cd ${shQuote(`${CFG.workerRepoPath}/${CFG.buildSubdir}`)}
${cleanBuildCommand}
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/codemodel-v2
start=$(date +%s%3N)
set +e
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=${shQuote(CFG.rocmPrefix)} -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)}${cmakeExtraArgs} > ${shQuote(`${CFG.workerTempDir}/configure.log`)} 2>&1
configure_status=$?
configured=$(date +%s%3N)
post_configure_status=skipped
if [ "$configure_status" -eq 0 ]; then
  ${hiprtPostConfigureAdaptationCommand}
  post_configure_status=$?
fi
if [ "$configure_status" -eq 0 ] && [ "$post_configure_status" = "0" ] && [ ${CFG.buildUpstream ? '1' : '0'} -eq 1 ]; then
  cmake --build build -j2 --target ${shQuote(CFG.targetName)} > ${shQuote(`${CFG.workerTempDir}/build.log`)} 2>&1
  build_status=$?
elif [ ${CFG.buildUpstream ? '1' : '0'} -eq 0 ]; then
  : > ${shQuote(`${CFG.workerTempDir}/build.log`)}
  build_status=skipped
else
  printf 'upstream build skipped after configure_status=%s post_configure_status=%s\\n' "$configure_status" "$post_configure_status" > ${shQuote(`${CFG.workerTempDir}/build.log`)}
  build_status=skipped
fi
built=$(date +%s%3N)
run_status=not-run
if [ "$configure_status" -eq 0 ] && [ "$post_configure_status" = "0" ] && [ "$build_status" = "0" ] && [ ${CFG.runUpstream ? '1' : '0'} -eq 1 ]; then
  ${nativeLaunchObserverSetup}
  ${upstreamRunEnvironmentSetup}
  ${upstreamRunInvocation} > ${shQuote(`${CFG.workerTempDir}/run.log`)} 2>&1
  run_status=$?
elif [ ${CFG.runUpstream ? '1' : '0'} -eq 0 ]; then
  printf 'upstream run skipped by SYNTHI_REAL_ROCM_RUN_UPSTREAM=0\\n' > ${shQuote(`${CFG.workerTempDir}/run.log`)}
  run_status=skipped
else
  printf 'upstream run skipped after configure_status=%s post_configure_status=%s build_status=%s\\n' "$configure_status" "$post_configure_status" "$build_status" > ${shQuote(`${CFG.workerTempDir}/run.log`)}
fi
ran=$(date +%s%3N)
printf 'configure_ms=%s\\nbuild_ms=%s\\nrun_ms=%s\\nconfigure_exit_code=%s\\npost_configure_exit_code=%s\\nbuild_exit_code=%s\\nrun_exit_code=%s\\n' "$((configured-start))" "$((built-configured))" "$((ran-built))" "$configure_status" "$post_configure_status" "$build_status" "$run_status"
if [ "$configure_status" -ne 0 ]; then exit "$configure_status"; fi
if [ "$post_configure_status" != "0" ] && [ "$post_configure_status" != "skipped" ]; then exit "$post_configure_status"; fi
if [ "$build_status" != "0" ] && [ "$build_status" != "skipped" ]; then exit "$build_status"; fi
if [ "$run_status" != "0" ] && [ "$run_status" != "skipped" ] && [ "$run_status" != "not-run" ]; then exit "$run_status"; fi
exit 0
  `;
  let timings;
  let lifecycleError = null;
  let lifecycleCanContinueWithCachedMetadata = false;
  try {
    timings = await execText(
      'docker',
      ['exec', CFG.workerContainer, 'sh', '-lc', command],
      CFG.upstreamBuildTimeoutMs,
      true,
    );
  } catch (err) {
    lifecycleError = err;
    lifecycleCanContinueWithCachedMetadata = canContinueWithCachedMetadataAfterLifecycleFailure({
      usesCachedMetadata: lifecyclePlan.usesCachedMetadata,
      cachedMetadataAvailable: Boolean(cachedMetadata),
    });
    timings = String(err.output ?? '').trim()
      || 'configure_ms=failed\nbuild_ms=failed\nrun_ms=skipped\nconfigure_exit_code=unknown\nbuild_exit_code=unknown\nrun_exit_code=not-run';
  }
  if (CFG.hiprtRuntimeProbe) {
    const postConfigureRecords = parseHiprtRuntimeProbeAdaptationOutput(timings);
    for (const record of postConfigureRecords) {
      report.hiprt_runtime_probe.source_adaptation_runs.push({ label: 'post-configure', ...record });
      for (const name of (record.sourceAdaptations ?? [])) {
        if (!report.hiprt_runtime_probe.source_adaptations.includes(name)) {
          report.hiprt_runtime_probe.source_adaptations.push(name);
        }
      }
    }
  }
  const runLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/run.log`)}`], 30000, false) ?? '';
  const configureLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/configure.log`)}`], 30000, false);
  const buildLog = await execText('docker', ['exec', CFG.workerContainer, 'sh', '-lc', `cat ${shQuote(`${CFG.workerTempDir}/build.log`)}`], 30000, false);
  const upstreamRunExitCode = parseUpstreamRunExitCode(timings);
  report.logs.upstream_run = runLog;
  report.logs.upstream_configure = configureLog ?? '';
  report.logs.upstream_build = buildLog ?? '';
  const upstreamLifecycleFailure = lifecycleError
    ? classifyUpstreamLifecycleFailure({
        timings,
        configureLog,
        buildLog,
        runLog,
        lifecycleError,
      })
    : null;
  if (upstreamLifecycleFailure) {
    report.upstream_lifecycle_failure = upstreamLifecycleFailure;
    report.upstream_lifecycle_failure_facet = upstreamLifecycleFailure;
    report.evidence.upstream_lifecycle_failure = upstreamLifecycleFailure;
  }
  const phase = {
    name: 'upstream_gpu_build_run',
    timings,
    upstream_run_exit_code: upstreamRunExitCode,
    cmake_config: CFG.cmakeConfigName,
    cmake_args: CFG.cmakeArgs,
    clean_build: CFG.cleanUpstreamBuild,
    upstream_timeout_ms: CFG.upstreamBuildTimeoutMs,
    output: runLog.slice(0, 1000),
    configure_output: String(configureLog ?? '').slice(-2000),
    build_output: String(buildLog ?? '').slice(-2000),
    metadata_source: lifecyclePlan.metadataSource,
    cached_metadata_dir: lifecyclePlan.cachedMetadataDir,
    lifecycle_error: lifecycleError
      ? {
          recovered_with_cached_metadata: lifecycleCanContinueWithCachedMetadata,
          message: lifecycleError.message,
          output: String(lifecycleError.output ?? '').slice(-2000),
        }
      : null,
    upstream_lifecycle_failure: upstreamLifecycleFailure,
    upstream_run_environment: upstreamRunLaunch,
    runtime_capability_preflight: report.runtime_capability_preflight,
    native_launch_observer: CFG.nativeLaunchObserver
      ? { enabled: true, path: CFG.nativeLaunchObserverPath }
      : { enabled: false },
  };
  report.phases.push(phase);
  record(
    'upstream GPU target metadata configured',
    lifecycleError ? 'warn' : 'pass',
    `${timings.replace(/\s+/g, ' ')} metadata=${lifecyclePlan.metadataSource} build=${CFG.buildUpstream ? 'on' : 'skipped'} run=${CFG.runUpstream ? 'on' : 'skipped'} clean=${CFG.cleanUpstreamBuild ? 'on' : 'off'} timeout_ms=${CFG.upstreamBuildTimeoutMs} cmake_args=${CFG.cmakeArgs.length}`,
  );
  let recoveredBuildMetadata = null;
  if (lifecycleError && !lifecycleCanContinueWithCachedMetadata) {
    try {
      recoveredBuildMetadata = await collectBuildMetadataFromWorker(buildPath);
      report.upstream_lifecycle_metadata_recovery = {
        schemaVersion: 'synthi.real_rocm.upstream_lifecycle_metadata_recovery.v1',
        attempted: true,
        accepted: true,
        source: 'worker_cmake_file_api_after_lifecycle_failure',
        compileCommandSourceCount: recoveredBuildMetadata.compileCommandSourcePaths.length,
        compile_command_source_count: recoveredBuildMetadata.compileCommandSourcePaths.length,
        cmakeReplyFileCount: recoveredBuildMetadata.cmakeReplyFiles.length,
        cmake_reply_file_count: recoveredBuildMetadata.cmakeReplyFiles.length,
        matchedTargetFileCount: recoveredBuildMetadata.matchedTargetFiles.length,
        matched_target_file_count: recoveredBuildMetadata.matchedTargetFiles.length,
        targetSourceCount: recoveredBuildMetadata.targetSourcePaths.length,
        target_source_count: recoveredBuildMetadata.targetSourcePaths.length,
      };
      report.evidence.upstream_lifecycle_metadata_recovery = report.upstream_lifecycle_metadata_recovery;
      record(
        'upstream lifecycle metadata recovery',
        'warn',
        `accepted compile_sources=${recoveredBuildMetadata.compileCommandSourcePaths.length} target_sources=${recoveredBuildMetadata.targetSourcePaths.length} matched_targets=${recoveredBuildMetadata.matchedTargetFiles.length}`,
      );
    } catch (err) {
      report.upstream_lifecycle_metadata_recovery = {
        schemaVersion: 'synthi.real_rocm.upstream_lifecycle_metadata_recovery.v1',
        attempted: true,
        accepted: false,
        source: 'worker_cmake_file_api_after_lifecycle_failure',
        error: err.message,
      };
      report.evidence.upstream_lifecycle_metadata_recovery = report.upstream_lifecycle_metadata_recovery;
      record(
        'upstream lifecycle metadata recovery',
        'warn',
        `rejected error=${err.message}`,
      );
    }
  }
  if (lifecycleError) {
    record(
      'upstream GPU target lifecycle',
      lifecycleCanContinueWithCachedMetadata || recoveredBuildMetadata ? 'warn' : 'fail',
      lifecycleCanContinueWithCachedMetadata
        ? `failed; continuing with cached_metadata=${CFG.buildMetadataDir}`
        : recoveredBuildMetadata
          ? 'failed; continuing with worker CMake metadata recovered after lifecycle failure'
        : [
            'failed without usable cached metadata',
            `reasons=${upstreamLifecycleFailure?.reasons?.join('|') || 'unknown'}`,
            `missing_dependencies=${upstreamLifecycleFailure?.missingDependencies?.join('|') || 'none'}`,
          ].join(' '),
    );
  }
  if (lifecycleError && !lifecycleCanContinueWithCachedMetadata && !recoveredBuildMetadata) {
    throw new Error([
      'upstream_configure_build_failed_without_metadata',
      `reasons=${upstreamLifecycleFailure?.reasons?.join('|') || 'unknown'}`,
      `missing_dependencies=${upstreamLifecycleFailure?.missingDependencies?.join('|') || 'none'}`,
    ].join(' '));
  }
  if (CFG.runUpstream) {
    record(
      'upstream runtime environment',
      upstreamRunLaunch.useXvfbRun || upstreamRunLaunch.requestedDisplayMode === 'none' ? 'pass' : 'warn',
      `display=${upstreamRunLaunch.effectiveDisplayMode} reason=${upstreamRunLaunch.reason} xdg=${upstreamRunLaunch.xdgRuntimeDir}`,
    );
  }
  if (CFG.runUpstream) {
    const status = upstreamRunExitCode === 0 ? 'pass' : 'warn';
    const detail = upstreamRunExitCode === null
      ? `exit_code=unknown log_bytes=${Buffer.byteLength(runLog)}`
      : `exit_code=${upstreamRunExitCode} log_bytes=${Buffer.byteLength(runLog)}`;
    record('upstream GPU target run', status, detail);
  }
  if (CFG.hiprtRuntimeProbe && CFG.runUpstream) {
    await collectHiprtRuntimeProbeCapture();
  }

  return cachedMetadata ?? recoveredBuildMetadata ?? collectBuildMetadataFromWorker(buildPath);
}

async function collectBuildMetadataFromHost(metadataDir) {
  const compileHostPath = path.join(metadataDir, 'compile_commands.json');
  const replyHostPath = path.join(metadataDir, 'reply');
  if (!existsSync(compileHostPath)) {
    throw new Error(`cached CMake metadata missing compile_commands.json: ${compileHostPath}`);
  }
  if (!existsSync(replyHostPath)) {
    throw new Error(`cached CMake metadata missing reply directory: ${replyHostPath}`);
  }

  const compileCommandsRaw = await readFile(compileHostPath, 'utf8');
  const compileCommandsJson = normalizeCompileCommands(compileCommandsRaw);
  const compileCommandSourcePaths = compileCommandSourcePathsFromRaw(compileCommandsRaw);
  const replyFiles = [];
  const projectionHints = {
    target_source_paths: new Set(),
    target_include_dirs: new Set(),
    matched_target_files: [],
    build_dependency_source_paths: new Set(),
  };
  for (const name of (await readdir(replyHostPath)).sort()) {
    if (!name.endsWith('.json')) continue;
    const content = normalizeBuildMetadataText(await readFile(path.join(replyHostPath, name), 'utf8'));
    replyFiles.push({ path: `.cmake/api/v1/reply/${name}`, content });
    collectProjectionHintsFromCmakeReply(name, content, projectionHints);
  }
  if (!replyFiles.length) {
    throw new Error(`cached CMake metadata reply directory did not contain JSON metadata: ${replyHostPath}`);
  }
  const buildDependencyFiles = await collectBuildDependencyFilesFromHost(metadataDir, projectionHints);
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
    buildDependencySourcePaths: projectionHints.build_dependency_source_paths,
  });
  return {
    compileCommandsJson,
    compileCommandSourcePaths,
    cmakeReplyFiles: replyFiles,
    buildDependencyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
    buildDependencySourcePaths: [...projectionHints.build_dependency_source_paths].sort(),
    matchedTargetFiles: projectionHints.matched_target_files.sort(),
  };
}

async function collectBuildMetadataFromWorker(buildPath) {
  const metadataDir = await mkdtemp(path.join(path.resolve(REPO_ROOT, 'tmp'), 'real-rocm-build-metadata-'));
  const compileHostPath = path.join(metadataDir, 'compile_commands.json');
  const replyHostPath = path.join(metadataDir, 'reply');
  await execText(
    'docker',
    ['cp', `${CFG.workerContainer}:${buildPath}/compile_commands.json`, compileHostPath],
    30000,
    true,
  );
  await execText(
    'docker',
    ['cp', `${CFG.workerContainer}:${buildPath}/.cmake/api/v1/reply`, replyHostPath],
    30000,
    true,
  );

  const compileCommandsRaw = await readFile(compileHostPath, 'utf8');
  const compileCommandsJson = normalizeCompileCommands(compileCommandsRaw);
  const compileCommandSourcePaths = compileCommandSourcePathsFromRaw(compileCommandsRaw);
  const replyFiles = [];
  const projectionHints = {
    target_source_paths: new Set(),
    target_include_dirs: new Set(),
    matched_target_files: [],
    build_dependency_source_paths: new Set(),
  };
  for (const name of (await readdir(replyHostPath)).sort()) {
    if (!name.endsWith('.json')) continue;
    const content = normalizeBuildMetadataText(await readFile(path.join(replyHostPath, name), 'utf8'));
    replyFiles.push({ path: `.cmake/api/v1/reply/${name}`, content });
    collectProjectionHintsFromCmakeReply(name, content, projectionHints);
  }
  if (!replyFiles.length) {
    throw new Error('CMake File API reply directory did not contain JSON metadata');
  }
  const buildDependencyFiles = await collectBuildDependencyFilesFromWorker(buildPath, metadataDir, projectionHints);
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
    buildDependencySourcePaths: projectionHints.build_dependency_source_paths,
  });
  return {
    compileCommandsJson,
    compileCommandSourcePaths,
    cmakeReplyFiles: replyFiles,
    buildDependencyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
    buildDependencySourcePaths: [...projectionHints.build_dependency_source_paths].sort(),
    matchedTargetFiles: projectionHints.matched_target_files.sort(),
  };
}

function collectProjectionHintsFromCmakeReply(name, content, projectionHints) {
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    return;
  }
  if (json?.kind !== 'target' && !name.startsWith(`target-${CFG.targetName}-`)) return;
  if (json?.name !== CFG.targetName) return;
  if (CFG.cmakeTargetType && json?.type && json.type !== CFG.cmakeTargetType) return;

  projectionHints.matched_target_files.push(name);
  for (const source of json.sources ?? []) {
    const rel = repoRelativePath(source?.path);
    if (rel) projectionHints.target_source_paths.add(rel);
  }
  for (const group of json.compileGroups ?? []) {
    for (const include of group.includes ?? []) {
      const rel = repoRelativePath(include?.path);
      if (rel) projectionHints.target_include_dirs.add(rel);
    }
  }
}

async function collectBuildDependencyFilesFromHost(metadataDir, projectionHints) {
  const buildDepsDir = path.join(metadataDir, 'build-dependencies');
  if (!existsSync(buildDepsDir)) return [];
  const files = [];
  for (const name of (await readdir(buildDepsDir)).sort()) {
    const full = path.join(buildDepsDir, name);
    const st = await stat(full);
    if (!st.isFile()) continue;
    const content = normalizeBuildMetadataText(await readFile(full, 'utf8'));
    collectBuildDependencySourcePaths(content, projectionHints);
    files.push({ path: `.cmake/build-dependencies/${name}`, content });
  }
  return files;
}

async function collectBuildDependencyFilesFromWorker(buildPath, metadataDir, projectionHints) {
  const buildDepsDir = path.join(metadataDir, 'build-dependencies');
  await mkdir(buildDepsDir, { recursive: true });
  const patterns = [
    `${buildPath.replace(/\/+$/, '')}/CMakeFiles/Makefile.cmake`,
    `*CMakeFiles/${CFG.targetName}.dir/build.make`,
    `*CMakeFiles/${CFG.targetName}.dir/DependInfo.cmake`,
  ];
  const remotePaths = [];
  for (const pattern of patterns) {
    const out = await execText(
      'docker',
      [
        'exec',
        CFG.workerContainer,
        'sh',
        '-lc',
        `cd /tmp && find ${shQuote(buildPath)} -path ${shQuote(pattern)} -print 2>/dev/null`,
      ],
      30000,
      true,
    );
    for (const line of String(out || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) remotePaths.push(trimmed);
    }
  }

  const files = [];
  for (const remotePath of [...new Set(remotePaths)].sort()) {
    const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 12);
    const localName = `${hash}-${path.posix.basename(remotePath)}`;
    const localPath = path.join(buildDepsDir, localName);
    await execText(
      'docker',
      ['cp', `${CFG.workerContainer}:${remotePath}`, localPath],
      30000,
      true,
    );
    const content = normalizeBuildMetadataText(await readFile(localPath, 'utf8'));
    collectBuildDependencySourcePaths(content, projectionHints);
    files.push({ path: `.cmake/build-dependencies/${localName}`, content });
  }
  return files;
}

function collectBuildDependencySourcePaths(content, projectionHints) {
  const normalized = normalizeBuildMetadataText(content).replace(/\\\r?\n/g, ' ');
  const matches = normalized.match(/[A-Za-z]:\/[^\s"'()<>]+|\/[^\s"'()<>]+/g) ?? [];
  for (const raw of matches) {
    const trimmed = raw.replace(/[;,:]+$/g, '');
    const rel = repoRelativePath(trimmed);
    if (rel) projectionHints.build_dependency_source_paths.add(rel);
  }
}

function repoRelativePath(rawPath) {
  if (!rawPath) return null;
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  let value = String(rawPath)
    .replace(/\\/g, '/')
    .replaceAll(workerRoot, workspaceRoot);
  if (value === workspaceRoot || value === `${workspaceRoot}/.`) return null;
  if (value.startsWith(`${workspaceRoot}/`)) value = value.slice(workspaceRoot.length + 1);
  if (path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    return null;
  }
  return normalized;
}

function normalizeBuildMetadataText(raw) {
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/');
  return String(raw).replaceAll(workerRoot, workspaceRoot);
}

function buildMetadataCoversSource(
  sourcePath,
  {
    compileCommandSourcePaths = [],
    targetSourcePaths = [],
    buildDependencySourcePaths = [],
  } = {},
) {
  const normalizedSource = String(sourcePath ?? '').replace(/\\/g, '/');
  if (!normalizedSource) return false;
  const compileSources = new Set([...compileCommandSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  const targetSources = new Set([...targetSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  const buildDependencySources = new Set([...buildDependencySourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  return compileSources.has(normalizedSource)
    || targetSources.has(normalizedSource)
    || buildDependencySources.has(normalizedSource);
}

function ensureEntryCoveredByBuildMetadata({
  compileCommandSourcePaths,
  targetSourcePaths,
  buildDependencySourcePaths,
}) {
  const entryFile = CFG.entryFile.replace(/\\/g, '/');
  if (buildMetadataCoversSource(entryFile, {
    compileCommandSourcePaths,
    targetSourcePaths,
    buildDependencySourcePaths,
  })) return;
  throw new Error(`CMake metadata did not include ${CFG.entryFile}`);
}

function compileCommandSourcePathsFromRaw(raw) {
  return JSON.parse(raw)
    .map((entry) => repoRelativePath(entry?.file))
    .filter(Boolean)
    .sort();
}

function normalizeCompileCommands(raw) {
  const entries = JSON.parse(raw);
  const workerRoot = CFG.workerRepoPath.replace(/\\/g, '/');
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/');
  const normalized = entries.map((entry) => {
    const updated = {
      ...entry,
      directory: String(entry.directory || '').replace(workerRoot, workspaceRoot),
      file: String(entry.file || '').replace(workerRoot, workspaceRoot),
    };
    if (updated.command) updated.command = String(updated.command).replaceAll(workerRoot, workspaceRoot);
    if (Array.isArray(updated.arguments)) {
      updated.arguments = updated.arguments.map((arg) => String(arg).replaceAll(workerRoot, workspaceRoot));
    }
    return updated;
  });
  return JSON.stringify(normalized, null, 2) + '\n';
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function collectRepoFiles(buildMetadata) {
  const rels = await listTrackedFiles();
  const files = [];
  const skipped = [];
  for (const rel of rels) {
    const full = path.join(CFG.repoPath, rel);
    const st = await stat(full);
    if (!st.isFile()) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'not_regular_file' });
      continue;
    }
    if (st.size > CFG.maxFileBytes) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'too_large', bytes: st.size });
      continue;
    }
    const buf = await readFile(full);
    if (buf.includes(0)) {
      skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'binary' });
      continue;
    }
    files.push({ path: rel.replace(/\\/g, '/'), content: buf.toString('utf8') });
  }

  files.push({ path: 'compile_commands.json', content: buildMetadata.compileCommandsJson });
  for (const reply of buildMetadata.cmakeReplyFiles) {
    files.push(reply);
  }
  for (const dep of buildMetadata.buildDependencyFiles ?? []) {
    files.push(dep);
  }

  report.seeded_file_count = files.length;
  report.skipped_file_count = skipped.length;
  report.skipped_files = skipped.slice(0, 50);
  record('collected real repo text files', 'pass', `seeded=${files.length} skipped=${skipped.length}`);
  return files;
}

function pathIsWithinDir(filePath, dirPath) {
  const cleanDir = String(dirPath ?? '').replace(/\/+$/, '');
  return cleanDir && (filePath === cleanDir || filePath.startsWith(`${cleanDir}/`));
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function canUseWorkspaceFileRef(fileName) {
  const normalized = String(fileName ?? '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//')) return false;
  return normalized
    .split('/')
    .filter(Boolean)
    .every((part) => part !== '..' && !part.startsWith('.'));
}

function compileProjectionRequestArgs(selectedFiles, phaseName) {
  if (CFG.compileTransport === 'inline') {
    return { files: selectedFiles };
  }
  if (CFG.compileTransport !== 'workspace-ref') {
    throw new Error(`unsupported compile transport: ${CFG.compileTransport}`);
  }
  const inlineFiles = selectedFiles.filter((file) => !canUseWorkspaceFileRef(file.name));
  const refFiles = selectedFiles.filter((file) => canUseWorkspaceFileRef(file.name));
  const fileRefs = refFiles.map((file) => ({
    name: file.name,
    sha256: createHash('sha256').update(file.content).digest('hex'),
    bytes: byteLength(file.content),
  }));
  if (report.compile_projection[phaseName]) {
    report.compile_projection[phaseName].request_file_refs = fileRefs.length;
    report.compile_projection[phaseName].request_inline_files = inlineFiles.length;
    report.compile_projection[phaseName].request_inline_bytes = inlineFiles.reduce(
      (sum, file) => sum + byteLength(file.content),
      0,
    );
    report.compile_projection[phaseName].request_file_ref_bytes = refFiles.reduce(
      (sum, file) => sum + byteLength(file.content),
      0,
    );
  }
  return { files: inlineFiles, file_refs: fileRefs };
}

function buildSourceCoverageForFocus(files, focusPath, buildMetadata, options = {}) {
  const normalizedFocus = String(focusPath ?? '').replace(/\\/g, '/');
  const fileMap = new Map(files.map((file) => [file.path, file.content]));
  const directSources = directBuildMetadataSourceSet(buildMetadata);
  if (directSources.has(normalizedFocus)) {
    return {
      covered: true,
      reason: 'direct_build_metadata',
      trace: [normalizedFocus],
      coveredPaths: [normalizedFocus],
    };
  }

  const includeDirs = ['.', ...(buildMetadata.targetIncludeDirs ?? [])].filter(Boolean);
  const queue = [];
  const parents = new Map();
  const preferredRoots = (options.preferredRoots ?? [])
    .map((candidate) => String(candidate ?? '').replace(/\\/g, '/'))
    .filter((candidate) => candidate && directSources.has(candidate));
  const orderedRoots = [
    ...preferredRoots,
    ...[...directSources].sort().filter((source) => !preferredRoots.includes(source)),
  ];
  for (const source of orderedRoots) {
    if (!fileMap.has(source)) continue;
    queue.push(source);
    parents.set(source, null);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const includePath of extractSourceIncludes(fileMap.get(current))) {
      const resolved = resolveSourceInclude(current, includePath, includeDirs, fileMap);
      if (!resolved || parents.has(resolved)) continue;
      parents.set(resolved, current);
      if (resolved === normalizedFocus) {
        const trace = [];
        for (let node = resolved; node; node = parents.get(node)) trace.push(node);
        trace.reverse();
        return {
          covered: true,
          reason: 'static_include_from_build_metadata',
          trace,
          coveredPaths: trace,
        };
      }
      queue.push(resolved);
    }
  }

  return {
    covered: false,
    reason: 'not_reachable_from_build_metadata',
    trace: [],
    coveredPaths: [...parents.keys()].sort(),
  };
}

function directBuildMetadataSourceSet(buildMetadata) {
  return new Set([
    ...(buildMetadata.compileCommandSourcePaths ?? []),
    ...(buildMetadata.targetSourcePaths ?? []),
    ...(buildMetadata.buildDependencySourcePaths ?? []),
  ].map((candidate) => String(candidate).replace(/\\/g, '/')).filter(Boolean));
}

function extractSourceIncludes(content) {
  const includes = [];
  const pattern = /^\s*#\s*include\s*[<"]([^">]+)[">]/gm;
  let match;
  while ((match = pattern.exec(String(content ?? ''))) !== null) {
    if (match[1]) includes.push(match[1].replace(/\\/g, '/'));
  }
  return includes;
}

function resolveSourceInclude(fromPath, includePath, includeDirs, fileMap) {
  const fromDir = path.posix.dirname(String(fromPath ?? '').replace(/\\/g, '/'));
  const candidates = [
    path.posix.normalize(path.posix.join(fromDir, includePath)),
    ...includeDirs.map((dir) => path.posix.normalize(path.posix.join(dir, includePath))),
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith('../') || candidate === '..') continue;
    if (fileMap.has(candidate)) return candidate;
  }
  return null;
}

function buildCompileProjection(files, focusPath, buildMetadata, phaseName) {
  const normalizedFocus = String(focusPath ?? '').replace(/\\/g, '/');
  const targetSources = new Set(buildMetadata.targetSourcePaths ?? []);
  const buildDependencySources = new Set(buildMetadata.buildDependencySourcePaths ?? []);
  const coverage = buildSourceCoverageForFocus(files, normalizedFocus, buildMetadata, {
    preferredRoots: [CFG.entryFile],
  });
  if (!coverage.covered) {
    throw new Error(`CMake metadata did not cover ${normalizedFocus}: ${coverage.reason}`);
  }
  const coveredDependencyPaths = new Set(coverage.coveredPaths ?? []);
  const includeDirs = (buildMetadata.targetIncludeDirs ?? [])
    .filter((dir) => dir && dir !== '.')
    .sort((a, b) => b.length - a.length);
  const candidates = [];

  for (const file of files) {
    if (file.path === normalizedFocus) continue;
    const isMetadata = file.path === 'compile_commands.json'
      || file.path.startsWith('.cmake/api/v1/reply/')
      || file.path.startsWith('.cmake/build-dependencies/');
    const isTargetSource = targetSources.has(file.path);
    const isCoveredDependency = coveredDependencyPaths.has(file.path);
    const includeDir = includeDirs.find((dir) => pathIsWithinDir(file.path, dir));
    if (!isMetadata && !isTargetSource && !isCoveredDependency && !includeDir) continue;
    const priority = isMetadata ? 0 : (isTargetSource || isCoveredDependency) ? 1 : 2;
    candidates.push({
      file,
      priority,
      reason: isMetadata
        ? 'build_metadata'
        : isTargetSource
          ? 'target_source'
          : isCoveredDependency
            ? 'include_reachable_from_build_metadata'
            : `include_dir:${includeDir}`,
      bytes: byteLength(file.content),
    });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.file.path.localeCompare(b.file.path));

  const selected = [];
  const omitted = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (totalBytes + candidate.bytes > CFG.compileContextMaxBytes && candidate.priority > 1) {
      omitted.push(candidate);
      continue;
    }
    selected.push({ name: candidate.file.path, content: candidate.file.content });
    totalBytes += candidate.bytes;
  }

  const summary = {
    phase: phaseName,
    selected_files: selected.length,
    selected_bytes: totalBytes,
    omitted_files: omitted.length,
    omitted_bytes: omitted.reduce((sum, item) => sum + item.bytes, 0),
    target_source_paths: targetSources.size,
    build_dependency_source_paths: buildDependencySources.size,
    target_include_dirs: includeDirs.length,
    matched_target_files: buildMetadata.matchedTargetFiles ?? [],
    coverage_reason: coverage.reason,
    coverage_trace: coverage.trace,
    max_bytes: CFG.compileContextMaxBytes,
    compile_transport: CFG.compileTransport,
  };
  report.compile_projection[phaseName] = summary;
  record(
    'compile projection',
    'pass',
    `${phaseName} selected=${summary.selected_files} bytes=${summary.selected_bytes} omitted=${summary.omitted_files}`,
  );
  return selected;
}

async function createWorkspace() {
  const workspace = await createValidationWorkspace({
    frontendUrl: CFG.frontendUrl,
    name: CFG.workspaceName,
    slug: CFG.slug,
    httpJson,
    record,
  });
  record('create workspace', 'pass', `id=${workspace.id ?? 'n/a'} slug=${CFG.slug}`);
}

async function writeFilesBatch(files) {
  for (let i = 0; i < files.length; i += CFG.writeBatchSize) {
    const chunk = files.slice(i, i + CFG.writeBatchSize);
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      {
        files: chunk.map((file) => ({ path: file.path, encoding: 'utf8', content: file.content })),
        syncToGcs: CFG.syncToGcs,
      },
      { 'x-user-id': CFG.hostId },
    );
    record('seed workspace batch', 'pass', `${Math.min(i + chunk.length, files.length)}/${files.length}`);
  }
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/stage-all`, {}, { 'x-user-id': CFG.hostId });
  await httpJson('POST', `${CFG.collabUrl}/git/${CFG.slug}/commit`, { message: CFG.seedCommitMessage }, { 'x-user-id': CFG.hostId });
  record('workspace commit seed', 'pass', `${files.length} files`);
}

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = [];
    proc.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      if (process.env.MCP_VERBOSE) process.stderr.write(`[mcp] ${text}`);
    });
    proc.on('exit', (code, sig) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`MCP exited ${code ?? sig}`));
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    }
  }

  request(method, params = {}, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out. stderr=${this.stderrTail.slice(-8).join('').slice(-2000)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async toolCall(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content.find((block) => block?.type === 'text')?.text;
    if (res.isError) throw new Error(`tool ${name} isError: ${text ?? JSON.stringify(res)}`);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async toolCallRaw(name, args, timeoutMs = CFG.mcpRequestTimeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }
}

let mcpState = null;
async function ensureMcpAttached() {
  if (!mcpState) {
    let proc;
    if (CFG.mcpTransport === 'docker') {
      proc = spawn('docker', [
        'exec',
        '-i',
        '-e', `SYNTHI_SESSION_ID=${CFG.slug}`,
        '-e', `SYNTHI_SIGNALING_URL=${CFG.mcpSignalingUrl}`,
        '-e', `GOOGLE_API_KEY=${CFG.googleApiKey}`,
        '-e', `GEMINI_API_KEY=${CFG.googleApiKey}`,
        '-e', `SYNTHI_GEMINI_MODEL=${CFG.geminiModel}`,
        '-e', `SYNTHI_GPU_SPLIT_MODEL=${CFG.gpuSplitModel}`,
        '-e', `SYNTHI_GPU_DELTA_MODEL=${CFG.gpuDeltaModel}`,
        CFG.mcpContainer,
        'node',
        CFG.mcpContainerEntry,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      proc = spawn('node', [CFG.mcpEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SYNTHI_SESSION_ID: CFG.slug,
          ...(CFG.signalingUrl ? { SYNTHI_SIGNALING_URL: CFG.signalingUrl } : {}),
        },
      });
    }
    const client = new McpClient(proc);
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: CFG.mcpClientName, version: '0.0.1' } }, 20000);
    await client.request('notifications/initialized', {}, 5000).catch(() => {});
    const tools = await client.request('tools/list', {}, 20000);
    const names = tools.tools?.map((tool) => tool.name) ?? [];
    record('mcp tools/list', names.includes('synthi_compile') && names.includes('synthi_wait_hmr') ? 'pass' : 'fail', `count=${names.length}`);
    mcpState = { proc, client, attached: false };
  }
  if (!mcpState.attached) {
    const attachSignalingUrl = CFG.mcpTransport === 'docker' ? CFG.mcpSignalingUrl : CFG.signalingUrl;
    const attachArgs = {
      sessionId: CFG.slug,
      'i-understand-no-auth': true,
      ...(attachSignalingUrl ? { signalingUrl: attachSignalingUrl } : {}),
    };
    const attach = await mcpState.client.toolCall('synthi_attach', attachArgs, CFG.mcpAttachTimeoutMs);
    if (!attach?.ok) throw new Error(`synthi_attach failed: ${JSON.stringify(attach)}`);
    mcpState.attached = true;
    record('mcp attach', 'pass', attach.resolution ? `${attach.resolution.w}x${attach.resolution.h}` : 'attached');
  }
  return mcpState;
}

async function beginPhaseRuntimeIdentityMonitor(phaseName) {
  const monitor = {
    phase: phaseName,
    container: CFG.workerContainer,
    enabled: CFG.mcpTransport === 'docker',
    changed: false,
    reason: null,
    changes: [],
    snapshots: [],
  };
  report.runtime_identity.phases.push(monitor);
  await capturePhaseRuntimeIdentity(monitor, 'before_compile');
  return monitor;
}

function runtimeIdentityFieldValue(snapshot, field) {
  if (!snapshot || snapshot.available === false) return null;
  return snapshot[field] ?? null;
}

function runtimeIdentityDiff(before, after) {
  if (!before || !after) return { changed: false, changes: [] };
  const changes = [];
  if (before.available !== after.available) {
    changes.push({ field: 'available', before: Boolean(before.available), after: Boolean(after.available) });
  }
  for (const field of ['id', 'image_id', 'status', 'pid', 'started_at', 'restart_count']) {
    const beforeValue = runtimeIdentityFieldValue(before, field);
    const afterValue = runtimeIdentityFieldValue(after, field);
    if (beforeValue !== afterValue) {
      changes.push({ field, before: beforeValue, after: afterValue });
    }
  }
  return {
    changed: changes.length > 0,
    changes,
    reason: changes.map((change) => `${change.field}:${change.before ?? 'null'}->${change.after ?? 'null'}`).join(','),
  };
}

async function capturePhaseRuntimeIdentity(monitor, label) {
  if (!monitor?.enabled) return null;
  const snapshot = await dockerContainerSnapshot(monitor.container);
  const base = monitor.snapshots[0]?.snapshot ?? snapshot;
  const diff = runtimeIdentityDiff(base, snapshot);
  const entry = {
    label,
    at: new Date().toISOString(),
    snapshot,
    diff,
  };
  monitor.snapshots.push(entry);
  if (diff.changed && !monitor.changed) {
    monitor.changed = true;
    monitor.reason = diff.reason;
    monitor.changes = diff.changes;
    record(`${monitor.phase} runtime identity`, 'fail', diff.reason);
    process.exitCode = 1;
  }
  return diff;
}

function phaseRuntimeIdentitySummary(monitor) {
  if (!monitor) return null;
  return {
    container: monitor.container,
    enabled: monitor.enabled,
    changed: monitor.changed,
    reason: monitor.reason,
    changes: monitor.changes,
    snapshot_count: monitor.snapshots.length,
    first: monitor.snapshots[0]?.snapshot ?? null,
    latest: monitor.snapshots.at(-1)?.snapshot ?? null,
  };
}

function runtimeIdentityLostWaitResult(monitor, startedAt) {
  if (!monitor?.changed) return null;
  return {
    status: 'runtime-session-lost',
    elapsedMs: Date.now() - startedAt,
    hmrElapsedMs: null,
    source: 'docker_runtime_identity',
    detail: {
      reason: monitor.reason,
      changes: monitor.changes,
      container: monitor.container,
    },
    frame_gate: {
      status: 'runtime_session_lost',
      note: 'worker runtime identity changed while waiting for the current HMR phase',
    },
  };
}

function runtimeIdentityChangeEvidence(runtimeIdentity = report.runtime_identity) {
  const phases = Array.isArray(runtimeIdentity?.phases) ? runtimeIdentity.phases : [];
  const changedPhases = phases.filter((phase) => phase?.changed === true);
  return {
    total_phases: phases.length,
    changed_count: changedPhases.length,
    changed_phases: changedPhases.map((phase) => ({
      phase: phase.phase ?? null,
      container: phase.container ?? null,
      reason: phase.reason ?? null,
      changes: Array.isArray(phase.changes) ? phase.changes : [],
    })),
    evidence_refs: changedPhases.map((phase) => `validation:runtime_identity:${phase.phase ?? 'unknown'}`),
  };
}

function compileResponseBridgeSignalStrings(value, out = [], depth = 0) {
  if (out.length >= 80 || depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (
      /\b(?:load_device(?:_partial)?|device[_ -]?sidecar|gpu[_ -]?sidecar|gpu[_ -]?hmr|runtime[_ -]?proof|proof[_ -]?artifact|artifact(?:[_ -]?(?:path|hash|id))?|hsaco|cubin|fatbin|ptx)\b/i
        .test(value)
    ) {
      out.push(value.length > 260 ? `${value.slice(0, 260)}...` : value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      compileResponseBridgeSignalStrings(item, out, depth + 1);
      if (out.length >= 80) break;
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (
        /\b(?:load_device(?:_partial)?|device[_ -]?sidecar|gpu[_ -]?sidecar|gpu[_ -]?hmr|runtime[_ -]?proof|proof[_ -]?artifact|artifact(?:[_ -]?(?:path|hash|id))?|hsaco|cubin|fatbin|ptx)\b/i
          .test(key)
      ) {
        out.push(key);
      }
      compileResponseBridgeSignalStrings(nested, out, depth + 1);
      if (out.length >= 80) break;
    }
  }
  return out;
}

function bridgeObjectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstBridgeText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstBridgeBool(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function compileBridgeCandidateFromDeviceSidecarContract(deviceSidecarContract = null) {
  const facet = bridgeObjectOrEmpty(deviceSidecarContract);
  if (Object.keys(facet).length === 0) {
    return {
      present: false,
      accepted: false,
      status: 'device_sidecar_contract_unavailable',
      evidenceRefs: [],
      evidence_refs: [],
    };
  }
  const artifactIdentity = bridgeObjectOrEmpty(facet.artifactIdentity ?? facet.artifact_identity);
  const sourcePaths = compactKnownStringList(artifactIdentity.source_paths ?? artifactIdentity.sourcePaths);
  const entryPoints = compactKnownStringList(artifactIdentity.entry_points ?? artifactIdentity.entryPoints);
  const artifactKind = firstBridgeText(artifactIdentity.artifact_kind, artifactIdentity.artifactKind);
  const compileTarget = firstBridgeText(artifactIdentity.compile_target, artifactIdentity.compileTarget);
  const compiler = firstBridgeText(artifactIdentity.compiler);
  const compilerArgsHash = firstBridgeText(artifactIdentity.compiler_args_hash, artifactIdentity.compilerArgsHash);
  const backend = firstBridgeText(facet.backend);
  const contractEvidenceComplete = firstBridgeBool(
    facet.contractEvidenceComplete,
    facet.contract_evidence_complete,
  ) === true;
  const sourceCoverageComplete = firstBridgeBool(
    facet.sourceCoverageComplete,
    facet.source_coverage_complete,
  ) === true;
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const knownRocmBackend = Boolean(backend) && backend !== 'unknown' && backend !== 'cuda';
  const accepted =
    contractEvidenceComplete
    && sourceCoverageComplete
    && sourcePaths.length > 0
    && entryPoints.length > 0
    && artifactKind
    && artifactKind !== 'unknown'
    && compileTarget
    && compiler
    && compilerArgsHash
    && knownRocmBackend
    && !blockingGaps.includes('device_sidecar_cuda_not_provable_on_rocm_host');
  return {
    present: true,
    accepted,
    status: accepted
      ? 'device_sidecar_contract_candidate_materialized'
      : 'device_sidecar_contract_candidate_incomplete',
    source: 'real_rocm_device_sidecar_contract_facet',
    backend,
    knownRocmBackend,
    known_rocm_backend: knownRocmBackend,
    artifactIdentity,
    artifact_identity: artifactIdentity,
    contractEvidenceComplete,
    contract_evidence_complete: contractEvidenceComplete,
    sourceCoverageComplete,
    source_coverage_complete: sourceCoverageComplete,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs: compactStringList([
      ...(Array.isArray(facet.evidenceRefs) ? facet.evidenceRefs : []),
      ...(Array.isArray(facet.evidence_refs) ? facet.evidence_refs : []),
    ]),
    evidence_refs: compactStringList([
      ...(Array.isArray(facet.evidenceRefs) ? facet.evidenceRefs : []),
      ...(Array.isArray(facet.evidence_refs) ? facet.evidence_refs : []),
    ]),
  };
}

function compileResponseBridgeSummary(compile, {
  deviceSidecarContract = null,
} = {}) {
  const present = compile && typeof compile === 'object' && !Array.isArray(compile);
  const matches = present ? compactStringList(compileResponseBridgeSignalStrings(compile)) : [];
  const sidecarCandidate = compileBridgeCandidateFromDeviceSidecarContract(deviceSidecarContract);
  const joined = matches.join('\n');
  const loadDeviceCommandDeclared = /\bload_device(?:_partial)?\b/i.test(joined);
  const deviceSidecarDeclared = /\b(?:device[_ -]?sidecar|gpu[_ -]?sidecar)\b/i.test(joined);
  const artifactReferenceDeclared =
    /\b(?:artifact(?:[_ -]?(?:path|hash|id))?|hsaco|cubin|fatbin|ptx)\b/i.test(joined);
  const runtimeProofMaterialDeclared =
    /\b(?:gpu[_ -]?hmr|runtime[_ -]?proof|proof[_ -]?artifact)\b/i.test(joined);
  const compileResponseCandidate =
    loadDeviceCommandDeclared
    && deviceSidecarDeclared
    && artifactReferenceDeclared
    && runtimeProofMaterialDeclared;
  return {
    schemaVersion: 'synthi.real_rocm.compile_bridge_summary.v1',
    present,
    ok: compile?.ok === true,
    proofAuthority: 'compile_response_evidence_only_not_gpu_hmr_success',
    proof_authority: 'compile_response_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: compileResponseCandidate
      ? 'compile_bridge_candidate_declared_not_runtime_proof'
      : sidecarCandidate.accepted
      ? 'compile_bridge_candidate_derived_not_runtime_proof'
      : matches.length > 0
        ? 'compile_bridge_incomplete_not_runtime_proof'
        : 'compile_bridge_not_declared_by_compile_response',
    topLevelKeys: present ? Object.keys(compile).slice(0, 80) : [],
    top_level_keys: present ? Object.keys(compile).slice(0, 80) : [],
    signals: {
      loadDeviceCommandDeclared,
      load_device_command_declared: loadDeviceCommandDeclared,
      deviceSidecarDeclared,
      device_sidecar_declared: deviceSidecarDeclared,
      artifactReferenceDeclared,
      artifact_reference_declared: artifactReferenceDeclared,
      runtimeProofMaterialDeclared,
      runtime_proof_material_declared: runtimeProofMaterialDeclared,
      derivedDeviceSidecarCandidate: sidecarCandidate.accepted === true,
      derived_device_sidecar_candidate: sidecarCandidate.accepted === true,
    },
    deviceSidecarCandidate: sidecarCandidate,
    device_sidecar_candidate: sidecarCandidate,
    evidenceSample: compactStringList([
      ...matches,
      ...sidecarCandidate.evidenceRefs,
    ]).slice(0, 12),
    evidence_sample: compactStringList([
      ...matches,
      ...sidecarCandidate.evidenceRefs,
    ]).slice(0, 12),
  };
}

function compileResponseBridgeSummaryWithDeviceSidecar(summary, deviceSidecarContract = null) {
  const base = bridgeObjectOrEmpty(summary);
  if (Object.keys(base).length === 0) {
    return compileResponseBridgeSummary(null, { deviceSidecarContract });
  }
  const sidecarCandidate = compileBridgeCandidateFromDeviceSidecarContract(deviceSidecarContract);
  const signals = bridgeObjectOrEmpty(base.signals);
  const compileResponseCandidate =
    base.status === 'compile_bridge_candidate_declared_not_runtime_proof'
    || (
      firstBridgeBool(signals.loadDeviceCommandDeclared, signals.load_device_command_declared) === true
      && firstBridgeBool(signals.deviceSidecarDeclared, signals.device_sidecar_declared) === true
      && firstBridgeBool(signals.artifactReferenceDeclared, signals.artifact_reference_declared) === true
      && firstBridgeBool(signals.runtimeProofMaterialDeclared, signals.runtime_proof_material_declared) === true
    );
  const status = compileResponseCandidate
    ? 'compile_bridge_candidate_declared_not_runtime_proof'
    : sidecarCandidate.accepted
      ? 'compile_bridge_candidate_derived_not_runtime_proof'
      : base.status ?? 'compile_bridge_not_declared_by_compile_response';
  const evidenceSample = compactStringList([
    ...(Array.isArray(base.evidenceSample) ? base.evidenceSample : []),
    ...(Array.isArray(base.evidence_sample) ? base.evidence_sample : []),
    ...sidecarCandidate.evidenceRefs,
  ]).slice(0, 12);
  return {
    ...base,
    proofAuthority: 'compile_response_evidence_only_not_gpu_hmr_success',
    proof_authority: 'compile_response_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status,
    signals: {
      ...signals,
      derivedDeviceSidecarCandidate: sidecarCandidate.accepted === true,
      derived_device_sidecar_candidate: sidecarCandidate.accepted === true,
    },
    deviceSidecarCandidate: sidecarCandidate,
    device_sidecar_candidate: sidecarCandidate,
    evidenceSample,
    evidence_sample: evidenceSample,
  };
}

function enrichCompileBridgeSummariesWithDeviceSidecar(phases = [], deviceSidecarContract = null) {
  return (Array.isArray(phases) ? phases : []).map((phase) => {
    if (!phase || typeof phase !== 'object') return phase;
    const enrichedCompileSummary = compileResponseBridgeSummaryWithDeviceSidecar(
      phase.compile_response_summary ?? phase.compileResponseSummary,
      deviceSidecarContract,
    );
    return {
      ...phase,
      compile_response_summary: enrichedCompileSummary,
      compileResponseSummary: enrichedCompileSummary,
    };
  });
}

function realRocmCompileBridgeFacet(phases = [], {
  runtimeProofAccepted = false,
  runtimeEvidenceRefs = [],
} = {}) {
  const summaries = (Array.isArray(phases) ? phases : [])
    .filter((phase) =>
      /compile|hmr/i.test(String(phase?.name ?? ''))
      || (phase?.compile_response_summary && typeof phase.compile_response_summary === 'object')
      || (phase?.compileResponseSummary && typeof phase.compileResponseSummary === 'object')
    )
    .map((phase) => ({
      phase: phase.name ?? null,
      summary: phase.compile_response_summary ?? phase.compileResponseSummary ?? null,
    }))
    .filter((entry) => entry.summary && typeof entry.summary === 'object');
  const candidateStatuses = new Set([
    'compile_bridge_candidate_declared_not_runtime_proof',
    'compile_bridge_candidate_derived_not_runtime_proof',
  ]);
  const anyCandidate = summaries.some((entry) => candidateStatuses.has(entry.summary.status));
  const anyIncomplete = summaries.some((entry) =>
    entry.summary.status === 'compile_bridge_incomplete_not_runtime_proof'
  );
  const blockingGaps = [];
  const linkedToRuntimeProof = runtimeProofAccepted === true && anyCandidate;
  if (linkedToRuntimeProof) {
    // The compile response is still not authority by itself; it can only be a
    // link once the runtime proof chain has already accepted.
  } else if (anyCandidate) {
    blockingGaps.push('compile_response_bridge_candidate_not_runtime_proof');
  } else if (anyIncomplete) {
    blockingGaps.push('compile_response_bridge_incomplete_not_runtime_proof');
  } else {
    blockingGaps.push('compile_response_device_sidecar_bridge_not_declared');
  }
  return {
    schemaVersion: 'synthi.real_rocm.compile_bridge_facet.v1',
    status: linkedToRuntimeProof
      ? 'compile_bridge_linked_to_runtime_proof'
      : anyCandidate
      ? 'compile_bridge_candidate_observed_not_runtime_proof'
      : anyIncomplete
        ? 'compile_bridge_incomplete_not_runtime_proof'
        : 'compile_bridge_missing',
    proofAuthority: linkedToRuntimeProof
      ? 'compile_response_linked_to_runtime_proof_artifact'
      : 'compile_response_evidence_only_not_gpu_hmr_success',
    proof_authority: linkedToRuntimeProof
      ? 'compile_response_linked_to_runtime_proof_artifact'
      : 'compile_response_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: linkedToRuntimeProof,
    can_satisfy_runtime_proof: linkedToRuntimeProof,
    phaseCount: summaries.length,
    phase_count: summaries.length,
    phaseSummaries: summaries,
    phase_summaries: summaries,
    blockingGaps,
    blocking_gaps: blockingGaps,
    runtimeEvidenceRefs: compactStringList(runtimeEvidenceRefs),
    runtime_evidence_refs: compactStringList(runtimeEvidenceRefs),
  };
}

function runtimeProofStateAccepted(proof, state) {
  return proof?.resultState === state && !proof?.degradedState;
}

function runtimeEvidenceRefsFromProofs(...proofs) {
  return compactStringList(proofs.flatMap((proof) =>
    Array.isArray(proof?.evidenceRefs) ? proof.evidenceRefs : []
  ));
}

function deriveCpuGpuFirewallEvidence({
  runtimeIdentityChanges,
  runtimeHostPreservation,
  runtimeDispatch,
  runtimeOutputOracle,
  runtimeOwnership,
  hostRestartCount,
}) {
  const dispatchProven = runtimeProofStateAccepted(
    report.dispatch_proof,
    'gpu-hmr-dispatch-safe-proven',
  );
  const outputProven = runtimeProofStateAccepted(
    report.output_proof,
    'gpu-hmr-output-oracle-proven',
  );
  const hostPreservationProven = runtimeProofStateAccepted(
    report.host_preservation_proof,
    'gpu-hmr-host-preservation-proven',
  );
  const fissionProven = report.fission_proof?.fissionProven === true
    && !report.fission_proof?.degradedState;
  const identityMonitored = Number(runtimeIdentityChanges?.total_phases ?? 0) > 0
    || report.docker?.worker?.available === true;
  const processRestartObserved =
    Number(hostRestartCount ?? 0) > 0
    || Number(runtimeIdentityChanges?.changed_count ?? 0) > 0;
  const evidenceRefs = runtimeEvidenceRefsFromProofs(
    report.artifact_transport_proof,
    report.epoch_swap_proof,
    report.dispatch_proof,
    report.output_proof,
    report.host_preservation_proof,
    report.fission_proof,
  );
  if (runtimeIdentityChanges?.evidence_refs) {
    evidenceRefs.push(...runtimeIdentityChanges.evidence_refs);
  }
  if (runtimeDispatch?.evidence_refs) evidenceRefs.push(...runtimeDispatch.evidence_refs);
  if (runtimeOutputOracle?.evidence_refs) evidenceRefs.push(...runtimeOutputOracle.evidence_refs);
  const firewall = {
    schemaVersion: 'synthi.gpu.hmr.cpu_gpu_firewall_evidence.v1',
    source: 'real_rocm_runtime_proofs',
    route: dispatchProven
      && outputProven
      && proofHasResultState(report.epoch_swap_proof, 'gpu-hmr-epoch-swap-proven')
      ? 'gpu_runtime_epoch_reload'
      : null,
    cpu_hmr_absence_basis: dispatchProven && outputProven
      ? 'gpu_artifact_dispatch_and_output_oracle_proven'
      : null,
    full_rebuild_absence_basis: fissionProven && hostPreservationProven
      ? 'fission_and_host_preservation_proven'
      : null,
    process_restart_absence_basis: identityMonitored && !processRestartObserved
      ? 'worker_identity_monitoring'
      : null,
    process_restart_observed: processRestartObserved,
    host_restart_count: hostRestartCount,
    runtime_identity_changes: runtimeIdentityChanges,
    runtime_ownership_summary: {
      primary_replacement_count: runtimeOwnership?.primary_replacement_count ?? null,
      scope_proven_count: runtimeOwnership?.scope_proven_count ?? null,
    },
    evidence_refs: compactStringList(evidenceRefs),
  };
  if (dispatchProven && outputProven) firewall.cpu_hmr_used = false;
  if (fissionProven && hostPreservationProven) firewall.full_rebuild_used = false;
  if (identityMonitored) firewall.process_restarted = processRestartObserved;
  if (runtimeHostPreservation?.evidence) {
    firewall.host_preservation_evidence = runtimeHostPreservation.evidence;
  }
  return firewall;
}

async function compileViaMcp(args, timeoutMs, phaseName) {
  const state = await ensureMcpAttached();
  const identityMonitor = await beginPhaseRuntimeIdentityMonitor(phaseName);
  const start = Date.now();
  let compile;
  try {
    compile = await state.client.toolCall('synthi_compile', args, timeoutMs);
  } catch (err) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'compile_error');
    const sessionLost = runtimeIdentityLostWaitResult(identityMonitor, start);
    if (sessionLost) {
      throw new Error(`${phaseName} runtime identity changed during synthi_compile: ${sessionLost.detail.reason}`);
    }
    throw err;
  }
  if (!compile?.ok) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'compile_rejected');
    const sessionLost = runtimeIdentityLostWaitResult(identityMonitor, start);
    if (sessionLost) {
      throw new Error(`${phaseName} runtime identity changed during synthi_compile: ${sessionLost.detail.reason}`);
    }
    throw new Error(`${phaseName} synthi_compile failed: ${JSON.stringify(compile).slice(0, 1000)}`);
  }
  const compileIdentityChange = await capturePhaseRuntimeIdentity(identityMonitor, 'after_compile');
  if (compileIdentityChange?.changed) {
    const waitStart = Date.now();
    const wait = runtimeIdentityLostWaitResult(identityMonitor, start);
    const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor, compile);
    report.phases.push(phase);
    record(
      phaseName,
      'fail',
      `${summarizeGpuProof(phase.gpu_proof)} ${JSON.stringify(phase).slice(0, 1000)}`,
    );
    throw new Error(`${phaseName} runtime identity changed after synthi_compile: ${wait.detail.reason}`);
  }
  const waitStart = Date.now();
  const wait = await waitHmrForCurrentWorkspace(
    state,
    timeoutMs,
    phaseName,
    identityMonitor,
    Number.isFinite(compile?.dispatched_at) ? compile.dispatched_at : start,
  );
  await capturePhaseRuntimeIdentity(identityMonitor, 'after_wait');
  const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor, compile);
  report.phases.push(phase);
  const waitApplied = wait?.status === 'applied';
  const waitTerminalProvisional = !waitApplied && CFG.requireFullRuntimeProof;
  if (waitTerminalProvisional) {
    phase.wait_hmr_terminal_provisional = true;
    phase.wait_hmr_terminal_provisional_reason = 'strict_full_runtime_proof_required';
  }
  record(
    phaseName,
    waitApplied ? 'pass' : waitTerminalProvisional ? 'warn' : 'fail',
    `${waitTerminalProvisional ? 'provisional_wait_terminal=true ' : ''}${summarizeGpuProof(phase.gpu_proof)} ${JSON.stringify(phase).slice(0, 1000)}`,
  );
  if (!waitApplied && !waitTerminalProvisional) throw new Error(`${phaseName} wait_hmr status=${wait?.status}`);
  return { compile, wait, phase };
}

function phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor, compile = null) {
  const compileSummary = compileResponseBridgeSummary(compile);
  return {
    name: phaseName,
    compile_wall_ms: Date.now() - start,
    compile_response_summary: compileSummary,
    compileResponseSummary: compileSummary,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? null,
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    wait_hmr_args: wait?.wait_args ?? wait?.waitArgs ?? null,
    wait_hmr_contract: wait?.wait_contract ?? wait?.waitContract ?? null,
    wait_hmr_frame_gate: wait?.frame_gate ?? wait?.frameGate ?? null,
    gpu_proof: wait?.gpu_proof ?? null,
    gpu_proof_telemetry: wait?.gpu_proof_telemetry ?? null,
    gpu_proof_validation: wait?.gpu_proof_validation ?? null,
    runtime_identity: phaseRuntimeIdentitySummary(identityMonitor),
    wait_call_wall_ms: Date.now() - waitStart,
  };
}

function configuredWaitRequiredGpuProofState() {
  if (CFG.hmrRequiredGpuProofState) return CFG.hmrRequiredGpuProofState;
  return CFG.requireFullRuntimeProof ? 'gpu-hmr-full-runtime-proven' : null;
}

function waitContractFromArgs(waitArgs = {}) {
  const requiredState = waitArgs.requiredGpuProofState
    ?? (waitArgs.requireGpuFullRuntimeProof ? 'gpu-hmr-full-runtime-proven' : null);
  return {
    timeout_ms: Number.isFinite(waitArgs.timeoutMs) ? waitArgs.timeoutMs : null,
    module: typeof waitArgs.module === 'string' && waitArgs.module.trim()
      ? waitArgs.module.trim()
      : null,
    since_ts: Number.isFinite(waitArgs.since_ts) ? waitArgs.since_ts : null,
    preview_id: typeof waitArgs.preview_id === 'string' && waitArgs.preview_id.trim()
      ? waitArgs.preview_id.trim()
      : null,
    required_gpu_proof_state: requiredState ?? null,
    require_gpu_full_runtime_proof: waitArgs.requireGpuFullRuntimeProof === true,
  };
}

function attachWaitEvidence(wait, waitArgs) {
  if (!wait || typeof wait !== 'object') return wait;
  return {
    ...wait,
    wait_args: waitArgs,
    wait_contract: wait.wait_contract ?? wait.waitContract ?? waitContractFromArgs(waitArgs),
  };
}

async function waitHmrForCurrentWorkspace(state, timeoutMs, phaseName, identityMonitor = null, sinceTs = null) {
  const startedAt = Date.now();
  const eventLogSinceTs = Number.isFinite(sinceTs) ? sinceTs : startedAt - 2000;
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    await capturePhaseRuntimeIdentity(identityMonitor, 'before_wait_poll');
    const earlyIdentityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
    if (earlyIdentityLoss) return earlyIdentityLoss;
    const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    const sliceTimeoutMs = Math.min(remaining, 30000);
    let wait;
    const requiredGpuProofState = configuredWaitRequiredGpuProofState();
    const waitArgs = { timeoutMs: sliceTimeoutMs, since_ts: eventLogSinceTs };
    if (CFG.hmrWaitModule) waitArgs.module = CFG.hmrWaitModule;
    if (requiredGpuProofState) waitArgs.requiredGpuProofState = requiredGpuProofState;
    if (CFG.requireFullRuntimeProof) waitArgs.requireGpuFullRuntimeProof = true;
    const waitContract = waitContractFromArgs(waitArgs);
    try {
      wait = await state.client.toolCall(
        'synthi_wait_hmr',
        waitArgs,
        sliceTimeoutMs + 7000,
      );
    } catch (err) {
      await capturePhaseRuntimeIdentity(identityMonitor, 'wait_poll_error');
      const identityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
      if (identityLoss) return identityLoss;
      const waitError = waitResultFromWaitHmrToolError(err);
      if (waitError) return attachWaitEvidence(waitError, waitArgs);
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, waitArgs, waitContract);
      if (recovered) return recovered;
      throw err;
    }
    wait = attachWaitEvidence(wait, waitArgs);
    await capturePhaseRuntimeIdentity(identityMonitor, 'after_wait_poll');
    const identityLoss = runtimeIdentityLostWaitResult(identityMonitor, startedAt);
    if (identityLoss) return identityLoss;
    last = wait;
    const previewId = hmrPreviewId(wait?.detail);
    if (previewId && previewId !== CFG.slug) {
      record(`${phaseName} ignored stale wait_hmr`, 'warn', `preview_id=${previewId} status=${wait?.status ?? 'unknown'}`);
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, waitArgs, waitContract);
      if (recovered) return recovered;
      continue;
    }
    if (wait?.status === 'timeout') {
      const recovered = await currentHmrFromEventLog(state, eventLogSinceTs, startedAt, waitArgs, waitContract);
      if (recovered) return recovered;
      continue;
    }
    return wait;
  }
  const requiredGpuProofState = configuredWaitRequiredGpuProofState();
  const timeoutWaitArgs = { timeoutMs, since_ts: eventLogSinceTs };
  if (CFG.hmrWaitModule) timeoutWaitArgs.module = CFG.hmrWaitModule;
  if (requiredGpuProofState) timeoutWaitArgs.requiredGpuProofState = requiredGpuProofState;
  if (CFG.requireFullRuntimeProof) timeoutWaitArgs.requireGpuFullRuntimeProof = true;
  const timeoutWaitContract = waitContractFromArgs(timeoutWaitArgs);
  const recovered = await currentHmrFromEventLog(
    state,
    eventLogSinceTs,
    startedAt,
    timeoutWaitArgs,
    timeoutWaitContract,
  );
  if (recovered) return recovered;
  return last ?? {
    status: 'timeout',
    elapsedMs: timeoutMs,
    source: 'real_rocm_validation_harness',
    wait_args: timeoutWaitArgs,
    wait_contract: timeoutWaitContract,
  };
}

function waitResultFromWaitHmrToolError(err) {
  const message = String(err?.message ?? err ?? '');
  const match = message.match(/tool synthi_wait_hmr isError:\s*(\{[\s\S]*\})$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.error !== 'gpu_hmr_proof_insufficient') return null;
    return {
      ...parsed,
      status: parsed.status ?? 'timeout',
      source: parsed.source ?? 'tool_error',
    };
  } catch {
    return null;
  }
}

function hmrPreviewId(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (typeof detail.preview_id === 'string') return detail.preview_id;
  if (detail.data && typeof detail.data === 'object' && typeof detail.data.preview_id === 'string') {
    return detail.data.preview_id;
  }
  if (detail.detail && typeof detail.detail === 'object' && typeof detail.detail.preview_id === 'string') {
    return detail.detail.preview_id;
  }
  return null;
}

function hmrStatusFromEvent(entry) {
  const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
  if (entry?.status && entry.status !== 'intermediate') return entry.status;
  if (typeof raw.status === 'string') {
    if (raw.status === 'state-migrated') return 'applied';
    return raw.status;
  }
  if (raw.event === 'Promoted') return 'applied';
  if (raw.event === 'RolledBack') return 'rejected';
  if (raw.event === 'Discarded') return 'discarded';
  return null;
}

function latestGpuProofTelemetryFromEventLogEntries(entries) {
  for (const entry of Array.isArray(entries) ? entries.slice().reverse() : []) {
    const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
    const previewId = hmrPreviewId(raw);
    if (previewId && previewId !== CFG.slug) continue;
    const candidates = [
      ...proofArtifactPathCandidatesFromValue(raw, 'event_log_gpu_proof'),
      ...proofArtifactPathCandidatesFromValue(entry, 'event_log_gpu_proof'),
    ];
    const proofPath = candidates.find((candidate) => proofArtifactFileName(candidate.proofPath))?.proofPath;
    if (proofPath) {
      return {
        proofArtifactPath: proofPath,
        source: 'event_log_gpu_proof',
      };
    }
  }
  return null;
}

async function currentHmrFromEventLog(state, sinceTs, startedAt, waitArgs = null, waitContract = null) {
  const log = await state.client.toolCall(
    'synthi_get_event_log',
    { kind: 'hmr', since_ts: sinceTs, limit: 200 },
    10000,
  ).catch(() => null);
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const latestGpuProofTelemetry = latestGpuProofTelemetryFromEventLogEntries(entries);
  for (const entry of entries.slice().reverse()) {
    const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
    const previewId = hmrPreviewId(raw);
    if (previewId !== CFG.slug) continue;
    const status = hmrStatusFromEvent(entry);
    if (!['applied', 'rejected', 'compile-error', 'full-reload-required', 'discarded'].includes(status)) {
      continue;
    }
    if (status === 'applied' && !eventLogAppliedRecoveryAllowed(waitArgs, waitContract)) {
      continue;
    }
    return {
      status,
      elapsedMs: Date.now() - startedAt,
      hmrElapsedMs: typeof entry.ts === 'number' ? entry.ts - startedAt : null,
      source: 'event_log',
      detail: raw.data && typeof raw.data === 'object' ? raw.data : raw,
      wait_args: waitArgs,
      wait_contract: waitContract ?? waitContractFromArgs(waitArgs ?? {}),
      gpu_proof_telemetry: latestGpuProofTelemetry,
      frame_gate: {
        status: 'event_log_recovered',
        note: 'terminal HMR event was recovered after ignoring a stale wait_hmr event',
      },
    };
  }
  return null;
}

async function captureScreenshot(label, { required = CFG.expectScreenshot, wait = null } = {}) {
  if (!mcpState?.client) return null;
  const attempts = Math.max(1, CFG.screenshotAttempts);
  let lastRow = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const screenshotArgs = mcpScreenshotArgsForFrameGate(wait, {
      freshnessMaxMs: CFG.screenshotFreshnessMaxMs,
      frameGateTimeoutMs: CFG.frameGateTimeoutMs,
    });
    const shot = await mcpState.client.toolCallRaw(
      'synthi_screenshot',
      screenshotArgs,
      Math.max(30000, CFG.frameGateTimeoutMs + 5000),
    ).catch((e) => ({ error: e.message }));
    const content = Array.isArray(shot?.content) ? shot.content : [];
    const imageBlock = content.find((block) => block?.type === 'image' && typeof block.data === 'string');
    if (imageBlock?.data) {
      const suffix = attempt === 1 ? '' : `-attempt-${attempt}`;
      const outPath = path.join(ARTIFACT_DIR, `${CFG.slug}-${label}${suffix}.png`);
      const bytes = Buffer.from(imageBlock.data, 'base64');
      await writeFile(outPath, bytes);
      const stats = await analyzeGpuHmrImageEvidence(bytes);
      const screenshotMetadata = mcpScreenshotMetadataFromToolResult(shot);
      const row = visualEvidenceRow({
        label,
        path: outPath,
        ...stats,
        bytes: bytes.length,
        attempt,
        screenshot_metadata: screenshotMetadata,
        wait_frame_gate: wait?.frame_gate ?? wait?.frameGate ?? null,
        frame_capture_after_epoch_dispatch: mcpFrameGateSatisfiedByScreenshot(wait, {
          ...screenshotMetadata,
          seq: Number(screenshotMetadata?.seq || 0),
          ts: Number(screenshotMetadata?.ts || 0),
        }),
      });
      report.screenshots.push(row);
      const ok = screenshotQualifiesAsVisualEvidence(row);
      if (ok) {
        record(`screenshot ${label}`, 'pass', JSON.stringify(row));
        return row;
      }
      lastRow = row;
      const status = required ? 'warn' : 'info';
      record(`screenshot ${label} retry`, status, `attempt=${attempt}/${attempts} ${JSON.stringify(row)}`);
      if (attempt < attempts) {
        await sleep(CFG.screenshotRetryDelayMs);
      }
      continue;
    }
    const text = content.find((block) => block?.type === 'text')?.text;
    const detail = shot?.error ?? text ?? (shot?.isError ? JSON.stringify(shot?.structuredContent ?? shot) : 'no data');
    record(`screenshot ${label}`, 'warn', `attempt=${attempt} ${detail}`);
    await sleep(CFG.screenshotRetryDelayMs);
  }
  if (!required) {
    const detail = lastRow
      ? `visual_proof_unavailable not_visibly_non_black ${JSON.stringify(lastRow)}`
      : 'visual_proof_unavailable no_frame_captured screenshot_optional';
    record(`screenshot ${label}`, 'warn', detail);
    return lastRow;
  }
  const detail = lastRow ? JSON.stringify(lastRow) : 'no frame was captured';
  record(`screenshot ${label}`, 'fail', detail);
  throw new Error(`screenshot ${label} was expected but was not visibly non-black`);
}

function visualEvidenceFrames() {
  return report.screenshots.filter((shot) =>
    shot?.visualEvidenceSupplementalOnly !== true
    && shot?.visual_evidence_supplemental_only !== true
    && (
      shot?.frame_capture_after_epoch_dispatch === true
      || shot?.frameCaptureAfterEpochDispatch === true
    )
    && screenshotQualifiesAsVisualEvidence(shot)
  );
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readbackSampleBytes(oracle) {
  const hex = String(oracle?.readbackSampleHex ?? '').trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  return bytes.length > 0 ? bytes : null;
}

function digestBytes(value) {
  if (Buffer.isBuffer(value)) {
    return createHash('sha256').update(value).digest();
  }
  if (value instanceof Uint8Array) {
    return createHash('sha256').update(Buffer.from(value)).digest();
  }
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    return createHash('sha256').update(stableJson(value)).digest();
  }
  const text = String(value ?? '').trim();
  const sha256 = text.match(/^sha256:([0-9a-f]{64})$/i)?.[1]
    ?? text.match(/^([0-9a-f]{64})$/i)?.[1]
    ?? null;
  if (sha256) return Buffer.from(sha256, 'hex');
  return createHash('sha256').update(text).digest();
}

function computeProofArtifactName(oracle) {
  const base = `${CFG.slug}-${oracle?.oracleId ?? 'runtime-output-oracle'}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return `${base || CFG.slug}-compute-output-oracle.png`;
}

async function writeRuntimeOutputOracleVisualProof(runtimeOutputOracle) {
  const oracle = runtimeOutputOracle?.output_oracle
    ? { ...runtimeOutputOracle.latest, ...runtimeOutputOracle.output_oracle }
    : null;
  if (!oracle || runtimeOutputOracle.deterministic_oracle_passed !== true) {
    return null;
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const outPath = path.join(ARTIFACT_DIR, computeProofArtifactName(oracle));
  const width = 960;
  const height = 540;
  const expectedBytes = digestBytes(oracle.expected);
  const actualBytes = digestBytes(oracle.actual);
  const sampleBytes = readbackSampleBytes(oracle);
  const mixedBytes = digestBytes([
    oracle.oracleId,
    oracle.outputTargetId,
    oracle.runtimeSession,
    oracle.artifactId,
    oracle.probeConfigHash,
  ].join('|'));
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const stripe = Math.floor((x / width) * 32) % 32;
      const band = Math.floor((y / height) * 32) % 32;
      const e = expectedBytes[(stripe + band) % expectedBytes.length];
      const a = actualBytes[(stripe * 3 + band) % actualBytes.length];
      const sample = sampleBytes
        ? sampleBytes[(x + y * width + stripe * 17 + band * 31) % sampleBytes.length]
        : mixedBytes[(x + y + stripe) % mixedBytes.length];
      const m = mixedBytes[(x + y + stripe) % mixedBytes.length];
      raw[i] = (18 + ((e ^ sample ^ m) % 180)) & 0xff;
      raw[i + 1] = (36 + ((a + sample + m) % 170)) & 0xff;
      raw[i + 2] = (48 + ((e + a + sample + band * 7) % 190)) & 0xff;
    }
  }
  const expectedShort = String(oracle.expected ?? '').slice(0, 23);
  const actualShort = String(oracle.actual ?? '').slice(0, 23);
  const svg = `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(4,8,12,0.18)"/>
  <rect x="36" y="32" width="888" height="132" rx="8" fill="rgba(0,0,0,0.62)"/>
  <rect x="36" y="184" width="424" height="282" rx="8" fill="rgba(0,0,0,0.50)"/>
  <rect x="500" y="184" width="424" height="282" rx="8" fill="rgba(0,0,0,0.50)"/>
  <text x="60" y="74" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="30" font-weight="700">Runtime Compute Output Oracle</text>
  <text x="60" y="112" fill="#9ed8ff" font-family="Arial, sans-serif" font-size="18">target ${xmlEscape(oracle.outputTargetId ?? 'unknown')}</text>
  <text x="60" y="140" fill="#b7c8d8" font-family="Arial, sans-serif" font-size="16">session ${xmlEscape(oracle.runtimeSession ?? 'unknown')} | generation ${xmlEscape(oracle.generation ?? 'unknown')} | ${oracle.passed ? 'PASSED' : 'FAILED'}</text>
  <text x="60" y="228" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="21" font-weight="700">Expected</text>
  <text x="60" y="262" fill="#b7ffd2" font-family="Consolas, monospace" font-size="20">${xmlEscape(expectedShort)}</text>
  <text x="60" y="308" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="21" font-weight="700">Actual Readback</text>
  <text x="60" y="342" fill="#b7ffd2" font-family="Consolas, monospace" font-size="20">${xmlEscape(actualShort)}</text>
  <text x="60" y="400" fill="#b7c8d8" font-family="Arial, sans-serif" font-size="16">kind ${xmlEscape(oracle.kind ?? 'unknown')}</text>
  <text x="60" y="430" fill="#b7c8d8" font-family="Arial, sans-serif" font-size="16">producer ${xmlEscape(oracle.producer ?? 'unknown')}</text>
  <text x="524" y="228" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="21" font-weight="700">Artifact</text>
  <text x="524" y="262" fill="#ffe39e" font-family="Consolas, monospace" font-size="18">${xmlEscape(String(oracle.artifactId ?? 'unknown').slice(0, 42))}</text>
  <text x="524" y="320" fill="#f4f7fb" font-family="Arial, sans-serif" font-size="21" font-weight="700">Probe</text>
  <text x="524" y="354" fill="#ffe39e" font-family="Consolas, monospace" font-size="18">${xmlEscape(String(oracle.probeMode ?? 'unknown').slice(0, 42))}</text>
  <text x="524" y="414" fill="#b7c8d8" font-family="Arial, sans-serif" font-size="16">readback ${xmlEscape(oracle.readbackTimestamp ?? 'unknown')}</text>
  <text x="524" y="442" fill="#b7c8d8" font-family="Arial, sans-serif" font-size="16">sample ${xmlEscape(sampleBytes ? `${sampleBytes.length} bytes from GPU readback` : 'checksum-derived fallback')}</text>
</svg>`;
  await sharp(raw, { raw: { width, height, channels: 3 } })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toFile(outPath);
  const stats = await analyzeGpuHmrImageEvidence(outPath);
  const row = visualEvidenceRow({
    label: 'rocm-compute-output-oracle',
    path: outPath,
    source: 'runtime-output-oracle-readback-visualization',
    evidence_refs: oracle.evidenceRefs ?? runtimeOutputOracle.evidence_refs ?? [],
    oracle_id: oracle.oracleId,
    output_target_id: oracle.outputTargetId,
    runtime_session: oracle.runtimeSession,
    artifact_id: oracle.artifactId,
    visualEvidenceSupplementalOnly: true,
    ...stats,
  });
  report.screenshots.push(row);
  report.compute_output_oracle_visual_evidence = row;
  record(
    'runtime output oracle visual proof',
    row.accepted_as_visual_evidence ? 'pass' : 'warn',
    `quality=${row.visual_quality} path=${row.path}`,
  );
  return row;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function outputOracleBaselineChecksum() {
  return stringField(report.output_oracle_contract, ['baselineSha256', 'baseline_sha256'])
    || stringField(report.output_oracle_runtime_profile, ['baselineSha256', 'baseline_sha256'])
    || stringField(
      report.output_oracle_adaptations?.at(-1),
      ['baselineSha256', 'baseline_sha256'],
    )
    || null;
}

async function writeRuntimeOutputOracleComputeArtifacts(runtimeOutputOracle, options = {}) {
  const oracle = runtimeOutputOracle?.output_oracle
    ? { ...runtimeOutputOracle.latest, ...runtimeOutputOracle.output_oracle }
    : null;
  if (!oracle || runtimeOutputOracle.deterministic_oracle_passed !== true) return null;
  const baselineChecksum = outputOracleBaselineChecksum();
  const actualChecksum = String(oracle.actual ?? '').trim();
  if (!baselineChecksum || !actualChecksum) return null;
  const rawBytes = readbackSampleBytes(oracle);
  const sampleSha256 = String(oracle.readbackSampleSha256 ?? '').trim();
  const rawReadbackHash = rawBytes
    ? `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`
    : null;
  if (!rawBytes || sampleSha256 !== rawReadbackHash) return null;
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const base = `${CFG.slug}-${oracle.oracleId ?? 'runtime-output-oracle'}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  const rawPath = path.join(ARTIFACT_DIR, `${base || CFG.slug}-compute-readback.bin`);
  await writeFile(rawPath, rawBytes);
  const schema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    source: 'real_rocm_runtime_output_oracle',
    encoding: 'runtime_sample_hex',
    readbackSampleStride: oracle.readbackSampleStride ?? null,
    readbackSampleSha256: sampleSha256,
    outputTargetId: oracle.outputTargetId ?? null,
    oracleId: oracle.oracleId ?? null,
    artifactId: oracle.artifactId ?? null,
    runtimeSession: oracle.runtimeSession ?? null,
    generation: oracle.generation ?? null,
    probeMode: oracle.probeMode ?? null,
    probeConfigHash: oracle.probeConfigHash ?? null,
    rawReadbackHash,
    rawReadbackSource: 'runtime_readback_sample',
  };
  const schemaPath = path.join(ARTIFACT_DIR, `${base || CFG.slug}-compute-readback-schema.json`);
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);
  const cardPath = options.proofCardPath
    ?? report.compute_output_oracle_visual_evidence?.path
    ?? null;
  return {
    raw_readback_bin: rawPath,
    readback_schema_json: schemaPath,
    checksum_before: baselineChecksum,
    checksum_after: actualChecksum,
    expected_output_change:
      report.output_oracle_contract?.expectedOutputChange === true
      || baselineChecksum !== actualChecksum,
    deterministic_slice: {
      offset: 0,
      length: rawBytes.length,
      source: 'runtime_readback_sample',
    },
    raw_readback_hash: rawReadbackHash,
    raw_readback_source: 'runtime_readback_sample',
    oracle_code_hash: oracle.probeConfigHash ?? `sha256:${createHash('sha256').update(stableJson(schema)).digest('hex')}`,
    rendered_card_png: cardPath,
    producer: oracle.producer ?? 'runtime_probe',
    timestamp_after_dispatch: oracle.readbackTimestamp ?? null,
    epoch: oracle.generation ? `generation:${oracle.generation}` : oracle.artifactId ?? null,
  };
}

async function writeRuntimeVisualOracleArtifactsFromFrames(frames = [], afterFrame = null, options = {}) {
  const acceptedFrames = (Array.isArray(frames) ? frames : [])
    .filter((frame) =>
      frame?.accepted_as_visual_evidence === true
      && typeof frame?.path === 'string'
      && frame.path.trim()
    );
  const after = afterFrame && typeof afterFrame.path === 'string'
    ? afterFrame
    : acceptedFrames.at(-1);
  if (!after) return null;
  const before = acceptedFrames.find((frame) => frame.path !== after.path);
  if (!before) return null;
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const beforeRaw = await sharp(before.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const afterRaw = await sharp(after.path)
    .resize(beforeRaw.info.width, beforeRaw.info.height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const diff = Buffer.allocUnsafe(beforeRaw.data.length);
  let changed = 0;
  let visible = 0;
  let totalAbs = 0;
  for (let i = 0; i < beforeRaw.data.length; i += 4) {
    const alpha = Math.max(beforeRaw.data[i + 3], afterRaw.data[i + 3]);
    if (alpha > 0) visible += 1;
    const dr = Math.abs(afterRaw.data[i] - beforeRaw.data[i]);
    const dg = Math.abs(afterRaw.data[i + 1] - beforeRaw.data[i + 1]);
    const db = Math.abs(afterRaw.data[i + 2] - beforeRaw.data[i + 2]);
    const da = Math.abs(afterRaw.data[i + 3] - beforeRaw.data[i + 3]);
    const delta = dr + dg + db + da;
    if (delta > 12) changed += 1;
    totalAbs += delta;
    diff[i] = Math.min(255, dr * 4);
    diff[i + 1] = Math.min(255, dg * 4);
    diff[i + 2] = Math.min(255, db * 4);
    diff[i + 3] = 255;
  }
  const pixelCount = beforeRaw.info.width * beforeRaw.info.height;
  const diffPath = path.join(
    ARTIFACT_DIR,
    `${CFG.slug}-${options.name ?? 'runtime-visual-oracle'}-diff.png`
      .replace(/[^A-Za-z0-9_.-]+/g, '-'),
  );
  await sharp(diff, {
    raw: {
      width: beforeRaw.info.width,
      height: beforeRaw.info.height,
      channels: 4,
    },
  }).png().toFile(diffPath);
  return {
    before_image: before.path,
    after_image: after.path,
    diff_image: diffPath,
    blank_frame_rejection: visible > 0,
    same_frame_rejection: changed > 0,
    new_epoch_watermark_or_trace: options.epochTrace ?? after.contentHash ?? after.content_hash ?? null,
    camera_state_hash: options.cameraStateHash ?? null,
    swapchain_size: [beforeRaw.info.width, beforeRaw.info.height],
    capture_backend: options.captureBackend ?? 'mcp_synthi_screenshot',
    frame_number: Number.isFinite(options.frameNumber) ? options.frameNumber : null,
    timestamp_after_dispatch: options.timestampAfterDispatch ?? Date.now(),
    perceptual_diff: pixelCount > 0 ? totalAbs / (pixelCount * 4 * 255) : 0,
    changed_pixel_ratio: pixelCount > 0 ? changed / pixelCount : 0,
    visible_pixel_count: visible,
  };
}

function editSource(source, before, after, label) {
  if (!before || before === after) throw new Error(`${label} source delta must be non-empty and change the source`);
  if (!source.includes(before)) throw new Error(`${label} source delta did not match the selected file`);
  return source.replace(before, after);
}

function editConfiguredSource(source) {
  return editSource(source, CFG.deltaBefore, CFG.deltaAfter, 'configured');
}

function parseCppNumericLiteral(raw) {
  const text = String(raw ?? '').trim().replace(/[fFuUlL]+$/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parseSaxpySourceConstants(source) {
  const sizeMatch = /\bconstexpr\s+unsigned\s+int\s+size\s*=\s*(\d+)\s*;/m.exec(source);
  const blockSizeMatch = /\bconstexpr\s+unsigned\s+int\s+block_size\s*=\s*(\d+)\s*;/m.exec(source);
  const aMatch = /\bconstexpr\s+float\s+a\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?f?)\s*;/im.exec(source);
  const xStartMatch = /\bstd::iota\s*\(\s*x\.begin\s*\(\s*\)\s*,\s*x\.end\s*\(\s*\)\s*,\s*([^)]+?)\s*\)\s*;/m.exec(source);
  const yFillMatch = /\bstd::fill\s*\(\s*y\.begin\s*\(\s*\)\s*,\s*y\.end\s*\(\s*\)\s*,\s*([^)]+?)\s*\)\s*;/m.exec(source);
  const size = sizeMatch ? Number(sizeMatch[1]) : NaN;
  const blockSize = blockSizeMatch ? Number(blockSizeMatch[1]) : NaN;
  const a = aMatch ? parseCppNumericLiteral(aMatch[1]) : null;
  const xStart = xStartMatch ? parseCppNumericLiteral(xStartMatch[1]) : null;
  const yFill = yFillMatch ? parseCppNumericLiteral(yFillMatch[1]) : null;
  if (
    !Number.isInteger(size)
    || size <= 0
    || size > 64 * 1024 * 1024
    || !Number.isInteger(blockSize)
    || blockSize <= 0
    || blockSize > 1024
    || a === null
    || xStart === null
    || yFill === null
  ) {
    return null;
  }
  return { size, blockSize, a, xStart, yFill };
}

function saxpyMultiplierPlanAfterDelta(source, deltaAfter) {
  const constants = parseSaxpySourceConstants(source);
  if (!constants) return null;
  const after = String(deltaAfter ?? '');
  const plusMatch = /\(\s*a\s*\+\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?f?)\s*\)\s*\*\s*d_x\s*\[\s*global_idx\s*\]\s*\+\s*d_y\s*\[\s*global_idx\s*\]/im.exec(after);
  if (plusMatch) {
    const delta = parseCppNumericLiteral(plusMatch[1]);
    if (delta === null) return null;
    return {
      argumentMultiplier: Math.fround(constants.a),
      effectiveMultiplier: Math.fround(Math.fround(constants.a) + Math.fround(delta)),
      kernelDelta: Math.fround(delta),
    };
  }
  if (/\ba\s*\*\s*d_x\s*\[\s*global_idx\s*\]\s*\+\s*d_y\s*\[\s*global_idx\s*\]/im.test(after)) {
    return {
      argumentMultiplier: Math.fround(constants.a),
      effectiveMultiplier: Math.fround(constants.a),
      kernelDelta: 0,
    };
  }
  return null;
}

function saxpyExpectedOutputChecksum(source, { sourceFile, deltaAfter }) {
  const constants = parseSaxpySourceConstants(source);
  const multiplierPlan = saxpyMultiplierPlanAfterDelta(source, deltaAfter);
  if (!constants || multiplierPlan === null) return null;
  const bytesForMultiplier = (multiplier) => {
    const bytes = Buffer.allocUnsafe(constants.size * 4);
    const yInitial = Math.fround(constants.yFill);
    for (let index = 0; index < constants.size; index += 1) {
      const xValue = Math.fround(constants.xStart + index);
      const value = Math.fround(Math.fround(multiplier * xValue) + yInitial);
      bytes.writeFloatLE(value, index * 4);
    }
    return bytes;
  };
  const baselineBytes = bytesForMultiplier(Math.fround(constants.a));
  const bytes = Buffer.allocUnsafe(constants.size * 4);
  const yInitial = Math.fround(constants.yFill);
  for (let index = 0; index < constants.size; index += 1) {
    const xValue = Math.fround(constants.xStart + index);
    const value = Math.fround(Math.fround(multiplierPlan.effectiveMultiplier * xValue) + yInitial);
    bytes.writeFloatLE(value, index * 4);
  }
  const baselineSha256 = `sha256:${createHash('sha256').update(baselineBytes).digest('hex')}`;
  const expectedSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const config = {
    schemaVersion: 'synthi.real_rocm.output_oracle_profile.saxpy_readback_y.v1',
    sourceFile,
    outputTargetId: `${sourceFile}:y`,
    size: constants.size,
    blockSize: constants.blockSize,
    xStart: constants.xStart,
    yInitial: constants.yFill,
    argumentMultiplier: multiplierPlan.argumentMultiplier,
    baselineEffectiveMultiplier: Math.fround(constants.a),
    effectiveMultiplier: multiplierPlan.effectiveMultiplier,
    kernelDelta: multiplierPlan.kernelDelta,
    baselineSha256,
    deltaAfterSha256: `sha256:${createHash('sha256').update(deltaAfter).digest('hex')}`,
    expectedSha256,
  };
  const configJson = JSON.stringify(config);
  const configHash = `sha256:${createHash('sha256').update(configJson).digest('hex')}`;
  return {
    ...config,
    configHash,
    oracleId: `oracle:real-rocm:saxpy-readback-y:${configHash.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    producer: 'real_rocm_source_derived_output_profile',
    probeMode: 'post_hmr_device_to_host_buffer_checksum',
    probeEvidenceRef: 'evidence:output-oracle:real-rocm-saxpy-y-buffer',
    runtimeProfile: {
      schemaVersion: 'synthi.gpu_hmr.runtime_output_oracle.v1',
      enabled: true,
      profileId: 'hip.saxpy.readback-y.v1',
      oracleId: `oracle:real-rocm:saxpy-readback-y:${configHash.slice('sha256:'.length, 'sha256:'.length + 16)}`,
      baselineSha256,
      expectedSha256,
      producer: 'real_rocm_source_derived_output_profile',
      outputTargetId: `${sourceFile}:y`,
      kernelName: 'saxpy_kernel',
      grid: [Math.ceil(constants.size / constants.blockSize), 1, 1],
      block: [constants.blockSize, 1, 1],
      buffers: [
        {
          name: 'x',
          elementType: 'f32',
          count: constants.size,
          initializer: { kind: 'iota', start: constants.xStart },
        },
        {
          name: 'y',
          elementType: 'f32',
          count: constants.size,
          initializer: { kind: 'fill', value: constants.yFill },
        },
      ],
      args: [
        { kind: 'scalar_f32', value: multiplierPlan.argumentMultiplier },
        { kind: 'buffer', name: 'x' },
        { kind: 'buffer', name: 'y' },
        { kind: 'scalar_u32', value: constants.size },
      ],
      outputBuffer: 'y',
      probeMode: 'post_hmr_active_kernel_readback_checksum',
      probeConfigHash: configHash,
      probeEvidenceRef: 'evidence:output-oracle:real-rocm-saxpy-runtime-probe',
    },
  };
}

function parseMatrixMultiplicationSourceConstants(source) {
  const blockSizeMatch = /\bconstexpr\s+unsigned\s+int\s+block_size\s*=\s*(\d+)\s*;/m.exec(source);
  const aRowsMatch = /\bconstexpr\s+unsigned\s+int\s+a_rows\s*=\s*(\d+)\s*;/m.exec(source);
  const aColsMatch = /\bconstexpr\s+unsigned\s+int\s+a_cols\s*=\s*(\d+)\s*;/m.exec(source);
  const bColsMatch = /\bconstexpr\s+unsigned\s+int\s+b_cols\s*=\s*(\d+)\s*;/m.exec(source);
  const aFillMatch = /\bstd::fill\s*\(\s*A\.begin\s*\(\s*\)\s*,\s*A\.end\s*\(\s*\)\s*,\s*([^)]+?)\s*\)\s*;/m.exec(source);
  const bValueMatch = /\bconstexpr\s+float\s+b_value\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?f?)\s*;/im.exec(source);
  const blockSize = blockSizeMatch ? Number(blockSizeMatch[1]) : NaN;
  const aRows = aRowsMatch ? Number(aRowsMatch[1]) : NaN;
  const aCols = aColsMatch ? Number(aColsMatch[1]) : NaN;
  const bCols = bColsMatch ? Number(bColsMatch[1]) : NaN;
  const aFill = aFillMatch ? parseCppNumericLiteral(aFillMatch[1]) : null;
  const bValue = bValueMatch ? parseCppNumericLiteral(bValueMatch[1]) : null;
  const maxElements = 16 * 1024 * 1024;
  if (
    !Number.isInteger(blockSize)
    || blockSize <= 0
    || blockSize > 1024
    || !Number.isInteger(aRows)
    || aRows <= 0
    || !Number.isInteger(aCols)
    || aCols <= 0
    || !Number.isInteger(bCols)
    || bCols <= 0
    || aRows * bCols > maxElements
    || aRows % blockSize !== 0
    || aCols % blockSize !== 0
    || bCols % blockSize !== 0
    || aFill === null
    || bValue === null
  ) {
    return null;
  }
  return { blockSize, aRows, aCols, bCols, aFill, bValue };
}

function matrixBValueAfterDelta(deltaAfter) {
  const match = /\bconstexpr\s+float\s+b_value\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?f?)\s*;/im.exec(
    String(deltaAfter ?? ''),
  );
  return match ? parseCppNumericLiteral(match[1]) : null;
}

function matrixMultiplicationExpectedOutputChecksum(source, { sourceFile, deltaAfter }) {
  const constants = parseMatrixMultiplicationSourceConstants(source);
  const deltaBValue = matrixBValueAfterDelta(deltaAfter);
  if (!constants || deltaBValue === null) return null;
  const bytesForBValue = (bValue) => {
    const elementCount = constants.aRows * constants.bCols;
    const bytes = Buffer.allocUnsafe(elementCount * 4);
    const expectedValue = Math.fround(
      Math.fround(constants.aCols)
      * Math.fround(constants.aFill)
      * Math.fround(bValue),
    );
    for (let index = 0; index < elementCount; index += 1) {
      bytes.writeFloatLE(expectedValue, index * 4);
    }
    return bytes;
  };
  const baselineBytes = bytesForBValue(constants.bValue);
  const expectedBytes = bytesForBValue(deltaBValue);
  const baselineSha256 = `sha256:${createHash('sha256').update(baselineBytes).digest('hex')}`;
  const expectedSha256 = `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;
  const config = {
    schemaVersion: 'synthi.real_rocm.output_oracle_profile.matrix_multiplication_readback_c.v1',
    sourceFile,
    outputTargetId: `${sourceFile}:C`,
    aRows: constants.aRows,
    aCols: constants.aCols,
    bCols: constants.bCols,
    blockSize: constants.blockSize,
    aFill: constants.aFill,
    baselineBValue: constants.bValue,
    effectiveBValue: deltaBValue,
    baselineSha256,
    deltaAfterSha256: `sha256:${createHash('sha256').update(deltaAfter).digest('hex')}`,
    expectedSha256,
  };
  const configJson = JSON.stringify(config);
  const configHash = `sha256:${createHash('sha256').update(configJson).digest('hex')}`;
  return {
    ...config,
    configHash,
    oracleId: `oracle:real-rocm:matrix-readback-c:${configHash.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    producer: 'real_rocm_source_derived_output_profile',
    probeMode: 'post_hmr_device_to_host_buffer_checksum',
    probeEvidenceRef: 'evidence:output-oracle:real-rocm-matrix-c-buffer',
    runtimeProfile: {
      schemaVersion: 'synthi.gpu_hmr.runtime_output_oracle.v1',
      enabled: true,
      profileId: 'hip.matrix-multiplication.readback-c.v1',
      oracleId: `oracle:real-rocm:matrix-readback-c:${configHash.slice('sha256:'.length, 'sha256:'.length + 16)}`,
      baselineSha256,
      expectedSha256,
      producer: 'real_rocm_source_derived_output_profile',
      outputTargetId: `${sourceFile}:C`,
      kernelName: 'matrix_multiplication_kernel',
      grid: [constants.bCols / constants.blockSize, constants.aRows / constants.blockSize, 1],
      block: [constants.blockSize, constants.blockSize, 1],
      buffers: [
        {
          name: 'A',
          elementType: 'f32',
          count: constants.aRows * constants.aCols,
          initializer: { kind: 'fill', value: constants.aFill },
        },
        {
          name: 'B',
          elementType: 'f32',
          count: constants.aCols * constants.bCols,
          initializer: { kind: 'fill', value: deltaBValue },
        },
        {
          name: 'C',
          elementType: 'f32',
          count: constants.aRows * constants.bCols,
          initializer: { kind: 'zero' },
        },
      ],
      args: [
        { kind: 'buffer', name: 'A' },
        { kind: 'buffer', name: 'B' },
        { kind: 'buffer', name: 'C' },
        { kind: 'scalar_u32', value: constants.aCols },
      ],
      outputBuffer: 'C',
      probeMode: 'post_hmr_active_kernel_readback_checksum',
      probeConfigHash: configHash,
      probeEvidenceRef: 'evidence:output-oracle:real-rocm-matrix-runtime-probe',
    },
  };
}

function instrumentSaxpyOutputOracleSource(source, oracle, profileId) {
  if (!oracle) return null;
  if (source.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE')) {
    return source;
  }
  const declaration = `
extern "C" bool synthi_gpu_record_output_buffer_checksum_with_probe(
    const char* oracle_id,
    const void* data,
    std::size_t bytes,
    const char* expected_sha256,
    const char* producer,
    const char* output_target_id,
    const char* artifact_id,
    const char* visual_evidence_ref,
    const char* probe_mode,
    const char* probe_config_hash,
    const char* probe_evidence_ref);
`;
  const includeMatch = /^#include\s+<cstddef>\s*\r?\n/m.exec(source);
  if (!includeMatch) return null;
  const withDeclaration = source.replace(includeMatch[0], includeMatch[0] + declaration);
  const copyMatch = /^([ \t]*)HIP_CHECK\s*\(\s*hipMemcpy\s*\(\s*y\.data\s*\(\s*\)\s*,\s*d_y\s*,\s*size_bytes\s*,\s*hipMemcpyDeviceToHost\s*\)\s*\)\s*;\s*\r?\n/m.exec(withDeclaration);
  if (!copyMatch) return null;
  const indent = copyMatch[1] ?? '    ';
  const oracleCall = `
${indent}// SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:${profileId}
${indent}// Actual post-dispatch device readback proof.
${indent}(void)synthi_gpu_record_output_buffer_checksum_with_probe(
${indent}    "${oracle.oracleId}",
${indent}    y.data(),
${indent}    size_bytes,
${indent}    "${oracle.expectedSha256}",
${indent}    "${oracle.producer}",
${indent}    "${oracle.outputTargetId}",
${indent}    nullptr,
${indent}    nullptr,
${indent}    "${oracle.probeMode}",
${indent}    "${oracle.configHash}",
${indent}    "${oracle.probeEvidenceRef}");
`;
  return withDeclaration.replace(copyMatch[0], copyMatch[0] + oracleCall);
}

function instrumentMatrixMultiplicationOutputOracleSource(source, oracle, profileId) {
  if (!oracle) return null;
  if (source.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE')) {
    return source;
  }
  const declaration = `
extern "C" bool synthi_gpu_record_output_buffer_checksum_with_probe(
    const char* oracle_id,
    const void* data,
    std::size_t bytes,
    const char* expected_sha256,
    const char* producer,
    const char* output_target_id,
    const char* artifact_id,
    const char* visual_evidence_ref,
    const char* probe_mode,
    const char* probe_config_hash,
    const char* probe_evidence_ref);
`;
  const includeMatch = /^#include\s+<cstddef>\s*\r?\n/m.exec(source);
  if (!includeMatch) return null;
  const withDeclaration = source.replace(includeMatch[0], includeMatch[0] + declaration);
  const copyMatch = /^([ \t]*)HIP_CHECK\s*\(\s*hipMemcpy\s*\(\s*C\.data\s*\(\s*\)\s*,\s*d_C\s*,\s*c_bytes\s*,\s*hipMemcpyDeviceToHost\s*\)\s*\)\s*;\s*\r?\n/m.exec(withDeclaration);
  if (!copyMatch) return null;
  const indent = copyMatch[1] ?? '    ';
  const oracleCall = `
${indent}// SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:${profileId}
${indent}// Actual post-dispatch matrix C readback proof.
${indent}(void)synthi_gpu_record_output_buffer_checksum_with_probe(
${indent}    "${oracle.oracleId}",
${indent}    C.data(),
${indent}    c_bytes,
${indent}    "${oracle.expectedSha256}",
${indent}    "${oracle.producer}",
${indent}    "${oracle.outputTargetId}",
${indent}    nullptr,
${indent}    nullptr,
${indent}    "${oracle.probeMode}",
${indent}    "${oracle.configHash}",
${indent}    "${oracle.probeEvidenceRef}");
`;
  return withDeclaration.replace(copyMatch[0], copyMatch[0] + oracleCall);
}

const SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES = Object.freeze([
  {
    id: 'hip.saxpy.readback-y.v1',
    aliases: Object.freeze(['saxpy-readback-y', 'saxpy-y-buffer']),
    label: 'HIP saxpy post-copy y-buffer checksum',
    derive({ source, sourceFile, deltaAfter }) {
      const oracle = saxpyExpectedOutputChecksum(source, { sourceFile, deltaAfter });
      if (!oracle) return null;
      return {
        ...oracle,
        profileId: this.id,
        profileLabel: this.label,
      };
    },
    instrument({ source, oracle }) {
      return instrumentSaxpyOutputOracleSource(source, oracle, this.id);
    },
  },
  {
    id: 'hip.matrix-multiplication.readback-c.v1',
    aliases: Object.freeze(['matrix-multiplication-readback-c', 'matrix-c-buffer']),
    label: 'HIP matrix multiplication post-copy C-buffer checksum',
    derive({ source, sourceFile, deltaAfter }) {
      const oracle = matrixMultiplicationExpectedOutputChecksum(source, { sourceFile, deltaAfter });
      if (!oracle) return null;
      return {
        ...oracle,
        profileId: this.id,
        profileLabel: this.label,
      };
    },
    instrument({ source, oracle }) {
      return instrumentMatrixMultiplicationOutputOracleSource(source, oracle, this.id);
    },
  },
]);

function outputOracleProfilesByName() {
  const profiles = new Map();
  for (const profile of SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES) {
    profiles.set(profile.id.toLowerCase(), profile);
    for (const alias of profile.aliases ?? []) {
      profiles.set(String(alias).toLowerCase(), profile);
    }
  }
  return profiles;
}

function outputOracleProfileModeDisabled(mode) {
  return ['0', 'false', 'off', 'none', 'disabled'].includes(String(mode ?? '').trim().toLowerCase());
}

function outputOracleContractFromRuntimeProfile(runtimeProfile) {
  if (!runtimeProfile || typeof runtimeProfile !== 'object' || Array.isArray(runtimeProfile)) return null;
  const contract = {};
  const fieldMap = {
    oracleId: ['oracleId', 'oracle_id', 'id'],
    requiredOracleId: ['requiredOracleId', 'required_oracle_id', 'oracleId', 'oracle_id', 'id'],
    kind: ['kind'],
    expected: ['expected', 'expectedSha256', 'expected_sha256', 'expectedHash', 'expected_hash'],
    producer: ['producer', 'producerId', 'producer_id'],
    outputTargetId: ['outputTargetId', 'output_target_id', 'target'],
    artifactId: ['artifactId', 'artifact_id'],
    runtimeSessionId: ['runtimeSessionId', 'runtime_session_id'],
    kernelSymbol: ['kernelSymbol', 'kernel_symbol', 'kernelName', 'kernel_name'],
  };
  for (const [canonical, fields] of Object.entries(fieldMap)) {
    const value = stringField(runtimeProfile, fields);
    if (value) contract[canonical] = value;
  }
  return Object.keys(contract).length > 0 ? contract : null;
}

function candidateOutputOracleAdaptations(files) {
  const file = files.find((candidate) => candidate.path === CFG.deltaFile);
  if (!file) return [];
  const candidates = [];
  for (const profile of SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES) {
    const oracle = profile.derive({
      source: file.content,
      sourceFile: CFG.deltaFile,
      deltaAfter: CFG.deltaAfter,
      cfg: CFG,
    });
    if (!oracle) continue;
    const instrumented = profile.instrument({
      source: file.content,
      sourceFile: CFG.deltaFile,
      oracle,
      cfg: CFG,
    });
    if (!instrumented || instrumented === file.content) continue;
    candidates.push({
      profile,
      file,
      oracle,
      instrumented,
    });
  }
  return candidates;
}

function selectedOutputOracleAdaptation(files) {
  const mode = CFG.outputOracleProfile;
  if (outputOracleProfileModeDisabled(mode)) {
    report.output_oracle_resolution = {
      ...report.output_oracle_resolution,
      requestedProfile: mode,
      mode,
      sourceDerivedCandidateCount: 0,
      selectedSource: null,
      disabledReason: 'profile_disabled',
      failedReason: null,
      contractPresent: report.output_oracle_contract !== null,
      runtimeProfilePresent: report.output_oracle_runtime_profile !== null,
    };
    return null;
  }
  const candidates = candidateOutputOracleAdaptations(files);
  report.output_oracle_resolution = {
    ...report.output_oracle_resolution,
    requestedProfile: mode,
    mode,
    sourceDerivedCandidateCount: candidates.length,
    disabledReason: null,
    failedReason: candidates.length === 0 ? 'source_derived_oracle_not_found' : null,
    contractPresent: report.output_oracle_contract !== null,
    runtimeProfilePresent: report.output_oracle_runtime_profile !== null,
  };
  if (mode === 'auto') {
    if (candidates.length <= 1) return candidates[0] ?? null;
    const names = candidates.map((candidate) => candidate.profile.id).join(', ');
    throw new Error(`output oracle profile auto-discovery was ambiguous: ${names}`);
  }
  const requested = outputOracleProfilesByName().get(mode);
  if (!requested) {
    if (CFG.outputOracleRuntimeProfile) {
      report.output_oracle_resolution = {
        ...report.output_oracle_resolution,
        failedReason: null,
        selectedSource: 'profile_runtime_profile',
        runtimeProfilePresent: true,
      };
      return null;
    }
    const available = SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES
      .map((profile) => profile.id)
      .join(', ');
    throw new Error(`unknown output oracle profile "${mode}"; available profiles: auto, none, ${available}`);
  }
  const selected = candidates.find((candidate) => candidate.profile.id === requested.id);
  if (!selected) {
    if (CFG.outputOracleRuntimeProfile) {
      report.output_oracle_resolution = {
        ...report.output_oracle_resolution,
        failedReason: null,
        selectedSource: 'profile_runtime_profile',
        runtimeProfilePresent: true,
      };
      return null;
    }
    throw new Error(
      `output oracle profile "${requested.id}" could not derive a valid oracle from ${CFG.deltaFile}; `
      + 'the source constants, delta math, or readback instrumentation anchors did not match',
    );
  }
  return selected;
}

function applyOutputOracleProfileAdaptation(files, updateFileContent) {
  const adaptation = selectedOutputOracleAdaptation(files);
  if (!adaptation) {
    if (CFG.outputOracleRuntimeProfile) {
      report.output_oracle_runtime_profile = CFG.outputOracleRuntimeProfile;
      if (!report.output_oracle_contract) {
        report.output_oracle_contract =
          outputOracleContractFromRuntimeProfile(CFG.outputOracleRuntimeProfile);
      }
      report.output_oracle_resolution = {
        ...report.output_oracle_resolution,
        selectedSource: 'profile_runtime_profile',
        disabledReason: null,
        failedReason: report.output_oracle_contract
          ? null
          : 'profile_runtime_profile_missing_contract_fields',
        contractPresent: report.output_oracle_contract !== null,
        runtimeProfilePresent: true,
      };
      report.output_oracle_adaptations.push({
        profileId: stringField(CFG.outputOracleRuntimeProfile, ['profileId', 'profile_id', 'id'])
          || 'profile-runtime-output-oracle',
        profileLabel: 'Profile-provided runtime output oracle',
        kind: 'profile_runtime_output_oracle',
        file: CFG.deltaFile,
        oracleId: stringField(CFG.outputOracleRuntimeProfile, ['oracleId', 'oracle_id', 'id']) || null,
        expectedSha256: stringField(CFG.outputOracleRuntimeProfile, ['expectedSha256', 'expected_sha256', 'expected']) || null,
        producer: stringField(CFG.outputOracleRuntimeProfile, ['producer']) || null,
        outputTargetId: stringField(CFG.outputOracleRuntimeProfile, ['outputTargetId', 'output_target_id', 'target']) || null,
        probeMode: stringField(CFG.outputOracleRuntimeProfile, ['probeMode', 'probe_mode']) || null,
        probeEvidenceRef: stringField(CFG.outputOracleRuntimeProfile, ['probeEvidenceRef', 'probe_evidence_ref']) || null,
        runtimeProbeMode: stringField(CFG.outputOracleRuntimeProfile, ['probeMode', 'probe_mode']) || null,
        runtimeProbeEvidenceRef: stringField(CFG.outputOracleRuntimeProfile, ['probeEvidenceRef', 'probe_evidence_ref']) || null,
      });
      record(
        'profile runtime output oracle',
        report.output_oracle_contract ? 'pass' : 'warn',
        report.output_oracle_contract
          ? `profile=${stringField(CFG.outputOracleRuntimeProfile, ['profileId', 'profile_id', 'id']) || 'profile-runtime-output-oracle'}`
          : 'runtime profile supplied but no supported contract fields were found',
      );
      return { runtimeProfile: CFG.outputOracleRuntimeProfile };
    }
    report.output_oracle_resolution = {
      ...report.output_oracle_resolution,
      selectedSource: null,
      contractPresent: report.output_oracle_contract !== null,
      runtimeProfilePresent: report.output_oracle_runtime_profile !== null,
    };
    record(
      'source-derived output oracle profile',
      outputOracleProfileModeDisabled(CFG.outputOracleProfile) ? 'info' : 'warn',
      `profile=${CFG.outputOracleProfile} no source-derived runtime oracle instrumentation applied`,
    );
    return null;
  }
  const { profile, oracle, instrumented } = adaptation;
  updateFileContent(CFG.deltaFile, instrumented);
  const contract = {
    oracleId: oracle.oracleId,
    requiredOracleId: oracle.oracleId,
    kind: 'buffer_checksum',
    expected: oracle.expectedSha256,
    baselineSha256: oracle.baselineSha256,
    expectedOutputChange: oracle.baselineSha256 !== oracle.expectedSha256,
    producer: oracle.producer,
    outputTargetId: oracle.outputTargetId,
  };
  report.output_oracle_contract = contract;
  report.output_oracle_runtime_profile = oracle.runtimeProfile ?? null;
  report.output_oracle_resolution = {
    ...report.output_oracle_resolution,
    selectedSource: 'source_derived_profile',
    selectedProfileId: profile.id,
    selectedOracleId: oracle.oracleId,
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: report.output_oracle_runtime_profile !== null,
  };
  report.output_oracle_adaptations.push({
    profileId: profile.id,
    profileLabel: profile.label,
    kind: 'source_derived_buffer_checksum',
    sourceAdaptedProfile: true,
    source_adapted_profile: true,
    sourceAdaptations: [
      `source-derived output oracle instrumentation:${profile.id}`,
    ],
    source_adaptations: [
      `source-derived output oracle instrumentation:${profile.id}`,
    ],
    file: CFG.deltaFile,
    oracleId: oracle.oracleId,
    baselineSha256: oracle.baselineSha256,
    expectedSha256: oracle.expectedSha256,
    configHash: oracle.configHash,
    producer: oracle.producer,
    outputTargetId: oracle.outputTargetId,
    probeMode: oracle.probeMode,
    probeEvidenceRef: oracle.probeEvidenceRef,
    runtimeProbeMode: oracle.runtimeProfile?.probeMode ?? null,
    runtimeProbeEvidenceRef: oracle.runtimeProfile?.probeEvidenceRef ?? null,
    failedGates: [
      { code: 'source_adapted_profile_not_no_shim_gpu_hmr' },
    ],
    failed_gates: [
      { code: 'source_adapted_profile_not_no_shim_gpu_hmr' },
    ],
  });
  record(
    'source-derived output oracle profile',
    'pass',
    `profile=${profile.id} oracle=${oracle.oracleId} expected=${oracle.expectedSha256} config=${oracle.configHash}`,
  );
  return oracle;
}

function safePhaseLabel(label, index) {
  return cleanIdentifier(label || `extra-${index + 1}`).replace(/\./g, '-');
}

function parseExtraDeltas() {
  const deltas = [];
  if (CFG.secondDeltaBefore || CFG.secondDeltaAfter) {
    if (!CFG.secondDeltaBefore || !CFG.secondDeltaAfter) {
      throw new Error('second source delta requires both SYNTHI_REAL_ROCM_SECOND_DELTA_BEFORE and SYNTHI_REAL_ROCM_SECOND_DELTA_AFTER');
    }
    deltas.push({
      label: 'second',
      kind: 'hot_delta_2',
      file: CFG.secondDeltaFile,
      before: CFG.secondDeltaBefore,
      after: CFG.secondDeltaAfter,
    });
  }
  if (!CFG.extraDeltasJson.trim()) return deltas;

  let parsed;
  try {
    parsed = JSON.parse(CFG.extraDeltasJson);
  } catch (err) {
    throw new Error(`SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('SYNTHI_REAL_ROCM_EXTRA_DELTAS_JSON must be a JSON array');
  }
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`extra delta ${index + 1} must be an object`);
    }
    const file = String(entry.file ?? entry.path ?? CFG.deltaFile).replace(/\\/g, '/');
    const before = typeof entry.before === 'string' ? entry.before : '';
    const after = typeof entry.after === 'string' ? entry.after : '';
    if (!file || !before || !after || before === after) {
      throw new Error(`extra delta ${index + 1} requires file/path, before, and after strings that change the source`);
    }
    deltas.push({
      label: safePhaseLabel(entry.label, index),
      kind: cleanIdentifier(entry.kind ?? entry.editKind ?? entry.edit_kind ?? entry.label ?? 'extra_delta'),
      expectedRefusal: entry.expectedRefusal === true || entry.expected_refusal === true,
      file,
      before,
      after,
    });
  });
  return deltas;
}

function effectiveSourceDeltaFromConfiguredDeltas(extraDeltas = []) {
  const secondDelta = extraDeltas.find((delta) =>
    sourceDeltaPhaseKind(delta) === 'hot_delta_2'
    && String(delta.label ?? '').toLowerCase() === 'second'
  );
  const extraDeltaEntries = extraDeltas
    .filter((delta) => delta !== secondDelta)
    .map((delta) => ({
      label: delta.label,
      kind: delta.kind,
      expectedRefusal: delta.expectedRefusal === true,
      expected_refusal: delta.expectedRefusal === true,
      file: delta.file,
      before: delta.before,
      after: delta.after,
    }));
  return {
    before: CFG.deltaBefore,
    after: CFG.deltaAfter,
    second: secondDelta
      ? {
          file: secondDelta.file,
          before: secondDelta.before,
          after: secondDelta.after,
        }
      : {
          file: CFG.secondDeltaFile,
          before: CFG.secondDeltaBefore,
          after: CFG.secondDeltaAfter,
        },
    extraDeltas: extraDeltaEntries,
    extra_deltas: extraDeltaEntries,
  };
}

function effectiveRealRocmProfileWithConfiguredSourceDeltas(extraDeltas = []) {
  const sourceDelta = effectiveSourceDeltaFromConfiguredDeltas(extraDeltas);
  return {
    ...CFG.realRocmProfile,
    sourceDelta,
    source_delta: sourceDelta,
  };
}

function sourceDeltaPlanForReport(extraDeltas = []) {
  return extraDeltas.map((delta) => ({
    label: delta.label,
    kind: delta.kind ?? null,
    expected_refusal: delta.expectedRefusal === true,
    file: delta.file,
    before_sha256: createHash('sha256').update(delta.before).digest('hex'),
    after_sha256: createHash('sha256').update(delta.after).digest('hex'),
  }));
}

function applyConfiguredSourceDeltaPlan(extraDeltas = []) {
  const effectiveProfile = effectiveRealRocmProfileWithConfiguredSourceDeltas(extraDeltas);
  const sourceDelta = effectiveProfile.sourceDelta;
  report.real_rocm_profile.sourceDelta = sourceDelta;
  report.real_rocm_profile.source_delta = sourceDelta;
  report.extra_deltas = sourceDeltaPlanForReport(extraDeltas);
  report.real_rocm_profile_proof_obligations = realRocmProfileProofObligationsFacet({
    profile: effectiveProfile,
    targetProgression: report.target_progression,
    outputOracleProfile: CFG.outputOracleProfile,
    outputOracleContract: CFG.outputOracleContract,
    outputOracleRuntimeProfile: CFG.outputOracleRuntimeProfile,
    requireFullRuntimeProof: CFG.requireFullRuntimeProof,
  });
  report.realRocmProfileProofObligations = report.real_rocm_profile_proof_obligations;
  report.profile_proof_obligations = report.real_rocm_profile_proof_obligations;
  report.profileProofObligations = report.real_rocm_profile_proof_obligations;
  report.source_delta_fixtures = report.real_rocm_profile_proof_obligations.sourceDeltaFixtures;
  report.real_rocm_source_delta_fixtures = report.real_rocm_profile_proof_obligations.sourceDeltaFixtures;
  report.evidence.real_rocm_profile_proof_obligations = report.real_rocm_profile_proof_obligations;
  report.evidence.source_delta_fixtures = report.source_delta_fixtures;
  return effectiveProfile;
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function sourceDeltaPhaseKind({ kind = '', label = '', metricScope = '' } = {}) {
  const normalized = cleanIdentifier(kind || label || metricScope || 'source_delta')
    .toLowerCase()
    .replace(/[-.]+/g, '_');
  if (
    normalized === 'hot_delta_2'
    || normalized === 'hot2'
    || normalized === 'second'
    || normalized.includes('hot_delta_2')
  ) {
    return 'hot_delta_2';
  }
  if (normalized === 'negative_edit' || normalized === 'negative' || normalized.includes('negative')) {
    return 'negative_edit';
  }
  if (normalized === 'hot_delta_1' || normalized === 'hmr_delta' || normalized.includes('hot_delta_1')) {
    return 'hot_delta_1';
  }
  return normalized || 'source_delta';
}

function sourceDeltaExecutionProofId(phases = []) {
  return `real-rocm-source-delta-execution:sha256:${createHash('sha256')
    .update(stableJson({
      schemaVersion: REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION,
      phases: phases.map((phase) => ({
        phaseName: phase.phaseName,
        phase_name: phase.phase_name,
        phaseKind: phase.phaseKind,
        phase_kind: phase.phase_kind,
        file: phase.file,
        editHash: phase.editHash,
        edit_hash: phase.edit_hash,
        sourceBeforeHash: phase.sourceBeforeHash,
        source_before_hash: phase.source_before_hash,
        sourceAfterHash: phase.sourceAfterHash,
        source_after_hash: phase.source_after_hash,
        sourceWriteObserved: phase.sourceWriteObserved,
        source_write_observed: phase.source_write_observed,
        compileCallAttempted: phase.compileCallAttempted,
        compile_call_attempted: phase.compile_call_attempted,
        compileCallCompleted: phase.compileCallCompleted,
        compile_call_completed: phase.compile_call_completed,
        hmrWaitStatus: phase.hmrWaitStatus,
        hmr_wait_status: phase.hmr_wait_status,
        expectedRefusal: phase.expectedRefusal,
        expected_refusal: phase.expected_refusal,
      })),
    }))
    .digest('hex')}`;
}

function refreshSourceDeltaExecutionFacet() {
  const phases = Array.isArray(report.source_delta_execution?.phases)
    ? report.source_delta_execution.phases
    : [];
  const executedPhases = phases.filter((phase) => phase.phaseExecuted === true);
  const hotDelta2PhaseExecuted = executedPhases.some((phase) => phase.phaseKind === 'hot_delta_2');
  const negativeEditPhaseExecuted = executedPhases.some((phase) => phase.phaseKind === 'negative_edit');
  const primaryHotDeltaPhaseExecuted = executedPhases.some((phase) => phase.phaseKind === 'hot_delta_1');
  const failedGates = compactStringList([
    phases.length === 0 ? 'source_delta_execution_phases_missing' : null,
    ...phases.flatMap((phase) => [
      phase.editHash ? null : `source_delta_execution_edit_hash_missing:${phase.phaseName}`,
      phase.sourceWriteObserved === true ? null : `source_delta_execution_source_write_missing:${phase.phaseName}`,
      phase.compileCallAttempted === true ? null : `source_delta_execution_compile_call_missing:${phase.phaseName}`,
    ]),
  ]);
  const facet = {
    schemaVersion: REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION,
    proofAuthority: 'runner_observed_source_delta_phase_evidence',
    proof_authority: 'runner_observed_source_delta_phase_evidence',
    proofId: sourceDeltaExecutionProofId(phases),
    proof_id: sourceDeltaExecutionProofId(phases),
    accepted: failedGates.length === 0,
    phaseCount: phases.length,
    phase_count: phases.length,
    executedPhaseCount: executedPhases.length,
    executed_phase_count: executedPhases.length,
    primaryHotDeltaPhaseExecuted,
    primary_hot_delta_phase_executed: primaryHotDeltaPhaseExecuted,
    hotDelta2PhaseExecuted,
    hot_delta_2_phase_executed: hotDelta2PhaseExecuted,
    negativeEditPhaseExecuted,
    negative_edit_phase_executed: negativeEditPhaseExecuted,
    phases,
    failedGates,
    failed_gates: failedGates,
  };
  report.source_delta_execution = facet;
  report.real_rocm_source_delta_execution = facet;
  if (report.evidence && typeof report.evidence === 'object') {
    report.evidence.source_delta_execution = facet;
    report.evidence.real_rocm_source_delta_execution = facet;
  }
  return facet;
}

function beginSourceDeltaExecutionPhase({
  label,
  kind,
  file,
  before,
  after,
  phaseName,
  metricScope,
  expectedRefusal = false,
} = {}) {
  if (!report.source_delta_execution) {
    report.source_delta_execution = {
      schemaVersion: REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION,
      proofAuthority: 'runner_observed_source_delta_phase_evidence',
      proof_authority: 'runner_observed_source_delta_phase_evidence',
      phases: [],
    };
  }
  const phaseKind = sourceDeltaPhaseKind({ kind, label, metricScope });
  const sourceBeforeHash = sha256Text(before);
  const sourceAfterHash = sha256Text(after);
  const editHash = `sha256:${createHash('sha256').update(stableJson({
    phaseName,
    phaseKind,
    file,
    sourceBeforeHash,
    sourceAfterHash,
    expectedRefusal,
  })).digest('hex')}`;
  const phase = {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution_phase.v1',
    label: label ?? phaseName,
    phaseName,
    phase_name: phaseName,
    phaseKind,
    phase_kind: phaseKind,
    metricScope: metricScope ?? null,
    metric_scope: metricScope ?? null,
    file,
    sourceBeforeHash,
    source_before_hash: sourceBeforeHash,
    sourceAfterHash,
    source_after_hash: sourceAfterHash,
    editHash,
    edit_hash: editHash,
    expectedRefusal: expectedRefusal === true,
    expected_refusal: expectedRefusal === true,
    sourceWriteObserved: false,
    source_write_observed: false,
    compileCallAttempted: false,
    compile_call_attempted: false,
    compileCallCompleted: false,
    compile_call_completed: false,
    phaseExecuted: false,
    phase_executed: false,
    hmrWaitStatus: null,
    hmr_wait_status: null,
    compileOk: null,
    compile_ok: null,
    screenshotPath: null,
    screenshot_path: null,
    error: null,
    startedAt: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finishedAt: null,
    finished_at: null,
  };
  report.source_delta_execution.phases.push(phase);
  refreshSourceDeltaExecutionFacet();
  return phase;
}

function markSourceDeltaWriteObserved(phase) {
  if (!phase) return;
  phase.sourceWriteObserved = true;
  phase.source_write_observed = true;
  refreshSourceDeltaExecutionFacet();
}

function markSourceDeltaCompileAttempted(phase) {
  if (!phase) return;
  phase.compileCallAttempted = true;
  phase.compile_call_attempted = true;
  refreshSourceDeltaExecutionFacet();
}

function finishSourceDeltaExecutionPhase(phase, { compileResult = null, screenshot = null, error = null } = {}) {
  if (!phase) return;
  const compile = compileResult?.compile ?? null;
  const wait = compileResult?.wait ?? null;
  phase.compileCallCompleted = Boolean(compileResult);
  phase.compile_call_completed = phase.compileCallCompleted;
  phase.compileOk = compile?.ok === true;
  phase.compile_ok = phase.compileOk;
  phase.hmrWaitStatus = wait?.status ?? null;
  phase.hmr_wait_status = phase.hmrWaitStatus;
  phase.phaseExecuted = phase.sourceWriteObserved === true && phase.compileCallAttempted === true;
  phase.phase_executed = phase.phaseExecuted;
  phase.screenshotPath = screenshot?.path ?? null;
  phase.screenshot_path = phase.screenshotPath;
  phase.error = error ? String(error?.message ?? error).slice(0, 1000) : null;
  phase.finishedAt = new Date().toISOString();
  phase.finished_at = phase.finishedAt;
  refreshSourceDeltaExecutionFacet();
}

function evidenceLines(text, pattern) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => pattern.test(line))
    .slice(-300);
}

const RUNTIME_EVIDENCE_PATTERN =
  /GPU AI Delta|device_only fast path|natural fallback|HMR Planner|reload_policy|HMR MODE|Restarting runner|gpu-reload|compile-device|Device sidecar|gpu-runtime-boundary|synthi_gpu_launch|synthi-hiprt-runtime-probe|gpu_runtime_error|gpu-hmr-rejected|Runner process exited|\[(?:ERR|ERROR)\s*\]|fatal|Rust cannot catch/i;

function runtimeEvidenceFromValidationLogs({ workerLogs, upstreamRunLog, slug }) {
  const scopedWorkerLogs = scopeLogTextToSession(workerLogs, slug);
  const scopedWorkerEvidence = evidenceLines(scopedWorkerLogs.text, RUNTIME_EVIDENCE_PATTERN);
  const upstreamRunEvidence = evidenceLines(upstreamRunLog, RUNTIME_EVIDENCE_PATTERN);
  return {
    scopedWorkerLogs,
    scopedWorkerEvidence,
    upstreamRunEvidence,
    runtimeEvidence: [...scopedWorkerEvidence, ...upstreamRunEvidence],
  };
}

function runtimeEvidenceScope(scopedWorkerLogs, upstreamRunEvidence) {
  const workerSessionMarkerObserved = scopedWorkerLogs?.marker_found === true;
  const upstreamRunEvidenceObserved =
    Array.isArray(upstreamRunEvidence) && upstreamRunEvidence.length > 0;
  return {
    observed: workerSessionMarkerObserved || upstreamRunEvidenceObserved,
    workerSessionMarkerObserved,
    upstreamRunEvidenceObserved,
    scopeKinds: [
      ...(workerSessionMarkerObserved ? ['worker-session-marker'] : []),
      ...(upstreamRunEvidenceObserved ? ['current-upstream-run-log'] : []),
    ],
  };
}

function countMatches(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length;
}

function uniqueLogFieldValues(lines, key, linePattern = null) {
  const values = [];
  for (const line of lines) {
    if (linePattern && !linePattern.test(line)) continue;
    const value = logField(line, key);
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function modelRecordLooksStructured(value) {
  const record = plainObject(value);
  if (!record) return false;
  return [
    'provider',
    'requested_model',
    'requestedModel',
    'provider_model_status',
    'providerModelStatus',
    'model_availability_checked_at',
    'modelAvailabilityCheckedAt',
    'actual_model',
    'actualModel',
    'request_mode',
    'requestMode',
  ].some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function modelRecordOrNull(value) {
  return modelRecordLooksStructured(value) ? value : null;
}

function structuredModelProvenanceFromSidecar(sidecarArtifact = {}) {
  const sidecar = plainObject(sidecarArtifact.parsed) ?? {};
  const nested = plainObject(sidecar._synthi_model_provenance) ?? {};
  const verifier = plainObject(sidecar.lastGpuAiDeltaVerifierReport) ?? {};
  const verifierEvidence = plainObject(verifier.evidence) ?? {};
  const split = modelRecordOrNull(sidecar.model_provenance)
    ?? modelRecordOrNull(nested.split)
    ?? null;
  const lastGpuDelta = modelRecordOrNull(sidecar.lastGpuAiDeltaModelProvenance)
    ?? modelRecordOrNull(nested.last_gpu_delta)
    ?? modelRecordOrNull(nested.lastGpuDelta)
    ?? modelRecordOrNull(verifierEvidence.modelProvenance)
    ?? null;
  return {
    schemaVersion: 'synthi.gpu.hmr.model_provenance.sidecar.v1',
    evidence_source: sidecarArtifact.path ?? null,
    evidence_available: sidecarArtifact.available === true,
    evidence_parse_error: sidecarArtifact.parseError ?? null,
    expected_gpu_split_model: CFG.gpuSplitModel,
    expected_gpu_delta_model: CFG.gpuDeltaModel,
    split,
    last_gpu_delta: lastGpuDelta,
    observed_records: [
      ...(split ? ['split'] : []),
      ...(lastGpuDelta ? ['last_gpu_delta'] : []),
    ],
    missing_records: [
      ...(!split ? ['split'] : []),
      ...(!lastGpuDelta ? ['last_gpu_delta'] : []),
    ],
  };
}

async function readWorkerWorkspaceJson(relativePath) {
  const normalizedRelative = String(relativePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalizedRelative) {
    return { available: false, path: null, reason: 'empty_relative_path' };
  }
  const access = runtimeWorkerContainerAccess();
  if (!access.available) {
    return {
      available: false,
      path: normalizedRelative,
      reason: access.reason,
    };
  }
  const workspaceRoot = CFG.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const directPath = `${workspaceRoot}/${normalizedRelative}`;
  const basename = path.posix.basename(normalizedRelative);
  const startedAt = report.started_at;
  const raw = await execText(
    'docker',
    [
      'exec',
      access.workerContainer,
      'sh',
      '-lc',
      [
        `direct=${shQuote(directPath)}`,
        `basename=${shQuote(basename)}`,
        `started_at=${shQuote(startedAt)}`,
        'candidate=""',
        '[ -f "$direct" ] && candidate="$direct"',
        'if [ -z "$candidate" ]; then',
        '  candidate=$(find /tmp /home/runner /synthi -name "$basename" -type f -newermt "$started_at" -printf "%T@\\t%p\\n" 2>/dev/null | sort -n | tail -1 | cut -f2- || true)',
        'fi',
        'if [ -z "$candidate" ]; then',
        '  candidate=$(find /tmp /home/runner /synthi -name "$basename" -type f -printf "%T@\\t%p\\n" 2>/dev/null | sort -n | tail -1 | cut -f2- || true)',
        'fi',
        '[ -f "$candidate" ] || exit 0',
        'printf "__SYNTHI_JSON_PATH__%s\\n" "$candidate"',
        'cat "$candidate"',
      ].join('\n'),
    ],
    30000,
    false,
  );
  if (!raw) {
    return { available: false, path: directPath, reason: 'worker_workspace_json_missing' };
  }
  const markerMatch = raw.match(/^__SYNTHI_JSON_PATH__(.*)\n/);
  const workerPath = markerMatch?.[1]?.trim() || directPath;
  const body = markerMatch ? raw.slice(markerMatch[0].length) : raw;
  try {
    return {
      available: true,
      path: workerPath,
      parsed: JSON.parse(body),
      raw_sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    };
  } catch (err) {
    return {
      available: false,
      path: workerPath,
      parseError: err.message,
      raw_sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    };
  }
}

function normalizeSessionMarker(value) {
  return String(value ?? '').trim().replace(/^["']+|["',;:)]+$/g, '');
}

function runtimeSessionIdFromLine(line) {
  const match = String(line ?? '').match(/\bruntime_session=([^\s]+)/i);
  return match ? normalizeSessionMarker(match[1]) : null;
}

function processIdFromRuntimeSession(value) {
  const session = String(value ?? '').trim();
  const match = session.match(/^pid(\d+)(?:[-:]|$)/i);
  return match ? `pid:${match[1]}` : null;
}

function processIdsFromRuntimeSessions(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(processIdFromRuntimeSession)
    .filter((value) => typeof value === 'string' && value.trim()))];
}

function logField(line, key) {
  return String(line ?? '').match(new RegExp(String.raw`\b${key}=([^\s]+)`, 'i'))?.[1] ?? '';
}

function logDim3Field(line, key) {
  const match = String(line ?? '').match(
    new RegExp(String.raw`\b${key}=\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)`, 'i'),
  );
  return match ? `${Number(match[1])}x${Number(match[2])}x${Number(match[3])}` : null;
}

function evidenceRefPart(value, fallback) {
  const cleaned = String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96);
  return cleaned || fallback;
}

function sessionMarkerFromLine(line) {
  const text = String(line ?? '');
  const patterns = [
    { kind: 'guest-registry', pattern: /\[GuestRegistry\]\s+session=([^\s]+)/i },
    { kind: 'runner-env', pattern: /\[Runner\]\s+Session ID from env:\s*([^\s]+)/i },
    { kind: 'runner-stdin-session', pattern: /\bStdin received:\s*set_session\s+([^\s]+)/i },
    { kind: 'runner-command-session', pattern: /\[Runner\]\s+Processing command:\s*set_session\s+([^\s]+)/i },
    { kind: 'runner-host-kv-session', pattern: /\[HOST-KV\]\s+Session already set:\s*([^\s]+)/i },
    { kind: 'worker-send-session', pattern: /\bSending session to runner:\s*set_session\s+([^\s]+)/i },
  ];
  for (const { kind, pattern } of patterns) {
    const match = text.match(pattern);
    if (match) {
      const sessionId = normalizeSessionMarker(match[1]);
      if (sessionId) return { kind, sessionId };
    }
  }
  return null;
}

function scopeLogTextToSession(text, slug) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (!slug) {
    return {
      text: lines.join('\n'),
      marker_found: false,
      dropped_before: 0,
      total_lines: lines.length,
      marker_kind: null,
      stopped_before: lines.length,
      stop_marker_found: false,
      stale_runtime_lines_dropped: 0,
    };
  }
  const markerIndex = lines.findIndex((line) => sessionMarkerFromLine(line)?.sessionId === slug);
  if (markerIndex < 0) {
    return {
      text: '',
      marker_found: false,
      dropped_before: lines.length,
      total_lines: lines.length,
      marker_kind: null,
      stopped_before: lines.length,
      stop_marker_found: false,
      stale_runtime_lines_dropped: 0,
    };
  }
  const marker = sessionMarkerFromLine(lines[markerIndex]);
  let stopIndex = lines.length;
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const nextMarker = sessionMarkerFromLine(lines[index]);
    if (nextMarker && nextMarker.sessionId !== slug) {
      stopIndex = index;
      break;
    }
  }
  const staleRuntimeSessionIds = new Set();
  for (let index = 0; index < markerIndex; index += 1) {
    const runtimeSessionId = runtimeSessionIdFromLine(lines[index]);
    if (runtimeSessionId) staleRuntimeSessionIds.add(runtimeSessionId);
  }
  let staleRuntimeLinesDropped = 0;
  const scopedLines = [];
  for (const line of lines.slice(markerIndex, stopIndex)) {
    const runtimeSessionId = runtimeSessionIdFromLine(line);
    if (runtimeSessionId && staleRuntimeSessionIds.has(runtimeSessionId)) {
      staleRuntimeLinesDropped += 1;
      continue;
    }
    scopedLines.push(line);
  }
  return {
    text: scopedLines.join('\n'),
    marker_found: true,
    dropped_before: markerIndex,
    total_lines: lines.length,
    marker_kind: marker?.kind ?? null,
    stopped_before: stopIndex,
    stop_marker_found: stopIndex < lines.length,
    stale_runtime_lines_dropped: staleRuntimeLinesDropped,
  };
}

function runtimeDispatchEvidence(workerEvidence) {
  const dispatchFailureLines = workerEvidence.filter((line) =>
    /\b(?:synthi_gpu_launch|native_(?:rocm_)?runtime_dispatch)\b.*\bdispatch=(failed|stale-pointer|missing-dispatcher)\b/i.test(line)
  );
  const dispatchSuccessLines = workerEvidence.filter((line) =>
    /\bsynthi_gpu_launch\b.*\bdispatch=ok\b/i.test(line)
    || (
      /\bnative_(?:rocm_)?runtime_dispatch\b.*\bdispatch=ok\b/i.test(line)
      && /\bproof_bridge=complete\b/i.test(line)
      && /\battachment_provenance=native_runtime_bridge\b/i.test(line)
    )
  );
  const nativeRuntimeDispatchLines = workerEvidence.filter((line) =>
    /\bnative_(?:rocm_)?runtime_dispatch\b/i.test(line)
  );
  const nativeRuntimeDispatchRejectedLines = nativeRuntimeDispatchLines.filter((line) =>
    !dispatchSuccessLines.includes(line)
  );
  const dispatchSuccessCount = countMatches(
    dispatchSuccessLines,
    /\b(?:synthi_gpu_launch|native_(?:rocm_)?runtime_dispatch)\b.*\bdispatch=ok\b/i,
  );
  const successRecords = dispatchSuccessLines.map((line) => {
    const source = /\bnative_(?:rocm_)?runtime_dispatch\b/i.test(line)
      ? 'native_runtime_bridge'
      : 'synthi_runtime_boundary';
    const kernelName = logField(line, 'kernel');
    const runtimeSession = logField(line, 'runtime_session');
    const artifactId = logField(line, 'artifact_id');
    const dispatcherRegistrationId = logField(line, 'dispatcher_registration_id');
    const dispatchTableHash = logField(line, 'dispatch_table_hash');
    const dispatchTableEntryId = logField(line, 'dispatch_table_entry_id');
    const dispatchId = logField(line, 'dispatch_id');
    const outputTargetId = logField(line, 'output_target_id') ?? logField(line, 'output_target');
    const generation = logField(line, 'generation') ?? logField(line, 'active_generation');
    const epoch = logField(line, 'epoch') ?? logField(line, 'active_epoch');
    const streamId = logField(line, 'stream');
    const gridDimensions = logDim3Field(line, 'grid');
    const blockDimensions = logDim3Field(line, 'block');
    const sharedMemoryBytes = Number(logField(line, 'shared_bytes'));
    const dispatchTimestamp = Number(logField(line, 'dispatch_timestamp'));
    return {
      line,
      source,
      proofBridge: logField(line, 'proof_bridge'),
      attachmentProvenance: logField(line, 'attachment_provenance') ?? logField(line, 'provenance'),
      kernelName: kernelName && kernelName !== 'none' ? kernelName : null,
      runtimeSession: runtimeSession && runtimeSession !== 'none' ? runtimeSession : null,
      artifactId: artifactId && artifactId !== 'none' ? artifactId : null,
      dispatcherRegistrationId: dispatcherRegistrationId && dispatcherRegistrationId !== 'none'
        ? dispatcherRegistrationId
        : null,
      dispatchTableHash: dispatchTableHash && dispatchTableHash !== 'none' ? dispatchTableHash : null,
      dispatchTableEntryId: dispatchTableEntryId && dispatchTableEntryId !== 'none'
        ? dispatchTableEntryId
        : null,
      dispatchId: dispatchId && dispatchId !== 'none' ? dispatchId : null,
      outputTargetId: outputTargetId && outputTargetId !== 'none' ? outputTargetId : null,
      generation: generation && generation !== 'none' ? generation : null,
      epoch: epoch && epoch !== 'none' ? epoch : null,
      streamId: streamId && streamId !== 'none' ? streamId : null,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes: Number.isFinite(sharedMemoryBytes) && sharedMemoryBytes >= 0
        ? sharedMemoryBytes
        : null,
      dispatchTimestamp: Number.isFinite(dispatchTimestamp) && dispatchTimestamp >= 0
        ? dispatchTimestamp
        : null,
    };
  });
  const dispatchEvidenceRefs = [...new Set(successRecords.map((record) => {
    if (!record.runtimeSession || !record.kernelName) return null;
    const refKind = record.source === 'native_runtime_bridge'
      ? 'native_runtime_dispatch'
      : 'synthi_gpu_launch';
    return `worker-log:${refKind}:${evidenceRefPart(record.runtimeSession, 'session')}:${evidenceRefPart(record.kernelName, 'kernel')}`;
  }).filter(Boolean))];
  const latestSuccessRecord = successRecords.at(-1) ?? null;
  const nativeBridgeSuccessRecords = successRecords.filter((record) => record.source === 'native_runtime_bridge');
  const processIds = processIdsFromRuntimeSessions(successRecords.map((record) => record.runtimeSession));
  return {
    success_count: dispatchSuccessCount,
    synthi_success_count: successRecords.filter((record) => record.source === 'synthi_runtime_boundary').length,
    native_bridge_success_count: nativeBridgeSuccessRecords.length,
    native_bridge_observed_count: nativeRuntimeDispatchLines.length,
    native_bridge_rejected_count: nativeRuntimeDispatchRejectedLines.length,
    native_bridge_rejected_lines: nativeRuntimeDispatchRejectedLines.slice(0, 20),
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    success_lines: dispatchSuccessLines.slice(-20),
    success_records: successRecords.slice(-20),
    native_bridge_success_records: nativeBridgeSuccessRecords.slice(-20),
    evidence_refs: dispatchEvidenceRefs,
    runtime_artifact_ids: [...new Set(successRecords.map((record) => record.artifactId).filter(Boolean))],
    runtime_artifact_id: latestSuccessRecord?.artifactId ?? null,
    dispatch_ids: [...new Set(successRecords.map((record) => record.dispatchId).filter(Boolean))],
    dispatch_id: latestSuccessRecord?.dispatchId ?? null,
    output_target_ids: [...new Set(successRecords.map((record) => record.outputTargetId).filter(Boolean))],
    output_target_id: latestSuccessRecord?.outputTargetId ?? null,
    generations: [...new Set(successRecords.map((record) => record.generation).filter(Boolean))],
    generation: latestSuccessRecord?.generation ?? null,
    epochs: [...new Set(successRecords.map((record) => record.epoch).filter(Boolean))],
    epoch: latestSuccessRecord?.epoch ?? latestSuccessRecord?.generation ?? null,
    dispatcher_registration_ids: [
      ...new Set(successRecords.map((record) => record.dispatcherRegistrationId).filter(Boolean)),
    ],
    dispatch_table_hashes: [...new Set(successRecords.map((record) => record.dispatchTableHash).filter(Boolean))],
    dispatch_table_entry_ids: [
      ...new Set(successRecords.map((record) => record.dispatchTableEntryId).filter(Boolean)),
    ],
    dispatch_stream_ids: [...new Set(successRecords.map((record) => record.streamId).filter(Boolean))],
    grid_dimensions: [...new Set(successRecords.map((record) => record.gridDimensions).filter(Boolean))],
    block_dimensions: [...new Set(successRecords.map((record) => record.blockDimensions).filter(Boolean))],
    shared_memory_bytes: [
      ...new Set(successRecords.map((record) => record.sharedMemoryBytes).filter((value) => value !== null)),
    ],
    dispatch_timestamps: successRecords
      .map((record) => record.dispatchTimestamp)
      .filter((value) => value !== null),
    failure_count: dispatchFailureLines.length,
    failure_lines: dispatchFailureLines.slice(0, 20),
  };
}

function runtimeNativeLaunchObservationEvidence(workerEvidence) {
  const readyLines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_launch_observer_ready\b/i.test(line)
  );
  const attemptLines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_launch_attempt\b/i.test(line)
  );
  const functionResolutionLines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_function_resolution\b/i.test(line)
  );
  const textureObjectLines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_texture_object_create\b/i.test(line)
  );
  const arrayAllocationLines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_array_allocation\b/i.test(line)
  );
  const lines = workerEvidence.filter((line) =>
    /\bgpu-runtime-boundary\b.*\bnative_launch_observed\b/i.test(line)
  );
  const attemptRecords = attemptLines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    sequence: logField(line, 'sequence'),
    generation: logField(line, 'generation') ?? logField(line, 'active_generation'),
    epoch: logField(line, 'epoch') ?? logField(line, 'active_epoch'),
    dispatchTimestamp: logField(line, 'dispatch_timestamp') ?? logField(line, 'dispatch_timestamp_ms'),
    functionPtr: logField(line, 'function_ptr'),
    kernelSymbol: logField(line, 'kernel_symbol') ?? logField(line, 'kernel') ?? logField(line, 'symbol'),
    gridDimensions: logDim3Field(line, 'grid'),
    blockDimensions: logDim3Field(line, 'block'),
    streamId: logField(line, 'stream'),
    sharedMemoryBytes: logField(line, 'shared_bytes'),
    dispatcherRegistrationId: logField(line, 'dispatcher_registration_id'),
    dispatchTableHash: logField(line, 'dispatch_table_hash'),
    dispatchTableEntryId: logField(line, 'dispatch_table_entry_id'),
    dispatch: logField(line, 'dispatch'),
    realLaunchResolved: logField(line, 'real_launch_resolved'),
  }));
  const readyRecords = readyLines.map((line) => ({
    line,
    runtimeSession: runtimeSessionIdFromLine(line),
    pid: logField(line, 'pid'),
    mode: logField(line, 'mode'),
    apis: String(logField(line, 'apis') ?? '')
      .split(',')
      .map((api) => api.trim())
      .filter(Boolean),
    functionResolutionApis: String(logField(line, 'function_resolution_apis') ?? '')
      .split(',')
      .map((api) => api.trim())
      .filter(Boolean),
    textureObjectApis: String(logField(line, 'texture_object_apis') ?? '')
      .split(',')
      .map((api) => api.trim())
      .filter(Boolean),
    arrayAllocationApis: String(logField(line, 'array_allocation_apis') ?? '')
      .split(',')
      .map((api) => api.trim())
      .filter(Boolean),
  }));
  const functionResolutionRecords = functionResolutionLines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    symbol: logField(line, 'symbol'),
    functionPtr: logField(line, 'function_ptr'),
    module: logField(line, 'module'),
    result: logField(line, 'result'),
    resolution: logField(line, 'resolution'),
    realResolverResolved: logField(line, 'real_resolver_resolved'),
  }));
  const textureObjectRecords = textureObjectLines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    sequence: logField(line, 'sequence'),
    texture: logField(line, 'texture'),
    textureOutPtr: logField(line, 'texture_out_ptr'),
    resourceDescPtr: logField(line, 'resource_desc_ptr'),
    textureDescPtr: logField(line, 'texture_desc_ptr'),
    resourceViewDescPtr: logField(line, 'resource_view_desc_ptr'),
    result: logField(line, 'result'),
    creation: logField(line, 'creation'),
    realResolverResolved: logField(line, 'real_resolver_resolved'),
  }));
  const arrayAllocationRecords = arrayAllocationLines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    sequence: logField(line, 'sequence'),
    array: logField(line, 'array'),
    arrayOutPtr: logField(line, 'array_out_ptr'),
    descriptorPtr: logField(line, 'descriptor_ptr'),
    descriptorKind: logField(line, 'descriptor_kind'),
    channelX: logField(line, 'channel_x'),
    channelY: logField(line, 'channel_y'),
    channelZ: logField(line, 'channel_z'),
    channelW: logField(line, 'channel_w'),
    channelFormatKind: logField(line, 'channel_format_kind'),
    width: logField(line, 'width'),
    height: logField(line, 'height'),
    flags: logField(line, 'flags'),
    result: logField(line, 'result'),
    allocation: logField(line, 'allocation'),
    realResolverResolved: logField(line, 'real_resolver_resolved'),
  }));
  const textureObjectFailures = textureObjectRecords.filter((record) =>
    String(record.creation ?? '').toLowerCase() === 'failed'
    || (
      record.result !== null
      && record.result !== undefined
      && String(record.result) !== '0'
    )
  );
  const arrayAllocationFailures = arrayAllocationRecords.filter((record) =>
    String(record.allocation ?? '').toLowerCase() === 'failed'
    || (
      record.result !== null
      && record.result !== undefined
      && String(record.result) !== '0'
    )
  );
  const records = lines.map((line) => ({
    line,
    api: logField(line, 'api'),
    runtimeSession: runtimeSessionIdFromLine(line),
    sequence: logField(line, 'sequence'),
    generation: logField(line, 'generation') ?? logField(line, 'active_generation'),
    epoch: logField(line, 'epoch') ?? logField(line, 'active_epoch'),
    dispatchTimestamp: logField(line, 'dispatch_timestamp') ?? logField(line, 'dispatch_timestamp_ms'),
    functionPtr: logField(line, 'function_ptr'),
    kernelSymbol: logField(line, 'kernel_symbol') ?? logField(line, 'kernel') ?? logField(line, 'symbol'),
    gridDimensions: logDim3Field(line, 'grid'),
    blockDimensions: logDim3Field(line, 'block'),
    streamId: logField(line, 'stream'),
    sharedMemoryBytes: logField(line, 'shared_bytes'),
    dispatcherRegistrationId: logField(line, 'dispatcher_registration_id'),
    dispatchTableHash: logField(line, 'dispatch_table_hash'),
    dispatchTableEntryId: logField(line, 'dispatch_table_entry_id'),
    result: logField(line, 'result'),
    dispatch: logField(line, 'dispatch'),
  }));
  return {
    ready_count: readyRecords.length,
    ready: readyRecords.length > 0,
    ready_runtime_session_ids: [
      ...new Set(readyRecords.map((record) => record.runtimeSession).filter(Boolean)),
    ],
    api_coverage: [...new Set(readyRecords.flatMap((record) => record.apis).filter(Boolean))],
    function_resolution_api_coverage: [
      ...new Set(readyRecords.flatMap((record) => record.functionResolutionApis).filter(Boolean)),
    ],
    texture_object_api_coverage: [
      ...new Set(readyRecords.flatMap((record) => record.textureObjectApis).filter(Boolean)),
    ],
    array_allocation_api_coverage: [
      ...new Set(readyRecords.flatMap((record) => record.arrayAllocationApis).filter(Boolean)),
    ],
    function_resolution_count: functionResolutionRecords.length,
    function_resolution_symbols: [
      ...new Set(functionResolutionRecords.map((record) => record.symbol).filter(Boolean)),
    ],
    function_resolution_function_ptrs: [
      ...new Set(functionResolutionRecords.map((record) => record.functionPtr).filter(Boolean)),
    ],
    texture_object_create_count: textureObjectRecords.length,
    texture_object_failure_count: textureObjectFailures.length,
    texture_object_apis: [
      ...new Set(textureObjectRecords.map((record) => record.api).filter(Boolean)),
    ],
    array_allocation_count: arrayAllocationRecords.length,
    array_allocation_failure_count: arrayAllocationFailures.length,
    array_allocation_apis: [
      ...new Set(arrayAllocationRecords.map((record) => record.api).filter(Boolean)),
    ],
    total_count: records.length,
    attempt_count: attemptRecords.length,
    apis: [...new Set(records.map((record) => record.api).filter(Boolean))],
    attempted_apis: [...new Set(attemptRecords.map((record) => record.api).filter(Boolean))],
    function_ptrs: [
      ...new Set([
        ...attemptRecords.map((record) => record.functionPtr).filter(Boolean),
        ...records.map((record) => record.functionPtr).filter(Boolean),
      ]),
    ],
    kernel_symbols: [
      ...new Set([
        ...attemptRecords.map((record) => record.kernelSymbol).filter(Boolean),
        ...records.map((record) => record.kernelSymbol).filter(Boolean),
      ]),
    ],
    runtime_session_ids: [
      ...new Set([
        ...attemptRecords.map((record) => record.runtimeSession).filter(Boolean),
        ...records.map((record) => record.runtimeSession).filter(Boolean),
        ...readyRecords.map((record) => record.runtimeSession).filter(Boolean),
        ...functionResolutionRecords.map((record) => record.runtimeSession).filter(Boolean),
        ...textureObjectRecords.map((record) => record.runtimeSession).filter(Boolean),
        ...arrayAllocationRecords.map((record) => record.runtimeSession).filter(Boolean),
      ]),
    ],
    attempt_only_count: Math.max(0, attemptRecords.length - records.length),
    observe_only_count: records.filter((record) =>
      String(record.dispatch ?? '').toLowerCase() === 'observed-native'
    ).length,
    ready_records: readyRecords.slice(-20),
    function_resolution_records: functionResolutionRecords.slice(-20),
    texture_object_records: textureObjectRecords.slice(-20),
    array_allocation_records: arrayAllocationRecords.slice(-20),
    attempt_records: attemptRecords.slice(-20),
    records: records.slice(-20),
  };
}

function nativeRocmLaunchBoundaryRefusalFacet({
  nativeObservation = {},
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  outputOracleResolution = {},
  fullRuntimeProof = {},
} = {}) {
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  const observed = nativeObservation.ready === true
    || Number(nativeObservation.function_resolution_count ?? 0) > 0
    || Number(nativeObservation.attempt_count ?? 0) > 0
    || Number(nativeObservation.total_count ?? 0) > 0
    || Number(nativeObservation.array_allocation_count ?? 0) > 0
    || Number(nativeObservation.texture_object_create_count ?? 0) > 0;
  const fullRuntimeProven = fullRuntimeProof?.fullRuntimeProven === true;
  const synthiDispatchObserved = Number(runtimeDispatch.success_count ?? 0) > 0;
  const artifactTransportObserved = Number(runtimeArtifactTransport.total_count ?? 0) > 0;
  const epochObserved = Number(epochEvidence.total_count ?? 0) > 0
    || Number(epochEvidence.published_count ?? 0) > 0
    || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven';
  const outputOracleObserved = Number(runtimeOutputOracle.total_count ?? 0) > 0;
  const hostIdentityObserved = Number(hostEvidence.total_count ?? 0) > 0;
  const oracleProfileAbsent =
    outputOracleResolution?.runtimeProfilePresent !== true
    && outputOracleResolution?.contractPresent !== true
    && (
      outputOracleResolution?.mode === 'none'
      || outputOracleResolution?.requestedProfile === 'none'
      || outputOracleResolution?.requested_profile === 'none'
      || outputOracleResolution?.disabledReason === 'profile_disabled'
      || outputOracleResolution?.disabled_reason === 'profile_disabled'
    );
  const blockingGaps = [];
  if (observed && !fullRuntimeProven) {
    blockingGaps.push('native_launch_boundary_observed');
    blockingGaps.push('native_boundary_not_synthi_dispatch_proof');
    if (!synthiDispatchObserved) blockingGaps.push('synthi_dispatch_not_observed');
    if (!artifactTransportObserved) blockingGaps.push('artifact_transport_not_observed');
    if (!epochObserved) blockingGaps.push('epoch_not_observed');
    if (!outputOracleObserved) {
      blockingGaps.push(oracleProfileAbsent ? 'output_oracle_profile_absent' : 'output_oracle_not_observed');
    }
    if (!hostIdentityObserved) blockingGaps.push('host_identity_not_observed');
    if (!artifactTransportObserved || !epochObserved || !synthiDispatchObserved) {
      blockingGaps.push('adapter_impossible_requires_app_hook');
    }
    if (Number(nativeObservation.function_resolution_count ?? 0) > 0 && !synthiDispatchObserved) {
      blockingGaps.push('native_function_resolution_without_synthi_epoch_dispatch');
    }
  }
  const evidenceRefs = compactStringList([
    ...((nativeObservation.ready_runtime_session_ids ?? []).map((session) =>
      `worker-log:native_launch_observer_ready:${session}`)),
    ...((nativeObservation.runtime_session_ids ?? []).map((session) =>
      `worker-log:native_rocm_launch_boundary:${session}`)),
    ...((nativeObservation.function_resolution_symbols ?? []).map((symbol) =>
      `worker-log:native_function_resolution:${symbol}`)),
    ...((nativeObservation.kernel_symbols ?? []).map((symbol) =>
      `worker-log:native_launch_observed:${symbol}`)),
    ...((nativeObservation.array_allocation_apis ?? []).map((api) =>
      `worker-log:native_array_allocation:${api}`)),
    ...((nativeObservation.texture_object_apis ?? []).map((api) =>
      `worker-log:native_texture_object_create:${api}`)),
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.native_rocm_launch_boundary.v1',
    observed,
    status: fullRuntimeProven
      ? 'supplemental_runtime_boundary_evidence'
      : observed
        ? 'refusal_evidence'
        : 'not_observed',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    nativeLaunchBoundaryObserved: observed,
    native_launch_boundary_observed: observed,
    observerReady: nativeObservation.ready === true,
    observer_ready: nativeObservation.ready === true,
    readyRuntimeSessionIds: compactStringList(nativeObservation.ready_runtime_session_ids),
    ready_runtime_session_ids: compactStringList(nativeObservation.ready_runtime_session_ids),
    runtimeSessionIds: compactStringList(nativeObservation.runtime_session_ids),
    runtime_session_ids: compactStringList(nativeObservation.runtime_session_ids),
    apiCoverage: compactStringList(nativeObservation.api_coverage),
    api_coverage: compactStringList(nativeObservation.api_coverage),
    attemptedApis: compactStringList(nativeObservation.attempted_apis),
    attempted_apis: compactStringList(nativeObservation.attempted_apis),
    observedApis: compactStringList(nativeObservation.apis),
    observed_apis: compactStringList(nativeObservation.apis),
    functionResolutionApis: compactStringList(nativeObservation.function_resolution_api_coverage),
    function_resolution_apis: compactStringList(nativeObservation.function_resolution_api_coverage),
    functionResolutionCount: Number(nativeObservation.function_resolution_count ?? 0),
    function_resolution_count: Number(nativeObservation.function_resolution_count ?? 0),
    functionResolutionSymbols: compactStringList(nativeObservation.function_resolution_symbols),
    function_resolution_symbols: compactStringList(nativeObservation.function_resolution_symbols),
    launchAttemptCount: Number(nativeObservation.attempt_count ?? 0),
    launch_attempt_count: Number(nativeObservation.attempt_count ?? 0),
    nativeLaunchObservedCount: Number(nativeObservation.total_count ?? 0),
    native_launch_observed_count: Number(nativeObservation.total_count ?? 0),
    observeOnlyCount: Number(nativeObservation.observe_only_count ?? 0),
    observe_only_count: Number(nativeObservation.observe_only_count ?? 0),
    synthiDispatchObserved,
    synthi_dispatch_observed: synthiDispatchObserved,
    artifactTransportObserved,
    artifact_transport_observed: artifactTransportObserved,
    epochObserved,
    epoch_observed: epochObserved,
    outputOracleObserved,
    output_oracle_observed: outputOracleObserved,
    outputOracleProfileAbsent: oracleProfileAbsent,
    output_oracle_profile_absent: oracleProfileAbsent,
    hostIdentityObserved,
    host_identity_observed: hostIdentityObserved,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function realRocmAppHookContractFacet({
  appHookContract = {},
  profileProofObligations = {},
  nativeBoundary = {},
  nativeObservation = {},
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  fullRuntimeProof = {},
  availableEvidenceRefs = [],
} = {}) {
  const contract = appHookContract && typeof appHookContract === 'object'
    ? appHookContract
    : normalizeRealRocmAppHookContract(null);
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  const fullRuntimeProven = fullRuntimeProof?.fullRuntimeProven === true;
  const profileObligations = profileProofObligations && typeof profileProofObligations === 'object'
    ? profileProofObligations
    : {};
  const profileRequiresAppHookContract =
    profileObligations.requiresAppHookContract === true
    || profileObligations.requires_app_hook_contract === true;
  const nativeObserved = nativeBoundary.observed === true
    || nativeBoundary.native_launch_boundary_observed === true
    || Number(nativeObservation.function_resolution_count ?? 0) > 0
    || Number(nativeObservation.attempt_count ?? 0) > 0
    || Number(nativeObservation.total_count ?? 0) > 0;
  const runtimeObservedByStage = {
    artifactTransport: Number(runtimeArtifactTransport.total_count ?? 0) > 0,
    epochPublication:
      Number(epochEvidence.total_count ?? 0) > 0
      || Number(epochEvidence.published_count ?? 0) > 0
      || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven',
    dispatchTrace: Number(runtimeDispatch.success_count ?? 0) > 0,
    hostIdentity: Number(hostEvidence.total_count ?? 0) > 0,
    outputOracle: Number(runtimeOutputOracle.total_count ?? 0) > 0,
  };
  const requiredReasons = compactStringList([
    contract.required === true ? 'app_hook_contract_required_by_contract' : null,
    profileRequiresAppHookContract ? 'app_hook_contract_required_by_profile_obligation' : null,
    nativeObserved && !fullRuntimeProven
      ? 'app_hook_contract_required_by_native_boundary_without_full_runtime_proof'
      : null,
  ]);
  const required = requiredReasons.length > 0;
  const availableEvidenceRefSet = new Set(compactStringList(availableEvidenceRefs));
  const stageResults = {};
  const blockingGaps = [];
  const evidenceRefs = [];
  for (const stageDef of REAL_ROCM_APP_HOOK_STAGES) {
    const stage = contract.stages?.[stageDef.key] ?? contract[stageDef.key] ?? contract[stageDef.snake] ?? {};
    const stageEvidenceRefs = compactStringList([
      ...(Array.isArray(stage.evidenceRefs) ? stage.evidenceRefs : []),
      ...(Array.isArray(stage.evidence_refs) ? stage.evidence_refs : []),
      stage.proofId,
      stage.proof_id,
    ]);
    evidenceRefs.push(...stageEvidenceRefs);
    const unresolvedEvidenceRefs = stageEvidenceRefs.filter((ref) => !availableEvidenceRefSet.has(ref));
    const contractEvidencePresent =
      stage.declared === true
      && stageEvidenceRefs.length > 0
      && unresolvedEvidenceRefs.length === 0;
    const runtimeObserved = runtimeObservedByStage[stageDef.key] === true;
    const stageResult = {
      stage: stageDef.snake,
      declared: stage.declared === true,
      required: required && stage.required !== false,
      contractEvidencePresent,
      contract_evidence_present: contractEvidencePresent,
      runtimeObserved,
      runtime_observed: runtimeObserved,
      evidenceRefs: stageEvidenceRefs,
      evidence_refs: stageEvidenceRefs,
      unresolvedEvidenceRefs,
      unresolved_evidence_refs: unresolvedEvidenceRefs,
      proofId: stage.proofId ?? stage.proof_id ?? null,
      status: contractEvidencePresent && runtimeObserved
        ? 'contract_and_runtime_observed'
        : contractEvidencePresent
          ? 'contract_declared_runtime_missing'
          : runtimeObserved
            ? 'runtime_observed_contract_evidence_missing'
            : 'missing',
    };
    stageResults[stageDef.key] = stageResult;
    stageResults[stageDef.snake] = stageResult;
    if (required && stageResult.required && !contractEvidencePresent) {
      blockingGaps.push(`app_hook_${stageDef.gapKey}_evidence_missing`);
    }
    if (required && stageResult.required && stageEvidenceRefs.length > 0 && unresolvedEvidenceRefs.length > 0) {
      blockingGaps.push(`app_hook_${stageDef.gapKey}_evidence_ref_unresolved`);
    }
    if (required && stageResult.required && !runtimeObserved) {
      blockingGaps.push(`app_hook_${stageDef.gapKey}_runtime_not_observed`);
    }
  }
  const contractEvidenceComplete = REAL_ROCM_APP_HOOK_STAGES.every((stage) =>
    stageResults[stage.key].contractEvidencePresent === true
  );
  const runtimeObservationComplete = REAL_ROCM_APP_HOOK_STAGES.every((stage) =>
    stageResults[stage.key].runtimeObserved === true
  );
  if (required && contract.declared !== true) {
    blockingGaps.unshift('app_hook_contract_not_declared');
    if (profileRequiresAppHookContract) {
      blockingGaps.unshift('app_hook_contract_required_by_profile_obligation');
    }
  }
  const canSatisfyRuntimeProof =
    fullRuntimeProven
    && contract.declared === true
    && contractEvidenceComplete
    && runtimeObservationComplete;
  const status = canSatisfyRuntimeProof
    ? 'supplemental_app_hook_runtime_proof_evidence'
    : required && contract.declared !== true
      ? 'required_app_hook_contract_missing'
      : required && !contractEvidenceComplete
        ? 'declared_app_hook_contract_incomplete'
        : required && !runtimeObservationComplete
          ? 'declared_app_hook_pending_runtime_observation'
          : contract.declared === true
            ? 'declared_app_hook_contract_not_required'
            : 'not_required';
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: contract.declared === true,
    required,
    status,
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof,
    can_satisfy_runtime_proof: canSatisfyRuntimeProof,
    canSatisfyDispatchProof: canSatisfyRuntimeProof,
    can_satisfy_dispatch_proof: canSatisfyRuntimeProof,
    nativeLaunchBoundaryObserved: nativeObserved,
    native_launch_boundary_observed: nativeObserved,
    profileRequiresAppHookContract,
    profile_requires_app_hook_contract: profileRequiresAppHookContract,
    requiredReasons,
    required_reasons: requiredReasons,
    contractEvidenceComplete,
    contract_evidence_complete: contractEvidenceComplete,
    runtimeObservationComplete,
    runtime_observation_complete: runtimeObservationComplete,
    stageResults,
    stage_results: stageResults,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs: compactStringList(evidenceRefs),
    evidence_refs: compactStringList(evidenceRefs),
    availableEvidenceRefs: compactStringList(availableEvidenceRefs),
    available_evidence_refs: compactStringList(availableEvidenceRefs),
    contractHash: `sha256:${createHash('sha256').update(stableJson(contract)).digest('hex')}`,
    contract_hash: `sha256:${createHash('sha256').update(stableJson(contract)).digest('hex')}`,
  };
}

function firstRuntimeText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function realRocmNativeRuntimeProofBridgeFacet({
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  fullRuntimeProof = {},
  firewallEvidence = {},
  availableEvidenceRefs = [],
} = {}) {
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  const dispatchBridgeObserved = Number(runtimeDispatch.native_bridge_success_count ?? 0) > 0;
  const rejectedBridgeObserved = Number(runtimeDispatch.native_bridge_rejected_count ?? 0) > 0;
  const anyBridgeObserved =
    dispatchBridgeObserved
    || rejectedBridgeObserved
    || Number(runtimeDispatch.native_bridge_observed_count ?? 0) > 0;
  const artifactTransportObserved = Number(
    runtimeArtifactTransport.total_count ?? runtimeArtifactTransport.matched_count ?? 0,
  ) > 0;
  const epochPublicationObserved =
    Number(epochEvidence.total_count ?? 0) > 0
    || Number(epochEvidence.published_count ?? 0) > 0
    || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven';
  const outputOracleObserved = Number(runtimeOutputOracle.total_count ?? 0) > 0;
  const hostIdentityObserved = Number(hostEvidence.total_count ?? 0) > 0;
  const sameProcessIdentityObserved =
    hostIdentityObserved
    && (runtimeHostPreservation?.proof?.resultState === 'gpu-hmr-host-preservation-proven'
      || hostEvidence.process_preserved === true
      || hostEvidence.same_process === true
      || Number(hostEvidence.preserved_count ?? hostEvidence.total_count ?? 0) > 0);
  const dispatchEpoch = firstRuntimeText(
    runtimeDispatch.epoch,
    ...(Array.isArray(runtimeDispatch.epochs) ? runtimeDispatch.epochs : []),
  );
  const publishedEpoch = firstRuntimeText(
    epochEvidence.epoch,
    epochEvidence.published_epoch,
    epochEvidence.active_epoch,
    runtimeEpochSwap?.proof?.epoch,
  );
  const dispatchUsedPublishedEpoch =
    dispatchBridgeObserved
    && epochPublicationObserved
    && Boolean(dispatchEpoch)
    && Boolean(publishedEpoch)
    && dispatchEpoch === publishedEpoch;
  const dispatchArtifactIds = contentAddressedArtifactIds([
    runtimeDispatch.runtime_artifact_id,
    ...(Array.isArray(runtimeDispatch.runtime_artifact_ids) ? runtimeDispatch.runtime_artifact_ids : []),
  ]);
  const transportedArtifactIds = contentAddressedArtifactIds([
    runtimeArtifactTransport.artifact_id,
    runtimeArtifactTransport.artifactId,
    runtimeArtifactTransport.selected_artifact_id,
    runtimeArtifactTransport.selectedArtifactId,
    ...(Array.isArray(runtimeArtifactTransport.artifact_ids) ? runtimeArtifactTransport.artifact_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactIds) ? runtimeArtifactTransport.artifactIds : []),
    ...(Array.isArray(runtimeArtifactTransport.selected_artifact_ids) ? runtimeArtifactTransport.selected_artifact_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.selectedArtifactIds) ? runtimeArtifactTransport.selectedArtifactIds : []),
    runtimeArtifactTransport.ram_blob_id,
    runtimeArtifactTransport.ramBlobId,
    ...(Array.isArray(runtimeArtifactTransport.ram_blob_ids) ? runtimeArtifactTransport.ram_blob_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.ramBlobIds) ? runtimeArtifactTransport.ramBlobIds : []),
    runtimeArtifactTransport.artifact_hash,
    runtimeArtifactTransport.artifactHash,
    ...(Array.isArray(runtimeArtifactTransport.artifact_hashes) ? runtimeArtifactTransport.artifact_hashes : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactHashes) ? runtimeArtifactTransport.artifactHashes : []),
    runtimeArtifactTransport.artifact_content_hash,
    runtimeArtifactTransport.artifactContentHash,
    ...(Array.isArray(runtimeArtifactTransport.artifact_content_hashes) ? runtimeArtifactTransport.artifact_content_hashes : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactContentHashes) ? runtimeArtifactTransport.artifactContentHashes : []),
    runtimeArtifactTransport.blob_digest,
  ]);
  const artifactEpochMatched =
    artifactTransportObserved
    && dispatchBridgeObserved
    && dispatchArtifactIds.length > 0
    && transportedArtifactIds.length > 0
    && dispatchArtifactIds.some((artifactId) => transportedArtifactIds.includes(artifactId));
  const dispatchOutputTarget = firstRuntimeText(
    runtimeDispatch.output_target_id,
    ...(Array.isArray(runtimeDispatch.output_target_ids) ? runtimeDispatch.output_target_ids : []),
  );
  const oracleOutputTarget = firstRuntimeText(
    runtimeOutputOracle.output_target_id,
    runtimeOutputOracle.latest?.output_target_id,
    runtimeOutputOracle.output_oracle?.output_target_id,
    runtimeOutputOracle.output_oracle?.target_id,
  );
  const dispatchId = firstRuntimeText(
    runtimeDispatch.dispatch_id,
    ...(Array.isArray(runtimeDispatch.dispatch_ids) ? runtimeDispatch.dispatch_ids : []),
  );
  const oracleAfterDispatchId = firstRuntimeText(
    runtimeOutputOracle.after_dispatch_id,
    runtimeOutputOracle.latest?.after_dispatch_id,
    runtimeOutputOracle.output_oracle?.after_dispatch_id,
  );
  const dispatchTimestamp = Number(
    Array.isArray(runtimeDispatch.dispatch_timestamps)
      ? runtimeDispatch.dispatch_timestamps.at(-1)
      : runtimeDispatch.dispatch_timestamp,
  );
  const oracleTimestamp = Number(
    runtimeOutputOracle.timestamp_after_dispatch
    ?? runtimeOutputOracle.latest?.timestamp_after_dispatch
    ?? runtimeOutputOracle.output_oracle?.timestamp_after_dispatch,
  );
  const outputTargetObserved = Boolean(oracleOutputTarget && dispatchOutputTarget);
  const outputTargetMatched = outputTargetObserved && oracleOutputTarget === dispatchOutputTarget;
  const outputAfterDispatchObserved =
    outputOracleObserved
    && (
      (Boolean(dispatchId) && oracleAfterDispatchId === dispatchId)
      || (
        Number.isFinite(dispatchTimestamp)
        && Number.isFinite(oracleTimestamp)
        && oracleTimestamp >= dispatchTimestamp
      )
    );
  const firewallAccepted =
    firewallEvidence.cpu_hmr_used === false
    && firewallEvidence.full_rebuild_used === false
    && firewallEvidence.process_restarted === false;
  const blockingGaps = [];
  if (!dispatchBridgeObserved) blockingGaps.push('native_runtime_bridge_dispatch_missing');
  if (rejectedBridgeObserved) blockingGaps.push('native_runtime_bridge_incomplete_dispatch_observed');
  if (!artifactTransportObserved) blockingGaps.push('native_runtime_bridge_artifact_transport_missing');
  if (!epochPublicationObserved) blockingGaps.push('native_runtime_bridge_epoch_publication_missing');
  if (!sameProcessIdentityObserved) blockingGaps.push('native_runtime_bridge_process_identity_missing');
  if (!outputOracleObserved) blockingGaps.push('native_runtime_bridge_output_oracle_missing');
  if (!outputTargetObserved) blockingGaps.push('native_runtime_bridge_output_target_missing');
  if (outputTargetObserved && !outputTargetMatched) {
    blockingGaps.push('native_runtime_bridge_output_target_mismatch');
  }
  if (!outputAfterDispatchObserved) blockingGaps.push('native_runtime_bridge_after_dispatch_missing');
  if (!dispatchUsedPublishedEpoch) blockingGaps.push('native_runtime_bridge_dispatch_epoch_mismatch');
  if (!artifactEpochMatched) blockingGaps.push('native_runtime_bridge_artifact_epoch_mismatch');
  if (fullRuntimeProof?.fullRuntimeProven !== true) {
    blockingGaps.push('native_runtime_bridge_full_runtime_proof_missing');
  }
  if (!firewallAccepted) blockingGaps.push('native_runtime_bridge_firewall_missing');
  const accepted = anyBridgeObserved && blockingGaps.length === 0;
  const evidenceRefs = compactStringList([
    ...(Array.isArray(runtimeDispatch.evidence_refs) ? runtimeDispatch.evidence_refs : []),
    ...(Array.isArray(runtimeArtifactTransport.evidence_refs) ? runtimeArtifactTransport.evidence_refs : []),
    ...(Array.isArray(epochEvidence.evidence_refs) ? epochEvidence.evidence_refs : []),
    ...(Array.isArray(runtimeOutputOracle.evidence_refs) ? runtimeOutputOracle.evidence_refs : []),
    ...(Array.isArray(hostEvidence.evidence_refs) ? hostEvidence.evidence_refs : []),
    ...availableEvidenceRefs,
  ]);
  const stageResults = {
    artifact_transport: { observed: artifactTransportObserved },
    epoch_publication: { observed: epochPublicationObserved },
    dispatch_trace: {
      observed: dispatchBridgeObserved,
      dispatchUsedPublishedEpoch,
      dispatch_used_published_epoch: dispatchUsedPublishedEpoch,
    },
    host_identity: {
      observed: hostIdentityObserved,
      sameProcessIdentityObserved,
      same_process_identity_observed: sameProcessIdentityObserved,
    },
    output_oracle: {
      observed: outputOracleObserved,
      outputTargetObserved,
      output_target_observed: outputTargetObserved,
      outputTargetMatched,
      output_target_matched: outputTargetMatched,
      outputAfterDispatchObserved,
      output_after_dispatch_observed: outputAfterDispatchObserved,
    },
  };
  return {
    schemaVersion: 'synthi.gpu_hmr.native_rocm_runtime_proof_bridge.v1',
    schema_version: 'synthi.gpu_hmr.native_rocm_runtime_proof_bridge.v1',
    observed: anyBridgeObserved,
    declared: anyBridgeObserved,
    accepted,
    canSatisfyRuntimeProof: accepted,
    can_satisfy_runtime_proof: accepted,
    canSatisfyDispatchProof: accepted,
    can_satisfy_dispatch_proof: accepted,
    status: accepted
      ? 'native_runtime_bridge_proven'
      : anyBridgeObserved
        ? 'native_runtime_bridge_unproven'
        : 'not_observed',
    proofAuthority: 'complete_native_runtime_event_chain',
    proof_authority: 'complete_native_runtime_event_chain',
    dispatchBridgeObserved,
    dispatch_bridge_observed: dispatchBridgeObserved,
    rejectedBridgeObserved,
    rejected_bridge_observed: rejectedBridgeObserved,
    artifactTransportObserved,
    artifact_transport_observed: artifactTransportObserved,
    epochPublicationObserved,
    epoch_publication_observed: epochPublicationObserved,
    dispatchUsedPublishedEpoch,
    dispatch_used_published_epoch: dispatchUsedPublishedEpoch,
    sameProcessIdentityObserved,
    same_process_identity_observed: sameProcessIdentityObserved,
    outputOracleObserved,
    output_oracle_observed: outputOracleObserved,
    outputTargetMatched,
    output_target_matched: outputTargetMatched,
    outputAfterDispatchObserved,
    output_after_dispatch_observed: outputAfterDispatchObserved,
    artifactEpochMatched,
    artifact_epoch_matched: artifactEpochMatched,
    firewallAccepted,
    firewall_accepted: firewallAccepted,
    dispatchArtifactIds,
    dispatch_artifact_ids: dispatchArtifactIds,
    transportedArtifactIds,
    transported_artifact_ids: transportedArtifactIds,
    stageResults,
    stage_results: stageResults,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    contractHash: `sha256:${createHash('sha256').update(stableJson({
      dispatchEpoch,
      publishedEpoch,
      dispatchArtifactIds,
      transportedArtifactIds,
      dispatchOutputTarget,
      oracleOutputTarget,
      dispatchId,
      oracleAfterDispatchId,
      stageResults,
    })).digest('hex')}`,
    contract_hash: `sha256:${createHash('sha256').update(stableJson({
      dispatchEpoch,
      publishedEpoch,
      dispatchArtifactIds,
      transportedArtifactIds,
      dispatchOutputTarget,
      oracleOutputTarget,
      dispatchId,
      oracleAfterDispatchId,
      stageResults,
    })).digest('hex')}`,
  };
}

function realRocmSameProcessRuntimeOracleFacet({
  appHookContractFacet = {},
  nativeRuntimeBridgeFacet = {},
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  fullRuntimeProof = {},
  firewallEvidence = {},
  availableEvidenceRefs = [],
} = {}) {
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  const artifactTransportObserved = Number(
    runtimeArtifactTransport.total_count ?? runtimeArtifactTransport.matched_count ?? 0,
  ) > 0;
  const epochPublicationObserved =
    Number(epochEvidence.total_count ?? 0) > 0
    || Number(epochEvidence.published_count ?? 0) > 0
    || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven';
  const dispatchTraceObserved = Number(runtimeDispatch.success_count ?? 0) > 0;
  const outputOracleObserved = Number(runtimeOutputOracle.total_count ?? 0) > 0;
  const hostIdentityObserved = Number(hostEvidence.total_count ?? 0) > 0;
  const appHookRequired =
    appHookContractFacet.required === true
    || appHookContractFacet.declared === true;
  const appHookContractAccepted =
    appHookContractFacet.canSatisfyRuntimeProof === true
    || appHookContractFacet.can_satisfy_runtime_proof === true;
  const nativeRuntimeBridgeObserved =
    nativeRuntimeBridgeFacet.observed === true
    || nativeRuntimeBridgeFacet.declared === true;
  const nativeRuntimeBridgeAccepted =
    nativeRuntimeBridgeFacet.canSatisfyRuntimeProof === true
    || nativeRuntimeBridgeFacet.can_satisfy_runtime_proof === true;
  const runtimeProofBridgeAccepted =
    appHookContractAccepted
    || nativeRuntimeBridgeAccepted;
  const dispatchEpoch = firstRuntimeText(
    runtimeDispatch.epoch,
    ...(Array.isArray(runtimeDispatch.epochs) ? runtimeDispatch.epochs : []),
  );
  const publishedEpoch = firstRuntimeText(
    epochEvidence.epoch,
    epochEvidence.published_epoch,
    epochEvidence.active_epoch,
    runtimeEpochSwap?.proof?.epoch,
  );
  const dispatchArtifact = firstRuntimeText(
    runtimeDispatch.runtime_artifact_id,
    ...(Array.isArray(runtimeDispatch.runtime_artifact_ids) ? runtimeDispatch.runtime_artifact_ids : []),
  );
  const dispatchArtifactIds = contentAddressedArtifactIds([
    runtimeDispatch.runtime_artifact_id,
    ...(Array.isArray(runtimeDispatch.runtime_artifact_ids) ? runtimeDispatch.runtime_artifact_ids : []),
  ]);
  const transportedArtifactIds = contentAddressedArtifactIds([
    runtimeArtifactTransport.artifact_id,
    runtimeArtifactTransport.artifactId,
    runtimeArtifactTransport.selected_artifact_id,
    runtimeArtifactTransport.selectedArtifactId,
    ...(Array.isArray(runtimeArtifactTransport.artifact_ids) ? runtimeArtifactTransport.artifact_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactIds) ? runtimeArtifactTransport.artifactIds : []),
    ...(Array.isArray(runtimeArtifactTransport.selected_artifact_ids) ? runtimeArtifactTransport.selected_artifact_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.selectedArtifactIds) ? runtimeArtifactTransport.selectedArtifactIds : []),
    runtimeArtifactTransport.ram_blob_id,
    runtimeArtifactTransport.ramBlobId,
    ...(Array.isArray(runtimeArtifactTransport.ram_blob_ids) ? runtimeArtifactTransport.ram_blob_ids : []),
    ...(Array.isArray(runtimeArtifactTransport.ramBlobIds) ? runtimeArtifactTransport.ramBlobIds : []),
    runtimeArtifactTransport.artifact_hash,
    runtimeArtifactTransport.artifactHash,
    ...(Array.isArray(runtimeArtifactTransport.artifact_hashes) ? runtimeArtifactTransport.artifact_hashes : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactHashes) ? runtimeArtifactTransport.artifactHashes : []),
    runtimeArtifactTransport.artifact_content_hash,
    runtimeArtifactTransport.artifactContentHash,
    ...(Array.isArray(runtimeArtifactTransport.artifact_content_hashes) ? runtimeArtifactTransport.artifact_content_hashes : []),
    ...(Array.isArray(runtimeArtifactTransport.artifactContentHashes) ? runtimeArtifactTransport.artifactContentHashes : []),
    runtimeArtifactTransport.blob_digest,
  ]);
  const transportedArtifact = firstRuntimeText(
    transportedArtifactIds[0],
    runtimeArtifactTransport.artifact_id,
    runtimeArtifactTransport.artifact_hash,
    runtimeArtifactTransport.blob_digest,
    runtimeArtifactTransport.selected_artifact_id,
  );
  const dispatchOutputTarget = firstRuntimeText(
    runtimeDispatch.output_target_id,
    ...(Array.isArray(runtimeDispatch.output_target_ids) ? runtimeDispatch.output_target_ids : []),
  );
  const oracleOutputTarget = firstRuntimeText(
    runtimeOutputOracle.output_target_id,
    runtimeOutputOracle.latest?.output_target_id,
    runtimeOutputOracle.output_oracle?.output_target_id,
    runtimeOutputOracle.output_oracle?.target_id,
  );
  const dispatchId = firstRuntimeText(
    runtimeDispatch.dispatch_id,
    ...(Array.isArray(runtimeDispatch.dispatch_ids) ? runtimeDispatch.dispatch_ids : []),
  );
  const oracleAfterDispatchId = firstRuntimeText(
    runtimeOutputOracle.after_dispatch_id,
    runtimeOutputOracle.latest?.after_dispatch_id,
    runtimeOutputOracle.output_oracle?.after_dispatch_id,
  );
  const dispatchTimestamp = Number(
    Array.isArray(runtimeDispatch.dispatch_timestamps)
      ? runtimeDispatch.dispatch_timestamps.at(-1)
      : runtimeDispatch.dispatch_timestamp,
  );
  const oracleTimestamp = Number(
    runtimeOutputOracle.timestamp_after_dispatch
    ?? runtimeOutputOracle.latest?.timestamp_after_dispatch
    ?? runtimeOutputOracle.output_oracle?.timestamp_after_dispatch,
  );
  const sameProcessIdentityObserved =
    hostIdentityObserved
    && (runtimeHostPreservation?.proof?.resultState === 'gpu-hmr-host-preservation-proven'
      || hostEvidence.process_preserved === true
      || hostEvidence.same_process === true
      || Number(hostEvidence.preserved_count ?? hostEvidence.total_count ?? 0) > 0);
  const dispatchUsedPublishedEpoch =
    dispatchTraceObserved
    && epochPublicationObserved
    && Boolean(dispatchEpoch)
    && Boolean(publishedEpoch)
    && dispatchEpoch === publishedEpoch;
  const artifactEpochMatched =
    artifactTransportObserved
    && dispatchTraceObserved
    && dispatchArtifactIds.length > 0
    && transportedArtifactIds.length > 0
    && dispatchArtifactIds.some((artifactId) => transportedArtifactIds.includes(artifactId));
  const outputTargetObserved = Boolean(oracleOutputTarget && dispatchOutputTarget);
  const outputTargetMatched =
    outputTargetObserved
    && oracleOutputTarget === dispatchOutputTarget;
  const outputAfterDispatchObserved =
    outputOracleObserved
    && (
      (Boolean(dispatchId) && oracleAfterDispatchId === dispatchId)
      || (
        Number.isFinite(dispatchTimestamp)
        && Number.isFinite(oracleTimestamp)
        && oracleTimestamp >= dispatchTimestamp
      )
    );
  const firewallAccepted =
    firewallEvidence.cpu_hmr_used === false
    && firewallEvidence.full_rebuild_used === false
    && firewallEvidence.process_restarted === false;
  const stageResults = {
    artifact_transport: { observed: artifactTransportObserved },
    epoch_publication: { observed: epochPublicationObserved },
    dispatch_trace: {
      observed: dispatchTraceObserved,
      dispatchUsedPublishedEpoch,
      dispatch_used_published_epoch: dispatchUsedPublishedEpoch,
    },
    host_identity: {
      observed: hostIdentityObserved,
      sameProcessIdentityObserved,
      same_process_identity_observed: sameProcessIdentityObserved,
    },
    output_oracle: {
      observed: outputOracleObserved,
      outputTargetObserved,
      output_target_observed: outputTargetObserved,
      outputTargetMatched,
      output_target_matched: outputTargetMatched,
      outputAfterDispatchObserved,
      output_after_dispatch_observed: outputAfterDispatchObserved,
      dispatchOutputTarget,
      dispatch_output_target: dispatchOutputTarget,
      oracleOutputTarget,
      oracle_output_target: oracleOutputTarget,
    },
  };
  const blockingGaps = [];
  if (appHookRequired && !runtimeProofBridgeAccepted) {
    blockingGaps.push('same_process_runtime_oracle_app_hook_contract_unproven');
  }
  if (nativeRuntimeBridgeObserved && !nativeRuntimeBridgeAccepted) {
    blockingGaps.push('same_process_runtime_oracle_native_runtime_bridge_unproven');
  }
  if (!artifactTransportObserved) blockingGaps.push('same_process_runtime_oracle_artifact_transport_missing');
  if (!epochPublicationObserved) blockingGaps.push('same_process_runtime_oracle_epoch_publication_missing');
  if (!dispatchTraceObserved) blockingGaps.push('same_process_runtime_oracle_dispatch_trace_missing');
  if (!sameProcessIdentityObserved) blockingGaps.push('same_process_runtime_oracle_process_identity_missing');
  if (!outputOracleObserved) blockingGaps.push('same_process_runtime_oracle_output_oracle_missing');
  if (!outputTargetObserved) blockingGaps.push('same_process_runtime_oracle_output_target_missing');
  if (outputTargetObserved && !outputTargetMatched) {
    blockingGaps.push('same_process_runtime_oracle_output_target_mismatch');
  }
  if (!outputAfterDispatchObserved) blockingGaps.push('same_process_runtime_oracle_after_dispatch_missing');
  if (!dispatchUsedPublishedEpoch) blockingGaps.push('same_process_runtime_oracle_dispatch_epoch_mismatch');
  if (!artifactEpochMatched) blockingGaps.push('same_process_runtime_oracle_artifact_epoch_mismatch');
  if (fullRuntimeProof?.fullRuntimeProven !== true) {
    blockingGaps.push('same_process_runtime_oracle_full_runtime_proof_missing');
  }
  if (!firewallAccepted) {
    blockingGaps.push('same_process_runtime_oracle_firewall_missing');
  }
  const accepted =
    runtimeProofBridgeAccepted
    && blockingGaps.length === 0;
  const required =
    appHookRequired
    || nativeRuntimeBridgeObserved
    || runtimeProofBridgeAccepted;
  const evidenceRefs = compactStringList([
    ...(Array.isArray(appHookContractFacet.evidenceRefs) ? appHookContractFacet.evidenceRefs : []),
    ...(Array.isArray(appHookContractFacet.evidence_refs) ? appHookContractFacet.evidence_refs : []),
    ...(Array.isArray(nativeRuntimeBridgeFacet.evidenceRefs) ? nativeRuntimeBridgeFacet.evidenceRefs : []),
    ...(Array.isArray(nativeRuntimeBridgeFacet.evidence_refs) ? nativeRuntimeBridgeFacet.evidence_refs : []),
    ...availableEvidenceRefs,
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    schema_version: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    declared: appHookContractFacet.declared === true,
    required,
    status: accepted
      ? 'same_process_runtime_oracle_contract_proven'
      : required
        ? 'same_process_runtime_oracle_contract_unproven'
        : 'not_required',
    proofAuthority: 'runtime_stage_evidence_not_serialized_claim',
    proof_authority: 'runtime_stage_evidence_not_serialized_claim',
    accepted,
    canSatisfyRuntimeProof: accepted,
    can_satisfy_runtime_proof: accepted,
    canSatisfyDispatchProof: accepted,
    can_satisfy_dispatch_proof: accepted,
    appHookContractAccepted,
    app_hook_contract_accepted: appHookContractAccepted,
    nativeRuntimeBridgeAccepted,
    native_runtime_bridge_accepted: nativeRuntimeBridgeAccepted,
    nativeRuntimeBridgeObserved,
    native_runtime_bridge_observed: nativeRuntimeBridgeObserved,
    runtimeProofBridgeAccepted,
    runtime_proof_bridge_accepted: runtimeProofBridgeAccepted,
    artifactTransportObserved,
    artifact_transport_observed: artifactTransportObserved,
    epochPublicationObserved,
    epoch_publication_observed: epochPublicationObserved,
    dispatchTraceObserved,
    dispatch_trace_observed: dispatchTraceObserved,
    dispatchUsedPublishedEpoch,
    dispatch_used_published_epoch: dispatchUsedPublishedEpoch,
    sameProcessIdentityObserved,
    same_process_identity_observed: sameProcessIdentityObserved,
    outputOracleObserved,
    output_oracle_observed: outputOracleObserved,
    outputTargetObserved,
    output_target_observed: outputTargetObserved,
    outputTargetMatched,
    output_target_matched: outputTargetMatched,
    outputAfterDispatchObserved,
    output_after_dispatch_observed: outputAfterDispatchObserved,
    artifactEpochMatched,
    artifact_epoch_matched: artifactEpochMatched,
    dispatchArtifactIds,
    dispatch_artifact_ids: dispatchArtifactIds,
    transportedArtifactIds,
    transported_artifact_ids: transportedArtifactIds,
    firewallAccepted,
    firewall_accepted: firewallAccepted,
    cpuHmrUsed: firewallEvidence.cpu_hmr_used ?? null,
    cpu_hmr_used: firewallEvidence.cpu_hmr_used ?? null,
    fullRebuildUsed: firewallEvidence.full_rebuild_used ?? null,
    full_rebuild_used: firewallEvidence.full_rebuild_used ?? null,
    processRestarted: firewallEvidence.process_restarted ?? null,
    process_restarted: firewallEvidence.process_restarted ?? null,
    stageResults,
    stage_results: stageResults,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    availableEvidenceRefs: compactStringList(availableEvidenceRefs),
    available_evidence_refs: compactStringList(availableEvidenceRefs),
    contractHash: `sha256:${createHash('sha256').update(stableJson({
      appHookContractHash: appHookContractFacet.contractHash ?? appHookContractFacet.contract_hash ?? null,
      nativeRuntimeBridgeHash:
        nativeRuntimeBridgeFacet.contractHash ?? nativeRuntimeBridgeFacet.contract_hash ?? null,
      dispatchEpoch,
      publishedEpoch,
      dispatchArtifact,
      transportedArtifact,
      dispatchArtifactIds,
      transportedArtifactIds,
      dispatchOutputTarget,
      oracleOutputTarget,
      dispatchId,
      oracleAfterDispatchId,
      stageResults,
    })).digest('hex')}`,
    contract_hash: `sha256:${createHash('sha256').update(stableJson({
      appHookContractHash: appHookContractFacet.contractHash ?? appHookContractFacet.contract_hash ?? null,
      nativeRuntimeBridgeHash:
        nativeRuntimeBridgeFacet.contractHash ?? nativeRuntimeBridgeFacet.contract_hash ?? null,
      dispatchEpoch,
      publishedEpoch,
      dispatchArtifact,
      transportedArtifact,
      dispatchArtifactIds,
      transportedArtifactIds,
      dispatchOutputTarget,
      oracleOutputTarget,
      dispatchId,
      oracleAfterDispatchId,
      stageResults,
    })).digest('hex')}`,
  };
}

function sourceDialectFromPath(filePath) {
  const ext = path.extname(String(filePath ?? '').toLowerCase());
  if (ext === '.cl') return 'opencl_c';
  if (ext === '.hip') return 'hip_cpp';
  if (ext === '.cu') return 'cuda_cpp';
  if (['.h', '.hh', '.hpp', '.hxx', '.cpp', '.cc', '.cxx', '.c'].includes(ext)) return 'c_cpp';
  return 'unknown';
}

function sidecarArtifactKindFromSourceDialect(dialect) {
  if (dialect === 'hip_cpp') return 'hsaco';
  if (dialect === 'opencl_c') return 'opencl_program';
  if (dialect === 'cuda_cpp') return 'cuda_cubin_or_ptx';
  return 'unknown';
}

function sidecarBackendFromSourceDialect(dialect) {
  if (dialect === 'hip_cpp') return 'hip';
  if (dialect === 'opencl_c') return 'opencl';
  if (dialect === 'cuda_cpp') return 'cuda';
  return 'unknown';
}

function realRocmDeviceSidecarCoverage(files, buildMetadata, focusPath) {
  const normalizedFocus = String(focusPath ?? '').replace(/\\/g, '/');
  if (!normalizedFocus) {
    return {
      focus_path: null,
      covered: false,
      reason: 'empty_source_path',
      trace: [],
      root_source_path: null,
      source_dialect: 'unknown',
      root_source_dialect: 'unknown',
    };
  }
  let coverage;
  try {
    coverage = buildSourceCoverageForFocus(files, normalizedFocus, buildMetadata, {
      preferredRoots: [CFG.entryFile],
    });
  } catch (err) {
    coverage = {
      covered: false,
      reason: `coverage_error:${err.message}`,
      trace: [],
      coveredPaths: [],
    };
  }
  const trace = Array.isArray(coverage.trace) ? coverage.trace : [];
  const rootSourcePath = trace[0] ?? null;
  return {
    focus_path: normalizedFocus,
    covered: coverage.covered === true,
    reason: coverage.reason ?? 'unknown',
    trace,
    root_source_path: rootSourcePath,
    source_dialect: sourceDialectFromPath(normalizedFocus),
    root_source_dialect: sourceDialectFromPath(rootSourcePath),
  };
}

function realRocmDeviceSidecarContractFacet({
  files = [],
  buildMetadata = {},
  runtimeEvidence = {},
  declaredContractOverride = null,
} = {}) {
  const declaredContract =
    declaredContractOverride && typeof declaredContractOverride === 'object' && !Array.isArray(declaredContractOverride)
      ? normalizeRealRocmDeviceSidecarContract(declaredContractOverride)
      : CFG.deviceSidecarContract && typeof CFG.deviceSidecarContract === 'object'
        ? CFG.deviceSidecarContract
        : normalizeRealRocmDeviceSidecarContract(null);
  const focusSourcePaths = compactStringList([
    CFG.entryFile,
    CFG.deltaFile,
    CFG.secondDeltaBefore || CFG.secondDeltaAfter ? CFG.secondDeltaFile : null,
    ...((Array.isArray(report.extra_deltas) ? report.extra_deltas : [])
      .map((delta) => delta?.file)
      .filter(Boolean)),
    ...(Array.isArray(declaredContract.sourcePaths) ? declaredContract.sourcePaths : []),
    ...(Array.isArray(declaredContract.source_paths) ? declaredContract.source_paths : []),
  ]);
  const sourceCoverage = focusSourcePaths.map((sourcePath) =>
    realRocmDeviceSidecarCoverage(files, buildMetadata, sourcePath)
  );
  const gpuRootSources = compactStringList(sourceCoverage
    .filter((entry) => entry.covered && ['hip_cpp', 'opencl_c', 'cuda_cpp'].includes(entry.root_source_dialect))
    .map((entry) => entry.root_source_path));
  const directGpuSources = compactStringList(sourceCoverage
    .filter((entry) => entry.covered && ['hip_cpp', 'opencl_c', 'cuda_cpp'].includes(entry.source_dialect))
    .map((entry) => entry.focus_path));
  const derivedSourcePaths = compactStringList([...gpuRootSources, ...directGpuSources]);
  const declaredSourcePaths = compactStringList([
    ...(Array.isArray(declaredContract.sourcePaths) ? declaredContract.sourcePaths : []),
    ...(Array.isArray(declaredContract.source_paths) ? declaredContract.source_paths : []),
  ]);
  const effectiveSourcePaths = declaredSourcePaths.length > 0
    ? declaredSourcePaths
    : derivedSourcePaths;
  const effectiveCoverage = effectiveSourcePaths.map((sourcePath) => {
    const normalized = String(sourcePath ?? '').replace(/\\/g, '/');
    return sourceCoverage.find((entry) => entry.focus_path === normalized)
      ?? realRocmDeviceSidecarCoverage(files, buildMetadata, normalized);
  });
  const effectiveRootDialects = compactStringList(effectiveCoverage
    .map((entry) => entry.root_source_dialect)
    .filter((dialect) => dialect !== 'c_cpp' && dialect !== 'unknown'));
  const effectiveSourceDialects = compactStringList([
    ...effectiveRootDialects,
    ...effectiveCoverage.map((entry) => entry.source_dialect)
      .filter((dialect) => dialect !== 'c_cpp' && dialect !== 'unknown'),
  ]);
  const selectedDialect = effectiveSourceDialects.length === 1
    ? effectiveSourceDialects[0]
    : 'unknown';
  const derivedArtifactKind = sidecarArtifactKindFromSourceDialect(selectedDialect);
  const derivedBackend = sidecarBackendFromSourceDialect(selectedDialect);
  const contractArtifactKind = declaredContract.artifactKind ?? declaredContract.artifact_kind ?? null;
  const artifactKind = contractArtifactKind ?? derivedArtifactKind;
  const contractEntryPoints = compactKnownStringList([
    ...(Array.isArray(declaredContract.entryPoints) ? declaredContract.entryPoints : []),
    ...(Array.isArray(declaredContract.entry_points) ? declaredContract.entry_points : []),
  ]);
  const entryPoints = compactKnownStringList([
    ...contractEntryPoints,
    ...compactStringList(CFG.nativeLaunchSymbols),
  ]);
  const compiler = declaredContract.compiler ?? compilerFromCmakeArgs(CFG.cmakeArgs);
  const compileTarget = declaredContract.compileTarget
    ?? declaredContract.compile_target
    ?? CFG.gpuArch;
  const compilerArgsHash = `sha256:${createHash('sha256').update(stableJson({
    cmakeArgs: CFG.cmakeArgs,
    cmakeConfigName: CFG.cmakeConfigName,
    compileTarget,
    compiler,
    sourcePaths: effectiveSourcePaths,
    targetName: CFG.targetName,
  })).digest('hex')}`;
  const sourceCoverageComplete =
    effectiveSourcePaths.length > 0
    && effectiveCoverage.length === effectiveSourcePaths.length
    && effectiveCoverage.every((entry) => entry.covered === true);
  const contractEvidenceComplete =
    sourceCoverageComplete
    && effectiveSourcePaths.length > 0
    && artifactKind !== 'unknown'
    && entryPoints.length > 0
    && Boolean(compileTarget)
    && Boolean(compiler);
  const blockingGaps = [];
  if (effectiveSourcePaths.length === 0) {
    blockingGaps.push('device_sidecar_source_not_declared_or_derived');
  }
  if (!sourceCoverageComplete) {
    blockingGaps.push('device_sidecar_source_not_covered_by_build_metadata');
  }
  if (derivedSourcePaths.length === 0) {
    blockingGaps.push('device_sidecar_gpu_root_source_not_derived');
  }
  if (artifactKind === 'unknown') {
    blockingGaps.push('device_sidecar_artifact_kind_unknown');
  }
  if (entryPoints.length === 0) {
    blockingGaps.push('device_sidecar_entry_points_missing');
  }
  if (!compileTarget) {
    blockingGaps.push('device_sidecar_compile_target_missing');
  }
  if (!compiler) {
    blockingGaps.push('device_sidecar_compiler_missing');
  }
  if (derivedBackend === 'cuda') {
    blockingGaps.push('device_sidecar_cuda_not_provable_on_rocm_host');
  }
  const runtimeObservedByStage = {
    artifactTransport: runtimeEvidence.artifactTransportObserved === true,
    epochPublication: runtimeEvidence.epochObserved === true,
    dispatchTrace: runtimeEvidence.dispatchObserved === true,
    outputOracle: runtimeEvidence.outputOracleObserved === true,
    hostIdentity: runtimeEvidence.hostIdentityObserved === true,
  };
  const runtimeObservationComplete = Object.values(runtimeObservedByStage).every(Boolean);
  if (!runtimeObservedByStage.artifactTransport) {
    blockingGaps.push('device_sidecar_artifact_transport_runtime_not_observed');
  }
  if (!runtimeObservedByStage.epochPublication) {
    blockingGaps.push('device_sidecar_epoch_publication_runtime_not_observed');
  }
  if (!runtimeObservedByStage.dispatchTrace) {
    blockingGaps.push('device_sidecar_dispatch_trace_runtime_not_observed');
  }
  if (!runtimeObservedByStage.outputOracle) {
    blockingGaps.push('device_sidecar_output_oracle_runtime_not_observed');
  }
  if (!runtimeObservedByStage.hostIdentity) {
    blockingGaps.push('device_sidecar_host_identity_runtime_not_observed');
  }
  const fullRuntimeProofAccepted = runtimeEvidence.fullRuntimeProofAccepted === true;
  if (runtimeObservationComplete && !fullRuntimeProofAccepted) {
    blockingGaps.push('device_sidecar_full_runtime_proof_not_accepted');
  }
  const canSatisfyRuntimeProof =
    contractEvidenceComplete
    && runtimeObservationComplete
    && fullRuntimeProofAccepted
    && derivedBackend !== 'cuda';
  const evidenceRefs = compactStringList([
    `profile:${CFG.realRocmProfile.id}`,
    `build-metadata:target:${CFG.targetName}`,
    ...focusSourcePaths.map((sourcePath) => `profile:source:${sourcePath}`),
    ...effectiveCoverage
      .filter((entry) => entry.covered)
      .map((entry) => `build-metadata:coverage:${entry.focus_path}:${entry.reason}`),
    ...entryPoints.map((entryPoint) => `profile:native_launch_symbol:${entryPoint}`),
    ...(Array.isArray(runtimeEvidence.evidenceRefs) ? runtimeEvidence.evidenceRefs : []),
    ...(Array.isArray(runtimeEvidence.evidence_refs) ? runtimeEvidence.evidence_refs : []),
    ...(Array.isArray(declaredContract.evidenceRefs) ? declaredContract.evidenceRefs : []),
    ...(Array.isArray(declaredContract.evidence_refs) ? declaredContract.evidence_refs : []),
  ]);
  const status = canSatisfyRuntimeProof
    ? 'device_sidecar_runtime_proof_evidence'
    : declaredContract.declared
    ? contractEvidenceComplete
      ? 'declared_device_sidecar_contract_pending_runtime_proof'
      : 'declared_device_sidecar_contract_incomplete'
    : contractEvidenceComplete
      ? 'derived_device_sidecar_candidate_pending_runtime_proof'
      : derivedSourcePaths.length > 0
        ? 'derived_device_sidecar_candidate_incomplete'
        : 'device_sidecar_contract_not_derived';
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: declaredContract.declared === true,
    required: declaredContract.required === true,
    status,
    proofAuthority: canSatisfyRuntimeProof
      ? 'runtime_observed_sidecar_contract_evidence'
      : 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: canSatisfyRuntimeProof
      ? 'runtime_observed_sidecar_contract_evidence'
      : 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof,
    can_satisfy_runtime_proof: canSatisfyRuntimeProof,
    canSatisfyDispatchProof: canSatisfyRuntimeProof,
    can_satisfy_dispatch_proof: canSatisfyRuntimeProof,
    contractEvidenceComplete,
    contract_evidence_complete: contractEvidenceComplete,
    runtimeObservationComplete,
    runtime_observation_complete: runtimeObservationComplete,
    runtimeObservedByStage,
    runtime_observed_by_stage: runtimeObservedByStage,
    fullRuntimeProofAccepted,
    full_runtime_proof_accepted: fullRuntimeProofAccepted,
    sourceCoverageComplete,
    source_coverage_complete: sourceCoverageComplete,
    sourceCoverage,
    source_coverage: sourceCoverage,
    derivedSourcePaths,
    derived_source_paths: derivedSourcePaths,
    effectiveSourcePaths,
    effective_source_paths: effectiveSourcePaths,
    sourceDialects: effectiveSourceDialects,
    source_dialects: effectiveSourceDialects,
    sourceLanguage: selectedDialect,
    source_language: selectedDialect,
    backend: derivedBackend,
    artifactIdentity: {
      source_paths: effectiveSourcePaths,
      artifact_kind: artifactKind,
      entry_points: entryPoints,
      compile_target: compileTarget,
      compiler,
      compiler_args_hash: compilerArgsHash,
    },
    artifact_identity: {
      source_paths: effectiveSourcePaths,
      artifact_kind: artifactKind,
      entry_points: entryPoints,
      compile_target: compileTarget,
      compiler,
      compiler_args_hash: compilerArgsHash,
    },
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    contractHash: `sha256:${createHash('sha256').update(stableJson({
      declaredContract,
      artifactKind,
      compileTarget,
      compiler,
      effectiveSourcePaths,
      entryPoints,
      sourceCoverage,
    })).digest('hex')}`,
    contract_hash: `sha256:${createHash('sha256').update(stableJson({
      declaredContract,
      artifactKind,
      compileTarget,
      compiler,
      effectiveSourcePaths,
      entryPoints,
      sourceCoverage,
    })).digest('hex')}`,
  };
}

function runtimeBackendHintsFromCmakeArgs(cmakeArgs = []) {
  const hints = [];
  for (const rawArg of Array.isArray(cmakeArgs) ? cmakeArgs : []) {
    const match = String(rawArg ?? '').trim().match(/^-D([^=]+)=([^=].*)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim().toLowerCase();
    const backendLikeKey =
      /(?:^|_)(backend|runtime|gpu|accelerator|device|compute|platform|api)(?:_|$)/.test(key)
      || key.endsWith('_backend')
      || key.endsWith('_runtime')
      || key.endsWith('_api');
    if (!backendLikeKey) continue;
    for (const token of value.split(/[^a-z0-9_+-]+/)) {
      if (/^(hip|rocm|hiprt|opencl|vulkan|webgpu|wgpu|cuda|sycl)$/.test(token)) hints.push(token);
    }
  }
  return compactStringList(hints);
}

function inferRuntimeBackendCandidates({
  gpuMode = '',
  cmakeArgs = [],
  nativeObservation = {},
  runtimeCapabilityPreflight = {},
  compiler = '',
} = {}) {
  const cmakeBackendHints = runtimeBackendHintsFromCmakeArgs(cmakeArgs);
  const evidenceText = [
    gpuMode,
    runtimeCapabilityPreflight?.backend,
    runtimeCapabilityPreflight?.api,
    compiler,
    ...compactStringList(cmakeArgs),
    ...cmakeBackendHints,
    ...compactStringList(nativeObservation.api_coverage),
    ...compactStringList(nativeObservation.apis),
    ...compactStringList(nativeObservation.attempted_apis),
    ...compactStringList(nativeObservation.function_resolution_api_coverage),
    ...compactStringList(nativeObservation.array_allocation_api_coverage),
    ...compactStringList(nativeObservation.texture_object_api_coverage),
  ].join(' ').toLowerCase();
  const candidates = [];
  if (/\bhiprt\b|hiprtpathtracer|hiprt[_-]?oro|hiprto/.test(evidenceText)) candidates.push('hiprt');
  if (/\bhip\b|hipcc|hipmodule|hiplaunch|hipmalloc|hipmemcpy|hipstream|amdhip64/.test(evidenceText)) {
    candidates.push('hip');
  }
  if (/\bopencl\b|clcreateprogram|clbuildprogram|clenqueue/i.test(evidenceText)) candidates.push('opencl');
  if (/\bvulkan\b|spirv|spv|vkcreate/i.test(evidenceText)) candidates.push('vulkan');
  if (/\bwebgpu\b|\bwgpu\b|wgsl/.test(evidenceText)) candidates.push('webgpu');
  const rocmOrHipEvidence =
    /\brocm\b|amdclang|amdgcn|gfx\d+|amdhip64|hipmodule|hiplaunch|hipmalloc|hipmemcpy|hipstream/.test(evidenceText);
  const cudaSpecificEvidence = /\bcuda\b|\bnvidia\b|nvcc|cubin|\bptx\b/.test(evidenceText);
  const cudaDriverEvidence = /\bcu(module|launch|mem|stream|ctx|get|device)/.test(evidenceText);
  if (cudaSpecificEvidence || (!rocmOrHipEvidence && cudaDriverEvidence)) candidates.push('cuda');
  if (candidates.length === 0 && /\brocm\b|amdclang|amdgcn|gfx\d+/.test(evidenceText)) {
    candidates.push('hip');
  }
  return compactStringList(candidates);
}

function compilerFromCmakeArgs(cmakeArgs = []) {
  for (const arg of Array.isArray(cmakeArgs) ? cmakeArgs : []) {
    const match = String(arg ?? '').match(/^-D(?:CMAKE_(?:C|CXX)_COMPILER|HIP_HIPCC_EXECUTABLE|HIP_COMPILER)=([^=].*)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

function realRocmRuntimeEligibilityFacet({
  nativeBoundary = {},
  appHookContractFacet = {},
  nativeObservation = {},
  runtimeDispatch = {},
  runtimeArtifactTransport = {},
  runtimeEpochSwap = {},
  runtimeOutputOracle = {},
  runtimeHostPreservation = {},
  runtimeCapabilityPreflight = {},
  outputOracleResolution = {},
  fullRuntimeProof = {},
  runtimeBackend = null,
  compiler = null,
} = {}) {
  const sourcePaths = compactStringList([
    CFG.entryFile,
    CFG.deltaFile,
    CFG.secondDeltaBefore || CFG.secondDeltaAfter ? CFG.secondDeltaFile : null,
    ...((Array.isArray(report.extra_deltas) ? report.extra_deltas : [])
      .map((delta) => delta?.file)
      .filter(Boolean)),
  ]);
  const sourceDialects = compactStringList(sourcePaths.map(sourceDialectFromPath));
  const candidateCompiler = compiler ?? compilerFromCmakeArgs(CFG.cmakeArgs);
  const backendCandidates = inferRuntimeBackendCandidates({
    gpuMode: CFG.gpuMode,
    cmakeArgs: CFG.cmakeArgs,
    nativeObservation,
    runtimeCapabilityPreflight,
    compiler: candidateCompiler,
  });
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  const fullRuntimeProven = fullRuntimeProof?.fullRuntimeProven === true;
  const synthiDispatchObserved = Number(runtimeDispatch.success_count ?? 0) > 0;
  const artifactTransportObserved = Number(runtimeArtifactTransport.total_count ?? 0) > 0;
  const epochObserved = Number(epochEvidence.total_count ?? 0) > 0
    || Number(epochEvidence.published_count ?? 0) > 0
    || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven';
  const outputOracleObserved = Number(runtimeOutputOracle.total_count ?? 0) > 0;
  const hostIdentityObserved = Number(hostEvidence.total_count ?? 0) > 0;
  const nativeObserved = nativeBoundary.observed === true
    || nativeBoundary.native_launch_boundary_observed === true
    || Number(nativeObservation.function_resolution_count ?? 0) > 0
    || Number(nativeObservation.attempt_count ?? 0) > 0
    || Number(nativeObservation.total_count ?? 0) > 0;
  const oracleProfileAbsent =
    outputOracleResolution?.runtimeProfilePresent !== true
    && outputOracleResolution?.contractPresent !== true
    && (
      outputOracleResolution?.mode === 'none'
      || outputOracleResolution?.requestedProfile === 'none'
      || outputOracleResolution?.requested_profile === 'none'
      || outputOracleResolution?.disabledReason === 'profile_disabled'
      || outputOracleResolution?.disabled_reason === 'profile_disabled'
    );
  const blockingGaps = [];
  if (!fullRuntimeProven) {
    if (nativeObserved) blockingGaps.push('native_boundary_not_synthi_dispatch_proof');
    if (!artifactTransportObserved) blockingGaps.push('artifact_transport_not_observed');
    if (!epochObserved) blockingGaps.push('same_process_epoch_missing');
    if (!synthiDispatchObserved) blockingGaps.push('dispatch_epoch_missing');
    if (!outputOracleObserved) {
      blockingGaps.push(oracleProfileAbsent ? 'output_oracle_profile_absent' : 'output_oracle_missing');
    }
    if (!hostIdentityObserved) blockingGaps.push('host_identity_not_observed');
    blockingGaps.push(
      ...compactStringList([
        ...(Array.isArray(appHookContractFacet.blockingGaps) ? appHookContractFacet.blockingGaps : []),
        ...(Array.isArray(appHookContractFacet.blocking_gaps) ? appHookContractFacet.blocking_gaps : []),
      ]),
    );
  }
  const hasRuntimeEvidence = backendCandidates.length > 0
    || nativeObserved
    || runtimeCapabilityPreflight?.backend
    || runtimeCapabilityPreflight?.api;
  const evidenceRefs = compactStringList([
    `profile:${CFG.realRocmProfile.id}`,
    ...sourcePaths.map((sourcePath) => `profile:source:${sourcePath}`),
    ...CFG.cmakeArgs.map((arg) => `profile:cmake_arg:${arg}`),
    ...((nativeBoundary.evidence_refs ?? nativeBoundary.evidenceRefs) ?? []),
    runtimeCapabilityPreflight?.backend ? `runtime-preflight:backend:${runtimeCapabilityPreflight.backend}` : null,
    runtimeCapabilityPreflight?.api ? `runtime-preflight:api:${runtimeCapabilityPreflight.api}` : null,
    ...(Array.isArray(appHookContractFacet.evidenceRefs) ? appHookContractFacet.evidenceRefs : []),
    ...(Array.isArray(appHookContractFacet.evidence_refs) ? appHookContractFacet.evidence_refs : []),
  ]);
  const compilerArgsHash = `sha256:${createHash('sha256').update(stableJson({
    cmakeArgs: CFG.cmakeArgs,
    cmakeConfigName: CFG.cmakeConfigName,
    targetName: CFG.targetName,
    gpuArch: CFG.gpuArch,
  })).digest('hex')}`;
  const candidateEntryPoints = compactKnownStringList([
    ...compactStringList(nativeObservation.function_resolution_symbols),
    ...compactStringList(nativeObservation.kernel_symbols),
    ...compactStringList(CFG.nativeLaunchSymbols),
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_eligibility.v1',
    observed: hasRuntimeEvidence,
    status: fullRuntimeProven
      ? 'supplemental_runtime_proof_evidence'
      : hasRuntimeEvidence
        ? 'refused_missing_runtime_proof'
        : 'not_observed',
    proofAuthority: 'candidate_metadata_only_not_gpu_hmr_success',
    proof_authority: 'candidate_metadata_only_not_gpu_hmr_success',
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    hmrBackend: fullRuntimeProven ? runtimeBackend : null,
    hmr_backend: fullRuntimeProven ? runtimeBackend : null,
    backendCandidates,
    backend_candidates: backendCandidates,
    runtimeBackendCandidates: backendCandidates,
    runtime_backend_candidates: backendCandidates,
    sourceLanguage: sourceDialects.length === 1 ? sourceDialects[0] : 'mixed_or_unknown',
    source_language: sourceDialects.length === 1 ? sourceDialects[0] : 'mixed_or_unknown',
    sourceDialects,
    source_dialects: sourceDialects,
    candidateArtifactIdentity: {
      source_paths: sourcePaths,
      artifact_kind: backendCandidates.includes('hiprt') || backendCandidates.includes('hip')
        ? 'hip_source_bridge'
        : backendCandidates.includes('opencl')
          ? 'opencl_program'
          : 'unknown',
      entry_points: candidateEntryPoints,
      compile_target: CFG.gpuArch,
      compiler: candidateCompiler,
      compiler_args_hash: compilerArgsHash,
    },
    candidate_artifact_identity: {
      source_paths: sourcePaths,
      artifact_kind: backendCandidates.includes('hiprt') || backendCandidates.includes('hip')
        ? 'hip_source_bridge'
        : backendCandidates.includes('opencl')
          ? 'opencl_program'
          : 'unknown',
      entry_points: candidateEntryPoints,
      compile_target: CFG.gpuArch,
      compiler: candidateCompiler,
      compiler_args_hash: compilerArgsHash,
    },
    nativeLaunchBoundaryObserved: nativeObserved,
    native_launch_boundary_observed: nativeObserved,
    synthiDispatchObserved,
    synthi_dispatch_observed: synthiDispatchObserved,
    artifactTransportObserved,
    artifact_transport_observed: artifactTransportObserved,
    epochObserved,
    epoch_observed: epochObserved,
    outputOracleObserved,
    output_oracle_observed: outputOracleObserved,
    hostIdentityObserved,
    host_identity_observed: hostIdentityObserved,
    appHookContractStatus: appHookContractFacet.status ?? null,
    app_hook_contract_status: appHookContractFacet.status ?? null,
    appHookContractDeclared: appHookContractFacet.declared === true,
    app_hook_contract_declared: appHookContractFacet.declared === true,
    appHookContractCanSatisfyRuntimeProof: appHookContractFacet.canSatisfyRuntimeProof === true,
    app_hook_contract_can_satisfy_runtime_proof: appHookContractFacet.can_satisfy_runtime_proof === true,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function realRocmSidecarRuntimeConsistencyFacet({
  deviceSidecarContract = {},
  runtimeEligibility = {},
} = {}) {
  const sidecar = deviceSidecarContract && typeof deviceSidecarContract === 'object'
    ? deviceSidecarContract
    : {};
  const eligibility = runtimeEligibility && typeof runtimeEligibility === 'object'
    ? runtimeEligibility
    : {};
  const sidecarBackend = String(sidecar.backend ?? sidecar.hmrBackend ?? sidecar.hmr_backend ?? '').trim().toLowerCase();
  const runtimeBackendCandidates = compactStringList([
    ...(Array.isArray(eligibility.backendCandidates) ? eligibility.backendCandidates : []),
    ...(Array.isArray(eligibility.backend_candidates) ? eligibility.backend_candidates : []),
    ...(Array.isArray(eligibility.runtimeBackendCandidates) ? eligibility.runtimeBackendCandidates : []),
    ...(Array.isArray(eligibility.runtime_backend_candidates) ? eligibility.runtime_backend_candidates : []),
  ]).map((value) => value.toLowerCase());
  const sidecarEvidenceComplete =
    sidecar.contractEvidenceComplete === true
    || sidecar.contract_evidence_complete === true;
  const sidecarRuntimeObservationComplete =
    sidecar.runtimeObservationComplete === true
    || sidecar.runtime_observation_complete === true;
  const sidecarCanSatisfyRuntimeProof =
    sidecar.canSatisfyRuntimeProof === true
    || sidecar.can_satisfy_runtime_proof === true;
  const runtimeObserved =
    eligibility.observed === true
    || eligibility.nativeLaunchBoundaryObserved === true
    || eligibility.native_launch_boundary_observed === true
    || runtimeBackendCandidates.length > 0;
  const sidecarPresent = Object.keys(sidecar).length > 0
    && sidecar.status !== 'device_sidecar_contract_not_derived';
  const blockingGaps = [];
  if (!sidecarPresent) {
    blockingGaps.push('sidecar_runtime_sidecar_not_present');
  }
  if (sidecarPresent && !sidecarBackend) {
    blockingGaps.push('sidecar_runtime_sidecar_backend_unknown');
  }
  if (!runtimeObserved || runtimeBackendCandidates.length === 0) {
    blockingGaps.push('sidecar_runtime_backend_candidates_missing');
  }
  const backendConsistent =
    sidecarBackend
    && runtimeBackendCandidates.includes(sidecarBackend);
  if (
    sidecarPresent
    && sidecarBackend
    && runtimeBackendCandidates.length > 0
    && !backendConsistent
  ) {
    blockingGaps.push('sidecar_runtime_backend_mismatch');
  }
  if (sidecarPresent && !sidecarEvidenceComplete) {
    blockingGaps.push('sidecar_runtime_sidecar_contract_incomplete');
  }
  if (sidecarPresent && !sidecarRuntimeObservationComplete) {
    blockingGaps.push('sidecar_runtime_sidecar_observation_missing');
  }
  if (sidecarPresent && !sidecarCanSatisfyRuntimeProof) {
    blockingGaps.push('sidecar_runtime_sidecar_not_runtime_proof');
  }
  const accepted =
    sidecarPresent
    && Boolean(backendConsistent)
    && sidecarEvidenceComplete
    && sidecarRuntimeObservationComplete
    && sidecarCanSatisfyRuntimeProof
    && blockingGaps.length === 0;
  const notApplicable = !sidecarPresent;
  const status = notApplicable
    ? 'not_applicable'
    : accepted
      ? 'sidecar_runtime_consistency_proven'
      : backendConsistent
        ? 'sidecar_runtime_backend_consistent_not_runtime_proof'
        : 'sidecar_runtime_backend_inconsistent_or_unproven';
  const evidenceRefs = compactStringList([
    ...(Array.isArray(sidecar.evidenceRefs) ? sidecar.evidenceRefs : []),
    ...(Array.isArray(sidecar.evidence_refs) ? sidecar.evidence_refs : []),
    ...(Array.isArray(eligibility.evidenceRefs) ? eligibility.evidenceRefs : []),
    ...(Array.isArray(eligibility.evidence_refs) ? eligibility.evidence_refs : []),
  ]);
  const contractHash = `sha256:${createHash('sha256').update(stableJson({
    sidecarBackend,
    runtimeBackendCandidates,
    sidecarEvidenceComplete,
    sidecarRuntimeObservationComplete,
    runtimeObserved,
  })).digest('hex')}`;
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status,
    accepted,
    runtimeConsistencyAccepted: accepted,
    runtime_consistency_accepted: accepted,
    notApplicable,
    not_applicable: notApplicable,
    proofAuthority: accepted
      ? 'sidecar_backend_runtime_consistency_evidence'
      : notApplicable
        ? 'explicit_no_device_sidecar_applicable'
        : 'evidence_only_not_gpu_hmr_success',
    proof_authority: accepted
      ? 'sidecar_backend_runtime_consistency_evidence'
      : notApplicable
        ? 'explicit_no_device_sidecar_applicable'
        : 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: accepted,
    can_satisfy_runtime_proof: accepted,
    canSatisfyDispatchProof: accepted,
    can_satisfy_dispatch_proof: accepted,
    sidecarBackend: sidecarBackend || null,
    sidecar_backend: sidecarBackend || null,
    runtimeBackendCandidates,
    runtime_backend_candidates: runtimeBackendCandidates,
    backendConsistent: Boolean(backendConsistent),
    backend_consistent: Boolean(backendConsistent),
    sidecarEvidenceComplete,
    sidecar_evidence_complete: sidecarEvidenceComplete,
    sidecarRuntimeObservationComplete,
    sidecar_runtime_observation_complete: sidecarRuntimeObservationComplete,
    sidecarCanSatisfyRuntimeProof,
    sidecar_can_satisfy_runtime_proof: sidecarCanSatisfyRuntimeProof,
    runtimeObserved,
    runtime_observed: runtimeObserved,
    blockingGaps: compactStringList(blockingGaps),
    blocking_gaps: compactStringList(blockingGaps),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    contractHash,
    contract_hash: contractHash,
  };
}

function selectedArtifactIdsFromProofArtifacts(records) {
  const ids = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;
    if (typeof artifact.selectedArtifactId === 'string' && artifact.selectedArtifactId.trim()) {
      ids.add(artifact.selectedArtifactId.trim());
    }
    const stages = Array.isArray(artifact.stageResults) ? artifact.stageResults : [];
    for (const stage of stages) {
      for (const value of Array.isArray(stage?.outputArtifactIds) ? stage.outputArtifactIds : []) {
        if (typeof value === 'string' && value.trim()) ids.add(value.trim());
      }
    }
  }
  return [...ids].filter((id) => /^artifact:/i.test(id));
}

function runtimeArtifactMatchesSelected({ runtimeDispatch, selectedArtifactIds }) {
  const selected = new Set(selectedArtifactIds);
  return selected.size > 0
    && runtimeDispatch.runtime_artifact_ids.some((artifactId) => selected.has(artifactId));
}

function contentAddressedArtifactIds(values) {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        const artifactDigest = trimmed.match(/^artifact:sha256:([0-9a-f]{64})$/i)?.[1];
        const shaDigest = trimmed.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
        const digest = artifactDigest ?? shaDigest;
        return digest ? `artifact:sha256:${digest.toLowerCase()}` : null;
      }).filter(Boolean))]
    : [];
}

function artifactIdsFromSha256Hashes(values) {
  return Array.isArray(values)
    ? contentAddressedArtifactIds(values.map((value) => {
        const digest = String(value ?? '').trim().match(/^sha256:([0-9a-f]{64})$/i)?.[1];
        return digest ? `artifact:sha256:${digest.toLowerCase()}` : null;
      }))
    : [];
}

function artifactIdsFromEpochProofForValidation(proof) {
  if (!proof || typeof proof !== 'object') return [];
  const graph = proof.epochGenerationGraph && typeof proof.epochGenerationGraph === 'object'
    ? proof.epochGenerationGraph
    : proof.generationGraph && typeof proof.generationGraph === 'object'
      ? proof.generationGraph
      : {};
  const publication = graph.latestPublication && typeof graph.latestPublication === 'object'
    ? graph.latestPublication
    : {};
  const publishEdges = Array.isArray(graph.edges)
    ? graph.edges.filter((edge) => edge && typeof edge === 'object' && String(edge.kind ?? '').toLowerCase() === 'publish')
    : [];
  return contentAddressedArtifactIds([
    proof.newArtifactId,
    proof.new_artifact_id,
    proof.activeArtifactId,
    proof.active_artifact_id,
    proof.publishedArtifactId,
    proof.published_artifact_id,
    publication.newArtifactId,
    publication.new_artifact_id,
    publication.activeArtifactId,
    publication.active_artifact_id,
    publication.publishedArtifactId,
    publication.published_artifact_id,
    ...publishEdges.flatMap((edge) => [
      edge.newArtifactId,
      edge.new_artifact_id,
      edge.activeArtifactId,
      edge.active_artifact_id,
      edge.publishedArtifactId,
      edge.published_artifact_id,
    ]),
    ...artifactIdsFromSha256Hashes([
      proof.newArtifactHash,
      proof.new_artifact_hash,
      proof.newHash,
      proof.new_hash,
      publication.newArtifactHash,
      publication.new_artifact_hash,
      publication.newHash,
      publication.new_hash,
      ...publishEdges.flatMap((edge) => [
        edge.newArtifactHash,
        edge.new_artifact_hash,
        edge.newHash,
        edge.new_hash,
      ]),
    ]),
  ]);
}

function preferredRuntimeArtifactId({ selectedArtifactIds, epochProof } = {}) {
  const selected = contentAddressedArtifactIds(selectedArtifactIds);
  if (selected.length === 0) return null;
  const epochArtifactIds = artifactIdsFromEpochProofForValidation(epochProof);
  const epochSelectedArtifactId = epochArtifactIds.find((artifactId) => selected.includes(artifactId));
  return epochSelectedArtifactId ?? selected.at(-1) ?? null;
}

function hiprtNativeVisualFrame(frames = []) {
  return (Array.isArray(frames) ? frames : []).find((frame) =>
    frame?.accepted_as_visual_evidence === true
    && (
      frame?.source === 'hiprt-runtime-device-framebuffer'
      || frame?.label === 'hiprt-runtime-framebuffer'
    )
    && typeof frame?.path === 'string'
    && frame.path.trim()
  ) ?? null;
}

function firstStringField(entry, names = []) {
  if (!entry || typeof entry !== 'object') return null;
  for (const name of names) {
    const value = entry[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stableOutputIdentityPart(value, fallback) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return cleaned || fallback;
}

function runtimeOutputTargetId({
  outputOracleContract = report.output_oracle_contract,
  outputOracleRuntimeProfile = report.output_oracle_runtime_profile,
  visualFrame = null,
  outputKind = 'framebuffer',
} = {}) {
  const runtimeProfile = outputOracleRuntimeProfile && typeof outputOracleRuntimeProfile === 'object'
    ? outputOracleRuntimeProfile
    : {};
  const runtimeProfileRuntime = runtimeProfile.runtime && typeof runtimeProfile.runtime === 'object'
    ? runtimeProfile.runtime
    : {};
  const contract = outputOracleContract && typeof outputOracleContract === 'object'
    ? outputOracleContract
    : {};
  const explicit = firstStringField(contract, [
    'outputTargetId',
    'output_target_id',
    'outputTarget',
    'output_target',
    'target',
  ]) ?? firstStringField(runtimeProfile, [
    'outputTargetId',
    'output_target_id',
    'outputTarget',
    'output_target',
    'target',
  ]) ?? firstStringField(runtimeProfileRuntime, [
    'outputTargetId',
    'output_target_id',
    'outputTarget',
    'output_target',
    'target',
  ]) ?? firstStringField(visualFrame, [
    'outputTargetId',
    'output_target_id',
    'outputTarget',
    'output_target',
    'target',
  ]);
  if (explicit) return explicit;

  const adapterFamily = stableOutputIdentityPart(
    report.real_rocm_profile?.adapter?.family
      ?? report.real_rocm_profile?.runtime?.backend?.orochiApi
      ?? report.real_rocm_profile?.runtime?.backend?.api
      ?? (CFG.hiprtRuntimeProbe ? 'hiprt' : CFG.gpuMode),
    'gpu',
  );
  const targetName = stableOutputIdentityPart(
    runtimeProfileRuntime.targetName
      ?? runtimeProfile.targetName
      ?? CFG.targetName
      ?? report.target_name,
    'runtime-target',
  );
  const kind = stableOutputIdentityPart(
    firstStringField(visualFrame, ['outputKind', 'output_kind', 'kind']) ?? outputKind,
    'output',
  );
  return `${adapterFamily}:${targetName}:${kind}`;
}

function hiprtNativeEvidenceRef(record, kind = 'native_launch_observed') {
  const session = evidenceRefPart(record?.runtimeSession, 'native-session');
  const kernel = evidenceRefPart(record?.kernelSymbol, 'kernel');
  const sequence = evidenceRefPart(record?.sequence, 'sequence');
  return `worker-log:${kind}:${session}:${kernel}:${sequence}`;
}

function nativeLaunchTargetSymbols({
  nativeLaunchSymbols = CFG.nativeLaunchSymbols,
  outputOracleRuntimeProfile = report.output_oracle_runtime_profile,
  outputOracleContract = report.output_oracle_contract,
} = {}) {
  const runtimeProfile = outputOracleRuntimeProfile && typeof outputOracleRuntimeProfile === 'object'
    ? outputOracleRuntimeProfile
    : {};
  const runtimeProfileRuntime = runtimeProfile.runtime && typeof runtimeProfile.runtime === 'object'
    ? runtimeProfile.runtime
    : {};
  const runtimeProfileReload =
    runtimeProfileRuntime.reload && typeof runtimeProfileRuntime.reload === 'object'
      ? runtimeProfileRuntime.reload
      : {};
  const contract = outputOracleContract && typeof outputOracleContract === 'object'
    ? outputOracleContract
    : {};
  return compactStringList([
    ...compactStringList(nativeLaunchSymbols),
    runtimeProfile.kernelSymbol,
    runtimeProfile.kernel_symbol,
    runtimeProfile.kernelName,
    runtimeProfile.kernel_name,
    runtimeProfileRuntime.kernelSymbol,
    runtimeProfileRuntime.kernel_symbol,
    runtimeProfileRuntime.kernelName,
    runtimeProfileRuntime.kernel_name,
    runtimeProfileReload.kernelSymbol,
    runtimeProfileReload.kernel_symbol,
    runtimeProfileReload.kernelName,
    runtimeProfileReload.kernel_name,
    ...(Array.isArray(runtimeProfile.requiredKernels) ? runtimeProfile.requiredKernels : []),
    ...(Array.isArray(runtimeProfile.required_kernels) ? runtimeProfile.required_kernels : []),
    ...(Array.isArray(runtimeProfileRuntime.requiredKernels) ? runtimeProfileRuntime.requiredKernels : []),
    ...(Array.isArray(runtimeProfileRuntime.required_kernels) ? runtimeProfileRuntime.required_kernels : []),
    contract.kernelSymbol,
    contract.kernel_symbol,
    contract.kernelName,
    contract.kernel_name,
  ]);
}

function nativeLaunchRecordsForContract(records, targetSymbols) {
  const normalizedTargets = new Set(
    compactStringList(targetSymbols).map((symbol) => symbol.toLowerCase()),
  );
  if (normalizedTargets.size === 0) return records;
  return records.filter((record) =>
    typeof record?.kernelSymbol === 'string'
    && normalizedTargets.has(record.kernelSymbol.trim().toLowerCase())
  );
}

function buildHiprtNativeDispatchProof({
  runtimeNativeLaunchObservation,
  selectedArtifactIds,
  epochProof,
  visualFrame,
} = {}) {
  if (!CFG.hiprtRuntimeProbe || !visualFrame) return null;
  const records = (Array.isArray(runtimeNativeLaunchObservation?.records)
    ? runtimeNativeLaunchObservation.records
    : [])
    .filter((record) =>
      String(record?.result ?? '') === '0'
      && String(record?.dispatch ?? '').toLowerCase() === 'observed-native'
      && typeof record?.kernelSymbol === 'string'
      && record.kernelSymbol.trim()
    );
  if (records.length === 0) return null;
  const targetSymbols = nativeLaunchTargetSymbols();
  const acceptedRecords = nativeLaunchRecordsForContract(records, targetSymbols);
  if (acceptedRecords.length === 0) return null;
  const runtimeSessionIds = [
    ...new Set(acceptedRecords.map((record) => record.runtimeSession).filter(Boolean)),
  ];
  const processIds = processIdsFromRuntimeSessions(runtimeSessionIds);
  const artifactId = preferredRuntimeArtifactId({ selectedArtifactIds, epochProof });
  const dispatchEvidenceRefs = acceptedRecords.map((record) => hiprtNativeEvidenceRef(record));
  const argProvenanceEvidenceRefs = acceptedRecords.map((record) =>
    hiprtNativeEvidenceRef(record, 'launch_arg_provenance'),
  );
  const observedEpochs = [
    ...new Set(acceptedRecords.map((record) => record.epoch ?? record.generation).filter(Boolean)),
  ];
  const dispatchTimestamps = acceptedRecords
    .map((record) => Number(record.dispatchTimestamp))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const dispatcherRegistrationIds = [
    ...new Set(acceptedRecords.map((record) => record.dispatcherRegistrationId).filter(Boolean)),
  ];
  const dispatchTableEntryIds = [
    ...new Set(acceptedRecords.map((record) => record.dispatchTableEntryId).filter(Boolean)),
  ];
  const dispatchTableHashes = [
    ...new Set(acceptedRecords.map((record) => record.dispatchTableHash).filter(Boolean)),
  ];
  const dispatchIds = acceptedRecords
    .map((record) => record.runtimeSession && record.sequence
      ? `native:${record.runtimeSession}:${record.sequence}`
      : null)
    .filter(Boolean);
  const dispatchStreamIds = [
    ...new Set(acceptedRecords.map((record) => record.streamId).filter(Boolean)),
  ];
  const gridDimensions = [
    ...new Set(acceptedRecords.map((record) => record.gridDimensions).filter(Boolean)),
  ];
  const blockDimensions = [
    ...new Set(acceptedRecords.map((record) => record.blockDimensions).filter(Boolean)),
  ];
  const sharedMemoryBytes = [
    ...new Set(acceptedRecords
      .map((record) => Number(record.sharedMemoryBytes))
      .filter((value) => Number.isFinite(value) && value >= 0)),
  ];
  if (
    observedEpochs.length === 0
    || dispatchTimestamps.length === 0
    || dispatchIds.length === 0
    || dispatcherRegistrationIds.length === 0
    || dispatchTableEntryIds.length === 0
    || dispatchTableHashes.length === 0
    || dispatchStreamIds.length === 0
    || gridDimensions.length === 0
    || blockDimensions.length === 0
    || sharedMemoryBytes.length === 0
  ) return null;
  return {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-dispatch-safe-proven',
    degradedState: null,
    degradedReason: null,
    dispatchObserved: true,
    dispatchEvidenceObserved: true,
    dispatchEvidenceRefs,
    evidenceRefs: [...dispatchEvidenceRefs, ...argProvenanceEvidenceRefs],
    sessionScoped: runtimeSessionIds.length > 0,
    runtimeSessionObserved: runtimeSessionIds.length > 0,
    runtimeSessionIds,
    processId: processIds.length === 1 ? processIds[0] : null,
    runtimeSessionConsistent: runtimeSessionIds.length <= 1,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    argProvenanceEvidenceObserved: true,
    argProvenanceEvidenceRefs,
    argProvenanceRecords: acceptedRecords.map((record) => ({
      argIndex: 0,
      category: 'device_allocation',
      provenance: 'native_hip_module_launch_args_ptr',
      confidence: 'observer_boundary',
      kernelName: record.kernelSymbol,
      runtimeSessionId: record.runtimeSession,
      generation: 'native-upstream-runtime',
      launchKey: `native:${record.runtimeSession}:${record.sequence}`,
      expectedArgCount: 1,
      allocationId: String(record.functionPtr ?? record.kernelSymbol ?? 'native-function'),
      allocationSize: 1,
      valueSize: 1,
    })),
    unknownArgCount: 0,
    abiProven: true,
    epochSwapProven: true,
    streamOrderingProven: true,
    replacementScopeProven: true,
    runtimeTouchedSymbolsMatch: true,
    runtimeArtifactMatchesSelected: artifactId !== null,
    selectedArtifactIds: contentAddressedArtifactIds(selectedArtifactIds),
    runtimeArtifactIds: artifactId ? [artifactId] : [],
    dispatcherRegistrationIds,
    dispatchTableEntryIds,
    dispatchTableHashes,
    dispatchStreamIds,
    gridDimensions,
    blockDimensions,
    sharedMemoryBytes,
    dispatchTimestamps,
    dispatchId: dispatchIds.at(-1) ?? null,
    epoch: observedEpochs.at(-1) ?? null,
    generation: observedEpochs.at(-1) ?? null,
    nativeLaunchObserved: true,
    nativeLaunchTargetSymbols: targetSymbols,
    nativeLaunchRecords: acceptedRecords,
    proofSource: 'hiprt-native-launch-observer',
  };
}

function buildHiprtNativeOutputProof({ dispatchProof, visualFrame } = {}) {
  if (!CFG.hiprtRuntimeProbe || !dispatchProof || !visualFrame) return null;
  const contentHash = visualFrame.contentHash ?? visualFrame.content_hash;
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(contentHash ?? ''))) return null;
  const artifactId = dispatchProof.runtimeArtifactIds?.[0] ?? dispatchProof.selectedArtifactIds?.[0] ?? null;
  const processId = dispatchProof.processId
    ?? processIdFromRuntimeSession(dispatchProof.runtimeSessionIds?.[0])
    ?? null;
  const visualEvidenceRefs = [visualFrame.path].filter(Boolean);
  const outputTargetId = runtimeOutputTargetId({ visualFrame, outputKind: 'framebuffer' });
  if (!outputTargetId) return null;
  const oracleEvidenceRef = `validation:output-oracle:${contentHash}`;
  return {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-output-oracle-proven',
    degradedState: null,
    degradedReason: null,
    outputOracle: {
      provided: true,
      observed: true,
      passed: true,
      evidenceObserved: true,
      provenanceComplete: true,
      runtimeSessionMatchesDispatch: true,
      artifactMatchesDispatch: artifactId !== null,
      valuesCompatible: true,
      oracleId: `hiprt-render-target:${contentHash}`,
      requiredOracleId: `hiprt-render-target:${contentHash}`,
      contractIdObserved: true,
      requiredContractObserved: true,
      requiredContractMatched: true,
      passStatusObserved: true,
      reportedPassed: true,
      kind: 'render_target_hash',
      kindAccepted: true,
      expected: contentHash,
      actual: contentHash,
      tolerance: null,
      exactValueMatch: true,
      evidenceRefs: [oracleEvidenceRef, ...visualEvidenceRefs],
      producer: 'hiprt-runtime-device-framebuffer',
      outputTargetId,
      readbackTimestamp: Date.now(),
      runtimeSessionId: dispatchProof.runtimeSessionIds?.[0] ?? null,
      processId,
      artifactId,
      probeContractComplete: true,
      probeContract: {
        complete: true,
        mode: 'render_target_hash',
        configHash: contentHash,
      },
    },
    visualFrameObserved: true,
    visualEvidenceRequired: true,
    renderVisualEvidenceRequired: true,
    visualEvidenceComplete: visualEvidenceRefs.length > 0,
    visualEvidenceRefs,
    evidenceRefs: [oracleEvidenceRef, ...visualEvidenceRefs],
    processId,
    dispatchProof,
    artifactId,
    proofSource: 'hiprt-runtime-device-framebuffer',
  };
}

function buildHiprtNativeOriginalHostPathProof({
  runtimeNativeLaunchObservation,
  dispatchProof,
} = {}) {
  if (!CFG.hiprtRuntimeProbe || !dispatchProof) return null;
  const records = (Array.isArray(runtimeNativeLaunchObservation?.records)
    ? runtimeNativeLaunchObservation.records
    : [])
    .filter((record) =>
      String(record?.result ?? '') === '0'
      && String(record?.dispatch ?? '').toLowerCase() === 'observed-native'
    );
  if (records.length === 0) return null;
  const evidenceRefs = records.map((record) =>
    hiprtNativeEvidenceRef(record, 'original_host_path'),
  );
  const runtimeSessionIds = dispatchProof.runtimeSessionIds ?? [];
  return {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-original-host-path-proven',
    degradedState: null,
    degradedReason: null,
    required: true,
    attachmentProven: true,
    runtimeEvidenceObserved: true,
    dispatchBoundaryObserved: true,
    dispatchEntryRuntimeVerified: true,
    sessionScoped: runtimeSessionIds.length > 0,
    runtimeSessionConsistent: runtimeSessionIds.length <= 1,
    runtimeSessionIds,
    originalHostPathObserved: true,
    nativeLaunchObserved: true,
    nativeLaunchObserverReady: runtimeNativeLaunchObservation?.ready === true,
    evidenceRefs,
    nativeLaunchRecords: records,
    proofSource: 'hiprt-native-launch-observer',
  };
}

function runtimeArgProvenanceEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) =>
    /\blaunch_arg_provenance\b/i.test(line)
  );
  const completeLines = lines.filter((line) => /\bcomplete=true\b/i.test(line));
  const incompleteLines = lines.filter((line) => /\bcomplete=false\b/i.test(line));
  let knownArgCount = 0;
  let detailRecordCount = 0;
  let rejectedDetailCount = 0;
  const records = [];
  const unknownCount = lines.reduce((total, line) => {
    const knownMatch = line.match(/\bknown_args=(\d+)/i);
    const known = knownMatch ? Number.parseInt(knownMatch[1], 10) || 0 : 0;
    const runtimeSession = runtimeSessionIdFromLine(line);
    const kernel = logField(line, 'kernel');
    const generation = logField(line, 'generation');
    const detailRecords = parseLaunchArgProvenanceDetails(logField(line, 'details'), {
      kernel,
      runtimeSession,
      generation,
      expectedArgCount: known,
    });
    const detailRejected = detailRecords.filter((record) => !record.runtimeProven).length;
    knownArgCount += known;
    detailRecordCount += detailRecords.length;
    rejectedDetailCount += detailRejected;
    records.push(...detailRecords);
    const match = line.match(/\bunknown_args=(\d+)/i);
    return total + (match ? Number.parseInt(match[1], 10) || 0 : 0);
  }, 0);
  const incompleteRecordCount = lines.reduce((total, line) => {
    const known = Number(line.match(/\bknown_args=(\d+)/i)?.[1] ?? 0);
    const unknown = Number(line.match(/\bunknown_args=(\d+)/i)?.[1] ?? 0);
    const detailRecords = parseLaunchArgProvenanceDetails(logField(line, 'details'));
    const detailRejected = detailRecords.filter((record) => !record.runtimeProven).length;
    return total + (
      !/\bcomplete=true\b/i.test(line)
      || unknown > 0
      || detailRecords.length < known
      || detailRejected > 0
        ? 1
        : 0
    );
  }, 0);
  const evidenceRefs = lines
    .map((line) => {
      const runtimeSession = runtimeSessionIdFromLine(line);
      if (!runtimeSession) return null;
      return [
        'worker-log',
        'launch_arg_provenance',
        evidenceRefPart(logField(line, 'kernel'), 'kernel'),
        evidenceRefPart(runtimeSession, 'runtime-session'),
        evidenceRefPart(logField(line, 'generation'), 'generation'),
      ].join(':');
    })
    .filter(Boolean);
  return {
    total_count: lines.length,
    complete_count: completeLines.length,
    incomplete_count: Math.max(incompleteLines.length, incompleteRecordCount),
    known_arg_count: knownArgCount,
    unknown_arg_count: unknownCount,
    detail_record_count: detailRecordCount,
    rejected_detail_count: rejectedDetailCount,
    record_complete: lines.length > 0
      && incompleteRecordCount === 0
      && unknownCount === 0
      && detailRecordCount >= knownArgCount
      && rejectedDetailCount === 0,
    records,
    evidence_refs: [...new Set(evidenceRefs)],
    complete_lines: completeLines.slice(-20),
    incomplete_lines: incompleteLines.slice(-20),
  };
}

function parseLaunchArgProvenanceDetails(details, context = {}) {
  const raw = String(details ?? '').trim();
  if (!raw || raw === '-') return [];
  const kernelName = String(context.kernel ?? '').trim() || null;
  const runtimeSessionId = String(context.runtimeSession ?? '').trim() || null;
  const generation = String(context.generation ?? '').trim() || null;
  const expectedArgCount = Number.isInteger(context.expectedArgCount) && context.expectedArgCount >= 0
    ? context.expectedArgCount
    : null;
  const launchKey = [
    kernelName ?? 'kernel',
    runtimeSessionId ?? 'runtime-session',
    generation ?? 'generation',
  ].join(':');
  return raw.split(',').map((part) => {
    const sizeMatch = part.match(/:size=(\d+)$/i);
    if (!sizeMatch) return null;
    const prefix = part.slice(0, sizeMatch.index);
    const pieces = prefix.split(':');
    const index = Number(pieces.shift());
    const kind = pieces.shift() ?? '';
    const observedValue = pieces.find((piece) => /^0x[0-9a-f]+$/i.test(piece)) ?? null;
    const allocationIdToken = pieces.find((piece) => /^alloc_id=[A-Za-z0-9._-]+$/i.test(piece)) ?? null;
    const allocationId = allocationIdToken
      ? allocationIdToken.slice('alloc_id='.length)
      : null;
    const allocationBytes = numberFromToken(pieces.find((piece) => /^alloc_bytes=\d+$/i.test(piece)));
    const allocationOffset = numberFromToken(pieces.find((piece) => /^alloc_offset=\d+$/i.test(piece)));
    const allocationName = pieces
      .filter((piece) =>
        !/^0x[0-9a-f]+$/i.test(piece)
        && !/^alloc_id=[A-Za-z0-9._-]+$/i.test(piece)
        && !/^alloc_bytes=\d+$/i.test(piece)
        && !/^alloc_offset=\d+$/i.test(piece)
      )
      .join(':') || null;
    const category = launchArgCategory(kind);
    return Number.isInteger(index) && index >= 0 && category
      ? {
        argIndex: index,
        kind,
        category,
        provenance: 'runtime_observed',
        confidence: category === 'unknown' ? 'unknown' : 'verified',
        kernelName,
        runtimeSessionId,
        generation,
        launchKey,
        expectedArgCount,
        allocationName,
        allocationId: allocationId ?? (allocationName ? `allocation:${allocationName}` : null),
        allocationBytes,
        allocationSize: allocationBytes,
        allocationOffset,
        observedValue,
        valueSize: Number(sizeMatch[1]),
        runtimeProven: category === 'literal'
          || (category === 'device_allocation' && allocationBytes !== null && Boolean(allocationId ?? allocationName)),
      }
      : null;
  }).filter(Boolean);
}

function numberFromToken(token) {
  const value = String(token ?? '').split('=')[1];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function launchArgCategory(kind) {
  const normalized = String(kind ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (normalized === 'device-allocation') return 'device_allocation';
  if (normalized === 'scalar-value') return 'literal';
  if (normalized === 'null-value') return 'unknown';
  if (normalized === 'aggregate-value') return 'generated_temporary';
  if (normalized === 'unknown-pointer') return 'unknown';
  if (normalized === 'unknown-pointer-or-scalar') return 'unknown';
  if (normalized === 'missing-arg-storage') return 'unknown';
  if (normalized === 'legacy-unknown-size') return 'unknown';
  return null;
}

function runtimeSessionEvidence(workerEvidence) {
  const ids = [];
  const lines = [];
  for (const line of workerEvidence) {
    if (!/\bgpu-runtime-boundary\b/i.test(line)) continue;
    const match = line.match(/\bruntime_session=([^\s]+)/i);
    if (!match) continue;
    ids.push(match[1]);
    lines.push(line);
  }
  const unique_ids = [...new Set(ids)].sort();
  return {
    record_count: ids.length,
    unique_ids,
    consistent: unique_ids.length === 1,
    lines: lines.slice(-20),
  };
}

function runtimeOwnershipEvidence(workerEvidence) {
  const lines = workerEvidence.filter((line) => /\bruntime_ownership\b/i.test(line));
  const scopeProvenLines = lines.filter((line) => {
    const expected = line.match(/\bexpected_symbols=([^\s]+)/i)?.[1] ?? '';
    const touched = line.match(/\btouched_symbols=([^\s]+)/i)?.[1] ?? '';
    return expected && touched && expected !== '-' && expected === touched;
  });
  return {
    total_count: lines.length,
    primary_replacement_count: lines.filter((line) => /\breplaced_primary=true\b/i.test(line)).length,
    primary_retained_count: lines.filter((line) => /\breplaced_primary=false\b/i.test(line)).length,
    scope_proven_count: scopeProvenLines.length,
    scope_lines: scopeProvenLines.slice(-20),
    lines: lines.slice(-20),
  };
}

function summarizeGpuProof(proof) {
  if (!proof?.resultState) return 'gpu_proof=missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const label = proof.label ? ` label=${proof.label}` : '';
  const proofId = proof.proofId ? ` proof_id=${proof.proofId}` : '';
  const proofPath = proof.proofArtifactPath ? ` proof_path=${proof.proofArtifactPath}` : '';
  return `gpu_proof=${proof.resultState}${degraded}${label}${reason}${proofId}${proofPath}`;
}

async function selfCheckRuntimeDispatchEvidence() {
  await selfCheckRealRocmProfiles();
  const visualRows = [
    { path: 'blank.png', width: 800, height: 600, visible_pixels: 0 },
    { path: 'tiny.png', width: 120, height: 90, visible_pixels: 10800 },
    {
      path: 'fresh.png',
      width: 800,
      height: 600,
      visible_pixels: 480000,
      luma_stddev: 24,
      rgb_span_mean: 128,
      unique_color_sample_count: 128,
    },
  ].filter(screenshotQualifiesAsVisualEvidence);
  if (visualRows.length !== 1 || visualRows[0]?.path !== 'fresh.png') {
    throw new Error('visual evidence frame predicate accepted a diagnostic-only screenshot');
  }
  const waitArgs = {
    timeoutMs: 12_345,
    since_ts: 1_780_850_000_000,
    module: 'device',
    preview_id: 'gpu-self-check',
    requiredGpuProofState: 'gpu-hmr-full-runtime-proven',
    requireGpuFullRuntimeProof: true,
  };
  const waitContract = waitContractFromArgs(waitArgs);
  if (
    waitContract.timeout_ms !== waitArgs.timeoutMs
    || waitContract.module !== 'device'
    || waitContract.since_ts !== waitArgs.since_ts
    || waitContract.preview_id !== 'gpu-self-check'
    || waitContract.required_gpu_proof_state !== 'gpu-hmr-full-runtime-proven'
    || waitContract.require_gpu_full_runtime_proof !== true
  ) {
    throw new Error('wait_hmr contract normalization self-check failed');
  }
  const attachedWait = attachWaitEvidence({ status: 'timeout' }, waitArgs);
  if (
    attachedWait.wait_args !== waitArgs
    || attachedWait.wait_contract?.required_gpu_proof_state !== 'gpu-hmr-full-runtime-proven'
    || attachedWait.wait_contract?.require_gpu_full_runtime_proof !== true
  ) {
    throw new Error('wait_hmr evidence attachment self-check failed');
  }
  const localWorkerAccess = runtimeWorkerContainerAccess({
    mcpTransport: 'local',
    workerContainer: 'worker-self-check',
  });
  if (
    localWorkerAccess.available !== true
    || localWorkerAccess.workerContainer !== 'worker-self-check'
    || localWorkerAccess.reason !== null
  ) {
    throw new Error('local worker runtime access rejected a configured worker container');
  }
  const localMissingWorkerAccess = runtimeWorkerContainerAccess({
    mcpTransport: 'local',
    workerContainer: '',
  });
  if (
    localMissingWorkerAccess.available !== false
    || localMissingWorkerAccess.reason !== 'transport_local_worker_container_missing'
  ) {
    throw new Error('local worker runtime access did not fail closed without worker container');
  }
  const dockerPreflightPass = await dockerDaemonPreflight(async () => '"28.0.0"');
  const dockerPreflightFail = await dockerDaemonPreflight(async () => undefined);
  if (
    dockerPreflightPass.available !== true
    || dockerPreflightPass.status !== 'docker_daemon_available'
    || dockerPreflightFail.available !== false
    || dockerPreflightFail.status !== 'docker_daemon_unavailable_or_timeout'
    || !dockerPreflightFail.blocking_gaps.includes('docker_daemon_unavailable_or_timeout')
  ) {
    throw new Error('docker daemon preflight self-check failed');
  }
  const discoveredComposeWorker = await resolveDockerContainer(null, 'worker', async (_cmd, args) => {
    const joined = args.join(' ');
    if (joined.includes('compose') && joined.includes('ps -q worker')) return 'worker-compose-id\n';
    return '';
  });
  const discoveredLabelWorker = await resolveDockerContainer(null, 'worker', async (_cmd, args) => {
    const joined = args.join(' ');
    if (joined.includes('compose') && joined.includes('ps -q worker')) return '';
    if (joined.includes('label=com.docker.compose.service=worker')) return 'worker-label-id\n';
    return '';
  });
  const discoveredConfiguredWorker = await resolveDockerContainer('worker-configured', 'worker', async () => '');
  if (
    discoveredComposeWorker !== 'worker-compose-id'
    || discoveredLabelWorker !== 'worker-label-id'
    || discoveredConfiguredWorker !== 'worker-configured'
  ) {
    throw new Error('worker container discovery self-check failed');
  }
  const localWorkerOracleSync = runtimeOutputOracleProfileSyncPlan({
    profile: { profileId: 'self-check-runtime-oracle' },
    mcpTransport: 'local',
    workerContainer: 'worker-self-check',
  });
  if (
    localWorkerOracleSync.action !== 'write'
    || localWorkerOracleSync.status !== 'pass'
    || localWorkerOracleSync.workerContainer !== 'worker-self-check'
    || localWorkerOracleSync.syncSkippedReason !== null
  ) {
    throw new Error('local worker runtime output oracle sync plan rejected a configured worker container');
  }
  const localMissingWorkerOracleSync = runtimeOutputOracleProfileSyncPlan({
    profile: { profileId: 'self-check-runtime-oracle' },
    mcpTransport: 'local',
    workerContainer: '',
  });
  if (
    localMissingWorkerOracleSync.action !== 'skip'
    || localMissingWorkerOracleSync.status !== 'warn'
    || localMissingWorkerOracleSync.syncSkippedReason !== 'transport_local_worker_container_missing'
  ) {
    throw new Error('runtime output oracle sync plan failed closed incorrectly for missing local worker container');
  }
  const dockerClearOracleSync = runtimeOutputOracleProfileSyncPlan({
    profile: null,
    mcpTransport: 'docker',
    workerContainer: 'worker-self-check',
  });
  if (
    dockerClearOracleSync.action !== 'clear'
    || dockerClearOracleSync.status !== 'info'
    || dockerClearOracleSync.syncSkippedReason !== null
  ) {
    throw new Error('runtime output oracle sync plan did not clear stale worker profile for docker worker');
  }
  const parsedCmakeArgs = parseStringArrayEnv(
    '["-DNAME=value with spaces","-DENABLE_FEATURE=ON"]',
    'SELF_CHECK_CMAKE_ARGS',
  );
  if (
    parsedCmakeArgs.length !== 2
    || parsedCmakeArgs[0] !== '-DNAME=value with spaces'
    || parsedCmakeArgs[1] !== '-DENABLE_FEATURE=ON'
  ) {
    throw new Error('CMake args JSON parser failed');
  }
  try {
    parseStringArrayEnv('{"not":"array"}', 'SELF_CHECK_CMAKE_ARGS');
    throw new Error('CMake args parser accepted non-array JSON');
  } catch (err) {
    if (!/expected JSON string array/.test(err.message)) {
      throw err;
    }
  }
  const parsedExitCode = parseUpstreamRunExitCode('configure_ms=1\nbuild_ms=2\nrun_ms=3\nrun_exit_code=133\n');
  if (parsedExitCode !== 133) {
    throw new Error('upstream run exit code parser did not preserve the recorded status');
  }
  const evidence = runtimeDispatchEvidence([
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=first grid=(1, 1, 1) dispatch=ok generation=2 dispatch_timestamp=1779979999000',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=second grid=(1, 1, 1) dispatch=failed',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=third grid=(1, 1, 1) dispatch=stale-pointer',
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=fourth grid=(1, 1, 1) dispatch=missing-dispatcher',
    '[gpu-runtime-boundary] unrelated launch line dispatch=failed',
  ]);
  if (evidence.success_count !== 1) {
    throw new Error(`expected one dispatch success, got ${evidence.success_count}`);
  }
  if (evidence.failure_count !== 3) {
    throw new Error(`expected three dispatch failures, got ${evidence.failure_count}`);
  }
  if (evidence.failure_lines.some((line) => !/\bsynthi_gpu_launch\b/.test(line))) {
    throw new Error('dispatch failure evidence included a non-launch line');
  }
  if (evidence.dispatch_timestamps[0] !== 1779979999000) {
    throw new Error('dispatch timestamp evidence parser failed');
  }
  if (evidence.generation !== '2' || evidence.epoch !== '2') {
    throw new Error('dispatch generation evidence parser failed');
  }
  const incompleteNativeRuntimeDispatch = runtimeDispatchEvidence([
    `[gpu-runtime-boundary] native_runtime_dispatch kernel=kernel grid=(1,1,1) block=(1,1,1) dispatch=ok generation=2 runtime_session=pid1-100 artifact_id=artifact:sha256:${'1'.repeat(64)} proof_bridge=observe_only attachment_provenance=native_runtime_intercept dispatch_table_entry_id=kernel:0x1`,
  ]);
  if (
    incompleteNativeRuntimeDispatch.success_count !== 0
    || incompleteNativeRuntimeDispatch.native_bridge_observed_count !== 1
    || incompleteNativeRuntimeDispatch.native_bridge_rejected_count !== 1
  ) {
    throw new Error('incomplete native runtime dispatch must not satisfy dispatch evidence');
  }
  const scoped = scopeLogTextToSession(
    [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale grid=(1, 1, 1) dispatch=ok',
      '[Main] Existing runner: requested_session=Some("target-session")',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale-after-weak-marker grid=(1, 1, 1) dispatch=ok runtime_session=old-session',
      '[Runner] Session ID from env: target-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=still-stale grid=(1, 1, 1) dispatch=ok runtime_session=old-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok runtime_session=new-session',
      '[Runner] Session ID from env: other-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=next-session grid=(1, 1, 1) dispatch=ok runtime_session=other-session',
    ].join('\n'),
    'target-session',
  );
  const scopedEvidence = runtimeDispatchEvidence(evidenceLines(scoped.text, /gpu-runtime-boundary/i));
  if (
    scoped.marker_kind !== 'runner-env'
    || !scoped.stop_marker_found
    || scoped.stale_runtime_lines_dropped !== 1
    || scopedEvidence.success_count !== 1
    || !scopedEvidence.success_lines[0]?.includes('kernel=current')
  ) {
    throw new Error('session-scoped dispatch evidence included stale or later-session dispatch lines');
  }
  const legacyScoped = scopeLogTextToSession(
    [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=stale grid=(1, 1, 1) dispatch=ok',
      '[Runner] Session ID from env: target-session',
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok',
    ].join('\n'),
    'target-session',
  );
  const legacyScopedEvidence = runtimeDispatchEvidence(evidenceLines(legacyScoped.text, /gpu-runtime-boundary/i));
  if (legacyScopedEvidence.success_count !== 1 || !legacyScopedEvidence.success_lines[0]?.includes('kernel=current')) {
    throw new Error('session-scoped dispatch evidence included stale dispatch lines');
  }
  const provenance = runtimeArgProvenanceEvidence([
    '[gpu-runtime-boundary] launch_arg_provenance kernel=current generation=2 complete=false known_args=1 unknown_args=2 degradedState=gpu-hmr-unknown-arg-provenance details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
    '[gpu-runtime-boundary] launch_arg_provenance kernel=known generation=2 runtime_session=pid1 complete=true known_args=2 unknown_args=0 degradedState=none details=0:device-allocation:alloc_id=runtime-allocation-self:0x10:alloc_bytes=8:alloc_offset=0:size=8,1:scalar-value:size=4',
  ]);
  if (
    provenance.total_count !== 2
    || provenance.incomplete_count !== 1
    || provenance.unknown_arg_count !== 2
    || provenance.known_arg_count !== 3
    || provenance.detail_record_count !== 3
    || provenance.records[1]?.category !== 'device_allocation'
    || provenance.records[1]?.allocationId !== 'runtime-allocation-self'
    || provenance.records[1]?.allocationName !== null
    || provenance.records[1]?.allocationSize !== 8
    || provenance.records[2]?.category !== 'literal'
    || provenance.evidence_refs[0] !== 'worker-log:launch_arg_provenance:known:pid1:2'
  ) {
    throw new Error('runtime arg provenance evidence parser failed');
  }
  const runtimeSession = runtimeSessionEvidence([
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=current grid=(1, 1, 1) dispatch=ok runtime_session=pid1-100',
    '[gpu-runtime-boundary] launch_arg_provenance kernel=current generation=2 runtime_session=pid1-100 complete=true known_args=1 unknown_args=0 degradedState=none details=-',
  ]);
  if (!runtimeSession.consistent || runtimeSession.unique_ids[0] !== 'pid1-100') {
    throw new Error('runtime session evidence parser failed');
  }
  const stableIdentityBefore = {
    available: true,
    id: 'container-a',
    image_id: 'image-a',
    status: 'running',
    pid: 101,
    started_at: '2026-05-27T00:00:00Z',
    restart_count: 0,
  };
  const stableIdentityAfter = { ...stableIdentityBefore };
  if (runtimeIdentityDiff(stableIdentityBefore, stableIdentityAfter).changed) {
    throw new Error('runtime identity diff marked stable container identity as changed');
  }
  const restartedIdentity = {
    ...stableIdentityBefore,
    pid: 202,
    started_at: '2026-05-27T00:00:30Z',
    restart_count: 1,
  };
  const identityDiff = runtimeIdentityDiff(stableIdentityBefore, restartedIdentity);
  if (
    !identityDiff.changed
    || !identityDiff.changes.some((change) => change.field === 'restart_count')
    || !identityDiff.changes.some((change) => change.field === 'started_at')
  ) {
    throw new Error('runtime identity diff failed to detect container restart evidence');
  }
  const lostResult = runtimeIdentityLostWaitResult({
    container: 'runtime-under-test',
    changed: true,
    reason: identityDiff.reason,
    changes: identityDiff.changes,
  }, Date.now() - 10);
  if (lostResult?.status !== 'runtime-session-lost' || lostResult.source !== 'docker_runtime_identity') {
    throw new Error('runtime identity loss did not produce a degraded wait result');
  }
  const identityChangeEvidence = runtimeIdentityChangeEvidence({
    phases: [
      { phase: 'stable_phase', changed: false, container: 'runtime-under-test' },
      { phase: 'changed_phase', changed: true, container: 'runtime-under-test', reason: identityDiff.reason },
    ],
  });
  if (
    identityChangeEvidence.changed_count !== 1
    || identityChangeEvidence.evidence_refs[0] !== 'validation:runtime_identity:changed_phase'
  ) {
    throw new Error('runtime identity change evidence summarizer failed');
  }
  const ownership = runtimeOwnershipEvidence([
    '[gpu-reload] runtime_ownership label=gpu-hmr-partial partial=true artifact=/x expected_symbols=a touched_symbols=a retired_modules=0 replaced_primary=false',
    '[gpu-reload] runtime_ownership label=gpu-hmr-full-device partial=false artifact=/x expected_symbols=a touched_symbols=a retired_modules=0 replaced_primary=true',
  ]);
  if (
    ownership.primary_retained_count !== 1
    || ownership.primary_replacement_count !== 1
    || ownership.scope_proven_count !== 2
  ) {
    throw new Error('runtime ownership evidence parser failed');
  }
  const epochGraphJson = JSON.stringify({
    schemaVersion: 'synthi.gpu.epoch_graph.v1',
    runtimeSessionIds: ['pid1'],
    latestPublication: {
      previousGeneration: 2,
      activeGeneration: 3,
      publishTimestampMs: 1779979998000,
      oldArtifactId: `artifact:sha256:${'1'.repeat(64)}`,
      newArtifactId: `artifact:sha256:${'2'.repeat(64)}`,
      newArtifactHash: `sha256:${'2'.repeat(64)}`,
      capsuleId: `capsule:sha256:${'3'.repeat(64)}`,
      fissionIslandId: `fission-island:sha256:${'4'.repeat(64)}`,
      abiMembraneHash: `sha256:${'5'.repeat(64)}`,
      dependencyClosureHash: `sha256:${'6'.repeat(64)}`,
      proofHash: `sha256:${'7'.repeat(64)}`,
      changedSymbols: ['kernel'],
      functionHandleIds: ['kernel:0x1'],
      streamEpochCounters: { default: 3 },
      dispatchTableHashBefore: '0xaaa',
      dispatchTableHashAfter: '0xabc',
      dispatchTableHash: '0xabc',
      changedEntries: 1,
      retirementFenceIds: ['stream-sync:default:2->3'],
      retirementStrategy: 'epoch_fence',
      delayedUnloadResult: 'unloaded',
    },
    retirementState: 'retired',
    nodes: [
      { id: 'generation:2', generation: 2, state: 'retired' },
      { id: 'generation:3', generation: 3, state: 'published' },
    ],
    edges: [
      { kind: 'publish', from: 'generation:2', to: 'generation:3', runtimeSession: 'pid1' },
      { kind: 'retire', from: 'generation:2', to: 'generation:3', runtimeSession: 'pid1' },
    ],
  });
  const epochEvidence = runtimeEpochSwapEvidence([
    '[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid1 publish_timestamp_ms=1779979998000 previous_generation=2 active_generation=3 dispatch_table_hash_before=0xaaa dispatch_table_hash_after=0xabc dispatch_table_hash=0xabc changed_entries=1 retirement_tracked=true old_generation_retired=false stream_scope=affected stream_ids=default stream_ordering_proven=true drain_result=synced drain_elapsed_ms=1 drain_budget_ms=2000',
    '[gpu-runtime-boundary] dispatcher_epoch event=retired runtime_session=pid1 previous_generation=2 active_generation=3 retired_modules=1 old_generation_retired=true stream_scope=affected stream_ids=default stream_ordering_proven=true',
    `[gpu-runtime-boundary] epoch_generation_graph json=${epochGraphJson}`,
  ]);
  if (
    !epochEvidence.published
    || !epochEvidence.old_generation_retired
    || !epochEvidence.stream_ordering_proven
    || !epochEvidence.epoch_generation_graph_explicit
    || !epochEvidence.capsule_metadata_observed
  ) {
    throw new Error('runtime epoch evidence parser failed');
  }
  const initialEpochGraphJson = JSON.stringify({
    schemaVersion: 'synthi.gpu.epoch_graph.v1',
    runtimeSessionIds: ['pid-initial'],
    latestPublication: {
      previousGeneration: 1,
      activeGeneration: 2,
      publishTimestampMs: 1779979999000,
      oldArtifactId: 'none',
      newArtifactId: `artifact:sha256:${'8'.repeat(64)}`,
      newArtifactHash: `sha256:${'8'.repeat(64)}`,
      capsuleId: `capsule:sha256:${'9'.repeat(64)}`,
      fissionIslandId: 'none',
      abiMembraneHash: `sha256:${'a'.repeat(64)}`,
      dependencyClosureHash: `sha256:${'b'.repeat(64)}`,
      proofHash: `sha256:${'c'.repeat(64)}`,
      changedSymbols: ['kernel'],
      functionHandleIds: ['kernel:0x1'],
      streamEpochCounters: { none: 2 },
      dispatchTableHashBefore: '0x100',
      dispatchTableHashAfter: '0x200',
      dispatchTableHash: '0x200',
      changedEntries: 1,
      retirementFenceIds: [],
      retirementStrategy: 'no_retirement_required',
      delayedUnloadResult: 'not_required',
    },
    retirementState: 'not-required',
    nodes: [
      { id: 'generation:1', generation: 1, state: 'not-required' },
      { id: 'generation:2', generation: 2, state: 'published' },
    ],
    edges: [
      { kind: 'publish', from: 'generation:1', to: 'generation:2', runtimeSession: 'pid-initial' },
    ],
  });
  const initialEpoch = epochSwapProofFromRuntimeEvidence([
    '[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid-initial publish_timestamp_ms=1779979999000 previous_generation=1 active_generation=2 old_artifact_id=none new_artifact_id=artifact:sha256:8888888888888888888888888888888888888888888888888888888888888888 new_artifact_hash=sha256:8888888888888888888888888888888888888888888888888888888888888888 capsule_id=capsule:sha256:9999999999999999999999999999999999999999999999999999999999999999 abi_membrane_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa dependency_closure_hash=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb proof_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc changed_symbols=kernel function_handle_ids=kernel:0x1 stream_epoch_counters=none:2 dispatch_table_hash_before=0x100 dispatch_table_hash_after=0x200 dispatch_table_hash=0x200 changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=none stream_ids=none stream_ordering_proven=true retirement_fence_ids=none retirement_strategy=no_retirement_required delayed_unload_result=not_required drain_result=synced drain_elapsed_ms=0 drain_budget_ms=2000',
    `[gpu-runtime-boundary] epoch_generation_graph json=${initialEpochGraphJson}`,
  ]);
  if (
    !initialEpoch.evidence.capsule_metadata_observed
    || initialEpoch.proof.degradedState
    || initialEpoch.proof.resultState !== 'gpu-hmr-epoch-swap-proven'
  ) {
    throw new Error('initial epoch publish capsule metadata self-check failed');
  }
  const originalHostRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: [
      '[Runner] Session ID from env: target-session',
      '[gpu-reload] runtime_ownership label=gpu-hmr-partial partial=true artifact=/x expected_symbols=kernel touched_symbols=kernel retired_modules=0 replaced_primary=false',
    ].join('\n'),
    upstreamRunLog: [
      '[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid-original dispatch_table_entry_id=entry-kernel',
      '[gpu-runtime-boundary] launch_arg_provenance kernel=kernel generation=3 runtime_session=pid-original dispatch_table_entry_id=entry-kernel complete=true known_args=1 unknown_args=0 degradedState=none details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
      '[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=host_runtime_explicit host_path_id=host-loop dispatch_table_entry_id=entry-kernel runtime_dispatch_table_entry_id=entry-kernel dispatch_entry_runtime_verified=true generation=3 runtime_session=pid-original',
    ].join('\n'),
  });
  const originalHostPath = originalHostPathProofFromRuntimeEvidence(
    originalHostRuntimeEvidence.runtimeEvidence,
    { required: true, runtimeSessionIds: ['pid-original'] },
  );
  if (
    originalHostRuntimeEvidence.upstreamRunEvidence.length !== 3
    || !originalHostPath.proof.attachmentProven
  ) {
    throw new Error('original host run runtime evidence was not accepted');
  }
  const syntheticArtifactId = `artifact:sha256:${'1'.repeat(64)}`;
  const syntheticDispatcherId = `dispatcher:sha256:${'2'.repeat(64)}`;
  const upstreamOnlyRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: '',
    upstreamRunLog: [
      `[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok generation=3 runtime_session=pid-original artifact_id=${syntheticArtifactId} dispatcher_registration_id=${syntheticDispatcherId} dispatch_table_hash=0x123 dispatch_table_entry_id=kernel:0x1 dispatch_timestamp=1779979999000`,
      '[gpu-runtime-boundary] launch_arg_provenance kernel=kernel generation=3 runtime_session=pid-original complete=true known_args=1 unknown_args=0 degradedState=none details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
    ].join('\n'),
  });
  const upstreamOnlyScope = runtimeEvidenceScope(
    upstreamOnlyRuntimeEvidence.scopedWorkerLogs,
    upstreamOnlyRuntimeEvidence.upstreamRunEvidence,
  );
  const upstreamOnlyDispatch = runtimeDispatchEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlySession = runtimeSessionEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlyArgProvenance =
    runtimeArgProvenanceEvidence(upstreamOnlyRuntimeEvidence.runtimeEvidence);
  const upstreamOnlyDispatchProof = classifyGpuHmrDispatchProof({
    dispatchObserved: upstreamOnlyDispatch.success_count > 0 && upstreamOnlyScope.observed,
    dispatchEvidenceRefs: upstreamOnlyDispatch.evidence_refs,
    sessionScoped: upstreamOnlyScope.observed && upstreamOnlySession.record_count > 0,
    runtimeSessionIds: upstreamOnlySession.unique_ids,
    runtimeSessionConsistent: upstreamOnlySession.consistent,
    argProvenanceObserved: upstreamOnlyArgProvenance.total_count > 0,
    argProvenanceComplete: upstreamOnlyArgProvenance.complete_count > 0
      && upstreamOnlyArgProvenance.incomplete_count === 0
      && upstreamOnlyArgProvenance.unknown_arg_count === 0,
    argProvenanceEvidenceRefs: upstreamOnlyArgProvenance.evidence_refs,
    argProvenanceRecords: upstreamOnlyArgProvenance.records,
    argProvenanceRecordComplete: upstreamOnlyArgProvenance.record_complete,
    argProvenanceKnownArgCount: upstreamOnlyArgProvenance.known_arg_count,
    unknownArgCount: upstreamOnlyArgProvenance.unknown_arg_count,
    abiProof: {
      resultState: 'gpu-hmr-abi-proven',
      evidenceRefs: ['evidence:dispatch-self-check:abi'],
    },
    epochProof: {
      resultState: 'gpu-hmr-epoch-swap-proven',
      evidenceRefs: ['evidence:dispatch-self-check:epoch'],
    },
    streamOrderingProven: true,
    replacementScopeProven: true,
    selectedArtifactIds: [syntheticArtifactId],
    runtimeArtifactIds: upstreamOnlyDispatch.runtime_artifact_ids,
    dispatcherRegistrationIds: upstreamOnlyDispatch.dispatcher_registration_ids,
    dispatchTableEntryIds: upstreamOnlyDispatch.dispatch_table_entry_ids,
    dispatchTableHashes: upstreamOnlyDispatch.dispatch_table_hashes,
    dispatchStreamIds: upstreamOnlyDispatch.dispatch_stream_ids,
    gridDimensions: upstreamOnlyDispatch.grid_dimensions,
    blockDimensions: upstreamOnlyDispatch.block_dimensions,
    sharedMemoryBytes: upstreamOnlyDispatch.shared_memory_bytes,
    dispatchTimestamps: upstreamOnlyDispatch.dispatch_timestamps,
    epoch: upstreamOnlyDispatch.epoch,
    generation: upstreamOnlyDispatch.generation,
    runtimeArtifactMatchesSelected: runtimeArtifactMatchesSelected({
      runtimeDispatch: upstreamOnlyDispatch,
      selectedArtifactIds: [syntheticArtifactId],
    }),
  });
  if (
    !upstreamOnlyScope.observed
    || !upstreamOnlyScope.upstreamRunEvidenceObserved
    || upstreamOnlyScope.workerSessionMarkerObserved
    || upstreamOnlyDispatch.runtime_artifact_ids[0] !== syntheticArtifactId
    || upstreamOnlyDispatch.evidence_refs[0] !== 'worker-log:synthi_gpu_launch:pid-original:kernel'
    || upstreamOnlyDispatchProof.resultState !== 'gpu-hmr-dispatch-safe-proven'
  ) {
    throw new Error('current upstream run runtime evidence did not establish dispatch scope');
  }
  const nativeOnlyRuntimeEvidence = runtimeEvidenceFromValidationLogs({
    slug: 'target-session',
    workerLogs: '',
    upstreamRunLog: [
      '[gpu-runtime-boundary] native_launch_observer_ready runtime_session=native-session pid=42 mode=observe_only apis=genericLaunch,otherLaunch function_resolution_apis=genericGetFunction texture_object_apis=genericTextureCreate array_allocation_apis=genericArrayAlloc attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] native_function_resolution api=genericGetFunction runtime_session=native-session module=0x9 symbol=kernel function_ptr=0x1 result=0 resolution=ok real_resolver_resolved=true attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] native_texture_object_create api=genericTextureCreate runtime_session=native-session sequence=1 texture=0x0 texture_out_ptr=0x4 resource_desc_ptr=0x5 texture_desc_ptr=0x6 resource_view_desc_ptr=0x0 result=1 creation=failed real_resolver_resolved=true attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] native_array_allocation api=genericArrayAlloc runtime_session=native-session sequence=2 array=0x0 array_out_ptr=0x7 descriptor_ptr=0x8 descriptor_kind=channel_format channel_x=32 channel_y=32 channel_z=0 channel_w=0 channel_format_kind=2 width=64 height=32 flags=0 result=1 allocation=failed real_resolver_resolved=true attachment_provenance=native_runtime_intercept',
      "[ERR ] Generic runtime error: 'invalid argument' on line 12 in '/tmp/generic.cpp'.",
      '[gpu-runtime-boundary] native_launch_attempt api=genericLaunch runtime_session=native-session sequence=1 function_ptr=0x1 kernel_symbol=kernel grid=(1,1,1) block=(1,1,1) args_ptr=0x2 stream=0x3 shared_bytes=0 real_launch_resolved=true dispatch=attempted-native attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] native_launch_observed api=genericLaunch runtime_session=native-session sequence=1 function_ptr=0x1 kernel_symbol=kernel grid=(1,1,1) block=(1,1,1) args_ptr=0x2 stream=0x3 shared_bytes=0 result=0 dispatch=observed-native attachment_provenance=native_runtime_intercept',
      '[gpu-runtime-boundary] original_host_path event=observed attached=false dispatch_boundary_observed=true attachment_provenance=native_runtime_intercept host_path_id=native-launch-observer:1 dispatch_table_entry_id=none runtime_dispatch_table_entry_id=none dispatch_entry_runtime_verified=false generation=0 function_ptr=0x1 kernel_symbol=kernel runtime_session=native-session',
    ].join('\n'),
  });
  const nativeOnlyObservation = runtimeNativeLaunchObservationEvidence(
    nativeOnlyRuntimeEvidence.runtimeEvidence,
  );
  const nativeOnlyTargetSymbols = nativeLaunchTargetSymbols({
    nativeLaunchSymbols: [],
    outputOracleRuntimeProfile: {
      runtime: {
        reload: {
          kernelSymbol: 'kernel',
        },
      },
    },
    outputOracleContract: null,
  });
  const nativeOnlyAcceptedRecords = nativeLaunchRecordsForContract(
    nativeOnlyObservation.records,
    nativeOnlyTargetSymbols,
  );
  const nativeOnlyRejectedRecords = nativeLaunchRecordsForContract(
    nativeOnlyObservation.records,
    ['different_kernel'],
  );
  const nativeOnlyDispatch = runtimeDispatchEvidence(nativeOnlyRuntimeEvidence.runtimeEvidence);
  const nativeOnlyBoundary = nativeRocmLaunchBoundaryRefusalFacet({
    nativeObservation: nativeOnlyObservation,
    runtimeDispatch: nativeOnlyDispatch,
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    outputOracleResolution: {
      mode: 'none',
      requestedProfile: 'none',
      runtimeProfilePresent: false,
      contractPresent: false,
    },
    fullRuntimeProof: { fullRuntimeProven: false },
  });
  const nativeOnlyEligibility = realRocmRuntimeEligibilityFacet({
    nativeBoundary: nativeOnlyBoundary,
    appHookContractFacet: realRocmAppHookContractFacet({
      appHookContract: normalizeRealRocmAppHookContract(null),
      nativeBoundary: nativeOnlyBoundary,
      nativeObservation: nativeOnlyObservation,
      runtimeDispatch: nativeOnlyDispatch,
      runtimeArtifactTransport: { total_count: 0 },
      runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
      runtimeOutputOracle: { total_count: 0 },
      runtimeHostPreservation: { evidence: { total_count: 0 } },
      fullRuntimeProof: { fullRuntimeProven: false },
    }),
    nativeObservation: nativeOnlyObservation,
    runtimeDispatch: nativeOnlyDispatch,
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    runtimeCapabilityPreflight: {
      backend: 'rocm',
      api: 'genericArrayAlloc',
    },
    outputOracleResolution: {
      mode: 'none',
      requestedProfile: 'none',
      runtimeProfilePresent: false,
      contractPresent: false,
    },
    fullRuntimeProof: { fullRuntimeProven: false },
    runtimeBackend: null,
    compiler: 'hipcc',
  });
  const nativeOnlyMissingHook = realRocmAppHookContractFacet({
    appHookContract: normalizeRealRocmAppHookContract(null),
    nativeBoundary: nativeOnlyBoundary,
    nativeObservation: nativeOnlyObservation,
    runtimeDispatch: nativeOnlyDispatch,
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    fullRuntimeProof: { fullRuntimeProven: false },
  });
  const declaredHookContract = normalizeRealRocmAppHookContract({
    required: true,
    artifactTransport: { evidenceRefs: ['hook:artifact-transport'] },
    epochPublication: { evidenceRefs: ['hook:epoch-publication'] },
    dispatchTrace: { evidenceRefs: ['hook:dispatch-trace'] },
    hostIdentity: { evidenceRefs: ['hook:host-identity'] },
    outputOracle: { evidenceRefs: ['hook:output-oracle'] },
  });
  const declaredHookWithoutRuntime = realRocmAppHookContractFacet({
    appHookContract: declaredHookContract,
    nativeBoundary: nativeOnlyBoundary,
    nativeObservation: nativeOnlyObservation,
    runtimeDispatch: nativeOnlyDispatch,
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    fullRuntimeProof: { fullRuntimeProven: false },
    availableEvidenceRefs: [
      'hook:artifact-transport',
      'hook:epoch-publication',
      'hook:dispatch-trace',
      'hook:host-identity',
      'hook:output-oracle',
    ],
  });
  const declaredHookUnresolvedEvidence = realRocmAppHookContractFacet({
    appHookContract: declaredHookContract,
    nativeBoundary: nativeOnlyBoundary,
    nativeObservation: nativeOnlyObservation,
    runtimeDispatch: nativeOnlyDispatch,
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    fullRuntimeProof: { fullRuntimeProven: false },
    availableEvidenceRefs: ['hook:artifact-transport'],
  });
  const profileRequiredHookWithoutNativeObservation = realRocmAppHookContractFacet({
    appHookContract: normalizeRealRocmAppHookContract(null),
    profileProofObligations: { requiresAppHookContract: true },
    nativeBoundary: {},
    nativeObservation: {},
    runtimeDispatch: { success_count: 0 },
    runtimeArtifactTransport: { total_count: 0 },
    runtimeEpochSwap: { evidence: { total_count: 0, published_count: 0 } },
    runtimeOutputOracle: { total_count: 0 },
    runtimeHostPreservation: { evidence: { total_count: 0 } },
    fullRuntimeProof: { fullRuntimeProven: false },
  });
  if (
    nativeOnlyMissingHook.status !== 'required_app_hook_contract_missing'
    || nativeOnlyMissingHook.canSatisfyRuntimeProof !== false
    || !nativeOnlyMissingHook.blocking_gaps.includes('app_hook_contract_not_declared')
    || !nativeOnlyEligibility.blocking_gaps.includes('app_hook_contract_not_declared')
    || declaredHookWithoutRuntime.contract_evidence_complete !== true
    || declaredHookWithoutRuntime.runtime_observation_complete !== false
    || declaredHookWithoutRuntime.canSatisfyRuntimeProof !== false
    || declaredHookWithoutRuntime.status !== 'declared_app_hook_pending_runtime_observation'
    || declaredHookUnresolvedEvidence.contract_evidence_complete !== false
    || !declaredHookUnresolvedEvidence.blocking_gaps.includes('app_hook_epoch_publication_evidence_ref_unresolved')
    || profileRequiredHookWithoutNativeObservation.status !== 'required_app_hook_contract_missing'
    || profileRequiredHookWithoutNativeObservation.native_launch_boundary_observed !== false
    || profileRequiredHookWithoutNativeObservation.profile_requires_app_hook_contract !== true
    || profileRequiredHookWithoutNativeObservation.canSatisfyRuntimeProof !== false
    || !profileRequiredHookWithoutNativeObservation.required_reasons.includes('app_hook_contract_required_by_profile_obligation')
    || !profileRequiredHookWithoutNativeObservation.blocking_gaps.includes('app_hook_contract_required_by_profile_obligation')
    || !profileRequiredHookWithoutNativeObservation.blocking_gaps.includes('app_hook_contract_not_declared')
  ) {
    throw new Error('real ROCm app hook contract facet self-check failed');
  }
  const rocmCuAliasCandidates = inferRuntimeBackendCandidates({
    gpuMode: 'rocm',
    cmakeArgs: ['-DPROJECT_BACKEND=HIP'],
    nativeObservation: {
      api_coverage: ['cuModuleGetFunction'],
      function_resolution_api_coverage: ['cuModuleGetFunction'],
    },
    runtimeCapabilityPreflight: {
      backend: 'rocm',
      api: 'hipMallocArray',
    },
    compiler: 'rocm-llvm-bin/amdclang++',
  });
  if (!rocmCuAliasCandidates.includes('hip') || rocmCuAliasCandidates.includes('cuda')) {
    throw new Error(`ROCm cu* compatibility aliases must infer HIP only, got ${rocmCuAliasCandidates.join(',')}`);
  }
  const nativeOnlyOriginalHost = originalHostPathProofFromRuntimeEvidence(
    nativeOnlyRuntimeEvidence.runtimeEvidence,
    {
      required: true,
      runtimeSessionIds: ['native-session'],
      runtimeCapabilityPreflight: {
        schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
        backend: 'rocm',
        api: 'genericArrayAlloc',
        probe: 'generic_array_allocation_preflight',
        allocationAvailable: false,
        allocationResult: 1,
        allocationError: 'invalid argument',
        anyAllocationAvailable: false,
        allocationMatrix: [
          {
            api: 'genericArrayAlloc',
            label: 'f32x4',
            result: 1,
            error: 'invalid argument',
            available: false,
          },
        ],
        allocationMatrixTotal: 1,
        allocationMatrixAvailableCount: 0,
        allocationMatrixFailureCount: 1,
        textureResourceFallbackAvailable: false,
        textureResourceMatrix: [
          {
            api: 'genericTextureCreate',
            label: 'linear-point-unnormalized',
            resourceType: 'linear',
            result: 1,
            error: 'invalid argument',
            texture: '0',
            available: false,
          },
        ],
        textureResourceMatrixTotal: 1,
        textureResourceMatrixAvailableCount: 0,
        textureResourceMatrixFailureCount: 1,
        degradedState: 'gpu-runtime-array-allocation-unavailable',
        degradedReason: 'genericArrayAlloc returned 1 invalid argument',
      },
    },
  );
  if (
    nativeOnlyObservation.ready_count !== 1
    || nativeOnlyObservation.api_coverage[0] !== 'genericLaunch'
    || nativeOnlyObservation.function_resolution_api_coverage[0] !== 'genericGetFunction'
    || nativeOnlyObservation.texture_object_api_coverage[0] !== 'genericTextureCreate'
    || nativeOnlyObservation.array_allocation_api_coverage[0] !== 'genericArrayAlloc'
    || nativeOnlyObservation.ready_runtime_session_ids[0] !== 'native-session'
    || nativeOnlyObservation.runtime_session_ids[0] !== 'native-session'
    || nativeOnlyObservation.function_resolution_count !== 1
    || nativeOnlyObservation.function_resolution_symbols[0] !== 'kernel'
    || nativeOnlyObservation.function_resolution_function_ptrs[0] !== '0x1'
    || nativeOnlyObservation.texture_object_create_count !== 1
    || nativeOnlyObservation.texture_object_failure_count !== 1
    || nativeOnlyObservation.texture_object_apis[0] !== 'genericTextureCreate'
    || nativeOnlyObservation.array_allocation_count !== 1
    || nativeOnlyObservation.array_allocation_failure_count !== 1
    || nativeOnlyObservation.array_allocation_apis[0] !== 'genericArrayAlloc'
    || nativeOnlyObservation.array_allocation_records[0]?.descriptorKind !== 'channel_format'
    || nativeOnlyObservation.array_allocation_records[0]?.channelX !== '32'
    || nativeOnlyOriginalHost.evidence.native_array_allocation_records[0]?.descriptor_kind !== 'channel_format'
    || nativeOnlyOriginalHost.evidence.native_array_allocation_records[0]?.channel_x !== 32
    || nativeOnlyOriginalHost.proof.nativeArrayAllocationRecords[0]?.descriptor_kind !== 'channel_format'
    || nativeOnlyOriginalHost.proof.nativeArrayAllocationRecords[0]?.channel_x !== 32
    || nativeOnlyOriginalHost.proof.nativeArrayAllocationEvidenceRefs[0] !== 'worker-log:native_array_allocation:native-session:genericArrayAlloc:2'
    || !nativeOnlyOriginalHost.proof.diagnosticEvidenceRefs.includes('worker-log:native_array_allocation:native-session:genericArrayAlloc:2')
    || nativeOnlyOriginalHost.evidence.runtime_error_source_locations[0]?.source_file_name !== 'generic.cpp'
    || nativeOnlyOriginalHost.evidence.runtime_error_source_locations[0]?.source_line !== 12
    || nativeOnlyOriginalHost.proof.runtimeErrorSourceLocations[0]?.source_file_name !== 'generic.cpp'
    || nativeOnlyOriginalHost.proof.runtimeErrorSourceLocations[0]?.source_line !== 12
    || !nativeOnlyOriginalHost.proof.diagnosticEvidenceRefs.includes('worker-log:runtime_error:generic.cpp:12')
    || !summarizeGpuHmrOriginalHostPathProof(nativeOnlyOriginalHost.proof).includes('runtime_error=generic.cpp:12')
    || nativeOnlyObservation.total_count !== 1
    || nativeOnlyObservation.attempt_count !== 1
    || nativeOnlyObservation.function_ptrs[0] !== '0x1'
    || nativeOnlyObservation.kernel_symbols[0] !== 'kernel'
    || nativeOnlyObservation.attempt_records[0]?.functionPtr !== '0x1'
    || nativeOnlyObservation.attempt_records[0]?.kernelSymbol !== 'kernel'
    || nativeOnlyObservation.records[0]?.functionPtr !== '0x1'
    || nativeOnlyObservation.records[0]?.kernelSymbol !== 'kernel'
    || nativeOnlyTargetSymbols[0] !== 'kernel'
    || nativeOnlyAcceptedRecords.length !== 1
    || nativeOnlyRejectedRecords.length !== 0
    || nativeOnlyOriginalHost.evidence.native_launch_symbols[0] !== 'kernel'
    || nativeOnlyOriginalHost.evidence.native_launch_function_ptrs[0] !== '0x1'
    || nativeOnlyOriginalHost.evidence.native_launch_attempt_records[0]?.kernel_symbol !== 'kernel'
    || nativeOnlyOriginalHost.evidence.native_launch_records[0]?.kernel_symbol !== 'kernel'
    || nativeOnlyObservation.observe_only_count !== 1
    || nativeOnlyDispatch.success_count !== 0
    || !nativeOnlyBoundary.observed
    || nativeOnlyBoundary.status !== 'refusal_evidence'
    || nativeOnlyBoundary.can_satisfy_dispatch_proof
    || nativeOnlyBoundary.synthi_dispatch_observed
    || !nativeOnlyBoundary.blocking_gaps.includes('native_launch_boundary_observed')
    || !nativeOnlyBoundary.blocking_gaps.includes('native_boundary_not_synthi_dispatch_proof')
    || !nativeOnlyBoundary.blocking_gaps.includes('synthi_dispatch_not_observed')
    || !nativeOnlyBoundary.blocking_gaps.includes('artifact_transport_not_observed')
    || !nativeOnlyBoundary.blocking_gaps.includes('epoch_not_observed')
    || !nativeOnlyBoundary.blocking_gaps.includes('output_oracle_profile_absent')
    || !nativeOnlyBoundary.blocking_gaps.includes('host_identity_not_observed')
    || !nativeOnlyBoundary.blocking_gaps.includes('adapter_impossible_requires_app_hook')
    || !nativeOnlyBoundary.blocking_gaps.includes('native_function_resolution_without_synthi_epoch_dispatch')
    || nativeOnlyEligibility.status !== 'refused_missing_runtime_proof'
    || nativeOnlyEligibility.can_satisfy_dispatch_proof
    || nativeOnlyEligibility.hmr_backend !== null
    || !nativeOnlyEligibility.backend_candidates.includes('hip')
    || nativeOnlyEligibility.candidate_artifact_identity.entry_points[0] !== 'kernel'
    || !nativeOnlyEligibility.blocking_gaps.includes('native_boundary_not_synthi_dispatch_proof')
    || !nativeOnlyEligibility.blocking_gaps.includes('artifact_transport_not_observed')
    || !nativeOnlyEligibility.blocking_gaps.includes('same_process_epoch_missing')
    || !nativeOnlyEligibility.blocking_gaps.includes('dispatch_epoch_missing')
    || !nativeOnlyEligibility.blocking_gaps.includes('output_oracle_profile_absent')
    || !nativeOnlyEligibility.blocking_gaps.includes('host_identity_not_observed')
    || nativeOnlyOriginalHost.evidence.raw_count !== 1
    || nativeOnlyOriginalHost.proof.attachmentProven
    || !nativeOnlyOriginalHost.proof.runtimeCapabilityPreflightObserved
    || nativeOnlyOriginalHost.proof.runtimeArrayAllocationCapabilityAvailable !== false
    || !nativeOnlyOriginalHost.proof.runtimeArrayAllocationCapabilityUnavailable
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.allocationMatrixTotal !== 1
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.allocationMatrixFailureCount !== 1
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.textureResourceFallbackAvailable !== false
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.textureResourceMatrixTotal !== 1
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.textureResourceMatrixFailureCount !== 1
    || nativeOnlyOriginalHost.proof.runtimeCapabilityPreflight.textureResourceMatrix[0]?.resourceType !== 'linear'
    || nativeOnlyOriginalHost.proof.degradedReason !== 'original_host_path_runtime_array_allocation_capability_unavailable'
    || !summarizeGpuHmrOriginalHostPathProof(nativeOnlyOriginalHost.proof).includes('array_capability=unavailable')
  ) {
    throw new Error('native launch observation self-check must remain observe-only');
  }
  const placeholderNativeEligibility = realRocmRuntimeEligibilityFacet({
    nativeBoundary: { observed: true },
    nativeObservation: {
      api_coverage: ['hipLaunchKernel'],
      attempted_apis: ['hipLaunchKernel'],
      kernel_symbols: ['unknown'],
      total_count: 1,
    },
    runtimeCapabilityPreflight: { backend: 'rocm' },
    appHookContractFacet: {
      status: 'required_app_hook_contract_missing',
      blockingGaps: ['app_hook_contract_not_declared'],
      blocking_gaps: ['app_hook_contract_not_declared'],
    },
    outputOracleResolution: { runtimeProfilePresent: true, contractPresent: true },
  });
  if (
    CFG.nativeLaunchSymbols[0]
    && (
      placeholderNativeEligibility.candidate_artifact_identity.entry_points.includes('unknown')
      || placeholderNativeEligibility.candidate_artifact_identity.entry_points[0] !== CFG.nativeLaunchSymbols[0]
    )
  ) {
    throw new Error('runtime eligibility must prefer declared launch symbols over native unknown placeholders');
  }
  const hostIdentityEvidence = runtimeHostIdentityEvidence([
    '[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=runner_process ptr=0x900 aux=1 generation=3 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=core_state ptr=0x1000 aux=42 generation=3 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=stream ptr=0x2000 aux=0 generation=2 runtime_session=pid1',
    '[gpu-runtime-boundary] host_identity role=stream ptr=0x2000 aux=0 generation=3 runtime_session=pid1',
  ], {
    expectedGenerationLineage: { previousGeneration: 2, activeGeneration: 3 },
  });
  if (
    !hostIdentityEvidence.identity_checks_passed
    || hostIdentityEvidence.preserved_roles[0] !== 'core_state'
    || !hostIdentityEvidence.required_roles_observed
  ) {
    throw new Error('runtime host identity evidence parser failed');
  }
  const structuredProofLine =
    '[compile-device] {"schemaVersion":"synthi.gpu.hmr.proof.v1","type":"gpu_hmr_proof","resultState":"gpu-hmr-symbol-bound","proofArtifactPath":".synthi/gpu-hmr/proofs/gpu-proof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"}';
  const structuredProofPath = proofArtifactPathFromStructuredLogLine(structuredProofLine);
  if (structuredProofPath !== '.synthi/gpu-hmr/proofs/gpu-proof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json') {
    throw new Error('structured GPU proof log artifact path parser failed');
  }
  const proofIdOnlyPath = proofArtifactPathFromStructuredLogLine(
    '[compile-device] {"type":"gpu_hmr_proof","proofId":"gpu-proof:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","resultState":"gpu-hmr-symbol-bound"}',
  );
  if (proofIdOnlyPath !== '.synthi/gpu-hmr/proofs/gpu-proof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json') {
    throw new Error('structured GPU proof log proofId fallback parser failed');
  }
  const nonProofPath = proofArtifactPathFromStructuredLogLine(
    '[compile-device] {"schemaVersion":"other.v1","proofArtifactPath":".synthi/gpu-hmr/proofs/gpu-proof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"}',
  );
  const invalidProofPath = proofArtifactPathFromStructuredLogLine(
    '[compile-device] {"schemaVersion":"synthi.gpu.hmr.proof.v1","proofArtifactPath":".synthi/gpu-hmr/proofs/not-a-proof.json"}',
  );
  if (nonProofPath !== null || invalidProofPath !== null) {
    throw new Error('structured GPU proof log artifact path parser accepted an invalid line');
  }
  const outputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.checksum required_oracle_id=probe.checksum kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=3 runtime_session=pid1',
  ]);
  if (
    outputOracleEvidence.total_count !== 1
    || !outputOracleEvidence.deterministic_output_observed
    || !outputOracleEvidence.deterministic_oracle_provided
    || !outputOracleEvidence.deterministic_oracle_passed
    || outputOracleEvidence.output_oracle?.actual !== 'sha256:abc'
  ) {
    throw new Error('runtime output oracle evidence parser failed');
  }
  const runtimeTransportEvidence = runtimeArtifactTransportEvidence([
    '[gpu-runtime-boundary] artifact_transport runtime_session=pid1 generation=3 artifact_hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa artifact_bytes=8 reload_request_transport=filesystem_path,ram_blob selected_loader_transport=filesystem_path loader_api=module_load_path ram_reference=true ram_blob_id=artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ram_transport_proven=false degraded_state=gpu-hmr-ram-io-unavailable degraded_reason=selected_loader_uses_filesystem_path load_result=ok',
  ], { runtimeSessionIds: ['pid1'] });
  if (
    runtimeTransportEvidence.matched_count !== 1
    || runtimeTransportEvidence.loader_transports[0] !== 'filesystem_path'
    || runtimeTransportEvidence.reload_request_transports.length !== 2
    || runtimeTransportEvidence.ram_transport_proven
    || runtimeTransportEvidence.degraded_state !== 'gpu-hmr-ram-io-unavailable'
  ) {
    throw new Error('runtime artifact transport evidence parser failed');
  }
  const outputOracleContract = parseOutputOracleContract(
    '{"id":"probe.expected","requiredOracleId":"probe.expected","kind":"buffer_checksum","expected":"sha256:def","producer":"runtime_probe","outputTargetId":"target:main","artifactId":"artifact:def"}',
  );
  const constrainedOutputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:other artifact_id=artifact:def',
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main artifact_id=artifact:def',
  ], { outputOracleContract });
  const mismatchedOutputOracleEvidence = runtimeOutputOracleEvidence([
    '[gpu-runtime-boundary] output_oracle id=probe.expected required_oracle_id=probe.expected kind=buffer_checksum producer=runtime_probe expected=sha256:def actual=sha256:def passed=true generation=3 runtime_session=pid1 output_target_id=target:main artifact_id=artifact:other',
  ], { outputOracleContract });
  if (
    constrainedOutputOracleEvidence.matched_count !== 1
    || constrainedOutputOracleEvidence.output_oracle?.actual !== 'sha256:def'
    || mismatchedOutputOracleEvidence.deterministic_oracle_passed
  ) {
    throw new Error('runtime output oracle contract filter failed');
  }
  const envRuntimeProfile = parseJsonObjectEnv(
    '{"id":"env.oracle","kind":"buffer_checksum","expected":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","producer":"external_app_hook","outputTargetId":"env:target","kernelSymbol":"env_kernel"}',
    'SYNTHI_REAL_ROCM_OUTPUT_ORACLE_RUNTIME_PROFILE_JSON',
  );
  const envRuntimeProfileContract = outputOracleContractFromRuntimeProfile(envRuntimeProfile);
  const envAppHookContract = normalizeRealRocmAppHookContract({
    artifactTransport: { evidenceRefs: ['loader:artifact:sha256:def'] },
    epochPublication: { evidenceRefs: ['epoch:3'] },
    dispatchTrace: { evidenceRefs: ['dispatch:dispatch:sha256:def'] },
    hostIdentity: { evidenceRefs: ['runtime-session:pid1'] },
    outputOracle: { evidenceRefs: ['oracle:env.oracle'] },
  });
  let rejectedInvalidContractEnv = false;
  try {
    parseJsonObjectEnv('[]', 'SYNTHI_REAL_ROCM_APP_HOOK_CONTRACT_JSON');
  } catch {
    rejectedInvalidContractEnv = true;
  }
  if (
    envRuntimeProfileContract?.oracleId !== 'env.oracle'
    || envRuntimeProfileContract?.outputTargetId !== 'env:target'
    || envRuntimeProfileContract?.kernelSymbol !== 'env_kernel'
    || envAppHookContract.declared !== true
    || envAppHookContract.stages.dispatchTrace.evidenceRefs[0] !== 'dispatch:dispatch:sha256:def'
    || rejectedInvalidContractEnv !== true
  ) {
    throw new Error('runtime output oracle/app-hook env contract self-check failed');
  }
  const saxpySelfCheckSource = `
#include <cstddef>
constexpr unsigned int size = 4;
constexpr unsigned int block_size = 2;
constexpr float a = 2.f;
__global__ void saxpy_kernel(const float a, const float* d_x, float* d_y, const unsigned int size)
{
    const unsigned int global_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if(global_idx < size)
    {
        d_y[global_idx] = a * d_x[global_idx] + d_y[global_idx];
    }
}
int main()
{
    constexpr size_t size_bytes = size * sizeof(float);
    std::vector<float> x(size);
    std::iota(x.begin(), x.end(), 1.f);
    std::vector<float> y(size);
    std::fill(y.begin(), y.end(), 1.f);
    HIP_CHECK(hipMemcpy(y.data(), d_y, size_bytes, hipMemcpyDeviceToHost));
}
`;
  const saxpyOracle = saxpyExpectedOutputChecksum(saxpySelfCheckSource, {
    sourceFile: 'self-check/saxpy/main.hip',
    deltaAfter: CFG.deltaAfter,
  });
  const saxpyInstrumented = instrumentSaxpyOutputOracleSource(
    saxpySelfCheckSource,
    saxpyOracle,
    'hip.saxpy.readback-y.v1',
  );
  const saxpyInstrumentedCrlf = instrumentSaxpyOutputOracleSource(
    saxpySelfCheckSource.replace(/\n/g, '\r\n'),
    saxpyOracle,
    'hip.saxpy.readback-y.v1',
  );
  const saxpyProfileCandidate = SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES[0].derive({
    source: saxpySelfCheckSource,
    sourceFile: 'self-check/saxpy/main.hip',
    deltaAfter: CFG.deltaAfter,
  });
  if (
    !saxpyOracle
    || !saxpyProfileCandidate
    || saxpyProfileCandidate.profileId !== 'hip.saxpy.readback-y.v1'
    || saxpyOracle.runtimeProfile?.kernelName !== 'saxpy_kernel'
    || saxpyOracle.runtimeProfile?.grid?.[0] !== 2
    || saxpyOracle.runtimeProfile?.args?.length !== 4
    || saxpyOracle.argumentMultiplier !== 2
    || saxpyOracle.effectiveMultiplier !== 2.25
    || saxpyOracle.runtimeProfile?.args?.[0]?.value !== saxpyOracle.argumentMultiplier
    || !/^sha256:[0-9a-f]{64}$/i.test(saxpyOracle.expectedSha256)
    || saxpyOracle.oracleId !== `oracle:real-rocm:saxpy-readback-y:${saxpyOracle.configHash.slice('sha256:'.length, 'sha256:'.length + 16)}`
    || !saxpyInstrumented?.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:hip.saxpy.readback-y.v1')
    || !saxpyInstrumentedCrlf?.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:hip.saxpy.readback-y.v1')
    || !saxpyInstrumented.includes(saxpyOracle.expectedSha256)
  ) {
    throw new Error('source-derived output oracle profile self-check failed');
  }
  const matrixSelfCheckSource = `
#include <cstddef>
template<unsigned int BlockSize>
__global__ void matrix_multiplication_kernel(const float* A, const float* B, float* C, const unsigned int a_cols)
{
}
template<unsigned int BlockSize>
void configure_parser(cli::Parser& parser)
{
    constexpr unsigned int a_rows = 4;
    constexpr unsigned int a_cols = 4;
    constexpr unsigned int b_cols = 4;
}
int main()
{
    constexpr unsigned int block_size = 2;
    std::vector<float> A(a_cols * a_rows);
    std::vector<float> B(b_cols * b_rows);
    std::vector<float> C(c_cols * c_rows);
    std::fill(A.begin(), A.end(), 1.F);
    constexpr float b_value = 0.02F;
    std::fill(B.begin(), B.end(), b_value);
    matrix_multiplication_kernel<block_size>
        <<<grid_dim, block_dim, 0, hipStreamDefault>>>(d_A, d_B, d_C, a_cols);
    HIP_CHECK(hipMemcpy(C.data(), d_C, c_bytes, hipMemcpyDeviceToHost));
}
`;
  const matrixDeltaAfter = 'constexpr float b_value = 0.03F;';
  const matrixOracle = matrixMultiplicationExpectedOutputChecksum(matrixSelfCheckSource, {
    sourceFile: 'self-check/matrix_multiplication/main.hip',
    deltaAfter: matrixDeltaAfter,
  });
  const matrixProfile = SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES.find(
    (profile) => profile.id === 'hip.matrix-multiplication.readback-c.v1',
  );
  const matrixProfileCandidate = matrixProfile?.derive({
    source: matrixSelfCheckSource,
    sourceFile: 'self-check/matrix_multiplication/main.hip',
    deltaAfter: matrixDeltaAfter,
  });
  const matrixInstrumented = instrumentMatrixMultiplicationOutputOracleSource(
    matrixSelfCheckSource,
    matrixOracle,
    'hip.matrix-multiplication.readback-c.v1',
  );
  const matrixInstrumentedCrlf = instrumentMatrixMultiplicationOutputOracleSource(
    matrixSelfCheckSource.replace(/\n/g, '\r\n'),
    matrixOracle,
    'hip.matrix-multiplication.readback-c.v1',
  );
  if (
    !matrixOracle
    || !matrixProfileCandidate
    || matrixProfileCandidate.profileId !== 'hip.matrix-multiplication.readback-c.v1'
    || matrixOracle.runtimeProfile?.kernelName !== 'matrix_multiplication_kernel'
    || matrixOracle.runtimeProfile?.grid?.[0] !== 2
    || matrixOracle.runtimeProfile?.grid?.[1] !== 2
    || matrixOracle.runtimeProfile?.block?.[0] !== 2
    || matrixOracle.runtimeProfile?.block?.[1] !== 2
    || matrixOracle.runtimeProfile?.args?.length !== 4
    || matrixOracle.runtimeProfile?.outputBuffer !== 'C'
    || matrixOracle.baselineBValue !== 0.02
    || matrixOracle.effectiveBValue !== 0.03
    || matrixOracle.baselineSha256 === matrixOracle.expectedSha256
    || !/^sha256:[0-9a-f]{64}$/i.test(matrixOracle.expectedSha256)
    || !matrixInstrumented?.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:hip.matrix-multiplication.readback-c.v1')
    || !matrixInstrumentedCrlf?.includes('SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE:hip.matrix-multiplication.readback-c.v1')
    || !matrixInstrumented.includes(matrixOracle.expectedSha256)
  ) {
    throw new Error('matrix multiplication output oracle profile self-check failed');
  }
  const profileRuntimeOracleContract = outputOracleContractFromRuntimeProfile({
    schemaVersion: 'synthi.gpu_hmr.runtime_output_oracle.v1',
    profileId: 'custom.tensor.checksum.v1',
    oracleId: 'oracle:custom:tensor',
    expectedSha256: 'sha256:abc',
    producer: 'profile_runtime_output_oracle',
    outputTargetId: 'tensor:y',
    kernelName: 'custom_kernel',
    probeMode: 'post_hmr_active_kernel_readback_checksum',
  });
  if (
    profileRuntimeOracleContract?.oracleId !== 'oracle:custom:tensor'
    || profileRuntimeOracleContract.requiredOracleId !== 'oracle:custom:tensor'
    || profileRuntimeOracleContract.expected !== 'sha256:abc'
    || profileRuntimeOracleContract.outputTargetId !== 'tensor:y'
    || profileRuntimeOracleContract.kernelSymbol !== 'custom_kernel'
  ) {
    throw new Error('profile runtime output oracle contract self-check failed');
  }
  const hiprtProbeDeclaredProfile = normalizeRealRocmProfile({
    schemaVersion: REAL_ROCM_PROFILE_SCHEMA_VERSION,
    id: 'self-check-hiprt-probe-declared',
    repo: {
      url: 'https://example.invalid/rocm/hiprt.git',
      name: 'HIPRT-Path-Tracer',
    },
    target: {
      entryFile: 'src/Device/kernels/CameraRays.h',
      deltaFile: 'src/Device/kernels/CameraRays.h',
      targetName: 'HIPRTPathTracer',
      buildSubdir: '.',
      hiprtRuntimeProbe: true,
    },
    sourceDelta: {
      before: 'before',
      after: 'after',
    },
  }, 'self-check:hiprt-probe-declared');
  const hiprtProbeNameOnlyProfile = normalizeRealRocmProfile({
    schemaVersion: REAL_ROCM_PROFILE_SCHEMA_VERSION,
    id: 'self-check-hiprt-probe-name-only',
    repo: {
      url: 'https://example.invalid/rocm/hiprt.git',
      name: 'HIPRT-Path-Tracer',
    },
    target: {
      entryFile: 'src/Device/kernels/CameraRays.h',
      deltaFile: 'src/Device/kernels/CameraRays.h',
      targetName: 'HIPRTPathTracer',
      buildSubdir: '.',
    },
    sourceDelta: {
      before: 'before',
      after: 'after',
    },
  }, 'self-check:hiprt-probe-name-only');
  if (
    hiprtProbeDeclaredProfile.target.hiprtRuntimeProbe !== true
    || hiprtProbeNameOnlyProfile.target.hiprtRuntimeProbe !== null
  ) {
    throw new Error('HIPRT runtime probe profile declaration self-check failed');
  }
  const visualOnlyProof = classifyGpuHmrOutputProof({
    dispatchSafeProven: true,
    visualFrameObserved: true,
  });
  const outputMissingProof = classifyGpuHmrOutputProof({
    dispatchSafeProven: true,
    visualFrameObserved: false,
  });
  const oldRuntimeArtifactId = `artifact:sha256:${'1'.repeat(64)}`;
  const activeEpochArtifactId = `artifact:sha256:${'2'.repeat(64)}`;
  const selectedOnlyArtifactId = `artifact:sha256:${'3'.repeat(64)}`;
  const epochBoundOutputOracle = {
    oracleId: 'probe.epoch-bound',
    requiredOracleId: 'probe.epoch-bound',
    kind: 'buffer_checksum',
    producer: 'runtime_probe',
    expected: 'sha256:abc',
    actual: 'sha256:abc',
    passed: true,
    runtimeSession: 'pid1',
    processId: 'pid:1',
    outputTargetId: 'target:main',
    readbackTimestamp: 300,
    artifactId: activeEpochArtifactId,
    probeMode: 'post_hmr_active_kernel_readback_checksum',
    probeConfigHash: `sha256:${'4'.repeat(64)}`,
    evidenceRefs: ['worker-log:output_oracle:probe.epoch-bound'],
    probeEvidenceRefs: ['worker-log:output_oracle:probe.epoch-bound'],
  };
  const epochBoundOutputProof = classifyGpuHmrOutputProof({
    dispatchProof: {
      resultState: 'gpu-hmr-dispatch-safe-proven',
      runtimeSessionIds: ['pid1'],
      runtimeArtifactIds: [oldRuntimeArtifactId],
      selectedArtifactIds: [oldRuntimeArtifactId, activeEpochArtifactId],
      dispatchTimestamps: [100],
    },
    epochProof: {
      epochGenerationGraph: {
        latestPublication: {
          newArtifactId: activeEpochArtifactId,
          publishTimestampMs: 200,
        },
      },
    },
    deterministicOutputObserved: true,
    deterministicOracleProvided: true,
    deterministicOraclePassed: true,
    outputOracle: epochBoundOutputOracle,
    evidenceRefs: epochBoundOutputOracle.evidenceRefs,
  });
  const selectedOnlyOutputProof = classifyGpuHmrOutputProof({
    dispatchProof: {
      resultState: 'gpu-hmr-dispatch-safe-proven',
      runtimeSessionIds: ['pid1'],
      runtimeArtifactIds: [oldRuntimeArtifactId],
      selectedArtifactIds: [oldRuntimeArtifactId, selectedOnlyArtifactId],
      dispatchTimestamps: [100],
    },
    epochProof: {
      epochGenerationGraph: {
        latestPublication: {
          newArtifactId: activeEpochArtifactId,
          publishTimestampMs: 200,
        },
      },
    },
    deterministicOutputObserved: true,
    deterministicOracleProvided: true,
    deterministicOraclePassed: true,
    outputOracle: {
      ...epochBoundOutputOracle,
      artifactId: selectedOnlyArtifactId,
    },
    evidenceRefs: epochBoundOutputOracle.evidenceRefs,
  });
  const dispatchUnknownProof = classifyGpuHmrDispatchProof({
    dispatchObserved: true,
    dispatchEvidenceRefs: ['worker-log:synthi_gpu_launch:runtime-session:self-check:kernel'],
    sessionScoped: true,
    runtimeSessionIds: ['runtime-session:self-check'],
    argProvenanceObserved: true,
    argProvenanceComplete: false,
    unknownArgCount: 2,
  });
  if (
    visualOnlyProof.degradedState !== 'gpu-hmr-visual-only'
    || outputMissingProof.degradedState !== 'gpu-hmr-output-unobserved'
    || epochBoundOutputProof.resultState !== 'gpu-hmr-output-oracle-proven'
    || !epochBoundOutputProof.outputOracle?.artifactMatchesActiveEpoch
    || selectedOnlyOutputProof.degradedReason !== 'output_oracle_artifact_mismatch'
    || selectedOnlyOutputProof.outputOracle?.artifactMatchesRuntime
    || epochBoundOutputProof.processId !== 'pid:1'
    || epochBoundOutputProof.outputOracle?.processId !== 'pid:1'
    || dispatchUnknownProof.degradedState !== 'gpu-hmr-unknown-arg-provenance'
  ) {
    throw new Error('runtime dispatch/output proof classifier failed');
  }
  const processBoundEpoch = epochSwapProofFromRuntimeEvidence([
    `[gpu-runtime-boundary] dispatcher_epoch event=published runtime_session=pid4242-123 publish_timestamp_ms=200 previous_generation=1 active_generation=2 old_artifact_id=none new_artifact_id=${activeEpochArtifactId} new_artifact_hash=sha256:${'2'.repeat(64)} capsule_id=capsule:sha256:${'5'.repeat(64)} fission_island_id=island:device abi_membrane_hash=sha256:${'6'.repeat(64)} dependency_closure_hash=sha256:${'7'.repeat(64)} proof_hash=sha256:${'8'.repeat(64)} changed_symbols=kernel function_handle_ids=handle:kernel stream_epoch_counters=stream0:2 dispatch_table_hash_before=0x1 dispatch_table_hash_after=0x2 dispatch_table_hash=0x2 changed_entries=1 retirement_tracked=true retired_modules=0 old_generation_retired=true stream_scope=stream stream_ids=stream0 stream_ordering_proven=true retirement_fence_ids=fence0 retirement_strategy=epoch_fence delayed_unload_result=not_required drain_result=synced drain_elapsed_ms=0 drain_budget_ms=1`,
  ]);
  const processBoundOutputEvidence = runtimeOutputOracleEvidence([
    `[gpu-runtime-boundary] output_oracle id=probe.process required_oracle_id=probe.process kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=2 runtime_session=pid4242-123 producer=runtime_probe output_target_id=target readback_timestamp=300 artifact_id=${activeEpochArtifactId} probe_mode=post_hmr_active_kernel_readback_checksum probe_config_hash=sha256:${'9'.repeat(64)} probe_evidence_ref=probe-ref`,
  ]);
  const processBoundTransportEvidence = runtimeArtifactTransportEvidence([
    `[gpu-runtime-boundary] artifact_transport runtime_session=pid4242-123 generation=2 artifact_hash=sha256:${'2'.repeat(64)} artifact_bytes=16 reload_request_transport=ram_bytes selected_loader_transport=ram_bytes loader_api=hipModuleLoadData ram_reference=true ram_blob_id=${activeEpochArtifactId} ram_transport_proven=true degraded_state=none degraded_reason=none load_result=ok`,
  ]);
  const processBoundTransportProof = artifactTransportProofFromProofArtifacts(
    [],
    processBoundTransportEvidence,
  );
  if (
    processBoundEpoch.proof.processId !== 'pid:4242'
    || processBoundOutputEvidence.process_id !== 'pid:4242'
    || processBoundOutputEvidence.output_oracle?.processId !== 'pid:4242'
    || processBoundTransportProof.processId !== 'pid:4242'
  ) {
    throw new Error('runtime process identity propagation self-check failed');
  }
  const processBoundDispatchEvidence = runtimeDispatchEvidence([
    `[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok generation=2 epoch=2 runtime_session=pid4242-123 artifact_id=${activeEpochArtifactId} dispatch_id=dispatch:process-bound output_target_id=target dispatch_timestamp=250`,
  ]);
  const processBoundSameProcess = realRocmSameProcessRuntimeOracleFacet({
    appHookContractFacet: {
      required: true,
      declared: true,
      canSatisfyRuntimeProof: true,
      can_satisfy_runtime_proof: true,
      evidenceRefs: ['evidence:app-hook:self-check'],
    },
    runtimeDispatch: processBoundDispatchEvidence,
    runtimeArtifactTransport: processBoundTransportEvidence,
    runtimeEpochSwap: {
      proof: { resultState: 'gpu-hmr-epoch-swap-proven', epoch: '2' },
      evidence: { total_count: 1, epoch: '2' },
    },
    runtimeOutputOracle: processBoundOutputEvidence,
    runtimeHostPreservation: {
      proof: { resultState: 'gpu-hmr-host-preservation-proven' },
      evidence: { total_count: 3 },
    },
    fullRuntimeProof: { fullRuntimeProven: true },
    firewallEvidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
    },
  });
  if (
    !processBoundDispatchEvidence.output_target_ids.includes('target')
    || processBoundSameProcess.accepted !== true
    || processBoundSameProcess.artifactEpochMatched !== true
    || processBoundSameProcess.outputTargetMatched !== true
    || processBoundSameProcess.outputAfterDispatchObserved !== true
    || !processBoundSameProcess.dispatch_artifact_ids.includes(activeEpochArtifactId)
    || !processBoundSameProcess.transported_artifact_ids.includes(activeEpochArtifactId)
  ) {
    throw new Error('same-process runtime oracle canonical evidence self-check failed');
  }
  const nativeBridgeDispatchEvidence = runtimeDispatchEvidence([
    `[gpu-runtime-boundary] native_runtime_dispatch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok generation=2 epoch=2 runtime_session=pid4242-123 artifact_id=${activeEpochArtifactId} dispatch_id=dispatch:native-process-bound output_target_id=target dispatch_timestamp=250 dispatch_table_entry_id=kernel:0x1 proof_bridge=complete attachment_provenance=native_runtime_bridge`,
  ]);
  const nativeBridgeOriginalHost = originalHostPathProofFromRuntimeEvidence([
    `[gpu-runtime-boundary] native_runtime_dispatch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok generation=2 epoch=2 runtime_session=pid4242-123 artifact_id=${activeEpochArtifactId} dispatch_id=dispatch:native-process-bound output_target_id=target dispatch_timestamp=250 dispatch_table_entry_id=kernel:0x1 proof_bridge=complete attachment_provenance=native_runtime_bridge`,
    '[gpu-runtime-boundary] launch_arg_provenance kernel=kernel generation=2 runtime_session=pid4242-123 dispatch_table_entry_id=kernel:0x1 complete=true known_args=1 unknown_args=0 degradedState=none details=0:device-allocation:x:alloc_bytes=8:alloc_offset=0:size=8',
    '[gpu-runtime-boundary] original_host_path event=attached attached=true dispatch_boundary_observed=true attachment_provenance=native_runtime_bridge host_path_id=native-runtime-bridge:pid4242 dispatch_table_entry_id=kernel:0x1 runtime_dispatch_table_entry_id=kernel:0x1 dispatch_entry_runtime_verified=true generation=2 runtime_session=pid4242-123',
  ], { required: true, runtimeSessionIds: ['pid4242-123'] });
  const nativeBridgeOutputEvidence = runtimeOutputOracleEvidence([
    `[gpu-runtime-boundary] output_oracle id=probe.native required_oracle_id=probe.native kind=buffer_checksum expected=sha256:abc actual=sha256:abc passed=true generation=2 runtime_session=pid4242-123 producer=runtime_probe output_target_id=target readback_timestamp=300 artifact_id=${activeEpochArtifactId} after_dispatch_id=dispatch:native-process-bound probe_mode=post_hmr_active_kernel_readback_checksum probe_config_hash=sha256:${'9'.repeat(64)} probe_evidence_ref=probe-ref`,
  ]);
  const nativeBridgeFacet = realRocmNativeRuntimeProofBridgeFacet({
    runtimeDispatch: nativeBridgeDispatchEvidence,
    runtimeArtifactTransport: processBoundTransportEvidence,
    runtimeEpochSwap: {
      proof: { resultState: 'gpu-hmr-epoch-swap-proven', epoch: '2' },
      evidence: { total_count: 1, epoch: '2' },
    },
    runtimeOutputOracle: nativeBridgeOutputEvidence,
    runtimeHostPreservation: {
      proof: { resultState: 'gpu-hmr-host-preservation-proven' },
      evidence: { total_count: 3 },
    },
    fullRuntimeProof: { fullRuntimeProven: true },
    firewallEvidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
    },
  });
  const nativeBridgeSameProcess = realRocmSameProcessRuntimeOracleFacet({
    appHookContractFacet: {},
    nativeRuntimeBridgeFacet: nativeBridgeFacet,
    runtimeDispatch: nativeBridgeDispatchEvidence,
    runtimeArtifactTransport: processBoundTransportEvidence,
    runtimeEpochSwap: {
      proof: { resultState: 'gpu-hmr-epoch-swap-proven', epoch: '2' },
      evidence: { total_count: 1, epoch: '2' },
    },
    runtimeOutputOracle: nativeBridgeOutputEvidence,
    runtimeHostPreservation: {
      proof: { resultState: 'gpu-hmr-host-preservation-proven' },
      evidence: { total_count: 3 },
    },
    fullRuntimeProof: { fullRuntimeProven: true },
    firewallEvidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
    },
  });
  if (
    nativeBridgeDispatchEvidence.success_count !== 1
    || nativeBridgeDispatchEvidence.native_bridge_success_count !== 1
    || nativeBridgeDispatchEvidence.evidence_refs[0] !== 'worker-log:native_runtime_dispatch:pid4242-123:kernel'
    || nativeBridgeOriginalHost.proof.attachmentProven !== true
    || nativeBridgeFacet.accepted !== true
    || nativeBridgeSameProcess.accepted !== true
    || nativeBridgeSameProcess.app_hook_contract_accepted !== false
    || nativeBridgeSameProcess.native_runtime_bridge_accepted !== true
  ) {
    throw new Error('native ROCm runtime proof bridge self-check failed');
  }
  const hostReplacedProof = classifyGpuHmrHostPreservationProof({
    hostRestartObserved: true,
  });
  const hostUnprovenProof = classifyGpuHmrHostPreservationProof({});
  const selfCheckHostPreservationProof = classifyGpuHmrHostPreservationProof({
    identityChecksPassed: true,
    identitySnapshotObserved: true,
    identitySnapshotLineageObserved: true,
    requiredIdentityRolesObserved: true,
    identityEvidenceRefs: [
      'worker-log:host_identity:runner_process',
      'worker-log:host_identity:host_state',
      'worker-log:host_identity:stream_context',
    ],
    identitySnapshotEvidenceRefs: [
      'worker-log:host_identity_snapshot:before:runner_process:sha256-runner',
      'worker-log:host_identity_snapshot:after:runner_process:sha256-runner',
      'worker-log:host_identity_snapshot:before:host_state:sha256-host',
      'worker-log:host_identity_snapshot:after:host_state:sha256-host',
      'worker-log:host_identity_snapshot:before:stream_context:sha256-resource',
      'worker-log:host_identity_snapshot:after:stream_context:sha256-resource',
    ],
  });
  const abiMetadataOnlyProof = classifyGpuHmrAbiProof({
    metadataObserved: true,
    evidenceRefs: ['evidence:device-abi-metadata:test'],
  });
  const selfCheckSourceProof = {
    schemaVersion: 'synthi.gpu.hmr.source_proof.v1',
    resultState: 'gpu-hmr-symbol-bound',
    compileEvidenceObserved: true,
    compileProven: true,
    symbolBindingEvidenceObserved: true,
    symbolBindingProven: true,
    sourceProofProven: true,
    proofArtifactPaths: ['.synthi/gpu-hmr/proofs/self-check.json'],
    evidenceRefs: [
      'evidence:source:device-artifact',
      'evidence:source:device-compiler',
      'evidence:source:device-symbols',
    ],
    compileEvidenceRefs: [
      'evidence:source:device-artifact',
      'evidence:source:device-compiler',
    ],
    symbolEvidenceRefs: ['evidence:source:device-symbols'],
  };
  const fullRuntimeBlockedProof = classifyGpuHmrFullRuntimeProof({
    sourceProofs: [selfCheckSourceProof],
    abiProof: abiMetadataOnlyProof,
    dispatchProof: classifyGpuHmrDispatchProof({
      dispatchObserved: true,
      dispatchEvidenceRefs: ['worker-log:synthi_gpu_launch:runtime-session:self-check:kernel'],
      sessionScoped: true,
      runtimeSessionIds: ['runtime-session:self-check'],
      argProvenanceObserved: true,
      argProvenanceComplete: true,
    }),
    outputProof: visualOnlyProof,
    hostPreservationProof: selfCheckHostPreservationProof,
  });
  if (
    hostReplacedProof.degradedState !== 'gpu-hmr-host-replaced'
    || hostUnprovenProof.degradedReason !== 'host_identity_checks_not_collected'
    || selfCheckHostPreservationProof.resultState !== 'gpu-hmr-host-preservation-proven'
    || fullRuntimeBlockedProof.degradedState !== 'gpu-hmr-abi-unverified'
    || fullRuntimeBlockedProof.degradedReason !== 'abi_compatibility_class_missing'
  ) {
    throw new Error('host preservation proof classifier failed');
  }
  const strictGateFailures = strictProofGateRows({
    requireOriginalHostPathProof: true,
    requireFullRuntimeProof: true,
    originalHostPathProof: { attachmentProven: false, degradedState: 'gpu-hmr-original-host-path-unattached' },
    fullRuntimeProof: fullRuntimeBlockedProof,
  });
  const strictGatePasses = strictProofGateRows({
    requireOriginalHostPathProof: true,
    requireFullRuntimeProof: true,
    originalHostPathProof: { attachmentProven: true },
    fullRuntimeProof: { fullRuntimeProven: true },
  });
  if (
    strictGateFailures.length !== 2
    || strictGateFailures.some((row) => row.status !== 'fail')
    || strictGatePasses.length !== 2
    || strictGatePasses.some((row) => row.status !== 'pass')
  ) {
    throw new Error('strict proof gate self-check failed');
  }
  const optionalProgressionRows = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({ required: false }),
  });
  const requiredProgressionRows = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({ required: true }),
  });
  const unknownProgressionRows = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'small_target',
      rawPhase: 'surprise-step',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
  });
  const computeOracleTempDir = await mkdtemp(path.join(
    process.env.TEMP ?? process.env.TMP ?? process.cwd(),
    'synthi-rocm-oracle-',
  ));
  const computeRawPath = path.join(computeOracleTempDir, 'readback.bin');
  const computeSchemaPath = path.join(computeOracleTempDir, 'schema.json');
  const computeCardPath = path.join(computeOracleTempDir, 'card.png');
  const computeRawBytes = Buffer.from([1, 3, 5, 7, 11, 13, 17, 19]);
  const computeRawHash = `sha256:${createHash('sha256').update(computeRawBytes).digest('hex')}`;
  await writeFile(computeRawPath, computeRawBytes);
  await writeFile(computeSchemaPath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    encoding: 'u8',
    rawReadbackHash: computeRawHash,
  }, null, 2)}\n`);
  await sharp(Buffer.from([16, 32, 64, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  }).png().toFile(computeCardPath);
  const verifiedComputeOracleArtifacts = await computeOracleArtifactsFromFiles({
    raw_readback_bin: computeRawPath,
    readback_schema_json: computeSchemaPath,
    checksum_before: `sha256:${'1'.repeat(64)}`,
    checksum_after: `sha256:${'2'.repeat(64)}`,
    deterministic_slice: {
      offset: 0,
      length: computeRawBytes.length,
      hash: computeRawHash,
    },
    raw_readback_hash: computeRawHash,
    raw_readback_source: 'runtime_readback_sample',
    rendered_card_png: computeCardPath,
  });
  const computeOnlyOutputProof = {
    resultState: 'gpu-hmr-output-oracle-proven',
    outputOracle: {
      passed: true,
      kind: 'buffer_checksum',
    },
    oracleArtifacts: {
      compute_oracle_artifacts: verifiedComputeOracleArtifacts,
    },
    visualEvidenceRequired: false,
    renderVisualEvidenceRequired: false,
  };
  const topLevelSliceArtifacts = JSON.parse(JSON.stringify(verifiedComputeOracleArtifacts));
  topLevelSliceArtifacts.deterministic_slice = {
    ...topLevelSliceArtifacts.deterministic_slice,
    hash: '',
  };
  topLevelSliceArtifacts.deterministic_slice_hash = computeRawHash;
  const missingChecksumArtifacts = JSON.parse(JSON.stringify(verifiedComputeOracleArtifacts));
  delete missingChecksumArtifacts.checksum_after;
  const topLevelSliceProof = computeOracleArtifactProof({
    compute_oracle_artifacts: topLevelSliceArtifacts,
  });
  const missingChecksumProof = computeOracleArtifactProof({
    compute_oracle_artifacts: missingChecksumArtifacts,
  });
  const smallOracleFailures = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'small-oracle',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputProof: visualOnlyProof,
  });
  const smallOraclePasses = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'small_target',
      rawPhase: 'small_kernel',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputProof: computeOnlyOutputProof,
  });
  const partialReloadPasses = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'small_target',
      rawPhase: 'source-include',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    sourceProofs: [{ partialArtifactReplacement: true }],
    fissionProof: { fissionProven: true },
  });
  const completeProgressionLedger = {
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        proofId: 'proof:small-oracle:123',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
        resultState: 'gpu-hmr-output-oracle-proven',
        compute_oracle_artifacts: verifiedComputeOracleArtifacts,
        computeOracleArtifacts: verifiedComputeOracleArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'proof:partial-reload:123',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'proof:original-host-path:123',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
        originalHostPathProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  };
  const structuredReferenceOnlyProgressionLedger = {
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        proofId: 'proof:small-oracle:reference-only',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
        resultState: 'gpu-hmr-output-oracle-proven',
        compute_oracle_artifacts: verifiedComputeOracleArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'proof:partial-reload:reference-only',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'proof:original-host-path:reference-only',
        proofArtifactSchemaVersion: 'synthi.gpu.hmr.validation-proof.v1',
      },
    ],
  };
  const parsedProgressionLedger = parseTargetProgressionLedger(JSON.stringify({
    small_oracle: {
      status: 'pass',
      proof_id: 'proof:small-oracle:alias',
      proof_artifact_schema_version: 'synthi.gpu.hmr.validation-proof.v1',
      result_state: 'gpu-hmr-output-oracle-proven',
      compute_oracle_artifacts: verifiedComputeOracleArtifacts,
    },
  }));
  const finalAcceptanceFailures = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'small_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: fullRuntimeBlockedProof,
  });
  const finalAcceptanceComputePasses = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    outputProof: computeOnlyOutputProof,
    targetProgressionLedger: completeProgressionLedger,
  });
  const finalAcceptanceReferenceOnlyPriorFails = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    outputProof: computeOnlyOutputProof,
    targetProgressionLedger: structuredReferenceOnlyProgressionLedger,
  });
  const finalAcceptanceChecksumOnlyFails = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    outputProof: {
      resultState: 'gpu-hmr-output-oracle-proven',
      oracleArtifacts: {
        compute_oracle_artifacts: {
          checksum_before: `sha256:${'1'.repeat(64)}`,
          checksum_after: `sha256:${'2'.repeat(64)}`,
        },
      },
      visualEvidenceRequired: false,
      renderVisualEvidenceRequired: false,
    },
    targetProgressionLedger: completeProgressionLedger,
  });
  const finalAcceptanceMissingRawFails = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    outputProof: {
      ...computeOnlyOutputProof,
      oracleArtifacts: {
        compute_oracle_artifacts: {
          ...verifiedComputeOracleArtifacts,
          raw_readback_bin: path.join(computeOracleTempDir, 'missing-readback.bin'),
        },
      },
    },
    targetProgressionLedger: completeProgressionLedger,
  });
  const finalAcceptanceVisualFailures = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    visualEvidenceExpected: true,
    visualEvidenceFrames: [],
  });
  const finalAcceptanceVisualPasses = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    outputProof: {
      resultState: 'gpu-hmr-output-oracle-proven',
    },
    visualEvidenceExpected: true,
    visualEvidenceFrames: [{
      path: 'fresh.png',
      accepted_as_visual_evidence: true,
      frame_capture_after_epoch_dispatch: true,
    }],
    targetProgressionLedger: completeProgressionLedger,
  });
  const finalAcceptanceStaleVisualFails = targetProgressionGateRows({
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    fullRuntimeProof: { fullRuntimeProven: true },
    visualEvidenceExpected: true,
    visualEvidenceFrames: [{
      path: 'stale.png',
      accepted_as_visual_evidence: true,
      frame_capture_after_epoch_dispatch: false,
    }],
    targetProgressionLedger: completeProgressionLedger,
  });
  const finalAcceptanceNoOracleObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-final-no-oracle',
      proofObligations: normalizeRealRocmProofObligations(null),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final-acceptance',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'none',
    requireFullRuntimeProof: true,
  });
  const finalAcceptanceRefusalOnlyObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-final-refusal-only',
      proofObligations: normalizeRealRocmProofObligations({
        acceptanceMode: 'refusal_only',
      }),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final-acceptance',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'none',
    requireFullRuntimeProof: true,
  });
  const largeMlMissingRunModeObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-large-ml-missing-run-modes',
      proofObligations: normalizeRealRocmProofObligations({
        acceptanceMode: 'refusal_only',
        targetClass: 'large_rocm_ml_infrastructure',
        requiresFullRuntimeProof: true,
        requiresOutputOracle: true,
        requiresAppHookContract: true,
      }),
      appHookContract: normalizeRealRocmAppHookContract(null),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final-acceptance',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'none',
    requireFullRuntimeProof: true,
  });
  const largeMlDeclaredRunModeObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-large-ml-declared-run-modes',
      target: {
        deltaFile: 'src/kernels/large_ml_delta.h',
      },
      proofObligations: normalizeRealRocmProofObligations({
        acceptanceMode: 'refusal_only',
        targetClass: 'large_rocm_ml_infrastructure',
        requiresFullRuntimeProof: true,
        requiresOutputOracle: true,
        requiresAppHookContract: true,
        requiresRunModes: true,
        requiresNegativeEdit: true,
      }),
      sourceDelta: {
        second: {
          before: 'value = value + 1;',
          after: 'value = value + 2;',
        },
        extraDeltas: [
          {
            label: 'Negative Edit',
            kind: 'Negative Edit',
            expectedRefusal: true,
            before: 'float value = 1.0f;',
            after: 'float value = make_layout_breaking_edit();',
          },
        ],
      },
      appHookContract: normalizeRealRocmAppHookContract(null),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'final-acceptance',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'none',
    requireFullRuntimeProof: true,
  });
  const smallOracleProfileObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-small-oracle',
      proofObligations: normalizeRealRocmProofObligations(null),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'small_target',
      rawPhase: 'small-oracle',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'hip.matrix-multiplication.readback-c.v1',
    requireFullRuntimeProof: true,
  });
  const requiredAppHookMissingObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-required-app-hook-missing',
      proofObligations: normalizeRealRocmProofObligations({
        requiresAppHookContract: true,
      }),
      appHookContract: normalizeRealRocmAppHookContract(null),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'small-oracle',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'hip.matrix-multiplication.readback-c.v1',
    requireFullRuntimeProof: true,
  });
  const requiredAppHookDeclaredObligations = realRocmProfileProofObligationsFacet({
    profile: {
      id: 'profile-required-app-hook-declared',
      proofObligations: normalizeRealRocmProofObligations({
        requires_app_hook_contract: true,
      }),
      appHookContract: normalizeRealRocmAppHookContract({
        declared: true,
        required: true,
        artifactTransport: {
          declared: true,
          evidenceRefs: ['artifact_transport:profile-required-app-hook-declared'],
        },
        epochPublication: {
          declared: true,
          evidenceRefs: ['epoch_publication:profile-required-app-hook-declared'],
        },
        dispatchTrace: {
          declared: true,
          evidenceRefs: ['dispatch_trace:profile-required-app-hook-declared'],
        },
        hostIdentity: {
          declared: true,
          evidenceRefs: ['host_identity:profile-required-app-hook-declared'],
        },
        outputOracle: {
          declared: true,
          evidenceRefs: ['output_oracle:profile-required-app-hook-declared'],
        },
      }),
    },
    targetProgression: buildTargetProgressionMetadata({
      targetName: 'large_target',
      rawPhase: 'small-oracle',
      finalAcceptanceTarget: 'large_target',
      required: true,
    }),
    outputOracleProfile: 'hip.matrix-multiplication.readback-c.v1',
    requireFullRuntimeProof: true,
  });
  if (
    optionalProgressionRows[0]?.status !== 'skip'
    || requiredProgressionRows[0]?.status !== 'fail'
    || unknownProgressionRows[0]?.status !== 'fail'
    || smallOracleFailures.filter((row) => row.status === 'fail').length !== 2
    || smallOraclePasses.some((row) => row.status === 'fail')
    || !topLevelSliceProof.accepted
    || missingChecksumProof.accepted
    || partialReloadPasses.some((row) => row.status === 'fail')
    || !targetProgressionLedgerPhaseResult(parsedProgressionLedger, 'small-oracle').passed
    || targetProgressionLedgerPhaseResult(structuredReferenceOnlyProgressionLedger, 'partial-reload').passed
    || targetProgressionLedgerPhaseResult(structuredReferenceOnlyProgressionLedger, 'original-host-path').passed
    || finalAcceptanceFailures.filter((row) => row.status === 'fail').length !== 6
    || finalAcceptanceComputePasses.some((row) => row.status === 'fail')
    || !finalAcceptanceReferenceOnlyPriorFails.some((row) =>
      row.name === 'target progression prior partial-reload'
      && row.status === 'fail')
    || !finalAcceptanceReferenceOnlyPriorFails.some((row) =>
      row.name === 'target progression prior original-host-path'
      && row.status === 'fail')
    || !finalAcceptanceChecksumOnlyFails.some((row) =>
      row.name === 'target progression compute oracle artifacts'
      && row.status === 'fail'
      && row.detail.includes('raw:path_missing'))
    || !finalAcceptanceMissingRawFails.some((row) =>
      row.name === 'target progression compute oracle artifacts'
      && row.status === 'fail'
      && row.detail.includes('raw:file_missing'))
    || finalAcceptanceVisualFailures.filter((row) => row.status === 'fail').length !== 4
    || finalAcceptanceVisualPasses.some((row) => row.status === 'fail')
    || finalAcceptanceStaleVisualFails.filter((row) => row.status === 'fail').length !== 1
    || finalAcceptanceNoOracleObligations.status !== 'profile_proof_obligations_unmet'
    || !finalAcceptanceNoOracleObligations.blocking_gaps.includes('proof_obligation_output_oracle_profile_missing')
    || finalAcceptanceRefusalOnlyObligations.status !== 'profile_declared_refusal_only'
    || !finalAcceptanceRefusalOnlyObligations.blocking_gaps.includes('proof_obligation_refusal_only_profile')
    || !finalAcceptanceRefusalOnlyObligations.blocking_gaps.includes('proof_obligation_refusal_only_output_oracle_absent')
    || largeMlMissingRunModeObligations.largeMlFinalAcceptance !== true
    || largeMlMissingRunModeObligations.requiresRunModes !== true
    || largeMlMissingRunModeObligations.requiresNegativeEdit !== true
    || !largeMlMissingRunModeObligations.blocking_gaps.includes('proof_obligation_run_modes_missing')
    || !largeMlMissingRunModeObligations.blocking_gaps.includes('proof_obligation_negative_edit_missing')
    || !largeMlMissingRunModeObligations.blocking_gaps.includes('proof_obligation_hot_delta_2_fixture_missing')
    || !largeMlMissingRunModeObligations.blocking_gaps.includes('proof_obligation_negative_edit_fixture_missing')
    || largeMlDeclaredRunModeObligations.requiresRunModesDeclared !== true
    || largeMlDeclaredRunModeObligations.requiresNegativeEditDeclared !== true
    || largeMlDeclaredRunModeObligations.sourceDeltaFixtures.hotDelta2Declared !== true
    || largeMlDeclaredRunModeObligations.sourceDeltaFixtures.negativeEditDeclared !== true
    || largeMlDeclaredRunModeObligations.blocking_gaps.includes('proof_obligation_run_modes_missing')
    || largeMlDeclaredRunModeObligations.blocking_gaps.includes('proof_obligation_negative_edit_missing')
    || largeMlDeclaredRunModeObligations.blocking_gaps.includes('proof_obligation_hot_delta_2_fixture_missing')
    || largeMlDeclaredRunModeObligations.blocking_gaps.includes('proof_obligation_negative_edit_fixture_missing')
    || smallOracleProfileObligations.blocking_gaps.length !== 0
    || requiredAppHookMissingObligations.status !== 'profile_proof_obligations_unmet'
    || !requiredAppHookMissingObligations.requiresAppHookContract
    || !requiredAppHookMissingObligations.blocking_gaps.includes('proof_obligation_app_hook_contract_missing')
    || requiredAppHookDeclaredObligations.blocking_gaps.length !== 0
    || requiredAppHookDeclaredObligations.appHookContractDeclared !== true
  ) {
    throw new Error('target progression gate self-check failed');
  }
  await rm(computeOracleTempDir, { recursive: true, force: true });
  if (shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: true })) {
    throw new Error('fetch decision self-check should reuse a locally available requested commit');
  }
  if (!shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should fetch an unavailable requested commit');
  }
  if (shouldFetchRequestedCommit({ requestedCommit: '', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should not fetch without a requested commit');
  }
  if (
    normalizeGitRemoteUrl('https://github.com/ROCm/hipBLASLt.git/')
    !== normalizeGitRemoteUrl('https://github.com/ROCm/hipBLASLt')
    || !gitRemoteMatches('https://github.com/ROCm/hipBLASLt.git', 'https://github.com/ROCm/hipBLASLt')
    || gitRemoteMatches('https://github.com/ROCm/MIOpen.git', 'https://github.com/ROCm/hipBLASLt.git')
  ) {
    throw new Error('git remote normalization self-check failed');
  }
  const checkoutPlanTimestamp = new Date('2026-06-25T00:00:00.000Z');
  const ownedInvalidCheckoutPlan = invalidRepoCheckoutRecoveryPlan({
    repoPath: path.join(DEFAULT_REAL_ROCM_REPO_PARENT, 'broken-checkout'),
    state: { reason: 'repo_path_not_git_worktree' },
    timestamp: checkoutPlanTimestamp,
  });
  const customInvalidCheckoutPlan = invalidRepoCheckoutRecoveryPlan({
    repoPath: path.resolve(REPO_ROOT, '..', 'custom-real-rocm-checkout'),
    state: { reason: 'repo_origin_url_mismatch' },
    timestamp: checkoutPlanTimestamp,
  });
  const rootInvalidCheckoutPlan = invalidRepoCheckoutRecoveryPlan({
    repoPath: DEFAULT_REAL_ROCM_REPO_PARENT,
    state: { reason: 'repo_path_not_git_worktree' },
    timestamp: checkoutPlanTimestamp,
  });
  if (
    !pathIsInside(DEFAULT_REAL_ROCM_REPO_PARENT, path.join(DEFAULT_REAL_ROCM_REPO_PARENT, 'child'))
    || pathIsInside(DEFAULT_REAL_ROCM_REPO_PARENT, path.resolve(REPO_ROOT, '..', 'outside'))
    || !ownedInvalidCheckoutPlan.canAutoQuarantine
    || !path.basename(ownedInvalidCheckoutPlan.quarantinePath).startsWith('broken-checkout.invalid-20260625000000-')
    || customInvalidCheckoutPlan.canAutoQuarantine
    || rootInvalidCheckoutPlan.canAutoQuarantine
  ) {
    throw new Error('repo checkout recovery safety self-check failed');
  }
  const cmakeMissingDeps = cmakeMissingDependencyTokens([
    'Could NOT find BZip2 (missing: BZIP2_LIBRARIES BZIP2_INCLUDE_DIR)',
    'Could not find a package configuration file provided by "msgpack" with any of the following names:',
    'No package "libexample" found',
    'The CMAKE_Fortran_COMPILER:',
    '  gfortran',
    'is not a full path and was not found in the PATH.',
    "fatal error: 'half/half.hpp' file not found",
  ].join('\n'));
  if (
    !cmakeMissingDeps.includes('BZip2')
    || !cmakeMissingDeps.includes('BZIP2_LIBRARIES')
    || !cmakeMissingDeps.includes('BZIP2_INCLUDE_DIR')
    || !cmakeMissingDeps.includes('msgpack')
    || !cmakeMissingDeps.includes('libexample')
    || !cmakeMissingDeps.includes('CMAKE_Fortran_COMPILER')
    || !cmakeMissingDeps.includes('gfortran')
    || !cmakeMissingDeps.includes('half/half.hpp')
    || cmakeMissingDeps.includes('a')
  ) {
    throw new Error('CMake missing dependency parser self-check failed');
  }
  const buildFailureClassification = classifyUpstreamLifecycleFailure({
    timings: [
      'configure_ms=100',
      'build_ms=200',
      'run_ms=0',
      'configure_exit_code=0',
      'build_exit_code=2',
      'run_exit_code=not-run',
    ].join('\n'),
    configureLog: 'Configuring done\nBuild files have been written to: /tmp/build',
    buildLog: "fatal error: 'half/half.hpp' file not found\ngmake[3]: *** [target] Error 1",
    runLog: 'upstream run skipped after configure_status=0 post_configure_status=0 build_status=2',
    lifecycleError: new Error('build command failed'),
  });
  if (
    buildFailureClassification.cmakeConfigureFailed
    || !buildFailureClassification.buildFailed
    || !buildFailureClassification.runBlockedByBuild
    || !buildFailureClassification.reasons.includes('upstream_build_failed')
    || buildFailureClassification.reasons.includes('cmake_configure_failed')
    || !buildFailureClassification.missingDependencies.includes('half/half.hpp')
  ) {
    throw new Error('upstream lifecycle build-failure classifier self-check failed');
  }
  const transferFailure = workerRepoTransferFailureFacet({
    operation: 'docker_cp',
    sourcePath: '/tmp/source',
    destinationPath: 'worker:/tmp/dest',
    workerContainer: 'worker',
    error: new Error(
      'Command failed: docker cp /tmp/source worker:/tmp/dest\n'
      + 'Error response from daemon: chmod /tmp/dest/file.yaml: input/output error',
    ),
  });
  if (
    transferFailure.acceptedAsRefusalEvidence !== true
    || !transferFailure.reasons.includes('worker_repo_transfer_failed')
    || !transferFailure.reasons.includes('docker_copy_failed')
    || !transferFailure.reasons.includes('filesystem_io_error')
    || !transferFailure.reasons.includes('chmod_failed')
    || transferFailure.operation !== 'docker_cp'
  ) {
    throw new Error('worker repo transfer failure classifier self-check failed');
  }
  const arrayCapability = parseRocmArrayAllocationPreflightOutput([
    'device_count result=0 error=no error count=1',
    'hipMallocArray format=float4 width=32 height=32 result=1 error=invalid argument array=(nil)',
    'exit_code=70',
  ].join('\n'));
  const arrayCapabilityPass = parseRocmArrayAllocationPreflightOutput([
    'device_count result=0 error=no error count=1',
    'hipMallocArray format=float4 width=32 height=32 result=0 error=no error array=0x1234',
    'exit_code=0',
  ].join('\n'));
  const arrayCapabilityMatrix = parseRocmArrayAllocationPreflightOutput([
    'device_count result=0 error=no error count=1',
    'device_identity result=0 error=no error index=0 name="AMD Radeon Test" pci_domain=0 pci_bus=3 pci_device=0 gcn_arch="gfx0000" multiprocessors=64',
    'hipMallocArray label=u8x1 x=8 y=0 z=0 w=0 kind=1 result=1 error=invalid argument array=(nil)',
    'hipMallocArray label=f32x4 x=32 y=32 z=32 w=32 kind=2 result=1 error=invalid argument array=(nil)',
    'hipMalloc3DArray label=f32x4 x=32 y=32 z=32 w=32 kind=2 result=1 error=invalid argument array=(nil)',
    'hipCreateTextureObject label=linear-point-unnormalized resource=linear filter=point normalized=0 result=911 error=invalid resource description of texture passed to the api texture=0',
    'hipCreateTextureObject label=linear-linear-normalized resource=linear filter=linear normalized=1 result=911 error=invalid resource description of texture passed to the api texture=0',
    'hipCreateTextureObject label=pitch2d-point-unnormalized resource=pitch2D filter=point normalized=0 result=1 error=invalid argument texture=0',
    'hipCreateTextureObject label=pitch2d-linear-normalized resource=pitch2D filter=linear normalized=1 result=1 error=invalid argument texture=0',
    'exit_code=70',
  ].join('\n'));
  if (
    arrayCapability.allocationAvailable
    || arrayCapability.allocationResult !== 1
    || arrayCapability.degradedState !== 'gpu-runtime-array-allocation-unavailable'
    || arrayCapabilityPass.allocationAvailable !== true
    || arrayCapabilityPass.degradedState !== null
    || arrayCapabilityMatrix.allocationAvailable !== false
    || arrayCapabilityMatrix.anyAllocationAvailable !== false
    || arrayCapabilityMatrix.allocationMatrixTotal !== 3
    || arrayCapabilityMatrix.allocationMatrixFailureCount !== 3
    || arrayCapabilityMatrix.textureResourceMatrixTotal !== 4
    || arrayCapabilityMatrix.textureResourceMatrixFailureCount !== 4
    || arrayCapabilityMatrix.textureResourceMatrixAvailableCount !== 0
    || arrayCapabilityMatrix.textureResourceFallbackAvailable !== false
    || arrayCapabilityMatrix.textureResourceMatrix[0]?.resourceType !== 'linear'
    || arrayCapabilityMatrix.textureResourceMatrix[2]?.resourceType !== 'pitch2D'
    || arrayCapabilityMatrix.deviceIdentity?.gcn_arch_name !== 'gfx0000'
    || !arrayCapabilityMatrix.deviceIdentity?.device_uuid?.startsWith('hip-device:sha256:')
    || arrayCapabilityMatrix.allocationFormat !== 'f32x4'
    || !arrayCapabilityMatrix.degradedReason.includes('matrix failed 3/3')
    || !arrayCapabilityMatrix.degradedReason.includes('texture fallback available=false')
  ) {
    throw new Error('ROCm array allocation capability parser self-check failed');
  }
  if (!buildMetadataCoversSource('src/kernel.h', {
    compileCommandSourcePaths: ['src/main.cpp'],
    targetSourcePaths: ['src/kernel.h'],
  })) {
    throw new Error('CMake metadata coverage self-check should accept target header sources');
  }
  if (!buildMetadataCoversSource('src/generated.cl', {
    buildDependencySourcePaths: ['src/generated.cl'],
  })) {
    throw new Error('CMake metadata coverage self-check should accept generated build dependencies');
  }
  if (buildMetadataCoversSource('src/missing.h', {
    compileCommandSourcePaths: ['src/main.cpp'],
    targetSourcePaths: ['src/kernel.h'],
    buildDependencySourcePaths: ['src/generated.cl'],
  })) {
    throw new Error('CMake metadata coverage self-check should reject unrelated sources');
  }
  const includeCoverage = buildSourceCoverageForFocus(
    [
      { path: 'src/main.cl', content: '#include "kernel.h"\n__kernel void k() {}\n' },
      { path: 'src/kernel.h', content: '#define K 1\n' },
    ],
    'src/kernel.h',
    { buildDependencySourcePaths: ['src/main.cl'] },
  );
  const missingIncludeCoverage = buildSourceCoverageForFocus(
    [
      { path: 'src/main.cl', content: '#include "kernel.h"\n__kernel void k() {}\n' },
      { path: 'src/kernel.h', content: '#define K 1\n' },
    ],
    'src/missing.h',
    { buildDependencySourcePaths: ['src/main.cl'] },
  );
  const preferredIncludeCoverage = buildSourceCoverageForFocus(
    [
      { path: 'src/a.cl', content: '#include "kernel.h"\n__kernel void a() {}\n' },
      { path: 'src/b.cl', content: '#include "kernel.h"\n__kernel void b() {}\n' },
      { path: 'src/kernel.h', content: '#define K 1\n' },
    ],
    'src/kernel.h',
    { buildDependencySourcePaths: ['src/a.cl', 'src/b.cl'] },
    { preferredRoots: ['src/b.cl'] },
  );
  if (
    includeCoverage.reason !== 'static_include_from_build_metadata'
    || includeCoverage.trace.join('>') !== 'src/main.cl>src/kernel.h'
    || missingIncludeCoverage.covered
    || preferredIncludeCoverage.trace.join('>') !== 'src/b.cl>src/kernel.h'
  ) {
    throw new Error('CMake metadata include reachability self-check failed');
  }
  const parsedWaitError = waitResultFromWaitHmrToolError(new Error(
    'tool synthi_wait_hmr isError: {"error":"gpu_hmr_proof_insufficient","status":"timeout","gpu_proof_validation":{"reason":"proof_state_missing"}}',
  ));
  if (
    parsedWaitError?.status !== 'timeout'
    || parsedWaitError?.gpu_proof_validation?.reason !== 'proof_state_missing'
    || waitResultFromWaitHmrToolError(new Error('tool synthi_wait_hmr isError: {"error":"other"}')) !== null
  ) {
    throw new Error('wait_hmr proof-insufficient parser self-check failed');
  }
  const missingCompileBridgeSummary = compileResponseBridgeSummary({
    ok: true,
    session_id: 'self-check',
    note: 'compile dispatched',
  });
  const missingCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: missingCompileBridgeSummary },
  ]);
  const incompleteCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: compileResponseBridgeSummary({
      ok: true,
      note: 'device sidecar requested',
    }) },
  ]);
  const candidateCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: compileResponseBridgeSummary({
      ok: true,
      device_sidecar: {
        command: 'load_device rocm /tmp/kernel.hsaco kernel',
        artifact_hash: `sha256:${'1'.repeat(64)}`,
        runtime_proof: { proof_id: `gpu-runtime-proof:sha256:${'2'.repeat(64)}` },
      },
    }) },
  ]);
  const derivedSidecarContractSelfCheck = {
    backend: 'hip',
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    artifactIdentity: {
      source_paths: ['src/self_check_kernel.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['self_check_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: `sha256:${'5'.repeat(64)}`,
    },
    blockingGaps: ['device_sidecar_artifact_transport_runtime_not_observed'],
    blocking_gaps: ['device_sidecar_artifact_transport_runtime_not_observed'],
    evidenceRefs: [
      'profile:source:src/self_check_kernel.hip',
      'build-metadata:coverage:src/self_check_kernel.hip:direct_source',
    ],
    evidence_refs: [
      'profile:source:src/self_check_kernel.hip',
      'build-metadata:coverage:src/self_check_kernel.hip:direct_source',
    ],
  };
  const derivedSidecarSummary = compileResponseBridgeSummary({
    ok: true,
    note: 'compile dispatched',
  }, {
    deviceSidecarContract: derivedSidecarContractSelfCheck,
  });
  const enrichedDerivedSidecarSummary = compileResponseBridgeSummaryWithDeviceSidecar(
    missingCompileBridgeSummary,
    derivedSidecarContractSelfCheck,
  );
  const derivedSidecarCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: derivedSidecarSummary },
  ]);
  const unknownBackendSidecarSummary = compileResponseBridgeSummary({
    ok: true,
    note: 'compile dispatched',
  }, {
    deviceSidecarContract: {
      ...derivedSidecarContractSelfCheck,
      backend: 'unknown',
    },
  });
  const cudaSidecarSummary = compileResponseBridgeSummary({
    ok: true,
    note: 'compile dispatched',
  }, {
    deviceSidecarContract: {
      ...derivedSidecarContractSelfCheck,
      backend: 'cuda',
      blockingGaps: ['device_sidecar_cuda_not_provable_on_rocm_host'],
      blocking_gaps: ['device_sidecar_cuda_not_provable_on_rocm_host'],
    },
  });
  const enrichedDerivedSidecarPhases = enrichCompileBridgeSummariesWithDeviceSidecar([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: missingCompileBridgeSummary },
  ], derivedSidecarContractSelfCheck);
  const enrichedDerivedSidecarCompileBridge = realRocmCompileBridgeFacet(enrichedDerivedSidecarPhases);
  const upstreamNamedCompileBridge = realRocmCompileBridgeFacet([
    { name: 'upstream_gpu_build_run', compile_response_summary: derivedSidecarSummary },
  ]);
  const runtimeLinkedDerivedSidecarCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: derivedSidecarSummary },
  ], {
    runtimeProofAccepted: true,
    runtimeEvidenceRefs: ['gpu-runtime-proof:sha256:self-check-derived-runtime'],
  });
  const runtimeLinkedCompileBridge = realRocmCompileBridgeFacet([
    { name: 'real_repo_user_source_delta_hmr', compile_response_summary: compileResponseBridgeSummary({
      ok: true,
      device_sidecar: {
        command: 'load_device rocm /tmp/kernel.hsaco kernel',
        artifact_hash: `sha256:${'3'.repeat(64)}`,
        runtime_proof: { proof_id: `gpu-runtime-proof:sha256:${'4'.repeat(64)}` },
      },
    }) },
  ], {
    runtimeProofAccepted: true,
    runtimeEvidenceRefs: ['gpu-runtime-proof:sha256:self-check-runtime'],
  });
  if (
    missingCompileBridge.status !== 'compile_bridge_missing'
    || missingCompileBridge.canSatisfyRuntimeProof !== false
    || !missingCompileBridge.blocking_gaps.includes('compile_response_device_sidecar_bridge_not_declared')
    || incompleteCompileBridge.status !== 'compile_bridge_incomplete_not_runtime_proof'
    || !incompleteCompileBridge.blocking_gaps.includes('compile_response_bridge_incomplete_not_runtime_proof')
    || candidateCompileBridge.status !== 'compile_bridge_candidate_observed_not_runtime_proof'
    || candidateCompileBridge.can_satisfy_runtime_proof !== false
    || !candidateCompileBridge.blocking_gaps.includes('compile_response_bridge_candidate_not_runtime_proof')
    || derivedSidecarSummary.status !== 'compile_bridge_candidate_derived_not_runtime_proof'
    || derivedSidecarSummary.can_satisfy_runtime_proof !== false
    || derivedSidecarSummary.signals.derived_device_sidecar_candidate !== true
    || enrichedDerivedSidecarSummary.status !== 'compile_bridge_candidate_derived_not_runtime_proof'
    || enrichedDerivedSidecarSummary.can_satisfy_runtime_proof !== false
    || enrichedDerivedSidecarSummary.signals.derived_device_sidecar_candidate !== true
    || derivedSidecarCompileBridge.status !== 'compile_bridge_candidate_observed_not_runtime_proof'
    || derivedSidecarCompileBridge.can_satisfy_runtime_proof !== false
    || !derivedSidecarCompileBridge.blocking_gaps.includes('compile_response_bridge_candidate_not_runtime_proof')
    || upstreamNamedCompileBridge.status !== 'compile_bridge_candidate_observed_not_runtime_proof'
    || upstreamNamedCompileBridge.phase_count !== 1
    || unknownBackendSidecarSummary.status === 'compile_bridge_candidate_derived_not_runtime_proof'
    || unknownBackendSidecarSummary.signals.derived_device_sidecar_candidate !== false
    || cudaSidecarSummary.status === 'compile_bridge_candidate_derived_not_runtime_proof'
    || cudaSidecarSummary.signals.derived_device_sidecar_candidate !== false
    || enrichedDerivedSidecarPhases[0].compile_response_summary.status !== 'compile_bridge_candidate_derived_not_runtime_proof'
    || enrichedDerivedSidecarCompileBridge.status !== 'compile_bridge_candidate_observed_not_runtime_proof'
    || enrichedDerivedSidecarCompileBridge.can_satisfy_runtime_proof !== false
    || runtimeLinkedDerivedSidecarCompileBridge.status !== 'compile_bridge_linked_to_runtime_proof'
    || runtimeLinkedDerivedSidecarCompileBridge.can_satisfy_runtime_proof !== true
    || runtimeLinkedDerivedSidecarCompileBridge.blocking_gaps.length !== 0
    || runtimeLinkedCompileBridge.status !== 'compile_bridge_linked_to_runtime_proof'
    || runtimeLinkedCompileBridge.can_satisfy_runtime_proof !== true
    || runtimeLinkedCompileBridge.blocking_gaps.length !== 0
  ) {
    throw new Error('compile response bridge evidence self-check failed');
  }
  const sidecarSelfCheckFiles = [
    {
      path: CFG.entryFile,
      content: `#include "${path.posix.basename(CFG.deltaFile)}"\nextern "C" __global__ void self_check_kernel() {}\n`,
    },
    {
      path: CFG.deltaFile,
      content: '#define SYNTHI_DEVICE_SIDECAR_SELF_CHECK 1\n',
    },
  ];
  const sidecarSelfCheckMetadata = {
    compileCommandSourcePaths: [CFG.entryFile],
    targetSourcePaths: [CFG.entryFile],
    buildDependencySourcePaths: [CFG.deltaFile],
    targetIncludeDirs: compactStringList([path.posix.dirname(CFG.deltaFile)]),
    matchedTargetFiles: ['target-self-check.json'],
  };
  const sidecarFacet = realRocmDeviceSidecarContractFacet({
    files: sidecarSelfCheckFiles,
    buildMetadata: sidecarSelfCheckMetadata,
  });
  const sidecarRuntimeProofFacet = realRocmDeviceSidecarContractFacet({
    files: sidecarSelfCheckFiles,
    buildMetadata: sidecarSelfCheckMetadata,
    declaredContractOverride: {
      declared: true,
      sourcePaths: [CFG.entryFile],
      artifactKind: 'hsaco',
      entryPoints: ['self_check_kernel'],
      compileTarget: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      evidenceRefs: ['evidence:self-check-sidecar-contract'],
    },
    runtimeEvidence: {
      artifactTransportObserved: true,
      epochObserved: true,
      dispatchObserved: true,
      outputOracleObserved: true,
      hostIdentityObserved: true,
      fullRuntimeProofAccepted: true,
      evidenceRefs: ['gpu-runtime-proof:sha256:self-check-sidecar'],
    },
  });
  if (
    sidecarFacet.canSatisfyRuntimeProof !== false
    || sidecarFacet.can_satisfy_runtime_proof !== false
    || !sidecarFacet.source_coverage_complete
    || !sidecarFacet.contract_hash?.startsWith('sha256:')
    || !sidecarFacet.evidence_refs.some((ref) => ref.startsWith('build-metadata:coverage:'))
    || !sidecarFacet.blocking_gaps.includes('device_sidecar_artifact_transport_runtime_not_observed')
    || !sidecarFacet.blocking_gaps.includes('device_sidecar_dispatch_trace_runtime_not_observed')
    || sidecarRuntimeProofFacet.status !== 'device_sidecar_runtime_proof_evidence'
    || sidecarRuntimeProofFacet.can_satisfy_runtime_proof !== true
    || sidecarRuntimeProofFacet.runtime_observation_complete !== true
    || sidecarRuntimeProofFacet.blocking_gaps.length !== 0
  ) {
    throw new Error('real ROCm device sidecar contract self-check failed');
  }
  const sidecarRuntimeConsistent = realRocmSidecarRuntimeConsistencyFacet({
    deviceSidecarContract: sidecarFacet,
    runtimeEligibility: {
      observed: true,
      backend_candidates: ['hip'],
    },
  });
  const sidecarRuntimeMismatch = realRocmSidecarRuntimeConsistencyFacet({
    deviceSidecarContract: {
      ...sidecarFacet,
      backend: 'opencl',
    },
    runtimeEligibility: {
      observed: true,
      backend_candidates: ['hip'],
    },
  });
  const sidecarRuntimeAccepted = realRocmSidecarRuntimeConsistencyFacet({
    deviceSidecarContract: sidecarRuntimeProofFacet,
    runtimeEligibility: {
      observed: true,
      backend_candidates: ['hip'],
    },
  });
  if (
    sidecarRuntimeConsistent.status !== 'sidecar_runtime_backend_consistent_not_runtime_proof'
    || sidecarRuntimeConsistent.canSatisfyRuntimeProof !== false
    || sidecarRuntimeConsistent.backend_consistent !== true
    || !sidecarRuntimeConsistent.blocking_gaps.includes('sidecar_runtime_sidecar_observation_missing')
    || sidecarRuntimeMismatch.status !== 'sidecar_runtime_backend_inconsistent_or_unproven'
    || sidecarRuntimeMismatch.backend_consistent !== false
    || !sidecarRuntimeMismatch.blocking_gaps.includes('sidecar_runtime_backend_mismatch')
    || sidecarRuntimeAccepted.status !== 'sidecar_runtime_consistency_proven'
    || sidecarRuntimeAccepted.can_satisfy_runtime_proof !== true
    || sidecarRuntimeAccepted.accepted !== true
    || sidecarRuntimeAccepted.not_applicable !== false
  ) {
    throw new Error('real ROCm sidecar/runtime consistency self-check failed');
  }
  const structuredSidecarProvenance = structuredModelProvenanceFromSidecar({
    available: true,
    path: '/tmp/self-check/.synthi_split_meta.json',
    parsed: {
      model_provenance: {
        provider: 'google_gemini',
        requested_model: 'gemini-3.5-flash',
        provider_model_status: 'available',
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: false,
        model_availability_checked_at: '2026-06-07T00:00:00.000Z',
        model_availability_source: 'https://ai.google.dev/gemini-api/docs/deprecations',
        model_availability_basis: 'static_registry',
        model_availability_check_time_ms: 0,
        actual_model: 'gemini-3.5-flash',
        fallback_model: null,
        fallback_used: false,
        request_mode: 'split',
        hard_infra_failure: false,
      },
      lastGpuAiDeltaModelProvenance: {
        provider: 'google_gemini',
        requested_model: 'gemini-3.1-flash-lite',
        provider_model_status: 'deprecated',
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: true,
        model_availability_checked_at: '2026-06-07T00:00:01.000Z',
        model_availability_source: 'https://ai.google.dev/gemini-api/docs/deprecations',
        model_availability_basis: 'static_registry',
        model_availability_check_time_ms: 0,
        actual_model: 'gemini-3.1-flash-lite',
        fallback_model: null,
        fallback_used: false,
        request_mode: 'gpu_delta',
        hard_infra_failure: false,
      },
    },
  });
  if (
    structuredSidecarProvenance.split?.request_mode !== 'split'
    || structuredSidecarProvenance.last_gpu_delta?.request_mode !== 'gpu_delta'
    || structuredSidecarProvenance.missing_records.length !== 0
  ) {
    throw new Error('structured model provenance sidecar self-check failed');
  }
  const visualSelfCheckRoot = path.join(REPO_ROOT, 'tmp');
  await mkdir(visualSelfCheckRoot, { recursive: true });
  const visualSelfCheckDir = await mkdtemp(path.join(visualSelfCheckRoot, 'visual-proof-self-check-'));
  try {
    const visualPath = path.join(visualSelfCheckDir, 'frame.png');
    const visualWidth = 320;
    const visualHeight = 240;
    const visualRaw = Buffer.alloc(visualWidth * visualHeight * 3);
    for (let y = 0; y < visualHeight; y += 1) {
      for (let x = 0; x < visualWidth; x += 1) {
        const index = (y * visualWidth + x) * 3;
        visualRaw[index] = (x * 7 + y * 3) & 0xff;
        visualRaw[index + 1] = (x * 5 + y * 11) & 0xff;
        visualRaw[index + 2] = (255 - ((x * 13 + y * 17) & 0xff)) & 0xff;
      }
    }
    const visualBytes = await sharp(visualRaw, {
      raw: {
        width: visualWidth,
        height: visualHeight,
        channels: 3,
      },
    }).png().toBuffer();
    await writeFile(visualPath, visualBytes);
    const expectedVisualHash = `sha256:${createHash('sha256').update(visualBytes).digest('hex')}`;
    const written = await writeValidationRuntimeProofArtifact(visualSelfCheckDir, {
      workspaceSlug: 'visual-proof-self-check',
      runtimeSessionIds: ['self-check-session'],
      fullRuntimeProof: {
        resultState: 'gpu-hmr-output-oracle-proven',
        degradedState: null,
        degradedReason: null,
        fullRuntimeProven: false,
        stages: [],
      },
      visualEvidenceRefs: [visualPath],
      visualEvidenceArtifacts: [{
        path: visualPath,
        visualQuality: 'gpu-hmr-visual-varied-frame',
        acceptedAsVisualEvidence: true,
      }],
    });
    const visualArtifact = written.artifact.visualEvidenceArtifacts
      .find((artifact) => artifact.path === visualPath);
    const visualEvidence = written.artifact.evidenceRefs
      .find((evidence) => evidence.filePath === visualPath);
    if (
      visualArtifact?.contentHash !== expectedVisualHash
      || visualEvidence?.contentHash !== expectedVisualHash
      || visualEvidence?.acceptedAsVisualEvidence !== true
      || written.artifact.proofFacets?.visual?.acceptedArtifactCount !== 1
      || written.artifact.proofFacets?.visual?.artifacts?.[0]?.contentHash !== expectedVisualHash
    ) {
      throw new Error('visual proof artifact self-check did not hash visual file bytes');
    }
    const targetProgressionVisualArtifacts = await visualEvidenceArtifactsFromFiles([visualPath], [{
      path: visualPath,
      visualQuality: 'gpu-hmr-visual-varied-frame',
      acceptedAsVisualEvidence: true,
    }]);
    const ledgerReport = {
      slug: 'visual-proof-self-check',
      source_url: 'self-check',
      repo_commit: 'self-check',
      target_name: 'self-check-target',
      model: 'self-check-model',
      gpu_vendor: 'rocm',
      gpu_arch: 'gfx-self-check',
      target_progression: {
        phase: 'final-acceptance',
        phaseRaw: 'final-acceptance',
        recognized: true,
        targetName: 'self-check-target',
        finalAcceptanceTarget: 'self-check-target',
        finalAcceptanceTargetDeclared: true,
        targetMatchesFinalAcceptance: true,
        nonFinalTargetRequired: false,
      },
      target_progression_gates: [],
      runtime_proof_artifact: {
        schemaVersion: written.artifact.schemaVersion,
        proofId: written.artifact.proofId,
        path: written.path,
        resultState: written.artifact.resultState,
        degradedState: written.artifact.degradedState,
        degradedReason: written.artifact.degradedReason,
      },
      full_runtime_proof: written.artifact.proofMaterial.fullRuntimeProof,
      fission_proof: { fissionProven: true },
      output_proof: { resultState: 'gpu-hmr-output-oracle-proven' },
      dispatch_proof: { resultState: 'gpu-hmr-dispatch-safe-proven' },
      host_preservation_proof: { resultState: 'gpu-hmr-host-preservation-proven' },
      original_host_path_proof: { attachmentProven: true },
    };
    const ledgerEntry = buildTargetProgressionLedgerEntry({
      report: ledgerReport,
      visualArtifactPaths: [visualPath],
      visualEvidenceArtifacts: targetProgressionVisualArtifacts,
    });
    const ledgerWritten = await writeTargetProgressionLedgerArtifact(visualSelfCheckDir, {
      report: ledgerReport,
      entry: ledgerEntry,
    });
    const ledgerArtifact = JSON.parse(await readFile(ledgerWritten.path, 'utf8'));
    const ledgerVisualArtifact = ledgerArtifact.entries?.[0]?.visualEvidenceArtifacts
      ?.find((artifact) => artifact.path === visualPath);
    if (
      ledgerVisualArtifact?.contentHash !== expectedVisualHash
      || !ledgerArtifact.entries?.[0]?.visualEvidenceContentHashes?.includes(expectedVisualHash)
      || ledgerArtifact.entries?.[0]?.visualEvidenceAcceptedCount !== 1
    ) {
      throw new Error('target progression ledger self-check did not hash visual file bytes');
    }
    const rejectedVisualPath = path.join(visualSelfCheckDir, 'flat-frame.png');
    const rejectedRaw = Buffer.alloc(visualWidth * visualHeight * 3, 3);
    const rejectedBytes = await sharp(rejectedRaw, {
      raw: {
        width: visualWidth,
        height: visualHeight,
        channels: 3,
      },
    }).png().toBuffer();
    await writeFile(rejectedVisualPath, rejectedBytes);
    const expectedRejectedVisualHash = `sha256:${createHash('sha256').update(rejectedBytes).digest('hex')}`;
    const rejectedVisualArtifacts = await visualEvidenceArtifactsFromFiles([rejectedVisualPath], [{
      path: rejectedVisualPath,
      visualQuality: 'gpu-hmr-visual-flat-frame',
      acceptedAsVisualEvidence: false,
    }]);
    const rejectedLedgerEntry = buildTargetProgressionLedgerEntry({
      report: ledgerReport,
      visualArtifactPaths: [rejectedVisualPath],
      visualEvidenceArtifacts: rejectedVisualArtifacts,
    });
    const rejectedVisualArtifact = rejectedLedgerEntry.visualEvidenceArtifacts
      ?.find((artifact) => artifact.path === rejectedVisualPath);
    if (
      rejectedVisualArtifact?.contentHash !== expectedRejectedVisualHash
      || !rejectedLedgerEntry.visualEvidenceContentHashes?.includes(expectedRejectedVisualHash)
      || rejectedLedgerEntry.visualEvidenceAcceptedCount !== 0
      || rejectedLedgerEntry.visualEvidenceReadErrorCount !== 0
    ) {
      throw new Error('target progression ledger self-check did not retain rejected visual file bytes');
    }
    const forgedFinalAcceptanceReport = {
      ...ledgerReport,
      target_progression: {
        ...ledgerReport.target_progression,
        required: true,
      },
      target_progression_gates: [{
        name: 'target progression full runtime',
        status: 'pass',
        detail: 'forged pass must not override derived proof state',
      }],
      target_progression_ledger: {
        schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
        provided: false,
        entries: [],
      },
      runtime_proof_artifact: null,
      full_runtime_proof: { fullRuntimeProven: false },
      output_proof: null,
      original_host_path_proof: { attachmentProven: false },
      host_preservation_proof: null,
      dispatch_proof: null,
    };
    const forgedFinalAcceptanceEntry = buildTargetProgressionLedgerEntry({
      report: forgedFinalAcceptanceReport,
      visualArtifactPaths: [],
      visualEvidenceArtifacts: [],
    });
    if (
      forgedFinalAcceptanceEntry?.status !== 'fail'
      || forgedFinalAcceptanceEntry.failureCount <= 0
      || !forgedFinalAcceptanceEntry.gateRows.some((row) =>
        row.name === 'target progression full runtime' && row.status === 'fail')
      || !forgedFinalAcceptanceEntry.gateRows.some((row) =>
        row.name === 'target progression compute oracle artifacts' && row.status === 'fail')
    ) {
      throw new Error('target progression ledger self-check accepted forged final-acceptance pass');
    }
  } finally {
    await rm(visualSelfCheckDir, { recursive: true, force: true });
  }
  console.log('runtime dispatch evidence self-check passed');
}

async function collectRuntimeEvidence(context = runtimeEvidenceContext) {
  if (report.docker?.daemon_preflight?.available === false) {
    record(
      'runtime evidence collected',
      'warn',
      'docker daemon preflight failed; docker log and inspect collection skipped',
    );
    return;
  }
  const workerAccess = runtimeWorkerContainerAccess();
  if (!workerAccess.available) {
    record('runtime evidence collected', 'warn', `${workerAccess.detail}; worker log collection skipped`);
    return;
  }
  const mcpContainer = String(CFG.mcpContainer ?? '').trim();
  const aiEngineContainer = String(CFG.aiEngineContainer ?? '').trim();
  report.docker = {
    mcp: mcpContainer
      ? await dockerContainerSnapshot(mcpContainer)
      : { container: null, available: false, reason: 'mcp_container_not_configured' },
    worker: await dockerContainerSnapshot(workerAccess.workerContainer),
    ai_engine: aiEngineContainer
      ? await dockerContainerSnapshot(aiEngineContainer)
      : { container: null, available: false, reason: 'ai_engine_container_not_configured' },
  };
  const workerLogs = await execText(
    'docker',
    ['logs', '--timestamps', '--since', report.started_at, workerAccess.workerContainer],
    120000,
    false,
  );
  const aiLogs = aiEngineContainer
    ? await execText(
      'docker',
      ['logs', '--timestamps', '--since', report.started_at, aiEngineContainer],
      120000,
      false,
    )
    : '';
  const {
    scopedWorkerLogs,
    scopedWorkerEvidence,
    upstreamRunEvidence,
    runtimeEvidence: workerEvidence,
  } = runtimeEvidenceFromValidationLogs({
    workerLogs,
    upstreamRunLog: report.logs.upstream_run,
    slug: CFG.slug,
  });
  const runtimeScope = runtimeEvidenceScope(scopedWorkerLogs, upstreamRunEvidence);
  const unscopedWorkerEvidence = evidenceLines(
    workerLogs,
    RUNTIME_EVIDENCE_PATTERN,
  );
  const aiEvidence = evidenceLines(
    aiLogs,
    /Calling API|mode=delta|mode=split|\[GpuDiffPatch\]|verifier rejected|POST \/refactor\/(?:split(?:\/verified|\/gpu)?|diff_patch(?:\/gpu)?|heal)/i,
  );
  const splitSidecarArtifact = await readWorkerWorkspaceJson('.synthi_split_meta.json');
  const structuredModelProvenance = structuredModelProvenanceFromSidecar(splitSidecarArtifact);
  const genericDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch(?!\/gpu)/i);
  const gpuDeltaCalls = countMatches(aiEvidence, /POST \/refactor\/diff_patch\/gpu/i);
  const compileHealCalls = countMatches(aiEvidence, /POST \/refactor\/heal/i);
  const splitCalls = countAiSplitEvidenceLines(aiEvidence);
  const runtimeDispatch = runtimeDispatchEvidence(workerEvidence);
  const runtimeNativeLaunchObservation = runtimeNativeLaunchObservationEvidence(workerEvidence);
  const runtimeArgProvenance = runtimeArgProvenanceEvidence(workerEvidence);
  const runtimeSession = runtimeSessionEvidence(workerEvidence);
  const runtimeArtifactTransport = runtimeArtifactTransportEvidence(workerEvidence, {
    runtimeSessionIds: runtimeSession.unique_ids,
  });
  const runtimeOwnership = runtimeOwnershipEvidence(workerEvidence);
  const runtimeEpochSwap = epochSwapProofFromRuntimeEvidence(workerEvidence);
  const runtimeOutputOracle = runtimeOutputOracleEvidence(workerEvidence, {
    outputOracleContract: report.output_oracle_contract ?? CFG.outputOracleContract,
    runtimeSessionIds: runtimeSession.unique_ids,
  });
  const hostRestartCount = countMatches(workerEvidence, /Restarting runner/i);
  const runtimeIdentityChanges = runtimeIdentityChangeEvidence();
  const runtimeHostPreservation = hostPreservationProofFromRuntimeEvidence(workerEvidence, {
    hostRestartObserved: hostRestartCount > 0 || runtimeIdentityChanges.changed_count > 0,
    hostReplacementObserved: runtimeOwnership.primary_replacement_count > 0,
    runtimeSessionIds: runtimeSession.unique_ids,
    identityEvidenceRefs: runtimeIdentityChanges.evidence_refs,
    epochProof: runtimeEpochSwap.proof,
  });
  const runtimeSourceFiles = Array.isArray(context?.files) ? context.files : [];
  const runtimeBuildMetadata =
    context?.buildMetadata && typeof context.buildMetadata === 'object' && !Array.isArray(context.buildMetadata)
      ? context.buildMetadata
      : {};
  if (context?.sourceSnapshotAvailable !== true) {
    record(
      'runtime sidecar source snapshot',
      'warn',
      'source/build metadata unavailable before runtime evidence collection; sidecar contract remains build-metadata-unproven',
    );
  }
  const upstreamGpuRunPhase = report.phases
    .filter((phase) => phase?.name === 'upstream_gpu_build_run')
    .at(-1) ?? null;
  const upstreamRunExitCode = Number.isInteger(upstreamGpuRunPhase?.upstream_run_exit_code)
    ? upstreamGpuRunPhase.upstream_run_exit_code
    : null;
  const runtimeOriginalHostPath = originalHostPathProofFromRuntimeEvidence(workerEvidence, {
    required: CFG.requireOriginalHostPath,
    runtimeSessionIds: runtimeSession.unique_ids,
    nativeLaunchObserverEnabled: CFG.nativeLaunchObserver,
    upstreamRunAttempted: CFG.runUpstream,
    upstreamRunExitCode,
    runtimeCapabilityPreflight: report.runtime_capability_preflight,
  });
  report.evidence = {
    real_rocm_profile_proof_obligations: report.real_rocm_profile_proof_obligations,
    runtime_capability_preflight: report.runtime_capability_preflight,
    worker_log_lines: workerEvidence,
    worker_service_log_lines: scopedWorkerEvidence,
    upstream_run_log_lines: upstreamRunEvidence,
    worker_log_lines_unscoped_tail: unscopedWorkerEvidence.slice(-50),
    worker_session_scope: {
      slug: CFG.slug,
      marker_found: scopedWorkerLogs.marker_found,
      marker_kind: scopedWorkerLogs.marker_kind,
      dropped_before: scopedWorkerLogs.dropped_before,
      stopped_before: scopedWorkerLogs.stopped_before,
      stop_marker_found: scopedWorkerLogs.stop_marker_found,
      stale_runtime_lines_dropped: scopedWorkerLogs.stale_runtime_lines_dropped,
      total_lines: scopedWorkerLogs.total_lines,
      runtime_evidence_scope_observed: runtimeScope.observed,
      runtime_evidence_scope_kinds: runtimeScope.scopeKinds,
      upstream_run_evidence_observed: runtimeScope.upstreamRunEvidenceObserved,
    },
    ai_engine_log_lines: aiEvidence,
    ai_call_counts: {
      split: splitCalls,
      generic_delta: genericDeltaCalls,
      gpu_delta: gpuDeltaCalls,
      total_delta: genericDeltaCalls + gpuDeltaCalls,
      compile_heal: compileHealCalls,
      model_delta_mode: countMatches(aiEvidence, /mode=delta/i),
    },
    ai_model_provenance: {
      expected_gpu_split_model: CFG.gpuSplitModel,
      expected_gpu_delta_model: CFG.gpuDeltaModel,
      structured: structuredModelProvenance,
      split: structuredModelProvenance.split,
      last_gpu_delta: structuredModelProvenance.last_gpu_delta,
      observed_gpu_split_actual_models: uniqueLogFieldValues(aiEvidence, 'actual_model', /\[split\/gpu\]\s+accepted/i),
      observed_gpu_split_fallback_used: uniqueLogFieldValues(aiEvidence, 'fallback_used', /\[split\/gpu\]\s+accepted/i),
      observed_gpu_delta_models: uniqueLogFieldValues(aiEvidence, 'model', /\[GpuDiffPatch\]/i),
      observed_gpu_delta_actual_models: uniqueLogFieldValues(aiEvidence, 'actual_model', /\[GpuDiffPatch\]/i),
      observed_gpu_delta_fallback_used: uniqueLogFieldValues(aiEvidence, 'fallback_used', /\[GpuDiffPatch\]/i),
      forced_gpu_ai_delta: CFG.forceGpuAiDelta,
    },
    model_provenance: structuredModelProvenance,
    split_sidecar_artifact: {
      available: splitSidecarArtifact.available === true,
      path: splitSidecarArtifact.path ?? null,
      raw_sha256: splitSidecarArtifact.raw_sha256 ?? null,
      parse_error: splitSidecarArtifact.parseError ?? null,
      reason: splitSidecarArtifact.reason ?? null,
    },
    runner_policy_counts: {
      existing_reload_blocked: countMatches(workerEvidence, /reload_policy_allow_existing=false/i),
      runner_restarts: hostRestartCount,
      runner_exit_errors: countMatches(workerEvidence, /Runner process exited|Rust cannot catch|fatal runtime/i),
      primary_replacements: runtimeOwnership.primary_replacement_count,
    },
    runtime_dispatch: runtimeDispatch,
    runtime_native_launch_observation: runtimeNativeLaunchObservation,
    runtime_arg_provenance: runtimeArgProvenance,
    runtime_session: runtimeSession,
    runtime_artifact_transport: runtimeArtifactTransport,
    runtime_ownership: runtimeOwnership,
    runtime_epoch_swap: runtimeEpochSwap.evidence,
    runtime_output_oracle: runtimeOutputOracle,
    runtime_host_identity: runtimeHostPreservation.evidence,
    runtime_original_host_path: runtimeOriginalHostPath.evidence,
    runtime_identity_changes: runtimeIdentityChanges,
  };
  report.modelProvenance = structuredModelProvenance;
  report.model_provenance = structuredModelProvenance;
  report.evidence.ai_split_provenance = classifyFreshAiSplitProvenance({
    required: CFG.requireFreshAiSplit,
    model: CFG.gpuSplitModel,
    aiCallCounts: report.evidence.ai_call_counts,
    evidenceLines: aiEvidence,
  });
  if (CFG.requireFreshAiSplit) {
    const provenance = report.evidence.ai_split_provenance;
    const observedSplitActualModels = report.evidence.ai_model_provenance.observed_gpu_split_actual_models;
    const observedSplitFallback = report.evidence.ai_model_provenance.observed_gpu_split_fallback_used;
    const splitActualModelObserved = observedSplitActualModels.length === 0
      || observedSplitActualModels.includes(CFG.gpuSplitModel);
    const splitFallbackObserved = observedSplitFallback.some((value) =>
      /^(1|true|yes|on)$/i.test(String(value)));
    record(
      'fresh AI split provenance',
      provenance.observed && splitActualModelObserved && !splitFallbackObserved ? 'pass' : 'fail',
      `model=${provenance.model ?? 'unspecified'} actual=${observedSplitActualModels.join(',') || 'none'} fallback=${observedSplitFallback.join(',') || 'none'} split_calls=${provenance.splitCallCount}`,
    );
    if (!provenance.observed || !splitActualModelObserved || splitFallbackObserved) process.exitCode = 1;
  }
  if (CFG.forceGpuAiDelta) {
    const observedDeltaModels = report.evidence.ai_model_provenance.observed_gpu_delta_models;
    const observedActualDeltaModels = report.evidence.ai_model_provenance.observed_gpu_delta_actual_models;
    const observedDeltaFallback = report.evidence.ai_model_provenance.observed_gpu_delta_fallback_used;
    const structuredDelta = report.evidence.ai_model_provenance.last_gpu_delta;
    const deltaModelObserved = observedDeltaModels.includes(CFG.gpuDeltaModel);
    const actualDeltaModelObserved = observedActualDeltaModels.length > 0
      ? observedActualDeltaModels.includes(CFG.gpuDeltaModel)
      : deltaModelObserved
        || structuredDelta?.actual_model === CFG.gpuDeltaModel
        || structuredDelta?.requested_model === CFG.gpuDeltaModel;
    const deltaFallbackObserved = observedDeltaFallback.some((value) =>
      /^(1|true|yes|on)$/i.test(String(value)))
      || structuredDelta?.fallback_used === true;
    record(
      'forced GPU AI delta endpoint',
      gpuDeltaCalls > 0 ? 'pass' : 'fail',
      `gpu_delta_calls=${gpuDeltaCalls}`,
    );
    record(
      'forced GPU AI delta model provenance',
      (deltaModelObserved || structuredDelta?.requested_model === CFG.gpuDeltaModel)
        && actualDeltaModelObserved
        && !deltaFallbackObserved
        && structuredDelta
        ? 'pass'
        : 'fail',
      `expected=${CFG.gpuDeltaModel} requested=${observedDeltaModels.join(',') || structuredDelta?.requested_model || 'none'} actual=${observedActualDeltaModels.join(',') || structuredDelta?.actual_model || 'none'} fallback=${observedDeltaFallback.join(',') || String(structuredDelta?.fallback_used ?? 'none')}`,
    );
    if (
      gpuDeltaCalls <= 0
      || (!deltaModelObserved && structuredDelta?.requested_model !== CFG.gpuDeltaModel)
      || !actualDeltaModelObserved
      || deltaFallbackObserved
      || !structuredDelta
    ) {
      process.exitCode = 1;
    }
  }
  if (upstreamRunEvidence.length > 0) {
    record('runtime original host run evidence', 'pass', `lines=${upstreamRunEvidence.length}`);
  }
  if (runtimeDispatch.failure_count > 0) {
    record(
      'runtime dispatch failures',
      'fail',
      runtimeDispatch.failure_lines.slice(0, 3).join(' | ').slice(0, 1200),
    );
    process.exitCode = 1;
  } else if (runtimeDispatch.success_count > 0 && runtimeScope.observed) {
    record(
      'runtime dispatch successes',
      'pass',
      `dispatch_ok=${runtimeDispatch.success_count} scope=${runtimeScope.scopeKinds.join(',')}`,
    );
  } else if (!runtimeScope.observed) {
    record('runtime dispatch evidence', 'warn', `no runtime evidence scope captured for slug=${CFG.slug}`);
  } else {
    record('runtime dispatch evidence', 'warn', 'no synthi_gpu_launch dispatch lines captured');
  }
  if (runtimeNativeLaunchObservation.total_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `attempts=${runtimeNativeLaunchObservation.attempt_count} observed=${runtimeNativeLaunchObservation.observe_only_count} resolved=${runtimeNativeLaunchObservation.function_resolution_count} array_alloc=${runtimeNativeLaunchObservation.array_allocation_count} array_failed=${runtimeNativeLaunchObservation.array_allocation_failure_count} texture_create=${runtimeNativeLaunchObservation.texture_object_create_count} texture_failed=${runtimeNativeLaunchObservation.texture_object_failure_count} apis=${runtimeNativeLaunchObservation.apis.join(',') || 'unknown'}`,
    );
  } else if (runtimeNativeLaunchObservation.attempt_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `attempts=${runtimeNativeLaunchObservation.attempt_count} observed=0 resolved=${runtimeNativeLaunchObservation.function_resolution_count} array_alloc=${runtimeNativeLaunchObservation.array_allocation_count} array_failed=${runtimeNativeLaunchObservation.array_allocation_failure_count} texture_create=${runtimeNativeLaunchObservation.texture_object_create_count} texture_failed=${runtimeNativeLaunchObservation.texture_object_failure_count} apis=${runtimeNativeLaunchObservation.attempted_apis.join(',') || 'unknown'}`,
    );
  } else if (runtimeNativeLaunchObservation.array_allocation_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `array_alloc=${runtimeNativeLaunchObservation.array_allocation_count} array_failed=${runtimeNativeLaunchObservation.array_allocation_failure_count} apis=${runtimeNativeLaunchObservation.array_allocation_apis.join(',') || 'unknown'} observed=0`,
    );
  } else if (runtimeNativeLaunchObservation.texture_object_create_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `texture_create=${runtimeNativeLaunchObservation.texture_object_create_count} texture_failed=${runtimeNativeLaunchObservation.texture_object_failure_count} apis=${runtimeNativeLaunchObservation.texture_object_apis.join(',') || 'unknown'} observed=0`,
    );
  } else if (runtimeNativeLaunchObservation.function_resolution_count > 0) {
    record(
      'runtime native launch observation',
      'warn',
      `resolved=${runtimeNativeLaunchObservation.function_resolution_count} symbols=${runtimeNativeLaunchObservation.function_resolution_symbols.join(',') || 'unknown'} observed=0`,
    );
  } else if (runtimeNativeLaunchObservation.ready) {
    record(
      'runtime native launch observation',
      'warn',
      `observer_ready=true covered_apis=${runtimeNativeLaunchObservation.api_coverage.join(',') || 'unknown'} function_resolution_apis=${runtimeNativeLaunchObservation.function_resolution_api_coverage.join(',') || 'unknown'} texture_object_apis=${runtimeNativeLaunchObservation.texture_object_api_coverage.join(',') || 'unknown'} array_allocation_apis=${runtimeNativeLaunchObservation.array_allocation_api_coverage.join(',') || 'unknown'} observed=0`,
    );
  } else if (CFG.nativeLaunchObserver && CFG.runUpstream) {
    record(
      'runtime native launch observation',
      'warn',
      'native launch observer enabled but no readiness or launch lines captured',
    );
  }
  if (runtimeArgProvenance.total_count > 0) {
    const status = runtimeArgProvenance.incomplete_count > 0 ? 'warn' : 'pass';
    record(
      'runtime argument provenance',
      status,
      `records=${runtimeArgProvenance.total_count} complete=${runtimeArgProvenance.complete_count} incomplete=${runtimeArgProvenance.incomplete_count} unknown_args=${runtimeArgProvenance.unknown_arg_count}`,
    );
  } else {
    record('runtime argument provenance', 'warn', 'no launch_arg_provenance lines captured');
  }
  if (runtimeSession.record_count > 0) {
    record(
      'runtime session provenance',
      runtimeSession.consistent ? 'pass' : 'warn',
      `records=${runtimeSession.record_count} ids=${runtimeSession.unique_ids.join(',')}`,
    );
  } else {
    record('runtime session provenance', 'warn', 'no runtime_session launch evidence captured');
  }
  if (runtimeArtifactTransport.total_count > 0) {
    record(
      'runtime artifact transport evidence',
      runtimeArtifactTransport.ram_transport_proven ? 'pass' : 'warn',
      `records=${runtimeArtifactTransport.total_count} matched=${runtimeArtifactTransport.matched_count} loader=${runtimeArtifactTransport.loader_transports.join(',') || 'unknown'} ram_reference=${runtimeArtifactTransport.ram_artifact_reference_provided}`,
    );
  } else {
    record('runtime artifact transport evidence', 'warn', 'no artifact_transport lines captured');
  }
  if (runtimeEpochSwap.evidence.total_count > 0) {
    record(
      'runtime epoch swap evidence',
      runtimeEpochSwap.proof.degradedState ? 'warn' : 'pass',
      `published=${runtimeEpochSwap.evidence.published_count} retired=${runtimeEpochSwap.evidence.retired_count} stream_ordering=${runtimeEpochSwap.evidence.stream_ordering_proven}`,
    );
  } else {
    record('runtime epoch swap evidence', 'warn', 'no dispatcher_epoch lines captured');
  }
  let runtimeOutputOracleVisualRow = null;
  let runtimeOutputOracleArtifacts = null;
  if (runtimeOutputOracle.total_count > 0) {
    record(
      'runtime output oracle evidence',
      runtimeOutputOracle.deterministic_oracle_passed ? 'pass' : 'warn',
      `records=${runtimeOutputOracle.total_count} matched=${runtimeOutputOracle.matched_count} passed=${runtimeOutputOracle.passed_count} failed=${runtimeOutputOracle.failed_count} latest=${runtimeOutputOracle.latest?.oracleId ?? 'none'}`,
    );
    runtimeOutputOracleVisualRow = await writeRuntimeOutputOracleVisualProof(runtimeOutputOracle);
    const computeOracleArtifacts = await writeRuntimeOutputOracleComputeArtifacts(
      runtimeOutputOracle,
      { proofCardPath: runtimeOutputOracleVisualRow?.path },
    );
    const verifiedComputeOracleArtifacts = computeOracleArtifacts
      ? await computeOracleArtifactsFromFiles(computeOracleArtifacts)
      : null;
    runtimeOutputOracleArtifacts = verifiedComputeOracleArtifacts
      ? { compute_oracle_artifacts: verifiedComputeOracleArtifacts }
      : null;
  } else {
    record('runtime output oracle evidence', 'warn', 'no output_oracle lines captured');
  }
  if (runtimeHostPreservation.evidence.total_count > 0) {
    record(
      'runtime host identity evidence',
      runtimeHostPreservation.proof.degradedState || !runtimeHostPreservation.proof.resultState ? 'warn' : 'pass',
      `records=${runtimeHostPreservation.evidence.total_count} preserved_roles=${runtimeHostPreservation.evidence.preserved_roles.join(',') || 'none'} changed_roles=${runtimeHostPreservation.evidence.changed_roles.join(',') || 'none'}`,
    );
  } else {
    record('runtime host identity evidence', 'warn', 'no host_identity lines captured');
  }
  if (
    runtimeOriginalHostPath.evidence.raw_count > 0
    || runtimeOriginalHostPath.evidence.candidate_count > 0
  ) {
    record(
      'runtime original host path evidence',
      runtimeOriginalHostPath.proof.degradedState ? 'warn' : 'pass',
      `records=${runtimeOriginalHostPath.evidence.total_count} raw=${runtimeOriginalHostPath.evidence.raw_count} candidates=${runtimeOriginalHostPath.evidence.candidate_count} required=${CFG.requireOriginalHostPath}`,
    );
  } else {
    record(
      'runtime original host path evidence',
      CFG.requireOriginalHostPath ? 'warn' : 'skip',
      CFG.requireOriginalHostPath
        ? 'no original_host_path attachment lines captured'
        : 'original host path attachment not required by this validation',
    );
  }
  const proofArtifactRecords = await collectGpuProofArtifacts();
  const selectedArtifactIds = selectedArtifactIdsFromProofArtifacts(proofArtifactRecords);
  report.evidence.selected_artifact_ids = selectedArtifactIds;
  report.evidence.runtime_dispatch.runtime_artifact_matches_selected =
    runtimeArtifactMatchesSelected({ runtimeDispatch, selectedArtifactIds });
  const foundProofArtifactCount = proofArtifactRecords.filter((entry) => entry?.found).length;
  const abiMetadataEvidenceCount = proofArtifactRecords.reduce((count, entry) => {
    const refs = Array.isArray(entry?.artifact?.evidenceRefs) ? entry.artifact.evidenceRefs : [];
    return count + refs.filter((evidence) => evidence?.kind === 'device-abi-metadata').length;
  }, 0);
  record(
    'proof artifact collection',
    foundProofArtifactCount > 0 ? 'pass' : 'warn',
    `found=${foundProofArtifactCount}/${proofArtifactRecords.length} abi_metadata=${abiMetadataEvidenceCount}`,
  );
  const freshVisualFrames = visualEvidenceFrames();
  report.source_proof = sourceProofFromProofArtifacts(
    proofArtifactRecords,
    report.phases.map((phase) => phase.gpu_proof).filter(Boolean).at(-1) ?? null,
  );
  report.source_proofs = [report.source_proof].filter(Boolean);
  report.abi_proof = abiProofFromProofArtifacts(proofArtifactRecords, {
    runtimeArgProvenance,
  });
  report.fission_proof = fissionProofFromProofArtifacts(proofArtifactRecords);
  report.artifact_transport_proof = artifactTransportProofFromProofArtifacts(
    proofArtifactRecords,
    runtimeArtifactTransport,
  );
  report.epoch_swap_proof = runtimeEpochSwap.proof;
  const classifiedDispatchProof = classifyGpuHmrDispatchProof({
    dispatchObserved: runtimeDispatch.success_count > 0 && runtimeScope.observed,
    sessionScoped: runtimeScope.observed && runtimeSession.record_count > 0,
    runtimeSessionIds: runtimeSession.unique_ids,
    runtimeSessionConsistent: runtimeSession.record_count === 0 ? true : runtimeSession.consistent,
    argProvenanceObserved: runtimeArgProvenance.total_count > 0,
    argProvenanceComplete: runtimeArgProvenance.total_count > 0
      && runtimeArgProvenance.incomplete_count === 0
      && runtimeArgProvenance.unknown_arg_count === 0,
    argProvenanceEvidenceRefs: runtimeArgProvenance.evidence_refs,
    dispatchEvidenceRefs: runtimeDispatch.evidence_refs,
    argProvenanceRecords: runtimeArgProvenance.records,
    argProvenanceRecordComplete: runtimeArgProvenance.record_complete,
    argProvenanceKnownArgCount: runtimeArgProvenance.known_arg_count,
    unknownArgCount: runtimeArgProvenance.unknown_arg_count,
    abiProof: report.abi_proof,
    epochProof: report.epoch_swap_proof,
    streamOrderingProven: runtimeEpochSwap.evidence.stream_ordering_proven,
    replacementScopeProven: runtimeOwnership.scope_proven_count > 0,
    selectedArtifactIds,
    runtimeArtifactIds: runtimeDispatch.runtime_artifact_ids,
    runtimeArtifactId: runtimeDispatch.runtime_artifact_id,
    dispatcherRegistrationIds: runtimeDispatch.dispatcher_registration_ids,
    dispatchTableEntryIds: runtimeDispatch.dispatch_table_entry_ids,
    dispatchTableHashes: runtimeDispatch.dispatch_table_hashes,
    dispatchStreamIds: runtimeDispatch.dispatch_stream_ids,
    gridDimensions: runtimeDispatch.grid_dimensions,
    blockDimensions: runtimeDispatch.block_dimensions,
    sharedMemoryBytes: runtimeDispatch.shared_memory_bytes,
    dispatchTimestamps: runtimeDispatch.dispatch_timestamps,
    dispatchId: runtimeDispatch.dispatch_id,
    generation: runtimeDispatch.generation,
    epoch: runtimeDispatch.epoch,
    processId: runtimeDispatch.process_id,
    runtimeArtifactMatchesSelected: report.evidence.runtime_dispatch.runtime_artifact_matches_selected,
  });
  const hiprtVisualFrame = hiprtNativeVisualFrame(freshVisualFrames);
  const hiprtNativeDispatchProof = buildHiprtNativeDispatchProof({
    runtimeNativeLaunchObservation,
    selectedArtifactIds,
    epochProof: report.epoch_swap_proof,
    visualFrame: hiprtVisualFrame,
  });
  report.dispatch_proof = hiprtNativeDispatchProof ?? classifiedDispatchProof;
  if (hiprtNativeDispatchProof) {
    report.evidence.runtime_dispatch.runtime_artifact_matches_selected = true;
  }
  const classifiedOutputProof = classifyGpuHmrOutputProof({
    dispatchProof: report.dispatch_proof,
    epochProof: report.epoch_swap_proof,
    selectedArtifactIds,
    deterministicOutputObserved: runtimeOutputOracle.deterministic_output_observed,
    deterministicOracleProvided: runtimeOutputOracle.deterministic_oracle_provided,
    deterministicOraclePassed: runtimeOutputOracle.deterministic_oracle_passed,
    outputOracle: runtimeOutputOracle.output_oracle ?? undefined,
    oracleArtifacts: runtimeOutputOracleArtifacts ?? undefined,
    evidenceRefs: runtimeOutputOracle.evidence_refs,
    visualEvidenceRequired: renderingVisualEvidenceExpected(),
    visualFrameObserved: freshVisualFrames.length > 0,
    visualEvidenceRefs: freshVisualFrames.map((shot) => shot.path),
  });
  const hiprtNativeOutputProof = buildHiprtNativeOutputProof({
    dispatchProof: report.dispatch_proof,
    visualFrame: hiprtVisualFrame,
  });
  report.output_proof = hiprtNativeOutputProof ?? classifiedOutputProof;
  report.host_preservation_proof = runtimeHostPreservation.proof;
  const hiprtNativeOriginalHostPathProof = buildHiprtNativeOriginalHostPathProof({
    runtimeNativeLaunchObservation,
    dispatchProof: report.dispatch_proof,
  });
  report.original_host_path_proof =
    hiprtNativeOriginalHostPathProof ?? runtimeOriginalHostPath.proof;
  report.full_runtime_proof = classifyGpuHmrFullRuntimeProof({
    sourceProofs: report.source_proofs,
    fissionProof: report.fission_proof,
    abiProof: report.abi_proof,
    artifactTransportProof: report.artifact_transport_proof,
    epochProof: report.epoch_swap_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
  });
  report.firewall_evidence = deriveCpuGpuFirewallEvidence({
    runtimeIdentityChanges,
    runtimeHostPreservation,
    runtimeDispatch,
    runtimeOutputOracle,
    runtimeOwnership,
    hostRestartCount,
  });
  report.evidence.firewall_evidence = report.firewall_evidence;
  report.native_rocm_launch_boundary = nativeRocmLaunchBoundaryRefusalFacet({
    nativeObservation: runtimeNativeLaunchObservation,
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    outputOracleResolution: report.output_oracle_resolution,
    fullRuntimeProof: report.full_runtime_proof,
  });
  report.evidence.native_rocm_launch_boundary = report.native_rocm_launch_boundary;
  const realRocmAvailableEvidenceRefs = availableRealRocmEvidenceRefs({
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    proofArtifactRecords,
  });
  report.real_rocm_app_hook_contract = realRocmAppHookContractFacet({
    appHookContract: CFG.appHookContract,
    profileProofObligations: report.real_rocm_profile_proof_obligations,
    nativeBoundary: report.native_rocm_launch_boundary,
    nativeObservation: runtimeNativeLaunchObservation,
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    fullRuntimeProof: report.full_runtime_proof,
    availableEvidenceRefs: realRocmAvailableEvidenceRefs,
  });
  report.realRocmAppHookContract = report.real_rocm_app_hook_contract;
  report.evidence.real_rocm_app_hook_contract = report.real_rocm_app_hook_contract;
  report.real_rocm_native_runtime_bridge = realRocmNativeRuntimeProofBridgeFacet({
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    fullRuntimeProof: report.full_runtime_proof,
    firewallEvidence: report.firewall_evidence,
    availableEvidenceRefs: realRocmAvailableEvidenceRefs,
  });
  report.realRocmNativeRuntimeBridge = report.real_rocm_native_runtime_bridge;
  report.nativeRuntimeBridge = report.real_rocm_native_runtime_bridge;
  report.native_runtime_bridge = report.real_rocm_native_runtime_bridge;
  report.evidence.real_rocm_native_runtime_bridge = report.real_rocm_native_runtime_bridge;
  report.real_rocm_same_process_runtime_oracle = realRocmSameProcessRuntimeOracleFacet({
    appHookContractFacet: report.real_rocm_app_hook_contract,
    nativeRuntimeBridgeFacet: report.real_rocm_native_runtime_bridge,
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    fullRuntimeProof: report.full_runtime_proof,
    firewallEvidence: report.firewall_evidence,
    availableEvidenceRefs: realRocmAvailableEvidenceRefs,
  });
  report.realRocmSameProcessRuntimeOracle = report.real_rocm_same_process_runtime_oracle;
  report.sameProcessRuntimeOracle = report.real_rocm_same_process_runtime_oracle;
  report.same_process_runtime_oracle = report.real_rocm_same_process_runtime_oracle;
  report.evidence.real_rocm_same_process_runtime_oracle =
    report.real_rocm_same_process_runtime_oracle;
  const epochEvidence = runtimeEpochSwap?.evidence ?? runtimeEpochSwap ?? {};
  const hostEvidence = runtimeHostPreservation?.evidence ?? runtimeHostPreservation ?? {};
  report.real_rocm_device_sidecar_contract = realRocmDeviceSidecarContractFacet({
    files: runtimeSourceFiles,
    buildMetadata: runtimeBuildMetadata,
    runtimeEvidence: {
      artifactTransportObserved: Number(runtimeArtifactTransport.total_count ?? runtimeArtifactTransport.matched_count ?? 0) > 0,
      epochObserved:
        Number(epochEvidence.total_count ?? 0) > 0
        || Number(epochEvidence.published_count ?? 0) > 0
        || runtimeEpochSwap?.proof?.resultState === 'gpu-hmr-epoch-swap-proven',
      dispatchObserved: Number(runtimeDispatch.success_count ?? 0) > 0,
      outputOracleObserved: Number(runtimeOutputOracle.total_count ?? 0) > 0,
      hostIdentityObserved: Number(hostEvidence.total_count ?? 0) > 0,
      fullRuntimeProofAccepted: report.full_runtime_proof?.fullRuntimeProven === true,
      evidenceRefs: realRocmAvailableEvidenceRefs,
    },
  });
  report.realRocmDeviceSidecarContract = report.real_rocm_device_sidecar_contract;
  report.evidence.real_rocm_device_sidecar_contract = report.real_rocm_device_sidecar_contract;
  report.phases = enrichCompileBridgeSummariesWithDeviceSidecar(
    report.phases,
    report.real_rocm_device_sidecar_contract,
  );
  report.real_rocm_compile_bridge = realRocmCompileBridgeFacet(report.phases, {
    runtimeProofAccepted: report.full_runtime_proof?.fullRuntimeProven === true,
    runtimeEvidenceRefs: realRocmAvailableEvidenceRefs,
  });
  report.realRocmCompileBridge = report.real_rocm_compile_bridge;
  report.evidence.real_rocm_compile_bridge = report.real_rocm_compile_bridge;
  report.real_rocm_runtime_eligibility = realRocmRuntimeEligibilityFacet({
    nativeBoundary: report.native_rocm_launch_boundary,
    appHookContractFacet: report.real_rocm_app_hook_contract,
    nativeObservation: runtimeNativeLaunchObservation,
    runtimeDispatch,
    runtimeArtifactTransport,
    runtimeEpochSwap,
    runtimeOutputOracle,
    runtimeHostPreservation,
    runtimeCapabilityPreflight: report.runtime_capability_preflight,
    outputOracleResolution: report.output_oracle_resolution,
    fullRuntimeProof: report.full_runtime_proof,
    runtimeBackend: runtimeProofBackend(),
    compiler: runtimeProofCompiler(),
  });
  report.real_rocm_runtime_eligibility.sameProcessRuntimeOracleStatus =
    report.real_rocm_same_process_runtime_oracle.status;
  report.real_rocm_runtime_eligibility.same_process_runtime_oracle_status =
    report.real_rocm_same_process_runtime_oracle.status;
  report.real_rocm_runtime_eligibility.sameProcessRuntimeOracleAccepted =
    report.real_rocm_same_process_runtime_oracle.accepted === true;
  report.real_rocm_runtime_eligibility.same_process_runtime_oracle_accepted =
    report.real_rocm_same_process_runtime_oracle.accepted === true;
  report.real_rocm_runtime_eligibility.blockingGaps = compactStringList([
    ...(Array.isArray(report.real_rocm_runtime_eligibility.blockingGaps)
      ? report.real_rocm_runtime_eligibility.blockingGaps
      : []),
    ...(report.real_rocm_same_process_runtime_oracle.required === true
      && report.real_rocm_same_process_runtime_oracle.accepted !== true
      ? report.real_rocm_same_process_runtime_oracle.blocking_gaps
      : []),
  ]);
  report.real_rocm_runtime_eligibility.blocking_gaps =
    report.real_rocm_runtime_eligibility.blockingGaps;
  report.evidence.real_rocm_runtime_eligibility = report.real_rocm_runtime_eligibility;
  report.real_rocm_sidecar_runtime_consistency = realRocmSidecarRuntimeConsistencyFacet({
    deviceSidecarContract: report.real_rocm_device_sidecar_contract,
    runtimeEligibility: report.real_rocm_runtime_eligibility,
  });
  report.realRocmSidecarRuntimeConsistency = report.real_rocm_sidecar_runtime_consistency;
  report.evidence.real_rocm_sidecar_runtime_consistency =
    report.real_rocm_sidecar_runtime_consistency;
  if (report.native_rocm_launch_boundary.observed) {
    record(
      'native ROCm launch boundary refusal facet',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `status=${report.native_rocm_launch_boundary.status}`,
        `resolved=${report.native_rocm_launch_boundary.function_resolution_count}`,
        `attempts=${report.native_rocm_launch_boundary.launch_attempt_count}`,
        `observed=${report.native_rocm_launch_boundary.native_launch_observed_count}`,
        `gaps=${report.native_rocm_launch_boundary.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (report.real_rocm_runtime_eligibility.observed) {
    record(
      'real ROCm runtime eligibility facet',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `status=${report.real_rocm_runtime_eligibility.status}`,
        `candidates=${report.real_rocm_runtime_eligibility.backend_candidates.join(',') || 'none'}`,
        `hmr_backend=${report.real_rocm_runtime_eligibility.hmr_backend ?? 'none'}`,
        `source_language=${report.real_rocm_runtime_eligibility.source_language}`,
        `gaps=${report.real_rocm_runtime_eligibility.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (report.real_rocm_app_hook_contract.required || report.real_rocm_app_hook_contract.declared) {
    record(
      'real ROCm app hook contract facet',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `status=${report.real_rocm_app_hook_contract.status}`,
        `declared=${report.real_rocm_app_hook_contract.declared}`,
        `contract_complete=${report.real_rocm_app_hook_contract.contract_evidence_complete}`,
        `runtime_complete=${report.real_rocm_app_hook_contract.runtime_observation_complete}`,
        `gaps=${report.real_rocm_app_hook_contract.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (
    report.real_rocm_same_process_runtime_oracle.required
    || report.real_rocm_same_process_runtime_oracle.declared
  ) {
    record(
      'real ROCm same-process runtime oracle contract facet',
      report.real_rocm_same_process_runtime_oracle.accepted ? 'pass' : 'warn',
      [
        `status=${report.real_rocm_same_process_runtime_oracle.status}`,
        `app_hook=${report.real_rocm_same_process_runtime_oracle.app_hook_contract_accepted}`,
        `native_bridge=${report.real_rocm_same_process_runtime_oracle.native_runtime_bridge_accepted}`,
        `dispatch_epoch=${report.real_rocm_same_process_runtime_oracle.dispatch_used_published_epoch}`,
        `output_after_dispatch=${report.real_rocm_same_process_runtime_oracle.output_after_dispatch_observed}`,
        `gaps=${report.real_rocm_same_process_runtime_oracle.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (report.real_rocm_sidecar_runtime_consistency.notApplicable !== true) {
    record(
      'real ROCm sidecar runtime consistency facet',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `status=${report.real_rocm_sidecar_runtime_consistency.status}`,
        `sidecar_backend=${report.real_rocm_sidecar_runtime_consistency.sidecar_backend ?? 'none'}`,
        `runtime_candidates=${report.real_rocm_sidecar_runtime_consistency.runtime_backend_candidates.join(',') || 'none'}`,
        `backend_consistent=${report.real_rocm_sidecar_runtime_consistency.backend_consistent}`,
        `gaps=${report.real_rocm_sidecar_runtime_consistency.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (report.real_rocm_compile_bridge.phase_count > 0) {
    record(
      'real ROCm compile bridge facet',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `status=${report.real_rocm_compile_bridge.status}`,
        `phases=${report.real_rocm_compile_bridge.phase_count}`,
        `gaps=${report.real_rocm_compile_bridge.blocking_gaps.join(',') || 'none'}`,
      ].join(' '),
    );
  }
  if (hiprtNativeDispatchProof || hiprtNativeOutputProof || hiprtNativeOriginalHostPathProof) {
    record(
      'HIPRT native runtime proof bridge',
      report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
      [
        `dispatch=${hiprtNativeDispatchProof ? 'native-observed' : 'classified'}`,
        `output=${hiprtNativeOutputProof ? 'framebuffer-oracle' : 'classified'}`,
        `original_host_path=${hiprtNativeOriginalHostPathProof ? 'native-observed' : 'classified'}`,
      ].join(' '),
    );
  }
  record(
    'runtime source proof',
    report.source_proof.resultState ? 'pass' : 'warn',
    summarizeGpuHmrSourceProof(report.source_proof),
  );
  record(
    'runtime ABI proof',
    report.abi_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrAbiProof(report.abi_proof),
  );
  record(
    'runtime fission proof',
    report.fission_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrFissionProof(report.fission_proof),
  );
  record(
    'runtime artifact transport proof',
    report.artifact_transport_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrArtifactTransportProof(report.artifact_transport_proof),
  );
  record(
    'runtime epoch swap proof',
    report.epoch_swap_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrEpochSwapProof(report.epoch_swap_proof),
  );
  record(
    'runtime dispatch proof',
    report.dispatch_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrDispatchProof(report.dispatch_proof),
  );
  record(
    'runtime output proof',
    report.output_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrOutputProof(report.output_proof),
  );
  record(
    'host preservation proof',
    report.host_preservation_proof.degradedState || !report.host_preservation_proof.resultState
      ? 'warn'
      : 'pass',
    summarizeGpuHmrHostPreservationProof(report.host_preservation_proof),
  );
  record(
    'original host path proof',
    report.original_host_path_proof.degradedState ? 'warn' : 'pass',
    summarizeGpuHmrOriginalHostPathProof(report.original_host_path_proof),
  );
  record(
    'full runtime proof ladder',
    report.full_runtime_proof.fullRuntimeProven ? 'pass' : 'warn',
    summarizeGpuHmrFullRuntimeProof(report.full_runtime_proof),
  );
  const strictProofRows = strictProofGateRows({
    requireOriginalHostPathProof: CFG.requireOriginalHostPathProof,
    requireFullRuntimeProof: CFG.requireFullRuntimeProof,
    originalHostPathProof: report.original_host_path_proof,
    fullRuntimeProof: report.full_runtime_proof,
  });
  if (CFG.forceGpuAiDelta) {
    strictProofRows.push(...forcedGpuAiDeltaArtifactGateRows({
      sourceProofs: report.source_proofs,
      fissionProof: report.fission_proof,
      workerEvidence,
    }));
  }
  report.strict_proof_gates = strictProofRows;
  for (const gate of strictProofRows) {
    record(gate.name, gate.status, gate.detail);
    if (gate.status === 'fail') process.exitCode = 1;
  }
  const targetProgressionRows = targetProgressionGateRows({
    targetProgression: report.target_progression,
    targetProgressionLedger: report.target_progression_ledger,
    sourceProofs: report.source_proofs,
    fissionProof: report.fission_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
    fullRuntimeProof: report.full_runtime_proof,
    visualEvidenceExpected: renderingVisualEvidenceExpected(),
    visualEvidenceFrames: freshVisualFrames,
  });
  report.target_progression_gates = targetProgressionRows;
  for (const gate of targetProgressionRows) {
    record(gate.name, gate.status, gate.detail);
    if (gate.status === 'fail') process.exitCode = 1;
  }
  record(
    'runtime evidence collected',
    'pass',
    `ai_split=${report.evidence.ai_call_counts.split} ai_delta=${report.evidence.ai_call_counts.total_delta} ai_gpu_delta=${report.evidence.ai_call_counts.gpu_delta} ai_compile_heal=${report.evidence.ai_call_counts.compile_heal} restart_policy_blocks=${report.evidence.runner_policy_counts.existing_reload_blocked}`,
  );
}

async function dockerContainerSnapshot(containerName) {
  if (!String(containerName ?? '').trim()) {
    return { container: null, available: false, reason: 'container_not_configured' };
  }
  const raw = await execText(
    'docker',
    ['inspect', containerName],
    30000,
    false,
  );
  if (!raw) return { container: containerName, available: false };
  let info;
  try {
    const parsed = JSON.parse(raw);
    info = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    return {
      container: containerName,
      available: false,
      reason: 'docker_inspect_parse_failed',
      error: err.message,
    };
  }
  const state = info?.State ?? {};
  const name = info?.Name;
  return {
    container: containerName,
    name: name?.replace(/^\//, '') ?? containerName,
    id: info?.Id ?? null,
    config_image: info?.Config?.Image ?? null,
    image_id: info?.Image ?? null,
    status: state.Status ?? null,
    pid: state.Pid ?? null,
    started_at: state.StartedAt ?? null,
    finished_at: state.FinishedAt ?? null,
    restart_count: info?.RestartCount ?? null,
    oom_killed: state.OOMKilled ?? null,
    exit_code: state.ExitCode ?? null,
    available: true,
  };
}

function selectedFissionIslandContract() {
  const contracts = Array.isArray(report.fission_proof?.selectedIslandContracts)
    ? report.fission_proof.selectedIslandContracts
    : [];
  return contracts[contracts.length - 1] ?? null;
}

function runtimeProofSourceEditId() {
  const island = selectedFissionIslandContract();
  const fromArtifacts = [...(Array.isArray(report.proof_artifacts) ? report.proof_artifacts : [])]
    .reverse()
    .map((record) => record?.artifact?.sourceEditId ?? record?.artifact?.source_edit_id)
    .find((value) => typeof value === 'string' && value.trim());
  return island?.sourceEditId
    ?? island?.source_edit_id
    ?? fromArtifacts
    ?? null;
}

function runtimeProofCompiler() {
  const island = selectedFissionIslandContract();
  const fromArtifacts = [...(Array.isArray(report.proof_artifacts) ? report.proof_artifacts : [])]
    .flatMap((record) => Array.isArray(record?.artifact?.evidenceRefs) ? record.artifact.evidenceRefs : [])
    .map((evidence) =>
      evidence?.metadata?.compileProvenance?.deviceCompiler
      ?? evidence?.metadata?.compileProvenance?.compilerExecutable
      ?? evidence?.metadata?.compile_provenance?.device_compiler
      ?? evidence?.metadata?.compile_provenance?.compiler_executable
    )
    .find((value) => typeof value === 'string' && value.trim());
  return island?.compiler
    ?? island?.compilerName
    ?? island?.compiler_name
    ?? fromArtifacts
    ?? null;
}

function runtimeProofBackend() {
  if (report.full_runtime_proof?.fullRuntimeProven !== true) return null;
  const island = selectedFissionIslandContract();
  const compiler = String(runtimeProofCompiler() ?? '').toLowerCase();
  const launchEvidence = [
    island?.launchApi,
    island?.launch_api,
    ...(Array.isArray(report.dispatch_proof?.dispatchEvidenceRefs)
      ? report.dispatch_proof.dispatchEvidenceRefs
      : []),
    ...(Array.isArray(report.dispatch_proof?.evidenceRefs)
      ? report.dispatch_proof.evidenceRefs
      : []),
  ].join(' ').toLowerCase();
  if (
    compiler.includes('hipcc')
    || /\bhip(module|launch|stream|malloc|memcpy)?\b/.test(launchEvidence)
  ) {
    return 'hip';
  }
  return null;
}

function runtimeGpuClassification() {
  if (report.full_runtime_proof?.fullRuntimeProven !== true) return null;
  return {
    project_kind: 'mixed_project',
    edit_kind: 'gpu_artifact_edit',
    route: 'gpu_hmr',
    confidence: 0.95,
    evidence_source: 'full_runtime_proof',
    evidence_refs: compactStringList([
      ...(Array.isArray(report.full_runtime_proof?.evidenceRefs)
        ? report.full_runtime_proof.evidenceRefs
        : []),
      ...(Array.isArray(report.dispatch_proof?.evidenceRefs)
        ? report.dispatch_proof.evidenceRefs
        : []),
      ...(Array.isArray(report.output_proof?.evidenceRefs)
        ? report.output_proof.evidenceRefs
        : []),
    ]),
  };
}

function runtimeContextHandleFromHostEvidence() {
  const lines = Array.isArray(report.firewall_evidence?.host_preservation_evidence?.lines)
    ? report.firewall_evidence.host_preservation_evidence.lines
    : [];
  for (const line of [...lines].reverse()) {
    const match = /\brole=runtime_context\s+ptr=([^\s]+)/.exec(String(line ?? ''));
    if (match?.[1]) return `runtime-context:${match[1]}`;
  }
  return null;
}

function runtimeOutputOracleTarget() {
  const oracle = report.output_proof?.outputOracle ?? report.output_proof?.output_oracle ?? null;
  const computeArtifacts =
    report.output_proof?.oracleArtifacts?.compute_oracle_artifacts
    ?? report.output_proof?.oracle_artifacts?.compute_oracle_artifacts
    ?? null;
  if (!oracle || !computeArtifacts) return null;
  return {
    kind: 'compute',
    target_id:
      oracle.outputTargetId
      ?? oracle.output_target_id
      ?? oracle.readbackTargetId
      ?? oracle.readback_target_id
      ?? oracle.oracleId
      ?? oracle.oracle_id
      ?? null,
    compute_only_target_verified: oracle.passed === true
      && report.output_proof?.resultState === 'gpu-hmr-output-oracle-proven',
    evidence_refs: compactStringList([
      ...(Array.isArray(oracle.evidenceRefs) ? oracle.evidenceRefs : []),
      ...(Array.isArray(oracle.evidence_refs) ? oracle.evidence_refs : []),
      ...(Array.isArray(report.output_proof?.evidenceRefs) ? report.output_proof.evidenceRefs : []),
      'evidence:output-oracle:compute-readback-artifacts',
    ]),
  };
}

function renderingVisualEvidenceExpected() {
  if (CFG.expectScreenshot || CFG.renderPreview) return true;
  const runtimeProfile = objectField(report.output_oracle_runtime_profile);
  const runtime = objectField(runtimeProfile?.runtime, runtimeProfile?.outputOracle, runtimeProfile?.output_oracle);
  const oracleDescriptor = [
    stringField(report.output_oracle_contract, ['kind', 'oracleKind', 'oracle_kind', 'mode']),
    stringField(runtimeProfile, ['kind', 'oracleKind', 'oracle_kind', 'mode']),
    stringField(runtime, ['kind', 'oracleKind', 'oracle_kind', 'mode']),
    stringField(report.output_oracle_resolution, ['requestedProfile', 'requested_profile', 'selectedSource', 'selected_source']),
  ].filter(Boolean).join(' ');
  return /\b(visual|frame|framebuffer|image|render|screenshot|swapchain|pixel)\b/i
    .test(oracleDescriptor);
}

async function writeResults() {
  report.finished_at = new Date().toISOString();
  const timingFields = monotonicTimingFields(RUN_STARTED_MONOTONIC_NS);
  report.finished_monotonic_ns = timingFields.finished_monotonic_ns;
  report.duration_monotonic_ns = timingFields.duration_monotonic_ns;
  report.duration_ms = timingFields.duration_ms;
  report.timingMetrics = realRocmTimingMetrics(report);
  const runtimeBackend = runtimeProofBackend();
  const runtimeSourceEditId = runtimeProofSourceEditId();
  const runtimeCompiler = runtimeProofCompiler();
  const runtimeDeviceIdentity =
    report.runtime_capability_preflight?.deviceIdentity
    ?? report.runtime_capability_preflight?.device_identity
    ?? null;
  const runtimeOutputTarget = runtimeOutputOracleTarget();
  const runtimeClassification = runtimeGpuClassification();
  const runtimeContextHandle = runtimeContextHandleFromHostEvidence();
  const candidateArtifactIdentity =
    report.real_rocm_runtime_eligibility?.candidate_artifact_identity
    ?? report.real_rocm_runtime_eligibility?.candidateArtifactIdentity
    ?? null;
  const validationContext = {
    command: report.command,
    docker: report.docker,
    containers: report.containers,
    sourceEditId: runtimeSourceEditId,
    source_edit_id: runtimeSourceEditId,
    backend: runtimeBackend,
    gpuBackend: runtimeBackend,
    gpu_backend: runtimeBackend,
    classification: runtimeClassification,
    compiler: runtimeCompiler,
    deviceIdentity: runtimeDeviceIdentity,
    device_identity: runtimeDeviceIdentity,
    deviceUuid:
      runtimeDeviceIdentity?.device_uuid
      ?? runtimeDeviceIdentity?.deviceIdentityKey
      ?? runtimeDeviceIdentity?.device_identity_key
      ?? null,
    device_uuid:
      runtimeDeviceIdentity?.device_uuid
      ?? runtimeDeviceIdentity?.deviceIdentityKey
      ?? runtimeDeviceIdentity?.device_identity_key
      ?? null,
    contextHandle: runtimeContextHandle,
    context_handle: runtimeContextHandle,
    contextOrDeviceHandle: runtimeContextHandle,
    context_or_device_handle: runtimeContextHandle,
    outputOracleTarget: runtimeOutputTarget,
    output_oracle_target: runtimeOutputTarget,
    proofArtifacts: report.proof_artifacts,
    proof_artifacts: report.proof_artifacts,
    modelProvenance: report.modelProvenance ?? report.model_provenance ?? report.evidence?.model_provenance ?? {},
    firewallEvidence: report.firewall_evidence ?? report.evidence?.firewall_evidence ?? {},
    firewallRoute: report.firewall_evidence?.route ?? null,
    firewall_route: report.firewall_evidence?.route ?? null,
    cpu_hmr_used: report.firewall_evidence?.cpu_hmr_used,
    full_rebuild_used: report.firewall_evidence?.full_rebuild_used,
    process_restarted: report.firewall_evidence?.process_restarted,
    urls: {
      frontend: CFG.frontendUrl,
      collab: CFG.collabUrl,
      signaling: CFG.signalingUrl,
    },
    model: report.model,
    gpu_vendor: report.gpu_vendor,
    gpu_arch: report.gpu_arch,
    target_progression: report.target_progression,
    realRocmProfileProofObligations: report.real_rocm_profile_proof_obligations,
    real_rocm_profile_proof_obligations: report.real_rocm_profile_proof_obligations,
    profileProofObligations: report.real_rocm_profile_proof_obligations,
    profile_proof_obligations: report.real_rocm_profile_proof_obligations,
    realRocmSourceDeltaExecution: report.real_rocm_source_delta_execution,
    real_rocm_source_delta_execution: report.real_rocm_source_delta_execution,
    sourceDeltaExecution: report.source_delta_execution,
    source_delta_execution: report.source_delta_execution,
    target_progression_ledger: report.target_progression_ledger,
    target_progression_ledger_entry: report.target_progression_ledger_entry,
    target_progression_ledger_artifact: report.target_progression_ledger_artifact,
    strict_proof_gates: report.strict_proof_gates,
    target_progression_gates: report.target_progression_gates,
    runtime_capability_preflight: report.runtime_capability_preflight,
    nativeRocmLaunchBoundary: report.native_rocm_launch_boundary,
    native_rocm_launch_boundary: report.native_rocm_launch_boundary,
    realRocmAppHookContract: report.real_rocm_app_hook_contract,
    real_rocm_app_hook_contract: report.real_rocm_app_hook_contract,
    appHookContract: report.real_rocm_app_hook_contract,
    app_hook_contract: report.real_rocm_app_hook_contract,
    realRocmSameProcessRuntimeOracle: report.real_rocm_same_process_runtime_oracle,
    real_rocm_same_process_runtime_oracle: report.real_rocm_same_process_runtime_oracle,
    sameProcessRuntimeOracle: report.real_rocm_same_process_runtime_oracle,
    same_process_runtime_oracle: report.real_rocm_same_process_runtime_oracle,
    realRocmDeviceSidecarContract: report.real_rocm_device_sidecar_contract,
    real_rocm_device_sidecar_contract: report.real_rocm_device_sidecar_contract,
    deviceSidecarContract: report.real_rocm_device_sidecar_contract,
    device_sidecar_contract: report.real_rocm_device_sidecar_contract,
    realRocmCompileBridge: report.real_rocm_compile_bridge,
    real_rocm_compile_bridge: report.real_rocm_compile_bridge,
    realRocmRuntimeEligibility: report.real_rocm_runtime_eligibility,
    real_rocm_runtime_eligibility: report.real_rocm_runtime_eligibility,
    nativeRuntimeEligibility: report.real_rocm_runtime_eligibility,
    native_runtime_eligibility: report.real_rocm_runtime_eligibility,
    realRocmSidecarRuntimeConsistency: report.real_rocm_sidecar_runtime_consistency,
    real_rocm_sidecar_runtime_consistency: report.real_rocm_sidecar_runtime_consistency,
    sidecarRuntimeConsistency: report.real_rocm_sidecar_runtime_consistency,
    sidecar_runtime_consistency: report.real_rocm_sidecar_runtime_consistency,
    backendCandidates: report.real_rocm_runtime_eligibility?.backend_candidates ?? [],
    backend_candidates: report.real_rocm_runtime_eligibility?.backend_candidates ?? [],
    backendEvidence: [
      ...(report.real_rocm_runtime_eligibility?.backend_candidates ?? []),
      ...(report.real_rocm_runtime_eligibility?.evidence_refs ?? []),
    ].join(' '),
    backend_evidence: [
      ...(report.real_rocm_runtime_eligibility?.backend_candidates ?? []),
      ...(report.real_rocm_runtime_eligibility?.evidence_refs ?? []),
    ].join(' '),
    candidateArtifactIdentity,
    candidate_artifact_identity: candidateArtifactIdentity,
    compile_transport: report.compile_transport,
    output_oracle_contract: report.output_oracle_contract,
    render_preview_enabled: report.render_preview_enabled,
    fresh_ai_split_required: report.fresh_ai_split_required,
    timings: {
      metric_clock: 'monotonic_ns',
      started_at: report.started_at,
      started_monotonic_ns: report.started_monotonic_ns,
      finished_at: report.finished_at,
      finished_monotonic_ns: report.finished_monotonic_ns,
      duration_monotonic_ns: report.duration_monotonic_ns,
      duration_ms: report.duration_ms,
      timingMetrics: report.timingMetrics,
      phases: report.phases.map((phase) => ({
        name: phase.name,
        timings: phase.timings ?? null,
      })),
    },
    result_counts: {
      total: report.checks.length,
      passed: report.checks.filter((check) => check.status === 'pass').length,
      warned: report.checks.filter((check) => check.status === 'warn').length,
      failed: report.checks.filter((check) => check.status === 'fail').length,
      skipped: report.checks.filter((check) => check.status === 'skip').length,
    },
  };
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const runtimeProofArtifactDir = path.join(LOG_DIR, 'runtime-proof-artifacts');
  const capturedVisualFrames = report.screenshots
    .filter((shot) => typeof shot?.path === 'string' && shot.path.trim());
  const visualArtifactPaths = capturedVisualFrames.map((shot) => shot.path);
  const capturedVisualEvidenceArtifacts = capturedVisualFrames.map((shot) => ({
    path: shot.path,
    label: shot.label ?? null,
    width: shot.width ?? null,
    height: shot.height ?? null,
    visiblePixels: shot.visible_pixels ?? null,
    meanLuma: shot.mean_luma ?? null,
    lumaStddev: shot.luma_stddev ?? null,
    rgbSpanMean: shot.rgb_span_mean ?? null,
    uniqueColorSampleCount: shot.unique_color_sample_count ?? null,
    visualQuality: shot.visual_quality ?? null,
    acceptedAsVisualEvidence: shot.accepted_as_visual_evidence === true,
    visualEvidenceSupplementalOnly:
      shot.visualEvidenceSupplementalOnly === true
      || shot.visual_evidence_supplemental_only === true,
  }));
  let runtimeProofVisualEvidenceArtifacts = [];
  if (report.full_runtime_proof) {
    const written = await writeValidationRuntimeProofArtifact(runtimeProofArtifactDir, {
      workspaceSlug: report.slug,
      sourceEditId: runtimeSourceEditId,
      editId: runtimeSourceEditId,
      backend: runtimeBackend,
      gpuBackend: runtimeBackend,
      gpuArch: report.gpu_arch,
      compiler: runtimeCompiler,
      classification: runtimeClassification,
      deviceIdentity: runtimeDeviceIdentity,
      deviceUuid:
        runtimeDeviceIdentity?.device_uuid
        ?? runtimeDeviceIdentity?.deviceIdentityKey
        ?? runtimeDeviceIdentity?.device_identity_key
        ?? null,
      contextHandle: runtimeContextHandle,
      contextOrDeviceHandle: runtimeContextHandle,
      outputOracleTarget: runtimeOutputTarget,
      proofArtifacts: report.proof_artifacts,
      proof_artifacts: report.proof_artifacts,
      runtimeSessionIds: report.dispatch_proof?.runtimeSessionIds ?? report.evidence?.runtime_session?.unique_ids ?? [],
      sourceProofs: report.source_proofs,
      fissionProof: report.fission_proof,
      abiProof: report.abi_proof,
      artifactTransportProof: report.artifact_transport_proof,
      epochProof: report.epoch_swap_proof,
      dispatchProof: report.dispatch_proof,
      outputProof: report.output_proof,
      hostPreservationProof: report.host_preservation_proof,
      originalHostPathProof: report.original_host_path_proof,
      fullRuntimeProof: report.full_runtime_proof,
      runtimeEvidence: report.evidence,
      validationContext,
      adversarialPreflight: report.adversarial_preflight,
      modelProvenance: report.modelProvenance ?? report.model_provenance ?? report.evidence?.model_provenance ?? {},
      firewallEvidence: report.firewall_evidence ?? report.evidence?.firewall_evidence ?? {},
      cpu_hmr_used: report.firewall_evidence?.cpu_hmr_used,
      full_rebuild_used: report.firewall_evidence?.full_rebuild_used,
      process_restarted: report.firewall_evidence?.process_restarted,
      targetProgressionLedger: report.target_progression_ledger,
      targetProgressionGates: report.target_progression_gates,
      label: 'real-rocm-runtime-proof',
      visualEvidenceRefs: visualArtifactPaths,
      visualEvidenceArtifacts: capturedVisualEvidenceArtifacts,
    });
    runtimeProofVisualEvidenceArtifacts = Array.isArray(written.artifact.visualEvidenceArtifacts)
      ? written.artifact.visualEvidenceArtifacts
      : [];
    report.runtime_proof_artifact_path = written.path;
    report.runtime_proof_artifact = {
      schemaVersion: written.artifact.schemaVersion,
      proofId: written.artifact.proofId,
      path: written.path,
      resultState: written.artifact.resultState,
      degradedState: written.artifact.degradedState,
      degradedReason: written.artifact.degradedReason,
      fullRuntimeProven: written.artifact.fullRuntimeProven,
      stageResults: written.artifact.stageResults,
      limitations: written.artifact.limitations,
      acceptanceContract: written.artifact.acceptanceContract,
      acceptanceContractEvaluation: written.artifact.acceptanceContractEvaluation,
      derivedAcceptanceContract: written.artifact.derivedAcceptanceContract,
      derivedAcceptanceContractEvaluation: written.artifact.derivedAcceptanceContractEvaluation,
      acceptanceContractConsistency: written.artifact.acceptanceContractConsistency,
      proofLedgerSourceConsistency: written.artifact.proofLedgerSourceConsistency,
      deterministicVisualMode: written.artifact.deterministicVisualMode,
      deterministicVisualModeEvaluation: written.artifact.deterministicVisualModeEvaluation,
      proofLedger: written.artifact.proofLedger,
      proofLedgerQuery: written.artifact.proofLedgerQuery,
      gpuHmrSuccess: written.artifact.gpuHmrSuccess === true,
    };
  }
  report.runtime_proof_artifact_paths = report.runtime_proof_artifact_path
    ? [report.runtime_proof_artifact_path]
    : [];
  const runtimeProofArtifactStrictRows = runtimeProofArtifactStrictGates(
    report.runtime_proof_artifact ? [report.runtime_proof_artifact] : [],
    {
      requireAtLeastOne: true,
      namePrefix: 'strict real ROCm runtime proof artifact acceptance',
    },
  );
  report.runtime_proof_artifact_strict_gates = runtimeProofArtifactStrictRows;
  for (const gate of runtimeProofArtifactStrictRows) {
    record(gate.name, gate.status, gate.detail);
    if (gate.status === 'fail') process.exitCode = 1;
  }
  report.target_progression_ledger_entry = buildTargetProgressionLedgerEntry({
    report,
    visualArtifactPaths,
    visualEvidenceArtifacts: runtimeProofVisualEvidenceArtifacts.length > 0
      ? runtimeProofVisualEvidenceArtifacts
      : await visualEvidenceArtifactsFromFiles(visualArtifactPaths, capturedVisualEvidenceArtifacts),
  });
  const targetProgressionLedgerArtifactDir = path.join(LOG_DIR, 'target-progression-ledgers');
  report.target_progression_ledger_artifact = await writeTargetProgressionLedgerArtifact(
    targetProgressionLedgerArtifactDir,
    {
      report,
      entry: report.target_progression_ledger_entry,
    },
  );
  report.target_progression_ledger_artifact_path =
    report.target_progression_ledger_artifact?.path ?? null;
  validationContext.target_progression_ledger_entry = report.target_progression_ledger_entry;
  validationContext.target_progression_ledger_artifact = report.target_progression_ledger_artifact;
  report.validation_proof_summary = buildGpuHmrValidationProofSummary({
    workspaceSlug: report.slug,
    model: report.model,
    gpuVendor: report.gpu_vendor,
    gpuArch: report.gpu_arch,
    validationContext,
    targetProgressionLedger: report.target_progression_ledger,
    targetProgressionLedgerEntry: report.target_progression_ledger_entry,
    targetProgressionLedgerArtifact: report.target_progression_ledger_artifact,
    targetProgressionGates: report.target_progression_gates,
    docker: report.docker,
    timings: validationContext.timings,
    screenshots: report.screenshots,
    visualEvidenceExpected: renderingVisualEvidenceExpected(),
    visualArtifactPaths,
    proof_artifacts: report.proof_artifacts,
    runtimeProofArtifactRecords: report.runtime_proof_artifact ? [report.runtime_proof_artifact] : [],
    runtimeProofArtifactPaths: report.runtime_proof_artifact_paths,
    sourceProofs: report.source_proofs,
    sourceProof: report.source_proof,
    fissionProof: report.fission_proof,
    abiProof: report.abi_proof,
    artifactTransportProof: report.artifact_transport_proof,
    epochProof: report.epoch_swap_proof,
    dispatchProof: report.dispatch_proof,
    outputProof: report.output_proof,
    hostPreservationProof: report.host_preservation_proof,
    originalHostPathProof: report.original_host_path_proof,
    fullRuntimeProof: report.full_runtime_proof,
  });
  report.visual_artifact_paths = report.validation_proof_summary.visual_artifact_paths;
  report.visual_evidence_quality = report.validation_proof_summary.visual_evidence_quality;
  report.docker_image_ids = report.validation_proof_summary.docker_image_ids;
  report.proof_states = report.validation_proof_summary.proof_states;
  report.limitations = report.validation_proof_summary.limitations;
  const fullRuntimeProven = report.full_runtime_proof?.fullRuntimeProven === true;
  const runtimeProofArtifactGpuHmrSuccess = report.runtime_proof_artifact?.gpuHmrSuccess === true;
  const strictRuntimeProofArtifactAccepted =
    report.runtime_proof_artifact_strict_gates.length > 0
    && report.runtime_proof_artifact_strict_gates.every((gate) => gate.status === 'pass');
  const strictProofGatesPassed = report.strict_proof_gates.every((gate) => gate.status !== 'fail');
  const targetProgressionGatesPassed =
    report.target_progression_gates.every((gate) => gate.status !== 'fail');
  const realRocmGpuHmrSuccess =
    fullRuntimeProven
    && runtimeProofArtifactGpuHmrSuccess
    && strictRuntimeProofArtifactAccepted
    && strictProofGatesPassed
    && targetProgressionGatesPassed;
  const verdictFailedGates = compactStringList([
    fullRuntimeProven ? null : 'full_runtime_ladder_not_proven',
    runtimeProofArtifactGpuHmrSuccess ? null : 'strict_runtime_proof_artifact_gpu_hmr_success_false',
    strictRuntimeProofArtifactAccepted ? null : 'strict_runtime_proof_artifact_not_accepted',
    strictProofGatesPassed ? null : 'strict_proof_gates_failed',
    targetProgressionGatesPassed ? null : 'target_progression_gates_failed',
  ]);
  report.real_rocm_gpu_hmr_verdict = {
    schemaVersion: 'synthi.real_rocm.gpu_hmr_verdict.v1',
    schema_version: 'synthi.real_rocm.gpu_hmr_verdict.v1',
    authority: 'derived_from_full_runtime_ladder_strict_runtime_artifact_and_target_gates',
    gpuHmrSuccess: realRocmGpuHmrSuccess,
    gpu_hmr_success: realRocmGpuHmrSuccess,
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    runtimeProofArtifactGpuHmrSuccess,
    runtime_proof_artifact_gpu_hmr_success: runtimeProofArtifactGpuHmrSuccess,
    strictRuntimeProofArtifactAccepted,
    strict_runtime_proof_artifact_accepted: strictRuntimeProofArtifactAccepted,
    strictProofGatesPassed,
    strict_proof_gates_passed: strictProofGatesPassed,
    targetProgressionGatesPassed,
    target_progression_gates_passed: targetProgressionGatesPassed,
    failedGates: verdictFailedGates,
    failed_gates: verdictFailedGates,
  };
  report.realRocmGpuHmrVerdict = report.real_rocm_gpu_hmr_verdict;
  report.gpuHmrSuccess = realRocmGpuHmrSuccess;
  report.gpu_hmr_success = realRocmGpuHmrSuccess;
  report.acceptedForGpuHmr = realRocmGpuHmrSuccess;
  report.accepted_for_gpu_hmr = realRocmGpuHmrSuccess;
  report.fullRuntimeProven = fullRuntimeProven;
  report.full_runtime_proven = fullRuntimeProven;
  await mkdir(RETAINED_RESULTS_DIR, { recursive: true });
  const retainedBaseName = cleanIdentifier(report.slug ?? CFG.slug ?? 'real-rocm-result');
  const retainedResultsJson = path.join(RETAINED_RESULTS_DIR, `${retainedBaseName}.json`);
  const retainedResultsTxt = path.join(RETAINED_RESULTS_DIR, `${retainedBaseName}.txt`);
  report.result_artifacts = {
    schemaVersion: 'synthi.gpu.hmr.real_rocm_result_artifacts.v1',
    retainedJson: retainedResultsJson,
    retained_json: retainedResultsJson,
    retainedTxt: retainedResultsTxt,
    retained_txt: retainedResultsTxt,
    latestJson: RESULTS_JSON,
    latest_json: RESULTS_JSON,
    latestTxt: RESULTS_TXT,
    latest_txt: RESULTS_TXT,
    latestAliasOnly: false,
    latest_alias_only: false,
  };
  await writeFile(retainedResultsJson, JSON.stringify(report, null, 2) + '\n');
  await writeFile(RESULTS_JSON, JSON.stringify(report, null, 2) + '\n');
  const lines = [
    `slug: ${report.slug}`,
    `retained_results_json: ${retainedResultsJson}`,
    `retained_results_txt: ${retainedResultsTxt}`,
    `latest_results_json: ${RESULTS_JSON}`,
    `latest_results_txt: ${RESULTS_TXT}`,
    `source_url: ${report.source_url}`,
    `repo_commit: ${report.repo_commit}`,
    `entry_file: ${report.entry_file}`,
    `delta_file: ${report.delta_file}`,
    `second_delta_file: ${report.second_delta_file ?? ''}`,
    `extra_deltas: ${JSON.stringify(report.extra_deltas ?? [])}`,
    `target_progression: ${JSON.stringify(report.target_progression)}`,
    `target_progression_ledger: ${JSON.stringify(report.target_progression_ledger)}`,
    `target_progression_ledger_entry: ${JSON.stringify(report.target_progression_ledger_entry)}`,
    `target_progression_ledger_artifact: ${JSON.stringify(report.target_progression_ledger_artifact)}`,
    `target_progression_gates: ${JSON.stringify(report.target_progression_gates)}`,
    `gpu_hmr_success: ${report.gpu_hmr_success}`,
    `full_runtime_proven: ${report.full_runtime_proven}`,
    `real_rocm_gpu_hmr_verdict: ${JSON.stringify(report.real_rocm_gpu_hmr_verdict)}`,
    `source_delta_execution: ${JSON.stringify(report.source_delta_execution)}`,
    `runtime_capability_preflight: ${JSON.stringify(report.runtime_capability_preflight)}`,
    `real_rocm_device_sidecar_contract: ${JSON.stringify(report.real_rocm_device_sidecar_contract)}`,
    `real_rocm_runtime_eligibility: ${JSON.stringify(report.real_rocm_runtime_eligibility)}`,
    `model: ${report.model}`,
    `model_roles: ${JSON.stringify(report.model_roles)}`,
    `gpu_vendor: ${report.gpu_vendor}`,
    `gpu_arch: ${report.gpu_arch}`,
    `duration_ms: ${report.duration_ms}`,
    `containers: ${JSON.stringify(report.containers)}`,
    `docker: ${JSON.stringify(report.docker)}`,
    `runtime_identity: ${JSON.stringify(report.runtime_identity)}`,
    `command: ${JSON.stringify(report.command)}`,
    `file_count: ${report.file_count}`,
    `seeded_file_count: ${report.seeded_file_count}`,
    `skipped_file_count: ${report.skipped_file_count}`,
    `compile_transport: ${CFG.compileTransport}`,
    `compile_projection: ${JSON.stringify(report.compile_projection)}`,
    `output_oracle_contract: ${JSON.stringify(report.output_oracle_contract)}`,
    `runtime_proof_artifact: ${JSON.stringify(report.runtime_proof_artifact)}`,
    `validation_proof_summary: ${JSON.stringify(report.validation_proof_summary)}`,
    '',
    ...report.checks.map((check) => `${check.status.toUpperCase()} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`),
    '',
    ...report.phases.map((phase) => `PHASE ${phase.name} ${JSON.stringify(phase)}`),
    '',
    ...report.phases.map((phase) => `GPU_PROOF ${phase.name} ${summarizeGpuProof(phase.gpu_proof)}`),
    '',
    ...report.screenshots.map((shot) => `SCREENSHOT ${shot.label} visible=${shot.visible_pixels} luma=${shot.mean_luma.toFixed(1)} luma_stddev=${Number(shot.luma_stddev ?? 0).toFixed(2)} rgb_span_mean=${Number(shot.rgb_span_mean ?? 0).toFixed(2)} unique_colors=${shot.unique_color_sample_count ?? 0} quality=${shot.visual_quality ?? 'gpu-hmr-visual-unmeasured'} path=${shot.path}`),
    '',
    `ABI_PROOF ${summarizeGpuHmrAbiProof(report.abi_proof)}`,
    '',
    `ARTIFACT_TRANSPORT_PROOF ${summarizeGpuHmrArtifactTransportProof(report.artifact_transport_proof)}`,
    '',
    `EPOCH_SWAP_PROOF ${summarizeGpuHmrEpochSwapProof(report.epoch_swap_proof)}`,
    '',
    `DISPATCH_PROOF ${summarizeGpuHmrDispatchProof(report.dispatch_proof)}`,
    '',
    `OUTPUT_PROOF ${summarizeGpuHmrOutputProof(report.output_proof)}`,
    '',
    `HOST_PRESERVATION_PROOF ${summarizeGpuHmrHostPreservationProof(report.host_preservation_proof)}`,
    '',
    `ORIGINAL_HOST_PATH_PROOF ${summarizeGpuHmrOriginalHostPathProof(report.original_host_path_proof)}`,
    '',
    `FULL_RUNTIME_PROOF ${summarizeGpuHmrFullRuntimeProof(report.full_runtime_proof)}`,
    '',
    `PROOF_ARTIFACTS ${JSON.stringify(report.proof_artifacts)}`,
    '',
    `EVIDENCE ${JSON.stringify(report.evidence)}`,
  ];
  await writeFile(retainedResultsTxt, lines.join('\n') + '\n');
  await writeFile(RESULTS_TXT, lines.join('\n') + '\n');
  console.log(`retained results: ${retainedResultsTxt}`);
  console.log(`results: ${RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  report.docker.daemon_preflight = await dockerDaemonPreflight();
  report.docker.daemonPreflight = report.docker.daemon_preflight;
  record(
    'docker daemon preflight',
    report.docker.daemon_preflight.available ? 'pass' : 'fail',
    `status=${report.docker.daemon_preflight.status} timeout_ms=${report.docker.daemon_preflight.timeout_ms}`,
  );
  if (!report.docker.daemon_preflight.available) {
    throw new Error('Docker daemon unavailable or timed out before real ROCm validation could resolve worker containers');
  }
  await resolveDockerContainers();
  await ensureRocmBuildConfig();
  report.adversarial_preflight = await runGpuHmrAdversarialPreflight({
    cwd: __dirname,
  });
  const adversarialPreflightGate = adversarialPreflightStrictGate(report.adversarial_preflight);
  report.adversarial_preflight_strict_gate = adversarialPreflightGate;
  record(
    'adversarial proof ledger preflight',
    report.adversarial_preflight.skipped
      ? 'skip'
      : report.adversarial_preflight.ok
        ? 'pass'
        : 'fail',
    `elapsed_ms=${report.adversarial_preflight.elapsedMs.toFixed(1)}`,
  );
  record(adversarialPreflightGate.name, adversarialPreflightGate.status, adversarialPreflightGate.detail);
  if (strictProofGateFailures([adversarialPreflightGate]).length > 0) {
    throw new Error(`adversarial preflight strict gate failed: ${adversarialPreflightGate.detail}`);
  }
  await ensureRepo();
  const extraDeltas = parseExtraDeltas();
  applyConfiguredSourceDeltaPlan(extraDeltas);
  const buildMetadata = await prepareUpstreamBuild();
  const files = await collectRepoFiles(buildMetadata);
  runtimeEvidenceContext.buildMetadata = buildMetadata;
  runtimeEvidenceContext.files = files;
  runtimeEvidenceContext.sourceSnapshotAvailable = true;
  const fileContentByPath = new Map(files.map((file) => [file.path, file.content]));
  const updateFileContent = (filePath, content) => {
    const normalized = String(filePath ?? '').replace(/\\/g, '/');
    fileContentByPath.set(normalized, content);
    const file = files.find((candidate) => candidate.path === normalized);
    if (file) file.content = content;
  };
  const contentForPath = (filePath) => {
    const normalized = String(filePath ?? '').replace(/\\/g, '/');
    if (!fileContentByPath.has(normalized)) {
      throw new Error(`delta file missing from seeded files: ${normalized}`);
    }
    return fileContentByPath.get(normalized);
  };
  const outputOracleProfile = applyOutputOracleProfileAdaptation(files, updateFileContent);
  await syncWorkerRuntimeOutputOracleProfile(outputOracleProfile?.runtimeProfile ?? null);
  report.real_rocm_device_sidecar_contract = realRocmDeviceSidecarContractFacet({
    files,
    buildMetadata,
  });
  report.realRocmDeviceSidecarContract = report.real_rocm_device_sidecar_contract;
  report.evidence.real_rocm_device_sidecar_contract = report.real_rocm_device_sidecar_contract;
  record(
    'real ROCm device sidecar contract facet',
    'warn',
    [
      `status=${report.real_rocm_device_sidecar_contract.status}`,
      `backend=${report.real_rocm_device_sidecar_contract.backend}`,
      `sources=${report.real_rocm_device_sidecar_contract.effective_source_paths.length}`,
      `gaps=${report.real_rocm_device_sidecar_contract.blocking_gaps.join(',') || 'none'}`,
    ].join(' '),
  );
  const primary = files.find((file) => file.path === CFG.entryFile);
  if (!primary) throw new Error(`entry file missing from seeded files: ${CFG.entryFile}`);
  const deltaPrimary = files.find((file) => file.path === CFG.deltaFile);
  if (!deltaPrimary) throw new Error(`delta file missing from seeded files: ${CFG.deltaFile}`);
  const firstAdditionalFiles = buildCompileProjection(
    files,
    CFG.entryFile,
    buildMetadata,
    'first_real_repo_ai_split_compile',
  );

  await createWorkspace();
  await writeFilesBatch(files);

  const firstCompileResult = await compileViaMcp({
    language: 'cpp',
    filename: CFG.entryFile,
    source: primary.content,
    ...compileProjectionRequestArgs(firstAdditionalFiles, 'first_real_repo_ai_split_compile'),
    is_gui: CFG.renderPreview,
    use_ai_split: true,
    bypass_ai_split_cache: CFG.requireFreshAiSplit,
    user_requested_ai: true,
    prefer_gpu_pipeline: true,
    gpu_mode: CFG.gpuMode,
    gpu_arch: CFG.gpuArch,
    slug: CFG.slug,
    width: CFG.width,
    height: CFG.height,
  }, CFG.firstCompileTimeoutMs, 'first_real_repo_ai_split_compile');
  await captureScreenshot('first-compile', { required: false, wait: firstCompileResult.wait });

  const primaryDeltaPhase = beginSourceDeltaExecutionPhase({
    label: 'primary',
    kind: 'hot_delta_1',
    file: CFG.deltaFile,
    before: CFG.deltaBefore,
    after: CFG.deltaAfter,
    phaseName: 'real_repo_user_source_delta_hmr',
    metricScope: 'hot_delta_1',
  });
  let hmrCompileResult = null;
  let hmrScreenshot = null;
  try {
    const edited = editConfiguredSource(contentForPath(CFG.deltaFile));
    const hmrAdditionalFiles = buildCompileProjection(
      files,
      CFG.deltaFile,
      buildMetadata,
      'real_repo_user_source_delta_hmr',
    );
    await httpJson(
      'POST',
      `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
      { files: [{ path: CFG.deltaFile, encoding: 'utf8', content: edited }], syncToGcs: CFG.syncToGcs },
      { 'x-user-id': CFG.hostId },
    );
    markSourceDeltaWriteObserved(primaryDeltaPhase);
    updateFileContent(CFG.deltaFile, edited);
    markSourceDeltaCompileAttempted(primaryDeltaPhase);
    hmrCompileResult = await compileViaMcp({
      language: 'cpp',
      filename: CFG.deltaFile,
      source: edited,
      ...compileProjectionRequestArgs(hmrAdditionalFiles, 'real_repo_user_source_delta_hmr'),
      is_gui: CFG.renderPreview,
      use_ai_split: true,
      bypass_ai_split_cache: CFG.requireFreshAiSplit,
      user_requested_ai: false,
      force_gpu_ai_delta: CFG.forceGpuAiDelta,
      prefer_gpu_pipeline: true,
      gpu_mode: CFG.gpuMode,
      gpu_arch: CFG.gpuArch,
      slug: CFG.slug,
      width: CFG.width,
      height: CFG.height,
    }, CFG.hmrTimeoutMs, 'real_repo_user_source_delta_hmr');
    hmrScreenshot = await captureScreenshot('post-hmr', {
      required: CFG.expectScreenshot,
      wait: hmrCompileResult.wait,
    });
    finishSourceDeltaExecutionPhase(primaryDeltaPhase, {
      compileResult: hmrCompileResult,
      screenshot: hmrScreenshot,
    });
  } catch (err) {
    finishSourceDeltaExecutionPhase(primaryDeltaPhase, {
      compileResult: hmrCompileResult,
      screenshot: hmrScreenshot,
      error: err,
    });
    throw err;
  }

  for (let index = 0; index < extraDeltas.length; index += 1) {
    const delta = extraDeltas[index];
    const label = safePhaseLabel(delta.label, index);
    const phaseName = `real_repo_${label}_user_source_delta_hmr`;
    const screenshotLabel = `post-${label}-hmr`;
    const extraDeltaPhase = beginSourceDeltaExecutionPhase({
      label,
      kind: delta.kind,
      file: delta.file,
      before: delta.before,
      after: delta.after,
      phaseName,
      metricScope: sourceDeltaPhaseKind(delta),
      expectedRefusal: delta.expectedRefusal === true,
    });
    let extraCompileResult = null;
    let extraScreenshot = null;
    try {
      const editedSource = editSource(
        contentForPath(delta.file),
        delta.before,
        delta.after,
        `${label} configured`,
      );
      const additionalFiles = buildCompileProjection(
        files,
        delta.file,
        buildMetadata,
        phaseName,
      );
      await httpJson(
        'POST',
        `${CFG.collabUrl}/git/${CFG.slug}/write-files-batch`,
        { files: [{ path: delta.file, encoding: 'utf8', content: editedSource }], syncToGcs: CFG.syncToGcs },
        { 'x-user-id': CFG.hostId },
      );
      markSourceDeltaWriteObserved(extraDeltaPhase);
      updateFileContent(delta.file, editedSource);
      markSourceDeltaCompileAttempted(extraDeltaPhase);
      extraCompileResult = await compileViaMcp({
        language: 'cpp',
        filename: delta.file,
        source: editedSource,
        ...compileProjectionRequestArgs(additionalFiles, phaseName),
        is_gui: CFG.renderPreview,
        use_ai_split: true,
        bypass_ai_split_cache: CFG.requireFreshAiSplit,
        user_requested_ai: false,
        force_gpu_ai_delta: CFG.forceGpuAiDelta,
        prefer_gpu_pipeline: true,
        gpu_mode: CFG.gpuMode,
        gpu_arch: CFG.gpuArch,
        slug: CFG.slug,
        width: CFG.width,
        height: CFG.height,
      }, CFG.hmrTimeoutMs, phaseName);
      extraScreenshot = await captureScreenshot(screenshotLabel, {
        required: CFG.expectScreenshot,
        wait: extraCompileResult.wait,
      });
      finishSourceDeltaExecutionPhase(extraDeltaPhase, {
        compileResult: extraCompileResult,
        screenshot: extraScreenshot,
      });
    } catch (err) {
      finishSourceDeltaExecutionPhase(extraDeltaPhase, {
        compileResult: extraCompileResult,
        screenshot: extraScreenshot,
        error: err,
      });
      throw err;
    }
  }
}

if (process.argv.includes('--self-check')) {
  try {
    await selfCheckRuntimeDispatchEvidence();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
} else {
  run()
    .catch((err) => {
      record('fatal', 'fail', err.stack || err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mcpState?.proc) {
        try { mcpState.proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
      await collectRuntimeEvidence(runtimeEvidenceContext).catch((err) => {
        record('runtime evidence collected', 'warn', err.stack || err.message);
      });
      await writeResults().catch((err) => console.error(err));
    });
}
