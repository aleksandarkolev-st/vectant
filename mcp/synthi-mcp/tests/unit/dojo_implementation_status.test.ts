import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOJO_TOOL_NAMES } from "../../src/tools/dojo.js";
import {
  buildDojoImplementationMetadata,
  DOJO_IMPLEMENTATION_STATUS_VALUES,
  DOJO_REPORT_IMPLEMENTATION_STATUS,
  DOJO_RUNTIME_SCOPE_VALUES,
  DOJO_TOOL_IMPLEMENTATION_STATUS,
  getDojoReportImplementationMetadata,
  getDojoToolImplementationMetadata,
} from "../../src/dojo/status/implementation_status.js";

describe("Dojo implementation status registry", () => {
  it("uses the stable maturity status vocabulary", () => {
    expect(DOJO_IMPLEMENTATION_STATUS_VALUES).toEqual([
      "executable",
      "deterministic_projection",
      "report_only",
      "planned",
    ]);
    expect(DOJO_RUNTIME_SCOPE_VALUES).toEqual([
      "none",
      "read_only_projection",
      "report_only",
      "registry_operation",
      "control_plane_write",
      "proof_validation",
      "proof_gated_dispatch",
      "synthetic_fixture_runtime",
      "non_mutating_shadow",
    ]);
  });

  it("classifies every current Dojo MCP tool", () => {
    const missing = DOJO_TOOL_NAMES.filter((toolName) => !DOJO_TOOL_IMPLEMENTATION_STATUS[toolName]);
    expect(missing).toEqual([]);
  });

  it("keeps the machine-readable maturity manifest in sync with the registry", () => {
    const manifest = JSON.parse(readFileSync(
      new URL("../../../../.synthi/dojo/maturity/implementation-status.json", import.meta.url),
      "utf8"
    )) as {
      schema_version: string;
      generated_from: string;
      status_values: string[];
      runtime_scope_values: string[];
      production_runtime_tool_claims: string[];
      tools: Record<string, string>;
      reports: Record<string, string>;
    };
    const toolStatuses = Object.fromEntries(
      Object.entries(DOJO_TOOL_IMPLEMENTATION_STATUS).map(([toolName, metadata]) => [
        toolName,
        metadata.implementation_status,
      ])
    );
    const reportStatuses = Object.fromEntries(
      Object.entries(DOJO_REPORT_IMPLEMENTATION_STATUS).map(([reportName, metadata]) => [
        reportName,
        metadata.implementation_status,
      ])
    );

    expect(manifest.schema_version).toBe("synthi.dojo.implementationStatusManifest.v1");
    expect(manifest.generated_from).toBe("mcp/synthi-mcp/src/dojo/status/implementation_status.ts");
    expect(manifest.status_values).toEqual(DOJO_IMPLEMENTATION_STATUS_VALUES);
    expect(manifest.runtime_scope_values).toEqual(DOJO_RUNTIME_SCOPE_VALUES);
    expect(manifest.production_runtime_tool_claims).toEqual([]);
    expect(manifest.tools).toEqual(toolStatuses);
    expect(Object.keys(manifest.tools).sort()).toEqual([...DOJO_TOOL_NAMES].sort());
    expect(manifest.reports).toEqual(reportStatuses);
  });

  it("does not classify unknown tool names as executable", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_future_runtime")).toEqual(
      expect.objectContaining({
        implementation_status: "planned",
        runtime_enforced: false,
        evidence_backing: "none",
      })
    );
  });

  it("marks graph report surfaces as runtime-backed projections and Vivarium runs as executable fixtures", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_get_skill_cortex")).toEqual(
      expect.objectContaining({
        implementation_status: "deterministic_projection",
        runtime_enforced: false,
        maturity_blockers: expect.arrayContaining(["read_only_report_surface"]),
      })
    );
    expect(getDojoToolImplementationMetadata("synthi_dojo_run_vivarium_scenario")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        runtime_scope: "synthetic_fixture_runtime",
        production_runtime: false,
        simulation_backing: "materialized_synthetic_fixture",
        maturity_blockers: expect.arrayContaining(["fixture_runtime_not_production_execution"]),
      })
    );
  });

  it("marks the current proof-gated execution path as dispatch-gated, not mature production runtime", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_run_with_proof_capsule")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        runtime_scope: "proof_gated_dispatch",
        production_runtime: false,
        evidence_backing: "runtime_validation",
        maturity_blockers: expect.arrayContaining(["hosted_runtime_gateway_not_on_execution_path"]),
      })
    );
  });

  it("classifies Ghost Mode as a non-mutating executable shadow-evidence write", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_run_ghost_mode")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        runtime_scope: "non_mutating_shadow",
        production_runtime: false,
        evidence_backing: "runtime_validation",
        maturity_blockers: expect.arrayContaining([
          "non_mutating_shadow_does_not_execute_production_actions",
          "shadow_evidence_store_is_repo_local_until_durable_control_plane_is_configured",
        ]),
      })
    );
  });

  it("classifies permission upgrade requests as control-plane writes, not runtime enforcement", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_request_permission_upgrade")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: false,
        runtime_scope: "control_plane_write",
        production_runtime: false,
        evidence_backing: "caller_context",
        maturity_blockers: expect.arrayContaining(["license_promotion_still_requires_checkride_and_evidence_policy"]),
      })
    );
    expect(getDojoToolImplementationMetadata("synthi_dojo_review_permission_upgrade")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: false,
        runtime_scope: "control_plane_write",
        production_runtime: false,
        evidence_backing: "caller_context",
        maturity_blockers: expect.arrayContaining(["license_promotion_still_requires_checkride_and_evidence_policy"]),
      })
    );
  });

  it("classifies current report artifacts without implying mature runtime backing", () => {
    expect(DOJO_REPORT_IMPLEMENTATION_STATUS.evidence_ledger).toEqual(
      expect.objectContaining({
        implementation_status: "report_only",
        runtime_enforced: false,
        runtime_scope: "report_only",
        production_runtime: false,
        evidence_backing: "durable_evidence_ledger",
      })
    );
    expect(getDojoReportImplementationMetadata("skill_cortex")).toEqual(
      expect.objectContaining({
        implementation_status: "deterministic_projection",
        maturity_blockers: expect.not.arrayContaining(["no_executable_graph_runtime"]),
      })
    );
  });

  it("describes proof issuing as evidence-aware and production signer configurable", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_issue_proof_capsule")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        runtime_scope: "proof_validation",
        production_runtime: false,
        summary: expect.stringContaining("external command signing"),
        maturity_blockers: expect.arrayContaining(["managed_kms_hsm_provider_not_configured_by_default"]),
      })
    );
  });

  it("returns cloned metadata so callers cannot mutate the registry", () => {
    const metadata = buildDojoImplementationMetadata("synthi_dojo_get_workspace_organoid");
    metadata.maturity_blockers.push("mutated_by_test");

    expect(getDojoToolImplementationMetadata("synthi_dojo_get_workspace_organoid").maturity_blockers).not.toContain(
      "mutated_by_test"
    );
  });

  it("does not currently claim mature production runtime execution for any Dojo surface", () => {
    const productionRuntimeClaims = Object.entries(DOJO_TOOL_IMPLEMENTATION_STATUS)
      .filter(([, metadata]) => metadata.production_runtime)
      .map(([toolName]) => toolName);
    expect(productionRuntimeClaims).toEqual([]);
  });

  it("requires executable surfaces to declare a precise non-empty runtime scope", () => {
    for (const [name, metadata] of Object.entries(DOJO_TOOL_IMPLEMENTATION_STATUS)) {
      if (metadata.implementation_status !== "executable") continue;
      expect(metadata.runtime_scope, name).not.toBe("none");
      expect(DOJO_RUNTIME_SCOPE_VALUES).toContain(metadata.runtime_scope);
    }
  });
});
