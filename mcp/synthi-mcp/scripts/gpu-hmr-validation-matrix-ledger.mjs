#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
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
    'Usage: node scripts/gpu-hmr-validation-matrix-ledger.mjs [--all] [--include-invalidated] [--include-unproven] [--format json|markdown|both] [--output-dir DIR] [--root DIR] [--self-check]',
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

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function matrixOutputProjectionHash(value) {
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

function compactMatrixRowRefForJsonOutput(row = {}) {
  const acceptedForGpuHmr = firstBool(row.acceptedForGpuHmr, row.accepted_for_gpu_hmr) === true;
  const gpuHmrSuccess = firstBool(row.gpuHmrSuccess, row.gpu_hmr_success) === true;
  const safetyAccepted = firstBool(row.safety?.accepted, row.safety_accepted) === true;
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
    safetyAccepted,
    safety_accepted: safetyAccepted,
    proofIds: Array.isArray(row.proofIds) ? row.proofIds : Array.isArray(row.proof_ids) ? row.proof_ids : [],
    proof_ids: Array.isArray(row.proof_ids) ? row.proof_ids : Array.isArray(row.proofIds) ? row.proofIds : [],
    openGaps: Array.isArray(row.openGaps) ? row.openGaps : [],
    open_gaps: Array.isArray(row.open_gaps) ? row.open_gaps : [],
  };
}

function matrixRowForJsonOutput(row = {}) {
  if (!row || typeof row !== 'object' || row.proofMode !== 'random_large_project_cold_path') {
    return row;
  }
  const projected = { ...row };
  delete projected.sourceIntakeEvidence;
  delete projected.source_intake_evidence;
  projected.outputProjection = {
    schemaVersion: 'synthi.gpu_hmr.validation_matrix_row_json_output_projection.v1',
    schema_version: 'synthi.gpu_hmr.validation_matrix_row_json_output_projection.v1',
    proofAuthority: 'cli_row_json_size_projection_only_not_gpu_hmr_acceptance',
    proof_authority: 'cli_row_json_size_projection_only_not_gpu_hmr_acceptance',
    omittedRawCarriers: ['sourceIntakeEvidence', 'source_intake_evidence'],
    omitted_raw_carriers: ['sourceIntakeEvidence', 'source_intake_evidence'],
    retainedValidatedSummaries: [
      'coldSourceTreeIntake',
      'sourceIntakeTransportFallback',
      'randomColdBackendEvidence',
    ],
    retained_validated_summaries: [
      'coldSourceTreeIntake',
      'sourceIntakeTransportFallback',
      'randomColdBackendEvidence',
    ],
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
  };
  projected.output_projection = projected.outputProjection;
  return projected;
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
    if (key === 'rows') return value.map((row) => matrixRowForJsonOutput(row));
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

function matrixLedgerForJsonOutput(ledger) {
  return {
    ...ledger,
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
    },
  };
}

async function writeLedger(ledger, args) {
  await fs.mkdir(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.md`);
  if (args.format === 'json' || args.format === 'both') {
    const jsonLedger = matrixLedgerForJsonOutput(ledger);
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
        summary: ledger.summary,
      },
      matrixOutputJsonReplacer,
      2,
    ));
    return;
  }
  const paths = await writeLedger(ledger, args);
  console.log(JSON.stringify(
    {
      ok: true,
      schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
      proofId: ledger.proofId,
      summary: ledger.summary,
      ...paths,
    },
    matrixOutputJsonReplacer,
    2,
  ));
}

await main();
