import { createHash } from 'node:crypto';

export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = 'synthi.gpu.hmr.proof_ledger.v1';

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

function visualDeterministicModeAccepted(mode) {
  const m = asObject(mode);
  if (m.accepted === true || m.proven === true) return true;
  if (m.fixed_seed === true && m.frozen_camera === true && m.frame_capture_after_epoch_dispatch === true) {
    return true;
  }
  const window = asObject(m.convergence_window ?? m.convergenceWindow);
  return m.frozen_camera === true
    && m.frame_capture_after_epoch_dispatch === true
    && text(window.metric?.value ?? window.metric)
    && finiteNumber(window.frame_start ?? window.frameStart) !== null
    && finiteNumber(window.frame_end ?? window.frameEnd) !== null;
}

function isVisualOutput(outputEvent) {
  const kind = outputKind(outputEvent);
  return kind.includes('visual')
    || kind.includes('render')
    || kind.includes('frame')
    || kind.includes('pixel')
    || asObject(outputEvent.visual_oracle_artifacts ?? outputEvent.visualOracleArtifacts).after_image;
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
    cpuHmrUsed: asBool(record.cpu_hmr_used ?? record.cpuHmrUsed),
    fullRebuildUsed: asBool(record.full_rebuild_used ?? record.fullRebuildUsed),
    processRestarted: asBool(record.process_restarted ?? record.processRestarted),
    oracleArtifacts: asObject(record.oracle_artifacts ?? record.oracleArtifacts),
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
  const dispatchPid = eventProcessId(record.dispatchEvent);

  if (record.cpuHmrUsed) addFailure(failures, 'cpu_hmr_used');
  if (record.fullRebuildUsed) addFailure(failures, 'full_rebuild_used');
  if (record.processRestarted) addFailure(failures, 'process_restarted');
  if (!artifactAfterHash) addFailure(failures, 'artifact_after_hash_missing');
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
  if (outputArtifactHash && artifactAfterHash && outputArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'output_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: outputArtifactHash,
    });
  }
  const outputEpoch = eventEpoch(record.outputEvent);
  if (outputEpoch && publishedEpoch && outputEpoch !== publishedEpoch) {
    addFailure(failures, 'output_epoch_mismatch', {
      expected: publishedEpoch,
      actual: outputEpoch,
    });
  }
  if (dispatchTs !== null && outputTs !== null && outputTs < dispatchTs) {
    addFailure(failures, 'output_precedes_dispatch', {
      dispatchTimestamp: dispatchTs,
      outputTimestamp: outputTs,
    });
  }
  if (identityPid && loaderPid && loaderPid !== identityPid) {
    addFailure(failures, 'loader_process_identity_mismatch', {
      expected: identityPid,
      actual: loaderPid,
    });
  }
  if (identityPid && dispatchPid && dispatchPid !== identityPid) {
    addFailure(failures, 'dispatch_process_identity_mismatch', {
      expected: identityPid,
      actual: dispatchPid,
    });
  }
  if (isVisualOutput(record.outputEvent) && !visualDeterministicModeAccepted(record.deterministicVisualMode)) {
    addFailure(failures, 'visual_output_without_deterministic_mode');
  }
  if (!record.contractHash) warnings.push({ code: 'contract_hash_missing' });
  if (!record.deviceIdentity || Object.keys(record.deviceIdentity).length === 0) {
    warnings.push({ code: 'device_identity_missing' });
  }
  if (!record.retirementEvent || Object.keys(record.retirementEvent).length === 0) {
    warnings.push({ code: 'retirement_event_missing' });
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
      fullRebuildUsed: record.fullRebuildUsed,
      processRestarted: record.processRestarted,
      artifactAfterHash,
      loadedArtifactHash,
      publishedArtifactHash,
      publishedEpoch,
      dispatchEpoch,
      dispatchId,
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
  if (asObject(ledger.query).schemaVersion === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION) {
    return ledger.query;
  }
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  if (records && records.length > 0) {
    return evaluateGpuHmrProofLedger(records[records.length - 1]);
  }
  return evaluateGpuHmrProofLedger(input);
}

export function assertGpuHmrProofLedgerSuccess(input = {}) {
  const result = queryGpuHmrLedgerInvariants(input);
  if (!result.gpuHmrSuccess) {
    const codes = result.failedInvariants.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR proof ledger rejected record: ${codes}`);
  }
  return result;
}
