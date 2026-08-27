import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WarrantStore } from "../../src/security/warrant_store.js";

const ORIGINAL_ENV = {
  store: process.env["SYNTHI_WARRANT_STORE"],
  key: process.env["SYNTHI_WARRANT_STORE_KEY"],
  mode: process.env["SYNTHI_WARRANT_MODE"],
};
const temporaryDirectories: string[] = [];

function tempStorePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synthi-warrant-store-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "warrants.journal");
}

function restoreEnv(): void {
  if (ORIGINAL_ENV.store === undefined) delete process.env["SYNTHI_WARRANT_STORE"];
  else process.env["SYNTHI_WARRANT_STORE"] = ORIGINAL_ENV.store;
  if (ORIGINAL_ENV.key === undefined) delete process.env["SYNTHI_WARRANT_STORE_KEY"];
  else process.env["SYNTHI_WARRANT_STORE_KEY"] = ORIGINAL_ENV.key;
  if (ORIGINAL_ENV.mode === undefined) delete process.env["SYNTHI_WARRANT_MODE"];
  else process.env["SYNTHI_WARRANT_MODE"] = ORIGINAL_ENV.mode;
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    // The path came directly from mkdtemp under the OS temp directory.
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function loadStoreBackedWarrantTools(file: string) {
  process.env["SYNTHI_WARRANT_STORE"] = file;
  process.env["SYNTHI_WARRANT_STORE_KEY"] = "test-only-32-byte-store-key-material";
  process.env["SYNTHI_WARRANT_MODE"] = "enforce";
  vi.resetModules();
  return import("../../src/tools/warrant.js");
}

describe("Patch K1 - encrypted warrant journal", () => {
  it("encrypts entries and ignores a duplicated sequence during replay", () => {
    const file = tempStorePath();
    const store = new WarrantStore({ file, key: "journal-key" });
    const entry = store.append({ k: "probe", value: "must-not-be-plaintext" });
    const ciphertext = fs.readFileSync(file, "utf8");
    expect(ciphertext).not.toContain("must-not-be-plaintext");
    fs.appendFileSync(file, ciphertext, "utf8");

    const restored = new WarrantStore({ file, key: "journal-key" }).replay<{ k: string; value: string }>();
    expect(restored).toEqual([entry]);
  });

  it("requests a checkpoint after 500 durable mutation entries", () => {
    const store = new WarrantStore({ file: tempStorePath(), key: "journal-key" });
    for (let index = 0; index < 500; index += 1) store.append({ k: "record", index });
    expect(store.needsCheckpoint()).toBe(true);
    store.append({ k: "checkpoint", state: "complete" });
    expect(store.needsCheckpoint()).toBe(false);
  });

  it("replays issue, trust binding, evidence, and sealed budget state into a fresh tools module", async () => {
    const file = tempStorePath();
    const first = await loadStoreBackedWarrantTools(file);
    const policy = await first.dispatchWarrantTool("synthi_warrant_policy_register", {
      policy_id: "restart-policy",
      steps: [{ unlock_after: { min_sample: 5, success_ratio: 1 }, grants: [{ tool: "synthi_describe" }] }],
    });
    expect(policy.isError).toBeFalsy();
    const issued = await first.dispatchWarrantTool("synthi_warrant_issue", {
      subject: "restart-agent",
      grants: [{ tool: "synthi_health", max_invocations: 3 }],
      ttl_ms: 60_000,
      seal: true,
    });
    const warrant = JSON.parse(issued.content[0]!.text).warrant as { warrant_id: string; bearer: string };
    expect((await first.dispatchWarrantTool("synthi_warrant_bind_trust", {
      warrant_id: warrant.warrant_id,
      policy_id: "restart-policy",
    })).isError).toBeFalsy();
    expect(first.enforceWarrantGate("synthi_health", {
      arguments: {},
      _meta: { warrant_id: warrant.warrant_id, warrant_bearer: warrant.bearer },
    })).toBeNull();
    first.settleWarrant("synthi_health", warrant.warrant_id, true);
    const before = JSON.parse((await first.dispatchWarrantTool("synthi_warrant_trust", {
      warrant_id: warrant.warrant_id,
    })).content[0]!.text).trust;
    expect(before.next_step.checks_remaining).toBe(4);

    const encryptedJournal = fs.readFileSync(file, "utf8");
    expect(encryptedJournal).not.toContain(warrant.warrant_id);
    expect(encryptedJournal).not.toContain(warrant.bearer);

    const second = await loadStoreBackedWarrantTools(file);
    const listed = JSON.parse((await second.dispatchWarrantTool("synthi_warrant_list", {})).content[0]!.text).warrants;
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ warrant_id: warrant.warrant_id, subject: "restart-agent", sealed: true }),
    ]));
    const after = JSON.parse((await second.dispatchWarrantTool("synthi_warrant_trust", {
      warrant_id: warrant.warrant_id,
    })).content[0]!.text).trust;
    expect(after).toEqual(before);
    const renewed = await second.dispatchWarrantTool("synthi_warrant_renew", {
      warrant_id: warrant.warrant_id,
      bearer: warrant.bearer,
      ttl_ms: 1_000,
    });
    expect(renewed.isError).toBeFalsy();
  });
});
