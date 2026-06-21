// @ts-nocheck
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDojoPostgresMigrationConfig,
  runDojoPostgresMigrations,
  verifyRequiredTables,
} from "../../scripts/dojo-postgres-migrate.mjs";

describe("Dojo Postgres migration script", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("deduplicates control-plane and evidence-ledger targets when URLs match", () => {
    const config = buildDojoPostgresMigrationConfig({
      env: {
        SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL: "postgres://user:pass@example.test/db",
        SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL: "postgres://user:pass@example.test/db",
      },
    });

    expect(config.targets).toHaveLength(1);
    expect(config.targets[0].target_ids).toEqual(["control-plane", "evidence-ledger"]);
  });

  it("verifies required tables through to_regclass checks", async () => {
    const checks: string[] = [];
    const result = await verifyRequiredTables({
      requiredTables: ["dojo_tenants", "dojo_evidence_records"],
      queryable: {
        query: async (_sql, values) => {
          checks.push(values[0]);
          return { rows: [{ table_name: values[0] === "dojo_tenants" ? "dojo_tenants" : null }] };
        },
      },
    });

    expect(checks).toEqual(["dojo_tenants", "dojo_evidence_records"]);
    expect(result).toEqual({
      ok: false,
      present_tables: ["dojo_tenants"],
      missing_tables: ["dojo_evidence_records"],
    });
  });

  it("applies migrations and writes a redacted report", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "dojo-postgres-migrate-"));
    tmpDirs.push(outDir);
    const migrated: string[] = [];
    class FakePool {
      constructor(options) {
        this.connectionString = options.connectionString;
      }

      async query(_sql, values) {
        return { rows: [{ table_name: values[0] }] };
      }

      async end() {
        return undefined;
      }
    }

    const result = await runDojoPostgresMigrations({
      env: {
        SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL: "postgres://user:pass@example.test/control",
        SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL: "postgres://user:pass@example.test/evidence",
      },
      outDir,
      now: "2026-06-20T00:00:00.000Z",
      modules: {
        Pool: FakePool,
        applyDojoPostgresMigrations: async (pool) => {
          migrated.push(pool.connectionString);
        },
        DOJO_POSTGRES_REQUIRED_TABLES: ["dojo_tenants", "dojo_evidence_records"],
      },
    });

    expect(migrated).toEqual([
      "postgres://user:pass@example.test/control",
      "postgres://user:pass@example.test/evidence",
    ]);
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.targets).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("user:pass");
    expect(report.targets[0].connection_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
