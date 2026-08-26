// Unit tests for src/security/warrant.ts (WI_WARRANTS_SPEC, Patch A).
// Covers issue/check decisions, attenuation narrowing, expiry clamping,
// revocation cascade, budgets, depth cap, and a seeded randomized sweep.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolGrant } from "../../src/security/warrant.js";
import { WarrantRegistry, globMatch } from "../../src/security/warrant.js";
import {
  dispatchWarrantTool,
  enforceWarrantGate,
  resolveWarrantMode,
} from "../../src/tools/warrant.js";

const NOW = 1_000_000;
const TTL = 60_000;

type Decision = ReturnType<WarrantRegistry["check"]>;

function codeOf(decision: Decision): string {
  return decision.allowed ? "" : decision.reason_code;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("WarrantRegistry", () => {
  it("issue + check happy path allows a covered tool", () => {
    const reg = new WarrantRegistry();
    const warrant = reg.issue({
      subject: "agent-a",
      grants: [{ tool: "fs.read" }],
      now: NOW,
      ttl_ms: TTL,
    });
    expect(warrant.status).toBe("active");
    expect(warrant.expires_at_ms).toBe(NOW + TTL);
    const decision = reg.check({ warrant_id: warrant.warrant_id, tool: "fs.read", now: NOW + 1 });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.warrant_id).toBe(warrant.warrant_id);
  });

  it("denies unknown ids, revoked warrants, and expired warrants", () => {
    const reg = new WarrantRegistry();
    expect(codeOf(reg.check({ warrant_id: "wr_missing", tool: "fs.read", now: NOW }))).toBe(
      "no_such_warrant",
    );
    const warrant = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    reg.revoke(warrant.warrant_id);
    expect(codeOf(reg.check({ warrant_id: warrant.warrant_id, tool: "fs.read", now: NOW + 1 }))).toBe(
      "revoked",
    );
    const brief = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: 100 });
    expect(
      codeOf(reg.check({ warrant_id: brief.warrant_id, tool: "fs.read", now: NOW + 100 })),
    ).toBe("expired");
  });

  it("denies uncovered tools and names the tool in human_reason", () => {
    const reg = new WarrantRegistry();
    const warrant = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    const decision = reg.check({ warrant_id: warrant.warrant_id, tool: "db.drop", now: NOW + 1 });
    expect(codeOf(decision)).toBe("tool_not_covered");
    if (!decision.allowed) expect(decision.human_reason).toContain("db.drop");
  });

  it("enforces arg globs: staging allowed, others denied, missing args pass", () => {
    const reg = new WarrantRegistry();
    const warrant = reg.issue({
      subject: "s",
      grants: [{ tool: "http.fetch", arg_constraints: { url: "https://staging.example.com/**" } }],
      now: NOW,
      ttl_ms: TTL,
    });
    expect(globMatch("https://staging.example.com/**", "https://staging.example.com/api/v1")).toBe(true);
    const staged = reg.check({
      warrant_id: warrant.warrant_id,
      tool: "http.fetch",
      args: { url: "https://staging.example.com/deploy/x" },
      now: NOW + 1,
    });
    expect(staged.allowed).toBe(true);
    const prod = reg.check({
      warrant_id: warrant.warrant_id,
      tool: "http.fetch",
      args: { url: "https://prod.example.com/deploy/x" },
      now: NOW + 1,
    });
    expect(codeOf(prod)).toBe("arg_out_of_scope");
    expect(reg.check({ warrant_id: warrant.warrant_id, tool: "http.fetch", now: NOW + 1 }).allowed).toBe(true);
  });

  it("attenuates to a strict subset and the child loses uncovered tools", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({
      subject: "parent",
      grants: [{ tool: "fs.read" }, { tool: "fs.write" }],
      now: NOW,
      ttl_ms: TTL,
    });
    const child = reg.attenuate({
      parent_warrant_id: parent.warrant_id,
      subject: "child",
      grants: [{ tool: "fs.read" }],
      now: NOW,
      ttl_ms: TTL,
    });
    expect(child.parent_warrant_id).toBe(parent.warrant_id);
    expect(child.root_warrant_id).toBe(parent.root_warrant_id);
    expect(reg.check({ warrant_id: child.warrant_id, tool: "fs.read", now: NOW + 1 }).allowed).toBe(true);
    expect(
      codeOf(reg.check({ warrant_id: child.warrant_id, tool: "fs.write", now: NOW + 1 })),
    ).toBe("tool_not_covered");
  });

  it("rejects attenuation that widens the tool set", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({ subject: "p", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    expect(() =>
      reg.attenuate({
        parent_warrant_id: parent.warrant_id,
        subject: "greedy",
        grants: [{ tool: "fs.read" }, { tool: "shell.exec" }],
        now: NOW,
        ttl_ms: TTL,
      }),
    ).toThrow(/not covered by parent/);
  });

  it("rejects looser or different arg patterns than the parent's", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({
      subject: "p",
      grants: [{ tool: "http.fetch", arg_constraints: { url: "https://staging.example.com/**" } }],
      now: NOW,
      ttl_ms: TTL,
    });
    const attempt = (pattern: string) => () =>
      reg.attenuate({
        parent_warrant_id: parent.warrant_id,
        subject: "loose",
        grants: [{ tool: "http.fetch", arg_constraints: { url: pattern } }],
        now: NOW,
        ttl_ms: TTL,
      });
    expect(attempt("**")).toThrow(/not equal to or stricter/);
    expect(attempt("https://other.example.com/**")).toThrow(/not equal to or stricter/);
  });

  it("clamps child expiry to the parent's when child ttl runs longer", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({ subject: "p", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: 10_000 });
    const greedy = reg.attenuate({
      parent_warrant_id: parent.warrant_id,
      subject: "greedy",
      grants: [{ tool: "fs.read" }],
      now: NOW + 2_000,
      ttl_ms: 999_999,
    });
    expect(greedy.expires_at_ms).toBe(parent.expires_at_ms);
    const modest = reg.attenuate({
      parent_warrant_id: parent.warrant_id,
      subject: "modest",
      grants: [{ tool: "fs.read" }],
      now: NOW + 2_000,
      ttl_ms: 3_000,
    });
    expect(modest.expires_at_ms).toBe(NOW + 5_000);
  });

  it("caps delegation depth: attenuating past the cap throws", () => {
    const reg = new WarrantRegistry();
    const root = reg.issue({ subject: "gen0", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    let parentId = root.warrant_id;
    for (let depth = 2; depth <= 8; depth += 1) {
      parentId = reg.attenuate({
        parent_warrant_id: parentId,
        subject: `gen${depth - 1}`,
        grants: [{ tool: "fs.read" }],
        now: NOW,
        ttl_ms: TTL,
      }).warrant_id;
    }
    expect(reg.listWarrants()).toHaveLength(8);
    expect(() =>
      reg.attenuate({
        parent_warrant_id: parentId,
        subject: "gen8",
        grants: [{ tool: "fs.read" }],
        now: NOW,
        ttl_ms: TTL,
      }),
    ).toThrow(/maximum depth/);
  });

  it("revoking a parent cascades to its child", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({ subject: "p", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    const child = reg.attenuate({
      parent_warrant_id: parent.warrant_id,
      subject: "c",
      grants: [{ tool: "fs.read" }],
      now: NOW,
      ttl_ms: TTL,
    });
    expect(reg.revoke(parent.warrant_id)).toBe(2);
    expect(codeOf(reg.check({ warrant_id: child.warrant_id, tool: "fs.read", now: NOW + 1 }))).toBe(
      "revoked",
    );
    expect(codeOf(reg.check({ warrant_id: parent.warrant_id, tool: "fs.read", now: NOW + 1 }))).toBe(
      "revoked",
    );
  });

  it("charges budgets down the chain and reports invocations_exhausted", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({
      subject: "p",
      grants: [{ tool: "api.call", max_invocations: 2 }],
      now: NOW,
      ttl_ms: TTL,
    });
    const child = reg.attenuate({
      parent_warrant_id: parent.warrant_id,
      subject: "c",
      grants: [{ tool: "api.call", max_invocations: 2 }],
      now: NOW,
      ttl_ms: TTL,
    });
    const probe = () => reg.check({ warrant_id: child.warrant_id, tool: "api.call", now: NOW + 1 });
    expect(probe().allowed).toBe(true);
    reg.chargeInvocation(child.warrant_id, "api.call");
    expect(probe().allowed).toBe(true);
    reg.chargeInvocation(child.warrant_id, "api.call");
    expect(codeOf(probe())).toBe("invocations_exhausted");
  });

  it("seeded sweep: child allowed implies parent allowed for identical inputs", () => {
    const rand = mulberry32(12345);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
    const chance = (probability: number): boolean => rand() < probability;
    const TOOLS = ["alpha", "beta"];
    const KEYS = ["path", "url"];
    const VALUES = ["v1", "v2", "sub.deep"];
    const PATTERNS = ["*", "**", "v1"];
    let violations = 0;
    for (let iteration = 0; iteration < 150; iteration += 1) {
      const reg = new WarrantRegistry();
      const parentTools = TOOLS.filter(() => chance(0.85));
      if (parentTools.length === 0) parentTools.push(TOOLS[0]!);
      const parentGrants: ToolGrant[] = parentTools.map((tool) => {
        const argConstraints: Record<string, string> = {};
        for (const key of KEYS) if (chance(0.6)) argConstraints[key] = pick(PATTERNS);
        const grant: ToolGrant = { tool };
        if (Object.keys(argConstraints).length > 0) grant.arg_constraints = argConstraints;
        return grant;
      });
      const parent = reg.issue({ subject: "p", grants: parentGrants, now: NOW, ttl_ms: TTL });
      const childTools = parentTools.filter(() => chance(0.75));
      if (childTools.length === 0) childTools.push(parentTools[0]!);
      const childGrants: ToolGrant[] = childTools.map((tool) => {
        const source = parentGrants.find((candidate) => candidate.tool === tool)!;
        const inherited: Record<string, string> = { ...(source.arg_constraints ?? {}) };
        const freeKeys = KEYS.filter((key) => !(key in inherited));
        if (freeKeys.length > 0 && chance(0.35)) inherited[freeKeys[0]!] = pick(PATTERNS);
        const grant: ToolGrant = { tool };
        if (Object.keys(inherited).length > 0) grant.arg_constraints = inherited;
        return grant;
      });
      const child = reg.attenuate({
        parent_warrant_id: parent.warrant_id,
        subject: "c",
        grants: childGrants,
        now: NOW,
        ttl_ms: TTL,
      });
      const args: Record<string, unknown> = {};
      for (const key of KEYS) if (chance(0.7)) args[key] = pick(VALUES);
      const tool = pick(childTools);
      const childDecision = reg.check({ warrant_id: child.warrant_id, tool, args, now: NOW + 1 });
      const parentDecision = reg.check({ warrant_id: parent.warrant_id, tool, args, now: NOW + 1 });
      if (childDecision.allowed && !parentDecision.allowed) violations += 1;
    }
    expect(violations).toBe(0);
  });
});

describe("warrant MCP dispatcher", () => {
  it("issues through the tool surface and lists it", async () => {
    const issued = await dispatchWarrantTool("synthi_warrant_issue", { subject: "ci-bot", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 60_000 });
    expect(issued.isError).toBeFalsy();
    const warrant = JSON.parse(issued.content[0]!.text).warrant;
    expect(warrant.subject).toBe("ci-bot");
    const list = await dispatchWarrantTool("synthi_warrant_list", {});
    const warrants = JSON.parse(list.content[0]!.text).warrants;
    expect(warrants.some((w: { warrant_id: string }) => w.warrant_id === warrant.warrant_id)).toBe(true);
  });

  it("checks a covered call as allowed and an uncovered one as denied", async () => {
    const issued = await dispatchWarrantTool("synthi_warrant_issue", { subject: "s", grants: [{ tool: "synthi_screenshot", arg_constraints: { url: "https://staging.example.com/**" } }], ttl_ms: 60_000 });
    const warrant = JSON.parse(issued.content[0]!.text).warrant;
    const allowed = await dispatchWarrantTool("synthi_warrant_check", { warrant_id: warrant.warrant_id, tool: "synthi_screenshot", args: { url: "https://staging.example.com/x" } });
    expect(JSON.parse(allowed.content[0]!.text).allowed).toBe(true);
    const denied = await dispatchWarrantTool("synthi_warrant_check", { warrant_id: warrant.warrant_id, tool: "synthi_compile" });
    const deniedBody = JSON.parse(denied.content[0]!.text);
    expect(deniedBody.allowed).toBe(false);
    expect(deniedBody.reason_code).toBe("tool_not_covered");
  });

  it("revokes through the tool surface and the cascade is visible in check", async () => {
    const parent = JSON.parse((await dispatchWarrantTool("synthi_warrant_issue", { subject: "p", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 60_000 })).content[0]!.text).warrant;
    const child = JSON.parse((await dispatchWarrantTool("synthi_warrant_attenuate", { parent_warrant_id: parent.warrant_id, subject: "c", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 30_000 })).content[0]!.text).warrant;
    const revoked = await dispatchWarrantTool("synthi_warrant_revoke", { warrant_id: parent.warrant_id });
    expect(JSON.parse(revoked.content[0]!.text).revoked_count).toBe(2);
    const after = JSON.parse((await dispatchWarrantTool("synthi_warrant_check", { warrant_id: child.warrant_id, tool: "synthi_screenshot" })).content[0]!.text);
    expect(after.allowed).toBe(false);
    expect(after.reason_code).toBe("revoked");
  });

  it("surfaces validation failures as isError with a human reason", async () => {
    const bad = await dispatchWarrantTool("synthi_warrant_issue", { ttl_ms: 60_000 });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0]!.text).human_reason).toBeTruthy();
  });
});

describe("warrant enforcement gate", () => {
  const ORIGINAL_MODE = process.env["SYNTHI_WARRANT_MODE"];

  beforeEach(() => {
    process.env["SYNTHI_WARRANT_MODE"] = "enforce";
  });

  afterAll(() => {
    if (ORIGINAL_MODE === undefined) delete process.env["SYNTHI_WARRANT_MODE"];
    else process.env["SYNTHI_WARRANT_MODE"] = ORIGINAL_MODE;
  });

  it("keeps warrant management tools callable in enforce mode (bootstrap)", () => {
    expect(enforceWarrantGate("synthi_warrant_issue", { arguments: {} })).toBeNull();
    expect(enforceWarrantGate("synthi_warrant_list", { arguments: {} })).toBeNull();
  });

  it("rejects non-warrant tools without _meta.warrant_id in enforce mode", () => {
    const err = enforceWarrantGate("synthi_screenshot", { arguments: {} });
    expect(err).not.toBeNull();
    expect(err?.error ?? "").toBeTruthy();
  });

  it("is inert when mode is off", () => {
    process.env["SYNTHI_WARRANT_MODE"] = "off";
    expect(enforceWarrantGate("synthi_screenshot", { arguments: {} })).toBeNull();
    expect(resolveWarrantMode()).toBe("off");
  });
});
