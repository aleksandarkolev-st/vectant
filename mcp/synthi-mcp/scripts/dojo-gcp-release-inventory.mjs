#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REQUIRED_APIS = [
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

const DEFAULT_OUT_DIR = path.resolve("tmp", "dojo-gcp-release-inventory");

function parseArgs(argv) {
  const out = {
    execute: false,
    selfCheck: false,
    outDir: DEFAULT_OUT_DIR,
    expectedSecret: [],
    expectedDeployment: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const parsed = splitArg(argv[index]);
    const arg = parsed.flag;
    const takeValue = () => {
      if (parsed.value !== undefined) {
        return parsed.value;
      }
      index += 1;
      return requireValue(argv, index, arg);
    };

    if (arg === "--execute") {
      out.execute = true;
    } else if (arg === "--self-check") {
      out.selfCheck = true;
    } else if (arg === "--out-dir") {
      out.outDir = path.resolve(takeValue());
    } else if (arg === "--project") {
      out.project = takeValue();
    } else if (arg === "--region") {
      out.region = takeValue();
    } else if (arg === "--zone") {
      out.zone = takeValue();
    } else if (arg === "--cluster") {
      out.cluster = takeValue();
    } else if (arg === "--namespace") {
      out.namespace = takeValue();
    } else if (arg === "--artifact-repository") {
      out.artifactRepository = takeValue();
    } else if (arg === "--gcs-bucket") {
      out.gcsBucket = takeValue();
    } else if (arg === "--cloud-sql-instance") {
      out.cloudSqlInstance = takeValue();
    } else if (arg === "--redis-instance") {
      out.redisInstance = takeValue();
    } else if (arg === "--domain") {
      out.domain = takeValue();
    } else if (arg === "--expected-secret") {
      out.expectedSecret.push(takeValue());
    } else if (arg === "--expected-deployment") {
      out.expectedDeployment.push(takeValue());
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function splitArg(arg) {
  if (!arg.startsWith("--") || !arg.includes("=")) {
    return { flag: arg, value: undefined };
  }
  const equalsIndex = arg.indexOf("=");
  return {
    flag: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1),
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Read-only Google Cloud release inventory for Agent Dojo.

Usage:
  node scripts/dojo-gcp-release-inventory.mjs [--execute] [options]

Options:
  --self-check                     Run deterministic self-check without gcloud.
  --execute                        Execute read-only gcloud/kubectl commands.
  --out-dir <path>                 Evidence output directory.
  --project <id>                   Google Cloud project id.
  --region <name>                  Google Cloud region.
  --zone <name>                    GKE cluster zone/location.
  --cluster <name>                 GKE cluster name.
  --namespace <name>               Kubernetes namespace to inspect.
  --artifact-repository <name>     Expected Artifact Registry repository id.
  --gcs-bucket <name>              Expected GCS bucket name, without gs://.
  --cloud-sql-instance <name>      Expected Cloud SQL instance name.
  --redis-instance <name>          Expected Memorystore Redis instance name.
  --domain <name>                  Expected public application domain.
  --expected-secret <name>         Expected Kubernetes secret name. Repeatable.
  --expected-deployment <name>     Expected Kubernetes deployment. Repeatable.

The script never creates, updates, patches, applies, deletes, or deploys cloud
resources. Without --execute it writes the planned read-only inventory commands.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(JSON.stringify(JSON.parse(readFileSync(filePath, "utf8"))));
}

function resolveConfig(raw) {
  const env = process.env;
  const expectedSecrets = raw.expectedSecret.length > 0 ? raw.expectedSecret : [
    "synthi-secrets",
  ];
  const expectedDeployments = raw.expectedDeployment.length > 0 ? raw.expectedDeployment : [
    "frontend",
    "collab-server",
    "signaling-server",
    "ai-gateway",
    "ai-engine",
    "worker",
  ];

  return {
    execute: raw.execute,
    selfCheck: raw.selfCheck,
    outDir: raw.outDir,
    project: raw.project || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || env.PROJECT_ID || "",
    region: raw.region || env.GOOGLE_CLOUD_REGION || env.GCLOUD_REGION || env.CLOUDSDK_COMPUTE_REGION || "",
    zone: raw.zone || env.GOOGLE_CLOUD_ZONE || env.GCLOUD_ZONE || env.CLOUDSDK_COMPUTE_ZONE || "",
    cluster: raw.cluster || env.GKE_CLUSTER || env.GCLOUD_GKE_CLUSTER || "",
    namespace: raw.namespace || env.K8S_NAMESPACE || "synthi",
    artifactRepository: raw.artifactRepository || env.ARTIFACT_REGISTRY_REPOSITORY || env.AR_REPO || "",
    gcsBucket: normalizeBucket(raw.gcsBucket || env.GCS_BUCKET || env.GCS_BUCKET_NAME || ""),
    cloudSqlInstance: raw.cloudSqlInstance || env.CLOUD_SQL_INSTANCE || "",
    redisInstance: raw.redisInstance || env.REDIS_INSTANCE || "",
    domain: raw.domain || env.SYNTHI_PUBLIC_DOMAIN || env.DOMAIN || "",
    expectedSecrets,
    expectedDeployments,
  };
}

function normalizeBucket(value) {
  return value.replace(/^gs:\/\//, "").replace(/\/$/, "");
}

function buildPlan(config) {
  const gcloud = (args) => config.project ? [...args, "--project", config.project] : args;
  const commands = [
    command("gcloud", ["config", "list", "--format=json"], "gcloud_config"),
    command("gcloud", gcloud(["services", "list", "--enabled", "--format=json"]), "enabled_apis"),
    command("gcloud", gcloud(["container", "clusters", "list", "--format=json"]), "gke_clusters"),
    command("gcloud", gcloud(["builds", "triggers", "list", "--format=json"]), "cloud_build_triggers", { optional: true }),
    command("gcloud", gcloud(["builds", "list", "--limit=10", "--format=json"]), "recent_cloud_builds", { optional: true }),
    command("gcloud", gcloud(["sql", "instances", "list", "--format=json"]), "cloud_sql_instances", { optional: true }),
    command("gcloud", gcloud(["storage", "buckets", "list", "--format=json"]), "gcs_buckets", { optional: true }),
    command("gcloud", gcloud(["secrets", "list", "--format=json"]), "secret_manager_names", { optional: true, redactStdout: false }),
    command("gcloud", gcloud(["compute", "addresses", "list", "--global", "--format=json"]), "global_addresses", { optional: true }),
    command("gcloud", gcloud(["compute", "url-maps", "list", "--format=json"]), "url_maps", { optional: true }),
    command("gcloud", gcloud(["compute", "target-https-proxies", "list", "--format=json"]), "https_proxies", { optional: true }),
    command("gcloud", gcloud(["compute", "ssl-certificates", "list", "--format=json"]), "ssl_certificates", { optional: true }),
  ];

  if (config.region) {
    commands.push(command("gcloud", gcloud(["artifacts", "repositories", "list", "--location", config.region, "--format=json"]), "artifact_repositories", { optional: true }));
    commands.push(command("gcloud", gcloud(["redis", "instances", "list", "--region", config.region, "--format=json"]), "redis_instances", { optional: true }));
  }

  if (config.cluster && config.zone) {
    commands.push(command("gcloud", gcloud(["container", "clusters", "describe", config.cluster, "--zone", config.zone, "--format=json"]), "gke_cluster_describe", { optional: true }));
  }

  commands.push(command("kubectl", ["config", "current-context"], "kubectl_current_context", { optional: true, parseJson: false }));
  commands.push(command("kubectl", ["get", "namespace", config.namespace, "-o", "json"], "k8s_namespace", { optional: true }));
  commands.push(command("kubectl", ["get", "deployment", "-n", config.namespace, "-o", "json"], "k8s_deployments", { optional: true }));
  commands.push(command("kubectl", ["get", "service", "-n", config.namespace, "-o", "json"], "k8s_services", { optional: true }));
  commands.push(command("kubectl", ["get", "ingress", "-n", config.namespace, "-o", "json"], "k8s_ingresses", { optional: true }));
  commands.push(command("kubectl", ["get", "externalsecret", "-n", config.namespace, "-o", "json"], "k8s_external_secrets", { optional: true }));
  commands.push(command("kubectl", ["get", "secret", "-n", config.namespace, "-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}"], "k8s_secret_names", { optional: true, parseJson: false }));

  return commands;
}

function command(bin, args, id, options = {}) {
  return {
    id,
    bin,
    args,
    optional: options.optional === true,
    parseJson: options.parseJson !== false,
    redactStdout: options.redactStdout === true,
    mutates: false,
  };
}

function assertPlanIsReadOnly(plan) {
  const mutatingTokens = new Set([
    "apply",
    "create",
    "delete",
    "deploy",
    "insert",
    "patch",
    "remove",
    "replace",
    "run",
    "scale",
    "set",
    "submit",
    "update",
    "upgrade",
  ]);
  const mutatingPhrases = new Set([
    "builds submit",
  ]);
  const violations = [];
  for (const item of plan) {
    const joined = `${item.bin} ${item.args.join(" ")}`;
    const tokens = joined.split(/\s+/);
    for (const term of mutatingTokens) {
      if (tokens.includes(term)) {
        violations.push({ id: item.id, command: joined, term });
      }
    }
    for (const phrase of mutatingPhrases) {
      if (joined.includes(phrase)) {
        violations.push({ id: item.id, command: joined, term: phrase });
      }
    }
    if (item.mutates) {
      violations.push({ id: item.id, command: joined, term: "mutates=true" });
    }
  }
  return violations;
}

function findCommand(bin) {
  const configured = configuredCommandPath(bin);
  if (configured) {
    return configured;
  }

  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", [bin], { encoding: "utf8" })
    : spawnSync("which", [bin], { encoding: "utf8" });
  if (lookup.status === 0) {
    return {
      found: true,
      path: lookup.stdout.trim().split(/\r?\n/)[0],
      source: "path",
    };
  }

  const discovered = discoverCommonCommandPath(bin);
  if (discovered) {
    return discovered;
  }

  return {
    found: false,
    path: "",
    source: "not_found",
  };
}

function configuredCommandPath(bin) {
  const envName = bin === "gcloud" ? "GCLOUD_BIN" : bin === "kubectl" ? "KUBECTL_BIN" : "";
  const configured = envName ? process.env[envName] : "";
  if (!configured) {
    return null;
  }
  if (!existsSync(configured)) {
    return {
      found: false,
      path: configured,
      source: envName,
      error: "configured_path_not_found",
    };
  }
  return {
    found: true,
    path: configured,
    source: envName,
  };
}

function discoverCommonCommandPath(bin) {
  if (process.platform !== "win32") {
    return null;
  }

  const executable = `${bin}.cmd`;
  const roots = [
    process.env.CLOUDSDK_ROOT_DIR,
    process.env.GOOGLE_CLOUD_SDK_HOME,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Cloud SDK", "google-cloud-sdk") : "",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Google", "Cloud SDK", "google-cloud-sdk") : "",
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Google", "Cloud SDK", "google-cloud-sdk") : "",
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = path.join(root, "bin", executable);
    if (existsSync(candidate)) {
      return {
        found: true,
        path: candidate,
        source: "common_windows_cloud_sdk_path",
      };
    }
  }

  return null;
}

function runInventory(config, plan) {
  const commandAvailability = {
    gcloud: findCommand("gcloud"),
    kubectl: findCommand("kubectl"),
  };

  if (!config.execute) {
    return {
      mode: "dry_run",
      commandAvailability,
      commandResults: plan.map((item) => ({
        id: item.id,
        command: [item.bin, ...item.args],
        skipped: true,
        reason: "dry_run_requires_--execute",
      })),
      datasets: {},
    };
  }

  const commandResults = [];
  const datasets = {};
  for (const item of plan) {
    const available = commandAvailability[item.bin]?.found === true;
    if (!available) {
      commandResults.push({
        id: item.id,
        command: [item.bin, ...item.args],
        ok: false,
        skipped: true,
        reason: `${item.bin}_not_found`,
      });
      continue;
    }

    const launch = buildLaunch(commandAvailability[item.bin].path || item.bin, item.args);
    const result = spawnSync(launch.bin, launch.args, {
      encoding: "utf8",
      shell: launch.shell,
      timeout: 120000,
      windowsHide: true,
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const parsed = item.parseJson ? parseJson(stdout) : stdout.trim();
    const ok = result.status === 0;
    commandResults.push({
      id: item.id,
      command: [item.bin, ...item.args],
      ok,
      exitCode: result.status,
      optional: item.optional,
      stdoutSha256: stdout ? sha256(stdout) : null,
      stderrSha256: stderr ? sha256(stderr) : null,
      stderrPreview: stderr ? stderr.slice(0, 500) : "",
      spawnError: result.error ? result.error.message : "",
      parseOk: item.parseJson ? parsed.ok : true,
    });
    if (ok && (!item.parseJson || parsed.ok)) {
      datasets[item.id] = item.parseJson ? parsed.value : parsed;
    }
  }

  return {
    mode: "execute",
    commandAvailability,
    commandResults,
    datasets,
  };
}

function buildLaunch(bin, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return {
      bin: [quoteCmdArg(bin), ...args.map(quoteCmdArg)].join(" "),
      args: [],
      shell: true,
    };
  }
  return { bin, args, shell: false };
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9._/:=@{}\\-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

function parseJson(value) {
  try {
    return { ok: true, value: value.trim() ? JSON.parse(value) : null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function evaluate(config, inventory, planViolations) {
  const datasets = inventory.datasets || {};
  const datasetKeys = new Set(Object.keys(datasets));
  const commandResults = new Map((inventory.commandResults || []).map((result) => [result.id, result]));
  const hasDataset = (id) => datasetKeys.has(id);
  const enabledApis = namesFrom(datasets.enabled_apis, (item) => item.config?.name || item.name);
  const clusters = namesFrom(datasets.gke_clusters, (item) => item.name);
  const artifactRepos = namesFrom(datasets.artifact_repositories, (item) => item.name?.split("/").pop() || item.repositoryId || item.name);
  const sqlInstances = namesFrom(datasets.cloud_sql_instances, (item) => item.name);
  const redisInstances = namesFrom(datasets.redis_instances, (item) => item.name);
  const buckets = namesFrom(datasets.gcs_buckets, (item) => normalizeBucket(item.name || item.id || ""));
  const secrets = namesFrom(datasets.secret_manager_names, (item) => item.name?.split("/").pop() || item.name);
  const deployments = namesFrom(datasets.k8s_deployments?.items, (item) => item.metadata?.name);
  const k8sSecrets = namesFrom(String(datasets.k8s_secret_names || "").split(/\r?\n/).filter(Boolean), (item) => item);

  const checks = [];
  checks.push(check("inventory_plan_read_only", planViolations.length === 0, planViolations));
  checks.push(check("gcloud_available", !config.execute || inventory.commandAvailability?.gcloud?.found === true, inventory.commandAvailability?.gcloud || {}, { notConfiguredOk: !config.execute }));
  checks.push(check("kubectl_available", !config.execute || inventory.commandAvailability?.kubectl?.found === true, inventory.commandAvailability?.kubectl || {}, { optional: true, notConfiguredOk: !config.execute }));

  const requiredDatasets = [
    ["enabled_apis", "enabled API inventory"],
    ["gke_clusters", "GKE cluster inventory", Boolean(config.cluster)],
    ["artifact_repositories", "Artifact Registry inventory", Boolean(config.artifactRepository)],
    ["cloud_sql_instances", "Cloud SQL inventory", Boolean(config.cloudSqlInstance)],
    ["redis_instances", "Memorystore Redis inventory", Boolean(config.redisInstance)],
    ["gcs_buckets", "GCS bucket inventory", Boolean(config.gcsBucket)],
  ];
  for (const [datasetId, label, required = true] of requiredDatasets) {
    if (config.execute && required && !hasDataset(datasetId)) {
      checks.push(check(
        `inventory_dataset:${datasetId}`,
        false,
        inventoryUnavailableDetail(datasetId, label, commandResults.get(datasetId)),
      ));
    }
  }

  for (const api of REQUIRED_APIS) {
    checks.push(check(
      `api:${api}`,
      !config.execute || (hasDataset("enabled_apis") && enabledApis.has(api)),
      hasDataset("enabled_apis") ? { api } : { api, reason: "enabled_apis_dataset_unavailable" },
      { notConfiguredOk: !config.execute, optional: config.execute && !hasDataset("enabled_apis") },
    ));
  }

  checks.push(namedResourceCheck("gke_cluster", config.cluster, clusters, { optionalWhenNoExecute: !config.execute || !hasDataset("gke_clusters"), unavailableReason: datasetUnavailableReason("gke_clusters", commandResults.get("gke_clusters")) }));
  checks.push(namedResourceCheck("artifact_repository", config.artifactRepository, artifactRepos, { optionalWhenNoExecute: !config.execute || !hasDataset("artifact_repositories"), unavailableReason: datasetUnavailableReason("artifact_repositories", commandResults.get("artifact_repositories")) }));
  checks.push(namedResourceCheck("cloud_sql_instance", config.cloudSqlInstance, sqlInstances, { optionalWhenNoExecute: !config.execute || !hasDataset("cloud_sql_instances"), unavailableReason: datasetUnavailableReason("cloud_sql_instances", commandResults.get("cloud_sql_instances")) }));
  checks.push(namedResourceCheck("redis_instance", config.redisInstance, redisInstances, { optionalWhenNoExecute: !config.execute || !hasDataset("redis_instances"), unavailableReason: datasetUnavailableReason("redis_instances", commandResults.get("redis_instances")) }));
  checks.push(namedResourceCheck("gcs_bucket", config.gcsBucket, buckets, { optionalWhenNoExecute: !config.execute || !hasDataset("gcs_buckets"), unavailableReason: datasetUnavailableReason("gcs_buckets", commandResults.get("gcs_buckets")) }));

  for (const secret of config.expectedSecrets) {
    checks.push(namedResourceCheck(`k8s_secret:${secret}`, secret, k8sSecrets, { optionalWhenNoExecute: true, unavailableReason: datasetUnavailableReason("k8s_secret_names", commandResults.get("k8s_secret_names")) }));
    checks.push(namedResourceCheck(`secret_manager:${secret}`, secret, secrets, { optionalWhenNoExecute: true, unavailableReason: datasetUnavailableReason("secret_manager_names", commandResults.get("secret_manager_names")), acceptMissingWhenNameLikelyK8sOnly: true }));
  }

  for (const deployment of config.expectedDeployments) {
    checks.push(namedResourceCheck(`k8s_deployment:${deployment}`, deployment, deployments, { optionalWhenNoExecute: true, unavailableReason: datasetUnavailableReason("k8s_deployments", commandResults.get("k8s_deployments")) }));
  }

  const hardFailures = checks.filter((item) => item.status === "failed" && item.optional !== true);
  const warnings = checks.filter((item) => item.status === "warning" || item.optional === true);
  return {
    ok: hardFailures.length === 0,
    hardFailureCount: hardFailures.length,
    warningCount: warnings.length,
    checks,
  };
}

function inventoryUnavailableDetail(datasetId, label, commandResult) {
  return {
    dataset: datasetId,
    label,
    reason: datasetUnavailableReason(datasetId, commandResult),
    command_exit_code: Number.isInteger(commandResult?.exitCode) ? commandResult.exitCode : null,
    command_stderr_preview: commandResult?.stderrPreview || "",
  };
}

function datasetUnavailableReason(datasetId, commandResult) {
  if (!commandResult) {
    return `${datasetId}_not_collected`;
  }
  if (commandResult.skipped) {
    return commandResult.reason || `${datasetId}_collection_skipped`;
  }
  if (commandResult.ok !== true) {
    return `${datasetId}_command_failed`;
  }
  if (commandResult.parseOk === false) {
    return `${datasetId}_parse_failed`;
  }
  return `${datasetId}_dataset_unavailable`;
}

function namesFrom(values, pick) {
  const result = new Set();
  if (!Array.isArray(values)) {
    return result;
  }
  for (const value of values) {
    const name = pick(value);
    if (typeof name === "string" && name.trim()) {
      result.add(name.trim());
    }
  }
  return result;
}

function namedResourceCheck(id, expectedName, names, options = {}) {
  if (!expectedName) {
    return {
      id,
      status: "not_configured",
      ok: false,
      optional: true,
      detail: { reason: "no_expected_name_provided" },
    };
  }
  if (names.size === 0 && options.optionalWhenNoExecute) {
    return {
      id,
      status: "warning",
      ok: false,
      optional: true,
      detail: { expectedName, reason: options.unavailableReason || "dataset_empty_or_not_executed" },
    };
  }
  return check(id, names.has(expectedName), { expectedName, observedCount: names.size });
}

function check(id, ok, detail = {}, options = {}) {
  if (ok) {
    return { id, status: "passed", ok: true, detail };
  }
  if (options.notConfiguredOk) {
    return { id, status: "not_checked", ok: false, optional: true, detail };
  }
  return {
    id,
    status: options.optional ? "warning" : "failed",
    ok: false,
    optional: options.optional === true,
    detail,
  };
}

function writeReport(config, report) {
  mkdirSync(config.outDir, { recursive: true });
  const reportPath = path.join(config.outDir, "dojo-gcp-release-inventory.json");
  const evidencePath = path.join(config.outDir, "dojo-gcp-release-inventory.evidence.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const evidence = {
    schema_version: "synthi.dojo.gcpReleaseInventoryEvidence.v1",
    created_at: report.created_at,
    report_path: reportPath,
    report_sha256: fileSha256(reportPath),
    mode: report.mode,
    execute: report.config.execute,
    command_count: report.command_plan.length,
    read_only_plan: report.plan_violations.length === 0,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { reportPath, evidencePath };
}

function buildReport(config) {
  const plan = buildPlan(config);
  const planViolations = assertPlanIsReadOnly(plan);
  const inventory = config.selfCheck
    ? buildSelfCheckInventory()
    : runInventory(config, plan);
  const evaluation = evaluate(config, inventory, planViolations);
  return {
    schema_version: "synthi.dojo.gcpReleaseInventory.v1",
    created_at: new Date().toISOString(),
    mode: config.selfCheck ? "self_check" : inventory.mode,
    config: redactConfig(config),
    required_apis: REQUIRED_APIS,
    command_plan: plan.map((item) => ({
      id: item.id,
      command: [item.bin, ...item.args],
      optional: item.optional,
      mutates: item.mutates,
    })),
    plan_violations: planViolations,
    inventory: summarizeInventory(inventory),
    evaluation,
  };
}

function redactConfig(config) {
  return {
    execute: config.execute,
    project: config.project || null,
    region: config.region || null,
    zone: config.zone || null,
    cluster: config.cluster || null,
    namespace: config.namespace || null,
    artifactRepository: config.artifactRepository || null,
    gcsBucket: config.gcsBucket || null,
    cloudSqlInstance: config.cloudSqlInstance || null,
    redisInstance: config.redisInstance || null,
    domain: config.domain || null,
    expectedSecrets: config.expectedSecrets,
    expectedDeployments: config.expectedDeployments,
  };
}

function summarizeInventory(inventory) {
  return {
    mode: inventory.mode,
    commandAvailability: inventory.commandAvailability,
    commandResults: inventory.commandResults,
    datasetKeys: Object.keys(inventory.datasets || {}),
  };
}

function buildSelfCheckInventory() {
  const deployments = ["frontend", "collab-server", "signaling-server", "ai-gateway", "ai-engine", "worker"]
    .map((name) => ({ metadata: { name } }));
  return {
    mode: "self_check",
    commandAvailability: {
      gcloud: { found: true, path: "self-check-gcloud" },
      kubectl: { found: true, path: "self-check-kubectl" },
    },
    commandResults: [],
    datasets: {
      enabled_apis: REQUIRED_APIS.map((name) => ({ config: { name } })),
      gke_clusters: [{ name: "self-check-cluster" }],
      artifact_repositories: [{ name: "projects/self-check/locations/self-check/repositories/self-check-repo" }],
      cloud_sql_instances: [{ name: "self-check-sql" }],
      redis_instances: [{ name: "self-check-redis" }],
      gcs_buckets: [{ name: "gs://self-check-bucket" }],
      secret_manager_names: [{ name: "projects/self-check/secrets/synthi-secrets" }],
      k8s_secret_names: "synthi-secrets\n",
      k8s_deployments: { items: deployments },
    },
  };
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.help) {
    printHelp();
    return;
  }
  const config = resolveConfig(raw);
  if (config.selfCheck) {
    config.project = "self-check-project";
    config.region = "self-check-region";
    config.zone = "self-check-zone";
    config.cluster = "self-check-cluster";
    config.artifactRepository = "self-check-repo";
    config.gcsBucket = "self-check-bucket";
    config.cloudSqlInstance = "self-check-sql";
    config.redisInstance = "self-check-redis";
  }
  const report = buildReport(config);
  const paths = writeReport(config, report);
  if (!report.evaluation.ok) {
    console.error(`[fail] GCP release inventory found ${report.evaluation.hardFailureCount} hard failure(s). report=${paths.reportPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[ok] GCP release inventory ${report.mode} complete - report=${paths.reportPath} evidence=${paths.evidencePath}`);
}

main().catch((error) => {
  console.error(`[fail] ${error.stack || error.message}`);
  process.exitCode = 1;
});
