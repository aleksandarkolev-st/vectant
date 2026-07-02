import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../mcp/synthi-mcp/dist/dojo/proof/signing.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function slugNow() {
  return `codesite-pilot-license-proof-${Date.now()}`;
}

function outDir(slug) {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'pilot-license-lifecycle', slug));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function signedDojoProof(slug, { capsuleId, licenseVersion, evidenceId }) {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-pilot-license-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: capsuleId,
    skill_id: 'codesite.schema',
    skill_version: '2026-07-01.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: licenseVersion,
    issuer: 'dojo-pilot-license-proof-issuer',
    key_id: keyPair.key_id,
    nonce: `nonce-${Date.now()}-${evidenceId}`,
    ledger_checkpoint_hash: crypto.createHash('sha256').update(`${slug}:${capsuleId}`).digest('hex'),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: [`evidence:${evidenceId}`],
    }],
    evidence_record_ids: [evidenceId],
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
    dojoRequiredEvidenceClaims: ['codesite.restricted_mutation'],
    implementationStatus: { executable: true, productionRuntime: false },
  };
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
  api.baseUrl = apiBase;
  return api;
}

function assertAll(assertions) {
  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) throw new Error(`pilot license proof failed: ${failed.join(', ')}`);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function screenshotLiveUi({ baseUrl, slug, dir }) {
  const browser = await chromium.launch({ headless: true });
  const desktop = path.join(dir, 'codesite-pilot-license-desktop.png');
  const panel = path.join(dir, 'codesite-pilot-license-panel.png');
  const mobile = path.join(dir, 'codesite-pilot-license-mobile.png');
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[browser:${message.type()}] ${message.text()}`);
    });
    await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    const health = page.getByTestId('codesite-pilot-license-health');
    await health.waitFor({ state: 'visible', timeout: 180000 });
    await health.getByText('STALE-IFR', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    await health.getByText('pilot_license_source_drift_expired', { exact: true }).first().waitFor({ state: 'visible', timeout: 60000 });
    await health.scrollIntoViewIfNeeded();
    await page.screenshot({ path: desktop, fullPage: true });
    await health.screenshot({ path: panel });

    await page.setViewportSize({ width: 390, height: 1100 });
    await page.goto(`${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(slug)}/codesite`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    const mobileHealth = page.getByTestId('codesite-pilot-license-health');
    await mobileHealth.waitFor({ state: 'visible', timeout: 180000 });
    await mobileHealth.getByText('STALE-IFR', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    await mobileHealth.scrollIntoViewIfNeeded();
    await page.screenshot({ path: mobile, fullPage: true });
  } finally {
    await browser.close();
  }
  return { desktop, panel, mobile };
}

function proofHtml(proof) {
  const imageRows = Object.entries(proof.visual).map(([label, file]) => `
    <section>
      <h2>${escapeHtml(label)}</h2>
      <img src="${escapeHtml(path.basename(file))}" alt="${escapeHtml(label)}">
    </section>
  `).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>CodeSite Pilot License Lifecycle Proof</title>
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
  <h1>CodeSite Pilot License Lifecycle Proof</h1>
  <p>Workspace <code>${escapeHtml(proof.slug)}</code>, project <code>${escapeHtml(proof.project.id)}</code>.</p>
  <table>
    <thead><tr><th>Callsign</th><th>Lease</th><th>Health</th><th>Reasons</th></tr></thead>
    <tbody>
      <tr>
        <td>ACTIVE-IFR</td>
        <td>${escapeHtml(proof.leases.active.status)}</td>
        <td>${escapeHtml(proof.health.active.status)} / ${escapeHtml(proof.health.active.level)}</td>
        <td>${escapeHtml(proof.health.active.reasonCodes.join(', '))}</td>
      </tr>
      <tr>
        <td>STALE-IFR</td>
        <td>${escapeHtml(proof.leases.stale.status)}</td>
        <td>${escapeHtml(proof.health.stale.status)} / ${escapeHtml(proof.health.stale.level)}</td>
        <td>${escapeHtml(proof.health.stale.reasonCodes.join(', '))}</td>
      </tr>
    </tbody>
  </table>
  ${imageRows}
</body>
</html>`;
}

async function main() {
  const baseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_BASE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const dir = outDir(slug);
  await fs.mkdir(dir, { recursive: true });
  const api = createApi(baseUrl, slug);
  const sourceDigest = {
    previous: 'sha256:pilot-license-source-v1',
    current: 'sha256:pilot-license-source-v2',
  };

  console.log(`[pilot-license-proof] creating project ${slug}`);
  const { project } = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Pilot license lifecycle proof',
      request: 'Prove active, drift-expired, and visually observable pilot-license lifecycle gates',
      repoPolicyCompiler: false,
      zonePolicy: {
        zones: [{ zoneKey: 'contracts', label: 'Contract runway', class: 'B', paths: ['packages/contracts/**'], risk: 'high' }],
        noFlyZones: ['secrets/**'],
        compiler: {
          sourceDigest: sourceDigest.current,
          policyDigest: 'sha256:pilot-license-policy-v2',
        },
      },
    }),
  });
  const currentSourceDigest = project.zonePolicy?.compiler?.sourceDigest || sourceDigest.current;

  const activeSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'ACTIVE-IFR',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      dojoPilotLicenseRef: 'schema.level_2@2026-07-01',
      dojoProofRef: 'proof:active-ifr',
      dojoEvidenceRefs: ['dojo:evidence:active-checkride'],
      dojoDecisionDigest: 'sha256:active-license-decision',
      pilotLicenseSnapshot: {
        level: 2,
        repoScope: slug,
        authorizedAirspace: ['packages/contracts/**'],
        requiredRadar: ['api_contract', 'security', 'tests'],
        earnedBy: ['dojo:evidence:active-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: currentSourceDigest,
      },
    }),
  })).agentSession;
  const staleSession = (await api(`/projects/${encodeURIComponent(project.id)}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'STALE-IFR',
      agentProvider: 'codex',
      agentRuntime: 'tmp-codex-cli',
      dojoPilotLicenseRef: 'schema.level_2@2026-07-01',
      dojoProofRef: 'proof:stale-ifr',
      dojoEvidenceRefs: ['dojo:evidence:stale-checkride'],
      dojoDecisionDigest: 'sha256:stale-license-decision',
      pilotLicenseSnapshot: {
        level: 2,
        repoScope: slug,
        authorizedAirspace: ['packages/contracts/**'],
        requiredRadar: ['api_contract', 'security', 'tests'],
        earnedBy: ['dojo:evidence:stale-checkride'],
        expiresOn: ['source_drift'],
        sourceDigest: sourceDigest.previous,
      },
    }),
  })).agentSession;

  const activePlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: activeSession.id,
      displayCallsign: 'ACTIVE-IFR',
      mission: 'Land contract schema change with current pilot license',
      domain: 'schema',
      route: ['packages/contracts/**'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;
  const stalePlan = (await api(`/projects/${encodeURIComponent(project.id)}/execution-plans`, {
    method: 'POST',
    body: JSON.stringify({
      agentSessionId: staleSession.id,
      displayCallsign: 'STALE-IFR',
      mission: 'Attempt contract schema change with source-drift-expired license',
      domain: 'schema',
      route: ['packages/contracts/**'],
      requestedTools: ['file_write'],
    }),
  })).executionPlan;

  console.log('[pilot-license-proof] requesting active and source-drift clearances');
  const activeLease = (await api(`/execution-plans/${encodeURIComponent(activePlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['packages/contracts/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['api_contract', 'security', 'tests'],
      ...signedDojoProof(slug, {
        capsuleId: 'pcap-active-ifr',
        licenseVersion: 'schema.level_2@2026-07-01',
        evidenceId: 'active-ifr-checkride',
      }),
    }),
  })).mutationLease;
  const staleLease = (await api(`/execution-plans/${encodeURIComponent(stalePlan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['packages/contracts/**'],
      allowedTools: ['file_write'],
      requiredRadar: ['api_contract', 'security', 'tests'],
      ...signedDojoProof(slug, {
        capsuleId: 'pcap-stale-ifr',
        licenseVersion: 'schema.level_2@2026-07-01',
        evidenceId: 'stale-ifr-checkride',
      }),
    }),
  })).mutationLease;

  for (let index = 1; index <= 3; index += 1) {
    await api(`/projects/${encodeURIComponent(project.id)}/inspection-runs`, {
      method: 'POST',
      body: JSON.stringify({
        executionPlanId: activePlan.id,
        displayCallsign: 'ACTIVE-IFR',
        status: 'passed',
        changedPaths: ['packages/contracts/schema.ts'],
        inspectionSignals: [{ key: 'tests', status: 'passed', evidenceRefs: [`test:active-license:${index}`] }],
        evidenceRefs: [`inspection:active-license:${index}`],
      }),
    });
  }

  const deniedWrite = await api(`/projects/${encodeURIComponent(project.id)}/codesitefs-events`, {
    method: 'POST',
    body: JSON.stringify({
      displayCallsign: 'STALE-IFR',
      path: 'secrets/prod.env',
      tool: 'file_write',
      source: 'codesitefs',
      evidenceRefs: ['codesite:pipeline-proof:no-fly-denial'],
      details: {
        workflow: 'pilot_license_lifecycle',
        expectedDisposition: 'write_denied',
      },
    }),
  });
  const exportResult = await api(`/projects/${encodeURIComponent(project.id)}/artifacts/export`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const pilotHealthArtifactRel = `projects/${project.id}/pilot-license-health.json`;
  const pilotHealthArtifactPath = exportResult.root
    ? path.join(exportResult.root, pilotHealthArtifactRel)
    : null;
  const durablePilotHealth = pilotHealthArtifactPath && await fileExists(pilotHealthArtifactPath)
    ? await readJsonFile(pilotHealthArtifactPath)
    : null;

  const [projectAfter, controlState, metricsResponse, eventsResponse, artifactPreview] = await Promise.all([
    api(`/projects/${encodeURIComponent(project.id)}`),
    api(`/projects/${encodeURIComponent(project.id)}/control-state`),
    api(`/projects/${encodeURIComponent(project.id)}/metrics`),
    api(`/projects/${encodeURIComponent(project.id)}/events`),
    api(`/projects/${encodeURIComponent(project.id)}/artifacts/preview?include=content&maxContentBytes=131072`),
  ]);
  const healthRecords = controlState.pilotLicenseHealth || [];
  const activeHealth = healthRecords.find((record) => record.displayCallsign === 'ACTIVE-IFR') || {};
  const staleHealth = healthRecords.find((record) => record.displayCallsign === 'STALE-IFR') || {};
  const metrics = metricsResponse.metrics || {};
  const trustRows = metrics.sections?.trust || [];
  const pilotMetric = trustRows.find((row) => row.key === 'pilotLicenseViolationRate') || {};
  const artifactPaths = (artifactPreview.files || []).map((file) => file.path);
  const healthArtifact = artifactPreview.files.find((file) => file.path.endsWith('/pilot-license-health.json')) || null;

  console.log('[pilot-license-proof] capturing live UI screenshots');
  const screenshots = await screenshotLiveUi({ baseUrl, slug, dir });

  const proof = {
    schemaVersion: 'synthi.codesite.pilotLicenseProof.v1',
    slug,
    baseUrl,
    project: projectAfter.project,
    leases: { active: activeLease, stale: staleLease },
    health: { active: activeHealth, stale: staleHealth },
    metrics: { pilotLicenseViolationRate: pilotMetric },
    controlState: {
      towerState: controlState.towerState,
      requiredActions: controlState.requiredActions,
      pilotLicenseSummary: controlState.pilotLicenseSummary,
    },
    artifacts: {
      paths: artifactPaths,
      pilotLicenseHealthPreview: healthArtifact?.contentPreview || null,
      export: {
        written: exportResult.written === true,
        root: exportResult.root || null,
        files: exportResult.files || [],
        pilotLicenseHealthPath: pilotHealthArtifactPath
          ? path.relative(repoRoot(), pilotHealthArtifactPath).replaceAll(path.sep, '/')
          : null,
        pilotLicenseHealth: durablePilotHealth,
      },
    },
    codesiteFs: {
      deniedWrite,
      repoMutated: await fileExists(path.join(repoRoot(), 'secrets', 'prod.env')),
    },
    events: (eventsResponse.events || []).map((event) => ({
      id: event.id,
      eventType: event.eventType,
      displayCallsign: event.displayCallsign,
      reasonCodes: event.details?.reasonCodes || [],
    })),
    visual: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, path.relative(dir, file).replaceAll(path.sep, '/')])),
    generatedAt: new Date().toISOString(),
  };
  const assertions = {
    activeLeaseIssued: activeLease.status === 'active',
    staleLeaseBlocked: staleLease.status === 'blocked',
    activeHealthActive: activeHealth.status === 'active' && activeHealth.level === 'IFR',
    activeHealthEarnedPrivilege: (activeHealth.reasonCodes || []).includes('pilot_license_privileges_earned_by_landings'),
    staleHealthExpired: staleHealth.status === 'expired',
    staleSourceDriftExpired: staleHealth.sourceDrift?.expired === true,
    staleReasonRecorded: (staleHealth.reasonCodes || []).includes('pilot_license_source_drift_expired'),
    requiredActionQueued: (controlState.requiredActions || []).some((action) => String(action).includes('renew_pilot_license_source')),
    metricMeasured: pilotMetric.status === 'measured' && Number(pilotMetric.value) === 0.6667,
    metricBoundedByClearanceAttempts: pilotMetric.detail?.numerator === 2 && pilotMetric.detail?.denominator === 3,
    artifactProjected: artifactPaths.some((file) => file.endsWith('/pilot-license-health.json')),
    durableArtifactProjected: exportResult.written === true
      && (exportResult.files || []).includes(pilotHealthArtifactRel)
      && durablePilotHealth?.summary?.statusCounts?.active === 1
      && durablePilotHealth?.summary?.statusCounts?.expired === 1,
    noFlyWriteDeniedBeforeMutation: deniedWrite.ok === false
      && deniedWrite.disposition === 'write_denied'
      && (deniedWrite.reasonCodes || []).some((code) => ['entered_no_fly_zone', 'active_clearance_required'].includes(code))
      && proof.codesiteFs.repoMutated === false,
    uiScreenshotsCaptured: Object.values(screenshots).every(Boolean),
  };
  proof.assertions = assertions;

  const jsonPath = path.join(dir, 'codesite-pilot-license-proof.json');
  const htmlPath = path.join(dir, 'codesite-pilot-license-proof.html');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.writeFile(htmlPath, proofHtml({
    ...proof,
    visual: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, file])),
  }), 'utf8');
  assertAll(assertions);

  console.log(JSON.stringify({
    ok: true,
    slug,
    proof: path.relative(repoRoot(), jsonPath).replaceAll(path.sep, '/'),
    html: path.relative(repoRoot(), htmlPath).replaceAll(path.sep, '/'),
    screenshots: Object.fromEntries(Object.entries(screenshots).map(([key, file]) => [key, path.relative(repoRoot(), file).replaceAll(path.sep, '/')])),
    assertions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
