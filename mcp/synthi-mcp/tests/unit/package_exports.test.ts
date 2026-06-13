import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package exports", () => {
  it("exposes the Vite React source identity adapter as a stable developer subpath", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };

    expect(pkg.exports).toEqual(expect.objectContaining({
      ".": expect.objectContaining({
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      }),
      "./source-identity": expect.objectContaining({
        import: "./dist/browser/source_identity.js",
        types: "./dist/browser/source_identity.d.ts",
      }),
    }));

    for (const expectedExport of expectedDojoContractExports()) {
      expect(pkg.exports?.[expectedExport.subpath]).toEqual(expect.objectContaining({
        import: expectedExport.import,
        types: expectedExport.types,
      }));
    }
  });
});

function expectedDojoContractExports() {
  return [
    contractExport("./dojo/proof/public-verifier", "proof/public_verifier"),
    contractExport("./dojo/proof/public-verification-export", "proof/public_verification_export"),
    contractExport("./dojo/proof/capsule-service", "proof/capsule_service"),
    contractExport("./dojo/license/kernel", "license/kernel"),
    contractExport("./dojo/mcp/skill-bus", "mcp/skill_bus"),
    contractExport("./dojo/mcp/execution-policy-gate", "mcp/execution_policy_gate"),
    contractExport("./dojo/mcp/manifest-signing", "mcp/manifest_signing"),
    contractExport("./dojo/evidence/types", "evidence/types"),
    contractExport("./dojo/evidence/ledger-store", "evidence/ledger_store"),
    contractExport("./dojo/evidence/claims", "evidence/claims"),
    contractExport("./dojo/evidence/redaction", "evidence/redaction"),
    contractExport("./dojo/evidence/export", "evidence/export"),
    contractExport("./dojo/graph/types", "graph/types"),
    contractExport("./dojo/graph/compiler", "graph/compiler"),
    contractExport("./dojo/graph/runtime", "graph/runtime"),
    contractExport("./dojo/graph/substrate-executor", "graph/substrate_executor"),
    contractExport("./dojo/vivarium/scenario-dsl", "vivarium/scenario_dsl"),
    contractExport("./dojo/vivarium/fixture-materializer", "vivarium/fixture_materializer"),
    contractExport("./dojo/vivarium/oracle", "vivarium/oracle"),
    contractExport("./dojo/vivarium/runner", "vivarium/runner"),
    contractExport("./dojo/checkride/runner", "checkride/runner"),
    contractExport("./dojo/checkride/entrustment", "checkride/entrustment"),
    contractExport("./dojo/checkride/readiness", "checkride/readiness"),
    contractExport("./dojo/case-law/registry", "case_law/registry"),
    contractExport("./dojo/case-law/guardrail-synthesizer", "case_law/guardrail_synthesizer"),
    contractExport("./dojo/source/source-snapshot", "source/source_snapshot"),
    contractExport("./dojo/source/source-drift", "source/source_drift"),
    contractExport("./dojo/source/agent-ready-ui-contract", "source/agent_ready_ui_contract"),
    contractExport("./dojo/source/affordance-pr-plan", "source/affordance_pr_plan"),
    contractExport("./dojo/source/codemod", "source/codemod"),
    contractExport("./dojo/source/pr-generator", "source/pr_generator"),
    contractExport("./dojo/api/types", "api/types"),
    contractExport("./dojo/api/endpoint-inference", "api/endpoint_inference"),
    contractExport("./dojo/api/api-tool-compiler", "api/api_tool_compiler"),
    contractExport("./dojo/governance/service", "governance/service"),
    contractExport("./dojo/runtime/hosted-runtime-gateway", "runtime/hosted_runtime_gateway"),
  ];
}

function contractExport(subpath: string, distPath: string) {
  return {
    subpath,
    import: `./dist/dojo/${distPath}.js`,
    types: `./dist/dojo/${distPath}.d.ts`,
  };
}
