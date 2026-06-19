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

  it("parameterizes the source registry used for rendered manifest substitution", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("_MANIFEST_SOURCE_REGISTRY:");
    expect(yaml).toContain('MANIFEST_SOURCE_REGISTRY="${_MANIFEST_SOURCE_REGISTRY}"');
    expect(yaml).toContain('if [[ -z "$${MANIFEST_SOURCE_REGISTRY}" ]]; then');
    expect(yaml).toContain('sed -i "s|$${MANIFEST_SOURCE_REGISTRY}|$${REGISTRY}|g" "$${RENDERED}"');
    expect(yaml).toContain('sed "s|$${MANIFEST_SOURCE_REGISTRY}|$${REGISTRY}|g; s|build-tag-required|$${TAG}|g"');
    expect(yaml).not.toContain('DEFAULT_REGISTRY="europe-west10-docker.pkg.dev/vectant-proj/synthi"');
  });

  it("runs a full-fleet critical vulnerability scan before rollout", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("id: vulnerability-scan-images");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-frontend:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-collab-server:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-ai-engine:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-ai-gateway:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-signaling-server:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-worker:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-prisma-migrate:$${IMAGE_TAG}\"");
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-browser-workflow-bridge:$${IMAGE_TAG}\"");
    expect(yaml).toContain('if [ "$${KUSTOMIZE_DIR}" = "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]; then');
    expect(yaml).toContain("scan \"$${REGISTRY}/synthi-mcp-http:$${IMAGE_TAG}\"");
    expect(yaml).toContain("--ignorefile=backend/runtime-image/.trivyignore");
    expect(yaml).toContain("- vulnerability-scan-images");
    expect(yaml).not.toContain("id: vulnerability-scan-runtime");
    expect(yaml).not.toContain("First-party images aren't the untrusted surface");
  });
});
