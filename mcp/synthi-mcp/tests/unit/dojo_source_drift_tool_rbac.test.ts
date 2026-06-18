import { afterEach, describe, expect, it } from "vitest";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo source drift MCP authorization", () => {
  it("enforces RBAC for production source drift expiry application", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const sourceDriftReport = validSourceDriftReport();

    const blocked = await dispatchDojoTool("synthi_dojo_apply_source_drift_expiry", {
      ...tenantContextArgs({
        actor_id: "source-drift-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-source-drift-expiry-rbac-blocked",
        correlation_id: "corr-source-drift-expiry-rbac-blocked",
      }),
      source_drift_report: sourceDriftReport,
    });
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_source_drift_expiry_role_required",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      app_origin: "https://app.example.test",
      previous_snapshot_id: "snapshot-prev",
      next_snapshot_id: "snapshot-next",
      affected_node_count: 0,
      license_expiry_trigger_count: 0,
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:source:apply"]),
      rbac_authorization: expect.objectContaining({
        action: "source_drift_expiry",
        actor_id: "source-drift-viewer",
        required_roles: ["dojo:source:apply"],
        matched_roles: [],
      }),
    }));

    const allowed = await dispatchDojoTool("synthi_dojo_apply_source_drift_expiry", {
      ...tenantContextArgs({
        actor_id: "source-drift-operator",
        actor_type: "service",
        roles: ["dojo:source:apply"],
        request_id: "req-source-drift-expiry-rbac-allowed",
        correlation_id: "corr-source-drift-expiry-rbac-allowed",
      }),
      source_drift_report: sourceDriftReport,
    });
    expect(allowed?.isError).toBeUndefined();
    expect(allowed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      control_plane_source: "compatibility_registry",
      dry_run: true,
      would_expire_license_count: 0,
      rbac_authorization: expect.objectContaining({
        action: "source_drift_expiry",
        actor_id: "source-drift-operator",
        matched_roles: ["dojo:source:apply"],
      }),
      source_drift_expiry_application: expect.objectContaining({
        schema_version: "synthi.dojo.sourceDriftExpiryApplication.v1",
        app_origin: "https://app.example.test",
        trigger_count: 0,
        expired_license_count: 0,
        ok: true,
      }),
    }));
  });
});

function tenantContextArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: "tenant-a",
    organization_id: "org-a",
    workspace_id: "workspace-a",
    actor_id: "source-drift-actor",
    actor_type: "service",
    roles: ["dojo:source:apply"],
    request_id: "req-source-drift-expiry",
    correlation_id: "corr-source-drift-expiry",
    ...overrides,
  };
}

function validSourceDriftReport(): Record<string, unknown> {
  return {
    schema_version: "synthi.dojo.sourceDriftReport.v1",
    previous_snapshot_id: "snapshot-prev",
    next_snapshot_id: "snapshot-next",
    app_origin: "https://app.example.test",
    previous_app_version: "2026.06.16",
    next_app_version: "2026.06.17",
    drifted_token_ids: [],
    added_token_ids: [],
    review_required_token_ids: [],
    affected_nodes: [],
    license_expiry_triggers: [],
  };
}
