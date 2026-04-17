import { createHash } from "node:crypto";
import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Agent-side producer for source-state. The agent calls this after editing
 * files so `synthi_get_source_state` and `wait({condition:"source_state"})`
 * reflect recent changes, without requiring the compile pipeline to have
 * run (useful for "edit → wait for human review" flows where the agent
 * doesn't also drive the compile, or for tests that want to mark a
 * checkpoint before dispatching).
 *
 * Shape:
 *   files        — list of edited file paths (repo-relative strings).
 *   content_hash — caller-computed hash. Optional; server falls back to
 *                  hashing the concatenated file names if not provided.
 *   detail       — free-form context the agent wants carried in the event.
 */

interface RawArgs {
  files?: unknown;
  content_hash?: unknown;
  detail?: unknown;
}

export async function reportSourceStateTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (!Array.isArray(a.files) || a.files.length === 0) {
    return errorResponse("invalid_args", {
      field: "files",
      expected: "non-empty string array",
    });
  }
  const files = a.files as unknown[];
  for (let i = 0; i < files.length; i++) {
    if (typeof files[i] !== "string" || (files[i] as string).length === 0) {
      return errorResponse("invalid_args", {
        field: `files[${i}]`,
        expected: "non-empty string",
      });
    }
  }
  const cleanFiles = files as string[];

  let contentHash: string;
  if (typeof a.content_hash === "string" && a.content_hash.length > 0) {
    contentHash = a.content_hash;
  } else {
    contentHash = createHash("sha256").update(cleanFiles.join("\n")).digest("hex").slice(0, 16);
  }

  const detail: Record<string, unknown> = { source: "synthi_report_source_state" };
  if (a.detail && typeof a.detail === "object") {
    Object.assign(detail, a.detail as Record<string, unknown>);
  }

  const entry = eventLog.push({
    kind: "source_state",
    last_changed_files: cleanFiles,
    content_hash: contentHash,
    detail,
  });
  session.touch();

  return jsonResponse({
    ok: true,
    seq: entry.seq,
    ts: entry.ts,
    last_changed_files: cleanFiles,
    content_hash: contentHash,
  });
}
