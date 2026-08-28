/**
 * Embodied tool dispatch for the workflow bridge (plan Architecture
 * Changes: "the Observe view gains a substrate picker fed by
 * synthi_attach_substrate" - the panel reaches these tools through the
 * same bridge every other tool uses).
 *
 * A module-level ToolContext persists across calls so sessions and
 * competencies survive between bridge requests, exactly like the browser
 * broker does for its tools.
 */
import {
  createToolContext,
  handleAttachSubstrate,
  handleObserve,
  handleBeginTeach,
  handlePerformAction,
  handleEndTeach,
  handleCompileWorkflow,
  handleRunWorkflow,
  handleExplainFailure,
  handleExportSkill,
  handleImportSkill,
  handleListSkills,
  type ToolContext,
} from "../embodied/tools.js";
import { registerTerminalAdapter } from "../embodied/adapters/terminal/index.js";
import { registerRuntimeAdapter } from "../embodied/adapters/runtime/register.js";
import type { ToolResponse } from "../tools/shared.js";

let context: ToolContext | null = null;

/** Idempotent bootstrap. Re-registers built-in adapters on EVERY call so a
 *  cleared registry (tests, host restarts) is always repaired; the
 *  ToolContext itself is memoized so sessions persist across requests -
 *  teachers re-resolve their adapter lazily via getAdapter, which always
 *  sees the current registry. */
export function embodiedBridgeContext(): ToolContext {
  try {
    registerTerminalAdapter();
    registerRuntimeAdapter();
  } catch {
    // "already registered" with a DIFFERENT bundle object (another host
    // module registered its own instance): the existing registration wins.
    // getAdapter below resolves whatever is currently registered.
  }
  if (!context) {
    context = createToolContext([]);
  }
  return context;
}

export const EMBODIED_TOOL_NAMES: readonly string[] = [
  "synthi_attach_substrate",
  "synthi_observe",
  "synthi_begin_teach",
  "synthi_perform_action",
  "synthi_end_teach",
  "synthi_compile_workflow",
  "synthi_run_workflow",
  "synthi_explain_failure",
  "synthi_export_skill",
  "synthi_import_skill",
  "synthi_list_skills",
];

/**
 * MCP tool descriptors for the embodied verbs, shared by the workflow bridge
 * and the main stdio server so both surfaces advertise identical schemas.
 */
const SESSION_ID_PROP = {
  type: "string" as const,
  description: "Session id returned by synthi_attach_substrate.",
};
const COMPETENCY_ID_PROP = {
  type: "string" as const,
  description: "Competency id recorded by synthi_end_teach (or synthi_import_skill).",
};

export const EMBODIED_TOOLS = [
  {
    name: "synthi_attach_substrate",
    description:
      "Attach to a registered world (substrate) for embodied teaching. Omit substrate_kind to list available substrates; otherwise pass the consent decision granting what the agent may do there. Returns a session_id used by every other embodied verb.",
    inputSchema: {
      type: "object",
      properties: {
        substrate_kind: { type: "string", description: "Registered substrate kind, e.g. browser or terminal. Omit to list available substrates." },
        consent: { type: "object", additionalProperties: true, description: "Consent decision input for the attachment." },
      },
      required: [],
    },
  },
  {
    name: "synthi_observe",
    description:
      "Read the current observation of an attached world session through its substrate observer.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID_PROP,
        channels: { type: "array", items: { type: "string" }, description: "Optional subset of observation channels to request." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "synthi_begin_teach",
    description:
      "Start recording a demonstration on an attached session so subsequent performed actions become teach-mode steps.",
    inputSchema: {
      type: "object",
      properties: { session_id: SESSION_ID_PROP },
      required: ["session_id"],
    },
  },
  {
    name: "synthi_perform_action",
    description:
      "Perform ONE action inside a recording session — the human's hand during teach mode. The action is journaled by the recorder and executed through the substrate actor under the attach consent.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID_PROP,
        action: { type: "object", additionalProperties: true, description: "Opaque action for the target world's actor capability." },
      },
      required: ["session_id", "action"],
    },
  },
  {
    name: "synthi_end_teach",
    description:
      "Stop recording and compile the demonstration into a competency contract. Supply observed state changes when known; returns steps_recorded, a contract_id, and any problems.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID_PROP,
        changed_values: { type: "array", items: { additionalProperties: true }, description: "Values observed to change during the demonstration." },
        persistence_traces: { type: "array", items: { additionalProperties: true }, description: "Persistence evidence captured during the demonstration." },
        control_diffs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source_id: { type: "string" },
              changed: { type: "array", items: { additionalProperties: true } },
            },
            required: ["source_id", "changed"],
          },
          description: "Per-source control changes observed while teaching.",
        },
        intent: { type: "string", description: "Plain-language goal of the taught flow." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "synthi_compile_workflow",
    description: "Return the compiled cross-substrate workflow contract stored for a competency.",
    inputSchema: {
      type: "object",
      properties: { competency_id: COMPETENCY_ID_PROP },
      required: ["competency_id"],
    },
  },
  {
    name: "synthi_run_workflow",
    description:
      "Replay a taught competency on an attached session. Runs under the license gate (defaults to E2_supervised); mode same_state replays against current state, fresh_state requires a resettable realm.",
    inputSchema: {
      type: "object",
      properties: {
        competency_id: COMPETENCY_ID_PROP,
        session_id: SESSION_ID_PROP,
        mode: { type: "string", enum: ["same_state", "fresh_state"], description: "Replay mode." },
        required_level: { type: "string", description: "Minimum entrustment level to require; defaults to E2_supervised." },
      },
      required: ["competency_id", "session_id", "mode"],
    },
  },
  {
    name: "synthi_explain_failure",
    description:
      "Turn a failed step index (and optional classifier trunk) into a plain-language explanation a human can act on.",
    inputSchema: {
      type: "object",
      properties: {
        step_index: { type: "number", description: "Zero-based index of the failed step." },
        classifier_trunk: { type: "string", description: "Classifier trunk reported with the failure." },
      },
      required: ["step_index"],
    },
  },
  {
    name: "synthi_export_skill",
    description:
      "Serialize a competency into a portable synthi.skill.v1 artifact with an integrity digest so importing agents can detect tampering.",
    inputSchema: {
      type: "object",
      properties: { competency_id: COMPETENCY_ID_PROP },
      required: ["competency_id"],
    },
  },
  {
    name: "synthi_import_skill",
    description:
      "Import a skill file produced by another agent. Integrity digests are re-verified on import; mismatches refuse the import outright.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "object", additionalProperties: true, description: "The synthi.skill.v1 artifact payload." },
      },
      required: ["skill"],
    },
  },
  {
    name: "synthi_list_skills",
    description: "List every teachable competence this agent holds, for agent-to-agent skill offers.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function jsonResponse(payload: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }, null, 2) }],
    structuredContent: { ok: true, ...payload },
  };
}

export async function dispatchEmbodied(toolName: string, args: unknown): Promise<ToolResponse | null> {
  const ctx = embodiedBridgeContext();
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (toolName) {
    case "synthi_attach_substrate":
      return jsonResponse(
        await Promise.resolve(handleAttachSubstrate(ctx, input as never)),
      );
    case "synthi_observe":
      return jsonResponse(await handleObserve(ctx, input as never));
    case "synthi_begin_teach":
      return jsonResponse(await handleBeginTeach(ctx, input as never));
    case "synthi_perform_action":
      return jsonResponse(await handlePerformAction(ctx, input as never));
    case "synthi_end_teach":
      return jsonResponse(await handleEndTeach(ctx, input as never));
    case "synthi_compile_workflow":
      return jsonResponse(handleCompileWorkflow(ctx, input as never));
    case "synthi_run_workflow":
      return jsonResponse(await Promise.resolve(handleRunWorkflow(ctx, input as never)));
    case "synthi_explain_failure":
      return jsonResponse(handleExplainFailure(ctx, input as never));
    case "synthi_export_skill":
      return jsonResponse(handleExportSkill(ctx, input as never));
    case "synthi_import_skill":
      return jsonResponse(handleImportSkill(ctx, input as never));
    case "synthi_list_skills":
      return jsonResponse(handleListSkills(ctx));
    default:
      return null;
  }
}
