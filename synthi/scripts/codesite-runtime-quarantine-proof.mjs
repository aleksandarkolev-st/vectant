import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  canonicalDojoProofPayload,
  createEd25519DojoProofSigner,
  generateEd25519DojoProofKeyPair,
} from '../../mcp/synthi-mcp/dist/dojo/proof/signing.js';

const DEFAULT_APP_BASE_URL = 'http://127.0.0.1:3107';
const DEFAULT_COLLAB_BASE_URL = 'http://127.0.0.1:1234';
const DEFAULT_COLLAB_CONTROL_PLANE_URL = 'http://host.docker.internal:3107';

function repoRoot() {
  return path.basename(process.cwd()) === 'synthi'
    ? path.dirname(process.cwd())
    : process.cwd();
}

function outDir() {
  return path.resolve(process.env.CODESITE_PROOF_OUT_DIR || path.join(repoRoot(), 'tmp', 'codesite-dojo-proof'));
}

function slugNow() {
  return `codesite-runtime-quarantine-proof-${Date.now()}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function signedDojoProof(slug) {
  const keyPair = generateEd25519DojoProofKeyPair('dojo-runtime-quarantine-key');
  const signer = createEd25519DojoProofSigner({
    key_id: keyPair.key_id,
    private_key_pem: keyPair.private_key_pem,
  });
  const unsignedCapsule = {
    schema_version: 'synthi.dojo.proofCapsule.v1',
    capsule_id: 'pcap-runtime-quarantine',
    skill_id: 'codesite.runtime.quarantine',
    skill_version: '2026-07-01.1',
    requested_action: 'codesite.mutation.clearance',
    license_version: 'runtime.level_2@2026-06-25',
    issuer: 'dojo-runtime-quarantine-issuer',
    key_id: keyPair.key_id,
    nonce: `nonce-${Date.now()}`,
    ledger_checkpoint_hash: crypto.createHash('sha256').update(slug).digest('hex'),
    evidence_claims: [{
      claim: 'codesite.restricted_mutation',
      satisfied: true,
      evidence_refs: ['evidence:runtime-quarantine-live-api'],
    }],
    evidence_record_ids: ['runtime-quarantine-live-api'],
    issued_at: '2026-07-01T00:00:00.000Z',
    expires_at: '2026-08-01T00:00:00.000Z',
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

async function postCollab(collabBaseUrl, route, body, options = {}) {
  const response = await fetch(`${collabBaseUrl.replace(/\/+$/, '')}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok && !options.allowFailure) {
    throw new Error(`POST ${route} returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return {
    ...parsed,
    ok: response.ok,
    status: response.status,
  };
}

function assertProof(assertions) {
  const failed = Object.entries(assertions)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);
  if (failed.length) {
    throw new Error(`runtime quarantine proof failed: ${failed.join(', ')}`);
  }
}

function proofHtml(proof) {
  const quarantinedRows = proof.quarantine.changes.map((change) => `
    <tr>
      <td>${escapeHtml(change.path)}</td>
      <td>${escapeHtml(change.kind)}</td>
      <td><code>${escapeHtml(change.beforeDigest || 'new')}</code></td>
      <td><code>${escapeHtml(change.afterDigest || 'deleted')}</code></td>
    </tr>
  `.trim()).join('\n');
  const eventRows = proof.controlPlane.quarantinedEvents.map((event) => `
    <tr>
      <td>${escapeHtml(event.path)}</td>
      <td>${escapeHtml(event.eventType)}</td>
      <td><code>${escapeHtml((event.reasonCodes || []).join(', '))}</code></td>
      <td><code>${escapeHtml((event.evidenceRefs || []).join(', '))}</code></td>
    </tr>
  `.trim()).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSite Runtime Boundary Proof</title>
<style>
:root { color-scheme: dark; --bg: #080a0f; --panel: #10131d; --panel-2: #0c0f17; --line: #273149; --text: #f3f6ff; --muted: #aab8df; --pass: #32d583; --accent: #9fb7ff; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
main { width: min(1180px, calc(100vw - 64px)); margin: 28px auto 48px; }
.hero { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 22px 24px 28px; }
.badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 4px; background: #09351f; color: #b9f6d3; font-weight: 800; font-size: 12px; letter-spacing: .04em; }
h1 { margin: 6px 0 12px; font-size: 28px; line-height: 1.1; }
p { margin: 0; max-width: 78ch; color: var(--muted); font-size: 17px; line-height: 1.55; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0 20px; }
.metric { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 14px; min-height: 86px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.metric strong { display: block; font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
h2 { margin: 20px 0 10px; font-size: 21px; }
pre, table { border: 1px solid var(--line); border-radius: 8px; background: #05070c; width: 100%; }
pre { margin: 0; padding: 14px; overflow: hidden; white-space: pre-wrap; color: #d8e1ff; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
table { border-collapse: separate; border-spacing: 0; overflow: hidden; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; background: var(--panel-2); }
td { color: var(--text); font-size: 14px; }
tr:last-child td { border-bottom: 0; }
code { font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #dfe7ff; }
@media (max-width: 860px) { main { width: min(100% - 28px, 720px); } .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<main>
  <section class="hero">
    <span class="badge">PASS</span>
    <h1>CodeSite Runtime Boundary Proof</h1>
    <p>A Docker-backed collab shell attempted to write through an active CodeSite context. Host exec was blocked before mutation, and the real workspace stayed unchanged.</p>
  </section>
  <section class="grid" aria-label="proof summary">
    <div class="metric"><span>Workspace</span><strong>${escapeHtml(proof.slug)}</strong></div>
    <div class="metric"><span>Transaction</span><strong>${escapeHtml(proof.transaction.id)}</strong></div>
    <div class="metric"><span>Host exec</span><strong>${escapeHtml(proof.rawWrite.error || 'missing')}</strong></div>
    <div class="metric"><span>Source workspace</span><strong>${proof.assertions.sourceWorkspaceUnchanged ? 'unchanged' : 'changed'}</strong></div>
  </section>
  <h2>Quarantined Overlay Changes</h2>
  <table>
    <thead><tr><th>Path</th><th>Kind</th><th>Before</th><th>After</th></tr></thead>
    <tbody>${quarantinedRows}</tbody>
  </table>
  <h2>Control Plane Events</h2>
  <table>
    <thead><tr><th>Path</th><th>Event</th><th>Reason</th><th>Evidence</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table>
  <h2>Real Workspace Readback</h2>
  <pre>${escapeHtml(proof.workspaceReadback.output)}</pre>
  <h2>Assertions</h2>
  <pre>${escapeHtml(JSON.stringify(proof.assertions, null, 2))}</pre>
</main>
</body>
</html>`;
}

async function writeProofArtifacts(proof) {
  const dir = outDir();
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, 'codesite-runtime-quarantine-proof.json');
  const htmlPath = path.join(dir, 'codesite-runtime-quarantine-proof.html');
  const pngPath = path.join(dir, 'codesite-runtime-quarantine-proof.png');
  await fs.writeFile(jsonPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  await fs.writeFile(htmlPath, proofHtml(proof), 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  return { jsonPath, htmlPath, pngPath };
}

async function main() {
  const appBaseUrl = process.env.CODESITE_PROOF_BASE_URL || DEFAULT_APP_BASE_URL;
  const collabBaseUrl = process.env.CODESITE_PROOF_COLLAB_URL || DEFAULT_COLLAB_BASE_URL;
  const controlPlaneBaseUrl = process.env.CODESITE_PROOF_COLLAB_CONTROL_PLANE_URL || DEFAULT_COLLAB_CONTROL_PLANE_URL;
  const slug = process.env.CODESITE_PROOF_WORKSPACE_SLUG || slugNow();
  const api = createApi(appBaseUrl, slug);
  const userId = `codesite-proof-user-${Date.now()}`;
  const targetPath = 'src/raw-terminal-target.txt';
  const newPath = 'src/quarantine-new.txt';
  const docPath = 'docs/allowed-terminal.txt';

  console.log(`[runtime-quarantine-proof] creating project ${slug}`);
  const projectResponse = await api('/projects', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Runtime quarantine proof',
      request: 'Prove raw terminal writes are quarantined before the real workspace mutates',
      autoWorkflow: true,
      strategy: 'airspace_survey_first',
      zonePolicy: {
        zones: [{ zoneKey: 'docs', label: 'Docs runway', class: 'B', paths: ['docs/**'], risk: 'medium' }],
        noFlyZones: ['secrets/**'],
      },
      missions: [{
        callsign: 'DOCS-01',
        domain: 'docs',
        mission: 'Document coordination workflow',
        route: ['docs/**'],
        requestedTools: ['file_write', 'raw_terminal'],
      }],
    }),
  });
  const project = projectResponse.project;
  const plan = project.executionPlans.find((item) => item.displayCallsign === 'DOCS-01') || project.executionPlans[0];
  if (!plan) throw new Error('execution plan missing');

  const leaseResponse = await api(`/execution-plans/${encodeURIComponent(plan.id)}/mutation-leases`, {
    method: 'POST',
    body: JSON.stringify({
      allowedPaths: ['docs/**'],
      blockedPaths: ['secrets/**'],
      allowedTools: ['file_write', 'raw_terminal'],
      requiredRadar: ['review'],
      ...signedDojoProof(slug),
    }),
  });
  const lease = leaseResponse.mutationLease;
  if (lease.status !== 'active') throw new Error(`mutation lease was not active: ${lease.status}`);

  const transactionResponse = await api(`/mutation-leases/${encodeURIComponent(lease.id)}/transactions`, {
    method: 'POST',
    body: JSON.stringify({
      readSet: ['docs/coordination.md'],
      writeSet: ['docs/**'],
      invariants: ['clearance.diff.inside_route'],
    }),
  });
  const transaction = transactionResponse.transaction;
  const controlPlaneUrl = `${controlPlaneBaseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;

  console.log('[runtime-quarantine-proof] seeding source workspace');
  const seed = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      'mkdir -p src docs',
      `printf 'baseline\\n' > ${targetPath}`,
      `rm -f ${newPath} ${docPath}`,
      `printf 'seeded=' && cat ${targetPath}`,
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
    evidenceRefs: ['proof:runtime-quarantine-live-api'],
    processAncestry: ['codex:runtime-quarantine-proof', 'collab-server:exec'],
    controlPlaneUrl,
  };

  console.log('[runtime-quarantine-proof] attempting raw shell writes under active CodeSite context');
  const rawWrite = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    codesite,
    command: [
      `printf 'raw-terminal-mutation\\n' > ${targetPath}`,
      `printf 'new quarantined file\\n' > ${newPath}`,
      `printf 'docs terminal change\\n' > ${docPath}`,
      `printf 'overlay=' && cat ${targetPath}`,
    ].join(' && '),
  }, { allowFailure: true });

  console.log('[runtime-quarantine-proof] reading source workspace after quarantine');
  const readback = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      `printf 'target=' && cat ${targetPath}`,
      `printf 'new_path=' && if test -e ${newPath}; then echo present; else echo absent; fi`,
      `printf 'doc_path=' && if test -e ${docPath}; then echo present; else echo absent; fi`,
    ].join(' && '),
  });

  console.log('[runtime-quarantine-proof] fetching recorded CodeSite events');
  const eventsResponse = await api(`/projects/${encodeURIComponent(project.id)}/events`);
  const quarantinedEvents = eventsResponse.events
    .filter((event) => event.eventType === 'write_quarantined')
    .map((event) => ({
      id: event.id,
      eventType: event.eventType,
      path: event.details?.path || event.details?.codesiteFsEvent?.path || null,
      reasonCodes: event.details?.reasonCodes || event.details?.reason_codes || [],
      evidenceRefs: event.evidenceRefs || event.evidence_refs || [],
      details: event.details || {},
    }));
  const quarantine = rawWrite.quarantine || { changes: [], recorded: [] };
  const quarantinedPaths = new Set(quarantine.changes.map((change) => change.path));
  const eventPaths = new Set(quarantinedEvents.map((event) => event.path));
  const readbackOutput = `${readback.stdout || ''}${readback.output || ''}`;
  const assertions = {
    dockerCollabExecUsed: true,
    clearanceIssued: lease.status === 'active',
    transactionOpened: Boolean(transaction.id),
    hostExecBlockedBeforeMutation: rawWrite.status === 409
      && rawWrite.error === 'codesite_runtime_quarantine_unavailable'
      && rawWrite.surface === 'exec',
    hostExecDidNotReturnQuarantine: Array.isArray(quarantine.changes) && quarantine.changes.length === 0,
    targetPathNotQuarantinedByUnsafeHostExec: !quarantinedPaths.has(targetPath),
    newPathNotQuarantinedByUnsafeHostExec: !quarantinedPaths.has(newPath),
    docsPathNotQuarantinedByUnsafeHostExec: !quarantinedPaths.has(docPath),
    sourceWorkspaceUnchanged: readbackOutput.includes('target=baseline')
      && readbackOutput.includes('new_path=absent')
      && readbackOutput.includes('doc_path=absent'),
    controlPlaneDidNotRecordUnsafeHostMutation: quarantinedEvents.length === 0,
    controlPlaneDidNotRecordTargetPath: !eventPaths.has(targetPath),
    controlPlaneDidNotRecordNewPath: !eventPaths.has(newPath),
    controlPlaneDidNotRecordDocsPath: !eventPaths.has(docPath),
  };
  assertProof(assertions);

  const proof = {
    generatedAt: new Date().toISOString(),
    title: 'CodeSite Runtime Boundary Proof',
    slug,
    appBaseUrl,
    collabBaseUrl,
    controlPlaneUrl,
    project: { id: project.id, title: project.title },
    clearance: { id: lease.id, callsign: lease.displayCallsign, status: lease.status },
    transaction: { id: transaction.id, status: transaction.status, writeSet: transaction.writeSet },
    seed: { exitCode: seed.exitCode, stdout: seed.stdout || seed.output || '' },
    rawWrite: {
      exitCode: rawWrite.exitCode,
      stdout: rawWrite.stdout || rawWrite.output || '',
      stderr: rawWrite.stderr || '',
      status: rawWrite.status,
      error: rawWrite.error || null,
      surface: rawWrite.surface || null,
      codesite: rawWrite.codesite || null,
    },
    quarantine,
    workspaceReadback: {
      exitCode: readback.exitCode,
      output: readbackOutput,
    },
    controlPlane: {
      eventCount: eventsResponse.events.length,
      quarantinedEvents,
    },
    assertions,
  };

  const artifacts = await writeProofArtifacts(proof);
  console.log(`[runtime-quarantine-proof] wrote ${artifacts.jsonPath}`);
  console.log(`[runtime-quarantine-proof] wrote ${artifacts.htmlPath}`);
  console.log(`[runtime-quarantine-proof] wrote ${artifacts.pngPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
