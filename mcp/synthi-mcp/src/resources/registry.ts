import { eventLog } from "../events/index.js";
import type { EventLogEntry } from "../events/index.js";
import { session } from "../session.js";
import { snapshotStore } from "../snapshot/index.js";
import { escapeHatchQueue } from "../escape_hatch/queue.js";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string; // base64
}

export const RESOURCE_URIS = {
  screenshot: "synthi://preview/screenshot",
  hmr: "synthi://preview/hmr",
  console: "synthi://preview/console",
  events: "synthi://preview/events",
  state: "synthi://preview/state",
  source: "synthi://preview/source",
  // Phase 3 additions.
  snapshots: "synthi://snapshots/list",
  escapeHatchQueue: "synthi://escape-hatch/queue",
} as const;

export const RESOURCES: ResourceDescriptor[] = [
  {
    uri: RESOURCE_URIS.screenshot,
    name: "Latest preview screenshot",
    description: "Most recent encoded PNG frame from the attached preview session. Rate-limited to ≤ 2 Hz on subscription.",
    mimeType: "image/png",
  },
  {
    uri: RESOURCE_URIS.hmr,
    name: "HMR status stream",
    description: "Terminal HMR events (applied/rejected/compile-error/...) since attach, newest last.",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.console,
    name: "Console stream",
    description: "All console-kind events from the event log.",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.events,
    name: "Event log (all kinds)",
    description: "Full event ring snapshot with last_seq marker.",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.state,
    name: "Session lifecycle + presence",
    description: "Wire SessionState, unsafe_mode flag, attached_humans, attached_agents, attached_at, last_activity_at.",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.source,
    name: "Source-state summary",
    description: "Most recent source_state event (last_changed_files + detail).",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.snapshots,
    name: "Snapshot index (phase 3)",
    description: "Metadata for every snapshot captured in this process. Frames are omitted — call synthi_list_snapshots({include_frame:true}) for blobs.",
    mimeType: "application/json",
  },
  {
    uri: RESOURCE_URIS.escapeHatchQueue,
    name: "Escape-hatch pending queue (phase 3)",
    description: "Pending synthi_request_human / synthi_annotate_and_ask entries awaiting operator answer.",
    mimeType: "application/json",
  },
];

/** Read the current snapshot for a URI. Returns undefined for unknown URIs. */
export async function readResource(uri: string): Promise<ResourceContents | undefined> {
  switch (uri) {
    case RESOURCE_URIS.screenshot: {
      const attached = session.get();
      if (!attached) return { uri, mimeType: "application/json", text: JSON.stringify({ ok: false, error: "not_attached" }) };
      try {
        const frame = await attached.frames.getFrame();
        return {
          uri,
          mimeType: "image/png",
          blob: frame.data.toString("base64"),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { uri, mimeType: "application/json", text: JSON.stringify({ ok: false, error: message }) };
      }
    }
    case RESOURCE_URIS.hmr: {
      const entries = eventLog.query({ kind: "hmr" });
      return json(uri, { entries, last_seq: eventLog.lastSeq() });
    }
    case RESOURCE_URIS.console: {
      const entries = eventLog.query({ kind: "console" });
      return json(uri, { entries, last_seq: eventLog.lastSeq() });
    }
    case RESOURCE_URIS.events: {
      const entries = eventLog.query();
      return json(uri, { entries, last_seq: eventLog.lastSeq() });
    }
    case RESOURCE_URIS.state: {
      const attached = session.get();
      return json(uri, {
        mcp_state: session.getState(),
        wire_state: session.getWireState(),
        wire_state_ts: session.getWireStateTs(),
        unsafe_mode: session.isUnsafeMode(),
        attached_at: session.getAttachedAt(),
        last_activity_at: session.getLastActivityAt(),
        session_id: attached?.sessionId ?? null,
        pending_disruption: session.disruptionPending(),
      });
    }
    case RESOURCE_URIS.source: {
      const entries = eventLog.query({ kind: "source_state" });
      const last = entries[entries.length - 1];
      return json(uri, {
        last,
        count: entries.length,
      });
    }
    case RESOURCE_URIS.snapshots: {
      const records = await snapshotStore.list();
      return json(uri, {
        count: records.length,
        snapshots: records.map((r) => ({
          snapshot_id: r.snapshot_id,
          label: r.label ?? null,
          session_id: r.session_id,
          captured_at: r.captured_at,
          event_log_seq_at_capture: r.event_log_seq_at_capture,
          wire_state: r.wire_state,
          source_state: r.source_state,
          frame: {
            frame_seq: r.frame.frame_seq ?? null,
            ts: r.frame.ts ?? null,
            width: r.frame.width ?? null,
            height: r.frame.height ?? null,
            has_blob: r.frame.png_base64 !== undefined,
          },
        })),
      });
    }
    case RESOURCE_URIS.escapeHatchQueue: {
      const pending = escapeHatchQueue.list();
      return json(uri, {
        count: pending.length,
        pending: pending.map((p) => ({
          pending_id: p.pending_id,
          kind: p.kind,
          question: p.question,
          created_at: p.created_at,
          expires_at: p.expires_at,
          source_tool: p.source_tool,
          ...(p.screenshot_bytes !== undefined ? { screenshot_bytes: p.screenshot_bytes } : {}),
          ...(p.detail !== undefined ? { detail: p.detail } : {}),
        })),
      });
    }
    default:
      return undefined;
  }
}

function json(uri: string, obj: Record<string, unknown>): ResourceContents {
  return { uri, mimeType: "application/json", text: JSON.stringify(obj) };
}

/**
 * Classify an event-log entry into the set of resource URIs whose
 * subscribers should be notified. Single entry can fan out to multiple
 * URIs (an HMR event triggers both "events" and "hmr").
 */
export function resourceUrisForEvent(entry: EventLogEntry): string[] {
  const uris: string[] = [RESOURCE_URIS.events]; // everything hits events
  switch (entry.kind) {
    case "hmr":
      uris.push(RESOURCE_URIS.hmr);
      break;
    case "console": {
      uris.push(RESOURCE_URIS.console);
      // Phase-3 taps: the snapshot + restore + escape-hatch paths emit
      // console events with a `[snapshot]` / `[restore]` / `[escape_hatch]`
      // prefix. We fan out to their dedicated resources so subscribers
      // don't have to parse the console stream.
      if (entry.message.startsWith("[snapshot]") || entry.message.startsWith("[restore]")) {
        uris.push(RESOURCE_URIS.snapshots);
      }
      if (entry.message.startsWith("[escape_hatch]")) {
        uris.push(RESOURCE_URIS.escapeHatchQueue);
      }
      break;
    }
    case "source_state":
      uris.push(RESOURCE_URIS.source);
      break;
    case "lifecycle":
    case "security":
      uris.push(RESOURCE_URIS.state);
      break;
    case "frame":
      uris.push(RESOURCE_URIS.screenshot);
      break;
  }
  return uris;
}
