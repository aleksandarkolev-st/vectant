export type BrowserPermissionTier =
  | "attached"
  | "origin_consent"
  | "snapshot"
  | "teach"
  | "control";

export type BrowserConsentStatus = "granted" | "denied" | "unset";

export type BrowserActionKind =
  | "click"
  | "fill"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "navigate"
  | "wait";

export interface BrowserOrigin {
  scheme: string;
  host: string;
  port: string;
  origin: string;
}

export interface BrowserTab {
  tab_id: string;
  target_id?: string;
  extension_tab_id?: number;
  url: string;
  title?: string;
  active: boolean;
  opener_tab_id?: string;
}

export interface BrowserFrameRef {
  frame_id: string;
  parent_frame_id?: string;
  url: string;
}

export interface BrowserConsentRecord {
  origin: string;
  status: BrowserConsentStatus;
  screenshot: BrowserConsentStatus;
  diagnostics: BrowserConsentStatus;
  granted_at?: number;
  denied_at?: number;
  revoked_at?: number;
  reason?: string;
}

export interface BrowserLease {
  lease_id: string;
  owner: string;
  acquired_at: number;
  expires_at: number;
  lease_ms: number;
  reason?: string;
  revoked?: boolean;
}

export interface LocatorCandidate {
  kind: "role" | "label" | "placeholder" | "test_id" | "text" | "css" | "xpath";
  locator: string;
  confidence: number;
  reason: string;
}

export interface BrowserElementMetadata {
  tag?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  test_id?: string;
  text?: string;
  id?: string;
  class_name?: string;
  css?: string;
  xpath?: string;
  type?: string;
}

export interface BrowserSelection {
  tab_id: string;
  frame_id?: string;
  url: string;
  origin: string;
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  element?: BrowserElementMetadata;
}

export interface BrowserTraceEvent {
  event_id: string;
  trace_id: string;
  trace_version: number;
  event_seq: number;
  ts: number;
  tab_id: string;
  frame_id?: string;
  origin: string;
  url: string;
  kind: "human_action" | "agent_action" | "selection" | "navigation" | "console" | "network";
  action?: BrowserActionKind;
  selector?: string;
  locator_candidates?: LocatorCandidate[];
  value?: string;
  redacted?: boolean;
  detail?: Record<string, unknown>;
  security?: {
    exact_origin_approved: boolean;
    screenshot_approved: boolean;
    diagnostics_approved: boolean;
    auth_checkpoint_approved: boolean;
  };
}

export interface BrowserSnapshot {
  tab_id: string;
  url: string;
  origin: string;
  title?: string;
  screenshot_base64?: string;
  dom?: Record<string, unknown>;
  console?: BrowserTraceEvent[];
  network?: BrowserTraceEvent[];
}
