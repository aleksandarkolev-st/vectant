import { describe, expect, it } from "vitest";
import { browserWorkflowDeploymentReadiness } from "../../src/browser/deployment_readiness.js";
import { dispatchBrowserTool } from "../../src/tools/browser.js";

describe("browser workflow deployment readiness", () => {
  it("passes production readiness with hosted runtime, scoped stores, bridge token, and no local CDP env", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, productionReadyEnv());

    expect(readiness.ok).toBe(true);
    expect(readiness.summary.failed).toBe(0);
    expect(readiness.checks.every((check) => check.status !== "fail")).toBe(true);
    expect(readiness.hosted_runtime).toEqual(expect.objectContaining({
      configured: true,
      tenant_id: "tenant-a",
      workspace_id: "tenant-a:workspace-a",
      actor_id: "agent-a",
      workspace_url: "https://app.example.test/workspace/acme",
      origin_allowlist: ["https://app.example.test"],
      session_ttl_ms: 900000,
      runtime_host_class: "remote",
      non_loopback_runtime: true,
    }));
    expect(readiness.dojo_enforcement).toEqual(expect.objectContaining({
      enforcement_mode: "production",
      production_enforcement: true,
      require_durable_store: true,
      require_external_signing: true,
      require_evidence_ledger: true,
    }));
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_production_enforcement", status: "pass" }),
      expect.objectContaining({ id: "dojo_durable_store", status: "pass" }),
      expect.objectContaining({ id: "dojo_external_signing", status: "pass" }),
      expect.objectContaining({ id: "dojo_evidence_ledger", status: "pass" }),
      expect.objectContaining({ id: "hosted_browser_runtime_endpoint", status: "pass" }),
      expect.objectContaining({ id: "hosted_browser_origin_policy", status: "pass" }),
      expect.objectContaining({ id: "hosted_browser_session_policy", status: "pass" }),
      expect.objectContaining({ id: "hosted_browser_tenant_policy", status: "pass" }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/private-tool-secret|auth-store-secret|bridge-secret|session-secret|dojo-signing-secret/);
    expect(JSON.stringify(readiness)).not.toMatch(/SYNTHI_BROWSER_CDP_URL/);
  });

  it("fails production readiness for process-local stores and local CDP leakage", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://runtime.example.test/devtools/browser/session",
      SYNTHI_WORKSPACE_URL: "https://app.example.test/workspace/acme",
      SYNTHI_WORKSPACE_ID: "tenant-a:workspace-a",
      SYNTHI_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/local",
      SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT: "9466",
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "private_workflow_tool_store", status: "fail" }),
      expect.objectContaining({ id: "auth_checkpoint_store", status: "fail" }),
      expect.objectContaining({ id: "local_cdp_env_absent", status: "fail" }),
      expect.objectContaining({ id: "hosted_browser_runtime_endpoint", status: "pass" }),
      expect.objectContaining({ id: "hosted_browser_origin_policy", status: "fail" }),
      expect.objectContaining({ id: "hosted_browser_session_policy", status: "fail" }),
      expect.objectContaining({ id: "hosted_browser_tenant_policy", status: "fail" }),
      expect.objectContaining({ id: "dojo_production_enforcement", status: "fail" }),
      expect.objectContaining({ id: "dojo_durable_store", status: "fail" }),
      expect.objectContaining({ id: "dojo_external_signing", status: "fail" }),
      expect.objectContaining({ id: "dojo_evidence_ledger", status: "fail" }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/127\.0\.0\.1:9222|\/port\/\d+|browser-mcp-live/i);
  });

  it("fails production readiness for invalid Dojo enforcement flag values", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "maybe",
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.dojo_enforcement.invalid_env).toEqual([
      expect.objectContaining({ name: "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT", value: "maybe" }),
    ]);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_enforcement_flag_values", status: "fail" }),
    ]));
  });

  it("fails production readiness when hosted runtime tenant or actor scope is missing", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_TENANT_ID: undefined,
      SYNTHI_AGENT_ID: undefined,
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "hosted_browser_tenant_policy",
        status: "fail",
      }),
    ]));
  });

  it("fails production readiness when hosted runtime points at a loopback endpoint", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools/browser/session",
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.hosted_runtime).toEqual(expect.objectContaining({
      runtime_host_class: "loopback",
      non_loopback_runtime: false,
    }));
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "hosted_browser_runtime_endpoint",
        status: "fail",
        message: expect.stringContaining("loopback"),
      }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/127\.0\.0\.1:9222/);
  });

  it("fails production readiness when Dojo proof signing falls back to the default local key", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PROOF_SIGNING_KEY: "synthi-dojo-local-development-signing-key",
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_external_signing", status: "fail" }),
    ]));
  });

  it("passes production readiness with explicit Ed25519 proof signing material", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "ed25519-local",
      SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "ed-key-a",
      SYNTHI_DOJO_PROOF_SIGNING_KEY: undefined,
      SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----",
      SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM: "-----BEGIN PUBLIC KEY-----\nredacted\n-----END PUBLIC KEY-----",
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dojo_external_signing",
        status: "pass",
        configured_env: expect.arrayContaining([
          "SYNTHI_DOJO_PROOF_SIGNING_PROVIDER",
          "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID",
          "SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM",
          "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM",
        ]),
      }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/BEGIN PRIVATE KEY|BEGIN PUBLIC KEY|redacted/);
  });

  it("passes production readiness with external command proof signing and public verifier material", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "external-command",
      SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "external-ed-key-a",
      SYNTHI_DOJO_PROOF_SIGNING_KEY: undefined,
      SYNTHI_DOJO_PROOF_SIGNING_COMMAND: "/usr/local/bin/dojo-proof-signer",
      SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS: "[\"--tenant\",\"tenant-a\"]",
      SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM: "-----BEGIN PUBLIC KEY-----\nredacted\n-----END PUBLIC KEY-----",
      SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM: undefined,
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "dojo_external_signing",
        status: "pass",
        configured_env: expect.arrayContaining([
          "SYNTHI_DOJO_PROOF_SIGNING_PROVIDER",
          "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID",
          "SYNTHI_DOJO_PROOF_SIGNING_COMMAND",
          "SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS",
          "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM",
        ]),
      }),
    ]));
    expect(JSON.stringify(readiness)).not.toMatch(/dojo-proof-signer|BEGIN PUBLIC KEY|redacted/);
  });

  it("fails production readiness for incomplete external command proof signing", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "external-command",
      SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "external-ed-key-a",
      SYNTHI_DOJO_PROOF_SIGNING_KEY: undefined,
      SYNTHI_DOJO_PROOF_SIGNING_COMMAND: "/usr/local/bin/dojo-proof-signer",
      SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM: undefined,
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_external_signing", status: "fail" }),
    ]));
  });

  it("fails production readiness for incomplete Ed25519 proof signing material", () => {
    const readiness = browserWorkflowDeploymentReadiness({}, {
      ...productionReadyEnv(),
      SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "ed25519-local",
      SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "ed-key-a",
      SYNTHI_DOJO_PROOF_SIGNING_KEY: undefined,
      SYNTHI_DOJO_PROOF_SIGNING_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----",
      SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM: undefined,
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dojo_external_signing", status: "fail" }),
    ]));
  });

  it("exposes a redacted MCP tool report without secret values", async () => {
    const originalEnv = { ...process.env };
    try {
      Object.assign(process.env, productionReadyEnv());
      delete process.env.SYNTHI_BROWSER_CDP_URL;

      const response = await dispatchBrowserTool("synthi_browser_get_deployment_readiness", { mode: "production" });
      expect(response?.isError).not.toBe(true);
      const text = response?.content?.[0]?.type === "text" ? response.content[0].text : "";
      expect(text).toContain("synthi.browserWorkflowDeploymentReadiness.v1");
      expect(text).toContain("synthi.dojo.enforcementConfig.v1");
      expect(text).not.toMatch(/private-tool-secret|auth-store-secret|bridge-secret|session-secret|dojo-signing-secret/);
    } finally {
      process.env = originalEnv;
    }
  });
});

function productionReadyEnv(): NodeJS.ProcessEnv {
  return {
    SYNTHI_HOSTED_BROWSER_CDP_URL: "wss://runtime.example.test/devtools/browser/session-secret",
    SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://app.example.test/workspace/acme",
    SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: "https://app.example.test",
    SYNTHI_HOSTED_BROWSER_SESSION_TTL_MS: "900000",
    SYNTHI_TENANT_ID: "tenant-a",
    SYNTHI_AGENT_ID: "agent-a",
    SYNTHI_WORKSPACE_ID: "tenant-a:workspace-a",
    SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE: "/var/lib/synthi/private-tools.enc.json",
    SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY: "private-tool-secret",
    SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE: "tenant-a:workspace-a",
    SYNTHI_AUTH_CHECKPOINT_STORE_FILE: "/var/lib/synthi/auth-checkpoints.enc.json",
    SYNTHI_AUTH_CHECKPOINT_STORE_KEY: "auth-store-secret",
    SYNTHI_AUTH_CHECKPOINT_SCOPE: "tenant-a:workspace-a",
    SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL: "https://workflow-bridge.example.test",
    SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN: "bridge-secret",
    SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "1",
    SYNTHI_DOJO_REQUIRE_DURABLE_STORE: "1",
    SYNTHI_DOJO_STORE_FILE: "/var/lib/synthi/dojo.enc.json",
    SYNTHI_DOJO_STORE_KEY: "dojo-store-secret",
    SYNTHI_DOJO_STORE_SCOPE: "tenant-a:workspace-a",
    SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING: "1",
    SYNTHI_DOJO_PROOF_SIGNING_PROVIDER: "test-kms",
    SYNTHI_DOJO_PROOF_SIGNING_KEY_ID: "dojo-prod-key-1",
    SYNTHI_DOJO_PROOF_SIGNING_KEY: "dojo-signing-secret",
    SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER: "1",
    SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: "postgres://dojo-evidence-ledger",
  };
}
