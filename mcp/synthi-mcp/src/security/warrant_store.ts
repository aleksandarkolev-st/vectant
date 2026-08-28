/**
 * Encrypted durable journal for Agent Warrants (WI_WARRANTS_SPEC, Patch K1).
 *
 * The on-disk representation is JSON Lines, but each line's payload is an
 * independent AES-256-GCM ciphertext. This makes a torn final append
 * recoverable without weakening authentication for the rest of the journal.
 * `seq` is monotonic and is used to ignore duplicate replay entries.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const CHECKPOINT_INTERVAL = 500;
const MAX_LINES_PER_GENERATION = 50_000;

export interface WarrantStoreOptions {
  /** Absolute or working-directory-relative journal path. */
  file: string;
  /** Deployment secret. A 32-byte hex/base64 value is used directly; other text is SHA-256 derived. */
  key?: string;
}

export interface JournalEntry<T> {
  seq: number;
  event: T;
}

interface EncryptedLine {
  iv: string;
  tag: string;
  data: string;
}

function keyFromEnvironment(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === trimmed.replace(/=+$/, "")) {
    return base64;
  }
  return createHash("sha256").update(trimmed).digest();
}

function fallbackKeyFile(file: string): string {
  const fingerprint = createHash("sha256").update(path.resolve(file)).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), `synthi-warrant-store-${fingerprint}.key`);
}

function resolveKeyMaterial(options: WarrantStoreOptions): Buffer {
  if (options.key !== undefined && options.key.trim().length > 0) return keyFromEnvironment(options.key);

  // This is intentionally machine-local. Operators that need portability or
  // multi-host recovery set SYNTHI_WARRANT_STORE_KEY explicitly.
  const keyFile = fallbackKeyFile(options.file);
  let material: string;
  if (fs.existsSync(keyFile)) {
    material = fs.readFileSync(keyFile, "utf8").trim();
    fs.chmodSync(keyFile, 0o600);
  } else {
    material = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, material, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return createHash("sha256").update(`${material}:${path.resolve(options.file)}`).digest();
}

function encryptLine(key: Buffer, plaintext: string): EncryptedLine {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptLine(key: Buffer, line: EncryptedLine): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(line.iv, "base64"));
  decipher.setAuthTag(Buffer.from(line.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(line.data, "base64")), decipher.final()]).toString("utf8");
}

function isCheckpoint(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as { k?: unknown }).k === "checkpoint";
}

/** Synchronous by design: a successful mutation is acknowledged only after fsync. */
export class WarrantStore {
  private readonly key: Buffer;
  private nextSequence = 1;
  private eventsSinceCheckpoint = 0;
  private lineCount = 0;

  constructor(private readonly options: WarrantStoreOptions) {
    this.key = resolveKeyMaterial(options);
    fs.mkdirSync(path.dirname(path.resolve(options.file)), { recursive: true });
    const entries = this.replay<unknown>();
    this.lineCount = this.readLineCount();
    this.nextSequence = (entries.at(-1)?.seq ?? 0) + 1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (isCheckpoint(entries[index]!.event)) break;
      this.eventsSinceCheckpoint += 1;
    }
  }

  get file(): string {
    return this.options.file;
  }

  /** Encrypt, append, and fsync one journal entry. Returns its durable sequence. */
  append<T>(event: T): JournalEntry<T> {
    const entry: JournalEntry<T> = { seq: this.nextSequence, event };
    this.writeEntry(this.options.file, entry, "a");
    this.nextSequence += 1;
    this.lineCount += 1;
    this.eventsSinceCheckpoint = isCheckpoint(event) ? 0 : this.eventsSinceCheckpoint + 1;
    return entry;
  }

  /**
   * Start a compacted generation from a complete checkpoint. The previous
   * encrypted journal is retained as a rotated audit generation. A crash in
   * the tiny rename window recovers from that retained generation on boot.
   */
  rotate<T>(checkpoint: T): JournalEntry<T> {
    const entry: JournalEntry<T> = { seq: this.nextSequence, event: checkpoint };
    const staged = `${this.options.file}.${process.pid}.${entry.seq}.next`;
    const archived = `${this.options.file}.${entry.seq}.rotated`;
    this.writeEntry(staged, entry, "wx");
    if (fs.existsSync(this.options.file)) fs.renameSync(this.options.file, archived);
    fs.renameSync(staged, this.options.file);
    this.nextSequence += 1;
    this.eventsSinceCheckpoint = 0;
    this.lineCount = 1;
    return entry;
  }

  /**
   * Read authenticated entries in sequence order. Malformed or torn tail
   * records are discarded. Duplicate sequence ids are ignored so a replay is
   * idempotent even if a line was replicated twice.
   */
  replay<T>(): JournalEntry<T>[] {
    const journalFile = this.recoveryJournalFile();
    if (journalFile === undefined) return [];
    const entries: JournalEntry<T>[] = [];
    const seen = new Set<number>();
    for (const line of fs.readFileSync(journalFile, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const encrypted = JSON.parse(line) as EncryptedLine;
        const entry = JSON.parse(decryptLine(this.key, encrypted)) as JournalEntry<T>;
        if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || seen.has(entry.seq)) continue;
        seen.add(entry.seq);
        entries.push(entry);
      } catch {
        // A crash can leave only the final line incomplete. Keep earlier
        // authenticated history intact; do not let one bad tail brick boot.
      }
    }
    return entries.sort((left, right) => left.seq - right.seq);
  }

  needsCheckpoint(): boolean {
    return this.eventsSinceCheckpoint >= CHECKPOINT_INTERVAL;
  }

  needsRotation(): boolean {
    return this.lineCount >= MAX_LINES_PER_GENERATION;
  }

  size(): number {
    return this.lineCount;
  }

  private writeEntry<T>(file: string, entry: JournalEntry<T>, flag: "a" | "wx"): void {
    const line = `${JSON.stringify(encryptLine(this.key, JSON.stringify(entry)))}\n`;
    const fd = fs.openSync(file, flag, 0o600);
    try {
      fs.writeFileSync(fd, line, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private recoveryJournalFile(): string | undefined {
    if (fs.existsSync(this.options.file)) return this.options.file;
    const directory = path.dirname(this.options.file);
    const prefix = `${path.basename(this.options.file)}.`;
    const candidates = fs.existsSync(directory)
      ? fs.readdirSync(directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".rotated"))
        .map((name) => path.join(directory, name))
      : [];
    if (candidates.length === 0) return undefined;
    const latest = candidates.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]!;
    // Restore the durable old generation before accepting any new mutation.
    fs.copyFileSync(latest, this.options.file, fs.constants.COPYFILE_EXCL);
    return this.options.file;
  }

  private readLineCount(): number {
    if (!fs.existsSync(this.options.file)) return 0;
    return fs.readFileSync(this.options.file, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
  }
}
