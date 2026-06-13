// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildConformanceEvidenceManifest,
  buildConformanceReleaseGateSummary,
  buildDojoMcpHostConformanceConfig,
  classifyMcpHost,
  isExpectedBlockedToolCall,
  mcpHostConformance,
  redactConformanceReport,
  resolveMcpCommandSpec,
  selectDojoCompetencyForConformance,
} from "../../scripts/dojo-mcp-host-conformance.mjs";

describe("Dojo MCP host conformance harness", () => {
  it("classifies MCP host URLs without treating loopback as deployed", () => {
    expect(classifyMcpHost("http://127.0.0.1:3000/mcp")).toBe("loopback");
    expect(classifyMcpHost("http://localhost:3000/mcp")).toBe("loopback");
    expect(classifyMcpHost("http://0.0.0.0:3000/mcp")).toBe("local-bind");
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
        "revocation-evidence-refs": "evidence-a,evidence-b",
      },
      env: {
        SYNTHI_DOJO_MCP_HOST_URL: "https://mcp.example.test/mcp",
        SYNTHI_DOJO_MCP_BEARER_TOKEN: "test-token",
        SYNTHI_DOJO_MCP_CONFORMANCE_REQUIRE_NON_LOOPBACK_HOST: "1",
        SYNTHI_DOJO_MCP_CONFORMANCE_REVOCATION_ACTOR_ID: "host-conformance-operator",
      },
    });

    expect(config.host.transport).toBe("http-json-rpc");
    expect(config.host.mcpHostUrl).toBe("https://mcp.example.test/mcp");
    expect(config.host.requireNonLoopbackMcpHost).toBe(true);
    expect(config.contextClaims).toEqual({ workspace_verified: true });
    expect(config.toolArgs).toEqual({ workspace_id: "acme" });
    expect(config.evidenceClaims).toEqual([{ claim: "checkride_passed", satisfied: true }]);
    expect(config.revocationActorId).toBe("host-conformance-operator");
    expect(config.revocationActorType).toBe("service");
    expect(config.revocationEvidenceRefs).toEqual(["evidence-a", "evidence-b"]);
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
      steps: [
        { name: "initialize", ok: true },
        { name: "required Dojo tool surface advertised", ok: true },
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
      steps: requiredGate.checks
        .filter((check) => check.id !== "raw_backing_tool_blocked")
        .map((check) => ({ name: nameForGateCheck(check.id), ok: true })),
    });
    expect(skippedGate.ok).toBe(true);
    expect(skippedGate.skipped).toBe(1);
    expect(skippedGate.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "raw_backing_tool_blocked", skipped: true }),
    ]));
  });

  it("builds a digest evidence manifest for redacted conformance reports", () => {
    const report = {
      release_gate: { ok: true, failed: 0 },
      steps: [{ name: "initialize", ok: true }],
      conformance: { mcp_host_class: "remote", non_loopback_mcp_host: true },
      config: { raw_backing_tool_required: true },
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
    }));
    expect(manifest.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

function nameForGateCheck(id: string): string {
  const names: Record<string, string> = {
    mcp_initialize: "initialize",
    required_dojo_tool_surface: "required Dojo tool surface advertised",
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
