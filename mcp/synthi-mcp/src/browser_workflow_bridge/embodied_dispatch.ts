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
  "synthi_end_teach",
  "synthi_compile_workflow",
  "synthi_run_workflow",
  "synthi_explain_failure",
  "synthi_export_skill",
  "synthi_import_skill",
  "synthi_list_skills",
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
