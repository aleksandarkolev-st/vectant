/**
 * Realm consent records: the universal generalization of exact-origin
 * browser consent.
 *
 * Semantics carried over from the browser broker, unchanged:
 * - approval is EXACT realm identity; it never crosses components
 *   (no prefix/suffix/subdomain/parent matching, ever)
 * - capabilities are independent: observe-consent implies nothing about
 *   record- or act-consent
 * - revocation is recorded and takes effect immediately at evaluation time
 *
 * Pure module: no IO, no clock reads. Time is injected so decisions are
 * deterministic and testable.
 */

import type { RealmRef } from "./event.js";

export type ConsentStatus = "granted" | "denied" | "unset";

/** Capability tiers a realm consent record can gate independently. */
export type ConsentCapability = "observe" | "record" | "act";

export const CONSENT_CAPABILITIES: readonly ConsentCapability[] = [
  "observe",
  "record",
  "act",
];

export interface RealmConsentGrant {
  status: Exclude<ConsentStatus, "unset">;
  at: number;
  reason?: string;
}

export interface CapabilityConsent {
  status: ConsentStatus;
  granted_at?: number;
  denied_at?: number;
  revoked_at?: number;
  reason?: string;
}

/**
 * One record per (realm, subject). The subject distinguishes who holds the
 * consent (agent id, workspace id); the core treats it as opaque.
 */
export interface RealmConsentRecord {
  realm: RealmRef;
  subject: string;
  capabilities: Partial<Record<ConsentCapability, CapabilityConsent>>;
}

export function emptyRealmConsentRecord(
  realm: RealmRef,
  subject: string,
): RealmConsentRecord {
  return { realm, subject, capabilities: {} };
}

// ---------------------------------------------------------------------------
// Exact-realm identity
// ---------------------------------------------------------------------------

/**
 * Exact equality on both coordinates. Deliberately naive: every component of
 * a realm id must match byte-for-byte. Any smarter matching (subdomains,
 * path prefixes, world-name wildcards) is forbidden here by design — if a
 * substrate ever needs grouped realms, that is a new explicit realm kind,
 * never looser matching inside one.
 */
export function sameRealm(a: RealmRef, b: RealmRef): boolean {
  return a.realm_kind === b.realm_kind && a.realm_id === b.realm_id;
}

// ---------------------------------------------------------------------------
// Grant / deny / revoke (pure state transitions)
// ---------------------------------------------------------------------------

export function grantRealmCapability(
  record: RealmConsentRecord,
  capability: ConsentCapability,
  now: number,
  reason?: string,
): RealmConsentRecord {
  const current = record.capabilities[capability] ?? {};
  return {
    ...record,
    capabilities: {
      ...record.capabilities,
      [capability]: {
        ...current,
        status: "granted",
        granted_at: now,
        denied_at: undefined,
        revoked_at: undefined,
        ...(reason !== undefined ? { reason } : {}),
      },
    },
  };
}

export function denyRealmCapability(
  record: RealmConsentRecord,
  capability: ConsentCapability,
  now: number,
  reason?: string,
): RealmConsentRecord {
  const current = record.capabilities[capability] ?? {};
  return {
    ...record,
    capabilities: {
      ...record.capabilities,
      [capability]: {
        ...current,
        status: "denied",
        denied_at: now,
        granted_at: undefined,
        ...(reason !== undefined ? { reason } : {}),
      },
    },
  };
}

export function revokeRealmCapability(
  record: RealmConsentRecord,
  capability: ConsentCapability,
  now: number,
  reason?: string,
): RealmConsentRecord {
  const current = record.capabilities[capability];
  if (!current) return record;
  return {
    ...record,
    capabilities: {
      ...record.capabilities,
      [capability]: {
        ...current,
        status: "unset",
        revoked_at: now,
        granted_at: undefined,
        denied_at: undefined,
        ...(reason !== undefined ? { reason } : {}),
      },
    },
  };
}

/** Revoke everything at once (the `synthi_browser_revoke_all` analogue). */
export function revokeAllRealmCapabilities(
  record: RealmConsentRecord,
  now: number,
): RealmConsentRecord {
  const capabilities: RealmConsentRecord["capabilities"] = {};
  for (const capability of CONSENT_CAPABILITIES) {
    const current = record.capabilities[capability];
    if (!current) continue;
    capabilities[capability] = {
      ...current,
      status: "unset",
      revoked_at: now,
      granted_at: undefined,
      denied_at: undefined,
    };
  }
  return { ...record, capabilities };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export type ConsentDecision =
  | { allowed: true }
  | { allowed: false; because: "denied" | "unset" };

/**
 * The single decision function adapters call before any capability use.
 * Fail-closed: anything not explicitly granted is denied with a structured
 * reason, mirroring "denied origins produce no bytes".
 */
export function evaluateRealmConsent(
  record: RealmConsentRecord | undefined,
  requestedRealm: RealmRef,
  capability: ConsentCapability,
): ConsentDecision {
  if (!record) return { allowed: false, because: "unset" };
  if (!sameRealm(record.realm, requestedRealm)) {
    // A record for another realm says nothing about this one: fail closed.
    return { allowed: false, because: "unset" };
  }
  const entry = record.capabilities[capability];
  if (!entry) return { allowed: false, because: "unset" };
  if (entry.status === "granted") return { allowed: true };
  if (entry.status === "denied") return { allowed: false, because: "denied" };
  return { allowed: false, because: "unset" };
}

// ---------------------------------------------------------------------------
// Browser conversion (pure; mirrors event.ts losslessness discipline)
// ---------------------------------------------------------------------------

/**
 * Legacy browser consent shape (structural mirror of the adapter's
 * BrowserConsentRecord — never imported). Screenshot and diagnostics map to
 * the observe capability's sub-channels; the origin becomes an
 * exact-origin realm.
 */
export interface BrowserConsentShape {
  origin: string;
  status: ConsentStatus;
  screenshot: ConsentStatus;
  diagnostics: ConsentStatus;
  granted_at?: number;
  denied_at?: number;
  revoked_at?: number;
  reason?: string;
}

export const ORIGIN_REALM_KIND = "origin";

export function browserConsentToRealmRecord(
  consent: BrowserConsentShape,
  subject: string,
): RealmConsentRecord {
  const observe: CapabilityConsent = {
    status: consent.screenshot === "granted" || consent.diagnostics === "granted"
      ? "granted"
      : consent.screenshot === "denied" || consent.diagnostics === "denied"
        ? "denied"
        : consent.status,
    ...(consent.granted_at !== undefined ? { granted_at: consent.granted_at } : {}),
    ...(consent.denied_at !== undefined ? { denied_at: consent.denied_at } : {}),
    ...(consent.revoked_at !== undefined ? { revoked_at: consent.revoked_at } : {}),
    ...(consent.reason !== undefined ? { reason: consent.reason } : {}),
  };
  return {
    realm: { realm_kind: ORIGIN_REALM_KIND, realm_id: consent.origin },
    subject,
    capabilities: { observe },
  };
}
