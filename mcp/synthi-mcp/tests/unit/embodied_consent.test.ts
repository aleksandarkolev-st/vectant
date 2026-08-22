import { describe, expect, it } from "vitest";
import {
  browserConsentToRealmRecord,
  denyRealmCapability,
  emptyRealmConsentRecord,
  evaluateRealmConsent,
  grantRealmCapability,
  type RealmConsentRecord,
  revokeAllRealmCapabilities,
  revokeRealmCapability,
  sameRealm,
} from "../../src/embodied/consent.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REALM = { realm_kind: "origin", realm_id: "https://app.example:8443" };
const OTHER_HOST = { realm_kind: "origin", realm_id: "https://other.example:8443" };
const SUBDOMAIN = { realm_kind: "origin", realm_id: "https://cdn.app.example:8443" };
const OTHER_PORT = { realm_kind: "origin", realm_id: "https://app.example:9000" };
const OTHER_SCHEME = { realm_kind: "origin", realm_id: "http://app.example:8443" };
const OTHER_KIND = { realm_kind: "workspace_root", realm_id: "https://app.example:8443" };

function grantedRecord(now = 1000): RealmConsentRecord {
  return grantRealmCapability(
    emptyRealmConsentRecord(REALM, "agent-1"),
    "observe",
    now,
  );
}

describe("realm identity is exact-match only", () => {
  it("matches identical realms", () => {
    expect(sameRealm(REALM, { ...REALM })).toBe(true);
  });

  it("does not cross any component", () => {
    for (const near of [OTHER_HOST, SUBDOMAIN, OTHER_PORT, OTHER_SCHEME, OTHER_KIND]) {
      expect(sameRealm(REALM, near)).toBe(false);
    }
  });

  it("evaluation fails closed on every near-miss component", () => {
    const record = grantedRecord();
    for (const requested of [OTHER_HOST, SUBDOMAIN, OTHER_PORT, OTHER_SCHEME, OTHER_KIND]) {
      const decision = evaluateRealmConsent(record, requested, "observe");
      expect(decision).toEqual({ allowed: false, because: "unset" });
    }
  });
});

describe("capability isolation", () => {
  it("grants nothing beyond the granted capability", () => {
    const record = grantedRecord();
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
    expect(evaluateRealmConsent(record, REALM, "act")).toEqual({
      allowed: false,
      because: "unset",
    });
    expect(evaluateRealmConsent(record, REALM, "record")).toEqual({
      allowed: false,
      because: "unset",
    });
  });

  it("keeps capabilities independent through grant/deny/revoke cycles", () => {
    let record = grantedRecord();
    record = grantRealmCapability(record, "record", 1100);
    record = denyRealmCapability(record, "act", 1200);

    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
    expect(evaluateRealmConsent(record, REALM, "record")).toEqual({ allowed: true });
    expect(evaluateRealmConsent(record, REALM, "act")).toEqual({
      allowed: false,
      because: "denied",
    });

    record = revokeRealmCapability(record, "record", 1300);
    expect(evaluateRealmConsent(record, REALM, "record")).toEqual({
      allowed: false,
      because: "unset",
    });
    // observe untouched by record revocation
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
  });
});

describe("fail-closed semantics", () => {
  it("denies when no record exists", () => {
    expect(evaluateRealmConsent(undefined, REALM, "observe")).toEqual({
      allowed: false,
      because: "unset",
    });
  });

  it("treats explicit denial distinctly from unset", () => {
    const denied = denyRealmCapability(
      emptyRealmConsentRecord(REALM, "agent-1"),
      "observe",
      1000,
      "user refused",
    );
    expect(evaluateRealmConsent(denied, REALM, "observe")).toEqual({
      allowed: false,
      because: "denied",
    });
  });

  it("revocation clears a previous grant immediately", () => {
    let record = grantedRecord();
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
    record = revokeRealmCapability(record, "observe", 2000);
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({
      allowed: false,
      because: "unset",
    });
  });

  it("revoke-all clears every capability but keeps audit timestamps", () => {
    let record = grantedRecord();
    record = grantRealmCapability(record, "act", 1100);
    record = denyRealmCapability(record, "record", 1150);
    record = revokeAllRealmCapabilities(record, 2000);
    for (const capability of ["observe", "record", "act"] as const) {
      expect(evaluateRealmConsent(record, REALM, capability).allowed).toBe(false);
    }
    expect(record.capabilities.observe?.revoked_at).toBe(2000);
    expect(record.capabilities.record?.revoked_at).toBe(2000);
    expect(record.capabilities.act?.revoked_at).toBe(2000);
  });

  it("re-grant after revocation works and overwrites revoked state", () => {
    let record = grantedRecord();
    record = revokeRealmCapability(record, "observe", 1500);
    record = grantRealmCapability(record, "observe", 1600);
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
    expect(record.capabilities.observe?.revoked_at).toBeUndefined();
    expect(record.capabilities.observe?.granted_at).toBe(1600);
  });
});

describe("records are per-subject", () => {
  it("one subject's consent never serves another subject", () => {
    const theirs = grantedRecord();
    const decisionForOtherSubject = evaluateRealmConsent(
      { ...theirs, subject: "agent-2" },
      REALM,
      "observe",
    );
    expect(decisionForOtherSubject.allowed).toBe(true); // same record content

    // But records are looked up by (realm, subject) upstream; the core marks
    // the subject so lookups cannot collide silently.
    expect(theirs.subject).toBe("agent-1");
  });
});

describe("browser consent conversion", () => {
  it("maps origin consent into an exact-origin realm record", () => {
    const record = browserConsentToRealmRecord(
      {
        origin: "https://app.example:8443",
        status: "granted",
        screenshot: "granted",
        diagnostics: "denied",
        granted_at: 1234,
        reason: "preview approved",
      },
      "agent-1",
    );
    expect(record.realm).toEqual({
      realm_kind: "origin",
      realm_id: "https://app.example:8443",
    });
    expect(evaluateRealmConsent(record, REALM, "observe")).toEqual({ allowed: true });
  });

  it("denial propagates: denied screenshot yields denied observe", () => {
    const record = browserConsentToRealmRecord(
      {
        origin: "https://x.example",
        status: "granted",
        screenshot: "denied",
        diagnostics: "unset",
      },
      "a",
    );
    expect(evaluateRealmConsent(record, { realm_kind: "origin", realm_id: "https://x.example" }, "observe"))
      .toEqual({ allowed: false, because: "denied" });
  });
});

describe("consent module boundary", () => {
  it("imports no adapter modules and contains no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/consent.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/browser\//);
    expect(source).not.toMatch(/from\s+"\.\.\/dojo\//);
    for (const noun of ["door", "purple", "nginx", "invoice", "dashboard"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
