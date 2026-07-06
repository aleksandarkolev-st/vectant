import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const basePolicies = readFileSync(join(repoRoot, "k8s", "network-policies.yaml"), "utf8");
const dojoMcpHost = readFileSync(join(repoRoot, "k8s", "overlays", "dojo-release-gate", "dojo-mcp-host.yaml"), "utf8");

const GCLB_RANGES = ["35.191.0.0/16", "130.211.0.0/22"];

function manifestDoc(contents, kind, name) {
  const docs = contents.split(/^---\s*$/m);
  return docs.find((doc) => {
    return new RegExp(`^kind:\\s*${escapeRegex(kind)}\\s*$`, "m").test(doc)
      && new RegExp(`^\\s*name:\\s*${escapeRegex(name)}\\s*$`, "m").test(doc);
  }) || "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPolicyAllowsOnlyGclb(policy, app, port) {
  assert.match(policy, new RegExp(`^\\s*app:\\s*${escapeRegex(app)}\\s*$`, "m"));
  assert.doesNotMatch(policy, /^\s*-\s*\{\}\s*$/m, "policy should not contain an open ingress rule");
  assert.doesNotMatch(policy, /^\s*-\s*podSelector:\s*\{\}\s*$/m, "policy should not allow every same-namespace pod");
  for (const range of GCLB_RANGES) {
    assert.match(policy, new RegExp(`^\\s*cidr:\\s*${escapeRegex(range)}\\s*$`, "m"));
  }
  assert.match(policy, new RegExp(`^\\s*(?:-\\s*)?port:\\s*${escapeRegex(String(port))}\\s*$`, "m"));
}

function assertPolicyAllowsPort(policy, port) {
  assert.match(policy, new RegExp(`^\\s*(?:-\\s*)?port:\\s*${escapeRegex(String(port))}\\s*$`, "m"));
}

function assertPolicyAllowsApps(policy, apps, port) {
  assert.doesNotMatch(policy, /^\s*-\s*\{\}\s*$/m, "policy should not contain an open ingress rule");
  assert.doesNotMatch(policy, /^\s*-\s*podSelector:\s*\{\}\s*$/m, "policy should not allow every same-namespace pod");
  for (const app of apps) {
    assert.match(policy, new RegExp(`^\\s*app:\\s*${escapeRegex(app)}\\s*$`, "m"));
  }
  assert.match(policy, new RegExp(`^\\s*(?:-\\s*)?port:\\s*${escapeRegex(String(port))}\\s*$`, "m"));
}

test("public base services are split into GCLB-only port policies", () => {
  assert.equal(manifestDoc(basePolicies, "NetworkPolicy", "allow-ingress-to-public-services"), "");

  assertPolicyAllowsOnlyGclb(manifestDoc(basePolicies, "NetworkPolicy", "allow-gclb-to-frontend"), "frontend", 3000);
  assertPolicyAllowsOnlyGclb(manifestDoc(basePolicies, "NetworkPolicy", "allow-gclb-to-collab-server"), "collab-server", 1234);
  const signalingPolicy = manifestDoc(basePolicies, "NetworkPolicy", "allow-gclb-to-signaling-server");
  assertPolicyAllowsOnlyGclb(signalingPolicy, "signaling-server", 9000);
  assertPolicyAllowsPort(signalingPolicy, 8080);
  assertPolicyAllowsOnlyGclb(manifestDoc(basePolicies, "NetworkPolicy", "allow-gclb-to-ai-gateway"), "ai-gateway", 7070);
});

test("cluster-internal services reject namespace-wide sources", () => {
  assertPolicyAllowsApps(manifestDoc(basePolicies, "NetworkPolicy", "allow-to-y-sweet"), ["y-sweet", "collab-server"], 8080);
  assertPolicyAllowsApps(manifestDoc(basePolicies, "NetworkPolicy", "allow-to-redis"), ["redis", "collab-server", "signaling-server"], 6379);
  assertPolicyAllowsApps(manifestDoc(basePolicies, "NetworkPolicy", "allow-to-postgres"), ["postgres", "frontend", "prisma-migrate"], 5432);
});

test("Dojo MCP public overlay ingress is GCLB-only", () => {
  const policy = manifestDoc(dojoMcpHost, "NetworkPolicy", "allow-to-dojo-mcp-host");
  assertPolicyAllowsOnlyGclb(policy, "dojo-mcp-host", 9467);
});
