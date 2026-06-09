#!/usr/bin/env node
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
    'Usage: node scripts/gpu-hmr-validation-matrix-ledger.mjs [--all] [--include-invalidated] [--include-unproven] [--format json|markdown|both] [--output-dir DIR] [--self-check]',
    '',
    'Collects GPU HMR proof artifacts into a matrix ledger. The collector records accepted full-runtime proof, visual-profile proof, preflight-only evidence, and structured refusals separately.',
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
    'visualProfileAccepted',
    'refusalProven',
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

async function writeLedger(ledger, args) {
  await fs.mkdir(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `gpu-hmr-validation-matrix-${stamp}.md`);
  if (args.format === 'json' || args.format === 'both') {
    await fs.writeFile(jsonPath, `${JSON.stringify(ledger, null, 2)}\n`);
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
  });
  if (!ledger.query.accepted) {
    const failures = ledger.query.failedGates.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR validation matrix rejected collected rows: ${failures}`);
  }
  if (args.selfCheck) {
    console.log(JSON.stringify({
      ok: true,
      schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
      proofId: ledger.proofId,
      summary: ledger.summary,
    }, null, 2));
    return;
  }
  const paths = await writeLedger(ledger, args);
  console.log(JSON.stringify({
    ok: true,
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    proofId: ledger.proofId,
    summary: ledger.summary,
    ...paths,
  }, null, 2));
}

await main();
