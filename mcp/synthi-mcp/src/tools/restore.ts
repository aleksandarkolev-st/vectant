/**
 * synthi_restore — replay a captured snapshot into the session.
 *
 * Phase 3 scaffold semantics: restore is best-effort observable-state replay.
 * The MCP re-emits the captured source_state event so downstream waits (e.g.
 * `wait({condition:"source_state", since_seq:...})`) see a fresh marker, and
 * can optionally drive a compile to re-render. It does NOT resurrect guest
 * heap state — that's CRIU territory and is out of scope.
 *
 * Restore modes:
 *   - default: replay source_state event only.
 *   - recompile_source:true + files+source supplied: also dispatch a compile
 *     so HMR reruns against the captured source.
 *   - include_frame:true: include the captured PNG in the response so
 *     callers can diff against the current frame.
 */

import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { snapshotStore } from "../snapshot/index.js";
import { compileTool } from "./compile.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  snapshot_id?: unknown;
  recompile_source?: unknown;
  include_frame?: unknown;
  /** Optional re-supply of the source at snapshot time. Required when
   *  recompile_source:true, because the MCP doesn't store file contents. */
  compile?: unknown;
}

export async function restoreTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.snapshot_id !== "string" || a.snapshot_id.length === 0) {
    return errorResponse("invalid_args", { field: "snapshot_id", expected: "non-empty string" });
  }
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  const record = await snapshotStore.load(a.snapshot_id);
  if (!record) {
    return errorResponse("snapshot_not_found", {
      snapshot_id: a.snapshot_id,
      required_tool_call: {
        name: "synthi_snapshot",
        suggested_args: {},
        reason: "capture a fresh snapshot before restore",
      },
    });
  }

  if (record.session_id !== attached.sessionId) {
    return errorResponse("snapshot_session_mismatch", {
      snapshot_session: record.session_id,
      current_session: attached.sessionId,
      detail: "snapshots are scoped to the session they were captured in",
    });
  }

  const replayedSourceEvent = eventLog.push({
    kind: "source_state",
    last_changed_files: record.source_state.last_changed_files,
    ...(record.source_state.content_hash
      ? { content_hash: record.source_state.content_hash }
      : {}),
    detail: {
      source: "synthi_restore",
      snapshot_id: record.snapshot_id,
      snapshot_captured_at: record.captured_at,
      replay_ts: Date.now(),
    },
  });

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[restore] replay snapshot_id=${record.snapshot_id} files=${record.source_state.last_changed_files.length}`,
    source: "mcp_internal",
  });

  const response: Record<string, unknown> = {
    ok: true,
    snapshot_id: record.snapshot_id,
    restored_at: Date.now(),
    session_id: attached.sessionId,
    replayed_event_seq: replayedSourceEvent.seq,
    source_state: record.source_state,
    wire_state_at_capture: record.wire_state,
    current_wire_state: session.getWireState(),
    recompile_applied: false,
  };

  if (a.include_frame === true && record.frame.png_base64) {
    response["frame"] = {
      png_base64: record.frame.png_base64,
      frame_seq: record.frame.frame_seq,
      ts: record.frame.ts,
      width: record.frame.width,
      height: record.frame.height,
    };
  }

  if (a.recompile_source === true) {
    if (!a.compile || typeof a.compile !== "object") {
      return errorResponse("restore_recompile_requires_source", {
        detail: "recompile_source:true needs `compile:{language,source,files?}` re-supplied",
        required_tool_call: {
          name: "synthi_restore",
          suggested_args: {
            snapshot_id: a.snapshot_id,
            recompile_source: true,
            compile: {
              language: "<lang>",
              source: "<primary source>",
              files: [{ name: "<name>", content: "<content>" }],
            },
          },
        },
      });
    }
    const compileArgs = a.compile as Record<string, unknown>;
    const compileResp = await compileTool(compileArgs);
    const compileStructured = compileResp.structuredContent ?? {};
    response["recompile_applied"] = compileResp.isError !== true;
    response["compile"] = compileStructured;
  }

  return jsonResponse(response);
}
