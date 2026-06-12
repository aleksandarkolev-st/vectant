import { describe, expect, it } from "vitest";
import { DOJO_TOOL_NAMES } from "../../src/tools/dojo.js";
import {
  buildDojoImplementationMetadata,
  DOJO_IMPLEMENTATION_STATUS_VALUES,
  DOJO_REPORT_IMPLEMENTATION_STATUS,
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
  });

  it("classifies every current Dojo MCP tool", () => {
    const missing = DOJO_TOOL_NAMES.filter((toolName) => !DOJO_TOOL_IMPLEMENTATION_STATUS[toolName]);
    expect(missing).toEqual([]);
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
        simulation_backing: "materialized_synthetic_fixture",
      })
    );
  });

  it("marks the current proof-gated execution path as executable", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_run_with_proof_capsule")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: true,
        evidence_backing: "runtime_validation",
      })
    );
  });

  it("classifies permission upgrade requests as control-plane writes, not runtime enforcement", () => {
    expect(getDojoToolImplementationMetadata("synthi_dojo_request_permission_upgrade")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: false,
        evidence_backing: "caller_context",
        maturity_blockers: expect.arrayContaining(["license_promotion_still_requires_checkride_and_evidence_policy"]),
      })
    );
    expect(getDojoToolImplementationMetadata("synthi_dojo_review_permission_upgrade")).toEqual(
      expect.objectContaining({
        implementation_status: "executable",
        runtime_enforced: false,
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
});
