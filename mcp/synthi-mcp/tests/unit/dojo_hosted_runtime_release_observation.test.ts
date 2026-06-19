// @ts-nocheck
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoHostedRuntimeGatewayReleaseObservation,
  buildDojoHostedRuntimeGatewayReleaseObservationFromArgs,
  deriveHostedRuntimeReleaseChecks,
} from "../../scripts/dojo-hosted-runtime-gateway-release-observation.mjs";
import {
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS,
  DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_SCHEMA_VERSION,
} from "../../scripts/dojo-hosted-runtime-gateway-self-check.mjs";
import {
  DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS,
} from "../../scripts/dojo-mcp-host-conformance.mjs";

describe("hosted runtime gateway release observation producer", () => {
  it("derives a release-ready observation from digest-backed live gate artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-hosted-runtime-observation-"));
    const paths = await writeHostedRuntimeReleaseArtifacts({ dir });

    const result = await buildDojoHostedRuntimeGatewayReleaseObservation({
      paths,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.observation).toEqual(expect.objectContaining({
      schema_version: DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_SCHEMA_VERSION,
      source: "hosted_runtime_gateway_release_observation",
      scope: "release",
      observed: true,
      release_ready: true,
    }));
    expect(result.observation.checks).toEqual(Object.fromEntries(
      DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS.map((check) => [check, true]),
    ));
    expect(result.observation.artifact_refs.map((ref) => ref.gate_id)).toEqual(DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS);
    for (const ref of result.observation.artifact_refs) {
      const bytes = await readFile(ref.artifact_path);
      expect(ref.artifact_sha256).toBe(sha256(bytes));
      expect(ref.artifact_bytes).toBe(bytes.length);
    }
    const mcpHostRef = result.observation.artifact_refs.find((ref) => ref.gate_id === "dojo_mcp_host_conformance");
    expect(mcpHostRef.evidence_path).toBe(paths.dojo_mcp_host_conformance.evidence_path);
    expect(mcpHostRef.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when a required hosted-runtime release observation cannot be derived", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-hosted-runtime-observation-fail-"));
    const paths = await writeHostedRuntimeReleaseArtifacts({
      dir,
      workflowOverrides: {
        runtime_session: {
          short_lived_credentials_observed: true,
          origin_policy_observed: true,
          local_network_policy_observed: true,
          screenshot_redaction_observed: true,
          audit_event_observed: true,
          evidence_write_observed: true,
          expiry_observed: true,
          no_long_lived_credentials_observed: true,
        },
      },
    });

    const result = await buildDojoHostedRuntimeGatewayReleaseObservation({
      paths,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(result.ok).toBe(false);
    expect(result.observation.observed).toBe(false);
    expect(result.observation.release_ready).toBe(false);
    expect(result.observation.checks.tenant_session_isolation_observed).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "release_observation_check_failed:tenant_session_isolation_observed",
    ]));
  });

  it("builds the same observation from CLI-style args", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-hosted-runtime-observation-args-"));
    const paths = await writeHostedRuntimeReleaseArtifacts({ dir });
    const result = await buildDojoHostedRuntimeGatewayReleaseObservationFromArgs({
      now: "2026-06-11T00:00:00.000Z",
      args: {
        "workflow-e2e-summary": paths.workflow_e2e_hosted.artifact_path,
        "private-tool-stdio-acceptance": paths.private_tool_stdio_acceptance.artifact_path,
        "private-tool-codex-acceptance": paths.private_tool_codex_acceptance.artifact_path,
        "mcp-host-conformance-report": paths.dojo_mcp_host_conformance.artifact_path,
        "mcp-host-conformance-evidence": paths.dojo_mcp_host_conformance.evidence_path,
        "private-tool-stdio-host-conformance": paths.private_tool_stdio_host_conformance.artifact_path,
        "private-tool-codex-host-conformance": paths.private_tool_codex_host_conformance.artifact_path,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.observation.artifact_refs).toHaveLength(DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_GATE_IDS.length);
  });

  it("exposes pure check derivation for already-loaded release artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dojo-hosted-runtime-observation-derived-"));
    const paths = await writeHostedRuntimeReleaseArtifacts({ dir });
    const artifacts = {};
    for (const [gateId, refs] of Object.entries(paths)) {
      artifacts[gateId] = {
        json: JSON.parse(await readFile(refs.artifact_path, "utf8")),
        evidence_json: refs.evidence_path ? JSON.parse(await readFile(refs.evidence_path, "utf8")) : undefined,
      };
    }

    expect(deriveHostedRuntimeReleaseChecks(artifacts)).toEqual(Object.fromEntries(
      DOJO_HOSTED_RUNTIME_GATEWAY_RELEASE_OBSERVATION_CHECKS.map((check) => [check, true]),
    ));
  });
});

async function writeHostedRuntimeReleaseArtifacts({
  dir,
  workflowOverrides = {},
} = {}) {
  const deploymentObservations = {
    source: "synthi_browser_get_deployment_readiness",
    readiness_ok: true,
    ...Object.fromEntries(DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS
      .map((requirement) => [requirement.observedField, true])),
  };
  const deploymentClaims = Object.fromEntries(DOJO_MCP_HOST_DEPLOYMENT_CLAIM_REQUIREMENTS
    .map((requirement) => [requirement.requiredField, true]));
  const workflow = {
    schema_version: "synthi.dojo.workflowPipelineE2E.v1",
    ok: true,
    case_count: 1,
    results: [
      { name: "export avoids forwarded port literals", ok: true },
      { name: "run exported Playwright", ok: true },
      { name: "fresh MCP attach hosted browser", ok: true },
      { name: "fresh MCP call discovered private tool", ok: true },
    ],
    hosted_runtime: {
      cdp_url_configured: true,
      non_loopback_runtime: true,
      runtime_host_class: "remote",
      cdp_url: "wss://hosted-runtime.example.test/session",
    },
    fresh_mcp: {
      verify_fresh_mcp: true,
      private_workflow_store_env_configured: true,
    },
    visual_artifact_count: 1,
    visual_artifacts: [{ path: "workflow.png", png_verified: true, bytes: 67, screenshot_sha256: "0".repeat(64) }],
    runtime_session: {
      tenant_session_isolation_observed: true,
      short_lived_credentials_observed: true,
      origin_policy_observed: true,
      local_network_policy_observed: true,
      screenshot_redaction_observed: true,
      audit_event_observed: true,
      evidence_write_observed: true,
      expiry_observed: true,
      no_long_lived_credentials_observed: true,
    },
    ...workflowOverrides,
  };
  const stdio = {
    schema_version: "synthi.dojo.privateToolStdioAcceptance.v1",
    ok: true,
    conformance: { require_non_loopback_runtime: true, non_loopback_runtime: true, runtime_host_class: "remote" },
    steps: [
      {
        name: "attach hosted workspace browser through MCP",
        ok: true,
        evidence: { hosted_attach: true, local_attach: false, runtime_kind: "hosted" },
      },
      { name: "grant exact-origin consent", ok: true },
      { name: "visual proof snapshot", ok: true },
    ],
  };
  const codex = {
    schema_version: "synthi.dojo.privateToolCodexAcceptance.v1",
    ok: true,
    conformance: { require_non_loopback_runtime: true, non_loopback_runtime: true, runtime_host_class: "remote" },
    codex: {
      exit_code: 0,
      saw_private_tool_name: true,
      mcp_evidence: {
        hosted_attach_call: true,
        local_attach_call: false,
        private_tool_call: true,
        private_tool_result_ok: true,
        consent_call: true,
        open_call: true,
        command_execution_count: 0,
        private_tool_steps_run: 2,
      },
    },
    acceptance: { expected_steps_min: 1 },
    steps: [{ name: "codex discovered and called private MCP tool", ok: true }, { name: "visual proof snapshot", ok: true }],
  };
  const mcpConformance = {
    schema_version: "synthi.dojo.mcpHostConformance.v1",
    conformance: { ok: true, mcp_host_class: "remote", non_loopback_mcp_host: true },
    config: { execute_production: true, raw_backing_tool_required: true },
    release_gate: { ok: true, failed: 0 },
    deployment_claims: deploymentClaims,
    deployment_observations: deploymentObservations,
    steps: [
      { name: "execute proof-gated Dojo skill", ok: true, dry_run: false },
      { name: "raw backing tool blocked outside Dojo proof path", ok: true },
      { name: "revoked proof validation blocked", ok: true },
      { name: "revoked proof run blocked", ok: true },
    ],
  };
  const mcpConformanceEvidence = {
    schema_version: "synthi.dojo.mcpHostConformanceEvidence.v1",
    gate_ok: true,
    gate_failed: 0,
    deployment_observations: deploymentObservations,
  };
  const stdioHost = {
    ...stdio,
    conformance: {
      ...stdio.conformance,
      require_external_private_tool_store: true,
      external_private_tool_store: true,
    },
    private_tool_store: { external: true },
  };
  const codexHost = {
    ...codex,
    conformance: {
      ...codex.conformance,
      require_external_private_tool_store: true,
      external_private_tool_store: true,
    },
    private_tool_store: { external: true },
  };

  return {
    workflow_e2e_hosted: await writeJsonArtifact(dir, "workflow-e2e.json", workflow),
    private_tool_stdio_acceptance: await writeJsonArtifact(dir, "private-tool-stdio.json", stdio),
    private_tool_codex_acceptance: await writeJsonArtifact(dir, "private-tool-codex.json", codex),
    dojo_mcp_host_conformance: {
      ...(await writeJsonArtifact(dir, "dojo-mcp-host-conformance.json", mcpConformance)),
      evidence_path: (await writeJsonArtifact(dir, "dojo-mcp-host-conformance.evidence.json", mcpConformanceEvidence)).artifact_path,
    },
    private_tool_stdio_host_conformance: await writeJsonArtifact(dir, "private-tool-stdio-host.json", stdioHost),
    private_tool_codex_host_conformance: await writeJsonArtifact(dir, "private-tool-codex-host.json", codexHost),
  };
}

async function writeJsonArtifact(dir, basename, value) {
  const artifactPath = path.join(dir, basename);
  await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { artifact_path: artifactPath };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
