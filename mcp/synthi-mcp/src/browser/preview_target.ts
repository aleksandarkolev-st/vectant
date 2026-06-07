import type { BrowserTab } from "./types.js";

export interface BrowserPreviewTargetInput {
  workspace_url?: string;
  preferred_url?: string;
  preview_url?: string;
  allowed_preview_origins?: string[];
  allowed_preview_host_suffixes?: string[];
}

export type BrowserPreviewTargetResult = {
  ok: true;
  tab: BrowserTab;
  reason: string;
  origin: string;
} | {
  ok: false;
  error: "preview_target_not_found";
  reason: string;
  eligible_tab_count: number;
};

interface ParsedTab {
  tab: BrowserTab;
  url: URL;
  origin: string;
}

export function resolveBrowserPreviewTarget(
  tabs: BrowserTab[],
  input: BrowserPreviewTargetInput = {},
  env: NodeJS.ProcessEnv = process.env
): BrowserPreviewTargetResult {
  const policy = buildPreviewPolicy(input, env);
  const workspaceOrigin = policy.workspaceUrl?.origin ?? null;

  const parsedTabs = tabs
    .map((tab) => {
      const url = parseUrl(tab.url);
      if (!url || !["http:", "https:"].includes(url.protocol)) return null;
      return { tab, url, origin: url.origin } satisfies ParsedTab;
    })
    .filter((entry): entry is ParsedTab => entry !== null)
    .filter((entry) => entry.origin !== workspaceOrigin);

  const candidates = parsedTabs
    .map((entry) => {
      const score = previewScore(entry, {
        workspaceIsLoopback: policy.workspaceIsLoopback,
        exactOrigins: policy.exactOrigins,
        suffixes: policy.suffixes,
        preferredUrl: policy.preferredUrl,
        previewUrl: policy.previewUrl,
      });
      return score > 0 ? { entry, score } : null;
    })
    .filter((entry): entry is { entry: ParsedTab; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) {
    return {
      ok: false,
      error: "preview_target_not_found",
      reason: "No open browser tab matched the configured workspace preview policy.",
      eligible_tab_count: parsedTabs.length,
    };
  }

  return {
    ok: true,
    tab: best.entry.tab,
    origin: best.entry.origin,
    reason: previewReason(best.entry, {
      workspaceIsLoopback: policy.workspaceIsLoopback,
      exactOrigins: policy.exactOrigins,
      suffixes: policy.suffixes,
      preferredUrl: policy.preferredUrl,
      previewUrl: policy.previewUrl,
    }),
  };
}

function buildPreviewPolicy(input: BrowserPreviewTargetInput, env: NodeJS.ProcessEnv): {
  workspaceUrl: URL | null;
  workspaceIsLoopback: boolean;
  preferredUrl: URL | null;
  previewUrl: URL | null;
  exactOrigins: Set<string>;
  suffixes: string[];
} {
  const workspaceUrl = parseUrl(input.workspace_url);
  const preferredUrl = parseUrl(input.preferred_url);
  const previewUrl = parseUrl(input.preview_url ?? env["SYNTHI_WORKSPACE_PREVIEW_URL"] ?? env["SYNTHI_PREVIEW_URL"]);
  const exactOrigins = new Set<string>();
  const addOrigin = (value: string | undefined): void => {
    const parsed = parseUrl(value);
    if (parsed) exactOrigins.add(parsed.origin);
  };
  addOrigin(input.preferred_url);
  addOrigin(input.preview_url);
  addOrigin(env["SYNTHI_WORKSPACE_PREVIEW_URL"]);
  addOrigin(env["SYNTHI_PREVIEW_URL"]);
  for (const origin of input.allowed_preview_origins ?? []) addOrigin(origin);
  for (const origin of splitEnvList(env["SYNTHI_BROWSER_PREVIEW_ALLOWED_ORIGINS"])) addOrigin(origin);

  const suffixes = [
    ...(input.allowed_preview_host_suffixes ?? []),
    ...splitEnvList(env["SYNTHI_BROWSER_PREVIEW_ALLOWED_HOST_SUFFIXES"]),
  ].map((suffix) => suffix.trim().toLowerCase()).filter(Boolean);

  return {
    workspaceUrl,
    workspaceIsLoopback: workspaceUrl ? isLoopbackHost(workspaceUrl.hostname) : false,
    preferredUrl,
    previewUrl,
    exactOrigins,
    suffixes,
  };
}

export function isBrowserPreviewUrlAllowed(
  value: unknown,
  input: Omit<BrowserPreviewTargetInput, "preferred_url" | "preview_url"> = {},
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const url = parseUrl(value);
  if (!url || !["http:", "https:"].includes(url.protocol)) return false;
  const policy = buildPreviewPolicy({ ...input, preferred_url: undefined, preview_url: undefined }, env);
  const workspaceOrigin = policy.workspaceUrl?.origin ?? null;
  if (url.origin === workspaceOrigin) return false;
  if (policy.previewUrl && (sameUrl(url, policy.previewUrl) || urlWithinBase(url, policy.previewUrl))) return true;
  if (policy.exactOrigins.has(url.origin)) return true;
  if (policy.suffixes.some((suffix) => hostMatchesSuffix(url.hostname, suffix))) return true;
  return policy.workspaceIsLoopback && isLoopbackHost(url.hostname);
}

function previewScore(
  entry: ParsedTab,
  policy: {
    workspaceIsLoopback: boolean;
    exactOrigins: Set<string>;
    suffixes: string[];
    preferredUrl: URL | null;
    previewUrl: URL | null;
  }
): number {
  let score = 0;
  if (policy.preferredUrl) {
    if (sameUrl(entry.url, policy.preferredUrl)) score += 1200;
    else if (urlWithinBase(entry.url, policy.preferredUrl)) score += 1100;
  }
  if (policy.previewUrl) {
    if (sameUrl(entry.url, policy.previewUrl)) score += 1000;
    else if (urlWithinBase(entry.url, policy.previewUrl)) score += 950;
  }
  if (policy.exactOrigins.has(entry.origin)) score += 700;
  if (policy.suffixes.some((suffix) => hostMatchesSuffix(entry.url.hostname, suffix))) score += 500;
  if (policy.workspaceIsLoopback && isLoopbackHost(entry.url.hostname)) score += 300;
  if (score === 0) return 0;
  if (entry.tab.active) score += 50;
  if (entry.tab.title && entry.tab.title !== "about:blank") score += 10;
  return score;
}

function previewReason(
  entry: ParsedTab,
  policy: {
    workspaceIsLoopback: boolean;
    exactOrigins: Set<string>;
    suffixes: string[];
    preferredUrl: URL | null;
    previewUrl: URL | null;
  }
): string {
  if (policy.preferredUrl && sameUrl(entry.url, policy.preferredUrl)) return "preferred_url";
  if (policy.preferredUrl && urlWithinBase(entry.url, policy.preferredUrl)) return "preferred_url_path";
  if (policy.previewUrl && sameUrl(entry.url, policy.previewUrl)) return "workspace_preview_url";
  if (policy.previewUrl && urlWithinBase(entry.url, policy.previewUrl)) return "workspace_preview_url_path";
  if (policy.exactOrigins.has(entry.origin)) return "allowed_preview_origin";
  if (policy.suffixes.some((suffix) => hostMatchesSuffix(entry.url.hostname, suffix))) return "allowed_preview_host_suffix";
  if (policy.workspaceIsLoopback && isLoopbackHost(entry.url.hostname)) return "loopback_workspace_preview";
  return "preview_policy";
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function sameUrl(a: URL, b: URL): boolean {
  return canonicalUrl(a) === canonicalUrl(b);
}

function canonicalUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  copy.pathname = normalizeTrailingSlash(copy.pathname);
  return copy.href;
}

function urlWithinBase(entry: URL, base: URL): boolean {
  if (entry.origin !== base.origin) return false;
  const basePath = normalizeTrailingSlash(base.pathname);
  if (!basePath || basePath === "/") return false;
  const entryPath = normalizeTrailingSlash(entry.pathname);
  return entryPath === basePath || entryPath.startsWith(`${basePath}/`);
}

function normalizeTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function splitEnvList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  return host === normalized || host.endsWith(`.${normalized}`);
}
