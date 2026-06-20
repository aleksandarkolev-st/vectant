#!/usr/bin/env node
/*
 * Apply Agent Dojo Postgres migrations to configured release databases.
 *
 * This intentionally reports only target ids and connection-string digests.
 * It must not print database credentials.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");

export const DOJO_POSTGRES_MIGRATION_SCHEMA_VERSION = "synthi.dojo.postgresMigration.v1";
export const DOJO_POSTGRES_MIGRATION_DEFAULT_OUT_DIR = "tmp/dojo-postgres-migrate";
export const DOJO_POSTGRES_MIGRATION_TARGETS = [
  {
    id: "control-plane",
    env: "SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL",
  },
  {
    id: "evidence-ledger",
    env: "SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL",
  },
];

const args = parseArgs(process.argv.slice(2));

if (isDirectRun()) {
  main().catch((err) => {
    console.error(`[fail] ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(1);
  });
}

async function main() {
  const artifacts = await runDojoPostgresMigrations({
    args,
    env: process.env,
    outDir: args["out-dir"],
  });
  console.log(`[ok] Dojo Postgres migrations applied - report=${artifacts.report_path}`);
}

export async function runDojoPostgresMigrations({
  args: inputArgs = {},
  env = process.env,
  outDir,
  now = new Date().toISOString(),
  modules,
} = {}) {
  const outputDir = path.resolve(outDir || env.SYNTHI_DOJO_POSTGRES_MIGRATION_OUT_DIR || path.join(REPO_ROOT, DOJO_POSTGRES_MIGRATION_DEFAULT_OUT_DIR));
  await mkdir(outputDir, { recursive: true });
  const runtime = modules ?? await loadRuntimeModules();
  const config = buildDojoPostgresMigrationConfig({ args: inputArgs, env });
  const results = [];
  for (const target of config.targets) {
    const pool = new runtime.Pool({ connectionString: target.connection_string });
    try {
      await runtime.applyDojoPostgresMigrations(pool);
      const verification = await verifyRequiredTables({
        queryable: pool,
        requiredTables: runtime.DOJO_POSTGRES_REQUIRED_TABLES,
      });
      if (!verification.ok) {
        throw new Error(`dojo_postgres_migration_missing_tables:${verification.missing_tables.join(",")}`);
      }
      results.push({
        target_ids: target.target_ids,
        connection_sha256: sha256(target.connection_string),
        ok: true,
        required_table_count: verification.present_tables.length,
      });
    } finally {
      await pool.end?.().catch(() => undefined);
    }
  }
  const report = {
    schema_version: DOJO_POSTGRES_MIGRATION_SCHEMA_VERSION,
    generated_at: now,
    ok: results.every((result) => result.ok === true),
    target_count: results.length,
    targets: results,
  };
  const reportPath = path.join(outputDir, "dojo-postgres-migrate.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report_path: reportPath, report };
}

export function buildDojoPostgresMigrationConfig({ args = {}, env = process.env } = {}) {
  const requested = parseTargetIds(args.targets ?? env.SYNTHI_DOJO_POSTGRES_MIGRATION_TARGETS);
  const selected = DOJO_POSTGRES_MIGRATION_TARGETS.filter((target) => requested.length === 0 || requested.includes(target.id));
  if (selected.length === 0) {
    throw new Error(`dojo_postgres_migration_targets_invalid:${requested.join(",")}`);
  }
  const byConnection = new Map();
  for (const target of selected) {
    const connectionString = stringOpt(env[target.env]);
    if (!connectionString) throw new Error(`dojo_postgres_migration_${target.env}_required`);
    const existing = byConnection.get(connectionString);
    if (existing) {
      existing.target_ids.push(target.id);
    } else {
      byConnection.set(connectionString, {
        target_ids: [target.id],
        connection_string: connectionString,
      });
    }
  }
  return {
    targets: [...byConnection.values()].map((target) => ({
      target_ids: [...target.target_ids].sort(),
      connection_string: target.connection_string,
    })),
  };
}

export async function verifyRequiredTables({ queryable, requiredTables }) {
  const present = [];
  const missing = [];
  for (const table of requiredTables) {
    const result = await queryable.query("SELECT to_regclass($1) AS table_name", [table]);
    const tableName = result?.rows?.[0]?.table_name;
    if (tableName) present.push(table);
    else missing.push(table);
  }
  return {
    ok: missing.length === 0,
    present_tables: present,
    missing_tables: missing,
  };
}

async function loadRuntimeModules() {
  const [pgModule, proofStoreModule, migrationsModule] = await Promise.all([
    import("pg"),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "store", "postgres_proof_store.js")).href),
    import(pathToFileURL(path.join(MCP_ROOT, "dist", "dojo", "store", "migrations.js")).href),
  ]);
  return {
    Pool: pgModule.Pool ?? pgModule.default?.Pool,
    applyDojoPostgresMigrations: proofStoreModule.applyDojoPostgresMigrations,
    DOJO_POSTGRES_REQUIRED_TABLES: migrationsModule.DOJO_POSTGRES_REQUIRED_TABLES,
  };
}

function parseTargetIds(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      parsed[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[raw] = next;
      i += 1;
    } else {
      parsed[raw] = "1";
    }
  }
  return parsed;
}

function stringOpt(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
