#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const REQUIRED_FIELDS = [
  'schemaVersion',
  'projectId',
  'transactionId',
  'mutationLeaseId',
  'readSetDigest',
  'writeSetDigest',
  'invariants',
  'evidenceRefs',
];

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.bundlePath) {
    printUsage(args.help ? 0 : 1);
    return;
  }

  const result = verifyProofBundleFile(args.bundlePath, {
    trailersPath: args.trailersPath,
    requireTrailers: args.requireTrailers,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

export function verifyProofBundleFile(bundlePath, options = {}) {
  const absoluteBundlePath = path.resolve(bundlePath);
  const errors = [];
  const warnings = [];
  let bundle = null;

  try {
    bundle = JSON.parse(fs.readFileSync(absoluteBundlePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reasonCodes: ['proof_bundle_unreadable'],
      errors: [error?.message || String(error)],
      bundlePath: absoluteBundlePath,
    };
  }

  const schemaVersionOk = bundle.schemaVersion === 'synthi.codesite.proofBundle.v1';
  if (!schemaVersionOk) errors.push('schemaVersion must be synthi.codesite.proofBundle.v1');

  const missingFields = REQUIRED_FIELDS.filter((field) => bundle[field] == null || bundle[field] === '');
  if (missingFields.length > 0) errors.push(`missing required fields: ${missingFields.join(', ')}`);

  if (!Array.isArray(bundle.invariants)) errors.push('invariants must be an array');
  if (!Array.isArray(bundle.evidenceRefs)) errors.push('evidenceRefs must be an array');
  if (!isDigest(bundle.readSetDigest)) errors.push('readSetDigest must be a sha256 digest');
  if (!isDigest(bundle.writeSetDigest)) errors.push('writeSetDigest must be a sha256 digest');
  if (bundle.incidentReplayDigest && !isDigest(bundle.incidentReplayDigest)) {
    errors.push('incidentReplayDigest must be a sha256 digest when present');
  }
  if (bundle.bundleDigest && !isDigest(bundle.bundleDigest)) {
    errors.push('bundleDigest must be a sha256 digest when present');
  }

  const { portableDigest, ...unsigned } = bundle;
  const expectedPortableDigest = digest(unsigned);
  const legacyDatePortableDigest = legacyDateObjectDigest(unsigned);
  const legacyDateDigestMatched = Boolean(
    portableDigest
    && legacyDatePortableDigest
    && portableDigest === legacyDatePortableDigest
  );
  if (!portableDigest) {
    warnings.push('portableDigest is absent; canonical digest was computed but cannot be compared');
  } else if (portableDigest !== expectedPortableDigest && !legacyDateDigestMatched) {
    errors.push('portableDigest mismatch');
  } else if (legacyDateDigestMatched) {
    warnings.push('portableDigest matches legacy Date-object canonicalization; regenerate the proof bundle to use ISO timestamp canonicalization');
  }

  const trailerResult = verifyTrailers(bundle, options);
  errors.push(...trailerResult.errors);
  warnings.push(...trailerResult.warnings);

  const reasonCodes = [];
  if (schemaVersionOk) reasonCodes.push('proof_bundle_schema_valid');
  if (missingFields.length === 0) reasonCodes.push('proof_bundle_required_fields_present');
  if (portableDigest && (portableDigest === expectedPortableDigest || legacyDateDigestMatched)) {
    reasonCodes.push('proof_bundle_digest_valid');
  }
  if (legacyDateDigestMatched) reasonCodes.push('proof_bundle_legacy_date_digest_valid');
  if (trailerResult.checked) reasonCodes.push('proof_commit_trailers_match');
  if (warnings.length > 0) reasonCodes.push('proof_bundle_warnings_present');
  if (errors.length > 0) reasonCodes.push('proof_bundle_verification_failed');

  return {
    ok: errors.length === 0,
    reasonCodes,
    errors,
    warnings,
    bundlePath: absoluteBundlePath,
    trailersPath: trailerResult.trailersPath,
    expectedPortableDigest,
    legacyDatePortableDigest,
    observedPortableDigest: portableDigest || null,
    transactionId: bundle.transactionId || null,
    mutationLeaseId: bundle.mutationLeaseId || null,
    readSetDigest: bundle.readSetDigest || null,
    writeSetDigest: bundle.writeSetDigest || null,
    blackBoxDigest: bundle.incidentReplayDigest || bundle.bundleDigest || portableDigest || expectedPortableDigest,
  };
}

function verifyTrailers(bundle, options) {
  const trailersPath = options.trailersPath ? path.resolve(options.trailersPath) : null;
  const errors = [];
  const warnings = [];
  if (!trailersPath) {
    if (options.requireTrailers) errors.push('commit trailers are required but no trailers file was provided');
    return { checked: false, errors, warnings, trailersPath };
  }

  let trailers = {};
  try {
    trailers = parseTrailers(fs.readFileSync(trailersPath, 'utf8'));
  } catch (error) {
    errors.push(`commit trailers unreadable: ${error?.message || String(error)}`);
    return { checked: false, errors, warnings, trailersPath };
  }

  const expected = {
    'CodeSite-Transaction': bundle.transactionId,
    'CodeSite-Lease': bundle.mutationLeaseId,
    'CodeSite-Read-Set': bundle.readSetDigest,
    'CodeSite-Write-Set': bundle.writeSetDigest,
    'CodeSite-Invariants': Array.isArray(bundle.invariants) ? bundle.invariants.join(',') : null,
    'CodeSite-Black-Box': bundle.incidentReplayDigest || bundle.bundleDigest || bundle.portableDigest,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue == null || expectedValue === '') continue;
    const observed = trailers[key];
    if (observed !== expectedValue) {
      errors.push(`commit trailer ${key} mismatch: expected ${expectedValue}, observed ${observed || '<missing>'}`);
    }
  }
  return { checked: true, errors, warnings, trailersPath };
}

function parseTrailers(text) {
  const trailers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (match) trailers[match[1]] = match[2].trim();
  }
  return trailers;
}

function parseArgs(argv) {
  const args = {
    bundlePath: null,
    trailersPath: null,
    requireTrailers: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--bundle') {
      args.bundlePath = argv[++index];
    } else if (arg === '--trailers') {
      args.trailersPath = argv[++index];
    } else if (arg === '--require-trailers') {
      args.requireTrailers = true;
    } else if (!args.bundlePath) {
      args.bundlePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printUsage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write([
    'Usage: node scripts/codesite-proof-verify.mjs --bundle <proof.json> [--trailers <trailers.txt>] [--require-trailers]',
    '',
    'Verifies a portable CodeSite proof bundle outside the UI and emits JSON.',
    '',
  ].join('\n'));
  process.exitCode = code;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function legacyDateObjectDigest(unsigned) {
  if (!unsigned || typeof unsigned.createdAt !== 'string') return null;
  return digest({ ...unsigned, createdAt: {} });
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function isDigest(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
