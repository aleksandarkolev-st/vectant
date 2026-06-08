import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { eventLog } from "./events/index.js";
import { recordToolCall } from "./observability/metrics.js";
import { enforceQuota } from "./observability/quota.js";
import {
  RESOURCES,
  RESOURCE_URIS,
  readResource,
  resourceUrisForEvent,
} from "./resources/index.js";
import { attachTool } from "./tools/attach.js";
import { detachTool } from "./tools/detach.js";
import { healthTool } from "./tools/health.js";
import { reconnectTool } from "./tools/reconnect.js";
import { getEventLogTool } from "./tools/get_event_log.js";
import { getSourceStateTool } from "./tools/get_source_state.js";
import { screenshotTool } from "./tools/screenshot.js";
import { waitHmrTool } from "./tools/wait_hmr.js";
import { clickTool } from "./tools/click.js";
import { typeTool } from "./tools/type.js";
import { locateTool } from "./tools/locate.js";
import { waitTool } from "./tools/wait.js";
import { mouseTool } from "./tools/mouse.js";
import { keyboardTool } from "./tools/keyboard.js";
import { getUsageTool } from "./tools/get_usage.js";
import { setQualityTool } from "./tools/set_quality.js";
import { checkpointTool } from "./tools/checkpoint.js";
import { acknowledgeDisruptionTool } from "./tools/acknowledge_disruption.js";
import { getCrashInfoTool } from "./tools/get_crash_info.js";
import { resetGuestTool } from "./tools/reset_guest.js";
import { verifyTool } from "./tools/verify.js";
import { compileTool } from "./tools/compile.js";
import { reportSourceStateTool } from "./tools/report_source_state.js";
import { dispatchInputTool } from "./tools/dispatch_input.js";
import { describeTool } from "./tools/describe.js";
import { acquireInputTool } from "./tools/acquire_input.js";
import { renewInputTool } from "./tools/renew_input.js";
import { releaseInputTool } from "./tools/release_input.js";
import { forceReleaseInputTool } from "./tools/force_release_input.js";
import { requestHumanTool } from "./tools/request_human.js";
import { annotateAndAskTool } from "./tools/annotate_and_ask.js";
import { recentHumanActionsTool } from "./tools/recent_human_actions.js";
import {
  actTool,
  clickTextTool,
  fillFormTool,
  getLabelsTool,
  getMetricsTool,
  getProcessStateTool,
  queryTool,
} from "./tools/enriched.js";
import { getAudioLevelTool, waitAudioEventTool } from "./tools/audio.js";
import { snapshotTool } from "./tools/snapshot.js";
import { restoreTool } from "./tools/restore.js";
import { listSnapshotsTool } from "./tools/list_snapshots.js";
import { answerEscapeHatchTool } from "./tools/answer_escape_hatch.js";
import { AUTH_TOOLS, dispatchAuthTool } from "./tools/auth.js";
import { BROWSER_TOOLS, dispatchBrowserTool } from "./tools/browser.js";
import { SOURCE_TOOLS, dispatchSourceTool } from "./tools/source.js";
import { SAFETY_TOOLS, dispatchSafetyTool } from "./tools/safety.js";
import type { ToolContext } from "./tools/shared.js";
import { SNAPSHOT_ID_PATTERN_SOURCE } from "./snapshot/index.js";

export interface SynthiServerOptions {
  defaultSessionId?: string;
  defaultSignalingUrl: string;
}

const TOOLS = [
  ...BROWSER_TOOLS,
  ...AUTH_TOOLS,
  ...SOURCE_TOOLS,
  ...SAFETY_TOOLS,
  {
    name: "synthi_attach",
    description:
      "Connect as a WebRTC peer to an existing Synthi preview session. Returns a protocol version + capability manifest + session envelope (state, unsafe_mode, presence). Evicts any existing browser peer on that session (MVP Path A). Required before any other tool call.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session ID from POST /session/create on collab-server. Defaults to SYNTHI_SESSION_ID env or --session CLI arg.",
        },
        signalingUrl: {
          type: "string",
          description: "WebSocket URL for the signaling server. Defaults to SYNTHI_SIGNALING_URL env or ws://localhost:9000.",
        },
        requested_protocol_version: {
          type: "number",
          description: "Agent's preferred protocol version. Server returns unsupported_protocol with server_supports[] if the version is not implemented. Omit to get the default.",
        },
        "i-understand-no-auth": {
          type: "boolean",
          description: "Required when signalingUrl is non-local (e.g., a remote hostname). Set true to acknowledge that the MCP has no authentication and the session is exposed over the network.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_screenshot",
    description:
      "Return the latest video frame as a PNG. Optional {region,max_dim,freshness_max_ms,after_frame_gate,frame_gate_timeout_ms}. region crops; max_dim downscales the longest edge; freshness_max_ms returns frame_stale if the most recent frame is older than the SLA. after_frame_gate must be the satisfied synthi_wait_hmr frame_gate including its one-time gate_token; screenshot returns a capture_manifest with frame/image hashes. Emits a `usage` event for every call.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
          },
          required: ["x", "y", "w", "h"],
          description: "Optional crop bbox in pixels. Clamped to the frame.",
        },
        max_dim: {
          type: "number",
          description: "Downscale so longest edge <= max_dim. Positive integer.",
        },
        freshness_max_ms: {
          type: "number",
          description: "SLA: return frame_stale if latest frame's age exceeds this many ms.",
        },
        after_frame_gate: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["satisfied"] },
            frame_seq: { type: "number" },
            ts_ms: { type: "number" },
            session_id: { type: "string" },
            gate_token: { type: "string" },
          },
          required: ["status", "gate_token"],
          description:
            "Satisfied frame_gate returned by synthi_wait_hmr, including the one-time gate_token. When provided, screenshot waits until the decoded frame seq/timestamp is at or after this gate, consumes the token, and returns a capture_manifest bound to image bytes.",
        },
        frame_gate_timeout_ms: {
          type: "number",
          description: "Maximum time to wait for after_frame_gate before returning frame_gate_timeout. Default 1200000.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_wait_hmr",
    description:
      "Block until the preview's HMR pipeline reaches a terminal status (applied / rejected / compile-error / full-reload-required / discarded) or the timeout elapses. Call this immediately after editing source files so the subsequent screenshot reflects the change.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: {
          type: "number",
          description: "Maximum wait in milliseconds. Default 1200000 (20 minutes, accommodates cold GPU validation, AI split, compile, runtime proof, and visual capture latency).",
          default: 1200000,
        },
        module: {
          type: "string",
          description: "Optional terminal HMR module filter, for example 'device' to wait for GPU sidecar HMR instead of the first core/gui status.",
        },
        since_ts: {
          type: "number",
          description: "Optional ms epoch anchor from synthi_compile.dispatched_at. Lets the wait return a terminal HMR event that completed after compile dispatch but before this wait subscribed.",
        },
        preview_id: {
          type: "string",
          description: "Optional preview/session slug filter for retained or live terminal HMR events.",
        },
        requiredGpuProofState: {
          type: "string",
          enum: [
            "gpu-hmr-compile-proven",
            "gpu-hmr-symbol-bound",
            "gpu-hmr-abi-proven",
            "gpu-hmr-epoch-swap-proven",
            "gpu-hmr-dispatch-observed",
            "gpu-hmr-dispatch-safe-proven",
            "gpu-hmr-output-oracle-proven",
            "gpu-hmr-host-preservation-proven",
            "gpu-hmr-full-runtime-proven",
          ],
          description: "Optional minimum GPU HMR proof state. If the latest GPU proof telemetry is missing or below this state, the tool returns gpu_hmr_proof_insufficient instead of treating HMR applied as full correctness. Raw GPU telemetry is returned as gpu_proof_telemetry; gpu_proof is only returned after a requested proof state passes validation.",
        },
        requireGpuFullRuntimeProof: {
          type: "boolean",
          description: "Shortcut for requiredGpuProofState='gpu-hmr-full-runtime-proven'. This must only pass when the full proof ladder has been satisfied.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_compile",
    description:
      "Dispatch a CompileRequest on the worker's `compile` data channel. Fire-and-forget — the HMR status streams on `build-log`, so follow up with synthi_wait_hmr({since_ts: dispatched_at}) to block on applied/compile-error/etc. Closes the edit→HMR→screenshot loop without a frontend open.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "Source language (e.g. 'cpp', 'rust', 'go', 'java'). Matches worker CompileRequest.language.",
        },
        source: {
          type: "string",
          description: "Primary source file content.",
        },
        filename: {
          type: "string",
          description: "Primary source filename. Defaults to main.<language>.",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
            },
            required: ["name", "content"],
          },
          description: "Additional source files keyed by relative path.",
        },
        file_refs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sha256: { type: "string" },
              bytes: { type: "number" },
            },
            required: ["name"],
          },
          description: "Additional source files already present in the workspace. The worker reads each relative path and verifies optional sha256/bytes before using it as compile input.",
        },
        is_gui: {
          type: "boolean",
          description: "Whether this compile emits a GUI (Xvfb + media pipeline). Default true.",
        },
        width: { type: "number" },
        height: { type: "number" },
        use_ai_split: {
          type: "boolean",
          description: "Let the worker decide split via AI (Tier 2/3). Default false.",
        },
        bypass_ai_split_cache: {
          type: "boolean",
          description:
            "Require a fresh AI split request instead of accepting a cached split result. Used for provenance-sensitive validation.",
        },
        force_ai_split: {
          type: "boolean",
          description: "Alias for bypass_ai_split_cache.",
        },
        force_fresh_ai_split: {
          type: "boolean",
          description: "Alias for bypass_ai_split_cache.",
        },
        require_fresh_ai_split: {
          type: "boolean",
          description: "Alias for bypass_ai_split_cache.",
        },
        user_requested_ai: {
          type: "boolean",
          description: "Explicit opt-in to the AI-split (Loop B). Default false.",
        },
        user_requested_deterministic: {
          type: "boolean",
          description: "Explicit opt-in to deterministic split (Loop A). Default false.",
        },
        force_gpu_ai_delta: {
          type: "boolean",
          description:
            "Force GPU source edits through the verifier-gated GPU AI delta path instead of the local direct-device fast path.",
        },
        use_gpu_ai_delta: {
          type: "boolean",
          description: "Alias for force_gpu_ai_delta.",
        },
        force_ai_delta: {
          type: "boolean",
          description: "Alias for force_gpu_ai_delta.",
        },
        prefer_gpu_pipeline: {
          type: "boolean",
          description: "Forward the compile through the GPU HMR detector/pipeline when a GPU manifest or source is present. Defaults true in the worker.",
        },
        gpu_mode: {
          type: "string",
          enum: ["auto", "disabled"],
          description: "GPU mode from the IDE toggle. 'auto' lets the worker detect/use GPU HMR; 'disabled' routes through the host-only path.",
        },
        gpu_arch: {
          type: "string",
          description: "Optional target GPU architecture forwarded to the worker, for example gfx1201 or sm_80.",
        },
        compile_manifest: {
          type: "object",
          description: "Optional worker compile manifest. Used by deterministic MCP flows before a split sidecar exists.",
        },
        manifest: {
          type: "object",
          description: "Alias for compile_manifest.",
        },
        target: {
          type: "string",
          description: "Target platform. Default 'native'; mobile uses 'react-native-emulator'.",
        },
        project_root: { type: "string" },
        slug: { type: "string" },
      },
      required: ["language", "source"],
    },
  },
  {
    name: "synthi_click",
    description:
      "Send a mouse click at the given Xvfb pixel coordinates on the attached session. Coordinates are relative to the preview frame (top-left origin).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "X coordinate in pixels." },
        y: { type: "number", description: "Y coordinate in pixels." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
          description: "Mouse button.",
        },
        lease_id: {
          type: "string",
          description: "Input lease id from synthi_acquire_input. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_frame_seq: {
          type: "number",
          description: "Frame seq the click is based on. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_viewport: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, dpr: { type: "number" } },
          required: ["w", "h", "dpr"],
        },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "synthi_type",
    description:
      "Type a text string into the attached session. Expands to a sequence of key down/up events. Rate-limited to 500 keys/sec.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type." },
        lease_id: {
          type: "string",
          description: "Input lease id from synthi_acquire_input. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_frame_seq: {
          type: "number",
          description: "Frame seq the typing action is based on. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_viewport: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, dpr: { type: "number" } },
          required: ["w", "h", "dpr"],
        },
      },
      required: ["text"],
    },
  },
  {
    name: "synthi_wait",
    description:
      "Block until a named condition is satisfied, or the timeout elapses. Conditions: hmr, log, source_state, pixel, motion_settled, scene_change, element. `text` is an ultraplan condition — phase 1 returns text_wait_requires_ocr_backend with a required_tool_call:\"synthi_wait\" suggesting condition:\"log\" as a fallback until an OCR backend ships.",
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          enum: ["hmr", "log", "source_state", "pixel", "motion_settled", "scene_change", "element", "text"],
          description: "Which condition to wait for.",
        },
        timeoutMs: {
          type: "number",
          description: "Maximum wait time in milliseconds. Default 60000.",
        },
        region: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
          description: "Bbox for motion_settled / scene_change / text.",
        },
        still_for_ms: { type: "number", description: "motion_settled: how long the frame must remain within `threshold` hamming before resolving." },
        threshold: { type: "number", description: "motion_settled: hamming distance below which two frames are considered 'still'. Default 4." },
        min_hamming: { type: "number", description: "scene_change: minimum hamming distance between baseline and current frame. Default 8." },
        sample_interval_ms: { type: "number", description: "motion_settled/pixel/scene_change: poll interval. Default 100." },
        x: { type: "number", description: "pixel: x coordinate." },
        y: { type: "number", description: "pixel: y coordinate." },
        expected_rgb: { type: "array", items: { type: "number" }, description: "pixel: resolve when pixel matches this RGB (within tolerance)." },
        not_rgb: { type: "array", items: { type: "number" }, description: "pixel: resolve when pixel differs from this RGB." },
        tolerance: { type: "number", description: "pixel: per-channel tolerance. Default 0." },
        substring: { type: "string", description: "text: substring to wait for on-screen." },
        pattern: { type: "string", description: "log: regex to match event entries." },
        since_seq: { type: "number", description: "log/source_state: only consider entries with seq > this." },
        handle_id: { type: "string", description: "element: handle id previously returned from synthi_locate." },
        any_change: { type: "boolean", description: "source_state: resolve on any source_state event (default true)." },
      },
      required: ["condition"],
    },
  },
  {
    name: "synthi_detach",
    description:
      "Close the current WebRTC + signaling connection and release the session handle. Safe to call when not attached. Does NOT terminate the Synthi preview session itself; a human browser can re-attach afterwards.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_health",
    description:
      "Snapshot of the MCP's connection state: wire session state + timestamp, peer connectionState, data-channel readyStates, first-frame flag, unsafe_mode flag. Read-only.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_reconnect",
    description:
      "Re-establish the WebRTC peer + signaling socket against the current sessionId. Recovers transient network drops. If the underlying session is gone (worker dead, pod evicted), returns session_terminated and the agent should synthi_attach a fresh session.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_get_event_log",
    description:
      "Fetch entries from the session-scoped event ring buffer. Supports since_seq, since_ts, kind filter (lifecycle/hmr/input/browser/locator_resolution/console/error/security/source_state/usage), and limit. Returns entries oldest-first + last_seq.",
    inputSchema: {
      type: "object",
      properties: {
        since_seq: {
          type: "number",
          description: "Return only entries with seq > since_seq. Integer >= 0.",
        },
        since_ts: {
          type: "number",
          description: "Return only entries with ts >= since_ts (ms epoch).",
        },
        kind: {
          oneOf: [
            { type: "string", enum: ["lifecycle", "hmr", "input", "browser", "locator_resolution", "console", "error", "security", "source_state", "usage"] },
            { type: "array", items: { type: "string" } },
          ],
          description: "Filter by one kind or an array of kinds.",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return. Integer >= 1.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_get_source_state",
    description:
      "Report the session's source-state summary (last_changed_files, last_change_seq, last_change_ts, content_hash). Sourced from the event log. Producers: synthi_compile (auto), synthi_report_source_state (agent-side).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_report_source_state",
    description:
      "Declare that the agent has edited the given files. Emits a source_state event so synthi_get_source_state + wait({condition:\"source_state\"}) see the change. Use after Edit/Write calls when you're NOT also driving a compile — otherwise synthi_compile emits this automatically.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths of files that were edited.",
        },
        content_hash: {
          type: "string",
          description: "Optional caller-computed hash. Server falls back to hashing the concatenated file names if omitted.",
        },
        detail: {
          description: "Free-form structured context; passed through in the event's detail field.",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "synthi_get_usage",
    description:
      "Return per-session usage counters aggregated from the event log: tool_call, screenshot, vision_inference, egress_bytes. Includes vision_cost_usd_estimate (populated by claude_api / gemini_api backends) and hot_seconds since attach.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_set_quality",
    description:
      "Request bandwidth changes (target_fps / target_bitrate / target_resolution). Phase 1 records the intent in the event log; actual negotiation with the worker is phase 2 (returns applied:false, note:\"phase_1_record_only\").",
    inputSchema: {
      type: "object",
      properties: {
        target_fps: { type: "number" },
        target_bitrate: { type: "number", description: "Bits per second." },
        target_resolution: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" } },
          required: ["w", "h"],
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_checkpoint",
    description:
      "Write a named marker (label) into the event log so post-run analysis can anchor time ranges to caller-meaningful phases. Returns {seq, ts}.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short human-readable label (required)." },
        detail: { description: "Arbitrary structured context, passed through in the response." },
      },
      required: ["label"],
    },
  },
  {
    name: "synthi_acknowledge_disruption",
    description:
      "Acknowledge a pending disruption (crash-recovered / full-reload-required) so subsequent input is accepted. Returns `cleared` with the disruption kind that was cleared, or \"none\" if nothing was pending.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_get_crash_info",
    description:
      "Return the most recent crash metadata observed by the MCP (pending_disruption + crash_info). null/empty if the session has not reported a crash.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_reset_guest",
    description:
      "Request that the guest program be restarted without closing the session. Phase 1 records the intent; worker-side enforcement lands in phase 2 (returns applied:false).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_mouse",
    description:
      "Playwright-style mouse tool. Actions: click, double_click, move, down, up, drag, wheel. Coordinates come from explicit x/y OR a handle (resolved via synthi_locate, bbox center is used). Optional auto-wait via waitFor:{condition,...} runs a synthi_wait before the action.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "double_click", "move", "down", "up", "drag", "wheel"] },
        x: { type: "number" },
        y: { type: "number" },
        toX: { type: "number", description: "Drag destination x." },
        toY: { type: "number", description: "Drag destination y." },
        deltaY: { type: "number", description: "Wheel delta (positive = scroll down)." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        handle: {
          type: "object",
          properties: {
            handle_id: { type: "string" },
            reuse: { type: "boolean" },
            description: { type: "string" },
          },
          required: ["handle_id"],
        },
        waitFor: {
          type: "object",
          description: "Optional pre-action wait. Same shape as synthi_wait input.",
        },
        await_ack: {
          type: "boolean",
          description: "When true, every outgoing input frame is stamped with a dispatch_id and the tool waits for the worker's `{type:\"input-ack\"}` echo before returning. Useful when subsequent steps (screenshot, wait) depend on the event actually landing in the guest. Default false (fire-and-forget).",
        },
        ack_timeout_ms: {
          type: "number",
          description: "Per-dispatch ack timeout when await_ack is true. Default 4000ms; rejects with input_ack_timeout if the worker doesn't echo within the window.",
        },
        lease_id: {
          type: "string",
          description: "Input lease id from synthi_acquire_input. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_frame_seq: {
          type: "number",
          description: "Frame seq the action is based on. Required for broker-enforced input; rejected if stale or more than one frame behind.",
        },
        based_on_viewport: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, dpr: { type: "number" } },
          required: ["w", "h", "dpr"],
          description: "Optional viewport observed with based_on_frame_seq. Broker-enforced input rejects if the current viewport dimensions or producer DPR changed.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "synthi_keyboard",
    description:
      "Keyboard tool. Actions: type (string), key (single named key like Enter/Tab), chord (array of keys pressed simultaneously, released in reverse). Optional confirm:{pattern,timeoutMs} waits for a log-pattern match after the action.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["type", "key", "chord"] },
        text: { type: "string", description: "For action=type." },
        key: { type: "string", description: "For action=key. Uses JS DOM ev.key semantics (\"Enter\", \"Tab\", \"a\")." },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "For action=chord (e.g., [\"Control\", \"c\"]).",
        },
        confirm: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            timeoutMs: { type: "number" },
          },
          required: ["pattern"],
        },
        waitFor: {
          type: "object",
          description: "Optional pre-action wait. Same shape as synthi_wait input.",
        },
        await_ack: {
          type: "boolean",
          description: "When true, every outgoing key frame is stamped with a dispatch_id and the tool waits for the worker's `{type:\"input-ack\"}` echo before returning. Default false.",
        },
        ack_timeout_ms: {
          type: "number",
          description: "Per-dispatch ack timeout when await_ack is true. Default 4000ms.",
        },
        lease_id: {
          type: "string",
          description: "Input lease id from synthi_acquire_input. Required when SYNTHI_BROKER_INPUT_MODE=enforce.",
        },
        based_on_frame_seq: {
          type: "number",
          description: "Frame seq the action is based on. Required for broker-enforced input; rejected if stale or more than one frame behind.",
        },
        based_on_viewport: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, dpr: { type: "number" } },
          required: ["w", "h", "dpr"],
          description: "Optional viewport observed with based_on_frame_seq. Broker-enforced input rejects if the current viewport dimensions or producer DPR changed.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "synthi_verify",
    description:
      "Evaluate a predicate against the current session state. Predicate kinds: pixel, log, element_visible, ocr, scene_matches, and, or. ocr returns ocr_backend_not_implemented (phase 1); scene_matches returns verify_scene_matches_unsupported with required_tool_call:\"synthi_describe\". and/or compose up to depth 4, 8 clauses per level.",
    inputSchema: {
      type: "object",
      properties: {
        predicate: {
          type: "object",
          description: "Tagged predicate object. See PhasePredicate types.",
        },
      },
      required: ["predicate"],
    },
  },
  {
    name: "synthi_dispatch_input",
    description:
      "Broker-mediated state-changing input endpoint. Requires lease_id and fresh based_on_frame_seq when SYNTHI_BROKER_INPUT_MODE=enforce. Returns transport_ack, browser_ack, optional effect_verified, ack_chain, and explicit unverified:true when no postcondition is supplied.",
    inputSchema: {
      type: "object",
      properties: {
        tool_call_id: { type: "string" },
        lease_id: { type: "string" },
        based_on_frame_seq: { type: "number" },
        based_on_viewport: {
          type: "object",
          properties: { w: { type: "number" }, h: { type: "number" }, dpr: { type: "number" } },
          required: ["w", "h", "dpr"],
        },
        action: {
          type: "object",
          description: "Supported actions: {tool:'synthi_mouse',kind:'click'|'move',x,y,button?} or {tool:'synthi_keyboard',kind:'type',text} or {tool:'synthi_keyboard',kind:'key',key}.",
        },
        postcondition: {
          type: "object",
          description: "Supported: pixel_match, lifecycle_event, custom_app_signal, event_log. DOM/URL/vision classes return UNSUPPORTED_POSTCONDITION_TYPE until corresponding session capabilities are present.",
        },
        timeout_ms: { type: "number" },
      },
      required: ["lease_id", "based_on_frame_seq", "action"],
    },
  },
  {
    name: "synthi_describe",
    description:
      "Describe the current preview frame. mode:'agent_side' (default) returns {screenshot, frame_seq, entities:[]} so the agent's own LLM runs the description. mode:'server_side' runs a VLM pass using the configured vision backend (claude_api | gemini_api) and returns {summary, entities[], frame_seq}. Falls back to capability_not_available when no server-side backend is configured. Intended as the closed-loop partner for verify({kind:'scene_matches'}), which returns verify_scene_matches_unsupported with required_tool_call:'synthi_describe'.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["agent_side", "server_side"],
          description: "agent_side returns a screenshot for the agent to reason about; server_side runs a VLM pass on the MCP side.",
        },
        focus_description: {
          type: "string",
          description: "Optional natural-language hint for what the description should emphasise (e.g. 'the login form').",
        },
        preferred_vision_backend: {
          type: "string",
          enum: ["claude_api", "gemini_api"],
          description: "server_side only: which vision backend to use. Defaults to SYNTHI_VISION_BACKEND env.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_acquire_input",
    description:
      "Acquire a D0 input lease for the session. Owner is derived server-side; client-supplied owner is ignored. Default/max lease duration is 15000ms, renewable up to 60000ms continuous ownership. Required before broker-enforced input.",
    inputSchema: {
      type: "object",
      properties: {
        lease_ms: {
          type: "number",
          description: "Lease duration in milliseconds. Clamped to [50, 15000]. Default 15000.",
        },
        scope: {
          type: "array",
          items: { type: "string", enum: ["mouse", "keyboard"] },
          description: "Lease scope. Defaults to both mouse and keyboard.",
        },
        preemptible: {
          type: "boolean",
          description: "Whether the lease may be preempted by policy. Default true.",
        },
        priority: {
          type: "string",
          enum: ["normal", "urgent_human_override"],
          description: "D1 arbitration priority. urgent_human_override can preempt a preemptible active lease.",
        },
        reason: {
          type: "string",
          description: "Short audit reason for acquiring input control.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_force_release_input",
    description:
      "Force-release an active input lease with an auditable reason. Intended for admin/human-override workflows; emits lease-loss events for subscribers.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string", description: "Lease id returned by synthi_acquire_input." },
        reason: { type: "string", description: "Audit reason for the forced release." },
        broker_token: { type: "string", description: "Signed broker bearer token for an admin principal." },
        forced_by: { type: "string", description: "Deprecated operator id override; when supplied, it must match the authenticated admin subject." },
      },
      required: ["lease_id", "broker_token"],
    },
  },
  {
    name: "synthi_renew_input",
    description:
      "Renew an active D0 input lease before expiry. Renewal after expiry deterministically returns LEASE_EXPIRED. Continuous ownership is capped at 60000ms.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string", description: "Lease id returned by synthi_acquire_input." },
        extend_ms: { type: "number", description: "Renewal duration in ms. Clamped to [50, 15000]. Default 15000." },
      },
      required: ["lease_id"],
    },
  },
  {
    name: "synthi_release_input",
    description:
      "Release a lease acquired via synthi_acquire_input. Omitting lease_id releases every lease held by this MCP process. Returns lease_not_found if the id does not match a live lease.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string", description: "Lease id returned by synthi_acquire_input. Omit to release all." },
      },
      required: [],
    },
  },
  {
    name: "synthi_request_human",
    description:
      "Ask a human operator a question and await their reply. Phase 1 wire-only: records intent + returns escape_hatch_backend_not_implemented. Operator-UI routing lands in phase 3.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Plain-text question for the human." },
        screenshot: {
          type: "string",
          description: "Optional base64-encoded PNG (from synthi_screenshot) to include with the question.",
        },
        timeoutMs: { type: "number", description: "Maximum time to wait for the human's reply." },
      },
      required: ["question"],
    },
  },
  {
    name: "synthi_annotate_and_ask",
    description:
      "Ask a human to click a point on a screenshot to disambiguate an action. Phase 1 wire-only: records intent + returns escape_hatch_backend_not_implemented. Operator-UI overlay lands in phase 3.",
    inputSchema: {
      type: "object",
      properties: {
        screenshot: { type: "string", description: "Base64-encoded PNG to annotate (from synthi_screenshot)." },
        question: { type: "string", description: "Plain-text prompt rendered with the overlay." },
        timeoutMs: { type: "number", description: "Maximum time to wait for the human's click." },
      },
      required: ["screenshot", "question"],
    },
  },
  {
    name: "synthi_recent_human_actions",
    description:
      "Return human-authored input actions observed by the MCP since sinceSeq. Phase 1 returns an empty list unless the worker has populated the log (input-source attribution hook is phase-1 pending).",
    inputSchema: {
      type: "object",
      properties: {
        sinceSeq: { type: "number", description: "Return only actions with seq > sinceSeq." },
        limit: { type: "number", description: "Maximum number of entries to return. Default 64." },
      },
      required: [],
    },
  },
  // Enriched tier (phase 2b). Advertised unconditionally so clients can
  // enumerate the surface, but each tool returns enriched_tier_not_available
  // until a session registers an a11y-bridge or synthi-probe provider.
  {
    name: "synthi_query",
    description:
      "Query the enriched-tier entity tree for entities matching a role / name-contains filter. Returns [] when no provider is registered. Requires capabilities.enriched_tier.available=true.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Filter by accessibility role (e.g., 'button', 'text_field')." },
        name_contains: { type: "string", description: "Substring match against entity accessible name." },
        limit: { type: "number", description: "Max entities returned. Default implementation-defined." },
      },
      required: [],
    },
  },
  {
    name: "synthi_act",
    description:
      "Invoke a semantic action on a known enriched entity (press, select, focus, toggle). Action dispatch goes through the a11y bridge or probe callback — not through raw coordinate input. Returns enriched_tier_not_available when no provider is registered.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Entity id returned by synthi_query." },
        action: { type: "string", enum: ["press", "select", "focus", "toggle"] },
      },
      required: ["entity_id", "action"],
    },
  },
  {
    name: "synthi_click_text",
    description:
      "Find an enriched entity by accessible-name substring and press it. Convenience wrapper over synthi_query + synthi_act — returns locator_ambiguous when multiple entities match, locator_unresolved when none match.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Substring to match against entity names." },
        confirm: { type: "boolean", description: "Reserved for future sensitive-action interstitial." },
      },
      required: ["text"],
    },
  },
  {
    name: "synthi_fill_form",
    description:
      "Batch-fill multiple text-entry entities by id + value. Each field reports per-entity {ok, reason} so partial fills are visible. Enriched tier only.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity_id: { type: "string" },
              value: { type: "string" },
            },
            required: ["entity_id", "value"],
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "synthi_get_labels",
    description:
      "Return {bbox, name, role} for every enriched entity in the frame (or restricted to a region). Useful for dense UIs where synthi_query would be chatty.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
          },
          required: ["x", "y", "w", "h"],
        },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "synthi_get_process_state",
    description:
      "Return {pid, rss_kb, threads, uptime_ms} for the guest process. Sourced via the enriched-tier provider when available. Returns enriched_tier_not_available otherwise.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "synthi_get_metrics",
    description:
      "Return guest-reported metrics. Only populated when a synthi-probe provider registers custom metrics; a11y bridges always return []. Optional `metric` filters to a single metric name.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string" },
      },
      required: [],
    },
  },
  // Audio tier (phase 2d — wire stubs).
  {
    name: "synthi_get_audio_level",
    description:
      "Return the guest's current audio peak + RMS level in dBFS over the most recent window. Phase 2d wire stub — returns audio_backend_not_implemented until the worker audio-tee emits peak samples on the build-log DC.",
    inputSchema: {
      type: "object",
      properties: {
        window_ms: { type: "number", description: "Analysis window size (default 200ms)." },
      },
      required: [],
    },
  },
  {
    name: "synthi_wait_audio_event",
    description:
      "Block until the guest audio crosses a threshold (kind='above_threshold') or goes silent (kind='silence'). Phase 2d wire stub — returns audio_backend_not_implemented until worker peak emission ships.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["above_threshold", "silence"] },
        threshold_dbfs: { type: "number", description: "Level in dBFS. Default -30 for above_threshold, -50 for silence." },
        window_ms: { type: "number", description: "How long the condition must hold. Default 200ms." },
        timeoutMs: { type: "number", description: "Maximum wait. Default 30_000." },
      },
      required: [],
    },
  },
  {
    name: "synthi_snapshot",
    description:
      "Phase 3 — capture a session-observable snapshot: last source_state, current frame (optional), event-log seq, wire state. Returns {snapshot_id, captured_at, digest, ...} that can be replayed via synthi_restore. Does not snapshot guest process memory; documented limits in §Snapshot/restore.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Short human-readable label for the snapshot." },
        detail: { description: "Optional free-form context passed through into the snapshot record." },
        omit_frame: {
          type: "boolean",
          description: "When true, skip the PNG capture. Default false — frames are captured when available.",
        },
        frame_max_dim: {
          type: "number",
          description: "Downscale the captured frame's longest edge to this integer (≥16). Keeps snapshot payloads small.",
        },
      },
      required: [],
    },
  },
  {
    name: "synthi_restore",
    description:
      "Phase 3 — replay a previously captured snapshot into the current session. Re-emits the captured source_state event (so waiters resolve on the replay). Pass `recompile_source:true` + `compile:{language, source, files?}` to trigger a compile using the re-supplied source. `include_frame:true` returns the captured PNG in the response.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_id: {
          type: "string",
          pattern: `^${SNAPSHOT_ID_PATTERN_SOURCE}$`,
          description: "Snapshot id returned by synthi_snapshot.",
        },
        recompile_source: { type: "boolean" },
        include_frame: { type: "boolean" },
        compile: {
          type: "object",
          description: "Compile payload re-supplied by the caller when recompile_source:true.",
          properties: {
            language: { type: "string" },
            source: { type: "string" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, content: { type: "string" } },
                required: ["name", "content"],
              },
            },
            is_gui: { type: "boolean" },
            width: { type: "number" },
            height: { type: "number" },
          },
        },
      },
      required: ["snapshot_id"],
    },
  },
  {
    name: "synthi_list_snapshots",
    description:
      "Phase 3 — list snapshots captured for the attached session. Frames are omitted by default; set include_frame:true to include the PNG blobs.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Return up to N most-recent snapshots. Default 32, max 256." },
        include_frame: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "synthi_answer_escape_hatch",
    description:
      "Phase 3 — operator-side tool. Drain one pending question from the escape-hatch queue by id. Pass {pending_id, answer} to resolve, or {pending_id, cancel:true, cancel_reason?} to cancel. The target agent's synthi_request_human / synthi_annotate_and_ask call unblocks on this response.",
    inputSchema: {
      type: "object",
      properties: {
        pending_id: { type: "string" },
        answer: { description: "The answer payload returned to the blocked agent. Accepts any JSON value." },
        operator_id: { type: "string", description: "Short label identifying the answering operator." },
        cancel: { type: "boolean" },
        cancel_reason: { type: "string" },
      },
      required: ["pending_id"],
    },
  },
  {
    name: "synthi_locate",
    description:
      "Resolve a natural-language element description into a {bbox, handle_id, region_phash} handle. Default backend is `agent_side` — the server returns the current screenshot + `agent_side_vision_required` and expects you to ground the bbox using your own LLM then re-call with `hints.prefer_region` populated. `claude_api` grounds server-side via Anthropic (needs ANTHROPIC_API_KEY); `gemini_api` grounds server-side via Google (needs GEMINI_API_KEY / GOOGLE_API_KEY); `local` grounds via a self-hosted HTTP endpoint (needs SYNTHI_LOCAL_VISION_URL, phase 3); `mock` uses `hints.prefer_region` verbatim (spike only). Passing `handle_id` + `reuse_handle:true` enables the region-pHash cache keyed on (frame_content, description).",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "What the agent is trying to find, in natural language (e.g., 'the counter value').",
        },
        hints: {
          type: "object",
          description: "Optional hints to narrow the search. Mock/agent_side backends require `prefer_region` today.",
          properties: {
            prefer_region: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
            exclude_bbox: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
            },
            containing_text: { type: "string" },
            nth: { type: "number" },
          },
        },
        preferred_vision_backend: {
          type: "string",
          enum: ["mock", "agent_side", "claude_api", "gemini_api", "local"],
          description: "Which backend to use for vision grounding. Defaults to env SYNTHI_VISION_BACKEND or 'agent_side' (no API key needed; the agent does the grounding and re-calls with hints.prefer_region). `claude_api` needs ANTHROPIC_API_KEY; `gemini_api` needs GEMINI_API_KEY (or GOOGLE_API_KEY); `local` needs SYNTHI_LOCAL_VISION_URL (phase 3).",
        },
        handle_id: {
          type: "string",
          description: "Caller-supplied stable identity for the element, used to key the cache.",
        },
        reuse_handle: {
          type: "boolean",
          description: "If true and handle_id is set, try the cache first.",
        },
      },
      required: ["description"],
    },
  },
] as const;

export function createSynthiServer(options: SynthiServerOptions): Server {
  const server = new Server(
    {
      name: "synthi-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: false },
      },
    }
  );

  const ctx: ToolContext = {
    defaultSignalingUrl: options.defaultSignalingUrl,
    ...(options.defaultSessionId !== undefined
      ? { defaultSessionId: options.defaultSessionId }
      : {}),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ---------------------------------------------------------------------
  // Resources (subscribable state streams).
  // ---------------------------------------------------------------------
  const subscriptions = new Set<string>();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const contents = await readResource(uri);
    if (!contents) throw new Error(`unknown_resource: ${uri}`);
    const out: Record<string, unknown> = { uri: contents.uri, mimeType: contents.mimeType };
    if (contents.text !== undefined) out["text"] = contents.text;
    if (contents.blob !== undefined) out["blob"] = contents.blob;
    return { contents: [out] };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscriptions.add(req.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscriptions.delete(req.params.uri);
    return {};
  });

  // Feed: when an event lands, notify any subscribers whose URI overlaps.
  // Rate-limit screenshot notifications to <= 2 Hz so a chatty pipeline
  // doesn't blow out the agent's inbox.
  let lastScreenshotPushTs = 0;
  const SCREENSHOT_PUSH_MIN_INTERVAL_MS = 500;

  eventLog.onAppend(async (entry) => {
    const uris = new Set(resourceUrisForEvent(entry));
    for (const uri of uris) {
      if (!subscriptions.has(uri)) continue;
      if (uri === RESOURCE_URIS.screenshot) {
        const now = Date.now();
        if (now - lastScreenshotPushTs < SCREENSHOT_PUSH_MIN_INTERVAL_MS) continue;
        lastScreenshotPushTs = now;
      }
      try {
        await server.notification({
          method: "notifications/resources/updated",
          params: { uri },
        });
      } catch {
        // ignore notification errors — transport may be disconnected
      }
    }
  });

  async function dispatchTool(
    toolName: string,
    args: unknown,
    signal: AbortSignal | undefined
  ): Promise<CallToolResult> {
    const browserResponse = await dispatchBrowserTool(toolName, args);
    if (browserResponse) return browserResponse as CallToolResult;
    const authResponse = await dispatchAuthTool(toolName, args);
    if (authResponse) return authResponse as CallToolResult;
    const sourceResponse = await dispatchSourceTool(toolName, args);
    if (sourceResponse) return sourceResponse as CallToolResult;
    const safetyResponse = await dispatchSafetyTool(toolName, args);
    if (safetyResponse) return safetyResponse as CallToolResult;
    switch (toolName) {
      case "synthi_attach":
        return (await attachTool(args, ctx)) as CallToolResult;
      case "synthi_screenshot":
        return (await screenshotTool(args)) as CallToolResult;
      case "synthi_wait_hmr":
        return (await waitHmrTool(args)) as CallToolResult;
      case "synthi_click":
        return (await clickTool(args)) as CallToolResult;
      case "synthi_type":
        return (await typeTool(args)) as CallToolResult;
      case "synthi_locate":
        return (await locateTool(args, signal ? { signal } : undefined)) as CallToolResult;
      case "synthi_detach":
        return (await detachTool(args)) as CallToolResult;
      case "synthi_health":
        return (await healthTool(args)) as CallToolResult;
      case "synthi_reconnect":
        return (await reconnectTool(args)) as CallToolResult;
      case "synthi_get_event_log":
        return (await getEventLogTool(args)) as CallToolResult;
      case "synthi_get_source_state":
        return (await getSourceStateTool(args)) as CallToolResult;
      case "synthi_wait":
        return (await waitTool(args)) as CallToolResult;
      case "synthi_mouse":
        return (await mouseTool(args)) as CallToolResult;
      case "synthi_keyboard":
        return (await keyboardTool(args)) as CallToolResult;
      case "synthi_get_usage":
        return (await getUsageTool(args)) as CallToolResult;
      case "synthi_set_quality":
        return (await setQualityTool(args)) as CallToolResult;
      case "synthi_checkpoint":
        return (await checkpointTool(args)) as CallToolResult;
      case "synthi_acknowledge_disruption":
        return (await acknowledgeDisruptionTool(args)) as CallToolResult;
      case "synthi_get_crash_info":
        return (await getCrashInfoTool(args)) as CallToolResult;
      case "synthi_reset_guest":
        return (await resetGuestTool(args)) as CallToolResult;
      case "synthi_verify":
        return (await verifyTool(args)) as CallToolResult;
      case "synthi_compile":
        return (await compileTool(args)) as CallToolResult;
      case "synthi_report_source_state":
        return (await reportSourceStateTool(args)) as CallToolResult;
      case "synthi_dispatch_input":
        return (await dispatchInputTool(args)) as CallToolResult;
      case "synthi_describe":
        return (await describeTool(args, signal ? { signal } : undefined)) as CallToolResult;
      case "synthi_acquire_input":
        return (await acquireInputTool(args)) as CallToolResult;
      case "synthi_force_release_input":
        return (await forceReleaseInputTool(args)) as CallToolResult;
      case "synthi_renew_input":
        return (await renewInputTool(args)) as CallToolResult;
      case "synthi_release_input":
        return (await releaseInputTool(args)) as CallToolResult;
      case "synthi_request_human":
        return (await requestHumanTool(args)) as CallToolResult;
      case "synthi_annotate_and_ask":
        return (await annotateAndAskTool(args)) as CallToolResult;
      case "synthi_recent_human_actions":
        return (await recentHumanActionsTool(args)) as CallToolResult;
      case "synthi_query":
        return (await queryTool(args)) as CallToolResult;
      case "synthi_act":
        return (await actTool(args)) as CallToolResult;
      case "synthi_click_text":
        return (await clickTextTool(args)) as CallToolResult;
      case "synthi_fill_form":
        return (await fillFormTool(args)) as CallToolResult;
      case "synthi_get_labels":
        return (await getLabelsTool(args)) as CallToolResult;
      case "synthi_get_process_state":
        return (await getProcessStateTool(args)) as CallToolResult;
      case "synthi_get_metrics":
        return (await getMetricsTool(args)) as CallToolResult;
      case "synthi_get_audio_level":
        return (await getAudioLevelTool(args)) as CallToolResult;
      case "synthi_wait_audio_event":
        return (await waitAudioEventTool(args)) as CallToolResult;
      case "synthi_snapshot":
        return (await snapshotTool(args)) as CallToolResult;
      case "synthi_restore":
        return (await restoreTool(args)) as CallToolResult;
      case "synthi_list_snapshots":
        return (await listSnapshotsTool(args)) as CallToolResult;
      case "synthi_answer_escape_hatch":
        return (await answerEscapeHatchTool(args)) as CallToolResult;
      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "unknown_tool", tool: toolName }),
            },
          ],
          isError: true,
        };
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments;
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    // Phase-2d quota gate. `off` mode returns null immediately; `warn` logs
    // a security event but still returns null; `enforce` short-circuits
    // with quota_exceeded. Gate precedes dispatch so the offending tool
    // never actually runs when over budget.
    const quotaError = enforceQuota(toolName);
    if (quotaError) {
      recordToolCall(toolName, "error");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(quotaError) }],
        isError: true,
      };
    }
    const response = await dispatchTool(toolName, args, signal);
    // Record the outcome for Prometheus. Most tools return structured error
    // payloads via `isError: true` rather than throwing — respect that.
    recordToolCall(toolName, response.isError ? "error" : "ok");
    return response;
  });

  return server;
}
