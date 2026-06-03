import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";
import { BrowserTraceRecorder, generatePlaywrightScript } from "./trace.js";
import { bridgeTokenMatches, normalizeOrigin, sameExactOrigin } from "./security.js";
import type {
  BrowserConsentRecord,
  BrowserConsentStatus,
  BrowserLease,
  BrowserSelection,
  BrowserSnapshot,
  BrowserTab,
  BrowserTraceEvent,
} from "./types.js";

export interface BrowserBrokerSnapshotInput {
  tab_id: string;
  url: string;
  title?: string;
  screenshot_base64?: string;
  dom?: Record<string, unknown>;
  console?: BrowserTraceEvent[];
  network?: BrowserTraceEvent[];
}

export interface BrowserActionInput {
  lease_id: string;
  action: "click" | "fill" | "press" | "navigate" | "wait";
  tab_id?: string;
  url?: string;
  selector?: string;
  value?: string;
  field_name?: string;
}

export interface BrowserBridgeMessage {
  bridge_token?: unknown;
  page_origin?: unknown;
  tab_id?: unknown;
  type?: unknown;
  payload?: unknown;
}

const DEFAULT_LEASE_MS = 15_000;
const MAX_LEASE_MS = 15_000;

export class BrowserBroker {
  private readonly consent = new Map<string, BrowserConsentRecord>();
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly trace = new BrowserTraceRecorder();
  private bridgeToken: string | undefined;
  private selectedTabId: string | null = null;
  private teachMode: { active: boolean; tab_id: string | null; origin: string | null } = {
    active: false,
    tab_id: null,
    origin: null,
  };
  private activeLease: BrowserLease | null = null;
  private queuedActions: BrowserActionInput[] = [];

  setBridgeToken(token: string | undefined): void {
    this.bridgeToken = token;
  }

  registerTabs(tabs: BrowserTab[]): BrowserTab[] {
    this.tabs.clear();
    for (const tab of tabs) {
      const origin = this.originOrNull(tab.url);
      if (origin && !this.hasOriginConsent(origin)) continue;
      this.tabs.set(tab.tab_id, { ...tab });
    }
    if (this.selectedTabId && !this.tabs.has(this.selectedTabId)) this.selectedTabId = null;
    return this.listTabs();
  }

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ ...tab }));
  }

  listAuthorizedTabs(allTabs: BrowserTab[]): BrowserTab[] {
    return allTabs.filter((tab) => {
      const origin = this.originOrNull(tab.url);
      return origin !== null && this.hasOriginConsent(origin);
    });
  }

  selectTab(tab_id: string): BrowserTab | null {
    const tab = this.tabs.get(tab_id);
    if (!tab) return null;
    this.selectedTabId = tab_id;
    return { ...tab };
  }

  selectedTab(): BrowserTab | null {
    if (!this.selectedTabId) return null;
    const tab = this.tabs.get(this.selectedTabId);
    return tab ? { ...tab } : null;
  }

  requestConsent(url: string, status: BrowserConsentStatus = "granted", reason?: string): BrowserConsentRecord {
    const origin = normalizeOrigin(url).origin;
    const now = Date.now();
    const record: BrowserConsentRecord = {
      origin,
      status,
      reason,
    };
    if (status === "granted") record.granted_at = now;
    if (status === "denied") record.denied_at = now;
    this.consent.set(origin, record);
    eventLog.push({
      kind: "security",
      code: status === "granted" ? "browser_consent_granted" : "browser_consent_denied",
      detail: { origin, reason: reason ?? null },
    });
    return { ...record };
  }

  getConsent(url?: string): BrowserConsentRecord[] {
    if (!url) return [...this.consent.values()].map((record) => ({ ...record }));
    const origin = normalizeOrigin(url).origin;
    const found = this.consent.get(origin);
    return found ? [{ ...found }] : [{ origin, status: "unset" }];
  }

  revokeConsent(url: string, reason?: string): BrowserConsentRecord {
    const origin = normalizeOrigin(url).origin;
    const record: BrowserConsentRecord = {
      origin,
      status: "denied",
      revoked_at: Date.now(),
      reason,
    };
    this.consent.set(origin, record);
    if (this.teachMode.active && this.teachMode.origin === origin) this.stopTeachMode("consent_revoked");
    if (this.selectedTabId) {
      const tab = this.tabs.get(this.selectedTabId);
      if (tab && sameExactOrigin(tab.url, origin)) this.selectedTabId = null;
    }
    eventLog.push({
      kind: "security",
      code: "browser_consent_revoked",
      detail: { origin, reason: reason ?? null },
    });
    return { ...record };
  }

  startTeachMode(tab_id: string): { ok: true; tab: BrowserTab; origin: string } | { ok: false; error: string } {
    const tab = this.tabs.get(tab_id);
    if (!tab) return { ok: false, error: "tab_not_authorized" };
    const origin = normalizeOrigin(tab.url).origin;
    if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    this.teachMode = { active: true, tab_id, origin };
    eventLog.push({
      kind: "browser",
      action: "teach_started",
      payload: { tab_id, origin },
    });
    return { ok: true, tab: { ...tab }, origin };
  }

  stopTeachMode(reason: string = "stopped"): { active: false; reason: string } {
    const previous = { ...this.teachMode };
    this.teachMode = { active: false, tab_id: null, origin: null };
    eventLog.push({
      kind: "browser",
      action: "teach_stopped",
      payload: { reason, previous },
    });
    return { active: false, reason };
  }

  teachState(): { active: boolean; tab_id: string | null; origin: string | null } {
    return { ...this.teachMode };
  }

  handleOriginChange(tab_id: string, nextUrl: string): void {
    const origin = normalizeOrigin(nextUrl).origin;
    const tab = this.tabs.get(tab_id);
    if (tab) {
      this.tabs.set(tab_id, { ...tab, url: nextUrl });
    }
    if (this.teachMode.active && this.teachMode.tab_id === tab_id && this.teachMode.origin !== origin) {
      this.stopTeachMode(this.hasOriginConsent(origin) ? "origin_changed" : "unapproved_origin_change");
    }
  }

  recordSelection(selection: BrowserSelection): { ok: true; event: BrowserTraceEvent } | { ok: false; error: string } {
    const gate = this.requireTeach(selection.tab_id, selection.url);
    if (!gate.ok) return gate;
    const event = this.trace.recordSelection(selection);
    eventLog.push({ kind: "browser", action: "selection", payload: { event } });
    return { ok: true, event };
  }

  recordHumanAction(selection: BrowserSelection & { action: BrowserActionInput["action"]; value?: string; field_name?: string }):
    | { ok: true; event: BrowserTraceEvent; lease_conflict: boolean }
    | { ok: false; error: string } {
    const gate = this.requireTeach(selection.tab_id, selection.url);
    if (!gate.ok) return gate;
    const lease_conflict = this.activeLease !== null && !this.activeLease.revoked;
    const event = this.trace.recordHumanAction({
      tab_id: selection.tab_id,
      frame_id: selection.frame_id,
      url: selection.url,
      origin: selection.origin,
      action: selection.action,
      value: selection.value,
      field_name: selection.field_name,
      element: selection.element,
      detail: { lease_conflict },
    });
    eventLog.push({ kind: "browser", action: "human_action", payload: { event, lease_conflict } });
    if (lease_conflict) {
      eventLog.push({
        kind: "security",
        code: "browser_human_action_during_agent_lease",
        detail: { lease_id: this.activeLease?.lease_id, tab_id: selection.tab_id },
      });
    }
    return { ok: true, event, lease_conflict };
  }

  snapshot(input: BrowserBrokerSnapshotInput): { ok: true; snapshot: BrowserSnapshot } | { ok: false; error: string } {
    const origin = normalizeOrigin(input.url).origin;
    if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    const tab = this.tabs.get(input.tab_id);
    if (!tab) return { ok: false, error: "tab_not_authorized" };
    const snapshot: BrowserSnapshot = {
      tab_id: input.tab_id,
      url: input.url,
      origin,
    };
    if (input.title !== undefined) snapshot.title = input.title;
    if (input.screenshot_base64 !== undefined) snapshot.screenshot_base64 = input.screenshot_base64;
    if (input.dom !== undefined) snapshot.dom = input.dom;
    if (input.console !== undefined) snapshot.console = input.console;
    if (input.network !== undefined) snapshot.network = input.network;
    return { ok: true, snapshot };
  }

  acquireLease(owner: string, lease_ms: number = DEFAULT_LEASE_MS, reason?: string): BrowserLease {
    const now = Date.now();
    const clamped = Math.min(Math.max(lease_ms, 50), MAX_LEASE_MS);
    const lease: BrowserLease = {
      lease_id: `browser_lease_${randomUUID()}`,
      owner,
      acquired_at: now,
      expires_at: now + clamped,
      lease_ms: clamped,
      reason,
    };
    this.activeLease = lease;
    eventLog.push({ kind: "browser", action: "lease_acquired", payload: { lease } });
    return { ...lease };
  }

  releaseLease(lease_id: string, reason: string = "released"): { released: boolean } {
    if (!this.activeLease || this.activeLease.lease_id !== lease_id) return { released: false };
    const lease = this.activeLease;
    this.activeLease = null;
    this.queuedActions = [];
    eventLog.push({ kind: "browser", action: "lease_released", payload: { lease_id, reason } });
    return { released: true };
  }

  revokeLease(reason: string): void {
    if (!this.activeLease) return;
    const lease = { ...this.activeLease, revoked: true };
    this.activeLease = null;
    this.queuedActions = [];
    eventLog.push({ kind: "browser", action: "lease_revoked", payload: { lease_id: lease.lease_id, reason } });
  }

  validateAction(input: BrowserActionInput): { ok: true; action: BrowserActionInput } | { ok: false; error: string } {
    if (!this.activeLease) return { ok: false, error: "browser_lease_required" };
    if (this.activeLease.lease_id !== input.lease_id) return { ok: false, error: "browser_lease_denied" };
    if (this.activeLease.expires_at <= Date.now()) {
      this.revokeLease("expired");
      return { ok: false, error: "browser_lease_expired" };
    }
    if (input.url !== undefined) {
      const origin = normalizeOrigin(input.url).origin;
      if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    }
    return { ok: true, action: { ...input } };
  }

  queueAction(input: BrowserActionInput): { ok: true; queued: number } | { ok: false; error: string } {
    const validation = this.validateAction(input);
    if (!validation.ok) return validation;
    this.queuedActions.push({ ...input });
    return { ok: true, queued: this.queuedActions.length };
  }

  traceSnapshot(): BrowserTraceEvent[] {
    return this.trace.snapshot();
  }

  generatedScript(): ReturnType<typeof generatePlaywrightScript> {
    return generatePlaywrightScript(this.trace.snapshot());
  }

  validateBridgeMessage(message: BrowserBridgeMessage): { ok: true } | { ok: false; error: string } {
    if (!bridgeTokenMatches(this.bridgeToken, message.bridge_token)) {
      return { ok: false, error: "bad_bridge_token" };
    }
    if (typeof message.page_origin !== "string") return { ok: false, error: "missing_page_origin" };
    if (!this.hasOriginConsent(message.page_origin)) return { ok: false, error: "origin_consent_required" };
    return { ok: true };
  }

  resetForTests(): void {
    this.consent.clear();
    this.tabs.clear();
    this.trace.clear();
    this.selectedTabId = null;
    this.teachMode = { active: false, tab_id: null, origin: null };
    this.activeLease = null;
    this.queuedActions = [];
    this.bridgeToken = undefined;
  }

  private hasOriginConsent(originOrUrl: string): boolean {
    let origin: string;
    try {
      origin = normalizeOrigin(originOrUrl).origin;
    } catch {
      return false;
    }
    return this.consent.get(origin)?.status === "granted";
  }

  private requireTeach(tab_id: string, url: string): { ok: true } | { ok: false; error: string } {
    if (!this.teachMode.active) return { ok: false, error: "teach_mode_required" };
    if (this.teachMode.tab_id !== tab_id) return { ok: false, error: "teach_tab_mismatch" };
    const origin = normalizeOrigin(url).origin;
    if (this.teachMode.origin !== origin) return { ok: false, error: "teach_origin_mismatch" };
    if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    return { ok: true };
  }

  private originOrNull(url: string): string | null {
    try {
      return normalizeOrigin(url).origin;
    } catch {
      return null;
    }
  }
}

export const browserBroker = new BrowserBroker();
