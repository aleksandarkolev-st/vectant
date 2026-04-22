/**
 * Enriched-tier provider registry — ultraplan §Enriched tools.
 *
 * Phase 1 ships with no provider registered; every enriched tool returns
 * `enriched_tier_not_available` so agents have a stable wire error to
 * branch on. Phase 2b plugs in real providers:
 *
 *   - a11y-bridge provider (JavaAccessibilityBridge for Swing, AT-SPI for
 *     GTK, QAccessible for Qt) — read a11y tree from the guest without
 *     guest code changes.
 *   - synthi-probe provider — cooperative library the guest links, speaks
 *     a newline-framed JSON protocol over a per-session Unix domain
 *     socket at /run/synthi/probe-<session_id>.sock.
 *
 * Both providers implement the same `EnrichedProvider` interface so the
 * tool layer never cares which source supplied the entity tree.
 */

export interface EnrichedBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EnrichedEntity {
  id: string;
  role: string;
  name?: string;
  value?: string;
  bbox: EnrichedBbox;
  state?: string[];
  parent_id?: string;
}

export interface EnrichedMetric {
  name: string;
  value: number;
  unit?: string;
}

export interface EnrichedProcessState {
  pid: number;
  rss_kb: number;
  threads: number;
  uptime_ms: number;
}

export interface EnrichedProviderInfo {
  kind: "a11y_bridge" | "synthi_probe";
  toolkit?: string; // "swing" | "atspi" | "qt" | "custom"
  version?: string;
}

export interface EnrichedProvider {
  info(): EnrichedProviderInfo;
  listEntities(opts?: { role?: string; name_contains?: string; limit?: number }): Promise<EnrichedEntity[]>;
  dispatchAction(entity_id: string, action: "press" | "select" | "focus" | "toggle"): Promise<{ ok: boolean; reason?: string }>;
  fillForm(fields: { entity_id: string; value: string }[]): Promise<{ filled: { entity_id: string; ok: boolean; reason?: string }[] }>;
  getLabels(region?: EnrichedBbox, limit?: number): Promise<EnrichedEntity[]>;
  getProcessState(): Promise<EnrichedProcessState | null>;
  getMetrics(name?: string): Promise<EnrichedMetric[]>;
}

let current: EnrichedProvider | null = null;

export function registerEnrichedProvider(p: EnrichedProvider | null): void {
  current = p;
}

export function currentEnrichedProvider(): EnrichedProvider | null {
  return current;
}

export function enrichedAvailable(): boolean {
  return current !== null;
}
