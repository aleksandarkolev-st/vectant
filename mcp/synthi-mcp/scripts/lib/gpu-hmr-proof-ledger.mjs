import { createHash } from 'node:crypto';
import { evaluateGpuHmrDeterministicVisualMode } from './gpu-hmr-visual-evidence.mjs';

export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = 'synthi.gpu.hmr.proof_ledger.v1';

const GPU_PROJECT_KINDS = new Set(['gpu_project', 'mixed_project']);
const GPU_ARTIFACT_EDIT_KINDS = new Set(['gpu_artifact_edit']);

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

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBool(value) {
  return value === true;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(...entries) {
  for (const [object, key] of entries) {
    if (object && typeof object === 'object' && hasOwn(object, key)) {
      return { present: true, value: object[key] };
    }
  }
  return { present: false, value: undefined };
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter(Boolean))];
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function enumText(value) {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return text(value.value);
  }
  return null;
}

function hasOwnDeep(object, key) {
  return object && typeof object === 'object' && !Array.isArray(object) && hasOwn(object, key);
}

function valueRecorded(object, key) {
  if (!hasOwnDeep(object, key)) return false;
  const value = object[key];
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventId(event) {
  return firstText(event.id, event.event_id, event.dispatch_id, event.proof_id, event.proofId);
}

function eventEpoch(event) {
  return firstText(event.epoch, event.epoch_id, event.epochId, event.generation);
}

function eventArtifactHash(event) {
  return firstText(
    event.artifact_hash,
    event.artifactHash,
    event.artifact_id,
    event.artifactId,
    event.loaded_artifact_hash,
    event.loadedArtifactHash,
    event.loaded_artifact_id,
    event.loadedArtifactId,
    event.published_artifact_hash,
    event.publishedArtifactHash,
    event.published_artifact_id,
    event.publishedArtifactId,
    event.runtime_artifact_id,
    event.runtimeArtifactId,
    event.selected_artifact_id,
    event.selectedArtifactId,
    event.new_artifact_hash,
    event.newArtifactHash,
    event.hash,
  );
}

function eventProcessId(event) {
  return firstText(event.process_id, event.processId, event.pid);
}

function eventTimestamp(event) {
  return finiteNumber(
    event.timestamp_monotonic_ns
    ?? event.timestampMonotonicNs
    ?? event.timestamp_ms
    ?? event.timestampMs
    ?? event.ts
  );
}

function outputAfterDispatchId(outputEvent) {
  return firstText(
    outputEvent.after_dispatch_id,
    outputEvent.afterDispatchId,
    outputEvent.dispatch_id,
    outputEvent.dispatchId,
  );
}

function outputKind(outputEvent) {
  return String(firstText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? '')
    .trim()
    .toLowerCase();
}

function isVisualOutput(outputEvent) {
  const kind = outputKind(outputEvent);
  return kind.includes('visual')
    || kind.includes('render')
    || kind.includes('frame')
    || kind.includes('pixel')
    || asObject(outputEvent.visual_oracle_artifacts ?? outputEvent.visualOracleArtifacts).after_image;
}

const COMPUTE_ORACLE_ARTIFACT_FIELDS = [
  ['raw_readback_bin', 'rawReadbackBin'],
  ['readback_schema_json', 'readbackSchemaJson'],
  ['checksum_before', 'checksumBefore'],
  ['checksum_after', 'checksumAfter'],
  ['deterministic_slice', 'deterministicSlice'],
  ['oracle_code_hash', 'oracleCodeHash'],
  ['rendered_card_png', 'renderedCardPng'],
  ['producer', 'producer'],
  ['timestamp_after_dispatch', 'timestampAfterDispatch'],
  ['epoch', 'epoch'],
];

const VISUAL_ORACLE_ARTIFACT_FIELDS = [
  ['before_image', 'beforeImage'],
  ['after_image', 'afterImage'],
  ['diff_image', 'diffImage'],
  ['blank_frame_rejection', 'blankFrameRejection'],
  ['same_frame_rejection', 'sameFrameRejection'],
  ['new_epoch_watermark_or_trace', 'newEpochWatermarkOrTrace', 'epoch_trace', 'epochTrace'],
  ['camera_state_hash', 'cameraStateHash'],
  ['swapchain_size', 'swapchainSize'],
  ['capture_backend', 'captureBackend'],
  ['frame_number', 'frameNumber'],
  ['timestamp_after_dispatch', 'timestampAfterDispatch'],
  ['perceptual_diff', 'perceptualDiff'],
  ['changed_pixel_ratio', 'changedPixelRatio'],
  ['visible_pixel_count', 'visiblePixelCount'],
];

function nonEmptyObject(value) {
  const object = asObject(value);
  return Object.keys(object).length > 0 ? object : null;
}

function objectFieldValue(object, keys) {
  const source = asObject(object);
  for (const key of keys) {
    if (hasOwnDeep(source, key)) return source[key];
  }
  return undefined;
}

function artifactValueRecorded(object, key) {
  if (!hasOwnDeep(object, key)) return false;
  const value = object[key];
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function artifactHasAnyField(object, fields) {
  const source = asObject(object);
  return fields.some((keys) => keys.some((key) => artifactValueRecorded(source, key)));
}

function firstArtifactObject(candidates, fields) {
  for (const candidate of candidates) {
    const object = nonEmptyObject(candidate);
    if (object && artifactHasAnyField(object, fields)) return object;
  }
  return null;
}

function outputOracleObject(outputEvent) {
  return asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
}

function oracleArtifactsObject(recordOracleArtifacts, outputEvent) {
  const ledgerArtifacts = asObject(recordOracleArtifacts);
  const outputArtifacts = asObject(outputEvent.oracle_artifacts ?? outputEvent.oracleArtifacts);
  const outputOracle = outputOracleObject(outputEvent);
  const outputOracleArtifacts = asObject(outputOracle.oracle_artifacts ?? outputOracle.oracleArtifacts);
  return {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  };
}

function computeOracleArtifacts(recordOracleArtifacts, outputEvent) {
  const {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  } = oracleArtifactsObject(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.compute_oracle_artifacts,
    ledgerArtifacts.computeOracleArtifacts,
    outputArtifacts.compute_oracle_artifacts,
    outputArtifacts.computeOracleArtifacts,
    outputEvent.compute_oracle_artifacts,
    outputEvent.computeOracleArtifacts,
    outputOracle.compute_oracle_artifacts,
    outputOracle.computeOracleArtifacts,
    outputOracleArtifacts.compute_oracle_artifacts,
    outputOracleArtifacts.computeOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], COMPUTE_ORACLE_ARTIFACT_FIELDS);
}

function visualOracleArtifacts(recordOracleArtifacts, outputEvent) {
  const {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  } = oracleArtifactsObject(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.visual_oracle_artifacts,
    ledgerArtifacts.visualOracleArtifacts,
    outputArtifacts.visual_oracle_artifacts,
    outputArtifacts.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts.visual_oracle_artifacts,
    outputOracleArtifacts.visualOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], VISUAL_ORACLE_ARTIFACT_FIELDS);
}

function missingArtifactFields(artifact, fields) {
  const source = asObject(artifact);
  return fields
    .filter((keys) => !keys.some((key) => artifactValueRecorded(source, key)))
    .map((keys) => keys[0]);
}

function artifactFieldText(artifact, ...keys) {
  return firstText(...keys.map((key) => asObject(artifact)[key]));
}

function modelProvenanceRecords(modelProvenance) {
  const provenance = asObject(modelProvenance);
  if (Object.keys(provenance).length === 0) return [];
  const nested = [
    provenance.split,
    provenance.gpu_split,
    provenance.gpuSplit,
    provenance.last_gpu_delta,
    provenance.lastGpuDelta,
    provenance.gpu_delta,
    provenance.gpuDelta,
    provenance.delta,
  ].map(asObject).filter((record) => Object.keys(record).length > 0);
  const directHasProviderFields = [
    'requested_model',
    'requestedModel',
    'provider_model_status',
    'providerModelStatus',
    'actual_model',
    'actualModel',
    'request_mode',
    'requestMode',
  ].some((key) => hasOwnDeep(provenance, key));
  return directHasProviderFields ? [provenance, ...nested] : nested;
}

function modelField(record, snakeKey, camelKey) {
  return record[snakeKey] ?? record[camelKey];
}

function modelFieldRecorded(record, snakeKey, camelKey) {
  return valueRecorded(record, snakeKey) || valueRecorded(record, camelKey);
}

function modelFieldText(record, snakeKey, camelKey) {
  return firstText(modelField(record, snakeKey, camelKey));
}

function modelStatus(record) {
  return enumText(modelField(record, 'provider_model_status', 'providerModelStatus'));
}

function prefixedModelStatus(record, prefix) {
  const pascal = `${prefix[0].toUpperCase()}${prefix.slice(1)}`;
  return enumText(modelField(
    record,
    `${prefix}_provider_model_status`,
    `${prefix}ProviderModelStatus`,
  ) ?? modelField(
    record,
    `${prefix}_model_provider_status`,
    `${pascal}ModelProviderStatus`,
  ));
}

function modelStatusAccepted(status) {
  return ['available', 'deprecated', 'private_alias'].includes(status ?? '');
}

function modelHardInfraFailure(record) {
  return modelField(record, 'hard_infra_failure', 'hardInfraFailure') === true;
}

function modelFallbackUsed(record) {
  return modelField(record, 'fallback_used', 'fallbackUsed') === true;
}

function modelShutdownOrDeprecationDetected(record) {
  return modelField(
    record,
    'provider_shutdown_or_deprecation_detected',
    'providerShutdownOrDeprecationDetected',
  ) === true;
}

export function normalizeGpuHmrProofLedgerRecord(input = {}) {
  const record = asObject(input);
  const artifactAfterHash = firstText(
    record.artifact_after_hash,
    record.artifactAfterHash,
    record.changed_gpu_artifact_hash,
    record.changedGpuArtifactHash,
  );
  const artifactBeforeHash = firstText(record.artifact_before_hash, record.artifactBeforeHash);
  const loaderEvent = asObject(record.loader_event ?? record.loaderEvent);
  const epochPublishEvent = asObject(record.epoch_publish_event ?? record.epochPublishEvent);
  const dispatchEvent = asObject(record.dispatch_event ?? record.dispatchEvent);
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const retirementEvent = asObject(record.retirement_event ?? record.retirementEvent);
  const processIdentity = asObject(record.process_identity ?? record.processIdentity);
  const deviceIdentity = asObject(record.device_identity ?? record.deviceIdentity);
  const firewallEvidence = asObject(record.firewall_evidence ?? record.firewallEvidence);
  const cpuHmrUsed = firstPresent(
    [record, 'cpu_hmr_used'],
    [record, 'cpuHmrUsed'],
    [firewallEvidence, 'cpu_hmr_used'],
    [firewallEvidence, 'cpuHmrUsed'],
  );
  const fullRebuildUsed = firstPresent(
    [record, 'full_rebuild_used'],
    [record, 'fullRebuildUsed'],
    [firewallEvidence, 'full_rebuild_used'],
    [firewallEvidence, 'fullRebuildUsed'],
  );
  const processRestarted = firstPresent(
    [record, 'process_restarted'],
    [record, 'processRestarted'],
    [firewallEvidence, 'process_restarted'],
    [firewallEvidence, 'processRestarted'],
  );
  const normalized = {
    schemaVersion: record.schemaVersion ?? record.schema_version ?? GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: firstText(record.proof_id, record.proofId),
    projectId: firstText(record.project_id, record.projectId),
    editId: firstText(record.edit_id, record.editId),
    classification: asObject(record.classification),
    contractHash: firstText(record.contract_hash, record.contractHash),
    artifactBeforeHash,
    artifactAfterHash,
    loaderEvent,
    epochPublishEvent,
    dispatchEvent,
    outputEvent,
    retirementEvent,
    processIdentity,
    deviceIdentity,
    firewallEvidence,
    cpuHmrUsed: asBool(cpuHmrUsed.value),
    cpuHmrUsedEvidencePresent: cpuHmrUsed.present,
    fullRebuildUsed: asBool(fullRebuildUsed.value),
    fullRebuildUsedEvidencePresent: fullRebuildUsed.present,
    processRestarted: asBool(processRestarted.value),
    processRestartedEvidencePresent: processRestarted.present,
    oracleArtifacts: asObject(
      record.oracle_artifacts
      ?? record.oracleArtifacts
      ?? outputEvent.oracle_artifacts
      ?? outputEvent.oracleArtifacts,
    ),
    deterministicVisualMode: asObject(
      record.deterministic_visual_mode
      ?? record.deterministicVisualMode
      ?? outputEvent.deterministic_visual_mode
      ?? outputEvent.deterministicVisualMode,
    ),
    timings: asObject(record.timings),
    modelProvenance: asObject(record.model_provenance ?? record.modelProvenance),
    evidenceRefs: compactStringList(record.evidence_refs ?? record.evidenceRefs),
  };
  normalized.proofId ??= `gpu-ledger-proof:sha256:${sha256Hex(stableJson({
    projectId: normalized.projectId,
    editId: normalized.editId,
    contractHash: normalized.contractHash,
    artifactBeforeHash: normalized.artifactBeforeHash,
    artifactAfterHash: normalized.artifactAfterHash,
    loaderEvent: normalized.loaderEvent,
    epochPublishEvent: normalized.epochPublishEvent,
    dispatchEvent: normalized.dispatchEvent,
    outputEvent: normalized.outputEvent,
    cpuHmrUsed: normalized.cpuHmrUsed,
    fullRebuildUsed: normalized.fullRebuildUsed,
    processRestarted: normalized.processRestarted,
    firewallEvidence: {
      cpuHmrUsedEvidencePresent: normalized.cpuHmrUsedEvidencePresent,
      fullRebuildUsedEvidencePresent: normalized.fullRebuildUsedEvidencePresent,
      processRestartedEvidencePresent: normalized.processRestartedEvidencePresent,
    },
  }))}`;
  return normalized;
}

function addFailure(failures, code, detail = {}) {
  failures.push({ code, ...detail });
}

export function evaluateGpuHmrProofLedger(input = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const failures = [];
  const warnings = [];
  const artifactAfterHash = record.artifactAfterHash;
  const loadedArtifactHash = eventArtifactHash(record.loaderEvent);
  const publishedArtifactHash = eventArtifactHash(record.epochPublishEvent);
  const publishedEpoch = eventEpoch(record.epochPublishEvent);
  const dispatchEpoch = eventEpoch(record.dispatchEvent);
  const dispatchId = eventId(record.dispatchEvent);
  const outputDispatchId = outputAfterDispatchId(record.outputEvent);
  const dispatchTs = eventTimestamp(record.dispatchEvent);
  const outputTs = eventTimestamp(record.outputEvent);
  const identityPid = eventProcessId(record.processIdentity);
  const loaderPid = eventProcessId(record.loaderEvent);
  const epochPublishPid = eventProcessId(record.epochPublishEvent);
  const dispatchPid = eventProcessId(record.dispatchEvent);
  const outputPid = eventProcessId(record.outputEvent);
  const classification = asObject(record.classification);
  const projectKind = firstText(classification.project_kind, classification.projectKind);
  const editKind = firstText(classification.edit_kind, classification.editKind);
  const route = firstText(classification.route);

  if (!projectKind) {
    addFailure(failures, 'classification_project_kind_missing');
  } else if (!GPU_PROJECT_KINDS.has(projectKind)) {
    addFailure(failures, 'classification_project_kind_not_gpu_hmr', { projectKind });
  }
  if (!editKind) {
    addFailure(failures, 'classification_edit_kind_missing');
  } else if (!GPU_ARTIFACT_EDIT_KINDS.has(editKind)) {
    addFailure(failures, 'classification_edit_kind_not_gpu_artifact', { editKind });
  }
  if (!route) addFailure(failures, 'classification_route_missing');
  if (projectKind === 'cpu_project') addFailure(failures, 'classification_cpu_project');
  if (editKind === 'host_only') addFailure(failures, 'classification_host_only_edit');
  if (route && route !== 'gpu_hmr') addFailure(failures, 'classification_route_not_gpu_hmr', { route });
  if (!record.cpuHmrUsedEvidencePresent) addFailure(failures, 'cpu_hmr_absence_evidence_missing');
  if (!record.fullRebuildUsedEvidencePresent) addFailure(failures, 'full_rebuild_absence_evidence_missing');
  if (!record.processRestartedEvidencePresent) addFailure(failures, 'process_restart_absence_evidence_missing');
  if (record.cpuHmrUsed) addFailure(failures, 'cpu_hmr_used');
  if (record.fullRebuildUsed) addFailure(failures, 'full_rebuild_used');
  if (record.processRestarted) addFailure(failures, 'process_restarted');
  if (!record.contractHash) addFailure(failures, 'contract_hash_missing');
  if (!record.artifactBeforeHash) addFailure(failures, 'artifact_before_hash_missing');
  if (!artifactAfterHash) addFailure(failures, 'artifact_after_hash_missing');
  if (record.artifactBeforeHash && artifactAfterHash && record.artifactBeforeHash === artifactAfterHash) {
    addFailure(failures, 'artifact_hash_unchanged');
  }
  if (!loadedArtifactHash) {
    addFailure(failures, 'loader_artifact_hash_missing');
  } else if (artifactAfterHash && loadedArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'loader_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: loadedArtifactHash,
    });
  }
  if (!publishedArtifactHash) {
    addFailure(failures, 'epoch_publish_artifact_hash_missing');
  } else if (artifactAfterHash && publishedArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'epoch_publish_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: publishedArtifactHash,
    });
  }
  if (!publishedEpoch) addFailure(failures, 'epoch_publish_id_missing');
  if (!dispatchEpoch) {
    addFailure(failures, 'dispatch_epoch_missing');
  } else if (publishedEpoch && dispatchEpoch !== publishedEpoch) {
    addFailure(failures, 'dispatch_epoch_mismatch', {
      expected: publishedEpoch,
      actual: dispatchEpoch,
    });
  }
  if (!dispatchId) addFailure(failures, 'dispatch_id_missing');
  const dispatchArtifactHash = eventArtifactHash(record.dispatchEvent);
  if (!dispatchArtifactHash) {
    addFailure(failures, 'dispatch_artifact_hash_missing');
  } else if (artifactAfterHash && dispatchArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'dispatch_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: dispatchArtifactHash,
    });
  }
  if (dispatchTs === null) addFailure(failures, 'dispatch_timestamp_missing');
  if (!outputDispatchId) {
    addFailure(failures, 'output_after_dispatch_id_missing');
  } else if (dispatchId && outputDispatchId !== dispatchId) {
    addFailure(failures, 'output_after_dispatch_id_mismatch', {
      expected: dispatchId,
      actual: outputDispatchId,
    });
  }
  if (record.outputEvent.passed !== true) addFailure(failures, 'output_oracle_not_passed');
  const outputArtifactHash = eventArtifactHash(record.outputEvent);
  if (!outputArtifactHash) {
    addFailure(failures, 'output_artifact_hash_missing');
  } else if (artifactAfterHash && outputArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'output_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: outputArtifactHash,
    });
  }
  const outputEpoch = eventEpoch(record.outputEvent);
  if (!outputEpoch) {
    addFailure(failures, 'output_epoch_missing');
  } else if (publishedEpoch && outputEpoch !== publishedEpoch) {
    addFailure(failures, 'output_epoch_mismatch', {
      expected: publishedEpoch,
      actual: outputEpoch,
    });
  }
  if (outputTs === null) addFailure(failures, 'output_timestamp_missing');
  if (dispatchTs !== null && outputTs !== null && outputTs < dispatchTs) {
    addFailure(failures, 'output_precedes_dispatch', {
      dispatchTimestamp: dispatchTs,
      outputTimestamp: outputTs,
    });
  }
  if (!identityPid) addFailure(failures, 'process_identity_missing');
  if (!loaderPid) addFailure(failures, 'loader_process_identity_missing');
  if (!epochPublishPid) addFailure(failures, 'epoch_publish_process_identity_missing');
  if (!dispatchPid) addFailure(failures, 'dispatch_process_identity_missing');
  if (!outputPid) addFailure(failures, 'output_process_identity_missing');
  if (identityPid && loaderPid && loaderPid !== identityPid) {
    addFailure(failures, 'loader_process_identity_mismatch', {
      expected: identityPid,
      actual: loaderPid,
    });
  }
  if (identityPid && epochPublishPid && epochPublishPid !== identityPid) {
    addFailure(failures, 'epoch_publish_process_identity_mismatch', {
      expected: identityPid,
      actual: epochPublishPid,
    });
  }
  if (identityPid && dispatchPid && dispatchPid !== identityPid) {
    addFailure(failures, 'dispatch_process_identity_mismatch', {
      expected: identityPid,
      actual: dispatchPid,
    });
  }
  if (identityPid && outputPid && outputPid !== identityPid) {
    addFailure(failures, 'output_process_identity_mismatch', {
      expected: identityPid,
      actual: outputPid,
    });
  }
  if (!record.deviceIdentity || Object.keys(record.deviceIdentity).length === 0) {
    addFailure(failures, 'device_identity_missing');
  }
  if (!record.retirementEvent || Object.keys(record.retirementEvent).length === 0) {
    addFailure(failures, 'retirement_event_missing');
  } else {
    const retirementStatus = firstText(
      record.retirementEvent.status,
      record.retirementEvent.proof,
      record.retirementEvent.retirement_proof,
      record.retirementEvent.retirementProof,
    );
    if (!retirementStatus) addFailure(failures, 'retirement_proof_missing');
  }
  const visualArtifacts = visualOracleArtifacts(record.oracleArtifacts, record.outputEvent);
  if (isVisualOutput(record.outputEvent) || visualArtifacts) {
    const artifacts = visualArtifacts;
    if (!artifacts) {
      addFailure(failures, 'visual_oracle_artifacts_missing');
    } else {
      const missingFields = missingArtifactFields(artifacts, VISUAL_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        addFailure(failures, 'visual_oracle_artifacts_incomplete', { missingFields });
      }
      if (objectFieldValue(artifacts, ['blank_frame_rejection', 'blankFrameRejection']) !== true) {
        addFailure(failures, 'visual_blank_frame_rejection_not_proven');
      }
      if (objectFieldValue(artifacts, ['same_frame_rejection', 'sameFrameRejection']) !== true) {
        addFailure(failures, 'visual_same_frame_rejection_not_proven');
      }
    }
    const deterministicVisualModeEvaluation =
      evaluateGpuHmrDeterministicVisualMode(record.deterministicVisualMode);
    if (deterministicVisualModeEvaluation.accepted !== true) {
      addFailure(failures, 'visual_output_without_deterministic_mode', {
        failedGates: deterministicVisualModeEvaluation.failedGates,
      });
      for (const gate of deterministicVisualModeEvaluation.failedGates) {
        addFailure(failures, gate.code ?? 'deterministic_visual_mode_gate_failed');
      }
    }
  } else {
    const artifacts = computeOracleArtifacts(record.oracleArtifacts, record.outputEvent);
    if (!artifacts) {
      addFailure(failures, 'compute_oracle_artifacts_missing');
    } else {
      const missingFields = missingArtifactFields(artifacts, COMPUTE_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        addFailure(failures, 'compute_oracle_artifacts_incomplete', { missingFields });
      }
      const checksumBefore = artifactFieldText(artifacts, 'checksum_before', 'checksumBefore');
      const checksumAfter = artifactFieldText(artifacts, 'checksum_after', 'checksumAfter');
      const outputChangeExpected = objectFieldValue(artifacts, [
        'output_change_expected',
        'outputChangeExpected',
        'expected_output_change',
        'expectedOutputChange',
      ]) === true;
      if (outputChangeExpected && checksumBefore && checksumAfter && checksumBefore === checksumAfter) {
        addFailure(failures, 'compute_oracle_checksum_unchanged');
      }
    }
  }
  const modelRecords = modelProvenanceRecords(record.modelProvenance);
  if (modelRecords.length === 0) {
    addFailure(failures, 'model_provenance_missing');
  }
  for (const [index, model] of modelRecords.entries()) {
    const prefix = `model_provenance_${index}`;
    for (const [snakeKey, camelKey, code] of [
      ['provider', 'provider', 'provider_missing'],
      ['requested_model', 'requestedModel', 'requested_model_missing'],
      ['provider_model_status', 'providerModelStatus', 'provider_model_status_missing'],
      ['provider_model_alias_resolved_to', 'providerModelAliasResolvedTo', 'provider_model_alias_resolved_to_missing'],
      ['provider_shutdown_or_deprecation_detected', 'providerShutdownOrDeprecationDetected',
        'provider_shutdown_or_deprecation_detected_missing'],
      ['model_availability_checked_at', 'modelAvailabilityCheckedAt', 'model_availability_checked_at_missing'],
      ['actual_model', 'actualModel', 'actual_model_missing'],
      ['fallback_model', 'fallbackModel', 'fallback_model_missing'],
      ['fallback_used', 'fallbackUsed', 'fallback_used_missing'],
      ['request_mode', 'requestMode', 'request_mode_missing'],
      ['hard_infra_failure', 'hardInfraFailure', 'hard_infra_failure_missing'],
    ]) {
      if (!modelFieldRecorded(model, snakeKey, camelKey)) {
        addFailure(failures, code, { record: prefix });
      }
    }
    const status = modelStatus(model);
    if (status === 'shutdown') {
      addFailure(failures, 'model_provider_status_shutdown', {
        record: prefix,
        requested_model: modelFieldText(model, 'requested_model', 'requestedModel'),
      });
    } else if (!modelStatusAccepted(status)) {
      addFailure(failures, 'model_provider_status_not_accepted', {
        record: prefix,
        provider_model_status: status,
      });
    }
    if (modelHardInfraFailure(model)) {
      addFailure(failures, 'model_hard_infra_failure', { record: prefix });
    }
    if (
      modelFieldText(model, 'request_mode', 'requestMode') === 'gpu_delta'
      && modelFallbackUsed(model)
    ) {
      warnings.push({ code: 'gpu_delta_model_fallback_used', record: prefix });
    }
    if (modelFallbackUsed(model)) {
      for (const [snakeKey, camelKey, code] of [
        ['actual_provider_model_status', 'actualProviderModelStatus', 'actual_provider_model_status_missing'],
        ['actual_model_availability_checked_at', 'actualModelAvailabilityCheckedAt',
          'actual_model_availability_checked_at_missing'],
        ['fallback_provider_model_status', 'fallbackProviderModelStatus', 'fallback_provider_model_status_missing'],
        ['fallback_model_availability_checked_at', 'fallbackModelAvailabilityCheckedAt',
          'fallback_model_availability_checked_at_missing'],
      ]) {
        if (!modelFieldRecorded(model, snakeKey, camelKey)) {
          addFailure(failures, code, { record: prefix });
        }
      }
      const actualStatus = prefixedModelStatus(model, 'actual');
      if (actualStatus === 'shutdown') {
        addFailure(failures, 'actual_model_provider_status_shutdown', { record: prefix });
      } else if (!modelStatusAccepted(actualStatus)) {
        addFailure(failures, 'actual_provider_model_status_not_accepted', {
          record: prefix,
          provider_model_status: actualStatus,
        });
      }
      const fallbackStatus = prefixedModelStatus(model, 'fallback');
      if (fallbackStatus === 'shutdown') {
        addFailure(failures, 'fallback_model_provider_status_shutdown', { record: prefix });
      } else if (!modelStatusAccepted(fallbackStatus)) {
        addFailure(failures, 'fallback_provider_model_status_not_accepted', {
          record: prefix,
          provider_model_status: fallbackStatus,
        });
      }
    }
    if (
      modelStatus(model) === 'deprecated'
      && !modelShutdownOrDeprecationDetected(model)
    ) {
      addFailure(failures, 'model_deprecation_not_recorded', { record: prefix });
    }
  }
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: record.proofId,
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
    warnings,
    record,
    invariantSummary: {
      cpuHmrUsed: record.cpuHmrUsed,
      cpuHmrUsedEvidencePresent: record.cpuHmrUsedEvidencePresent,
      fullRebuildUsed: record.fullRebuildUsed,
      fullRebuildUsedEvidencePresent: record.fullRebuildUsedEvidencePresent,
      processRestarted: record.processRestarted,
      processRestartedEvidencePresent: record.processRestartedEvidencePresent,
      artifactAfterHash,
      loadedArtifactHash,
      publishedArtifactHash,
      publishedEpoch,
      dispatchEpoch,
      dispatchId,
      dispatchArtifactHash,
      outputDispatchId,
      outputPassed: record.outputEvent.passed === true,
    },
  };
}

export function buildGpuHmrProofLedger(input = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const query = evaluateGpuHmrProofLedger(record);
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: record.proofId,
    records: [record],
    query,
    gpuHmrSuccess: query.gpuHmrSuccess,
    gpu_hmr_success: query.gpuHmrSuccess,
  };
}

export function queryGpuHmrLedgerInvariants(input = {}) {
  const ledger = asObject(input);
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  const recomputed = records && records.length > 0
    ? evaluateGpuHmrProofLedger(records[records.length - 1])
    : evaluateGpuHmrProofLedger(input);
  const consistencyFailures = [];
  const topLevelProofId = firstText(ledger.proofId, ledger.proof_id);
  if (records && records.length > 0 && topLevelProofId && topLevelProofId !== recomputed.proofId) {
    consistencyFailures.push({
      code: 'ledger_proof_id_mismatch',
      suppliedProofId: topLevelProofId,
      recomputedProofId: recomputed.proofId,
    });
  }
  const topLevelSuccess = firstPresent(
    [ledger, 'gpuHmrSuccess'],
    [ledger, 'gpu_hmr_success'],
  );
  if (
    records
    && records.length > 0
    && topLevelSuccess.present
    && topLevelSuccess.value !== recomputed.gpuHmrSuccess
  ) {
    consistencyFailures.push({
      code: 'ledger_success_flag_mismatch',
      suppliedGpuHmrSuccess: topLevelSuccess.value,
      recomputedGpuHmrSuccess: recomputed.gpuHmrSuccess,
    });
  }
  const suppliedQuery = asObject(ledger.query);
  if (suppliedQuery.schemaVersion === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION) {
    const suppliedFailures = compactStringList(asObject(suppliedQuery).failedInvariants?.map?.((failure) => failure?.code));
    const recomputedFailures = compactStringList(recomputed.failedInvariants.map((failure) => failure.code));
    const suppliedConsistent =
      suppliedQuery.gpuHmrSuccess === recomputed.gpuHmrSuccess
      && firstText(suppliedQuery.proofId, suppliedQuery.proof_id) === recomputed.proofId
      && stableJson(suppliedFailures) === stableJson(recomputedFailures);
    if (!suppliedConsistent) {
      return {
        ...recomputed,
        gpuHmrSuccess: false,
        failedInvariants: [
          ...recomputed.failedInvariants,
          {
            code: 'supplied_ledger_query_mismatch',
            suppliedGpuHmrSuccess: suppliedQuery.gpuHmrSuccess,
            recomputedGpuHmrSuccess: recomputed.gpuHmrSuccess,
          },
          ...consistencyFailures,
        ],
      };
    }
  } else if (Object.keys(suppliedQuery).length > 0) {
    consistencyFailures.push({
      code: 'supplied_ledger_query_schema_mismatch',
      suppliedSchemaVersion: suppliedQuery.schemaVersion ?? suppliedQuery.schema_version ?? null,
    });
  }
  if (consistencyFailures.length > 0) {
    return {
      ...recomputed,
      gpuHmrSuccess: false,
      failedInvariants: [
        ...recomputed.failedInvariants,
        ...consistencyFailures,
      ],
    };
  }
  return recomputed;
}

export function assertGpuHmrProofLedgerSuccess(input = {}) {
  const result = queryGpuHmrLedgerInvariants(input);
  if (!result.gpuHmrSuccess) {
    const codes = result.failedInvariants.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR proof ledger rejected record: ${codes}`);
  }
  return result;
}
