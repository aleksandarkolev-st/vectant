import type {
  BranchFossil,
  BranchTrace,
  ChoiceScene,
  CounterfactualRun,
  PolicyDelta,
  RegretPlanningHint,
} from "./types.js";

export interface RegretMemoryStore {
  putCounterfactualRun(run: CounterfactualRun): Promise<CounterfactualRun> | CounterfactualRun;
  getCounterfactualRun(counterfactualRunId: string): Promise<CounterfactualRun | null> | CounterfactualRun | null;
  putBranchTrace(trace: BranchTrace): Promise<BranchTrace> | BranchTrace;
  listBranchTraces(counterfactualRunId: string): Promise<BranchTrace[]> | BranchTrace[];
  putChoiceScene(scene: ChoiceScene): Promise<ChoiceScene> | ChoiceScene;
  getChoiceScene(choiceSceneId: string): Promise<ChoiceScene | null> | ChoiceScene | null;
  putBranchFossil(fossil: BranchFossil): Promise<BranchFossil> | BranchFossil;
  listBranchFossils(input: {
    workspace_id: string;
    skill_id?: string;
    task_class?: string;
  }): Promise<BranchFossil[]> | BranchFossil[];
  putPolicyDelta(delta: PolicyDelta): Promise<PolicyDelta> | PolicyDelta;
  listPolicyDeltas(input: {
    workspace_id: string;
    skill_id?: string;
    task_class?: string;
    status?: PolicyDelta["status"];
  }): Promise<PolicyDelta[]> | PolicyDelta[];
  listPlanningHints(input: {
    workspace_id: string;
    skill_id?: string;
    task_class?: string;
    now?: string;
  }): Promise<RegretPlanningHint[]> | RegretPlanningHint[];
  disablePolicyDelta(policyDeltaId: string, input: {
    disabled_at: string;
    disabled_by: string;
  }): Promise<PolicyDelta> | PolicyDelta;
  deleteWorkspaceMemory(input: {
    workspace_id: string;
    deleted_at: string;
    deleted_by: string;
  }): Promise<{ deleted_count: number }> | { deleted_count: number };
}

export class InMemoryRegretMemoryStore implements RegretMemoryStore {
  private readonly runs = new Map<string, CounterfactualRun>();
  private readonly branches = new Map<string, BranchTrace>();
  private readonly scenes = new Map<string, ChoiceScene>();
  private readonly fossils = new Map<string, BranchFossil>();
  private readonly deltas = new Map<string, PolicyDelta>();

  putCounterfactualRun(run: CounterfactualRun): CounterfactualRun {
    const clone = cloneJson(run);
    this.runs.set(clone.counterfactual_run_id, clone);
    return cloneJson(clone);
  }

  getCounterfactualRun(counterfactualRunId: string): CounterfactualRun | null {
    const run = this.runs.get(counterfactualRunId);
    return run ? cloneJson(run) : null;
  }

  putBranchTrace(trace: BranchTrace): BranchTrace {
    const clone = cloneJson(trace);
    this.branches.set(clone.branch_id, clone);
    return cloneJson(clone);
  }

  listBranchTraces(counterfactualRunId: string): BranchTrace[] {
    return [...this.branches.values()]
      .filter((trace) => trace.counterfactual_run_id === counterfactualRunId)
      .map(cloneJson)
      .sort((left, right) => left.branch_id.localeCompare(right.branch_id));
  }

  putChoiceScene(scene: ChoiceScene): ChoiceScene {
    const clone = cloneJson(scene);
    this.scenes.set(clone.choice_scene_id, clone);
    return cloneJson(clone);
  }

  getChoiceScene(choiceSceneId: string): ChoiceScene | null {
    const scene = this.scenes.get(choiceSceneId);
    return scene ? cloneJson(scene) : null;
  }

  putBranchFossil(fossil: BranchFossil): BranchFossil {
    const clone = cloneJson(fossil);
    this.fossils.set(clone.fossil_id, clone);
    return cloneJson(clone);
  }

  listBranchFossils(input: { workspace_id: string; skill_id?: string; task_class?: string }): BranchFossil[] {
    return [...this.fossils.values()]
      .filter((fossil) => fossil.workspace_id === input.workspace_id)
      .filter((fossil) => input.skill_id === undefined || fossil.skill_id === input.skill_id)
      .filter((fossil) => input.task_class === undefined || fossil.task_class === input.task_class)
      .map(cloneJson)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.fossil_id.localeCompare(right.fossil_id));
  }

  putPolicyDelta(delta: PolicyDelta): PolicyDelta {
    const clone = cloneJson(delta);
    this.deltas.set(clone.policy_delta_id, clone);
    return cloneJson(clone);
  }

  listPolicyDeltas(input: {
    workspace_id: string;
    skill_id?: string;
    task_class?: string;
    status?: PolicyDelta["status"];
  }): PolicyDelta[] {
    return [...this.deltas.values()]
      .filter((delta) => delta.workspace_id === input.workspace_id)
      .filter((delta) => input.skill_id === undefined || delta.skill_id === input.skill_id)
      .filter((delta) => input.task_class === undefined || delta.task_class === input.task_class)
      .filter((delta) => input.status === undefined || delta.status === input.status)
      .map(cloneJson)
      .sort((left, right) => left.policy_delta_id.localeCompare(right.policy_delta_id));
  }

  listPlanningHints(input: {
    workspace_id: string;
    skill_id?: string;
    task_class?: string;
    now?: string;
  }): RegretPlanningHint[] {
    const nowMs = input.now ? Date.parse(input.now) : Date.now();
    return this.listPolicyDeltas({
      workspace_id: input.workspace_id,
      skill_id: input.skill_id,
      task_class: input.task_class,
      status: "promoted",
    })
      .filter((delta) => !delta.expires_at || !Number.isFinite(nowMs) || Date.parse(delta.expires_at) > nowMs)
      .map((delta) => ({
        skillId: delta.skill_id ?? "",
        taskClass: delta.task_class,
        hintKind: delta.delta_kind,
        confidence: delta.confidence,
        evidenceIds: [...delta.evidence_ids],
        ...(delta.expires_at ? { expiresAt: delta.expires_at } : {}),
      }));
  }

  disablePolicyDelta(policyDeltaId: string, input: { disabled_at: string; disabled_by: string }): PolicyDelta {
    const delta = this.deltas.get(policyDeltaId);
    if (!delta) throw new Error("regret_policy_delta_not_found");
    const disabled: PolicyDelta = {
      ...delta,
      status: "disabled",
      disabled_at: input.disabled_at,
      disabled_by: input.disabled_by,
    };
    this.deltas.set(policyDeltaId, disabled);
    return cloneJson(disabled);
  }

  deleteWorkspaceMemory(input: { workspace_id: string }): { deleted_count: number } {
    let deletedCount = 0;
    for (const collection of [this.runs, this.branches, this.scenes, this.fossils, this.deltas]) {
      for (const [key, value] of collection.entries()) {
        if (value.workspace_id === input.workspace_id) {
          collection.delete(key);
          deletedCount += 1;
        }
      }
    }
    return { deleted_count: deletedCount };
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
