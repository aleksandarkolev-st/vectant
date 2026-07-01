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
  return `codesite-counterfactual-memory-proof-${Date.now()}`;
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
    files: [
      'packages/schemas/auth.ts',
      'app/signup/page.tsx',
      'tests/auth/signup.test.ts',
    ],
    packageExports: [
      { packageName: '@acme/contracts', root: 'packages/schemas', exports: ['packages/schemas/auth.ts'] },
    ],
    importGraph: [
      { from: 'app/signup/page.tsx', imports: ['packages/schemas/auth.ts'] },
    ],
    testGraph: [
      { testPath: 'tests/auth/signup.test.ts', covers: ['packages/schemas/auth.ts', 'app/signup/page.tsx'] },
    ],
  };
}

async function createCoordinationProject(api) {
  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Counterfactual ATC memory proof',
      request: 'Coordinate contract and signup UI with learned traffic rules',
      zonePolicy: {
        repoSignals: repoSignals(),
        zones: [
          { zoneKey: 'schema-contracts', label: 'Schema contracts', class: 'B', paths: ['packages/schemas/**'], rules: ['api_contract_radar_required'], risk: 'high' },
          { zoneKey: 'signup-ui', label: 'Signup UI', class: 'C', paths: ['app/signup/**'], rules: ['landing_inspection_required'], risk: 'medium' },
        ],
      },
    }),
  })).project;
  const schemaSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'SCHEMA-01', agentProvider: 'codex-cli' }),
  })).agentSession;
  const uiSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'UI-02', agentProvider: 'codex-cli' }),
  })).agentSession;
  await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: schemaSession.id,
      displayCallsign: 'SCHEMA-01',
      domain: 'schema',
      mission: 'Change signup contract',
      route: ['packages/schemas/auth.ts'],
      requestedTools: ['file_write'],
    }),
  });
  await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: uiSession.id,
      displayCallsign: 'UI-02',
      domain: 'frontend',
      mission: 'Build signup UI',
      route: ['app/signup/page.tsx'],
      requestedTools: ['file_write'],
    }),
  });
  return project;
}

async function createLeaseGateProject(api) {
  const project = (await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Counterfactual lease gate proof',
      request: 'Prove learned policy can hold a matching future clearance',
      zonePolicy: {
        zones: [
          { zoneKey: 'component-ui', label: 'Component UI', class: 'C', paths: ['src/components/**'], rules: ['landing_inspection_required'], risk: 'medium' },
        ],
      },
    }),
  })).project;
  const session = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({ displayCallsign: 'UI-GATE-01', agentProvider: 'codex-cli' }),
  })).agentSession;
  const plan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: session.id,
      displayCallsign: 'UI-GATE-01',
      domain: 'frontend',
      mission: 'Update signup component',
      route: ['src/components/SignupForm.tsx'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;
  return { project, plan };
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
<title>CodeSite Counterfactual Memory Proof</title>
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
<h1>CodeSite Counterfactual ATC Memory Proof</h1>
<p>Live Docker workflow proving persisted counterfactual policy deltas influence future tower simulation and live clearance decisions without bypassing hard safety gates.</p>
</section>
<section class="grid">
<div class="card"><div class="label">Workspace</div><div class="value">${escapeHtml(proof.slug)}</div></div>
<div class="card"><div class="label">Simulation project</div><div class="value">${escapeHtml(proof.simulationProject.id)}</div></div>
<div class="card"><div class="label">Simulator delta</div><div class="value">${escapeHtml(proof.simulatorDelta.id)}</div></div>
<div class="card"><div class="label">Lease delta</div><div class="value">${escapeHtml(proof.leaseDelta.id)}</div></div>
</section>
<section class="card"><h2>Before And After Tower Decision</h2><table><thead><tr><th>Run</th><th>Selected</th><th>Applied deltas</th><th>Reason codes</th></tr></thead><tbody>
<tr><td>Before memory</td><td>${escapeHtml(proof.before.selected)}</td><td>${escapeHtml((proof.before.appliedPolicyDeltas || []).join(', ') || 'none')}</td><td>${escapeHtml((proof.before.reason.reasonCodes || []).join(', '))}</td></tr>
<tr><td>After promoted delta</td><td>${escapeHtml(proof.after.selected)}</td><td>${escapeHtml((proof.after.appliedPolicyDeltas || []).join(', '))}</td><td>${escapeHtml((proof.after.reason.reasonCodes || []).join(', '))}</td></tr>
</tbody></table></section>
<section class="card"><h2>Lease Gate</h2><pre>${escapeHtml(JSON.stringify(proof.leaseDecision, null, 2))}</pre></section>
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

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = proofDir();
  fs.mkdirSync(dir, { recursive: true });
  const api = createApi(baseUrl, slug);

  const simulationProject = await createCoordinationProject(api);
  const strategies = ['schema-first', 'frontend-backend-parallel', 'test-first'];
  const before = await api(`/projects/${encodeURIComponent(simulationProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies }),
  });
  const simulatorDelta = (await api(`/projects/${encodeURIComponent(simulationProject.id)}/policy-deltas`, {
    method: 'POST',
    body: JSON.stringify({
      learnedFromIncidents: ['near-miss-signup-contract-001'],
      ruleCandidate: {
        rule: 'contract_churn_requires_owned_tests',
        preferredStrategies: ['test-first'],
        avoidStrategies: ['schema-first', 'frontend-backend-parallel'],
        requiredTowerActions: ['run_owned_tests_before_landing'],
      },
      triggerConditions: [{ risk: 'semantic_collision' }, { path: 'packages/schemas/**' }],
      expectedRiskReduction: 0.6,
      confidence: 0.95,
      promotionState: 'active',
      replayRefs: [before.shadowJobRef],
    }),
  })).policyDelta;
  const after = await api(`/projects/${encodeURIComponent(simulationProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies }),
  });

  const { project: leaseProject, plan } = await createLeaseGateProject(api);
  const leaseDelta = (await api(`/projects/${encodeURIComponent(leaseProject.id)}/policy-deltas`, {
    method: 'POST',
    body: JSON.stringify({
      learnedFromIncidents: ['near-miss-ui-contract-rfi-001'],
      affectedZoneKey: 'Component-UI',
      ruleCandidate: {
        rule: 'sequence_frontend_after_contract_rfi',
        decision: 'hold',
        requiredRadar: ['visual'],
        requiredTowerActions: ['sequence_after_contract_response'],
      },
      triggerConditions: [{ path: 'src/components/**' }],
      expectedRiskReduction: 0.3,
      confidence: 0.9,
      promotionState: 'active',
      replayRefs: [after.shadowJobRef],
    }),
  })).policyDelta;
  const lease = (await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['src/components/SignupForm.tsx'],
      allowedTools: ['file_write'],
      requiredRadar: ['tests'],
    }),
  })).mutationLease;

  const assertions = {
    baselineHadNoAppliedPolicyDelta: before.appliedPolicyDeltas.length === 0,
    promotedDeltaChangedTowerSelection: before.selected !== after.selected
      && after.selected === 'test-first'
      && after.appliedPolicyDeltas.includes(simulatorDelta.id),
    afterReasonExplainsLearning: after.reason.reasonCodes.includes('counterfactual_policy_delta_applied')
      && after.reason.reasonCodes.includes('learned_policy_delta_preferred_strategy'),
    simulatorEvidenceReferencesDelta: after.evidenceRefs.includes(`codesite:policy-delta:${simulatorDelta.id}`),
    explicitAvoidWasNotNeutralizedByFallback: after.universes
      .find((universe) => universe.strategy === 'schema-first')
      ?.reasonCodes.includes('learned_policy_delta_avoided_strategy') === true
      && after.universes
        .find((universe) => universe.strategy === 'schema-first')
        ?.reasonCodes.includes('learned_policy_delta_preferred_strategy') !== true,
    learnedLeaseGateHeldClearance: lease.status === 'holding'
      && lease.lease.counterfactualPolicy?.appliedPolicyDeltas?.includes(leaseDelta.id),
    learnedLeaseGateAugmentedRadar: lease.lease.requiredRadar.includes('tests')
      && lease.lease.requiredRadar.includes('visual'),
  };
  for (const [key, value] of Object.entries(assertions)) {
    assertProof(value === true, `assertion failed: ${key}`);
  }

  const proof = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    slug,
    simulationProject: { id: simulationProject.id, title: simulationProject.title },
    simulatorDelta,
    leaseProject: { id: leaseProject.id, title: leaseProject.title },
    leaseDelta,
    before,
    after,
    leaseDecision: {
      status: lease.status,
      requiredRadar: lease.lease.requiredRadar,
      counterfactualPolicy: lease.lease.counterfactualPolicy,
      policyDecision: lease.policyDecision,
    },
    assertions,
  };
  const jsonPath = path.join(dir, 'codesite-counterfactual-memory-proof.json');
  const htmlPath = path.join(dir, 'codesite-counterfactual-memory-proof.html');
  const pngPath = path.join(dir, 'codesite-counterfactual-memory-proof.png');
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
