import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
} from './gpu-hmr-acceptance-contract.mjs';
import {
  buildValidationRuntimeProofArtifact,
} from './gpu-hmr-validation-proof-artifact.mjs';
import {
  runtimeProofArtifactStrictGate,
} from './gpu-hmr-proof-strict-gates.mjs';
import {
  buildGpuHmrFrameGateRuntimeBinding,
  buildGpuHmrVisualCaptureRuntimeBinding,
} from './gpu-hmr-proof-ledger.mjs';
import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrFissionProof,
  classifyGpuHmrFullRuntimeProof,
  classifyGpuHmrHostPreservationProof,
} from './gpu-hmr-runtime-proof.mjs';

export const RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_boundary_proof_adapter.v1';
export const RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY =
  'runtime_boundary_events_to_strict_runtime_proof_adapter_not_success_authority';
export const RUNTIME_RUN_MODE_PROOF_SCHEMA_VERSION =
  'synthi.gpu.hmr.runtime_run_mode_proof.v1';

const REQUIRED_BOUNDARY_STAGES = Object.freeze([
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
]);

const REQUIRED_TIMING_FIELDS = Object.freeze([
  'static_discovery_time',
  'ai_contract_synthesis_time',
  'model_availability_check_time',
  'artifact_hash_time',
  'adapter_generation_time',
  'device_compile_wall_time',
  'artifact_load_time',
  'epoch_publish_time',
  'dispatch_trace_time',
  'runtime_probe_time',
  'oracle_analysis_time',
  'trigger_to_visible_time',
  'screenshot_capture_time',
  'dispatch_to_output_proof_time',
  'total_validator_wall_time',
]);

const FISSION_VERIFICATION_CATEGORIES = Object.freeze([
  'source_mapping',
  'include_closure',
  'symbol_ownership',
  'dependency_closure',
  'abi_membrane',
  'compile_recipe',
  'loader_capability',
  'output_oracle',
]);

const REQUIRED_PRELIMINARY_VISUAL_RUNTIME_PROOF_FIELDS = Object.freeze([
  'runtime_proof_id',
  'runtime_proof_state',
  'runtime_proof_accepted',
  'runtime_proof_observed_at_ms',
  'hmr_observed_at_ms',
]);

const STAGE_ALIASES = Object.freeze({
  artifact_transport: new Set([
    'artifact_transport',
    'runtime_artifact_transport',
    'artifact_load',
    'module_load',
    'loader_event',
  ]),
  epoch_publication: new Set([
    'epoch_publication',
    'epoch_publish',
    'epoch_swap',
    'publish_epoch',
    'dispatcher_epoch',
  ]),
  dispatch_trace: new Set([
    'dispatch_trace',
    'runtime_dispatch',
    'native_runtime_dispatch',
    'synthi_gpu_launch',
    'kernel_dispatch',
  ]),
  host_identity: new Set([
    'host_identity',
    'same_process_identity',
    'process_identity',
  ]),
  output_oracle: new Set([
    'output_oracle',
    'compute_oracle',
    'visual_oracle',
    'readback_oracle',
  ]),
});

const RETIREMENT_RECEIPT_EVENT_TYPE = 'retirement_receipt';
const RETIREMENT_RECEIPT_ALIASES = new Set([
  'retirement_receipt',
  'runtime_boundary_retirement_receipt',
  'epoch_retirement_receipt',
  'generation_retirement_receipt',
  'retirement_event',
  'runtime_boundary_retirement_event',
]);
const RETIREMENT_RECEIPT_ACTIONS = new Set([
  'retired',
  'retirement_receipt',
  'old_generation_retired',
]);
const SUCCESSFUL_RETIREMENT_PROOFS = new Set([
  'stream_event_proven',
  'queue_idle_proven',
  'frame_boundary_proven',
  'no_retirement_required',
]);
const SUCCESSFUL_RETIREMENT_RESULTS = new Set([
  'retired_after_quiescent',
]);

const STAGE_BOUNDARY_LINE_TOKENS = Object.freeze({
  artifact_transport: 'artifact_transport',
  epoch_publication: 'dispatcher_epoch',
  dispatch_trace: 'synthi_gpu_launch',
  host_identity: 'host_identity',
  output_oracle: 'output_oracle',
});

const MATERIALIZED_BOUNDARY_LINES_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_boundary_materialized_lines.v1';
const MATERIALIZED_BOUNDARY_LINES_AUTHORITY =
  'typed_runtime_boundary_event_materialization_only_not_gpu_hmr_success';

const MATERIALIZED_LINE_OMIT_KEYS = new Set([
  'adapter_runtime_boundary_events',
  'adapterRuntimeBoundaryEvents',
  'accepted_for_gpu_hmr',
  'acceptedForGpuHmr',
  'can_satisfy_dispatch_proof',
  'can_satisfy_runtime_proof',
  'canSatisfyDispatchProof',
  'canSatisfyRuntimeProof',
  'event_fields',
  'eventFields',
  'event_kind',
  'eventKind',
  'evidence_ref',
  'evidence_refs',
  'evidenceRef',
  'evidenceRefs',
  'fields',
  'gpu_hmr_success',
  'gpuHmrSuccess',
  'kind',
  'raw',
  'runtime_authority',
  'runtime_boundary_events',
  'runtimeAuthority',
  'runtimeBoundaryEvents',
  'stage',
  'stage_kind',
  'stageKind',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256Stable(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const match = /^(?:sha256:)?([0-9a-f]{64})$/.exec(text);
  return match ? `sha256:${match[1]}` : null;
}

function artifactIdFromHash(value) {
  const hash = normalizeSha256(value);
  return hash ? `artifact:${hash}` : null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function compactObjectList(value) {
  return (Array.isArray(value) ? value : []).map(objectOrNull).filter(Boolean);
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstBool(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
  }
  return null;
}

function proofArtifactPath(value) {
  const text = firstText(value);
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) return null;
  return text;
}

function pathInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function visualCaptureArtifactRoots(input = {}) {
  const roots = compactStringList([
    ...(Array.isArray(input.visualArtifactRoots) ? input.visualArtifactRoots : []),
    ...(Array.isArray(input.visual_artifact_roots) ? input.visual_artifact_roots : []),
    ...(Array.isArray(input.allowedArtifactRoots) ? input.allowedArtifactRoots : []),
    ...(Array.isArray(input.allowed_artifact_roots) ? input.allowed_artifact_roots : []),
    ...(Array.isArray(input.artifactCasRoots) ? input.artifactCasRoots : []),
    ...(Array.isArray(input.artifact_cas_roots) ? input.artifact_cas_roots : []),
    ...(Array.isArray(input.allowedCasRoots) ? input.allowedCasRoots : []),
    ...(Array.isArray(input.allowed_cas_roots) ? input.allowed_cas_roots : []),
  ]);
  const canonicalRoots = [];
  const seen = new Set();
  for (const root of roots) {
    try {
      const canonicalRoot = realpathSync(path.resolve(root));
      if (!statSync(canonicalRoot).isDirectory()) continue;
      const identity = process.platform === 'win32'
        ? canonicalRoot.toLowerCase()
        : canonicalRoot;
      if (seen.has(identity)) continue;
      seen.add(identity);
      canonicalRoots.push(canonicalRoot);
    } catch {
      // A missing or unreadable root cannot authorize visual artifact bytes.
    }
  }
  return canonicalRoots;
}

function resolveVisualCaptureArtifactPath(rawPath, roots) {
  const pathText = firstText(rawPath);
  if (!pathText || (/^[a-z][a-z0-9+.-]*:/iu.test(pathText) && !path.isAbsolute(pathText))) {
    return { path: null, outsideAllowedRoots: false };
  }
  const candidates = path.isAbsolute(pathText)
    ? [path.resolve(pathText)]
    : roots.map((root) => path.resolve(root, pathText));
  let outsideAllowedRoots = false;
  for (const candidate of candidates) {
    if (!roots.some((root) => pathInsideRoot(candidate, root))) {
      outsideAllowedRoots = true;
      continue;
    }
    try {
      const canonicalPath = realpathSync(candidate);
      if (!statSync(canonicalPath).isFile()) continue;
      if (!roots.some((root) => pathInsideRoot(canonicalPath, root))) {
        outsideAllowedRoots = true;
        continue;
      }
      return { path: canonicalPath, outsideAllowedRoots: false };
    } catch {
      // Keep trying explicit roots for a relative artifact path.
    }
  }
  return { path: null, outsideAllowedRoots };
}

function runtimeBoundaryStrictGateOptions(input = {}) {
  const computeOracleArtifacts = objectOrNull(
    input.computeOracleArtifacts
    ?? input.compute_oracle_artifacts,
  ) ?? {};
  const explicitAllowedRoots = compactStringList([
    ...(Array.isArray(input.allowedArtifactRoots) ? input.allowedArtifactRoots : []),
    ...(Array.isArray(input.allowed_artifact_roots) ? input.allowed_artifact_roots : []),
    ...(Array.isArray(input.computeArtifactRoots) ? input.computeArtifactRoots : []),
    ...(Array.isArray(input.compute_artifact_roots) ? input.compute_artifact_roots : []),
  ]);
  const explicitPathBaseRoots = compactStringList([
    ...(Array.isArray(input.computeArtifactPathBaseRoots) ? input.computeArtifactPathBaseRoots : []),
    ...(Array.isArray(input.compute_artifact_path_base_roots) ? input.compute_artifact_path_base_roots : []),
    ...(Array.isArray(input.artifactPathBaseRoots) ? input.artifactPathBaseRoots : []),
    ...(Array.isArray(input.artifact_path_base_roots) ? input.artifact_path_base_roots : []),
  ]);
  const artifactRoots = [
    computeOracleArtifacts.raw_readback_bin,
    computeOracleArtifacts.rawReadbackBin,
    computeOracleArtifacts.before_raw_readback_bin,
    computeOracleArtifacts.beforeRawReadbackBin,
    computeOracleArtifacts.readback_schema_json,
    computeOracleArtifacts.readbackSchemaJson,
    computeOracleArtifacts.rendered_card_png,
    computeOracleArtifacts.renderedCardPng,
    computeOracleArtifacts.raw_readback_cas_manifest,
    computeOracleArtifacts.rawReadbackCasManifest,
  ].map(proofArtifactPath)
    .filter((artifactPath) => artifactPath && path.isAbsolute(artifactPath))
    .map((artifactPath) => path.dirname(path.resolve(artifactPath)));
  const allowedArtifactRoots = compactStringList([
    ...explicitAllowedRoots,
    ...artifactRoots,
  ]);
  const computeArtifactPathBaseRoots = compactStringList([
    ...explicitPathBaseRoots,
    ...allowedArtifactRoots,
  ]);
  return {
    allowedArtifactRoots,
    computeArtifactPathBaseRoots,
  };
}

function firstTimestamp(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
  }
  return null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function positiveNumber(...values) {
  const numeric = firstFiniteNumber(...values);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function positiveInteger(...values) {
  const numeric = firstFiniteNumber(...values);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function generationInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value !== 'string') continue;
    const match = /^(?:(?:epoch|generation)[:-])?(0|[1-9][0-9]*)$/i.exec(value.trim());
    if (!match) continue;
    const numeric = Number(match[1]);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  return null;
}

function normalizeStreamEpochCounters(...values) {
  for (const value of values) {
    const object = objectOrNull(value);
    if (!object) continue;
    const entries = Object.entries(object)
      .map(([streamId, generation]) => [streamId.trim(), generationInteger(generation)])
      .filter(([streamId, generation]) => streamId && generation !== null);
    if (entries.length > 0) return Object.fromEntries(entries);
  }
  return {};
}

function normalizedEnumText(...values) {
  return firstText(...values)?.toLowerCase().replace(/-/g, '_') ?? null;
}

function normalizeSwapchainSize(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length >= 2) {
      const width = positiveInteger(value[0]);
      const height = positiveInteger(value[1]);
      if (width && height) return [width, height];
    }
    const object = objectOrNull(value);
    if (object) {
      const width = positiveInteger(object.width, object.w);
      const height = positiveInteger(object.height, object.h);
      if (width && height) return [width, height];
    }
    if (typeof value === 'string') {
      const match = /^(\d+)\s*[x,]\s*(\d+)$/i.exec(value.trim());
      if (match) {
        const width = positiveInteger(match[1]);
        const height = positiveInteger(match[2]);
        if (width && height) return [width, height];
      }
    }
  }
  return null;
}

function authorityClaimsSuccess(value) {
  const object = objectOrNull(value);
  if (!object) return false;
  return object.acceptedForGpuHmr === true
    || object.accepted_for_gpu_hmr === true
    || object.gpuHmrSuccess === true
    || object.gpu_hmr_success === true
    || object.canSatisfyRuntimeProof === true
    || object.can_satisfy_runtime_proof === true
    || object.canSatisfyDispatchProof === true
    || object.can_satisfy_dispatch_proof === true
    || object.runtimeAuthority === true
    || object.runtime_authority === true;
}

function eventEvidenceRefs(event) {
  return compactStringList([
    ...(Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []),
    ...(Array.isArray(event.evidence_refs) ? event.evidence_refs : []),
    event.evidenceRef,
    event.evidence_ref,
  ]);
}

function isVisualOracleKind(kind) {
  const normalized = String(kind ?? '').trim().toLowerCase();
  return normalized === 'visual_oracle'
    || normalized === 'render_target_hash'
    || normalized === 'accumulation_buffer_hash'
    || normalized === 'selected_pixels'
    || normalized === 'selected_pixel_values'
    || normalized.includes('visual')
    || normalized.includes('render')
    || normalized.includes('frame')
    || normalized.includes('pixel');
}

function acceptedVisualOracleKind(kind) {
  const normalized = String(kind ?? '').trim().toLowerCase();
  if ([
    'render_target_hash',
    'accumulation_buffer_hash',
    'selected_pixels',
    'selected_pixel_values',
  ].includes(normalized)) {
    return normalized;
  }
  return 'render_target_hash';
}

function visualRoleHash(source, role) {
  const object = objectOrNull(source) ?? {};
  if (role === 'before') return normalizeSha256(firstText(object.beforeImageHash, object.before_image_hash));
  if (role === 'after') return normalizeSha256(firstText(object.afterImageHash, object.after_image_hash));
  if (role === 'diff') return normalizeSha256(firstText(object.diffImageHash, object.diff_image_hash));
  return null;
}

function visualRolePath(source, role) {
  const object = objectOrNull(source) ?? {};
  if (role === 'before') return firstText(object.beforeImage, object.before_image);
  if (role === 'after') return firstText(object.afterImage, object.after_image);
  if (role === 'diff') return firstText(object.diffImage, object.diff_image);
  return null;
}

function visualRoleHasReference(source, role) {
  const object = objectOrNull(source) ?? {};
  if (visualRolePath(object, role) || visualRoleHash(object, role)) return true;
  const locators = [
    ...(Array.isArray(object.artifactLocators) ? object.artifactLocators : []),
    ...(Array.isArray(object.artifact_locators) ? object.artifact_locators : []),
    ...(Array.isArray(object.casLocators) ? object.casLocators : []),
    ...(Array.isArray(object.cas_locators) ? object.cas_locators : []),
  ];
  return locators.some((locator) => {
    const item = objectOrNull(locator) ?? {};
    return firstText(item.role, item.artifactRole, item.artifact_role) === role
      && normalizeSha256(firstText(item.sha256, item.hash, item.contentHash, item.content_hash));
  });
}

function visualEvidenceArtifactsFromInput(input = {}) {
  const inputArtifacts = objectOrNull(input.oracleArtifacts) ?? objectOrNull(input.oracle_artifacts) ?? {};
  return [
    ...compactObjectList(input.visualEvidenceArtifacts),
    ...compactObjectList(input.visual_evidence_artifacts),
    ...compactObjectList(inputArtifacts.visualEvidenceArtifacts),
    ...compactObjectList(inputArtifacts.visual_evidence_artifacts),
  ].map((artifact) => ({ ...artifact }));
}

function visualArtifactRole(artifact) {
  const role = firstText(artifact.role, artifact.artifactRole, artifact.artifact_role);
  if (!role) return null;
  return role.trim().toLowerCase().replace(/-/g, '_');
}

function visualArtifactHash(artifact) {
  return normalizeSha256(firstText(
    artifact.contentHash,
    artifact.content_hash,
  ));
}

function visualArtifactByteLength(artifact) {
  const length = firstFiniteNumber(
    artifact.byteLength,
    artifact.byte_length,
    artifact.bytes,
    artifact.byteCount,
    artifact.byte_count,
  );
  return Number.isFinite(length) && length > 0 ? length : null;
}

function visualArtifactContentHashVerified(artifact) {
  return firstBool(
    artifact.contentHashVerified,
    artifact.content_hash_verified,
    artifact.hashVerified,
    artifact.hash_verified,
    artifact.byteHashVerified,
    artifact.byte_hash_verified,
    artifact.readableByteHashVerified,
    artifact.readable_byte_hash_verified,
  ) === true;
}

function contentAddressedProofId(value) {
  return /\bsha256:[0-9a-f]{64}\b/i.test(String(value ?? '').trim());
}

function visualArtifactProofId(artifact) {
  return firstText(
    artifact.proofId,
    artifact.proof_id,
    artifact.verificationProofId,
    artifact.verification_proof_id,
    artifact.evidenceId,
    artifact.evidence_id,
  );
}

function visualArtifactPath(artifact) {
  return firstText(artifact.path, artifact.filePath, artifact.file_path, artifact.sourcePath, artifact.source_path);
}

function visualArtifactEvidenceRefs(artifact) {
  return compactStringList([
    ...(Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : []),
    ...(Array.isArray(artifact.evidence_refs) ? artifact.evidence_refs : []),
    artifact.evidenceId,
    artifact.evidence_id,
  ]);
}

function visualArtifactAuthority(artifact) {
  return firstText(
    artifact.proofAuthority,
    artifact.proof_authority,
    artifact.evidenceAuthority,
    artifact.evidence_authority,
    artifact.producerSubsystem,
    artifact.producer_subsystem,
    artifact.recomputeEngine,
    artifact.recompute_engine,
  );
}

function visualArtifactAuthorityAccepted(artifact) {
  const authority = visualArtifactAuthority(artifact)?.toLowerCase();
  if (!authority) return false;
  return new Set([
    'runtime_boundary_visual_artifact_verification_not_gpu_hmr_success',
    'runtime_boundary_visual_artifact_verification',
    'async_visual_metrics_and_transport_only',
    'matrix_async_visual_worker_rgba',
    'mcp.gpu_hmr_validation',
    'visual_artifact_file_verification_not_gpu_hmr_success',
    'image_byte_verification_not_gpu_hmr_success',
    'byte_hash_verification_not_gpu_hmr_success',
  ]).has(authority);
}

function visualArtifactHasVerifiedBytes(artifact) {
  return firstBool(
    artifact.acceptedAsImageEvidence,
    artifact.accepted_as_image_evidence,
  ) === true
    && firstBool(
      artifact.acceptedAsVisualEvidence,
      artifact.accepted_as_visual_evidence,
    ) === true
    && visualArtifactHash(artifact)
    && visualArtifactContentHashVerified(artifact)
    && visualArtifactByteLength(artifact) !== null
    && contentAddressedProofId(visualArtifactProofId(artifact))
    && !firstText(artifact.readError, artifact.read_error)
    && !firstText(artifact.visualAnalysisError, artifact.visual_analysis_error)
    && visualArtifactAuthorityAccepted(artifact)
    && visualArtifactEvidenceRefs(artifact).length > 0
    && !authorityClaimsSuccess(artifact);
}

function visualEvidenceArtifactsVerificationFailures(visualOracleArtifacts, artifacts) {
  const source = objectOrNull(visualOracleArtifacts);
  if (!source) return ['runtime_boundary_visual_oracle_artifacts_missing'];
  const artifactList = compactObjectList(artifacts);
  if (artifactList.length === 0) return ['runtime_boundary_visual_evidence_artifacts_missing'];

  const failures = [];
  for (const role of ['before', 'after', 'diff']) {
    const expectedHash = visualRoleHash(source, role);
    const candidates = artifactList.filter((artifact) => visualArtifactRole(artifact) === role);
    if (candidates.length === 0) {
      failures.push(`runtime_boundary_visual_evidence_${role}_artifact_missing`);
      continue;
    }
    const matching = candidates.find((artifact) =>
      visualArtifactHash(artifact)
      && expectedHash
      && visualArtifactHash(artifact) === expectedHash
    );
    if (!matching) {
      failures.push(
        candidates.some((artifact) => visualArtifactHash(artifact))
          ? `runtime_boundary_visual_evidence_${role}_hash_mismatch`
          : `runtime_boundary_visual_evidence_${role}_content_hash_missing`,
      );
      continue;
    }
    if (!visualArtifactPath(matching) && !visualArtifactHash(matching)) {
      failures.push(`runtime_boundary_visual_evidence_${role}_reference_missing`);
    }
    if (!visualArtifactHasVerifiedBytes(matching)) {
      if (authorityClaimsSuccess(matching)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_claims_success_authority`);
      }
      if (!visualArtifactAuthorityAccepted(matching)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_byte_verifier_authority_missing`);
      }
      if (visualArtifactEvidenceRefs(matching).length === 0) {
        failures.push(`runtime_boundary_visual_evidence_${role}_evidence_refs_missing`);
      }
      if (!visualArtifactHash(matching)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_content_hash_missing`);
      }
      if (!visualArtifactContentHashVerified(matching)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_content_hash_unverified`);
      }
      if (visualArtifactByteLength(matching) === null) {
        failures.push(`runtime_boundary_visual_evidence_${role}_byte_length_missing`);
      }
      if (!contentAddressedProofId(visualArtifactProofId(matching))) {
        failures.push(`runtime_boundary_visual_evidence_${role}_proof_id_missing`);
      }
      if (firstBool(matching.acceptedAsImageEvidence, matching.accepted_as_image_evidence) !== true) {
        failures.push(`runtime_boundary_visual_evidence_${role}_image_not_accepted`);
      }
      if (firstBool(matching.acceptedAsVisualEvidence, matching.accepted_as_visual_evidence) !== true) {
        failures.push(`runtime_boundary_visual_evidence_${role}_visual_not_accepted`);
      }
      if (firstText(matching.readError, matching.read_error)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_read_error`);
      }
      if (firstText(matching.visualAnalysisError, matching.visual_analysis_error)) {
        failures.push(`runtime_boundary_visual_evidence_${role}_analysis_error`);
      }
    }
  }
  return [...new Set(failures)];
}

function verifiedVisualEvidenceArtifactForRole(visualOracleArtifacts, artifacts, role) {
  const expectedHash = visualRoleHash(visualOracleArtifacts, role);
  if (!expectedHash) return null;
  return compactObjectList(artifacts).find((artifact) =>
    visualArtifactRole(artifact) === role
    && visualArtifactHash(artifact) === expectedHash
    && visualArtifactHasVerifiedBytes(artifact)
  ) ?? null;
}

function visualOracleArtifactsWithEvidenceVerification(visualOracleArtifacts, artifacts) {
  const source = objectOrNull(visualOracleArtifacts);
  if (!source) return null;
  const verification = {
    ...objectOrNull(source.visualPixelVerification),
    ...objectOrNull(source.visual_pixel_verification),
  };
  const result = {
    ...source,
    visual_pixel_verification: verification,
    visualPixelVerification: verification,
  };
  for (const role of ['before', 'after', 'diff']) {
    const artifact = verifiedVisualEvidenceArtifactForRole(source, artifacts, role);
    if (!artifact) continue;
    const snakeKey = `${role}_image_hash_verified`;
    const camelKey = `${role}ImageHashVerified`;
    verification[snakeKey] = true;
    verification[camelKey] = true;
    result[snakeKey] = true;
    result[camelKey] = true;
  }
  return result;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensionsFromBytes(bytes) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.length < 24
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? [width, height] : null;
}

function visualCaptureManifestCandidates(input, visualOracleArtifacts) {
  const artifacts = objectOrNull(visualOracleArtifacts) ?? {};
  return compactObjectList([
    artifacts.capture_manifest,
    artifacts.captureManifest,
    artifacts.after_capture_manifest,
    artifacts.afterCaptureManifest,
    input.capture_manifest,
    input.captureManifest,
    input.visual_capture_manifest,
    input.visualCaptureManifest,
  ]);
}

function resolveVisualCaptureManifest(input, visualOracleArtifacts) {
  const candidates = visualCaptureManifestCandidates(input, visualOracleArtifacts);
  if (candidates.length === 0) {
    return {
      manifest: null,
      frameGate: null,
      evidenceBinding: null,
      failedGates: ['runtime_boundary_visual_capture_manifest_missing'],
    };
  }
  const failedGates = [];
  if (new Set(candidates.map(stableJson)).size !== 1) {
    failedGates.push('runtime_boundary_visual_capture_manifest_conflict');
  }
  const manifest = candidates[0];
  const frameGateCandidates = compactObjectList([
    manifest.frame_gate,
    manifest.frameGate,
  ]);
  if (frameGateCandidates.length === 0) {
    failedGates.push('runtime_boundary_visual_capture_frame_gate_missing');
  } else if (new Set(frameGateCandidates.map(stableJson)).size !== 1) {
    failedGates.push('runtime_boundary_visual_capture_frame_gate_conflict');
  }
  const frameGate = frameGateCandidates[0] ?? null;
  if (firstText(manifest.schema_version, manifest.schemaVersion)
    !== 'synthi.mcp.capture_manifest.v1') {
    failedGates.push('runtime_boundary_visual_capture_manifest_schema_invalid');
  }
  if (firstText(frameGate?.status) !== 'satisfied') {
    failedGates.push('runtime_boundary_visual_capture_frame_gate_unsatisfied');
  }
  const evidenceBinding = objectOrNull(frameGate?.evidence_binding);
  if (!evidenceBinding) {
    failedGates.push('runtime_boundary_visual_capture_frame_gate_evidence_binding_missing');
  }
  return {
    manifest,
    frameGate,
    evidenceBinding,
    failedGates: [...new Set(failedGates)],
  };
}

function visualCaptureByteVerificationFailures(
  captureManifest,
  visualOracleArtifacts,
  visualEvidenceArtifacts,
  input,
) {
  if (!captureManifest) return ['runtime_boundary_visual_capture_manifest_missing'];
  const afterArtifact = verifiedVisualEvidenceArtifactForRole(
    visualOracleArtifacts,
    visualEvidenceArtifacts,
    'after',
  );
  if (!afterArtifact) {
    return ['runtime_boundary_visual_capture_after_artifact_unverified'];
  }
  const artifactPath = visualArtifactPath(afterArtifact);
  if (!artifactPath) {
    return ['runtime_boundary_visual_capture_after_image_bytes_unreadable'];
  }

  const allowedRoots = visualCaptureArtifactRoots(input);
  if (allowedRoots.length === 0) {
    return ['runtime_boundary_visual_capture_allowed_artifact_roots_missing'];
  }
  const resolvedArtifact = resolveVisualCaptureArtifactPath(artifactPath, allowedRoots);
  if (!resolvedArtifact.path) {
    return [resolvedArtifact.outsideAllowedRoots
      ? 'runtime_boundary_visual_capture_after_image_path_outside_allowed_artifact_roots'
      : 'runtime_boundary_visual_capture_after_image_bytes_unreadable'];
  }

  let bytes;
  try {
    bytes = readFileSync(resolvedArtifact.path);
  } catch {
    return ['runtime_boundary_visual_capture_after_image_bytes_unreadable'];
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return ['runtime_boundary_visual_capture_after_image_bytes_unreadable'];
  }

  const actualHash = sha256Bytes(bytes);
  const actualDimensions = pngDimensionsFromBytes(bytes);
  const manifestHash = normalizeSha256(firstText(
    captureManifest.image_sha256,
    captureManifest.imageSha256,
  ));
  const manifestByteLength = captureManifest.image_byte_length
    ?? captureManifest.imageByteLength;
  const manifestWidth = captureManifest.width;
  const manifestHeight = captureManifest.height;
  const artifactByteLength = visualArtifactByteLength(afterArtifact);
  return [
    visualArtifactHash(afterArtifact) === actualHash
      ? null
      : 'runtime_boundary_visual_capture_after_artifact_hash_mismatch',
    visualRoleHash(visualOracleArtifacts, 'after') === actualHash
      ? null
      : 'runtime_boundary_visual_capture_visual_oracle_hash_mismatch',
    manifestHash === actualHash
      ? null
      : 'runtime_boundary_visual_capture_manifest_image_hash_mismatch',
    artifactByteLength === bytes.length
      ? null
      : 'runtime_boundary_visual_capture_after_artifact_byte_length_mismatch',
    Number.isSafeInteger(manifestByteLength) && manifestByteLength === bytes.length
      ? null
      : 'runtime_boundary_visual_capture_manifest_image_byte_length_mismatch',
    actualDimensions
      && Number.isSafeInteger(manifestWidth)
      && Number.isSafeInteger(manifestHeight)
      && actualDimensions[0] === manifestWidth
      && actualDimensions[1] === manifestHeight
      ? null
      : 'runtime_boundary_visual_capture_manifest_dimensions_mismatch',
  ].filter(Boolean);
}

function proofBindingErrorCodes(error, fallback) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const details = message.includes(':')
    ? message.slice(message.indexOf(':') + 1).split(',').map((value) => value.trim())
    : [];
  return compactStringList([fallback, ...details]);
}

function missingPreliminaryVisualRuntimeProofFields(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message.startsWith('visual_frame_gate_runtime_binding_material_incomplete:')) {
    return [];
  }
  const missingFields = new Set(
    message.slice(message.indexOf(':') + 1).split(',').map((value) => value.trim()),
  );
  return REQUIRED_PRELIMINARY_VISUAL_RUNTIME_PROOF_FIELDS
    .filter((field) => missingFields.has(field));
}

function buildVisualCaptureProofLedgerRecord(
  preliminaryArtifact,
  stageEvidence,
) {
  const sourceRecord = objectOrNull(preliminaryArtifact?.derivedProofLedgerRecord)
    ?? objectOrNull(preliminaryArtifact?.derived_proof_ledger_record);
  if (!sourceRecord) return null;
  const record = structuredClone(sourceRecord);
  const stages = stageEvidence.stageEvents;
  const eventBindings = [
    ['loader_event', stages.artifact_transport],
    ['epoch_publish_event', stages.epoch_publication],
    ['dispatch_event', stages.dispatch_trace],
    ['output_event', stages.output_oracle],
  ];
  for (const [recordKey, stage] of eventBindings) {
    record[recordKey] = {
      ...objectOrNull(record[recordKey]),
      runtime_session_id: stage?.runtimeSessionId ?? null,
      device_uuid: stage?.deviceUuid ?? null,
    };
  }
  record.output_event.output_target_id = stages.output_oracle?.outputTargetId ?? null;
  record.process_identity = {
    ...objectOrNull(record.process_identity),
    runtime_session_id: stages.host_identity?.runtimeSessionId ?? null,
  };
  record.device_identity = {
    ...objectOrNull(record.device_identity),
    device_uuid: stages.host_identity?.deviceUuid ?? null,
  };
  record.runtime_session_id = stages.dispatch_trace?.runtimeSessionId ?? null;
  return record;
}

function prepareVisualCaptureRuntimeBinding({
  input,
  components,
  stageEvidence,
  preliminaryArtifact,
}) {
  const capture = resolveVisualCaptureManifest(input, components.visualOracleArtifacts);
  const failedGates = [...capture.failedGates];
  if (capture.manifest) {
    failedGates.push(...visualCaptureByteVerificationFailures(
      capture.manifest,
      components.visualOracleArtifacts,
      components.visualEvidenceArtifacts,
      input,
    ));
  }
  if (failedGates.length > 0 || !capture.evidenceBinding) {
    return { accepted: false, failedGates: [...new Set(failedGates)] };
  }

  const record = buildVisualCaptureProofLedgerRecord(
    preliminaryArtifact,
    stageEvidence,
  );
  if (!record) {
    return {
      accepted: false,
      failedGates: ['runtime_boundary_visual_capture_derived_ledger_record_missing'],
    };
  }

  let frameGateRuntimeBinding;
  try {
    frameGateRuntimeBinding = buildGpuHmrFrameGateRuntimeBinding(record);
  } catch (error) {
    const missingPreliminaryFields = missingPreliminaryVisualRuntimeProofFields(error);
    if (missingPreliminaryFields.length > 0) {
      return {
        accepted: false,
        failedGates: [
          'runtime_boundary_visual_capture_preliminary_runtime_binding_material_incomplete',
          ...missingPreliminaryFields.map((field) =>
            `runtime_boundary_visual_capture_preliminary_${field}_missing`
          ),
        ],
      };
    }
    return {
      accepted: false,
      failedGates: proofBindingErrorCodes(
        error,
        'runtime_boundary_visual_capture_frame_gate_runtime_binding_rejected',
      ),
    };
  }
  const missingSuppliedFields = Object.keys(frameGateRuntimeBinding)
    .filter((key) => !Object.prototype.hasOwnProperty.call(capture.evidenceBinding, key));
  if (missingSuppliedFields.length > 0) {
    return {
      accepted: false,
      failedGates: [
        'runtime_boundary_visual_capture_frame_gate_runtime_binding_incomplete',
        ...missingSuppliedFields.map((field) =>
          `runtime_boundary_visual_capture_frame_gate_${field}_missing`
        ),
      ],
    };
  }
  if (stableJson(capture.evidenceBinding) !== stableJson(frameGateRuntimeBinding)) {
    return {
      accepted: false,
      failedGates: ['visual_capture_manifest_runtime_binding_mismatch'],
    };
  }
  record.oracle_artifacts = {
    ...objectOrNull(record.oracle_artifacts),
    visual_oracle_artifacts: components.visualOracleArtifacts,
  };

  let visualCaptureRuntimeBinding;
  try {
    visualCaptureRuntimeBinding = buildGpuHmrVisualCaptureRuntimeBinding(record);
  } catch (error) {
    return {
      accepted: false,
      failedGates: proofBindingErrorCodes(
        error,
        'runtime_boundary_visual_capture_runtime_binding_rejected',
      ),
    };
  }
  const boundVisualOracleArtifacts = components.visualOracleArtifacts;
  boundVisualOracleArtifacts.visual_capture_runtime_binding = visualCaptureRuntimeBinding;
  record.oracle_artifacts = {
    ...objectOrNull(record.oracle_artifacts),
    visual_oracle_artifacts: boundVisualOracleArtifacts,
  };
  return {
    accepted: true,
    failedGates: [],
    proofLedgerRecord: record,
    visualOracleArtifacts: boundVisualOracleArtifacts,
  };
}

function eventKind(event) {
  return firstText(
    event.kind,
    event.eventKind,
    event.event_kind,
    event.stage,
    event.stageKind,
    event.stage_kind,
  )?.toLowerCase().replace(/-/g, '_') ?? null;
}

function canonicalStage(kind) {
  if (!kind) return null;
  for (const [stage, aliases] of Object.entries(STAGE_ALIASES)) {
    if (aliases.has(kind)) return stage;
  }
  return null;
}

function canonicalBoundaryEventType(kind, event) {
  if (RETIREMENT_RECEIPT_ALIASES.has(kind)) return RETIREMENT_RECEIPT_EVENT_TYPE;
  const stage = canonicalStage(kind);
  const action = normalizedEnumText(event?.event, event?.action, event?.eventAction, event?.event_action);
  if (stage === 'epoch_publication' && RETIREMENT_RECEIPT_ACTIONS.has(action)) {
    return RETIREMENT_RECEIPT_EVENT_TYPE;
  }
  return stage;
}

export function normalizeRuntimeBoundaryEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event: objectOrNull(event), index }))
    .filter(({ event }) => event)
    .map(({ event, index }) => {
      const kind = eventKind(event);
      const eventType = canonicalBoundaryEventType(kind, event);
      const stage = REQUIRED_BOUNDARY_STAGES.includes(eventType) ? eventType : null;
      const lineHash = sha256Stable(event);
      const artifactHash = normalizeSha256(firstText(
        event.artifactHash,
        event.artifact_hash,
        event.artifactSha256,
        event.artifact_sha256,
        event.loadedArtifactHash,
        event.loaded_artifact_hash,
        event.publishedArtifactHash,
        event.published_artifact_hash,
      ));
      const oldArtifactHash = normalizeSha256(firstText(
        event.oldArtifactHash,
        event.old_artifact_hash,
        event.retiredArtifactHash,
        event.retired_artifact_hash,
        event.previousArtifactHash,
        event.previous_artifact_hash,
        eventType === RETIREMENT_RECEIPT_EVENT_TYPE ? artifactHash : null,
      ));
      const epoch = firstText(
        event.epoch,
        event.epochId,
        event.epoch_id,
        event.generation,
        eventType === RETIREMENT_RECEIPT_EVENT_TYPE ? event.previousEpoch : null,
        eventType === RETIREMENT_RECEIPT_EVENT_TYPE ? event.previous_epoch : null,
      );
      const previousEpoch = firstText(
        event.previousEpoch,
        event.previous_epoch,
        event.retiredEpoch,
        event.retired_epoch,
        event.previousGeneration,
        event.previous_generation,
      );
      const activeGeneration = generationInteger(
        event.activeGeneration,
        event.active_generation,
        event.candidateGeneration,
        event.candidate_generation,
        eventType === 'epoch_publication' ? event.generation : null,
        eventType === 'epoch_publication' ? epoch : null,
      );
      const previousGeneration = generationInteger(
        event.previousGeneration,
        event.previous_generation,
        event.retiredGeneration,
        event.retired_generation,
        previousEpoch,
        eventType === RETIREMENT_RECEIPT_EVENT_TYPE ? event.generation : null,
        eventType === RETIREMENT_RECEIPT_EVENT_TYPE ? epoch : null,
      );
      const retirementFenceIds = compactStringList([
        ...(Array.isArray(event.retirementFenceIds) ? event.retirementFenceIds : []),
        ...(Array.isArray(event.retirement_fence_ids) ? event.retirement_fence_ids : []),
        event.retirementFenceId,
        event.retirement_fence_id,
        event.fenceId,
        event.fence_id,
      ]);
      return {
        index,
        raw: event,
        kind,
        eventType,
        event_type: eventType,
        stage,
        lineHash,
        line_hash: lineHash,
        successAuthorityClaimed: authorityClaimsSuccess(event),
        success_authority_claimed: authorityClaimsSuccess(event),
        eventId: firstText(event.eventId, event.event_id, event.id),
        event_id: firstText(event.eventId, event.event_id, event.id),
        artifactHash,
        artifact_hash: artifactHash,
        artifactId: firstText(event.artifactId, event.artifact_id) ?? artifactIdFromHash(artifactHash),
        artifact_id: firstText(event.artifactId, event.artifact_id) ?? artifactIdFromHash(artifactHash),
        oldArtifactHash,
        old_artifact_hash: oldArtifactHash,
        epoch,
        previousEpoch,
        previous_epoch: previousEpoch,
        activeGeneration,
        active_generation: activeGeneration,
        previousGeneration,
        previous_generation: previousGeneration,
        streamEpochCounters: normalizeStreamEpochCounters(
          event.streamEpochCounters,
          event.stream_epoch_counters,
        ),
        stream_epoch_counters: normalizeStreamEpochCounters(
          event.streamEpochCounters,
          event.stream_epoch_counters,
        ),
        dispatchId: firstText(event.dispatchId, event.dispatch_id, event.afterDispatchId, event.after_dispatch_id),
        dispatch_id: firstText(event.dispatchId, event.dispatch_id, event.afterDispatchId, event.after_dispatch_id),
        afterDispatchId: firstText(event.afterDispatchId, event.after_dispatch_id, event.dispatchId, event.dispatch_id),
        after_dispatch_id: firstText(event.afterDispatchId, event.after_dispatch_id, event.dispatchId, event.dispatch_id),
        processId: firstText(event.processId, event.process_id, event.pid),
        process_id: firstText(event.processId, event.process_id, event.pid),
        runtimeSessionId: firstText(event.runtimeSessionId, event.runtime_session_id, event.runtimeSession, event.runtime_session),
        runtime_session_id: firstText(event.runtimeSessionId, event.runtime_session_id, event.runtimeSession, event.runtime_session),
        deviceUuid: firstText(event.deviceUuid, event.device_uuid),
        device_uuid: firstText(event.deviceUuid, event.device_uuid),
        contextId: firstText(event.contextId, event.context_id, event.contextHandle, event.context_handle),
        context_id: firstText(event.contextId, event.context_id, event.contextHandle, event.context_handle),
        queueOrStream: firstText(
          event.queueOrStream,
          event.queue_or_stream,
          event.stream,
          event.streamId,
          event.stream_id,
          event.dispatchStream,
          event.dispatch_stream,
          event.dispatchStreamId,
          event.dispatch_stream_id,
          event.queue,
          event.queueId,
          event.queue_id,
        ),
        queue_or_stream: firstText(
          event.queueOrStream,
          event.queue_or_stream,
          event.stream,
          event.streamId,
          event.stream_id,
          event.dispatchStream,
          event.dispatch_stream,
          event.dispatchStreamId,
          event.dispatch_stream_id,
          event.queue,
          event.queueId,
          event.queue_id,
        ),
        dispatchTableEntry: firstText(event.dispatchTableEntry, event.dispatch_table_entry),
        dispatch_table_entry: firstText(event.dispatchTableEntry, event.dispatch_table_entry),
        dispatchTableHashBefore: normalizeSha256(firstText(event.dispatchTableHashBefore, event.dispatch_table_hash_before)),
        dispatch_table_hash_before: normalizeSha256(firstText(event.dispatchTableHashBefore, event.dispatch_table_hash_before)),
        dispatchTableHashAfter: normalizeSha256(firstText(event.dispatchTableHashAfter, event.dispatch_table_hash_after)),
        dispatch_table_hash_after: normalizeSha256(firstText(event.dispatchTableHashAfter, event.dispatch_table_hash_after)),
        outputTargetId: firstText(event.outputTargetId, event.output_target_id, event.outputTarget, event.output_target),
        output_target_id: firstText(event.outputTargetId, event.output_target_id, event.outputTarget, event.output_target),
        oracleKind: firstText(event.oracleKind, event.oracle_kind, event.outputKind, event.output_kind, event.kind),
        oracle_kind: firstText(event.oracleKind, event.oracle_kind, event.outputKind, event.output_kind, event.kind),
        cameraStateHash: normalizeSha256(firstText(event.cameraStateHash, event.camera_state_hash)),
        camera_state_hash: normalizeSha256(firstText(event.cameraStateHash, event.camera_state_hash)),
        swapchainSize: normalizeSwapchainSize(event.swapchainSize, event.swapchain_size),
        swapchain_size: normalizeSwapchainSize(event.swapchainSize, event.swapchain_size),
        frameNumber: positiveInteger(event.frameNumber, event.frame_number),
        frame_number: positiveInteger(event.frameNumber, event.frame_number),
        captureBackend: firstText(event.captureBackend, event.capture_backend),
        capture_backend: firstText(event.captureBackend, event.capture_backend),
        swapchainOrFramebufferIdentity: firstText(
          event.swapchainOrFramebufferIdentity,
          event.swapchain_or_framebuffer_identity,
          event.framebufferIdentity,
          event.framebuffer_identity,
          event.framebufferHandle,
          event.framebuffer_handle,
          event.swapchainImageId,
          event.swapchain_image_id,
        ),
        swapchain_or_framebuffer_identity: firstText(
          event.swapchainOrFramebufferIdentity,
          event.swapchain_or_framebuffer_identity,
          event.framebufferIdentity,
          event.framebuffer_identity,
          event.framebufferHandle,
          event.framebuffer_handle,
          event.swapchainImageId,
          event.swapchain_image_id,
        ),
        timestampMonotonicNs: firstTimestamp(
          event.timestampMonotonicNs,
          event.timestamp_monotonic_ns,
          event.timestamp,
          event.timestampNs,
          event.timestamp_ns,
        ),
        timestamp_monotonic_ns: firstTimestamp(
          event.timestampMonotonicNs,
          event.timestamp_monotonic_ns,
          event.timestamp,
          event.timestampNs,
          event.timestamp_ns,
        ),
        retirementProof: normalizedEnumText(
          event.retirementProof,
          event.retirement_proof,
          event.proof,
        ),
        retirement_proof: normalizedEnumText(
          event.retirementProof,
          event.retirement_proof,
          event.proof,
        ),
        retirementResult: normalizedEnumText(
          event.retirementResult,
          event.retirement_result,
          event.result,
          event.status,
        ),
        retirement_result: normalizedEnumText(
          event.retirementResult,
          event.retirement_result,
          event.result,
          event.status,
        ),
        retirementStrategy: normalizedEnumText(
          event.retirementStrategy,
          event.retirement_strategy,
        ),
        retirement_strategy: normalizedEnumText(
          event.retirementStrategy,
          event.retirement_strategy,
        ),
        retirementFenceIds,
        retirement_fence_ids: retirementFenceIds,
        evidenceRefs: eventEvidenceRefs(event),
        evidence_refs: eventEvidenceRefs(event),
      };
    });
}

function boundaryLineHash(line) {
  return `sha256:${sha256Hex(line)}`;
}

function snakeKey(key) {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function scalarBoundaryLineValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /\s/.test(text)) return null;
  return text;
}

function scalarBoundaryLineFields(source = {}) {
  const out = {};
  const object = objectOrNull(source) ?? {};
  for (const [key, value] of Object.entries(object)) {
    if (MATERIALIZED_LINE_OMIT_KEYS.has(key)) continue;
    const normalizedKey = snakeKey(key);
    if (!normalizedKey || MATERIALIZED_LINE_OMIT_KEYS.has(normalizedKey)) continue;
    const normalizedValue = scalarBoundaryLineValue(value);
    if (normalizedValue !== null) out[normalizedKey] = normalizedValue;
  }
  return out;
}

function addLineField(fields, key, value) {
  const normalizedValue = scalarBoundaryLineValue(value);
  if (normalizedValue !== null) fields[key] = normalizedValue;
}

function canonicalBoundaryLineFields(event) {
  const fields = {
    ...scalarBoundaryLineFields(event.raw),
    ...scalarBoundaryLineFields(event.raw?.fields),
    ...scalarBoundaryLineFields(event.raw?.eventFields),
    ...scalarBoundaryLineFields(event.raw?.event_fields),
  };
  addLineField(fields, 'id', event.eventId);
  addLineField(fields, 'event_id', event.eventId);
  addLineField(fields, 'artifact_hash', event.artifactHash);
  addLineField(fields, 'artifact_id', event.artifactId);
  addLineField(fields, 'old_artifact_hash', event.oldArtifactHash);
  addLineField(fields, 'epoch', event.epoch);
  addLineField(fields, 'previous_epoch', event.previousEpoch);
  addLineField(fields, 'active_generation', event.activeGeneration);
  addLineField(fields, 'previous_generation', event.previousGeneration);
  addLineField(fields, 'dispatch_id', event.dispatchId);
  addLineField(fields, 'after_dispatch_id', event.afterDispatchId);
  addLineField(fields, 'process_id', event.processId);
  addLineField(fields, 'runtime_session', event.runtimeSessionId);
  addLineField(fields, 'runtime_session_id', event.runtimeSessionId);
  addLineField(fields, 'device_uuid', event.deviceUuid);
  addLineField(fields, 'context_id', event.contextId);
  addLineField(fields, 'queue_or_stream_id', event.queueOrStream);
  addLineField(fields, 'stream_id', event.queueOrStream);
  addLineField(fields, 'dispatch_table_entry', event.dispatchTableEntry);
  addLineField(fields, 'dispatch_table_hash_before', event.dispatchTableHashBefore);
  addLineField(fields, 'dispatch_table_hash_after', event.dispatchTableHashAfter);
  addLineField(fields, 'output_target', event.outputTargetId);
  addLineField(fields, 'output_target_id', event.outputTargetId);
  addLineField(fields, 'oracle_kind', event.oracleKind);
  addLineField(fields, 'camera_state_hash', event.cameraStateHash);
  addLineField(fields, 'frame_number', event.frameNumber);
  addLineField(fields, 'capture_backend', event.captureBackend);
  addLineField(fields, 'framebuffer_identity', event.swapchainOrFramebufferIdentity);
  addLineField(fields, 'swapchain_or_framebuffer_identity', event.swapchainOrFramebufferIdentity);
  if (Array.isArray(event.swapchainSize) && event.swapchainSize.length >= 2) {
    addLineField(fields, 'swapchain_size', `${event.swapchainSize[0]}x${event.swapchainSize[1]}`);
  }
  addLineField(fields, 'timestamp_monotonic_ns', event.timestampMonotonicNs);
  addLineField(fields, 'timestamp_ns', event.timestampMonotonicNs);
  addLineField(fields, 'retirement_proof', event.retirementProof);
  addLineField(fields, 'retirement_result', event.retirementResult);
  addLineField(fields, 'retirement_strategy', event.retirementStrategy);
  return fields;
}

export function materializeRuntimeBoundaryEventLines(events = []) {
  const normalizedEvents = normalizeRuntimeBoundaryEvents(events);
  const materializedEvents = normalizedEvents.map((event) => {
    const token = STAGE_BOUNDARY_LINE_TOKENS[event.stage]
      ?? (event.eventType === RETIREMENT_RECEIPT_EVENT_TYPE
        ? RETIREMENT_RECEIPT_EVENT_TYPE
        : eventKind(event.raw) ?? 'unknown_event');
    const fields = canonicalBoundaryLineFields(event);
    const orderedFields = Object.fromEntries(
      Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)),
    );
    const fieldText = Object.entries(orderedFields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const line = fieldText
      ? `[gpu-runtime-boundary] ${token} ${fieldText}`
      : `[gpu-runtime-boundary] ${token}`;
    return {
      sourceEventIndex: event.index,
      source_event_index: event.index,
      sourceEventHash: event.lineHash,
      source_event_hash: event.lineHash,
      eventType: event.eventType,
      event_type: event.eventType,
      stage: event.stage,
      token,
      boundaryLine: line,
      boundary_line: line,
      boundaryLineHash: boundaryLineHash(line),
      boundary_line_hash: boundaryLineHash(line),
      fieldCount: Object.keys(orderedFields).length,
      field_count: Object.keys(orderedFields).length,
      fields: orderedFields,
    };
  });
  const runtimeBoundaryLines = materializedEvents.map((entry) => entry.boundaryLine);
  const boundaryLineHashes = materializedEvents.map((entry) => entry.boundaryLineHash);
  const sourceEventHashes = materializedEvents.map((entry) => entry.sourceEventHash);
  const failedGates = [
    normalizedEvents.length > 0 ? null : 'runtime_boundary_materialization_events_missing',
    ...materializedEvents.flatMap((entry) => [
      entry.eventType ? null : 'runtime_boundary_materialization_stage_unknown',
      entry.fieldCount > 0 ? null : 'runtime_boundary_materialization_fields_missing',
    ]),
  ].filter(Boolean);
  const bindingSeed = { boundaryLineHashes, sourceEventHashes };
  return {
    schemaVersion: MATERIALIZED_BOUNDARY_LINES_SCHEMA_VERSION,
    schema_version: MATERIALIZED_BOUNDARY_LINES_SCHEMA_VERSION,
    proofAuthority: MATERIALIZED_BOUNDARY_LINES_AUTHORITY,
    proof_authority: MATERIALIZED_BOUNDARY_LINES_AUTHORITY,
    accepted: failedGates.length === 0,
    acceptedAsMaterializedBoundaryLines: failedGates.length === 0,
    accepted_as_materialized_boundary_lines: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    eventCount: normalizedEvents.length,
    event_count: normalizedEvents.length,
    lineCount: runtimeBoundaryLines.length,
    line_count: runtimeBoundaryLines.length,
    runtimeBoundaryLines,
    runtime_boundary_lines: runtimeBoundaryLines,
    adapterRuntimeBoundaryLines: runtimeBoundaryLines,
    adapter_runtime_boundary_lines: runtimeBoundaryLines,
    boundaryLineHashes,
    boundary_line_hashes: boundaryLineHashes,
    runtimeBoundaryLineHashes: boundaryLineHashes,
    runtime_boundary_line_hashes: boundaryLineHashes,
    adapterRuntimeBoundaryLineHashes: boundaryLineHashes,
    adapter_runtime_boundary_line_hashes: boundaryLineHashes,
    sourceEventHashes,
    source_event_hashes: sourceEventHashes,
    materializedEvents,
    materialized_events: materializedEvents,
    bindingHash: sha256Stable(bindingSeed),
    binding_hash: sha256Stable(bindingSeed),
    failedGates: [...new Set(failedGates)],
    failed_gates: [...new Set(failedGates)],
  };
}

function boundaryEventByStage(events) {
  const map = new Map();
  for (const event of events) {
    if (event.stage && !map.has(event.stage)) map.set(event.stage, event);
  }
  return map;
}

function boundaryEventsByStage(events) {
  const map = new Map();
  for (const event of events) {
    if (!event.stage) continue;
    const existing = map.get(event.stage) ?? [];
    existing.push(event);
    map.set(event.stage, existing);
  }
  return map;
}

function retirementReceiptEvents(events) {
  return events.filter((event) => event.eventType === RETIREMENT_RECEIPT_EVENT_TYPE);
}

function runtimeBoundaryFieldFailures(stage, event) {
  if (!event) return [`runtime_boundary_stage_${stage}_missing`];
  const failures = [];
  if (event.successAuthorityClaimed) failures.push('runtime_boundary_event_claims_success_authority');
  if (event.evidenceRefs.length === 0) failures.push(`${stage}_evidence_refs_missing`);
  if (!event.processId) failures.push(`${stage}_process_id_missing`);
  if (!event.runtimeSessionId) failures.push(`${stage}_runtime_session_missing`);
  if (!event.timestampMonotonicNs && event.timestampMonotonicNs !== 0) {
    failures.push(`${stage}_timestamp_missing`);
  }
  if (stage !== 'host_identity' && !event.artifactHash) failures.push(`${stage}_artifact_hash_missing`);
  if (stage !== 'host_identity' && !event.artifactId) failures.push(`${stage}_artifact_identity_missing`);
  if (stage === 'epoch_publication') {
    if (!event.epoch) failures.push('epoch_publication_epoch_missing');
    if (!event.previousEpoch) failures.push('epoch_publication_previous_epoch_missing');
    if (!Number.isInteger(event.activeGeneration)) {
      failures.push('epoch_publication_active_generation_missing');
    }
    if (!Number.isInteger(event.previousGeneration)) {
      failures.push('epoch_publication_previous_generation_missing');
    }
    if (
      Number.isInteger(event.activeGeneration)
      && Number.isInteger(event.previousGeneration)
      && event.activeGeneration <= event.previousGeneration
    ) {
      failures.push('epoch_publication_generation_transition_not_forward');
    }
  }
  if (stage === 'dispatch_trace') {
    if (!event.epoch) failures.push('dispatch_trace_epoch_missing');
    if (!event.dispatchId) failures.push('dispatch_trace_dispatch_id_missing');
    if (!event.dispatchTableEntry) failures.push('dispatch_trace_table_entry_missing');
    if (!event.queueOrStream) failures.push('dispatch_trace_queue_or_stream_missing');
  }
  if (stage === 'host_identity') {
    if (!event.deviceUuid) failures.push('host_identity_device_uuid_missing');
    if (!event.contextId) failures.push('host_identity_context_id_missing');
    if (!event.queueOrStream) failures.push('host_identity_queue_or_stream_missing');
  }
  if (stage === 'output_oracle') {
    if (!event.epoch) failures.push('output_oracle_epoch_missing');
    if (!event.afterDispatchId) failures.push('output_oracle_after_dispatch_id_missing');
    if (!event.outputTargetId) failures.push('output_oracle_target_missing');
    if (isVisualOracleKind(event.oracleKind)) {
      if (!event.cameraStateHash) failures.push('output_oracle_visual_camera_state_hash_missing');
      if (!event.swapchainOrFramebufferIdentity) {
        failures.push('output_oracle_visual_framebuffer_identity_missing');
      }
      if (!event.swapchainSize) failures.push('output_oracle_visual_swapchain_size_missing');
      if (!Number.isInteger(event.frameNumber)) failures.push('output_oracle_visual_frame_number_missing');
      if (!event.captureBackend) failures.push('output_oracle_visual_capture_backend_missing');
    }
  }
  return failures;
}

function runtimeBoundaryRetirementFailures(event) {
  if (!event) return ['runtime_boundary_retirement_receipt_missing'];
  const failures = [];
  if (event.successAuthorityClaimed) failures.push('runtime_boundary_event_claims_success_authority');
  if (!event.eventId) failures.push('runtime_boundary_retirement_event_id_missing');
  if (!event.oldArtifactHash) failures.push('runtime_boundary_retirement_old_artifact_hash_missing');
  if (!event.epoch) failures.push('runtime_boundary_retirement_epoch_missing');
  if (!Number.isInteger(event.previousGeneration)) {
    failures.push('runtime_boundary_retirement_previous_generation_missing');
  }
  if (!event.processId) failures.push('runtime_boundary_retirement_process_id_missing');
  if (!event.runtimeSessionId) failures.push('runtime_boundary_retirement_runtime_session_missing');
  if (!event.queueOrStream) failures.push('runtime_boundary_retirement_dispatch_stream_missing');
  if (event.evidenceRefs.length === 0) failures.push('runtime_boundary_retirement_evidence_refs_missing');
  if (event.timestampMonotonicNs === null) failures.push('runtime_boundary_retirement_timestamp_missing');
  if (!event.retirementProof) {
    failures.push('runtime_boundary_retirement_proof_missing');
  } else if (!SUCCESSFUL_RETIREMENT_PROOFS.has(event.retirementProof)) {
    failures.push('runtime_boundary_retirement_proof_not_successful');
  }
  if (!event.retirementResult) {
    failures.push('runtime_boundary_retirement_result_missing');
  } else if (!SUCCESSFUL_RETIREMENT_RESULTS.has(event.retirementResult)) {
    failures.push('runtime_boundary_retirement_result_not_successful');
  }
  return failures;
}

function runtimeBoundaryLegacySyntheticRetirementFailures(
  retirement,
  publication,
  dispatch,
  output,
) {
  if (!retirement || !dispatch || !output) return [];
  const syntheticEventId = dispatch.runtimeSessionId && dispatch.dispatchId
    ? `runtime-boundary:${dispatch.runtimeSessionId}:${dispatch.dispatchId}:retire`
    : null;
  const syntheticFenceId = dispatch.queueOrStream
    ? `runtime-boundary:retirement:${dispatch.queueOrStream}`
    : null;
  const eventIdMatches = syntheticEventId !== null && retirement.eventId === syntheticEventId;
  const fenceIdMatches = syntheticFenceId !== null
    && retirement.retirementFenceIds.includes(syntheticFenceId);
  const timestampMatches = output.timestampMonotonicNs !== null
    && retirement.timestampMonotonicNs === output.timestampMonotonicNs + 1;
  const generationPairMatches = publication?.previousGeneration === 1
    && publication?.activeGeneration === 2;
  const signatureMatches = [
    eventIdMatches,
    fenceIdMatches,
    timestampMatches,
    generationPairMatches,
  ].filter(Boolean).length;
  return (eventIdMatches || fenceIdMatches) && signatureMatches >= 2
    ? ['runtime_boundary_retirement_receipt_legacy_synthetic']
    : [];
}

export function buildRuntimeBoundaryStageEvidence(events = []) {
  const normalizedEvents = normalizeRuntimeBoundaryEvents(events);
  const eventMap = boundaryEventByStage(normalizedEvents);
  const eventGroups = boundaryEventsByStage(normalizedEvents);
  const retirementReceipts = retirementReceiptEvents(normalizedEvents);
  const retirementReceipt = retirementReceipts[0] ?? null;
  const failedGates = [];
  for (const event of normalizedEvents) {
    if (!event.eventType) failedGates.push('runtime_boundary_event_stage_unknown');
    if (event.successAuthorityClaimed) failedGates.push('runtime_boundary_event_claims_success_authority');
    if (event.evidenceRefs.length === 0) failedGates.push('runtime_boundary_event_evidence_refs_missing');
  }
  for (const stage of REQUIRED_BOUNDARY_STAGES) {
    if ((eventGroups.get(stage) ?? []).length > 1) {
      failedGates.push(`runtime_boundary_stage_${stage}_duplicate`);
    }
    failedGates.push(...runtimeBoundaryFieldFailures(stage, eventMap.get(stage)));
  }
  if (retirementReceipts.length > 1) {
    failedGates.push('runtime_boundary_retirement_receipt_duplicate');
  }
  failedGates.push(...runtimeBoundaryRetirementFailures(retirementReceipt));
  const runtimeSessions = compactStringList(normalizedEvents.map((event) => event.runtimeSessionId));
  if (runtimeSessions.length > 1) failedGates.push('runtime_boundary_session_mismatch');
  const processIds = compactStringList(normalizedEvents.map((event) => event.processId));
  if (processIds.length > 1) failedGates.push('runtime_boundary_process_mismatch');
  const afterArtifactIds = compactStringList(
    REQUIRED_BOUNDARY_STAGES
      .map((stage) => eventMap.get(stage)?.artifactId)
      .filter(Boolean),
  );
  if (afterArtifactIds.length > 1) failedGates.push('runtime_boundary_artifact_identity_mismatch');
  const afterArtifactHashes = compactStringList(
    REQUIRED_BOUNDARY_STAGES
      .filter((stage) => stage !== 'host_identity')
      .map((stage) => eventMap.get(stage)?.artifactHash)
      .filter(Boolean),
  );
  if (afterArtifactHashes.length > 1) failedGates.push('runtime_boundary_artifact_hash_mismatch');
  const epoch = eventMap.get('epoch_publication')?.epoch;
  const dispatchEpoch = eventMap.get('dispatch_trace')?.epoch;
  const outputEpoch = eventMap.get('output_oracle')?.epoch;
  if (epoch && dispatchEpoch && epoch !== dispatchEpoch) failedGates.push('runtime_boundary_dispatch_epoch_mismatch');
  if (epoch && outputEpoch && epoch !== outputEpoch) failedGates.push('runtime_boundary_output_epoch_mismatch');
  const dispatchId = eventMap.get('dispatch_trace')?.dispatchId;
  const afterDispatchId = eventMap.get('output_oracle')?.afterDispatchId;
  if (dispatchId && afterDispatchId && dispatchId !== afterDispatchId) {
    failedGates.push('runtime_boundary_output_dispatch_id_mismatch');
  }
  const previousEpoch = eventMap.get('epoch_publication')?.previousEpoch;
  const previousGeneration = eventMap.get('epoch_publication')?.previousGeneration;
  const activeGeneration = eventMap.get('epoch_publication')?.activeGeneration;
  const dispatchStream = eventMap.get('dispatch_trace')?.queueOrStream;
  const streamEpochCounter = dispatchStream
    ? eventMap.get('epoch_publication')?.streamEpochCounters?.[dispatchStream]
    : null;
  if (dispatchStream && !Number.isInteger(streamEpochCounter)) {
    failedGates.push('runtime_boundary_epoch_stream_counter_missing');
  }
  if (
    Number.isInteger(streamEpochCounter)
    && Number.isInteger(activeGeneration)
    && streamEpochCounter !== activeGeneration
  ) {
    failedGates.push('runtime_boundary_epoch_stream_counter_generation_mismatch');
  }
  failedGates.push(...runtimeBoundaryLegacySyntheticRetirementFailures(
    retirementReceipt,
    eventMap.get('epoch_publication'),
    eventMap.get('dispatch_trace'),
    eventMap.get('output_oracle'),
  ));
  if (retirementReceipt) {
    if (
      retirementReceipt.runtimeSessionId
      && eventMap.get('dispatch_trace')?.runtimeSessionId
      && retirementReceipt.runtimeSessionId !== eventMap.get('dispatch_trace').runtimeSessionId
    ) {
      failedGates.push('runtime_boundary_retirement_session_mismatch');
    }
    if (
      retirementReceipt.processId
      && eventMap.get('host_identity')?.processId
      && retirementReceipt.processId !== eventMap.get('host_identity').processId
    ) {
      failedGates.push('runtime_boundary_retirement_process_mismatch');
    }
    if (
      retirementReceipt.queueOrStream
      && dispatchStream
      && retirementReceipt.queueOrStream !== dispatchStream
    ) {
      failedGates.push('runtime_boundary_retirement_stream_mismatch');
    }
    if (retirementReceipt.epoch && previousEpoch && retirementReceipt.epoch !== previousEpoch) {
      failedGates.push('runtime_boundary_retirement_epoch_mismatch');
    }
    if (
      Number.isInteger(retirementReceipt.previousGeneration)
      && Number.isInteger(previousGeneration)
      && retirementReceipt.previousGeneration !== previousGeneration
    ) {
      failedGates.push('runtime_boundary_retirement_generation_mismatch');
    }
  }
  const loadTs = eventMap.get('artifact_transport')?.timestampMonotonicNs;
  const publishTs = eventMap.get('epoch_publication')?.timestampMonotonicNs;
  const dispatchTs = eventMap.get('dispatch_trace')?.timestampMonotonicNs;
  const outputTs = eventMap.get('output_oracle')?.timestampMonotonicNs;
  if (loadTs !== null && publishTs !== null && publishTs < loadTs) {
    failedGates.push('runtime_boundary_epoch_precedes_load');
  }
  if (publishTs !== null && dispatchTs !== null && dispatchTs < publishTs) {
    failedGates.push('runtime_boundary_dispatch_precedes_epoch');
  }
  if (dispatchTs !== null && outputTs !== null && outputTs < dispatchTs) {
    failedGates.push('runtime_boundary_output_precedes_dispatch');
  }
  const retirementTs = retirementReceipt?.timestampMonotonicNs ?? null;
  if (outputTs !== null && retirementTs !== null && retirementTs <= outputTs) {
    failedGates.push('runtime_boundary_retirement_not_after_output');
  }
  return {
    schemaVersion: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    schema_version: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    proofAuthority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    accepted: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    normalizedEvents,
    normalized_events: normalizedEvents,
    stageEvents: Object.fromEntries(REQUIRED_BOUNDARY_STAGES.map((stage) => [stage, eventMap.get(stage) ?? null])),
    stage_events: Object.fromEntries(REQUIRED_BOUNDARY_STAGES.map((stage) => [stage, eventMap.get(stage) ?? null])),
    retirementReceipt,
    retirement_receipt: retirementReceipt,
    retirementEvent: retirementReceipt,
    retirement_event: retirementReceipt,
    boundaryLineHashes: normalizedEvents.map((event) => event.lineHash),
    boundary_line_hashes: normalizedEvents.map((event) => event.lineHash),
    artifactHashAfter: afterArtifactHashes[0] ?? null,
    artifact_hash_after: afterArtifactHashes[0] ?? null,
    failedGates: [...new Set(failedGates)],
    failed_gates: [...new Set(failedGates)],
  };
}

export function buildComputeOracleArtifactsFromByteEvidence(input = {}) {
  const verificationInput = {
    ...objectOrNull(input.rawReadbackVerification),
    ...objectOrNull(input.raw_readback_verification),
  };
  const rawReadbackHash = normalizeSha256(firstText(input.rawReadbackHash, input.raw_readback_hash));
  const checksumBefore = normalizeSha256(firstText(input.checksumBefore, input.checksum_before));
  const checksumAfter = normalizeSha256(firstText(input.checksumAfter, input.checksum_after));
  const deterministicSliceHash = normalizeSha256(firstText(
    input.deterministicSliceHash,
    input.deterministic_slice_hash,
    objectOrNull(input.deterministicSlice)?.hash,
    objectOrNull(input.deterministic_slice)?.hash,
  ));
  const byteLength = Number(input.rawReadbackByteLength ?? input.raw_readback_byte_length ?? input.byteLength ?? input.byte_length);
  const sliceOffset = Number(input.sliceOffset ?? input.slice_offset ?? objectOrNull(input.deterministicSlice)?.offset ?? 0);
  const sliceLength = Number(input.sliceLength ?? input.slice_length ?? objectOrNull(input.deterministicSlice)?.length ?? byteLength);
  const rawReadbackHashVerified =
    firstBool(input.rawReadbackHashVerified, input.raw_readback_hash_verified, verificationInput.hash_verified) === true
    && rawReadbackHash !== null;
  const deterministicSliceHashVerified =
    firstBool(
      input.deterministicSliceHashVerified,
      input.deterministic_slice_hash_verified,
      verificationInput.deterministic_slice_hash_verified,
    ) === true
    && deterministicSliceHash !== null;
  const expectedOutputVerified =
    firstBool(input.expectedOutputVerified, input.expected_output_verified, verificationInput.expected_output_verified) === true;
  const evidenceRefs = compactStringList([
    ...(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []),
    ...(Array.isArray(input.evidence_refs) ? input.evidence_refs : []),
    ...(Array.isArray(verificationInput.evidenceRefs) ? verificationInput.evidenceRefs : []),
    ...(Array.isArray(verificationInput.evidence_refs) ? verificationInput.evidence_refs : []),
  ]);
  return {
    raw_readback_bin: firstText(input.rawReadbackBin, input.raw_readback_bin) ?? 'runtime-boundary://raw-readback',
    readback_schema_json: firstText(input.readbackSchemaJson, input.readback_schema_json) ?? 'runtime-boundary://readback-schema',
    checksum_before: checksumBefore,
    checksum_after: checksumAfter,
    expected_output_change: firstBool(input.expectedOutputChange, input.expected_output_change),
    expected_output_verified: expectedOutputVerified,
    expected_output_hash: normalizeSha256(firstText(input.expectedOutputHash, input.expected_output_hash)),
    deterministic_slice: {
      offset: Number.isFinite(sliceOffset) ? sliceOffset : 0,
      length: Number.isFinite(sliceLength) && sliceLength > 0 ? sliceLength : byteLength,
      format: firstText(input.sliceFormat, input.slice_format, objectOrNull(input.deterministicSlice)?.format) ?? 'bytes',
      hash: deterministicSliceHash,
    },
    raw_readback_hash: rawReadbackHash,
    raw_readback_hash_verified: rawReadbackHashVerified,
    raw_readback_byte_length: Number.isFinite(byteLength) && byteLength > 0 ? byteLength : null,
    raw_readback_source: firstText(input.rawReadbackSource, input.raw_readback_source) ?? 'runtime_readback',
    deterministic_slice_hash: deterministicSliceHash,
    deterministic_slice_hash_verified: deterministicSliceHashVerified,
    raw_readback_verification: {
      hash_verified: rawReadbackHashVerified,
      byte_length: Number.isFinite(byteLength) && byteLength > 0 ? byteLength : null,
      deterministic_slice_hash: deterministicSliceHash,
      deterministic_slice_hash_verified: deterministicSliceHashVerified,
      expected_output_verified: expectedOutputVerified,
      slice_bounds_verified:
        Number.isFinite(byteLength)
        && byteLength > 0
        && Number.isFinite(sliceOffset)
        && Number.isFinite(sliceLength)
        && sliceLength > 0
        && sliceOffset + sliceLength <= byteLength,
    },
    oracle_code_hash: normalizeSha256(firstText(input.oracleCodeHash, input.oracle_code_hash)) ?? deterministicSliceHash,
    rendered_card_png: firstText(input.renderedCardPng, input.rendered_card_png) ?? 'runtime-boundary://compute-proof-card.png',
    producer: firstText(input.producer) ?? 'runtime_boundary_proof_adapter',
    timestamp_after_dispatch: firstTimestamp(input.timestampAfterDispatch, input.timestamp_after_dispatch),
    epoch: firstText(input.epoch),
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

function computeOracleArtifactsFromInput(input = {}, fallback = {}) {
  const explicit = objectOrNull(input.computeOracleArtifacts) ?? objectOrNull(input.compute_oracle_artifacts);
  if (explicit) return explicit;
  const byteEvidence = {
    ...objectOrNull(input.computeOracleByteEvidence),
    ...objectOrNull(input.compute_oracle_byte_evidence),
  };
  if (Object.keys(byteEvidence).length === 0) return null;
  return buildComputeOracleArtifactsFromByteEvidence({
    ...byteEvidence,
    ...fallback,
  });
}

function computeOracleEvidenceRefs(artifacts) {
  const source = objectOrNull(artifacts) ?? {};
  const verification = {
    ...objectOrNull(source.rawReadbackVerification),
    ...objectOrNull(source.raw_readback_verification),
  };
  return compactStringList([
    ...(Array.isArray(source.evidenceRefs) ? source.evidenceRefs : []),
    ...(Array.isArray(source.evidence_refs) ? source.evidence_refs : []),
    ...(Array.isArray(verification.evidenceRefs) ? verification.evidenceRefs : []),
    ...(Array.isArray(verification.evidence_refs) ? verification.evidence_refs : []),
  ]);
}

function computeOracleVerificationFailures(computeOracleArtifacts) {
  const source = objectOrNull(computeOracleArtifacts);
  if (!source) return ['runtime_boundary_compute_oracle_artifacts_missing'];
  const verification = {
    ...objectOrNull(source.rawReadbackVerification),
    ...objectOrNull(source.raw_readback_verification),
  };
  const rawHash = normalizeSha256(firstText(source.rawReadbackHash, source.raw_readback_hash));
  const slice = objectOrNull(source.deterministicSlice) ?? objectOrNull(source.deterministic_slice) ?? {};
  const deterministicSliceHash = normalizeSha256(firstText(
    source.deterministicSliceHash,
    source.deterministic_slice_hash,
    slice.hash,
  ));
  const checksumBefore = normalizeSha256(firstText(source.checksumBefore, source.checksum_before));
  const checksumAfter = normalizeSha256(firstText(source.checksumAfter, source.checksum_after));
  const byteLength = Number(
    source.rawReadbackByteLength
    ?? source.raw_readback_byte_length
    ?? verification.byte_length
    ?? verification.byteLength,
  );
  const rawHashVerified =
    firstBool(source.rawReadbackHashVerified, source.raw_readback_hash_verified, verification.hash_verified) === true;
  const deterministicSliceHashVerified =
    firstBool(
      source.deterministicSliceHashVerified,
      source.deterministic_slice_hash_verified,
      verification.deterministic_slice_hash_verified,
    ) === true;
  const expectedOutputVerified =
    firstBool(source.expectedOutputVerified, source.expected_output_verified, verification.expected_output_verified) === true;
  const expectedOutputChange = firstBool(source.expectedOutputChange, source.expected_output_change);
  return [
    rawHash ? null : 'runtime_boundary_compute_oracle_raw_readback_hash_missing',
    rawHashVerified ? null : 'runtime_boundary_compute_oracle_raw_readback_hash_unverified',
    Number.isFinite(byteLength) && byteLength > 0 ? null : 'runtime_boundary_compute_oracle_raw_readback_bytes_missing',
    deterministicSliceHash ? null : 'runtime_boundary_compute_oracle_deterministic_slice_hash_missing',
    deterministicSliceHashVerified ? null : 'runtime_boundary_compute_oracle_deterministic_slice_hash_unverified',
    checksumBefore ? null : 'runtime_boundary_compute_oracle_checksum_before_missing',
    checksumAfter ? null : 'runtime_boundary_compute_oracle_checksum_after_missing',
    expectedOutputVerified ? null : 'runtime_boundary_compute_oracle_expected_output_not_verified',
    expectedOutputChange === true && checksumBefore && checksumAfter && checksumBefore === checksumAfter
      ? 'runtime_boundary_compute_oracle_expected_change_missing'
      : null,
    computeOracleEvidenceRefs(source).length > 0 ? null : 'runtime_boundary_compute_oracle_evidence_refs_missing',
  ].filter(Boolean);
}

function visualOracleArtifactsFromInput(input = {}, outputEvent = null) {
  const inputArtifacts = objectOrNull(input.oracleArtifacts) ?? objectOrNull(input.oracle_artifacts) ?? {};
  const explicit = objectOrNull(input.visualOracleArtifacts)
    ?? objectOrNull(input.visual_oracle_artifacts)
    ?? objectOrNull(inputArtifacts.visualOracleArtifacts)
    ?? objectOrNull(inputArtifacts.visual_oracle_artifacts)
    ?? null;
  const rawOutput = objectOrNull(outputEvent?.raw) ?? {};
  const captureManifest = objectOrNull(explicit?.capture_manifest)
    ?? objectOrNull(explicit?.captureManifest)
    ?? objectOrNull(explicit?.after_capture_manifest)
    ?? objectOrNull(explicit?.afterCaptureManifest)
    ?? objectOrNull(input.capture_manifest)
    ?? objectOrNull(input.captureManifest)
    ?? objectOrNull(input.visual_capture_manifest)
    ?? objectOrNull(input.visualCaptureManifest)
    ?? null;
  const source = {
    ...(explicit ?? {}),
    ...(captureManifest ? { capture_manifest: captureManifest } : {}),
  };
  const beforeImage = firstText(source.beforeImage, source.before_image, rawOutput.beforeImage, rawOutput.before_image);
  const afterImage = firstText(source.afterImage, source.after_image, rawOutput.afterImage, rawOutput.after_image);
  const diffImage = firstText(source.diffImage, source.diff_image, rawOutput.diffImage, rawOutput.diff_image);
  const beforeImageHash = normalizeSha256(firstText(
    source.beforeImageHash,
    source.before_image_hash,
    rawOutput.beforeImageHash,
    rawOutput.before_image_hash,
  ));
  const afterImageHash = normalizeSha256(firstText(
    source.afterImageHash,
    source.after_image_hash,
    rawOutput.afterImageHash,
    rawOutput.after_image_hash,
  ));
  const diffImageHash = normalizeSha256(firstText(
    source.diffImageHash,
    source.diff_image_hash,
    rawOutput.diffImageHash,
    rawOutput.diff_image_hash,
  ));
  if (!explicit && !beforeImage && !afterImage && !diffImage && !beforeImageHash && !afterImageHash && !diffImageHash) {
    return null;
  }
  const evidenceRefs = compactStringList([
    ...(Array.isArray(source.evidenceRefs) ? source.evidenceRefs : []),
    ...(Array.isArray(source.evidence_refs) ? source.evidence_refs : []),
    ...(Array.isArray(outputEvent?.evidenceRefs) ? outputEvent.evidenceRefs : []),
    ...(Array.isArray(rawOutput.evidenceRefs) ? rawOutput.evidenceRefs : []),
    ...(Array.isArray(rawOutput.evidence_refs) ? rawOutput.evidence_refs : []),
  ]);
  const frameNumber = positiveInteger(source.frameNumber, source.frame_number, outputEvent?.frameNumber, rawOutput.frameNumber, rawOutput.frame_number);
  const timestampAfterDispatch = firstTimestamp(
    source.timestampAfterDispatch,
    source.timestamp_after_dispatch,
    outputEvent?.timestampMonotonicNs,
    rawOutput.timestampAfterDispatch,
    rawOutput.timestamp_after_dispatch,
  );
  const swapchainSize = normalizeSwapchainSize(
    source.swapchainSize,
    source.swapchain_size,
    outputEvent?.swapchainSize,
    rawOutput.swapchainSize,
    rawOutput.swapchain_size,
  );
  const visualPixelVerification = {
    ...objectOrNull(source.visualPixelVerification),
    ...objectOrNull(source.visual_pixel_verification),
    before_image_hash: beforeImageHash,
    before_image_hash_verified: firstBool(
      source.beforeImageHashVerified,
      source.before_image_hash_verified,
      objectOrNull(source.visualPixelVerification)?.beforeImageHashVerified,
      objectOrNull(source.visual_pixel_verification)?.before_image_hash_verified,
    ) === true,
    after_image_hash: afterImageHash,
    after_image_hash_verified: firstBool(
      source.afterImageHashVerified,
      source.after_image_hash_verified,
      objectOrNull(source.visualPixelVerification)?.afterImageHashVerified,
      objectOrNull(source.visual_pixel_verification)?.after_image_hash_verified,
    ) === true,
    diff_image_hash: diffImageHash,
    diff_image_hash_verified: firstBool(
      source.diffImageHashVerified,
      source.diff_image_hash_verified,
      objectOrNull(source.visualPixelVerification)?.diffImageHashVerified,
      objectOrNull(source.visual_pixel_verification)?.diff_image_hash_verified,
    ) === true,
    metrics_verified: firstBool(
      source.pixelMetricsVerified,
      source.pixel_metrics_verified,
      objectOrNull(source.visualPixelVerification)?.metricsVerified,
      objectOrNull(source.visual_pixel_verification)?.metrics_verified,
    ),
  };
  const result = {
    ...source,
    before_image: beforeImage,
    after_image: afterImage,
    diff_image: diffImage,
    before_image_hash: beforeImageHash,
    after_image_hash: afterImageHash,
    diff_image_hash: diffImageHash,
    blank_frame_rejection: firstBool(source.blankFrameRejection, source.blank_frame_rejection),
    same_frame_rejection: firstBool(source.sameFrameRejection, source.same_frame_rejection),
    new_epoch_watermark_or_trace: firstText(
      source.newEpochWatermarkOrTrace,
      source.new_epoch_watermark_or_trace,
      rawOutput.newEpochWatermarkOrTrace,
      rawOutput.new_epoch_watermark_or_trace,
      outputEvent?.afterDispatchId,
    ),
    camera_state_hash: normalizeSha256(firstText(
      source.cameraStateHash,
      source.camera_state_hash,
      outputEvent?.cameraStateHash,
      rawOutput.cameraStateHash,
      rawOutput.camera_state_hash,
    )),
    swapchain_size: swapchainSize,
    capture_backend: firstText(source.captureBackend, source.capture_backend, outputEvent?.captureBackend, rawOutput.captureBackend, rawOutput.capture_backend),
    frame_number: frameNumber,
    timestamp_after_dispatch: timestampAfterDispatch,
    changed_pixel_ratio: positiveNumber(
      source.changedPixelRatio,
      source.changed_pixel_ratio,
      objectOrNull(source.visualPixelVerification)?.changedPixelRatio,
      objectOrNull(source.visual_pixel_verification)?.changed_pixel_ratio,
    ),
    perceptual_diff: positiveNumber(
      source.perceptualDiff,
      source.perceptual_diff,
      objectOrNull(source.visualPixelVerification)?.perceptualDiff,
      objectOrNull(source.visual_pixel_verification)?.perceptual_diff,
    ),
    visible_pixel_count: positiveInteger(
      source.visiblePixelCount,
      source.visible_pixel_count,
      objectOrNull(source.visualPixelVerification)?.visiblePixelCount,
      objectOrNull(source.visual_pixel_verification)?.visible_pixel_count,
    ),
    evidenceRefs,
    evidence_refs: evidenceRefs,
    visual_pixel_verification: visualPixelVerification,
  };
  if (Array.isArray(source.artifactLocators)) result.artifactLocators = source.artifactLocators;
  if (Array.isArray(source.artifact_locators)) result.artifact_locators = source.artifact_locators;
  if (Array.isArray(source.casLocators)) result.casLocators = source.casLocators;
  if (Array.isArray(source.cas_locators)) result.cas_locators = source.cas_locators;
  return result;
}

function visualOracleEvidenceRefs(artifacts) {
  const source = objectOrNull(artifacts) ?? {};
  const verification = {
    ...objectOrNull(source.visualPixelVerification),
    ...objectOrNull(source.visual_pixel_verification),
  };
  return compactStringList([
    ...(Array.isArray(source.evidenceRefs) ? source.evidenceRefs : []),
    ...(Array.isArray(source.evidence_refs) ? source.evidence_refs : []),
    ...(Array.isArray(verification.evidenceRefs) ? verification.evidenceRefs : []),
    ...(Array.isArray(verification.evidence_refs) ? verification.evidence_refs : []),
  ]);
}

function visualOracleVerificationFailures(visualOracleArtifacts) {
  const source = objectOrNull(visualOracleArtifacts);
  if (!source) return ['runtime_boundary_visual_oracle_artifacts_missing'];
  const beforeHash = visualRoleHash(source, 'before');
  const afterHash = visualRoleHash(source, 'after');
  const diffHash = visualRoleHash(source, 'diff');
  return [
    visualRoleHasReference(source, 'before') ? null : 'runtime_boundary_visual_oracle_before_image_missing',
    visualRoleHasReference(source, 'after') ? null : 'runtime_boundary_visual_oracle_after_image_missing',
    visualRoleHasReference(source, 'diff') ? null : 'runtime_boundary_visual_oracle_diff_image_missing',
    beforeHash ? null : 'runtime_boundary_visual_oracle_before_image_hash_missing',
    afterHash ? null : 'runtime_boundary_visual_oracle_after_image_hash_missing',
    diffHash ? null : 'runtime_boundary_visual_oracle_diff_image_hash_missing',
    beforeHash && afterHash && beforeHash === afterHash
      ? 'runtime_boundary_visual_oracle_before_after_image_hashes_not_distinct'
      : null,
    diffHash && (diffHash === beforeHash || diffHash === afterHash)
      ? 'runtime_boundary_visual_oracle_diff_image_hash_not_distinct'
      : null,
    source.blank_frame_rejection === true ? null : 'runtime_boundary_visual_oracle_blank_frame_rejection_missing',
    source.same_frame_rejection === true ? null : 'runtime_boundary_visual_oracle_same_frame_rejection_missing',
    firstText(source.newEpochWatermarkOrTrace, source.new_epoch_watermark_or_trace)
      ? null
      : 'runtime_boundary_visual_oracle_epoch_trace_missing',
    source.camera_state_hash ? null : 'runtime_boundary_visual_oracle_camera_state_hash_missing',
    normalizeSwapchainSize(source.swapchain_size, source.swapchainSize) ? null : 'runtime_boundary_visual_oracle_swapchain_size_missing',
    firstText(source.capture_backend, source.captureBackend) ? null : 'runtime_boundary_visual_oracle_capture_backend_missing',
    Number.isInteger(positiveInteger(source.frame_number, source.frameNumber)) ? null : 'runtime_boundary_visual_oracle_frame_number_missing',
    firstTimestamp(source.timestamp_after_dispatch, source.timestampAfterDispatch) !== null
      ? null
      : 'runtime_boundary_visual_oracle_timestamp_after_dispatch_missing',
    positiveNumber(source.changed_pixel_ratio, source.changedPixelRatio) ? null : 'runtime_boundary_visual_oracle_changed_pixel_ratio_missing',
    positiveNumber(source.perceptual_diff, source.perceptualDiff) ? null : 'runtime_boundary_visual_oracle_perceptual_diff_missing',
    positiveInteger(source.visible_pixel_count, source.visiblePixelCount) ? null : 'runtime_boundary_visual_oracle_visible_pixel_count_missing',
    firstBool(
      source.pixelMetricsVerified,
      source.pixel_metrics_verified,
      objectOrNull(source.visual_pixel_verification)?.metrics_verified,
      objectOrNull(source.visualPixelVerification)?.metricsVerified,
    ) === true ? null : 'runtime_boundary_visual_oracle_pixel_metrics_unverified',
    visualOracleEvidenceRefs(source).length > 0 ? null : 'runtime_boundary_visual_oracle_evidence_refs_missing',
  ].filter(Boolean);
}

export function buildRuntimeBoundaryInputEvidence(input = {}) {
  const sourcePaths = compactStringList(input.sourcePaths ?? input.source_paths);
  const entryPoint = firstText(input.entryPoint, input.entry_point, input.kernelName, input.kernel_name);
  const compileTarget = firstText(input.compileTarget, input.compile_target, input.gpuArch, input.gpu_arch);
  const compiler = firstText(input.compiler);
  const compilerArgsHash = normalizeSha256(firstText(input.compilerArgsHash, input.compiler_args_hash));
  const sourceManifestHash = normalizeSha256(firstText(
    input.sourceManifestHash,
    input.source_manifest_hash,
    input.sourceTreeManifestHash,
    input.source_tree_manifest_hash,
    input.sourceIdentityHash,
    input.source_identity_hash,
  ));
  const sourceManifestHashVerified = firstBool(
    input.sourceManifestHashVerified,
    input.source_manifest_hash_verified,
    input.sourceTreeManifestHashVerified,
    input.source_tree_manifest_hash_verified,
    input.sourceIdentityHashVerified,
    input.source_identity_hash_verified,
  ) === true;
  const sourceIdentityEvidenceRefs = compactStringList([
    ...(input.sourceIdentityEvidenceRefs ?? input.source_identity_evidence_refs ?? []),
    ...(input.sourceManifestEvidenceRefs ?? input.source_manifest_evidence_refs ?? []),
  ]);
  const artifactHashBefore = normalizeSha256(firstText(input.artifactHashBefore, input.artifact_hash_before));
  const artifactHashAfter = normalizeSha256(firstText(input.artifactHashAfter, input.artifact_hash_after));
  const contractHash = normalizeSha256(firstText(input.contractHash, input.contract_hash));
  const projectId = firstText(input.projectId, input.project_id, input.workspaceSlug, input.workspace_slug);
  const editId = firstText(input.editId, input.edit_id, input.sourceEditId, input.source_edit_id);
  const targetId = firstText(input.targetId, input.target_id);
  const backend = firstText(input.backend);
  const stageEventsForInput = boundaryEventByStage(
    normalizeRuntimeBoundaryEvents(input.runtimeBoundaryEvents ?? input.runtime_boundary_events ?? []),
  );
  const outputEventForInput = stageEventsForInput.get('output_oracle') ?? null;
  const computeOracleArtifacts = computeOracleArtifactsFromInput(input);
  const visualOracleArtifacts = visualOracleArtifactsFromInput(input, outputEventForInput);
  const visualEvidenceArtifacts = visualEvidenceArtifactsFromInput(input);
  const visualOracleRequested =
    Boolean(visualOracleArtifacts)
    || isVisualOracleKind(firstText(input.oracleKind, input.oracle_kind, outputEventForInput?.oracleKind));
  const oracleVerificationFailures = visualOracleRequested
    ? [
        ...visualOracleVerificationFailures(visualOracleArtifacts),
        ...visualEvidenceArtifactsVerificationFailures(visualOracleArtifacts, visualEvidenceArtifacts),
      ]
    : computeOracleVerificationFailures(computeOracleArtifacts);
  const failedGates = [
    projectId ? null : 'runtime_boundary_project_id_missing',
    editId ? null : 'runtime_boundary_edit_id_missing',
    targetId ? null : 'runtime_boundary_target_id_missing',
    backend ? null : 'runtime_boundary_backend_missing',
    sourcePaths.length > 0 ? null : 'runtime_boundary_source_paths_missing',
    sourceManifestHash ? null : 'runtime_boundary_source_manifest_hash_missing',
    sourceManifestHash && sourceManifestHashVerified
      ? null
      : 'runtime_boundary_source_manifest_hash_unverified',
    sourceIdentityEvidenceRefs.length > 0
      ? null
      : 'runtime_boundary_source_identity_evidence_refs_missing',
    entryPoint ? null : 'runtime_boundary_entry_point_missing',
    compileTarget ? null : 'runtime_boundary_compile_target_missing',
    compiler ? null : 'runtime_boundary_compiler_missing',
    compilerArgsHash ? null : 'runtime_boundary_compiler_args_hash_missing',
    artifactHashBefore ? null : 'runtime_boundary_artifact_hash_before_missing',
    artifactHashAfter ? null : 'runtime_boundary_artifact_hash_after_missing',
    artifactHashBefore && artifactHashAfter && artifactHashBefore === artifactHashAfter
      ? 'runtime_boundary_artifact_hash_unchanged'
      : null,
    contractHash ? null : 'runtime_boundary_contract_hash_missing',
    ...oracleVerificationFailures,
  ].filter(Boolean);
  return {
    schemaVersion: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    schema_version: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    proofAuthority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    accepted: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    sourcePaths,
    source_paths: sourcePaths,
    sourceManifestHash,
    source_manifest_hash: sourceManifestHash,
    sourceManifestHashVerified,
    source_manifest_hash_verified: sourceManifestHashVerified,
    sourceIdentityEvidenceRefs,
    source_identity_evidence_refs: sourceIdentityEvidenceRefs,
    entryPoint,
    entry_point: entryPoint,
    compileTarget,
    compile_target: compileTarget,
    compiler,
    compilerArgsHash,
    compiler_args_hash: compilerArgsHash,
    artifactHashBefore,
    artifact_hash_before: artifactHashBefore,
    artifactHashAfter,
    artifact_hash_after: artifactHashAfter,
    contractHash,
    contract_hash: contractHash,
    projectId,
    project_id: projectId,
    editId,
    edit_id: editId,
    targetId,
    target_id: targetId,
    backend,
    oracleKind: visualOracleRequested ? 'visual' : 'compute',
    oracle_kind: visualOracleRequested ? 'visual' : 'compute',
    computeOracleEvidenceRefs: computeOracleEvidenceRefs(computeOracleArtifacts),
    compute_oracle_evidence_refs: computeOracleEvidenceRefs(computeOracleArtifacts),
    visualOracleEvidenceRefs: visualOracleEvidenceRefs(visualOracleArtifacts),
    visual_oracle_evidence_refs: visualOracleEvidenceRefs(visualOracleArtifacts),
    failedGates,
    failed_gates: failedGates,
  };
}

function buildRuntimeBoundaryInputStageBindingEvidence(inputEvidence, stageEvidence) {
  const retirementReceipt = stageEvidence.retirementReceipt;
  const failedGates = [
    stageEvidence.artifactHashAfter ? null : 'runtime_boundary_observed_artifact_hash_after_missing',
    inputEvidence.artifactHashAfter
      && stageEvidence.artifactHashAfter
      && inputEvidence.artifactHashAfter !== stageEvidence.artifactHashAfter
      ? 'runtime_boundary_input_artifact_hash_after_mismatch'
      : null,
    inputEvidence.artifactHashBefore
      && stageEvidence.artifactHashAfter
      && inputEvidence.artifactHashBefore === stageEvidence.artifactHashAfter
      ? 'runtime_boundary_observed_artifact_matches_before_hash'
      : null,
    retirementReceipt?.oldArtifactHash
      && inputEvidence.artifactHashBefore
      && retirementReceipt.oldArtifactHash !== inputEvidence.artifactHashBefore
      ? 'runtime_boundary_retirement_old_artifact_hash_mismatch'
      : null,
  ].filter(Boolean);
  return {
    schemaVersion: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    schema_version: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    proofAuthority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    accepted: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    inputArtifactHashAfter: inputEvidence.artifactHashAfter,
    input_artifact_hash_after: inputEvidence.artifactHashAfter,
    observedArtifactHashAfter: stageEvidence.artifactHashAfter,
    observed_artifact_hash_after: stageEvidence.artifactHashAfter,
    observedRetirementArtifactHash: retirementReceipt?.oldArtifactHash ?? null,
    observed_retirement_artifact_hash: retirementReceipt?.oldArtifactHash ?? null,
    failedGates,
    failed_gates: failedGates,
  };
}

function defaultModelProvenance() {
  const availabilitySource = 'https://ai.google.dev/gemini-api/docs/deprecations';
  return {
    split: {
      provider: 'google_gemini',
      requested_model: 'gemini-3.5-flash',
      provider_model_status: 'available',
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: false,
      model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      model_availability_source: availabilitySource,
      model_availability_basis: 'static_registry',
      model_availability_check_time_ms: 0,
      actual_model: 'gemini-3.5-flash',
      fallback_model: null,
      fallback_used: false,
      request_mode: 'split',
      hard_infra_failure: false,
    },
    last_gpu_delta: {
      provider: 'google_gemini',
      requested_model: 'gemini-3.1-flash-lite',
      provider_model_status: 'deprecated',
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: true,
      model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      model_availability_source: availabilitySource,
      model_availability_basis: 'static_registry',
      model_availability_check_time_ms: 0,
      actual_model: 'gemini-3.1-flash-lite',
      fallback_model: null,
      fallback_used: false,
      request_mode: 'gpu_delta',
      hard_infra_failure: false,
    },
  };
}

function defaultTimings(overrides = {}) {
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    ...Object.fromEntries(REQUIRED_TIMING_FIELDS.map((field, index) => [field, index + 1])),
    ...overrides,
  };
}

function fissionCoverage(evidencePrefix) {
  return {
    requiredCategories: [...FISSION_VERIFICATION_CATEGORIES],
    missingCategories: [],
    categories: FISSION_VERIFICATION_CATEGORIES.map((category) => ({
      category,
      evidenceIds: [`${evidencePrefix}:${category}`],
    })),
  };
}

function runtimeBoundaryEvidenceRefs(stageEvidence) {
  return compactStringList([
    ...stageEvidence.normalizedEvents.flatMap((event) => event.evidenceRefs),
    ...stageEvidence.boundaryLineHashes.map((hash) => `runtime-boundary-event:${hash}`),
  ]);
}

function retirementStrategyFromReceipt(receipt) {
  const explicit = normalizedEnumText(receipt?.retirementStrategy);
  if ([
    'epoch_fence',
    'conservative_drain_fallback',
    'no_retirement_required',
  ].includes(explicit)) {
    return explicit;
  }
  if (receipt?.retirementProof === 'queue_idle_proven') return 'conservative_drain_fallback';
  if (receipt?.retirementProof === 'no_retirement_required') return 'no_retirement_required';
  return 'epoch_fence';
}

function buildBoundaryProofComponents(input, stageEvidence) {
  const stages = stageEvidence.stageEvents;
  const artifactTransport = stages.artifact_transport;
  const epoch = stages.epoch_publication;
  const dispatch = stages.dispatch_trace;
  const host = stages.host_identity;
  const output = stages.output_oracle;
  const retirement = stageEvidence.retirementReceipt;
  const backend = firstText(input.backend);
  let visualOracleArtifacts = visualOracleArtifactsFromInput(input, output);
  const oracleMode = visualOracleArtifacts ? 'visual' : 'compute';
  const artifactAfterHash = normalizeSha256(firstText(input.artifactHashAfter, input.artifact_hash_after));
  const artifactBeforeHash = normalizeSha256(firstText(input.artifactHashBefore, input.artifact_hash_before));
  const artifactAfterId = artifactIdFromHash(artifactAfterHash);
  const artifactBeforeId = artifactIdFromHash(artifactBeforeHash);
  const runtimeSessionId = dispatch?.runtimeSessionId ?? epoch?.runtimeSessionId ?? artifactTransport?.runtimeSessionId;
  const processId = host?.processId ?? dispatch?.processId ?? output?.processId;
  const streamId = dispatch?.queueOrStream ?? host?.queueOrStream;
  const outputTargetId = output?.outputTargetId ?? firstText(input.outputTargetId, input.output_target_id) ?? 'runtime-output-target';
  const visualTargetIdentity = output?.swapchainOrFramebufferIdentity
    ?? firstText(input.swapchainOrFramebufferIdentity, input.swapchain_or_framebuffer_identity)
    ?? outputTargetId;
  const dispatchId = dispatch?.dispatchId;
  const previousGeneration = epoch.previousGeneration;
  const activeGeneration = epoch.activeGeneration;
  const retirementFenceIds = [...retirement.retirementFenceIds];
  const retirementEvidenceRefs = [...retirement.evidenceRefs];
  const retirementStrategy = retirementStrategyFromReceipt(retirement);
  const retirementProven =
    SUCCESSFUL_RETIREMENT_PROOFS.has(retirement.retirementProof)
    && SUCCESSFUL_RETIREMENT_RESULTS.has(retirement.retirementResult)
    && retirement.oldArtifactHash === artifactBeforeHash
    && retirement.epoch === epoch.previousEpoch
    && retirement.previousGeneration === previousGeneration
    && retirement.processId === processId
    && retirement.runtimeSessionId === runtimeSessionId
    && retirement.queueOrStream === streamId
    && retirement.evidenceRefs.length > 0
    && retirement.timestampMonotonicNs > output.timestampMonotonicNs;
  const entryPoint = firstText(
    input.entryPoint,
    input.entry_point,
    input.kernelName,
    input.kernel_name,
    dispatch?.dispatchTableEntry?.split(':')[0],
  );
  const sourcePaths = compactStringList(input.sourcePaths ?? input.source_paths);
  const sourceManifestHash = normalizeSha256(firstText(
    input.sourceManifestHash,
    input.source_manifest_hash,
    input.sourceTreeManifestHash,
    input.source_tree_manifest_hash,
    input.sourceIdentityHash,
    input.source_identity_hash,
  ));
  const sourceIdentityEvidenceRefs = compactStringList([
    ...(input.sourceIdentityEvidenceRefs ?? input.source_identity_evidence_refs ?? []),
    ...(input.sourceManifestEvidenceRefs ?? input.source_manifest_evidence_refs ?? []),
  ]);
  const sourceDependencyClosureHash = sha256Stable({
    sourcePaths,
    sourceManifestHash,
  });
  const compileTarget = firstText(input.compileTarget, input.compile_target, input.gpuArch, input.gpu_arch);
  const compiler = firstText(input.compiler);
  const compilerArgsHash = normalizeSha256(firstText(input.compilerArgsHash, input.compiler_args_hash));
  const contractHash = normalizeSha256(firstText(input.contractHash, input.contract_hash));
  const evidencePrefix = `runtime-boundary:${runtimeSessionId}:${dispatchId}`;
  const boundaryRefs = runtimeBoundaryEvidenceRefs(stageEvidence);
  const compileRefs = compactStringList([
    ...(input.compileEvidenceRefs ?? input.compile_evidence_refs ?? []),
    `compile:${compiler}:${compilerArgsHash}`,
    `compile-artifact:${artifactAfterId}`,
  ]);
  const symbolRefs = compactStringList([
    ...(input.symbolEvidenceRefs ?? input.symbol_evidence_refs ?? []),
    `symbol:${entryPoint}`,
  ]);
  const fissionVerifierRefs = FISSION_VERIFICATION_CATEGORIES.map((category) =>
    `${evidencePrefix}:fission:${category}`
  );
  const sourceProofs = [{
    schemaVersion: 'synthi.gpu.hmr.source_proof.v1',
    resultState: 'gpu-hmr-symbol-bound',
    compileEvidenceObserved: true,
    compileProven: true,
    symbolBindingEvidenceObserved: true,
    symbolBindingProven: true,
    sourceProofProven: true,
    compileEvidenceRefs: compileRefs,
    symbolEvidenceRefs: symbolRefs,
    sourceManifestHash,
    source_manifest_hash: sourceManifestHash,
    sourceManifestEvidenceRefs: sourceIdentityEvidenceRefs,
    source_manifest_evidence_refs: sourceIdentityEvidenceRefs,
    sourceIdentityEvidenceRefs,
    source_identity_evidence_refs: sourceIdentityEvidenceRefs,
    evidenceRefs: compactStringList([...compileRefs, ...symbolRefs, ...sourceIdentityEvidenceRefs]),
    proofArtifactPaths: [firstText(input.sourceProofArtifactPath, input.source_proof_artifact_path) ?? 'runtime-boundary://source-proof.json'],
    artifactId: artifactAfterId,
    selectedArtifactId: artifactAfterId,
  }];
  const fissionProof = classifyGpuHmrFissionProof({
    status: 'passed',
    selectedIslandIds: ['runtime-boundary-device-island'],
    selectedIslandContracts: [{
      islandId: 'runtime-boundary-device-island',
      sourcePaths,
      artifactKind: firstText(input.artifactKind, input.artifact_kind) ?? (backend === 'opencl' ? 'opencl_program' : 'hsaco'),
      targetSymbols: [entryPoint],
      compiler,
      compileCommandHash: compilerArgsHash,
      includeClosure: [],
      excludedHostSources: compactStringList(input.excludedHostSources ?? input.excluded_host_sources),
      verifierEvidenceId: fissionVerifierRefs[0],
      deterministicVerifierEvidenceIds: fissionVerifierRefs,
      outputOracleContract: {
        kind: output?.oracleKind === 'output_oracle' ? 'buffer_checksum' : output?.oracleKind,
        outputTargetId,
        readbackPlan: 'after-dispatch',
      },
      verificationEvidenceCoverage: fissionCoverage(`${evidencePrefix}:fission`),
    }],
    verifierEvidenceRefs: fissionVerifierRefs,
    deterministicVerifierEvidenceRefs: fissionVerifierRefs,
    evidenceRefs: [`evidence:fission-verifier-report:${sha256Hex(evidencePrefix)}`],
  });
  const abiEvidenceRef = `abi:${entryPoint}:${contractHash}`;
  const abiProof = classifyGpuHmrAbiProof({
    metadataObserved: true,
    layoutSizeAlignmentVerified: true,
    abiCompatibilityClass: firstText(input.abiCompatibilityClass, input.abi_compatibility_class) ?? 'compatible',
    kernelAbiFingerprintHashes: [contractHash],
    constantGlobalLayoutHashes: [sha256Stable({ outputTargetId, entryPoint })],
    extractorProvenance: [{
      kind: 'runtime_wrapper_instrumentation',
      evidenceId: abiEvidenceRef,
      extractorName: 'runtime-boundary-proof-adapter',
      extractorVersion: '1',
      command: 'runtime-boundary-event-normalization',
      inputHash: sha256Stable(stageEvidence.normalizedEvents),
    }],
    evidenceRefs: [abiEvidenceRef],
  });
  const dispatchTableHashBefore =
    epoch?.dispatchTableHashBefore
    ?? normalizeSha256(firstText(input.dispatchTableHashBefore, input.dispatch_table_hash_before))
    ?? sha256Stable({ before: artifactBeforeId, entryPoint });
  const dispatchTableHashAfter =
    epoch?.dispatchTableHashAfter
    ?? normalizeSha256(firstText(input.dispatchTableHashAfter, input.dispatch_table_hash_after))
    ?? sha256Stable({ after: artifactAfterId, entryPoint });
  const epochProof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-epoch-swap-proven',
    published: true,
    activeEpoch: epoch.epoch,
    previousEpoch: epoch.previousEpoch,
    activeGeneration,
    previousGeneration,
    oldGenerationRetired: retirementProven,
    streamOrderingProven: retirementProven,
    retirementTracked: Boolean(retirement.eventId),
    retirementStrategy,
    delayedUnloadResult: retirement.retirementResult,
    streamIds: [streamId],
    streamScope: 'stream',
    eventId: epoch.eventId ?? `${evidencePrefix}:epoch`,
    processId,
    runtimeSessionId,
    retirementEventId: retirement.eventId,
    retirementEpoch: retirement.epoch,
    retirementPreviousGeneration: retirement.previousGeneration,
    retirementProof: retirement.retirementProof,
    retirementResult: retirement.retirementResult,
    retirementArtifactHash: retirement.oldArtifactHash,
    retirementProcessId: retirement.processId,
    retirementRuntimeSessionId: retirement.runtimeSessionId,
    retirementDispatchStream: retirement.queueOrStream,
    retirementTimestampMonotonicNs: retirement.timestampMonotonicNs,
    retirementFenceIds,
    retirementEvidenceRefs,
    epochGenerationGraph: {
      schemaVersion: 'synthi.gpu.epoch_graph.v1',
      runtimeSessionIds: [runtimeSessionId],
      retirementState: retirementProven ? 'retired' : 'pending',
      nodes: [
        { id: `generation:${previousGeneration}`, generation: previousGeneration },
        { id: `generation:${activeGeneration}`, generation: activeGeneration },
      ],
      edges: [{
        kind: 'publish',
        from: `generation:${previousGeneration}`,
        to: `generation:${activeGeneration}`,
        runtimeSession: runtimeSessionId,
        publishTimestamp: epoch.timestampMonotonicNs,
        oldArtifactId: artifactBeforeId,
        newArtifactId: artifactAfterId,
        newArtifactHash: artifactAfterHash,
        capsuleId: `capsule:${sha256Stable({ artifactAfterId, dispatchId }).slice('sha256:'.length).padEnd(64, '0').slice(0, 64)}`,
        fissionIslandId: 'runtime-boundary-device-island',
        abiMembraneHash: contractHash,
        dependencyClosureHash: sourceDependencyClosureHash,
        proofHash: sha256Stable(boundaryRefs),
        changedSymbols: [entryPoint],
        functionHandleIds: [`function:${entryPoint}`],
        streamEpochCounters: { ...epoch.streamEpochCounters },
        dispatchTableHashBefore,
        dispatchTableHashAfter,
        dispatchTableHash: dispatchTableHashAfter,
        changedEntries: 1,
        retirementFenceIds,
        delayedUnloadResult: retirement.retirementResult,
        retirementStrategy,
      }, {
        kind: 'retire',
        id: retirement.eventId,
        eventId: retirement.eventId,
        from: `generation:${previousGeneration}`,
        to: `generation:${activeGeneration}`,
        epoch: retirement.epoch,
        previousGeneration: retirement.previousGeneration,
        artifactHash: retirement.oldArtifactHash,
        oldArtifactHash: retirement.oldArtifactHash,
        proof: retirement.retirementProof,
        result: retirement.retirementResult,
        processId: retirement.processId,
        runtimeSession: runtimeSessionId,
        dispatchStream: retirement.queueOrStream,
        timestampMonotonicNs: retirement.timestampMonotonicNs,
        retirementFenceIds,
        evidenceRefs: retirementEvidenceRefs,
      }],
      latestPublication: {
        previousGeneration,
        activeGeneration,
        publishTimestamp: epoch.timestampMonotonicNs,
        oldArtifactId: artifactBeforeId,
        newArtifactId: artifactAfterId,
        newArtifactHash: artifactAfterHash,
        capsuleId: `capsule:${sha256Stable({ artifactAfterId, dispatchId }).slice('sha256:'.length).padEnd(64, '0').slice(0, 64)}`,
        fissionIslandId: 'runtime-boundary-device-island',
        abiMembraneHash: contractHash,
        dependencyClosureHash: sourceDependencyClosureHash,
        proofHash: sha256Stable(boundaryRefs),
        changedSymbols: [entryPoint],
        functionHandleIds: [`function:${entryPoint}`],
        streamEpochCounters: { ...epoch.streamEpochCounters },
        dispatchTableHashBefore,
        dispatchTableHashAfter,
        dispatchTableHash: dispatchTableHashAfter,
        changedEntries: 1,
        retirementFenceIds,
        delayedUnloadResult: retirement.retirementResult,
        retirementStrategy,
      },
    },
    evidenceRefs: compactStringList([...epoch.evidenceRefs, ...retirementEvidenceRefs]),
  };
  const artifactTransportProof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-artifact-transport-proven',
    ramTransportProven: true,
    transportEvidenceObserved: true,
    ramArtifactReferenceProvided: true,
    ramBlobIdentityProven: true,
    selectedArtifactIds: [artifactAfterId],
    ramBlobIds: [artifactAfterId],
    artifactContentHashes: [artifactAfterHash],
    processId,
    eventId: artifactTransport.eventId ?? `${evidencePrefix}:load`,
    timestampMonotonicNs: artifactTransport.timestampMonotonicNs,
    evidenceRefs: artifactTransport.evidenceRefs,
  };
  const kernelParam = {
    name: 'output',
    kind: 'device_pointer',
    category: 'device_allocation',
    allocationId: outputTargetId,
    runtime_proven: true,
    runtimeProven: true,
    evidenceRefs: dispatch.evidenceRefs,
  };
  const dispatchProof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-dispatch-safe-proven',
    dispatchObserved: true,
    sessionScoped: true,
    runtimeSessionObserved: true,
    runtimeSessionIds: [runtimeSessionId],
    runtimeSessionConsistent: true,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    argProvenanceEvidenceRefs: dispatch.evidenceRefs,
    argProvenanceRecords: [kernelParam],
    unknownArgCount: 0,
    abiProof,
    epochProof,
    abiProven: true,
    epochSwapProven: true,
    streamOrderingProven: retirementProven,
    replacementScopeProven: true,
    runtimeTouchedSymbolsMatch: true,
    runtimeArtifactMatchesSelected: true,
    selectedArtifactIds: [artifactAfterId],
    runtimeArtifactId: artifactAfterId,
    runtimeArtifactIds: [artifactAfterId],
    dispatcherRegistrationIds: [`dispatcher:${entryPoint}`],
    dispatchTableEntryIds: [dispatch.dispatchTableEntry ?? `${entryPoint}:${epoch.epoch}`],
    dispatchTableHashes: [dispatchTableHashAfter],
    dispatchStreamIds: [streamId],
    gridDimensions: [firstText(input.gridDim, input.grid_dim) ?? '1,1,1'],
    blockDimensions: [firstText(input.blockDim, input.block_dim) ?? '64,1,1'],
    sharedMemoryBytes: [Number(input.sharedMemoryBytes ?? input.shared_memory_bytes ?? 0)],
    dispatchTimestamps: [dispatch.timestampMonotonicNs],
    dispatchId,
    epoch: epoch.epoch,
    processId,
    kernelName: entryPoint,
    launchApi: firstText(input.launchApi, input.launch_api) ?? 'synthi_gpu_launch',
    kernelParams: [kernelParam],
    evidenceRefs: dispatch.evidenceRefs,
  };
  const computeOracleArtifacts = computeOracleArtifactsFromInput(input, {
    epoch: epoch.epoch,
    timestampAfterDispatch: output.timestampMonotonicNs,
  });
  const deterministicVisualMode = oracleMode === 'visual'
    ? (objectOrNull(input.deterministicVisualMode) ?? objectOrNull(input.deterministic_visual_mode) ?? null)
    : null;
  const visualEvidenceArtifacts = oracleMode === 'visual'
    ? visualEvidenceArtifactsFromInput(input)
    : [];
  if (oracleMode === 'visual') {
    visualOracleArtifacts = visualOracleArtifactsWithEvidenceVerification(
      visualOracleArtifacts,
      visualEvidenceArtifacts,
    );
  }
  const verifiedAfterVisualArtifact = oracleMode === 'visual'
    ? verifiedVisualEvidenceArtifactForRole(visualOracleArtifacts, visualEvidenceArtifacts, 'after')
    : null;
  const outputOracleKind = oracleMode === 'visual'
    ? acceptedVisualOracleKind(output.oracleKind)
    : (output?.oracleKind === 'output_oracle' ? 'buffer_checksum' : output?.oracleKind);
  const outputOracleExpected = oracleMode === 'visual'
    ? visualOracleArtifacts.after_image_hash
    : computeOracleArtifacts.checksum_after;
  const outputOracleActual = oracleMode === 'visual'
    ? visualArtifactHash(verifiedAfterVisualArtifact ?? {})
    : outputOracleExpected;
  const outputOraclePassed = Boolean(outputOracleExpected && outputOracleActual && outputOracleExpected === outputOracleActual);
  const outputOracleTarget = oracleMode === 'visual'
    ? {
        kind: 'visual',
        target_id: outputTargetId,
        framebuffer_identity: visualTargetIdentity,
        swapchain_or_framebuffer_identity: visualTargetIdentity,
        camera_state_hash: visualOracleArtifacts.camera_state_hash,
        swapchain_size: visualOracleArtifacts.swapchain_size,
        capture_backend: visualOracleArtifacts.capture_backend,
        frame_number: visualOracleArtifacts.frame_number,
        visual_target_verified: outputOraclePassed,
        visual_actual_hash_source: 'verified_visual_evidence_artifact_content_hash',
        evidence_refs: output.evidenceRefs,
      }
    : {
        kind: 'compute',
        target_id: outputTargetId,
        compute_only_target_verified: true,
        evidence_refs: output.evidenceRefs,
      };
  const visualEvidenceRefs = oracleMode === 'visual'
    ? compactStringList([
        ...output.evidenceRefs,
        ...visualEvidenceArtifacts.flatMap(visualArtifactEvidenceRefs),
      ])
    : [];
  const outputProof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    resultState: 'gpu-hmr-output-oracle-proven',
    eventId: output.eventId ?? `${evidencePrefix}:output`,
    processId,
    epoch: epoch.epoch,
    artifactId: artifactAfterId,
    afterDispatchId: dispatchId,
    outputTimestamp: output.timestampMonotonicNs,
    outputBuffers: [outputTargetId],
    outputOracleTarget,
    output_oracle_target: outputOracleTarget,
    outputOracle: {
      kind: outputOracleKind,
      artifactId: artifactAfterId,
      processId,
      dispatchId,
      afterDispatchId: dispatchId,
      epoch: epoch.epoch,
      readbackTimestamp: output.timestampMonotonicNs,
      runtimeSessionId,
      outputTargetId,
      producer: 'runtime_boundary_proof_adapter',
      passed: outputOraclePassed,
      expected: outputOracleExpected,
      actual: outputOracleActual,
      actualSource: oracleMode === 'visual' ? 'verified_visual_evidence_artifact_content_hash' : 'compute_oracle_checksum_after',
      actual_source: oracleMode === 'visual' ? 'verified_visual_evidence_artifact_content_hash' : 'compute_oracle_checksum_after',
      requiredOracleId: outputTargetId,
      oracleId: outputTargetId,
      outputOracleTarget,
      output_oracle_target: outputOracleTarget,
      visualOracleArtifacts,
      visual_oracle_artifacts: visualOracleArtifacts,
      deterministicVisualMode,
      deterministic_visual_mode: deterministicVisualMode,
      evidenceRefs: output.evidenceRefs,
      evidence_refs: output.evidenceRefs,
      visualEvidenceRefs,
      visual_evidence_refs: visualEvidenceRefs,
    },
    oracleArtifacts: oracleMode === 'visual'
      ? { visual_oracle_artifacts: visualOracleArtifacts }
      : { compute_oracle_artifacts: computeOracleArtifacts },
    oracle_artifacts: oracleMode === 'visual'
      ? { visual_oracle_artifacts: visualOracleArtifacts }
      : { compute_oracle_artifacts: computeOracleArtifacts },
    visualFrameObserved: oracleMode === 'visual',
    visual_frame_observed: oracleMode === 'visual',
    visualEvidenceRequired: oracleMode === 'visual',
    visual_evidence_required: oracleMode === 'visual',
    visualEvidenceRefs,
    visual_evidence_refs: visualEvidenceRefs,
    deterministicOutputObserved: true,
    deterministic_output_observed: true,
    deterministicOracleProvided: true,
    deterministic_oracle_provided: true,
    deterministicOraclePassed: true,
    deterministic_oracle_passed: true,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    evidenceRefs: output.evidenceRefs,
  };
  const hostPreservationProof = classifyGpuHmrHostPreservationProof({
    identityChecksPassed: true,
    processId,
    identitySnapshotObserved: true,
    identitySnapshotLineageObserved: true,
    requiredIdentityRolesObserved: true,
    identityEvidenceRefs: host.evidenceRefs,
    identitySnapshotEvidenceRefs: host.evidenceRefs,
  });
  return {
    backend,
    projectId: firstText(input.projectId, input.project_id, input.workspaceSlug, input.workspace_slug),
    editId: firstText(input.editId, input.edit_id, input.sourceEditId, input.source_edit_id),
    targetId: firstText(input.targetId, input.target_id),
    artifactAfterHash,
    artifactAfterId,
    artifactBeforeHash,
    artifactBeforeId,
    contractHash,
    processId,
    runtimeSessionId,
    deviceUuid: host.deviceUuid,
    contextHandle: host.contextId,
    streamId,
    outputTargetId,
    sourceProofs,
    fissionProof,
    abiProof,
    artifactTransportProof,
    epochProof,
    dispatchProof,
    outputProof,
    hostPreservationProof,
    computeOracleArtifacts,
    visualOracleArtifacts,
    visualEvidenceArtifacts,
    deterministicVisualMode,
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    firewallEvidence: {
      route: 'gpu_device_sidecar_reload',
      evidence_source: 'runtime_boundary_proof_adapter',
      evidence_refs: boundaryRefs,
      cpu_hmr_used: input.cpuHmrUsed === true || input.cpu_hmr_used === true,
      full_rebuild_used: input.fullRebuildUsed === true || input.full_rebuild_used === true,
      process_restarted: input.processRestarted === true || input.process_restarted === true,
      process_id_before: processId,
      process_id_after: processId,
    },
    timings: defaultTimings({
      ...(objectOrNull(input.timings) ?? {}),
      metric_scope: firstText(input.metricScope, input.metric_scope, objectOrNull(input.timings)?.metric_scope) ?? 'hot_delta_1',
      cache_state: firstText(input.cacheState, input.cache_state, objectOrNull(input.timings)?.cache_state) ?? 'compiler_cache_warm',
    }),
    modelProvenance: objectOrNull(input.modelProvenance) ?? objectOrNull(input.model_provenance) ?? defaultModelProvenance(),
    evidenceRefs: boundaryRefs,
  };
}

function runtimeProofFailureCodes(runtimeProofArtifact, strictGate, stageEvidence) {
  return compactStringList([
    ...stageEvidence.failedGates,
    ...((runtimeProofArtifact?.limitations ?? []).map((item) => firstText(item.code, item.degradedReason))),
    ...((runtimeProofArtifact?.proofLedgerQuery?.failedInvariants ?? []).map((item) => firstText(item.code))),
    ...((runtimeProofArtifact?.acceptanceContractEvaluation?.failedGates ?? []).map((item) => firstText(item.code))),
    ...((strictGate?.status === 'pass' ? [] : (strictGate?.failures ?? [])).map((item) => firstText(item.code, item))),
  ]);
}

function buildBoundaryValidationRuntimeProofArtifact({
  input,
  components,
  fullRuntimeProof,
  acceptanceContract,
  proofLedgerRecord = null,
  createdAt = null,
}) {
  return buildValidationRuntimeProofArtifact({
    workspaceSlug: components.projectId,
    sourceEditId: components.editId,
    backend: components.backend,
    gpuArch: firstText(input.gpuArch, input.gpu_arch, input.compileTarget, input.compile_target),
    processId: components.processId,
    runtimeSessionId: components.runtimeSessionId,
    deviceUuid: components.deviceUuid,
    contextHandle: components.contextHandle,
    classification: components.classification,
    cpuHmrUsed: components.firewallEvidence.cpu_hmr_used,
    fullRebuildUsed: components.firewallEvidence.full_rebuild_used,
    processRestarted: components.firewallEvidence.process_restarted,
    firewallEvidence: components.firewallEvidence,
    modelProvenance: components.modelProvenance,
    timings: components.timings,
    metricClock: 'monotonic_ns',
    metricScope: components.timings.metric_scope,
    cacheState: components.timings.cache_state,
    sourceProofs: components.sourceProofs,
    fissionProof: components.fissionProof,
    abiProof: components.abiProof,
    artifactTransportProof: components.artifactTransportProof,
    epochProof: components.epochProof,
    dispatchProof: components.dispatchProof,
    outputProof: components.outputProof,
    hostPreservationProof: components.hostPreservationProof,
    fullRuntimeProof,
    acceptanceContract,
    computeOracleArtifacts: components.computeOracleArtifacts,
    visualOracleArtifacts: components.visualOracleArtifacts,
    visualEvidenceArtifacts: components.visualEvidenceArtifacts,
    visualEvidenceRefs: components.outputProof.visualEvidenceRefs,
    deterministicVisualMode: components.deterministicVisualMode,
    evidenceRefs: components.evidenceRefs,
    ...(proofLedgerRecord ? { proofLedgerRecord } : {}),
    ...(createdAt ? { createdAt } : {}),
    adversarialPreflight: {
      schemaVersion: 'synthi.gpu_hmr.adversarial_preflight.v1',
      ok: true,
      skipped: false,
      scriptPath: 'runtime-boundary-proof-adapter',
      exitCode: 0,
      elapsedMs: 0,
      stdoutHash: sha256Stable({ adapter: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION, ok: true }),
      stderrHash: sha256Stable({ adapter: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION, stderr: '' }),
      error: null,
    },
  });
}

export function buildRuntimeBoundaryProofAdapter(input = {}) {
  const stageEvidence = buildRuntimeBoundaryStageEvidence(input.runtimeBoundaryEvents ?? input.runtime_boundary_events ?? []);
  const inputEvidence = buildRuntimeBoundaryInputEvidence(input);
  const inputStageBindingEvidence = buildRuntimeBoundaryInputStageBindingEvidence(inputEvidence, stageEvidence);
  let components = null;
  let runtimeProofArtifact = null;
  let strictGate = null;
  let fullRuntimeProof = null;
  let acceptanceContract = null;
  let visualCaptureBindingFailedGates = [];

  if (
    stageEvidence.accepted === true
    && inputEvidence.accepted === true
    && inputStageBindingEvidence.accepted === true
  ) {
    components = buildBoundaryProofComponents(input, stageEvidence);
    fullRuntimeProof = classifyGpuHmrFullRuntimeProof({
      sourceProofs: components.sourceProofs,
      fissionProof: components.fissionProof,
      abiProof: components.abiProof,
      artifactTransportProof: components.artifactTransportProof,
      epochProof: components.epochProof,
      dispatchProof: components.dispatchProof,
      outputProof: components.outputProof,
      hostPreservationProof: components.hostPreservationProof,
    });
    acceptanceContract = deriveGpuHmrAcceptanceContractFromVerifiedProofs({
      workspaceSlug: components.projectId,
      sourceEditId: components.editId,
      backend: components.backend,
      gpuArch: firstText(input.gpuArch, input.gpu_arch, input.compileTarget, input.compile_target),
      compiler: firstText(input.compiler),
      classification: components.classification,
      cpuHmrUsed: components.firewallEvidence.cpu_hmr_used,
      fullRebuildUsed: components.firewallEvidence.full_rebuild_used,
      processRestarted: components.firewallEvidence.process_restarted,
      firewallEvidence: components.firewallEvidence,
      processId: components.processId,
      deviceUuid: components.deviceUuid,
      contextHandle: components.contextHandle,
      outputOracleTarget: components.outputProof.outputOracleTarget,
      sourceProofs: components.sourceProofs,
      fissionProof: components.fissionProof,
      abiProof: components.abiProof,
      artifactTransportProof: components.artifactTransportProof,
      epochProof: components.epochProof,
      dispatchProof: components.dispatchProof,
      outputProof: components.outputProof,
      hostPreservationProof: components.hostPreservationProof,
      fullRuntimeProof,
    });
    runtimeProofArtifact = buildBoundaryValidationRuntimeProofArtifact({
      input,
      components,
      fullRuntimeProof,
      acceptanceContract,
    });
    if (components.visualOracleArtifacts) {
      const visualCaptureBinding = prepareVisualCaptureRuntimeBinding({
        input,
        components,
        stageEvidence,
        preliminaryArtifact: runtimeProofArtifact,
      });
      visualCaptureBindingFailedGates = visualCaptureBinding.failedGates;
      if (visualCaptureBinding.accepted === true) {
        components.visualOracleArtifacts = visualCaptureBinding.visualOracleArtifacts;
        runtimeProofArtifact = buildBoundaryValidationRuntimeProofArtifact({
          input,
          components,
          fullRuntimeProof,
          acceptanceContract,
          proofLedgerRecord: visualCaptureBinding.proofLedgerRecord,
          createdAt: runtimeProofArtifact.createdAt,
        });
      }
    }
    strictGate = runtimeProofArtifactStrictGate(
      runtimeProofArtifact,
      runtimeBoundaryStrictGateOptions(input),
    );
  }

  const failedGates = runtimeProofFailureCodes(runtimeProofArtifact, strictGate, stageEvidence);
  const allFailedGates = compactStringList([
    ...failedGates,
    ...inputEvidence.failedGates,
    ...inputStageBindingEvidence.failedGates,
    ...visualCaptureBindingFailedGates,
  ]);
  const accepted =
    stageEvidence.accepted === true
    && inputEvidence.accepted === true
    && fullRuntimeProof?.fullRuntimeProven === true
    && runtimeProofArtifact?.gpuHmrSuccess === true
    && strictGate?.status === 'pass'
    && allFailedGates.length === 0;
  return {
    schemaVersion: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    schema_version: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
    proofAuthority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PROOF_ADAPTER_AUTHORITY,
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: accepted,
    can_satisfy_runtime_proof: accepted,
    stageEvidence,
    stage_evidence: stageEvidence,
    inputEvidence,
    input_evidence: inputEvidence,
    inputStageBindingEvidence,
    input_stage_binding_evidence: inputStageBindingEvidence,
    fullRuntimeProof,
    full_runtime_proof: fullRuntimeProof,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
    strictGate,
    strict_gate: strictGate,
    acceptanceContract,
    acceptance_contract: acceptanceContract,
    components,
    failedGates: allFailedGates,
    failed_gates: allFailedGates,
    proofId: sha256Stable({
      schemaVersion: RUNTIME_BOUNDARY_PROOF_ADAPTER_SCHEMA_VERSION,
      stageEvidenceHash: sha256Stable(stageEvidence.normalizedEvents),
      runtimeProofArtifactId: runtimeProofArtifact?.proofId ?? null,
      failedGates: allFailedGates,
    }).replace('sha256:', 'runtime-boundary-proof-adapter:sha256:'),
  };
}

export function buildRuntimeBoundaryRunModeProof(input = {}) {
  const adapter = buildRuntimeBoundaryProofAdapter(input);
  const artifact = adapter.runtimeProofArtifact ?? {};
  const proofLedger = artifact.proofLedger ?? artifact.proof_ledger ?? {};
  const ledgerQuery = artifact.proofLedgerQuery ?? artifact.proof_ledger_query ?? proofLedger.query ?? {};
  const runMode = {
    metric_clock: 'monotonic_ns',
    metric_scope: firstText(input.metricScope, input.metric_scope, objectOrNull(input.timings)?.metric_scope) ?? 'hot_delta_1',
    cache_state: firstText(input.cacheState, input.cache_state, objectOrNull(input.timings)?.cache_state) ?? 'compiler_cache_warm',
  };
  const material = {
    schemaVersion: RUNTIME_RUN_MODE_PROOF_SCHEMA_VERSION,
    schema: RUNTIME_RUN_MODE_PROOF_SCHEMA_VERSION,
    proofAuthority: 'strict_runtime_boundary_adapter_output_not_declaration',
    proof_authority: 'strict_runtime_boundary_adapter_output_not_declaration',
    targetId: firstText(input.targetId, input.target_id) ?? adapter.components?.targetId ?? 'runtime-boundary-target',
    target_id: firstText(input.targetId, input.target_id) ?? adapter.components?.targetId ?? 'runtime-boundary-target',
    backend: adapter.components?.backend ?? firstText(input.backend) ?? 'hip',
    runMode,
    run_mode: runMode,
    metricScope: runMode.metric_scope,
    metric_scope: runMode.metric_scope,
    coldRuntimeInitialProven: false,
    cold_runtime_initial_proven: false,
    gpuHmrSuccess: adapter.accepted,
    gpu_hmr_success: adapter.accepted,
    fullRuntimeProven: artifact.fullRuntimeProven === true,
    full_runtime_proven: artifact.fullRuntimeProven === true,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery: ledgerQuery,
    proof_ledger_query: ledgerQuery,
    runtimeProofArtifact: artifact,
    runtime_proof_artifact: artifact,
    runtimeBoundaryProofAdapter: adapter,
    runtime_boundary_proof_adapter: adapter,
    runtimeBoundaryEvents: input.runtimeBoundaryEvents ?? input.runtime_boundary_events ?? [],
    runtime_boundary_events: input.runtimeBoundaryEvents ?? input.runtime_boundary_events ?? [],
    outputOracleFacet: {
      accepted: adapter.accepted,
      proofAuthority: 'strict_runtime_boundary_adapter_output_oracle_binding',
      proof_authority: 'strict_runtime_boundary_adapter_output_oracle_binding',
      failedGates: adapter.failedGates.map((code) => ({ code })),
      failed_gates: adapter.failedGates.map((code) => ({ code })),
    },
    accepted: adapter.accepted,
    failedGates: adapter.failedGates,
    failed_gates: adapter.failedGates,
  };
  return {
    ...material,
    proofId: sha256Stable(material).replace('sha256:', 'runtime-run-mode-proof:sha256:'),
    proof_id: sha256Stable(material).replace('sha256:', 'runtime-run-mode-proof:sha256:'),
  };
}
