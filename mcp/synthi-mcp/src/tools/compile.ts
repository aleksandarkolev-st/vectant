import { createHash } from "node:crypto";
import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { checkInputGate } from "../correctness/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

function computeContentHash(source: string, files: Array<{ name: string; content: string }>): string {
  const hasher = createHash("sha256");
  hasher.update("primary:");
  hasher.update(source);
  for (const f of files) {
    hasher.update("\n::file::");
    hasher.update(f.name);
    hasher.update("::");
    hasher.update(f.content);
  }
  return hasher.digest("hex").slice(0, 16);
}

/**
 * MCP-driven compile trigger. Sends a CompileRequest on the `compile` DC
 * so agents can close the edit → HMR → screenshot loop without a frontend
 * open in a browser. The worker's handler is `main.rs:1336` (matches the
 * `CompileRequest` struct in `infra/messages.rs`).
 *
 * This tool is fire-and-forget — it returns as soon as the payload lands
 * on the wire. The caller is expected to follow up with
 * `synthi_wait({condition:"hmr"})` to block on a terminal HMR status.
 */

interface RawArgs {
  language?: unknown;
  filename?: unknown;
  source?: unknown;
  files?: unknown;
  is_gui?: unknown;
  width?: unknown;
  height?: unknown;
  use_ai_split?: unknown;
  user_requested_ai?: unknown;
  user_requested_deterministic?: unknown;
  target?: unknown;
  project_root?: unknown;
  slug?: unknown;
}

export async function compileTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;

  if (typeof a.language !== "string" || a.language.length === 0) {
    return errorResponse("invalid_args", { field: "language", expected: "non-empty string" });
  }
  if (typeof a.source !== "string") {
    return errorResponse("invalid_args", { field: "source", expected: "string" });
  }
  if (a.filename !== undefined && typeof a.filename !== "string") {
    return errorResponse("invalid_args", { field: "filename", expected: "string" });
  }

  // Validate optional `files` shape: [{name, content}]. An invalid shape
  // would be silently accepted by the worker's serde until it tried to
  // parse, so we fail fast here.
  if (a.files !== undefined) {
    if (!Array.isArray(a.files)) {
      return errorResponse("invalid_args", { field: "files", expected: "array" });
    }
    for (let i = 0; i < a.files.length; i++) {
      const f = a.files[i] as { name?: unknown; content?: unknown };
      if (!f || typeof f !== "object" || typeof f.name !== "string" || typeof f.content !== "string") {
        return errorResponse("invalid_args", {
          field: `files[${i}]`,
          expected: "{name:string, content:string}",
        });
      }
    }
  }

  const gate = checkInputGate();
  if (gate) return errorResponse(gate.error, gate);

  const attached = session.require();
  const language = a.language;
  const filename = typeof a.filename === "string" ? a.filename : `main.${language}`;
  const isGui = typeof a.is_gui === "boolean" ? a.is_gui : true;
  const files = Array.isArray(a.files)
    ? (a.files as Array<{ name: string; content: string }>)
    : [];
  const payload: Record<string, unknown> = {
    language,
    filename,
    source: a.source,
    files,
    session_id: attached.sessionId,
    is_gui: isGui,
    supports_h265: false,
  };
  if (typeof a.width === "number") payload["width"] = a.width;
  if (typeof a.height === "number") payload["height"] = a.height;
  if (typeof a.use_ai_split === "boolean") payload["use_ai_split"] = a.use_ai_split;
  if (typeof a.user_requested_ai === "boolean") payload["user_requested_ai"] = a.user_requested_ai;
  if (typeof a.user_requested_deterministic === "boolean") {
    payload["user_requested_deterministic"] = a.user_requested_deterministic;
  }
  if (typeof a.target === "string") payload["target"] = a.target;
  if (typeof a.project_root === "string") payload["project_root"] = a.project_root;
  if (typeof a.slug === "string") payload["slug"] = a.slug;

  try {
    await attached.channels.sendCompileRequest(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("compile_channel_not_open")) {
      return errorResponse("compile_channel_not_open", {
        ready_state: msg.split(":")[1] ?? "unknown",
      });
    }
    return errorFromException("compile_send_failed", err);
  }

  const dispatchedAt = Date.now();
  eventLog.push({
    kind: "input",
    action: "compile:start",
    payload: {
      language,
      filename,
      is_gui: isGui,
      use_ai_split: Boolean(payload["use_ai_split"]),
      file_count: files.length,
      source_chars: (a.source as string).length,
      ...(typeof a.target === "string" ? { target: a.target } : {}),
    },
  });

  // Source-state producer: every MCP-driven compile declares which files
  // made up the compile input, so `synthi_get_source_state` and
  // `wait({condition:"source_state"})` see real data instead of a
  // "producer not wired" placeholder.
  const lastChangedFiles = [filename, ...files.map((f) => f.name)];
  const contentHash = computeContentHash(a.source as string, files);
  eventLog.push({
    kind: "source_state",
    last_changed_files: lastChangedFiles,
    content_hash: contentHash,
    detail: { source: "synthi_compile", dispatched_at: dispatchedAt },
  });

  session.touch();

  return jsonResponse({
    ok: true,
    session_id: attached.sessionId,
    language,
    filename,
    dispatched_at: dispatchedAt,
    note:
      "Compile dispatched. Await terminal HMR status via synthi_wait({condition:\"hmr\"}). Responses stream on build-log.",
  });
}
