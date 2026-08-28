/**
 * Provider-neutral persistence boundary for warrant enforcement.  The
 * registry is useful for local development; a production host supplies this
 * port so every replica asks one transactional authority to decide, reserve,
 * and settle a call.
 */
import type {
  DelegationPolicy,
  IssuedWarrant,
  ToolGrant,
  Warrant,
  WarrantDecision,
} from "./warrant.js";
import type { WarrantPrincipal } from "./warrant_principal.js";

export interface WarrantAuthorityReservation {
  receipt_id: string;
  status: "reserved" | "succeeded" | "failed" | "unknown";
  /** Present when the authority can expose the durable reservation timestamp. */
  reserved_at_ms?: number;
}

export interface WarrantAuthority {
  issue(input: {
    subject: string;
    audience: WarrantPrincipal;
    grants: readonly ToolGrant[];
    ttl_ms: number;
    seal?: boolean;
    delegation?: DelegationPolicy;
  }): Promise<IssuedWarrant>;
  attenuate(input: {
    parent_warrant_id: string;
    subject: string;
    audience?: WarrantPrincipal;
    grants: readonly ToolGrant[];
    ttl_ms?: number;
    seal?: boolean;
    bearer?: string;
  }): Promise<IssuedWarrant>;
  check(input: {
    warrant_id: string;
    tool: string;
    args?: Readonly<Record<string, unknown>>;
    bearer?: string;
  }): Promise<WarrantDecision>;
  list(): Promise<readonly Warrant[]>;
  revoke(warrantId: string): Promise<number>;
  renew(input: {
    warrant_id: string;
    bearer?: string;
    ttl_ms: number;
    add_invocations?: Record<string, number>;
  }): Promise<Warrant>;
  reserve(input: {
    warrant_id: string;
    tool: string;
    args?: Readonly<Record<string, unknown>>;
    bearer?: string;
    idempotency_key: string;
  }): Promise<{ decision: WarrantDecision; reservation?: WarrantAuthorityReservation }>;
  settle(input: {
    receipt_id: string;
    outcome: "succeeded" | "failed" | "unknown";
    failure_code?: string;
  }): Promise<WarrantAuthorityReservation>;
}
