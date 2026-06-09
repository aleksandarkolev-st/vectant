import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';

export const GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation_matrix_ledger.v1';
export const GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation_matrix_row.v1';

const MATRIX_OUTCOME_PRIORITY = new Map([
  ['full_runtime_gpu_hmr', 100],
  ['visual_profile_accepted', 70],
  ['preflight_only', 50],
  ['refusal_proven', 40],
  ['unproven', 0],
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

function proofIdFor(prefix, value) {
  return `${prefix}:sha256:${sha256Hex(stableJson(value))}`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter(Boolean))];
}

function compactObject(value) {
  return isObject(value) ? value : {};
}

function relPath(filePath, repoRoot) {
  if (!filePath) return null;
  const absolute = path.resolve(String(filePath));
  const relative = path.relative(repoRoot, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : absolute;
}

function normalizeMaybeWindowsPath(value) {
  const raw = text(value);
  if (!raw) return null;
  return raw.replace(/\\/g, path.sep);
}

function resolveEvidencePath(value, repoRoot, baseDir = repoRoot) {
  const normalized = normalizeMaybeWindowsPath(value);
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  const repoResolved = path.resolve(repoRoot, normalized);
  return repoResolved.startsWith(repoRoot) ? repoResolved : path.resolve(baseDir, normalized);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pngEvidence(filePath) {
  if (!filePath) {
    return {
      path: null,
      exists: false,
      sizeBytes: null,
      pngSignatureValid: false,
    };
  }
  try {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buffer, 0, 8, 0);
      const pngSignatureValid =
        bytesRead === 8
        && buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47
        && buffer[4] === 0x0d
        && buffer[5] === 0x0a
        && buffer[6] === 0x1a
        && buffer[7] === 0x0a;
      return {
        path: filePath,
        exists: true,
        sizeBytes: stat.size,
        pngSignatureValid,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      path: filePath,
      exists: false,
      sizeBytes: null,
      pngSignatureValid: false,
    };
  }
}

async function visualArtifactEvidence(paths, repoRoot, baseDir, metrics = {}, required = false) {
  const resolved = compactStringList(paths)
    .map((value) => resolveEvidencePath(value, repoRoot, baseDir))
    .filter(Boolean);
  const evidence = [];
  for (const filePath of resolved) {
    const fileEvidence = await pngEvidence(filePath);
    evidence.push({
      ...fileEvidence,
      path: relPath(fileEvidence.path, repoRoot),
    });
  }
  const imageCount = evidence.length;
  const existingImageCount = evidence.filter((item) => item.exists).length;
  const pngImageCount = evidence.filter((item) => item.pngSignatureValid).length;
  const allImagesExist = imageCount > 0 && existingImageCount === imageCount;
  const allImagesArePng = imageCount > 0 && pngImageCount === imageCount;
  return {
    required,
    present: imageCount > 0,
    accepted: required ? allImagesExist && allImagesArePng : imageCount === 0 || allImagesExist,
    imageCount,
    existingImageCount,
    pngImageCount,
    allImagesExist,
    allImagesArePng,
    changedPixelRatio: finiteNumber(metrics.changedPixelRatio ?? metrics.changed_pixel_ratio),
    meanAbsDelta8bit: finiteNumber(metrics.meanAbsDelta8bit ?? metrics.mean_abs_delta_8bit),
    visiblePixelCount: finiteNumber(metrics.visiblePixelCount ?? metrics.visible_pixel_count),
    images: evidence,
  };
}

function rowKey(row) {
  return [
    row.backend ?? 'unknown',
    row.targetId ?? 'unknown',
    row.profileId ?? 'unknown',
    row.proofMode ?? 'unknown',
    row.evidenceKind ?? 'unknown',
    row.matrixOutcome ?? 'unknown',
  ].join('|');
}

function finalizeRow(seed) {
  const row = {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    ...seed,
  };
  const safetyFailures = rowSafetyFailures(row);
  row.safety = {
    accepted: safetyFailures.length === 0,
    failedGates: safetyFailures,
  };
  row.rowId = proofIdFor('gpu-validation-matrix-row', {
    ...row,
    rowId: undefined,
  });
  row.matrixKey = rowKey(row);
  return row;
}

function rowSafetyFailures(row) {
  const failures = [];
  if (row.acceptedForGpuHmr === true && row.matrixOutcome !== 'full_runtime_gpu_hmr') {
    failures.push({ code: 'gpu_hmr_success_requires_full_runtime_outcome' });
  }
  if (row.acceptedForGpuHmr === true && row.proofChainAccepted !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_accepted_proof_chain' });
  }
  if (row.acceptedForGpuHmr === true && row.cpuHmrUsed === true) {
    failures.push({ code: 'gpu_hmr_success_cannot_use_cpu_hmr' });
  }
  if (row.acceptedForGpuHmr === true && row.fullRebuildUsed === true) {
    failures.push({ code: 'gpu_hmr_success_cannot_use_full_rebuild' });
  }
  if (row.acceptedForGpuHmr === true && row.processRestarted === true) {
    failures.push({ code: 'gpu_hmr_success_cannot_restart_process' });
  }
  if (row.acceptedForGpuHmr === true && row.visual?.required === true && row.visual.accepted !== true) {
    failures.push({ code: 'visual_gpu_hmr_success_requires_readable_visual_artifacts' });
  }
  if (row.matrixOutcome === 'refusal_proven' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'refusal_row_cannot_accept_gpu_hmr' });
  }
  if (row.matrixOutcome === 'preflight_only' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'preflight_only_row_cannot_accept_gpu_hmr' });
  }
  return failures;
}

function ledgerFacet(json) {
  const ledger = compactObject(json.proofLedger ?? json.proof_ledger);
  const suppliedQuery = compactObject(json.proofLedgerQuery ?? json.proof_ledger_query ?? ledger.query);
  let query = null;
  if (Object.keys(ledger).length > 0) {
    query = queryGpuHmrLedgerInvariants(ledger);
  } else if (suppliedQuery.schemaVersion || suppliedQuery.schema_version) {
    query = suppliedQuery;
  }
  const failures = Array.isArray(query?.failedInvariants)
    ? query.failedInvariants
    : Array.isArray(query?.failed_invariants)
      ? query.failed_invariants
      : [];
  return {
    present: Object.keys(ledger).length > 0,
    proofId: firstText(ledger.proofId, ledger.proof_id, query?.proofId, query?.proof_id),
    gpuHmrSuccess: boolOrNull(query?.gpuHmrSuccess ?? query?.gpu_hmr_success),
    failedInvariants: failures.map((failure) => (
      isObject(failure) ? failure : { code: String(failure) }
    )),
  };
}

function proofIdsFrom(...values) {
  return compactStringList(values.flatMap((value) => {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((item) => proofIdsFrom(item));
    if (!isObject(value)) return [];
    return [
      value.proofId,
      value.proof_id,
      value.runtimeProof?.proofId,
      value.runtimeProof?.proof_id,
      value.proofLedger?.proofId,
      value.proof_ledger?.proofId,
      value.proof_ledger?.proof_id,
      value.proofLedgerQuery?.proofId,
      value.proof_ledger_query?.proofId,
      value.rejectionProofArtifact?.proofId,
      value.visualProofArtifact?.proofId,
    ];
  }));
}

function artifactPathsFromValue(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => artifactPathsFromValue(item));
  if (!isObject(value)) return [];
  return compactStringList([
    value.path,
    value.summary,
    value.before_image,
    value.after_image,
    value.diff_image,
    value.beforeImage,
    value.afterImage,
    value.diffImage,
    value.rendered_card_png,
    value.renderedCardPng,
    ...Object.values(value).flatMap((item) => (
      isObject(item) || Array.isArray(item) ? artifactPathsFromValue(item) : []
    )),
  ]);
}

async function runtimeProofRow(json, filePath, context) {
  const contract = compactObject(json.acceptanceContract ?? json.acceptance_contract);
  const classification = compactObject(contract.classification);
  const artifactIdentity = compactObject(contract.artifact_identity ?? contract.artifactIdentity);
  const ledger = ledgerFacet(json);
  const resultState = firstText(json.resultState, json.result_state);
  const accepted =
    json.gpuHmrSuccess === true
    && json.fullRuntimeProven === true
    && resultState === 'gpu-hmr-full-runtime-proven'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0;
  const backend = firstText(
    isObject(contract.backend) ? contract.backend.value : contract.backend,
    json.backend,
    'hip',
  );
  const targetId = firstText(
    json.target_name,
    json.targetName,
    artifactIdentity.entry_points?.join('+'),
    contract.project_id,
    contract.projectId,
    json.workspaceSlug,
    json.workspace_slug,
  );
  const ledgerRecord = compactObject(json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const oracleArtifacts = compactObject(ledgerRecord.oracle_artifacts ?? ledgerRecord.oracleArtifacts);
  const hasVisualOracle = isObject(oracleArtifacts.visual_oracle_artifacts ?? oracleArtifacts.visualOracleArtifacts);
  const hasComputeOracle = isObject(oracleArtifacts.compute_oracle_artifacts ?? oracleArtifacts.computeOracleArtifacts);
  const outputKind = hasVisualOracle ? 'visual_oracle' : hasComputeOracle ? 'compute_oracle' : 'compute_oracle';
  const visualPaths = compactStringList([
    ...artifactPathsFromValue(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts),
    ...artifactPathsFromValue(json.visualEvidenceRefs ?? json.visual_evidence_refs),
    ...artifactPathsFromValue(
      oracleArtifacts.visual_oracle_artifacts
      ?? oracleArtifacts.visualOracleArtifacts
      ?? oracleArtifacts.compute_oracle_artifacts
      ?? oracleArtifacts.computeOracleArtifacts,
    ).filter((item) => item.endsWith('.png')),
  ]);
  const visual = await visualArtifactEvidence(visualPaths, context.repoRoot, path.dirname(filePath), {}, outputKind === 'visual_oracle');
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: targetId,
    proofMode: 'strict_runtime_ledger',
    evidenceKind: outputKind,
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'runtime_proof_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'proof_ledger_invariant_query' : 'proof_ledger_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    visual,
    cpuHmrUsed: boolOrNull(json.derivedProofLedgerRecord?.cpuHmrUsed ?? json.derived_proof_ledger_record?.cpuHmrUsed),
    fullRebuildUsed: boolOrNull(json.derivedProofLedgerRecord?.fullRebuildUsed ?? json.derived_proof_ledger_record?.fullRebuildUsed),
    processRestarted: boolOrNull(json.derivedProofLedgerRecord?.processRestarted ?? json.derived_proof_ledger_record?.processRestarted),
    reasons: accepted ? [] : compactStringList([
      json.degradedReason,
      ...(Array.isArray(json.limitations) ? json.limitations.map((item) => item?.degradedReason ?? item?.degraded_reason ?? item) : []),
      ...ledger.failedInvariants.map((failure) => failure.code),
    ]),
    openGaps: accepted ? [] : ['runtime_proof_not_accepted'],
    classification: {
      projectKind: firstText(classification.project_kind, classification.projectKind),
      editKind: firstText(classification.edit_kind, classification.editKind),
      route: firstText(classification.route),
    },
  });
}

function parseRecordDetailJson(record) {
  try {
    return JSON.parse(record?.detail ?? '{}');
  } catch {
    return null;
  }
}

function detailRecord(records, name, fromEnd = true) {
  const matches = records.filter((record) => record?.name === name);
  if (matches.length === 0) return null;
  return fromEnd ? matches[matches.length - 1] : matches[0];
}

function detailStatus(records, name) {
  return detailRecord(records, name)?.status ?? null;
}

function imagePathsFromDetail(detail) {
  const raw = text(detail);
  if (!raw) return [];
  const imageMatch = raw.match(/images=([^ ]+)/);
  const diffMatch = raw.match(/diff=([^ ]+)/);
  return compactStringList([
    ...(imageMatch ? imageMatch[1].split(',') : []),
    ...(diffMatch ? [diffMatch[1]] : []),
  ]);
}

function visualMetricsFromDeltaDetail(detail) {
  const raw = text(detail) ?? '';
  return {
    changedPixelRatio: finiteNumber(raw.match(/changed=([0-9.]+)%/)?.[1]) !== null
      ? finiteNumber(raw.match(/changed=([0-9.]+)%/)?.[1]) / 100
      : null,
    meanAbsDelta8bit: finiteNumber(raw.match(/mean_abs=([0-9.]+)/)?.[1]),
    selectedDeltaMs: finiteNumber(raw.match(/selected_delta_ms=([0-9.]+)/)?.[1]),
  };
}

async function agentSplitRow(records, filePath, context) {
  const fixture = firstText(detailRecord(records, 'fixture', false)?.detail, path.basename(path.dirname(filePath)));
  const waitDetail = parseRecordDetailJson(detailRecord(records, 'mcp wait_hmr proof gate'));
  const proofValidation = compactObject(waitDetail?.gpu_proof_validation);
  const ledgerValidation = compactObject(proofValidation.proofLedgerValidation);
  const runtimeValidation = compactObject(proofValidation.runtimeProofArtifactValidation);
  const deltaRecord = detailRecord(records, 'mcp screenshot visual delta');
  const deltaMetrics = visualMetricsFromDeltaDetail(deltaRecord?.detail);
  const beforePaths = imagePathsFromDetail(detailRecord(records, 'mcp screenshot before hmr')?.detail);
  const afterPaths = imagePathsFromDetail(detailRecord(records, 'mcp screenshot after hmr')?.detail);
  const diffPaths = imagePathsFromDetail(deltaRecord?.detail);
  const visual = await visualArtifactEvidence(
    [...beforePaths, ...afterPaths, ...diffPaths],
    context.repoRoot,
    path.dirname(filePath),
    deltaMetrics,
    true,
  );
  const accepted =
    detailStatus(records, 'worker used GPU split endpoint') === 'pass'
    && detailStatus(records, 'generated split contains HMR ABI') === 'pass'
    && detailStatus(records, 'generated split HMR granularity') === 'pass'
    && detailStatus(records, 'device-only GPU HMR observed') === 'pass'
    && detailStatus(records, 'runner stayed alive after GPU HMR') === 'pass'
    && proofValidation.satisfied === true
    && ledgerValidation.gpuHmrSuccess === true
    && Array.isArray(ledgerValidation.failedInvariants)
    && ledgerValidation.failedInvariants.length === 0
    && runtimeValidation.accepted === true
    && deltaRecord?.status === 'pass'
    && visual.accepted === true;
  const ledger = {
    present: false,
    proofId: firstText(ledgerValidation.proofId),
    gpuHmrSuccess: boolOrNull(ledgerValidation.gpuHmrSuccess),
    failedInvariants: Array.isArray(ledgerValidation.failedInvariants)
      ? ledgerValidation.failedInvariants
      : [],
  };
  return finalizeRow({
    artifactSchema: 'synthi.gpu.hmr.agent_split_results.v1',
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'hip',
    targetId: fixture,
    profileId: fixture,
    proofMode: 'mcp_preview_visual',
    evidenceKind: 'visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'mcp_preview_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'mcp_wait_hmr_runtime_proof_gate' : 'mcp_wait_hmr_runtime_proof_gate_rejected',
    proofIds: proofIdsFrom(
      ledgerValidation.proofId,
      waitDetail?.gpu_proof_telemetry?.proofId,
      waitDetail?.gpu_proof_telemetry?.proof_id,
    ),
    ledger,
    visual,
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
    timings: {
      selectedDeltaMs: deltaMetrics.selectedDeltaMs,
    },
    reasons: accepted ? [] : compactStringList([
      proofValidation.reason,
      ...(Array.isArray(ledger.failedInvariants) ? ledger.failedInvariants.map((failure) => failure.code) : []),
      visual.accepted ? null : 'visual_artifacts_not_readable',
    ]),
    openGaps: accepted ? [] : ['mcp_runtime_visual_proof_not_accepted'],
  });
}

async function hiprtWarmRow(json, filePath, context) {
  const acceptance = compactObject(json.acceptance);
  const diff = compactObject(json.diff);
  const baseline = compactObject(json.runtime?.baseline);
  const changed = compactObject(json.runtime?.changed);
  const strict = compactObject(json.strictHmrProvenance ?? json.strict_hmr_provenance);
  const visual = await visualArtifactEvidence(
    [baseline.localCapturePath, changed.localCapturePath, diff.path],
    context.repoRoot,
    path.dirname(filePath),
    {
      changedPixelRatio: diff.changedPixelRatioThreshold4,
      meanAbsDelta8bit: diff.meanAbsDelta8bit,
    },
    true,
  );
  const accepted =
    json.accepted === true
    && acceptance.strictProvenance === true
    && acceptance.sameProcessRuntime === true
    && acceptance.visualDelta === true
    && strict.fullRuntimeProven === true
    && strict.strictFullRuntimePassed === true
    && changed.sameProcess === true
    && visual.accepted === true;
  const profileId = firstText(json.profile?.id, json.profileId, json.slug);
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'hiprt',
    targetId: profileId,
    profileId,
    proofMode: firstText(json.mode, 'same-process'),
    evidenceKind: 'raytraced_visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'hiprt_runtime_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'hiprt_strict_runtime_provenance' : 'hiprt_strict_runtime_rejected',
    proofIds: proofIdsFrom(json, strict),
    ledger: {
      present: false,
      proofId: firstText(strict.runtimeProof?.proofId, strict.runtimeProof?.proof_id),
      gpuHmrSuccess: boolOrNull(strict.fullRuntimeProven),
      failedInvariants: [],
    },
    visual,
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
    timings: {
      totalWallMs: finiteNumber(json.timings?.totalWallMs),
      liveRecompileMs: finiteNumber(changed.liveRecompileMs),
      editToFirstVisualMs: finiteNumber(changed.totalHostWallMs),
    },
    reasons: accepted ? [] : compactStringList([
      visual.accepted ? null : 'visual_artifacts_not_readable',
      strict.fullRuntimeProven === true ? null : 'strict_full_runtime_not_proven',
    ]),
    openGaps: accepted ? [] : ['hiprt_same_process_visual_proof_not_accepted'],
  });
}

async function webGpuRuntimeVisualRow(json, filePath, context) {
  const visualArtifacts = compactObject(
    json.visualOracleArtifacts
    ?? json.visual_oracle_artifacts
    ?? json.artifacts,
  );
  const metrics = compactObject(json.metrics);
  const visual = await visualArtifactEvidence(
    [visualArtifacts.beforeImage, visualArtifacts.afterImage, visualArtifacts.diffImage,
      visualArtifacts.before_image, visualArtifacts.after_image, visualArtifacts.diff_image],
    context.repoRoot,
    path.dirname(filePath),
    metrics,
    true,
  );
  const ledger = ledgerFacet(json);
  const processContinuity = compactObject(json.browser?.processContinuity);
  const nativeApiEvidence = compactObject(json.nativeWebGpuApiEvidence);
  const accepted =
    json.gpuHmrSuccess === true
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && json.visualThresholdValidation?.accepted === true
    && processContinuity.accepted === true
    && processContinuity.processRestarted === false
    && nativeApiEvidence.accepted === true
    && visual.accepted === true;
  const profileId = firstText(json.profile?.id, json.slug);
  return finalizeRow({
    artifactSchema: json.schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'webgpu',
    targetId: profileId,
    profileId,
    proofMode: 'webgpu_wgsl_runtime_visual',
    evidenceKind: 'deterministic_visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'webgpu_runtime_visual_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'webgpu_ledger_process_native_visual_chain' : 'webgpu_runtime_visual_chain_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    visual,
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: boolOrNull(processContinuity.processRestarted),
    timings: {
      totalValidatorWallTimeNs: finiteNumber(json.timings?.total_validator_wall_time),
      triggerToVisibleTimeNs: finiteNumber(json.timings?.trigger_to_visible_time),
      oracleAnalysisTimeNs: finiteNumber(json.timings?.oracle_analysis_time),
    },
    reasons: accepted ? [] : compactStringList([
      ...ledger.failedInvariants.map((failure) => failure.code),
      visual.accepted ? null : 'visual_artifacts_not_readable',
      json.visualThresholdValidation?.accepted === true ? null : 'visual_threshold_not_accepted',
      processContinuity.accepted === true ? null : 'process_continuity_not_accepted',
      nativeApiEvidence.accepted === true ? null : 'native_webgpu_api_not_accepted',
    ]),
    openGaps: accepted ? [] : ['webgpu_runtime_visual_proof_not_accepted'],
  });
}

async function externalProjectRow(json, filePath, context) {
  const profileId = firstText(json.profile?.id, json.profileId, path.basename(filePath).replace(/-\d+-report\.json$/, ''));
  const backend = profileId?.includes('bevy') ? 'bevy_wgsl' : 'webgl';
  const visualArtifacts = compactObject(json.visualOracleArtifacts ?? json.visual_oracle_artifacts);
  const visualDiff = compactObject(json.visualDiff ?? json.visual_diff);
  const visual = await visualArtifactEvidence(
    [visualArtifacts.before_image, visualArtifacts.after_image, visualArtifacts.diff_image],
    context.repoRoot,
    path.dirname(filePath),
    visualDiff,
    json.status === 'pass',
  );
  const deterministicAccepted = json.deterministicVisualModeEvaluation?.accepted === true
    || json.deterministic_visual_mode_evaluation?.accepted === true;
  const visualProfileAccepted =
    json.status === 'pass'
    && visual.accepted === true
    && deterministicAccepted;
  const rejection = compactObject(json.rejectionProofArtifact ?? json.rejection_proof_artifact);
  const refusalProven =
    json.status === 'fail'
    && Boolean(firstText(rejection.proofId, rejection.proof_id))
    && Array.isArray(rejection.reasons)
    && rejection.reasons.length > 0;
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: profileId,
    profileId,
    proofMode: firstText(json.proofMode, json.profile?.proofMode),
    evidenceKind: visualProfileAccepted ? 'external_visual_oracle' : 'external_profile_result',
    matrixOutcome: visualProfileAccepted
      ? 'visual_profile_accepted'
      : refusalProven
        ? 'refusal_proven'
        : 'unproven',
    acceptanceClass: visualProfileAccepted
      ? 'visual_profile_not_full_gpu_hmr_ledger'
      : refusalProven
        ? 'external_profile_refusal'
        : 'external_profile_unproven',
    acceptedForGpuHmr: false,
    visualProfileAccepted,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: visualProfileAccepted || refusalProven,
    proofChain: visualProfileAccepted
      ? 'external_screenshot_visual_oracle'
      : refusalProven
        ? 'external_rejection_artifact'
        : 'external_profile_unproven',
    proofIds: proofIdsFrom(json, rejection),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual,
    cpuHmrUsed: null,
    fullRebuildUsed: null,
    processRestarted: null,
    timings: {
      totalMs: finiteNumber(json.timings?.totalMs ?? json.duration_ms),
      editToFirstVisualMs: finiteNumber(json.timings?.editToScreenshotMs),
      visualDiffMs: finiteNumber(json.timings?.visualDiffMs),
    },
    reasons: compactStringList([
      ...(Array.isArray(rejection.reasons) ? rejection.reasons : []),
      json.error?.message ? 'external_profile_failed' : null,
      visualProfileAccepted || visual.accepted ? null : 'visual_artifacts_not_readable',
    ]),
    openGaps: visualProfileAccepted
      ? ['full_runtime_gpu_hmr_ledger_not_present']
      : refusalProven
        ? ['full_runtime_gpu_hmr_not_proven']
        : ['external_profile_not_accepted'],
  });
}

function preflightBackend(schema) {
  if (schema.includes('oidn_preflight')) return 'oidn_hip';
  if (schema.includes('opencl_preflight')) return 'opencl';
  if (schema.includes('vulkan_preflight')) return 'vulkan';
  if (schema.includes('webgpu_preflight')) return 'webgpu';
  return 'unknown';
}

function preflightAcceptedField(backend, acceptance) {
  if (backend === 'oidn_hip') return acceptance.acceptedForHipOutputProof === true;
  if (backend === 'opencl') return acceptance.acceptedForOpenClOutputProof === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanPipelineProof === true;
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuPipelineProof === true;
  return false;
}

function preflightRuntimeOnlyAccepted(backend, acceptance) {
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuRuntimePreflight === true;
  if (backend === 'opencl') return acceptance.acceptedForOpenClRuntimePreflight === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanRuntimePreflight === true;
  return false;
}

async function preflightRow(json, filePath, context) {
  const schema = firstText(json.schema, json.schemaVersion) ?? 'unknown';
  const backend = preflightBackend(schema);
  const acceptance = compactObject(json.acceptance);
  const classification = compactObject(json.classification);
  const proofAccepted = preflightAcceptedField(backend, acceptance);
  const runtimeOnlyAccepted = preflightRuntimeOnlyAccepted(backend, acceptance);
  const unsupportedReasons = compactStringList(classification.unsupportedReasons ?? classification.unsupported_reasons);
  const noShimApplied = acceptance.noShimApplied === true;
  const noSymlinkApplied = acceptance.noSymlinkApplied === true;
  const noSynthesizedRuntime =
    acceptance.noVendorIcdSynthesized === true
    || acceptance.noIcdSynthesized === true
    || backend === 'oidn_hip'
    || backend === 'webgpu';
  const refusalProven =
    proofAccepted === false
    && unsupportedReasons.length > 0
    && noShimApplied
    && noSymlinkApplied !== false
    && noSynthesizedRuntime !== false;
  const visual = await visualArtifactEvidence(
    [classification.diagnosticScreenshot],
    context.repoRoot,
    path.dirname(filePath),
    {},
    false,
  );
  const matrixOutcome = proofAccepted
    ? 'unproven'
    : runtimeOnlyAccepted
      ? 'preflight_only'
      : refusalProven
        ? 'refusal_proven'
        : 'unproven';
  return finalizeRow({
    artifactSchema: schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: firstText(json.slug, backend),
    profileId: firstText(json.slug, backend),
    proofMode: 'runtime_preflight',
    evidenceKind: backend === 'webgpu' ? 'runtime_preflight_diagnostic' : 'runtime_preflight_refusal',
    matrixOutcome,
    acceptanceClass: matrixOutcome,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: matrixOutcome === 'preflight_only' || refusalProven,
    proofChain: matrixOutcome === 'preflight_only'
      ? 'runtime_preflight_only'
      : refusalProven
        ? 'structured_runtime_refusal'
        : 'preflight_unproven',
    proofIds: proofIdsFrom(json),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual,
    cpuHmrUsed: null,
    fullRebuildUsed: null,
    processRestarted: null,
    noShimEvidence: {
      noShimApplied: boolOrNull(acceptance.noShimApplied),
      noSymlinkApplied: boolOrNull(acceptance.noSymlinkApplied),
      noVendorIcdSynthesized: boolOrNull(acceptance.noVendorIcdSynthesized),
      noIcdSynthesized: boolOrNull(acceptance.noIcdSynthesized),
      noBrowserFlagClaimedAsHmr: boolOrNull(acceptance.noBrowserFlagClaimedAsHmr),
    },
    reasons: compactStringList([
      ...unsupportedReasons,
      acceptance.reason,
      proofAccepted ? 'preflight_does_not_prove_required_output_or_pipeline' : null,
    ]),
    openGaps: matrixOutcome === 'preflight_only'
      ? ['shader_pipeline_or_output_oracle_not_proven']
      : refusalProven
        ? compactStringList([
          backend === 'opencl' ? 'real_opencl_vendor_icd_required' : null,
          backend === 'vulkan' ? 'real_vulkan_icd_required' : null,
          backend === 'oidn_hip' ? 'matching_oidn_hip_runtime_required' : null,
        ])
        : ['runtime_preflight_not_accepted'],
  });
}

async function classifyJsonArtifact(json, filePath, context) {
  if (Array.isArray(json) && json.every((record) => isObject(record) && 'name' in record && 'status' in record)) {
    return agentSplitRow(json, filePath, context);
  }
  if (!isObject(json)) return null;
  const schema = firstText(json.schemaVersion, json.schema) ?? '';
  const proofId = firstText(json.proofId, json.proof_id) ?? '';
  if (schema === 'synthi.gpu.hmr.proof.v1') return runtimeProofRow(json, filePath, context);
  if (schema === 'synthi.hiprt.warm_visual_proof.v2') return hiprtWarmRow(json, filePath, context);
  if (schema === 'synthi.gpu.hmr.external_project_profile.report.v1') {
    return externalProjectRow(json, filePath, context);
  }
  if (schema.includes('webgpu_runtime_visual_proof') || proofId.startsWith('webgpu-runtime-visual-proof:')) {
    return webGpuRuntimeVisualRow(json, filePath, context);
  }
  if (
    schema.includes('oidn_preflight')
    || schema.includes('opencl_preflight')
    || schema.includes('vulkan_preflight')
    || schema.includes('webgpu_preflight')
  ) {
    return preflightRow(json, filePath, context);
  }
  return null;
}

export async function walkJsonFiles(root) {
  if (!(await pathExists(root))) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function defaultValidationMatrixRoots({ repoRoot, mcpRoot }) {
  return [
    path.join(mcpRoot, '.gpu-hmr-test-logs'),
    path.join(mcpRoot, '.gpu-hmr-test-artifacts'),
    path.join(repoRoot, 'tmp', 'validation-runs'),
    path.join(repoRoot, 'tmp', 'real-rocm'),
  ];
}

function rowPriority(row) {
  return MATRIX_OUTCOME_PRIORITY.get(row.matrixOutcome) ?? 0;
}

function selectBestRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = row.matrixKey;
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, row);
      continue;
    }
    const priorityDelta = rowPriority(row) - rowPriority(existing);
    if (priorityDelta > 0 || (priorityDelta === 0 && String(row.updatedAt) > String(existing.updatedAt))) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function coverageSummary(rows) {
  const byOutcome = {};
  const byBackend = {};
  for (const row of rows) {
    byOutcome[row.matrixOutcome] = (byOutcome[row.matrixOutcome] ?? 0) + 1;
    byBackend[row.backend] = (byBackend[row.backend] ?? 0) + 1;
  }
  const fullRuntimeRows = rows.filter((row) => row.matrixOutcome === 'full_runtime_gpu_hmr');
  const visualProfileRows = rows.filter((row) => row.matrixOutcome === 'visual_profile_accepted');
  const refusalRows = rows.filter((row) => row.matrixOutcome === 'refusal_proven');
  const preflightRows = rows.filter((row) => row.matrixOutcome === 'preflight_only');
  const unprovenRows = rows.filter((row) => row.matrixOutcome === 'unproven');
  return {
    rowCount: rows.length,
    byOutcome,
    byBackend,
    acceptedFullRuntimeGpuHmrRows: fullRuntimeRows.length,
    acceptedFullRuntimeTargets: compactStringList(fullRuntimeRows.map((row) => row.targetId)),
    visualProfileAcceptedRows: visualProfileRows.length,
    visualProfileTargets: compactStringList(visualProfileRows.map((row) => row.targetId)),
    refusalProvenRows: refusalRows.length,
    refusalTargets: compactStringList(refusalRows.map((row) => row.targetId)),
    preflightOnlyRows: preflightRows.length,
    preflightOnlyTargets: compactStringList(preflightRows.map((row) => row.targetId)),
    unprovenRows: unprovenRows.length,
    unprovenTargets: compactStringList(unprovenRows.map((row) => row.targetId)),
    planCoverage: planCoverage(rows),
  };
}

function rowRefs(rows) {
  return rows.map((row) => ({
    rowId: row.rowId,
    backend: row.backend,
    targetId: row.targetId,
    matrixOutcome: row.matrixOutcome,
    proofChain: row.proofChain,
    proofIds: row.proofIds,
  }));
}

function coverageEntry({ id, requirement, status, rows = [], openGaps = [] }) {
  return {
    id,
    requirement,
    status,
    rowCount: rows.length,
    rows: rowRefs(rows),
    openGaps: compactStringList(openGaps),
  };
}

function acceptedRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'full_runtime_gpu_hmr' && predicate(row));
}

function refusalRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'refusal_proven' && predicate(row));
}

function preflightOnlyRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'preflight_only' && predicate(row));
}

function visualProfileRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'visual_profile_accepted' && predicate(row));
}

function acceptedOrRefusedCoverage({ rows, id, requirement, acceptedPredicate, refusalPredicate, missingGap }) {
  const accepted = acceptedRows(rows, acceptedPredicate);
  if (accepted.length > 0) {
    return coverageEntry({ id, requirement, status: 'accepted', rows: accepted });
  }
  const refused = refusalRows(rows, refusalPredicate ?? acceptedPredicate);
  if (refused.length > 0) {
    return coverageEntry({
      id,
      requirement,
      status: 'refused',
      rows: refused,
      openGaps: compactStringList(refused.flatMap((row) => row.openGaps)),
    });
  }
  return coverageEntry({
    id,
    requirement,
    status: 'missing',
    openGaps: [missingGap],
  });
}

function planCoverage(rows) {
  const flowRows = acceptedRows(rows, (row) => row.backend === 'hip' && row.targetId === 'flow');
  const rayRows = acceptedRows(rows, (row) => row.backend === 'hip' && row.targetId === 'ray-light');
  const hipRuntimeRows = acceptedRows(rows, (row) => row.backend === 'hip');
  const hiprtRows = acceptedRows(rows, (row) => row.backend === 'hiprt');
  const webgpuRuntimeRows = acceptedRows(rows, (row) => row.backend === 'webgpu');
  const webgpuPreflightRows = preflightOnlyRows(rows, (row) => row.backend === 'webgpu');
  const externalVisualRows = visualProfileRows(rows, (row) => row.backend === 'webgl');

  return [
    coverageEntry({
      id: 'rocm_hip_full_runtime',
      requirement: 'ROCm/HIP full-runtime proof-ledger acceptance',
      status: hipRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: hipRuntimeRows,
      openGaps: hipRuntimeRows.length > 0 ? [] : ['hip_full_runtime_ledger_required'],
    }),
    coverageEntry({
      id: 'flow_visual_gpu_path',
      requirement: 'Flow visual GPU path with runtime proof and visual oracle',
      status: flowRows.length > 0 ? 'accepted' : 'missing',
      rows: flowRows,
      openGaps: flowRows.length > 0 ? [] : ['flow_visual_runtime_proof_required'],
    }),
    coverageEntry({
      id: 'ray_light_visual_gpu_path',
      requirement: 'Ray-light visual GPU path with runtime proof and visual oracle',
      status: rayRows.length > 0 ? 'accepted' : 'missing',
      rows: rayRows,
      openGaps: rayRows.length > 0 ? [] : ['ray_light_visual_runtime_proof_required'],
    }),
    coverageEntry({
      id: 'hiprt_visual_path',
      requirement: 'HIPRT same-process ray-traced visual path',
      status: hiprtRows.length > 0 ? 'accepted' : 'missing',
      rows: hiprtRows,
      openGaps: hiprtRows.length > 0 ? [] : ['hiprt_visual_runtime_proof_required'],
    }),
    coverageEntry({
      id: 'webgpu_scoped_runtime_visual',
      requirement: 'Scoped WebGPU WGSL shader/pipeline runtime visual proof',
      status: webgpuRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: webgpuRuntimeRows,
      openGaps: webgpuRuntimeRows.length > 0 ? [] : ['webgpu_runtime_visual_proof_required'],
    }),
    coverageEntry({
      id: 'webgpu_runtime_preflight',
      requirement: 'WebGPU runtime capability preflight without shader/pipeline overclaim',
      status: webgpuPreflightRows.length > 0 ? 'preflight_only' : 'missing',
      rows: webgpuPreflightRows,
      openGaps: webgpuPreflightRows.length > 0
        ? compactStringList(webgpuPreflightRows.flatMap((row) => row.openGaps))
        : ['webgpu_runtime_preflight_required'],
    }),
    coverageEntry({
      id: 'external_engine_visual_profile',
      requirement: 'At least one larger external engine-style visual profile',
      status: externalVisualRows.length > 0 ? 'visual_profile_only' : 'missing',
      rows: externalVisualRows,
      openGaps: externalVisualRows.length > 0
        ? compactStringList(externalVisualRows.flatMap((row) => row.openGaps))
        : ['external_engine_visual_profile_required'],
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'bevy_file_loaded_wgsl',
      requirement: 'Bevy file-loaded WGSL full-runtime proof',
      acceptedPredicate: (row) => row.backend === 'bevy_wgsl',
      missingGap: 'bevy_full_runtime_ledger_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'oidn_hip_output',
      requirement: 'OIDN HIP output proof on ROCm-compatible runtime',
      acceptedPredicate: (row) => row.backend === 'oidn_hip',
      missingGap: 'oidn_hip_runtime_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'opencl_dispatch_readback',
      requirement: 'OpenCL dispatch/event/readback output proof',
      acceptedPredicate: (row) => row.backend === 'opencl',
      missingGap: 'opencl_dispatch_readback_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'vulkan_pipeline_frame',
      requirement: 'Vulkan pipeline-layout, command-buffer, and frame-output proof',
      acceptedPredicate: (row) => row.backend === 'vulkan',
      missingGap: 'vulkan_pipeline_frame_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'cuda_runtime',
      requirement: 'CUDA runtime proof on CUDA hardware',
      acceptedPredicate: (row) => row.backend === 'cuda',
      missingGap: 'cuda_hardware_required',
    }),
    coverageEntry({
      id: 'per_kernel_smallest_safe_fission',
      requirement: 'Per-kernel or smallest-safe fission verifier proof',
      status: 'missing',
      openGaps: ['deterministic_smallest_safe_fission_verifier_required'],
    }),
  ];
}

export function queryGpuHmrValidationMatrixLedger(ledger = {}) {
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const failures = [];
  if (ledger.schemaVersion !== GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION) {
    failures.push({
      code: 'validation_matrix_schema_mismatch',
      suppliedSchemaVersion: ledger.schemaVersion ?? null,
    });
  }
  if (rows.length === 0) {
    failures.push({ code: 'validation_matrix_rows_empty' });
  }
  rows.forEach((row, index) => {
    if (row.schemaVersion !== GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION) {
      failures.push({ code: 'validation_matrix_row_schema_mismatch', row_index: index });
    }
    for (const failure of rowSafetyFailures(row)) {
      failures.push({ ...failure, row_index: index, targetId: row.targetId });
    }
    if (row.safety?.accepted === false) {
      for (const failure of row.safety.failedGates ?? []) {
        failures.push({ ...failure, row_index: index, targetId: row.targetId });
      }
    }
  });
  const recomputedProofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: rows.map((row) => row.rowId),
    summary: ledger.summary,
  });
  if (ledger.proofId && ledger.proofId !== recomputedProofId) {
    failures.push({
      code: 'validation_matrix_proof_id_mismatch',
      suppliedProofId: ledger.proofId,
      recomputedProofId,
    });
  }
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    proofId: recomputedProofId,
    accepted: failures.length === 0,
    failedGates: failures,
    summary: ledger.summary ?? coverageSummary(rows),
  };
}

export function buildGpuHmrValidationMatrixLedger(rows, options = {}) {
  const selectedRows = options.latestPerTarget === false ? rows : selectBestRows(rows);
  const includedRows = options.includeUnproven === true
    ? selectedRows
    : selectedRows.filter((row) => row.matrixOutcome !== 'unproven');
  const omittedUnprovenRows = selectedRows.length - includedRows.length;
  includedRows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  const summary = {
    ...coverageSummary(includedRows),
    includeUnproven: options.includeUnproven === true,
    omittedUnprovenRows,
  };
  const seed = {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    latestPerTarget: options.latestPerTarget !== false,
    includeUnproven: options.includeUnproven === true,
    sourceRoots: options.sourceRoots ?? [],
    summary,
    rows: includedRows,
  };
  const proofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: seed.schemaVersion,
    rows: includedRows.map((row) => row.rowId),
    summary,
  });
  const ledger = {
    ...seed,
    proofId,
  };
  return {
    ...ledger,
    query: queryGpuHmrValidationMatrixLedger(ledger),
  };
}

export async function collectGpuHmrValidationMatrixLedger(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const mcpRoot = path.resolve(options.mcpRoot ?? path.join(repoRoot, 'mcp', 'synthi-mcp'));
  const roots = options.roots ?? defaultValidationMatrixRoots({ repoRoot, mcpRoot });
  const files = [];
  for (const root of roots) {
    files.push(...await walkJsonFiles(path.resolve(root)));
  }
  const rows = [];
  for (const filePath of files) {
    if (options.includeInvalidated !== true && filePath.split(path.sep).includes('invalidated')) continue;
    const json = await readJson(filePath);
    if (json === null) continue;
    const stat = await fs.stat(filePath);
    const row = await classifyJsonArtifact(json, filePath, {
      repoRoot,
      mcpRoot,
      updatedAt: stat.mtime.toISOString(),
    });
    if (row) rows.push(row);
  }
  return buildGpuHmrValidationMatrixLedger(rows, {
    latestPerTarget: options.latestPerTarget !== false,
    includeUnproven: options.includeUnproven === true,
    sourceRoots: roots.map((root) => relPath(root, repoRoot)),
    generatedAt: options.generatedAt,
  });
}
