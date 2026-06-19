// @ts-nocheck
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const overlayRoot = path.join(repoRoot, "k8s/overlays/dojo-release-gate");

describe("Dojo release overlay kustomization", () => {
  it("routes the Dojo MCP ingress through a structured strategic merge patch", () => {
    const kustomization = readFileSync(path.join(overlayRoot, "kustomization.yaml"), "utf8");
    const ingressPatchPath = path.join(overlayRoot, "dojo-mcp-ingress.patch.yaml");
    const ingressPatch = readFileSync(ingressPatchPath, "utf8");

    expect(existsSync(ingressPatchPath)).toBe(true);
    expect(kustomization).toContain("- path: dojo-mcp-ingress.patch.yaml");
    expect(kustomization).not.toContain("/spec/rules/0/http/paths/0");
    expect(ingressPatch).toContain("kind: Ingress");
    expect(ingressPatch).toContain("namespace: synthi");
    expect(ingressPatch).toContain("path: /dojo/mcp");
    expect(ingressPatch).toContain("pathType: Prefix");
    expect(ingressPatch).toContain("name: dojo-mcp-host");
    expect(ingressPatch).toContain("number: 9467");
  });
});
