import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthCheckpointManager,
  EncryptedFileAuthCheckpointStore,
  InMemoryAuthCheckpointStore,
  createDefaultAuthCheckpointStore,
  authCheckpointManager,
} from "../../src/browser/auth.js";
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
      idp_grants: [
        expect.objectContaining({
          app_origin: "https://app.example.com",
          origin: "https://auth.example-idp.com",
          domain: "auth.example-idp.com",
          source: "topLevelRedirect",
          reason: "oauthState",
          approved_by_user: true,
          cookie_names_hashed: [],
        }),
      ],
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

  it("can share durable metadata through an auth checkpoint store without leaking mutable objects", () => {
    const store = new InMemoryAuthCheckpointStore();
    const firstManager = new AuthCheckpointManager(store);
    const enrollment = firstManager.beginEnrollment("https://app.example.com/settings");
    const result = firstManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/settings",
      redirect_chain: ["https://idp.example.com/login"],
      ttl_ms: 60_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected auth finish failure");
    expect(firstManager.saveStorageArtifact({
      checkpoint_id: result.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "ready", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "ready" }] }],
      },
    }).ok).toBe(true);

    const secondManager = new AuthCheckpointManager(store);
    expect(secondManager.readiness("https://app.example.com/settings", false)).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      durability: "idpCheckpoint",
    }));

    const listed = secondManager.list("https://app.example.com");
    listed[0]?.idp_origins.push("https://mutated.example.com");
    listed[0]?.idp_grants.push({
      checkpoint_id: "mutated",
      app_origin: "https://mutated.example.com",
      origin: "https://mutated.example.com",
      domain: "mutated.example.com",
      source: "userApprovedManual",
      reason: "unknown",
      cookie_names_hashed: ["sha256:mutated"],
      approved_by_user: true,
    });
    listed[0]!.cookie_domain_audit.idp_origin_count = 99;

    expect(firstManager.list("https://app.example.com")[0]).toEqual(expect.objectContaining({
      idp_origins: ["https://idp.example.com"],
      idp_grants: [
        expect.objectContaining({
          origin: "https://idp.example.com",
          domain: "idp.example.com",
          source: "topLevelRedirect",
          reason: "sessionCookie",
          cookie_names_hashed: [],
        }),
      ],
      cookie_domain_audit: expect.objectContaining({ idp_origin_count: 1 }),
    }));
  });

  it("persists checkpoint metadata encrypted and isolated by scope", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-store-"));
    const filePath = path.join(directory, "auth-checkpoints.enc.json");
    const key = `unit-key-${Date.now()}`;
    const scopeA = "tenant-a/workspace-a";
    const scopeB = "tenant-b/workspace-b";
    const managerA = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: scopeA,
    }));
    const enrollment = managerA.beginEnrollment("https://app.example.com/settings");
    const checkpoint = managerA.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/settings",
      redirect_chain: ["https://idp.example.com/login"],
      ttl_ms: 60_000,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error("unexpected auth finish failure");
    const provider = managerA.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: await writeRefreshMintCommand(directory),
      mint_command_admin_approved: true,
    });
    expect(provider.ok).toBe(true);
    if (!provider.ok) throw new Error("unexpected refresh provider failure");
    await managerA.testRefreshProvider(provider.provider.provider_id);
    expect(managerA.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "secret-cookie", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "local-secret" }] }],
      },
    }).ok).toBe(true);

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).toContain("synthi_auth_checkpoint_store_envelope_v1");
    expect(persisted).not.toMatch(/app\.example|idp\.example|auth-refresh|tenant-a|workspace-a|secret-cookie|local-secret/);

    const reloadedA = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: scopeA,
    }));
    expect(reloadedA.readiness("https://app.example.com/settings", false)).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
    }));
    expect(reloadedA.readiness("https://app.example.com/settings", true)).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      durability: "refreshProvider",
    }));

    const isolatedScope = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: scopeB,
    }));
    expect(isolatedScope.readiness("https://app.example.com/settings", false)).toEqual(expect.objectContaining({
      ready: false,
      status: "checkpointMissing",
    }));
  });

  it("writes encrypted auth checkpoint files atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-store-mode-"));
    const filePath = path.join(directory, "auth-checkpoints.enc.json");
    const manager = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key: `unit-mode-key-${Date.now()}`,
      scope_id: "tenant/workspace/mode",
    }));

    const enrollment = manager.beginEnrollment("https://app.example.com/settings");
    const finished = manager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/settings",
      ttl_ms: 60_000,
    });

    expect(finished.ok).toBe(true);
    const fileMode = (await stat(filePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).toContain("synthi_auth_checkpoint_store_envelope_v1");
    expect(persisted).not.toMatch(/app\.example|tenant|workspace/);
  });

  it("stores approved browser auth artifacts encrypted without exposing values in checkpoint metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-store-artifact-"));
    const filePath = path.join(directory, "auth-checkpoints.enc.json");
    const key = `unit-artifact-key-${Date.now()}`;
    const manager = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: "tenant/workspace/auth-artifact",
    }));
    const enrollment = manager.beginEnrollment("https://app.example.com/settings");
    const finished = manager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      app_url: "https://app.example.com/settings",
      redirect_chain: ["https://idp.example.com/login"],
      ttl_ms: 60_000,
    });
    expect(finished.ok).toBe(true);
    if (!finished.ok) throw new Error("unexpected auth finish failure");

    const saved = manager.saveStorageArtifact({
      checkpoint_id: finished.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [
          { name: "sid", value: "secret-cookie-value", domain: "app.example.com", path: "/", httpOnly: true, secure: true },
          { name: "empty", value: "", domain: "app.example.com", path: "/" },
          { name: "idp", value: "secret-idp-cookie", domain: ".idp.example.com", path: "/", secure: true },
          { name: "child", value: "must-not-persist-child", domain: "child.app.example.com", path: "/" },
          { name: "unrelated", value: "must-not-persist", domain: "other.example.com", path: "/" },
        ],
        origins: [
          {
            origin: "https://app.example.com",
            localStorage: [{ name: "sessionToken", value: "local-storage-secret" }],
            sessionStorage: [{ name: "csrf", value: "session-storage-secret" }],
          },
          {
            origin: "https://idp.example.com",
            localStorage: [{ name: "idpSession", value: "idp-local-secret" }],
          },
          {
            origin: "https://other.example.com",
            localStorage: [{ name: "ignored", value: "ignored-secret" }],
          },
        ],
      },
      captured_at: 1234,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("unexpected storage artifact failure");
    expect(saved.storage_artifact).toEqual(expect.objectContaining({
      app_origin: "https://app.example.com",
      origin_count: 2,
      cookie_count: 3,
      local_storage_entry_count: 2,
      session_storage_entry_count: 1,
      captured_at: 1234,
    }));
    expect(saved.checkpoint.idp_grants).toEqual([
      expect.objectContaining({
        origin: "https://idp.example.com",
        domain: "idp.example.com",
        source: "topLevelRedirect",
        reason: "sessionCookie",
        cookie_names_hashed: [expect.stringMatching(/^sha256:[a-f0-9]{64}$/)],
      }),
    ]);
    expect(JSON.stringify(saved.checkpoint.idp_grants)).not.toMatch(/"sid"|"idp"|secret-cookie|secret-idp-cookie/);
    expect(JSON.stringify(saved.checkpoint)).not.toMatch(/secret-cookie|local-storage-secret|session-storage-secret|idp-local-secret|must-not-persist/);

    const artifact = manager.storageArtifactForCheckpoint(finished.checkpoint.checkpoint_id);
    expect(artifact?.state.cookies.map((cookie) => cookie.name).sort()).toEqual(["empty", "idp", "sid"]);
    expect(artifact?.state.origins.map((origin) => origin.origin).sort()).toEqual([
      "https://app.example.com",
      "https://idp.example.com",
    ]);
    expect(JSON.stringify(artifact)).toContain("local-storage-secret");
    expect(JSON.stringify(artifact)).not.toMatch(/must-not-persist/);

    const persisted = await readFile(filePath, "utf8");
    expect(persisted).toContain("synthi_auth_checkpoint_store_envelope_v1");
    expect(persisted).not.toMatch(/app\.example|idp\.example|secret-cookie|local-storage-secret|session-storage-secret|idp-local-secret|tenant|workspace/);

    const reloaded = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: "tenant/workspace/auth-artifact",
    }));
    expect(reloaded.storageArtifactForCheckpoint(finished.checkpoint.checkpoint_id)?.state.origins[0]?.localStorage?.[0]).toEqual({
      name: "sessionToken",
      value: "local-storage-secret",
    });
    const isolated = new AuthCheckpointManager(new EncryptedFileAuthCheckpointStore({
      file_path: filePath,
      key,
      scope_id: "tenant/workspace/other",
    }));
    expect(isolated.storageArtifactForCheckpoint(finished.checkpoint.checkpoint_id)).toBeNull();
  });

  it("creates encrypted auth stores from explicit environment configuration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-store-env-"));
    const filePath = path.join(directory, "auth-checkpoints.enc.json");
    const store = createDefaultAuthCheckpointStore({
      SYNTHI_AUTH_CHECKPOINT_STORE_FILE: filePath,
      SYNTHI_AUTH_CHECKPOINT_STORE_KEY: "unit-env-key",
      SYNTHI_AUTH_CHECKPOINT_SCOPE: "tenant/workspace",
    });
    const manager = new AuthCheckpointManager(store);
    const enrollment = manager.beginEnrollment("https://env.example.com");
    const finished = manager.finishEnrollment({ enrollment_id: enrollment.enrollment_id, ttl_ms: 60_000 });
    expect(finished.ok).toBe(true);
    expect(await readFile(filePath, "utf8")).not.toContain("env.example.com");
  });

  it("blocks unattended runs unless checkpoint durability is refresh-provider or CI auth", () => {
    const enrollment = authCheckpointManager.beginEnrollment("https://app.example.com");
    const result = authCheckpointManager.finishEnrollment({
      enrollment_id: enrollment.enrollment_id,
      ttl_ms: 60_000,
      durability: "interactiveCheckpoint",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected auth finish failure");
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: result.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "ready", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "ready" }] }],
      },
    }).ok).toBe(true);

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
    expect(authCheckpointManager.saveStorageArtifact({
      checkpoint_id: result.checkpoint.checkpoint_id,
      storage_state: {
        cookies: [{ name: "sid", value: "ready", domain: "app.example.com", path: "/" }],
        origins: [{ origin: "https://app.example.com", localStorage: [{ name: "session", value: "ready" }] }],
      },
    }).ok).toBe(true);
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

  it("requires a refresh-provider mint command before unattended readiness", async () => {
    const configured = authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error("unexpected refresh provider config failure");
    const tested = await authCheckpointManager.testRefreshProvider(configured.provider.provider_id);
    expect(tested.ok).toBe(true);
    if (!tested.ok) throw new Error("unexpected refresh provider test failure");

    expect(authCheckpointManager.readiness("https://app.example.com", true)).toEqual(expect.objectContaining({
      ready: false,
      status: "checkpointMissing",
    }));
    expect(tested).toEqual(expect.objectContaining({
      can_mint_replay_state: false,
      provider: expect.objectContaining({
        status: "failed",
        failure_class: "missingMintCommand",
        mint_command_configured: false,
      }),
    }));
  });

  it("allows unattended readiness after a refresh-provider command mints approved storage state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-refresh-"));
    const configured = authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: await writeRefreshMintCommand(directory),
      mint_command_admin_approved: true,
      timeout_ms: 5_000,
    });
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error("unexpected refresh provider config failure");
    const tested = await authCheckpointManager.testRefreshProvider(configured.provider.provider_id);
    expect(tested.ok).toBe(true);
    if (!tested.ok) throw new Error("unexpected refresh provider test failure");

    const readiness = authCheckpointManager.readiness("https://app.example.com", true);
    expect(readiness).toEqual(expect.objectContaining({
      ready: true,
      status: "ready",
      durability: "refreshProvider",
      refresh_provider: expect.objectContaining({
        status: "validated",
        secret_ref: "synthi://secrets/workspace/auth-refresh",
        mint_command_configured: true,
        last_mint_artifact: expect.objectContaining({
          app_origin: "https://app.example.com",
          cookie_count: 1,
          local_storage_entry_count: 1,
        }),
      }),
    }));
    expect(JSON.stringify(readiness)).not.toMatch(/minted-cookie-secret|minted-local-secret|mint-refresh|\.mjs|\/node/);
    expect(tested).toEqual(expect.objectContaining({ can_mint_replay_state: true }));
  });

  it("rejects raw refresh-provider secret values", () => {
    const result = authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "sk-live-secret-value",
    });

    expect(result).toEqual({ ok: false, error: "auth_refresh_provider_secret_ref_required" });
  });

  it("requires internal approval before configuring refresh-provider mint commands", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "synthi-auth-refresh-approval-"));
    const command = await writeRefreshMintCommand(directory);

    expect(authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: command,
    })).toEqual({ ok: false, error: "auth_refresh_provider_mint_command_admin_approval_required" });

    expect(authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: "sh -c 'echo unsafe'",
      mint_command_admin_approved: true,
    })).toEqual({ ok: false, error: "auth_refresh_provider_shell_command_not_allowed" });

    expect(authCheckpointManager.configureRefreshProvider({
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: command,
      mint_command_admin_approved: true,
      working_directory: "relative/path",
    })).toEqual({ ok: false, error: "auth_refresh_provider_working_directory_absolute_required" });
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
    expect((readiness?.structuredContent as { readiness: { status: string } }).readiness.status).toBe("checkpointStorageMissing");

    const revoked = await dispatchAuthTool("synthi_auth_revoke_checkpoint", { checkpoint_id: checkpointId });
    expect((revoked?.structuredContent as { checkpoint: { status: string } }).checkpoint.status).toBe("revoked");

    const providerBeforeApproval = await dispatchAuthTool("synthi_auth_configure_refresh_provider", {
      url: "https://app.example.com",
      secret_ref: "synthi://secrets/workspace/auth-refresh",
      mint_command: await writeRefreshMintCommand(await mkdtemp(path.join(os.tmpdir(), "synthi-auth-tool-refresh-denied-"))),
    });
    expect(providerBeforeApproval?.isError).toBe(true);
    expect(providerBeforeApproval?.structuredContent).toEqual(expect.objectContaining({
      error: "auth_refresh_provider_mint_command_admin_approval_required",
    }));

    const previousCommandConfig = process.env["SYNTHI_AUTH_REFRESH_PROVIDER_COMMAND_CONFIG"];
    process.env["SYNTHI_AUTH_REFRESH_PROVIDER_COMMAND_CONFIG"] = "true";
    try {
      const provider = await dispatchAuthTool("synthi_auth_configure_refresh_provider", {
        url: "https://app.example.com",
        secret_ref: "synthi://secrets/workspace/auth-refresh",
        mint_command: await writeRefreshMintCommand(await mkdtemp(path.join(os.tmpdir(), "synthi-auth-tool-refresh-"))),
      });
      const providerId = (provider?.structuredContent as { provider: { provider_id: string } }).provider.provider_id;
      const tested = await dispatchAuthTool("synthi_auth_test_refresh_provider", { provider_id: providerId });
      expect((tested?.structuredContent as { can_mint_replay_state: boolean; provider: { status: string } })).toEqual(expect.objectContaining({
        can_mint_replay_state: true,
        provider: expect.objectContaining({ status: "validated" }),
      }));
    } finally {
      if (previousCommandConfig === undefined) {
        delete process.env["SYNTHI_AUTH_REFRESH_PROVIDER_COMMAND_CONFIG"];
      } else {
        process.env["SYNTHI_AUTH_REFRESH_PROVIDER_COMMAND_CONFIG"] = previousCommandConfig;
      }
    }

    const listed = await dispatchAuthTool("synthi_auth_list_checkpoints", { url: "https://app.example.com" });
    expect((listed?.structuredContent as { checkpoints: unknown[] }).checkpoints).toHaveLength(2);
    expect(JSON.stringify(listed?.structuredContent)).not.toMatch(/hunter2|secret-token|localStorage|sessionStorage/);
  });
});

async function writeRefreshMintCommand(directory: string): Promise<string> {
  const scriptPath = path.join(directory, `mint-refresh-${Date.now()}.mjs`);
  await writeFile(scriptPath, `
const origin = process.env.SYNTHI_AUTH_APP_ORIGIN;
if (!origin || !process.env.SYNTHI_AUTH_SECRET_REF) process.exit(2);
const host = new URL(origin).hostname;
const output = JSON.stringify({
  ok: true,
  storage_state: {
    cookies: [{ name: "sid", value: "minted-cookie-secret", domain: host, path: "/", httpOnly: true, secure: true }],
    origins: [{ origin, localStorage: [{ name: "session", value: "minted-local-secret" }], sessionStorage: [] }]
  },
  redirect_chain: [origin + "/login"],
  ttl_ms: 60000,
  captured_at: 1234
});
if (process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH, output);
}
process.stdout.write(output);
`, "utf8");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
