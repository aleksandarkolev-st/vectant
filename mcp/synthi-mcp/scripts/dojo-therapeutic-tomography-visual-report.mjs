#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateProductionTherapeuticTomographyEvidence } from "./dojo-therapeutic-tomography-release-evidence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(MCP_ROOT, "..", "..");
const DEFAULT_EVIDENCE_PATH = resolve(REPO_ROOT, "docs", "THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE.json");
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, "tmp", "therapeutic-tomography-visual-proof");

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    const result = await runTherapeuticTomographyVisualReportSelfCheck({ outDir: args.outDir || DEFAULT_OUT_DIR });
    console.log(`[ok] Therapeutic tomography visual report self-check passed - html=${result.html_path} manifest=${result.manifest_path}`);
    return;
  }
  const result = await generateTherapeuticTomographyVisualReport({
    evidencePath: args.evidence || DEFAULT_EVIDENCE_PATH,
    outDir: args.outDir || DEFAULT_OUT_DIR,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function generateTherapeuticTomographyVisualReport({
  evidencePath = DEFAULT_EVIDENCE_PATH,
  outDir = DEFAULT_OUT_DIR,
} = {}) {
  const resolvedEvidencePath = resolveRepoPath(evidencePath);
  const resolvedOutDir = resolveRepoPath(outDir);
  const evidenceText = await readFile(resolvedEvidencePath, "utf8");
  const artifact = JSON.parse(evidenceText);
  const validation = validateProductionTherapeuticTomographyEvidence(artifact);
  if (!validation.ok) {
    throw new Error(`therapeutic_tomography_visual_report_invalid_production_evidence:${validation.errors.join(",")}`);
  }

  const evidenceSha256 = sha256(evidenceText);
  const html = buildTherapeuticTomographyVisualReportHtml({
    artifact,
    evidencePath: resolvedEvidencePath,
    evidenceSha256,
  });
  const htmlPath = resolve(resolvedOutDir, "therapeutic-tomography-production-proof.html");
  const manifestPath = resolve(resolvedOutDir, "therapeutic-tomography-production-proof.manifest.json");
  const manifest = {
    schema_version: "synthi.dojo.therapeuticTomographyVisualProof.v1",
    generated_at: new Date().toISOString(),
    source_evidence_path: resolvedEvidencePath,
    source_evidence_sha256: evidenceSha256,
    source_evidence_schema_version: artifact.schema_version,
    html_path: htmlPath,
    html_sha256: sha256(html),
    production_evidence_validated: true,
    hosted_runtime_url: artifact.hosted_runtime.url,
    probe_endpoint_url: artifact.deployed_probe_adapter.endpoint_url,
    durable_store_readback_url: artifact.production_durable_store.readback_url,
    signing_provider: artifact.proof_signing.signing_provider,
  };

  await mkdir(resolvedOutDir, { recursive: true });
  await writeFile(htmlPath, html, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    ok: true,
    html_path: htmlPath,
    manifest_path: manifestPath,
    evidence_sha256: evidenceSha256,
    html_sha256: manifest.html_sha256,
  };
}

export function buildTherapeuticTomographyVisualReportHtml({ artifact, evidencePath, evidenceSha256 }) {
  const probeRows = artifact.deployed_probe_adapter.http_observations
    .map((observation) => row([
      observation.probe_name,
      observation.status,
      observation.url,
      shortHash(observation.request_body_sha256),
      shortHash(observation.response_body_sha256),
    ])).join("\n");
  const safetyRows = Object.entries(artifact.safety_assertions)
    .map(([key, value]) => row([key, String(value)])).join("\n");
  const roleList = artifact.tenant_scope.roles.map((role) => `<li>${escapeHtml(role)}</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Therapeutic Tomography Production Proof</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2933;
      --muted: #52616b;
      --line: #d8dee4;
      --paper: #f7f9fb;
      --panel: #ffffff;
      --ok: #0f766e;
      --warn: #9a3412;
      --accent: #334155;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--paper);
      color: var(--ink);
      letter-spacing: 0;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 40px 28px 52px; }
    header { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 28px; align-items: end; margin-bottom: 28px; }
    h1 { font-size: 42px; line-height: 1.05; margin: 0 0 14px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 0 0 14px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.55; }
    .stamp {
      border: 1px solid var(--ok);
      color: var(--ok);
      padding: 14px 16px;
      font-weight: 700;
      text-transform: uppercase;
      text-align: center;
      background: #f0fdfa;
    }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 20px 0; }
    .panel { background: var(--panel); border: 1px solid var(--line); padding: 18px; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 700; margin-bottom: 6px; }
    .value { font-size: 15px; overflow-wrap: anywhere; line-height: 1.45; }
    .value strong { color: var(--accent); }
    ol.steps { counter-reset: step; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; list-style: none; padding: 0; margin: 0; }
    ol.steps li { border: 1px solid var(--line); background: #fff; padding: 14px; min-height: 112px; }
    ol.steps li::before { counter-increment: step; content: counter(step); display: inline-grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--ok); color: var(--ok); margin-bottom: 10px; font-size: 12px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); text-align: left; padding: 10px 8px; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    ul { margin: 0; padding-left: 18px; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .footer { margin-top: 20px; color: var(--muted); font-size: 12px; }
    @media (max-width: 860px) {
      main { padding: 24px 16px 36px; }
      header, .grid, ol.steps { grid-template-columns: 1fr; }
      h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Therapeutic Tomography Production Proof</h1>
        <p>This visual report is generated only after strict v2 production evidence validation passes. It is a readable proof sheet for the signed JSON artifact, not a replacement for the artifact.</p>
      </div>
      <div class="stamp">validated production evidence</div>
    </header>

    <section class="grid">
      ${metric("Evidence", evidencePath)}
      ${metric("Evidence SHA-256", evidenceSha256)}
      ${metric("Generated", artifact.generated_at)}
      ${metric("Hosted Runtime", artifact.hosted_runtime.url)}
      ${metric("Runtime Session", artifact.hosted_runtime.session_id)}
      ${metric("Probe Endpoint", artifact.deployed_probe_adapter.endpoint_url)}
      ${metric("Durable Readback", artifact.production_durable_store.readback_url)}
      ${metric("Signer", `${artifact.proof_signing.signing_provider} / ${artifact.proof_signing.key_custody}`)}
      ${metric("Signature", artifact.proof_signing.signature_verified ? "verified ed25519" : "not verified")}
    </section>

    <section class="panel wide">
      <h2>Authorization Path</h2>
      <ol class="steps">
        <li><div class="label">Bypass Before Grant</div><div class="value">${escapeHtml(artifact.authorization_path.unauthorized_bypass_decision)}</div></li>
        <li><div class="label">Brokered Grant</div><div class="value">${escapeHtml(artifact.authorization_path.access_decision)}<br><code>${escapeHtml(artifact.authorization_path.grant_id || "")}</code></div></li>
        <li><div class="label">Active Dispatch</div><div class="value">${escapeHtml(artifact.authorization_path.protected_dispatch_decision)}</div></li>
        <li><div class="label">After Revocation</div><div class="value">${escapeHtml(artifact.authorization_path.post_revocation_dispatch_decision)}</div></li>
      </ol>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>Tenant and RBAC</h2>
        <div class="label">Tenant</div><div class="value">${escapeHtml(artifact.tenant_scope.tenant_id)}</div>
        <div class="label">Workspace</div><div class="value">${escapeHtml(artifact.tenant_scope.workspace_id)}</div>
        <div class="label">Actor</div><div class="value">${escapeHtml(artifact.tenant_scope.actor_id)}</div>
        <div class="label">Roles</div><ul>${roleList}</ul>
      </div>
      <div class="panel">
        <h2>Durable Store</h2>
        <div class="label">Record</div><div class="value">${escapeHtml(artifact.production_durable_store.record_id)}</div>
        <div class="label">State Hash</div><div class="value">${escapeHtml(artifact.production_durable_store.state_sha256)}</div>
        <div class="label">Reconstruction</div><div class="value">${artifact.production_durable_store.reconstruction_verified ? "verified" : "failed"}</div>
      </div>
      <div class="panel">
        <h2>Runtime Fingerprints</h2>
        <div class="label">Headers</div><div class="value">${escapeHtml(artifact.hosted_runtime.response_headers_sha256)}</div>
        <div class="label">Body</div><div class="value">${escapeHtml(artifact.hosted_runtime.response_body_sha256)}</div>
      </div>
    </section>

    <section class="panel wide">
      <h2>HTTPS Probe Evidence</h2>
      <table>
        <thead><tr><th>Probe</th><th>Status</th><th>URL</th><th>Request Hash</th><th>Response Hash</th></tr></thead>
        <tbody>${probeRows}</tbody>
      </table>
    </section>

    <section class="panel wide">
      <h2>Safety Assertions</h2>
      <table>
        <thead><tr><th>Assertion</th><th>Value</th></tr></thead>
        <tbody>${safetyRows}</tbody>
      </table>
    </section>
    <p class="footer">Render target: browser screenshot or PDF capture of this HTML can be archived under the release evidence directory after the JSON evidence is produced by the production run.</p>
  </main>
</body>
</html>
`;
}

export async function runTherapeuticTomographyVisualReportSelfCheck({ outDir = DEFAULT_OUT_DIR } = {}) {
  const resolvedOutDir = resolve(outDir);
  const evidencePath = resolve(resolvedOutDir, "fixture-production-evidence.json");
  const invalidPath = resolve(resolvedOutDir, "fixture-invalid-evidence.json");
  await mkdir(resolvedOutDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(productionFixtureArtifact(), null, 2)}\n`, "utf8");
  await writeFile(invalidPath, `${JSON.stringify({
    schema_version: "synthi.dojo.therapeuticTomographyReleaseEvidence.v1",
    hosted_runtime: { url: "https://runtime.example.test/session/demo", authorized: true },
  }, null, 2)}\n`, "utf8");

  await expectRejects(
    () => generateTherapeuticTomographyVisualReport({
      evidencePath: invalidPath,
      outDir: resolve(resolvedOutDir, "invalid"),
    }),
    "therapeutic_tomography_visual_report_invalid_production_evidence"
  );

  const result = await generateTherapeuticTomographyVisualReport({ evidencePath, outDir: resolvedOutDir });
  const html = await readFile(result.html_path, "utf8");
  if (!html.includes("Validated production evidence") && !html.includes("validated production evidence")) {
    throw new Error("therapeutic_tomography_visual_report_self_check_missing_validation_stamp");
  }
  if (html.includes("<script")) {
    throw new Error("therapeutic_tomography_visual_report_self_check_script_tag_forbidden");
  }
  return result;
}

function metric(label, value) {
  return `<div class="panel"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function row(values) {
  return `<tr>${values.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`;
}

function shortHash(value) {
  const text = String(value ?? "");
  return text.length > 16 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function expectRejects(fn, messageFragment) {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(messageFragment)) throw err;
    return;
  }
  throw new Error(`expected_rejection_missing:${messageFragment}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-check") args.selfCheck = true;
    else if (arg === "--evidence") args.evidence = argv[++index];
    else if (arg.startsWith("--evidence=")) args.evidence = arg.slice("--evidence=".length);
    else if (arg === "--out-dir") args.outDir = argv[++index];
    else if (arg.startsWith("--out-dir=")) args.outDir = arg.slice("--out-dir=".length);
    else if (!arg.startsWith("--") && !args.evidence) args.evidence = arg;
    else if (!arg.startsWith("--") && !args.outDir) args.outDir = arg;
    else throw new Error(`unknown_arg:${arg}`);
  }
  return args;
}

function resolveRepoPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return REPO_ROOT;
  return isAbsolute(text) ? resolve(text) : resolve(REPO_ROOT, text);
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function productionFixtureArtifact() {
  return {
    schema_version: "synthi.dojo.therapeuticTomographyReleaseEvidence.v2",
    generated_at: "2026-07-01T00:00:00.000Z",
    scope: "production deployed therapeutic tomography release evidence",
    hosted_runtime: {
      authorized: true,
      session_id: "session-prod-001",
      url: "https://runtime.prod.synthi.ai/session/session-prod-001",
      loopback: false,
      authorization_observed_at: "2026-07-01T00:00:00.000Z",
      status: 200,
      response_headers_sha256: "a".repeat(64),
      response_body_sha256: "b".repeat(64),
      authorization_context: {
        session_id: "session-prod-001",
        tenant_id: "tenant-prod-001",
        organization_id: "org-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "agent-prod-001",
        roles: ["incident_commander", "therapeutic_proof_broker"],
        source: "hosted_runtime_authorization_response",
      },
    },
    tenant_scope: {
      tenant_id: "tenant-prod-001",
      organization_id: "org-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      roles: ["incident_commander", "therapeutic_proof_broker"],
      source: "production_runtime_authorization",
    },
    task_id: "production_incident_response_001",
    deployed_probe_adapter: {
      kind: "https_probe_adapter",
      endpoint_url: "https://probe.prod.synthi.ai/therapeutic/incident-response",
      loopback: false,
      transport: "fetch",
      probes_completed: ["service_health_rollup", "blast_radius_summary"],
      evidence_refs: ["evidence:probe-1", "evidence:probe-2"],
      http_observations: [
        {
          probe_name: "service_health_rollup",
          url: "https://probe.prod.synthi.ai/therapeutic/incident-response",
          status: 200,
          request_body_sha256: "1".repeat(64),
          response_body_sha256: "2".repeat(64),
          observed_at: "2026-07-01T00:00:00.000Z",
        },
        {
          probe_name: "blast_radius_summary",
          url: "https://probe.prod.synthi.ai/therapeutic/incident-response",
          status: 200,
          request_body_sha256: "3".repeat(64),
          response_body_sha256: "4".repeat(64),
          observed_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    },
    production_durable_store: {
      kind: "external_control_plane",
      endpoint_url: "https://control.prod.synthi.ai/therapeutic/runtime-state",
      readback_url: "https://control.prod.synthi.ai/therapeutic/runtime-state/record-prod-001",
      record_id: "record-prod-001",
      state_sha256: "5".repeat(64),
      persisted_at: "2026-07-01T00:00:00.000Z",
      append_status: 201,
      append_response_body_sha256: "6".repeat(64),
      read_status: 200,
      read_response_body_sha256: "7".repeat(64),
      evidence_records: 8,
      audit_records: 7,
      grant_records: 1,
      proof_decision_records: 2,
      checkride_reports: 0,
      policy_learning_records: 0,
      reconstructed_evidence_records: 8,
      reconstructed_audit_records: 7,
      reconstruction_verified: true,
    },
    proof_signing: {
      signature_algorithm: "ed25519",
      signature_key_id: "therapeutic-prod-key",
      signing_provider: "managed-key-service",
      key_custody: "managed",
      signature_verified: true,
      verification_blocked_by: [],
      external_signing_path: {
        provider: "managed-key-service",
        key_uri: "gcp-kms://projects/prod/locations/global/keyRings/dojo/cryptoKeys/therapeutic",
        command_redacted: true,
        args_redacted: true,
      },
    },
    authorization_path: {
      unauthorized_bypass_decision: "denied",
      unauthorized_bypass_blocked_by: ["broker_required", "active_scoped_grant_missing"],
      access_decision: "approved",
      grant_id: "grant-prod-001",
      protected_dispatch_decision: "approved",
      post_revocation_dispatch_decision: "denied",
      post_revocation_dispatch_blocked_by: ["broker_required", "active_scoped_grant_missing"],
      revoked_grants: [{ grant_id: "grant-prod-001", status: "revoked", revocation_status: "success" }],
    },
    safety_assertions: {
      narrative_only_access_decision: "denied",
      narrative_only_blocked_by: ["narrative_only_proof"],
      narrative_only_grants_broader_access: false,
      diagnostic_proof_authorized_mutation: false,
      unauthorized_protected_tool_bypass: "blocked",
      broad_access_granted: false,
      raw_logs_granted: false,
      model_weights_granted: false,
      admin_privileges_granted: false,
      full_db_access_granted: false,
    },
  };
}
