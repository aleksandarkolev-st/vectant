// Unit tests for src/security/warrant.ts (WI_WARRANTS_SPEC, Patch A).
// Covers issue/check decisions, attenuation narrowing, expiry clamping,
// revocation cascade, budgets, depth cap, and a seeded randomized sweep.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolGrant } from "../../src/security/warrant.js";
import { WarrantRegistry, globMatch } from "../../src/security/warrant.js";
import { TrustLedger } from "../../src/security/trust.js";
import {
  __resetWarrantRegistryForTests,
  dispatchWarrantTool,
  enforceWarrantGate,
  resolveOrgCeilings,
  resolveWarrantAdminKey,
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

describe("warrant admin gate and org ceilings", () => {
  const ORIGINALS = { mode: process.env["SYNTHI_WARRANT_MODE"], key: process.env["SYNTHI_WARRANT_ADMIN_KEY"], active: process.env["SYNTHI_WARRANT_MAX_ACTIVE"], ttl: process.env["SYNTHI_WARRANT_MAX_TTL_MS"] };

  beforeEach(() => {
    __resetWarrantRegistryForTests();
    process.env["SYNTHI_WARRANT_MODE"] = "enforce";
    delete process.env["SYNTHI_WARRANT_ADMIN_KEY"];
    delete process.env["SYNTHI_WARRANT_MAX_ACTIVE"];
    delete process.env["SYNTHI_WARRANT_MAX_TTL_MS"];
  });

  afterAll(() => {
    process.env["SYNTHI_WARRANT_MODE"] = ORIGINALS.mode;
    if (ORIGINALS.key === undefined) delete process.env["SYNTHI_WARRANT_ADMIN_KEY"]; else process.env["SYNTHI_WARRANT_ADMIN_KEY"] = ORIGINALS.key;
    if (ORIGINALS.active === undefined) delete process.env["SYNTHI_WARRANT_MAX_ACTIVE"]; else process.env["SYNTHI_WARRANT_MAX_ACTIVE"] = ORIGINALS.active;
    if (ORIGINALS.ttl === undefined) delete process.env["SYNTHI_WARRANT_MAX_TTL_MS"]; else process.env["SYNTHI_WARRANT_MAX_TTL_MS"] = ORIGINALS.ttl;
  });

  it("leaves the management plane open when no admin key is configured", () => {
    expect(enforceWarrantGate("synthi_warrant_issue", { arguments: {} })).toBeNull();
    expect(resolveWarrantAdminKey()).toBeNull();
  });

  it("requires the admin key for management tools once configured", () => {
    process.env["SYNTHI_WARRANT_ADMIN_KEY"] = "sekrit";
    const missing = enforceWarrantGate("synthi_warrant_issue", { arguments: {} });
    expect(missing?.error ?? missing?.code).toBe("warrant_admin_required");
    const wrong = enforceWarrantGate("synthi_warrant_issue", { arguments: {}, _meta: { warrant_admin_key: "wrong" } });
    expect(wrong?.error ?? wrong?.code).toBe("warrant_admin_required");
    const right = enforceWarrantGate("synthi_warrant_issue", { arguments: {}, _meta: { warrant_admin_key: "sekrit" } });
    expect(right).toBeNull();
  });

  it("still gates ordinary tools even when the admin key is presented", () => {
    process.env["SYNTHI_WARRANT_ADMIN_KEY"] = "sekrit";
    const r = enforceWarrantGate("synthi_screenshot", { arguments: {}, _meta: { warrant_admin_key: "sekrit" } });
    expect(r?.error ?? r?.code).toBe("warrant_required");
  });

  it("parses org ceilings from env with sane defaults", () => {
    const defaults = resolveOrgCeilings();
    expect(defaults.max_active).toBeGreaterThan(0);
    expect(defaults.max_ttl_ms).toBeGreaterThan(0);
    process.env["SYNTHI_WARRANT_MAX_ACTIVE"] = "1";
    process.env["SYNTHI_WARRANT_MAX_TTL_MS"] = "5000";
    expect(resolveOrgCeilings()).toEqual({ max_active: 1, max_ttl_ms: 5000 });
  });

  it("enforces the active-warrant ceiling through the dispatcher", async () => {
    process.env["SYNTHI_WARRANT_MAX_ACTIVE"] = "2";
    const first = await dispatchWarrantTool("synthi_warrant_issue", { subject: "one", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 60_000 });
    expect(first.isError).toBeFalsy();
    const second = await dispatchWarrantTool("synthi_warrant_issue", { subject: "two", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 60_000 });
    expect(second.isError).toBeFalsy();
    const third = await dispatchWarrantTool("synthi_warrant_issue", { subject: "three", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 60_000 });
    expect(third.isError).toBe(true);
    const body = JSON.parse(third.content[0]!.text);
    expect(body.error).toBe("warrant_ceiling_reached");
  });

  it("clamps oversized ttl to the organization maximum", async () => {
    process.env["SYNTHI_WARRANT_MAX_TTL_MS"] = "5000";
    const issued = await dispatchWarrantTool("synthi_warrant_issue", { subject: "greedy-ttl", grants: [{ tool: "synthi_screenshot" }], ttl_ms: 99_999_999 });
    const warrant = JSON.parse(issued.content[0]!.text).warrant;
    expect(warrant.expires_at_ms - warrant.issued_at_ms).toBeLessThanOrEqual(5000);
  });
});

describe("sealed warrants (proof-of-possession)", () => {
  it("issues sealed, discloses the bearer once, and requires it on every check", () => {
    const reg = new WarrantRegistry();
    const issued = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL, seal: true });
    expect(issued.sealed).toBe(true);
    expect(issued.bearer).toMatch(/^wb_[0-9a-f]{32}$/);
    const missing = reg.check({ warrant_id: issued.warrant_id, tool: "fs.read", now: NOW + 1 });
    expect(codeOf(missing)).toBe("bearer_mismatch");
    const wrong = reg.check({ warrant_id: issued.warrant_id, tool: "fs.read", bearer: "wb_" + "0".repeat(32), now: NOW + 1 });
    expect(codeOf(wrong)).toBe("bearer_mismatch");
    const good = reg.check({ warrant_id: issued.warrant_id, tool: "fs.read", bearer: issued.bearer!, now: NOW + 1 });
    expect(good.allowed).toBe(true);
  });

  it("keeps unsealed warrants working exactly as before", () => {
    const reg = new WarrantRegistry();
    const plain = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL });
    expect(plain.sealed).toBeUndefined();
    expect(plain.bearer).toBeUndefined();
    expect(reg.check({ warrant_id: plain.warrant_id, tool: "fs.read", now: NOW + 1 }).allowed).toBe(true);
  });

  it("never discloses secrets through audit views", () => {
    const reg = new WarrantRegistry();
    const issued = reg.issue({ subject: "s", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL, seal: true });
    const listed = reg.listWarrants().find((w) => w.warrant_id === issued.warrant_id)!;
    expect(listed.sealed).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(issued.bearer!);
  });

  it("seals attenuated children of sealed parents with a fresh bearer", () => {
    const reg = new WarrantRegistry();
    const parent = reg.issue({ subject: "p", grants: [{ tool: "fs.read" }], now: NOW, ttl_ms: TTL, seal: true });
    const child = reg.attenuate({ parent_warrant_id: parent.warrant_id, subject: "c", grants: [{ tool: "fs.read" }], now: NOW });
    expect(child.sealed).toBe(true);
    expect(child.bearer).toBeTruthy();
    expect(child.bearer).not.toBe(parent.bearer);
    expect(reg.check({ warrant_id: child.warrant_id, tool: "fs.read", bearer: child.bearer!, now: NOW + 1 }).allowed).toBe(true);
    expect(reg.check({ warrant_id: child.warrant_id, tool: "fs.read", bearer: parent.bearer!, now: NOW + 1 })).toEqual(
      expect.objectContaining({ allowed: false }));
  });
});

describe("separated trust progression (TrustLedger)", () => {
  const STEPS = [
    { unlock_after: { min_sample: 5, success_ratio: 0.9 }, grants: [{ tool: "synthi_describe" }] },
    { unlock_after: { min_sample: 8, success_ratio: 0.95 }, grants: [{ tool: "synthi_get_event_log" }] },
  ];
  function setup() {
    const reg = new WarrantRegistry();
    const ledger = new TrustLedger();
    const w = reg.issue({ subject: "agent", grants: [{ tool: "synthi_screenshot" }], now: NOW, ttl_ms: TTL });
    ledger.registerPolicy({ policy_id: "std", steps: STEPS });
    return { reg, ledger, id: w.warrant_id };
  }

  it("registers policies with validation", () => {
    const { ledger } = setup();
    expect(() => ledger.registerPolicy({ policy_id: "bad", steps: [{ unlock_after: { min_sample: 2, success_ratio: 0.9 }, grants: [] }] })).toThrow(/at least/i);
    expect(() => ledger.registerPolicy({ policy_id: "bad", steps: Array.from({ length: 5 }, () => ({ unlock_after: { min_sample: 9, success_ratio: 0.9 }, grants: [{ tool: "t" }] })) })).toThrow(/depth/i);
    expect(() => ledger.registerPolicy({ policy_id: "bad", steps: [{ unlock_after: { min_sample: 9, success_ratio: 1.5 }, grants: [{ tool: "t" }] }] })).toThrow(/ratio/i);
    expect(() => ledger.registerPolicy({ policy_id: "std", steps: STEPS })).toThrow(/already registered/i);
  });

  it("unlocks rungs from recorded evidence while the warrant itself stays pure", () => {
    const { reg, ledger, id } = setup();
    ledger.bind(id, "std");
    for (let i = 0; i < 5; i += 1) {
      expect(reg.check({ warrant_id: id, tool: "synthi_screenshot", now: NOW + 1 }).allowed).toBe(true);
      ledger.record(id, { allowed: true }, NOW + 1);
    }
    // Pure registry: base authority is static, so the ladder tool is NOT admitted by the warrant alone...
    expect(reg.check({ warrant_id: id, tool: "synthi_describe", now: NOW + 2 }).allowed).toBe(false);
    // ...admitting it takes composing the warrant with its bound ledger.
    const warrant = reg.listWarrants()[0]!;
    expect(ledger.effectiveGrantsFor(warrant, id, NOW + 2).some((g) => g.tool === "synthi_describe")).toBe(true);
    const v = ledger.view(id, NOW + 2)!;
    expect(v.current_rung).toBe(1);
    expect(v.unlocked_grants.some((g) => g.tool === "synthi_describe")).toBe(true);
    expect(v.next_step?.checks_remaining).toBe(3);
  });

  it("demotes on probe evidence and cools down to base only", () => {
    const { reg, ledger, id } = setup();
    ledger.bind(id, "std");
    for (let i = 0; i < 5; i += 1) ledger.record(id, { allowed: true }, NOW + 1);
    for (let i = 0; i < 3; i += 1) ledger.record(id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 2);
    const v = ledger.view(id, NOW + 3)!;
    expect(v.demoted_rungs).toBe(1);
    expect(v.cooldown_active).toBe(true);
    const warrant = reg.listWarrants()[0]!;
    expect(ledger.effectiveGrantsFor(warrant, id, NOW + 3).some((g) => g.tool === "synthi_describe")).toBe(false);
  });

  it("blocks rebinding during cooldown and resets counters on policy change", () => {
    const { ledger, id } = setup();
    ledger.registerPolicy({ policy_id: "alt", steps: [{ unlock_after: { min_sample: 5, success_ratio: 0.9 }, grants: [{ tool: "synthi_locate" }] }] });
    ledger.bind(id, "std");
    for (let i = 0; i < 5; i += 1) ledger.record(id, { allowed: true }, NOW + 1);
    for (let i = 0; i < 3; i += 1) ledger.record(id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 2);
    expect(() => ledger.bind(id, "alt", NOW + 3)).toThrow(/cooldown/i);
    const after = ledger.view(id, NOW + 61_002)!;
    expect(after.cooldown_active).toBe(false);
    ledger.bind(id, "alt", NOW + 61_002);
    expect(ledger.view(id, NOW + 61_003)?.current_rung ?? 0).toBeLessThan(1);
  });

  it("unbind restores full base authority and clears progression state", () => {
    const { reg, ledger, id } = setup();
    ledger.bind(id, "std");
    for (let i = 0; i < 5; i += 1) ledger.record(id, { allowed: true }, NOW + 1);
    const warrant = reg.listWarrants()[0]!;
    ledger.unbind(id);
    expect(ledger.view(id, NOW + 2)).toBeNull();
    expect(ledger.effectiveGrantsFor(warrant, id, NOW + 2).map((g) => g.tool)).toEqual(["synthi_screenshot"]);
  });
});

describe("Patch G red-team hardening", () => {
  const STEPS = [{ unlock_after: { min_sample: 5, success_ratio: 0.9 }, grants: [{ tool: "synthi_describe" }] }];

  function sealedSetup() {
    const reg = new WarrantRegistry();
    const ledger = new TrustLedger();
    const w = reg.issue({ subject: "s", grants: [{ tool: "synthi_screenshot" }], now: NOW, ttl_ms: TTL, seal: true });
    ledger.registerPolicy({ policy_id: "std", steps: STEPS });
    return { reg, ledger, id: w.warrant_id, bearer: w.bearer! };
  }

  it("lifecycle outranks trust: revoked-but-bound stays denied by the pure registry", () => {
    const { reg, ledger, id, bearer } = sealedSetup();
    ledger.bind(id, "std", NOW);
    for (let i = 0; i < 5; i += 1) {
      expect(reg.check({ warrant_id: id, tool: "synthi_screenshot", bearer, now: NOW + 1 }).allowed).toBe(true);
      ledger.record(id, { allowed: true }, NOW + 1);
    }
    reg.revoke(id);
    const d = reg.check({ warrant_id: id, tool: "synthi_screenshot", bearer, now: NOW + 2 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason_code).toBe("revoked");
  });

  it("registerPolicy rejects empty ladders and non-finite min_sample and cross-rung duplicate tools", () => {
    const ledger = new TrustLedger();
    expect(() => ledger.registerPolicy({ policy_id: "e1", steps: [] })).toThrow(/empty/i);
    expect(() =>
      ledger.registerPolicy({
        policy_id: "e2",
        steps: [{ unlock_after: { min_sample: Number.NaN, success_ratio: 0.9 }, grants: [{ tool: "t" }] }],
      }),
    ).toThrow(/finite|at least/i);
    expect(() =>
      ledger.registerPolicy({
        policy_id: "e3",
        steps: [
          { unlock_after: { min_sample: 9, success_ratio: 0.9 }, grants: [{ tool: "t" }] },
          { unlock_after: { min_sample: 12, success_ratio: 0.9 }, grants: [{ tool: "t" }] },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  it("registered policies are deeply frozen", () => {
    const ledger = new TrustLedger();
    const p = ledger.registerPolicy({ policy_id: "frozen", steps: STEPS });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.steps[0]!)).toBe(true);
  });
});

describe("Patch H - taint inheritance and escalating cooldowns", () => {
  // Two rungs: record() still caps demoted_rungs at the policy's depth
  // (pre-H semantics), so observing the second demotion / doubled cooldown
  // requires a ladder deeper than one rung.
  function setup() {
    const reg = new WarrantRegistry();
    const ledger = new TrustLedger();
    ledger.registerPolicy({
      policy_id: "std",
      steps: [
        { unlock_after: { min_sample: 5, success_ratio: 0.9 }, grants: [{ tool: "synthi_describe" }] },
        { unlock_after: { min_sample: 8, success_ratio: 0.9 }, grants: [{ tool: "synthi_locate" }] },
      ],
    });
    return { reg, ledger };
  }

  it("demotion taints the subject and inherited taint applies to future bindings", () => {
    const { reg, ledger } = setup();
    const w1 = reg.issue({ subject: "repeat-offender", grants: [{ tool: "synthi_screenshot" }], now: NOW, ttl_ms: TTL });
    ledger.bind(w1.warrant_id, "std", NOW);
    for (let i = 0; i < 5; i += 1) ledger.record(w1.warrant_id, { allowed: true }, NOW + 1, "repeat-offender");
    for (let i = 0; i < 3; i += 1) ledger.record(w1.warrant_id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 2, "repeat-offender");
    expect(ledger.viewTaint("repeat-offender")).toBeGreaterThanOrEqual(1);
    const w2 = reg.issue({ subject: "repeat-offender", grants: [{ tool: "synthi_screenshot" }], now: NOW + 10_000, ttl_ms: TTL });
    ledger.bind(w2.warrant_id, "std", NOW + 10_000);
    ledger.applyInheritedTaint(w2.warrant_id, "repeat-offender");
    expect(ledger.view(w2.warrant_id, NOW + 10_001)?.current_rung ?? 0).toBe(0);
  });

  it("cooldown doubles with each subsequent demotion", () => {
    const { ledger } = setup();
    const reg = new WarrantRegistry();
    const w = reg.issue({ subject: "escalator", grants: [{ tool: "synthi_screenshot" }], now: NOW, ttl_ms: TTL });
    ledger.bind(w.warrant_id, "std", NOW);
    for (let i = 0; i < 5; i += 1) ledger.record(w.warrant_id, { allowed: true }, NOW + 1, "escalator");
    ledger.record(w.warrant_id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 2, "escalator");
    ledger.record(w.warrant_id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 3, "escalator");
    ledger.record(w.warrant_id, { allowed: false, reason_code: "tool_not_covered" }, NOW + 4, "escalator");
    const first = ledger.view(w.warrant_id, NOW + 5)!;
    expect(first.cooldown_active).toBe(true);
    const afterFirstWindow = ledger.view(w.warrant_id, NOW + 5 + 60_000)!;
    expect(afterFirstWindow.cooldown_active).toBe(false);
    for (let i = 0; i < 3; i += 1) ledger.record(w.warrant_id, { allowed: false, reason_code: "arg_out_of_scope" }, NOW + 6 + 61_000, "escalator");
    const second = ledger.view(w.warrant_id, NOW + 7 + 61_000)!;
    expect(second.demoted_rungs).toBe(2);
    expect(ledger.view(w.warrant_id, NOW + 8 + 61_000 + 60_000)!.cooldown_active).toBe(true);
    expect(ledger.view(w.warrant_id, NOW + 8 + 61_000 + 120_000 + 1)!.cooldown_active).toBe(false);
  });
});
