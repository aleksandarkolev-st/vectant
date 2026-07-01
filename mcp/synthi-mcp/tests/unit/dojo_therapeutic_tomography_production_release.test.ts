import { describe, expect, it } from "vitest";

const releaseModulePromise = import("../../scripts/dojo-therapeutic-tomography-release-evidence.mjs");

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SYNTHI_THERAPEUTIC_PROD_RUNTIME_URL: "https://runtime.prod.synthi.ai/session/session-prod-001",
    SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_TOKEN: "runtime-token",
    SYNTHI_THERAPEUTIC_PROD_RUNTIME_SESSION_ID: "session-prod-001",
    SYNTHI_THERAPEUTIC_PROD_PROBE_URL: "https://probe.prod.synthi.ai/therapeutic/incident-response",
    SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN: "probe-token",
    SYNTHI_THERAPEUTIC_PROD_STORE_URL: "https://control.prod.synthi.ai/therapeutic/runtime-state",
    SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN: "store-token",
    SYNTHI_THERAPEUTIC_PROD_TENANT_ID: "tenant-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ORGANIZATION_ID: "org-prod-001",
    SYNTHI_THERAPEUTIC_PROD_WORKSPACE_ID: "workspace-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ACTOR_ID: "agent-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ACTOR_ROLES: "incident_commander,therapeutic_proof_broker",
    SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "managed-key-service",
    SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "therapeutic-prod-key",
    SYNTHI_DOJO_PROOF_SIGNING_COMMAND: "kms-signer",
    SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI: "gcp-kms://projects/prod/locations/global/keyRings/dojo/cryptoKeys/therapeutic",
    SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAk2P9j2ND6dPXbMhbm9ATkdZCVJz9qNfMTgq6fY54/zM=",
      "-----END PUBLIC KEY-----",
    ].join("\n"),
    ...overrides,
  };
}

function productionArtifact(overrides: Record<string, any> = {}) {
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
    },
    tenant_scope: {
      tenant_id: "tenant-prod-001",
      organization_id: "org-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      roles: ["incident_commander", "therapeutic_proof_broker"],
      source: "production_environment",
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
    ...overrides,
  };
}

describe("therapeutic tomography production release evidence gate", () => {
  it("fails closed when production dependencies are missing", async () => {
    const { resolveProductionTherapeuticTomographyConfig } = await releaseModulePromise;
    expect(() => resolveProductionTherapeuticTomographyConfig({}))
      .toThrow("therapeutic_tomography_production_env_missing");
  });

  it("rejects demo, loopback, local-only, and fake signing production config", async () => {
    const { resolveProductionTherapeuticTomographyConfig } = await releaseModulePromise;

    expect(() => resolveProductionTherapeuticTomographyConfig(productionEnv({
      SYNTHI_THERAPEUTIC_PROD_RUNTIME_URL: "https://runtime.example.test/session/demo",
    }))).toThrow("therapeutic_production_runtime_url_not_production_https");

    expect(() => resolveProductionTherapeuticTomographyConfig(productionEnv({
      SYNTHI_THERAPEUTIC_PROD_PROBE_URL: "http://127.0.0.1:8080/probe",
    }))).toThrow("therapeutic_production_probe_url_not_production_https");

    expect(() => resolveProductionTherapeuticTomographyConfig(productionEnv({
      SYNTHI_THERAPEUTIC_PROD_STORE_URL: "https://localhost/therapeutic/runtime-state",
    }))).toThrow("therapeutic_production_store_url_not_production_https");

    expect(() => resolveProductionTherapeuticTomographyConfig(productionEnv({
      SYNTHI_THERAPEUTIC_PROD_TENANT_ID: "tenant-test",
    }))).toThrow("therapeutic_tomography_production_tenant_id_not_production");

    expect(() => resolveProductionTherapeuticTomographyConfig(productionEnv({
      SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "hmac-local",
      SYNTHI_DOJO_PROOF_SIGNING_KEY: "local-secret",
    }))).toThrow("therapeutic_tomography_production_signer_external_required");
  });

  it("rejects stale repo-local v1 evidence and accepts production-shaped v2 evidence", async () => {
    const { validateProductionTherapeuticTomographyEvidence } = await releaseModulePromise;
    const staleV1 = {
      schema_version: "synthi.dojo.therapeuticTomographyReleaseEvidence.v1",
      hosted_runtime: { authorized: true, url: "https://runtime.example.test/session/demo" },
      non_demo_probe_adapter: { endpoint_url: "https://probe.example.test/therapeutic/incident-response" },
      durable_store: { kind: "file", audit_reconstruction_verified: true },
      proof_signing: { signing_provider: "hmac-local", signature_algorithm: "hmac-sha256", signature_verified: true },
      authorization_path: {
        unauthorized_bypass_decision: "denied",
        access_decision: "approved",
        protected_dispatch_decision: "approved",
        post_revocation_dispatch_decision: "denied",
      },
      safety_assertions: {
        narrative_only_grants_broader_access: false,
        diagnostic_proof_authorized_mutation: false,
        broad_access_granted: false,
        raw_logs_granted: false,
        model_weights_granted: false,
        admin_privileges_granted: false,
        full_db_access_granted: false,
      },
    };
    const staleValidation = validateProductionTherapeuticTomographyEvidence(staleV1);
    expect(staleValidation.ok).toBe(false);
    expect(staleValidation.errors).toEqual(expect.arrayContaining([
      "schema_version_invalid",
      "hosted_runtime_url_not_production_https",
      "durable_store_not_external_control_plane",
      "proof_signing_provider_not_external",
      "proof_signature_algorithm_not_ed25519",
    ]));

    expect(validateProductionTherapeuticTomographyEvidence(productionArtifact()).ok).toBe(true);
  });

  it("requires response fingerprints for runtime, probe, and durable store observations", async () => {
    const { validateProductionTherapeuticTomographyEvidence } = await releaseModulePromise;
    const validation = validateProductionTherapeuticTomographyEvidence(productionArtifact({
      hosted_runtime: {
        ...productionArtifact().hosted_runtime,
        response_body_sha256: undefined,
      },
      deployed_probe_adapter: {
        ...productionArtifact().deployed_probe_adapter,
        http_observations: [],
      },
      production_durable_store: {
        ...productionArtifact().production_durable_store,
        read_response_body_sha256: undefined,
      },
    }));

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      "hosted_runtime_response_body_sha256_missing",
      "production_probe_http_observations_missing",
      "production_probe_http_observation_missing:service_health_rollup",
      "production_probe_http_observation_missing:blast_radius_summary",
      "durable_store_read_response_sha256_missing",
    ]));
  });

  it("does not allow local/demo transports to satisfy production evidence", async () => {
    const { validateProductionTherapeuticTomographyEvidence } = await releaseModulePromise;

    const localProbe = validateProductionTherapeuticTomographyEvidence(productionArtifact({
      deployed_probe_adapter: {
        ...productionArtifact().deployed_probe_adapter,
        endpoint_url: "https://localhost/probe",
      },
    }));
    expect(localProbe.ok).toBe(false);
    expect(localProbe.errors).toContain("probe_endpoint_not_production_https");

    const fileStore = validateProductionTherapeuticTomographyEvidence(productionArtifact({
      production_durable_store: {
        ...productionArtifact().production_durable_store,
        kind: "file",
        endpoint_url: "file:///tmp/therapeutic-runtime.json",
      },
    }));
    expect(fileStore.ok).toBe(false);
    expect(fileStore.errors).toEqual(expect.arrayContaining([
      "durable_store_not_external_control_plane",
      "durable_store_endpoint_not_production_https",
    ]));

    const localSigner = validateProductionTherapeuticTomographyEvidence(productionArtifact({
      proof_signing: {
        ...productionArtifact().proof_signing,
        signing_provider: "hmac-local",
        key_custody: "local",
        signature_algorithm: "hmac-sha256",
      },
    }));
    expect(localSigner.ok).toBe(false);
    expect(localSigner.errors).toEqual(expect.arrayContaining([
      "proof_signing_provider_not_external",
      "proof_signing_local_custody_forbidden",
      "proof_signature_algorithm_not_ed25519",
    ]));
  });
});
