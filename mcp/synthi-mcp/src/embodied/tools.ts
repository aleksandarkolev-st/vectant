/**
 * Substrate-neutral MCP tool surface (plan Architecture Changes).
 *
 *   synthi_attach_substrate  - list registered substrates / attach with consent
 *   synthi_observe           - channel-aware observation
 *   synthi_begin_teach       - start recording a demonstration
 *   synthi_end_teach         - stop recording; compile the contract
 *   synthi_compile_workflow  - recompile/inspect a stored competency
 *   synthi_run_workflow      - replay under license
 *   synthi_explain_failure   - human-language failure explanation
 *
 * Handlers are thin: semantics live in the teacher facade and registry.
 * Sessions are keyed by an opaque session id handed out at attach time.
 */
import { EmbodiedTeacher } from "./teacher.js";
import type { AttachedSession, ConsentDecisionInput, TeachResult } from "./teacher.js";
import { getAdapter, listRegisteredSubstrates } from "./substrate.js";
import { authorizeRun, type CompetencyLicense, type EntrustmentLevel } from "./governance.js";
import type { EmbodiedWorkflowContract } from "./contract.js";

type Json = Record<string, unknown>;

interface CompetencyRecord {
  demonstration: TeachResult["demonstration"];
  contract: NonNullable<TeachResult["contract"]> | EmbodiedWorkflowContract;
  substrate_kind: string;
}

export interface ToolContext {
  teachers: Map<string, EmbodiedTeacher>;
  sessions: Map<string, AttachedSession>;
  competencies: Map<string, CompetencyRecord>;
  licenses: readonly CompetencyLicense[];
  now: number;
}

export function createToolContext(licenses: readonly CompetencyLicense[] = []): ToolContext {
  return { teachers: new Map(), sessions: new Map(), competencies: new Map(), licenses, now: Date.now() };
}

function requireTeacher(context: ToolContext, substrateKind: string): EmbodiedTeacher {
  const existing = context.teachers.get(substrateKind);
  if (existing) return existing;
  const teacher = new EmbodiedTeacher(getAdapter(substrateKind));
  context.teachers.set(substrateKind, teacher);
  return teacher;
}

export function handleAttachSubstrate(
  context: ToolContext,
  input: { substrate_kind?: string; consent?: ConsentDecisionInput },
): Promise<Json> | Json {
  if (!input.substrate_kind) {
    return { available_substrates: listRegisteredSubstrates() };
  }
  if (!input.consent) {
    return { error: "consent_required", human_hint: "Grant permission for what the agent may do there." };
  }
  let teacher: EmbodiedTeacher;
  try {
    teacher = requireTeacher(context, input.substrate_kind);
  } catch {
    return { error: "unknown_substrate", human_hint: "That kind of world is not connected." };
  }
  return teacher.attach(input.consent).then((session) => {
    const sessionId = `sess-${context.sessions.size + 1}-${input.substrate_kind}`;
    context.sessions.set(sessionId, session);
    return { session_id: sessionId, substrate_kind: session.substrate_kind };
  });
}

export async function handleObserve(
  context: ToolContext,
  input: { session_id: string; channels?: string[] },
): Promise<Json> {
  const session = context.sessions.get(input.session_id);
  if (!session) return { error: "unknown_session", human_hint: "Attach to a world first." };
  return { observation: await requireTeacher(context, session.substrate_kind).observe(session, input.channels) };
}

export async function handleBeginTeach(context: ToolContext, input: { session_id: string }): Promise<Json> {
  const session = context.sessions.get(input.session_id);
  if (!session) return { error: "unknown_session", human_hint: "Attach to a world first." };
  await requireTeacher(context, session.substrate_kind).beginTeach(session);
  return { status: "recording" };
}

export async function handleEndTeach(
  context: ToolContext,
  input: {
    session_id: string;
    changed_values?: unknown[];
    persistence_traces?: unknown[];
    control_diffs?: Array<{ source_id: string; changed: unknown[] }>;
    intent?: string;
  },
): Promise<Json> {
  const session = context.sessions.get(input.session_id);
  if (!session) return { error: "unknown_session", human_hint: "Attach to a world first." };
  const result = await requireTeacher(context, session.substrate_kind).endTeach(session, {
    ...(input.changed_values ? { changedValues: input.changed_values as never } : {}),
    ...(input.persistence_traces ? { persistenceTraces: input.persistence_traces as never } : {}),
    ...(input.control_diffs ? { controlDiffs: input.control_diffs as never } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
  });
  if (result.contract) {
    context.competencies.set(result.contract.contract_id, {
      demonstration: result.demonstration,
      contract: result.contract,
      substrate_kind: session.substrate_kind,
    });
  }
  return {
    steps_recorded: result.steps_recorded,
    contract_id: result.contract?.contract_id ?? null,
    problems: result.problems,
  };
}

export function handleCompileWorkflow(context: ToolContext, input: { competency_id: string }): Json {
  const record = context.competencies.get(input.competency_id);
  if (!record) return { error: "unknown_competency", human_hint: "Teach the flow first." };
  return { contract: record.contract };
}

export function handleRunWorkflow(
  context: ToolContext,
  input: {
    competency_id: string;
    session_id: string;
    mode: "same_state" | "fresh_state";
    required_level?: EntrustmentLevel;
  },
): Promise<Json> | Json {
  const record = context.competencies.get(input.competency_id);
  if (!record) return { error: "unknown_competency", human_hint: "Teach the flow first." };
  const session = context.sessions.get(input.session_id);
  if (!session) return { error: "unknown_session", human_hint: "Attach to a world first." };

  // License gate before any action.
  const decision = authorizeRun(context.licenses, {
    competency_id: input.competency_id,
    substrate_kind: session.substrate_kind,
    realm: session.handle.realm,
    required_level: input.required_level ?? "E2_supervised",
    now: context.now,
  });
  if (!decision.authorized) {
    return { ok: false, refusal_reason: decision.human_reason };
  }

  return requireTeacher(context, session.substrate_kind)
    .run(session, record.demonstration, input.mode)
    .then((outcome) => ({ ok: outcome.ok, step_results: outcome.step_results }));
}

export function handleExplainFailure(
  _context: ToolContext,
  input: { step_index: number; classifier_trunk?: string },
): Json {
  const explanation = new EmbodiedTeacher({
    substrate_kind: "_explain_only",
    adapter_version: "0",
    attach: async () => {
      throw new Error("unused");
    },
  }).explainFailure(input.step_index, input.classifier_trunk);
  return { explanation };
}
