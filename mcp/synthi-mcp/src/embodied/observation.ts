/**
 * Observation plumbing (plan Architecture Changes "observation.ts"):
 * ObservationBundle, channel registry, redaction policies.
 *
 * - Channel registry: adapters declare channels; observation requests are
 *   validated against them (unknown channel = error, never silence).
 * - Redaction policies: per-channel scrubbing applied BEFORE any
 *   observation leaves the adapter boundary. The terminal secret scrubber
 *   is one policy; adapters may register their own.
 */

import { scrubSecrets } from "./adapters/terminal/scrub.js";

export type RedactionPolicy = {
  id: string;
  apply(value: unknown): unknown;
};

/** Built-in policy: deep-scrub strings for known credential shapes. */
export const secretsPolicy: RedactionPolicy = {
  id: "secrets",
  apply: (value) => redactStrings(value),
};

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return scrubSecrets(value).text;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redactStrings(inner)]),
    );
  }
  return value;
}

/** Drop values for keys matching sensitive names entirely. */
export const dropSensitiveKeysPolicy: RedactionPolicy = {
  id: "drop_sensitive_keys",
  apply: (value) => stripSensitive(value),
};

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api_key|private_key/i;

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, inner]) => [key, stripSensitive(inner)]),
    );
  }
  return value;
}

export interface ObservationBundle<T = unknown> {
  substrate_kind: string;
  channels_used: string[];
  /** Redaction policies applied, in order. */
  policies_applied: string[];
  tick?: number;
  data: T;
}

export class ChannelRegistry {
  private readonly channels = new Map<string, { observe: () => Promise<unknown> | unknown }>();

  register(channel: string, observe: () => Promise<unknown> | unknown): void {
    this.channels.set(channel, { observe });
  }

  has(channel: string): boolean {
    return this.channels.has(channel);
  }

  list(): string[] {
    return [...this.channels.keys()];
  }

  async observe(channel: string, policies: readonly RedactionPolicy[] = [secretsPolicy]): Promise<ObservationBundle> {
    const entry = this.channels.get(channel);
    if (!entry) {
      throw new Error(`unknown channel "${channel}" (registered: ${this.list().join(", ") || "none"})`);
    }
    let data = await entry.observe();
    const applied: string[] = [];
    for (const policy of policies) {
      data = policy.apply(data);
      applied.push(policy.id);
    }
    return {
      substrate_kind: "",
      channels_used: [channel],
      policies_applied: applied,
      data,
    };
  }
}
