import { beforeEach, describe, expect, it } from "vitest";
import {
  SNAPSHOT_ID_PATTERN,
  snapshotStore,
  MemorySnapshotPersistor,
  FileSnapshotPersistor,
  type SnapshotRecord,
} from "../../src/snapshot/index.js";
import { snapshotTool } from "../../src/tools/snapshot.js";
import { restoreTool } from "../../src/tools/restore.js";
import { listSnapshotsTool } from "../../src/tools/list_snapshots.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

const SNAPSHOT_ID_A = "snap_00000000-0000-0000-0000-000000000001";
const SNAPSHOT_ID_B = "snap_00000000-0000-0000-0000-000000000002";
const SNAPSHOT_ID_MISSING = "snap_00000000-0000-0000-0000-000000000099";

function installFakeAttached(sessionId: string = "fake-session"): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId,
    signalingUrl: "ws://localhost:9000",
    // frames.getFrame() throws in these tests — snapshot gracefully
    // falls back to "no frame" mode, which is what we want to exercise.
    frames: {
      getFrame: async () => { throw new Error("no_frame_in_unit_test"); },
    },
    resolution: { width: 800, height: 600 },
  };
}

describe("snapshot store", () => {
  beforeEach(() => {
    snapshotStore._resetForTests();
  });

  it("memory persistor round-trips records", async () => {
    const p = new MemorySnapshotPersistor();
    const rec: SnapshotRecord = {
      snapshot_id: SNAPSHOT_ID_A,
      session_id: "s",
      captured_at: 100,
      event_log_seq_at_capture: 5,
      wire_state: "running",
      source_state: {
        last_changed_files: ["a.ts"],
        content_hash: "abc",
        source_state_seq: 2,
        source_state_ts: 50,
      },
      frame: {},
    };
    await p.save(rec);
    const back = await p.load(SNAPSHOT_ID_A);
    expect(back?.snapshot_id).toBe(SNAPSHOT_ID_A);
    expect((await p.list()).length).toBe(1);
    expect(await p.remove(SNAPSHOT_ID_A)).toBe(true);
    expect(await p.load(SNAPSHOT_ID_A)).toBeUndefined();
  });

  it("computes a stable digest over key fields", () => {
    const rec: SnapshotRecord = {
      snapshot_id: SNAPSHOT_ID_B,
      session_id: "s",
      captured_at: 1,
      event_log_seq_at_capture: 1,
      wire_state: "running",
      source_state: {
        last_changed_files: ["a"],
        content_hash: "hash1",
        source_state_seq: 1,
        source_state_ts: 1,
      },
      frame: {},
    };
    const d1 = snapshotStore.digest(rec);
    const d2 = snapshotStore.digest(rec);
    expect(d1).toBe(d2);
    const d3 = snapshotStore.digest({ ...rec, source_state: { ...rec.source_state, content_hash: "hash2" } });
    expect(d3).not.toBe(d1);
  });

  it("file persistor rejects non-canonical snapshot ids", async () => {
    const p = new FileSnapshotPersistor(".tmp-snapshots");
    await expect(p.load("../secret")).rejects.toThrow("invalid_snapshot_id");
    await expect(p.remove("snap_../../secret")).rejects.toThrow("invalid_snapshot_id");
  });
});

describe("synthi_snapshot tool", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    snapshotStore._resetForTests();
  });

  it("errors when not attached", async () => {
    const res = await snapshotTool({});
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("not_attached");
  });

  it("captures source_state + wire_state when attached", async () => {
    installFakeAttached();
    eventLog.push({
      kind: "source_state",
      last_changed_files: ["main.cpp"],
      content_hash: "deadbeef",
    });
    const res = await snapshotTool({ label: "checkpoint-A" });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      snapshot_id: string;
      label: string;
      source_state: { last_changed_files: string[]; content_hash: string };
      wire_state: string;
      digest: string;
    };
    expect(body.snapshot_id).toMatch(SNAPSHOT_ID_PATTERN);
    expect(body.label).toBe("checkpoint-A");
    expect(body.source_state.last_changed_files).toEqual(["main.cpp"]);
    expect(body.source_state.content_hash).toBe("deadbeef");
    expect(body.wire_state).toBe("ready");
    expect(body.digest).toHaveLength(16);
  });

  it("rejects frame_max_dim < 16", async () => {
    installFakeAttached();
    const res = await snapshotTool({ frame_max_dim: 5 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("invalid_args");
  });
});

describe("synthi_restore tool", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    snapshotStore._resetForTests();
  });

  it("returns snapshot_not_found for unknown ids", async () => {
    installFakeAttached();
    const res = await restoreTool({ snapshot_id: SNAPSHOT_ID_MISSING });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; required_tool_call: { name: string } };
    expect(body.error).toBe("snapshot_not_found");
    expect(body.required_tool_call.name).toBe("synthi_snapshot");
  });

  it("rejects restore across session boundaries", async () => {
    installFakeAttached("session-A");
    // Capture in session A…
    eventLog.push({ kind: "source_state", last_changed_files: ["a"], content_hash: "h" });
    const snap = await snapshotTool({});
    const snapshotId = (snap.structuredContent as { snapshot_id: string }).snapshot_id;

    // …switch to session B and try to restore.
    installFakeAttached("session-B");
    const res = await restoreTool({ snapshot_id: snapshotId });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; snapshot_session: string; current_session: string };
    expect(body.error).toBe("snapshot_session_mismatch");
    expect(body.snapshot_session).toBe("session-A");
    expect(body.current_session).toBe("session-B");
  });

  it("replays the source_state event on restore", async () => {
    installFakeAttached("session-X");
    eventLog.push({
      kind: "source_state",
      last_changed_files: ["main.cpp", "util.cpp"],
      content_hash: "h1",
    });
    const snap = await snapshotTool({ label: "before-change" });
    const snapshotId = (snap.structuredContent as { snapshot_id: string }).snapshot_id;

    // Emit a second, different source_state; then restore should push a
    // fresh event with the original files.
    eventLog.push({
      kind: "source_state",
      last_changed_files: ["other.cpp"],
      content_hash: "h2",
    });
    const res = await restoreTool({ snapshot_id: snapshotId });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as {
      replayed_event_seq: number;
      source_state: { last_changed_files: string[]; content_hash: string };
    };
    expect(body.source_state.last_changed_files).toEqual(["main.cpp", "util.cpp"]);
    expect(body.source_state.content_hash).toBe("h1");

    // New event in the log reflects the replay.
    const events = eventLog.query({ kind: "source_state" });
    expect(events.length).toBe(3);
    const last = events[events.length - 1] as { last_changed_files: string[] };
    expect(last.last_changed_files).toEqual(["main.cpp", "util.cpp"]);
  });

  it("recompile_source:true without compile args fails loud", async () => {
    installFakeAttached("session-Y");
    eventLog.push({ kind: "source_state", last_changed_files: ["x"], content_hash: "h" });
    const snap = await snapshotTool({});
    const id = (snap.structuredContent as { snapshot_id: string }).snapshot_id;
    const res = await restoreTool({ snapshot_id: id, recompile_source: true });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("restore_recompile_requires_source");
  });
});

describe("synthi_list_snapshots tool", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    snapshotStore._resetForTests();
  });

  it("returns snapshots scoped to the attached session", async () => {
    installFakeAttached("session-A");
    eventLog.push({ kind: "source_state", last_changed_files: ["a"], content_hash: "h" });
    await snapshotTool({ label: "a1" });
    await snapshotTool({ label: "a2" });

    installFakeAttached("session-B");
    eventLog.push({ kind: "source_state", last_changed_files: ["b"], content_hash: "hh" });
    await snapshotTool({ label: "b1" });

    const res = await listSnapshotsTool({});
    const body = res.structuredContent as {
      total: number;
      count: number;
      snapshots: Array<{ label: string | null }>;
    };
    expect(body.total).toBe(1);
    expect(body.count).toBe(1);
    expect(body.snapshots[0]!.label).toBe("b1");
  });
});
