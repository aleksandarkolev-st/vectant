import { describe, expect, it, vi } from "vitest";

import {
  publicLocalSupportPolicy,
  readDurableLocalSupportPolicy,
  updateDurableLocalSupportPolicy,
} from "./policyStore";

describe("durable local support policy", () => {
  it("overrides environment defaults with immediate persistent kill switches", async () => {
    const stored = {
      globalEnabled: true,
      orgDisabled: false,
      pairingDisabled: false,
      previewDisabled: true,
      agentAccessDisabled: true,
      minAppVersion: "0.2.0",
      vulnerableVersionsJson: "[\"0.1.0\"]",
      retentionDays: 14,
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const policy = await readDurableLocalSupportPolicy({}, {
      localSupportPolicyState: { findUnique: vi.fn(async () => stored) },
    });

    expect(policy).toMatchObject({
      enabled: true,
      min_app_version: "0.2.0",
      vulnerable_versions: ["0.1.0"],
      emergency_controls: { preview_gateway_disabled: true, agent_access_disabled: true },
      mvp: { browser_preview_enabled: false, agent_preview_read_enabled: false },
      retention: { cloud_security_event_days: 14 },
      persistent_policy: true,
    });
  });

  it("validates and upserts an exact admin policy update", async () => {
    const upsert = vi.fn(async ({ create }) => ({ ...create, updatedAt: new Date() }));
    const client = {
      localSupportPolicyState: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    };
    const result = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      global_enabled: true,
      pairing_disabled: true,
      min_app_version: "0.2.0",
      vulnerable_versions: ["0.1.0"],
      retention_days: 14,
    }, "admin_1", client);

    expect(result).toMatchObject({
      decision: "policy_updated",
      global_enabled: true,
      pairing_disabled: true,
      min_app_version: "0.2.0",
      bytes_sent: 0,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ updatedBy: "admin_1", vulnerableVersionsJson: "[\"0.1.0\"]" }),
    }));
  });

  it("keeps explicit environment emergency controls stricter than durable state", async () => {
    const policy = await readDurableLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "false",
      VECTANT_LOCAL_SUPPORT_ORG_DISABLED: "true",
      VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION: "0.4.0",
      VECTANT_LOCAL_SUPPORT_VULNERABLE_VERSIONS: "0.3.0",
      VECTANT_LOCAL_SUPPORT_NO_RETENTION: "true",
    }, {
      localSupportPolicyState: { findUnique: vi.fn(async () => ({
        globalEnabled: true,
        orgDisabled: false,
        pairingDisabled: false,
        previewDisabled: false,
        agentAccessDisabled: false,
        minAppVersion: "0.2.0",
        vulnerableVersionsJson: "[\"0.1.0\"]",
        retentionDays: 14,
        updatedAt: new Date("2030-01-01T00:00:00.000Z"),
      })) },
    });

    expect(policy).toMatchObject({
      enabled: false,
      global_enabled: false,
      org_kill_switch: true,
      min_app_version: "0.4.0",
      vulnerable_versions: ["0.3.0", "0.1.0"],
      retention: { local_activity_days: 0, cloud_security_event_days: 0 },
    });
  });

  it("preserves an explicit no-retention policy", async () => {
    const upsert = vi.fn(async ({ create }) => ({ ...create, updatedAt: new Date() }));
    const result = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      retention_days: 0,
    }, "admin_1", {
      localSupportPolicyState: {
        findUnique: vi.fn(async () => null),
        upsert,
      },
    });

    expect(result).toMatchObject({ decision: "policy_updated", retention_days: 0 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ retentionDays: 0 }),
    }));
  });

  it("stores and resolves an organization policy without changing global policy", async () => {
    const global = {
      id: "global",
      orgId: null,
      globalEnabled: true,
      orgDisabled: false,
      pairingDisabled: false,
      previewDisabled: false,
      agentAccessDisabled: true,
      minAppVersion: "0.1.0",
      vulnerableVersionsJson: "[]",
      retentionDays: 30,
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const scoped = {
      ...global,
      id: "org_org_acme",
      orgId: "org_acme",
      orgDisabled: true,
      updatedAt: new Date("2030-01-02T00:00:00.000Z"),
    };
    const findUnique = vi.fn(async ({ where }) => {
      if (where.id === "global") return global;
      if (where.id === "org_org_acme") return null;
      if (where.orgId === "org_acme") return scoped;
      return null;
    });
    const upsert = vi.fn(async ({ create }) => ({ ...create, ...scoped }));
    const client = { localSupportPolicyState: { findUnique, upsert } };

    const updated = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      org_id: "org_acme",
      org_disabled: true,
    }, "admin_1", client);
    expect(updated).toMatchObject({ policy_id: "org_org_acme", org_id: "org_acme", org_disabled: true });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "org_org_acme" },
      create: expect.objectContaining({ id: "org_org_acme", orgId: "org_acme" }),
    }));

    const policy = await readDurableLocalSupportPolicy({}, client, "org_acme");
    expect(policy).toMatchObject({ org_id: "org_acme", enabled: false, org_kill_switch: true });
  });

  it("keeps stricter global controls authoritative over organization policy", async () => {
    const global = {
      id: "global",
      orgId: null,
      globalEnabled: false,
      orgDisabled: false,
      pairingDisabled: true,
      previewDisabled: true,
      agentAccessDisabled: true,
      minAppVersion: "0.4.0",
      vulnerableVersionsJson: "[\"0.2.0\"]",
      retentionDays: 7,
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const scoped = {
      ...global,
      id: "org_org_acme",
      orgId: "org_acme",
      globalEnabled: true,
      pairingDisabled: false,
      previewDisabled: false,
      agentAccessDisabled: false,
      minAppVersion: "0.1.0",
      vulnerableVersionsJson: "[\"0.3.0\"]",
      retentionDays: 30,
    };
    const findUnique = vi.fn(async ({ where }) => {
      if (where.id === "global") return global;
      if (where.orgId === "org_acme") return scoped;
      return null;
    });

    const policy = await readDurableLocalSupportPolicy({}, {
      localSupportPolicyState: { findUnique },
    }, "org_acme");

    expect(policy).toMatchObject({
      enabled: false,
      global_enabled: false,
      pairing_disabled: true,
      min_app_version: "0.4.0",
      vulnerable_versions: ["0.2.0", "0.3.0"],
      retention: { local_activity_days: 7, cloud_security_event_days: 7 },
      emergency_controls: { preview_gateway_disabled: true, agent_access_disabled: true },
      mvp: { browser_preview_enabled: false },
    });
  });

  it("allows an organization to disable itself without overriding global enablement", async () => {
    const global = {
      id: "global",
      orgId: null,
      globalEnabled: true,
      orgDisabled: false,
      pairingDisabled: false,
      previewDisabled: false,
      agentAccessDisabled: true,
      minAppVersion: "0.1.0",
      vulnerableVersionsJson: "[]",
      retentionDays: 30,
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const scoped = { ...global, id: "org_org_acme", orgId: "org_acme", globalEnabled: false };
    const findUnique = vi.fn(async ({ where }) => {
      if (where.id === "global") return global;
      if (where.orgId === "org_acme") return scoped;
      return null;
    });

    const policy = await readDurableLocalSupportPolicy({}, {
      localSupportPolicyState: { findUnique },
    }, "org_acme");

    expect(policy).toMatchObject({ enabled: false, global_enabled: false, org_id: "org_acme" });
  });

  it("rejects malformed organization policy scopes", async () => {
    const result = await updateDurableLocalSupportPolicy({
      action: "update_policy",
      org_id: "org/acme",
      org_disabled: true,
    }, "admin_1", { localSupportPolicyState: { findUnique: vi.fn() } });
    expect(result).toMatchObject({ decision: "denied", reason: "invalid_org_id" });
  });

  it("projects policy for browsers without secrets or private device restrictions", () => {
    const projected = publicLocalSupportPolicy({
      enabled: true,
      org_id: "org_acme",
      device_proof_secret: "device-secret",
      account_id: "acct_private",
      device_fingerprint: "sha256:private",
      revoked_sessions: ["sess_private"],
      revoked_devices: ["sha256:private"],
      emergency_controls: {
        feature_disabled: false,
        org_disabled: false,
        preview_gateway_disabled: false,
        pairing_disabled: false,
        agent_access_disabled: true,
        vulnerable_version_blocklist: ["0.1.0"],
        revoked_sessions: ["sess_private"],
      },
      mvp: { fast_support_enabled: true, fast_support_ttl_minutes: 30 },
    });
    expect(projected).toMatchObject({ org_id: "org_acme", mvp: { fast_support_enabled: true } });
    expect(JSON.stringify(projected)).not.toContain("device-secret");
    expect(JSON.stringify(projected)).not.toContain("sess_private");
    expect(projected).not.toHaveProperty("device_proof_secret");
    expect(projected).not.toHaveProperty("account_id");
  });

  it("allowlists nested public policy fields instead of forwarding internal metadata", () => {
    const projected = publicLocalSupportPolicy({
      enabled: true,
      retention: {
        local_activity_days: 14,
        cloud_security_event_days: 7,
        raw_bodies_allowed: true,
        export_available: true,
        internal_storage_path: "C:\\Users\\private\\audit.json",
        device_proof_secret: "nested-secret",
      },
      mvp: {
        fast_support_enabled: true,
        fast_support_ttl_minutes: 12,
        fast_support_scope: "safe_metadata_one_workspace",
        internal_feature_flag: "private-value",
      },
    });

    expect(projected).toMatchObject({
      retention: { local_activity_days: 14, cloud_security_event_days: 7, export_available: true },
      mvp: {
        fast_support_enabled: true,
        fast_support_ttl_minutes: 12,
        agent_read_enabled: false,
        shell_commands: false,
      },
    });
    expect(projected.retention.raw_bodies_allowed).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("audit.json");
    expect(JSON.stringify(projected)).not.toContain("nested-secret");
    expect(JSON.stringify(projected)).not.toContain("private-value");
    expect(projected.retention).not.toHaveProperty("internal_storage_path");
    expect(projected.mvp).not.toHaveProperty("internal_feature_flag");
  });
});
