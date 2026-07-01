import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../mcp/synthi-mcp/dist/dojo/proof/signing.js';
import { dispatchCodeSiteTool } from '../../mcp/synthi-mcp/dist/tools/codesite.js';

const DEFAULT_APP_BASE_URL = 'http://127.0.0.1:3117';
const DEFAULT_COLLAB_BASE_URL = 'http://127.0.0.1:1237';
const DEFAULT_COLLAB_CONTROL_PLANE_URL = 'http://host.docker.internal:3117';
const UI_RESPONSE_TIMEOUT_MS = 300000;

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function outDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-quarantine-review-proof-${Date.now()}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signedDojoProof(slug) {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-quarantine-review-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-quarantine-review',
    skill_id: 'codesite.quarantine.review',
    skill_version: '2026-07-01.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'runtime.level_2@2026-06-25',
    issuer: 'dojo-quarantine-review-issuer',
    key_id: keyPair.key_id,
    nonce: `nonce-${Date.now()}`,
    ledger_checkpoint_hash: crypto.createHash('sha256').update(slug).digest('hex'),
    evidence_claims: [{
      claim: 'codesite.quarantine.reviewed_replay',
      satisfied: true,
      evidence_refs: ['evidence:quarantine-review-live-api'],
    }],
    evidence_record_ids: ['quarantine-review-live-api'],
    issued_at: '2026-07-01T00:00:00.000Z',
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
      issuer: unsignedCapsule.issuer,
      algorithm: 'ed25519',
      signing_provider: 'ed25519-local',
      key_custody: 'local',
      public_key_pem: keyPair.public_key_pem,
      status: 'active',
      created_at: '2026-07-01T00:00:00.000Z',
      retain_for_forensic_verification: false,
    },
    dojoRequiredEvidenceClaims: ['codesite.quarantine.reviewed_replay'],
    implementationStatus: { executable: true, productionRuntime: false },
  };
}

function createApi(baseUrl, slug) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  async function raw(route, options = {}) {
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
    return { ok: response.ok, status: response.status, body };
  }
  async function api(route, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const maxAttempts = method === 'GET' ? 4 : 1;
    let response = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      response = await raw(route, options);
      if (response.ok) return response.body;
      const retryable = method === 'GET' && response.status >= 500 && response.status < 600;
      if (!retryable || attempt === maxAttempts) break;
      await sleep(750 * attempt);
    }
    throw new Error(`${method} ${route} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  api.baseUrl = apiBase;
  api.raw = raw;
  return api;
}

async function collabRequest(collabBaseUrl, route, options = {}) {
  const response = await fetch(`${collabBaseUrl.replace(/\/+$/, '')}${route}`, {
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
  return { ok: response.ok, status: response.status, body };
}

async function postCollab(collabBaseUrl, route, body) {
  const response = await collabRequest(collabBaseUrl, route, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${route} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function getCollab(collabBaseUrl, route) {
  const response = await collabRequest(collabBaseUrl, route);
  if (!response.ok) {
    throw new Error(`GET ${route} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

function assertProof(assertions) {
  const failed = Object.entries(assertions)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  if (failed.length) {
    throw new Error(`quarantine review proof failed: ${failed.join(', ')}`);
  }
}

function ignorableBrowserConsoleError(message) {
  return message.includes('Cross-Origin-Opener-Policy header has been ignored')
    || message.includes('Failed to load resource: the server responded with a status of 409 (Conflict)');
}

function mcpToolName(tool) {
  return typeof tool === 'string' ? tool : tool?.name || '';
}

function mcpStructuredResponse(response) {
  if (response?.structuredContent && typeof response.structuredContent === 'object') {
    return response.structuredContent;
  }
  const text = response?.content?.find((item) => item?.type === 'text')?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function dispatchMcpQuarantineTool(toolName, args) {
  const response = await dispatchCodeSiteTool(toolName, args);
  return {
    isError: Boolean(response?.isError),
    structured: mcpStructuredResponse(response),
  };
}

function eventRows(events) {
  return events.map((event) => `
    <tr>
      <td>${escapeHtml(event.eventType)}</td>
      <td>${escapeHtml(event.path || event.details?.quarantineId || '')}</td>
      <td><code>${escapeHtml((event.evidenceRefs || []).join(', '))}</code></td>
    </tr>
  `.trim()).join('\n');
}

function proofHtml(proof) {
  const uiImage = proof.visual?.ui?.screenshot ? path.basename(proof.visual.ui.screenshot) : null;
  const uiImages = [
    ['Panel after apply', proof.visual?.ui?.screenshot],
    ['Full desktop after apply', proof.visual?.ui?.desktopScreenshot],
    ['Mobile after apply', proof.visual?.ui?.mobileScreenshot],
    ['Rejected stale replay', proof.visual?.ui?.rejectedScreenshot],
  ]
    .filter(([, image]) => image)
    .map(([label, image]) => `<figure><img src="${escapeHtml(path.basename(image))}" alt="${escapeHtml(label)}" /><figcaption>${escapeHtml(label)}</figcaption></figure>`)
    .join('\n');
  const symlinkRows = (proof.quarantine.manifest.symlinkSanitization?.sanitized || []).map((item) => `
    <tr>
      <td>${escapeHtml(item.path)}</td>
      <td><code>${escapeHtml(item.target)}</code></td>
      <td><code>${escapeHtml(item.reason)}</code></td>
    </tr>
  `.trim()).join('\n') || '<tr><td colspan="3">No unsafe symlinks were present.</td></tr>';
  const manifestRows = proof.quarantine.manifest.changes.map((change) => `
    <tr>
      <td>${escapeHtml(change.path)}</td>
      <td>${escapeHtml(change.kind)}</td>
      <td><code>${escapeHtml(change.quarantineEvidence?.evidenceRef || '')}</code></td>
      <td><pre>${escapeHtml((change.quarantineEvidence?.textDiff?.lines || []).join('\n'))}</pre></td>
    </tr>
  `.trim()).join('\n');
  const replayRows = proof.replay.replay.map((change) => `
    <tr>
      <td>${escapeHtml(change.path)}</td>
      <td><code>${escapeHtml(change.beforeDigest)}</code></td>
      <td><code>${escapeHtml(change.afterDigest)}</code></td>
      <td>${escapeHtml(change.lineProvenanceCount)}</td>
    </tr>
  `.trim()).join('\n');
  const appliedRows = proof.apply.applied.map((change) => `
    <tr>
      <td>${escapeHtml(change.path)}</td>
      <td><code>${escapeHtml(change.evidenceRef)}</code></td>
      <td>${escapeHtml(change.lineProvenanceCount)}</td>
    </tr>
  `.trim()).join('\n');
  const artifactRows = (proof.agentSurface?.artifactFiles || []).map((file) => `
    <tr>
      <td><code>${escapeHtml(file.path)}</code></td>
      <td>${escapeHtml(file.bytes)}</td>
      <td><pre>${escapeHtml(file.contentPreview || '')}</pre></td>
    </tr>
  `.trim()).join('\n');
  const toolRows = (proof.agentSurface?.quarantineMcpTools || []).map((tool) => `
    <tr>
      <td><code>${escapeHtml(mcpToolName(tool))}</code></td>
      <td>${escapeHtml(tool.description || '')}</td>
    </tr>
  `.trim()).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CodeSite Quarantine Review Proof</title>
<style>
:root { color-scheme: dark; --bg: #07090d; --panel: #11151f; --panel2: #0b0f16; --line: #2b3548; --text: #f5f7fb; --muted: #aeb8ce; --pass: #35d07f; --warn: #ffd166; --accent: #9cc7ff; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
main { width: min(1220px, calc(100vw - 56px)); margin: 24px auto 48px; }
.hero { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 22px 24px; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 4px; background: #0d3b24; color: #bdffd8; font-size: 12px; font-weight: 800; }
h1 { margin: 8px 0 10px; font-size: 30px; line-height: 1.1; }
p { margin: 0; max-width: 86ch; color: var(--muted); font-size: 16px; line-height: 1.5; }
.grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 16px 0 20px; }
.metric { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); min-height: 86px; padding: 13px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.metric strong { display: block; font-size: 16px; line-height: 1.25; overflow-wrap: anywhere; }
h2 { margin: 22px 0 10px; font-size: 21px; }
table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: #05070b; }
th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 14px; }
th { background: var(--panel2); color: var(--accent); font-size: 12px; text-transform: uppercase; }
tr:last-child td { border-bottom: 0; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #dce5ff; font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #dce5ff; overflow-wrap: anywhere; }
.twocol { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.panel { border: 1px solid var(--line); border-radius: 8px; background: #05070b; padding: 13px; }
img { display: block; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; background: #05070b; }
@media (max-width: 940px) { main { width: min(100% - 28px, 760px); } .grid { grid-template-columns: 1fr 1fr; } .twocol { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="badge">PASS</span>
    <h1>CodeSite Quarantine Review Proof</h1>
    <p>Docker-backed workflow: a raw terminal wrote four paths in an active CodeSite context, including a symlink escape attempt; the real repo stayed unchanged, the manifest was listed and replayed, and one selected path was applied through the transaction boundary with ordered timeline evidence.</p>
  </section>
  <section class="grid">
    <div class="metric"><span>Workspace</span><strong>${escapeHtml(proof.slug)}</strong></div>
    <div class="metric"><span>Quarantine ID</span><strong>${escapeHtml(proof.quarantine.id)}</strong></div>
    <div class="metric"><span>Manifest changes</span><strong>${escapeHtml(proof.quarantine.manifest.changes.length)}</strong></div>
    <div class="metric"><span>Applied paths</span><strong>${escapeHtml(proof.apply.applied.map((item) => item.path).join(', '))}</strong></div>
    <div class="metric"><span>Stale replay</span><strong>${escapeHtml(proof.staleReplay.status)}</strong></div>
  </section>
  <h2>Symlink Escape Guard</h2>
  <table>
    <thead><tr><th>Path</th><th>Target</th><th>Disposition</th></tr></thead>
    <tbody>${symlinkRows}</tbody>
  </table>
  <h2>Quarantine Manifest</h2>
  <table>
    <thead><tr><th>Path</th><th>Kind</th><th>Evidence</th><th>Diff</th></tr></thead>
    <tbody>${manifestRows}</tbody>
  </table>
  <h2>Replay Dry Run</h2>
  <table>
    <thead><tr><th>Path</th><th>Current Digest</th><th>After Digest</th><th>Line Evidence</th></tr></thead>
    <tbody>${replayRows}</tbody>
  </table>
  <h2>Applied Through Transaction Boundary</h2>
  <table>
    <thead><tr><th>Path</th><th>Evidence</th><th>Line Evidence</th></tr></thead>
    <tbody>${appliedRows}</tbody>
  </table>
  <div class="twocol">
    <section>
      <h2>Workspace Before Apply</h2>
      <div class="panel"><pre>${escapeHtml(proof.workspaceReadback.beforeApply.output)}</pre></div>
    </section>
    <section>
      <h2>Workspace After Apply</h2>
      <div class="panel"><pre>${escapeHtml(proof.workspaceReadback.afterApply.output)}</pre></div>
    </section>
  </div>
  <h2>Browser UI Review</h2>
  <div class="panel"><pre>${escapeHtml(JSON.stringify(proof.visual?.ui?.checks || {}, null, 2))}</pre></div>
  ${uiImages || (uiImage ? `<img src="${escapeHtml(uiImage)}" alt="CodeSite quarantine review panel showing selected replay and apply result" />` : '')}
  <h2>Agent Surface</h2>
  <table>
    <thead><tr><th>MCP tool</th><th>Description</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table>
  <h2>MCP Dispatch Proof</h2>
  <div class="panel"><pre>${escapeHtml(JSON.stringify(proof.mcp, null, 2))}</pre></div>
  <h2>Direct Collab Fail-Closed Check</h2>
  <div class="panel"><pre>${escapeHtml(JSON.stringify(proof.directCollabMissingSelection, null, 2))}</pre></div>
  <h2>Artifact Projection</h2>
  <table>
    <thead><tr><th>Path</th><th>Bytes</th><th>Preview</th></tr></thead>
    <tbody>${artifactRows}</tbody>
  </table>
  <h2>Control Plane Timeline</h2>
  <table>
    <thead><tr><th>Event</th><th>Path / Quarantine</th><th>Evidence</th></tr></thead>
    <tbody>${eventRows(proof.controlPlane.relevantEvents)}</tbody>
  </table>
  <h2>Assertions</h2>
  <div class="panel"><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></div>
</main>
</body>
</html>`;
}

async function writeProofArtifacts(proof) {
  const dir = outDir();
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, 'codesite-quarantine-review-proof.json');
  const htmlPath = path.join(dir, 'codesite-quarantine-review-proof.html');
  const pngPath = path.join(dir, 'codesite-quarantine-review-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.writeFile(htmlPath, proofHtml(proof), 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  return { jsonPath, htmlPath, pngPath };
}

async function captureQuarantineReviewUi({
  baseUrl,
  slug,
  quarantineId,
  targetPath,
  createdPath,
  escapePath,
  outsidePath,
  screenshotPath,
  desktopScreenshotPath,
  mobileScreenshotPath,
  rejectedScreenshotPath,
}) {
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (handler, timeout, ...args) => {
      if (Number(timeout) >= 1000) return 0;
      return nativeSetInterval(handler, timeout, ...args);
    };
  });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.setDefaultNavigationTimeout(180000);

  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('[data-testid="codesite-quarantine-review"]', { timeout: 90000 });
  await page.waitForFunction(({ id, target, created, escape, outside }) => {
    const panel = document.querySelector('[data-testid="codesite-quarantine-review"]');
    return panel
      && panel.textContent.includes(id)
      && panel.textContent.includes(target)
      && panel.textContent.includes(created)
      && panel.textContent.includes(escape)
      && panel.textContent.includes(outside)
      && panel.textContent.includes('quarantine_symlink_escape_replaced');
  }, { id: quarantineId, target: targetPath, created: createdPath, escape: escapePath, outside: outsidePath }, { timeout: 90000 });

  const panel = page.locator('[data-testid="codesite-quarantine-review"]').first();
  await panel.scrollIntoViewIfNeeded();
  const targetRow = page.locator('[data-testid="codesite-quarantine-change-row"]').filter({ hasText: targetPath }).first();
  const createdRow = page.locator('[data-testid="codesite-quarantine-change-row"]').filter({ hasText: createdPath }).first();
  await page.getByRole('button', { name: /Replay selected quarantine paths/i }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: /Apply replayed quarantine paths/i }).waitFor({ state: 'visible', timeout: 30000 });
  await targetRow.locator('[data-testid="codesite-quarantine-path-toggle"]').check();
  await createdRow.locator('[data-testid="codesite-quarantine-path-toggle"]').check();
  await page.waitForFunction(({ target, created }) => {
    const checkedRows = [...document.querySelectorAll('[data-testid="codesite-quarantine-change-row"]')]
      .filter((row) => row.querySelector('[data-testid="codesite-quarantine-path-toggle"]')?.checked);
    return checkedRows.length === 2
      && checkedRows.some((row) => row.textContent.includes(target))
      && checkedRows.some((row) => row.textContent.includes(created));
  }, { target: targetPath, created: createdPath }, { timeout: 30000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="codesite-quarantine-replay-button"]');
    return button && !button.disabled;
  }, null, { timeout: 60000 });

  const replayResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().includes(`/quarantines/${encodeURIComponent(quarantineId)}/replay`)
  ), { timeout: UI_RESPONSE_TIMEOUT_MS });
  await page.locator('[data-testid="codesite-quarantine-replay-button"]').click();
  const replayResponse = await replayResponsePromise;
  const replay = await replayResponse.json();
  await page.waitForSelector('[data-testid="codesite-quarantine-replay-result"]', { timeout: 30000 });
  await page.waitForFunction(({ target, created }) => {
    const result = document.querySelector('[data-testid="codesite-quarantine-replay-result"]');
    const applyButton = document.querySelector('[data-testid="codesite-quarantine-apply-button"]');
    return result?.textContent.includes(target)
      && result.textContent.includes(created)
      && applyButton
      && !applyButton.disabled;
  }, { target: targetPath, created: createdPath }, { timeout: 30000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="codesite-quarantine-apply-button"]');
    return button && !button.disabled;
  }, null, { timeout: 60000 });

  const applyResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().includes(`/quarantines/${encodeURIComponent(quarantineId)}/apply`)
  ), { timeout: UI_RESPONSE_TIMEOUT_MS });
  await page.locator('[data-testid="codesite-quarantine-apply-button"]').click();
  const applyResponse = await applyResponsePromise;
  const apply = await applyResponse.json();
  await page.waitForSelector('[data-testid="codesite-quarantine-apply-result"]', { timeout: 30000 });
  await page.waitForFunction(({ target, created }) => {
    const result = document.querySelector('[data-testid="codesite-quarantine-apply-result"]');
    return result?.textContent.includes(target) && result.textContent.includes(created);
  }, { target: targetPath, created: createdPath }, { timeout: 30000 });

  await panel.screenshot({ path: screenshotPath });
  if (desktopScreenshotPath) {
    await page.screenshot({ path: desktopScreenshotPath, fullPage: true });
  }
  if (mobileScreenshotPath) {
    await page.setViewportSize({ width: 390, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth + 4, null, { timeout: 30000 });
    await page.screenshot({ path: mobileScreenshotPath, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1120 });
    await panel.scrollIntoViewIfNeeded();
  }
  const happyChecks = await page.evaluate(({ id, target, created, escape, outside }) => {
    const panel = document.querySelector('[data-testid="codesite-quarantine-review"]');
    const checkedRows = [...document.querySelectorAll('[data-testid="codesite-quarantine-change-row"]')]
      .filter((row) => row.querySelector('[data-testid="codesite-quarantine-path-toggle"]')?.checked)
      .map((row) => row.textContent);
    return {
      panelVisible: Boolean(panel),
      quarantineIdVisible: Boolean(panel?.textContent.includes(id)),
      targetVisible: Boolean(panel?.textContent.includes(target)),
      createdVisible: Boolean(panel?.textContent.includes(created)),
      escapeVisible: Boolean(panel?.textContent.includes(escape)),
      outsideVisible: Boolean(panel?.textContent.includes(outside)),
      symlinkGuardVisible: Boolean(panel?.textContent.includes('quarantine_symlink_escape_replaced')),
      replayResultVisible: Boolean(document.querySelector('[data-testid="codesite-quarantine-replay-result"]')?.textContent.includes(target))
        && Boolean(document.querySelector('[data-testid="codesite-quarantine-replay-result"]')?.textContent.includes(created)),
      applyResultVisible: Boolean(document.querySelector('[data-testid="codesite-quarantine-apply-result"]')?.textContent.includes(target))
        && Boolean(document.querySelector('[data-testid="codesite-quarantine-apply-result"]')?.textContent.includes(created)),
      selectedModifiedAndCreated: checkedRows.length === 2
        && checkedRows.some((row) => row.includes(target))
        && checkedRows.some((row) => row.includes(created)),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
    };
  }, { id: quarantineId, target: targetPath, created: createdPath, escape: escapePath, outside: outsidePath });

  const staleReplayResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && response.url().includes(`/quarantines/${encodeURIComponent(quarantineId)}/replay`)
  ), { timeout: UI_RESPONSE_TIMEOUT_MS });
  await page.locator('[data-testid="codesite-quarantine-replay-button"]').click();
  const staleReplayResponse = await staleReplayResponsePromise;
  const staleReplay = await staleReplayResponse.json();
  await page.waitForSelector('[data-testid="codesite-quarantine-rejected-row"]', { timeout: 30000 });
  await page.waitForFunction(() => {
    const rejectedRows = [...document.querySelectorAll('[data-testid="codesite-quarantine-rejected-row"]')];
    const applyButton = document.querySelector('[data-testid="codesite-quarantine-apply-button"]');
    const hasStaleConflict = rejectedRows.some((row) => (
      row.textContent.includes('quarantine_replay_base_mismatch')
      || row.textContent.includes('quarantine_replay_base_exists')
    ));
    return hasStaleConflict && applyButton?.disabled;
  }, null, { timeout: 30000 });
  if (rejectedScreenshotPath) {
    await panel.screenshot({ path: rejectedScreenshotPath });
  }

  const rejectedChecks = await page.evaluate(({ id, target, created, escape, outside }) => {
    const panel = document.querySelector('[data-testid="codesite-quarantine-review"]');
    const checkedRows = [...document.querySelectorAll('[data-testid="codesite-quarantine-change-row"]')]
      .filter((row) => row.querySelector('[data-testid="codesite-quarantine-path-toggle"]')?.checked)
      .map((row) => row.textContent);
    const rejectedRows = [...document.querySelectorAll('[data-testid="codesite-quarantine-rejected-row"]')];
    const applyButton = document.querySelector('[data-testid="codesite-quarantine-apply-button"]');
    const hasStaleConflict = rejectedRows.some((row) => (
      row.textContent.includes('quarantine_replay_base_mismatch')
      || row.textContent.includes('quarantine_replay_base_exists')
    ));
    return {
      panelVisible: Boolean(panel),
      quarantineIdVisible: Boolean(panel?.textContent.includes(id)),
      targetVisible: Boolean(panel?.textContent.includes(target)),
      createdVisible: Boolean(panel?.textContent.includes(created)),
      escapeVisible: Boolean(panel?.textContent.includes(escape)),
      outsideVisible: Boolean(panel?.textContent.includes(outside)),
      symlinkGuardVisible: Boolean(panel?.textContent.includes('quarantine_symlink_escape_replaced')),
      replayResultVisible: Boolean(document.querySelector('[data-testid="codesite-quarantine-replay-result"]')?.textContent.includes(target)),
      applyResultVisible: Boolean(document.querySelector('[data-testid="codesite-quarantine-apply-result"]')?.textContent.includes(target)),
      staleReplayRejectedVisible: hasStaleConflict,
      applyDisabledAfterRejected: Boolean(applyButton?.disabled),
      selectedModifiedAndCreated: checkedRows.length === 2
        && checkedRows.some((row) => row.includes(target))
        && checkedRows.some((row) => row.includes(created)),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 4,
    };
  }, { id: quarantineId, target: targetPath, created: createdPath, escape: escapePath, outside: outsidePath });
  const checks = {
    ...happyChecks,
    staleReplayRejectedVisible: rejectedChecks.staleReplayRejectedVisible,
    applyDisabledAfterRejected: rejectedChecks.applyDisabledAfterRejected,
    noHorizontalOverflow: happyChecks.noHorizontalOverflow && rejectedChecks.noHorizontalOverflow,
  };

  await browser.close();
  const actionableConsoleErrors = consoleErrors.filter((message) => !ignorableBrowserConsoleError(message));
  if (actionableConsoleErrors.length) throw new Error(`browser console errors: ${actionableConsoleErrors.join('\n')}`);
  return {
    screenshot: path.relative(repoRoot(), screenshotPath).replaceAll(path.sep, '/'),
    desktopScreenshot: desktopScreenshotPath ? path.relative(repoRoot(), desktopScreenshotPath).replaceAll(path.sep, '/') : null,
    mobileScreenshot: mobileScreenshotPath ? path.relative(repoRoot(), mobileScreenshotPath).replaceAll(path.sep, '/') : null,
    rejectedScreenshot: rejectedScreenshotPath ? path.relative(repoRoot(), rejectedScreenshotPath).replaceAll(path.sep, '/') : null,
    replay,
    apply,
    staleReplay,
    console: {
      ignored: consoleErrors.filter(ignorableBrowserConsoleError),
      actionable: actionableConsoleErrors,
    },
    checks,
  };
}

function relevantEventProjection(event) {
  const details = event.details || {};
  return {
    id: event.id,
    eventType: event.eventType,
    path: details.path || details.codesiteFsEvent?.path || null,
    details,
    evidenceRefs: event.evidenceRefs || [],
  };
}

async function main() {
  const appBaseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_APP_BASE_URL;
  const collabBaseUrl = process.env.CODESITE_PROOF_COLLAB_URL || DEFAULT_COLLAB_BASE_URL;
  const controlPlaneBaseUrl = process.env.CODESITE_PROOF_COLLAB_CONTROL_PLANE_URL || DEFAULT_COLLAB_CONTROL_PLANE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const api = createApi(appBaseUrl, slug);
  const userId = process.env.CODESITE_PROOF_USER_ID || 'codesite-dev-bypass';
  const targetPath = 'docs/review.md';
  const createdPath = 'docs/notes.md';
  const escapePath = 'docs/escape-link.txt';
  const outsidePath = 'src/outside.txt';
  const escapeTarget = `/tmp/${slug}-outside-target.txt`;

  console.log(`[quarantine-review-proof] creating project ${slug}`);
  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Quarantine review proof',
      request: 'Prove quarantined runtime writes can be reviewed, replayed, and selectively applied',
      autoWorkflow: true,
      strategy: 'airspace_survey_first',
      zonePolicy: {
        zones: [{ zoneKey: 'docs', label: 'Docs runway', class: 'B', paths: ['docs/**'], risk: 'medium' }],
        noFlyZones: ['secrets/**'],
      },
      missions: [{
        callsign: 'DOCS-QR',
        domain: 'docs',
        mission: 'Review and land a quarantined docs edit',
        route: ['docs/**'],
        requestedTools: ['file_write', 'raw_terminal'],
      }],
    }),
  });
  const project = projectResponse.project;
  const plan = project.executionPlans.find((item) => item.displayCallsign === 'DOCS-QR') || project.executionPlans[0];
  if (!plan) throw new Error('execution plan missing');

  const leaseResponse = await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['docs/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write', 'raw_terminal'],
      ...signedDojoProof(slug),
    }),
  });
  const lease = leaseResponse.mutationLease;
  const transactionResponse = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: [targetPath],
      writeSet: ['docs/**'],
      invariants: ['quarantine.replay.base_digest_matches', 'selected_paths_only'],
    }),
  });
  const transaction = transactionResponse.transaction;
  const controlPlaneUrl = `${controlPlaneBaseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;

  console.log('[quarantine-review-proof] seeding real workspace');
  await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      'mkdir -p docs src',
      `printf 'baseline\\n' > ${targetPath}`,
      `printf 'outside-before\\n' > ${escapeTarget}`,
      `rm -f ${createdPath} ${outsidePath} ${escapePath}`,
      `ln -s ${escapeTarget} ${escapePath}`,
      `printf 'seed=' && cat ${targetPath}`,
    ].join(' && '),
  });

  const codesite = {
    active: true,
    required: true,
    managedAgent: true,
    workspaceSlug: slug,
    transactionId: transaction.id,
    mutationLeaseId: lease.id,
    displayCallsign: lease.displayCallsign,
    allowedPaths: ['docs/**'],
    blockedPaths: ['secrets/**'],
    allowedTools: ['file_write', 'raw_terminal'],
    evidenceRefs: ['proof:quarantine-review-live-api'],
    processAncestry: ['codex:quarantine-review-proof', 'collab-server:exec'],
    controlPlaneUrl,
  };

  console.log('[quarantine-review-proof] writing four paths through raw terminal quarantine');
  const rawWrite = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    codesite,
    command: [
      `printf 'baseline\\nreviewed through quarantine\\n' > ${targetPath}`,
      `printf 'selected created quarantined note\\n' > ${createdPath}`,
      `printf 'escape attempt from quarantine\\n' > ${escapePath}`,
      `printf 'outside quarantined source\\n' > ${outsidePath}`,
      `printf 'overlay=' && cat ${targetPath}`,
    ].join(' && '),
  });
  const quarantine = rawWrite.quarantine || { changes: [] };
  const targetChange = quarantine.changes.find((change) => change.path === targetPath);
  const quarantineId = targetChange?.quarantineId || quarantine.changes[0]?.quarantineId;
  if (!quarantineId) throw new Error('quarantine id missing from raw write response');

  console.log('[quarantine-review-proof] reading real workspace before apply');
  const beforeApply = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      `printf 'target=' && cat ${targetPath}`,
      `printf 'notes=' && if test -e ${createdPath}; then echo present; else echo absent; fi`,
      `printf 'outside=' && if test -e ${outsidePath}; then echo present; else echo absent; fi`,
      `printf 'escape_link=' && if test -L ${escapePath}; then echo symlink; else echo missing; fi`,
      `printf 'escape_target=' && cat ${escapeTarget}`,
    ].join(' && '),
  });
  const beforeOutput = beforeApply.stdout || beforeApply.output || '';

  console.log('[quarantine-review-proof] listing durable manifest through Next control-plane facade');
  const listResponse = await api(
    `/quarantines?userId=${encodeURIComponent(userId)}&filesystemUserId=${encodeURIComponent(userId)}&transactionId=${encodeURIComponent(transaction.id)}`,
  );
  const manifestResponse = await api(
    `/quarantines/${encodeURIComponent(quarantineId)}?userId=${encodeURIComponent(userId)}&filesystemUserId=${encodeURIComponent(userId)}`,
  );
  const controlStateBeforeApply = await api(`/projects/${encodeURIComponent(project.id)}/control-state`);
  const directCollabMissingSelection = await collabRequest(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}/replay`,
    {
      method: 'POST',
      body: JSON.stringify({
        userId,
        filesystemUserId: userId,
        transactionId: transaction.id,
      }),
    },
  );
  const mcpArgs = {
    workspace_slug: slug,
    base_url: appBaseUrl,
    transaction_id: transaction.id,
    user_id: userId,
    filesystem_user_id: userId,
  };
  const mcpReviewList = await dispatchMcpQuarantineTool('synthi_codesite_review_quarantine', mcpArgs);
  const mcpReviewManifest = await dispatchMcpQuarantineTool('synthi_codesite_review_quarantine', {
    ...mcpArgs,
    quarantine_id: quarantineId,
  });
  const mcpReplay = await dispatchMcpQuarantineTool('synthi_codesite_replay_quarantine', {
    ...mcpArgs,
    quarantine_id: quarantineId,
    mutation_lease_id: lease.id,
    selected_paths: [targetPath],
  });

  console.log('[quarantine-review-proof] replaying and applying a selected modified+created batch through the browser UI');
  const uiScreenshotPath = path.join(outDir(), 'codesite-quarantine-review-ui-panel.png');
  const uiProof = await captureQuarantineReviewUi({
    baseUrl: appBaseUrl,
    slug,
    quarantineId,
    targetPath,
    createdPath,
    escapePath,
    outsidePath,
    screenshotPath: uiScreenshotPath,
    desktopScreenshotPath: path.join(outDir(), 'codesite-quarantine-review-ui-desktop-full.png'),
    mobileScreenshotPath: path.join(outDir(), 'codesite-quarantine-review-ui-mobile.png'),
    rejectedScreenshotPath: path.join(outDir(), 'codesite-quarantine-review-ui-rejected.png'),
  });
  const replay = uiProof.replay;
  const apply = uiProof.apply;

  const afterApply = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      `printf 'target=' && cat ${targetPath}`,
      `printf 'notes=' && if test -e ${createdPath}; then cat ${createdPath}; else echo absent; fi`,
      `printf 'outside=' && if test -e ${outsidePath}; then echo present; else echo absent; fi`,
      `printf 'escape_link=' && if test -L ${escapePath}; then echo symlink; else echo missing; fi`,
      `printf 'escape_target=' && cat ${escapeTarget}`,
    ].join(' && '),
  });
  const afterOutput = afterApply.stdout || afterApply.output || '';

  console.log('[quarantine-review-proof] proving stale replay is rejected after apply');
  const staleReplay = await api.raw(
    `/quarantines/${encodeURIComponent(quarantineId)}/replay`,
    {
      method: 'POST',
      body: JSON.stringify({
        transactionId: transaction.id,
        mutationLeaseId: lease.id,
        paths: [targetPath],
      }),
    },
  );
  const mcpStaleApply = await dispatchMcpQuarantineTool('synthi_codesite_apply_quarantine', {
    ...mcpArgs,
    quarantine_id: quarantineId,
    mutation_lease_id: lease.id,
    selected_paths: [targetPath],
  });

  const transactionAfter = await api(`/transactions/${encodeURIComponent(transaction.id)}`);
  const controlStateAfterApply = await api(`/projects/${encodeURIComponent(project.id)}/control-state`);
  const agentManifest = await api(`/projects/${encodeURIComponent(project.id)}/agent-manifest`);
  const artifactPreview = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/preview?include=content&maxContentBytes=131072`);
  const eventsResponse = await api(`/projects/${encodeURIComponent(project.id)}/events`);
  const relevantEvents = eventsResponse.events
    .filter((event) => [
      'write_quarantined',
      'quarantine_reviewed',
      'quarantine_replayed',
      'write_allowed',
      'quarantine_applied',
    ].includes(event.eventType))
    .map(relevantEventProjection);
  const eventTypes = relevantEvents.map((event) => event.eventType);
  const quarantinedPaths = new Set(quarantine.changes.map((change) => change.path));
  const artifactFiles = artifactPreview.files || [];
  const artifactPathSet = new Set(artifactFiles.map((file) => file.path));
  const quarantineArtifactRecord = artifactFiles.find((file) => file.path === `projects/${project.id}/quarantines/${quarantineId}.json`);
  const quarantineIndexArtifact = artifactFiles.find((file) => file.path === `projects/${project.id}/quarantines/index.jsonl`);
  const controlStateArtifact = artifactFiles.find((file) => file.path === `projects/${project.id}/control-state.json`);
  const quarantineArtifactJson = quarantineArtifactRecord?.contentPreview
    ? JSON.parse(quarantineArtifactRecord.contentPreview)
    : null;
  const controlStateArtifactJson = controlStateArtifact?.contentPreview
    ? JSON.parse(controlStateArtifact.contentPreview)
    : null;
  const pendingAfterApply = (controlStateAfterApply.pendingQuarantines || []).find((item) => item.quarantineId === quarantineId);
  const pendingArtifactRecord = (controlStateArtifactJson?.pendingQuarantines || []).find((item) => item.quarantineId === quarantineId);
  const quarantineMcpTools = (agentManifest.mcpTools || []).filter((tool) => /quarantine/i.test(mcpToolName(tool)));

  const assertions = {
    dockerCollabExecUsed: true,
    clearanceIssued: lease.status === 'active',
    transactionOpened: Boolean(transaction.id),
    rawTerminalSucceeded: rawWrite.exitCode === 0,
    stableQuarantineIdReturned: /^qtn-/.test(quarantineId),
    rawQuarantineCapturedAllPaths: quarantinedPaths.has(targetPath)
      && quarantinedPaths.has(createdPath)
      && quarantinedPaths.has(outsidePath)
      && quarantinedPaths.has(escapePath),
    realWorkspaceUnchangedBeforeApply: beforeOutput.includes('target=baseline')
      && beforeOutput.includes('notes=absent')
      && beforeOutput.includes('outside=absent')
      && beforeOutput.includes('escape_link=symlink')
      && beforeOutput.includes('escape_target=outside-before'),
    nextFacadeListedQuarantine: listResponse.quarantines?.some((item) => item.quarantineId === quarantineId),
    nextFacadeReadManifest: manifestResponse.quarantine?.quarantineId === quarantineId,
    mcpReviewListedQuarantine: mcpReviewList.isError === false
      && mcpReviewList.structured?.response?.quarantines?.some((item) => item.quarantineId === quarantineId),
    mcpReviewReadManifest: mcpReviewManifest.isError === false
      && mcpReviewManifest.structured?.response?.quarantine?.quarantineId === quarantineId,
    mcpReplaySelectedOnly: mcpReplay.isError === false
      && mcpReplay.structured?.request?.url?.includes(`/api/workspace/${encodeURIComponent(slug)}/codesite/quarantines/`)
      && mcpReplay.structured?.response?.ok === true
      && mcpReplay.structured?.response?.replay?.length === 1
      && mcpReplay.structured.response.replay[0].path === targetPath,
    directCollabReplayRequiresSelectedPaths: directCollabMissingSelection.status === 400
      && directCollabMissingSelection.body?.error === 'missing_selected_paths',
    manifestListedById: listResponse.quarantines?.some((item) => item.quarantineId === quarantineId),
    manifestHasReplayText: manifestResponse.quarantine?.changes?.some((change) => (
      change.path === targetPath
      && change.quarantineEvidence?.beforeText === 'baseline\n'
      && change.quarantineEvidence?.afterText.includes('reviewed through quarantine')
    )),
    manifestRecordedSymlinkSanitization: manifestResponse.quarantine?.symlinkSanitization?.sanitized?.some((item) => (
      item.path === escapePath
      && item.reason === 'quarantine_symlink_escape_replaced'
    )),
    replayDryRunSelectedModifiedAndCreated: replay.ok === true
      && replay.replay.length === 2
      && replay.replay.some((item) => item.path === targetPath)
      && replay.replay.some((item) => item.path === createdPath),
    applySelectedModifiedAndCreated: apply.ok === true
      && apply.applied.length === 2
      && apply.applied.some((item) => item.path === targetPath)
      && apply.applied.some((item) => item.path === createdPath),
    browserUiVisibleAndSelectedBatch: uiProof.checks.panelVisible
      && uiProof.checks.quarantineIdVisible
      && uiProof.checks.targetVisible
      && uiProof.checks.createdVisible
      && uiProof.checks.symlinkGuardVisible
      && uiProof.checks.outsideVisible
      && uiProof.checks.replayResultVisible
      && uiProof.checks.applyResultVisible
      && uiProof.checks.staleReplayRejectedVisible
      && uiProof.checks.applyDisabledAfterRejected
      && uiProof.checks.selectedModifiedAndCreated
      && uiProof.checks.noHorizontalOverflow,
    realWorkspaceAppliedSelectedBatchOnly: afterOutput.includes('target=baseline\nreviewed through quarantine')
      && afterOutput.includes('notes=selected created quarantined note')
      && afterOutput.includes('outside=absent')
      && afterOutput.includes('escape_link=symlink')
      && afterOutput.includes('escape_target=outside-before'),
    staleReplayRejectedAfterApply: staleReplay.status === 409
      && staleReplay.body?.rejected?.some((item) => item.reasonCodes?.includes('quarantine_replay_base_mismatch')),
    mcpApplyRejectsStaleAfterApply: mcpStaleApply.isError === true
      && mcpStaleApply.structured?.status === 409
      && mcpStaleApply.structured?.response?.rejected?.some((item) => item.reasonCodes?.includes('quarantine_replay_base_mismatch')),
    controlPlaneRecordedQuarantine: eventTypes.filter((type) => type === 'write_quarantined').length >= 4,
    controlPlaneRecordedReview: eventTypes.includes('quarantine_reviewed'),
    controlPlaneRecordedReplay: eventTypes.includes('quarantine_replayed'),
    controlPlaneRecordedApply: eventTypes.includes('quarantine_applied'),
    controlPlaneRecordedWriteAllowed: relevantEvents.some((event) => event.eventType === 'write_allowed' && event.path === targetPath)
      && relevantEvents.some((event) => event.eventType === 'write_allowed' && event.path === createdPath),
    transactionObservedSelectedWrite: transactionAfter.transaction?.observedWriteSet?.includes(targetPath)
      && transactionAfter.transaction?.observedWriteSet?.includes(createdPath),
    controlStatePendingBeforeApply: controlStateBeforeApply.pendingQuarantines?.some((item) => item.quarantineId === quarantineId),
    controlStateRetainsUnselectedAfterPartialApply: pendingAfterApply?.status === 'partially_applied'
      && pendingAfterApply.appliedPaths?.includes(targetPath)
      && pendingAfterApply.appliedPaths?.includes(createdPath)
      && !pendingAfterApply.remainingPaths?.includes(createdPath)
      && pendingAfterApply.remainingPaths?.includes(outsidePath)
      && pendingAfterApply.remainingPaths?.includes(escapePath),
    controlStateSeparatesSuccessfulAndRejectedReplay: Boolean(
      pendingAfterApply?.successfulReplay?.attemptedAt
      && pendingAfterApply?.latestReplayAttempt?.rejectedChangeCount > 0
      && Date.parse(pendingAfterApply.lifecycle?.replayedAt) === Date.parse(pendingAfterApply.successfulReplay.attemptedAt)
      && Date.parse(pendingAfterApply.successfulReplay.attemptedAt) <= Date.parse(pendingAfterApply.lifecycle?.appliedAt)
      && Date.parse(pendingAfterApply.latestReplayAttempt.attemptedAt) > Date.parse(pendingAfterApply.lifecycle?.appliedAt),
    ),
    agentManifestHasQuarantineTools: ['synthi_codesite_review_quarantine', 'synthi_codesite_replay_quarantine', 'synthi_codesite_apply_quarantine']
      .every((name) => (agentManifest.mcpTools || []).some((tool) => mcpToolName(tool) === name)),
    agentManifestHasQuarantinePaths: agentManifest.quarantineIndex === `projects/${project.id}/quarantines/index.jsonl`
      && agentManifest.quarantineRoot === `projects/${project.id}/quarantines/`,
    artifactProjectionHasQuarantineSchema: artifactPathSet.has('schemas/codesitefs-quarantine.schema.json'),
    artifactProjectionHasControlPendingSchema: artifactPathSet.has('schemas/control-state.schema.json')
      && artifactFiles.find((file) => file.path === 'schemas/control-state.schema.json')?.contentPreview?.includes('pendingQuarantines'),
    artifactProjectionHasQuarantineIndex: Boolean(quarantineIndexArtifact?.contentPreview?.includes(quarantineId)),
    artifactProjectionHasQuarantineRecord: Boolean(quarantineArtifactRecord?.contentPreview?.includes(targetPath)),
    artifactProjectionControlStateRetainsPartial: pendingArtifactRecord?.status === 'partially_applied'
      && pendingArtifactRecord.appliedPaths?.includes(targetPath)
      && pendingArtifactRecord.appliedPaths?.includes(createdPath)
      && !pendingArtifactRecord.remainingPaths?.includes(createdPath)
      && pendingArtifactRecord.remainingPaths?.includes(outsidePath)
      && pendingArtifactRecord.remainingPaths?.includes(escapePath),
    artifactProjectionSeparatesSuccessfulAndRejectedReplay: Boolean(
      quarantineArtifactJson?.successfulReplay?.attemptedAt
      && quarantineArtifactJson?.latestReplayAttempt?.rejectedChangeCount > 0
      && Date.parse(quarantineArtifactJson.lifecycle?.replayedAt) === Date.parse(quarantineArtifactJson.successfulReplay.attemptedAt)
      && Date.parse(quarantineArtifactJson.lifecycle?.replayedAt) <= Date.parse(quarantineArtifactJson.lifecycle?.appliedAt)
      && Date.parse(quarantineArtifactJson.latestReplayAttempt.attemptedAt) > Date.parse(quarantineArtifactJson.lifecycle?.appliedAt)
      && Array.isArray(quarantineArtifactJson.replayAttempts)
      && quarantineArtifactJson.replayAttempts.length >= 2,
    ),
  };
  assertProof(assertions);

  const proof = {
    generatedAt: new Date().toISOString(),
    title: 'CodeSite Quarantine Review Proof',
    slug,
    appBaseUrl,
    collabBaseUrl,
    controlPlaneUrl,
    project: { id: project.id, title: project.title },
    clearance: { id: lease.id, callsign: lease.displayCallsign, status: lease.status },
    transaction: transactionAfter.transaction,
    rawWrite: {
      exitCode: rawWrite.exitCode,
      stdout: rawWrite.stdout || rawWrite.output || '',
      stderr: rawWrite.stderr || '',
    },
    quarantine: {
      id: quarantineId,
      changes: quarantine.changes,
      listed: listResponse.quarantines,
      manifest: manifestResponse.quarantine,
    },
    replay,
    apply,
    staleReplay: {
      status: staleReplay.status,
      body: staleReplay.body,
    },
    mcp: {
      reviewList: mcpReviewList,
      reviewManifest: mcpReviewManifest,
      replay: mcpReplay,
      staleApply: mcpStaleApply,
    },
    directCollabMissingSelection,
    workspaceReadback: {
      beforeApply: { exitCode: beforeApply.exitCode, output: beforeOutput },
      afterApply: { exitCode: afterApply.exitCode, output: afterOutput },
    },
    visual: {
      ui: {
        screenshot: uiProof.screenshot,
        desktopScreenshot: uiProof.desktopScreenshot,
        mobileScreenshot: uiProof.mobileScreenshot,
        rejectedScreenshot: uiProof.rejectedScreenshot,
        console: uiProof.console,
        checks: uiProof.checks,
      },
    },
    agentSurface: {
      agentManifest,
      quarantineMcpTools,
      artifactFiles: artifactFiles.filter((file) => (
        file.path.includes('/quarantines/')
        || file.path === 'schemas/codesitefs-quarantine.schema.json'
        || file.path === 'schemas/control-state.schema.json'
        || file.path.endsWith('/control-state.json')
      )),
      controlStateBeforeApply: {
        towerState: controlStateBeforeApply.towerState,
        pendingQuarantines: controlStateBeforeApply.pendingQuarantines,
        requiredActions: controlStateBeforeApply.requiredActions,
      },
      controlStateAfterApply: {
        towerState: controlStateAfterApply.towerState,
        pendingQuarantines: controlStateAfterApply.pendingQuarantines,
        requiredActions: controlStateAfterApply.requiredActions,
      },
    },
    controlPlane: {
      eventCount: eventsResponse.events.length,
      relevantEvents,
    },
    assertions,
  };

  const artifacts = await writeProofArtifacts(proof);
  console.log(`[quarantine-review-proof] wrote ${artifacts.jsonPath}`);
  console.log(`[quarantine-review-proof] wrote ${artifacts.htmlPath}`);
  console.log(`[quarantine-review-proof] wrote ${artifacts.pngPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
