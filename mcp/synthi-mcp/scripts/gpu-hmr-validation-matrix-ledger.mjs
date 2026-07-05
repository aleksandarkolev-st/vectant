#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  selfCheckGenericOutputOracleLedger,
} from './lib/gpu-hmr-validation-matrix-ledger.mjs';

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const mcpRoot = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(mcpRoot, '..', '..');

function parseArgs(argv) {
  const args = {
    outputDir: path.join(mcpRoot, '.gpu-hmr-test-logs', 'validation-matrix'),
    format: 'both',
    latestPerTarget: true,
    includeInvalidated: false,
    includeUnproven: false,
    outputOracleSelfCheck: false,
    selfCheck: false,
    roots: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      args.latestPerTarget = false;
    } else if (arg === '--include-invalidated') {
      args.includeInvalidated = true;
    } else if (arg === '--include-unproven') {
      args.includeUnproven = true;
    } else if (arg === '--format') {
      args.format = argv[++i] ?? args.format;
    } else if (arg === '--output-dir') {
      args.outputDir = path.resolve(argv[++i] ?? args.outputDir);
    } else if (arg === '--root') {
      const root = argv[++i];
      if (!root) throw new Error('--root requires a directory');
      args.roots.push(path.resolve(root));
    } else if (arg === '--self-check') {
      args.selfCheck = true;
    } else if (arg === '--output-oracle-self-check') {
      args.outputOracleSelfCheck = true;
    } else if (arg === '--help') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/gpu-hmr-validation-matrix-ledger.mjs [--all] [--include-invalidated] [--include-unproven] [--format json|markdown|both] [--output-dir DIR] [--root DIR] [--self-check] [--output-oracle-self-check]',
    '',
    'Collects GPU HMR proof artifacts into a matrix ledger. The collector records accepted full-runtime proof, visual-profile proof, preflight-only evidence, and structured refusals separately.',
    'When --root is provided one or more times, collection is restricted to those artifact roots.',
  ].join('\n');
}

function value(input) {
  if (input === null || input === undefined || input === '') return '';
  if (Array.isArray(input)) return input.join(', ');
  return String(input).replace(/\|/g, '\\|');
}

function markdownTable(rows) {
  const columns = [
    'backend',
    'targetId',
    'proofMode',
    'matrixOutcome',
    'acceptedForGpuHmr',
    'acceptanceScope',
    'claimScope',
    'supportedPipelineScope',
    'validationTargetScope',
    'visualProfileAccepted',
    'refusalProven',
    'safetyAccepted',
    'proofChain',
    'ledgerProofId',
    'changedPixelRatio',
    'openGaps',
  ];
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    const compact = {
      ...row,
      ledgerProofId: row.ledger?.proofId ?? null,
      changedPixelRatio: row.visual?.changedPixelRatio ?? null,
      safetyAccepted: row.safety?.accepted ?? null,
      openGaps: row.openGaps ?? [],
    };
    return `| ${columns.map((column) => value(compact[column])).join(' | ')} |`;
  });
  return [
    '# GPU HMR Validation Matrix Ledger',
    '',
    `Schema: \`${GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION}\``,
    '',
    header,
    divider,
    ...body,
    '',
  ].join('\n');
}

const MATRIX_JSON_OUTPUT_ARRAY_ENTRY_LIMIT = 200;
const MATRIX_JSON_OUTPUT_ARRAY_SAMPLE_LIMIT = 32;
const MATRIX_JSON_OUTPUT_STRING_LIMIT = 256 * 1024;
const MATRIX_JSON_OUTPUT_STRING_PREFIX_LIMIT = 4096;
const MATRIX_JSON_OUTPUT_DETAIL_SCHEMA_VERSION =
  'synthi.gpu_hmr.validation_matrix_row_detail.v1';
const MATRIX_JSON_OUTPUT_DETAIL_REF_SCHEMA_VERSION =
  'synthi.gpu_hmr.validation_matrix_row_detail_ref.v1';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function matrixOutputProjectionHash(value) {
  if (Array.isArray(value)) {
    const hash = createHash('sha256');
    hash.update(`array:${value.length}:`);
    for (const entry of value) {
      hash.update(sha256Hex(JSON.stringify(entry)));
      hash.update('\n');
    }
    return `sha256:${hash.digest('hex')}`;
  }
  return `sha256:${sha256Hex(JSON.stringify(value))}`;
}

function firstBool(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
  }
  return null;
}

function isMatrixRowLike(value) {
  return value
    && typeof value === 'object'
    && (
      typeof value.rowId === 'string'
      || typeof value.row_id === 'string'
      || typeof value.matrixOutcome === 'string'
      || typeof value.matrix_outcome === 'string'
    );
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function arrayField(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function compactObjectField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function safePathSegment(value) {
  const text = String(value ?? 'row');
  const normalized = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || 'row').slice(0, 96);
}

function compactMatrixRowRefForJsonOutput(row = {}, detailRef = null) {
  const acceptedForGpuHmr = firstBool(row.acceptedForGpuHmr, row.accepted_for_gpu_hmr) === true;
  const gpuHmrSuccess = firstBool(row.gpuHmrSuccess, row.gpu_hmr_success) === true;
  const safetyAccepted = firstBool(row.safety?.accepted, row.safety_accepted) === true;
  const proofIds = arrayField(row.proofIds, row.proof_ids);
  const openGaps = arrayField(row.openGaps, row.open_gaps);
  const reasons = arrayField(row.reasons, row.reasonCodes, row.reason_codes);
  const visual = compactObjectField(row.visual) ?? {};
  const ledger = compactObjectField(row.ledger) ?? {};
  const runtimeProof = compactObjectField(row.runtimeProof) ?? compactObjectField(row.runtime_proof) ?? {};
  const compact = {
    schemaVersion: 'synthi.gpu_hmr.validation_matrix_row_json_projection.v1',
    schema_version: 'synthi.gpu_hmr.validation_matrix_row_json_projection.v1',
    rowId: row.rowId ?? row.row_id ?? null,
    row_id: row.rowId ?? row.row_id ?? null,
    matrixKey: row.matrixKey ?? row.matrix_key ?? null,
    matrix_key: row.matrixKey ?? row.matrix_key ?? null,
    attemptKey: row.attemptKey ?? row.attempt_key ?? null,
    attempt_key: row.attemptKey ?? row.attempt_key ?? null,
    artifactPath: row.artifactPath ?? row.artifact_path ?? null,
    artifact_path: row.artifactPath ?? row.artifact_path ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    updated_at: row.updatedAt ?? row.updated_at ?? null,
    backend: row.backend ?? null,
    targetId: row.targetId ?? row.target_id ?? null,
    target_id: row.targetId ?? row.target_id ?? null,
    profileId: row.profileId ?? row.profile_id ?? null,
    profile_id: row.profileId ?? row.profile_id ?? null,
    proofMode: row.proofMode ?? row.proof_mode ?? null,
    proof_mode: row.proofMode ?? row.proof_mode ?? null,
    evidenceKind: row.evidenceKind ?? row.evidence_kind ?? null,
    evidence_kind: row.evidenceKind ?? row.evidence_kind ?? null,
    matrixOutcome: row.matrixOutcome ?? row.matrix_outcome ?? null,
    matrix_outcome: row.matrixOutcome ?? row.matrix_outcome ?? null,
    acceptanceClass: row.acceptanceClass ?? row.acceptance_class ?? null,
    acceptance_class: row.acceptanceClass ?? row.acceptance_class ?? null,
    acceptanceScope: row.acceptanceScope ?? row.acceptance_scope ?? null,
    acceptance_scope: row.acceptanceScope ?? row.acceptance_scope ?? null,
    claimScope: row.claimScope ?? row.claim_scope ?? null,
    claim_scope: row.claimScope ?? row.claim_scope ?? null,
    supportedPipelineScope: row.supportedPipelineScope ?? row.supported_pipeline_scope ?? null,
    supported_pipeline_scope: row.supportedPipelineScope ?? row.supported_pipeline_scope ?? null,
    validationTargetScope: row.validationTargetScope ?? row.validation_target_scope ?? null,
    validation_target_scope: row.validationTargetScope ?? row.validation_target_scope ?? null,
    acceptedForGpuHmr,
    accepted_for_gpu_hmr: acceptedForGpuHmr,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
    visualProfileAccepted: firstBool(row.visualProfileAccepted, row.visual_profile_accepted) === true,
    visual_profile_accepted: firstBool(row.visualProfileAccepted, row.visual_profile_accepted) === true,
    refusalProven: firstBool(row.refusalProven, row.refusal_proven) === true,
    refusal_proven: firstBool(row.refusalProven, row.refusal_proven) === true,
    proofChainAccepted: firstBool(row.proofChainAccepted, row.proof_chain_accepted) === true,
    proof_chain_accepted: firstBool(row.proofChainAccepted, row.proof_chain_accepted) === true,
    proofChain: row.proofChain ?? row.proof_chain ?? null,
    proof_chain: row.proofChain ?? row.proof_chain ?? null,
    ledgerProofId: firstDefined(row.ledgerProofId, row.ledger_proof_id, ledger.proofId, ledger.proof_id),
    ledger_proof_id: firstDefined(row.ledgerProofId, row.ledger_proof_id, ledger.proofId, ledger.proof_id),
    runtimeProofId: firstDefined(
      row.runtimeProofId,
      row.runtime_proof_id,
      runtimeProof.proofId,
      runtimeProof.proof_id,
    ),
    runtime_proof_id: firstDefined(
      row.runtimeProofId,
      row.runtime_proof_id,
      runtimeProof.proofId,
      runtimeProof.proof_id,
    ),
    changedPixelRatio: firstDefined(row.changedPixelRatio, row.changed_pixel_ratio, visual.changedPixelRatio),
    changed_pixel_ratio: firstDefined(row.changedPixelRatio, row.changed_pixel_ratio, visual.changedPixelRatio),
    safetyAccepted,
    safety_accepted: safetyAccepted,
    proofIds,
    proof_ids: proofIds,
    reasons,
    reason_codes: reasons,
    openGaps,
    open_gaps: openGaps,
    sourceTreeIntakeAccepted:
      firstBool(row.sourceTreeIntakeAccepted, row.source_tree_intake_accepted) === true,
    source_tree_intake_accepted:
      firstBool(row.sourceTreeIntakeAccepted, row.source_tree_intake_accepted) === true,
    sourceRelevantFileCount:
      firstDefined(row.sourceRelevantFileCount, row.source_relevant_file_count),
    source_relevant_file_count:
      firstDefined(row.sourceRelevantFileCount, row.source_relevant_file_count),
    gpuSourceFileCount:
      firstDefined(row.gpuSourceFileCount, row.gpu_source_file_count),
    gpu_source_file_count:
      firstDefined(row.gpuSourceFileCount, row.gpu_source_file_count),
    runtimeBoundaryEventManifestTemplateAccepted:
      firstBool(
        row.runtimeBoundaryEventManifestTemplateAccepted,
        row.runtime_boundary_event_manifest_template_accepted,
      ) === true,
    runtime_boundary_event_manifest_template_accepted:
      firstBool(
        row.runtimeBoundaryEventManifestTemplateAccepted,
        row.runtime_boundary_event_manifest_template_accepted,
      ) === true,
    outputProjection: {
      schemaVersion: 'synthi.gpu_hmr.validation_matrix_row_json_projection.v1',
      schema_version: 'synthi.gpu_hmr.validation_matrix_row_json_projection.v1',
      proofAuthority: 'cli_row_json_projection_only_not_gpu_hmr_acceptance',
      proof_authority: 'cli_row_json_projection_only_not_gpu_hmr_acceptance',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
    },
  };
  compact.output_projection = compact.outputProjection;
  if (detailRef) {
    compact.detailRef = detailRef;
    compact.detail_ref = detailRef;
  }
  return compact;
}

function compactMatrixRowTinyRefForJsonOutput(row = {}) {
  const acceptedForGpuHmr = firstBool(row.acceptedForGpuHmr, row.accepted_for_gpu_hmr) === true;
  const gpuHmrSuccess = firstBool(row.gpuHmrSuccess, row.gpu_hmr_success) === true;
  const proofIds = arrayField(row.proofIds, row.proof_ids);
  return {
    rowId: row.rowId ?? row.row_id ?? null,
    row_id: row.rowId ?? row.row_id ?? null,
    backend: row.backend ?? null,
    targetId: row.targetId ?? row.target_id ?? null,
    target_id: row.targetId ?? row.target_id ?? null,
    proofMode: row.proofMode ?? row.proof_mode ?? null,
    proof_mode: row.proofMode ?? row.proof_mode ?? null,
    matrixOutcome: row.matrixOutcome ?? row.matrix_outcome ?? null,
    matrix_outcome: row.matrixOutcome ?? row.matrix_outcome ?? null,
    acceptanceScope: row.acceptanceScope ?? row.acceptance_scope ?? null,
    acceptance_scope: row.acceptanceScope ?? row.acceptance_scope ?? null,
    acceptedForGpuHmr,
    accepted_for_gpu_hmr: acceptedForGpuHmr,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
    proofIds,
    proof_ids: proofIds,
  };
}

function matrixRowForJsonOutput(row = {}, detailRef = null) {
  return compactMatrixRowRefForJsonOutput(row, detailRef);
}

function matrixOutputJsonReplacer(key, value) {
  if (
    Array.isArray(value)
    && (
      key === 'rows'
      || key === 'matrixGeneralizationRowRefs'
      || key === 'matrix_generalization_row_refs'
      || key === 'rowRefs'
      || key === 'row_refs'
      || (key !== 'rows' && key !== 'refs' && value.some(isMatrixRowLike))
    )
  ) {
    if (key === 'rows') return value;
    const contentHash = matrixOutputProjectionHash(value);
    const refs = value.map((row) => compactMatrixRowRefForJsonOutput(row));
    return {
      truncatedForMatrixOutput: true,
      truncated_for_matrix_output: true,
      originalEntryCount: value.length,
      original_entry_count: value.length,
      contentHash,
      content_hash: contentHash,
      refs,
    };
  }
  if (
    Array.isArray(value)
    && value.length > MATRIX_JSON_OUTPUT_ARRAY_ENTRY_LIMIT
    && key !== 'rows'
  ) {
    const contentHash = matrixOutputProjectionHash(value);
    const sampleEntryCount = Math.min(value.length, MATRIX_JSON_OUTPUT_ARRAY_SAMPLE_LIMIT);
    return {
      truncatedForMatrixOutput: true,
      truncated_for_matrix_output: true,
      originalEntryCount: value.length,
      original_entry_count: value.length,
      sampleEntryCount,
      sample_entry_count: sampleEntryCount,
      contentHash,
      content_hash: contentHash,
      sample: value.slice(0, MATRIX_JSON_OUTPUT_ARRAY_SAMPLE_LIMIT),
    };
  }
  if (typeof value === 'string' && value.length > MATRIX_JSON_OUTPUT_STRING_LIMIT) {
    const contentHash = `sha256:${sha256Hex(value)}`;
    const originalByteLength = Buffer.byteLength(value);
    return {
      truncatedForMatrixOutput: true,
      truncated_for_matrix_output: true,
      originalByteLength,
      original_byte_length: originalByteLength,
      contentHash,
      content_hash: contentHash,
      prefix: value.slice(0, MATRIX_JSON_OUTPUT_STRING_PREFIX_LIMIT),
    };
  }
  return value;
}

function matrixRowDetailPayload(row, ledger) {
  return {
    schemaVersion: MATRIX_JSON_OUTPUT_DETAIL_SCHEMA_VERSION,
    schema_version: MATRIX_JSON_OUTPUT_DETAIL_SCHEMA_VERSION,
    proofAuthority: 'validation_matrix_row_detail_transport_only_not_gpu_hmr_acceptance',
    proof_authority: 'validation_matrix_row_detail_transport_only_not_gpu_hmr_acceptance',
    ledgerProofId: ledger.proofId,
    ledger_proof_id: ledger.proofId,
    rowId: row.rowId ?? row.row_id ?? null,
    row_id: row.rowId ?? row.row_id ?? null,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    row,
  };
}

async function writeMatrixRowDetailSidecars(ledger, args, stamp) {
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  if (rows.length === 0) return { refsByRowId: new Map(), manifest: null };
  const detailDirName = `gpu-hmr-validation-matrix-${stamp}-rows`;
  const detailDir = path.join(args.outputDir, detailDirName);
  await fs.mkdir(detailDir, { recursive: true });
  const refs = [];
  const refsByRowId = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowId = row?.rowId ?? row?.row_id ?? `row-${index + 1}`;
    const fileName = `${String(index + 1).padStart(4, '0')}-${safePathSegment(rowId)}-${sha256Hex(rowId).slice(0, 16)}.json`;
    const detailPath = path.join(detailDir, fileName);
    const detailPayload = matrixRowDetailPayload(row, ledger);
    const detailJson = `${JSON.stringify(detailPayload, matrixOutputJsonReplacer, 2)}\n`;
    await fs.writeFile(detailPath, detailJson);
    const detailHash = `sha256:${sha256Hex(detailJson)}`;
    const byteLength = Buffer.byteLength(detailJson);
    const relativePath = path.relative(args.outputDir, detailPath).split(path.sep).join('/');
    const ref = {
      schemaVersion: MATRIX_JSON_OUTPUT_DETAIL_REF_SCHEMA_VERSION,
      schema_version: MATRIX_JSON_OUTPUT_DETAIL_REF_SCHEMA_VERSION,
      proofAuthority: 'row_detail_transport_only_not_gpu_hmr_acceptance',
      proof_authority: 'row_detail_transport_only_not_gpu_hmr_acceptance',
      rowId,
      row_id: rowId,
      rowDetailPath: relativePath,
      row_detail_path: relativePath,
      rowDetailHash: detailHash,
      row_detail_hash: detailHash,
      byteLength,
      byte_length: byteLength,
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
    };
    refs.push(ref);
    refsByRowId.set(rowId, ref);
  }
  const manifestHash = matrixOutputProjectionHash(refs);
  const manifest = {
    schemaVersion: 'synthi.gpu_hmr.validation_matrix_row_detail_manifest.v1',
    schema_version: 'synthi.gpu_hmr.validation_matrix_row_detail_manifest.v1',
    proofAuthority: 'row_detail_manifest_transport_only_not_gpu_hmr_acceptance',
    proof_authority: 'row_detail_manifest_transport_only_not_gpu_hmr_acceptance',
    directory: detailDirName,
    rowCount: refs.length,
    row_count: refs.length,
    manifestHash,
    manifest_hash: manifestHash,
    refs,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
  };
  return { refsByRowId, manifest };
}

function matrixLedgerForJsonOutput(ledger, rowDetailRefsById = new Map(), rowDetailManifest = null) {
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const summary = matrixSummaryForJsonOutput(ledger.summary);
  const attemptHistory = matrixAttemptHistoryForJsonOutput(ledger.attemptHistory);
  return {
    ...ledger,
    summary,
    attemptHistory,
    attempt_history: attemptHistory,
    rows: rows.map((row) => {
      const rowId = row?.rowId ?? row?.row_id ?? null;
      return matrixRowForJsonOutput(row, rowId ? rowDetailRefsById.get(rowId) : null);
    }),
    query: matrixQueryForJsonOutput(ledger.query, summary, attemptHistory),
    rowDetailManifest,
    row_detail_manifest: rowDetailManifest,
    outputProjection: {
      schemaVersion: 'synthi.gpu_hmr.validation_matrix_json_output_projection.v1',
      schema_version: 'synthi.gpu_hmr.validation_matrix_json_output_projection.v1',
      proofAuthority: 'cli_json_size_projection_only_not_gpu_hmr_acceptance',
      proof_authority: 'cli_json_size_projection_only_not_gpu_hmr_acceptance',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
      arrayEntryLimit: MATRIX_JSON_OUTPUT_ARRAY_ENTRY_LIMIT,
      array_entry_limit: MATRIX_JSON_OUTPUT_ARRAY_ENTRY_LIMIT,
      stringByteLimit: MATRIX_JSON_OUTPUT_STRING_LIMIT,
      string_byte_limit: MATRIX_JSON_OUTPUT_STRING_LIMIT,
      rowDetailSidecars: rowDetailManifest !== null,
      row_detail_sidecars: rowDetailManifest !== null,
    },
  };
}

function compactCoverageRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => compactMatrixRowTinyRefForJsonOutput(row));
}

function compactPrimitiveArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) =>
    entry === null
    || typeof entry === 'string'
    || typeof entry === 'number'
    || typeof entry === 'boolean'
  );
}

function compactPrimitiveArraySample(value, limit = 32) {
  const entries = compactPrimitiveArray(value);
  return {
    entries: entries.slice(0, limit),
    count: entries.length,
    truncated: entries.length > limit,
    contentHash: entries.length > limit ? matrixOutputProjectionHash(entries) : null,
  };
}

function compactPlanCoverageEntry(entry = {}) {
  const rows = compactCoverageRows(entry.rows);
  const openGaps = compactPrimitiveArraySample(entry.openGaps ?? entry.open_gaps, 32);
  return {
    id: entry.id ?? null,
    requirement: entry.requirement ?? null,
    status: entry.status ?? null,
    claimScope: entry.claimScope ?? entry.claim_scope ?? null,
    claim_scope: entry.claimScope ?? entry.claim_scope ?? null,
    acceptanceScopes: compactPrimitiveArray(entry.acceptanceScopes ?? entry.acceptance_scopes),
    acceptance_scopes: compactPrimitiveArray(entry.acceptanceScopes ?? entry.acceptance_scopes),
    rowCount: Number.isSafeInteger(Number(entry.rowCount ?? entry.row_count))
      ? Number(entry.rowCount ?? entry.row_count)
      : rows.length,
    row_count: Number.isSafeInteger(Number(entry.rowCount ?? entry.row_count))
      ? Number(entry.rowCount ?? entry.row_count)
      : rows.length,
    openGaps: openGaps.entries,
    open_gaps: openGaps.entries,
    openGapCount: openGaps.count,
    open_gap_count: openGaps.count,
    openGapsTruncated: openGaps.truncated,
    open_gaps_truncated: openGaps.truncated,
    openGapsHash: openGaps.contentHash,
    open_gaps_hash: openGaps.contentHash,
    rows,
  };
}

function compactBroadLibraryAgnosticReadiness(readiness = {}) {
  if (!readiness || typeof readiness !== 'object') return null;
  const broadProof =
    compactObjectField(readiness.broadLibraryAgnosticProof ?? readiness.broad_library_agnostic_proof)
    ?? {};
  const proofId = readiness.proofId
    ?? readiness.proof_id
    ?? broadProof.proofId
    ?? broadProof.proof_id
    ?? null;
  const proofAuthority = readiness.proofAuthority
    ?? readiness.proof_authority
    ?? readiness.authority
    ?? broadProof.proofAuthority
    ?? broadProof.proof_authority
    ?? broadProof.authority
    ?? null;
  const numberField = (...values) => {
    for (const value of values) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  };
  const openGaps = compactPrimitiveArraySample(
    readiness.openGaps ?? readiness.open_gaps ?? broadProof.openGaps ?? broadProof.open_gaps,
    32,
  );
  const failedGates = compactPrimitiveArraySample(
    readiness.failedGates ?? readiness.failed_gates,
    32,
  );
  const randomColdPathTargets = compactPrimitiveArraySample(
    readiness.randomColdPathTargets
      ?? readiness.random_cold_path_targets
      ?? broadProof.randomColdPathTargets
      ?? broadProof.random_cold_path_targets,
    32,
  );
  const randomColdPathSourceHashes = compactPrimitiveArraySample(
    readiness.randomColdPathDistinctSourceIdentityHashes
      ?? readiness.random_cold_path_distinct_source_identity_hashes
      ?? broadProof.randomColdPathDistinctSourceIdentityHashes
      ?? broadProof.random_cold_path_distinct_source_identity_hashes,
    32,
  );
  const randomColdPathContentOnlyHashes = compactPrimitiveArraySample(
    readiness.randomColdPathDistinctSourceContentOnlyIdentityHashes
      ?? readiness.random_cold_path_distinct_source_content_only_identity_hashes
      ?? broadProof.randomColdPathDistinctSourceContentOnlyIdentityHashes
      ?? broadProof.random_cold_path_distinct_source_content_only_identity_hashes,
    32,
  );
  const sourceFirstVisualSourceHashes = compactPrimitiveArraySample(
    readiness.sourceFirstVisualSourceIdentityHashes
      ?? readiness.source_first_visual_source_identity_hashes
      ?? broadProof.sourceFirstVisualSourceIdentityHashes
      ?? broadProof.source_first_visual_source_identity_hashes,
    32,
  );
  return {
    schemaVersion: readiness.schemaVersion ?? readiness.schema_version ?? null,
    schema_version: readiness.schemaVersion ?? readiness.schema_version ?? null,
    accepted: firstBool(readiness.accepted) === true,
    proofId,
    proof_id: proofId,
    proofAuthority,
    proof_authority: proofAuthority,
    matrixGeneralizationAccepted:
      firstBool(readiness.matrixGeneralizationAccepted, readiness.matrix_generalization_accepted)
      ?? null,
    matrix_generalization_accepted:
      firstBool(readiness.matrixGeneralizationAccepted, readiness.matrix_generalization_accepted)
      ?? null,
    acceptedFullRuntimeRows:
      numberField(readiness.acceptedFullRuntimeRows, readiness.accepted_full_runtime_rows),
    accepted_full_runtime_rows:
      numberField(readiness.acceptedFullRuntimeRows, readiness.accepted_full_runtime_rows),
    matrixGeneralizationRuntimeRows:
      numberField(
        readiness.matrixGeneralizationRuntimeRows,
        readiness.matrix_generalization_runtime_rows,
        broadProof.matrixGeneralizationRuntimeRows,
        broadProof.matrix_generalization_runtime_rows,
      ),
    matrix_generalization_runtime_rows:
      numberField(
        readiness.matrixGeneralizationRuntimeRows,
        readiness.matrix_generalization_runtime_rows,
        broadProof.matrixGeneralizationRuntimeRows,
        broadProof.matrix_generalization_runtime_rows,
      ),
    scopedRuntimeRows: numberField(readiness.scopedRuntimeRows, readiness.scoped_runtime_rows),
    scoped_runtime_rows: numberField(readiness.scopedRuntimeRows, readiness.scoped_runtime_rows),
    backendFamilies: compactPrimitiveArray(readiness.backendFamilies ?? readiness.backend_families),
    backend_families: compactPrimitiveArray(readiness.backendFamilies ?? readiness.backend_families),
    acceptanceScopes: compactPrimitiveArray(readiness.acceptanceScopes ?? readiness.acceptance_scopes),
    acceptance_scopes: compactPrimitiveArray(readiness.acceptanceScopes ?? readiness.acceptance_scopes),
    visualOracleScopes: compactPrimitiveArray(readiness.visualOracleScopes ?? readiness.visual_oracle_scopes),
    visual_oracle_scopes: compactPrimitiveArray(readiness.visualOracleScopes ?? readiness.visual_oracle_scopes),
    computeOracleScopes: compactPrimitiveArray(readiness.computeOracleScopes ?? readiness.compute_oracle_scopes),
    compute_oracle_scopes: compactPrimitiveArray(readiness.computeOracleScopes ?? readiness.compute_oracle_scopes),
    adversarialRefusalRows:
      Number.isSafeInteger(Number(readiness.adversarialRefusalRows ?? readiness.adversarial_refusal_rows))
        ? Number(readiness.adversarialRefusalRows ?? readiness.adversarial_refusal_rows)
        : null,
    adversarial_refusal_rows:
      Number.isSafeInteger(Number(readiness.adversarialRefusalRows ?? readiness.adversarial_refusal_rows))
        ? Number(readiness.adversarialRefusalRows ?? readiness.adversarial_refusal_rows)
        : null,
    randomColdPathRowCount:
      numberField(readiness.randomColdPathRowCount, readiness.random_cold_path_row_count),
    random_cold_path_row_count:
      numberField(readiness.randomColdPathRowCount, readiness.random_cold_path_row_count),
    randomColdPathCandidateRowCount:
      numberField(
        readiness.randomColdPathCandidateRowCount,
        readiness.random_cold_path_candidate_row_count,
        broadProof.randomColdPathCandidateRows,
        broadProof.random_cold_path_candidate_rows,
      ),
    random_cold_path_candidate_row_count:
      numberField(
        readiness.randomColdPathCandidateRowCount,
        readiness.random_cold_path_candidate_row_count,
        broadProof.randomColdPathCandidateRows,
        broadProof.random_cold_path_candidate_rows,
      ),
    randomColdPathDistinctSourceIdentityCount:
      numberField(
        readiness.randomColdPathDistinctSourceIdentityCount,
        readiness.random_cold_path_distinct_source_identity_count,
        broadProof.randomColdPathDistinctSourceIdentityCount,
        broadProof.random_cold_path_distinct_source_identity_count,
      ),
    random_cold_path_distinct_source_identity_count:
      numberField(
        readiness.randomColdPathDistinctSourceIdentityCount,
        readiness.random_cold_path_distinct_source_identity_count,
        broadProof.randomColdPathDistinctSourceIdentityCount,
        broadProof.random_cold_path_distinct_source_identity_count,
      ),
    randomColdPathDistinctSourceContentOnlyIdentityCount:
      numberField(
        readiness.randomColdPathDistinctSourceContentOnlyIdentityCount,
        readiness.random_cold_path_distinct_source_content_only_identity_count,
        broadProof.randomColdPathDistinctSourceContentOnlyIdentityCount,
        broadProof.random_cold_path_distinct_source_content_only_identity_count,
      ),
    random_cold_path_distinct_source_content_only_identity_count:
      numberField(
        readiness.randomColdPathDistinctSourceContentOnlyIdentityCount,
        readiness.random_cold_path_distinct_source_content_only_identity_count,
        broadProof.randomColdPathDistinctSourceContentOnlyIdentityCount,
        broadProof.random_cold_path_distinct_source_content_only_identity_count,
      ),
    minimumRandomColdPathDistinctSourceIdentityCount:
      numberField(
        readiness.minimumRandomColdPathDistinctSourceIdentityCount,
        readiness.minimum_random_cold_path_distinct_source_identity_count,
        broadProof.minimumRandomColdPathDistinctSourceIdentityCount,
        broadProof.minimum_random_cold_path_distinct_source_identity_count,
      ),
    minimum_random_cold_path_distinct_source_identity_count:
      numberField(
        readiness.minimumRandomColdPathDistinctSourceIdentityCount,
        readiness.minimum_random_cold_path_distinct_source_identity_count,
        broadProof.minimumRandomColdPathDistinctSourceIdentityCount,
        broadProof.minimum_random_cold_path_distinct_source_identity_count,
      ),
    minimumRandomColdPathDistinctSourceContentOnlyIdentityCount:
      numberField(
        readiness.minimumRandomColdPathDistinctSourceContentOnlyIdentityCount,
        readiness.minimum_random_cold_path_distinct_source_content_only_identity_count,
      ),
    minimum_random_cold_path_distinct_source_content_only_identity_count:
      numberField(
        readiness.minimumRandomColdPathDistinctSourceContentOnlyIdentityCount,
        readiness.minimum_random_cold_path_distinct_source_content_only_identity_count,
      ),
    randomColdPathTargets: randomColdPathTargets.entries,
    random_cold_path_targets: randomColdPathTargets.entries,
    randomColdPathTargetsCount: randomColdPathTargets.count,
    random_cold_path_targets_count: randomColdPathTargets.count,
    randomColdPathTargetsTruncated: randomColdPathTargets.truncated,
    random_cold_path_targets_truncated: randomColdPathTargets.truncated,
    randomColdPathTargetsHash: randomColdPathTargets.contentHash,
    random_cold_path_targets_hash: randomColdPathTargets.contentHash,
    randomColdPathDistinctSourceIdentityHashes: randomColdPathSourceHashes.entries,
    random_cold_path_distinct_source_identity_hashes: randomColdPathSourceHashes.entries,
    randomColdPathDistinctSourceIdentityHashesCount: randomColdPathSourceHashes.count,
    random_cold_path_distinct_source_identity_hashes_count: randomColdPathSourceHashes.count,
    randomColdPathDistinctSourceIdentityHashesTruncated: randomColdPathSourceHashes.truncated,
    random_cold_path_distinct_source_identity_hashes_truncated: randomColdPathSourceHashes.truncated,
    randomColdPathDistinctSourceIdentityHashesHash: randomColdPathSourceHashes.contentHash,
    random_cold_path_distinct_source_identity_hashes_hash: randomColdPathSourceHashes.contentHash,
    randomColdPathDistinctSourceContentOnlyIdentityHashes:
      randomColdPathContentOnlyHashes.entries,
    random_cold_path_distinct_source_content_only_identity_hashes:
      randomColdPathContentOnlyHashes.entries,
    randomColdPathDistinctSourceContentOnlyIdentityHashesCount:
      randomColdPathContentOnlyHashes.count,
    random_cold_path_distinct_source_content_only_identity_hashes_count:
      randomColdPathContentOnlyHashes.count,
    randomColdPathDistinctSourceContentOnlyIdentityHashesTruncated:
      randomColdPathContentOnlyHashes.truncated,
    random_cold_path_distinct_source_content_only_identity_hashes_truncated:
      randomColdPathContentOnlyHashes.truncated,
    randomColdPathDistinctSourceContentOnlyIdentityHashesHash:
      randomColdPathContentOnlyHashes.contentHash,
    random_cold_path_distinct_source_content_only_identity_hashes_hash:
      randomColdPathContentOnlyHashes.contentHash,
    sourceFirstVisualRowCount:
      numberField(readiness.sourceFirstVisualRowCount, readiness.source_first_visual_row_count),
    source_first_visual_row_count:
      numberField(readiness.sourceFirstVisualRowCount, readiness.source_first_visual_row_count),
    sourceFirstVisualSourceIdentityCount:
      numberField(
        readiness.sourceFirstVisualSourceIdentityCount,
        readiness.source_first_visual_source_identity_count,
      ),
    source_first_visual_source_identity_count:
      numberField(
        readiness.sourceFirstVisualSourceIdentityCount,
        readiness.source_first_visual_source_identity_count,
      ),
    sourceFirstVisualSourceIdentityHashes: sourceFirstVisualSourceHashes.entries,
    source_first_visual_source_identity_hashes: sourceFirstVisualSourceHashes.entries,
    sourceFirstVisualSourceIdentityHashesCount: sourceFirstVisualSourceHashes.count,
    source_first_visual_source_identity_hashes_count: sourceFirstVisualSourceHashes.count,
    sourceFirstVisualSourceIdentityHashesTruncated: sourceFirstVisualSourceHashes.truncated,
    source_first_visual_source_identity_hashes_truncated: sourceFirstVisualSourceHashes.truncated,
    sourceFirstVisualSourceIdentityHashesHash: sourceFirstVisualSourceHashes.contentHash,
    source_first_visual_source_identity_hashes_hash: sourceFirstVisualSourceHashes.contentHash,
    openGaps: openGaps.entries,
    open_gaps: openGaps.entries,
    openGapsCount: openGaps.count,
    open_gaps_count: openGaps.count,
    openGapsTruncated: openGaps.truncated,
    open_gaps_truncated: openGaps.truncated,
    openGapsHash: openGaps.contentHash,
    open_gaps_hash: openGaps.contentHash,
    failedGates: failedGates.entries,
    failed_gates: failedGates.entries,
    failedGatesCount: failedGates.count,
    failed_gates_count: failedGates.count,
    failedGatesTruncated: failedGates.truncated,
    failed_gates_truncated: failedGates.truncated,
    failedGatesHash: failedGates.contentHash,
    failed_gates_hash: failedGates.contentHash,
    rowRefs: compactCoverageRows(readiness.rowRefs ?? readiness.row_refs ?? readiness.rows),
    row_refs: compactCoverageRows(readiness.rowRefs ?? readiness.row_refs ?? readiness.rows),
  };
}

function matrixSummaryForJsonOutput(summary = {}) {
  const refusalTargets = compactPrimitiveArraySample(summary.refusalTargets, 80);
  return {
    schemaVersion: 'synthi.gpu_hmr.validation_matrix_summary_json_projection.v1',
    schema_version: 'synthi.gpu_hmr.validation_matrix_summary_json_projection.v1',
    rowCount: summary.rowCount,
    byOutcome: summary.byOutcome,
    byBackend: summary.byBackend,
    acceptedFullRuntimeGpuHmrRows: summary.acceptedFullRuntimeGpuHmrRows,
    acceptedFullRuntimeTargets: summary.acceptedFullRuntimeTargets,
    acceptedFullRuntimeClaimScopeBreakdown: summary.acceptedFullRuntimeClaimScopeBreakdown,
    broadFullRuntimeGpuHmrRows: summary.broadFullRuntimeGpuHmrRows,
    broadFullRuntimeTargets: summary.broadFullRuntimeTargets,
    scopedFullRuntimeGpuHmrRows: summary.scopedFullRuntimeGpuHmrRows,
    scopedFullRuntimeTargets: summary.scopedFullRuntimeTargets,
    allFullRuntimeGpuHmrRows: summary.allFullRuntimeGpuHmrRows,
    allFullRuntimeTargets: summary.allFullRuntimeTargets,
    fullRuntimeScopeBreakdown: summary.fullRuntimeScopeBreakdown,
    fullRuntimeGeneralityBreakdown: summary.fullRuntimeGeneralityBreakdown,
    visualProfileAcceptedRows: summary.visualProfileAcceptedRows,
    visualProfileTargets: summary.visualProfileTargets,
    refusalProvenRows: summary.refusalProvenRows,
    refusalTargets: refusalTargets.entries,
    refusal_targets: refusalTargets.entries,
    refusalTargetCount: refusalTargets.count,
    refusal_target_count: refusalTargets.count,
    refusalTargetsTruncated: refusalTargets.truncated,
    refusal_targets_truncated: refusalTargets.truncated,
    refusalTargetsHash: refusalTargets.contentHash,
    refusal_targets_hash: refusalTargets.contentHash,
    preflightOnlyRows: summary.preflightOnlyRows,
    preflightOnlyTargets: summary.preflightOnlyTargets,
    unprovenRows: summary.unprovenRows,
    unprovenTargets: summary.unprovenTargets,
    broadLibraryAgnosticReadiness:
      compactBroadLibraryAgnosticReadiness(summary.broadLibraryAgnosticReadiness),
    planCoverage: Array.isArray(summary.planCoverage)
      ? summary.planCoverage.map((entry) => compactPlanCoverageEntry(entry))
      : [],
    includeInvalidated: summary.includeInvalidated,
    includeUnproven: summary.includeUnproven,
    omittedInvalidatedRows: summary.omittedInvalidatedRows,
    omitted_invalidated_rows: summary.omitted_invalidated_rows ?? summary.omittedInvalidatedRows,
    omittedUnprovenRows: summary.omittedUnprovenRows,
    omitted_unproven_rows: summary.omitted_unproven_rows ?? summary.omittedUnprovenRows,
    outputProjection: {
      schemaVersion: 'synthi.gpu_hmr.validation_matrix_summary_json_projection.v1',
      schema_version: 'synthi.gpu_hmr.validation_matrix_summary_json_projection.v1',
      proofAuthority: 'cli_summary_json_projection_only_not_gpu_hmr_acceptance',
      proof_authority: 'cli_summary_json_projection_only_not_gpu_hmr_acceptance',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      canSatisfyRuntimeProof: false,
      can_satisfy_runtime_proof: false,
    },
  };
}

function matrixAttemptHistoryForJsonOutput(attemptHistory = []) {
  if (!Array.isArray(attemptHistory)) return attemptHistory;
  return attemptHistory.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    return {
      targetId: entry.targetId ?? entry.target_id ?? null,
      target_id: entry.targetId ?? entry.target_id ?? null,
      backend: entry.backend ?? null,
      selectedRowId: entry.selectedRowId ?? entry.selected_row_id ?? null,
      selected_row_id: entry.selectedRowId ?? entry.selected_row_id ?? null,
      candidateCount: entry.candidateCount ?? entry.candidate_count ?? null,
      candidate_count: entry.candidateCount ?? entry.candidate_count ?? null,
      selectedOutcome: entry.selectedOutcome ?? entry.selected_outcome ?? null,
      selected_outcome: entry.selectedOutcome ?? entry.selected_outcome ?? null,
      supportScore: entry.supportScore ?? entry.support_score ?? null,
      support_score: entry.supportScore ?? entry.support_score ?? null,
    };
  });
}

function matrixQueryForJsonOutput(query = {}, summary = {}, attemptHistory = []) {
  return {
    schemaVersion: query.schemaVersion ?? query.schema_version ?? null,
    schema_version: query.schemaVersion ?? query.schema_version ?? null,
    proofId: query.proofId ?? query.proof_id ?? null,
    proof_id: query.proofId ?? query.proof_id ?? null,
    accepted: query.accepted === true,
    failedGates: compactPrimitiveArray(query.failedGates ?? query.failed_gates),
    failed_gates: compactPrimitiveArray(query.failedGates ?? query.failed_gates),
    summary,
    attemptHistory,
    attempt_history: attemptHistory,
  };
}

function matrixSummaryForConsole(summary = {}) {
  const projected = matrixSummaryForJsonOutput(summary);
  return {
    ...projected,
    refusalTargets: projected.refusalTargets.slice(0, 20),
    refusal_targets: projected.refusal_targets.slice(0, 20),
    planCoverage: projected.planCoverage.map((entry) => ({
      id: entry.id,
      requirement: entry.requirement,
      status: entry.status,
      claimScope: entry.claimScope,
      claim_scope: entry.claim_scope,
      acceptanceScopes: entry.acceptanceScopes,
      acceptance_scopes: entry.acceptance_scopes,
      rowCount: entry.rowCount,
      row_count: entry.row_count,
      openGaps: entry.openGaps.slice(0, 8),
      open_gaps: entry.open_gaps.slice(0, 8),
      openGapCount: entry.openGapCount,
      open_gap_count: entry.open_gap_count,
      openGapsTruncated: entry.openGapsTruncated,
      open_gaps_truncated: entry.open_gaps_truncated,
      openGapsHash: entry.openGapsHash,
      open_gaps_hash: entry.open_gaps_hash,
    })),
  };
}

function pathsForConsole(paths = {}) {
  const manifest = paths.rowDetailManifest
    ? {
        schemaVersion: paths.rowDetailManifest.schemaVersion,
        schema_version: paths.rowDetailManifest.schema_version,
        proofAuthority: paths.rowDetailManifest.proofAuthority,
        proof_authority: paths.rowDetailManifest.proof_authority,
        directory: paths.rowDetailManifest.directory,
        rowCount: paths.rowDetailManifest.rowCount,
        row_count: paths.rowDetailManifest.row_count,
        manifestHash: paths.rowDetailManifest.manifestHash,
        manifest_hash: paths.rowDetailManifest.manifest_hash,
      }
    : null;
  return {
    jsonPath: paths.jsonPath ?? null,
    markdownPath: paths.markdownPath ?? null,
    rowDetailManifest: manifest,
    row_detail_manifest: manifest,
  };
}

async function writeLedger(ledger, args) {
  await fs.mkdir(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.md`);
  let rowDetailManifest = null;
  if (args.format === 'json' || args.format === 'both') {
    const sidecars = await writeMatrixRowDetailSidecars(ledger, args, stamp);
    rowDetailManifest = sidecars.manifest;
    const jsonLedger = matrixLedgerForJsonOutput(ledger, sidecars.refsByRowId, rowDetailManifest);
    await fs.writeFile(
      jsonPath,
      `${JSON.stringify(jsonLedger, matrixOutputJsonReplacer, 2)}\n`,
    );
  }
  if (args.format === 'markdown' || args.format === 'both') {
    await fs.writeFile(markdownPath, markdownTable(ledger.rows));
  }
  return {
    jsonPath: args.format === 'markdown' ? null : jsonPath,
    markdownPath: args.format === 'json' ? null : markdownPath,
    rowDetailManifest,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!['json', 'markdown', 'both'].includes(args.format)) {
    throw new Error(`Unsupported format: ${args.format}`);
  }
  if (args.outputOracleSelfCheck) {
    console.log(JSON.stringify(await selfCheckGenericOutputOracleLedger(), matrixOutputJsonReplacer, 2));
    return;
  }
  const ledger = await collectGpuHmrValidationMatrixLedger({
    repoRoot,
    mcpRoot,
    latestPerTarget: args.latestPerTarget,
    includeInvalidated: args.includeInvalidated,
    includeUnproven: args.includeUnproven,
    roots: args.roots.length > 0 ? args.roots : undefined,
  });
  if (!ledger.query.accepted) {
    const failures = ledger.query.failedGates.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR validation matrix rejected collected rows: ${failures}`);
  }
  if (args.selfCheck) {
    console.log(JSON.stringify(
      {
        ok: true,
        schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
        proofId: ledger.proofId,
        summary: matrixSummaryForConsole(ledger.summary),
      },
      matrixOutputJsonReplacer,
      2,
    ));
    return;
  }
  const paths = await writeLedger(ledger, args);
  const consolePaths = pathsForConsole(paths);
  console.log(JSON.stringify(
    {
      ok: true,
      schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
      proofId: ledger.proofId,
      summary: matrixSummaryForConsole(ledger.summary),
      ...consolePaths,
    },
    matrixOutputJsonReplacer,
    2,
  ));
}

await main();
