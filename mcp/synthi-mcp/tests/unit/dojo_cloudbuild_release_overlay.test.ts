// @ts-nocheck
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function cloudbuildYaml() {
  return readFileSync("../../cloudbuild.yaml", "utf8");
}

describe("Dojo Cloud Build release overlay contract", () => {
  it("scans every Dockerfile variant for mutable images", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("id: reject-mutable-images");
    expect(yaml).toContain("--include='Dockerfile*'");
    expect(yaml).toContain("--include='*.yaml'");
    expect(yaml).toContain("--include='*.yml'");
  });

  it("builds the Dojo MCP host image only for the release-gate overlay", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("id: build-dojo-mcp-host");
    expect(yaml).toContain("KUSTOMIZE_DIR=${_KUSTOMIZE_DIR}");
    expect(yaml).toContain("DOJO_RELEASE_KUSTOMIZE_DIR=${_DOJO_RELEASE_KUSTOMIZE_DIR}");
    expect(yaml).toContain('if [ "$${KUSTOMIZE_DIR}" != "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]; then');
    expect(yaml).toContain("--dockerfile=mcp/synthi-mcp/Dockerfile.http");
  });

  it("fails closed on Dojo MCP host rollout when the release-gate overlay is selected", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain('DOJO_RELEASE_KUSTOMIZE_DIR="${_DOJO_RELEASE_KUSTOMIZE_DIR}"');
    expect(yaml).toContain('if [[ "$${KUSTOMIZE_DIR}" == "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]]; then');
    expect(yaml).toMatch(/if \[\[ "\$\$\{KUSTOMIZE_DIR\}" == "\$\$\{DOJO_RELEASE_KUSTOMIZE_DIR\}" \]\]; then\s+kubectl rollout status deployment\/dojo-mcp-host -n \$\$\{NS\} --timeout=300s\s+elif kubectl get deployment\/dojo-mcp-host/);
  });
});
