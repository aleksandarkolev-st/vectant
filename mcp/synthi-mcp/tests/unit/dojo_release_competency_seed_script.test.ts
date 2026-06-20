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
    expect(config.workflow.stable_entity_label).toBe("Open release details");
    expect(config.workflow.source_file_path).toBe("dojo/release-seed.tsx");
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
    const ledgerEvents: string[] = [];
    const recordedActions: unknown[] = [];
    const sourceRegistrations: unknown[] = [];
    const publishedSkillIds = new Set<string>();
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
        recordHumanAction: (action) => {
          recordedActions.push(action);
        },
        workflowArtifact: () => ({ ok: true, artifact }),
      },
      sourceIdentityRegistry: {
        register: (input) => {
          sourceRegistrations.push(input);
          return {
            workspace_id: input.workspaceId,
            token_count: input.tokens.length,
          };
        },
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
        permission_license: {
          proof_requirements: {
            required_evidence_claims: ["checkride_passed", "guardrails_active"],
            required_context_claims: ["workspace_verified"],
          },
        },
      }),
      PostgresDojoSkillStore: class FakePostgresDojoSkillStore {
        async getSkillRecord(skillId) {
          return publishedSkillIds.has(skillId) ? { skill_id: skillId, status: "published" } : null;
        }

        async saveSkill(skill, options) {
          ledgerEvents.push(`save:${skill.skill_id}:${options.status}`);
          return { skill_id: skill.skill_id };
        }
      },
      resolveDojoEvidenceLedgerAppendStore: async () => ({
        ok: true,
        queryable: {},
        evidence_ledger: {
          append: async (input) => {
            ledgerEvents.push(`append:${input.skill_id}`);
            return {
              record_id: input.record_id,
            };
          },
        },
        close: async () => undefined,
      }),
      dispatchDojoTool: async (tool, args) => {
        if (tool === "synthi_dojo_list_competencies") {
          return {
            structuredContent: {
              ok: true,
              competencies: [],
            },
          };
        }
        if (tool === "synthi_dojo_get_skill") {
          return {
            isError: true,
            structuredContent: {
              ok: false,
              error: "dojo_skill_not_found",
            },
          };
        }
        ledgerEvents.push(`publish:${args.workflow_id}`);
        calls.push({ tool, args });
        publishedSkillIds.add("skill-release-seed");
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
              executable_checkride: {
                evidence_refs: [
                  "ledger:dojo_checkride_record_a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  "evidence:dojo_inline_record_b",
                ],
                ledger_checkpoint_hashes: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
                results: [
                  {
                    ledger_record: {
                      record_id: "dojo_checkride_record_c",
                    },
                  },
                ],
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

    expect(sourceRegistrations).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-a",
        filePath: "dojo/release-seed.tsx",
        tokens: [
          expect.objectContaining({
            token: "dojo.release.seed.action",
            file: "dojo/release-seed.tsx",
            line: 1,
            column: 1,
            tag: "button",
          }),
        ],
      }),
    ]);
    expect(recordedActions).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({
          label: "Open release details",
          source_id: "dojo.release.seed.action",
        }),
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(ledgerEvents).toEqual([
      "save:skill-release-seed:draft",
      "append:skill-release-seed",
      "publish:workflow-release-seed",
      "append:skill-release-seed",
    ]);
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
    expect(report.proof.aggregate_evidence_record_ids).toEqual([
      expect.stringMatching(/^dojo_release_proof_[a-f0-9]{24}$/),
    ]);
    expect(report.proof.evidence_record_ids).toEqual([
      report.proof.aggregate_evidence_record_ids[0],
      "dojo_checkride_record_c",
      "dojo_checkride_record_a",
      "dojo_inline_record_b",
    ]);
    expect(report.proof.required_evidence_claims).toEqual(["checkride_passed", "guardrails_active"]);
    expect(report.proof.required_context_claims).toEqual(["workspace_verified"]);
  });

  it("reuses an existing published release competency instead of republishing", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "dojo-release-seed-"));
    tmpDirs.push(outDir);
    const calls: string[] = [];
    const ledgerEvents: string[] = [];
    const privateToolRegistry = new Map<string, unknown>();
    const artifact = {
      workflow_id: "workflow-release-seed",
      workflow: {
        contract: { workflowId: "workflow-release-seed" },
        card: { stepCount: 1 },
      },
      events: [{ event_id: "event-a" }],
    };
    const existingSkill = {
      skill_id: "skill-release-seed",
      workflow_id: "workflow-release-seed",
      workspace_id: "workspace-a",
      published_tool_name: "synthi_app_release_seed",
      private_tool_manifest: {
        status: "available",
        tool_name: "synthi_app_release_seed",
        workflow_id: "workflow-release-seed",
      },
      entrustment_level: "E3",
      skill_readiness_level: "SRL3",
      permission_license: {
        license_id: "license-release-seed",
        license_version: "1.0.0",
        autonomy_level: "supervised",
        proof_requirements: {
          required_evidence_claims: ["checkride_passed"],
          required_context_claims: ["workspace_verified"],
          required_guardrails: [],
        },
      },
      executable_entrustment: {
        checkride_id: "checkride-release-seed",
        scenario_count: 2,
        passed_scenarios: 2,
        failed_scenarios: 0,
        blocked_scenarios: 0,
        production_recommendation: "constrained",
        evidence_refs: ["ledger:existing_evidence:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      },
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
      sourceIdentityRegistry: {
        register: (input) => ({
          workspace_id: input.workspaceId,
          token_count: input.tokens.length,
        }),
      },
      generatePrivateWorkflowToolManifest: () => ({
        status: "available",
        tool_name: "synthi_app_release_seed",
        workflow_id: "workflow-release-seed",
      }),
      buildDojoSkill: (_contract, options) => ({
        ...existingSkill,
        workspace_id: options.workspace_id,
      }),
      PostgresDojoSkillStore: class FakePostgresDojoSkillStore {
        async getSkillRecord(skillId) {
          return { skill_id: skillId, status: "published" };
        }

        async saveSkill(skill, options) {
          ledgerEvents.push(`save:${skill.skill_id}:${options.status}`);
          return { skill_id: skill.skill_id };
        }
      },
      resolveDojoEvidenceLedgerAppendStore: async () => ({
        ok: true,
        queryable: {},
        evidence_ledger: {
          append: async (input) => {
            ledgerEvents.push(`append:${input.skill_id}`);
            return {
              record_id: input.record_id,
            };
          },
        },
        close: async () => undefined,
      }),
      privateWorkflowToolRegistry: {
        get: (toolName) => privateToolRegistry.get(toolName) ?? null,
        publish: (manifest, options) => {
          const registration = {
            tool_name: manifest.tool_name,
            workflow_id: manifest.workflow_id,
            manifest,
            workflow_artifact: options.workflowArtifact,
            registered_at: Date.parse("2026-06-20T00:00:00.000Z"),
          };
          privateToolRegistry.set(manifest.tool_name, registration);
          return { ok: true, registration };
        },
      },
      dispatchDojoTool: async (tool) => {
        calls.push(tool);
        if (tool === "synthi_dojo_list_competencies") {
          return {
            structuredContent: {
              ok: true,
              competencies: [{
                skill_id: "skill-release-seed",
                published_tool_name: "synthi_app_release_seed",
              }],
            },
          };
        }
        if (tool === "synthi_dojo_get_skill") {
          return {
            structuredContent: {
              ok: true,
              skill: existingSkill,
            },
          };
        }
        throw new Error(`unexpected tool call:${tool}`);
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

    expect(calls).toEqual(["synthi_dojo_list_competencies", "synthi_dojo_get_skill"]);
    expect(ledgerEvents).toEqual(["append:skill-release-seed"]);
    expect(privateToolRegistry.get("synthi_app_release_seed")).toEqual(expect.objectContaining({
      workflow_id: "workflow-release-seed",
      workflow_artifact: artifact,
    }));
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    expect(report.skill.skill_id).toBe("skill-release-seed");
    expect(report.private_tool.tool_name).toBe("synthi_app_release_seed");
    expect(report.private_tool.registry_status).toBe("repaired");
    expect(report.publication.evidence_ref_count).toBe(0);
    expect(report.proof.aggregate_evidence_record_ids).toEqual([
      expect.stringMatching(/^dojo_release_proof_[a-f0-9]{24}$/),
    ]);
  });

  it("does not reuse an existing release competency for a different workflow", async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), "dojo-release-seed-"));
    tmpDirs.push(outDir);
    const calls: string[] = [];
    const artifact = {
      workflow_id: "workflow-new",
      workflow: {
        contract: { workflowId: "workflow-new" },
        card: { stepCount: 1 },
      },
      events: [{ event_id: "event-a" }],
    };
    const staleSkill = {
      skill_id: "skill-release-seed",
      workflow_id: "workflow-old",
      workspace_id: "workspace-a",
      published_tool_name: "synthi_app_release_seed",
      private_tool_manifest: {
        status: "available",
        tool_name: "synthi_app_release_seed",
      },
      entrustment_level: "E3",
      permission_license: {
        license_id: "license-release-seed",
        license_version: "1.0.0",
        autonomy_level: "submit_limited",
        proof_requirements: {
          required_evidence_claims: [],
          required_context_claims: [],
          required_guardrails: [],
        },
      },
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
      sourceIdentityRegistry: {
        register: (input) => ({
          workspace_id: input.workspaceId,
          token_count: input.tokens.length,
        }),
      },
      generatePrivateWorkflowToolManifest: () => ({
        status: "available",
        tool_name: "synthi_app_release_seed",
        workflow_id: "workflow-new",
      }),
      buildDojoSkill: (_contract, options) => ({
        skill_id: "skill-release-seed",
        workflow_id: "workflow-new",
        workspace_id: options.workspace_id,
        permission_license: {
          proof_requirements: {
            required_evidence_claims: [],
            required_context_claims: [],
          },
        },
      }),
      PostgresDojoSkillStore: class FakePostgresDojoSkillStore {
        async getSkillRecord() {
          return null;
        }

        async saveSkill() {
          return {};
        }
      },
      resolveDojoEvidenceLedgerAppendStore: async () => ({
        ok: true,
        queryable: {},
        evidence_ledger: {
          append: async (input) => ({
            record_id: input.record_id,
          }),
        },
        close: async () => undefined,
      }),
      dispatchDojoTool: async (tool, args) => {
        calls.push(`${tool}:${args?.workflow_id ?? ""}`);
        if (tool === "synthi_dojo_list_competencies") {
          return {
            structuredContent: {
              ok: true,
              competencies: [{
                skill_id: "skill-release-seed",
                published_tool_name: "synthi_app_release_seed",
              }],
            },
          };
        }
        if (tool === "synthi_dojo_get_skill") {
          return {
            structuredContent: {
              ok: true,
              skill: staleSkill,
            },
          };
        }
        if (tool === "synthi_dojo_publish_skill") {
          return {
            structuredContent: {
              ok: true,
              skill: {
                skill_id: "skill-release-seed",
                workflow_id: "workflow-new",
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
                  workflow_id: "workflow-new",
                  status: "published",
                },
              },
            },
          };
        }
        throw new Error(`unexpected tool call:${tool}`);
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

    expect(calls).toEqual([
      "synthi_dojo_list_competencies:",
      "synthi_dojo_get_skill:",
      "synthi_dojo_publish_skill:workflow-new",
    ]);
    const report = JSON.parse(await readFile(result.report_path, "utf8"));
    expect(report.publication.control_plane_persistence.workflow_id).toBe("workflow-new");
  });
});
