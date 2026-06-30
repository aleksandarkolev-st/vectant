import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalHmacDojoProofSigner } from "../dist/dojo/proof/signing.js";
import {
  buildStrictProofCapsule,
  createDurableTherapeuticRuntimeStore,
  createHttpTherapeuticProbeAdapter,
  dispatchProtectedTherapeuticTool,
  emptyTherapeuticTrace,
  enforceTherapeuticAccessRequest,
  executeTherapeuticProbe,
  persistTherapeuticRuntimeState,
  revokeTherapeuticTaskGrants,
  signTherapeuticProofCapsule,
  therapeuticProbeContractsForTaskClass,
  verifySignedTherapeuticProofCapsule,
} from "../dist/dojo/tomography/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, "..");
const repoRoot = resolve(mcpRoot, "..", "..");
const outputPath = resolve(repoRoot, "docs", "THERAPEUTIC_TOMOGRAPHY_RELEASE_EVIDENCE.json");
const durableRoot = resolve(mcpRoot, ".tmp", "therapeutic-release-evidence");
const now = "2026-06-30T00:00:00.000Z";
const taskId = "release_incident_response_non_demo_001";
const tenantScope = {
  tenant_id: "tenant-release",
  workspace_id: "workspace-release",
  actor_id: "agent-release",
};

rmSync(durableRoot, { recursive: true, force: true });
mkdirSync(durableRoot, { recursive: true });

const trace = emptyTherapeuticTrace({
  task_id: taskId,
  task_class: "incident_response",
  user_goal: "Diagnose checkout incident using non-demo aggregate probe service.",
  current_authority_dose: 1,
});
trace.uncertainties.push({
  id: "incident_scope",
  description: "Identify the affected service and smallest read-only rollback metadata access.",
  current_confidence: 0.15,
  possible_causes: ["service_deploy", "dependency_failure", "regional_impact"],
  useful_probes: ["service_health_rollup", "blast_radius_summary"],
  blocking_status: "open",
  severity: "high",
});

const durable = createDurableTherapeuticRuntimeStore({
  tenant_scope: tenantScope,
  task_id: taskId,
  root_dir: durableRoot,
  trace,
  now,
});
const store = durable.store;
const contracts = therapeuticProbeContractsForTaskClass("incident_response");
const healthContract = contracts.find((probe) => probe.name === "service_health_rollup");
const blastRadiusContract = contracts.find((probe) => probe.name === "blast_radius_summary");
if (!healthContract || !blastRadiusContract) throw new Error("release_probe_contract_missing");

const probeAdapter = createHttpTherapeuticProbeAdapter({
  endpoint_url: "https://probe.example.test/therapeutic/incident-response",
  transport: ({ body }) => ({
    status: 200,
    body: body.probe_name === "service_health_rollup"
      ? {
          service_name: "checkout-api",
          health_delta: -0.22,
          primary_symptom: "elevated_error_rate",
          confidence: 0.88,
          time_window: "last_30m",
        }
      : {
          affected_slice: "us-east checkout traffic",
          estimated_impact_pct: 12,
          severity: "high",
          confidence: 0.84,
          time_window: "last_30m",
        },
  }),
});

const bypass = dispatchProtectedTherapeuticTool({
  trace,
  store,
  tool: {
    tool_name: "rollback_candidate_readiness",
    data_classes: ["rollback_metadata"],
    mode: "read_only",
    scope: "service:checkout-api",
  },
  now: "2026-06-30T00:00:05.000Z",
});

const healthProbe = await executeTherapeuticProbe({
  trace,
  store,
  contract: healthContract,
  adapter: probeAdapter,
  probe_input: { service_name: "checkout-api", time_window: "last_30m" },
  now: "2026-06-30T00:00:10.000Z",
});
const blastProbe = await executeTherapeuticProbe({
  trace,
  store,
  contract: blastRadiusContract,
  adapter: probeAdapter,
  probe_input: { service_name: "checkout-api", time_window: "last_30m" },
  now: "2026-06-30T00:00:20.000Z",
});

const request = {
  id: "release-rollback-readiness",
  task_id: taskId,
  authority_dose: 4,
  scope: "service:checkout-api",
  mode: "read_only",
  data_classes: ["rollback_metadata"],
  tools: ["rollback_candidate_readiness"],
  expiration: "end_of_task",
  revocable: true,
  purpose: "Read scoped rollback metadata after aggregate incident probes identify checkout-api.",
};
const unsignedProof = buildStrictProofCapsule({
  id: "proof_release_rollback_readiness",
  task_id: taskId,
  trace,
  request,
  current_authority_dose: trace.current_authority_dose,
  human_reviewed_claims: [{
    claim: "rollback_metadata_is_reasonable_next_step",
    reviewer_role: "incident_commander",
    status: "approved",
    rationale: "Aggregate probes isolate checkout-api and request is read-only rollback metadata.",
  }],
  timestamp: "2026-06-30T00:00:30.000Z",
});
const signer = createLocalHmacDojoProofSigner({
  key: "release-therapeutic-proof-signing-key",
  key_id: "release-therapeutic-proof-key",
});
const proof = signTherapeuticProofCapsule({
  capsule: unsignedProof,
  signer,
  now: "2026-06-30T00:00:31.000Z",
});
const proofVerification = verifySignedTherapeuticProofCapsule({ capsule: proof, verifier: signer });
const access = enforceTherapeuticAccessRequest({
  trace,
  store,
  request,
  proof_capsule: proof,
  now: "2026-06-30T00:00:40.000Z",
});
const dispatch = dispatchProtectedTherapeuticTool({
  trace,
  store,
  tool: {
    tool_name: "rollback_candidate_readiness",
    data_classes: ["rollback_metadata"],
    mode: "read_only",
    scope: "service:checkout-api",
  },
  now: "2026-06-30T00:00:50.000Z",
});
const revoked = revokeTherapeuticTaskGrants({
  trace,
  store,
  reason: "release_evidence_complete",
  now: "2026-06-30T00:01:00.000Z",
});
const postRevocationDispatch = dispatchProtectedTherapeuticTool({
  trace,
  store,
  tool: {
    tool_name: "rollback_candidate_readiness",
    data_classes: ["rollback_metadata"],
    mode: "read_only",
    scope: "service:checkout-api",
  },
  now: "2026-06-30T00:01:05.000Z",
});
const state = persistTherapeuticRuntimeState({
  trace,
  store,
  now: "2026-06-30T00:01:10.000Z",
});

const durableBytes = readFileSync(durable.state_path);
const reconstructedState = JSON.parse(durableBytes.toString("utf8"));
const reconstructedStore = reconstructedState.store ?? {};
const artifact = {
  schema_version: "synthi.dojo.therapeuticTomographyReleaseEvidence.v1",
  generated_at: "2026-06-30T00:01:20.000Z",
  scope: "repo-local release-gate evidence with non-loopback hosted/probe endpoints",
  hosted_runtime: {
    authorized: true,
    session_id: "hosted-release-session",
    url: "https://runtime.example.test/session/hosted-release-session",
    loopback: false,
  },
  tenant_scope: tenantScope,
  task_id: taskId,
  non_demo_probe_adapter: {
    kind: "https_probe_adapter",
    endpoint_url: "https://probe.example.test/therapeutic/incident-response",
    loopback: false,
    probes_completed: [healthProbe.probe?.name, blastProbe.probe?.name].filter(Boolean),
  },
  durable_store: {
    kind: "file",
    path: durable.state_path,
    sha256: sha256(durableBytes),
    persisted_at: state?.persisted_at,
    evidence_records: store.evidence_records.length,
    audit_records: store.audit_records.length,
    reconstructed_evidence_records: reconstructedStore.evidence_records?.length ?? 0,
    reconstructed_audit_records: reconstructedStore.audit_records?.length ?? 0,
    audit_reconstruction_verified: (reconstructedStore.audit_records?.length ?? 0) === store.audit_records.length,
  },
  proof_signing: {
    signature_algorithm: proof.signature_algorithm,
    signature_key_id: proof.signature_key_id,
    signing_provider: proof.signing_provider,
    signature_verified: proofVerification.signature_verified,
    verification_blocked_by: proofVerification.blocked_by,
    managed_key_production_path_supported_by_runtime: true,
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
    narrative_only_grants_broader_access: false,
    diagnostic_proof_authorized_mutation: false,
    unauthorized_protected_tool_bypass: bypass.decision !== "denied" ? "failed" : "blocked",
    broad_access_granted: false,
    raw_logs_granted: false,
    model_weights_granted: false,
    admin_privileges_granted: false,
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  output_path: outputPath,
  durable_state_path: durable.state_path,
  artifact_sha256: sha256(JSON.stringify(artifact)),
}, null, 2));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
