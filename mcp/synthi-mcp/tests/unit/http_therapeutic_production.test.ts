import { describe, expect, it } from "vitest";
import {
  parseArgs,
  parseTherapeuticStateAppend,
  resolveConfig,
  therapeuticProductionRuntimeAuthorizationBody,
} from "../../src/http.js";

describe("synthi-mcp-http therapeutic production config", () => {
  it("keeps therapeutic production endpoints disabled by default", () => {
    const config = resolveConfig(parseArgs([]), {});

    expect(config.therapeuticProduction.enabled).toBe(false);
    expect(config.therapeuticProduction.runtimeAuthPath).toBe("/therapeutic/runtime-authorization");
    expect(config.therapeuticProduction.storePath).toBe("/therapeutic/runtime-state");
    expect(config.therapeuticProduction.probePath).toBe("/therapeutic/incident-response");
  });

  it("fails closed when production endpoints lack external backing", () => {
    expect(() => resolveConfig(parseArgs([]), {
      SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED: "1",
      SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN: "store-token",
      SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN: "probe-token",
      SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_URL: "https://observability.prod.synthi.ai/probe",
    })).toThrow("therapeutic_production_http_runtime_bearer_token_required");

    expect(() => resolveConfig(parseArgs([]), {
      ...productionEndpointEnv(),
      SYNTHI_THERAPEUTIC_PROD_POSTGRES_URL: undefined,
    })).toThrow("therapeutic_production_http_postgres_url_required");

    expect(() => resolveConfig(parseArgs([]), {
      ...productionEndpointEnv(),
      SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_URL: "http://127.0.0.1:9000/probe",
    })).toThrow("therapeutic_production_probe_upstream_url_must_be_https");

    expect(() => resolveConfig(parseArgs([]), {
      ...productionEndpointEnv(),
      SYNTHI_THERAPEUTIC_PROD_TENANT_ID: "tenant-test",
    })).toThrow("therapeutic_production_http_tenant_id_not_production");
  });

  it("accepts production endpoint config only with tokens, Postgres, and external HTTPS probe upstream", () => {
    const config = resolveConfig(parseArgs(["--host", "0.0.0.0", "--bearer-token", "mcp-token"]), {
      ...productionEndpointEnv(),
    });

    expect(config.therapeuticProduction).toMatchObject({
      enabled: true,
      runtimeAuthPath: "/therapeutic/runtime-authorization",
      runtimeBearerToken: "runtime-token",
      runtimeSessionId: "session-prod-001",
      tenantId: "tenant-prod-001",
      organizationId: "org-prod-001",
      workspaceId: "workspace-prod-001",
      actorId: "agent-prod-001",
      actorRoles: ["incident_commander", "therapeutic_proof_broker"],
      postgresUrl: "postgres://control-plane/prod",
      storeBearerToken: "store-token",
      probeBearerToken: "probe-token",
      probeUpstreamUrl: "https://observability.prod.synthi.ai/probe",
      probeUpstreamBearerToken: "upstream-token",
    });
  });

  it("builds runtime authorization body from deployed production context", () => {
    const config = resolveConfig(parseArgs(["--host", "0.0.0.0", "--bearer-token", "mcp-token"]), {
      ...productionEndpointEnv(),
    });

    expect(therapeuticProductionRuntimeAuthorizationBody(config.therapeuticProduction)).toMatchObject({
      schema_version: "synthi.dojo.therapeuticRuntimeAuthorization.v1",
      authorized: true,
      session_id: "session-prod-001",
      tenant_id: "tenant-prod-001",
      organization_id: "org-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      roles: ["incident_commander", "therapeutic_proof_broker"],
      authorization_context: {
        session_id: "session-prod-001",
        tenant_id: "tenant-prod-001",
        organization_id: "org-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "agent-prod-001",
        roles: ["incident_commander", "therapeutic_proof_broker"],
        source: "synthi_mcp_http_production_runtime",
      },
    });
  });
});

describe("therapeutic production state append parser", () => {
  it("requires schema and tenant scope agreement", () => {
    expect(() => parseTherapeuticStateAppend({
      schema_version: "synthi.dojo.therapeuticProductionStateAppend.v1",
      tenant_scope: {
        tenant_id: "tenant-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "agent-prod-001",
      },
      task_id: "production_incident_response_001",
      state: therapeuticState(),
    }, {
      tenant_id: "tenant-prod-001",
      workspace_id: "other-workspace",
      actor_id: "agent-prod-001",
    })).toThrow("therapeutic_production_tenant_scope_mismatch");
  });

  it("passes through production append payload fields after validation", () => {
    const parsed = parseTherapeuticStateAppend({
      schema_version: "synthi.dojo.therapeuticProductionStateAppend.v1",
      tenant_scope: {
        tenant_id: "tenant-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "agent-prod-001",
        data_region: "us-central1",
      },
      task_id: "production_incident_response_001",
      state: therapeuticState(),
      state_sha256: "f".repeat(64),
      created_at: "2026-07-01T00:00:00.000Z",
      record_id: "record-prod-001",
    }, {
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
    });

    expect(parsed.tenant_scope).toEqual({
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "agent-prod-001",
      data_region: "us-central1",
    });
    expect(parsed.task_id).toBe("production_incident_response_001");
    expect(parsed.state_sha256).toBe("f".repeat(64));
    expect(parsed.record_id).toBe("record-prod-001");
  });
});

function therapeuticState() {
  return {
    schema_version: "synthi.dojo.therapeuticRuntimeState.v1",
    tenant_scope: {
      tenant_id: "tenant-prod-001",
      workspace_id: "workspace-prod-001",
      actor_id: "body-actor",
      data_region: "us-central1",
    },
    trace: {
      task_id: "production_incident_response_001",
      task_kind: "incident_response",
      operator_intent: "restore service",
      requested_action: "restart_healthy_canary",
      narrative: "Production incident probe and scoped remediation.",
      domain: "sre",
      evidence: [],
    },
    store: {
      evidence_records: [],
      audit_records: [],
      grants: [],
      proof_statuses: {},
      proof_decision_records: [],
      checkride_reports: [],
      policy_learning_records: [],
      review_requests: [],
      remediation_verifications: [],
      tenant_scope: {
        tenant_id: "tenant-prod-001",
        workspace_id: "workspace-prod-001",
        actor_id: "body-actor",
        data_region: "us-central1",
      },
    },
    persisted_at: "2026-07-01T00:00:00.000Z",
  };
}

function productionEndpointEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED: "true",
    SYNTHI_THERAPEUTIC_PROD_RUNTIME_AUTH_TOKEN: "runtime-token",
    SYNTHI_THERAPEUTIC_PROD_RUNTIME_SESSION_ID: "session-prod-001",
    SYNTHI_THERAPEUTIC_PROD_TENANT_ID: "tenant-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ORGANIZATION_ID: "org-prod-001",
    SYNTHI_THERAPEUTIC_PROD_WORKSPACE_ID: "workspace-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ACTOR_ID: "agent-prod-001",
    SYNTHI_THERAPEUTIC_PROD_ACTOR_ROLES: "incident_commander,therapeutic_proof_broker",
    SYNTHI_THERAPEUTIC_PROD_POSTGRES_URL: "postgres://control-plane/prod",
    SYNTHI_THERAPEUTIC_PROD_STORE_AUTH_TOKEN: "store-token",
    SYNTHI_THERAPEUTIC_PROD_PROBE_AUTH_TOKEN: "probe-token",
    SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_URL: "https://observability.prod.synthi.ai/probe",
    SYNTHI_THERAPEUTIC_PROD_PROBE_UPSTREAM_AUTH_TOKEN: "upstream-token",
    ...overrides,
  };
}
