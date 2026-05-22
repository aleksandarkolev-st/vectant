/**
 * Snapshot / restore store — Phase 3 scaffold (ultraplan §Snapshot/restore).
 *
 * What this captures:
 *   - last observed source_state from the event log (file list + content_hash)
 *   - event-log seq at capture time (so wait({condition:"source_state",
 *     since_seq:snap.seq}) works after restore)
 *   - latest decoded PNG frame (bounded; drops if no frame yet)
 *   - wire session state snapshot (for correlation)
 *
 * What this does NOT capture (documented, not hidden):
 *   - Guest process heap / stack (requires CRIU + worker integration — the
 *     phase-2+ backlog item D6's neighbor).
 *   - File contents (we only remember which files were last touched — the
 *     agent is the source of truth for contents).
 *
 * Restore semantics are deliberately explicit: the MCP replays the captured
 * source_state into the event log, and the caller can opt into
 * `recompile_source:true` to actually trigger a compile (provided they
 * re-supply the matching files). Everything else is "observable state
 * markers you can compare against after an experiment."
 *
 * Storage is in-memory by default. Long-lived runs (soak harness) pass
 * a file-backed persistor so snapshots survive MCP restarts.
 */

import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SNAPSHOT_ID_PATTERN_SOURCE = "snap_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const SNAPSHOT_ID_PATTERN = new RegExp(`^${SNAPSHOT_ID_PATTERN_SOURCE}$`);

export function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_ID_PATTERN.test(value);
}

export function assertSnapshotId(value: unknown): asserts value is string {
  if (!isSnapshotId(value)) {
    throw new Error("invalid_snapshot_id");
  }
}

export interface SnapshotSourceState {
  last_changed_files: string[];
  content_hash: string | null;
  source_state_seq: number | null;
  source_state_ts: number | null;
}

export interface SnapshotFrame {
  /** Base64 PNG. Present only when a decoded frame was available at capture. */
  png_base64?: string;
  /** Worker-assigned seq for the frame. */
  frame_seq?: number;
  /** Encoder timestamp for the frame. */
  ts?: number;
  width?: number;
  height?: number;
}

export interface SnapshotRecord {
  snapshot_id: string;
  label?: string;
  session_id: string;
  captured_at: number;
  event_log_seq_at_capture: number;
  wire_state: string;
  source_state: SnapshotSourceState;
  frame: SnapshotFrame;
  /** Caller-supplied free-form notes (e.g. experiment parameters). */
  detail?: Record<string, unknown>;
}

export interface SnapshotPersistor {
  save(record: SnapshotRecord): Promise<void>;
  load(snapshot_id: string): Promise<SnapshotRecord | undefined>;
  list(): Promise<SnapshotRecord[]>;
  remove(snapshot_id: string): Promise<boolean>;
}

/** In-memory persistor — the default. Tests use this directly. */
export class MemorySnapshotPersistor implements SnapshotPersistor {
  private readonly store = new Map<string, SnapshotRecord>();

  async save(record: SnapshotRecord): Promise<void> {
    this.store.set(record.snapshot_id, record);
  }
  async load(snapshot_id: string): Promise<SnapshotRecord | undefined> {
    return this.store.get(snapshot_id);
  }
  async list(): Promise<SnapshotRecord[]> {
    return [...this.store.values()].sort((a, b) => a.captured_at - b.captured_at);
  }
  async remove(snapshot_id: string): Promise<boolean> {
    return this.store.delete(snapshot_id);
  }
  _size(): number {
    return this.store.size;
  }
  _resetForTests(): void {
    this.store.clear();
  }
}

/**
 * File-backed persistor. One JSON document per snapshot under the
 * configured directory, atomic rename to avoid torn writes.
 */
export class FileSnapshotPersistor implements SnapshotPersistor {
  private readonly resolvedBaseDir: string;

  constructor(private readonly baseDir: string) {
    this.resolvedBaseDir = path.resolve(baseDir);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.resolvedBaseDir, { recursive: true });
  }

  private fileFor(id: string): string {
    assertSnapshotId(id);
    const filePath = path.resolve(this.resolvedBaseDir, `${id}.json`);
    const relative = path.relative(this.resolvedBaseDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("invalid_snapshot_path");
    }
    return filePath;
  }

  async save(record: SnapshotRecord): Promise<void> {
    await this.ensureDir();
    const tmp = this.fileFor(record.snapshot_id) + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(record), "utf8");
    await fs.rename(tmp, this.fileFor(record.snapshot_id));
  }

  async load(id: string): Promise<SnapshotRecord | undefined> {
    try {
      const text = await fs.readFile(this.fileFor(id), "utf8");
      return JSON.parse(text) as SnapshotRecord;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async list(): Promise<SnapshotRecord[]> {
    try {
      const files = await fs.readdir(this.resolvedBaseDir);
      const records: SnapshotRecord[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -".json".length);
        if (!isSnapshotId(id)) continue;
        try {
          const text = await fs.readFile(this.fileFor(id), "utf8");
          records.push(JSON.parse(text) as SnapshotRecord);
        } catch {
          // skip malformed files rather than failing the whole list
        }
      }
      return records.sort((a, b) => a.captured_at - b.captured_at);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return [];
      throw err;
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.fileFor(id));
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return false;
      throw err;
    }
  }
}

export class SnapshotStore {
  private persistor: SnapshotPersistor = new MemorySnapshotPersistor();
  private cap = 64;

  setPersistor(p: SnapshotPersistor): void {
    this.persistor = p;
  }

  setCapacity(n: number): void {
    this.cap = Math.max(1, Math.floor(n));
  }

  newId(): string {
    return `snap_${randomUUID()}`;
  }

  digest(record: SnapshotRecord): string {
    const h = createHash("sha256");
    h.update(record.snapshot_id);
    h.update(String(record.captured_at));
    h.update(record.wire_state);
    h.update(record.source_state.content_hash ?? "");
    for (const f of record.source_state.last_changed_files) h.update(f);
    if (record.frame.png_base64) h.update(record.frame.png_base64.slice(0, 256));
    return h.digest("hex").slice(0, 16);
  }

  async save(record: SnapshotRecord): Promise<void> {
    await this.persistor.save(record);
    // Best-effort cap enforcement: drop oldest memory entries so long-running
    // processes don't accumulate unbounded JSON blobs. File-backed persistors
    // ignore the cap (operator can prune explicitly).
    if (this.persistor instanceof MemorySnapshotPersistor) {
      const all = await this.persistor.list();
      if (all.length > this.cap) {
        const drop = all.slice(0, all.length - this.cap);
        for (const r of drop) await this.persistor.remove(r.snapshot_id);
      }
    }
  }

  async load(id: string): Promise<SnapshotRecord | undefined> {
    return this.persistor.load(id);
  }

  async list(): Promise<SnapshotRecord[]> {
    return this.persistor.list();
  }

  async remove(id: string): Promise<boolean> {
    return this.persistor.remove(id);
  }

  _resetForTests(): void {
    this.persistor = new MemorySnapshotPersistor();
    this.cap = 64;
  }
}

export const snapshotStore = new SnapshotStore();
