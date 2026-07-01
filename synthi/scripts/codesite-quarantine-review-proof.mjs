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
const DEFAULT_COLLAB_BASE_URL = 'http://127.0.0.1:2234';
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
  const userId = `codesite-quarantine-review-user-${Date.now()}`;
  const targetPath = 'docs/review.md';
  const unselectedPath = 'docs/notes.md';
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
      `rm -f ${unselectedPath} ${outsidePath} ${escapePath}`,
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
      `printf 'unselected quarantined note\\n' > ${unselectedPath}`,
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
      `printf 'notes=' && if test -e ${unselectedPath}; then echo present; else echo absent; fi`,
      `printf 'outside=' && if test -e ${outsidePath}; then echo present; else echo absent; fi`,
      `printf 'escape_link=' && if test -L ${escapePath}; then echo symlink; else echo missing; fi`,
      `printf 'escape_target=' && cat ${escapeTarget}`,
    ].join(' && '),
  });
  const beforeOutput = beforeApply.stdout || beforeApply.output || '';

  console.log('[quarantine-review-proof] listing and replaying durable manifest');
  const listResponse = await getCollab(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}?userId=${encodeURIComponent(userId)}&filesystemUserId=${encodeURIComponent(userId)}&transactionId=${encodeURIComponent(transaction.id)}`,
  );
  const manifestResponse = await getCollab(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}?userId=${encodeURIComponent(userId)}&filesystemUserId=${encodeURIComponent(userId)}`,
  );
  const replay = await postCollab(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}/replay`,
    {
      userId,
      filesystemUserId: userId,
      paths: [targetPath],
      codesite,
    },
  );

  console.log('[quarantine-review-proof] applying only the reviewed target path');
  const apply = await postCollab(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}/apply`,
    {
      userId,
      filesystemUserId: userId,
      paths: [targetPath],
      codesite,
    },
  );

  const afterApply = await postCollab(collabBaseUrl, `/exec/${encodeURIComponent(slug)}`, {
    userId,
    filesystemUserId: userId,
    timeout: 20000,
    command: [
      `printf 'target=' && cat ${targetPath}`,
      `printf 'notes=' && if test -e ${unselectedPath}; then echo present; else echo absent; fi`,
      `printf 'outside=' && if test -e ${outsidePath}; then echo present; else echo absent; fi`,
      `printf 'escape_link=' && if test -L ${escapePath}; then echo symlink; else echo missing; fi`,
      `printf 'escape_target=' && cat ${escapeTarget}`,
    ].join(' && '),
  });
  const afterOutput = afterApply.stdout || afterApply.output || '';

  console.log('[quarantine-review-proof] proving stale replay is rejected after apply');
  const staleReplay = await collabRequest(
    collabBaseUrl,
    `/codesitefs/quarantines/${encodeURIComponent(slug)}/${encodeURIComponent(quarantineId)}/replay`,
    {
      method: 'POST',
      body: JSON.stringify({
        userId,
        filesystemUserId: userId,
        paths: [targetPath],
        codesite,
      }),
    },
  );

  const transactionAfter = await api(`/transactions/${encodeURIComponent(transaction.id)}`);
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

  const assertions = {
    dockerCollabExecUsed: true,
    clearanceIssued: lease.status === 'active',
    transactionOpened: Boolean(transaction.id),
    rawTerminalSucceeded: rawWrite.exitCode === 0,
    stableQuarantineIdReturned: /^qtn-/.test(quarantineId),
    rawQuarantineCapturedAllPaths: quarantinedPaths.has(targetPath)
      && quarantinedPaths.has(unselectedPath)
      && quarantinedPaths.has(outsidePath)
      && quarantinedPaths.has(escapePath),
    realWorkspaceUnchangedBeforeApply: beforeOutput.includes('target=baseline')
      && beforeOutput.includes('notes=absent')
      && beforeOutput.includes('outside=absent')
      && beforeOutput.includes('escape_link=symlink')
      && beforeOutput.includes('escape_target=outside-before'),
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
    replayDryRunSelectedOnly: replay.ok === true
      && replay.replay.length === 1
      && replay.replay[0].path === targetPath,
    applySelectedOnly: apply.ok === true
      && apply.applied.length === 1
      && apply.applied[0].path === targetPath,
    realWorkspaceAppliedOnlyTarget: afterOutput.includes('target=baseline\nreviewed through quarantine')
      && afterOutput.includes('notes=absent')
      && afterOutput.includes('outside=absent')
      && afterOutput.includes('escape_link=symlink')
      && afterOutput.includes('escape_target=outside-before'),
    staleReplayRejectedAfterApply: staleReplay.status === 409
      && staleReplay.body?.rejected?.some((item) => item.reasonCodes?.includes('quarantine_replay_base_mismatch')),
    controlPlaneRecordedQuarantine: eventTypes.filter((type) => type === 'write_quarantined').length >= 4,
    controlPlaneRecordedReview: eventTypes.includes('quarantine_reviewed'),
    controlPlaneRecordedReplay: eventTypes.includes('quarantine_replayed'),
    controlPlaneRecordedApply: eventTypes.includes('quarantine_applied'),
    controlPlaneRecordedWriteAllowed: relevantEvents.some((event) => event.eventType === 'write_allowed' && event.path === targetPath),
    transactionObservedSelectedWrite: transactionAfter.transaction?.observedWriteSet?.includes(targetPath),
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
    workspaceReadback: {
      beforeApply: { exitCode: beforeApply.exitCode, output: beforeOutput },
      afterApply: { exitCode: afterApply.exitCode, output: afterOutput },
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
