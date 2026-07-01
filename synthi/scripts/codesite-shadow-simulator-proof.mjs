import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

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
  return `codesite-shadow-simulator-proof-${Date.now()}`;
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

function repoSignals() {
  return {
    source: 'codesite_shadow_simulator_live_proof',
    files: [
      'packages/schemas/auth.ts',
      'api/auth/signup.ts',
      'app/signup/page.tsx',
      'tests/auth/signup.test.ts',
      'openapi/auth.yaml',
      'prisma/schema.prisma',
      'prisma/migrations/202607010001_auth/migration.sql',
      'infra/production/auth-service.yaml',
    ],
    codeowners: [
      { pattern: 'packages/schemas/**', owners: ['@platform/contracts'] },
      { pattern: 'api/auth/**', owners: ['@platform/backend'] },
    ],
    openapi: ['openapi/auth.yaml'],
    prisma: {
      schemas: ['prisma/schema.prisma'],
      migrations: ['prisma/migrations/**'],
    },
    packageExports: [
      { packageName: '@acme/auth-contracts', root: 'packages/schemas', exports: ['packages/schemas/auth.ts'] },
    ],
    importGraph: [
      { from: 'api/auth/signup.ts', imports: ['packages/schemas/auth.ts'] },
      { from: 'app/signup/page.tsx', imports: ['packages/schemas/auth.ts'] },
    ],
    testGraph: [
      { testPath: 'tests/auth/signup.test.ts', covers: ['packages/schemas/auth.ts', 'api/auth/signup.ts'] },
    ],
    deployment: ['infra/production/auth-service.yaml'],
    generatedClients: ['app/generated/auth-client.ts'],
    secretPatterns: ['secrets/**', '**/.env.production'],
    pastIncidents: [
      {
        id: 'incident-auth-stale-contract',
        severity: 'medium',
        category: 'near_miss',
        affectedZones: ['packages/schemas/**'],
        evidenceRefs: ['incident:auth-stale-contract'],
      },
    ],
  };
}

async function createSchemaProject(api) {
  const response = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Tower simulator schema coordination proof',
      request: 'Coordinate signup schema, backend route, and frontend route without stale contract assumptions',
      autoWorkflow: true,
      zonePolicy: {
        repoSignals: repoSignals(),
        zones: [
          { zoneKey: 'schema-auth', label: 'Auth schema contract', class: 'B', paths: ['packages/schemas/**'], rules: ['api_contract_radar_required'], risk: 'high' },
          { zoneKey: 'api-auth', label: 'Auth API route', class: 'B', paths: ['api/auth/**'], rules: ['api_contract_radar_required'], risk: 'high' },
          { zoneKey: 'signup-ui', label: 'Signup UI', class: 'C', paths: ['app/signup/**'], rules: ['landing_inspection_required'], risk: 'medium' },
        ],
        noFlyZones: ['secrets/**'],
      },
      missions: [
        {
          callsign: 'SCHEMA-01',
          domain: 'schema',
          mission: 'Change signup schema contract',
          route: ['packages/schemas/auth.ts'],
          requestedTools: ['file_write', 'npm_test'],
        },
        {
          callsign: 'API-02',
          domain: 'backend',
          mission: 'Update signup backend route',
          route: ['api/auth/signup.ts'],
          requestedTools: ['file_write', 'npm_test'],
        },
        {
          callsign: 'UI-03',
          domain: 'frontend',
          mission: 'Update signup UI from schema contract',
          route: ['app/signup/page.tsx'],
          requestedTools: ['file_write', 'npm_test'],
        },
      ],
    }),
  });
  const project = response.project;

  await api(`/projects/${encodeURIComponent(project.id)}/incidents`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'near_miss',
      severity: 'medium',
      participants: ['UI-03'],
      affectedZones: ['packages/schemas/**'],
      evidenceRefs: ['incident:auth-stale-contract'],
      policyDelta: { candidate: 'refresh_downstream_assumptions' },
    }),
  });

  await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'QA-04',
      status: 'passed',
      changedPaths: ['packages/schemas/auth.ts', 'api/auth/signup.ts'],
      inspectionSignals: [
        { key: 'auth.signup.contract', status: 'passed', source: 'codesite_shadow_simulator_proof' },
        { key: 'auth.signup.tests', status: 'passed', source: 'codesite_shadow_simulator_proof' },
      ],
      evidenceRefs: ['test:auth-signup', 'runtime:event:shadow-simulator-proof'],
    }),
  });

  return project;
}

async function createMigrationProject(api) {
  const response = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Tower simulator migration runway proof',
      request: 'Coordinate two independent migration files on a single migration runway',
      autoWorkflow: true,
      zonePolicy: {
        repoSignals: {
          source: 'codesite_shadow_simulator_migration_proof',
          files: [
            'prisma/migrations/202607010001_auth/migration.sql',
            'prisma/migrations/202607010002_accounts/migration.sql',
          ],
          prisma: { migrations: ['prisma/migrations/**'] },
        },
        zones: [
          { zoneKey: 'migration-runway', label: 'Migration runway', class: 'A', paths: ['prisma/migrations/**'], rules: ['single_migration_runway_lock', 'migration_radar_required'], risk: 'critical' },
        ],
      },
      missions: [
        {
          callsign: 'DB-01',
          domain: 'backend',
          mission: 'Add auth migration',
          route: ['prisma/migrations/202607010001_auth/migration.sql'],
          requestedTools: ['file_write', 'npm_test'],
        },
        {
          callsign: 'DB-02',
          domain: 'backend',
          mission: 'Add account migration',
          route: ['prisma/migrations/202607010002_accounts/migration.sql'],
          requestedTools: ['file_write', 'npm_test'],
        },
      ],
    }),
  });
  return response.project;
}

async function captureTowerUi({ baseUrl, slug, screenshotPath, viewport }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="codesite-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="codesite-tower-simulator"]', { timeout: 60000 });
  await page.locator('[data-testid="codesite-tower-simulator"]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-testid="codesite-run-tower-simulator"]').first().click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="codesite-tower-simulator"]');
    return panel
      && panel.textContent.includes('schema-first')
      && panel.textContent.includes('frontend-backend-parallel')
      && panel.textContent.includes('refresh_downstream_assumptions')
      && panel.textContent.includes('codesite:repo-policy:');
  }, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const checks = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="codesite-tower-simulator"]');
    const rect = panel?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      panelRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      selectedVisible: Boolean(document.querySelector('[data-testid="codesite-tower-selected"]')?.textContent.includes('schema-first')),
      hasParallelUniverse: Boolean(panel?.textContent.includes('frontend-backend-parallel')),
      hasSchemaReason: Boolean(panel?.textContent.includes('schema_airspace_first')),
      hasTowerAction: Boolean(panel?.textContent.includes('refresh_downstream_assumptions')),
      hasRepoPolicyEvidence: Boolean(panel?.textContent.includes('codesite:repo-policy:')),
      hasSourceSignals: Boolean(panel?.textContent.includes('importGraphEdges:') && panel?.textContent.includes('testOwners:')),
      fitsViewport: Boolean(panel && document.documentElement.scrollWidth <= window.innerWidth + 4),
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function proofHtml(proof) {
  const schemaRows = proof.schemaSimulation.universes.map((universe) => `
<tr>
<td>${escapeHtml(universe.strategy)}</td>
<td>${escapeHtml(universe.result)}</td>
<td>${Math.round(Number(universe.predictedCollisionRisk || 0) * 100)}%</td>
<td>${escapeHtml(universe.inspectionCost)}</td>
<td>${escapeHtml((universe.unresolvedRisks || []).join(', ') || 'none')}</td>
</tr>`).join('\n');
  const migrationRows = proof.migrationSimulation.universes.map((universe) => `
<tr>
<td>${escapeHtml(universe.strategy)}</td>
<td>${escapeHtml(universe.result)}</td>
<td>${Math.round(Number(universe.predictedCollisionRisk || 0) * 100)}%</td>
<td>${escapeHtml(universe.inspectionCost)}</td>
<td>${escapeHtml((universe.requiredTowerActions || []).join(', ') || 'none')}</td>
</tr>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Tower Simulator Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a10;color:#f4f7fb}
body{margin:0;padding:28px;background:#080a10}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #252d3f;border-radius:8px;background:#10131c;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{margin:8px 0 6px;font-size:25px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px}
p{margin:0;color:#a5adbf;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.label{color:#98a2b8;font-size:12px}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border-top:1px solid #252d3f;padding:8px;text-align:left;vertical-align:top}
th{color:#a5adbf;font-weight:600}
pre{white-space:pre-wrap;border:1px solid #252d3f;border-radius:8px;background:#05060a;padding:14px;color:#cbd1e3;font-size:12px}
img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid #252d3f}
</style>
</head>
<body>
<main>
<section class="hero">
<span class="pass">PASS</span>
<h1>CodeSite Tower Simulator Proof</h1>
<p>Live Docker workflow using real CodeSite projects, repo policy signals, incidents, inspection history, API simulations, and actual browser captures of the Tower Simulator UI.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Schema selected</div><div class="value">${escapeHtml(proof.schemaSimulation.selected)}</div></div>
<div class="card"><div class="label">Migration selected</div><div class="value">${escapeHtml(proof.migrationSimulation.selected)}</div></div>
<div class="card"><div class="label">UI captures</div><div class="value">${escapeHtml(proof.browserProof.captures.map((capture) => capture.viewport.name).join(', '))}</div></div>
</section>
<section class="card"><h2>Schema Coordination Universes</h2><table><thead><tr><th>Strategy</th><th>Result</th><th>Risk</th><th>Cost</th><th>Unresolved</th></tr></thead><tbody>${schemaRows}</tbody></table></section>
<section class="card"><h2>Migration Runway Universes</h2><table><thead><tr><th>Strategy</th><th>Result</th><th>Risk</th><th>Cost</th><th>Tower actions</th></tr></thead><tbody>${migrationRows}</tbody></table></section>
<section><pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre></section>
${proof.browserProof.captures.map((capture) => `<section><h2>${escapeHtml(capture.viewport.name)} UI Capture</h2><img src="${escapeHtml(path.basename(capture.screenshot))}" alt="Tower Simulator ${escapeHtml(capture.viewport.name)} capture"></section>`).join('\n')}
</main>
</body>
</html>`;
}

async function screenshotSummary(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const api = createApi(baseUrl, slug);
  const dir = proofDir();
  await fs.promises.mkdir(dir, { recursive: true });

  const migrationProject = await createMigrationProject(api);
  const migrationSimulation = await api(`/projects/${encodeURIComponent(migrationProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies: [] }),
  });

  const schemaProject = await createSchemaProject(api);
  const schemaSimulation = await api(`/projects/${encodeURIComponent(schemaProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({
      strategies: ['schema-first', 'backend-first', 'frontend/backend parallel', 'single fullstack agent', 'test-first'],
    }),
  });
  const schemaProjectAfter = await api(`/projects/${encodeURIComponent(schemaProject.id)}`);

  const schemaUniverse = schemaSimulation.universes.find((universe) => universe.strategy === 'schema-first');
  const parallelUniverse = schemaSimulation.universes.find((universe) => universe.strategy === 'frontend-backend-parallel');
  const migrationUniverse = migrationSimulation.universes.find((universe) => universe.strategy === migrationSimulation.selected);
  const migrationSchemaUniverse = migrationSimulation.universes.find((universe) => universe.strategy === 'schema-first');
  const counterfactualRuns = schemaProjectAfter.project.counterfactualRuns || [];
  const events = schemaProjectAfter.project.events || [];

  const desktopShot = path.join(dir, 'codesite-shadow-simulator-ui-desktop.png');
  const mobileShot = path.join(dir, 'codesite-shadow-simulator-ui-mobile.png');
  const captures = [
    await captureTowerUi({
      baseUrl,
      slug,
      viewport: { name: 'desktop', width: 1440, height: 1100 },
      screenshotPath: desktopShot,
    }),
    await captureTowerUi({
      baseUrl,
      slug,
      viewport: { name: 'mobile', width: 390, height: 980 },
      screenshotPath: mobileShot,
    }),
  ];

  const assertions = {
    schemaSelected: schemaSimulation.selected === 'schema-first',
    schemaAvoidsSemanticCollision: schemaUniverse?.avoidedRisks?.includes('semantic_collision') === true,
    parallelLeavesSemanticCollision: parallelUniverse?.unresolvedRisks?.includes('semantic_collision') === true,
    aliasesNormalized: schemaSimulation.universes.some((universe) => universe.strategy === 'frontend-backend-parallel')
      && schemaSimulation.universes.some((universe) => universe.strategy === 'single-fullstack-agent'),
    repoSignalsUsed: Number(schemaUniverse?.sourceSignals?.importGraphEdges || 0) >= 2
      && Number(schemaUniverse?.sourceSignals?.testOwners || 0) >= 1
      && Number(schemaUniverse?.sourceSignals?.priorIncidents || 0) >= 1
      && Number(schemaUniverse?.sourceSignals?.inspectionRuns || 0) >= 1,
    counterfactualPersisted: counterfactualRuns.length >= 1,
    shadowAndArbiterEventsPersisted: events.some((event) => event.eventType === 'shadow_run')
      && events.some((event) => event.eventType === 'arbiter_verdict'),
    evidenceRefsPortable: schemaSimulation.evidenceRefs?.some((ref) => ref.startsWith('codesite:repo-policy:')) === true,
    migrationSelectedSingleRunway: migrationSimulation.selected === 'single-fullstack-agent',
    migrationLockActionVisible: migrationUniverse?.requiredTowerActions?.includes('single_migration_runway_lock') === true,
    migrationSchemaUnresolved: migrationSchemaUniverse?.unresolvedRisks?.includes('migration_collision') === true,
    desktopUiProved: captures[0].checks.selectedVisible
      && captures[0].checks.hasParallelUniverse
      && captures[0].checks.hasTowerAction
      && captures[0].checks.fitsViewport,
    mobileUiProved: captures[1].checks.selectedVisible
      && captures[1].checks.hasParallelUniverse
      && captures[1].checks.hasTowerAction
      && captures[1].checks.fitsViewport,
  };

  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    schemaProject: {
      id: schemaProject.id,
      title: schemaProject.title,
      route: `/workspace/${slug}/codesite`,
    },
    migrationProject: {
      id: migrationProject.id,
      title: migrationProject.title,
    },
    schemaSimulation,
    migrationSimulation,
    persisted: {
      counterfactualRunCount: counterfactualRuns.length,
      eventTypes: events.map((event) => event.eventType),
    },
    browserProof: { captures },
    assertions,
  };

  const jsonPath = path.join(dir, 'codesite-shadow-simulator-proof.json');
  const htmlPath = path.join(dir, 'codesite-shadow-simulator-proof.html');
  const pngPath = path.join(dir, 'codesite-shadow-simulator-proof.png');
  await fs.promises.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`);
  await fs.promises.writeFile(htmlPath, proofHtml(proof));
  await screenshotSummary(htmlPath, pngPath);

  console.log(JSON.stringify({
    ok: true,
    jsonPath: path.relative(repoRoot(), jsonPath),
    htmlPath: path.relative(repoRoot(), htmlPath),
    pngPath: path.relative(repoRoot(), pngPath),
    uiCaptures: captures.map((capture) => capture.screenshot),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
