import { session } from "../session.js";
import {
  errorFromException,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface WaitHmrArgs {
  timeoutMs?: unknown;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function waitHmrTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as WaitHmrArgs;
  const timeoutMs =
    typeof a.timeoutMs === "number" && a.timeoutMs > 0
      ? a.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  try {
    const start = Date.now();
    const attached = session.require();
    const result = await attached.channels.hmr.waitForTerminal({ timeoutMs });
    let frameGate: Record<string, unknown> | undefined;

    if (result.status === "applied") {
      const tHmr = Date.now();
      const budget = session.pipelineBudgetMs();
      if (session.frameSeqGateEnabled()) {
        const remaining = Math.max(0, timeoutMs - (Date.now() - start));
        const satisfiedBy = await session.awaitFrameAdvanceAtOrAfter(
          tHmr + budget,
          remaining
        );
        frameGate = satisfiedBy
          ? {
              status: "satisfied",
              frame_seq: satisfiedBy.frame_seq,
              ts_ms: satisfiedBy.ts_ms,
              pipeline_budget_ms: budget,
            }
          : {
              status: "timeout",
              pipeline_budget_ms: budget,
              note: "no post-budget frame_advance observed; screenshot may reflect pre-reload frame",
            };
      } else {
        frameGate = {
          status: "disabled",
          reason: "no_frame_advance_observed",
          pipeline_budget_ms: budget,
        };
      }
    }

    return jsonResponse({
      status: result.status,
      elapsedMs: Date.now() - start,
      hmrElapsedMs: result.elapsedMs,
      source: result.source,
      detail: result.detail ?? null,
      ...(frameGate !== undefined ? { frame_gate: frameGate } : {}),
    });
  } catch (err) {
    return errorFromException("wait_hmr_failed", err);
  }
}
