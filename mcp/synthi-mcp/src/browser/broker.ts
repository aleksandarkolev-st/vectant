import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";
import { authCheckpointManager } from "./auth.js";
import { lane0Status } from "./lane0.js";
import { BrowserTraceRecorder, generatePlaywrightScript, type GeneratedScript } from "./trace.js";
import {
  compileWorkflowContract,
  planWorkflowReplay,
  type CompiledWorkflowV7,
  type WorkflowReplayModeV7,
  type WorkflowReplayPlanV7,
} from "./workflow.js";
import { bridgeTokenMatches, normalizeOrigin, redactUrl, sameExactOrigin } from "./security.js";
import type {
  BrowserActionKind,
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
  action: BrowserActionKind;
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

export interface BrowserRuntimeAttachment {
  kind: "hosted" | "local-dev-cdp";
  workspace_id: string | null;
  runtime_id: string | null;
  workspace_url: string | null;
  adapter: string;
  attached_at: number;
}

export interface BrowserTeachQuestionAnswer {
  question_id: string;
  answer: string;
  step_id?: string;
  accepted_affordance?: string;
  answered_at: number;
}

export interface BrowserWorkflowArtifact {
  workflow_id: string;
  workflow: CompiledWorkflowV7;
  events: BrowserTraceEvent[];
  saved_at: number;
}

export interface BrowserRecordingIssue {
  issue_id: string;
  at: number;
  source: "hosted-playwright-adapter" | "hosted-playwright-annotation" | "browser-extension-bridge" | "broker";
  error: string;
  tab_id?: string;
  action?: BrowserActionKind;
  url?: string;
  origin?: string;
  frame_origin?: string;
  popup_origin?: string;
}

const DEFAULT_LEASE_MS = 15_000;
const MAX_LEASE_MS = 15_000;

export interface BrowserConsentGrantOptions {
  screenshot?: boolean;
  diagnostics?: boolean;
}

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
  private runtime: BrowserRuntimeAttachment | null = null;
  private teachAnswers: BrowserTeachQuestionAnswer[] = [];
  private workflows = new Map<string, BrowserWorkflowArtifact>();
  private recordingIssues: BrowserRecordingIssue[] = [];

  setRuntimeAttachment(runtime: Omit<BrowserRuntimeAttachment, "attached_at">): BrowserRuntimeAttachment {
    this.runtime = { ...runtime, attached_at: Date.now() };
    eventLog.push({
      kind: "browser",
      action: "runtime_attached",
      payload: { runtime: this.runtime },
    });
    return { ...this.runtime };
  }

  runtimeAttachment(): BrowserRuntimeAttachment | null {
    return this.runtime ? { ...this.runtime } : null;
  }

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

  requestConsent(
    url: string,
    status: BrowserConsentStatus = "granted",
    reason?: string,
    grants: BrowserConsentGrantOptions = {}
  ): BrowserConsentRecord {
    const origin = normalizeOrigin(url).origin;
    const now = Date.now();
    const granted = status === "granted";
    const record: BrowserConsentRecord = {
      origin,
      status,
      screenshot: granted && grants.screenshot !== false ? "granted" : "denied",
      diagnostics: granted && grants.diagnostics !== false ? "granted" : "denied",
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
    return found ? [{ ...found }] : [{ origin, status: "unset", screenshot: "unset", diagnostics: "unset" }];
  }

  revokeConsent(url: string, reason?: string): BrowserConsentRecord {
    const origin = normalizeOrigin(url).origin;
    const record: BrowserConsentRecord = {
      origin,
      status: "denied",
      screenshot: "denied",
      diagnostics: "denied",
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
    this.trace.beginTrace();
    this.recordingIssues = [];
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

  recordTeachQuestionAnswer(input: {
    question_id: string;
    answer: string;
    step_id?: string;
    accepted_affordance?: string;
  }): BrowserTeachQuestionAnswer {
    const answer: BrowserTeachQuestionAnswer = {
      question_id: input.question_id,
      answer: input.answer,
      ...(input.step_id ? { step_id: input.step_id } : {}),
      ...(input.accepted_affordance ? { accepted_affordance: input.accepted_affordance } : {}),
      answered_at: Date.now(),
    };
    this.teachAnswers.push(answer);
    eventLog.push({
      kind: "browser",
      action: "teach_question_answered",
      payload: {
        question_id: answer.question_id,
        step_id: answer.step_id ?? null,
        accepted_affordance: answer.accepted_affordance ?? null,
      },
    });
    return { ...answer };
  }

  teachQuestionAnswers(): BrowserTeachQuestionAnswer[] {
    return this.teachAnswers.map((answer) => ({ ...answer }));
  }

  recordingIssueSnapshot(limit: number = 20): BrowserRecordingIssue[] {
    return this.recordingIssues.slice(-Math.max(1, Math.min(100, Math.floor(limit)))).map((issue) => ({ ...issue }));
  }

  recordTeachRecordingIssue(
    error: string,
    input: {
      tab_id?: string;
      url?: string;
      origin?: string;
      action?: BrowserActionKind;
      detail?: Record<string, unknown>;
    },
    source: BrowserRecordingIssue["source"] = "broker"
  ): BrowserRecordingIssue {
    const url = typeof input.url === "string" ? input.url : undefined;
    const origin = url ? this.originOrNull(url) : typeof input.origin === "string" ? this.originOrNull(input.origin) : null;
    const issue: BrowserRecordingIssue = {
      issue_id: `recording_issue_${randomUUID()}`,
      at: Date.now(),
      source,
      error,
      ...(typeof input.tab_id === "string" && input.tab_id.length > 0 ? { tab_id: input.tab_id } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(url ? { url: redactUrl(url).url } : {}),
      ...(origin ? { origin } : {}),
      ...(this.targetOriginFromDetail(input.detail, "frame_origin") ? { frame_origin: this.targetOriginFromDetail(input.detail, "frame_origin")! } : {}),
      ...(this.popupOriginFromDetail(input.detail) ? { popup_origin: this.popupOriginFromDetail(input.detail)! } : {}),
    };
    this.recordingIssues.push(issue);
    if (this.recordingIssues.length > 100) this.recordingIssues.splice(0, this.recordingIssues.length - 100);
    eventLog.push({ kind: "browser", action: "recording_issue", payload: { issue } });
    return { ...issue };
  }

  handleOriginChange(tab_id: string, nextUrl: string, detail?: Record<string, unknown>): void {
    let origin: string;
    try {
      origin = normalizeOrigin(nextUrl).origin;
    } catch {
      return;
    }
    const tab = this.tabs.get(tab_id);
    const previousUrl = tab?.url;
    if (tab) {
      this.tabs.set(tab_id, { ...tab, url: nextUrl });
    }
    if (!this.teachMode.active) return;
    const sameTeachTab = this.teachMode.tab_id === tab_id;
    const popupTeachTab = this.isTeachPopupContext(tab_id, detail);
    if (!sameTeachTab && !popupTeachTab) return;
    if (!popupTeachTab && this.teachMode.origin !== origin) {
      this.stopTeachMode(this.hasOriginConsent(origin) ? "origin_changed" : "unapproved_origin_change");
      return;
    }
    if (!this.hasOriginConsent(origin)) {
      this.stopTeachMode("unapproved_origin_change");
      return;
    }
    if (previousUrl === nextUrl) return;
    const eventDetail = this.detailWithTargetSecurity(nextUrl, {
      event_source: "page_lifecycle",
      navigation_event: true,
      ...(detail ?? {}),
    });
    const event = this.trace.recordNavigation({
      tab_id,
      url: nextUrl,
      origin,
      action: "navigate",
      detail: eventDetail,
      security: this.securityForUrl(nextUrl, eventDetail),
    });
    eventLog.push({ kind: "browser", action: "navigation", payload: { event } });
  }

  recordSelection(selection: BrowserSelection): { ok: true; event: BrowserTraceEvent } | { ok: false; error: string } {
    const gate = this.requireTeach(selection.tab_id, selection.url);
    if (!gate.ok) return gate;
    const normalized = this.normalizeSelectionOrigin(selection);
    if (!normalized.ok) return normalized;
    const event = this.trace.recordSelection({
      ...selection,
      origin: normalized.origin,
      security: this.securityForUrl(selection.url),
    });
    eventLog.push({ kind: "browser", action: "selection", payload: { event } });
    return { ok: true, event };
  }

  recordHumanAction(selection: BrowserSelection & { action: BrowserActionInput["action"]; value?: string; field_name?: string; detail?: Record<string, unknown> }):
    | { ok: true; event: BrowserTraceEvent; lease_conflict: boolean }
    | { ok: false; error: string } {
    const gate = this.requireTeach(selection.tab_id, selection.url, selection.detail);
    if (!gate.ok) return gate;
    const normalized = this.normalizeSelectionOrigin(selection);
    if (!normalized.ok) return normalized;
    const intentGate = this.requireExplicitIntent(selection.action, selection.detail);
    if (!intentGate.ok) return intentGate;
    const lease_conflict = this.activeLease !== null && !this.activeLease.revoked;
    const detail = this.detailWithTargetSecurity(selection.url, selection.detail);
    const event = this.trace.recordHumanAction({
      tab_id: selection.tab_id,
      frame_id: selection.frame_id,
      url: selection.url,
      origin: normalized.origin,
      action: selection.action,
      value: selection.value,
      field_name: selection.field_name,
      element: selection.element,
      detail: { ...detail, lease_conflict },
      security: this.securityForUrl(selection.url, detail),
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

  annotateLatestHumanAction(input: {
    tab_id: string;
    url: string;
    origin: string;
    actions?: BrowserActionKind[];
    detail: Record<string, unknown>;
    within_ms?: number;
  }): { ok: true; event: BrowserTraceEvent | null } | { ok: false; error: string } {
    const gate = this.requireTeach(input.tab_id, input.url, input.detail);
    if (!gate.ok) return gate;
    const normalized = this.normalizeSelectionOrigin({
      tab_id: input.tab_id,
      url: input.url,
      origin: input.origin,
    });
    if (!normalized.ok) return normalized;
    const event = this.trace.annotateLatestAction({
      tab_id: input.tab_id,
      actions: input.actions,
      detail: input.detail,
      within_ms: input.within_ms,
    });
    if (event) eventLog.push({ kind: "browser", action: "human_action_annotated", payload: { event } });
    return { ok: true, event };
  }

  snapshot(input: BrowserBrokerSnapshotInput): { ok: true; snapshot: BrowserSnapshot } | { ok: false; error: string } {
    const origin = normalizeOrigin(input.url).origin;
    if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    if (!this.hasScreenshotConsent(origin)) return { ok: false, error: "screenshot_consent_required" };
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

  lane0Status(): ReturnType<typeof lane0Status> {
    return lane0Status(this.trace.snapshot());
  }

  generatedScript(mode?: WorkflowReplayModeV7): GeneratedScript {
    const artifact = this.workflowArtifact();
    if (!artifact.ok) return generatePlaywrightScript(this.trace.snapshot(), { mode });
    return generatePlaywrightScript(artifact.artifact.events, { mode });
  }

  generatedScriptFor(
    workflowId: string | undefined,
    mode?: WorkflowReplayModeV7
  ): { ok: true; generated: GeneratedScript; artifact: BrowserWorkflowArtifact } | { ok: false; error: string; workflow_id?: string } {
    const artifact = this.workflowArtifact(workflowId);
    if (!artifact.ok) return artifact;
    return {
      ok: true,
      artifact: artifact.artifact,
      generated: generatePlaywrightScript(artifact.artifact.events, { mode }),
    };
  }

  compiledWorkflow(): ReturnType<typeof compileWorkflowContract> {
    const artifact = this.workflowArtifact();
    if (!artifact.ok) return compileWorkflowContract(this.trace.snapshot());
    return artifact.artifact.workflow;
  }

  workflowReplayPlan(mode?: WorkflowReplayModeV7): ReturnType<typeof planWorkflowReplay> {
    const artifact = this.workflowArtifact();
    if (!artifact.ok) return planWorkflowReplay(this.trace.snapshot(), mode);
    return planWorkflowReplay(artifact.artifact.events, mode);
  }

  workflowReplayPlanFor(
    workflowId: string | undefined,
    mode?: WorkflowReplayModeV7
  ): { ok: true; plan: WorkflowReplayPlanV7; artifact: BrowserWorkflowArtifact } | { ok: false; error: string; workflow_id?: string } {
    const artifact = this.workflowArtifact(workflowId);
    if (!artifact.ok) return artifact;
    return {
      ok: true,
      artifact: artifact.artifact,
      plan: planWorkflowReplay(artifact.artifact.events, mode),
    };
  }

  workflowArtifact(workflowId?: string): { ok: true; artifact: BrowserWorkflowArtifact } | { ok: false; error: string; workflow_id?: string } {
    if (workflowId) {
      const saved = this.workflows.get(workflowId);
      if (saved) return { ok: true, artifact: cloneWorkflowArtifact(saved) };
      const current = this.currentWorkflowArtifact();
      if (current.workflow_id === workflowId) return { ok: true, artifact: current };
      return { ok: false, error: "workflow_not_found", workflow_id: workflowId };
    }
    return { ok: true, artifact: this.currentWorkflowArtifact() };
  }

  registerWorkflowArtifact(artifact: BrowserWorkflowArtifact): { ok: true; artifact: BrowserWorkflowArtifact } | { ok: false; error: string; workflow_id?: string } {
    if (artifact.workflow_id !== artifact.workflow.contract.workflowId) {
      return { ok: false, error: "workflow_artifact_id_mismatch", workflow_id: artifact.workflow_id };
    }
    if (artifact.workflow.card.stepCount <= 0 || artifact.events.length <= 0) {
      return { ok: false, error: "workflow_artifact_empty", workflow_id: artifact.workflow_id };
    }
    this.workflows.set(artifact.workflow_id, cloneWorkflowArtifact(artifact));
    return { ok: true, artifact: cloneWorkflowArtifact(artifact) };
  }

  validateBridgeMessage(message: BrowserBridgeMessage): { ok: true } | { ok: false; error: string } {
    if (!bridgeTokenMatches(this.bridgeToken, message.bridge_token)) {
      return { ok: false, error: "bad_bridge_token" };
    }
    if (typeof message.page_origin !== "string") return { ok: false, error: "missing_page_origin" };
    if (!this.originOrNull(message.page_origin)) return { ok: false, error: "invalid_page_origin" };
    if (!this.hasOriginConsent(message.page_origin)) return { ok: false, error: "origin_consent_required" };
    return { ok: true };
  }

  requireSnapshotAccess(url: string): { ok: true } | { ok: false; error: string } {
    if (!this.hasOriginConsent(url)) return { ok: false, error: "origin_consent_required" };
    if (!this.hasScreenshotConsent(url)) return { ok: false, error: "screenshot_consent_required" };
    return { ok: true };
  }

  requireDiagnosticsAccess(url: string): { ok: true } | { ok: false; error: string } {
    if (!this.hasOriginConsent(url)) return { ok: false, error: "origin_consent_required" };
    if (!this.hasDiagnosticsConsent(url)) return { ok: false, error: "diagnostics_consent_required" };
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
    this.runtime = null;
    this.teachAnswers = [];
    this.workflows.clear();
    this.recordingIssues = [];
  }

  private currentWorkflowArtifact(): BrowserWorkflowArtifact {
    const events = this.trace.snapshot();
    const workflow = compileWorkflowContract(events);
    return this.saveWorkflowArtifact(events, workflow);
  }

  private saveWorkflowArtifact(events: BrowserTraceEvent[], workflow: CompiledWorkflowV7): BrowserWorkflowArtifact {
    const artifact: BrowserWorkflowArtifact = {
      workflow_id: workflow.contract.workflowId,
      workflow,
      events: events.map((event) => ({ ...event })),
      saved_at: Date.now(),
    };
    if (workflow.card.stepCount > 0) {
      this.workflows.set(artifact.workflow_id, cloneWorkflowArtifact(artifact));
    }
    return cloneWorkflowArtifact(artifact);
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

  private hasScreenshotConsent(originOrUrl: string): boolean {
    let origin: string;
    try {
      origin = normalizeOrigin(originOrUrl).origin;
    } catch {
      return false;
    }
    const record = this.consent.get(origin);
    return record?.status === "granted" && record.screenshot === "granted";
  }

  private hasDiagnosticsConsent(originOrUrl: string): boolean {
    let origin: string;
    try {
      origin = normalizeOrigin(originOrUrl).origin;
    } catch {
      return false;
    }
    const record = this.consent.get(origin);
    return record?.status === "granted" && record.diagnostics === "granted";
  }

  private requireTeach(tab_id: string, url: string, detail?: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    if (!this.teachMode.active) return { ok: false, error: "teach_mode_required" };
    const origin = normalizeOrigin(url).origin;
    const popupContext = this.isTeachPopupContext(tab_id, detail);
    if (this.teachMode.tab_id !== tab_id && !popupContext) {
      return { ok: false, error: "teach_tab_mismatch" };
    }
    if (!popupContext && this.teachMode.origin !== origin) return { ok: false, error: "teach_origin_mismatch" };
    if (!this.hasOriginConsent(origin)) return { ok: false, error: "origin_consent_required" };
    const frameGate = this.requireFrameOriginConsent(origin, detail);
    if (!frameGate.ok) return frameGate;
    const popupGate = this.requirePopupOriginConsent(origin, detail);
    if (!popupGate.ok) return popupGate;
    return { ok: true };
  }

  private isTeachPopupContext(tab_id: string, detail: Record<string, unknown> | undefined): boolean {
    if (!detail || detail["popup_context"] !== true) return false;
    if (typeof detail["popup_tab_id"] === "string" && detail["popup_tab_id"] !== tab_id) return false;
    if (detail["opener_tab_id"] !== this.teachMode.tab_id) return false;
    if (typeof detail["opener_origin"] === "string" && detail["opener_origin"] !== this.teachMode.origin) return false;
    return true;
  }

  private normalizeSelectionOrigin(selection: BrowserSelection): { ok: true; origin: string } | { ok: false; error: string } {
    let origin: string;
    let claimedOrigin: string;
    try {
      origin = normalizeOrigin(selection.url).origin;
      claimedOrigin = normalizeOrigin(selection.origin).origin;
    } catch {
      return { ok: false, error: "invalid_event_origin" };
    }
    if (claimedOrigin !== origin) {
      return { ok: false, error: "selection_origin_mismatch" };
    }
    return { ok: true, origin };
  }

  private securityForUrl(url: string, detail?: Record<string, unknown>): BrowserTraceEvent["security"] {
    const security: NonNullable<BrowserTraceEvent["security"]> = {
      exact_origin_approved: this.hasOriginConsent(url),
      screenshot_approved: this.hasScreenshotConsent(url),
      diagnostics_approved: this.hasDiagnosticsConsent(url),
      auth_checkpoint_approved: this.hasAuthCheckpointAccess(url),
    };
    const frameOrigin = this.targetOriginFromDetail(detail, "frame_origin");
    if (frameOrigin) {
      security.frame_origin_approved = this.hasOriginConsent(frameOrigin);
      security.frame_screenshot_approved = this.hasScreenshotConsent(frameOrigin);
    }
    const popupOrigin = this.popupOriginFromDetail(detail);
    if (popupOrigin) {
      security.popup_origin_approved = this.hasOriginConsent(popupOrigin);
    }
    return security;
  }

  private detailWithTargetSecurity(url: string, detail: Record<string, unknown> | undefined): Record<string, unknown> {
    const next = { ...(detail ?? {}) };
    const pageOrigin = normalizeOrigin(url).origin;
    const frameOrigin = this.targetOriginFromDetail(next, "frame_origin");
    if (frameOrigin) {
      next["frame_origin"] = frameOrigin;
      next["frame_origin_approved"] = frameOrigin === pageOrigin || this.hasOriginConsent(frameOrigin);
      next["frame_screenshot_approved"] = frameOrigin === pageOrigin || this.hasScreenshotConsent(frameOrigin);
    }
    const popupOrigin = this.popupOriginFromDetail(next);
    if (popupOrigin) {
      next["popup_origin"] = popupOrigin;
      next["popup_origin_approved"] = popupOrigin === pageOrigin || this.hasOriginConsent(popupOrigin);
    }
    return next;
  }

  private requireFrameOriginConsent(pageOrigin: string, detail: Record<string, unknown> | undefined): { ok: true } | { ok: false; error: string } {
    const frameOrigin = this.targetOriginFromDetail(detail, "frame_origin");
    if (!frameOrigin || frameOrigin === pageOrigin) return { ok: true };
    if (!this.hasOriginConsent(frameOrigin)) return { ok: false, error: "frame_origin_consent_required" };
    return { ok: true };
  }

  private requirePopupOriginConsent(pageOrigin: string, detail: Record<string, unknown> | undefined): { ok: true } | { ok: false; error: string } {
    const popupOrigin = this.popupOriginFromDetail(detail);
    if (!popupOrigin || popupOrigin === pageOrigin) return { ok: true };
    if (!this.hasOriginConsent(popupOrigin)) return { ok: false, error: "popup_origin_consent_required" };
    return { ok: true };
  }

  private popupOriginFromDetail(detail: Record<string, unknown> | undefined): string | null {
    const popupUrlOrigin = this.targetOriginFromDetail(detail, "popup_url");
    if (popupUrlOrigin) return popupUrlOrigin;
    return this.targetOriginFromDetail(detail, "popup_origin");
  }

  private targetOriginFromDetail(detail: Record<string, unknown> | undefined, key: string): string | null {
    const raw = detail?.[key];
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    try {
      return normalizeOrigin(raw).origin;
    } catch {
      return null;
    }
  }

  private requireExplicitIntent(
    action: BrowserActionKind,
    detail: Record<string, unknown> | undefined
  ): { ok: true } | { ok: false; error: string } {
    if (action === "hover" && !this.hasExplicitHoverIntent(detail)) {
      return { ok: false, error: "explicit_hover_intent_required" };
    }
    if (action === "drag" && !this.hasDragModeIntent(detail)) {
      return { ok: false, error: "drag_mode_required" };
    }
    return { ok: true };
  }

  private hasExplicitHoverIntent(detail: Record<string, unknown> | undefined): boolean {
    if (!detail) return false;
    return detail["explicit_intent"] === true ||
      detail["alt_option_intent"] === true ||
      detail["modifier_key"] === "Alt" ||
      detail["modifier_key"] === "Option";
  }

  private hasDragModeIntent(detail: Record<string, unknown> | undefined): boolean {
    if (!detail) return false;
    return detail["drag_mode"] === true || detail["explicit_intent"] === true;
  }

  private originOrNull(url: string): string | null {
    try {
      return normalizeOrigin(url).origin;
    } catch {
      return null;
    }
  }

  private hasAuthCheckpointAccess(url: string): boolean {
    try {
      return authCheckpointManager.readiness(url, false).ready;
    } catch {
      return false;
    }
  }
}

export const browserBroker = new BrowserBroker();

function cloneWorkflowArtifact(artifact: BrowserWorkflowArtifact): BrowserWorkflowArtifact {
  return {
    workflow_id: artifact.workflow_id,
    workflow: artifact.workflow,
    events: artifact.events.map((event) => ({ ...event })),
    saved_at: artifact.saved_at,
  };
}
