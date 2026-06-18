import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo source drift MCP authorization", () => {
  it("enforces RBAC for production source snapshot capture", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";

    const blocked = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...tenantContextArgs({
        actor_id: "source-snapshot-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-source-snapshot-capture-rbac-blocked",
        correlation_id: "corr-source-snapshot-capture-rbac-blocked",
      }),
      ...sourceSnapshotCaptureArgs({
        app_version: "2026.06.16",
        commit_sha: "commit-source-snapshot-rbac-blocked",
      }),
    });
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_source_snapshot_capture_role_required",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:source:capture|source-registry"]),
      rbac_authorization: expect.objectContaining({
        action: "source_snapshot_capture",
        actor_id: "source-snapshot-viewer",
        required_roles: ["dojo:source:capture", "source-registry"],
        matched_roles: [],
      }),
    }));

    const allowed = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
      ...tenantContextArgs({
        actor_id: "source-snapshot-registry",
        actor_type: "service",
        roles: ["source-registry"],
        request_id: "req-source-snapshot-capture-rbac-allowed",
        correlation_id: "corr-source-snapshot-capture-rbac-allowed",
      }),
      ...sourceSnapshotCaptureArgs({
        app_version: "2026.06.16",
        commit_sha: "commit-source-snapshot-rbac-allowed",
      }),
    });
    expect(allowed?.isError).toBeUndefined();
    expect(allowed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      source_token_count: 1,
      verification: expect.objectContaining({ ok: true, blocked_by: [] }),
      rbac_authorization: expect.objectContaining({
        action: "source_snapshot_capture",
        actor_id: "source-snapshot-registry",
        matched_roles: ["source-registry"],
      }),
    }));
    expect(JSON.stringify(allowed?.structuredContent)).not.toContain(sourceSigningKey());
  });

  it("enforces RBAC for production source drift detection", async () => {
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    const previousSnapshot = await captureSnapshotForDriftRbac("2026.06.16", "submitInvoice:v1");
    const nextSnapshot = await captureSnapshotForDriftRbac("2026.06.17", "submitInvoice:v2");

    const blocked = await dispatchDojoTool("synthi_dojo_detect_source_drift", {
      ...tenantContextArgs({
        actor_id: "source-drift-viewer",
        actor_type: "human",
        roles: ["dojo:governance:view"],
        request_id: "req-source-drift-detection-rbac-blocked",
        correlation_id: "corr-source-drift-detection-rbac-blocked",
      }),
      previous_snapshot: previousSnapshot,
      next_snapshot: nextSnapshot,
      source_snapshot_signing_keys_by_id: { "source-rbac-key": sourceSigningKey() },
      node_bindings: sourceDriftNodeBindings(),
    });
    expect(blocked?.isError).toBe(true);
    expect(blocked?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      error: "dojo_source_drift_detection_role_required",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      blocked_by: expect.arrayContaining(["governance_role_required:dojo:source:review|source-registry"]),
      rbac_authorization: expect.objectContaining({
        action: "source_drift_detection",
        actor_id: "source-drift-viewer",
        required_roles: ["dojo:source:review", "source-registry"],
        matched_roles: [],
      }),
    }));

    const allowed = await dispatchDojoTool("synthi_dojo_detect_source_drift", {
      ...tenantContextArgs({
        actor_id: "source-drift-reviewer",
        actor_type: "service",
        roles: ["dojo:source:review"],
        request_id: "req-source-drift-detection-rbac-allowed",
        correlation_id: "corr-source-drift-detection-rbac-allowed",
      }),
      previous_snapshot: previousSnapshot,
      next_snapshot: nextSnapshot,
      source_snapshot_signing_keys_by_id: { "source-rbac-key": sourceSigningKey() },
      node_bindings: sourceDriftNodeBindings(),
    });
    expect(allowed?.isError).toBeUndefined();
    expect(allowed?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      drifted_token_count: 1,
      affected_node_count: 1,
      license_expiry_trigger_count: 1,
      rbac_authorization: expect.objectContaining({
        action: "source_drift_detection",
        actor_id: "source-drift-reviewer",
        matched_roles: ["dojo:source:review"],
      }),
    }));
  });

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

async function captureSnapshotForDriftRbac(appVersion: string, sourceMaterial: string): Promise<unknown> {
  const response = await dispatchDojoTool("synthi_dojo_capture_source_snapshot", {
    ...tenantContextArgs({
      actor_id: "source-registry-service",
      actor_type: "service",
      roles: ["source-registry"],
      request_id: `req-source-snapshot-${appVersion}`,
      correlation_id: `corr-source-snapshot-${appVersion}`,
    }),
    ...sourceSnapshotCaptureArgs({
      app_version: appVersion,
      commit_sha: `commit-${appVersion}`,
      source_tokens: [sourceToken("submit-invoice", sourceMaterial)],
    }),
  });
  expect(response?.isError).toBeUndefined();
  return (response?.structuredContent as { source_snapshot: unknown }).source_snapshot;
}

function sourceSnapshotCaptureArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_origin: "https://app.example.test",
    app_version: "2026.06.16",
    commit_sha: "commit-source-rbac",
    source_root: "src",
    signer_key_id: "source-rbac-key",
    signing_key: sourceSigningKey(),
    created_at: "2026-06-16T00:00:00.000Z",
    source_tokens: [sourceToken("submit-invoice", "submitInvoice:v1")],
    ...overrides,
  };
}

function sourceToken(tokenId: string, sourceMaterial: string): Record<string, unknown> {
  return {
    token_id: tokenId,
    route: "/invoices/new",
    component: "InvoiceForm",
    action: "submitInvoice",
    source_locator: "src/routes/invoices/InvoiceForm.jsx:88",
    source_sha256: createHash("sha256").update(sourceMaterial).digest("hex"),
    risk: "mutation",
  };
}

function sourceDriftNodeBindings(): Array<Record<string, unknown>> {
  return [
    {
      node_id: "action-submit-invoice",
      source_token_ids: ["submit-invoice"],
      license_id: "license-submit-invoice",
    },
  ];
}

function sourceSigningKey(): string {
  return "source-signing-secret-rbac";
}
