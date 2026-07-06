import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3122';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function slugNow() {
  return `codesite-filesystem-boundary-proof-${Date.now()}`;
}

function outDir(slug) {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'filesystem-boundary-proof', slug));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function assertAll(assertions) {
  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) throw new Error(`filesystem boundary proof failed: ${failed.join(', ')}`);
}

async function screenshotLiveUi({ baseUrl, slug, dir }) {
  const browser = await chromium.launch({ headless: true });
  const desktop = path.join(dir, 'codesite-filesystem-boundary-desktop.png');
  const panel = path.join(dir, 'codesite-filesystem-boundary-panel.png');
  const mobile = path.join(dir, 'codesite-filesystem-boundary-mobile.png');
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1120 }, deviceScaleFactor: 1 });
    await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    const proofPanel = page.getByTestId('codesite-filesystem-boundary-proof');
    await proofPanel.waitFor({ state: 'visible', timeout: 180000 });
    await proofPanel.getByText('runtime-boundary/', { exact: false }).first().waitFor({ state: 'visible', timeout: 60000 });
    await proofPanel.getByText('python <- bash <- codex-cli', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    const replayApplyText = await proofPanel.evaluate((element) => element.textContent || '');
    if (/\bReplay\b|\bApply\b/.test(replayApplyText)) {
      throw new Error('filesystem boundary proof panel exposed quarantine replay/apply controls');
    }
    await proofPanel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: desktop, fullPage: true });
    await proofPanel.screenshot({ path: panel });

    await page.setViewportSize({ width: 390, height: 1120 });
    await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    const mobilePanel = page.getByTestId('codesite-filesystem-boundary-proof');
    await mobilePanel.waitFor({ state: 'visible', timeout: 180000 });
    await mobilePanel.getByText('runtime-boundary/', { exact: false }).first().waitFor({ state: 'visible', timeout: 60000 });
    await mobilePanel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: mobile, fullPage: true });
  } finally {
    await browser.close();
  }
  return { desktop, panel, mobile };
}

function proofHtml(proof) {
  const rows = proof.boundaryProofs.map((record) => `
    <tr>
      <td>${escapeHtml(record.disposition)}</td>
      <td><code>${escapeHtml(record.path)}</code></td>
      <td>${escapeHtml(record.mutationLeaseId || record.leaseState)}</td>
      <td>${escapeHtml(record.reasonCodes.join(', '))}</td>
      <td>${escapeHtml(record.process?.display || record.missingProofFields.join(', '))}</td>
      <td>${escapeHtml(record.evidenceRefs.join(', '))}</td>
    </tr>
  `).join('\n');
  const images = Object.entries(proof.visual).map(([label, file]) => `
    <section>
      <h2>${escapeHtml(label)}</h2>
      <img src="${escapeHtml(path.basename(file))}" alt="${escapeHtml(label)}">
    </section>
  `).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>CodeSite Filesystem Boundary Proof</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; background: #f7f7f5; color: #181816; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 28px 0 10px; }
    code { background: #ecece8; padding: 2px 5px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin-top: 18px; }
    td, th { border: 1px solid #d7d7d1; padding: 8px; text-align: left; font-size: 13px; vertical-align: top; }
    img { max-width: 100%; border: 1px solid #d7d7d1; border-radius: 6px; background: #fff; }
  </style>
</head>
<body>
  <h1>CodeSite Filesystem Boundary Proof</h1>
  <p>Workspace <code>${escapeHtml(proof.slug)}</code>, project <code>${escapeHtml(proof.project.id)}</code>.</p>
  <table>
    <thead><tr><th>Disposition</th><th>Path</th><th>Lease</th><th>Reason</th><th>Process</th><th>Evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${images}
</body>
</html>`;
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = outDir(slug);
  await fs.mkdir(dir, { recursive: true });
  const api = createApi(baseUrl, slug);
  const deniedPath = `runtime-boundary/${slug}/prod.env`;
  const quarantinedPath = `src/app/${slug}/quarantined-note.md`;

  const { project } = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Filesystem boundary proof',
      request: 'Prove CodeSiteFS denied and quarantined writes are visible as path, lease, reason, process, and evidence.',
      zonePolicy: {
        noFlyZones: ['runtime-boundary/**'],
        zones: [
          { zoneKey: 'app', label: 'Application code', class: 'C', paths: ['src/app/**'], rules: ['transaction_required'] },
          { zoneKey: 'runtime-boundary', label: 'Runtime boundary no-fly', class: 'A', paths: ['runtime-boundary/**'], rules: ['no_runtime_write'] },
        ],
        classRules: { A: ['type_rated_license_required'], C: ['transaction_required'] },
      },
    }),
  });
  const session = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'FS-PROOF-1', agentProvider: 'codex-cli' }),
  })).agentSession;
  const plan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: session.id,
      displayCallsign: 'FS-PROOF-1',
      domain: 'frontend',
      mission: 'Exercise CodeSiteFS boundary proof projection',
      route: ['src/app/**'],
      requestedTools: ['terminal_exec', 'file_write'],
    }),
  })).executionPlan;
  const lease = (await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['src/app/**'],
      blockedPaths: ['runtime-boundary/**'],
      allowedTools: ['terminal_exec', 'file_write'],
      requiredRadar: ['filesystem_boundary'],
    }),
  })).mutationLease;

  const denied = await api(`/projects/${encodeURIComponent(project.id)}/codesitefs-events`, {
    method: 'POST',
    body: JSON.stringify({
      path: deniedPath,
      source: 'runtime_pod_terminal',
      tool: 'terminal_exec',
      processAncestry: ['python', 'bash', 'codex-cli'],
      evidenceRefs: [`runtime:event:denied-write:${slug}`],
    }),
  });
  const quarantined = await api(`/projects/${encodeURIComponent(project.id)}/codesitefs-events`, {
    method: 'POST',
    body: JSON.stringify({
      path: quarantinedPath,
      source: 'runtime_pod_terminal',
      tool: 'terminal_exec',
      disposition: 'write_quarantined',
      processAncestry: ['node', 'bash', 'codex-cli'],
      evidenceRefs: [`runtime:event:quarantined-write:${slug}`],
      quarantine: true,
    }),
  });
  const exportResult = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const [controlState, events, artifactPreview] = await Promise.all([
    api(`/projects/${encodeURIComponent(project.id)}/control-state`),
    api(`/projects/${encodeURIComponent(project.id)}/events`),
    api(`/projects/${encodeURIComponent(project.id)}/artifacts/preview?include=content&maxContentBytes=262144`),
  ]);

  const boundaryProofs = controlState.filesystemBoundaryProofs || [];
  const deniedProof = boundaryProofs.find((record) => record.path === deniedPath);
  const quarantinedProof = boundaryProofs.find((record) => record.path === quarantinedPath);
  const artifactRecord = (artifactPreview.files || []).find((file) => file.path === `projects/${project.id}/filesystem-boundary-proof.json`);
  const artifactJson = artifactRecord?.contentPreview ? JSON.parse(artifactRecord.contentPreview) : null;
  const realRepoDeniedPath = path.join(repoRoot(), deniedPath);
  const screenshots = await screenshotLiveUi({ baseUrl, slug, dir });

  const assertions = {
    deniedPreflightBlocked: denied.ok === false && denied.disposition === 'write_denied',
    quarantinedPreflightCaptured: quarantined.ok === false && quarantined.disposition === 'write_quarantined',
    deniedProofProjected: Boolean(deniedProof),
    quarantinedProofProjected: Boolean(quarantinedProof),
    deniedProofHasPathLeaseReasonProcessEvidence: Boolean(
      deniedProof?.path === deniedPath
      && deniedProof?.mutationLeaseId == null
      && deniedProof?.leaseState === 'inspected_clearance_rejected'
      && (deniedProof?.inspectedLeases || []).some((item) => item.mutationLeaseId === lease.id && item.ok === false)
      && deniedProof?.reasonCodes?.includes('entered_no_fly_zone')
      && deniedProof?.process?.display === 'python <- bash <- codex-cli'
      && deniedProof?.evidenceRefs?.includes(`runtime:event:denied-write:${slug}`)
      && deniedProof?.proofComplete === true
    ),
    quarantineProofHasPathLeaseReasonProcessEvidence: Boolean(
      quarantinedProof?.path === quarantinedPath
      && quarantinedProof?.mutationLeaseId === lease.id
      && quarantinedProof?.disposition === 'write_quarantined'
      && quarantinedProof?.process?.display === 'node <- bash <- codex-cli'
      && quarantinedProof?.evidenceRefs?.includes(`runtime:event:quarantined-write:${slug}`)
      && quarantinedProof?.proofComplete === true
    ),
    artifactProjected: Boolean(artifactJson?.records?.some((record) => record.path === deniedPath) && artifactJson?.records?.some((record) => record.path === quarantinedPath)),
    schemaProjected: Boolean((artifactPreview.files || []).some((file) => file.path === 'schemas/filesystem-boundary-proof.schema.json')),
    eventLogContainsBoundaryEvents: events.events?.filter((event) => ['write_denied', 'write_quarantined'].includes(event.eventType)).length >= 2,
    deniedPathNotMutatedInRepo: !(await fileExists(realRepoDeniedPath)),
    uiScreenshotsCaptured: Object.values(screenshots).every(Boolean),
  };
  assertAll(assertions);

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: { id: project.id, title: project.title },
    session: { id: session.id, displayCallsign: session.displayCallsign },
    plan: { id: plan.id, route: plan.route },
    lease: { id: lease.id, allowedPaths: lease.lease?.allowedPaths, blockedPaths: lease.lease?.blockedPaths },
    denied,
    quarantined,
    exportResult,
    boundaryProofs,
    artifact: artifactJson,
    assertions,
    visual: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, path.relative(dir, file).replaceAll(path.sep, '/')])),
  };
  const jsonPath = path.join(dir, 'codesite-filesystem-boundary-proof.json');
  const htmlPath = path.join(dir, 'codesite-filesystem-boundary-proof.html');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  await fs.writeFile(htmlPath, proofHtml({
    ...proof,
    visual: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, file])),
  }));

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot(), jsonPath),
    htmlPath: path.relative(repoRoot(), htmlPath),
    screenshots: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, path.relative(repoRoot(), file).replaceAll(path.sep, '/')])),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
