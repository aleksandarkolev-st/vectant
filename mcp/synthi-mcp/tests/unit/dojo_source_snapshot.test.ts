import { describe, expect, it } from "vitest";
import { buildDojoSourceSnapshot, sourceTokenReleaseKey } from "../../src/dojo/source/source_snapshot.js";

describe("Dojo source snapshot contract", () => {
  it("hashes the same release-scoped snapshot deterministically", () => {
    const first = snapshotFixture();
    const second = snapshotFixture();

    expect(first.snapshot_hash).toBe(second.snapshot_hash);
    expect(first.snapshot_id).toBe(second.snapshot_id);
    expect(first.source_tokens.map((token) => token.token_id)).toEqual(["save-button", "total-field"]);
    expect(first.source_tokens[0]?.source_locator).toBe("src/routes/invoices/InvoiceForm.jsx:42");
  });

  it("scopes source tokens by app release and commit", () => {
    const snapshot = snapshotFixture();

    expect(sourceTokenReleaseKey(snapshot, "save-button")).toBe(
      "https://app.example.test@2026.06.11:abc123:save-button"
    );
    expect(() => sourceTokenReleaseKey(snapshot, "missing-token")).toThrow(/dojo_source_token_not_in_snapshot/);
  });

  it("changes snapshot hash when release-scoped source token material changes", () => {
    const first = snapshotFixture();
    const second = snapshotFixture({
      source_tokens: [
        {
          token_id: "save-button",
          route: "/invoices",
          component: "InvoiceForm",
          action: "saveInvoice",
          source_locator: "src/routes/invoices/InvoiceForm.jsx:99",
          risk: "mutation",
        },
      ],
    });

    expect(second.snapshot_hash).not.toBe(first.snapshot_hash);
  });

  it("rejects duplicate source token IDs", () => {
    expect(() => snapshotFixture({
      source_tokens: [
        { token_id: "save-button", route: "/a", component: "A", source_locator: "src/A.jsx:1" },
        { token_id: "save-button", route: "/b", component: "B", source_locator: "src/B.jsx:1" },
      ],
    })).toThrow(/dojo_source_token_duplicate/);
  });
});

function snapshotFixture(overrides: Partial<Parameters<typeof buildDojoSourceSnapshot>[0]> = {}) {
  return buildDojoSourceSnapshot({
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    app_origin: "https://app.example.test",
    app_version: "2026.06.11",
    commit_sha: "abc123",
    source_root: "C:\\repo\\synthi",
    source_tokens: [
      {
        token_id: "total-field",
        route: "/invoices",
        component: "InvoiceForm",
        source_locator: "src\\routes\\invoices\\InvoiceForm.jsx:24",
        risk: "safe",
      },
      {
        token_id: "save-button",
        route: "/invoices",
        component: "InvoiceForm",
        action: "saveInvoice",
        source_locator: "src\\routes\\invoices\\InvoiceForm.jsx:42",
        risk: "mutation",
      },
    ],
    created_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  });
}
