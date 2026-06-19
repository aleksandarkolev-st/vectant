#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_INVENTORY_REPORT = path.resolve("tmp", "dojo-gcp-release-inventory", "dojo-gcp-release-inventory.json");
const DEFAULT_OUT_DIR = path.resolve("tmp", "dojo-gcp-release-blockers");

const CATEGORY_ORDER = [
  "read_only_plan",
  "cloud_api",
  "inventory_access",
  "cloud_resource",
  "kubernetes_context",
  "secret_inventory",
  "deployment_inventory",
  "warning",
  "unknown",
];

const STRICT_WARNING_BLOCKER_CATEGORIES = new Set([
  "cloud_api",
  "inventory_access",
  "cloud_resource",
  "kubernetes_context",
  "secret_inventory",
  "deployment_inventory",
]);

function parseArgs(argv) {
  const out = {
    inventoryReport: DEFAULT_INVENTORY_REPORT,
    outDir: DEFAULT_OUT_DIR,
    selfCheck: false,
    allowBlockers: false,
    advisory: false,
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

    if (arg === "--inventory-report") {
      out.inventoryReport = path.resolve(takeValue());
    } else if (arg === "--out-dir") {
      out.outDir = path.resolve(takeValue());
    } else if (arg === "--allow-blockers") {
      out.allowBlockers = true;
    } else if (arg === "--advisory") {
      out.advisory = true;
    } else if (arg === "--mode") {
      const mode = takeValue();
      if (mode !== "strict" && mode !== "advisory") {
        throw new Error("--mode must be strict or advisory");
      }
      out.advisory = mode === "advisory";
    } else if (arg === "--self-check") {
      out.selfCheck = true;
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
  console.log(`Summarize Agent Dojo Google Cloud release inventory blockers.

Usage:
  node scripts/dojo-gcp-release-blockers.mjs [options]

Options:
  --inventory-report <path>  Inventory report JSON path.
  --out-dir <path>           Directory for blocker JSON and Markdown artifacts.
  --mode <strict|advisory>   Strict is default. Advisory keeps evidence gaps as warnings.
  --advisory                 Alias for --mode advisory.
  --allow-blockers           Write artifacts but exit 0 even when blocked.
  --self-check               Run deterministic self-check without cloud access.

The script consumes the read-only inventory report produced by
dojo-gcp-release-inventory.mjs. It never calls gcloud, kubectl, or any mutating
cloud command.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function validateInventoryReport(report) {
  const errors = [];
  if (!report || typeof report !== "object") {
    errors.push("report is not an object");
    return errors;
  }
  if (report.schema_version !== "synthi.dojo.gcpReleaseInventory.v1") {
    errors.push(`unsupported schema_version ${JSON.stringify(report.schema_version)}`);
  }
  if (!report.evaluation || !Array.isArray(report.evaluation.checks)) {
    errors.push("missing evaluation.checks array");
  }
  if (!report.inventory || !Array.isArray(report.inventory.commandResults)) {
    errors.push("missing inventory.commandResults array");
  }
  return errors;
}

function buildBlockerReport(inventoryReport, sourcePath = "", options = {}) {
  const advisory = options.advisory === true;
  const checks = inventoryReport.evaluation.checks || [];
  const commandResults = new Map((inventoryReport.inventory.commandResults || []).map((item) => [item.id, item]));

  const blockerItems = [];
  const warningItems = [];
  for (const check of checks) {
    const classified = classifyReleaseCheck(check, commandResults, { advisory });
    if (!classified) {
      continue;
    }
    if (classified.kind === "blocker") {
      blockerItems.push(classified.item);
    } else {
      warningItems.push(classified.item);
    }
  }
  const blockers = dedupeReleaseItems(blockerItems);
  const warnings = dedupeReleaseItems(warningItems);

  const promotedWarningBlockers = blockers.filter((item) => item.promoted_from_warning === true);

  const blockedCategories = new Set(blockers.map((item) => item.category));
  const nextActions = buildNextActions(blockers, warnings);

  return {
    schema_version: "synthi.dojo.gcpReleaseBlockers.v1",
    created_at: new Date().toISOString(),
    source_inventory_report: sourcePath || null,
    source_inventory_sha256: sourcePath && existsSync(sourcePath)
      ? sha256(readFileSync(sourcePath, "utf8"))
      : sha256(JSON.stringify(inventoryReport)),
    inventory_created_at: inventoryReport.created_at || null,
    inventory_mode: inventoryReport.mode || null,
    project: inventoryReport.config?.project || null,
    region: inventoryReport.config?.region || null,
    cluster: inventoryReport.config?.cluster || null,
    namespace: inventoryReport.config?.namespace || null,
    mode: advisory ? "advisory" : "strict",
    release_ready: blockers.length === 0,
    blocked_category_count: blockedCategories.size,
    blocker_count: blockers.length,
    hard_blocker_count: blockers.length - promotedWarningBlockers.length,
    promoted_warning_blocker_count: promotedWarningBlockers.length,
    warning_count: warnings.length,
    blockers: sortByCategory(blockers),
    warnings: sortByCategory(warnings),
    next_actions: nextActions,
  };
}

function dedupeReleaseItems(items) {
  const byId = new Map();
  for (const item of items) {
    const key = `${item.severity}:${item.id}`;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, {
        ...item,
        occurrence_count: item.occurrence_count || 1,
      });
      continue;
    }
    existing.occurrence_count += item.occurrence_count || 1;
  }
  return [...byId.values()];
}

function classifyReleaseCheck(check, commandResults, options = {}) {
  if (!check || check.status === "passed" || check.status === "not_checked") {
    return null;
  }
  const category = categoryForCheck(check);
  const shouldPromoteWarning = options.advisory !== true
    && STRICT_WARNING_BLOCKER_CATEGORIES.has(category)
    && (check.status === "warning" || check.optional === true);
  if ((check.status === "failed" && check.optional !== true) || shouldPromoteWarning) {
    return {
      kind: "blocker",
      item: blockerFromCheck(check, commandResults, {
        promotedFromWarning: shouldPromoteWarning,
      }),
    };
  }
  if (check.status === "warning" || check.optional === true || check.status === "failed") {
    return {
      kind: "warning",
      item: warningFromCheck(check, commandResults),
    };
  }
  return null;
}

function blockerFromCheck(check, commandResults, options = {}) {
  const category = categoryForCheck(check);
  const datasetId = datasetIdForCheck(check);
  const commandResult = datasetId ? commandResults.get(datasetId) : null;
  const stderrPreview = firstNonEmpty(
    check.detail?.command_stderr_preview,
    commandResult?.stderrPreview,
  );
  return {
    id: check.id,
    category,
    severity: "release_blocker",
    promoted_from_warning: options.promotedFromWarning === true,
    summary: summaryForCheck(check, category),
    detail: check.detail || {},
    evidence: evidenceForCheck(check, commandResult, stderrPreview),
    remediation: remediationForCheck(check, category),
    verification: verificationForCheck(check, category),
  };
}

function warningFromCheck(check, commandResults) {
  const category = categoryForCheck(check);
  const datasetId = datasetIdForCheck(check);
  const commandResult = datasetId ? commandResults.get(datasetId) : null;
  const stderrPreview = firstNonEmpty(
    check.detail?.command_stderr_preview,
    commandResult?.stderrPreview,
  );
  return {
    id: check.id,
    category,
    severity: "warning",
    summary: summaryForCheck(check, category),
    detail: check.detail || {},
    evidence: evidenceForCheck(check, commandResult, stderrPreview),
    remediation: remediationForCheck(check, category),
    verification: verificationForCheck(check, category),
  };
}

function categoryForCheck(check) {
  if (check.id === "inventory_plan_read_only") {
    return "read_only_plan";
  }
  if (check.id.startsWith("api:")) {
    return "cloud_api";
  }
  if (check.id.startsWith("inventory_dataset:")) {
    return "inventory_access";
  }
  if (check.id.startsWith("k8s_secret:")
    || check.id.startsWith("secret_manager:")
    || check.id.startsWith("externalsecret")) {
    return "secret_inventory";
  }
  if (check.id.startsWith("k8s_deployment:")) {
    return "deployment_inventory";
  }
  if (check.id.startsWith("k8s_namespace:") || check.id.startsWith("k8s_ingress")) {
    return "kubernetes_context";
  }
  if (check.id === "kubectl_available") {
    return "kubernetes_context";
  }
  if (check.id === "gcloud_available") {
    return "inventory_access";
  }
  const reason = String(check.detail?.reason || "");
  if (reason.startsWith("k8s_") || reason.includes("kubectl")) {
    return "kubernetes_context";
  }
  if (["gke_cluster", "artifact_repository", "cloud_sql_instance", "redis_instance", "gcs_bucket"].includes(check.id)) {
    return "cloud_resource";
  }
  if (check.status === "warning" || check.optional === true) {
    return "warning";
  }
  return "unknown";
}

function datasetIdForCheck(check) {
  if (check.id.startsWith("inventory_dataset:")) {
    return check.id.slice("inventory_dataset:".length);
  }
  const reason = String(check.detail?.reason || "");
  const match = reason.match(/^(.+?)_(?:command_failed|parse_failed|dataset_unavailable|not_collected|collection_skipped)$/);
  return match ? match[1] : "";
}

function summaryForCheck(check, category) {
  if (category === "cloud_api") {
    return `Required Google Cloud API is not enabled or not visible: ${check.id.slice("api:".length)}`;
  }
  if (category === "inventory_access") {
    return `Required inventory dataset could not be collected: ${check.detail?.label || check.detail?.dataset || check.id}`;
  }
  if (category === "secret_inventory") {
    return `Required secret could not be verified: ${check.detail?.expectedName || check.id}`;
  }
  if (category === "deployment_inventory") {
    return `Required Kubernetes deployment could not be verified: ${check.detail?.expectedName || check.id}`;
  }
  if (category === "kubernetes_context") {
    return `Kubernetes inventory is unavailable for ${check.id}`;
  }
  if (category === "cloud_resource") {
    if (check.detail?.reason === "no_expected_name_provided") {
      return `Expected Google Cloud resource name is not configured: ${check.id}`;
    }
    return `Required Google Cloud resource could not be verified: ${check.detail?.expectedName || check.id}`;
  }
  if (category === "read_only_plan") {
    return "Inventory command plan contains a mutating command";
  }
  return `Release check is not passing: ${check.id}`;
}

function evidenceForCheck(check, commandResult, stderrPreview) {
  return {
    check_status: check.status,
    optional: check.optional === true,
    command_exit_code: Number.isInteger(commandResult?.exitCode)
      ? commandResult.exitCode
      : Number.isInteger(check.detail?.command_exit_code)
        ? check.detail.command_exit_code
        : null,
    command_stderr_preview: redactPromptNoise(stderrPreview || ""),
    stdout_sha256: commandResult?.stdoutSha256 || null,
    stderr_sha256: commandResult?.stderrSha256 || null,
  };
}

function remediationForCheck(check, category) {
  if (category === "cloud_api") {
    const apiName = check.id.slice("api:".length);
    return [
      `Enable or obtain access to ${apiName} in the target project.`,
      "Treat this as a cloud-state change requiring operator approval; do not auto-enable it from release validation.",
    ];
  }
  if (category === "inventory_access") {
    return [
      "Fix the inventory command prerequisite before judging whether the underlying resource exists.",
      "Common causes are a disabled Google API, missing IAM permission, wrong project, wrong region, or an unavailable local credential.",
    ];
  }
  if (category === "kubernetes_context" || category === "deployment_inventory") {
    return [
      "Select the target GKE context with the approved cluster credentials command.",
      "Rerun the read-only inventory after kubectl can read the target namespace.",
    ];
  }
  if (category === "secret_inventory") {
    return [
      "Verify Secret Manager remote secret names and External Secrets synchronization into the release namespace.",
      "Do not print or fetch secret payload values; only verify names, sync status, and Kubernetes secret presence.",
    ];
  }
  if (category === "cloud_resource") {
    if (check.detail?.reason === "no_expected_name_provided") {
      return [
        "Set the expected Google Cloud resource name before judging whether the resource exists.",
        "Use the inventory flag or environment variable for the resource, such as --cloud-sql-instance/CLOUD_SQL_INSTANCE, --redis-instance/REDIS_INSTANCE, --gcs-bucket/GCS_BUCKET, --cluster/GKE_CLUSTER, or --artifact-repository/AR_REPO.",
        "Rerun inventory after the expected name is configured; provisioning still requires separate operator approval.",
      ];
    }
    return [
      "Create, select, or grant read access to the named Google Cloud resource in the configured project and region.",
      "Rerun inventory before using that resource as release evidence.",
    ];
  }
  if (category === "read_only_plan") {
    return [
      "Remove mutating commands from the inventory plan.",
      "Release inventory must only use read, list, describe, and get operations.",
    ];
  }
  return [
    "Inspect the failed check detail and rerun the relevant preflight after correction.",
  ];
}

function verificationForCheck(check, category) {
  if (category === "cloud_api") {
    const apiName = check.id.slice("api:".length);
    return [
      `Rerun inventory and confirm api:${apiName} passes.`,
      "Confirm dependent inventory datasets no longer fail because of that API.",
    ];
  }
  if (category === "inventory_access") {
    return [
      `Rerun inventory and confirm ${check.id} passes or is no longer present as a hard failure.`,
      "Then confirm the named resource check passes instead of relying on unavailable data.",
    ];
  }
  if (category === "kubernetes_context" || category === "deployment_inventory" || category === "secret_inventory") {
    return [
      "Rerun inventory with the target kube context selected.",
      "Confirm Kubernetes warnings for namespace, deployments, services, ingress, ExternalSecrets, and secrets are gone.",
    ];
  }
  if (category === "cloud_resource") {
    if (check.detail?.reason === "no_expected_name_provided") {
      return [
        `Rerun inventory and confirm ${check.id} is no longer reported as not_configured.`,
        "Then confirm the named resource check passes against observed inventory.",
      ];
    }
    return [
      `Rerun inventory and confirm ${check.id} passes with observedCount greater than zero.`,
    ];
  }
  if (category === "read_only_plan") {
    return [
      "Rerun the blocker script and confirm no read_only_plan blocker remains.",
    ];
  }
  return [
    "Rerun the inventory and blocker summary; release_ready must be true before release evidence collection proceeds.",
  ];
}

function buildNextActions(blockers, warnings) {
  const actions = [];
  const byCategory = new Map();
  for (const blocker of blockers) {
    if (!byCategory.has(blocker.category)) {
      byCategory.set(blocker.category, []);
    }
    byCategory.get(blocker.category).push(blocker);
  }

  for (const category of CATEGORY_ORDER) {
    const items = byCategory.get(category) || [];
    if (items.length === 0) {
      continue;
    }
    actions.push({
      category,
      blocker_ids: items.map((item) => item.id),
      action: nextActionText(category, items),
    });
  }

  if (warnings.some((item) => item.category === "secret_inventory" || item.category === "deployment_inventory" || item.category === "kubernetes_context")) {
    actions.push({
      category: "kubernetes_context",
      blocker_ids: warnings
        .filter((item) => item.category === "secret_inventory" || item.category === "deployment_inventory" || item.category === "kubernetes_context")
        .map((item) => item.id),
      action: "After hard blockers are resolved, select the target GKE context and rerun inventory so Kubernetes and ExternalSecrets warnings become real pass/fail evidence.",
    });
  }

  return actions;
}

function nextActionText(category, items) {
  if (category === "cloud_api") {
    return `Operator approval needed to enable or grant visibility to ${items.length} required Google Cloud API check(s).`;
  }
  if (category === "inventory_access") {
    return `Restore read access for ${items.length} inventory dataset(s) before judging dependent resources.`;
  }
  if (category === "cloud_resource") {
    const missingNames = items.filter((item) => item.detail?.reason === "no_expected_name_provided");
    if (missingNames.length > 0) {
      return `Configure expected Google Cloud resource name(s) for ${missingNames.map((item) => item.id).join(", ")} before deciding whether provisioning is required.`;
    }
    return `Provision or grant read access to ${items.length} expected Google Cloud resource check(s).`;
  }
  if (category === "read_only_plan") {
    return "Fix the inventory plan before collecting release evidence; the plan must remain non-mutating.";
  }
  return `Resolve ${items.length} ${category} release blocker(s), then rerun inventory and this blocker summary.`;
}

function sortByCategory(items) {
  return [...items].sort((left, right) => {
    const categoryDelta = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return left.id.localeCompare(right.id);
  });
}

function writeArtifacts(config, blockerReport) {
  mkdirSync(config.outDir, { recursive: true });
  const jsonPath = path.join(config.outDir, "dojo-gcp-release-blockers.json");
  const markdownPath = path.join(config.outDir, "dojo-gcp-release-blockers.md");
  writeFileSync(jsonPath, `${JSON.stringify(blockerReport, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(blockerReport), "utf8");
  return { jsonPath, markdownPath };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Agent Dojo Google Cloud Release Blockers");
  lines.push("");
  lines.push(`- Release ready: ${report.release_ready ? "yes" : "no"}`);
  lines.push(`- Project: ${report.project || "not configured"}`);
  lines.push(`- Region: ${report.region || "not configured"}`);
  lines.push(`- Cluster: ${report.cluster || "not configured"}`);
  lines.push(`- Namespace: ${report.namespace || "not configured"}`);
  lines.push(`- Inventory mode: ${report.inventory_mode || "unknown"}`);
  lines.push(`- Blocker mode: ${report.mode || "strict"}`);
  lines.push(`- Hard blockers: ${report.blocker_count}`);
  if (report.promoted_warning_blocker_count > 0) {
    lines.push(`- Promoted warning blockers: ${report.promoted_warning_blocker_count}`);
  }
  lines.push(`- Warnings: ${report.warning_count}`);
  lines.push("");

  if (report.next_actions.length > 0) {
    lines.push("## Next Actions");
    lines.push("");
    for (const action of report.next_actions) {
      lines.push(`- **${action.category}:** ${action.action}`);
    }
    lines.push("");
  }

  lines.push("## Hard Blockers");
  lines.push("");
  if (report.blockers.length === 0) {
    lines.push("No hard blockers found in the inventory report.");
  } else {
    for (const blocker of report.blockers) {
      lines.push(`### ${blocker.id}`);
      lines.push("");
      lines.push(`- Category: ${blocker.category}`);
      lines.push(`- Summary: ${blocker.summary}`);
      if (blocker.promoted_from_warning) {
        lines.push("- Promoted from warning: yes");
      }
      if (blocker.occurrence_count > 1) {
        lines.push(`- Repeated check occurrences: ${blocker.occurrence_count}`);
      }
      if (blocker.evidence.command_exit_code !== null) {
        lines.push(`- Command exit code: ${blocker.evidence.command_exit_code}`);
      }
      if (blocker.evidence.command_stderr_preview) {
        lines.push(`- Command stderr preview: ${markdownInline(blocker.evidence.command_stderr_preview)}`);
      }
      lines.push("- Remediation:");
      for (const step of blocker.remediation) {
        lines.push(`  - ${step}`);
      }
      lines.push("- Verification:");
      for (const step of blocker.verification) {
        lines.push(`  - ${step}`);
      }
      lines.push("");
    }
  }

  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (report.warnings.length === 0) {
    lines.push("No warnings found in the inventory report.");
  } else {
    for (const warning of report.warnings.slice(0, 80)) {
      lines.push(`- **${warning.id}:** ${warning.summary}`);
    }
    if (report.warnings.length > 80) {
      lines.push(`- ... ${report.warnings.length - 80} additional warning(s) omitted from Markdown; see JSON artifact.`);
    }
  }
  lines.push("");
  lines.push("## Source Evidence");
  lines.push("");
  lines.push(`- Inventory report: ${report.source_inventory_report || "embedded self-check report"}`);
  lines.push(`- Inventory SHA256: ${report.source_inventory_sha256}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function markdownInline(value) {
  return `\`${String(value).replace(/\s+/g, " ").slice(0, 400).replace(/`/g, "'")}\``;
}

function redactPromptNoise(value) {
  return String(value)
    .replace(/Would\s+you\s+like\s+to\s+enable\s+and\s+retry.*?\(y\/N\)\?\s*/gis, "")
    .trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function runSelfCheck() {
  const blockedReport = {
    schema_version: "synthi.dojo.gcpReleaseInventory.v1",
    created_at: "2026-01-01T00:00:00.000Z",
    mode: "execute",
    config: {
      project: "self-check-project",
      region: "self-check-region",
      cluster: "self-check-cluster",
      namespace: "self-check-namespace",
    },
    inventory: {
      commandResults: [
        {
          id: "cloud_sql_instances",
          exitCode: 1,
          stderrPreview: "API [sqladmin.googleapis.com] not enabled on project [self-check-project].",
          stdoutSha256: null,
          stderrSha256: "self-check-sql-stderr",
        },
      ],
    },
    evaluation: {
      checks: [
        {
          id: "inventory_dataset:cloud_sql_instances",
          status: "failed",
          ok: false,
          detail: {
            dataset: "cloud_sql_instances",
            label: "Cloud SQL inventory",
            reason: "cloud_sql_instances_command_failed",
          },
        },
        {
          id: "api:sqladmin.googleapis.com",
          status: "failed",
          ok: false,
          detail: { api: "sqladmin.googleapis.com" },
        },
        {
          id: "k8s_secret:synthi-dojo-mcp-bearer-token",
          status: "warning",
          ok: false,
          optional: true,
          detail: {
            expectedName: "synthi-dojo-mcp-bearer-token",
            reason: "k8s_secret_names_command_failed",
          },
        },
      ],
    },
  };

  const blocked = buildBlockerReport(blockedReport);
  assert(blocked.release_ready === false, "blocked report should not be release ready");
  assert(blocked.blocker_count === 3, "blocked report should contain two hard blockers and one promoted warning blocker");
  assert(blocked.hard_blocker_count === 2, "blocked report should count hard blockers separately");
  assert(blocked.promoted_warning_blocker_count === 1, "blocked report should count promoted warning blockers");
  assert(blocked.blockers.some((item) => item.category === "cloud_api"), "API failure should be categorized");
  assert(blocked.blockers.some((item) => item.category === "inventory_access"), "dataset failure should be categorized");
  assert(blocked.blockers.some((item) => item.category === "secret_inventory" && item.promoted_from_warning === true), "secret warning should be promoted in strict mode");

  const advisory = buildBlockerReport(blockedReport, "", { advisory: true });
  assert(advisory.blocker_count === 2, "advisory report should keep warnings advisory");
  assert(advisory.warnings.some((item) => item.category === "secret_inventory"), "advisory report should keep secret warning categorized");

  const readyReport = {
    schema_version: "synthi.dojo.gcpReleaseInventory.v1",
    created_at: "2026-01-01T00:00:00.000Z",
    mode: "execute",
    config: {
      project: "self-check-project",
      region: "self-check-region",
      cluster: "self-check-cluster",
      namespace: "self-check-namespace",
    },
    inventory: { commandResults: [] },
    evaluation: {
      checks: [
        {
          id: "api:container.googleapis.com",
          status: "passed",
          ok: true,
          detail: { api: "container.googleapis.com" },
        },
      ],
    },
  };
  const ready = buildBlockerReport(readyReport);
  assert(ready.release_ready === true, "ready report should be release ready");
  assert(renderMarkdown(blocked).includes("Agent Dojo Google Cloud Release Blockers"), "markdown should render title");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`self-check failed: ${message}`);
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return;
  }
  if (config.selfCheck) {
    runSelfCheck();
    console.log("[ok] GCP release blocker summarizer self-check passed");
    return;
  }
  if (!existsSync(config.inventoryReport)) {
    throw new Error(`Inventory report not found: ${config.inventoryReport}`);
  }
  const inventoryReport = readJson(config.inventoryReport);
  const validationErrors = validateInventoryReport(inventoryReport);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid inventory report: ${validationErrors.join("; ")}`);
  }
  const blockerReport = buildBlockerReport(inventoryReport, config.inventoryReport, { advisory: config.advisory });
  const paths = writeArtifacts(config, blockerReport);
  const status = blockerReport.release_ready ? "ok" : "blocked";
  console.log(`[${status}] GCP release blockers written - json=${paths.jsonPath} markdown=${paths.markdownPath}`);
  if (!blockerReport.release_ready && !config.allowBlockers) {
    process.exitCode = 1;
  }
}

export {
  buildBlockerReport,
  categoryForCheck,
  classifyReleaseCheck,
  parseArgs,
  runSelfCheck,
  validateInventoryReport,
};

function isMain() {
  return process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
}

if (isMain()) {
  main().catch((error) => {
    console.error(`[fail] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
