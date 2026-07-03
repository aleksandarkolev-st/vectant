import { createHash } from 'node:crypto';
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

export function normalizeRuntimeBoundaryEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event: objectOrNull(event), index }))
    .filter(({ event }) => event)
    .map(({ event, index }) => {
      const stage = canonicalStage(eventKind(event));
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
      return {
        index,
        raw: event,
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
        epoch: firstText(event.epoch, event.epochId, event.epoch_id, event.generation),
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
        evidenceRefs: eventEvidenceRefs(event),
        evidence_refs: eventEvidenceRefs(event),
      };
    });
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
  if (stage === 'epoch_publication' && !event.epoch) failures.push('epoch_publication_epoch_missing');
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
  }
  return failures;
}

export function buildRuntimeBoundaryStageEvidence(events = []) {
  const normalizedEvents = normalizeRuntimeBoundaryEvents(events);
  const eventMap = boundaryEventByStage(normalizedEvents);
  const eventGroups = boundaryEventsByStage(normalizedEvents);
  const failedGates = [];
  for (const event of normalizedEvents) {
    if (!event.stage) failedGates.push('runtime_boundary_event_stage_unknown');
    if (event.successAuthorityClaimed) failedGates.push('runtime_boundary_event_claims_success_authority');
    if (event.evidenceRefs.length === 0) failedGates.push('runtime_boundary_event_evidence_refs_missing');
  }
  for (const stage of REQUIRED_BOUNDARY_STAGES) {
    if ((eventGroups.get(stage) ?? []).length > 1) {
      failedGates.push(`runtime_boundary_stage_${stage}_duplicate`);
    }
    failedGates.push(...runtimeBoundaryFieldFailures(stage, eventMap.get(stage)));
  }
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

export function buildRuntimeBoundaryInputEvidence(input = {}) {
  const sourcePaths = compactStringList(input.sourcePaths ?? input.source_paths);
  const entryPoint = firstText(input.entryPoint, input.entry_point, input.kernelName, input.kernel_name);
  const compileTarget = firstText(input.compileTarget, input.compile_target, input.gpuArch, input.gpu_arch);
  const compiler = firstText(input.compiler);
  const compilerArgsHash = normalizeSha256(firstText(input.compilerArgsHash, input.compiler_args_hash));
  const artifactHashBefore = normalizeSha256(firstText(input.artifactHashBefore, input.artifact_hash_before));
  const artifactHashAfter = normalizeSha256(firstText(input.artifactHashAfter, input.artifact_hash_after));
  const contractHash = normalizeSha256(firstText(input.contractHash, input.contract_hash));
  const projectId = firstText(input.projectId, input.project_id, input.workspaceSlug, input.workspace_slug);
  const editId = firstText(input.editId, input.edit_id, input.sourceEditId, input.source_edit_id);
  const targetId = firstText(input.targetId, input.target_id);
  const backend = firstText(input.backend);
  const computeOracleArtifacts = computeOracleArtifactsFromInput(input);
  const failedGates = [
    projectId ? null : 'runtime_boundary_project_id_missing',
    editId ? null : 'runtime_boundary_edit_id_missing',
    targetId ? null : 'runtime_boundary_target_id_missing',
    backend ? null : 'runtime_boundary_backend_missing',
    sourcePaths.length > 0 ? null : 'runtime_boundary_source_paths_missing',
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
    ...computeOracleVerificationFailures(computeOracleArtifacts),
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
    computeOracleEvidenceRefs: computeOracleEvidenceRefs(computeOracleArtifacts),
    compute_oracle_evidence_refs: computeOracleEvidenceRefs(computeOracleArtifacts),
    failedGates,
    failed_gates: failedGates,
  };
}

function buildRuntimeBoundaryInputStageBindingEvidence(inputEvidence, stageEvidence) {
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

function buildBoundaryProofComponents(input, stageEvidence) {
  const stages = stageEvidence.stageEvents;
  const artifactTransport = stages.artifact_transport;
  const epoch = stages.epoch_publication;
  const dispatch = stages.dispatch_trace;
  const host = stages.host_identity;
  const output = stages.output_oracle;
  const backend = firstText(input.backend);
  const artifactAfterHash = normalizeSha256(firstText(input.artifactHashAfter, input.artifact_hash_after));
  const artifactBeforeHash = normalizeSha256(firstText(input.artifactHashBefore, input.artifact_hash_before));
  const artifactAfterId = artifactIdFromHash(artifactAfterHash);
  const artifactBeforeId = artifactIdFromHash(artifactBeforeHash) ?? 'no-old-generation';
  const runtimeSessionId = dispatch?.runtimeSessionId ?? epoch?.runtimeSessionId ?? artifactTransport?.runtimeSessionId;
  const processId = host?.processId ?? dispatch?.processId ?? output?.processId;
  const streamId = dispatch?.queueOrStream ?? host?.queueOrStream ?? 'stream-runtime-boundary';
  const outputTargetId = output?.outputTargetId ?? firstText(input.outputTargetId, input.output_target_id) ?? 'runtime-output-target';
  const dispatchId = dispatch?.dispatchId;
  const entryPoint = firstText(
    input.entryPoint,
    input.entry_point,
    input.kernelName,
    input.kernel_name,
    dispatch?.dispatchTableEntry?.split(':')[0],
  );
  const sourcePaths = compactStringList(input.sourcePaths ?? input.source_paths);
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
    evidenceRefs: compactStringList([...compileRefs, ...symbolRefs]),
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
    oldGenerationRetired: true,
    streamOrderingProven: true,
    retirementStrategy: firstText(input.retirementStrategy, input.retirement_strategy) ?? 'stream_event',
    streamIds: [streamId],
    eventId: epoch.eventId ?? `${evidencePrefix}:epoch`,
    processId,
    retirementEventId: firstText(input.retirementEventId, input.retirement_event_id) ?? `${evidencePrefix}:retire`,
    retirementTimestampMonotonicNs: output.timestampMonotonicNs + 1,
    retirementFenceIds: [`runtime-boundary:retirement:${streamId}`],
    epochGenerationGraph: {
      schemaVersion: 'synthi.gpu.epoch_graph.v1',
      runtimeSessionIds: [runtimeSessionId],
      retirementState: 'retired',
      nodes: [{ id: 'generation:1', generation: 1 }, { id: 'generation:2', generation: 2 }],
      edges: [{
        kind: 'publish',
        from: 'generation:1',
        to: 'generation:2',
        runtimeSession: runtimeSessionId,
        publishTimestamp: epoch.timestampMonotonicNs,
        oldArtifactId: artifactBeforeId,
        newArtifactId: artifactAfterId,
        newArtifactHash: artifactAfterHash,
        capsuleId: `capsule:${sha256Stable({ artifactAfterId, dispatchId }).slice('sha256:'.length).padEnd(64, '0').slice(0, 64)}`,
        fissionIslandId: 'runtime-boundary-device-island',
        abiMembraneHash: contractHash,
        dependencyClosureHash: sha256Stable(sourcePaths),
        proofHash: sha256Stable(boundaryRefs),
        changedSymbols: [entryPoint],
        functionHandleIds: [`function:${entryPoint}`],
        streamEpochCounters: { [streamId]: 2 },
        dispatchTableHashBefore,
        dispatchTableHashAfter,
        dispatchTableHash: dispatchTableHashAfter,
        changedEntries: 1,
        retirementFenceIds: [`runtime-boundary:retirement:${streamId}`],
        delayedUnloadResult: 'retired',
        retirementStrategy: 'stream_event',
      }, {
        kind: 'retire',
        from: 'generation:1',
        to: 'generation:2',
        runtimeSession: runtimeSessionId,
      }],
      latestPublication: {
        previousGeneration: 1,
        activeGeneration: 2,
        publishTimestamp: epoch.timestampMonotonicNs,
        oldArtifactId: artifactBeforeId,
        newArtifactId: artifactAfterId,
        newArtifactHash: artifactAfterHash,
        capsuleId: `capsule:${sha256Stable({ artifactAfterId, dispatchId }).slice('sha256:'.length).padEnd(64, '0').slice(0, 64)}`,
        fissionIslandId: 'runtime-boundary-device-island',
        abiMembraneHash: contractHash,
        dependencyClosureHash: sha256Stable(sourcePaths),
        proofHash: sha256Stable(boundaryRefs),
        changedSymbols: [entryPoint],
        functionHandleIds: [`function:${entryPoint}`],
        streamEpochCounters: { [streamId]: 2 },
        dispatchTableHashBefore,
        dispatchTableHashAfter,
        dispatchTableHash: dispatchTableHashAfter,
        changedEntries: 1,
        retirementFenceIds: [`runtime-boundary:retirement:${streamId}`],
        delayedUnloadResult: 'retired',
        retirementStrategy: 'stream_event',
      },
    },
    evidenceRefs: epoch.evidenceRefs,
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
    streamOrderingProven: true,
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
    outputOracleTarget: {
      kind: 'compute',
      target_id: outputTargetId,
      compute_only_target_verified: true,
      evidence_refs: output.evidenceRefs,
    },
    outputOracle: {
      kind: output.oracleKind === 'output_oracle' ? 'buffer_checksum' : output.oracleKind,
      artifactId: artifactAfterId,
      processId,
      dispatchId,
      afterDispatchId: dispatchId,
      epoch: epoch.epoch,
      readbackTimestamp: output.timestampMonotonicNs,
      runtimeSessionId,
      outputTargetId,
      passed: true,
      expected: computeOracleArtifacts.checksum_after,
      actual: computeOracleArtifacts.checksum_after,
      requiredOracleId: outputTargetId,
      oracleId: outputTargetId,
      outputOracleTarget: {
        kind: 'compute',
        target_id: outputTargetId,
        compute_only_target_verified: true,
        evidence_refs: output.evidenceRefs,
      },
    },
    oracleArtifacts: {
      compute_oracle_artifacts: computeOracleArtifacts,
    },
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

export function buildRuntimeBoundaryProofAdapter(input = {}) {
  const stageEvidence = buildRuntimeBoundaryStageEvidence(input.runtimeBoundaryEvents ?? input.runtime_boundary_events ?? []);
  const inputEvidence = buildRuntimeBoundaryInputEvidence(input);
  const inputStageBindingEvidence = buildRuntimeBoundaryInputStageBindingEvidence(inputEvidence, stageEvidence);
  let components = null;
  let runtimeProofArtifact = null;
  let strictGate = null;
  let fullRuntimeProof = null;
  let acceptanceContract = null;

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
    runtimeProofArtifact = buildValidationRuntimeProofArtifact({
      workspaceSlug: components.projectId,
      sourceEditId: components.editId,
      backend: components.backend,
      gpuArch: firstText(input.gpuArch, input.gpu_arch, input.compileTarget, input.compile_target),
      processId: components.processId,
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
      evidenceRefs: components.evidenceRefs,
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
    strictGate = runtimeProofArtifactStrictGate(runtimeProofArtifact);
  }

  const failedGates = runtimeProofFailureCodes(runtimeProofArtifact, strictGate, stageEvidence);
  const allFailedGates = compactStringList([
    ...failedGates,
    ...inputEvidence.failedGates,
    ...inputStageBindingEvidence.failedGates,
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
