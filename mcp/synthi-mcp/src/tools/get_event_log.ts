import { eventLog } from "../events/index.js";
import type { EventKind } from "../events/index.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

const VALID_KINDS: readonly EventKind[] = [
  "lifecycle",
  "hmr",
  "input",
  "frame",
  "lease",
  "locator_resolution",
  "console",
  "error",
  "security",
  "source_state",
  "usage",
];

interface RawArgs {
  since_seq?: unknown;
  since_ts?: unknown;
  kind?: unknown;
  limit?: unknown;
}

export async function getEventLogTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const opts: {
    since_seq?: number;
    since_ts?: number;
    kind?: EventKind | EventKind[];
    limit?: number;
  } = {};

  if (a.since_seq !== undefined) {
    if (typeof a.since_seq !== "number" || !Number.isInteger(a.since_seq) || a.since_seq < 0) {
      return errorResponse("invalid_args", { field: "since_seq", expected: "non-negative integer" });
    }
    opts.since_seq = a.since_seq;
  }
  if (a.since_ts !== undefined) {
    if (typeof a.since_ts !== "number" || a.since_ts < 0) {
      return errorResponse("invalid_args", { field: "since_ts", expected: "non-negative number (ms)" });
    }
    opts.since_ts = a.since_ts;
  }
  if (a.kind !== undefined) {
    const list = Array.isArray(a.kind) ? a.kind : [a.kind];
    for (const k of list) {
      if (typeof k !== "string" || !VALID_KINDS.includes(k as EventKind)) {
        return errorResponse("invalid_args", { field: "kind", allowed: VALID_KINDS });
      }
    }
    opts.kind = list as EventKind[];
  }
  if (a.limit !== undefined) {
    if (typeof a.limit !== "number" || !Number.isInteger(a.limit) || a.limit < 1) {
      return errorResponse("invalid_args", { field: "limit", expected: "positive integer" });
    }
    opts.limit = a.limit;
  }

  const entries = eventLog.query(opts);
  return jsonResponse({
    ok: true,
    entries,
    last_seq: eventLog.lastSeq(),
    count: entries.length,
  });
}
