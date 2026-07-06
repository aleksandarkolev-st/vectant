import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { addAuthCookiesToBrowserContext, ensureProofWorkspace } from './codesite-proof-api.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-runway-occupancy-proof-${Date.now()}`;
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
  return api;
}

function assertProof(condition, message) {
  if (!condition) throw new Error(message);
}

async function buildWorkflow(api) {
  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Runway occupancy proof',
      request: 'Show occupied CodeSite runways with live transaction diffs and landing eligibility',
      zonePolicy: {
        zones: [
          {
            zoneKey: 'checkout-service',
            label: 'Checkout service runway',
            class: 'C',
            paths: ['services/checkout/**'],
            rules: ['api_contract_radar_required'],
            risk: 'medium',
          },
          {
            zoneKey: 'docs-runway',
            label: 'Docs runway',
            class: 'D',
            paths: ['docs/**'],
            rules: [],
            risk: 'low',
          },
        ],
        noFlyZones: ['secrets/**'],
      },
    }),
  })).project;

  const runwaySession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'RUNWAY-01', agentProvider: 'codex-cli' }),
  })).agentSession;
  const docsSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'DOCS-02', agentProvider: 'codex-cli' }),
  })).agentSession;
  const conflictSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'CONFLICT-03', agentProvider: 'codex-cli' }),
  })).agentSession;

  const runwayPlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: runwaySession.id,
      displayCallsign: 'RUNWAY-01',
      domain: 'backend',
      mission: 'Update checkout handler on the service runway',
      route: ['services/checkout/**'],
      requestedTools: ['file_write', 'npm_test'],
    }),
  })).executionPlan;
  const docsPlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: docsSession.id,
      displayCallsign: 'DOCS-02',
      domain: 'docs',
      mission: 'Prepare release notes outside the checkout runway',
      route: ['docs/release/**'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;
  const conflictPlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: conflictSession.id,
      displayCallsign: 'CONFLICT-03',
      domain: 'backend',
      mission: 'Attempt overlapping checkout update while runway is occupied',
      route: ['services/checkout/conflicting.ts'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;

  const lease = (await api(`/execution-plans/${encodeURIComponent(runwayPlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['services/checkout/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['api_contract'],
    }),
  })).mutationLease;

  const transaction = (await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: ['services/checkout/handler.ts'],
      writeSet: ['services/checkout/handler.ts'],
      baseSnapshotEvidence: {
        schemaVersion: 'synthi.codesite.repoSnapshotEvidence.v1',
        status: 'stable',
        readSet: ['services/checkout/handler.ts'],
        fileDigests: [{ path: 'services/checkout/handler.ts', digest: 'sha256:checkout-handler-base', exists: true }],
        snapshotDigest: 'sha256:runway-occupancy-base',
        generatedAt: new Date().toISOString(),
      },
    }),
  })).transaction;

  await api(`/transactions/${encodeURIComponent(transaction.id)}/record-write`, {
    method: 'POST',
    body: JSON.stringify({
      path: 'services/checkout/handler.ts',
      tool: 'file_write',
      evidenceRefs: ['codesite:runway-proof:write-checkout'],
      lineProvenance: [{
        lineAnchor: 'services/checkout/handler.ts#L8-L14',
        startLine: 8,
        endLine: 14,
        evidenceRefs: ['codesite:runway-proof:line-checkout'],
        processAncestry: ['mcp:synthi_codesite_apply_patch'],
        promptSummary: 'Update checkout handler runway proof',
      }],
    }),
  });
  const inspectionRun = (await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: runwayPlan.id,
      displayCallsign: 'QA-RUNWAY-01',
      status: 'requested',
      changedPaths: ['services/checkout/handler.ts'],
      evidenceRefs: ['codesite:runway-proof:pending-inspection'],
    }),
  })).inspectionRun;

  const controlState = await api(`/projects/${encodeURIComponent(project.id)}/control-state`);
  return {
    project,
    runwaySession,
    docsSession,
    conflictSession,
    runwayPlan,
    docsPlan,
    conflictPlan,
    lease,
    transaction,
    inspectionRun,
    controlState,
  };
}

async function screenshotPanel(baseUrl, slug, pngPath, authCookie) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1020 }, deviceScaleFactor: 1 });
  await addAuthCookiesToBrowserContext(context, baseUrl, authCookie);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="codesite-runway-occupancy"]', { timeout: 60000 });
  const section = page.locator('[data-testid="codesite-runway-occupancy"]').first();
  await section.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const board = document.querySelector('[data-testid="codesite-runway-occupancy"]');
    return board
      && board.textContent.includes('services/checkout/**')
      && board.textContent.includes('RUNWAY-01')
      && board.textContent.includes('services/checkout/handler.ts')
      && board.textContent.includes('api_contract_radar')
      && board.textContent.includes('inspection:QA-RUNWAY-01')
      && board.textContent.includes('DOCS-02')
      && !board.textContent.includes('CONFLICT-03');
  }, null, { timeout: 60000 });
  const box = await section.boundingBox();
  if (!box) throw new Error('runway occupancy section not visible');
  await page.screenshot({
    path: pngPath,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y - 44),
      width: box.width,
      height: Math.min(420, box.height + 80),
    },
  });
  const checks = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="codesite-runway-occupancy"]');
    return {
      boardVisible: Boolean(board),
      runwayVisible: Boolean(board?.textContent.includes('services/checkout/**')),
      occupantVisible: Boolean(board?.textContent.includes('RUNWAY-01')),
      diffVisible: Boolean(board?.textContent.includes('services/checkout/handler.ts')),
      pendingVisible: Boolean(board?.textContent.includes('api_contract_radar')),
      pendingInspectionRunVisible: Boolean(board?.textContent.includes('inspection:QA-RUNWAY-01')),
      eligibleVisible: Boolean(board?.textContent.includes('DOCS-02')),
      conflictingFlightHeld: Boolean(board && !board.textContent.includes('CONFLICT-03')),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
    };
  });
  await browser.close();
  if (consoleErrors.length) throw new Error(`browser console errors: ${consoleErrors.join('\n')}`);
  return checks;
}

async function screenshotFile(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

function proofHtml(proof) {
  const runway = proof.runway;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Runway Occupancy Proof</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a0f;color:#f5f7fb}
body{margin:0;padding:28px;background:#080a0f}
main{max-width:1120px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #293246;border-radius:8px;background:#10151f;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{font-size:25px;margin:8px 0 6px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px;letter-spacing:0}
p{margin:0;color:#afbad0;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.label{font-size:12px;color:#98a2b8}
.value{margin-top:6px;font-size:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-top:1px solid #293246;padding:8px;text-align:left;vertical-align:top}
th{color:#afbad0;font-weight:600}
pre{white-space:pre-wrap;border:1px solid #293246;border-radius:8px;background:#05060a;padding:14px;color:#cbd3e7;font-size:12px}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Runway Occupancy Proof</h1>
<p>Live Docker workflow proving runway occupancy is derived from real active clearances and transaction write sets, then rendered in the CodeSite operator UI.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Project</div><div class="value">${escapeHtml(proof.project.id)}</div></div>
<div class="card"><div class="label">Lease</div><div class="value">${escapeHtml(proof.lease.id)}</div></div>
<div class="card"><div class="label">Transaction</div><div class="value">${escapeHtml(proof.transaction.id)}</div></div>
</section>
<section class="card">
<h2>Runway Board Source</h2>
<table><thead><tr><th>Runway</th><th>Occupied by</th><th>Diff</th><th>Pending</th><th>Can land</th></tr></thead><tbody>
<tr>
<td>${escapeHtml(runway.runway)}</td>
<td>${escapeHtml(runway.occupiedBy)}</td>
<td>${escapeHtml((runway.diffPaths || []).join(', '))}</td>
<td>${escapeHtml((runway.pendingInspections || []).join(', '))}</td>
<td>${escapeHtml((runway.eligibleFlights || []).join(', '))}</td>
</tr>
</tbody></table>
</section>
<section class="card"><h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
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

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = proofDir();
  fs.mkdirSync(dir, { recursive: true });
  const { api, authCookie } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Runway occupancy proof workspace',
  });
  const workflow = await buildWorkflow(api);
  const runway = workflow.controlState.collisionForecast?.runwayOccupancy?.[0] || null;
  const panelPngPath = path.join(dir, 'codesite-runway-occupancy-panel.png');
  const browserChecks = await screenshotPanel(baseUrl, slug, panelPngPath, authCookie);

  const assertions = {
    runwayFromControlState: Boolean(runway),
    occupiedByLeaseCallsign: runway?.occupiedBy === 'RUNWAY-01',
    diffFromTransactionWriteSet: runway?.diffPaths?.includes('services/checkout/handler.ts') === true,
    pendingInspectionFromZoneRule: runway?.pendingInspections?.includes('api_contract_radar') === true,
    pendingInspectionFromInspectionRun: runway?.pendingInspections?.includes('inspection:QA-RUNWAY-01') === true,
    nonOverlappingFlightCanLand: runway?.eligibleFlights?.includes('DOCS-02') === true,
    overlappingFlightCannotLand: runway?.eligibleFlights?.includes('CONFLICT-03') === false,
    browserBoardVisible: browserChecks.boardVisible,
    browserShowsRunwayDiff: browserChecks.diffVisible,
    browserShowsPendingInspection: browserChecks.pendingVisible,
    browserShowsPendingInspectionRun: browserChecks.pendingInspectionRunVisible,
    browserShowsEligibleFlight: browserChecks.eligibleVisible,
    browserHidesConflictingFlight: browserChecks.conflictingFlightHeld,
    browserNoHorizontalOverflow: browserChecks.noHorizontalOverflow,
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: { id: workflow.project.id, title: workflow.project.title },
    lease: { id: workflow.lease.id, status: workflow.lease.status },
    transaction: { id: workflow.transaction.id, status: workflow.transaction.status },
    runway,
    controlState: workflow.controlState,
    browserChecks,
    panelPngPath: path.relative(repoRoot(), panelPngPath),
    assertions,
  };
  const jsonPath = path.join(dir, 'codesite-runway-occupancy-proof.json');
  const htmlPath = path.join(dir, 'codesite-runway-occupancy-proof.html');
  const pngPath = path.join(dir, 'codesite-runway-occupancy-proof.png');
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, proofHtml(proof));
  await screenshotFile(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot(), jsonPath),
    htmlPath: path.relative(repoRoot(), htmlPath),
    pngPath: path.relative(repoRoot(), pngPath),
    panelPngPath: path.relative(repoRoot(), panelPngPath),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
