import { describe, expect, it } from "vitest";
import { reduceLane0Windows } from "../../src/browser/lane0.js";
import type { BrowserTraceEvent } from "../../src/browser/types.js";

describe("Lane 0 sliding-window reducer", () => {
  it("annotates adjacent form fields with parameter candidates and semantic groups", () => {
    const reduced = reduceLane0Windows([
      event({
        event_id: "first-name",
        event_seq: 1,
        action: "fill",
        value: "Jane",
        detail: {
          field_name: "First name",
          element: { label: "First name", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"First name\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      event({
        event_id: "last-name",
        event_seq: 2,
        action: "fill",
        value: "Doe",
        detail: {
          field_name: "Last name",
          element: { label: "Last name", role: "textbox" },
        },
        locator_candidates: [
          { kind: "label", locator: "page.getByLabel(\"Last name\")", confidence: 0.94, reason: "form_label" },
        ],
      }),
      event({
        event_id: "save",
        event_seq: 3,
        action: "click",
        detail: {
          element: { role: "button", name: "Save customer" },
        },
        locator_candidates: [
          { kind: "role", locator: "page.getByRole(\"button\", { name: \"Save customer\" })", confidence: 0.98, reason: "role" },
        ],
      }),
    ]);

    const first = reduced.events.find((item) => item.event_id === "first-name");
    const last = reduced.events.find((item) => item.event_id === "last-name");
    const save = reduced.events.find((item) => item.event_id === "save");

    expect(reduced.status).toEqual(expect.objectContaining({
      reducer_version: "lane0_deterministic_v1",
      actionable_event_count: 3,
      window_count: 3,
      annotated_event_count: 3,
      stale_annotation_count: 0,
      unresolved_event_count: 0,
    }));
    expect(first?.semantic).toEqual(expect.objectContaining({
      parameter_name: "first_name",
      group_label: "Save customer workflow",
      confidence: "high",
      reasons: expect.arrayContaining(["adjacent_field_context_parameter", "window_contains_mutation_signal"]),
    }));
    expect(last?.semantic?.parameter_name).toBe("last_name");
    expect(save?.semantic).toEqual(expect.objectContaining({
      intent: "Commit Save customer workflow",
      group_label: "Save customer workflow",
    }));
  });

  it("keeps late or stale model-response behavior out of trace ordering", () => {
    const reduced = reduceLane0Windows([
      event({ event_id: "third", event_seq: 3, action: "click", detail: { element: { role: "button", name: "Third" } } }),
      event({ event_id: "first", event_seq: 1, action: "click", detail: { element: { role: "button", name: "First" } } }),
      event({ event_id: "second", event_seq: 2, action: "click", detail: { element: { role: "button", name: "Second" } } }),
    ]);

    expect(reduced.events.map((item) => item.event_id)).toEqual(["first", "second", "third"]);
    expect(reduced.status.stale_annotation_count).toBe(0);
    expect(reduced.windows.map((window) => window.focus_event_id)).toEqual(["first", "second", "third"]);
  });

  it("immediately flushes explicit hover and drag teaching signals", () => {
    const reduced = reduceLane0Windows([
      event({
        event_id: "hover-menu",
        event_seq: 1,
        action: "hover",
        detail: { alt_option_intent: true, element: { role: "button", name: "More actions" } },
      }),
      event({
        event_id: "drag-card",
        event_seq: 2,
        action: "drag",
        detail: { drag_mode: true, drag_class: "nativeHtmlDnd", element: { role: "listitem", name: "Task" } },
      }),
    ]);

    expect(reduced.status.flush_policy.immediate_flush_on).toEqual(
      expect.arrayContaining(["explicitHover", "dragIntent"]),
    );
    expect(reduced.windows).toEqual([
      expect.objectContaining({ focus_event_id: "hover-menu", flush_reason: "explicitHover" }),
      expect.objectContaining({ focus_event_id: "drag-card", flush_reason: "dragIntent" }),
    ]);
    expect(reduced.events[0]?.semantic?.intent).toBe("Reveal or inspect More actions");
    expect(reduced.events[0]?.semantic?.reasons).toContain("explicit_hover_intent");
    expect(reduced.events[1]?.semantic?.intent).toBe("Drag Task");
    expect(reduced.events[1]?.semantic?.reasons).toContain("drag_mode_intent");
  });
});

function event(overrides: Partial<BrowserTraceEvent>): BrowserTraceEvent {
  return {
    event_id: "evt",
    trace_id: "trace",
    trace_version: 7,
    event_seq: 1,
    ts: 1,
    tab_id: "tab",
    origin: "https://app.example.com",
    url: "https://app.example.com/customers",
    kind: "human_action",
    ...overrides,
  };
}
