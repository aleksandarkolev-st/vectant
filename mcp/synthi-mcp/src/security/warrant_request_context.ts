import { AsyncLocalStorage } from "node:async_hooks";
import type { WarrantPrincipal } from "./warrant_principal.js";
import type { WarrantAuthority } from "./warrant_authority.js";

/**
 * A host-resolved capability request for one exact resource read.  The MCP
 * warrant core neither classifies URIs nor chooses capability names: that is
 * application policy and must be supplied by the authenticated host.
 */
export interface WarrantResourceGrant {
  capability: string;
  args?: Readonly<Record<string, unknown>>;
}

/** A provider can use this stable error shape without coupling to HTTP or a particular identity system. */
export class WarrantRequestContextError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode = 403) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface WarrantRequestContext {
  /** Authenticated by the MCP host's trusted integration. */
  principal?: WarrantPrincipal;
  /** Production hosts require every usable warrant to bind a recipient. */
  audienceRequired?: boolean;
  /** Canonicalizes a requested audience at issuance. Never accepts it as proof. */
  verifyAudience?: (requested: WarrantPrincipal) => Promise<WarrantPrincipal>;
  /** Shared transactional authority selected by an authenticated production host. */
  authority?: WarrantAuthority;
  /**
   * Resolves an exact read into the host's ordinary capability vocabulary.
   * It receives the unmodified requested URI and must never use caller input
   * as proof of a grant.
   */
  resolveResourceGrant?: (uri: string) => Promise<WarrantResourceGrant> | WarrantResourceGrant;
}

const requestContext = new AsyncLocalStorage<WarrantRequestContext>();

export function runWithWarrantRequestContext<T>(
  context: WarrantRequestContext,
  operation: () => T,
): T {
  return requestContext.run(context, operation);
}

export function currentWarrantPrincipal(): WarrantPrincipal | undefined {
  return requestContext.getStore()?.principal;
}

export function warrantAudienceRequired(): boolean {
  return requestContext.getStore()?.audienceRequired === true;
}

/** Whether the active host can verify a requested recipient instead of trusting caller input. */
export function hasWarrantAudienceVerifier(): boolean {
  return typeof requestContext.getStore()?.verifyAudience === "function";
}

export async function verifyWarrantAudience(requested: WarrantPrincipal): Promise<WarrantPrincipal> {
  const verifier = requestContext.getStore()?.verifyAudience;
  return verifier ? verifier(requested) : requested;
}

export function currentWarrantAuthority(): WarrantAuthority | undefined {
  return requestContext.getStore()?.authority;
}

export async function resolveWarrantResourceGrant(uri: string): Promise<WarrantResourceGrant | undefined> {
  const resolver = requestContext.getStore()?.resolveResourceGrant;
  return resolver ? resolver(uri) : undefined;
}

/** Whether the active host can turn a literal resource URI into a trusted grant. */
export function hasWarrantResourceGrantResolver(): boolean {
  return typeof requestContext.getStore()?.resolveResourceGrant === "function";
}
