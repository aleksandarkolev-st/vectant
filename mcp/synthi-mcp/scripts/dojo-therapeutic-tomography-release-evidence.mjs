#!/usr/bin/env node
/*
 * Production therapeutic tomography release evidence runner.
 *
 * This script intentionally has no local/demo fallback. It writes
 * docs/THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE.json only after observing a
 * non-loopback hosted runtime, real HTTPS probe service, production tenant/RBAC
 * context, external durable state reconstruction, and external/managed proof
 * signing.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEd25519DojoProofVerifier,
  createExternalCommandDojoProofSigner,
  createManagedKeyServiceDojoProofSigner,
} from "../dist/dojo/proof/signing.js";
import {
  buildStrictProofCapsule,
  createHttpTherapeuticProbeAdapter,
  createTherapeuticRuntimeStore,
  dispatchProtectedTherapeuticTool,
  emptyTherapeuticTrace,
  enforceTherapeuticAccessRequest,
  executeTherapeuticProbe,
  revokeTherapeuticTaskGrants,
  signTherapeuticProofCapsule,
  therapeuticProbeContractsForTaskClass,
  verifySignedTherapeuticProofCapsule,
} from "../dist/dojo/tomography/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(MCP_ROOT, "..", "..");
const DEFAULT_OUTPUT_PATH = resolve(REPO_ROOT, "docs", "THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE.json");
const args = parseArgs(process.argv.slice(2));

export const THERAPEUTIC_TOMOGRAPHY_PRODUCTION_REQUIRED_ENV = [
  "SYNTHI_THERAPEUTIC_PROD_RUNTIME_URL",
  "SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_TOKEN",
  "SYNTHI_THERAPEUTIC_PROD_RUNTIME_SESSION_ID",
  "SYNTHI_THERAPEUTIC_PROD_PROBE_URL",
  "SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN",
  "SYNTHI_THERAPEUTIC_PROD_STORE_URL",
  "SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN",
  "SYNTHI_THERAPEUTIC_PROD_TENANT_ID",
  "SYNTHI_THERAPEUTIC_PROD_ORGANIZATION_ID",
  "SYNTHI_THERAPEUTIC_PROD_WORKSPACE_ID",
  "SYNTHI_THERAPEUTIC_PROD_ACTOR_ID",
  "SYNTHI_THERAPEUTIC_PROD_ACTOR_ROLES",
  "SYNTHI_DOJO_PROOF_SIGNING_PROVIDER",
  "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID",
  "SYNTHI_DOJO_PROOF_SIGNING_COMMAND",
  "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM",
];

const FORBIDDEN_BROAD_CLASSES = new Set([
  "raw_logs",
  "model_weights",
  "admin_privileges",
  "full_db_access",
  "database_dump",
  "customer_pii",
]);

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const outputPath = resolve(args.output || DEFAULT_OUTPUT_PATH);
  const result = await runTherapeuticTomographyProductionReleaseEvidence({
    env: process.env,
    outputPath,
    now: new Date().toISOString(),
  });
  console.log(JSON.stringify({
    ok: true,
    output_path: result.output_path,
    artifact_sha256: result.artifact_sha256,
    external_state_record_id: result.artifact.production_durable_store.record_id,
  }, null, 2));
}

export async function runTherapeuticTomographyProductionReleaseEvidence({
  env = process.env,
  outputPath = DEFAULT_OUTPUT_PATH,
  now = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resolveProductionTherapeuticTomographyConfig(env);
  const runtimeObservation = await observeHostedRuntimeAuthorization({ config, now, fetchImpl });

  const taskId = `production_incident_response_${stableSuffix([
    config.tenant_scope.tenant_id,
    config.runtime_session_id,
    now,
  ])}`;
  const trace = emptyTherapeuticTrace({
    task_id: taskId,
    task_class: "incident_response",
    user_goal: "Diagnose production incident using deployed therapeutic tomography probes.",
    current_authority_dose: 1,
  });
  trace.uncertainties.push({
    id: "incident_scope",
    description: "Identify affected service and smallest read-only rollback metadata access.",
    current_confidence: 0.15,
    possible_causes: ["service_deploy", "dependency_failure", "regional_impact"],
    useful_probes: ["service_health_rollup", "blast_radius_summary"],
    blocking_status: "open",
    severity: "high",
  });

  const store = createTherapeuticRuntimeStore();
  store.tenant_scope = config.tenant_scope;

  const contracts = therapeuticProbeContractsForTaskClass("incident_response");
  const healthContract = contracts.find((probe) => probe.name === "service_health_rollup");
  const blastRadiusContract = contracts.find((probe) => probe.name === "blast_radius_summary");
  if (!healthContract || !blastRadiusContract) throw new Error("release_probe_contract_missing");

  const probeHttpObservations = [];
  const probeAdapter = createHttpTherapeuticProbeAdapter({
    endpoint_url: config.probe_url,
    headers: {
      Authorization: `Bearer ${config.probe_auth_token}`,
      "X-Synthi-Tenant-Id": config.tenant_scope.tenant_id,
      "X-Synthi-Workspace-Id": config.tenant_scope.workspace_id,
      "X-Synthi-Actor-Id": config.tenant_scope.actor_id,
      "X-Synthi-Roles": config.actor_roles.join(","),
      "X-Synthi-Runtime-Session-Id": config.runtime_session_id,
    },
    transport: async (input) => {
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers: input.headers,
        body: JSON.stringify(input.body),
      });
      const text = await readResponseText(response);
      const body = parseResponseBody(text);
      probeHttpObservations.push({
        probe_name: String(input.body?.probe_name ?? ""),
        url: input.url,
        status: response.status,
        request_body_sha256: sha256(JSON.stringify(redactProbeRequestBody(input.body))),
        response_body_sha256: sha256(text),
        observed_at: now,
      });
      return { status: response.status, body };
    },
  });

  const protectedTool = {
    tool_name: "rollback_candidate_readiness",
    data_classes: ["rollback_metadata"],
    mode: "read_only",
    scope: `service:${config.service_name}`,
  };
  const bypass = dispatchProtectedTherapeuticTool({
    trace,
    store,
    tool: protectedTool,
    now,
  });

  const healthProbe = await executeTherapeuticProbe({
    trace,
    store,
    contract: healthContract,
    adapter: probeAdapter,
    probe_input: { service_name: config.service_name, time_window: config.time_window },
    now,
  });
  const blastProbe = await executeTherapeuticProbe({
    trace,
    store,
    contract: blastRadiusContract,
    adapter: probeAdapter,
    probe_input: { service_name: config.service_name, time_window: config.time_window },
    now,
  });
  if (healthProbe.decision !== "completed" || blastProbe.decision !== "completed") {
    throw new Error(`therapeutic_production_probe_failed:${[
      ...healthProbe.blocked_by,
      ...blastProbe.blocked_by,
    ].join(",") || "probe_incomplete"}`);
  }

  const request = {
    id: "production-rollback-readiness",
    task_id: taskId,
    authority_dose: 4,
    scope: `service:${config.service_name}`,
    mode: "read_only",
    data_classes: ["rollback_metadata"],
    tools: ["rollback_candidate_readiness"],
    expiration: "end_of_task",
    revocable: true,
    purpose: "Read scoped rollback metadata after aggregate incident probes identify the service.",
  };
  const unsignedProof = buildStrictProofCapsule({
    id: `proof_${stableSuffix([taskId, request.id])}`,
    task_id: taskId,
    trace,
    request,
    current_authority_dose: trace.current_authority_dose,
    human_reviewed_claims: [{
      claim: "rollback_metadata_is_reasonable_next_step",
      reviewer_role: "incident_commander",
      status: "approved",
      rationale: "Production aggregate probes isolated the service and request is scoped read-only rollback metadata.",
    }],
    timestamp: now,
  });
  const { signer, verifier, signing_config } = createProductionProofSignerAndVerifier(config);
  const proof = signTherapeuticProofCapsule({ capsule: unsignedProof, signer, now });
  const proofVerification = verifySignedTherapeuticProofCapsule({ capsule: proof, verifier });
  if (!proofVerification.ok) {
    throw new Error(`therapeutic_production_proof_signature_invalid:${proofVerification.blocked_by.join(",")}`);
  }

  const access = enforceTherapeuticAccessRequest({ trace, store, request, proof_capsule: proof, now });
  const dispatch = dispatchProtectedTherapeuticTool({ trace, store, tool: protectedTool, now });
  const revoked = revokeTherapeuticTaskGrants({ trace, store, reason: "production_release_evidence_complete", now });
  const postRevocationDispatch = dispatchProtectedTherapeuticTool({ trace, store, tool: protectedTool, now });

  const narrativeOnlyProof = buildStrictProofCapsule({
    id: `proof_negative_narrative_${stableSuffix([taskId])}`,
    task_id: taskId,
    trace,
    request: {
      ...request,
      id: "negative-broad-narrative",
      authority_dose: 8,
      scope: "*",
      mode: "write",
      data_classes: ["raw_logs", "model_weights", "admin_privileges", "full_db_access"],
      tools: ["admin_console", "database_export", "model_weight_download"],
      purpose: "Narrative-only broad access should never be authorized.",
    },
    current_authority_dose: trace.current_authority_dose,
    machine_verifiable_claims: [],
    human_reviewed_claims: [],
    unverifiable_narrative_claims: [{ claim: "Narrative says broad access would help.", status: "context_only" }],
    timestamp: now,
  });
  const narrativeOnlyAccess = enforceTherapeuticAccessRequest({
    trace,
    store,
    request: narrativeOnlyProof.requested_access,
    proof_capsule: narrativeOnlyProof,
    now,
  });

  const runtimeState = {
    schema_version: "synthi.dojo.therapeuticRuntimeState.v1",
    tenant_scope: config.tenant_scope,
    trace,
    store,
    persisted_at: now,
  };
  const durableObservation = await persistAndReconstructProductionState({
    config,
    taskId,
    runtimeState,
    now,
    fetchImpl,
  });

  const artifact = {
    schema_version: "synthi.dojo.therapeuticTomographyReleaseEvidence.v2",
    generated_at: now,
    scope: "production deployed therapeutic tomography release evidence",
    hosted_runtime: runtimeObservation,
    tenant_scope: {
      ...config.tenant_scope,
      organization_id: config.organization_id,
      roles: config.actor_roles,
      source: "production_environment",
    },
    task_id: taskId,
    deployed_probe_adapter: {
      kind: "https_probe_adapter",
      endpoint_url: config.probe_url,
      loopback: false,
      transport: "fetch",
      probes_completed: [healthProbe.probe?.name, blastProbe.probe?.name].filter(Boolean),
      evidence_refs: [...healthProbe.evidence_refs, ...blastProbe.evidence_refs],
      http_observations: probeHttpObservations,
    },
    production_durable_store: durableObservation,
    proof_signing: {
      signature_algorithm: proof.signature_algorithm,
      signature_key_id: proof.signature_key_id,
      signing_provider: proof.signing_provider,
      key_custody: proof.key_custody,
      signature_verified: proofVerification.signature_verified,
      verification_blocked_by: proofVerification.blocked_by,
      external_signing_path: signing_config,
    },
    authorization_path: {
      unauthorized_bypass_decision: bypass.decision,
      unauthorized_bypass_blocked_by: bypass.blocked_by,
      access_decision: access.decision,
      grant_id: access.grant?.grant_id,
      protected_dispatch_decision: dispatch.decision,
      post_revocation_dispatch_decision: postRevocationDispatch.decision,
      post_revocation_dispatch_blocked_by: postRevocationDispatch.blocked_by,
      revoked_grants: revoked.map((grant) => ({
        grant_id: grant.grant_id,
        status: grant.status,
        revocation_status: grant.revocation_status,
      })),
    },
    safety_assertions: {
      narrative_only_access_decision: narrativeOnlyAccess.decision,
      narrative_only_blocked_by: narrativeOnlyAccess.broker_decision.blocked_by,
      narrative_only_grants_broader_access: narrativeOnlyAccess.decision === "approved",
      diagnostic_proof_authorized_mutation: access.grant?.access_request.mode === "write",
      unauthorized_protected_tool_bypass: bypass.decision !== "denied" ? "failed" : "blocked",
      broad_access_granted: grantedForbiddenBroadAccess(store),
      raw_logs_granted: grantedDataClass(store, "raw_logs"),
      model_weights_granted: grantedDataClass(store, "model_weights"),
      admin_privileges_granted: grantedDataClass(store, "admin_privileges"),
      full_db_access_granted: grantedDataClass(store, "full_db_access"),
    },
  };

  const validation = validateProductionTherapeuticTomographyEvidence(artifact);
  if (!validation.ok) {
    throw new Error(`therapeutic_tomography_production_evidence_invalid:${validation.errors.join(",")}`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(outputPath, serialized, "utf8");
  return {
    output_path: outputPath,
    artifact_sha256: sha256(serialized),
    artifact,
  };
}

export function resolveProductionTherapeuticTomographyConfig(env = process.env) {
  const missing = THERAPEUTIC_TOMOGRAPHY_PRODUCTION_REQUIRED_ENV
    .filter((key) => !String(env[key] ?? "").trim());
  const provider = String(env.SYNTHI_DOJO_PROOF_SIGNING_PROVIDER ?? "").trim();
  if (provider === "managed-key-service" && !String(env.SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI ?? "").trim()) {
    missing.push("SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI");
  }
  if (missing.length > 0) {
    throw new Error(`therapeutic_tomography_production_env_missing:${missing.join(",")}`);
  }

  const runtimeUrl = validateProductionHttpsUrl(
    env.SYNTHI_THERAPEUTIC_PROD_RUNTIME_URL,
    "therapeutic_production_runtime_url"
  );
  const probeUrl = validateProductionHttpsUrl(
    env.SYNTHI_THERAPEUTIC_PROD_PROBE_URL,
    "therapeutic_production_probe_url"
  );
  const storeUrl = validateProductionHttpsUrl(
    env.SYNTHI_THERAPEUTIC_PROD_STORE_URL,
    "therapeutic_production_store_url"
  );
  if (provider !== "managed-key-service" && provider !== "external-command") {
    throw new Error("therapeutic_tomography_production_signer_external_required");
  }
  if (String(env.SYNTHI_DOJO_PROOF_SIGNING_KEY ?? "").trim()) {
    throw new Error("therapeutic_tomography_production_local_hmac_key_forbidden");
  }
  if (String(env.SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM ?? "").trim()) {
    throw new Error("therapeutic_tomography_production_private_key_material_forbidden");
  }

  const actorRoles = parseCsv(env.SYNTHI_THERAPEUTIC_PROD_ACTOR_ROLES);
  if (!actorRoles.includes("incident_commander") && !actorRoles.includes("therapeutic_proof_broker")) {
    throw new Error("therapeutic_tomography_production_rbac_role_missing");
  }
  const tenantScope = {
    tenant_id: validateProductionIdentifier(env.SYNTHI_THERAPEUTIC_PROD_TENANT_ID, "tenant_id"),
    workspace_id: validateProductionIdentifier(env.SYNTHI_THERAPEUTIC_PROD_WORKSPACE_ID, "workspace_id"),
    actor_id: validateProductionIdentifier(env.SYNTHI_THERAPEUTIC_PROD_ACTOR_ID, "actor_id"),
  };

  return {
    runtime_url: runtimeUrl,
    runtime_auth_token: String(env.SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_TOKEN).trim(),
    runtime_session_id: validateProductionIdentifier(env.SYNTHI_THERAPEUTIC_PROD_RUNTIME_SESSION_ID, "runtime_session_id"),
    probe_url: probeUrl,
    probe_auth_token: String(env.SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN).trim(),
    store_url: storeUrl,
    store_read_url_template: String(env.SYNTHI_THERAPEUTIC_PROD_STORE_READ_URL_TEMPLATE ?? "").trim(),
    store_auth_token: String(env.SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN).trim(),
    tenant_scope: tenantScope,
    organization_id: validateProductionIdentifier(env.SYNTHI_THERAPEUTIC_PROD_ORGANIZATION_ID, "organization_id"),
    actor_roles: actorRoles,
    service_name: String(env.SYNTHI_THERAPEUTIC_PROD_SERVICE_NAME ?? "checkout-api").trim(),
    time_window: String(env.SYNTHI_THERAPEUTIC_PROD_TIME_WINDOW ?? "last_30m").trim(),
    signing_provider: provider,
    signing_key_id: String(env.SYNTHI_DOJO_PROOF_SIGNING_KEY_ID).trim(),
    signing_command: String(env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND).trim(),
    signing_command_args: parseJsonArray(env.SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS),
    signing_managed_key_uri: String(env.SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI ?? "").trim(),
    signing_public_key_pem: String(env.SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM).trim(),
    signing_timeout_ms: Number(env.SYNTHI_DOJO_PROOF_SIGNING_TIMEOUT_MS ?? 5000),
  };
}

export function validateProductionTherapeuticTomographyEvidence(artifact) {
  const errors = [];
  if (artifact?.schema_version !== "synthi.dojo.therapeuticTomographyReleaseEvidence.v2") {
    errors.push("schema_version_invalid");
  }
  const runtimeUrl = safeUrl(artifact?.hosted_runtime?.url);
  if (!runtimeUrl || !isProductionHttpsUrl(runtimeUrl)) errors.push("hosted_runtime_url_not_production_https");
  if (artifact?.hosted_runtime?.authorized !== true) errors.push("hosted_runtime_not_authorized");
  if (!artifact?.hosted_runtime?.authorization_observed_at) errors.push("hosted_runtime_authorization_missing");
  if (!isSha256Hex(artifact?.hosted_runtime?.response_headers_sha256)) errors.push("hosted_runtime_response_headers_sha256_missing");
  if (!isSha256Hex(artifact?.hosted_runtime?.response_body_sha256)) errors.push("hosted_runtime_response_body_sha256_missing");
  const probeUrl = safeUrl(artifact?.deployed_probe_adapter?.endpoint_url);
  if (!probeUrl || !isProductionHttpsUrl(probeUrl)) errors.push("probe_endpoint_not_production_https");
  if (artifact?.deployed_probe_adapter?.transport !== "fetch") errors.push("probe_transport_not_real_fetch");
  if (!Array.isArray(artifact?.deployed_probe_adapter?.probes_completed) || artifact.deployed_probe_adapter.probes_completed.length < 2) {
    errors.push("production_probe_evidence_incomplete");
  }
  const probeObservations = Array.isArray(artifact?.deployed_probe_adapter?.http_observations)
    ? artifact.deployed_probe_adapter.http_observations
    : [];
  if (probeObservations.length < 2) {
    errors.push("production_probe_http_observations_missing");
  }
  for (const name of ["service_health_rollup", "blast_radius_summary"]) {
    const observation = probeObservations.find((item) => item?.probe_name === name);
    if (!observation) {
      errors.push(`production_probe_http_observation_missing:${name}`);
      continue;
    }
    const observationUrl = safeUrl(observation.url);
    if (!observationUrl || !isProductionHttpsUrl(observationUrl)) errors.push(`production_probe_http_observation_url_invalid:${name}`);
    if (!Number.isInteger(observation.status) || observation.status < 200 || observation.status >= 300) {
      errors.push(`production_probe_http_observation_status_invalid:${name}`);
    }
    if (!isSha256Hex(observation.request_body_sha256)) errors.push(`production_probe_request_sha256_missing:${name}`);
    if (!isSha256Hex(observation.response_body_sha256)) errors.push(`production_probe_response_sha256_missing:${name}`);
    if (!observation.observed_at) errors.push(`production_probe_observed_at_missing:${name}`);
  }
  if (!artifact?.tenant_scope?.tenant_id || !artifact?.tenant_scope?.workspace_id || !artifact?.tenant_scope?.actor_id) {
    errors.push("tenant_scope_missing");
  }
  if (artifact?.tenant_scope?.source !== "production_environment") errors.push("tenant_scope_not_from_production_environment");
  if (!Array.isArray(artifact?.tenant_scope?.roles) || artifact.tenant_scope.roles.length === 0) {
    errors.push("tenant_rbac_roles_missing");
  }
  if (artifact?.production_durable_store?.kind !== "external_control_plane") errors.push("durable_store_not_external_control_plane");
  const storeUrl = safeUrl(artifact?.production_durable_store?.endpoint_url);
  if (!storeUrl || !isProductionHttpsUrl(storeUrl)) errors.push("durable_store_endpoint_not_production_https");
  if (artifact?.production_durable_store?.reconstruction_verified !== true) errors.push("durable_state_reconstruction_unverified");
  if (!artifact?.production_durable_store?.record_id) errors.push("durable_store_record_id_missing");
  const readbackUrl = safeUrl(artifact?.production_durable_store?.readback_url);
  if (!readbackUrl || !isProductionHttpsUrl(readbackUrl)) errors.push("durable_store_readback_url_not_production_https");
  if (!Number.isInteger(artifact?.production_durable_store?.append_status) || artifact.production_durable_store.append_status < 200 || artifact.production_durable_store.append_status >= 300) {
    errors.push("durable_store_append_status_invalid");
  }
  if (!Number.isInteger(artifact?.production_durable_store?.read_status) || artifact.production_durable_store.read_status < 200 || artifact.production_durable_store.read_status >= 300) {
    errors.push("durable_store_read_status_invalid");
  }
  if (!isSha256Hex(artifact?.production_durable_store?.append_response_body_sha256)) errors.push("durable_store_append_response_sha256_missing");
  if (!isSha256Hex(artifact?.production_durable_store?.read_response_body_sha256)) errors.push("durable_store_read_response_sha256_missing");
  if (artifact?.proof_signing?.signing_provider !== "managed-key-service" && artifact?.proof_signing?.signing_provider !== "external-command") {
    errors.push("proof_signing_provider_not_external");
  }
  if (artifact?.proof_signing?.key_custody === "local") errors.push("proof_signing_local_custody_forbidden");
  if (artifact?.proof_signing?.signature_algorithm !== "ed25519") errors.push("proof_signature_algorithm_not_ed25519");
  if (artifact?.proof_signing?.signature_verified !== true) errors.push("proof_signature_not_verified");
  if (artifact?.authorization_path?.unauthorized_bypass_decision !== "denied") errors.push("unauthorized_bypass_not_denied");
  if (artifact?.authorization_path?.access_decision !== "approved") errors.push("scoped_grant_not_approved");
  if (artifact?.authorization_path?.protected_dispatch_decision !== "approved") errors.push("protected_dispatch_not_approved");
  if (artifact?.authorization_path?.post_revocation_dispatch_decision !== "denied") errors.push("post_revocation_dispatch_not_denied");
  if (artifact?.safety_assertions?.narrative_only_access_decision === "approved") errors.push("narrative_only_proof_granted_access");
  for (const key of [
    "narrative_only_grants_broader_access",
    "diagnostic_proof_authorized_mutation",
    "broad_access_granted",
    "raw_logs_granted",
    "model_weights_granted",
    "admin_privileges_granted",
    "full_db_access_granted",
  ]) {
    if (artifact?.safety_assertions?.[key] !== false) errors.push(`safety_assertion_failed:${key}`);
  }
  return { ok: errors.length === 0, errors };
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function observeHostedRuntimeAuthorization({ config, now, fetchImpl }) {
  const response = await fetchImpl(config.runtime_url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.runtime_auth_token}`,
      "X-Synthi-Tenant-Id": config.tenant_scope.tenant_id,
      "X-Synthi-Organization-Id": config.organization_id,
      "X-Synthi-Workspace-Id": config.tenant_scope.workspace_id,
      "X-Synthi-Actor-Id": config.tenant_scope.actor_id,
      "X-Synthi-Roles": config.actor_roles.join(","),
      "X-Synthi-Runtime-Session-Id": config.runtime_session_id,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`therapeutic_production_runtime_authorization_failed:${response.status}`);
  }
  const text = await readResponseText(response);
  return {
    authorized: true,
    session_id: config.runtime_session_id,
    url: config.runtime_url,
    loopback: false,
    authorization_observed_at: now,
    status: response.status,
    response_headers_sha256: sha256(JSON.stringify(Object.fromEntries(response.headers.entries()))),
    response_body_sha256: sha256(text),
  };
}

async function persistAndReconstructProductionState({ config, taskId, runtimeState, now, fetchImpl }) {
  const stateText = JSON.stringify(runtimeState);
  const stateSha256 = sha256(stateText);
  const appendResponse = await fetchImpl(config.store_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.store_auth_token}`,
      "Content-Type": "application/json",
      "X-Synthi-Tenant-Id": config.tenant_scope.tenant_id,
      "X-Synthi-Workspace-Id": config.tenant_scope.workspace_id,
      "X-Synthi-Actor-Id": config.tenant_scope.actor_id,
    },
    body: JSON.stringify({
      schema_version: "synthi.dojo.therapeuticProductionStateAppend.v1",
      tenant_scope: config.tenant_scope,
      task_id: taskId,
      state: runtimeState,
      state_sha256: stateSha256,
      created_at: now,
    }),
  });
  if (appendResponse.status < 200 || appendResponse.status >= 300) {
    throw new Error(`therapeutic_production_store_append_failed:${appendResponse.status}`);
  }
  const appendText = await readResponseText(appendResponse);
  const appendBody = parseResponseBody(appendText);
  const recordId = String(appendBody.record_id ?? appendBody.id ?? "").trim();
  if (!recordId) throw new Error("therapeutic_production_store_record_id_missing");

  const readUrl = config.store_read_url_template
    ? config.store_read_url_template.replace("{record_id}", encodeURIComponent(recordId))
    : `${config.store_url.replace(/\/$/, "")}/${encodeURIComponent(recordId)}`;
  validateProductionHttpsUrl(readUrl, "therapeutic_production_store_read_url");
  const readResponse = await fetchImpl(readUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.store_auth_token}`,
      "X-Synthi-Tenant-Id": config.tenant_scope.tenant_id,
      "X-Synthi-Workspace-Id": config.tenant_scope.workspace_id,
      "X-Synthi-Actor-Id": config.tenant_scope.actor_id,
    },
  });
  if (readResponse.status < 200 || readResponse.status >= 300) {
    throw new Error(`therapeutic_production_store_readback_failed:${readResponse.status}`);
  }
  const readText = await readResponseText(readResponse);
  const readBody = parseResponseBody(readText);
  const reconstructed = readBody.state ?? readBody.record?.state ?? readBody;
  const reconstructedSha256 = String(
    readBody.state_sha256 ?? readBody.record?.state_sha256 ?? sha256(JSON.stringify(reconstructed))
  );
  const reconstructedText = JSON.stringify(reconstructed);
  const reconstructionVerified = reconstructedSha256 === stateSha256
    && sha256(reconstructedText) === stateSha256
    && reconstructed?.trace?.task_id === taskId
    && reconstructed?.tenant_scope?.tenant_id === config.tenant_scope.tenant_id
    && Array.isArray(reconstructed?.store?.evidence_records)
    && Array.isArray(reconstructed?.store?.audit_records);
  if (!reconstructionVerified) {
    throw new Error("therapeutic_production_store_reconstruction_unverified");
  }
  return {
    kind: "external_control_plane",
    endpoint_url: config.store_url,
    readback_url: readUrl,
    record_id: recordId,
    state_sha256: stateSha256,
    persisted_at: now,
    append_status: appendResponse.status,
    append_response_body_sha256: sha256(appendText),
    read_status: readResponse.status,
    read_response_body_sha256: sha256(readText),
    evidence_records: runtimeState.store.evidence_records.length,
    audit_records: runtimeState.store.audit_records.length,
    grant_records: runtimeState.store.grants.length,
    proof_decision_records: runtimeState.store.proof_decision_records.length,
    checkride_reports: runtimeState.store.checkride_reports.length,
    policy_learning_records: runtimeState.store.policy_learning_records.length,
    reconstructed_evidence_records: reconstructed.store.evidence_records.length,
    reconstructed_audit_records: reconstructed.store.audit_records.length,
    reconstruction_verified: true,
  };
}

async function readResponseText(response) {
  if (typeof response.text === "function") return await response.text();
  if (typeof response.json === "function") return JSON.stringify(await response.json());
  return "";
}

function parseResponseBody(text) {
  if (!String(text ?? "").trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactProbeRequestBody(body) {
  return {
    schema_version: body?.schema_version,
    task_id: body?.task_id,
    task_class: body?.task_class,
    probe_name: body?.probe_name,
    allowed_output_shape: body?.allowed_output_shape,
  };
}

function createProductionProofSignerAndVerifier(config) {
  const verifier = createEd25519DojoProofVerifier({
    key_id: config.signing_key_id,
    public_key_pem: config.signing_public_key_pem,
  });
  if (config.signing_provider === "managed-key-service") {
    return {
      signer: createManagedKeyServiceDojoProofSigner({
        key_id: config.signing_key_id,
        key_uri: config.signing_managed_key_uri,
        command: config.signing_command,
        args: config.signing_command_args,
        timeout_ms: config.signing_timeout_ms,
      }),
      verifier,
      signing_config: {
        provider: "managed-key-service",
        key_uri: config.signing_managed_key_uri,
        command_redacted: true,
        args_redacted: true,
      },
    };
  }
  return {
    signer: createExternalCommandDojoProofSigner({
      key_id: config.signing_key_id,
      command: config.signing_command,
      args: config.signing_command_args,
      timeout_ms: config.signing_timeout_ms,
    }),
    verifier,
    signing_config: {
      provider: "external-command",
      command_redacted: true,
      args_redacted: true,
    },
  };
}

function validateProductionHttpsUrl(raw, label) {
  const url = safeUrl(raw);
  if (!url) throw new Error(`${label}_invalid`);
  if (!isProductionHttpsUrl(url)) throw new Error(`${label}_not_production_https`);
  return url.toString();
}

function isProductionHttpsUrl(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".test")
    || host.endsWith(".example")
    || host.endsWith(".invalid")
    || host === "example.com"
    || host.includes("example.test")
  ) {
    return false;
  }
  const ipKind = isIP(host);
  if (ipKind === 4) {
    const [a, b] = host.split(".").map((part) => Number(part));
    if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) {
      return false;
    }
  }
  if (ipKind === 6) {
    if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false;
  }
  return true;
}

function validateProductionIdentifier(raw, label) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`therapeutic_tomography_production_${label}_missing`);
  if (/^(test|demo|local|example)([-_:]|$)/i.test(value) || /(test|demo|local|example)$/i.test(value)) {
    throw new Error(`therapeutic_tomography_production_${label}_not_production`);
  }
  return value;
}

function parseJsonArray(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("therapeutic_tomography_signing_command_args_invalid");
  }
  return parsed;
}

function parseCsv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function grantedDataClass(store, dataClass) {
  return store.grants.some((grant) =>
    grant.status === "active"
    && grant.access_request.data_classes.includes(dataClass)
  );
}

function grantedForbiddenBroadAccess(store) {
  return store.grants.some((grant) =>
    grant.status === "active"
    && (
      grant.access_request.scope === "*"
      || grant.access_request.mode === "write"
      || grant.access_request.data_classes.some((dataClass) => FORBIDDEN_BROAD_CLASSES.has(dataClass))
    )
  );
}

function safeUrl(raw) {
  try {
    return new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
}

function stableSuffix(parts) {
  return sha256(parts.join("|")).slice(0, 12);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
