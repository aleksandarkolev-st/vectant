import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

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
  return `codesite-metrics-proof-${Date.now()}`;
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

async function screenshotFile(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function screenshotPanel(baseUrl, slug, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="codesite-success-metrics"]', { timeout: 60000 });
  const metricsSection = page.locator('[data-testid="codesite-success-metrics"]');
  await metricsSection.scrollIntoViewIfNeeded();
  await page.addStyleTag({
    content: '[aria-label*="compass" i],[data-testid*="compass" i],[class*="compass" i]{display:none!important}',
  });
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('button,div')) {
      const text = (element.textContent || '').trim();
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const looksLikeBottomLeftCompass = text === 'N' && rect.left < 80 && rect.bottom > window.innerHeight - 120;
      if (looksLikeBottomLeftCompass || (text === 'N' && style.position === 'fixed')) {
        let node = element;
        for (let depth = 0; node && depth < 3; depth += 1) {
          node.style.display = 'none';
          node = node.parentElement;
        }
      }
    }
  });
  const box = await metricsSection.boundingBox();
  if (!box) throw new Error('metrics section not visible');
  await page.screenshot({
    path: pngPath,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: box.width,
      height: Math.max(360, box.height - 86),
    },
  });
  await browser.close();
}

async function buildWorkflow(api) {
  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Metrics ATC proof',
      request: 'Measure CodeSite ATC outcomes from real control-plane workflow data',
      zonePolicy: {
        noFlyZones: ['secrets/**'],
        zones: [
          { zoneKey: 'auth-api', label: 'Auth API', class: 'C', paths: ['features/auth/**'], rules: ['api_contract_radar_required'], risk: 'high' },
          { zoneKey: 'auth-ui', label: 'Auth UI', class: 'C', paths: ['components/auth/**'], rules: ['landing_inspection_required'], risk: 'medium' },
        ],
        repoSignals: {
          files: ['features/auth/signup.ts', 'components/auth/SignupForm.tsx', 'tests/auth/signup.test.ts'],
          importGraph: [{ from: 'components/auth/SignupForm.tsx', imports: ['features/auth/signup.ts'] }],
          testGraph: [{ testPath: 'tests/auth/signup.test.ts', covers: ['features/auth/signup.ts', 'components/auth/SignupForm.tsx'] }],
        },
      },
    }),
  })).project;
  const session = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'METRICS-01', agentProvider: 'codex-cli' }),
  })).agentSession;
  const plan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: session.id,
      displayCallsign: 'METRICS-01',
      domain: 'fullstack',
      mission: 'Update signup API and UI',
      route: ['features/auth/signup.ts', 'components/auth/SignupForm.tsx'],
      requestedTools: ['file_write', 'terminal_exec'],
    }),
  })).executionPlan;
  const lease = (await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['features/auth/**', 'components/auth/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write', 'terminal_exec'],
      requiredRadar: ['tests', 'security', 'migration'],
    }),
  })).mutationLease;
  const transaction = (await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: ['features/auth/signup.ts'],
      writeSet: ['features/auth/signup.ts', 'components/auth/SignupForm.tsx'],
      baseSnapshotEvidence: {
        schemaVersion: 'synthi.codesite.repoSnapshotEvidence.v1',
        status: 'stable',
        readSet: ['features/auth/signup.ts'],
        fileDigests: [{ path: 'features/auth/signup.ts', digest: 'sha256:auth-feature-api', exists: true }],
        snapshotDigest: 'sha256:metrics-proof-base',
        generatedAt: new Date().toISOString(),
      },
    }),
  })).transaction;
  await api(`/transactions/${encodeURIComponent(transaction.id)}/record-write`, {
    method: 'POST',
    body: JSON.stringify({
      path: 'features/auth/signup.ts',
      tool: 'file_write',
      evidenceRefs: ['codesite:metrics-proof:write-api'],
      lineProvenance: [{
        lineAnchor: 'features/auth/signup.ts#L12-L18',
        startLine: 12,
        endLine: 18,
        evidenceRefs: ['codesite:metrics-proof:line-api'],
        processAncestry: ['mcp:synthi_codesite_apply_patch'],
        promptSummary: 'Update signup API contract handler',
      }],
    }),
  });
  await api(`/projects/${encodeURIComponent(project.id)}/codesitefs-events`, {
    method: 'POST',
    body: JSON.stringify({
      path: 'secrets/prod.env',
      source: 'runtime_terminal',
      tool: 'terminal_exec',
      disposition: 'write_denied',
      evidenceRefs: ['codesitefs:block:metrics-proof'],
    }),
  });
  const inspectionRun = (await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      executionPlanId: plan.id,
      displayCallsign: 'QA-METRICS-01',
      changedPaths: ['features/auth/signup.ts', 'components/auth/SignupForm.tsx'],
      execute: true,
      commands: ['tests', 'security', 'migration'].map((adapter) => ({
        adapter,
        command: process.execPath,
        args: ['-e', `console.log("${adapter} metrics proof pass")`],
        timeoutMs: 5000,
      })),
    }),
  })).inspectionRun;
  const incident = (await api(`/projects/${encodeURIComponent(project.id)}/incidents`, {
    method: 'POST',
    body: JSON.stringify({
      severity: 'medium',
      category: 'near_miss',
      participants: ['METRICS-01'],
      affectedZones: ['features/auth/**', 'components/auth/**'],
      timelineEventRefs: ['write_allowed', 'write_denied', 'inspection_result'],
      evidenceRefs: ['codesite:metrics-proof:near-miss'],
      summary: 'Signup UI started from a stale API assumption before tower sequencing.',
      policyDelta: { rule: 'api_contract_before_ui_landing' },
    }),
  })).incident;
  const simulation = await api(`/projects/${encodeURIComponent(project.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies: ['schema-first', 'frontend-backend-parallel', 'test-first'] }),
  });
  const metrics = (await api(`/projects/${encodeURIComponent(project.id)}/metrics`)).metrics;
  const exportResult = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const artifactPreview = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/preview?include=content`);
  return {
    project,
    session,
    plan,
    lease,
    transaction,
    inspectionRun,
    incident,
    simulation,
    metrics,
    exportResult,
    artifactPreview,
  };
}

function proofHtml(proof) {
  const atcRows = proof.metrics.sections.atc;
  const transactionRows = proof.metrics.sections.transaction;
  const qualityRows = proof.metrics.sections.quality;
  const trustRows = proof.metrics.sections.trust;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Metrics Proof</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a0f;color:#f5f7fb}
body{margin:0;padding:28px;background:#080a0f}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #293246;border-radius:8px;background:#10151f;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{font-size:25px;margin:8px 0 6px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px;letter-spacing:0}
p{margin:0;color:#afbad0;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.label{font-size:12px;color:#98a2b8}
.value{margin-top:6px;font-size:22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
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
<h1>CodeSite Success Metrics Proof</h1>
<p>Live Docker workflow proving metrics are derived from real CodeSite API events, inspection runs, incidents, CodeSiteFS blocks, artifacts, and panel rendering.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div>${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Project</div><div>${escapeHtml(proof.project.id)}</div></div>
<div class="card"><div class="label">Metrics artifact</div><div>${escapeHtml(proof.metricsArtifactPath)}</div></div>
<div class="card"><div class="label">Panel screenshot</div><div>${escapeHtml(proof.panelPngPath)}</div></div>
</section>
<section class="grid">
${summaryCell('Near-misses replayed', proof.metrics.summary.nearMissesReplayed)}
${summaryCell('No-fly blocks', proof.metrics.summary.noFlyViolationsBlocked)}
${summaryCell('CodeSiteFS blocked writes', proof.metrics.summary.codeSiteFsBlockedWrites)}
${summaryCell('Landings passed first try', proof.metrics.summary.landingsPassedFirstTry)}
</section>
${metricTable('ATC Metrics', atcRows)}
${metricTable('Transaction Metrics', transactionRows)}
${metricTable('Quality Metrics', qualityRows)}
${metricTable('Trust Metrics', trustRows)}
<section class="card"><h2>Assertions</h2><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
</main>
</body>
</html>`;
}

function summaryCell(label, value) {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value ?? 'n/a')}</div></div>`;
}

function metricTable(title, rows) {
  return `<section class="card"><h2>${escapeHtml(title)}</h2><table><thead><tr><th>Metric</th><th>Value</th><th>Status</th><th>Evidence</th></tr></thead><tbody>
${rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.value ?? 'n/a')}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml((row.evidenceRefs || []).slice(0, 4).join(', '))}</td></tr>`).join('')}
</tbody></table></section>`;
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
  const api = createApi(baseUrl, slug);
  const workflow = await buildWorkflow(api);
  const metricsArtifact = workflow.artifactPreview.files.find((file) => file.path.endsWith('/metrics.json'));
  const assertions = {
    metricsSchemaVersion: workflow.metrics.schemaVersion === 'synthi.codesite.metrics.v1',
    nearMissReplayed: workflow.metrics.summary.nearMissesReplayed >= 1,
    noFlyBlocked: workflow.metrics.summary.noFlyViolationsBlocked >= 1,
    codeSiteFsBlocked: workflow.metrics.summary.codeSiteFsBlockedWrites >= 1,
    inspectionPassedFirstTry: workflow.metrics.summary.landingsPassedFirstTry >= 1,
    noFalseReroute: workflow.metrics.summary.flightsReroutedByTower === 0,
    writeClearanceCoverageUsesAttempts: workflow.metrics.summary.percentageWritesWithValidClearance === 0.5,
    lineProvenanceRecorded: workflow.metrics.summary.lineProvenanceCoverage > 0,
    metricsArtifactExported: Boolean(metricsArtifact),
    mcpManifestIncludesMetrics: workflow.artifactPreview.files
      .find((file) => file.path === 'manifest.json')
      ?.contentPreview?.includes('synthi_codesite_get_metrics') === true,
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const jsonPath = path.join(dir, 'codesite-metrics-proof.json');
  const htmlPath = path.join(dir, 'codesite-metrics-proof.html');
  const pngPath = path.join(dir, 'codesite-metrics-proof.png');
  const panelPngPath = path.join(dir, 'codesite-metrics-panel.png');
  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: { id: workflow.project.id, title: workflow.project.title },
    workflow,
    metrics: workflow.metrics,
    metricsArtifactPath: metricsArtifact?.path || null,
    panelPngPath: path.relative(repoRoot(), panelPngPath),
    assertions,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  fs.writeFileSync(htmlPath, proofHtml(proof));
  await screenshotFile(htmlPath, pngPath);
  await screenshotPanel(baseUrl, slug, panelPngPath);

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
