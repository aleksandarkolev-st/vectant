import { ADVERTISED_TOOLS } from "./tool_registry.js";

/**
 * Schema-free routing metadata for the MCP surface. The canonical tool list
 * remains `ADVERTISED_TOOLS`; this module only adds stable routing facets and
 * never participates in tool registration or dispatch.
 */

export type ToolMetadataOrigin = "advertised" | "dynamic" | "both";

export interface VectantToolMetadata {
  /** Exact MCP tool name. */
  readonly name: string;
  /** Reusable, normalized routing facets such as `codesite` or `runtime`. */
  readonly groups: readonly string[];
  /** Normalized name tokens plus caller-supplied routing terms. */
  readonly keywords: readonly string[];
  /** Whether the entry originated in the advertised registry, dynamic input, or both. */
  readonly origin: ToolMetadataOrigin;
}

/**
 * Metadata for a generated/private tool or an advertised tool that needs
 * extra routing hints. No tool schema is required to register an entry here.
 */
export interface DynamicToolMetadataEntry {
  readonly name: string;
  readonly groups?: readonly string[];
  readonly keywords?: readonly string[];
}

export interface ToolMetadataCatalogOptions {
  /** Defaults to the canonical advertised registry. Useful for isolated tests. */
  readonly advertisedTools?: readonly string[];
  /** Generated/private tools and optional extra facets for advertised tools. */
  readonly dynamicEntries?: readonly DynamicToolMetadataEntry[];
}

export type ToolMetadataMatch = "any" | "all";

/**
 * `names` is an exact-name prefilter. `groups` and `keywords` are normalized
 * before comparison; each facet defaults to any-match so one query can route
 * across related groups, while callers may opt into all-match to narrow it.
 */
export interface ToolMetadataSelection {
  readonly names?: readonly string[];
  readonly groups?: readonly string[];
  readonly keywords?: readonly string[];
  readonly groupMatch?: ToolMetadataMatch;
  readonly keywordMatch?: ToolMetadataMatch;
}

export interface ToolMetadataCatalog {
  /** All entries in advertised-tool order, followed by dynamic-only entries. */
  readonly entries: readonly VectantToolMetadata[];
  /** Alias for `entries` for callers that treat the catalog as a tool list. */
  readonly tools: readonly VectantToolMetadata[];
  lookup(name: string): VectantToolMetadata | undefined;
  select(selection?: ToolMetadataSelection): readonly VectantToolMetadata[];
}

const ATTACHMENT_ACTIONS = new Set(["attach", "detach", "reconnect"]);
const SNAPSHOT_ACTIONS = new Set(["snapshot", "restore", "snapshots"]);

function normalizedTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizedGroup(value: string): string {
  return normalizedTerms(value).join("-");
}

function uniqueTerms(terms: readonly string[]): string[] {
  return [...new Set(terms)];
}

function assertToolName(name: string): void {
  if (name.trim().length === 0) {
    throw new TypeError("Tool metadata entries require a non-empty name.");
  }
}

function addGroup(groups: string[], group: string): void {
  if (!groups.includes(group)) {
    groups.push(group);
  }
}

function hasAnyToken(tokens: readonly string[], candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate));
}

/** Derives reusable facets solely from the MCP tool name. */
export function deriveToolMetadata(name: string): VectantToolMetadata {
  assertToolName(name);

  const tokens = normalizedTerms(name);
  const groups: string[] = [];
  const [namespace, domain] = tokens;
  const actionTokens = namespace === "synthi" ? tokens.slice(1) : tokens;

  if (namespace === "synthi" && domain === "codesite") {
    addGroup(groups, "codesite");
    addGroup(groups, "control-plane");
  } else if (namespace === "synthi" && domain === "dojo") {
    addGroup(groups, "agent-dojo");
    addGroup(groups, "governance");
  } else if (namespace === "synthi" && domain === "browser") {
    addGroup(groups, "browser");
    addGroup(groups, "runtime");
  } else if (namespace === "synthi" && domain === "auth") {
    addGroup(groups, "authentication");
  } else if (namespace === "synthi" && domain === "source") {
    addGroup(groups, "source-identity");
  } else if (namespace === "synthi" && domain === "safety") {
    addGroup(groups, "safety");
  } else {
    addGroup(groups, "runtime");
  }

  if (hasAnyToken(actionTokens, [...ATTACHMENT_ACTIONS])) {
    addGroup(groups, "attachment");
  }
  if (hasAnyToken(actionTokens, ["workflow", "teach", "trace", "private"])) {
    addGroup(groups, "workflow");
  }
  if (hasAnyToken(actionTokens, ["project", "deployment", "compile", "run"])) {
    addGroup(groups, "project");
  }
  if (hasAnyToken(actionTokens, ["proof", "capsule"])) {
    addGroup(groups, "proof");
  }
  if (hasAnyToken(actionTokens, [...SNAPSHOT_ACTIONS])) {
    addGroup(groups, "snapshot");
  }
  if (hasAnyToken(actionTokens, ["mouse", "keyboard", "click", "type", "input", "fill", "act"])) {
    addGroup(groups, "input");
  }
  if (hasAnyToken(actionTokens, ["screenshot", "observe", "describe", "console", "network", "trace"])) {
    addGroup(groups, "observation");
  }
  if (hasAnyToken(actionTokens, ["verify", "validate", "checkride", "test", "readiness"])) {
    addGroup(groups, "verification");
  }
  if (hasAnyToken(actionTokens, ["metric", "usage", "event", "status", "health", "radar", "log"])) {
    addGroup(groups, "telemetry");
  }
  if (hasAnyToken(actionTokens, ["human", "permission"])) {
    addGroup(groups, "human-escalation");
  }

  return {
    name,
    groups: uniqueTerms(groups),
    keywords: uniqueTerms(["vectant", ...actionTokens]),
    origin: "advertised",
  };
}

function toDynamicMetadata(entry: DynamicToolMetadataEntry): VectantToolMetadata {
  assertToolName(entry.name);
  const derived = deriveToolMetadata(entry.name);

  return {
    ...derived,
    groups: uniqueTerms([
      ...derived.groups,
      ...(entry.groups ?? []).map(normalizedGroup).filter(Boolean),
    ]),
    keywords: uniqueTerms([
      ...derived.keywords,
      ...(entry.keywords ?? []).flatMap(normalizedTerms),
    ]),
    origin: "dynamic",
  };
}

function mergeMetadata(
  current: VectantToolMetadata,
  incoming: VectantToolMetadata,
): VectantToolMetadata {
  return {
    name: current.name,
    groups: uniqueTerms([...current.groups, ...incoming.groups]),
    keywords: uniqueTerms([...current.keywords, ...incoming.keywords]),
    origin: current.origin === incoming.origin ? current.origin : "both",
  };
}

function matchesTerms(
  available: readonly string[],
  requested: readonly string[] | undefined,
  mode: ToolMetadataMatch,
  normalize: (value: string) => readonly string[],
): boolean {
  if (!requested || requested.length === 0) {
    return true;
  }

  const normalized = uniqueTerms(requested.flatMap(normalize));
  if (normalized.length === 0) {
    return true;
  }

  return mode === "all"
    ? normalized.every((term) => available.includes(term))
    : normalized.some((term) => available.includes(term));
}

/**
 * Builds a catalog from the canonical registry and optional runtime-generated
 * metadata. Dynamic entries with an advertised name augment that entry instead
 * of creating a duplicate; dynamic-only entries are appended in input order.
 */
export function createToolMetadataCatalog(
  options: ToolMetadataCatalogOptions = {},
): ToolMetadataCatalog {
  const advertisedTools = options.advertisedTools ?? ADVERTISED_TOOLS;
  const orderedNames: string[] = [];
  const byName = new Map<string, VectantToolMetadata>();

  for (const name of advertisedTools) {
    assertToolName(name);
    if (!byName.has(name)) {
      orderedNames.push(name);
      byName.set(name, deriveToolMetadata(name));
    }
  }

  for (const entry of options.dynamicEntries ?? []) {
    const incoming = toDynamicMetadata(entry);
    const current = byName.get(incoming.name);
    if (current) {
      byName.set(incoming.name, mergeMetadata(current, incoming));
    } else {
      orderedNames.push(incoming.name);
      byName.set(incoming.name, incoming);
    }
  }

  const entries = orderedNames.map((name) => byName.get(name) as VectantToolMetadata);
  const lookup = (name: string): VectantToolMetadata | undefined => byName.get(name);
  const select = (selection: ToolMetadataSelection = {}): readonly VectantToolMetadata[] => {
    const requestedNames = selection.names ? new Set(selection.names) : undefined;
    const groupMatch = selection.groupMatch ?? "any";
    const keywordMatch = selection.keywordMatch ?? "any";

    return entries.filter((entry) => (
      (!requestedNames || requestedNames.has(entry.name))
      && matchesTerms(entry.groups, selection.groups, groupMatch, (value) => [normalizedGroup(value)])
      && matchesTerms(entry.keywords, selection.keywords, keywordMatch, normalizedTerms)
    ));
  };

  return {
    entries,
    tools: entries,
    lookup,
    select,
  };
}

/** Default catalog covering every action currently advertised by the MCP. */
export const TOOL_METADATA_CATALOG = createToolMetadataCatalog();

/** Named alias for routing code that prefers the product name. */
export const VECTANT_TOOL_CATALOG = TOOL_METADATA_CATALOG;

export function lookupToolMetadata(name: string): VectantToolMetadata | undefined {
  return TOOL_METADATA_CATALOG.lookup(name);
}

export function selectToolMetadata(
  selection: ToolMetadataSelection = {},
): readonly VectantToolMetadata[] {
  return TOOL_METADATA_CATALOG.select(selection);
}
