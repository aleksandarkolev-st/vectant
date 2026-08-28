import type { IncomingMessage } from "node:http";
import type { WarrantRequestContext } from "./warrant_request_context.js";

/**
 * Runtime boundary for a deployment-owned warrant identity integration.
 *
 * The MCP package intentionally does not know where CodeSite runs, how a
 * service channel is authenticated, or how credentials are presented. An
 * operator supplies a trusted module that constructs the request provider from
 * its own runtime configuration and secrets.
 */
export type WarrantRequestContextProvider = (
  request: IncomingMessage,
) => Promise<WarrantRequestContext> | WarrantRequestContext;

export type WarrantRequestContextProviderFactory = () =>
  | WarrantRequestContextProvider
  | Promise<WarrantRequestContextProvider>;

interface WarrantRequestContextProviderModule {
  createWarrantRequestContextProvider?: unknown;
}

/**
 * Loads the deployment module only when the operator explicitly configured
 * one. No endpoint, protocol, header, certificate, provider, or identity is
 * encoded here. An invalid configured module is an availability failure, never
 * a fallback to caller-supplied identity.
 */
export async function loadRuntimeWarrantRequestContextProvider(
  moduleSpecifier = process.env["SYNTHI_WARRANT_CONTEXT_PROVIDER_MODULE"],
): Promise<WarrantRequestContextProvider | undefined> {
  const specifier = String(moduleSpecifier ?? "").trim();
  if (!specifier) return undefined;

  let loaded: WarrantRequestContextProviderModule;
  try {
    loaded = await import(specifier) as WarrantRequestContextProviderModule;
  } catch {
    throw new Error("warrant_request_context_provider_module_unavailable");
  }
  if (typeof loaded.createWarrantRequestContextProvider !== "function") {
    throw new Error("warrant_request_context_provider_factory_required");
  }

  let provider: WarrantRequestContextProvider;
  try {
    provider = await (loaded.createWarrantRequestContextProvider as WarrantRequestContextProviderFactory)();
  } catch {
    throw new Error("warrant_request_context_provider_initialization_failed");
  }
  if (typeof provider !== "function") {
    throw new Error("warrant_request_context_provider_invalid");
  }
  return provider;
}
