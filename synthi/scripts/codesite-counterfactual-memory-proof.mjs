import fs from 'node:fs';
import path from 'node:path';
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

async function getProject(api, projectId) {
  return (await api(`/projects/${encodeURIComponent(projectId)}`)).project;
}

function policyDeltaByRule(project, rule, replayRef = null) {
  return (project.policyDeltas || []).find((delta) => (
    delta.ruleCandidate?.rule === rule
    && (!replayRef || (delta.replayRefs || []).includes(replayRef))
  ));
}

function counterfactualRunById(project, runId) {
  return (project.counterfactualRuns || []).find((run) => run.id === runId);
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
<div class="card"><div class="label">Choice scene run</div><div class="value">${escapeHtml(proof.choiceSceneRun.id)}</div></div>
<div class="card"><div class="label">Simulator delta</div><div class="value">${escapeHtml(proof.simulatorDelta.id)}</div></div>
<div class="card"><div class="label">Lease delta</div><div class="value">${escapeHtml(proof.leaseDelta.id)}</div></div>
</section>
<section class="card"><h2>Before And After Tower Decision</h2><table><thead><tr><th>Run</th><th>Selected</th><th>Applied deltas</th><th>Reason codes</th></tr></thead><tbody>
<tr><td>Before memory</td><td>${escapeHtml(proof.before.selected)}</td><td>${escapeHtml((proof.before.appliedPolicyDeltas || []).join(', ') || 'none')}</td><td>${escapeHtml((proof.before.reason.reasonCodes || []).join(', '))}</td></tr>
<tr><td>After promoted delta</td><td>${escapeHtml(proof.after.selected)}</td><td>${escapeHtml((proof.after.appliedPolicyDeltas || []).join(', '))}</td><td>${escapeHtml((proof.after.reason.reasonCodes || []).join(', '))}</td></tr>
</tbody></table></section>
<section class="card"><h2>Mature Learning Signals</h2><table><tbody>
<tr><th>Choice-scene candidates</th><td>${escapeHtml(proof.choiceSceneRun.arbiterVerdict?.counterfactualLearning?.inferredCandidateCount || 0)}</td></tr>
<tr><th>Learning signals</th><td>${escapeHtml((proof.choiceSceneRun.arbiterVerdict?.counterfactualLearning?.learningSignals || []).join(', '))}</td></tr>
<tr><th>Collision hints</th><td>${escapeHtml((proof.collisionForecast.regretMemoryPolicyHints || []).map((hint) => hint.rule).join(', '))}</td></tr>
<tr><th>Incident delta</th><td>${escapeHtml(`${proof.incident.policyDelta?.id || 'missing'} / ${proof.incident.policyDelta?.ruleCandidate?.rule || 'missing'}`)}</td></tr>
<tr><th>Manual rewrites linked</th><td>${escapeHtml((proof.updatedChoiceSceneRun?.laterManualEdits || []).filter((edit) => edit.incidentId).map((edit) => `${edit.path}:${edit.incidentId}`).join(', '))}</td></tr>
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
  const { api } = await ensureProofWorkspace(baseUrl, slug, {
    workspaceName: 'Counterfactual memory proof workspace',
  });

  const simulationProject = await createCoordinationProject(api);
  const strategies = ['schema-first', 'frontend-backend-parallel', 'test-first'];
  const before = await api(`/projects/${encodeURIComponent(simulationProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies }),
  });

  const choiceSceneRun = (await api(`/projects/${encodeURIComponent(simulationProject.id)}/counterfactual-runs`, {
    method: 'POST',
    body: JSON.stringify({
      shadowJobRef: before.shadowJobRef,
      repoSnapshot: before.baseSnapshot,
      choices: [
        {
          universe: 'test-first',
          result: 'passed',
          affectedRoutes: ['packages/schemas/auth.ts', 'app/signup/page.tsx'],
          inspectionCost: 3,
          staleAssumptions: 0,
          reworkRiskReduction: 0.52,
          evidenceRefs: ['test:auth-signup-owned'],
        },
        {
          universe: 'schema-first',
          result: 'near_miss',
          affectedRoutes: ['packages/schemas/auth.ts'],
          unresolvedRisks: ['semantic_collision'],
          predictedCollisionRisk: 0.72,
          staleAssumptions: 2,
          incidents: ['near-miss-signup-contract-001'],
        },
        {
          universe: 'frontend-backend-parallel',
          result: 'near_miss',
          affectedRoutes: ['app/signup/page.tsx', 'packages/schemas/auth.ts'],
          unresolvedRisks: ['semantic_collision'],
          predictedCollisionRisk: 0.84,
          staleAssumptions: 3,
          incidents: ['near-miss-signup-contract-001', 'near-miss-profile-payload-002'],
        },
      ],
      arbiterVerdict: { selected: 'test-first', humanOverride: null },
      applyResult: { result: 'applied', selected: 'test-first' },
      nearMisses: ['near-miss-signup-contract-001', 'near-miss-profile-payload-002'],
      laterManualEdits: [{
        path: 'app/generated/auth-client.ts',
        reason: 'manual rewrite refreshed downstream generated client after schema contract churn',
        incidentRefs: ['near-miss-profile-payload-002'],
      }],
      airspaceClassFeedback: [{
        path: 'packages/schemas/auth.ts',
        outcome: 'too_loose',
        reason: 'class mismatch allowed dependent work before schema stability',
      }],
      inspectionFindings: [{
        path: 'api/auth/signup.ts',
        adapter: 'api_contract',
        caughtRealIssue: true,
        status: 'blocked_regression',
      }],
      towerReroutes: [{
        path: 'app/signup/page.tsx',
        savedWork: 4,
        reason: 'reroute avoided repeated UI rewrite',
      }],
      clearanceViolations: [{
        path: 'app/signup/page.tsx',
        callsign: 'UI-02',
        violation: true,
        reason: 'outside_clearance_write',
      }],
      blackBoxPatterns: [{
        path: 'packages/schemas/auth.ts',
        pattern: 'contract_escape_without_generated_client_refresh',
        promoteToRule: true,
      }],
      validityStrength: 'executed',
      evidenceRefs: [
        `shadow:job:${before.shadowJobRef}`,
        'replay:evidence:counterfactual-choice-scene',
      ],
    }),
  })).counterfactualRun;
  const projectWithInferredDeltas = await getProject(api, simulationProject.id);
  const proposedSimulatorDelta = policyDeltaByRule(
    projectWithInferredDeltas,
    'flight_split_reduced_collision',
    `codesite:counterfactual-run:${choiceSceneRun.id}`,
  );
  assertProof(Boolean(proposedSimulatorDelta), 'inferred flight-split policy delta was not persisted');
  const simulatorDelta = (await api(`/projects/${encodeURIComponent(simulationProject.id)}/policy-deltas/${encodeURIComponent(proposedSimulatorDelta.id)}/promote`, {
    method: 'POST',
    body: JSON.stringify({
      targetState: 'promoted',
      validation: {
        status: 'passed',
        replayRefs: [`codesite:counterfactual-run:${choiceSceneRun.id}`],
        evidenceRefs: ['replay:evidence:counterfactual-memory-simulator'],
      },
    }),
  })).policyDelta;
  const after = await api(`/projects/${encodeURIComponent(simulationProject.id)}/shadow-merge-simulate`, {
    method: 'POST',
    body: JSON.stringify({ strategies }),
  });
  const collisionForecast = await api(`/projects/${encodeURIComponent(simulationProject.id)}/collision-predict`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const incident = (await api(`/projects/${encodeURIComponent(simulationProject.id)}/incidents`, {
    method: 'POST',
    body: JSON.stringify({
      category: 'near_miss',
      severity: 'high',
      summary: 'Signup contract drift required a manual generated-client rewrite.',
      participants: ['UI-02', 'SCHEMA-01'],
      affectedZones: ['packages/schemas/**', 'app/generated/**'],
      counterfactualRunId: choiceSceneRun.id,
      evidenceRefs: [`codesite:counterfactual-run:${choiceSceneRun.id}`, 'runtime:event:signup-drift'],
      laterManualEdits: [{
        path: 'app/generated/auth-client.ts',
        reason: 'manual rewrite after schema drift',
      }],
    }),
  })).incident;
  const projectAfterIncident = await getProject(api, simulationProject.id);
  const updatedChoiceSceneRun = counterfactualRunById(projectAfterIncident, choiceSceneRun.id);

  const { project: leaseProject, plan } = await createLeaseGateProject(api);
  const leaseMemoryRun = (await api(`/projects/${encodeURIComponent(leaseProject.id)}/counterfactual-runs`, {
    method: 'POST',
    body: JSON.stringify({
      shadowJobRef: `lease-shadow:${choiceSceneRun.id}`,
      repoSnapshot: `repo@lease-${choiceSceneRun.id}`,
      choices: [
        {
          universe: 'sequence-after-contract-rfi',
          result: 'passed',
          affectedRoutes: ['src/components/SignupForm.tsx'],
          inspectionCost: 2,
          staleAssumptions: 0,
        },
        {
          universe: 'immediate-ui-clearance',
          result: 'near_miss',
          affectedRoutes: ['src/components/SignupForm.tsx'],
          incidents: ['near-miss-ui-contract-rfi-001'],
          staleAssumptions: 2,
        },
      ],
      arbiterVerdict: { selected: 'sequence-after-contract-rfi' },
      validityStrength: 'executed',
      evidenceRefs: ['replay:evidence:counterfactual-memory-lease'],
    }),
  })).counterfactualRun;
  const proposedLeaseDelta = (await api(`/projects/${encodeURIComponent(leaseProject.id)}/policy-deltas`, {
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
      replayRefs: [`codesite:counterfactual-run:${leaseMemoryRun.id}`],
    }),
  })).policyDelta;
  const leaseDelta = (await api(`/projects/${encodeURIComponent(leaseProject.id)}/policy-deltas/${encodeURIComponent(proposedLeaseDelta.id)}/promote`, {
    method: 'POST',
    body: JSON.stringify({
      targetState: 'promoted',
      validation: {
        status: 'passed',
        replayRefs: [`codesite:counterfactual-run:${leaseMemoryRun.id}`],
        evidenceRefs: ['replay:evidence:counterfactual-memory-lease'],
      },
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
    governedPromotionActivatedMemory: proposedSimulatorDelta.promotionState === 'proposed'
      && simulatorDelta.promotionState === 'promoted'
      && simulatorDelta.ruleCandidate?.promotion?.validationStatus === 'passed'
      && leaseDelta.ruleCandidate?.promotion?.validationStatus === 'passed',
    inferredChoiceSceneCapturedAllMatureSignals: choiceSceneRun.arbiterVerdict?.choiceScene?.choices?.length === 3
      && choiceSceneRun.arbiterVerdict?.counterfactualLearning?.inferredCandidateCount >= 8,
    collisionPredictionCarriesRegretMemoryHints: (collisionForecast.regretMemoryPolicyHints || [])
      .some((hint) => hint.policyDeltaId === simulatorDelta.id),
    nearMissIncidentCreatedGovernedDelta: incident.policyDelta?.promotionState === 'proposed'
      && incident.policyDelta?.ruleCandidate?.rule === 'near_miss_replay_requires_airspace_rule',
    laterManualRewriteLinkedToCounterfactualRun: (updatedChoiceSceneRun?.laterManualEdits || [])
      .some((edit) => edit.incidentId === incident.id && edit.path === 'app/generated/auth-client.ts'),
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
    choiceSceneRun,
    simulatorDelta,
    collisionForecast,
    incident,
    updatedChoiceSceneRun,
    leaseProject: { id: leaseProject.id, title: leaseProject.title },
    leaseMemoryRun,
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
