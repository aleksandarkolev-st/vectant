import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../mcp/synthi-mcp/dist/dojo/proof/signing.js';

const require = createRequire(import.meta.url);
const {
  collectCodeSiteRepoState,
  createCodeSiteFS,
  createCodeSiteQuarantineWorkspace,
  deriveLineProvenanceFromContentChange,
  finalizeCodeSiteQuarantineWorkspace,
} = require('../../backend/collab-server/codesiteFs.js');
const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = 'http://127.0.0.1:3107';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function outDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function containerRepoRoot(hostPath) {
  const containerRoot = process.env.CODESITE_PROOF_CONTAINER_WORKSPACE_ROOT || '/workspace';
  const relative = path.relative(repoRoot(), hostPath).split(path.sep).join('/');
  return path.posix.join(containerRoot, relative);
}

function slugNow() {
  return `codesite-full-workflow-proof-${Date.now()}`;
}

function signedDojoProof(slug) {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-full-workflow-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-full-workflow-schema',
    skill_id: 'codesite.schema',
    skill_version: '2026-06-25.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'schema.level_2@2026-06-25',
    issuer: 'dojo-full-workflow-issuer',
    key_id: keyPair.key_id,
    nonce: `nonce-${Date.now()}`,
    ledger_checkpoint_hash: 'd'.repeat(64),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: ['evidence:full-workflow-checkride'],
    }],
    evidence_record_ids: ['full-workflow-checkride'],
    issued_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-07-02T00:00:00.000Z',
    signature_algorithm: 'ed25519',
  };
  const signature = signer.sign(canonicalDojoProofPayload(unsignedCapsule));
  return {
    dojoProofCapsule: {
      ...unsignedCapsule,
      signature: signature.signature,
    },
    dojoProofKey: {
      schema_version: 'synthi.dojo.proofKey.v1',
      tenant_id: slug,
      key_id: keyPair.key_id,
      issuer: 'dojo-full-workflow-issuer',
      algorithm: 'ed25519',
      signing_provider: 'ed25519-local',
      key_custody: 'local',
      public_key_pem: keyPair.public_key_pem,
      status: 'active',
      created_at: '2026-06-29T00:00:00.000Z',
      retain_for_forensic_verification: false,
    },
    dojoRequiredEvidenceClaims: ['codesite.restricted_mutation'],
    implementationStatus: { executable: true, productionRuntime: false },
  };
}

function createApi(baseUrl, slug) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  async function api(route, options = {}) {
    const response = await fetch(`${apiBase}${route}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${options.method || 'GET'} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }
  api.baseUrl = apiBase;
  return api;
}

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
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

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

async function prepareProofRepo({ dir, slug, changedPath, readPath }) {
  const hostRoot = path.join(dir, 'codesite-full-workflow-repos', slug);
  await fs.promises.rm(hostRoot, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(path.join(hostRoot, changedPath)), { recursive: true });
  await fs.promises.mkdir(path.dirname(path.join(hostRoot, readPath)), { recursive: true });
  const before = [
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    'model User {',
    '  id    String @id',
    '  email String @unique',
    '}',
    '',
  ].join('\n');
  const after = [
    before,
    'model AuditEvent {',
    '  id        String   @id',
    '  userId    String',
    '  createdAt DateTime @default(now())',
    '}',
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(hostRoot, changedPath), before, 'utf8');
  await fs.promises.writeFile(path.join(hostRoot, readPath), 'schema-contract-read-v1\n', 'utf8');
  await run('git', ['init'], { cwd: hostRoot });
  await run('git', ['config', 'user.email', 'codesite-proof@example.invalid'], { cwd: hostRoot });
  await run('git', ['config', 'user.name', 'CodeSite Proof'], { cwd: hostRoot });
  await run('git', ['add', '.'], { cwd: hostRoot });
  await run('git', ['commit', '-m', 'Initial CodeSite proof repo'], { cwd: hostRoot });
  return {
    hostRoot,
    containerRoot: containerRepoRoot(hostRoot),
    before,
    after,
  };
}

async function buildContainerReadableSnapshot(readSet, hostRepoRoot, containerRoot) {
  const fileDigests = await Promise.all(readSet.map(async (filePath) => {
    const absolutePath = path.join(hostRepoRoot, filePath);
    const content = await fs.promises.readFile(absolutePath);
    const stat = await fs.promises.stat(absolutePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    };
  }));
  const evidence = {
    schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
    status: 'recorded',
    readSet,
    repoRoot: containerRoot,
    fileDigests,
    missingPaths: [],
    skippedPaths: [],
    truncated: false,
    limits: {
      maxFiles: 512,
      maxFileBytes: 2 * 1024 * 1024,
      maxScanEntries: 15000,
    },
    generatedAt: new Date().toISOString(),
    source: 'codesite-full-workflow-proof',
  };
  evidence.snapshotDigest = digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    readSet: evidence.readSet,
    fileDigests: evidence.fileDigests,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths,
    truncated: evidence.truncated,
    limits: evidence.limits,
  });
  evidence.evidenceDigest = digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    readSet: evidence.readSet,
    snapshotDigest: evidence.snapshotDigest,
    fileCount: evidence.fileDigests.length,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths,
    truncated: evidence.truncated,
    source: evidence.source,
  });
  return evidence;
}

async function runVerifier({ proofBundle, exportPaths }) {
  const bundleRel = exportPaths.find((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.proof.json`));
  const trailersRel = exportPaths.find((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.trailers.txt`));
  if (!bundleRel || !trailersRel) {
    return {
      ok: false,
      reason: 'proof_bundle_export_missing',
      bundleRel: bundleRel || null,
      trailersRel: trailersRel || null,
    };
  }
  const artifactRoot = path.join(repoRoot(), '.synthi', 'codesite');
  const bundlePath = path.join(artifactRoot, bundleRel);
  const trailersPath = path.join(artifactRoot, trailersRel);
  const result = await run('node', [
    'scripts/codesite-proof-verify.mjs',
    '--bundle',
    bundlePath,
    '--trailers',
    trailersPath,
    '--require-trailers',
  ], { cwd: path.join(repoRoot(), 'synthi') }).then(
    ({ stdout, stderr }) => ({ ok: true, stdout, stderr, bundlePath, trailersPath }),
    (error) => ({
      ok: false,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      message: error.message,
      bundlePath,
      trailersPath,
    }),
  );
  try {
    result.json = JSON.parse(result.stdout);
  } catch {
    result.json = null;
  }
  return result;
}

function proofHtml(proof) {
  const summary = [
    ['Workspace', proof.slug],
    ['Project', proof.project.title],
    ['Schema clearance', `${proof.clearance.callsign} ${proof.clearance.status}`],
    ['Transaction', `${proof.transaction.id} ${proof.transaction.status}`],
    ['Proof bundle', `${proof.proofBundle.id} ${proof.proofBundle.bundleDigest}`],
    ['CodeSiteFS', `${proof.codesiteFs.denied.disposition}, ${proof.codesiteFs.quarantined.disposition}`],
    ['Line provenance', proof.lineProvenance.map((row) => `${row.filePath} ${row.lineAnchor}`).join(', ')],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Full Workflow Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090e;color:#f4f5f8}
body{margin:0;padding:28px;background:#08090e}
main{max-width:1180px;margin:0 auto}
.hero{border:1px solid #2a3147;border-radius:8px;background:#11131d;padding:22px;margin-bottom:16px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{margin:0 0 8px;font-size:24px;letter-spacing:0}
h2{font-size:18px;margin:22px 0 10px}
p{color:#9ba2b8;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{border:1px solid #24283a;border-radius:8px;background:#10121b;padding:14px;min-height:70px}
.label{color:#9ba2b8;font-size:12px}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;border:1px solid #24283a;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Full Workflow Proof</h1>
<p>Live Docker workflow: schema-first clearance, CodeSiteFS denial and quarantine, transaction write with line provenance, landing inspection, proof bundle, commit trailers, artifact export, and browser UI capture.</p>
</section>
<section class="grid">
${summary.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('\n')}
</section>
<h2>Assertions</h2>
<pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre>
<h2>Commit Trailers</h2>
<pre>${escapeHtml(Object.entries(proof.proofBundle.trailers || {}).map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function screenshotHtml(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function screenshotLiveUi({ baseUrl, slug, pngPath, proofSectionPngPath }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="codesite-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-radar-graph"]', { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: pngPath, fullPage: false });
  await page.waitForSelector('text=CodeSite-Transaction', { timeout: 60000 });
  await page.waitForSelector('text=Line Provenance', { timeout: 60000 });
  await page.waitForSelector('text=synthi/prisma/schema.prisma', { timeout: 60000 });
  await page.getByText('CodeSite-Transaction').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  if (proofSectionPngPath) {
    await page.screenshot({ path: proofSectionPngPath, fullPage: false });
  }
  await browser.close();
  return { consoleErrors };
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const api = createApi(baseUrl, slug);
  const dir = outDir();
  fs.mkdirSync(dir, { recursive: true });

  const changedPath = 'synthi/prisma/schema.prisma';
  const readPath = 'synthi/prisma/schema-contract-read.txt';
  const proofRepo = await prepareProofRepo({ dir, slug, changedPath, readPath });
  const baseSnapshotEvidence = await buildContainerReadableSnapshot([readPath], proofRepo.hostRoot, proofRepo.containerRoot);
  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Full workflow proof',
      request: 'Land schema contract before dependent backend mutation',
      autoWorkflow: true,
      strategy: 'airspace_survey_first',
      zonePolicy: {
        zones: [{ zoneKey: 'schema', label: 'Schema runway', class: 'B', paths: ['synthi/prisma/**'], risk: 'high' }],
        noFlyZones: ['secrets/**'],
      },
      missions: [
        { callsign: 'SCHEMA-01', domain: 'schema', mission: 'Schema first', route: ['synthi/prisma/**'], requestedTools: ['file_write', 'npm_test'] },
        { callsign: 'API-02', domain: 'backend', mission: 'Dependent API', route: ['synthi/prisma/**'], requestedTools: ['file_write', 'npm_test'] },
        { callsign: 'TEST-03', domain: 'inspection', mission: 'Landing radar', route: ['synthi/src/lib/codesite/__tests__/**'], requestedTools: ['npm_test'] },
      ],
    }),
  });
  const project = projectResponse.project;
  const schemaPlan = requireValue(project.executionPlans.find((plan) => plan.displayCallsign === 'SCHEMA-01'), 'schema execution plan missing');

  const leaseResponse = await api(`/execution-plans/${encodeURIComponent(schemaPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['synthi/prisma/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['typecheck', 'tests'],
      ...signedDojoProof(slug),
    }),
  });
  const lease = leaseResponse.mutationLease;

  const transactionResponse = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      baseSnapshot: baseSnapshotEvidence.snapshotDigest,
      baseSnapshotEvidence,
      readSet: [readPath],
      writeSet: [changedPath],
      invariants: ['clearance.diff.inside_route'],
    }),
  });
  const transaction = transactionResponse.transaction;

  const codesiteContext = {
    active: true,
    required: true,
    managedAgent: true,
    workspaceSlug: slug,
    transactionId: transaction.id,
    mutationLeaseId: lease.id,
    displayCallsign: 'SCHEMA-01',
    allowedTools: ['file_write'],
    controlPlaneUrl: api.baseUrl,
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
  };
  const codesiteFs = createCodeSiteFS(codesiteContext, {
    fetch,
    repoRoot: proofRepo.hostRoot,
    requireAuthoritativeContext: true,
  });
  let deniedApplyCalled = false;
  let deniedError = null;
  try {
    await codesiteFs.apply({
      path: 'secrets/prod.env',
      tool: 'file_write',
      kind: 'raw-terminal-write',
      evidenceRefs: ['mcp:audit:codesitefs-denied-full-workflow'],
    }, async () => {
      deniedApplyCalled = true;
      await fs.promises.mkdir(path.join(proofRepo.hostRoot, 'secrets'), { recursive: true });
      await fs.promises.writeFile(path.join(proofRepo.hostRoot, 'secrets/prod.env'), 'DATABASE_URL=postgres://prod\n', 'utf8');
    });
  } catch (error) {
    deniedError = error;
  }
  assertProof(deniedError?.code === 'CODESITE_WRITE_DENIED', 'CodeSiteFS denied write did not fail closed');

  const quarantine = await createCodeSiteQuarantineWorkspace(codesiteContext, proofRepo.hostRoot, {
    baseDir: path.join(dir, 'codesite-full-workflow-quarantine'),
    operation: 'raw_terminal',
  });
  await fs.promises.writeFile(path.join(quarantine.cwd, changedPath), proofRepo.after.replace('AuditEvent', 'QuarantinedAuditEvent'), 'utf8');
  const quarantineResult = await finalizeCodeSiteQuarantineWorkspace(codesiteContext, quarantine, {
    fetch,
    cleanup: true,
  });
  const quarantinedRecord = quarantineResult.recorded.find((item) => item.path === changedPath);
  const lineProvenance = deriveLineProvenanceFromContentChange(changedPath, proofRepo.before, proofRepo.after, {
    reasonRef: 'full-workflow-schema-change',
    evidenceRefs: ['mcp:audit:write-full-workflow'],
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
    promptSummary: 'Land schema-first full workflow proof',
  });
  const allowedApply = await codesiteFs.apply({
    path: changedPath,
    tool: 'file_write',
    kind: 'write-file',
    lineProvenance,
    evidenceRefs: ['mcp:audit:write-full-workflow'],
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:tmp-proof-session'],
  }, async () => {
    await fs.promises.writeFile(path.join(proofRepo.hostRoot, changedPath), proofRepo.after, 'utf8');
    return { bytesWritten: Buffer.byteLength(proofRepo.after, 'utf8') };
  });
  const writeResponse = allowedApply.eventRecord;
  const repoState = await collectCodeSiteRepoState(proofRepo.hostRoot, {
    workspaceSlug: slug,
    transactionId: transaction.id,
    baseSnapshot: baseSnapshotEvidence.snapshotDigest,
    writePaths: [changedPath],
  });

  const nodeCheckScript = "const fs=require('fs'); fs.accessSync('synthi/prisma/schema.prisma');";
  const nodeTestScript = "const fs=require('fs'); const text=fs.readFileSync('synthi/prisma/schema.prisma','utf8'); if (!text.includes('model AuditEvent')) process.exit(1);";
  const inspectionResponse = await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: schemaPlan.id,
      displayCallsign: 'SCHEMA-01',
      changedPaths: [changedPath],
      execute: true,
      repoRoot: proofRepo.containerRoot,
      commands: [
        { key: 'typecheck', command: 'node', args: ['-e', nodeCheckScript], timeoutMs: 30000 },
        { key: 'tests', command: 'node', args: ['-e', nodeTestScript], timeoutMs: 30000 },
      ],
      evidenceRefs: ['runtime:event:inspection-full-workflow'],
    }),
  });

  const commitResponse = await api(`/transactions/${encodeURIComponent(transaction.id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      repoState,
      evidenceRefs: ['mcp:audit:commit-full-workflow'],
    }),
  });
  assertProof(commitResponse.transaction?.status === 'committed', `transaction did not commit: ${JSON.stringify(commitResponse)}`);

  const proofBundle = commitResponse.proofBundle;
  const exported = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const [projectAfter, controlState, events] = await Promise.all([
    api(`/projects/${encodeURIComponent(project.id)}`),
    api(`/projects/${encodeURIComponent(project.id)}/control-state`),
    api(`/projects/${encodeURIComponent(project.id)}/events`),
  ]);
  const lineRows = projectAfter.project.lineProvenance || [];
  const exportPaths = (exported.files || []).map((file) => (
    typeof file === 'string' ? file : file.relativePath || file.path
  )).filter(Boolean);
  const eventTypes = events.events.map((event) => event.eventType);
  const verifier = await runVerifier({ proofBundle, exportPaths });
  const browserShot = path.join(dir, 'codesite-full-workflow-ui.png');
  const browserProofSectionShot = path.join(dir, 'codesite-full-workflow-ui-proof-section.png');
  const browserProof = await screenshotLiveUi({
    baseUrl,
    slug,
    pngPath: browserShot,
    proofSectionPngPath: browserProofSectionShot,
  });

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: {
      id: project.id,
      title: project.title,
      route: `/workspace/${slug}/codesite`,
    },
    clearance: {
      id: lease.id,
      callsign: lease.displayCallsign,
      status: lease.status,
      reasonCodes: lease.policyDecision?.reasonCodes || [],
      towerInstruction: lease.lease?.towerInstruction,
      dojoProofRef: lease.dojoProofRef,
      dojoDecisionDigest: lease.dojoDecisionDigest,
    },
    codesiteFs: {
      denied: {
        ok: false,
        disposition: deniedError.event?.type || null,
        path: deniedError.event?.path || 'secrets/prod.env',
        reasonCodes: deniedError.event?.details?.reason_codes || [],
        applyCalled: deniedApplyCalled,
        repoMutated: fs.existsSync(path.join(proofRepo.hostRoot, 'secrets/prod.env')),
      },
      quarantined: {
        ok: false,
        disposition: 'write_quarantined',
        path: quarantinedRecord?.path || null,
        recorded: Boolean(quarantinedRecord?.ok),
        changes: quarantineResult.changes.map((change) => ({ path: change.path, kind: change.kind, evidenceRef: change.quarantineEvidence?.evidenceRef || null })),
      },
      allowed: {
        phase: allowedApply.phase,
        path: allowedApply.path,
        eventRecordOk: writeResponse?.ok === true,
        verification: allowedApply.verification,
      },
    },
    transaction: {
      id: commitResponse.transaction.id,
      status: commitResponse.transaction.status,
      writeSet: commitResponse.transaction.writeSet,
      proofBundleDigest: commitResponse.transaction.proofBundleDigest,
    },
    inspection: inspectionResponse.inspectionRun,
    repoState,
    proofBundle,
    lineProvenance: lineRows,
    exported: {
      fileCount: exportPaths.length,
      paths: exportPaths,
      verifier: {
        ok: verifier.ok,
        bundlePath: verifier.bundlePath ? path.relative(repoRoot(), verifier.bundlePath) : null,
        trailersPath: verifier.trailersPath ? path.relative(repoRoot(), verifier.trailersPath) : null,
        checks: verifier.json?.checks || [],
        errors: verifier.json?.errors || [],
      },
    },
    controlState: {
      towerState: controlState.towerState,
      activeFlights: controlState.activeFlights.map((flight) => ({ callsign: flight.displayCallsign, status: flight.status, route: flight.route })),
      riskLevel: controlState.collisionForecast.riskLevel,
    },
    eventTypes,
    browserProof: {
      screenshot: path.relative(repoRoot(), browserShot),
      proofSectionScreenshot: path.relative(repoRoot(), browserProofSectionShot),
      consoleErrors: browserProof.consoleErrors,
    },
    assertions: {
      schemaClearanceActive: lease.status === 'active',
      dependentFlightHeld: controlState.activeFlights.some((flight) => flight.displayCallsign === 'API-02' && flight.status === 'holding'),
      deniedWriteRecorded: deniedError.event?.type === 'write_denied' && deniedApplyCalled === false && !fs.existsSync(path.join(proofRepo.hostRoot, 'secrets/prod.env')) && eventTypes.includes('write_denied'),
      quarantinedWriteRecorded: Boolean(quarantinedRecord?.ok) && eventTypes.includes('write_quarantined'),
      allowedWriteRecorded: writeResponse?.ok === true && allowedApply.verification?.ok === true && eventTypes.includes('write_allowed'),
      transactionCommitted: commitResponse.transaction.status === 'committed',
      proofBundleCreated: Boolean(proofBundle?.id && proofBundle?.bundleDigest),
      commitTrailersPresent: Boolean(proofBundle?.trailers?.['CodeSite-Transaction'] && proofBundle?.trailers?.['CodeSite-Clearance']),
      repoSnapshotRecorded: baseSnapshotEvidence.status === 'recorded' && commitResponse.transaction.commitDecision?.repoSnapshot?.reasonCodes?.includes('repo_snapshot_stable'),
      repoStateCollectedFromRealRepo: repoState.source === 'collab-server' && repoState.writeFileDigests?.some((file) => file.path === changedPath && file.exists && /^sha256:/.test(file.digest || '')),
      inspectionCommandsExecuted: inspectionResponse.inspectionRun.status === 'completed'
        && inspectionResponse.inspectionRun.inspectionSignals.some((signal) => signal.key === 'typecheck' && signal.source === 'codesite_inspection_executor')
        && inspectionResponse.inspectionRun.inspectionSignals.some((signal) => signal.key === 'tests' && signal.source === 'codesite_inspection_executor'),
      lineProvenanceSeeded: lineRows.some((row) => row.filePath === changedPath && lineProvenance.some((line) => line.lineAnchor === row.lineAnchor)),
      artifactsExported: exportPaths.some((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.proof.json`))
        && exportPaths.some((item) => item.endsWith(`/proof-bundles/${proofBundle.id}.trailers.txt`)),
      exportedProofVerifies: verifier.ok === true && verifier.json?.ok === true,
      browserUiCaptured: fs.existsSync(browserShot) && fs.existsSync(browserProofSectionShot) && browserProof.consoleErrors.length === 0,
    },
  };
  const failed = Object.entries(proof.assertions).filter(([, value]) => value !== true);
  if (failed.length) {
    throw new Error(`full workflow proof assertions failed: ${JSON.stringify(failed)}`);
  }

  const jsonPath = path.join(dir, 'codesite-full-workflow-proof.json');
  const htmlPath = path.join(dir, 'codesite-full-workflow-proof.html');
  const pngPath = path.join(dir, 'codesite-full-workflow-proof.png');
  fs.writeFileSync(jsonPath, JSON.stringify(proof, null, 2));
  fs.writeFileSync(htmlPath, proofHtml(proof));
  await screenshotHtml(htmlPath, pngPath);

  console.log(JSON.stringify({
    proof: path.relative(repoRoot(), jsonPath),
    html: path.relative(repoRoot(), htmlPath),
    screenshot: path.relative(repoRoot(), pngPath),
    browserScreenshot: path.relative(repoRoot(), browserShot),
    browserProofSectionScreenshot: path.relative(repoRoot(), browserProofSectionShot),
    assertions: proof.assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
