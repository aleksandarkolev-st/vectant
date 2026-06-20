// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
  buildDojoMcpHostConformanceConfig,
  buildMcpHttpHeaders,
  classifyMcpHost,
  deploymentObservationsFromReadiness,
  DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS,
  HttpJsonRpcClient,
  isExpectedBlockedToolCall,
  MCP_STREAMABLE_HTTP_ACCEPT,
  mcpHostConformance,
  observesLicensedSkillFiltering,
  redactConformanceReport,
  resolveMcpCommandSpec,
  selectDojoCompetencyForConformance,
} from "../../scripts/dojo-mcp-host-conformance.mjs";

describe("Dojo MCP host conformance harness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests both JSON and event-stream for MCP Streamable HTTP", () => {
    expect(MCP_STREAMABLE_HTTP_ACCEPT).toBe("application/json, text/event-stream");
    expect(buildMcpHttpHeaders({ mcpSessionId: "session-123" })).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "session-123",
    });
  });

  it("reuses the MCP Streamable HTTP session returned by initialize", async () => {
    const seenHeaders: Record<string, string>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_endpoint, init) => {
      seenHeaders.push(init.headers);
      if (seenHeaders.length === 1) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "test" } } }), {
          status: 200,
          headers: { "mcp-session-id": "session-123" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), { status: 200 });
    });

    const client = new HttpJsonRpcClient({
      endpoint: "https://mcp.example.test/dojo/mcp",
      bearerToken: "app-token",
      bearerHeader: "X-Synthi-Dojo-Mcp-Token",
      iapBearerToken: "iap-token",
      timeoutMs: 1000,
    });

    await client.request("initialize", {});
    await client.request("tools/list", {});

    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0]["mcp-session-id"]).toBeUndefined();
    expect(seenHeaders[1]["mcp-session-id"]).toBe("session-123");
    expect(seenHeaders[1].authorization).toBe("Bearer iap-token");
    expect(seenHeaders[1]["x-synthi-dojo-mcp-token"]).toBe("Bearer app-token");
  });

  it("classifies MCP host URLs without treating loopback as deployed", () => {
    expect(classifyMcpHost("http://127.0.0.1:3000/mcp")).toBe("loopback");
    expect(classifyMcpHost("http://localhost:3000/mcp")).toBe("loopback");
    expect(classifyMcpHost("http://0.0.0.0:3000/mcp")).toBe("local-bind");
    expect(classifyMcpHost("http://10.0.0.12:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://172.16.0.12:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://172.31.255.12:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://172.32.0.12:3000/mcp")).toBe("remote");
    expect(classifyMcpHost("http://192.168.1.12:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://100.64.0.12:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://169.254.1.12:3000/mcp")).toBe("link-local");
    expect(classifyMcpHost("http://[fd00::1]:3000/mcp")).toBe("private-network");
    expect(classifyMcpHost("http://[fe80::1]:3000/mcp")).toBe("link-local");
    expect(classifyMcpHost("ws://mcp.example.test/session")).toBe("unsupported-url");
    expect(classifyMcpHost("https://mcp.example.test/mcp")).toBe("remote");
  });

  it("requires a non-loopback HTTP host when deployed host conformance is enabled", () => {
    expect(mcpHostConformance({
      transport: "http-json-rpc",
      mcpHostUrl: "https://mcp.example.test/mcp",
      requireNonLoopbackMcpHost: true,
    })).toEqual({
      ok: true,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: true,
      mcp_host_class: "remote",
    });
    expect(mcpHostConformance({
      transport: "http-json-rpc",
      mcpHostUrl: "http://127.0.0.1:3000/mcp",
      requireNonLoopbackMcpHost: true,
    })).toEqual({
      ok: false,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: false,
      mcp_host_class: "loopback",
    });
    expect(mcpHostConformance({
      transport: "http-json-rpc",
      mcpHostUrl: "http://10.0.0.12:3000/mcp",
      requireNonLoopbackMcpHost: true,
    })).toEqual({
      ok: false,
      transport: "http-json-rpc",
      require_non_loopback_mcp_host: true,
      non_loopback_mcp_host: false,
      mcp_host_class: "private-network",
    });
  });

  it("can treat a custom stdio wrapper as an explicit deployed-host path only when allowed", () => {
    const defaultSpec = resolveMcpCommandSpec({
      args: {},
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });
    const customSpec = resolveMcpCommandSpec({
      args: { "mcp-command": "synthi-mcp-host-wrapper", "mcp-args-json": "[\"--stdio\"]" },
      env: {},
      defaultCommand: "/usr/bin/node",
      defaultArgs: ["/repo/mcp/synthi-mcp/dist/index.js"],
      defaultCwd: "/repo/mcp/synthi-mcp",
    });

    expect(mcpHostConformance({
      transport: "stdio",
      commandSpec: defaultSpec,
      requireNonLoopbackMcpHost: true,
      allowCustomStdioHost: true,
    })).toEqual(expect.objectContaining({
      ok: false,
      mcp_host_class: "repo-stdio",
      custom_stdio_host: false,
    }));
    expect(mcpHostConformance({
      transport: "stdio",
      commandSpec: customSpec,
      requireNonLoopbackMcpHost: true,
      allowCustomStdioHost: true,
    })).toEqual(expect.objectContaining({
      ok: true,
      mcp_host_class: "custom-stdio",
      custom_stdio_host: true,
    }));
  });

  it("builds config from host env and structured JSON arguments", () => {
    const config = buildDojoMcpHostConformanceConfig({
      args: {
        "tool-args-json": "{\"workspace_id\":\"acme\"}",
        "context-claims-json": "{\"workspace_verified\":true}",
        "evidence-claims-json": "[{\"claim\":\"checkride_passed\",\"satisfied\":true}]",
        "evidence-record-ids": "evidence-a,evidence-b",
        "ledger-checkpoint-hash": "a".repeat(64),
        "evidence-max-age-ms": "60000",
        "require-verified-evidence": "1",
        "require-external-control-plane-store": "1",
        "external-control-plane-store": "1",
        "require-external-proof-signing": "1",
        "external-proof-signing": "1",
        "require-bridge-token": "1",
        "bridge-token-required": "1",
        "require-no-local-cdp": "1",
        "no-local-cdp-leakage": "1",
        "require-licensed-skill-filtering": "1",
        "licensed-skill-filtering": "1",
        "revocation-evidence-refs": "evidence-a,evidence-b",
      },
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "https://mcp.example.test/mcp",
        SYNTHI_DOJO_MCP_BEARER_TOKEN: "test-token",
        SYNTHI_DOJO_MCP_BEARER_HEADER: "X-Synthi-Dojo-Mcp-Token",
        SYNTHI_DOJO_MCP_IAP_BEARER_TOKEN: "iap-token",
        SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_NON_LOOPBACK_HOST: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_ACTOR_ID: "host-conformance-operator",
      },
    });

    expect(config.host.transport).toBe("http-json-rpc");
    expect(config.host.mcpHostUrl).toBe("https://mcp.example.test/mcp");
    expect(config.host.bearerHeader).toBe("x-synthi-dojo-mcp-token");
    expect(config.host.iapBearerToken).toBe("iap-token");
    expect(config.host.requireNonLoopbackMcpHost).toBe(true);
    expect(config.contextClaims).toEqual({ workspace_verified: true });
    expect(config.toolArgs).toEqual({ workspace_id: "acme" });
    expect(config.evidenceClaims).toEqual([{ claim: "checkride_passed", satisfied: true }]);
    expect(config.evidenceRecordIds).toEqual(["evidence-a", "evidence-b"]);
    expect(config.ledgerCheckpointHash).toBe("a".repeat(64));
    expect(config.evidenceMaxAgeMs).toBe(60000);
    expect(config.requireVerifiedEvidence).toBe(true);
    expect(config.requireExternalControlPlaneStore).toBe(true);
    expect(config.externalControlPlaneStore).toBe(true);
    expect(config.requireExternalProofSigning).toBe(true);
    expect(config.externalProofSigning).toBe(true);
    expect(config.requireBridgeToken).toBe(true);
    expect(config.bridgeTokenRequired).toBe(true);
    expect(config.requireNoLocalCdp).toBe(true);
    expect(config.noLocalCdpLeakage).toBe(true);
    expect(config.requireLicensedSkillFiltering).toBe(true);
    expect(config.licensedSkillFiltering).toBe(true);
    expect(config.revocationActorId).toBe("host-conformance-operator");
    expect(config.revocationActorType).toBe("service");
    expect(config.revocationEvidenceRefs).toEqual(["evidence-a", "evidence-b"]);
  });

  it("requires a separate app bearer header when IAP also uses Authorization", () => {
    expect(() => buildDojoMcpHostConformanceConfig({
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "https://mcp.example.test/mcp",
        SYNTHI_DOJO_MCP_BEARER_TOKEN: "app-token",
        SYNTHI_DOJO_MCP_IAP_BEARER_TOKEN: "iap-token",
      },
    })).toThrow("dojo_mcp_bearer_header_conflicts_with_iap_authorization");

    expect(buildDojoMcpHostConformanceConfig({
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "https://mcp.example.test/mcp",
        SYNTHI_DOJO_MCP_BEARER_TOKEN: "app-token",
        SYNTHI_DOJO_MCP_BEARER_HEADER: "X-Synthi-Dojo-Mcp-Token",
        SYNTHI_DOJO_MCP_IAP_BEARER_TOKEN: "iap-token",
      },
    }).host).toEqual(expect.objectContaining({
      bearerHeader: "x-synthi-dojo-mcp-token",
      bearerToken: "app-token",
      iapBearerToken: "iap-token",
    }));
  });

  it("selects an unambiguous published Dojo competency for conformance", () => {
    const competencies = [
      { skill_id: "skill_a", workflow_id: "workflow_a", published_tool_name: "synthi_app_a" },
      { skill_id: "skill_b", workflow_id: "workflow_b", published_tool_name: "synthi_app_b" },
    ];

    expect(selectDojoCompetencyForConformance(competencies, { skillId: "skill_b" }).published_tool_name).toBe("synthi_app_b");
    expect(selectDojoCompetencyForConformance(competencies, { workflowId: "workflow_a" }).skill_id).toBe("skill_a");
    expect(selectDojoCompetencyForConformance(competencies, { publishedToolName: "synthi_app_b" }).skill_id).toBe("skill_b");
    expect(() => selectDojoCompetencyForConformance(competencies, {})).toThrow("dojo_competency_ambiguous");
    expect(() => selectDojoCompetencyForConformance([{ skill_id: "draft" }], {})).toThrow("dojo_competency_missing");
  });

  it("detects expected blocks for raw backing calls and revoked proofs", () => {
    expect(isExpectedBlockedToolCall({
      isError: false,
      parsed: { ok: false, error: "dojo_proof_capsule_required", error_codes: ["proof_capsule_missing"] },
    }, ["dojo_proof_capsule_required"])).toBe(true);
    expect(isExpectedBlockedToolCall({
      isError: false,
      parsed: { ok: false, license_kernel: { ok: false, blocked_by: ["proof_capsule_revoked"] } },
    }, ["proof_capsule_revoked"])).toBe(true);
    expect(isExpectedBlockedToolCall({
      isError: false,
      parsed: { ok: true },
    }, ["proof_capsule_revoked"])).toBe(false);
  });

  it("derives deployment observations from host readiness instead of deployment claims", () => {
    const readiness = {
      ok: true,
      checks: [
        { id: "dojo_durable_store", status: "pass", configured_env: ["SYNTHI_DOJO_CONTROL_PLANE_STORE"] },
        { id: "dojo_external_signing", status: "pass", configured_env: ["SYNTHI_DOJO_PROOF_SIGNING_PROVIDER"] },
        {
          id: "browser_workflow_bridge",
          status: "pass",
          configured_env: ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL", "SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN"],
        },
        { id: "local_cdp_env_absent", status: "pass", configured_env: [] },
        { id: "hosted_browser_runtime_endpoint", status: "pass", configured_env: ["SYNTHI_HOSTED_BROWSER_CDP_URL"] },
        { id: "dojo_evidence_ledger", status: "pass", configured_env: ["SYNTHI_DOJO_EVIDENCE_LEDGER_STORE"] },
        { id: "dojo_mcp_manifest_signing", status: "pass", configured_env: ["SYNTHI_DOJO_MCP_MANIFEST_KEY_ID"] },
      ],
    };

    expect(deploymentObservationsFromReadiness(readiness)).toEqual(expect.objectContaining({
      source: "synthi_browser_get_deployment_readiness",
      readiness_ok: true,
      external_control_plane_store: true,
      external_proof_signing: true,
      bridge_token_required: true,
      no_local_cdp_leakage: true,
      hosted_runtime_non_loopback: true,
      evidence_ledger: true,
      mcp_manifest_signing: true,
      licensed_skill_filtering: false,
    }));
    expect(deploymentObservationsFromReadiness({
      ok: true,
      checks: [
        { id: "browser_workflow_bridge", status: "pass", configured_env: ["SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL"] },
      ],
    }).bridge_token_required).toBe(false);
  });

  it("observes licensed skill filtering from the returned competency shape", () => {
    expect(observesLicensedSkillFiltering([
      {
        skill_id: "skill_a",
        published_tool_name: "synthi_app_a",
        license: { license_id: "license_a" },
        mcp_skill_manifest: { signature: "ed25519:test" },
      },
    ])).toBe(true);
    expect(observesLicensedSkillFiltering([
      {
        skill_id: "draft",
        published_tool_name: "",
        license: null,
      },
    ])).toBe(false);
  });

  it("refuses to write reports containing proof secret material", () => {
    expect(() => redactConformanceReport({
      proof_capsule: { signature: "hmac-sha256:deadbeef" },
    })).toThrow("dojo_mcp_host_conformance_report_contains_secret_material");
    expect(redactConformanceReport({
      proof_capsule_id: "capsule_123",
      conformance: { ok: true },
    })).toEqual({
      proof_capsule_id: "capsule_123",
      conformance: { ok: true },
    });
  });

  it("summarizes release-gate steps and skipped raw backing checks", () => {
    const requiredGate = buildConformanceReleaseGateSummary({
      config: { raw_backing_tool_required: true },
      deployment_claims: fullDeploymentClaims(),
      deployment_observations: fullDeploymentObservations(),
      steps: [
        { name: "initialize", ok: true },
        { name: "required Dojo tool surface advertised", ok: true },
        { name: "observe production deployment readiness", ok: true },
        { name: "select published Dojo competency", ok: true },
        { name: "issue proof capsule", ok: true },
        { name: "validate proof capsule", ok: true },
        { name: "dry-run proof-gated Dojo skill", ok: true },
        { name: "raw backing tool blocked outside Dojo proof path", ok: true },
        { name: "revoke proof capsule", ok: true },
        { name: "revoked proof validation blocked", ok: true },
        { name: "revoked proof run blocked", ok: true },
      ],
    });

    expect(requiredGate).toEqual(expect.objectContaining({
      ok: true,
      failed: 0,
      skipped: 0,
    }));

    const skippedGate = buildConformanceReleaseGateSummary({
      config: { raw_backing_tool_required: false },
      deployment_claims: fullDeploymentClaims(),
      deployment_observations: fullDeploymentObservations(),
      steps: requiredGate.checks
        .filter((check) => check.id !== "raw_backing_tool_blocked")
        .filter((check) => !DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS.some((requirement) => requirement.id === check.id))
        .map((check) => ({ name: nameForGateCheck(check.id), ok: true })),
    });
    expect(skippedGate.ok).toBe(true);
    expect(skippedGate.skipped).toBe(1);
    expect(skippedGate.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "raw_backing_tool_blocked", skipped: true }),
    ]));
  });

  it("fails release-gate summary when required deployment claims are missing", () => {
    const gate = buildConformanceReleaseGateSummary({
      config: { raw_backing_tool_required: true },
      deployment_claims: {
        ...fullDeploymentClaims(),
        external_proof_signing: false,
        licensed_skill_filtering: false,
      },
      deployment_observations: {
        ...fullDeploymentObservations(),
        external_proof_signing: false,
        licensed_skill_filtering: false,
      },
      steps: [
        { name: "initialize", ok: true },
        { name: "required Dojo tool surface advertised", ok: true },
        { name: "observe production deployment readiness", ok: true },
        { name: "select published Dojo competency", ok: true },
        { name: "issue proof capsule", ok: true },
        { name: "validate proof capsule", ok: true },
        { name: "execute proof-gated Dojo skill", ok: true },
        { name: "raw backing tool blocked outside Dojo proof path", ok: true },
        { name: "revoke proof capsule", ok: true },
        { name: "revoked proof validation blocked", ok: true },
        { name: "revoked proof run blocked", ok: true },
      ],
    });

    expect(gate.ok).toBe(false);
    expect(gate.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "external_proof_signing", ok: false }),
      expect.objectContaining({ id: "licensed_skill_filtering", ok: false }),
    ]));
  });

  it("builds a digest evidence manifest for redacted conformance reports", () => {
    const report = {
      release_gate: { ok: true, failed: 0 },
      steps: [{ name: "initialize", ok: true }],
      conformance: { mcp_host_class: "remote", non_loopback_mcp_host: true },
      config: { raw_backing_tool_required: true },
      deployment_claims: fullDeploymentClaims(),
      deployment_observations: fullDeploymentObservations(),
    };
    const serialized = JSON.stringify(report, null, 2);
    const manifest = buildConformanceEvidenceManifest({
      report,
      reportPath: "/tmp/dojo-mcp-host-conformance.json",
      serialized,
    });

    expect(manifest).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
      report_path: "/tmp/dojo-mcp-host-conformance.json",
      report_bytes: Buffer.byteLength(serialized),
      gate_ok: true,
      gate_failed: 0,
      step_count: 1,
      mcp_host_class: "remote",
      non_loopback_mcp_host: true,
      raw_backing_tool_required: true,
      deployment_claims: fullDeploymentClaims(),
      deployment_observations: fullDeploymentObservations(),
    }));
    expect(manifest.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

function fullDeploymentClaims(): Record<string, boolean> {
  return {
    require_external_control_plane_store: true,
    external_control_plane_store: true,
    require_external_proof_signing: true,
    external_proof_signing: true,
    require_bridge_token: true,
    bridge_token_required: true,
    require_no_local_cdp: true,
    no_local_cdp_leakage: true,
    require_licensed_skill_filtering: true,
    licensed_skill_filtering: true,
  };
}

function fullDeploymentObservations(): Record<string, boolean | string> {
  return {
    source: "synthi_browser_get_deployment_readiness",
    readiness_ok: true,
    external_control_plane_store: true,
    external_proof_signing: true,
    bridge_token_required: true,
    no_local_cdp_leakage: true,
    hosted_runtime_non_loopback: true,
    evidence_ledger: true,
    mcp_manifest_signing: true,
    licensed_skill_filtering: true,
  };
}

function nameForGateCheck(id: string): string {
  const names: Record<string, string> = {
    mcp_initialize: "initialize",
    required_dojo_tool_surface: "required Dojo tool surface advertised",
    production_deployment_readiness_observed: "observe production deployment readiness",
    published_competency_selected: "select published Dojo competency",
    proof_capsule_issued: "issue proof capsule",
    proof_capsule_validated: "validate proof capsule",
    proof_gated_run: "dry-run proof-gated Dojo skill",
    raw_backing_tool_blocked: "raw backing tool blocked outside Dojo proof path",
    proof_capsule_revoked: "revoke proof capsule",
    revoked_proof_validation_blocked: "revoked proof validation blocked",
    revoked_proof_run_blocked: "revoked proof run blocked",
  };
  return names[id] || id;
}
