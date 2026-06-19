import { describe, expect, it } from "vitest";
import { resolveDojoEvidenceLedgerRecords } from "../../src/dojo/evidence/ledger_resolver.js";

describe("Dojo evidence ledger resolver", () => {
  it("fails closed when record IDs are missing", async () => {
    await expect(resolveDojoEvidenceLedgerRecords({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      record_ids: [],
      env: {},
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      store_kind: "unconfigured",
      records: [],
      blocked_by: expect.arrayContaining([
        "evidence_ledger_store_unconfigured",
        "evidence_record_ids_missing",
      ]),
    }));
  });

  it("does not resolve production evidence from inline stores", async () => {
    await expect(resolveDojoEvidenceLedgerRecords({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      record_ids: ["evidence-a"],
      env: { SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: "inline" },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      store_kind: "inline",
      missing_record_ids: ["evidence-a"],
      blocked_by: expect.arrayContaining([
        "evidence_ledger_store_inline_not_production_capable",
        "evidence_ledger_store_kind_unsupported:inline",
      ]),
    }));
  });

  it("requires a Postgres connection URL for Postgres ledger resolution", async () => {
    await expect(resolveDojoEvidenceLedgerRecords({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      record_ids: ["evidence-a"],
      env: { SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: "postgres" },
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      store_kind: "postgres",
      missing_record_ids: ["evidence-a"],
      blocked_by: expect.arrayContaining(["evidence_ledger_postgres_url_missing"]),
    }));
  });
});
