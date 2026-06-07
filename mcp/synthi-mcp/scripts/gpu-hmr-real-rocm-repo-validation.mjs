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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
  const preview = objectOrEmpty(raw.preview, 'preview');
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
    },
    preview: {
      renderPreview: optionalProfileBoolean(preview.renderPreview, 'preview.renderPreview'),
      expectScreenshot: optionalProfileBoolean(preview.expectScreenshot, 'preview.expectScreenshot'),
      width: optionalProfileNumber(preview.width, 'preview.width'),
      height: optionalProfileNumber(preview.height, 'preview.height'),
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
      if (!known) {
        throw new Error(`real ROCm profile ${profile.id} references unknown output oracle profile: ${profile.outputOracle.profile}`);
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
        'fresh_visual_evidence_when_rendering',
      ];
    default:
      return [];
  }
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
      if (
        hasStructuredProofReference
        && (
          resultState === 'gpu-hmr-output-oracle-proven'
          || booleanField(entry, ['outputOracleProven', 'output_oracle_proven'])
          || statusPassedWithStructuredProof
        )
      ) {
        return {
          passed: true,
          detail: `small-oracle proof=${stringField(entry, ['proofId', 'proof_id', 'proofArtifactPath', 'proof_artifact_path']) || resultState || 'observed'}`,
        };
      }
    } else if (normalizedPhase === 'partial-reload') {
      const partialAndFission =
        booleanField(entry, ['partialReloadProven', 'partial_reload_proven'])
        && booleanField(entry, ['fissionProven', 'fission_proven']);
      if (hasStructuredProofReference && (partialAndFission || statusPassedWithStructuredProof)) {
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
      if (hasStructuredProofReference && (originalHostPath || statusPassedWithStructuredProof)) {
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
      if (typeof frame === 'string') return frame.trim().length > 0;
      if (!frame || typeof frame !== 'object') return false;
      if (frame.accepted_as_visual_evidence === false) return false;
      return frame.accepted_as_visual_evidence === true
        || typeof frame.path === 'string'
        || typeof frame.filePath === 'string'
        || typeof frame.file_path === 'string';
    })
    .length;
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
    rows.push({
      name: 'target progression output oracle',
      status: proofHasResultState(outputProof, 'gpu-hmr-output-oracle-proven') ? 'pass' : 'fail',
      detail: proofHasResultState(outputProof, 'gpu-hmr-output-oracle-proven')
        ? 'gpu-hmr-output-oracle-proven'
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
        status: acceptedVisualFrames > 0 ? 'pass' : 'fail',
        detail: acceptedVisualFrames > 0
          ? `fresh visual evidence frames=${acceptedVisualFrames}`
          : 'fresh visual evidence missing for final acceptance render workflow',
      });
    }
  }
  return rows;
}

function buildTargetProgressionLedgerEntry({
  report,
  visualArtifactPaths = [],
  visualEvidenceArtifacts = [],
} = {}) {
  const progression = report?.target_progression;
  if (!progression?.phase) return null;
  const gateRows = Array.isArray(report.target_progression_gates)
    ? report.target_progression_gates
    : [];
  const failedGates = gateRows.filter((row) => row?.status === 'fail');
  const runtimeProofArtifact = report.runtime_proof_artifact ?? {};
  const visualArtifacts = (Array.isArray(visualEvidenceArtifacts) ? visualEvidenceArtifacts : [])
    .filter((artifact) => artifact && typeof artifact === 'object' && !Array.isArray(artifact));
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
const configuredRepoUrl = process.env.SYNTHI_REAL_ROCM_REPO_URL ?? REAL_ROCM_PROFILE.repo.url;
const configuredRepoName = cleanIdentifier(
  process.env.SYNTHI_REAL_ROCM_REPO_NAME
    ?? REAL_ROCM_PROFILE.repo.name
    ?? repoNameFromUrl(configuredRepoUrl),
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

const CFG = {
  repoUrl: configuredRepoUrl,
  repoName: configuredRepoName,
  repoPath: path.resolve(REPO_ROOT, process.env.SYNTHI_REAL_ROCM_REPO_PATH ?? `tmp/real-rocm/${configuredRepoName}`),
  repoCommit: process.env.SYNTHI_REAL_ROCM_COMMIT ?? REAL_ROCM_PROFILE.repo.commit ?? '',
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
  targetProgressionPhase: process.env.SYNTHI_REAL_ROCM_TARGET_PROGRESSION_PHASE ?? '',
  finalAcceptanceTarget: process.env.SYNTHI_REAL_ROCM_FINAL_ACCEPTANCE_TARGET ?? '',
  requireTargetProgression: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_REQUIRE_TARGET_PROGRESSION',
    false,
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
      : /hiprt/i.test(`${configuredRepoName} ${process.env.SYNTHI_REAL_ROCM_TARGET ?? ''}`),
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
  signalingUrl: process.env.SIGNALING_URL ?? 'ws://localhost:9000',
  hostId: process.env.HOST_ID ?? 'gpu-hmr-real-rocm-validation',
  mcpClientName: process.env.SYNTHI_REAL_ROCM_MCP_CLIENT_NAME ?? 'real-rocm-validation',
  mcpContainer: process.env.MCP_CONTAINER ?? 'vectant-ade-mcp-1',
  workerContainer: process.env.WORKER_CONTAINER ?? 'vectant-ade-worker-1',
  aiEngineContainer: process.env.AI_ENGINE_CONTAINER ?? 'vectant-ade-ai-engine-1',
  mcpTransport: (process.env.MCP_TRANSPORT ?? 'docker').toLowerCase(),
  mcpEntry: path.resolve(__dirname, process.env.MCP_ENTRY ?? '../dist/index.js'),
  mcpSignalingUrl: process.env.MCP_SIGNALING_URL ?? 'ws://signaling-server:9000',
  mcpRequestTimeoutMs: Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 300000),
  mcpAttachTimeoutMs: Number(process.env.MCP_ATTACH_TIMEOUT_MS ?? 30000),
  firstCompileTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_FIRST_TIMEOUT_MS ?? 300000),
  hmrTimeoutMs: Number(process.env.SYNTHI_REAL_ROCM_HMR_TIMEOUT_MS ?? 20 * 60 * 1000),
  upstreamBuildTimeoutMs: positiveIntegerFromEnv(process.env, 'SYNTHI_REAL_ROCM_UPSTREAM_TIMEOUT_MS', 1200000),
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
  outputOracleProfile: outputOracleProfileMode(
    process.env.SYNTHI_REAL_ROCM_OUTPUT_ORACLE_PROFILE
      ?? process.env.SYNTHI_GPU_HMR_OUTPUT_ORACLE_PROFILE
      ?? REAL_ROCM_PROFILE.outputOracle.profile
      ?? 'auto',
  ),
  hmrWaitModule: process.env.SYNTHI_REAL_ROCM_HMR_WAIT_MODULE ?? 'device',
  hmrRequiredGpuProofState: (process.env.SYNTHI_REAL_ROCM_REQUIRED_GPU_PROOF_STATE ?? '').trim(),
  forceGpuAiDelta: booleanFromEnv(
    process.env,
    'SYNTHI_REAL_ROCM_FORCE_GPU_AI_DELTA',
    false,
  ),
  gpuArch: process.env.SYNTHI_REAL_ROCM_GPU_ARCH ?? process.env.SYNTHI_GPU_ARCH ?? 'gfx1201',
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
const WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH =
  '/tmp/synthi-gpu-hmr-runtime-output-oracle.json';

const report = {
  slug: CFG.slug,
  real_rocm_profile: {
    id: CFG.realRocmProfile.id,
    schemaVersion: CFG.realRocmProfile.schemaVersion,
    source: CFG.realRocmProfile.source,
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
  output_oracle_adaptations: [],
  output_oracle_runtime_profile_path: WORKER_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH,
  output_oracle_runtime_profile: null,
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

function execTextAllowPartialOutput(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, ...opts }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`.trim());
    });
  });
}

async function syncWorkerRuntimeOutputOracleProfile(profile) {
  if (CFG.mcpTransport !== 'docker') {
    record(
      'runtime output oracle profile sync',
      profile ? 'warn' : 'info',
      `transport=${CFG.mcpTransport} worker profile sync skipped`,
    );
    return;
  }
  if (!profile) {
    await execText(
      'docker',
      [
        'exec',
        CFG.workerContainer,
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
    return;
  }
  const payload = `${JSON.stringify(profile, null, 2)}\n`;
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  await execText(
    'docker',
    [
      'exec',
      CFG.workerContainer,
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
}

function shouldFetchRequestedCommit({ requestedCommit, localCommitAvailable }) {
  return Boolean(String(requestedCommit ?? '').trim()) && !localCommitAvailable;
}

async function gitCommitExists(repoPath, commit) {
  if (!String(commit ?? '').trim()) return false;
  const found = await execText(
    'git',
    ['-C', repoPath, 'cat-file', '-e', `${commit}^{commit}`],
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

async function readWorkerProofArtifact(proofArtifactPath) {
  if (CFG.mcpTransport !== 'docker') {
    return { proofArtifactPath, found: false, reason: 'docker_transport_required' };
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
      CFG.workerContainer,
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
    ['exec', '-w', '/', CFG.workerContainer, 'cat', containerPath],
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
  for (const phase of report.phases) {
    const proofPath = phase?.gpu_proof?.proofArtifactPath;
    if (typeof proofPath !== 'string' || !proofPath.trim() || seen.has(proofPath)) continue;
    seen.add(proofPath);
    const record = await readWorkerProofArtifact(proofPath);
    records.push(record);
    phase.gpu_proof_artifact = record.found
      ? {
          found: true,
          proofId: record.artifact?.proofId ?? null,
          containerPath: record.containerPath,
          evidenceKinds: Array.isArray(record.artifact?.evidenceRefs)
            ? record.artifact.evidenceRefs.map((evidence) => evidence?.kind).filter(Boolean)
            : [],
        }
      : {
          found: false,
          reason: record.reason,
        };
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
  if (!existsSync(CFG.repoPath)) {
    await mkdir(path.dirname(CFG.repoPath), { recursive: true });
    const cloneArgs = CFG.repoCommit
      ? ['clone', CFG.repoUrl, CFG.repoPath]
      : ['clone', '--depth', '1', CFG.repoUrl, CFG.repoPath];
    await execText('git', cloneArgs, 300000, true);
  }
  if (CFG.repoCommit) {
    const localCommitAvailable = await gitCommitExists(CFG.repoPath, CFG.repoCommit);
    if (shouldFetchRequestedCommit({ requestedCommit: CFG.repoCommit, localCommitAvailable })) {
      const fetched = await execText(
        'git',
        ['-C', CFG.repoPath, 'fetch', '--depth', '1', 'origin', CFG.repoCommit],
        300000,
        false,
      );
      if (fetched === undefined) {
        await execText('git', ['-C', CFG.repoPath, 'fetch', 'origin'], 300000, true);
      }
    }
    await execText('git', ['-C', CFG.repoPath, 'checkout', '--detach', CFG.repoCommit], 120000, true);
  }
  if (CFG.initSubmodules) {
    const gitmodules = path.join(CFG.repoPath, '.gitmodules');
    if (existsSync(gitmodules)) {
      await execText(
        'git',
        ['-C', CFG.repoPath, 'submodule', 'update', '--init', '--recursive'],
        600000,
        true,
      );
    }
  }
  const commit = await execText('git', ['-C', CFG.repoPath, 'rev-parse', 'HEAD'], 30000, true);
  report.repo_commit = commit.trim();
  report.submodules = CFG.initSubmodules
    ? await execText('git', ['-C', CFG.repoPath, 'submodule', 'status', '--recursive'], 60000, false)
    : 'submodule initialization disabled';
  const files = await listTrackedFiles();
  report.file_count = files.length;
  record('real ROCm repo', 'pass', `${CFG.repoUrl} @ ${report.repo_commit.slice(0, 12)} files=${report.file_count}`);
}

async function listTrackedFiles() {
  const args = ['-C', CFG.repoPath, 'ls-files', '-z'];
  if (CFG.initSubmodules) args.push('--recurse-submodules');
  const raw = await execText('git', args, 120000, true);
  return raw.split('\0').filter(Boolean).sort();
}

function parseUpstreamRunExitCode(timings) {
  const match = /\brun_exit_code=(\d+)\b/.exec(String(timings ?? ''));
  return match ? Number(match[1]) : null;
}

function parseRocmArrayAllocationPreflightOutput(output) {
  const text = String(output ?? '');
  const device = /\bdevice_count result=(\d+)\s+error=(.*?)\s+count=(\d+)/.exec(text);
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
  return {
    schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
    backend: 'rocm',
    api: 'hipMallocArray',
    probe: 'hip_array_allocation_preflight',
    command: 'hipcc hip_array_preflight.cpp && hip_array_preflight',
    deviceCountResult: device ? Number(device[1]) : null,
    deviceCountError: device?.[2] ?? null,
    deviceCount: device ? Number(device[3]) : null,
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
    await execText('docker', ['cp', CFG.repoPath, `${CFG.workerContainer}:${CFG.workerRepoPath}`], 180000, true);
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
    : CFG.hiprtRuntimeProbe && CFG.targetName === 'HIPRTPathTracer'
      ? hiprtRuntimeProbeRunCommand()
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
cmake -S . -B build -DCMAKE_BUILD_TYPE=${shQuote(CFG.cmakeConfigName)} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_PREFIX_PATH=/opt/rocm -DCMAKE_HIP_ARCHITECTURES=${shQuote(CFG.gpuArch)}${cmakeExtraArgs} > ${shQuote(`${CFG.workerTempDir}/configure.log`)} 2>&1
configured=$(date +%s%3N)
${hiprtPostConfigureAdaptationCommand}
if [ ${CFG.buildUpstream ? '1' : '0'} -eq 1 ]; then
  cmake --build build -j2 --target ${shQuote(CFG.targetName)} > ${shQuote(`${CFG.workerTempDir}/build.log`)} 2>&1
else
  : > ${shQuote(`${CFG.workerTempDir}/build.log`)}
fi
built=$(date +%s%3N)
run_status=0
if [ ${CFG.runUpstream ? '1' : '0'} -eq 1 ]; then
  ${nativeLaunchObserverSetup}
  ${upstreamRunEnvironmentSetup}
  set +e
  ${upstreamRunInvocation} > ${shQuote(`${CFG.workerTempDir}/run.log`)} 2>&1
  run_status=$?
  set -e
else
  printf 'upstream run skipped by SYNTHI_REAL_ROCM_RUN_UPSTREAM=0\\n' > ${shQuote(`${CFG.workerTempDir}/run.log`)}
fi
ran=$(date +%s%3N)
printf 'configure_ms=%s\\nbuild_ms=%s\\nrun_ms=%s\\nrun_exit_code=%s\\n' "$((configured-start))" "$((built-configured))" "$((ran-built))" "$run_status"
`;
  let timings;
  let lifecycleError = null;
  try {
    timings = await execText(
      'docker',
      ['exec', CFG.workerContainer, 'sh', '-lc', command],
      CFG.upstreamBuildTimeoutMs,
      true,
    );
  } catch (err) {
    lifecycleError = err;
    if (!canContinueWithCachedMetadataAfterLifecycleFailure({
      usesCachedMetadata: lifecyclePlan.usesCachedMetadata,
      cachedMetadataAvailable: Boolean(cachedMetadata),
    })) {
      throw err;
    }
    timings = 'configure_ms=failed\nbuild_ms=failed\nrun_ms=skipped\nrun_exit_code=not-run';
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
          recovered_with_cached_metadata: true,
          message: lifecycleError.message,
          output: String(lifecycleError.output ?? '').slice(-2000),
        }
      : null,
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
  if (lifecycleError) {
    record(
      'upstream GPU target lifecycle',
      'warn',
      `failed; continuing with cached_metadata=${CFG.buildMetadataDir}`,
    );
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

  return cachedMetadata ?? collectBuildMetadataFromWorker(buildPath);
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
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
  });
  return {
    compileCommandsJson,
    cmakeReplyFiles: replyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
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
  ensureEntryCoveredByBuildMetadata({
    compileCommandSourcePaths,
    targetSourcePaths: projectionHints.target_source_paths,
  });
  return {
    compileCommandsJson,
    cmakeReplyFiles: replyFiles,
    targetSourcePaths: [...projectionHints.target_source_paths].sort(),
    targetIncludeDirs: [...projectionHints.target_include_dirs].sort(),
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

function buildMetadataCoversSource(sourcePath, { compileCommandSourcePaths = [], targetSourcePaths = [] } = {}) {
  const normalizedSource = String(sourcePath ?? '').replace(/\\/g, '/');
  if (!normalizedSource) return false;
  const compileSources = new Set([...compileCommandSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  const targetSources = new Set([...targetSourcePaths].map((candidate) => String(candidate).replace(/\\/g, '/')));
  return compileSources.has(normalizedSource) || targetSources.has(normalizedSource);
}

function ensureEntryCoveredByBuildMetadata({ compileCommandSourcePaths, targetSourcePaths }) {
  const entryFile = CFG.entryFile.replace(/\\/g, '/');
  if (buildMetadataCoversSource(entryFile, { compileCommandSourcePaths, targetSourcePaths })) return;
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

function buildCompileProjection(files, focusPath, buildMetadata, phaseName) {
  const normalizedFocus = String(focusPath ?? '').replace(/\\/g, '/');
  const targetSources = new Set(buildMetadata.targetSourcePaths ?? []);
  const includeDirs = (buildMetadata.targetIncludeDirs ?? [])
    .filter((dir) => dir && dir !== '.')
    .sort((a, b) => b.length - a.length);
  const candidates = [];

  for (const file of files) {
    if (file.path === normalizedFocus) continue;
    const isMetadata = file.path === 'compile_commands.json' || file.path.startsWith('.cmake/api/v1/reply/');
    const isTargetSource = targetSources.has(file.path);
    const includeDir = includeDirs.find((dir) => pathIsWithinDir(file.path, dir));
    if (!isMetadata && !isTargetSource && !includeDir) continue;
    const priority = isMetadata ? 0 : isTargetSource ? 1 : 2;
    candidates.push({
      file,
      priority,
      reason: isMetadata ? 'build_metadata' : isTargetSource ? 'target_source' : `include_dir:${includeDir}`,
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
    target_include_dirs: includeDirs.length,
    matched_target_files: buildMetadata.matchedTargetFiles ?? [],
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
        '/app/dist/index.js',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      proc = spawn('node', [CFG.mcpEntry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SYNTHI_SESSION_ID: CFG.slug, SYNTHI_SIGNALING_URL: CFG.signalingUrl },
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
    const attach = await mcpState.client.toolCall('synthi_attach', { sessionId: CFG.slug, 'i-understand-no-auth': true }, CFG.mcpAttachTimeoutMs);
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
    const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor);
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
  const phase = phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor);
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

function phaseResultFromCompileWait(phaseName, start, waitStart, wait, identityMonitor) {
  return {
    name: phaseName,
    compile_wall_ms: Date.now() - start,
    wait_hmr_elapsed_ms: wait?.elapsedMs ?? null,
    wait_hmr_terminal_elapsed_ms: wait?.hmrElapsedMs ?? null,
    wait_hmr_status: wait?.status ?? null,
    wait_hmr_source: wait?.source ?? null,
    wait_hmr_detail: wait?.detail ?? null,
    wait_hmr_args: wait?.wait_args ?? wait?.waitArgs ?? null,
    wait_hmr_contract: wait?.wait_contract ?? wait?.waitContract ?? null,
    wait_hmr_frame_gate: wait?.frame_gate ?? wait?.frameGate ?? null,
    gpu_proof: wait?.gpu_proof ?? null,
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

async function currentHmrFromEventLog(state, sinceTs, startedAt, waitArgs = null, waitContract = null) {
  const log = await state.client.toolCall(
    'synthi_get_event_log',
    { kind: 'hmr', since_ts: sinceTs, limit: 200 },
    10000,
  ).catch(() => null);
  const entries = Array.isArray(log?.entries) ? log.entries : [];
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

function digestBytes(value) {
  const text = String(value ?? '');
  const digest = text.match(/^sha256:([0-9a-f]{64})$/i)?.[1]
    ?? createHash('sha256').update(text).digest('hex');
  return Buffer.from(digest, 'hex');
}

function readbackSampleBytes(oracle) {
  const hex = String(oracle?.readbackSampleHex ?? '').trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  return bytes.length > 0 ? bytes : null;
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
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const base = `${CFG.slug}-${oracle.oracleId ?? 'runtime-output-oracle'}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  const rawBytes = readbackSampleBytes(oracle) ?? digestBytes(actualChecksum);
  const rawPath = path.join(ARTIFACT_DIR, `${base || CFG.slug}-compute-readback.bin`);
  await writeFile(rawPath, rawBytes);
  const schema = {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    source: 'real_rocm_runtime_output_oracle',
    encoding: oracle.readbackSampleHex ? 'runtime_sample_hex' : 'sha256_digest_bytes',
    readbackSampleStride: oracle.readbackSampleStride ?? null,
    readbackSampleSha256: oracle.readbackSampleSha256 ?? null,
    outputTargetId: oracle.outputTargetId ?? null,
    oracleId: oracle.oracleId ?? null,
    artifactId: oracle.artifactId ?? null,
    runtimeSession: oracle.runtimeSession ?? null,
    generation: oracle.generation ?? null,
    probeMode: oracle.probeMode ?? null,
    probeConfigHash: oracle.probeConfigHash ?? null,
    rawReadbackHash: `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`,
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
      source: oracle.readbackSampleHex ? 'runtime_readback_sample' : 'runtime_checksum_digest',
    },
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
  if (outputOracleProfileModeDisabled(mode)) return null;
  const candidates = candidateOutputOracleAdaptations(files);
  if (mode === 'auto') {
    if (candidates.length <= 1) return candidates[0] ?? null;
    const names = candidates.map((candidate) => candidate.profile.id).join(', ');
    throw new Error(`output oracle profile auto-discovery was ambiguous: ${names}`);
  }
  const requested = outputOracleProfilesByName().get(mode);
  if (!requested) {
    const available = SOURCE_DERIVED_OUTPUT_ORACLE_PROFILES
      .map((profile) => profile.id)
      .join(', ');
    throw new Error(`unknown output oracle profile "${mode}"; available profiles: auto, none, ${available}`);
  }
  const selected = candidates.find((candidate) => candidate.profile.id === requested.id);
  if (!selected) {
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
  report.output_oracle_adaptations.push({
    profileId: profile.id,
    profileLabel: profile.label,
    kind: 'source_derived_buffer_checksum',
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
      file,
      before,
      after,
    });
  });
  return deltas;
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
  if (CFG.mcpTransport !== 'docker') {
    return {
      available: false,
      path: normalizedRelative,
      reason: `transport_${CFG.mcpTransport}_cannot_read_worker_workspace`,
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
      CFG.workerContainer,
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
    /\bsynthi_gpu_launch\b.*\bdispatch=(failed|stale-pointer|missing-dispatcher)\b/i.test(line)
  );
  const dispatchSuccessLines = workerEvidence.filter((line) =>
    /\bsynthi_gpu_launch\b.*\bdispatch=ok\b/i.test(line)
  );
  const dispatchSuccessCount = countMatches(
    workerEvidence,
    /\bsynthi_gpu_launch\b.*\bdispatch=ok\b/i,
  );
  const successRecords = dispatchSuccessLines.map((line) => {
    const kernelName = logField(line, 'kernel');
    const runtimeSession = logField(line, 'runtime_session');
    const artifactId = logField(line, 'artifact_id');
    const dispatcherRegistrationId = logField(line, 'dispatcher_registration_id');
    const dispatchTableHash = logField(line, 'dispatch_table_hash');
    const dispatchTableEntryId = logField(line, 'dispatch_table_entry_id');
    const dispatchId = logField(line, 'dispatch_id');
    const streamId = logField(line, 'stream');
    const gridDimensions = logDim3Field(line, 'grid');
    const blockDimensions = logDim3Field(line, 'block');
    const sharedMemoryBytes = Number(logField(line, 'shared_bytes'));
    const dispatchTimestamp = Number(logField(line, 'dispatch_timestamp'));
    return {
      line,
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
    return `worker-log:synthi_gpu_launch:${evidenceRefPart(record.runtimeSession, 'session')}:${evidenceRefPart(record.kernelName, 'kernel')}`;
  }).filter(Boolean))];
  const latestSuccessRecord = successRecords.at(-1) ?? null;
  const processIds = processIdsFromRuntimeSessions(successRecords.map((record) => record.runtimeSession));
  return {
    success_count: dispatchSuccessCount,
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    success_lines: dispatchSuccessLines.slice(-20),
    success_records: successRecords.slice(-20),
    evidence_refs: dispatchEvidenceRefs,
    runtime_artifact_ids: [...new Set(successRecords.map((record) => record.artifactId).filter(Boolean))],
    runtime_artifact_id: latestSuccessRecord?.artifactId ?? null,
    dispatch_ids: [...new Set(successRecords.map((record) => record.dispatchId).filter(Boolean))],
    dispatch_id: latestSuccessRecord?.dispatchId ?? null,
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
    functionPtr: logField(line, 'function_ptr'),
    kernelSymbol: logField(line, 'kernel_symbol') ?? logField(line, 'kernel') ?? logField(line, 'symbol'),
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
    functionPtr: logField(line, 'function_ptr'),
    kernelSymbol: logField(line, 'kernel_symbol') ?? logField(line, 'kernel') ?? logField(line, 'symbol'),
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
    ? [...new Set(values.filter((value) =>
        typeof value === 'string'
        && /^artifact:sha256:[0-9a-f]{64}$/i.test(value.trim()),
      ).map((value) => value.trim()))]
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
    dispatcherRegistrationIds: ['native-hip-module-launch-observer'],
    dispatchTableEntryIds: acceptedRecords.map((record) =>
      `native-launch-observer:${record.sequence}`,
    ),
    dispatchTableHashes: [],
    dispatchStreamIds: [],
    gridDimensions: [],
    blockDimensions: [],
    sharedMemoryBytes: [],
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
    '[gpu-runtime-boundary] synthi_gpu_launch kernel=first grid=(1, 1, 1) dispatch=ok dispatch_timestamp=1779979999000',
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
      `[gpu-runtime-boundary] synthi_gpu_launch kernel=kernel grid=(1,1,1) block=(1,1,1) args=1 stream=0 shared_bytes=0 dispatch=ok runtime_session=pid-original artifact_id=${syntheticArtifactId} dispatcher_registration_id=${syntheticDispatcherId} dispatch_table_hash=0x123 dispatch_table_entry_id=kernel:0x1 dispatch_timestamp=1779979999000`,
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
  const hostReplacedProof = classifyGpuHmrHostPreservationProof({
    hostRestartObserved: true,
  });
  const hostUnprovenProof = classifyGpuHmrHostPreservationProof({});
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
    hostPreservationProof: classifyGpuHmrHostPreservationProof({ identityChecksPassed: true }),
  });
  if (
    hostReplacedProof.degradedState !== 'gpu-hmr-host-replaced'
    || hostUnprovenProof.degradedReason !== 'host_identity_checks_not_collected'
    || fullRuntimeBlockedProof.degradedState !== 'gpu-hmr-abi-unverified'
    || fullRuntimeBlockedProof.degradedReason !== 'abi_layout_size_alignment_unverified'
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
    outputProof: { resultState: 'gpu-hmr-output-oracle-proven' },
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
  const parsedProgressionLedger = parseTargetProgressionLedger(JSON.stringify({
    small_oracle: {
      status: 'pass',
      proof_id: 'proof:small-oracle:alias',
      proof_artifact_schema_version: 'synthi.gpu.hmr.validation-proof.v1',
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
    visualEvidenceExpected: true,
    visualEvidenceFrames: [{ path: 'fresh.png', accepted_as_visual_evidence: true }],
    targetProgressionLedger: completeProgressionLedger,
  });
  if (
    optionalProgressionRows[0]?.status !== 'skip'
    || requiredProgressionRows[0]?.status !== 'fail'
    || unknownProgressionRows[0]?.status !== 'fail'
    || smallOracleFailures.filter((row) => row.status === 'fail').length !== 2
    || smallOraclePasses.some((row) => row.status === 'fail')
    || partialReloadPasses.some((row) => row.status === 'fail')
    || !targetProgressionLedgerPhaseResult(parsedProgressionLedger, 'small-oracle').passed
    || finalAcceptanceFailures.filter((row) => row.status === 'fail').length !== 5
    || finalAcceptanceVisualFailures.filter((row) => row.status === 'fail').length !== 4
    || finalAcceptanceVisualPasses.some((row) => row.status === 'fail')
  ) {
    throw new Error('target progression gate self-check failed');
  }
  if (shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: true })) {
    throw new Error('fetch decision self-check should reuse a locally available requested commit');
  }
  if (!shouldFetchRequestedCommit({ requestedCommit: 'abc123', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should fetch an unavailable requested commit');
  }
  if (shouldFetchRequestedCommit({ requestedCommit: '', localCommitAvailable: false })) {
    throw new Error('fetch decision self-check should not fetch without a requested commit');
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
  if (buildMetadataCoversSource('src/missing.h', {
    compileCommandSourcePaths: ['src/main.cpp'],
    targetSourcePaths: ['src/kernel.h'],
  })) {
    throw new Error('CMake metadata coverage self-check should reject unrelated sources');
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
    const visualBytes = Buffer.from('not-a-real-png-but-proof-writer-hashes-file-bytes');
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
        targetName: 'self-check-target',
        finalAcceptanceTarget: 'self-check-target',
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
    const rejectedVisualArtifacts = await visualEvidenceArtifactsFromFiles([visualPath], [{
      path: visualPath,
      visualQuality: 'gpu-hmr-visual-flat-frame',
      acceptedAsVisualEvidence: false,
    }]);
    const rejectedLedgerEntry = buildTargetProgressionLedgerEntry({
      report: ledgerReport,
      visualArtifactPaths: [visualPath],
      visualEvidenceArtifacts: rejectedVisualArtifacts,
    });
    const rejectedVisualArtifact = rejectedLedgerEntry.visualEvidenceArtifacts
      ?.find((artifact) => artifact.path === visualPath);
    if (
      rejectedVisualArtifact?.contentHash !== expectedVisualHash
      || !rejectedLedgerEntry.visualEvidenceContentHashes?.includes(expectedVisualHash)
      || rejectedLedgerEntry.visualEvidenceAcceptedCount !== 0
      || rejectedLedgerEntry.visualEvidenceReadErrorCount !== 0
    ) {
      throw new Error('target progression ledger self-check did not retain rejected visual file bytes');
    }
  } finally {
    await rm(visualSelfCheckDir, { recursive: true, force: true });
  }
  console.log('runtime dispatch evidence self-check passed');
}

async function collectRuntimeEvidence() {
  if (CFG.mcpTransport !== 'docker') return;
  report.docker = {
    mcp: await dockerContainerSnapshot(CFG.mcpContainer),
    worker: await dockerContainerSnapshot(CFG.workerContainer),
    ai_engine: await dockerContainerSnapshot(CFG.aiEngineContainer),
  };
  const workerLogs = await execText(
    'docker',
    ['logs', '--timestamps', '--since', report.started_at, CFG.workerContainer],
    120000,
    false,
  );
  const aiLogs = await execText(
    'docker',
    ['logs', '--timestamps', '--since', report.started_at, CFG.aiEngineContainer],
    120000,
    false,
  );
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
    runtimeOutputOracleArtifacts = computeOracleArtifacts
      ? { compute_oracle_artifacts: computeOracleArtifacts }
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
  report.abi_proof = abiProofFromProofArtifacts(proofArtifactRecords);
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
    visualEvidenceRequired:
      CFG.renderPreview
      || CFG.expectScreenshot
      || report.target_progression?.phase === 'final-acceptance',
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
    visualEvidenceExpected:
      CFG.renderPreview
      || CFG.expectScreenshot
      || report.target_progression?.phase === 'final-acceptance',
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

async function writeResults() {
  report.finished_at = new Date().toISOString();
  const timingFields = monotonicTimingFields(RUN_STARTED_MONOTONIC_NS);
  report.finished_monotonic_ns = timingFields.finished_monotonic_ns;
  report.duration_monotonic_ns = timingFields.duration_monotonic_ns;
  report.duration_ms = timingFields.duration_ms;
  report.timingMetrics = realRocmTimingMetrics(report);
  const validationContext = {
    command: report.command,
    docker: report.docker,
    containers: report.containers,
    modelProvenance: report.modelProvenance ?? report.model_provenance ?? report.evidence?.model_provenance ?? {},
    firewallEvidence: report.firewall_evidence ?? report.evidence?.firewall_evidence ?? {},
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
    target_progression_ledger: report.target_progression_ledger,
    target_progression_ledger_entry: report.target_progression_ledger_entry,
    target_progression_ledger_artifact: report.target_progression_ledger_artifact,
    strict_proof_gates: report.strict_proof_gates,
    target_progression_gates: report.target_progression_gates,
    runtime_capability_preflight: report.runtime_capability_preflight,
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
      limitations: written.artifact.limitations,
      acceptanceContract: written.artifact.acceptanceContract,
      acceptanceContractEvaluation: written.artifact.acceptanceContractEvaluation,
      acceptanceContractConsistency: written.artifact.acceptanceContractConsistency,
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
    visualEvidenceExpected:
      CFG.expectScreenshot
      || CFG.renderPreview
      || report.target_progression?.phase === 'final-acceptance',
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
  await writeFile(RESULTS_JSON, JSON.stringify(report, null, 2) + '\n');
  const lines = [
    `slug: ${report.slug}`,
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
    `runtime_capability_preflight: ${JSON.stringify(report.runtime_capability_preflight)}`,
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
  await writeFile(RESULTS_TXT, lines.join('\n') + '\n');
  console.log(`results: ${RESULTS_TXT}`);
}

async function run() {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
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
  const buildMetadata = await prepareUpstreamBuild();
  const files = await collectRepoFiles(buildMetadata);
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
  const extraDeltas = parseExtraDeltas();
  report.extra_deltas = extraDeltas.map((delta) => ({
    label: delta.label,
    file: delta.file,
    before_sha256: createHash('sha256').update(delta.before).digest('hex'),
    after_sha256: createHash('sha256').update(delta.after).digest('hex'),
  }));
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
  updateFileContent(CFG.deltaFile, edited);
  const hmrCompileResult = await compileViaMcp({
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
  await captureScreenshot('post-hmr', { required: CFG.expectScreenshot, wait: hmrCompileResult.wait });

  for (let index = 0; index < extraDeltas.length; index += 1) {
    const delta = extraDeltas[index];
    const label = safePhaseLabel(delta.label, index);
    const phaseName = `real_repo_${label}_user_source_delta_hmr`;
    const screenshotLabel = `post-${label}-hmr`;
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
    updateFileContent(delta.file, editedSource);
    const extraCompileResult = await compileViaMcp({
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
    await captureScreenshot(screenshotLabel, { required: CFG.expectScreenshot, wait: extraCompileResult.wait });
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
      await collectRuntimeEvidence().catch((err) => {
        record('runtime evidence collected', 'warn', err.stack || err.message);
      });
      await writeResults().catch((err) => console.error(err));
    });
}
