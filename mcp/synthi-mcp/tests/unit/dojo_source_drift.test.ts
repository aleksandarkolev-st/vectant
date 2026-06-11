import { describe, expect, it } from "vitest";
import { detectDojoSourceDrift } from "../../src/dojo/source/source_drift.js";
import { buildDojoSourceSnapshot } from "../../src/dojo/source/source_snapshot.js";

describe("Dojo source drift expiry", () => {
  it("expires graph nodes mapped to changed source tokens", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "total-field", route: "/invoices", component: "InvoiceForm", source_locator: "src/InvoiceForm.jsx:24", risk: "safe" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:99", risk: "mutation" },
      { token_id: "total-field", route: "/invoices", component: "InvoiceForm", source_locator: "src/InvoiceForm.jsx:24", risk: "safe" },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [
        { node_id: "action_submit", source_token_ids: ["save-button"], license_id: "license-a" },
      ],
    });

    expect(report).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.sourceDriftReport.v1",
      drifted_token_ids: ["save-button"],
      affected_nodes: [
        expect.objectContaining({
          node_id: "action_submit",
          source_token_id: "save-button",
          drift_kind: "changed",
          license_id: "license-a",
        }),
      ],
    }));
    expect(report.license_expiry_triggers).toEqual([
      expect.objectContaining({
        node_id: "action_submit",
        source_token_id: "save-button",
        license_id: "license-a",
      }),
    ]);
  });

  it("does not expire a skill when only unrelated source tokens change", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "other-button", route: "/settings", component: "Settings", action: "saveSettings", source_locator: "src/Settings.jsx:10", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "other-button", route: "/settings", component: "Settings", action: "saveSettings", source_locator: "src/Settings.jsx:99", risk: "mutation" },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [
        { node_id: "action_submit", source_token_ids: ["save-button"], license_id: "license-a" },
      ],
    });

    expect(report.drifted_token_ids).toEqual(["other-button"]);
    expect(report.affected_nodes).toEqual([]);
    expect(report.license_expiry_triggers).toEqual([]);
  });

  it("marks removed source tokens as drift", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", []);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [{ node_id: "action_submit", source_token_ids: ["save-button"] }],
    });

    expect(report.affected_nodes).toEqual([
      expect.objectContaining({ drift_kind: "removed", source_token_id: "save-button" }),
    ]);
  });
});

function snapshotFixture(appVersion: string, sourceTokens: Parameters<typeof buildDojoSourceSnapshot>[0]["source_tokens"]) {
  return buildDojoSourceSnapshot({
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    app_origin: "https://app.example.test",
    app_version: appVersion,
    commit_sha: `commit-${appVersion}`,
    source_root: "src",
    source_tokens: sourceTokens,
    created_at: "2026-06-11T00:00:00.000Z",
  });
}
