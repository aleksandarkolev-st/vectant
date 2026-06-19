#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_OVERLAY_DIR = path.join(REPO_ROOT, "k8s", "overlays", "dojo-release-gate");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "tmp", "dojo-kustomize-overlay-check");
const DEFAULT_LOAD_RESTRICTOR = "LoadRestrictionsNone";

const FORBIDDEN_RESOURCES = [
  { kind: "StatefulSet", name: "postgres" },
  { kind: "Deployment", name: "redis" },
  { kind: "Service", name: "postgres" },
  { kind: "Service", name: "redis" },
];

const FORBIDDEN_LITERALS = [
  "redis://redis.synthi.svc.cluster.local:6379",
  "postgres://postgres.synthi.svc.cluster.local",
];

const REQUIRED_CONFIG_KEYS = [
  "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT",
  "SYNTHI_DOJO_REQUIRE_DURABLE_STORE",
  "SYNTHI_DOJO_CONTROL_PLANE_STORE",
  "SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING",
  "SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER",
  "SYNTHI_DOJO_EVIDENCE_LEDGER_STORE",
  "SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST",
  "SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS",
  "SYNTHI_TENANT_ID",
];

const REQUIRED_EXTERNAL_SECRET_KEYS = [
  "REDIS_URL",
  "SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL",
  "SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL",
  "SYNTHI_DOJO_PROOF_SIGNING_KEY_ID",
  "SYNTHI_DOJO_PROOF_SIGNING_COMMAND",
  "SYNTHI_DOJO_PROOF_SIGNING_COMMAND_ARGS",
  "SYNTHI_DOJO_PROOF_SIGNING_MANAGED_KEY_URI",
  "SYNTHI_DOJO_PROOF_SIGNING_PUBLIC_KEY_PEM",
  "SYNTHI_DOJO_MCP_MANIFEST_KEY_ID",
  "SYNTHI_DOJO_MCP_MANIFEST_PRIVATE_KEY_PEM",
  "SYNTHI_DOJO_MCP_MANIFEST_PUBLIC_KEY_PEM",
  "SYNTHI_DOJO_MCP_BEARER_TOKEN",
];

const REDIS_DEPLOYMENTS = ["collab-server", "signaling-server"];
const DOJO_MCP_HOST = {
  deployment: "dojo-mcp-host",
  service: "dojo-mcp-host",
  backendConfig: "dojo-mcp-host-backend-config",
  networkPolicy: "allow-to-dojo-mcp-host",
  image: "synthi-mcp-http:build-tag-required",
  host: "beta.vectant.dev",
  path: "/dojo/mcp",
  pathType: "Prefix",
  port: "9467",
};

function parseArgs(argv) {
  const options = {
    overlayDir: DEFAULT_OVERLAY_DIR,
    outDir: DEFAULT_OUT_DIR,
    loadRestrictor: DEFAULT_LOAD_RESTRICTOR,
    selfCheck: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const parsed = splitArg(argv[index]);
    const takeValue = () => {
      if (parsed.value !== undefined) return parsed.value;
      index += 1;
      return requireValue(argv, index, parsed.flag);
    };

    if (parsed.flag === "--overlay-dir") {
      options.overlayDir = path.resolve(takeValue());
    } else if (parsed.flag === "--out-dir") {
      options.outDir = path.resolve(takeValue());
    } else if (parsed.flag === "--load-restrictor") {
      options.loadRestrictor = takeValue();
    } else if (parsed.flag === "--self-check") {
      options.selfCheck = true;
    } else if (parsed.flag === "--help" || parsed.flag === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${parsed.flag}`);
    }
  }

  return options;
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
  console.log(`Validate the Agent Dojo release-gate kustomize overlay.

Usage:
  node scripts/dojo-kustomize-overlay-check.mjs [options]

Options:
  --self-check                  Run deterministic parser self-check.
  --overlay-dir <path>          Overlay directory to render.
  --load-restrictor <value>     Optional kustomize load restrictor. Default: ${DEFAULT_LOAD_RESTRICTOR}
  --out-dir <path>              Output directory for report and evidence.
`);
}

function renderKustomize(options) {
  if (!existsSync(options.overlayDir)) {
    return {
      ok: false,
      stdout: "",
      stderr: `overlay directory does not exist: ${options.overlayDir}`,
      status: 1,
      command: null,
    };
  }

  const args = ["kustomize", options.overlayDir];
  if (options.loadRestrictor) {
    args.push("--load-restrictor", options.loadRestrictor);
  }

  const result = spawnSync("kubectl", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
    command: ["kubectl", ...args],
  };
}

function parseRenderedResources(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter(Boolean)
    .map((doc) => ({
      kind: topField(doc, "kind"),
      name: metadataName(doc),
      doc,
    }));
}

function topField(doc, name) {
  const line = doc.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : undefined;
}

function metadataName(doc) {
  const lines = doc.split(/\r?\n/);
  const metadataIndex = lines.findIndex((line) => line === "metadata:");
  if (metadataIndex < 0) return undefined;

  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(" ")) break;
    const match = /^  name:\s*(.+)$/.exec(line);
    if (match) return match[1].trim();
  }

  return undefined;
}

function validateRenderedOverlay(rendered) {
  const resources = parseRenderedResources(rendered);
  const failures = [];

  for (const forbidden of FORBIDDEN_RESOURCES) {
    if (resources.some((resource) => resource.kind === forbidden.kind && resource.name === forbidden.name)) {
      failures.push({
        code: "forbidden_resource_rendered",
        message: `${forbidden.kind}/${forbidden.name} must not be rendered by the Dojo release overlay.`,
      });
    }
  }

  for (const literal of FORBIDDEN_LITERALS) {
    if (rendered.includes(literal)) {
      failures.push({
        code: "forbidden_in_cluster_literal_rendered",
        message: `Forbidden in-cluster literal rendered: ${literal}`,
      });
    }
  }

  const config = findResource(resources, "ConfigMap", "synthi-config");
  if (!config) {
    failures.push({ code: "missing_config_map", message: "ConfigMap/synthi-config was not rendered." });
  } else {
    for (const key of REQUIRED_CONFIG_KEYS) {
      if (!hasDataKey(config.doc, key)) {
        failures.push({ code: "missing_dojo_config_key", message: `Missing synthi-config data key: ${key}` });
      }
    }
    if (hasDataKey(config.doc, "REDIS_URL")) {
      failures.push({
        code: "config_map_redis_url_present",
        message: "synthi-config must not contain REDIS_URL in the Dojo release overlay.",
      });
    }
  }

  for (const deploymentName of REDIS_DEPLOYMENTS) {
    const deployment = findResource(resources, "Deployment", deploymentName);
    if (!deployment) {
      failures.push({ code: "missing_redis_deployment", message: `Deployment/${deploymentName} was not rendered.` });
      continue;
    }
    const redisBlocks = envBlocks(deployment.doc, "REDIS_URL");
    if (redisBlocks.length !== 1) {
      failures.push({
        code: "invalid_redis_env_count",
        message: `Deployment/${deploymentName} must have exactly one REDIS_URL env entry, got ${redisBlocks.length}.`,
      });
      continue;
    }
    if (!isSecretBackedEnvBlock(redisBlocks[0], "synthi-secrets", "REDIS_URL")) {
      failures.push({
        code: "redis_env_not_secret_backed",
        message: `Deployment/${deploymentName} REDIS_URL must read from synthi-secrets/REDIS_URL.`,
      });
    }
  }

  const releaseSecret = findResource(resources, "ExternalSecret", "synthi-dojo-release-secrets");
  if (!releaseSecret) {
    failures.push({
      code: "missing_dojo_release_external_secret",
      message: "ExternalSecret/synthi-dojo-release-secrets was not rendered.",
    });
  } else {
    for (const key of REQUIRED_EXTERNAL_SECRET_KEYS) {
      if (!externalSecretHasKey(releaseSecret.doc, key)) {
        failures.push({
          code: "missing_dojo_release_secret_key",
          message: `ExternalSecret/synthi-dojo-release-secrets does not write key: ${key}`,
        });
      }
    }
  }

  const mcpDeployment = findResource(resources, "Deployment", DOJO_MCP_HOST.deployment);
  if (!mcpDeployment) {
    failures.push({
      code: "missing_dojo_mcp_host_deployment",
      message: `Deployment/${DOJO_MCP_HOST.deployment} was not rendered.`,
    });
  } else {
    if (!mcpDeployment.doc.includes(DOJO_MCP_HOST.image)) {
      failures.push({
        code: "dojo_mcp_host_image_missing",
        message: `Deployment/${DOJO_MCP_HOST.deployment} must use ${DOJO_MCP_HOST.image}.`,
      });
    }
    if (!hasEnvFromRef(mcpDeployment.doc, "configMapRef", "synthi-config")) {
      failures.push({
        code: "dojo_mcp_host_config_not_loaded",
        message: `Deployment/${DOJO_MCP_HOST.deployment} must load ConfigMap/synthi-config.`,
      });
    }
    if (!hasEnvFromRef(mcpDeployment.doc, "secretRef", "synthi-secrets")) {
      failures.push({
        code: "dojo_mcp_host_secret_not_loaded",
        message: `Deployment/${DOJO_MCP_HOST.deployment} must load Secret/synthi-secrets.`,
      });
    }
    for (const [envName, expectedValue] of [
      ["SYNTHI_MCP_HTTP_HOST", "0.0.0.0"],
      ["SYNTHI_MCP_HTTP_PORT", DOJO_MCP_HOST.port],
      ["SYNTHI_MCP_HTTP_PATH", DOJO_MCP_HOST.path],
      ["SYNTHI_MCP_HTTP_HEALTH_PATH", "/healthz"],
    ]) {
      const blocks = envBlocks(mcpDeployment.doc, envName);
      if (blocks.length !== 1 || !isLiteralEnvBlock(blocks[0], expectedValue)) {
        failures.push({
          code: "dojo_mcp_host_env_invalid",
          message: `Deployment/${DOJO_MCP_HOST.deployment} must set ${envName}=${expectedValue}.`,
        });
      }
    }
  }

  const mcpService = findResource(resources, "Service", DOJO_MCP_HOST.service);
  if (!mcpService) {
    failures.push({ code: "missing_dojo_mcp_host_service", message: `Service/${DOJO_MCP_HOST.service} was not rendered.` });
  } else {
    if (!mcpService.doc.includes(DOJO_MCP_HOST.backendConfig)) {
      failures.push({
        code: "dojo_mcp_host_backend_config_not_bound",
        message: `Service/${DOJO_MCP_HOST.service} must bind BackendConfig/${DOJO_MCP_HOST.backendConfig}.`,
      });
    }
    if (!new RegExp(`port:\\s*${DOJO_MCP_HOST.port}(?:\\s|$)`).test(mcpService.doc)) {
      failures.push({
        code: "dojo_mcp_host_service_port_missing",
        message: `Service/${DOJO_MCP_HOST.service} must expose port ${DOJO_MCP_HOST.port}.`,
      });
    }
    if (!serviceHasIngressNeg(mcpService.doc)) {
      failures.push({
        code: "dojo_mcp_host_neg_not_enabled",
        message: `Service/${DOJO_MCP_HOST.service} must enable a GKE ingress NEG.`,
      });
    }
    if (!new RegExp(`^\\s*type:\\s*NodePort(?:\\s|$)`, "m").test(mcpService.doc)) {
      failures.push({
        code: "dojo_mcp_host_service_type_invalid",
        message: `Service/${DOJO_MCP_HOST.service} must be type NodePort for the GKE ingress backend.`,
      });
    }
  }

  const mcpBackendConfig = findResource(resources, "BackendConfig", DOJO_MCP_HOST.backendConfig);
  if (!mcpBackendConfig) {
    failures.push({
      code: "missing_dojo_mcp_host_backend_config",
      message: `BackendConfig/${DOJO_MCP_HOST.backendConfig} was not rendered.`,
    });
  } else if (!backendConfigIapEnabled(mcpBackendConfig.doc)) {
    failures.push({
      code: "dojo_mcp_host_iap_not_enabled",
      message: `BackendConfig/${DOJO_MCP_HOST.backendConfig} must enable IAP for the public MCP backend.`,
    });
  }

  const mcpNetworkPolicy = findResource(resources, "NetworkPolicy", DOJO_MCP_HOST.networkPolicy);
  if (!mcpNetworkPolicy) {
    failures.push({
      code: "missing_dojo_mcp_host_network_policy",
      message: `NetworkPolicy/${DOJO_MCP_HOST.networkPolicy} was not rendered.`,
    });
  }

  const ingress = findResource(resources, "Ingress", "synthi-ingress");
  if (!ingress) {
    failures.push({ code: "missing_ingress", message: "Ingress/synthi-ingress was not rendered." });
  } else if (!ingressRoutesToService(ingress.doc, DOJO_MCP_HOST)) {
    failures.push({
      code: "dojo_mcp_host_ingress_missing",
      message: `Ingress/synthi-ingress must route ${DOJO_MCP_HOST.host}${DOJO_MCP_HOST.path} to Service/${DOJO_MCP_HOST.service}:${DOJO_MCP_HOST.port}.`,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    resourceCount: resources.length,
    renderedSha256: sha256(rendered),
  };
}

function findResource(resources, kind, name) {
  return resources.find((resource) => resource.kind === kind && resource.name === name);
}

function hasDataKey(doc, key) {
  const dataBlock = blockAfter(doc, "data:");
  return new RegExp(`^  ${escapeRegex(key)}:`, "m").test(dataBlock);
}

function externalSecretHasKey(doc, key) {
  return new RegExp(`secretKey:\\s*${escapeRegex(key)}(?:\\s|$)`).test(doc);
}

function envBlocks(doc, envName) {
  const lines = doc.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!new RegExp(`^\\s*- name:\\s*${escapeRegex(envName)}\\s*$`).test(lines[index])) continue;
    const indent = leadingSpaces(lines[index]);
    const block = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.startsWith(`${" ".repeat(indent)}- name:`)) break;
      block.push(line);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function isSecretBackedEnvBlock(block, secretName, secretKey) {
  return (
    /valueFrom:\s*\n/.test(block) &&
    /secretKeyRef:\s*\n/.test(block) &&
    new RegExp(`name:\\s*${escapeRegex(secretName)}(?:\\s|$)`).test(block) &&
    new RegExp(`key:\\s*${escapeRegex(secretKey)}(?:\\s|$)`).test(block) &&
    !/^\s*value:\s*/m.test(block) &&
    !/configMapKeyRef:\s*\n/.test(block)
  );
}

function isLiteralEnvBlock(block, expectedValue) {
  return new RegExp(`^\\s*value:\\s*"?${escapeRegex(expectedValue)}"?(?:\\s|$)`, "m").test(block)
    && !/valueFrom:\s*\n/.test(block);
}

function hasEnvFromRef(doc, refKind, name) {
  return new RegExp(`${escapeRegex(refKind)}:\\s*\\n\\s*name:\\s*${escapeRegex(name)}(?:\\s|$)`).test(doc);
}

function backendConfigIapEnabled(doc) {
  return /iap:\s*\n\s*enabled:\s*true(?:\s|$)/.test(doc);
}

function serviceHasIngressNeg(doc) {
  return /cloud\.google\.com\/neg:\s*['"]?\{"ingress":\s*true\}['"]?/.test(doc);
}

function ingressRoutesToService(doc, expected) {
  const hostBlock = listItemBlock(doc, "host", expected.host);
  if (!hostBlock) return false;
  return listBlocksAfterHeader(hostBlock, "paths").some((pathBlock) => {
    return new RegExp(`^\\s*(?:-\\s+)?path:\\s*${escapeRegex(expected.path)}(?:\\s|$)`, "m").test(pathBlock)
    && new RegExp(`^\\s*pathType:\\s*${escapeRegex(expected.pathType)}(?:\\s|$)`, "m").test(pathBlock)
    && new RegExp(`^\\s*name:\\s*${escapeRegex(expected.service)}(?:\\s|$)`, "m").test(pathBlock)
    && new RegExp(`^\\s*number:\\s*${escapeRegex(expected.port)}(?:\\s|$)`, "m").test(pathBlock);
  });
}

function listItemBlock(doc, key, value) {
  const lines = doc.split(/\r?\n/);
  const matcher = new RegExp(`^(\\s*)-\\s+${escapeRegex(key)}:\\s*"?${escapeRegex(value)}"?(?:\\s|$)`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = matcher.exec(lines[index]);
    if (!match) continue;
    const indent = match[1].length;
    const block = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line && leadingSpaces(line) <= indent && !/^\s*$/.test(line)) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return "";
}

function listBlocksAfterHeader(doc, headerKey) {
  const lines = doc.split(/\r?\n/);
  const header = new RegExp(`^(\\s*)${escapeRegex(headerKey)}:\\s*$`);
  const headerIndex = lines.findIndex((line) => header.test(line));
  if (headerIndex < 0) return [];
  const headerIndent = leadingSpaces(lines[headerIndex]);
  const blocks = [];
  let itemIndent = null;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && leadingSpaces(line) < headerIndent && !/^\s*$/.test(line)) break;
    if (!/^\s*-\s+/.test(line)) continue;
    const indent = leadingSpaces(line);
    if (indent < headerIndent) break;
    if (itemIndent === null) itemIndent = indent;
    if (indent !== itemIndent) continue;
    const block = [line];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate && leadingSpaces(candidate) <= indent && !/^\s*$/.test(candidate)) break;
      block.push(candidate);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function blockAfter(doc, header) {
  const lines = doc.split(/\r?\n/);
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return "";
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(" ")) break;
    block.push(line);
  }
  return block.join("\n");
}

function leadingSpaces(line) {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeReport(options, report) {
  mkdirSync(options.outDir, { recursive: true });
  const reportPath = path.join(options.outDir, "dojo-kustomize-overlay-check.json");
  const evidencePath = path.join(options.outDir, "dojo-kustomize-overlay-check.evidence.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        kind: "dojo_kustomize_overlay_check_evidence",
        ok: report.ok,
        generated_at: report.generated_at,
        report_sha256: sha256(JSON.stringify(report)),
        rendered_sha256: report.rendered_sha256,
        report_path: reportPath,
      },
      null,
      2,
    )}\n`,
  );
  return { reportPath, evidencePath };
}

function selfCheck() {
  const validRendered = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: synthi-config
data:
  SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: "1"
  SYNTHI_DOJO_REQUIRE_DURABLE_STORE: "1"
  SYNTHI_DOJO_CONTROL_PLANE_STORE: postgres
  SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING: "1"
  SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER: "1"
  SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: postgres
  SYNTHI_HOSTED_BROWSER_ORIGIN_ALLOWLIST: https://beta.vectant.dev
  SYNTHI_HOSTED_BROWSER_REDACT_SCREENSHOTS: "true"
  SYNTHI_TENANT_ID: vectant
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: collab-server
spec:
  template:
    spec:
      containers:
      - name: collab
        env:
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              key: REDIS_URL
              name: synthi-secrets
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: signaling-server
spec:
  template:
    spec:
      containers:
      - name: signaling
        env:
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              key: REDIS_URL
              name: synthi-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: synthi-dojo-release-secrets
spec:
  data:
${REQUIRED_EXTERNAL_SECRET_KEYS.map((key) => `  - secretKey: ${key}\n    remoteRef:\n      key: ${key.toLowerCase()}`).join("\n")}
---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: dojo-mcp-host-backend-config
spec:
  iap:
    enabled: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dojo-mcp-host
spec:
  template:
    spec:
      containers:
      - name: dojo-mcp-host
        image: europe-west10-docker.pkg.dev/vectant-proj/synthi/synthi-mcp-http:build-tag-required
        envFrom:
        - configMapRef:
            name: synthi-config
        - secretRef:
            name: synthi-secrets
        env:
        - name: SYNTHI_MCP_HTTP_HOST
          value: "0.0.0.0"
        - name: SYNTHI_MCP_HTTP_PORT
          value: "9467"
        - name: SYNTHI_MCP_HTTP_PATH
          value: "/dojo/mcp"
        - name: SYNTHI_MCP_HTTP_HEALTH_PATH
          value: "/healthz"
---
apiVersion: v1
kind: Service
metadata:
  name: dojo-mcp-host
  annotations:
    cloud.google.com/backend-config: '{"ports":{"9467":"dojo-mcp-host-backend-config"}}'
    cloud.google.com/neg: '{"ingress": true}'
spec:
  type: NodePort
  ports:
  - port: 9467
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-to-dojo-mcp-host
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: synthi-ingress
spec:
  rules:
  - host: beta.vectant.dev
    http:
      paths:
      - path: /dojo/mcp
        pathType: Prefix
        backend:
          service:
            name: dojo-mcp-host
            port:
              number: 9467
`;

  const valid = validateRenderedOverlay(validRendered);
  if (!valid.ok) {
    throw new Error(`valid self-check fixture failed: ${valid.failures.map((failure) => failure.message).join("; ")}`);
  }

  const invalid = validateRenderedOverlay(`${validRendered}\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: redis\n`);
  if (invalid.ok || !invalid.failures.some((failure) => failure.code === "forbidden_resource_rendered")) {
    throw new Error("invalid self-check fixture did not detect forbidden Redis deployment");
  }

  const invalidIngress = validateRenderedOverlay(validRendered.replace("host: beta.vectant.dev", "host: preview.vectant.dev"));
  if (invalidIngress.ok || !invalidIngress.failures.some((failure) => failure.code === "dojo_mcp_host_ingress_missing")) {
    throw new Error("invalid self-check fixture did not detect MCP host ingress on the wrong host");
  }

  const invalidService = validateRenderedOverlay(validRendered.replace("    cloud.google.com/neg: '{\"ingress\": true}'\n", ""));
  if (invalidService.ok || !invalidService.failures.some((failure) => failure.code === "dojo_mcp_host_neg_not_enabled")) {
    throw new Error("invalid self-check fixture did not detect missing MCP host NEG annotation");
  }

  const invalidBackend = validateRenderedOverlay(validRendered.replace("  iap:\n    enabled: true\n", ""));
  if (invalidBackend.ok || !invalidBackend.failures.some((failure) => failure.code === "dojo_mcp_host_iap_not_enabled")) {
    throw new Error("invalid self-check fixture did not detect missing MCP host IAP");
  }

  return {
    ok: true,
    resourceCount: valid.resourceCount,
    renderedSha256: valid.renderedSha256,
    failures: [],
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const generatedAt = new Date().toISOString();
  let validation;
  let render = {
    ok: true,
    stdout: "",
    stderr: "",
    status: 0,
    command: ["self-check"],
  };

  if (options.selfCheck) {
    validation = selfCheck();
  } else {
    render = renderKustomize(options);
    validation = render.ok
      ? validateRenderedOverlay(render.stdout)
      : {
          ok: false,
          failures: [{ code: "kustomize_render_failed", message: render.stderr || "kubectl kustomize failed" }],
          resourceCount: 0,
          renderedSha256: null,
        };
  }

  const report = {
    kind: "dojo_kustomize_overlay_check",
    ok: render.ok && validation.ok,
    generated_at: generatedAt,
    overlay_dir: options.overlayDir,
    load_restrictor: options.loadRestrictor,
    command: render.command,
    render_status: render.status,
    rendered_sha256: validation.renderedSha256,
    resource_count: validation.resourceCount,
    failures: validation.failures,
    stderr: render.stderr,
  };

  const { reportPath, evidencePath } = writeReport(options, report);
  if (!report.ok) {
    console.error(`[fail] Dojo kustomize overlay check failed - report=${reportPath}`);
    for (const failure of report.failures) console.error(`- ${failure.code}: ${failure.message}`);
    process.exit(1);
  }

  console.log(`[ok] Dojo kustomize overlay check passed - report=${reportPath} evidence=${evidencePath}`);
}

main();
