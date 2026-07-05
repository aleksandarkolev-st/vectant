import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { addAuthCookiesToBrowserContext, ensureProofWorkspace } from './codesite-proof-api.mjs';

const require = createRequire(import.meta.url);
const { collectCodeSiteRepoState } = require('../../backend/collab-server/codesiteFs.js');
const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = 'http://127.0.0.1:3107';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function containerRepoRoot(hostPath) {
  const containerRoot = process.env.CODESITE_PROOF_CONTAINER_WORKSPACE_ROOT || '/workspace';
  const relative = path.relative(repoRoot(), hostPath).split(path.sep).join('/');
  return path.posix.join(containerRoot, relative);
}

function slugNow() {
  return `codesite-line-inspector-proof-${Date.now()}`;
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

function checkoutContractLines(replacement = null) {
  const lines = Array.from({ length: 64 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}: checkout contract unchanged`);
  lines[40] = 'line 41: refund window remains configurable by policy';
  lines[41] = replacement?.[0] || 'line 42: cancellation policy pending tower decision';
  lines[42] = replacement?.[1] || 'line 43: refund event schema pending tower decision';
  lines[43] = replacement?.[2] || 'line 44: retry behavior pending tower decision';
  lines[44] = 'line 45: payment capture remains behind order confirmation';
  return `${lines.join('\n')}\n`;
}

async function prepareProofRepo({ dir, slug, changedPath }) {
  const hostRoot = path.join(dir, 'codesite-line-inspector-repos', slug);
  await fs.promises.rm(hostRoot, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(path.join(hostRoot, changedPath)), { recursive: true });
  const before = checkoutContractLines();
  const after = checkoutContractLines([
    'line 42: accepted RFI requires cancellation reason on checkout changes',
    'line 43: checkout.refund.requested emits proof-backed evidence refs',
    'line 44: retry behavior is bounded by inspector-approved idempotency',
  ]);
  await fs.promises.writeFile(path.join(hostRoot, changedPath), before, 'utf8');
  await run('git', ['init'], { cwd: hostRoot });
  await run('git', ['config', 'user.email', 'codesite-proof@example.invalid'], { cwd: hostRoot });
  await run('git', ['config', 'user.name', 'CodeSite Proof'], { cwd: hostRoot });
  await run('git', ['add', '.'], { cwd: hostRoot });
  await run('git', ['commit', '-m', 'Initial checkout contract'], { cwd: hostRoot });
  return { hostRoot, containerRoot: containerRepoRoot(hostRoot), before, after };
}

async function createPlanIfMissing(api, project) {
  const refreshed = await api(`/projects/${encodeURIComponent(project.id)}`);
  const existingPlan = (refreshed.project?.executionPlans || project.executionPlans || [])
    .find((plan) => plan.displayCallsign === 'LINE-INSPECT-01')
    || (refreshed.project?.executionPlans || project.executionPlans || [])[0];
  if (existingPlan) return existingPlan;

  const sessionResponse = await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'LINE-INSPECT-01',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      toolList: ['synthi_codesite_record_write', 'synthi_codesite_get_line_provenance'],
    }),
  });
  const planResponse = await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: sessionResponse.agentSession.id,
      displayCallsign: 'LINE-INSPECT-01',
      mission: 'Land checkout contract line provenance',
      domain: 'docs',
      status: 'preflight',
      route: ['docs/**'],
      requestedTools: ['file_write', 'node'],
    }),
  });
  return planResponse.executionPlan;
}

async function screenshotSummary(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function captureInspectorUi({ baseUrl, slug, viewport, screenshotPath, authCookie }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await addAuthCookiesToBrowserContext(context, baseUrl, authCookie);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.addStyleTag({
    content: `
      nextjs-portal,
      [data-nextjs-toast],
      [data-next-badge-root],
      [data-nextjs-dev-tools-button],
      button[aria-label="Open Next.js Dev Tools"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `,
  });
  await page.waitForSelector('[data-testid="codesite-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-line-provenance-row"]', { timeout: 60000 });
  await page.locator('[data-testid="codesite-line-provenance-row"]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-testid="codesite-line-provenance-row"]').first().click();
  await page.waitForFunction(() => {
    const inspector = document.querySelector('[data-testid="codesite-line-inspector"]');
    const status = document.querySelector('[data-testid="codesite-line-inspector-status"]')?.textContent?.trim();
    return inspector
      && status
      && status !== 'loading'
      && inspector.textContent.includes('L42-L44 causal trace')
      && inspector.textContent.includes('mcp:synthi_codesite_apply_patch')
      && inspector.textContent.includes('tmp-codex-line-inspector')
      && inspector.textContent.includes('dojo:source:line-inspector-contract')
      && inspector.textContent.includes('runtime:event:line-inspector-proof');
  }, null, { timeout: 60000 });
  await page.locator('[data-testid="codesite-line-inspector"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const checks = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="codesite-line-provenance-row"]');
    const inspector = document.querySelector('[data-testid="codesite-line-inspector"]');
    const status = document.querySelector('[data-testid="codesite-line-inspector-status"]')?.textContent?.trim() || null;
    const rectOf = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
    };
    const fits = (rect) => Boolean(rect && rect.x >= -1 && rect.right <= window.innerWidth + 4 && rect.width <= window.innerWidth + 4);
    const overlaySelectors = [
      'nextjs-portal',
      '[data-nextjs-toast]',
      '[data-next-badge-root]',
      '[data-nextjs-dev-tools-button]',
      'button[aria-label="Open Next.js Dev Tools"]',
    ];
    const visibleDevOverlays = overlaySelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map((element) => selector));
    const rowRect = row ? rectOf(row) : null;
    const inspectorRect = inspector ? rectOf(inspector) : null;
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rowRect,
      inspectorRect,
      inspectorStatus: status,
      inspectorText: inspector?.textContent || '',
      hasRange: Boolean(inspector?.textContent.includes('L42-L44 causal trace')),
      hasTransaction: Boolean(inspector?.textContent.includes('Transaction')),
      hasClearance: Boolean(inspector?.textContent.includes('Clearance')),
      hasEvidence: Boolean(inspector?.textContent.includes('line-inspector-proof')),
      hasInspectionApproval: Boolean(inspector?.textContent.includes('runtime:event:line-inspector-proof')),
      hasDojoSource: Boolean(inspector?.textContent.includes('dojo:source:line-inspector-contract')),
      hasProcess: Boolean(inspector?.textContent.includes('mcp:synthi_codesite_apply_patch')),
      hasPrompt: Boolean(inspector?.textContent.includes('checkout cancellation contract')),
      lineInspectorSettled: status !== 'loading',
      visibleDevOverlays,
      devOverlayHidden: visibleDevOverlays.length === 0,
      fitsViewport: Boolean(row && inspector && fits(rowRect) && fits(inspectorRect) && document.documentElement.scrollWidth <= window.innerWidth + 4),
    };
  });
  await browser.close();
  if (consoleErrors.length) {
    throw new Error(`${viewport.name} console errors: ${consoleErrors.join('\n')}`);
  }
  return {
    viewport,
    screenshot: path.relative(repoRoot(), screenshotPath),
    consoleErrors,
    checks,
  };
}

function proofHtml(proof) {
  const rows = [
    ['Workspace', proof.slug],
    ['Project', proof.project.title],
    ['Transaction', `${proof.transaction.id} ${proof.transaction.status}`],
    ['Line lookup', `${proof.lineLookup.count} row at ${proof.lineLookup.lineNumber}`],
    ['Proof bundle', `${proof.proofBundle.id} ${proof.proofBundle.bundleDigest}`],
    ['UI captures', proof.browserProof.captures.map((capture) => capture.viewport.name).join(', ')],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Line Inspector Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#090a10;color:#f5f7fb}
body{margin:0;padding:28px;background:#090a10}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero{border:1px solid #2a3147;border-radius:8px;background:#11131d;padding:22px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{margin:8px 0 6px;font-size:25px;letter-spacing:0}
p{margin:0;color:#a5adbf;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{border:1px solid #252a38;border-radius:8px;background:#10131c;padding:14px}
.label{color:#98a2b8;font-size:12px}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;border:1px solid #252a38;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid #252a38}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Line Inspector Proof</h1>
<p>Live Docker workflow with a real CodeSite transaction, ranged line provenance persisted in the database, API lookup by line number, and browser-clicked causal inspector captures.</p>
</section>
<section class="grid">
${rows.map(([label, value]) => `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('\n')}
</section>
<section><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
${proof.browserProof.captures.map((capture) => `<section><h2>${escapeHtml(capture.viewport.name)}</h2><img src="${escapeHtml(path.basename(capture.screenshot))}" alt="Line inspector ${escapeHtml(capture.viewport.name)} capture"></section>`).join('\n')}
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
  const { api, authCookie } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Line inspector proof workspace',
  });
  const dir = proofDir();
  await fs.promises.mkdir(dir, { recursive: true });

  const changedPath = 'docs/checkout-contract.md';
  const proofRepo = await prepareProofRepo({ dir, slug, changedPath });
  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Line inspector workflow proof',
      request: 'Prove causal provenance for a changed checkout contract line',
      autoWorkflow: true,
      zonePolicy: {
        zones: [{ zoneKey: 'docs', label: 'Documentation airspace', class: 'D', paths: ['docs/**'], risk: 'low' }],
        noFlyZones: ['secrets/**'],
      },
      missions: [{
        callsign: 'LINE-INSPECT-01',
        domain: 'docs',
        mission: 'Land checkout contract line provenance',
        route: ['docs/**'],
        requestedTools: ['file_write', 'node'],
      }],
    }),
  });
  const project = projectResponse.project;
  const plan = await createPlanIfMissing(api, project);

  const leaseResponse = await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['docs/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write', 'node'],
      requiredRadar: ['tests'],
    }),
  });
  const lease = leaseResponse.mutationLease;

  const transactionResponse = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: [],
      writeSet: [changedPath],
      invariants: ['tests:pass'],
    }),
  });
  const transaction = transactionResponse.transaction;

  await fs.promises.writeFile(path.join(proofRepo.hostRoot, changedPath), proofRepo.after, 'utf8');
  const processAncestry = ['tmp-codex-line-inspector', 'mcp:synthi_codesite_apply_patch'];
  const lineProvenanceInput = [{
    filePath: changedPath,
    lineAnchor: `${changedPath}#L42-L44`,
    startLine: 42,
    endLine: 44,
    reasonRef: 'rfi:checkout-cancellation-contract',
    evidenceRefs: ['test:run:line-inspector-proof', 'mcp:audit:line-inspector-write'],
    dojoSourceRefs: ['dojo:source:line-inspector-contract'],
    processAncestry,
    promptSummary: 'Add checkout cancellation contract after RFI approval',
  }];
  const writeResponse = await api(`/transactions/${encodeURIComponent(transaction.id)}/record-write`, {
    method: 'POST',
    body: JSON.stringify({
      path: changedPath,
      tool: 'file_write',
      lineProvenance: lineProvenanceInput,
      changedLineRanges: lineProvenanceInput,
      evidenceRefs: ['mcp:audit:line-inspector-write'],
      dojoSourceRefs: ['dojo:source:line-inspector-contract'],
      processAncestry,
    }),
  });

  const testScript = [
    "const fs = require('fs');",
    `const text = fs.readFileSync(${JSON.stringify(changedPath)}, 'utf8');`,
    "if (!text.includes('accepted RFI requires cancellation reason')) process.exit(1);",
    "if (!text.includes('checkout.refund.requested emits proof-backed evidence refs')) process.exit(1);",
  ].join(' ');
  const inspectionResponse = await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: plan.id,
      displayCallsign: 'LINE-INSPECT-01',
      changedPaths: [changedPath],
      execute: true,
      repoRoot: proofRepo.containerRoot,
      commands: [{ key: 'tests', command: 'node', args: ['-e', testScript], timeoutMs: 30000 }],
      evidenceRefs: ['runtime:event:line-inspector-proof'],
    }),
  });

  const repoState = await collectCodeSiteRepoState(proofRepo.hostRoot, {
    workspaceSlug: slug,
    transactionId: transaction.id,
    baseSnapshot: transaction.baseSnapshot,
    writePaths: [changedPath],
  });
  const commitResponse = await api(`/transactions/${encodeURIComponent(transaction.id)}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      repoState,
      evidenceRefs: ['mcp:audit:line-inspector-commit'],
    }),
  });
  assertProof(commitResponse.transaction?.status === 'committed', 'line inspector transaction did not commit');

  const lineLookupResponse = await api(`/provenance/line?projectId=${encodeURIComponent(project.id)}&filePath=${encodeURIComponent(changedPath)}&lineNumber=42`);
  const lineRows = lineLookupResponse.lineProvenance || [];
  assertProof(lineRows.length >= 1, 'line provenance lookup returned no rows');

  const desktopShot = path.join(dir, 'codesite-line-inspector-ui-desktop.png');
  const mobileShot = path.join(dir, 'codesite-line-inspector-ui-mobile.png');
  const captures = [
    await captureInspectorUi({
      baseUrl,
      slug,
      viewport: { name: 'desktop', width: 1440, height: 1100 },
      screenshotPath: desktopShot,
      authCookie,
    }),
    await captureInspectorUi({
      baseUrl,
      slug,
      viewport: { name: 'mobile', width: 390, height: 980 },
      screenshotPath: mobileShot,
      authCookie,
    }),
  ];

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: {
      id: project.id,
      title: project.title,
      route: `/workspace/${slug}/codesite`,
    },
    plan: { id: plan.id, displayCallsign: plan.displayCallsign },
    lease: { id: lease.id, status: lease.status, displayCallsign: lease.displayCallsign },
    transaction: {
      id: commitResponse.transaction.id,
      status: commitResponse.transaction.status,
      baseSnapshot: transaction.baseSnapshot,
      writeSet: commitResponse.transaction.writeSet,
    },
    writeResponse: {
      ok: writeResponse.ok,
      invalidatedAssumptions: writeResponse.invalidatedAssumptions || [],
    },
    inspection: inspectionResponse.inspectionRun,
    repoState,
    proofBundle: commitResponse.proofBundle,
    lineLookup: {
      lineNumber: 42,
      count: lineRows.length,
      rows: lineRows,
    },
    browserProof: { captures },
    assertions: {
      leaseActive: lease.status === 'active',
      writeAllowed: writeResponse.ok === true,
      inspectionExecuted: inspectionResponse.inspectionRun.status === 'completed'
        && inspectionResponse.inspectionRun.inspectionSignals.some((signal) => signal.key === 'tests' && signal.source === 'codesite_inspection_executor'),
      transactionCommitted: commitResponse.transaction.status === 'committed',
      lineRangePersisted: lineRows.some((row) => row.filePath === changedPath && row.startLine === 42 && row.endLine === 44),
      dojoSourcePersisted: lineRows.some((row) => Array.isArray(row.dojoSourceRefs)
        && row.dojoSourceRefs.includes('dojo:source:line-inspector-contract')),
      apiReturnsCausalContext: lineRows.some((row) => row.transaction?.id === transaction.id
        && row.mutationLease?.id === lease.id
        && Array.isArray(row.proofBundles)
        && row.proofBundles.some((bundle) => bundle.id === commitResponse.proofBundle.id)),
      proofBundleHasTrailers: Boolean(commitResponse.proofBundle?.trailers?.['CodeSite-Transaction']
        && commitResponse.proofBundle?.trailers?.['CodeSite-Clearance']),
      desktopInspectorVisible: captures[0].checks.hasRange
        && captures[0].checks.hasTransaction
        && captures[0].checks.hasClearance
        && captures[0].checks.hasEvidence
        && captures[0].checks.hasInspectionApproval
        && captures[0].checks.hasDojoSource
        && captures[0].checks.hasProcess
        && captures[0].checks.hasPrompt
        && captures[0].checks.lineInspectorSettled
        && captures[0].checks.devOverlayHidden
        && captures[0].checks.fitsViewport,
      mobileInspectorVisible: captures[1].checks.hasRange
        && captures[1].checks.hasTransaction
        && captures[1].checks.hasClearance
        && captures[1].checks.hasEvidence
        && captures[1].checks.hasInspectionApproval
        && captures[1].checks.hasDojoSource
        && captures[1].checks.hasProcess
        && captures[1].checks.hasPrompt
        && captures[1].checks.lineInspectorSettled
        && captures[1].checks.devOverlayHidden
        && captures[1].checks.fitsViewport,
    },
  };
  const failed = Object.entries(proof.assertions).filter(([, value]) => value !== true);
  if (failed.length) {
    throw new Error(`line inspector proof assertions failed: ${JSON.stringify({
      failed,
      captures: proof.browserProof.captures.map((capture) => ({
        viewport: capture.viewport,
        screenshot: capture.screenshot,
        checks: capture.checks,
      })),
    })}`);
  }

  const jsonPath = path.join(dir, 'codesite-line-inspector-proof.json');
  const htmlPath = path.join(dir, 'codesite-line-inspector-proof.html');
  const pngPath = path.join(dir, 'codesite-line-inspector-proof.png');
  await fs.promises.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.promises.writeFile(htmlPath, proofHtml(proof), 'utf8');
  await screenshotSummary(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    proof: path.relative(repoRoot(), jsonPath),
    html: path.relative(repoRoot(), htmlPath),
    screenshot: path.relative(repoRoot(), pngPath),
    captures: captures.map((capture) => capture.screenshot),
    assertions: proof.assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
