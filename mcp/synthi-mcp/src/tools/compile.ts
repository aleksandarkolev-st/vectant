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

interface FileRef {
  name: string;
  sha256?: string;
  bytes?: number;
}

const SOURCE_FIRST_REQUEST_INTENT_MAX_BYTES = 64 * 1024;
const SOURCE_FIRST_REQUEST_INTENT_MAX_DEPTH = 32;
const SOURCE_FIRST_AUTHORITY_CLAIM_KEYS = new Set([
  "acceptedforgpuhmr",
  "gpuhmrsuccess",
  "cansatisfyruntimeproof",
  "cansatisfydispatchproof",
  "runtimeauthority",
  "dispatchauthority",
  "fullruntimeproven",
  "dispatchproven",
]);

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedIntentKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function validateJsonIntentValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): string | undefined {
  if (depth > SOURCE_FIRST_REQUEST_INTENT_MAX_DEPTH) return "maximum nesting depth exceeded";
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : "non-finite number";
  }
  if (typeof value !== "object") return `non-JSON ${typeof value} value`;
  if (ancestors.has(value)) return "cyclic object graph";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        const reason = validateJsonIntentValue(item, ancestors, depth + 1);
        if (reason) return reason;
      }
      return undefined;
    }
    if (!isPlainJsonObject(value)) return "non-plain object";
    if (Object.getOwnPropertySymbols(value).length > 0) return "symbol-keyed property";

    for (const [key, child] of Object.entries(value)) {
      if (SOURCE_FIRST_AUTHORITY_CLAIM_KEYS.has(normalizedIntentKey(key)) && child !== false) {
        return `authority claim at ${key}`;
      }
      const reason = validateJsonIntentValue(child, ancestors, depth + 1);
      if (reason) return reason;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function validateSourceFirstRequestIntent(
  value: unknown,
): { accepted: true; value: Record<string, unknown> } | { accepted: false; reason: string } {
  if (!isPlainJsonObject(value)) {
    return { accepted: false, reason: "expected a plain JSON object" };
  }
  const invalidReason = validateJsonIntentValue(value, new Set(), 0);
  if (invalidReason) return { accepted: false, reason: invalidReason };

  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { accepted: false, reason: "object is not JSON serializable" };
  }
  if (typeof encoded !== "string") {
    return { accepted: false, reason: "object is not JSON serializable" };
  }
  if (Buffer.byteLength(encoded, "utf8") > SOURCE_FIRST_REQUEST_INTENT_MAX_BYTES) {
    return {
      accepted: false,
      reason: `encoded object exceeds ${SOURCE_FIRST_REQUEST_INTENT_MAX_BYTES} bytes`,
    };
  }
  return { accepted: true, value };
}

function computeContentHash(
  source: string,
  files: Array<{ name: string; content: string }>,
  fileRefs: FileRef[] = [],
): string {
  const hasher = createHash("sha256");
  hasher.update("primary:");
  hasher.update(source);
  for (const f of files) {
    hasher.update("\n::file::");
    hasher.update(f.name);
    hasher.update("::");
    hasher.update(f.content);
  }
  for (const ref of fileRefs) {
    hasher.update("\n::file-ref::");
    hasher.update(ref.name);
    hasher.update("::sha256=");
    hasher.update(ref.sha256 ?? "");
    hasher.update("::bytes=");
    hasher.update(ref.bytes === undefined ? "" : String(ref.bytes));
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
  file_refs?: unknown;
  is_gui?: unknown;
  width?: unknown;
  height?: unknown;
  use_ai_split?: unknown;
  bypass_ai_split_cache?: unknown;
  bypass_device_compile_cache?: unknown;
  force_ai_split?: unknown;
  force_fresh_ai_split?: unknown;
  require_fresh_ai_split?: unknown;
  require_ai_provider_call?: unknown;
  require_provider_call?: unknown;
  force_ai_provider_call?: unknown;
  ai_provider_call_nonce?: unknown;
  provider_call_nonce?: unknown;
  aiProviderCallNonce?: unknown;
  ai_provider?: unknown;
  provider?: unknown;
  provider_name?: unknown;
  aiProvider?: unknown;
  ai_model?: unknown;
  model?: unknown;
  model_name?: unknown;
  aiModel?: unknown;
  user_requested_ai?: unknown;
  user_requested_deterministic?: unknown;
  force_gpu_ai_delta?: unknown;
  use_gpu_ai_delta?: unknown;
  force_ai_delta?: unknown;
  prefer_gpu_pipeline?: unknown;
  gpu_mode?: unknown;
  gpu_arch?: unknown;
  compile_manifest?: unknown;
  manifest?: unknown;
  source_first_request_intent?: unknown;
  compute_expected_output_contract_hash?: unknown;
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
  const computeExpectedOutputContractHash =
    a.compute_expected_output_contract_hash;
  if (
    computeExpectedOutputContractHash !== undefined
    && (
      typeof computeExpectedOutputContractHash !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(computeExpectedOutputContractHash)
    )
  ) {
    return errorResponse("invalid_args", {
      field: "compute_expected_output_contract_hash",
      expected: "sha256: followed by exactly 64 lowercase hexadecimal characters",
    });
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
  let fileRefs: FileRef[] = [];
  if (a.file_refs !== undefined) {
    if (!Array.isArray(a.file_refs)) {
      return errorResponse("invalid_args", { field: "file_refs", expected: "array" });
    }
    fileRefs = [];
    for (let i = 0; i < a.file_refs.length; i++) {
      const ref = a.file_refs[i] as { name?: unknown; sha256?: unknown; bytes?: unknown };
      if (!ref || typeof ref !== "object" || typeof ref.name !== "string") {
        return errorResponse("invalid_args", {
          field: `file_refs[${i}]`,
          expected: "{name:string, sha256?:string, bytes?:number}",
        });
      }
      if (ref.sha256 !== undefined && typeof ref.sha256 !== "string") {
        return errorResponse("invalid_args", {
          field: `file_refs[${i}].sha256`,
          expected: "string",
        });
      }
      if (Object.prototype.hasOwnProperty.call(ref, "bytes")) {
        if (typeof ref.bytes !== "number" || !Number.isFinite(ref.bytes) || ref.bytes < 0) {
          return errorResponse("invalid_args", {
            field: `file_refs[${i}].bytes`,
            expected: "non-negative number",
          });
        }
      }
      fileRefs.push({
        name: ref.name,
        ...(typeof ref.sha256 === "string" ? { sha256: ref.sha256 } : {}),
        ...(typeof ref.bytes === "number" ? { bytes: ref.bytes } : {}),
      });
    }
  }
  if (
    a.bypass_device_compile_cache !== undefined
    && typeof a.bypass_device_compile_cache !== "boolean"
  ) {
    return errorResponse("invalid_args", {
      field: "bypass_device_compile_cache",
      expected: "boolean",
    });
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
    ...(fileRefs.length > 0 ? { file_refs: fileRefs } : {}),
    session_id: attached.sessionId,
    is_gui: isGui,
    supports_h265: false,
  };
  if (typeof a.width === "number") payload["width"] = a.width;
  if (typeof a.height === "number") payload["height"] = a.height;
  if (typeof a.use_ai_split === "boolean") payload["use_ai_split"] = a.use_ai_split;
  const bypassAiSplitCache =
    a.bypass_ai_split_cache ?? a.force_ai_split ?? a.force_fresh_ai_split ?? a.require_fresh_ai_split;
  if (typeof bypassAiSplitCache === "boolean") {
    payload["bypass_ai_split_cache"] = bypassAiSplitCache;
  }
  if (typeof a.bypass_device_compile_cache === "boolean") {
    payload["bypass_device_compile_cache"] = a.bypass_device_compile_cache;
  }
  const requireAiProviderCall =
    a.require_ai_provider_call ?? a.require_provider_call ?? a.force_ai_provider_call;
  if (requireAiProviderCall !== undefined && typeof requireAiProviderCall !== "boolean") {
    return errorResponse("invalid_args", {
      field: "require_ai_provider_call",
      expected: "boolean",
    });
  }
  const aiProviderCallNonce =
    a.ai_provider_call_nonce ?? a.provider_call_nonce ?? a.aiProviderCallNonce;
  if (aiProviderCallNonce !== undefined && typeof aiProviderCallNonce !== "string") {
    return errorResponse("invalid_args", {
      field: "ai_provider_call_nonce",
      expected: "string",
    });
  }
  if (
    requireAiProviderCall === true
    && (
      typeof aiProviderCallNonce !== "string"
      || !/^provider-call:[a-f0-9]{32}$/.test(aiProviderCallNonce)
    )
  ) {
    return errorResponse("invalid_args", {
      field: "ai_provider_call_nonce",
      expected: "provider-call followed by 32 lowercase hexadecimal characters",
    });
  }
  if (typeof requireAiProviderCall === "boolean") {
    payload["require_ai_provider_call"] = requireAiProviderCall;
  }
  if (typeof aiProviderCallNonce === "string") {
    payload["ai_provider_call_nonce"] = aiProviderCallNonce;
  }
  const aiProvider = a.ai_provider ?? a.provider ?? a.provider_name ?? a.aiProvider;
  if (aiProvider !== undefined && (typeof aiProvider !== "string" || aiProvider.trim() === "")) {
    return errorResponse("invalid_args", { field: "ai_provider", expected: "non-empty string" });
  }
  const aiModel = a.ai_model ?? a.model ?? a.model_name ?? a.aiModel;
  if (aiModel !== undefined && (typeof aiModel !== "string" || aiModel.trim() === "")) {
    return errorResponse("invalid_args", { field: "ai_model", expected: "non-empty string" });
  }
  if (typeof aiProvider === "string") payload["ai_provider"] = aiProvider.trim().toLowerCase();
  if (typeof aiModel === "string") payload["ai_model"] = aiModel.trim();
  if (typeof a.user_requested_ai === "boolean") payload["user_requested_ai"] = a.user_requested_ai;
  if (typeof a.user_requested_deterministic === "boolean") {
    payload["user_requested_deterministic"] = a.user_requested_deterministic;
  }
  const forceGpuAiDelta = a.force_gpu_ai_delta ?? a.use_gpu_ai_delta ?? a.force_ai_delta;
  if (typeof forceGpuAiDelta === "boolean") {
    payload["force_gpu_ai_delta"] = forceGpuAiDelta;
  }
  if (typeof a.prefer_gpu_pipeline === "boolean") {
    payload["prefer_gpu_pipeline"] = a.prefer_gpu_pipeline;
  }
  if (typeof a.gpu_mode === "string") payload["gpu_mode"] = a.gpu_mode;
  if (typeof a.gpu_arch === "string") payload["gpu_arch"] = a.gpu_arch;
  const compileManifest = a.compile_manifest ?? a.manifest;
  if (compileManifest !== undefined) {
    if (!compileManifest || typeof compileManifest !== "object" || Array.isArray(compileManifest)) {
      return errorResponse("invalid_args", {
        field: a.compile_manifest !== undefined ? "compile_manifest" : "manifest",
        expected: "object",
      });
    }
    payload["compile_manifest"] = compileManifest;
  }
  if (a.source_first_request_intent !== undefined) {
    const requestIntent = validateSourceFirstRequestIntent(a.source_first_request_intent);
    if (!requestIntent.accepted) {
      return errorResponse("invalid_args", {
        field: "source_first_request_intent",
        expected:
          `plain JSON object no larger than ${SOURCE_FIRST_REQUEST_INTENT_MAX_BYTES} UTF-8 bytes without GPU HMR/runtime/dispatch authority claims`,
        reason: requestIntent.reason,
      });
    }
    payload["source_first_request_intent"] = requestIntent.value;
  }
  if (typeof a.target === "string") payload["target"] = a.target;
  if (typeof a.project_root === "string") payload["project_root"] = a.project_root;
  if (typeof a.slug === "string") payload["slug"] = a.slug;

  let compileDispatch: Awaited<ReturnType<typeof attached.channels.sendCompileRequest>>;
  try {
    compileDispatch = await attached.channels.sendCompileRequest(
      payload,
      computeExpectedOutputContractHash,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("compile_channel_not_open")) {
      return errorResponse("compile_channel_not_open", {
        ready_state: msg.split(":")[1] ?? "unknown",
      });
    }
    return errorFromException("compile_send_failed", err);
  }

  const dispatchedAt = compileDispatch.dispatchedAt;
  const gpuProofDispatchCorrelation = Object.freeze({
    schema_version: compileDispatch.schemaVersion,
    evidence_authority: compileDispatch.proofAuthority,
    correlation_id: compileDispatch.proofCorrelationId,
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
  });
  eventLog.push({
    kind: "input",
    action: "compile:start",
    payload: {
      language,
      filename,
      is_gui: isGui,
      use_ai_split: Boolean(payload["use_ai_split"]),
      bypass_ai_split_cache:
        typeof bypassAiSplitCache === "boolean" ? bypassAiSplitCache : undefined,
      ...(typeof a.bypass_device_compile_cache === "boolean"
        ? { bypass_device_compile_cache: a.bypass_device_compile_cache }
        : {}),
      require_ai_provider_call:
        typeof requireAiProviderCall === "boolean" ? requireAiProviderCall : undefined,
      ...(typeof aiProvider === "string" ? { ai_provider: aiProvider.trim().toLowerCase() } : {}),
      ...(typeof aiModel === "string" ? { ai_model: aiModel.trim() } : {}),
      file_count: files.length,
      file_ref_count: fileRefs.length,
      source_chars: (a.source as string).length,
      prefer_gpu_pipeline:
        typeof a.prefer_gpu_pipeline === "boolean" ? a.prefer_gpu_pipeline : undefined,
      ...(typeof forceGpuAiDelta === "boolean" ? { force_gpu_ai_delta: forceGpuAiDelta } : {}),
      ...(typeof a.gpu_mode === "string" ? { gpu_mode: a.gpu_mode } : {}),
      ...(typeof a.gpu_arch === "string" ? { gpu_arch: a.gpu_arch } : {}),
      ...(compileManifest !== undefined ? { compile_manifest: true } : {}),
      ...(typeof a.target === "string" ? { target: a.target } : {}),
      gpu_proof_dispatch_correlation: gpuProofDispatchCorrelation,
    },
  });

  // Source-state producer: every MCP-driven compile declares which files
  // made up the compile input, so `synthi_get_source_state` and
  // `wait({condition:"source_state"})` see real data instead of a
  // "producer not wired" placeholder.
  const lastChangedFiles = [filename, ...files.map((f) => f.name), ...fileRefs.map((ref) => ref.name)];
  const contentHash = computeContentHash(a.source as string, files, fileRefs);
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
    gpu_proof_dispatch_correlation: gpuProofDispatchCorrelation,
    note:
      "Compile dispatched. Await terminal HMR status via synthi_wait_hmr({since_ts: dispatched_at}). Responses stream on build-log.",
  });
}
