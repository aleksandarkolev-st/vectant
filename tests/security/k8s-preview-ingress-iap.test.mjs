import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ingressYaml = readFileSync(join(repoRoot, "k8s", "ingress.yaml"), "utf8");
const collabYaml = readFileSync(join(repoRoot, "k8s", "collab-server.yaml"), "utf8");

function manifestDoc(contents, kind, name) {
  const docs = contents.split(/^---\s*$/m);
  return docs.find((doc) => {
    return new RegExp(`^kind:\\s*${escapeRegex(kind)}\\s*$`, "m").test(doc)
      && new RegExp(`^\\s*name:\\s*${escapeRegex(name)}\\s*$`, "m").test(doc);
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listItemBlock(doc, key, value) {
  const matcher = new RegExp(`^(\\s*)-\\s+${escapeRegex(key)}:\\s*"?${escapeRegex(value)}"?(?:\\s|$)`, "m");
  const match = matcher.exec(doc);
  if (!match) return "";
  const start = match.index;
  const indent = match[1].length;
  const rest = doc.slice(start + match[0].length);
  const nextSibling = new RegExp(`\\n\\s{${indent}}-\\s+\\w`);
  const siblingMatch = nextSibling.exec(rest);
  return doc.slice(start, siblingMatch ? start + match[0].length + siblingMatch.index : undefined);
}

test("wildcard preview ingress uses an IAP-protected backend", () => {
  const ingress = manifestDoc(ingressYaml, "Ingress", "synthi-ingress");
  assert.ok(ingress, "Ingress/synthi-ingress should exist");

  const previewHost = listItemBlock(ingress, "host", "*.preview.vectant.dev");
  assert.match(previewHost, /^\s*name:\s*collab-preview\s*$/m, "wildcard preview route should target Service/collab-preview");
  assert.match(previewHost, /^\s*number:\s*1234\s*$/m, "wildcard preview route should target the preview service port");

  const previewService = manifestDoc(collabYaml, "Service", "collab-preview");
  assert.ok(previewService, "Service/collab-preview should exist");
  assert.match(
    previewService,
    /cloud\.google\.com\/backend-config:\s*['"]?\{"ports":\{"1234":"preview-backend-config"\}\}['"]?/,
    "Service/collab-preview should bind port 1234 to BackendConfig/preview-backend-config",
  );

  const previewBackend = manifestDoc(ingressYaml, "BackendConfig", "preview-backend-config");
  assert.ok(previewBackend, "BackendConfig/preview-backend-config should exist");
  assert.match(previewBackend, /^\s*iap:\s*\n\s*enabled:\s*true\s*$/m, "preview backend must enable IAP");
});
