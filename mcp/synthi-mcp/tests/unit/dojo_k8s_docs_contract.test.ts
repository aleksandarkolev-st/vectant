// @ts-nocheck
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readRepoFile(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8");
}

describe("Dojo Kubernetes documentation contract", () => {
  it("does not claim the Prisma migration Job includes a database proxy sidecar", () => {
    const readme = readRepoFile("k8s", "README.md");
    const secretTemplate = readRepoFile("k8s", "secrets.yaml.example");
    const migrateJob = readRepoFile("k8s", "prisma-migrate-job.yaml");

    expect(readme).not.toContain("Prisma migration Job with Cloud SQL Auth Proxy sidecar");
    expect(readme).not.toContain("Run Prisma migrations (via dedicated Job with Cloud SQL Auth Proxy)");
    expect(secretTemplate).not.toContain("PostgreSQL (via Cloud SQL Auth Proxy sidecar)");
    expect(migrateJob).toContain("does not include a database proxy sidecar");
    expect(readme).toContain("Prisma migration Job using configured `DATABASE_URL`");
    expect(secretTemplate).toContain("DATABASE_URL must reach the target Postgres endpoint");
  });
});
