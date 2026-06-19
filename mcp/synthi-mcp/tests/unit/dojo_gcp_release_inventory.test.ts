// @ts-nocheck
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  deploymentNamesFromKubernetesManifestDir,
  deploymentNamesFromKubernetesManifestText,
  evaluate,
  externalSecretBindingId,
  externalSecretInventoryFrom,
  parseArgs,
  parseExternalSecretBinding,
  resolveConfig,
} from "../../scripts/dojo-gcp-release-inventory.mjs";

const requiredApis = [
  "artifactregistry.googleapis.com",
  "cloudbuild.googleapis.com",
  "container.googleapis.com",
  "compute.googleapis.com",
  "secretmanager.googleapis.com",
  "iamcredentials.googleapis.com",
  "cloudkms.googleapis.com",
  "sqladmin.googleapis.com",
  "redis.googleapis.com",
  "storage.googleapis.com",
  "certificatemanager.googleapis.com",
  "logging.googleapis.com",
  "monitoring.googleapis.com",
];

function inventoryWithSecrets({
  remoteSecrets = [],
  k8sSecrets = [],
  externalSecrets = [],
  namespace = null,
  ingressHosts = null,
  deployments = null,
} = {}) {
  const datasets = {
    enabled_apis: requiredApis.map((name) => ({ config: { name } })),
    secret_manager_names: remoteSecrets.map((name) => ({ name: `projects/test/secrets/${name}` })),
    k8s_secret_names: `${k8sSecrets.join("\n")}\n`,
    k8s_external_secrets: {
      items: externalSecrets,
    },
  };
  if (namespace !== null) {
    datasets.k8s_namespace = { metadata: { name: namespace } };
  }
  if (Array.isArray(ingressHosts)) {
    datasets.k8s_ingresses = {
      items: ingressHosts.map((host) => ({ spec: { rules: [{ host }] } })),
    };
  }
  if (Array.isArray(deployments)) {
    datasets.k8s_deployments = {
      items: deployments.map((name) => ({ metadata: { name } })),
    };
  }
  return {
    mode: "execute",
    commandAvailability: {
      gcloud: { found: true, path: "gcloud" },
      kubectl: { found: true, path: "kubectl" },
    },
    commandResults: [
      { id: "enabled_apis", ok: true, parseOk: true },
      { id: "secret_manager_names", ok: true, parseOk: true },
      { id: "k8s_namespace", ok: true, parseOk: true },
      { id: "k8s_ingresses", ok: true, parseOk: true },
      { id: "k8s_secret_names", ok: true, parseOk: true },
      { id: "k8s_deployments", ok: true, parseOk: true },
      { id: "k8s_external_secrets", ok: true, parseOk: true },
    ],
    datasets,
  };
}

function releaseExternalSecret() {
  return {
    metadata: { name: "synthi-dojo-release-secrets" },
    spec: {
      target: {
        name: "synthi-secrets",
      },
      data: [
        {
          secretKey: "REDIS_URL",
          remoteRef: { key: "synthi-redis-url" },
        },
        {
          secretKey: "SYNTHI_DOJO_MCP_BEARER_TOKEN",
          remoteRef: { key: "synthi-dojo-mcp-bearer-token" },
        },
      ],
    },
  };
}

describe("Dojo GCP release inventory", () => {
  it("derives expected deployment names from Kubernetes manifest text", () => {
    const names = deploymentNamesFromKubernetesManifestText(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runtime-api
---
apiVersion: v1
kind: Service
metadata:
  name: runtime-api
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: "runtime-worker"
`);

    expect(names).toEqual(["runtime-api", "runtime-worker"]);
  });

  it("derives expected deployment names from Kubernetes manifest directories without fixed service names", () => {
    const fixtureRoot = path.join(tmpdir(), `dojo-k8s-fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(path.join(fixtureRoot, "nested"), { recursive: true });
      writeFileSync(path.join(fixtureRoot, "runtime.yaml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runtime-api
`, "utf8");
      writeFileSync(path.join(fixtureRoot, "nested", "worker.yml"), `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runtime-worker
`, "utf8");
      writeFileSync(path.join(fixtureRoot, "nested", "service.yaml"), `
apiVersion: v1
kind: Service
metadata:
  name: runtime-worker
`, "utf8");

      const config = resolveConfig(parseArgs([
        `--expected-deployments-from-k8s-dir=${fixtureRoot}`,
        "--expected-deployment=runtime-scheduler",
      ]));

      expect(deploymentNamesFromKubernetesManifestDir(fixtureRoot)).toEqual(["runtime-api", "runtime-worker"]);
      expect(config.expectedDeployments).toEqual(["runtime-scheduler", "runtime-api", "runtime-worker"]);
      expect(config.expectedDeploymentSources).toEqual([{
        type: "k8s_dir",
        path: path.resolve(fixtureRoot),
        deployments: ["runtime-api", "runtime-worker"],
      }]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects missing expected deployment manifest directories", () => {
    const missingDir = path.join(tmpdir(), `dojo-missing-k8s-fixture-${Date.now()}`);

    expect(() => resolveConfig(parseArgs([
      `--expected-deployments-from-k8s-dir=${missingDir}`,
    ]))).toThrow(/existing directory/);
  });

  it("parses secret manager, Kubernetes Secret, and ExternalSecret expectations separately", () => {
    const raw = parseArgs([
      "--expected-k8s-secret=synthi-secrets",
      "--expected-secret-manager-secret=synthi-redis-url",
      "--expected-external-secret=synthi-dojo-release-secrets",
      "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url",
    ]);

    const config = resolveConfig(raw);

    expect(config.expectedK8sSecrets).toEqual(["synthi-secrets"]);
    expect(config.expectedSecretManagerSecrets).toEqual(["synthi-redis-url"]);
    expect(config.expectedExternalSecrets).toEqual(["synthi-dojo-release-secrets"]);
    expect(config.expectedExternalSecretBindings).toEqual([
      {
        externalSecretName: "synthi-dojo-release-secrets",
        targetSecretName: "synthi-secrets",
        targetKey: "REDIS_URL",
        remoteSecret: "synthi-redis-url",
      },
    ]);
  });

  it("keeps the legacy expected-secret flag as a Kubernetes Secret alias only", () => {
    const config = resolveConfig(parseArgs(["--expected-secret=synthi-secrets"]));

    expect(config.expectedK8sSecrets).toEqual(["synthi-secrets"]);
    expect(config.expectedSecretManagerSecrets).toEqual([]);
  });

  it("extracts ExternalSecret names, target keys, remote keys, and bindings", () => {
    const inventory = externalSecretInventoryFrom([releaseExternalSecret()]);

    expect(inventory.names.has("synthi-dojo-release-secrets")).toBe(true);
    expect(inventory.targetSecretNames.has("synthi-secrets")).toBe(true);
    expect(inventory.targetKeys.has("synthi-dojo-release-secrets:synthi-secrets:REDIS_URL")).toBe(true);
    expect(inventory.remoteKeys.has("synthi-dojo-release-secrets:synthi-secrets:synthi-redis-url")).toBe(true);
    expect(inventory.bindings.has("synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url")).toBe(true);
    expect(externalSecretBindingId(parseExternalSecretBinding("synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url"))).toBe("synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url");
  });

  it("rejects malformed ExternalSecret binding arguments", () => {
    expect(() => parseExternalSecretBinding("REDIS_URL")).toThrow(/targetKey=remoteSecretName/);
    expect(() => parseExternalSecretBinding("synthi-dojo-release-secrets: :REDIS_URL=synthi-redis-url")).toThrow(/targetKey=remoteSecretName/);
    expect(() => parseExternalSecretBinding("synthi-dojo-release-secrets:synthi-secrets:REDIS_URL= ")).toThrow(/targetKey=remoteSecretName/);
  });

  it("passes when each secret layer is present in its own inventory source", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--expected-k8s-secret=synthi-secrets",
      "--expected-secret-manager-secret=synthi-redis-url",
      "--expected-external-secret=synthi-dojo-release-secrets",
      "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url",
    ]));

    const result = evaluate(config, inventoryWithSecrets({
      remoteSecrets: ["synthi-redis-url"],
      k8sSecrets: ["synthi-secrets"],
      externalSecrets: [releaseExternalSecret()],
    }), []);

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "k8s_secret:synthi-secrets")?.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "secret_manager:synthi-redis-url")?.status).toBe("passed");
    expect(result.checks.find((check) => check.id === "externalsecret_binding:synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url")?.status).toBe("passed");
  });

  it("fails when an ExternalSecret target key points at the wrong remote secret", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--expected-k8s-secret=synthi-secrets",
      "--expected-secret-manager-secret=synthi-redis-url",
      "--expected-external-secret=synthi-dojo-release-secrets",
      "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url",
    ]));
    const result = evaluate(config, inventoryWithSecrets({
      remoteSecrets: ["synthi-redis-url"],
      k8sSecrets: ["synthi-secrets"],
      externalSecrets: [{
        metadata: { name: "synthi-dojo-release-secrets" },
        spec: {
          target: { name: "synthi-secrets" },
          data: [{
            secretKey: "REDIS_URL",
            remoteRef: { key: "wrong-redis-secret" },
          }],
        },
      }],
    }), []);

    const failedBinding = result.checks.find((check) => check.id === "externalsecret_binding:synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url");
    expect(result.ok).toBe(false);
    expect(failedBinding).toEqual(expect.objectContaining({ status: "failed" }));
  });

  it("fails when the ExternalSecret syncs the right key and remote to the wrong target Secret", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--expected-k8s-secret=synthi-secrets",
      "--expected-secret-manager-secret=synthi-redis-url",
      "--expected-external-secret=synthi-dojo-release-secrets",
      "--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url",
    ]));
    const result = evaluate(config, inventoryWithSecrets({
      remoteSecrets: ["synthi-redis-url"],
      k8sSecrets: ["synthi-secrets"],
      externalSecrets: [{
        metadata: { name: "synthi-dojo-release-secrets" },
        spec: {
          target: { name: "wrong-target-secret" },
          data: [{
            secretKey: "REDIS_URL",
            remoteRef: { key: "synthi-redis-url" },
          }],
        },
      }],
    }), []);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "externalsecret_binding:synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url")).toEqual(expect.objectContaining({ status: "failed" }));
  });

  it("fails expected resources when execute mode collected an empty dataset", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--expected-k8s-secret=synthi-secrets",
      "--expected-secret-manager-secret=synthi-redis-url",
      "--expected-external-secret=synthi-dojo-release-secrets",
      "--expected-deployment=dojo-mcp-host",
    ]));
    const result = evaluate(config, {
      ...inventoryWithSecrets({
        remoteSecrets: [],
        k8sSecrets: [],
        externalSecrets: [],
      }),
      datasets: {
        ...inventoryWithSecrets().datasets,
        k8s_deployments: { items: [] },
      },
    }, []);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "k8s_secret:synthi-secrets")).toEqual(expect.objectContaining({ status: "failed" }));
    expect(result.checks.find((check) => check.id === "secret_manager:synthi-redis-url")).toEqual(expect.objectContaining({ status: "failed" }));
    expect(result.checks.find((check) => check.id === "externalsecret:synthi-dojo-release-secrets")).toEqual(expect.objectContaining({ status: "failed" }));
    expect(result.checks.find((check) => check.id === "k8s_deployment:dojo-mcp-host")).toEqual(expect.objectContaining({ status: "failed" }));
  });

  it("verifies namespace and ingress host when those datasets are collected", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--namespace=synthi",
      "--domain=beta.vectant.dev",
      "--expected-deployment=dojo-mcp-host",
    ]));
    const result = evaluate(config, inventoryWithSecrets({
      namespace: "synthi",
      ingressHosts: ["beta.vectant.dev"],
      deployments: ["dojo-mcp-host"],
      k8sSecrets: ["synthi-secrets"],
    }), []);

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "k8s_namespace:synthi")).toEqual(expect.objectContaining({ status: "passed" }));
    expect(result.checks.find((check) => check.id === "k8s_ingress_host:beta.vectant.dev")).toEqual(expect.objectContaining({ status: "passed" }));
  });

  it("fails namespace and ingress host checks when collected data does not match", () => {
    const config = resolveConfig(parseArgs([
      "--execute",
      "--namespace=synthi",
      "--domain=beta.vectant.dev",
      "--expected-deployment=dojo-mcp-host",
    ]));
    const result = evaluate(config, inventoryWithSecrets({
      namespace: "other-namespace",
      ingressHosts: ["preview.vectant.dev"],
      deployments: ["dojo-mcp-host"],
      k8sSecrets: ["synthi-secrets"],
    }), []);

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "k8s_namespace:synthi")).toEqual(expect.objectContaining({ status: "failed" }));
    expect(result.checks.find((check) => check.id === "k8s_ingress_host:beta.vectant.dev")).toEqual(expect.objectContaining({ status: "failed" }));
  });

  it("keeps self-check import-safe and runnable through buildReport", () => {
    const raw = parseArgs(["--self-check"]);
    const config = resolveConfig(raw);
    config.project = "self-check-project";
    config.region = "self-check-region";
    config.zone = "self-check-zone";
    config.cluster = "self-check-cluster";
    config.artifactRepository = "self-check-repo";
    config.gcsBucket = "self-check-bucket";
    config.cloudSqlInstance = "self-check-sql";
    config.redisInstance = "self-check-redis";

    const report = buildReport(config);

    expect(report.mode).toBe("self_check");
    expect(report.evaluation.ok).toBe(true);
    expect(report.config.expectedK8sSecrets).toEqual(["synthi-secrets"]);
    expect(report.evaluation.checks.find((check) => check.id === "k8s_namespace:synthi")).toEqual(expect.objectContaining({ status: "passed" }));
    expect(report.inventory.datasetKeys).toContain("k8s_external_secrets");
  });

  it("documents split secret inventory flags without using the legacy alias for remote secrets", () => {
    const runbook = readFileSync("../../docs/AGENT_DOJO_RELEASE_GATE_RUNBOOK.md", "utf8");

    expect(runbook).toContain("--expected-k8s-secret=synthi-secrets");
    expect(runbook).toContain("--expected-secret-manager-secret=synthi-redis-url");
    expect(runbook).toContain("--expected-external-secret-binding=synthi-dojo-release-secrets:synthi-secrets:REDIS_URL=synthi-redis-url");
    expect(runbook).not.toContain("--expected-secret=synthi-redis-url");
    expect(runbook).not.toContain("--expected-secret=synthi-database-url");
  });
});
