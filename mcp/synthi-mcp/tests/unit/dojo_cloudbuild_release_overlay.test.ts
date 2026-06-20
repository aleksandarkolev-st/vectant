// @ts-nocheck
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function cloudbuildYaml() {
  return readFileSync("../../cloudbuild.yaml", "utf8");
}

function deployWorkflowYaml() {
  return readFileSync("../../.github/workflows/deploy-prod.yml", "utf8");
}

function deployScript() {
  return readFileSync("../../scripts/deploy-prod.sh", "utf8");
}

function renderGuardScript() {
  return readFileSync("../../scripts/validate-dojo-release-render.sh", "utf8");
}

describe("Dojo Cloud Build release overlay contract", () => {
  it("defaults every production deploy entrypoint to the Dojo release overlay", () => {
    const cloudbuild = cloudbuildYaml();
    const workflow = deployWorkflowYaml();
    const script = deployScript();

    expect(cloudbuild).toContain("_KUSTOMIZE_DIR: k8s/overlays/dojo-release-gate");
    expect(cloudbuild).toContain("_KUSTOMIZE_LOAD_RESTRICTOR: LoadRestrictionsNone");
    expect(workflow).toContain('default: "k8s/overlays/dojo-release-gate"');
    expect(workflow).toContain('default: "LoadRestrictionsNone"');
    expect(workflow).toContain("github.event.inputs.kustomize_dir || 'k8s/overlays/dojo-release-gate'");
    expect(workflow).toContain("github.event.inputs.kustomize_load_restrictor || 'LoadRestrictionsNone'");
    expect(script).toContain('KUSTOMIZE_DIR="k8s/overlays/dojo-release-gate"');
    expect(script).toContain('KUSTOMIZE_LOAD_RESTRICTOR="LoadRestrictionsNone"');
  });

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
    expect(yaml).toContain("kubectl rollout status deployment/dojo-mcp-host -n $${NS} --timeout=300s");
    expect(yaml).toContain("npm run live:dojo:seed-release-competency");
    expect(yaml).toContain("elif kubectl get deployment/dojo-mcp-host -n $${NS} >/dev/null 2>&1; then");
  });

  it("cleans stale in-cluster beta stores only for Dojo release deploys", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain('if [[ "$${KUSTOMIZE_DIR}" == "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]]; then');
    expect(yaml).toContain("deployment/redis");
    expect(yaml).toContain("service/redis");
    expect(yaml).toContain("statefulset/postgres");
    expect(yaml).toContain("service/postgres");
    expect(yaml).toContain("networkpolicy/allow-to-redis");
    expect(yaml).toContain("networkpolicy/allow-to-postgres");
    expect(yaml).not.toContain("persistentvolumeclaim/postgres");
    expect(yaml).not.toContain("persistentvolumeclaim/redis");
  });

  it("fails the Dojo render guard when beta Redis or Postgres resources leak back in", () => {
    const script = renderGuardScript();

    expect(script).toContain('reject_text "in-cluster Redis URL" "redis://redis.synthi.svc.cluster.local:6379"');
    expect(script).toContain('reject_resource "Deployment" "redis"');
    expect(script).toContain('reject_resource "Service" "redis"');
    expect(script).toContain('reject_resource "StatefulSet" "postgres"');
    expect(script).toContain('reject_resource "Service" "postgres"');
    expect(script).toContain('reject_resource "NetworkPolicy" "allow-to-redis"');
    expect(script).toContain('reject_resource "NetworkPolicy" "allow-to-postgres"');
  });

  it("keeps Dojo release workflow and checkpoint state secrets self-contained", () => {
    const renderGuard = renderGuardScript();
    const releaseSecrets = readFileSync("../../k8s/overlays/dojo-release-gate/dojo-release-external-secrets.yaml", "utf8");

    expect(releaseSecrets).toContain("secretKey: SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_FILE");
    expect(releaseSecrets).toContain("secretKey: SYNTHI_PRIVATE_WORKFLOW_TOOL_SCOPE");
    expect(releaseSecrets).toContain("secretKey: SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY");
    expect(releaseSecrets).toContain("key: synthi-private-workflow-tool-store-key");
    expect(releaseSecrets).toContain("secretKey: SYNTHI_AUTH_CHECKPOINT_STORE_FILE");
    expect(releaseSecrets).toContain("secretKey: SYNTHI_AUTH_CHECKPOINT_SCOPE");
    expect(releaseSecrets).toContain("secretKey: SYNTHI_AUTH_CHECKPOINT_STORE_KEY");
    expect(releaseSecrets).toContain("key: synthi-auth-checkpoint-store-key");
    expect(renderGuard).toContain("Dojo release render guard");
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
