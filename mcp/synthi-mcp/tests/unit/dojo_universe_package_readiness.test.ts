import { describe, expect, it } from "vitest";
import { buildDojoSkill } from "../../src/browser/dojo.js";
import {
  buildDojoEvidenceLedger,
  buildDojoPackageReadiness,
  buildDojoUniverseDossier,
  type DojoPackageReadinessEvidenceSummary,
} from "../../src/browser/dojo_universe.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";
import { compileWorkflowContract } from "../../src/browser/workflow.js";

describe("Dojo universe package readiness", () => {
  it("marks package readiness as pending when release evidence is not supplied", () => {
    const readiness = buildDojoPackageReadiness(skillFixture());

    expect(readiness.release_gate.status).toBe("partial");
    expect(readiness.release_gate.gaps).toEqual(["package_readiness_evidence_not_supplied"]);
    expect(readiness.release_gate.packed_file_count).toBeNull();
    expect(readiness.enterprise.find((row) => row.package === "Dojo Package Readiness")).toMatchObject({
      status: "partial",
      gaps: ["package_readiness_evidence_not_supplied"],
    });
  });

  it("summarizes a valid package-readiness release artifact", () => {
    const evidence = packageReadinessEvidence({
      export_entry_paths: ["dist/index.js", "dist/index.d.ts", "dist/dojo/proof/public_verifier.js"],
      script_referenced_paths: [
        "scripts/dojo-package-readiness-self-check.mjs",
        "scripts/dojo-release-gate-verify.mjs",
        "tests/chaos/runner.mjs",
      ],
      required_package_scripts: ["build", "typecheck", "proof:dojo:package-readiness:self-check"],
      required_package_files_entries: ["dist", "scripts/dojo-package-readiness-self-check.mjs", "tests/chaos"],
      npm_pack: {
        exit_code: 0,
        integrity_present: true,
        packed_file_count: 42,
        unpacked_size: 123456,
      },
    });

    const readiness = buildDojoPackageReadiness(skillFixture(), {
      evidence,
      evidence_path: "tmp/dojo-package-readiness/dojo-package-readiness.evidence.json",
    });

    expect(readiness.release_gate).toMatchObject({
      status: "ready",
      evidence_path: "tmp/dojo-package-readiness/dojo-package-readiness.evidence.json",
      package_name: "@synthi-inc/mcp-server",
      package_version: "0.1.0",
      npm_pack_exit_code: 0,
      npm_pack_integrity_present: true,
      packed_file_count: 42,
      unpacked_size: 123456,
      export_entry_path_count: 3,
      release_harness_path_count: 3,
      required_script_count: 3,
      required_file_entry_count: 3,
      gaps: [],
    });
    expect(readiness.release_gate.evidence).toEqual(expect.arrayContaining([
      "release_gate:dojo_package_readiness_self_check",
      "package_script:proof:dojo:package-readiness:self-check",
      "packed_files:42",
      "export_entry_paths:3",
      "release_harness_paths:3",
    ]));
    expect(readiness.enterprise.find((row) => row.package === "Dojo Package Readiness")).toMatchObject({
      status: "ready",
      gaps: [],
    });
  });

  it("fails closed when package-readiness evidence is invalid", () => {
    const evidence = packageReadinessEvidence({
      ok: false,
      errors: ["missing_packed_path:scripts/dojo-release-gate-verify.mjs"],
      validation: {
        ok: false,
        errors: ["script_path_not_covered_by_files:tests/chaos/runner.mjs"],
      },
      npm_pack: {
        exit_code: 1,
        integrity_present: false,
        packed_file_count: 4,
        unpacked_size: 1200,
      },
    });

    const readiness = buildDojoPackageReadiness(skillFixture(), { evidence });

    expect(readiness.release_gate.status).toBe("blocked");
    expect(readiness.release_gate.gaps).toEqual(expect.arrayContaining([
      "package_readiness_not_ok",
      "package_readiness_validation_not_ok",
      "npm_pack_exit_code:1",
      "npm_pack_integrity_missing",
      "missing_packed_path:scripts/dojo-release-gate-verify.mjs",
      "script_path_not_covered_by_files:tests/chaos/runner.mjs",
    ]));
    expect(readiness.enterprise.find((row) => row.package === "Dojo Package Readiness")).toMatchObject({
      status: "blocked",
    });
  });

  it("threads package-readiness evidence into the universe dossier", () => {
    const evidence = packageReadinessEvidence({
      npm_pack: {
        exit_code: 0,
        integrity_present: true,
        packed_file_count: 9,
        unpacked_size: 8080,
      },
    });

    const dossier = buildDojoUniverseDossier(skillFixture(), undefined, {
      package_readiness_evidence: evidence,
      package_readiness_evidence_path: "tmp/dojo-package-readiness/custom.evidence.json",
    });

    expect(dossier.package_readiness.release_gate.status).toBe("ready");
    expect(dossier.package_readiness.release_gate.evidence_path).toBe("tmp/dojo-package-readiness/custom.evidence.json");
    expect(dossier.package_readiness.release_gate.packed_file_count).toBe(9);
  });

  it("scopes evidence retention records by skill tenant or deterministic local fallback", () => {
    const tenantScopedSkill = skillFixture({ tenant_id: "tenant-a" });
    const tenantScopedLedger = buildDojoEvidenceLedger(tenantScopedSkill);

    expect(tenantScopedLedger.retention_plan.tenant_id).toBe("tenant-a");
    expect(tenantScopedLedger.retention_plan.workspace_id).toBe(tenantScopedSkill.workspace_id);
    expect(tenantScopedLedger.retention_plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenant_id: "tenant-a",
          workspace_id: tenantScopedSkill.workspace_id,
        }),
      ])
    );

    const firstLocalLedger = buildDojoEvidenceLedger(skillFixture({ workspace_id: "workspace-local" }));
    const secondLocalLedger = buildDojoEvidenceLedger(skillFixture({ workspace_id: "workspace-local" }));

    expect(firstLocalLedger.retention_plan.tenant_id).toMatch(/^local-tenant-[a-f0-9]{12}$/);
    expect(firstLocalLedger.retention_plan.tenant_id).not.toBe("legacy-local-tenant");
    expect(firstLocalLedger.retention_plan.tenant_id).toBe(secondLocalLedger.retention_plan.tenant_id);
    expect(firstLocalLedger.retention_plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenant_id: firstLocalLedger.retention_plan.tenant_id,
          workspace_id: "workspace-local",
        }),
      ])
    );
  });
});

function skillFixture(options: { tenant_id?: string; workspace_id?: string } = {}) {
  return buildDojoSkill(compileWorkflowContract([
    event({
      event_id: "client",
      event_seq: 1,
      action: "fill",
      value: "Acme",
      detail: { element: { role: "textbox", label: "Client name" } },
      locator_candidates: [
        { kind: "label", locator: "page.getByLabel(\"Client name\")", confidence: 0.94, reason: "form_label" },
      ],
    }),
    event({
      event_id: "save",
      event_seq: 2,
      action: "click",
      detail: { element: { role: "button", name: "Save invoice" } },
      locator_candidates: [
        { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save invoice\" })", confidence: 0.96, reason: "role" },
      ],
    }),
  ]).contract, {
    workspace_id: options.workspace_id ?? "workspace-a",
    tenant_id: options.tenant_id,
    now: "2026-06-11T00:00:00.000Z",
  });
}

function packageReadinessEvidence(
  overrides: Partial<DojoPackageReadinessEvidenceSummary> = {}
): DojoPackageReadinessEvidenceSummary {
  return {
    schema_version: "synthi.dojo.packageReadinessEvidence.v1",
    generated_at: "2026-06-11T00:00:00.000Z",
    ok: true,
    errors: [],
    package_name: "@synthi-inc/mcp-server",
    package_version: "0.1.0",
    package_private: false,
    required_package_scripts: ["build", "typecheck"],
    required_package_files_entries: ["dist"],
    export_entry_paths: ["dist/index.js"],
    script_referenced_paths: ["scripts/dojo-package-readiness-self-check.mjs"],
    validation: {
      ok: true,
      errors: [],
    },
    npm_pack: {
      exit_code: 0,
      integrity_present: true,
      packed_file_count: 1,
      unpacked_size: 1024,
    },
    ...overrides,
  };
}

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 1,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.test",
    url: "https://app.example.test/invoices",
    kind: "human_action",
    action: "click",
    target: "button",
    selectors: [],
    locator_candidates: [],
    confidence: 0.99,
    ...overrides,
  };
}
