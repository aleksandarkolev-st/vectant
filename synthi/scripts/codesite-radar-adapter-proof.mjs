import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensureProofWorkspace } from './codesite-proof-api.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const ADAPTERS = [
  ['clearance', /^clearance:run:sha256:/],
  ['type', /^typecheck:run:sha256:/],
  ['tests', /^test:run:sha256:/],
  ['api_contract', /^api-contract:run:sha256:/],
  ['security', /^security:scan:sha256:/],
  ['migration', /^migration:plan:sha256:/],
  ['ui', /^ui:screenshot:sha256:/],
  ['accessibility', /^accessibility:audit:sha256:/],
  ['runtime', /^runtime:event:sha256:/],
  ['performance', /^performance:budget:sha256:/],
  ['handover', /^handover:packet:sha256:/],
];

const RADAR_TRAFFIC_MISSIONS = [
  {
    callsign: 'SCHEMA-01',
    domain: 'schema',
    mission: 'Stabilize shared contract before downstream signup work',
    route: ['packages/schemas/auth/**', 'openapi/auth.yaml'],
    requestedTools: ['file_write', 'npm_test'],
  },
  {
    callsign: 'API-02',
    domain: 'backend',
    mission: 'Implement dependent signup endpoint',
    route: ['packages/schemas/auth/**', 'api/auth/**'],
    requestedTools: ['file_write', 'npm_test'],
  },
  {
    callsign: 'UI-03',
    domain: 'frontend',
    mission: 'Wire signup form to the new contract',
    route: ['components/auth/**', 'packages/schemas/auth/**'],
    requestedTools: ['file_write', 'npm_test', 'playwright'],
  },
];

function radarTrafficProjectPayload() {
  return {
    title: 'Radar adapter proof',
    request: 'Run every mature radar adapter against a safe proof workspace with schema-first multi-agent traffic',
    autoWorkflow: true,
    autoWorkflowOperations: true,
    strategy: 'airspace_survey_first',
    zonePolicy: {
      zones: [
        {
          zoneKey: 'schema',
          label: 'Schema runway',
          class: 'B',
          paths: ['packages/schemas/auth/**', 'openapi/**'],
          rules: ['api_contract_radar_required'],
          risk: 'high',
        },
        {
          zoneKey: 'api',
          label: 'API approach',
          class: 'B',
          paths: ['api/auth/**'],
          rules: ['api_contract_radar_required'],
          risk: 'high',
        },
        {
          zoneKey: 'ui',
          label: 'UI approach',
          class: 'C',
          paths: ['components/auth/**'],
          rules: ['landing_inspection_required'],
          risk: 'medium',
        },
      ],
      semanticGraph: {
        sourceDigest: 'codesite-radar-adapter-proof-traffic-v1',
        generatedClients: ['components/auth/generated/auth-client.ts'],
        importEdges: [
          {
            from: 'api/auth/signup.ts',
            imports: ['packages/schemas/auth/signup.ts', 'openapi/auth.yaml'],
          },
          {
            from: 'components/auth/SignupForm.tsx',
            imports: ['packages/schemas/auth/signup.ts', 'api/auth/signup.ts'],
          },
        ],
        testOwnership: [
          {
            testPath: 'tests/auth/signup.contract.test.ts',
            covers: ['packages/schemas/auth/**', 'api/auth/**', 'components/auth/**'],
          },
        ],
      },
      noFlyZones: ['secrets/**', '.env*'],
    },
    missions: RADAR_TRAFFIC_MISSIONS,
  };
}

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function proofDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-radar-adapter-proof-${Date.now()}`;
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

function assertProof(value, message) {
  if (!value) throw new Error(message);
}

async function screenshotSummary(htmlPath, pngPath) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
}

function proofHtml(proof) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSite Radar Adapter Proof</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#080a0f;color:#f5f7fb}
body{margin:0;padding:28px;background:#080a0f}
main{max-width:1180px;margin:0 auto;display:grid;gap:18px}
.hero,.card{border:1px solid #293246;border-radius:8px;background:#10151f;padding:18px}
.pass{display:inline-block;border-radius:6px;background:#123b27;color:#9df2bd;padding:4px 8px;font-size:12px;font-weight:700}
h1{font-size:25px;margin:8px 0 6px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px;letter-spacing:0}
p{margin:0;color:#afbad0;line-height:1.5}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.label{font-size:12px;color:#98a2b8}
.value{margin-top:6px;font-size:14px;overflow-wrap:anywhere}
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
<h1>CodeSite Radar Adapter Proof</h1>
<p>Live Docker workflow proving first-class radar adapters run through the CodeSite inspection API and emit adapter-specific durable evidence refs.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Project</div><div class="value">${escapeHtml(proof.project.id)}</div></div>
<div class="card"><div class="label">Inspection run</div><div class="value">${escapeHtml(proof.inspectionRun.id)}</div></div>
<div class="card"><div class="label">Status</div><div class="value">${escapeHtml(proof.inspectionRun.status)}</div></div>
</section>
<section class="card"><h2>Adapter Evidence</h2><table><thead><tr><th>Adapter</th><th>Status</th><th>Evidence</th><th>Reason codes</th></tr></thead><tbody>
${proof.adapterRows.map((row) => `<tr><td>${escapeHtml(row.adapter)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.evidenceRef)}</td><td>${escapeHtml(row.reasonCodes.join(', '))}</td></tr>`).join('')}
</tbody></table></section>
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
  const { api } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Radar adapter proof workspace',
  });

  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify(radarTrafficProjectPayload()),
  })).project;
  const commands = ADAPTERS.map(([adapter]) => ({
    adapter,
    command: 'node',
    args: ['-e', `console.log("${adapter} radar adapter proof")`],
    timeoutMs: 5000,
  }));
  const inspectionRun = (await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'RADAR-STACK-01',
      changedPaths: ['components/auth/SignupForm.tsx', 'api/auth/signup.ts', 'packages/schemas/auth/signup.ts'],
      execute: true,
      commands,
    }),
  })).inspectionRun;
  const hydratedProject = (await api(`/projects/${encodeURIComponent(project.id)}`)).project;
  const controlState = await api(`/projects/${encodeURIComponent(project.id)}/control-state`);
  const collisionForecast = await api(`/projects/${encodeURIComponent(project.id)}/collision-predict`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const adapterRows = ADAPTERS.map(([adapter, evidencePattern]) => {
    const signal = inspectionRun.inspectionSignals.find((item) => item.key === adapter);
    const evidenceRef = signal?.evidenceRefs?.find((ref) => evidencePattern.test(ref)) || '';
    return {
      adapter,
      status: signal?.status || 'missing',
      evidenceRef,
      reasonCodes: signal?.reasonCodes || [],
    };
  });
  const assertions = {
    inspectionCompleted: inspectionRun.status === 'completed',
    everyAdapterProducedSignal: adapterRows.every((row) => row.status === 'passed'),
    everyAdapterProducedDurableEvidence: adapterRows.every((row) => row.evidenceRef),
    everyAdapterRecordedReasonCodes: adapterRows.every((row) => row.reasonCodes.includes(`${row.adapter}_adapter_executed`)),
    seededMultiAgentTraffic: (controlState.activeFlights || []).length >= 3,
    seededHoldingPattern: (controlState.activeFlights || []).some((flight) => String(flight.status).toLowerCase() === 'holding'),
    seededCollisionRisk: (collisionForecast.risks || []).length >= 1,
    seededLandingQueue: (hydratedProject.inspectionRuns || []).length >= 1,
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    project: { id: project.id, title: project.title, route: `/workspace/${encodeURIComponent(slug)}/codesite` },
    schemaProject: {
      id: hydratedProject.id,
      title: hydratedProject.title,
      route: `/workspace/${encodeURIComponent(slug)}/codesite`,
      activeFlights: (controlState.activeFlights || []).map((flight) => ({
        callsign: flight.displayCallsign,
        status: flight.status,
        route: flight.route,
      })),
      activeMutationLeases: (controlState.activeMutationLeases || []).map((lease) => ({
        callsign: lease.displayCallsign,
        status: lease.status,
        allowedPaths: lease.lease?.allowedPaths || [],
      })),
      collisionForecast: {
        riskLevel: collisionForecast.riskLevel,
        risks: collisionForecast.risks || [],
        runwayOccupancy: collisionForecast.runwayOccupancy || [],
      },
    },
    inspectionRun,
    adapterRows,
    assertions,
  };
  const jsonPath = path.join(dir, 'codesite-radar-adapter-proof.json');
  const htmlPath = path.join(dir, 'codesite-radar-adapter-proof.html');
  const pngPath = path.join(dir, 'codesite-radar-adapter-proof.png');
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
