// @ts-nocheck
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Dojo release runbook manual rollout", () => {
  it("does not instruct operators to apply raw Kustomize output with image placeholders", () => {
    const runbook = readFileSync("../../docs/AGENT_DOJO_RELEASE_GATE_RUNBOOK.md", "utf8");

    expect(runbook).not.toContain("kubectl apply -k k8s/");
    expect(runbook).toContain("$env:RELEASE_REGISTRY");
    expect(runbook).toContain("$env:MANIFEST_SOURCE_REGISTRY");
    expect(runbook).toContain("$env:RELEASE_IMAGE_TAG");
    expect(runbook).toContain("Rendered base manifests still contain build-tag-required.");
    expect(runbook).toContain("Rendered Dojo release-gate manifests still contain build-tag-required.");
    expect(runbook).toContain("kubectl apply -f tmp/base-render.release.yaml");
    expect(runbook).toContain("kubectl apply -f tmp/dojo-release-gate-render.release.yaml");
  });
});
