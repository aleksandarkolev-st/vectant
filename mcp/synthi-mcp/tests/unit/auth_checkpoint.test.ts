import { beforeEach, describe, expect, it } from "vitest";
import { authCheckpointManager } from "../../src/browser/auth.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { AUTH_TOOL_NAMES, AUTH_TOOLS, dispatchAuthTool } from "../../src/tools/auth.js";

beforeEach(() => {
  authCheckpointManager.resetForTests();
});

describe("auth checkpoint manager", () => {
  it("stores only checkpoint metadata with redirect-chain IdP grants", () => {
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com/settings", "unit-test");
    const result = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/settings",
      redirect_chain: [
        "https://app.example.com/login",
        "https://auth.example-idp.com/oauth",
        "https://auth.example-idp.com/callback",
      ],
      ttl_ms: 60_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected auth finish failure");
    expect(result.checkpoint).toEqual(expect.objectContaining({
      app_origin: "https://app.example.com",
      idp_origins: ["https://auth.example-idp.com"],
      durability: "idpCheckpoint",
      status: "valid",
      unattended_allowed: false,
      cookie_domain_audit: expect.objectContaining({
        idp_origin_count: 1,
        has_third_party_idp: true,
      }),
    }));
    expect(JSON.stringify(result.checkpoint)).not.toMatch(/hunter2|secret-token|localStorage|sessionStorage/i);
  });

  it("blocks unattended runs unless checkpoint durability is refresh-provider or CI auth", () => {
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com");
    const result = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      ttl_ms: 60_000,
      durability: "interactiveCheckpoint",
    });
    expect(result.ok).toBe(true);

    expect(authCheckpointManager.readiness("https://app.example.com/dashboard", false)).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      durability: "interactiveCheckpoint",
    }));
    expect(authCheckpointManager.readiness("https://app.example.com/dashboard", true)).toEqual(expect.objectContaining({
      ready: false,
      status: "unattendedBlocked",
      durability: "interactiveCheckpoint",
    }));
  });

  it("does not let checkpoint enrollment claim provider-backed unattended durability", async () => {
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com");
    const result = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      ttl_ms: 60_000,
      durability: "refreshProvider" as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected auth finish failure");
    expect(result.checkpoint).toEqual(expect.objectContaining({
      durability: "interactiveCheckpoint",
      unattended_allowed: false,
    }));
    expect(authCheckpointManager.readiness("https://app.example.com/dashboard", true)).toEqual(expect.objectContaining({
      ready: false,
      status: "unattendedBlocked",
      durability: "interactiveCheckpoint",
    }));

    const begun = await dispatchAuthTool("synthi_auth_begin_checkpoint_enrollment", {
      url: "https://tool.example.com",
    });
    const enrollmentId = (begun?.structuredContent as { enrollment: { enrollment_id: string } }).enrollment.enrollment_id;
    const finished = await dispatchAuthTool("synthi_auth_finish_checkpoint_enrollment", {
      enrollment_id: enrollmentId,
      ttl_ms: 60_000,
      durability: "ciTestAuth",
    });
    expect(finished?.isError).toBeUndefined();
    expect((finished?.structuredContent as { checkpoint: { durability: string; unattended_allowed: boolean } }).checkpoint).toEqual(expect.objectContaining({
      durability: "interactiveCheckpoint",
      unattended_allowed: false,
    }));
  });

  it("allows unattended readiness for refresh-provider metadata", () => {
    const configured = authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error("unexpected refresh provider config failure");
    const tested = authCheckpointManager.testRefreshProvider(configured.provider.provider_id);
    expect(tested.ok).toBe(true);

    expect(authCheckpointManager.readiness("https://app.example.com", true)).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      durability: "refreshProvider",
      refresh_provider: expect.objectContaining({
        status: "validated",
        secret_ref: "synthi://secrets/workspace/auth-refresh",
      }),
    }));
  });

  it("rejects raw refresh-provider secret values", () => {
    const result = authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "sk-live-secret-value",
    });

    expect(result).toEqual({ ok: false, error: "auth_refresh_provider_secret_ref_required" });
  });

  it("exposes auth checkpoint tools through structured responses", async () => {
    for (const name of AUTH_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(AUTH_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }

    const begun = await dispatchAuthTool("synthi_auth_begin_checkpoint_enrollment", {
      url: "https://app.example.com",
    });
    const enrollmentId = (begun?.structuredContent as { enrollment: { enrollment_id: string } }).enrollment.enrollment_id;

    const finished = await dispatchAuthTool("synthi_auth_finish_checkpoint_enrollment", {
      enrollment_id: enrollmentId,
      redirect_chain: ["https://idp.example.com/login"],
      ttl_ms: 60_000,
    });
    expect(finished?.isError).toBeUndefined();
    const checkpointId = (finished?.structuredContent as { checkpoint: { checkpoint_id: string } }).checkpoint.checkpoint_id;

    const readiness = await dispatchAuthTool("synthi_auth_get_tool_auth_readiness", {
      url: "https://app.example.com/dashboard",
      unattended: true,
    });
    expect((readiness?.structuredContent as { readiness: { status: string } }).readiness.status).toBe("unattendedBlocked");

    const revoked = await dispatchAuthTool("synthi_auth_revoke_checkpoint", { checkpoint_id: checkpointId });
    expect((revoked?.structuredContent as { checkpoint: { status: string } }).checkpoint.status).toBe("revoked");

    const provider = await dispatchAuthTool("synthi_auth_configure_refresh_provider", {
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
    });
    const providerId = (provider?.structuredContent as { provider: { provider_id: string } }).provider.provider_id;
    const tested = await dispatchAuthTool("synthi_auth_test_refresh_provider", { provider_id: providerId });
    expect((tested?.structuredContent as { can_mint_replay_state: boolean; provider: { status: string } })).toEqual(expect.objectContaining({
      can_mint_replay_state: true,
      provider: expect.objectContaining({ status: "validated" }),
    }));

    const listed = await dispatchAuthTool("synthi_auth_list_checkpoints", { url: "https://app.example.com" });
    expect((listed?.structuredContent as { checkpoints: unknown[] }).checkpoints).toHaveLength(1);
    expect(JSON.stringify(listed?.structuredContent)).not.toMatch(/hunter2|secret-token|localStorage|sessionStorage/);
  });
});
