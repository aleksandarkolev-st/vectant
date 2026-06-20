// @ts-nocheck
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDojoReleaseCompetencySeedConfig,
  buildReleasePublicationEvidenceInput,
  runDojoReleaseCompetencySeed,
} from "../../scripts/dojo-release-competency-seed.mjs";

describe("Dojo release competency seed harness", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds release tenant context from existing production env names", () => {
    const config = buildDojoReleaseCompetencySeedConfig({
      env: {
        SYNTHI_TENANT_ID: "vectant",
        SYNTHI_WORKSPACE_ID: "release-workspace",
        SYNTHI_AGENT_ID: "release-agent",
        SYNTHI_HOSTED_BROWSER_WORKSPACE_URL: "https://beta.vectant.dev/workspace/release-workspace",
      },
      now: "2026-06-20T00:00:00.000Z",
    });

    expect(config.tenant).toEqual(expect.objectContaining({
      tenant_id: "vectant",
      organization_id: "vectant",
      workspace_id: "release-workspace",
      actor_id: "release-agent",
      actor_type: "service",
      roles: ["dojo:operator"],
    }));
    expect(config.workflow.origin).toBe("https://beta.vectant.dev");
    expect(config.workflow.url).toBe("https://beta.vectant.dev/dojo-release-seed");
  });

  it("builds scoped publication evidence for the candidate skill", () => {
    const config = buildDojoReleaseCompetencySeedConfig({
      env: {
        SYNTHI_TENANT_ID: "tenant-a",
        SYNTHI_WORKSPACE_ID: "workspace-a",
        SYNTHI_AGENT_ID: "agent-a",
        FRONTEND_URL: "https://app.example.test",
      },
      now: "2026-06-20T00:00:00.000Z",
    });
    const record = buildReleasePublicationEvidenceInput({
      config,
      artifact: { workflow_id: "workflow-a" },
      candidateSkill: { skill_id: "skill-a" },
    });

    expect(record).toEqual(expect.objectContaining({
      skill_id: "skill-a",
      kind: "audit",
      retention_class: "standard",
      claim_ids: ["publication_reviewed"],
      created_by: "agent-a",
    }));
    expect(record.record_id).toMatch(/^dojo_release_publication_[a-f0-9]{24}$/);
    expect(record.source_refs).toEqual(expect.arrayContaining(["workflow:workflow-a", "skill:skill-a"]));
  });

  it("records a workflow, appends ledger evidence, and publishes through synthi_dojo_publish_skill", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "dojo-release-seed-"));
    tmpDirs.push(outDir);
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const artifact = {
      workflow_id: "workflow-release-seed",
      workflow: {
        contract: { workflowId: "workflow-release-seed" },
        card: { stepCount: 1 },
      },
      events: [{ event_id: "event-a" }],
    };
    const modules = {
      browserBroker: {
        resetForTests: () => undefined,
        requestConsent: () => undefined,
        registerTabs: () => undefined,
        selectTab: () => undefined,
        startTeachMode: () => ({ ok: true }),
        recordHumanAction: () => undefined,
        workflowArtifact: () => ({ ok: true, artifact }),
      },
      generatePrivateWorkflowToolManifest: () => ({
        status: "available",
        tool_name: "synthi_app_release_seed",
        workflow_id: "workflow-release-seed",
      }),
      buildDojoSkill: (_contract, options) => ({
        skill_id: "skill-release-seed",
        workflow_id: "workflow-release-seed",
        workspace_id: options.workspace_id,
      }),
      resolveDojoEvidenceLedgerAppendStore: async () => ({
        ok: true,
        evidence_ledger: {
          append: async (input) => ({
            record_id: input.record_id,
          }),
        },
        close: async () => undefined,
      }),
      dispatchDojoTool: async (tool, args) => {
        calls.push({ tool, args });
        return {
          structuredContent: {
            ok: true,
            skill: {
              skill_id: "skill-release-seed",
              workflow_id: "workflow-release-seed",
              readiness_level: "SRL3",
              entrustment_level: "E1",
            },
            private_tool: {
              ok: true,
              tool_name: "synthi_app_release_seed",
              manifest_status: "available",
            },
            publication: {
              ok: true,
              control_plane_persistence: {
                ok: true,
                store_kind: "postgres",
                skill_id: "skill-release-seed",
                workflow_id: "workflow-release-seed",
                status: "published",
              },
            },
          },
        };
      },
    };

    const result = await runDojoReleaseCompetencySeed({
      env: {
        SYNTHI_TENANT_ID: "tenant-a",
        SYNTHI_WORKSPACE_ID: "workspace-a",
        SYNTHI_AGENT_ID: "agent-a",
        FRONTEND_URL: "https://app.example.test",
      },
      outDir,
      now: "2026-06-20T00:00:00.000Z",
      modules,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("synthi_dojo_publish_skill");
    expect(calls[0].args).toEqual(expect.objectContaining({
      workflow_id: "workflow-release-seed",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      actor_id: "agent-a",
      evidence_refs: [expect.stringMatching(/^dojo_release_publication_[a-f0-9]{24}$/)],
    }));
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.skill.skill_id).toBe("skill-release-seed");
    expect(report.private_tool.tool_name).toBe("synthi_app_release_seed");
    expect(report.publication.control_plane_persistence.store_kind).toBe("postgres");
  });
});
