import { describe, expect, it } from "vitest";
import { parseDotEnv, loadEnvFile } from "../../src/util/env.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("parseDotEnv", () => {
  it("parses KEY=VALUE", () => {
    expect(parseDotEnv("FOO=bar\nBAZ=quux")).toEqual({ FOO: "bar", BAZ: "quux" });
  });

  it("ignores blank lines and # comments", () => {
    const out = parseDotEnv("\n# comment\nFOO=bar\n\n# another\n");
    expect(out).toEqual({ FOO: "bar" });
  });

  it("strips surrounding quotes", () => {
    expect(parseDotEnv(`FOO="quoted"\nBAR='singly'`)).toEqual({
      FOO: "quoted",
      BAR: "singly",
    });
  });

  it("strips trailing inline comment only when unquoted", () => {
    expect(parseDotEnv(`FOO=bar # inline\nBAZ="bar # not a comment"`)).toEqual({
      FOO: "bar",
      BAZ: "bar # not a comment",
    });
  });

  it("skips malformed keys", () => {
    expect(parseDotEnv(`1BAD=x\n-bad=x\nGOOD=y`)).toEqual({ GOOD: "y" });
  });

  it("keeps `=` inside the value intact", () => {
    expect(parseDotEnv("URL=ws://host:9000/path?x=1&y=2")).toEqual({
      URL: "ws://host:9000/path?x=1&y=2",
    });
  });
});

describe("loadEnvFile", () => {
  it("reads CLI --env-file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synthi-env-"));
    const file = path.join(dir, "custom.env");
    writeFileSync(file, "FROM_CLI=yes\n");
    const env: Record<string, string | undefined> = {};
    const res = loadEnvFile(["--env-file", file], env);
    expect(res.path).toBe(file);
    expect(res.loaded).toBe(1);
    expect(env["FROM_CLI"]).toBe("yes");
  });

  it("accepts --env-file=path syntax", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synthi-env-"));
    const file = path.join(dir, "eq.env");
    writeFileSync(file, "FROM_EQ=yes\n");
    const env: Record<string, string | undefined> = {};
    const res = loadEnvFile([`--env-file=${file}`], env);
    expect(res.loaded).toBe(1);
    expect(env["FROM_EQ"]).toBe("yes");
  });

  it("falls back to SYNTHI_ENV_FILE env var", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synthi-env-"));
    const file = path.join(dir, "from_env_var.env");
    writeFileSync(file, "FROM_ENV=yes\n");
    const env: Record<string, string | undefined> = { SYNTHI_ENV_FILE: file };
    const res = loadEnvFile([], env);
    expect(res.loaded).toBe(1);
    expect(env["FROM_ENV"]).toBe("yes");
  });

  it("never overrides values already present in env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synthi-env-"));
    const file = path.join(dir, "host_wins.env");
    writeFileSync(file, "KEY=from_file\n");
    const env: Record<string, string | undefined> = { KEY: "from_host" };
    const res = loadEnvFile(["--env-file", file], env);
    expect(res.loaded).toBe(0);
    expect(res.skipped_existing).toBe(1);
    expect(env["KEY"]).toBe("from_host");
  });
});
