import type { IncomingMessage } from "node:http";
import {
  normalizeWarrantPrincipal,
  sameWarrantPrincipal,
  type WarrantPrincipal,
} from "./warrant_principal.js";
import {
  WarrantRequestContextError,
  isWarrantServiceAuthentication,
  type WarrantRequestContext,
  type WarrantResourceGrant,
  type WarrantServiceAuthentication,
} from "./warrant_request_context.js";
import type { WarrantAuthority } from "./warrant_authority.js";

/**
 * The CodeSite-owned side of the identity boundary.  It authenticates the
 * transport and csa credential before returning a session projection; no
 * session identifier supplied by an MCP caller is accepted as proof here.
 *
 * URLs, header names, mutual-TLS implementation, secret storage, and resource
 * vocabulary intentionally belong to the deployment implementation of this
 * port, not to the MCP package.
 */
export interface CodeSiteWarrantSessionVerifier {
  authenticate(request: IncomingMessage): Promise<CodeSiteAuthenticatedWarrantSession>;
}

export interface CodeSiteAuthenticatedWarrantSession {
  /** Canonical principal derived from the authenticated CodeSite session. */
  principal: unknown;
  /** Shared, transactional authority already scoped to that authenticated session. */
  authority: WarrantAuthority;
  /**
   * Trusted evidence that the verifier reached CodeSite over the deployment's
   * authenticated service channel. Its values are opaque to warrant core and
   * must not be taken from MCP request fields.
   */
  serviceAuthentication: unknown;
  /** Maps the literal requested resource to the host's ordinary grant language. */
  resolveResourceGrant(uri: string): Promise<WarrantResourceGrant> | WarrantResourceGrant;
  /**
   * Looks up a proposed audience as a live CodeSite session visible to the
   * authenticated issuer. The service must validate attachment and lifecycle
   * before returning it; the adapter additionally checks its tenant scope and
   * exact equality with the requested claim.
   */
  canonicalizeRecipient(
    issuer: WarrantPrincipal,
    requested: WarrantPrincipal,
  ): Promise<unknown>;
}

/**
 * Produces the generic MCP request context from CodeSite's authenticated
 * session service. This is the only CodeSite-specific adapter; warrant core
 * code remains unaware of CodeSite or any other identity provider.
 */
export function createCodeSiteWarrantContextProvider(
  verifier: CodeSiteWarrantSessionVerifier,
): (request: IncomingMessage) => Promise<WarrantRequestContext> {
  return async (request) => {
    let authenticated: CodeSiteAuthenticatedWarrantSession;
    try {
      authenticated = await verifier.authenticate(request);
    } catch (error) {
      if (error instanceof WarrantRequestContextError) throw error;
      throw new WarrantRequestContextError("codesite_warrant_session_unavailable", 503);
    }
    if (!authenticated || typeof authenticated !== "object") {
      throw new WarrantRequestContextError("codesite_warrant_session_invalid", 503);
    }
    if (!authenticated.authority || typeof authenticated.resolveResourceGrant !== "function") {
      throw new WarrantRequestContextError("codesite_warrant_session_incomplete", 503);
    }
    if (typeof authenticated.canonicalizeRecipient !== "function") {
      throw new WarrantRequestContextError("codesite_warrant_recipient_verifier_required", 503);
    }
    const serviceAuthentication = normalizeServiceAuthentication(authenticated.serviceAuthentication);
    if (!serviceAuthentication) {
      throw new WarrantRequestContextError("codesite_warrant_service_authentication_required", 503);
    }

    let principal: WarrantPrincipal;
    try {
      principal = normalizeWarrantPrincipal(authenticated.principal);
    } catch {
      throw new WarrantRequestContextError("codesite_warrant_principal_invalid", 503);
    }
    if (!principal.project) {
      throw new WarrantRequestContextError("codesite_warrant_principal_project_required", 503);
    }

    return {
      principal,
      audienceRequired: true,
      authority: authenticated.authority,
      serviceAuthentication,
      resolveResourceGrant: authenticated.resolveResourceGrant,
      verifyAudience: async (requested) => {
        let canonical: WarrantPrincipal;
        try {
          canonical = normalizeWarrantPrincipal(
            await authenticated.canonicalizeRecipient(principal, requested),
          );
        } catch (error) {
          if (error instanceof WarrantRequestContextError) throw error;
          throw new WarrantRequestContextError("codesite_warrant_recipient_unavailable", 503);
        }
        if (
          !canonical.project
          ||
          canonical.workspace !== principal.workspace
          || canonical.project !== principal.project
          || !sameWarrantPrincipal(canonical, requested)
        ) {
          throw new WarrantRequestContextError("codesite_warrant_recipient_mismatch", 403);
        }
        return canonical;
      },
    };
  };
}

function normalizeServiceAuthentication(value: unknown): WarrantServiceAuthentication | undefined {
  if (!isWarrantServiceAuthentication(value)) return undefined;
  return { transport: value.transport.trim(), service: value.service.trim() };
}
