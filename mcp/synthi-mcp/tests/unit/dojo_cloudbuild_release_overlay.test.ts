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

function overlayCheckScript() {
  return readFileSync("../../mcp/synthi-mcp/scripts/dojo-kustomize-overlay-check.mjs", "utf8");
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
    expect(yaml).toContain("normalize_kustomize_dir()");
    expect(yaml).toContain('KUSTOMIZE_DIR="$$(normalize_kustomize_dir "$${KUSTOMIZE_DIR}")"');
    expect(yaml).toContain('DOJO_RELEASE_KUSTOMIZE_DIR="$$(normalize_kustomize_dir "$${DOJO_RELEASE_KUSTOMIZE_DIR}")"');
    expect(yaml).toContain('if [ "$${KUSTOMIZE_DIR}" != "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]; then');
    expect(yaml).toContain("--dockerfile=mcp/synthi-mcp/Dockerfile.http");
  });

  it("normalizes kustomize directory variants before production deploy submission", () => {
    const workflow = deployWorkflowYaml();
    const script = deployScript();

    expect(workflow).toContain("normalize_kustomize_dir()");
    expect(workflow).toContain('KUSTOMIZE_DIR="$(normalize_kustomize_dir "${KUSTOMIZE_DIR}")"');
    expect(script).toContain("normalize_kustomize_dir()");
    expect(script).toContain('KUSTOMIZE_DIR="$(normalize_kustomize_dir "$KUSTOMIZE_DIR")"');
  });

  it("fails closed on Dojo MCP host rollout when the release-gate overlay is selected", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain('DOJO_RELEASE_KUSTOMIZE_DIR="${_DOJO_RELEASE_KUSTOMIZE_DIR}"');
    expect(yaml).toContain('if [[ "$${KUSTOMIZE_DIR}" == "$${DOJO_RELEASE_KUSTOMIZE_DIR}" ]]; then');
    expect(yaml).toContain("kubectl rollout status deployment/dojo-mcp-host -n $${NS} --timeout=300s");
    expect(yaml).toContain("npm run live:dojo:seed-release-competency");
    expect(yaml).toContain("elif kubectl get deployment/dojo-mcp-host -n $${NS} >/dev/null 2>&1; then");
  });

  it("smoke tests kubectl auth before rendering and applying manifests", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("id: verify-kubectl-auth");
    expect(yaml).toContain("kubectl get namespace synthi");
    expect(yaml).toContain("- verify-kubectl-auth");
  });

  it("recovers generically from immutable Deployment selector drift", () => {
    const yaml = cloudbuildYaml();

    expect(yaml).toContain("apply_rendered_manifest()");
    expect(yaml).toContain('Deployment\\.apps "\\([^"]\\+\\)" is invalid: spec\\.selector:');
    expect(yaml).toContain("selector_drift_deployments");
    expect(yaml).toContain('kubectl delete deployment "$${deployment}" -n "$${NS}" --ignore-not-found');
    expect(yaml).toContain('kubectl wait --for=delete "deployment/$${deployment}" -n "$${NS}" --timeout=180s || true');
    expect(yaml).toContain("apply_rendered_manifest");
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

    expect(script).toContain('require_text "Dojo production enforcement" "SYNTHI_DOJO_PRODUCTION_ENFORCEMENT: \\"1\\""');
    expect(script).toContain('require_text "Dojo durable store requirement" "SYNTHI_DOJO_REQUIRE_DURABLE_STORE: \\"1\\""');
    expect(script).toContain('require_text "Dojo external control-plane store" "SYNTHI_DOJO_CONTROL_PLANE_STORE: postgres"');
    expect(script).toContain('require_text "Dojo external signing requirement" "SYNTHI_DOJO_REQUIRE_EXTERNAL_SIGNING: \\"1\\""');
    expect(script).toContain('require_text "Dojo evidence ledger requirement" "SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER: \\"1\\""');
    expect(script).toContain('require_text "Dojo external evidence ledger store" "SYNTHI_DOJO_EVIDENCE_LEDGER_STORE: postgres"');
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
    const overlayCheck = overlayCheckScript();
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
    expect(renderGuard).toContain("key: synthi-private-workflow-tool-store-key");
    expect(renderGuard).toContain("key: synthi-auth-checkpoint-store-key");
    expect(overlayCheck).toContain('"SYNTHI_PRIVATE_WORKFLOW_TOOL_STORE_KEY"');
    expect(overlayCheck).toContain('"SYNTHI_AUTH_CHECKPOINT_STORE_KEY"');
    expect(overlayCheck).toContain('{ kind: "NetworkPolicy", name: "allow-to-postgres" }');
    expect(overlayCheck).toContain('{ kind: "NetworkPolicy", name: "allow-to-redis" }');
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
