import { eventLog } from "../events/index.js";
import { verify } from "../verify/index.js";

export type BrokerPostcondition =
  | { type: "pixel_match"; x: number; y: number; expected_rgb: [number, number, number]; tolerance?: number }
  | { type: "lifecycle_event"; state: string; since_event_id?: number }
  | { type: "custom_app_signal"; pattern: string; since_event_id?: number }
  | { type: "event_log"; pattern: string; since_event_id?: number }
  | { type: "dom_visible"; selector: string; text?: string }
  | { type: "url_location"; url?: string; pattern?: string }
  | { type: "vision_visible"; description: string };

export interface BrokerPostconditionResult {
  supported: boolean;
  verified: boolean;
  type: string;
  evidence?: Record<string, unknown>;
}

export async function verifyBrokerPostcondition(
  raw: unknown,
  timeoutMs: number = 2_000
): Promise<BrokerPostconditionResult> {
  const parsed = parsePostcondition(raw);
  if (!parsed) {
    return {
      supported: false,
      verified: false,
      type: "unknown",
      evidence: { reason: "invalid_postcondition_shape" },
    };
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  switch (parsed.type) {
    case "pixel_match": {
      const result = await verify({
        kind: "pixel",
        x: parsed.x,
        y: parsed.y,
        expected_rgb: parsed.expected_rgb,
        tolerance: parsed.tolerance ?? 0,
      });
      return {
        supported: true,
        verified: result.matched === true,
        type: parsed.type,
        evidence: result.evidence,
      };
    }
    case "lifecycle_event":
      return pollUntil(deadline, parsed.type, () => {
        const match = eventLog.query({ kind: "lifecycle", since_seq: parsed.since_event_id ?? 0 })
          .find((entry) => entry.kind === "lifecycle" && entry.state === parsed.state);
        return match ? { verified: true, evidence: { event_id: match.seq, state: parsed.state } } : null;
      });
    case "custom_app_signal":
    case "event_log":
      return pollUntil(deadline, parsed.type, () => {
        const re = new RegExp(parsed.pattern);
        const match = eventLog.query({ since_seq: parsed.since_event_id ?? 0 })
          .find((entry) => re.test(JSON.stringify(entry)));
        return match ? { verified: true, evidence: { event_id: match.seq, pattern: parsed.pattern } } : null;
      });
    case "dom_visible":
    case "url_location":
    case "vision_visible":
      return {
        supported: false,
        verified: false,
        type: parsed.type,
        evidence: { reason: "capability_not_available_for_session" },
      };
  }
}

function parsePostcondition(raw: unknown): BrokerPostcondition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  switch (obj["type"]) {
    case "pixel_match":
      if (
        typeof obj["x"] === "number" &&
        typeof obj["y"] === "number" &&
        Array.isArray(obj["expected_rgb"]) &&
        obj["expected_rgb"].length === 3 &&
        obj["expected_rgb"].every((v) => typeof v === "number")
      ) {
        return {
          type: "pixel_match",
          x: obj["x"],
          y: obj["y"],
          expected_rgb: obj["expected_rgb"] as [number, number, number],
          ...(typeof obj["tolerance"] === "number" ? { tolerance: obj["tolerance"] } : {}),
        };
      }
      return null;
    case "lifecycle_event":
      return typeof obj["state"] === "string"
        ? {
            type: "lifecycle_event",
            state: obj["state"],
            ...(typeof obj["since_event_id"] === "number" ? { since_event_id: obj["since_event_id"] } : {}),
          }
        : null;
    case "custom_app_signal":
    case "event_log":
      return typeof obj["pattern"] === "string"
        ? {
            type: obj["type"],
            pattern: obj["pattern"],
            ...(typeof obj["since_event_id"] === "number" ? { since_event_id: obj["since_event_id"] } : {}),
          } as BrokerPostcondition
        : null;
    case "dom_visible":
      return typeof obj["selector"] === "string"
        ? { type: "dom_visible", selector: obj["selector"], ...(typeof obj["text"] === "string" ? { text: obj["text"] } : {}) }
        : null;
    case "url_location":
      return {
        type: "url_location",
        ...(typeof obj["url"] === "string" ? { url: obj["url"] } : {}),
        ...(typeof obj["pattern"] === "string" ? { pattern: obj["pattern"] } : {}),
      };
    case "vision_visible":
      return typeof obj["description"] === "string"
        ? { type: "vision_visible", description: obj["description"] }
        : null;
    default:
      return null;
  }
}

async function pollUntil(
  deadline: number,
  type: string,
  sample: () => { verified: true; evidence: Record<string, unknown> } | null
): Promise<BrokerPostconditionResult> {
  for (;;) {
    const result = sample();
    if (result) {
      return { supported: true, verified: true, type, evidence: result.evidence };
    }
    if (Date.now() >= deadline) {
      return { supported: true, verified: false, type, evidence: { timeout: true } };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
