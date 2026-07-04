#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
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
const ACTIVE_AUTHORITY_PROOF = 'codesite-active-transaction-registry-proof.json';
const ACTIVE_AUTHORITY_PNG = 'codesite-active-transaction-registry-proof.png';
const REQUIRED_MATURE_PROOFS = [
  {
    name: 'activeMutationBoundary',
    plan: '2A.1, 2B, 25.2A',
    file: 'codesite-active-mutation-boundary-proof.json',
    png: 'codesite-active-mutation-boundary-proof.png',
    requiredCommands: ['activeBoundaryTests', 'gitServiceBoundaryTests', 'dockerReplay'],
    dockerCommand: 'dockerReplay',
  },
  { name: 'gitServiceBoundary', plan: '2A.3, 2B', file: 'codesite-gitservice-boundary-proof.json', png: 'codesite-gitservice-boundary-proof.png' },
  { name: 'gitServiceIndexBoundary', plan: '2A.3, 2B', file: 'codesite-gitservice-index-proof.json', png: 'codesite-gitservice-index-proof.png' },
  { name: 'gitServiceWorktreeBoundary', plan: '2A.3, 2B', file: 'codesite-gitservice-worktree-proof.json', png: 'codesite-gitservice-worktree-proof.png' },
  { name: 'directGitServiceBoundary', plan: '2A.3, 2B', file: 'codesite-direct-gitservice-boundary-proof.json', png: 'codesite-direct-gitservice-boundary-proof.png' },
  { name: 'gitProvisioningBoundary', plan: '2A.3, 2B', file: 'codesite-git-provisioning-boundary-proof.json', png: 'codesite-git-provisioning-boundary-proof.png' },
  { name: 'repoCacheBoundary', plan: '2A.3, 2B', file: 'codesite-repo-cache-boundary-proof.json', png: 'codesite-repo-cache-boundary-proof.png' },
  { name: 'workspacePrepGuard', plan: '2A.3, 25.2C', file: 'codesite-workspace-prep-guard-proof.json', png: 'codesite-workspace-prep-guard-proof.png' },
  { name: 'runtimeFilesystemHydration', plan: '2A.3, 25.2C', file: 'codesite-runtime-filesystem-hydration-proof.json', png: 'codesite-runtime-filesystem-hydration-proof.png' },
  { name: 'runtimeOverlay', plan: '2A.3, 25.2C', file: 'codesite-runtime-overlay-proof.json', png: 'codesite-runtime-overlay-proof.png' },
  { name: 'runtimeQuarantine', plan: '2A.3, 26.9', file: 'codesite-runtime-quarantine-proof.json', png: 'codesite-runtime-quarantine-proof.png' },
  { name: 'codesiteFsRuntimeBoundary', plan: '2A.3, 25.2C, 26.9', file: 'codesitefs-runtime-boundary-proof.json', png: 'codesitefs-runtime-boundary-proof.png' },
  { name: 'quarantineReview', plan: '2A.3, 26.9', file: 'codesite-quarantine-review-proof.json', png: 'codesite-quarantine-review-proof.png' },
  { name: 'proofCarryingCommit', plan: '2A.4, 25.7B, 26.4', file: 'codesite-proof-carrying-commit-proof.json', png: 'codesite-proof-carrying-commit-proof.png' },
  { name: 'actualGitCommitProof', plan: '2A.4, 25.7B, 26.4', file: 'codesite-actual-git-commit-proof.json', png: 'codesite-actual-git-commit-proof.png' },
  { name: 'proofBundleGitContext', plan: '2A.4, 25.7B, 26.4', file: 'codesite-proof-bundle-git-context-proof.json', png: 'codesite-proof-bundle-git-context-proof.png' },
  { name: 'repoStateIdentity', plan: '2A.2, 2A.4, 25.7A, 26.4', file: 'codesite-repo-state-identity-proof.json', png: 'codesite-repo-state-identity-proof.png' },
  { name: 'blackBoxCompleteness', plan: '2A.5, 25.7B, 26.8', file: 'codesite-black-box-completeness-proof.json', png: 'codesite-black-box-completeness-proof.png' },
  {
    name: 'lineInspector',
    plan: '2A.6, 25.7B, 26.10',
    file: 'codesite-line-inspector-proof.json',
    png: 'codesite-line-inspector-proof.png',
    browserProof: true,
  },
  {
    name: 'lineProvenanceDiff',
    plan: '2A.6, 25.7B, 26.10',
    file: 'codesite-line-provenance-diff-proof.json',
    png: 'codesite-line-provenance-diff-proof.png',
  },
  {
    name: 'shadowSimulator',
    plan: '2A.5, 25.4, 26.6',
    file: 'codesite-shadow-simulator-proof.json',
    png: 'codesite-shadow-simulator-proof.png',
    browserProof: true,
  },
  { name: 'runwayOccupancy', plan: '26.2', file: 'codesite-runway-occupancy-proof.json', png: 'codesite-runway-occupancy-proof.png' },
  { name: 'counterfactualMemory', plan: '22, 25.9', file: 'codesite-counterfactual-memory-proof.json', png: 'codesite-counterfactual-memory-proof.png' },
  { name: 'repoPolicyCompiler', plan: '2A.7, 25.0', file: 'codesite-repo-policy-compiler-proof.json', png: 'codesite-repo-policy-compiler-proof.png' },
  { name: 'repoLocalAutosync', plan: '23', file: 'codesite-repo-local-autosync-proof.json', png: 'codesite-repo-local-autosync-proof.png' },
  { name: 'radarAdapter', plan: '8, 15, 25.3', file: 'codesite-radar-adapter-proof.json', png: 'codesite-radar-adapter-proof.png' },
  {
    name: 'governanceMcpLifecycle',
    plan: '2C, 16, 19, 20, 21.4-21.7, 23, 25.2B',
    file: 'codesite-governance-mcp-lifecycle-proof.json',
    png: 'codesite-governance-mcp-lifecycle-proof.png',
    requiredCommands: ['dockerGovernanceControlPlane', 'dockerMcpLifecycle'],
    dockerCommand: 'dockerGovernanceControlPlane',
  },
  {
    name: 'radarUi',
    plan: '8, 25.3, 26.1',
    file: 'codesite-radar-ui-proof.json',
    allowNoAssertions: true,
    browserProof: true,
    requiredScreenshots: ['codesite-radar-ui-desktop.png', 'codesite-radar-ui-mobile.png'],
    requiredCaptureTruthies: ['hasLandingQueue', 'hasRiskLabel'],
    requiredCaptureCounts: ['flightBlips', 'riskCones', 'holdingPatterns'],
  },
  { name: 'schemaFirstClearance', plan: '9, 17, 25.4', file: 'codesite-schema-first-clearance-proof.json', png: 'codesite-schema-first-clearance-proof.png' },
  {
    name: 'metrics',
    plan: '27',
    file: 'codesite-metrics-proof.json',
    png: 'codesite-metrics-proof.png',
    requiredCommands: ['dockerMetricsEngine', 'dockerMetricsSuite'],
    dockerCommand: 'dockerMetricsSuite',
    requiredMeasuredMetrics: [
      'proofBundlesVerifiedOutsideUi',
      'shadowMergeSimulatorAccuracy',
      'lineProvenanceCoverage',
      'blackBoxCompletenessScore',
      'humanReviewTimeSavedMs',
      'percentageWritesWithValidClearance',
    ],
    requiredMetricThresholds: [
      { key: 'proofBundlesVerifiedOutsideUi', min: 1 },
      { key: 'shadowMergeSimulatorAccuracy', min: 0.8 },
      { key: 'lineProvenanceCoverage', min: 0.5 },
      { key: 'blackBoxCompletenessScore', min: 0.75 },
      { key: 'humanReviewTimeSavedMs', min: 1 },
      { key: 'percentageWritesWithValidClearance', min: 0.3 },
    ],
  },
  { name: 'isolationContract', plan: '2A.1, 26.7', file: 'codesite-isolation-contract-proof.json', png: 'codesite-isolation-contract-proof.png' },
  { name: 'serializableCommitRace', plan: '2A.1, 26.7', file: 'codesite-serializable-commit-race-proof.json', png: 'codesite-serializable-commit-race-proof.png' },
  { name: 'runtimeContext', plan: '20, 25.2C', file: 'codesite-runtime-context-proof.json', png: 'codesite-runtime-context-proof.png' },
  { name: 'contextAlias', plan: '20, 25.2C', file: 'codesite-context-alias-proof.json', png: 'codesite-context-alias-proof.png' },
  { name: 'monitorDowngrade', plan: '2A.3, 28', file: 'codesite-monitor-downgrade-proof.json', png: 'codesite-monitor-downgrade-proof.png' },
  { name: 'pathlessRun', plan: '2A.3, 28', file: 'codesite-pathless-run-proof.json', png: 'codesite-pathless-run-proof.png' },
  { name: 'terminalReattach', plan: '2A.3, 28', file: 'codesite-terminal-reattach-proof.json', png: 'codesite-terminal-reattach-proof.png' },
];

async function main(argv) {
  const options = parseArgs(argv);
  const root = repoRoot();
  if (options.inputPath) {
    const failures = [];
    const result = readJson(path.resolve(root, options.inputPath), failures);
    if (!result || failures.length) throw new Error(`Unable to read release gate input: ${failures.join('; ')}`);
    await writeReleaseGateArtifacts({ root, options, result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
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
  const proofGitProvenanceSummary = validateProofGitProvenance({ root, proof, failures });
  checks.push({ name: 'proofGitProvenance', ...proofGitProvenanceSummary });

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

  const activeAuthoritySummary = validateActiveAuthorityProof({
    root,
    proofRoot,
    failures,
  });
  checks.push({ name: 'activeTransactionAuthority', ...activeAuthoritySummary });

  const matureProofSummary = validateMatureProofSuite({ root, proofRoot, failures });
  checks.push({ name: 'maturePlanProofSuite', ...matureProofSummary });

  const trustedKeysPath = resolveTrustedKeysPath(root, proofRoot, slug, failures);
  const proofBundleSummary = verifyProofBundles({ root, proofRoot, slug, proof, trustedKeysPath, failures });
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
  await writeReleaseGateArtifacts({ root, options, result });
  if (!result.ok) process.exitCode = 1;
}

async function writeReleaseGateArtifacts({ root, options, result }) {
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
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi' ? path.dirname(process.cwd()) : process.cwd();
}

function parseArgs(argv) {
  const options = {
    proofRoot: process.env.CODESITE_PROOF_ROOT || DEFAULT_PROOF_ROOT,
    minimumAssertions: Number(process.env.CODESITE_RELEASE_GATE_MINIMUM_ASSERTIONS || DEFAULT_MINIMUM_ASSERTIONS),
    inputPath: process.env.CODESITE_RELEASE_GATE_INPUT || null,
    outPath: process.env.CODESITE_RELEASE_GATE_OUT || null,
    htmlPath: process.env.CODESITE_RELEASE_GATE_HTML || null,
    pngPath: process.env.CODESITE_RELEASE_GATE_PNG || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--proof-root') options.proofRoot = argv[++index];
    else if (arg === '--minimum-assertions') options.minimumAssertions = Number(argv[++index]);
    else if (arg === '--input') options.inputPath = argv[++index];
    else if (arg === '--out') options.outPath = argv[++index];
    else if (arg === '--html') options.htmlPath = argv[++index];
    else if (arg === '--png') options.pngPath = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/codesite-release-gate.mjs [--proof-root tmp/codesite-dojo-proof] [--minimum-assertions 43] [--out path] [--html path --png path] [--input result.json --html path --png path]\n');
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
  const pixelStats = inspectPngPixels(root, filePath, buffer, failures);
  if (pixelStats && pixelStats.nonblank !== true) {
    failures.push(`${relative(root, filePath)} appears blank`);
  }
  return { width, height, bytes: buffer.length, ...(pixelStats || {}) };
}

function inspectPngPixels(root, filePath, buffer, failures) {
  const chunks = readPngChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  if (!ihdr || ihdr.length < 13) {
    failures.push(`${relative(root, filePath)} missing IHDR chunk`);
    return null;
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);
  const interlace = ihdr.readUInt8(12);
  if (bitDepth !== 8 || interlace !== 0) {
    failures.push(`${relative(root, filePath)} uses unsupported PNG encoding for nonblank validation`);
    return null;
  }
  const channels = pngChannelCount(colorType);
  if (!channels) {
    failures.push(`${relative(root, filePath)} uses unsupported PNG color type ${colorType}`);
    return null;
  }
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  if (!idat.length) {
    failures.push(`${relative(root, filePath)} missing IDAT data`);
    return null;
  }
  let inflated;
  try {
    inflated = zlib.inflateSync(idat);
  } catch (error) {
    failures.push(`${relative(root, filePath)} IDAT inflate failed: ${error?.message || String(error)}`);
    return null;
  }
  const rowBytes = width * channels;
  const expectedBytes = (rowBytes + 1) * height;
  if (inflated.length < expectedBytes) {
    failures.push(`${relative(root, filePath)} inflated data shorter than expected`);
    return null;
  }
  const previous = Buffer.alloc(rowBytes);
  const current = Buffer.alloc(rowBytes);
  let offset = 0;
  const seen = new Set();
  let transitions = 0;
  let last = null;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[offset];
    offset += 1;
    const raw = inflated.subarray(offset, offset + rowBytes);
    offset += rowBytes;
    try {
      unfilterPngRow(filter, raw, current, previous, channels);
    } catch (error) {
      failures.push(`${relative(root, filePath)} PNG decode failed: ${error?.message || String(error)}`);
      return null;
    }
    for (const byte of current) {
      seen.add(byte);
      if (last !== null && byte !== last) transitions += 1;
      last = byte;
      if (seen.size > 8 && transitions > 512) {
        return { nonblank: true, colorType, bitDepth, channels, sampleValues: seen.size };
      }
    }
    current.copy(previous);
  }
  return { nonblank: seen.size > 1 && transitions > 16, colorType, bitDepth, channels, sampleValues: seen.size };
}

function readPngChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function pngChannelCount(colorType) {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function unfilterPngRow(filter, raw, current, previous, bytesPerPixel) {
  for (let index = 0; index < raw.length; index += 1) {
    const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
    const up = previous[index] || 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
    let value = raw[index];
    if (filter === 1) value += left;
    else if (filter === 2) value += up;
    else if (filter === 3) value += Math.floor((left + up) / 2);
    else if (filter === 4) value += paeth(left, up, upLeft);
    else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    current[index] = value & 0xff;
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function validateActiveAuthorityProof({ root, proofRoot, failures }) {
  const proofPath = path.join(proofRoot, ACTIVE_AUTHORITY_PROOF);
  const proof = readJson(proofPath, failures);
  if (proof?.ok !== true) failures.push(`${relative(root, proofPath)} ok must be true`);
  const assertions = Array.isArray(proof?.assertions) ? proof.assertions : [];
  if (!assertions.length) failures.push(`${relative(root, proofPath)} assertions must be a non-empty array`);
  const failedAssertions = assertions.filter((assertion) => assertion?.ok !== true);
  for (const assertion of failedAssertions) {
    failures.push(`${relative(root, proofPath)} active authority assertion failed: ${assertion?.name || '<unnamed>'}`);
  }
  const commands = Array.isArray(proof?.commands) ? proof.commands : [];
  if (!commands.length) failures.push(`${relative(root, proofPath)} commands must be a non-empty array`);
  const failedCommands = commands.filter((command) => !commandPassed(command));
  for (const command of failedCommands) {
    failures.push(`${relative(root, proofPath)} active authority command failed: ${command?.name || command?.command || '<unnamed>'}`);
  }
  const qualityCounters = validateProofQualityCounters({ root, proofPath, proof, failures });
  const dockerReplay = commands.find((command) => command?.name === 'dockerReplay');
  if (!dockerReplay) {
    failures.push(`${relative(root, proofPath)} missing dockerReplay command`);
  } else {
    if (Number(dockerReplay.exitCode) !== 0) {
      failures.push(`${relative(root, proofPath)} dockerReplay exitCode must be 0`);
    }
    if (Number(dockerReplay.summary?.tests || 0) <= 0 || !commandPassed(dockerReplay)) {
      failures.push(`${relative(root, proofPath)} dockerReplay summary must contain passing tests and zero failures`);
    }
  }
  const requiredCommandNames = [
    'activityEndpointTests',
    'activeBoundaryTests',
    'runtimePrepTests',
    'gitServiceBoundaryTests',
    'dockerReplay',
  ];
  for (const name of requiredCommandNames) {
    if (!commands.some((command) => command?.name === name && commandPassed(command))) {
      failures.push(`${relative(root, proofPath)} missing passing ${name} command`);
    }
  }
  const png = validatePng(root, path.join(proofRoot, ACTIVE_AUTHORITY_PNG), failures);
  return {
    assertions: assertions.length,
    commands: commands.length,
    qualityCounters,
    dockerTests: Number(dockerReplay?.summary?.tests || 0),
    visualBytes: png?.bytes || 0,
    ok: proof?.ok === true
      && assertions.length > 0
      && failedAssertions.length === 0
      && commands.length > 0
      && failedCommands.length === 0
      && commandPassed(dockerReplay)
      && Boolean(png?.bytes),
  };
}

function validateMatureProofSuite({ root, proofRoot, failures }) {
  const artifacts = [];
  let assertionCount = 0;
  let commandCount = 0;
  let dockerCommandCount = 0;
  let visualCount = 0;
  let browserCaptureCount = 0;

  for (const spec of REQUIRED_MATURE_PROOFS) {
    const summary = validateMatureProofArtifact({ root, proofRoot, spec, failures });
    artifacts.push(summary);
    assertionCount += summary.assertions;
    commandCount += summary.commands;
    dockerCommandCount += summary.dockerCommands;
    visualCount += summary.visuals;
    browserCaptureCount += summary.browserCaptures;
  }

  return {
    required: REQUIRED_MATURE_PROOFS.length,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      plan: artifact.plan,
      assertions: artifact.assertions,
      visuals: artifact.visuals,
      browserCaptures: artifact.browserCaptures,
      commands: artifact.commands,
      dockerCommands: artifact.dockerCommands,
      qualityCounters: artifact.qualityCounters,
      metricThresholds: artifact.metricThresholds,
      ok: artifact.ok,
    })),
    assertions: assertionCount,
    visuals: visualCount,
    browserCaptures: browserCaptureCount,
    commands: commandCount,
    dockerCommands: dockerCommandCount,
    ok: artifacts.every((artifact) => artifact.ok),
  };
}

function validateMatureProofArtifact({ root, proofRoot, spec, failures }) {
  const beforeFailureCount = failures.length;
  const proofPath = path.join(proofRoot, spec.file);
  const proof = readJson(proofPath, failures);
  const summary = {
    name: spec.name,
    plan: spec.plan,
    file: relative(root, proofPath),
    assertions: 0,
    visuals: 0,
    browserCaptures: 0,
    commands: 0,
    dockerCommands: 0,
    ok: false,
  };

  if (!proof) {
    summary.ok = false;
    return summary;
  }

  if (proof.ok !== undefined && proof.ok !== true) {
    failures.push(`${relative(root, proofPath)} ok must be true`);
  }
  if (proof.status !== undefined && proof.status !== 'validated') {
    failures.push(`${relative(root, proofPath)} status expected validated, observed ${proof.status}`);
  }
  if (!proof.generatedAt) {
    failures.push(`${relative(root, proofPath)} missing generatedAt`);
  }

  const assertionSummary = validateProofAssertions({
    root,
    proofPath,
    assertions: proof.assertions,
    allowNoAssertions: spec.allowNoAssertions,
    failures,
  });
  summary.assertions = assertionSummary.total;

  for (const fileName of [spec.png, ...(spec.requiredScreenshots || [])].filter(Boolean)) {
    const png = validatePng(root, path.join(proofRoot, fileName), failures);
    if (png?.bytes) summary.visuals += 1;
  }

  if (spec.browserProof) {
    summary.browserCaptures = validateBrowserProof({
      root,
      proofRoot,
      proofPath,
      proof,
      requiredTruthies: spec.requiredCaptureTruthies || [],
      requiredCounts: spec.requiredCaptureCounts || [],
      failures,
    });
  }

  const commandSummary = validateProofCommands({
    root,
    proofPath,
    proof,
    requiredCommands: spec.requiredCommands || [],
    dockerCommand: spec.dockerCommand,
    failures,
  });
  summary.commands = commandSummary.commands;
  summary.dockerCommands = commandSummary.dockerCommands;
  summary.qualityCounters = commandSummary.qualityCounters;
  summary.metricThresholds = validateProofMetricThresholds({
    root,
    proofPath,
    proof,
    requiredMeasuredMetrics: spec.requiredMeasuredMetrics || [],
    requiredMetricThresholds: spec.requiredMetricThresholds || [],
    failures,
  });
  summary.ok = failures.length === beforeFailureCount;
  return summary;
}

function validateProofMetricThresholds({ root, proofPath, proof, requiredMeasuredMetrics, requiredMetricThresholds, failures }) {
  const metrics = proof?.metrics || proof?.metricSnapshot || proof?.metricProof?.metrics || null;
  const rowsByKey = metricRowsByKey(metrics);
  const summary = {
    requiredMeasured: requiredMeasuredMetrics.length,
    thresholds: requiredMetricThresholds.length,
    passed: 0,
  };
  if (!requiredMeasuredMetrics.length && !requiredMetricThresholds.length) return summary;
  if (!metrics || typeof metrics !== 'object') {
    failures.push(`${relative(root, proofPath)} missing metrics payload`);
    return summary;
  }
  for (const key of requiredMeasuredMetrics) {
    const row = rowsByKey.get(key);
    const value = metricValue(metrics, key, row);
    if (value == null || !Number.isFinite(Number(value))) {
      failures.push(`${relative(root, proofPath)} metric ${key} must be finite and measured`);
    }
    if (row && row.status && row.status !== 'measured') {
      failures.push(`${relative(root, proofPath)} metric ${key} status must be measured, observed ${row.status}`);
    }
  }
  for (const threshold of requiredMetricThresholds) {
    const value = Number(metricValue(metrics, threshold.key, rowsByKey.get(threshold.key)));
    if (!Number.isFinite(value)) {
      failures.push(`${relative(root, proofPath)} metric ${threshold.key} is not numeric`);
      continue;
    }
    if (threshold.min != null && value < Number(threshold.min)) {
      failures.push(`${relative(root, proofPath)} metric ${threshold.key} ${value} below minimum ${threshold.min}`);
      continue;
    }
    if (threshold.max != null && value > Number(threshold.max)) {
      failures.push(`${relative(root, proofPath)} metric ${threshold.key} ${value} above maximum ${threshold.max}`);
      continue;
    }
    summary.passed += 1;
  }
  return summary;
}

function metricRowsByKey(metrics) {
  const rows = new Map();
  for (const sectionRows of Object.values(metrics?.sections || {})) {
    if (!Array.isArray(sectionRows)) continue;
    for (const row of sectionRows) {
      if (row?.key) rows.set(row.key, row);
    }
  }
  return rows;
}

function metricValue(metrics, key, row = null) {
  if (metrics?.summary && Object.prototype.hasOwnProperty.call(metrics.summary, key)) return metrics.summary[key];
  if (row && Object.prototype.hasOwnProperty.call(row, 'value')) return row.value;
  return null;
}

function validateProofAssertions({ root, proofPath, assertions, allowNoAssertions, failures }) {
  const entries = normalizeAssertions(assertions);
  if (!entries.length) {
    if (!allowNoAssertions) failures.push(`${relative(root, proofPath)} assertions must be non-empty`);
    return { total: 0, failed: 0 };
  }
  const failed = entries.filter((entry) => entry.ok !== true);
  for (const entry of failed) {
    failures.push(`${relative(root, proofPath)} assertion failed: ${entry.name}`);
  }
  return { total: entries.length, failed: failed.length };
}

function normalizeAssertions(assertions) {
  if (Array.isArray(assertions)) {
    return assertions.map((assertion, index) => ({
      name: assertionName(assertion, index),
      ok: assertionOk(assertion),
    }));
  }
  if (assertions && typeof assertions === 'object') {
    return Object.entries(assertions).map(([name, value]) => ({
      name,
      ok: assertionOk(value),
    }));
  }
  return [];
}

function assertionName(assertion, index) {
  if (assertion && typeof assertion === 'object' && assertion.name) return assertion.name;
  return `assertion[${index}]`;
}

function assertionOk(assertion) {
  if (assertion === true) return true;
  if (!assertion || typeof assertion !== 'object') return false;
  if (assertion.ok !== undefined) return assertion.ok === true;
  if (assertion.passed !== undefined) return assertion.passed === true;
  if (assertion.value !== undefined) return assertion.value === true;
  if (assertion.status !== undefined) return assertion.status === 'passed' || assertion.status === 'pass';
  return false;
}

function validateProofCommands({ root, proofPath, proof, requiredCommands, dockerCommand, failures }) {
  const commandList = collectProofCommands(proof);
  const qualityCounters = validateProofQualityCounters({ root, proofPath, proof, failures });
  let dockerCommands = 0;

  for (const command of commandList) {
    if (command?.ok === false || (command?.exitCode !== undefined && Number(command.exitCode) !== 0)) {
      failures.push(`${relative(root, proofPath)} command failed: ${command?.name || command?.command || '<unnamed>'}`);
    }
    if (isDockerCommand(command)) dockerCommands += 1;
  }

  for (const name of requiredCommands) {
    if (!commandList.some((command) => command?.name === name && commandPassed(command))) {
      failures.push(`${relative(root, proofPath)} missing passing ${name} command`);
    }
  }

  if (dockerCommand) {
    const command = commandList.find((item) => item?.name === dockerCommand);
    if (!command) {
      failures.push(`${relative(root, proofPath)} missing ${dockerCommand} Docker command`);
    } else if (Number(command?.summary?.tests || 0) <= 0 || Number(command?.summary?.fail || 0) !== 0 || !commandPassed(command)) {
      failures.push(`${relative(root, proofPath)} ${dockerCommand} must report passing tests and zero failures`);
    }
  }

  return { commands: commandList.length, dockerCommands, qualityCounters };
}

function collectProofCommands(proof) {
  const commands = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.command === 'string' && !seen.has(value)) {
      seen.add(value);
      commands.push(value);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(proof);
  return commands;
}

function commandPassed(command) {
  if (!command || typeof command !== 'object') return false;
  if (command.ok === false) return false;
  if (command.exitCode !== undefined && Number(command.exitCode) !== 0) return false;
  return !hasBadTestCounters(command.summary) && !hasBadTestCounters(command.tap) && !hasBadTestCounters(command.testSummary);
}

function validateProofQualityCounters({ root, proofPath, proof, failures }) {
  const summaries = collectTestCounterObjects(proof);
  for (const item of summaries) {
    const badCounters = badTestCounters(item.value);
    for (const [key, value] of badCounters) {
      failures.push(`${relative(root, proofPath)} ${item.path}.${key} must be 0, observed ${value}`);
    }
  }
  return summaries.length;
}

function collectTestCounterObjects(proof) {
  const summaries = [];
  const seen = new Set();
  const visit = (value, keys = []) => {
    if (!value || typeof value !== 'object') return;
    const lastKey = keys.at(-1);
    if (!seen.has(value) && looksLikeTestCounterObject(value, lastKey, keys)) {
      seen.add(value);
      summaries.push({ path: keys.join('.') || '<root>', value });
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object') visit(child, [...keys, key]);
    }
  };
  visit(proof);
  return summaries;
}

function looksLikeTestCounterObject(value, lastKey, keys) {
  if (!value || typeof value !== 'object') return false;
  const hasCounter = ['tests', 'pass', 'fail', 'failed', 'failures', 'cancelled', 'skipped', 'todo']
    .some((key) => typeof value[key] === 'number');
  if (!hasCounter) return false;
  if (['summary', 'tap', 'testSummary'].includes(lastKey)) return true;
  return keys.some((key) => ['commands', 'hostTests', 'dockerNodeTests', 'steps'].includes(key));
}

function hasBadTestCounters(value) {
  return badTestCounters(value).length > 0;
}

function badTestCounters(value) {
  if (!value || typeof value !== 'object') return [];
  return ['fail', 'failed', 'failures', 'cancelled', 'skipped', 'todo']
    .filter((key) => typeof value[key] === 'number' && Number(value[key]) > 0)
    .map((key) => [key, Number(value[key])]);
}

function isDockerCommand(command) {
  const text = `${command?.name || ''} ${command?.command || ''} ${command?.runner || ''}`.toLowerCase();
  return text.includes('docker');
}

function validateBrowserProof({ root, proofRoot, proofPath, proof, requiredTruthies, requiredCounts, failures }) {
  const captures = Array.isArray(proof?.browserProof?.captures) ? proof.browserProof.captures : [];
  if (!captures.length) {
    failures.push(`${relative(root, proofPath)} browserProof.captures must be non-empty`);
    return 0;
  }

  for (const [index, capture] of captures.entries()) {
    const label = capture?.viewport?.name || `capture[${index}]`;
    const screenshotPath = resolveProofArtifactPath(root, proofRoot, capture?.screenshot);
    if (!screenshotPath) {
      failures.push(`${relative(root, proofPath)} ${label} missing screenshot path`);
    } else {
      validatePng(root, screenshotPath, failures);
    }
    if (Array.isArray(capture?.consoleErrors) && capture.consoleErrors.length > 0) {
      failures.push(`${relative(root, proofPath)} ${label} has console errors`);
    }
    for (const key of requiredTruthies) {
      if (capture?.checks?.[key] !== true) {
        failures.push(`${relative(root, proofPath)} ${label} expected checks.${key} true`);
      }
    }
    for (const key of requiredCounts) {
      if (Number(capture?.checks?.[key] || 0) <= 0) {
        failures.push(`${relative(root, proofPath)} ${label} expected checks.${key} to be positive`);
      }
    }
  }

  return captures.length;
}

function resolveProofArtifactPath(root, proofRoot, artifactPath) {
  if (!artifactPath) return null;
  const normalized = String(artifactPath);
  if (path.isAbsolute(normalized)) return normalized;
  const fromRoot = path.resolve(root, normalized);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return path.resolve(proofRoot, normalized);
}

function verifyProofBundles({ root, proofRoot, slug, proof, trustedKeysPath, failures }) {
  const appArtifactsRoot = path.join(proofRoot, 'app-artifacts', slug || '');
  const bundles = listFiles(appArtifactsRoot).filter((file) => file.endsWith('.proof.json'));
  let verified = 0;
  let gitVerified = 0;
  for (const bundlePath of bundles) {
    const trailersPath = bundlePath.replace(/\.proof\.json$/, '.trailers.txt');
    const bundle = readJson(bundlePath, failures);
    const gitContext = resolveProofBundleGitContext({
      root,
      proofRoot,
      slug,
      proof,
      bundle,
      bundlePath,
      bundleCount: bundles.length,
      failures,
    });
    const result = verifyProofBundleFile(bundlePath, {
      trailersPath,
      requireTrailers: true,
      repoPath: gitContext?.repoPath || null,
      commitSha: gitContext?.commitSha || null,
      requireGitCommit: true,
      trustedKeysPath,
      requireTrustedAuthority: true,
      allowEmbeddedPublicKey: false,
    });
    if (!result.ok) {
      failures.push(`${relative(root, bundlePath)} failed trusted proof verification: ${result.errors.join('; ')}`);
    } else if (!result.reasonCodes?.includes('proof_git_commit_trailers_match')) {
      failures.push(`${relative(root, bundlePath)} proof verification did not load matching actual git commit trailers`);
    } else {
      verified += 1;
      gitVerified += 1;
    }
  }
  if (bundles.length === 0) failures.push(`${relative(root, appArtifactsRoot)} contains no proof bundles`);
  return {
    found: bundles.length,
    verified,
    gitVerified,
    ok: bundles.length > 0 && verified === bundles.length && gitVerified === bundles.length,
  };
}

function resolveProofBundleGitContext({ root, proofRoot, slug, proof, bundle, bundlePath, bundleCount, failures }) {
  const repoPath = path.join(proofRoot, 'codesite-full-workflow-repos', slug || '');
  const commitSha = proofBundleCommitSha(proof, bundle, bundlePath, bundleCount);
  const label = relative(root, bundlePath);
  if (!commitSha) {
    failures.push(`${label} missing proof-bundle git commit provenance`);
    return null;
  }
  if (!fs.existsSync(repoPath)) {
    failures.push(`${label} proof-bundle git repo missing: ${relative(root, repoPath)}`);
    return null;
  }
  return { repoPath, commitSha };
}

function proofBundleCommitSha(proof, bundle, bundlePath, bundleCount) {
  const proofBundle = proof?.proofBundle || {};
  const proofGit = proof?.git || {};
  const candidates = [
    bundle?.commitSha,
    bundle?.gitCommitSha,
  ];
  const bundlePathText = String(bundlePath || '');
  const matchesWorkflowBundle = Boolean(
    (proofBundle.id && bundlePathText.includes(`/proof-bundles/${proofBundle.id}.proof.json`))
    || (proofBundle.transactionId && bundle?.transactionId === proofBundle.transactionId)
    || bundleCount === 1
  );
  if (matchesWorkflowBundle) {
    candidates.push(
      proofBundle.commitSha,
      proofGit.proofBundleCommitSha,
      proofGit.trailerCommit?.sha,
    );
  }
  return candidates.map((value) => String(value || '').trim()).find((value) => /^[0-9a-f]{7,64}$/i.test(value)) || null;
}

function resolveTrustedKeysPath(root, proofRoot, slug, failures) {
  const candidates = [
    process.env.CODESITE_RELEASE_GATE_TRUSTED_KEYS_PATH,
    path.join(proofRoot, `trusted-proof-authorities-${slug}.json`),
    path.join(proofRoot, 'trusted-proof-keys.json'),
  ].filter(Boolean);
  const trustedKeysPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (trustedKeysPath) return trustedKeysPath;
  failures.push(`trusted proof authorities missing: ${candidates.map((candidate) => relative(root, candidate)).join(', ')}`);
  return candidates[0] || path.join(proofRoot, `trusted-proof-authorities-${slug}.json`);
}

function validateProofGitProvenance({ root, proof, failures }) {
  const proofHead = String(proof?.run?.gitHead || '').trim();
  const proofScript = String(proof?.run?.proofScript || '').trim();
  if (!proofHead) {
    failures.push('workflow proof missing run.gitHead');
    return { ok: false, proofHead: null, currentHead: null, artifactOnlyPostProofChanges: false };
  }
  let currentHead = null;
  let mergeBase = null;
  let changedPaths = [];
  try {
    currentHead = git(root, ['rev-parse', 'HEAD']);
    mergeBase = git(root, ['merge-base', proofHead, currentHead]);
    changedPaths = git(root, ['diff', '--name-only', `${proofHead}..${currentHead}`])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const unavailableWorktree = unavailableExternalGitDir(root);
    if (unavailableWorktree) {
      return {
        ok: true,
        mode: 'git_unavailable_external_worktree_dir',
        proofHead,
        currentHead: null,
        postProofChangedPathCount: null,
        artifactOnlyPostProofChanges: null,
        warning: `Git provenance must be validated by the host release gate; container cannot access ${unavailableWorktree}`,
      };
    }
    failures.push(`unable to validate proof git provenance: ${error.message}`);
    return { ok: false, proofHead, currentHead, artifactOnlyPostProofChanges: false };
  }
  if (mergeBase !== proofHead) {
    failures.push(`workflow proof gitHead ${proofHead} is not an ancestor of current HEAD ${currentHead}`);
  }
  const allowedPostProofPrefixes = [
    'tmp/codesite-dojo-proof/',
  ];
  const disallowedPostProofChanges = changedPaths.filter((filePath) => (
    !allowedPostProofPrefixes.some((prefix) => filePath.startsWith(prefix))
  ));
  if (disallowedPostProofChanges.length) {
    failures.push(`post-proof non-artifact changes detected after ${proofHead}: ${disallowedPostProofChanges.join(', ')}`);
  }
  if (proofScript && changedPaths.includes(proofScript)) {
    failures.push(`proof script ${proofScript} changed after recorded proof gitHead ${proofHead}`);
  }
  return {
    ok: mergeBase === proofHead && disallowedPostProofChanges.length === 0 && !(proofScript && changedPaths.includes(proofScript)),
    proofHead,
    currentHead,
    postProofChangedPathCount: changedPaths.length,
    artifactOnlyPostProofChanges: disallowedPostProofChanges.length === 0,
    samplePostProofChangedPaths: changedPaths.slice(0, 24),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function unavailableExternalGitDir(root) {
  const gitPath = path.join(root, '.git');
  if (!fs.existsSync(gitPath)) return null;
  const stat = fs.statSync(gitPath);
  if (!stat.isFile()) return null;
  const text = fs.readFileSync(gitPath, 'utf8').trim();
  const match = text.match(/^gitdir:\s*(.+)$/i);
  if (!match) return null;
  const gitDir = path.isAbsolute(match[1])
    ? match[1]
    : path.resolve(root, match[1]);
  return fs.existsSync(gitDir) ? null : gitDir;
}

function validateCodexEvidence({ root, proofRoot, slug, failures }) {
  const evidenceRoot = path.join(proofRoot, 'codex-agent-evidence', slug || '');
  const candidateRecords = listFiles(evidenceRoot).filter((file) => file.endsWith('.json') && !file.endsWith('schema.json'));
  const records = [];
  const codeSiteToolNames = loadCodeSiteToolNames(root, failures);
  for (const candidatePath of candidateRecords) {
    const candidate = readJson(candidatePath, failures);
    if (candidate?.schemaVersion === 'synthi.codesite.codexAgentExecutionEvidence.v1') {
      records.push({ recordPath: candidatePath, record: candidate });
    }
  }
  let valid = 0;
  for (const { recordPath, record } of records) {
    const transcript = record?.transcript || {};
    let recordValid = true;
    const transcriptArtifacts = [
      ['eventsRawPath', 'eventsRawSha256'],
      ['stderrPath', 'stderrSha256'],
      ['finalMessagePath', 'finalMessageSha256'],
    ];
    for (const [pathKey, shaKey] of transcriptArtifacts) {
      const relativePath = transcript[pathKey];
      if (!relativePath) {
        failures.push(`${relative(root, recordPath)} missing transcript.${pathKey}`);
        recordValid = false;
        continue;
      }
      const absolutePath = path.resolve(root, relativePath);
      if (!fs.existsSync(absolutePath)) {
        failures.push(`${relative(root, recordPath)} references missing transcript artifact ${relativePath}`);
        recordValid = false;
        continue;
      }
      const expectedSha = transcript[shaKey];
      const actualSha = fileSha256(absolutePath);
      if (expectedSha !== actualSha) {
        failures.push(`${relative(root, recordPath)} transcript.${shaKey} mismatch for ${relativePath}`);
        recordValid = false;
      }
    }
    if (!record?.codexExecThreadId) {
      failures.push(`${relative(root, recordPath)} missing codexExecThreadId`);
      recordValid = false;
    }
    if (transcript.threadId && record?.codexExecThreadId && transcript.threadId !== record.codexExecThreadId) {
      failures.push(`${relative(root, recordPath)} transcript.threadId does not match codexExecThreadId`);
      recordValid = false;
    }
    if (Number(transcript.eventCount || 0) <= 0) {
      failures.push(`${relative(root, recordPath)} transcript.eventCount must be positive`);
      recordValid = false;
    }
    if (Number(transcript.toolEventCount || 0) <= 0) {
      failures.push(`${relative(root, recordPath)} transcript.toolEventCount must be positive`);
      recordValid = false;
    }
    if (!record?.providerSessionRef) {
      failures.push(`${relative(root, recordPath)} missing providerSessionRef`);
      recordValid = false;
    } else if (!/^codex[-_:]/i.test(String(record.providerSessionRef))) {
      failures.push(`${relative(root, recordPath)} providerSessionRef must identify a Codex session`);
      recordValid = false;
    }
    const actorProjection = record?.actorProjection || {};
    const actorProjectionArtifacts = [
      ['controlStatePath', 'controlStateSha256'],
      ['actionScriptPath', 'actionScriptSha256'],
      ['receiptPath', 'receiptSha256'],
    ];
    if (actorProjection.surface !== 'repo_local_codesite_projection') {
      failures.push(`${relative(root, recordPath)} actorProjection.surface must be repo_local_codesite_projection`);
      recordValid = false;
    }
    for (const [pathKey, shaKey] of actorProjectionArtifacts) {
      const relativePath = actorProjection[pathKey];
      if (!relativePath) {
        failures.push(`${relative(root, recordPath)} missing actorProjection.${pathKey}`);
        recordValid = false;
        continue;
      }
      const absolutePath = path.resolve(root, relativePath);
      if (!fs.existsSync(absolutePath)) {
        failures.push(`${relative(root, recordPath)} references missing actor projection artifact ${relativePath}`);
        recordValid = false;
        continue;
      }
      const expectedSha = actorProjection[shaKey];
      const actualSha = fileSha256(absolutePath);
      if (expectedSha !== actualSha) {
        failures.push(`${relative(root, recordPath)} actorProjection.${shaKey} mismatch for ${relativePath}`);
        recordValid = false;
      }
    }
    const workflowActions = Array.isArray(record?.workflowActions) ? record.workflowActions : [];
    const requiredWorkflowActions = roleWorkflowActionRequirements(record?.role);
    const missingWorkflowActions = requiredWorkflowActions.filter((kind) => !workflowActions.some((action) => action?.kind === kind));
    if (workflowActions.length === 0) {
      failures.push(`${relative(root, recordPath)} workflowActions must not be empty`);
      recordValid = false;
    }
    if (missingWorkflowActions.length) {
      failures.push(`${relative(root, recordPath)} missing workflow action receipts: ${missingWorkflowActions.join(', ')}`);
      recordValid = false;
    }
    const commandTexts = Array.isArray(record?.commands) ? record.commands.map((command) => normalizeCommandText(command?.command)) : [];
    workflowActions.forEach((action, index) => {
      const label = `${relative(root, recordPath)} workflowActions.${index}`;
      if (action?.source !== 'codesite_repo_local_projection_actor') {
        failures.push(`${label}.source must be codesite_repo_local_projection_actor`);
        recordValid = false;
      }
      if (!action?.receiptDigest || !action?.action || !action?.kind) {
        failures.push(`${label} missing receiptDigest/action/kind`);
        recordValid = false;
      }
      if (!action?.tool) {
        failures.push(`${label} missing MCP tool name`);
        recordValid = false;
      } else if (!codeSiteToolNames.has(action.tool)) {
        failures.push(`${label} references unknown MCP tool ${action.tool}`);
        recordValid = false;
      }
      if (action?.projectionControlStateSha256 !== actorProjection.controlStateSha256) {
        failures.push(`${label}.projectionControlStateSha256 does not match actorProjection.controlStateSha256`);
        recordValid = false;
      }
      if (action?.actionScriptSha256 !== actorProjection.actionScriptSha256) {
        failures.push(`${label}.actionScriptSha256 does not match actorProjection.actionScriptSha256`);
        recordValid = false;
      }
      if (!workflowActionBackedByTranscript(action, commandTexts)) {
        failures.push(`${label} is not backed by a Codex transcript command`);
        recordValid = false;
      }
    });
    const commands = Array.isArray(record?.commands) ? record.commands : [];
    if (commands.length === 0) {
      failures.push(`${relative(root, recordPath)} commands must not be empty`);
      recordValid = false;
    }
    commands.forEach((command, index) => {
      const commandLabel = `${relative(root, recordPath)} commands.${index}`;
      if (command?.source !== 'codex_jsonl_command_execution') {
        failures.push(`${commandLabel}.source must be codex_jsonl_command_execution`);
        recordValid = false;
      }
      if (!command?.transcriptEventId) {
        failures.push(`${commandLabel}.transcriptEventId is required`);
        recordValid = false;
      }
      if (Number(command?.exitCode) !== 0 || command?.status !== 'completed') {
        failures.push(`${commandLabel} failed transcript command: status=${command?.status || 'missing'} exitCode=${command?.exitCode ?? 'missing'}`);
        recordValid = false;
      }
      if (!command?.evidenceDigest || !command?.outputDigest) {
        failures.push(`${commandLabel} missing command digests`);
        recordValid = false;
      }
    });
    if (recordValid) valid += 1;
  }
  if (records.length < 3) failures.push(`${relative(root, evidenceRoot)} must contain at least three Codex role evidence records`);
  return { records: records.length, valid, ok: records.length >= 3 && valid === records.length };
}

function loadCodeSiteToolNames(root, failures) {
  const candidates = [
    path.join(root, 'mcp/synthi-mcp/src/tools/codesite.ts'),
    path.join(root, 'mcp/synthi-mcp/src/tool_registry.ts'),
    path.join(root, 'synthi/src/lib/codesite/artifacts.js'),
  ];
  const names = new Set();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const source = fs.readFileSync(candidate, 'utf8');
    for (const match of source.matchAll(/['"](synthi_codesite_[a-z0-9_]+)['"]/g)) {
      names.add(match[1]);
    }
  }
  if (names.size === 0) failures.push('unable to load CodeSite MCP tool registry');
  return names;
}

function roleWorkflowActionRequirements(role) {
  if (role === 'schema') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'mutation_lease_requested',
      'mutation_transaction_opened',
      'assumption_recorded',
      'controlled_write_proposed',
      'inspection_requested',
      'commit_requested',
    ];
  }
  if (role === 'backend') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'inbox_read',
      'inbox_event_acknowledged',
      'change_order_filed',
      'stale_transaction_aborted',
    ];
  }
  if (role === 'inspection') {
    return [
      'control_state_read',
      'execution_plan_filed',
      'landing_requested',
      'metrics_read',
    ];
  }
  return [];
}

function normalizeCommandText(value) {
  return String(value || '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim()
    .replace(/\s+/g, ' ');
}

function workflowActionBackedByTranscript(action, transcriptCommands = []) {
  const commandAction = String(action?.action || '').trim();
  if (!commandAction) return false;
  return transcriptCommands.some((command) => (
    String(command || '').includes('codesite-agent-action.mjs')
    && String(command || '').includes(` ${commandAction}`)
  ));
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
