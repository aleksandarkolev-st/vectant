#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { verifyProofBundleFile } from './codesite-proof-verify.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_PROOF_ROOT = 'tmp/codesite-dojo-proof';
const DEFAULT_MINIMUM_ASSERTIONS = 43;
const REQUIRED_WORKFLOW_SHOTS = [
  'codesite-full-workflow-proof.png',
  'codesite-full-workflow-proof-summary.png',
  'codesite-full-workflow-ui.png',
  'codesite-full-workflow-ui-proof-section.png',
  'codesite-full-workflow-ui-coordination.png',
  'codesite-full-workflow-ui-line-inspector.png',
  'codesite-full-workflow-ui-causal-replay-handover.png',
  'codesite-full-workflow-ui-causal-replay-mobile.png',
];

async function main(argv) {
  const options = parseArgs(argv);
  const root = repoRoot();
  const proofRoot = path.resolve(root, options.proofRoot);
  const failures = [];
  const warnings = [];
  const checks = [];

  const latestPath = path.join(proofRoot, 'codesite-full-workflow-latest.json');
  const latest = readJson(latestPath, failures);
  requireField(latest, 'status', 'validated', latestPath, failures);
  const slug = latest?.slug || null;
  if (!slug) failures.push(`${relative(root, latestPath)} missing slug`);

  const publicationPath = path.resolve(root, latest?.publication || path.join(proofRoot, 'codesite-full-workflow-publication.json'));
  const publication = readJson(publicationPath, failures);
  requireField(publication, 'status', 'validated', publicationPath, failures);
  requireTruthy(publication?.artifactValidation?.ok, `${relative(root, publicationPath)} artifactValidation.ok`, failures);
  requireTruthy(publication?.secretScan?.ok, `${relative(root, publicationPath)} secretScan.ok`, failures);
  requireTruthy(publication?.publicationSecretScan?.ok, `${relative(root, publicationPath)} publicationSecretScan.ok`, failures);
  if (!Array.isArray(publication?.failedAssertions) || publication.failedAssertions.length !== 0) {
    failures.push(`${relative(root, publicationPath)} failedAssertions must be an empty array`);
  }
  if (Number(publication?.assertionCount || 0) < options.minimumAssertions) {
    failures.push(`${relative(root, publicationPath)} assertionCount ${publication?.assertionCount || 0} below minimum ${options.minimumAssertions}`);
  }

  const proofPath = path.resolve(root, publication?.proof || latest?.proof || '');
  const proof = readJson(proofPath, failures);
  const assertionEntries = Object.entries(proof?.assertions || {});
  if (assertionEntries.length < options.minimumAssertions) {
    failures.push(`${relative(root, proofPath)} has ${assertionEntries.length} assertions; expected at least ${options.minimumAssertions}`);
  }
  for (const [name, value] of assertionEntries) {
    if (value !== true) failures.push(`${relative(root, proofPath)} assertion ${name} is not true`);
  }
  checks.push({ name: 'workflowAssertions', count: assertionEntries.length, ok: assertionEntries.every(([, value]) => value === true) });

  verifySha(root, proofPath, publication?.proofSha256 || latest?.proofSha256, failures);
  if (publication?.publicationSha256) verifySha(root, publicationPath, publication.publicationSha256, failures);

  const visualArtifacts = [
    ...(publication?.artifactValidation?.visualArtifacts || []),
    ...REQUIRED_WORKFLOW_SHOTS.map((file) => ({
      path: publication?.runDir ? path.posix.join(publication.runDir, file) : path.posix.join('tmp/codesite-dojo-proof/runs', slug || '', file),
    })),
  ];
  const visualSummary = validateVisualArtifacts(root, visualArtifacts, failures);
  checks.push({ name: 'visualArtifacts', ...visualSummary });

  const runtimeProofPath = path.join(proofRoot, 'codesite-runtime-mount-boundary-proof.json');
  const runtimeProof = readJson(runtimeProofPath, failures);
  requireField(runtimeProof, 'status', 'validated', runtimeProofPath, failures);
  if (Number(runtimeProof?.docker?.exitCode) !== 0) {
    failures.push(`${relative(root, runtimeProofPath)} docker.exitCode must be 0`);
  }
  const runtimeAssertions = Object.entries(runtimeProof?.assertions || {});
  for (const [name, value] of runtimeAssertions) {
    if (value !== true) failures.push(`${relative(root, runtimeProofPath)} runtime assertion ${name} is not true`);
  }
  const runtimePngPath = path.join(proofRoot, 'codesite-runtime-mount-boundary-proof.png');
  validatePng(root, runtimePngPath, failures);
  checks.push({ name: 'runtimeMountBoundary', assertions: runtimeAssertions.length, ok: runtimeAssertions.every(([, value]) => value === true) });

  const trustedKeysPath = path.join(proofRoot, `trusted-proof-authorities-${slug}.json`);
  if (!fs.existsSync(trustedKeysPath)) failures.push(`trusted proof authorities missing: ${relative(root, trustedKeysPath)}`);
  const proofBundleSummary = verifyProofBundles({ root, proofRoot, slug, trustedKeysPath, failures });
  checks.push({ name: 'proofBundles', ...proofBundleSummary });

  const codexSummary = validateCodexEvidence({ root, proofRoot, slug, failures });
  checks.push({ name: 'codexAgentEvidence', ...codexSummary });

  const result = {
    ok: failures.length === 0,
    schemaVersion: 'synthi.codesite.releaseGate.v1',
    generatedAt: new Date().toISOString(),
    proofRoot: relative(root, proofRoot),
    slug,
    checks,
    warnings,
    failures,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outPath) {
    const outPath = path.resolve(root, options.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf8');
  }
  if (options.htmlPath) {
    const htmlPath = path.resolve(root, options.htmlPath);
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    fs.writeFileSync(htmlPath, cleanTextArtifact(releaseGateHtml(result)), 'utf8');
  }
  if (options.pngPath) {
    if (!options.htmlPath) throw new Error('--png requires --html');
    await screenshotHtml(path.resolve(root, options.htmlPath), path.resolve(root, options.pngPath));
  }
  process.stdout.write(output);
  if (!result.ok) process.exitCode = 1;
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi' ? path.dirname(process.cwd()) : process.cwd();
}

function parseArgs(argv) {
  const options = {
    proofRoot: process.env.CODESITE_PROOF_ROOT || DEFAULT_PROOF_ROOT,
    minimumAssertions: Number(process.env.CODESITE_RELEASE_GATE_MINIMUM_ASSERTIONS || DEFAULT_MINIMUM_ASSERTIONS),
    outPath: process.env.CODESITE_RELEASE_GATE_OUT || null,
    htmlPath: process.env.CODESITE_RELEASE_GATE_HTML || null,
    pngPath: process.env.CODESITE_RELEASE_GATE_PNG || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--proof-root') options.proofRoot = argv[++index];
    else if (arg === '--minimum-assertions') options.minimumAssertions = Number(argv[++index]);
    else if (arg === '--out') options.outPath = argv[++index];
    else if (arg === '--html') options.htmlPath = argv[++index];
    else if (arg === '--png') options.pngPath = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/codesite-release-gate.mjs [--proof-root tmp/codesite-dojo-proof] [--minimum-assertions 43] [--out path] [--html path --png path]\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.minimumAssertions) || options.minimumAssertions <= 0) {
    throw new Error('--minimum-assertions must be a positive number');
  }
  return options;
}

function releaseGateHtml(result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  const cards = result.checks.map((check) => `
    <section class="card">
      <div class="label">${escapeHtml(check.name)}</div>
      <div class="value ${check.ok === false ? 'bad' : 'good'}">${check.ok === false ? 'fail' : 'pass'}</div>
      <pre>${escapeHtml(JSON.stringify(check, null, 2))}</pre>
    </section>
  `).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CodeSite Release Gate</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #07080d; color: #f5f7fb; }
    body { margin: 0; padding: 28px; background: #07080d; }
    main { max-width: 1180px; margin: 0 auto; }
    .hero { border: 1px solid #2b3450; background: #111521; border-radius: 8px; padding: 24px; margin-bottom: 18px; }
    .status { display: inline-flex; align-items: center; border-radius: 4px; padding: 5px 10px; font-size: 12px; font-weight: 800; letter-spacing: .04em; background: ${result.ok ? '#0f6b3b' : '#7f1d1d'}; color: white; }
    h1 { margin: 10px 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0; color: #aeb8d4; line-height: 1.55; max-width: 900px; }
    .meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 16px 0 18px; }
    .metric, .card { border: 1px solid #27304a; background: #111521; border-radius: 8px; padding: 16px; min-width: 0; }
    .label { color: #8f9bb8; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 8px; }
    .value { font-size: 22px; line-height: 1.2; overflow-wrap: anywhere; }
    .good { color: #8dffb8; }
    .bad { color: #ff9999; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 12px 0 0; color: #d8def1; background: #070a12; border: 1px solid #202842; border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.45; }
    @media (max-width: 720px) { body { padding: 12px; } .meta, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <span class="status">${status}</span>
      <h1>CodeSite Release Gate</h1>
      <p>Blocking release validation for committed CodeSite workflow proof, visual artifacts, runtime mount boundary evidence, trusted proof bundles, and real Codex agent transcripts.</p>
    </section>
    <section class="meta">
      <div class="metric"><div class="label">Slug</div><div class="value">${escapeHtml(result.slug || 'unknown')}</div></div>
      <div class="metric"><div class="label">Proof root</div><div class="value">${escapeHtml(result.proofRoot)}</div></div>
      <div class="metric"><div class="label">Generated</div><div class="value">${escapeHtml(result.generatedAt)}</div></div>
    </section>
    <section class="grid">${cards}</section>
    <section class="card" style="margin-top:12px">
      <div class="label">Failures</div>
      <pre>${escapeHtml(JSON.stringify(result.failures, null, 2))}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function screenshotHtml(htmlPath, pngPath) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    await page.screenshot({ path: pngPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

function readJson(filePath, failures) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    failures.push(`${filePath} unreadable JSON: ${error?.message || String(error)}`);
    return null;
  }
}

function requireField(object, field, expected, filePath, failures) {
  if (object?.[field] !== expected) {
    failures.push(`${relative(repoRoot(), filePath)} ${field} expected ${expected}, observed ${object?.[field] ?? '<missing>'}`);
  }
}

function requireTruthy(value, label, failures) {
  if (value !== true) failures.push(`${label} must be true`);
}

function verifySha(root, filePath, expected, failures) {
  if (!expected) {
    failures.push(`${relative(root, filePath)} missing expected sha256`);
    return;
  }
  const actual = fileSha256(filePath);
  if (actual !== expected) {
    failures.push(`${relative(root, filePath)} sha256 mismatch: expected ${expected}, observed ${actual}`);
  }
}

function validateVisualArtifacts(root, artifacts, failures) {
  const uniquePaths = new Set();
  const publishedByName = new Map();
  for (const artifact of artifacts || []) {
    if (artifact?.path && artifact?.sha256) {
      publishedByName.set(path.basename(artifact.path), artifact);
    }
  }
  for (const requiredName of REQUIRED_WORKFLOW_SHOTS) {
    const artifact = publishedByName.get(requiredName);
    if (!artifact) {
      failures.push(`workflow visual artifact ${requiredName} is missing from publication metadata`);
      continue;
    }
    if (artifact.nonblank !== true && artifact?.png?.nonblank !== true) {
      failures.push(`workflow visual artifact ${requiredName} is missing nonblank publication metadata`);
    }
    if (!artifact?.png?.width || !artifact?.png?.height) {
      failures.push(`workflow visual artifact ${requiredName} is missing PNG dimension metadata`);
    }
  }
  let checked = 0;
  for (const artifact of artifacts || []) {
    const artifactPath = artifact?.path ? path.resolve(root, artifact.path) : null;
    if (!artifactPath || uniquePaths.has(artifactPath)) continue;
    uniquePaths.add(artifactPath);
    const png = validatePng(root, artifactPath, failures);
    checked += 1;
    if (artifact?.sha256) verifySha(root, artifactPath, artifact.sha256, failures);
    if (artifact?.nonblank === false || artifact?.png?.nonblank === false) {
      failures.push(`${relative(root, artifactPath)} recorded as blank`);
    }
    if (artifact?.png?.width && png?.width && Number(artifact.png.width) !== png.width) {
      failures.push(`${relative(root, artifactPath)} width mismatch against publication metadata`);
    }
    if (artifact?.png?.height && png?.height && Number(artifact.png.height) !== png.height) {
      failures.push(`${relative(root, artifactPath)} height mismatch against publication metadata`);
    }
  }
  return { checked, ok: checked >= REQUIRED_WORKFLOW_SHOTS.length };
}

function validatePng(root, filePath, failures) {
  let buffer = null;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    failures.push(`${relative(root, filePath)} unreadable PNG: ${error?.message || String(error)}`);
    return null;
  }
  if (buffer.length < 33) {
    failures.push(`${relative(root, filePath)} PNG too small`);
    return null;
  }
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    failures.push(`${relative(root, filePath)} is not a PNG`);
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) failures.push(`${relative(root, filePath)} has empty PNG dimensions`);
  return { width, height, bytes: buffer.length };
}

function verifyProofBundles({ root, proofRoot, slug, trustedKeysPath, failures }) {
  const appArtifactsRoot = path.join(proofRoot, 'app-artifacts', slug || '');
  const bundles = listFiles(appArtifactsRoot).filter((file) => file.endsWith('.proof.json'));
  let verified = 0;
  for (const bundlePath of bundles) {
    const trailersPath = bundlePath.replace(/\.proof\.json$/, '.trailers.txt');
    const result = verifyProofBundleFile(bundlePath, {
      trailersPath,
      requireTrailers: true,
      trustedKeysPath,
      requireTrustedAuthority: true,
      allowEmbeddedPublicKey: false,
    });
    if (!result.ok) {
      failures.push(`${relative(root, bundlePath)} failed trusted proof verification: ${result.errors.join('; ')}`);
    } else {
      verified += 1;
    }
  }
  if (bundles.length === 0) failures.push(`${relative(root, appArtifactsRoot)} contains no proof bundles`);
  return { found: bundles.length, verified, ok: bundles.length > 0 && verified === bundles.length };
}

function validateCodexEvidence({ root, proofRoot, slug, failures }) {
  const evidenceRoot = path.join(proofRoot, 'codex-agent-evidence', slug || '');
  const records = listFiles(evidenceRoot).filter((file) => file.endsWith('.json') && !file.endsWith('schema.json'));
  let valid = 0;
  for (const recordPath of records) {
    const record = readJson(recordPath, failures);
    const transcript = record?.transcript || {};
    const requiredPaths = [
      transcript.eventsRawPath,
      transcript.stderrPath,
      transcript.finalMessagePath,
    ].filter(Boolean);
    for (const relativePath of requiredPaths) {
      if (!fs.existsSync(path.resolve(root, relativePath))) {
        failures.push(`${relative(root, recordPath)} references missing transcript artifact ${relativePath}`);
      }
    }
    if (!record?.codexExecThreadId) failures.push(`${relative(root, recordPath)} missing codexExecThreadId`);
    if (Number(transcript.eventCount || 0) <= 0) failures.push(`${relative(root, recordPath)} transcript.eventCount must be positive`);
    if (!record?.providerSessionRef) failures.push(`${relative(root, recordPath)} missing providerSessionRef`);
    valid += 1;
  }
  if (records.length < 3) failures.push(`${relative(root, evidenceRoot)} must contain at least three Codex role evidence records`);
  return { records: records.length, valid, ok: records.length >= 3 };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleanTextArtifact(value) {
  return String(value).replace(/[ \t]+$/gm, '');
}

function relative(root, filePath) {
  return path.relative(root, path.resolve(filePath)).split(path.sep).join('/');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
