import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ensureProofWorkspace } from './codesite-proof-api.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3107';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-repo-local-autosync-proof-${Date.now()}`;
}

function safeSegment(value) {
  return String(value || 'workspace').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function gitValue(args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function artifactRoot(slug) {
  if (process.env.CODESITE_PROOF_APP_ARTIFACT_HOST_ROOT) {
    return path.resolve(process.env.CODESITE_PROOF_APP_ARTIFACT_HOST_ROOT, safeSegment(slug), '.synthi', 'codesite');
  }
  if (process.env.SYNTHI_CODESITE_ARTIFACT_ROOT) {
    return path.resolve(process.env.SYNTHI_CODESITE_ARTIFACT_ROOT, safeSegment(slug), '.synthi', 'codesite');
  }
  return path.join(repoRoot(), '.synthi', 'codesite');
}

function createApi(baseUrl, slug) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  const calledRoutes = [];
  async function api(route, options = {}) {
    calledRoutes.push(`${options.method || 'GET'} ${route}`);
    if (route.includes('/artifacts/export')) {
      throw new Error('proof must not call explicit artifact export');
    }
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
  api.calledRoutes = calledRoutes;
  return api;
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForJson(file, predicate = () => true, timeoutMs = 10000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (predicate(parsed)) return parsed;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`artifact json not ready: ${file}${lastError ? ` (${lastError.message})` : ''}`);
}

async function waitForText(file, predicate = () => true, timeoutMs = 10000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (predicate(text)) return text;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`artifact text not ready: ${file}${lastError ? ` (${lastError.message})` : ''}`);
}

function proofHtml(proof) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Repo-Local Autosync Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#07090d;color:#f4f7fb}
body{margin:0;padding:28px;background:#07090d}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #273044;border-radius:8px;background:#10141d;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{font-size:25px;margin:8px 0 6px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px;letter-spacing:0}
p{margin:0;color:#aeb7c8;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.label{font-size:12px;color:#98a2b8}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-top:1px solid #273044;padding:8px;text-align:left;vertical-align:top}
th{color:#aeb7c8;font-weight:600}
pre{white-space:pre-wrap;border:1px solid #273044;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Repo-Local Autosync Proof</h1>
<p>Live Docker workflow using public CodeSite APIs only. The proof never calls artifact export; it reads .synthi/codesite directly after project, RFI, inbox acknowledgement, assumption invalidation, inspection, and proof-carrying commit mutations.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Project</div><div class="value">${escapeHtml(proof.project.id)}</div></div>
<div class="card"><div class="label">Artifact root</div><div class="value">${escapeHtml(proof.artifactRoot)}</div></div>
<div class="card"><div class="label">Proof bundle</div><div class="value">${escapeHtml(proof.proofBundle.id)}</div></div>
</section>
<section class="card"><h2>Repo-Local Checkpoints</h2><table><thead><tr><th>Checkpoint</th><th>Artifact</th><th>Observed state</th></tr></thead><tbody>${proof.checkpoints.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.path)}</td><td>${escapeHtml(row.state)}</td></tr>`).join('\n')}</tbody></table></section>
<section class="card"><h2>Control State</h2><pre>${escapeHtml(JSON.stringify(proof.controlStateSummary, null, 2))}</pre></section>
<section class="card"><h2>Verifier</h2><pre>${escapeHtml(JSON.stringify(proof.verifier, null, 2))}</pre></section>
<section><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
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

async function screenshotSummary(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

function verifyProofBundle(bundlePath, trailersPath) {
  const verifierEnv = { ...process.env };
  if (!verifierEnv.SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET && !verifierEnv.SYNTHI_CODESITE_PROOF_AUTHORITY_SECRET_FILE) {
    delete verifierEnv.AUTH_SECRET;
    delete verifierEnv.NEXTAUTH_SECRET;
  }
  const output = execFileSync(process.execPath, [
    path.join(repoRoot(), 'synthi', 'scripts', 'codesite-proof-verify.mjs'),
    '--bundle',
    bundlePath,
    '--trailers',
    trailersPath,
    '--require-trailers',
  ], { encoding: 'utf8', env: verifierEnv });
  return JSON.parse(output);
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = proofDir();
  fs.mkdirSync(dir, { recursive: true });
  const root = artifactRoot(slug);
  const { api } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Repo-local autosync proof workspace',
    apiOptions: {
      trackRoutes: true,
      rejectRoute: (route) => route.includes('/artifacts/export'),
    },
  });

  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Repo-local autosync proof',
      request: 'Prove CLI agents can use .synthi/codesite without browser export',
      zonePolicy: {
        zones: [
          { zoneKey: 'autosync_contract', label: 'Autosync contract', class: 'C', paths: ['src/contracts/**'], rules: ['landing_inspection_required'], risk: 'medium' },
          { zoneKey: 'autosync_ui', label: 'Autosync UI', class: 'C', paths: ['src/components/**'], rules: ['landing_inspection_required'], risk: 'medium' },
        ],
        noFlyZones: ['secrets/**'],
      },
    }),
  });
  const project = projectResponse.project;
  const projectDir = path.join(root, 'projects', project.id);
  const controlStatePath = path.join(projectDir, 'control-state.json');
  const eventsPath = path.join(projectDir, 'events.jsonl');
  const manifestPath = path.join(root, 'manifest.json');

  const manifest = await waitForJson(manifestPath, (json) => json.workspace_slug === slug
    && json.control_state === `projects/${project.id}/control-state.json`);
  const initialControl = await waitForJson(controlStatePath, (json) => json.projectId === project.id);
  const initialEvents = await waitForText(eventsPath, (text) => text.includes('tower_instruction'));

  const uiSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'UI-01', agentProvider: 'codex-cli', permissions: ['codesite:mutation', 'codesite:inbox'] }),
  })).agentSession;
  const contractSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'CONTRACT-01', agentProvider: 'codex-cli', permissions: ['codesite:mutation', 'codesite:inbox'] }),
  })).agentSession;

  const uiPlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: uiSession.id,
      displayCallsign: 'UI-01',
      mission: 'Read signup contract and update UI',
      domain: 'frontend',
      route: ['src/components/SignupForm.tsx'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;
  const contractPlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: contractSession.id,
      displayCallsign: 'CONTRACT-01',
      mission: 'Update signup contract',
      domain: 'contract',
      route: ['src/contracts/signup.ts'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;

  const uiLease = (await api(`/execution-plans/${encodeURIComponent(uiPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({ allowedPaths: ['src/components/SignupForm.tsx'], allowedTools: ['file_write'], requiredRadar: ['tests'] }),
  })).mutationLease;
  const contractLease = (await api(`/execution-plans/${encodeURIComponent(contractPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({ allowedPaths: ['src/contracts/signup.ts'], allowedTools: ['file_write'], requiredRadar: ['typecheck', 'tests'] }),
  })).mutationLease;

  const uiTxn = (await api(`/mutation-leases/${encodeURIComponent(uiLease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: ['src/contracts/signup.ts'],
      writeSet: ['src/components/SignupForm.tsx'],
      baseSnapshotEvidence: {
        schemaVersion: 'synthi.codesite.readSnapshotEvidence.v1',
        snapshotDigest: 'sha256:ui-base',
        readSet: ['src/contracts/signup.ts'],
        fileDigests: [{ path: 'src/contracts/signup.ts', digest: 'sha256:contract-v1' }],
        status: 'captured',
        reasonCodes: ['repo_snapshot_captured'],
      },
    }),
  })).transaction;
  const assumption = (await api(`/transactions/${encodeURIComponent(uiTxn.id)}/assumptions`, {
    method: 'POST',
    body: JSON.stringify({
      assumptionKey: 'signup.contract.v1',
      dependsOn: [{ path: 'src/contracts/signup.ts', version: 'v1' }],
      usedBy: ['src/components/SignupForm.tsx'],
    }),
  })).assumption;

  const rfi = await api(`/projects/${encodeURIComponent(project.id)}/documents`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'rfi',
      title: 'Confirm signup payload',
      fromSessionId: uiSession.id,
      toSessionId: contractSession.id,
      transactionId: uiTxn.id,
      mutationLeaseId: uiLease.id,
      affectedZones: ['src/contracts/**'],
      requiresResponse: true,
      body: {
        question: 'Is displayName required in signup v2?',
        apiToken: 'ghp_FAKE_AUTOSYNC_TOKEN_SHOULD_REDACT',
      },
    }),
  });
  const inboxEventId = rfi.inboxItems[0].eventId;
  const inboxPath = path.join(projectDir, 'inbox', 'CONTRACT-01', `${inboxEventId}.json`);
  const inboxPending = await waitForJson(inboxPath, (json) => json.status === 'pending');
  const controlWithAck = await waitForJson(controlStatePath, (json) => json.requiredActions?.some((action) => action === `ack_event:${inboxEventId}`));

  await api(`/agent-sessions/${encodeURIComponent(contractSession.id)}/inbox/${encodeURIComponent(inboxEventId)}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const inboxAcknowledged = await waitForJson(inboxPath, (json) => json.status === 'acknowledged');
  const controlAfterAck = await waitForJson(controlStatePath, (json) => !json.requiredActions?.some((action) => action === `ack_event:${inboxEventId}`));

  const contractTxn = (await api(`/mutation-leases/${encodeURIComponent(contractLease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({ writeSet: ['src/contracts/signup.ts'], readSet: [], repoSnapshot: false }),
  })).transaction;
  await api(`/transactions/${encodeURIComponent(contractTxn.id)}/record-write`, {
    method: 'POST',
    body: JSON.stringify({
      path: 'src/contracts/signup.ts',
      tool: 'file_write',
      semanticDependencyRefs: [{ path: 'src/contracts/signup.ts', fromVersion: 'v1', version: 'v2' }],
      evidenceRefs: ['mcp:audit:repo-local-autosync-write'],
      lineProvenance: [{
        filePath: 'src/contracts/signup.ts',
        lineAnchor: 'src/contracts/signup.ts#L1-L4',
        startLine: 1,
        endLine: 4,
        reasonRef: 'rfi:signup-payload-v2',
        evidenceRefs: ['mcp:audit:repo-local-autosync-write'],
        processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:repo-local-autosync-proof'],
        promptSummary: 'Update signup contract to v2',
      }],
      changedLineRanges: [{
        filePath: 'src/contracts/signup.ts',
        lineAnchor: 'src/contracts/signup.ts#L1-L4',
        startLine: 1,
        endLine: 4,
      }],
    }),
  });
  const contractLineRange = {
    filePath: 'src/contracts/signup.ts',
    lineAnchor: 'src/contracts/signup.ts#L1-L4',
    startLine: 1,
    endLine: 4,
    reasonRef: 'rfi:signup-payload-v2',
    evidenceRefs: ['mcp:audit:repo-local-autosync-write'],
    processAncestry: ['mcp:synthi_codesite_apply_patch', 'codex:repo-local-autosync-proof'],
    promptSummary: 'Update signup contract to v2',
  };

  const assumptionsPath = path.join(projectDir, 'flights', 'UI-01', 'assumptions.json');
  const assumptions = await waitForJson(assumptionsPath, (json) => json.some((item) => item.id === assumption.id && item.status === 'invalidated'));
  const controlWithRebase = await waitForJson(controlStatePath, (json) => json.requiredActions?.some((action) => action === `rebase_assumption:${assumption.id}`));

  await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: contractPlan.id,
      displayCallsign: 'CONTRACT-01',
      status: 'completed',
      changedPaths: ['src/contracts/signup.ts'],
      inspectionSignals: [
        { key: 'typecheck', status: 'passed', evidenceRefs: ['typecheck:run:repo-local-autosync'] },
        { key: 'tests', status: 'passed', evidenceRefs: ['test:run:repo-local-autosync'] },
      ],
      evidenceRefs: ['test:run:repo-local-autosync-suite'],
    }),
  });

  const repoState = {
    schemaVersion: 'synthi.codesite.repoStateEvidence.v1',
    workspaceSlug: slug,
    transactionId: contractTxn.id,
    baseSnapshot: contractTxn.baseSnapshot,
    repoIdentity: {
      workspaceSlug: slug,
      transactionId: contractTxn.id,
      repoRootDigest: digest(repoRoot()),
      gitTopLevelDigest: digest(gitValue(['rev-parse', '--show-toplevel'], repoRoot())),
      gitCommonDirDigest: digest(gitValue(['rev-parse', '--git-common-dir'], path.join(repoRoot(), '.git'))),
      gitTopLevelMatchesRepoRoot: path.resolve(gitValue(['rev-parse', '--show-toplevel'], repoRoot())) === path.resolve(repoRoot()),
      source: 'codesite-repo-local-autosync-proof',
    },
    gitHead: gitValue(['rev-parse', 'HEAD'], 'repo-local-autosync-proof'),
    stagedDiffDigest: digest(`${contractTxn.id}:staged:src/contracts/signup.ts`),
    worktreeDiffDigest: digest(`${contractTxn.id}:worktree:src/contracts/signup.ts`),
    changedLineRanges: [contractLineRange],
    writeFileDigests: [{
      path: 'src/contracts/signup.ts',
      digest: digest('export interface SignupPayload { email: string; displayName?: string }'),
      size: 240,
      exists: true,
      changedLineRanges: [contractLineRange],
    }],
    generatedAt: new Date().toISOString(),
    source: 'codesite-repo-local-autosync-proof',
  };
  const commit = await api(`/transactions/${encodeURIComponent(contractTxn.id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      commitSha: 'abc123repoauto',
      repoState,
      evidenceRefs: ['mcp:audit:repo-local-autosync-commit'],
    }),
  });
  assertProof(commit.transaction?.status === 'committed', `transaction did not commit: ${JSON.stringify(commit)}`);
  const proofBundle = commit.proofBundle;
  const proofBundlePath = path.join(projectDir, 'proof-bundles', `${proofBundle.id}.proof.json`);
  const trailersPath = path.join(projectDir, 'proof-bundles', `${proofBundle.id}.trailers.txt`);
  const portableProof = await waitForJson(proofBundlePath, (json) => json.transactionId === contractTxn.id && json.landingStatus === 'completed');
  const trailers = await waitForText(trailersPath, (text) => text.includes(`CodeSite-Transaction: ${contractTxn.id}`));
  const verifier = verifyProofBundle(proofBundlePath, trailersPath);
  const eventsText = await waitForText(eventsPath, (text) => text.includes('transaction_committed') && text.includes('assumption_invalidated') && text.includes('transponder_update'));
  const finalControl = await waitForJson(controlStatePath, (json) => json.requiredActions?.some((action) => action === `rebase_assumption:${assumption.id}`));

  const assertions = {
    noExplicitArtifactExport: api.calledRoutes.every((route) => !route.includes('/artifacts/export')),
    manifestWrittenAfterProjectCreate: manifest.mcp_tools?.includes('synthi_codesite_get_radar') === true,
    projectControlStateWritten: initialControl.projectId === project.id,
    eventJsonlWritten: initialEvents.includes('tower_instruction') && eventsText.includes('transaction_committed'),
    rfiInboxWrittenAfterRouting: inboxPending.status === 'pending' && inboxPending.requiresResponse === true,
    rfiPayloadRedacted: inboxPending.redactedPayload?.body?.apiToken === '[redacted]',
    ackRequiredActionProjected: controlWithAck.requiredActions.includes(`ack_event:${inboxEventId}`),
    ackStatusProjected: inboxAcknowledged.status === 'acknowledged'
      && !controlAfterAck.requiredActions.includes(`ack_event:${inboxEventId}`),
    assumptionInvalidatedProjected: assumptions.some((item) => item.id === assumption.id && item.status === 'invalidated')
      && controlWithRebase.requiredActions.includes(`rebase_assumption:${assumption.id}`),
    proofBundleProjected: portableProof.transactionId === contractTxn.id && trailers.includes(`CodeSite-Lease: ${contractLease.id}`),
    proofBundleVerifierPassed: verifier.ok === true,
    finalControlStillRequiresRebase: finalControl.requiredActions.includes(`rebase_assumption:${assumption.id}`),
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const checkpoints = [
    { name: 'Project opened', path: path.relative(repoRoot(), controlStatePath), state: `tower=${initialControl.towerState}` },
    { name: 'RFI inbox routed', path: path.relative(repoRoot(), inboxPath), state: `status=${inboxPending.status}, redacted=${inboxPending.redactedPayload?.body?.apiToken}` },
    { name: 'Inbox acknowledged', path: path.relative(repoRoot(), inboxPath), state: `status=${inboxAcknowledged.status}` },
    { name: 'Assumption invalidated', path: path.relative(repoRoot(), assumptionsPath), state: assumptions.map((item) => `${item.assumptionKey}:${item.status}`).join(', ') },
    { name: 'Proof bundle projected', path: path.relative(repoRoot(), proofBundlePath), state: `landing=${portableProof.landingStatus}` },
    { name: 'Proof trailers projected', path: path.relative(repoRoot(), trailersPath), state: `contains transaction ${contractTxn.id}` },
  ];
  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    artifactRoot: root,
    project: { id: project.id, title: project.title, route: `/workspace/${slug}/codesite` },
    sessions: { ui: uiSession.id, contract: contractSession.id },
    transactions: { ui: uiTxn.id, contract: contractTxn.id },
    proofBundle: { id: proofBundle.id, path: proofBundlePath, trailersPath },
    controlStateSummary: {
      afterRfi: controlWithAck.requiredActions,
      afterAck: controlAfterAck.requiredActions,
      afterInvalidation: controlWithRebase.requiredActions,
      final: finalControl.requiredActions,
    },
    checkpoints,
    verifier,
    assertions,
  };

  const jsonPath = path.join(dir, 'codesite-repo-local-autosync-proof.json');
  const htmlPath = path.join(dir, 'codesite-repo-local-autosync-proof.html');
  const pngPath = path.join(dir, 'codesite-repo-local-autosync-proof.png');
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, proofHtml(proof));
  await screenshotSummary(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot(), jsonPath),
    htmlPath: path.relative(repoRoot(), htmlPath),
    pngPath: path.relative(repoRoot(), pngPath),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
