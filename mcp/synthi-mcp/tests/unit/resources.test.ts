import { beforeEach, describe, expect, it } from "vitest";
import {
  RESOURCES,
  RESOURCE_URIS,
  readResource,
  resourceUrisForEvent,
} from "../../src/resources/index.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

describe("resources registry", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("advertises six resources", () => {
    expect(RESOURCES.length).toBe(6);
    const uris = new Set(RESOURCES.map((r) => r.uri));
    expect(uris.has(RESOURCE_URIS.screenshot)).toBe(true);
    expect(uris.has(RESOURCE_URIS.hmr)).toBe(true);
    expect(uris.has(RESOURCE_URIS.console)).toBe(true);
    expect(uris.has(RESOURCE_URIS.events)).toBe(true);
    expect(uris.has(RESOURCE_URIS.state)).toBe(true);
    expect(uris.has(RESOURCE_URIS.source)).toBe(true);
  });

  it("readResource(unknown) returns undefined", async () => {
    const r = await readResource("synthi://preview/nonexistent");
    expect(r).toBeUndefined();
  });

  it("readResource(state) returns session snapshot", async () => {
    const r = await readResource(RESOURCE_URIS.state);
    expect(r?.mimeType).toBe("application/json");
    const parsed = JSON.parse(r!.text!) as Record<string, unknown>;
    expect(parsed["mcp_state"]).toBe("detached");
  });

  it("readResource(hmr) returns events filtered to kind:hmr", async () => {
    eventLog.push({ kind: "hmr", status: "applied", source: "test" });
    eventLog.push({ kind: "console", level: "info", message: "noise", source: "mcp_internal" });
    const r = await readResource(RESOURCE_URIS.hmr);
    const parsed = JSON.parse(r!.text!) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(1);
  });

  it("readResource(events) returns full log with last_seq", async () => {
    eventLog.push({ kind: "lifecycle", state: "ready" });
    eventLog.push({ kind: "console", level: "info", message: "x", source: "mcp_internal" });
    const r = await readResource(RESOURCE_URIS.events);
    const parsed = JSON.parse(r!.text!) as { entries: unknown[]; last_seq: number };
    expect(parsed.entries.length).toBe(2);
    expect(parsed.last_seq).toBe(2);
  });

  it("resourceUrisForEvent routes hmr → [events, hmr]", () => {
    const uris = resourceUrisForEvent({
      kind: "hmr",
      status: "applied",
      source: "test",
      seq: 1,
      ts: 1,
    });
    expect(uris).toContain(RESOURCE_URIS.events);
    expect(uris).toContain(RESOURCE_URIS.hmr);
  });

  it("resourceUrisForEvent routes console → [events, console]", () => {
    const uris = resourceUrisForEvent({
      kind: "console",
      level: "info",
      message: "x",
      source: "mcp_internal",
      seq: 1,
      ts: 1,
    });
    expect(uris).toContain(RESOURCE_URIS.console);
  });

  it("resourceUrisForEvent routes source_state → [events, source]", () => {
    const uris = resourceUrisForEvent({
      kind: "source_state",
      last_changed_files: ["a"],
      seq: 1,
      ts: 1,
    });
    expect(uris).toContain(RESOURCE_URIS.source);
  });
});
