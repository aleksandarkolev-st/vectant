"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Eye,
  FileCheck2,
  FileWarning,
  FolderLock,
  History,
  KeyRound,
  Pause,
  Play,
  PlugZap,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Unplug,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import "./local-support.css";

const DEFAULT_INVENTORY = [];

const DEFAULT_SENT_PAYLOADS = [];

const DEFAULT_BLOCKED_ITEMS = [];

const DEFAULT_ACTIVITY = [];

const DEFAULT_EXPORT_METADATA = {
  exported_by: "local_support_app",
  export_type: "scrubbed_activity_history",
  session_id: null,
  workspace_display: "No workspace selected",
  policy_version: null,
  scanner_version: null,
  raw_bodies_included: false,
  audit_chain_verified: null,
  audit_chain_head: null,
};

const DEFAULT_PORTS = [];

function buildOrgRestrictions(policy) {
  const previewDisabled = policy?.emergency_controls?.preview_gateway_disabled === true;
  const fastSupportEnabled = policy?.mvp?.fast_support_enabled === true;
  const fastSupportTtl = formatMinutes(policy?.mvp?.fast_support_ttl_minutes);
  return [
    ["Browser preview", policy ? (previewDisabled ? "Blocked by policy" : "Allowed by policy") : "Not reported", previewDisabled ? "bad" : policy ? "good" : "neutral", "Local app still requires a loopback approval"],
    ["Vectant AI page reading", "Blocked in MVP", "bad", "Browser preview never grants AI page access"],
    ["Support agent page reading", "Blocked in MVP", "bad", "Browser preview never grants support page access"],
    ["Fast Support", policy ? (fastSupportEnabled ? "Enabled by policy" : "Disabled by policy") : "Not reported", policy && fastSupportEnabled ? "warn" : "neutral", `Safe metadata only, with a ${fastSupportTtl === "Not reported" ? "policy-controlled" : fastSupportTtl} session TTL`],
    ["Minimum app version", policy?.min_app_version || "Not reported", policy ? "warn" : "neutral", policy ? "Older versions are denied" : "Cloud policy has not loaded"],
    ["Activity retention", formatRetention(policy), policy ? "warn" : "neutral", "Raw bodies are never stored in cloud audit"],
  ];
}

function formatMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes <= 0) return "Not reported";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatRetention(policy) {
  const days = policy?.retention?.local_activity_days;
  if (days === 0) return "No retention";
  if (!Number.isInteger(days) || days < 1) return "Not reported";
  return `${days} days`;
}

function buildSetupChecklist({ liveSession, liveWorkspace, livePolicy, liveState, pairingState, connected }) {
  const workspaceSelected = liveWorkspace.workspace_id && liveWorkspace.workspace_id !== "not_selected";
  const scanner = liveState?.scanner_version;
  return [
    ["Workspace chosen", workspaceSelected ? (liveWorkspace.display || "Selected workspace") : "No live local workspace selected"],
    ["Secret denylist active", scanner ? `Active, ${scanner}` : "Not reported by the local app"],
    ["Local policy mode", livePolicy ? (livePolicy.enabled ? "Enabled, fail closed" : "Disabled by cloud policy") : "Waiting for cloud policy"],
    ["Pairing consent", connected ? `Connected, ${liveSession.session_id || "session ID unavailable"}` : pairingState.status === "ready" ? "Fingerprint confirmation pending" : "Waiting for local app pairing"],
  ];
}

function buildPermissionModes({ fastSupportEnabled, connected, liveFastSupport, fastSupportTtl }) {
  return [
    {
      mode: "Balanced mode",
      status: connected ? "Active" : "Available after pairing",
      automatic: "Low-risk metadata only",
      approval: "Source, logs, and loopback preview",
      blocked: "Secrets, workspace writes, commands, AI/support page reads, persistent approvals",
      tone: connected ? "good" : "neutral",
    },
    {
      mode: "Manual mode",
      status: "Available after pairing",
      automatic: "Nothing",
      approval: "Every file, log, and port request",
      blocked: "Same local security denylist, writes, commands, and page reads",
      tone: "info",
    },
    {
      mode: "Fast Support",
      status: !fastSupportEnabled ? "Disabled by policy" : liveFastSupport ? "Active" : "Available after pairing",
      automatic: `Safe metadata only, one workspace, ${fastSupportTtl === "Not reported" ? "policy-controlled TTL" : `max ${fastSupportTtl}`}`,
      approval: "Source, logs, and loopback preview",
      blocked: "Secrets, writes, commands, response bodies, AI/support page reads, persistent approvals",
      tone: !fastSupportEnabled ? "bad" : liveFastSupport ? "warn" : "neutral",
    },
  ];
}

function normalizeInventoryRows(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object").map((item, index) => {
    const state = String(item.status || item.state || "").toLowerCase();
    const sent = item.sent === true || item.bytes_sent > 0 || state === "sent_to_vectant" || state === "delivered";
    const status = item.status || (
      state === "blocked_locally" || state === "denied" ? "Blocked locally" :
        sent ? "Sent to Vectant" :
          state === "approval_required" || state === "review_pending" ? "Review required" : "Available locally"
    );
    return {
      ...item,
      path: item.path || item.target || item.target_display || `item-${index + 1}`,
      type: item.type || item.classification || "Context",
      status,
      className: item.className || item.classification || "Unclassified",
      sent,
    };
  });
}

function Pill({ tone = "neutral", children }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium",
        tone === "good" && "border-[color-mix(in_srgb,var(--accent-success)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent-success)_10%,transparent)] text-[var(--accent-success)]",
        tone === "warn" && "border-[color-mix(in_srgb,var(--accent-warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent-warning)_10%,transparent)] text-[var(--accent-warning)]",
        tone === "bad" && "border-[color-mix(in_srgb,var(--accent-danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--accent-danger)_10%,transparent)] text-[var(--accent-danger)]",
        tone === "info" && "border-[color-mix(in_srgb,var(--attention-purple)_28%,transparent)] bg-[color-mix(in_srgb,var(--attention-purple)_10%,transparent)] text-[color-mix(in_srgb,var(--attention-purple)_78%,white)]",
        tone === "neutral" && "border-[var(--border-medium)] bg-[var(--bg-surface)] text-[var(--text-secondary)]",
      )}
    >
      {children}
    </span>
  );
}

function Panel({ title, description, action, children, className }) {
  return (
    <section className={cn("local-support-panel rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] shadow-[var(--depth-shadow-1)]", className)}>
      <div className="flex flex-col gap-3 border-b border-[var(--border-subtle)] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
          {description ? <p className="mt-1 max-w-[72ch] text-sm leading-6 text-[var(--text-muted)]">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  return (
    <div className="local-support-stat rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-4 shadow-[var(--depth-shadow-1)]">
      <div className="flex items-center justify-between gap-3">
        <Icon className={cn("size-4", tone || "text-zinc-300")} aria-hidden="true" />
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function DataTable({ columns, rows, renderRow }) {
  return (
    <div className="local-support-table overflow-x-auto rounded-md border border-[var(--border-subtle)]">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-[var(--bg-surface)] text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-4 py-3 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {rows.length > 0 ? (
            rows.map(renderRow)
          ) : (
            <tr>
              <td className="px-4 py-6 text-sm text-[var(--text-muted)]" colSpan={columns.length}>
                No live local support records yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CapabilityFlag({ label, enabled }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-sm">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <Pill tone={enabled ? "good" : "bad"}>{enabled ? "Allowed" : "Off"}</Pill>
    </div>
  );
}

export default function LocalSupportTransparency() {
  const [localPaused, setLocalPaused] = useState(false);
  const [localDisconnected, setLocalDisconnected] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [historyDeleted, setHistoryDeleted] = useState(false);
  const [lastExport, setLastExport] = useState(null);
  const [approvalsRevoked, setApprovalsRevoked] = useState(false);
  const [fastSupportActive, setFastSupportActive] = useState(false);
  const [revokedPorts, setRevokedPorts] = useState([]);
  const [controlActionStatus, setControlActionStatus] = useState(null);
  const [testRequestStatus, setTestRequestStatus] = useState(null);
  const [pairingState, setPairingState] = useState({
    status: "idle",
    challenge: null,
    error: null,
  });
  const [policyState, setPolicyState] = useState({
    status: "loading",
    policy: null,
    error: null,
  });
  const [transparencyState, setTransparencyState] = useState({
    status: "loading",
    state: null,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    async function loadPolicy() {
      try {
        const response = await fetch("/api/local-support/policy", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`policy_${response.status}`);
        }
        const policy = await response.json();
        if (!controller.signal.aborted) {
          setPolicyState({ status: "loaded", policy, error: null });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPolicyState({
            status: "error",
            policy: null,
            error: error instanceof Error ? error.message : "policy_unavailable",
          });
        }
      }
    }
    loadPolicy();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function loadTransparencyState() {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const response = await fetch("/api/local-support/transparency-state", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`transparency_state_${response.status}`);
        }
        const state = await response.json();
        if (!controller.signal.aborted) {
          setTransparencyState({ status: "loaded", state, error: null });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setTransparencyState({
            status: "error",
            state: null,
            error: error instanceof Error ? error.message : "transparency_state_unavailable",
          });
        }
      } finally {
        loading = false;
      }
    }
    loadTransparencyState();
    const interval = window.setInterval(loadTransparencyState, 3_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, []);

  const liveState = transparencyState.state;
  const liveSession = liveState?.session || {};
  const liveWorkspace = liveState?.workspace || {};
  const connected = Boolean(liveSession.connected) && !localDisconnected;
  const paused = Boolean(liveSession.paused || localPaused);
  const liveFastSupport = liveSession.permission_mode === "Fast Support"
    && Number(liveSession.fast_support_remaining_seconds || 0) > 0;
  const inventory = normalizeInventoryRows(liveState?.inventory || DEFAULT_INVENTORY);
  const sentPayloads = liveState?.sent_payloads || DEFAULT_SENT_PAYLOADS;
  const blockedItems = liveState?.blocked_items || DEFAULT_BLOCKED_ITEMS;
  const activity = liveState?.activity || DEFAULT_ACTIVITY;
  const ports = liveState?.ports || DEFAULT_PORTS;
  const redactionCount = sentPayloads.reduce((total, item) => total + Number(item.redactions || 0), 0);

  const sessionState = useMemo(() => {
    if (!connected) return { label: "Disconnected", tone: "bad", Icon: XCircle };
    if (paused) return { label: "Paused", tone: "warn", Icon: Pause };
    return { label: "Connected", tone: "good", Icon: CheckCircle2 };
  }, [connected, paused]);

  const SessionIcon = sessionState.Icon;
  const visibleActivity = historyDeleted ? [] : activity;
  const livePolicy = policyState.policy;
  const fastSupportEnabled = livePolicy?.mvp?.fast_support_enabled === true;
  const fastSupportTtl = formatMinutes(livePolicy?.mvp?.fast_support_ttl_minutes);
  const liveExportMetadata = {
    ...DEFAULT_EXPORT_METADATA,
    ...(liveState?.export_metadata || {}),
    policy_version: livePolicy?.policy_version || liveState?.policy_version || DEFAULT_EXPORT_METADATA.policy_version,
    scanner_version: liveState?.scanner_version || DEFAULT_EXPORT_METADATA.scanner_version,
  };
  const workspaceDisplay = liveWorkspace.display || "No workspace selected";
  const accountDisplay = liveSession.account_id || "Not paired";
  const sessionDisplay = liveSession.session_id || "Not paired";
  const orgRestrictions = buildOrgRestrictions(livePolicy);
  const setupChecklist = buildSetupChecklist({
    liveSession,
    liveWorkspace,
    livePolicy,
    liveState,
    pairingState,
    connected,
  });
  const permissionModes = buildPermissionModes({
    fastSupportEnabled,
    connected,
    liveFastSupport,
    fastSupportTtl,
  });
  const policyStatus = policyState.status === "loaded"
    ? livePolicy?.enabled
      ? { label: "Cloud policy enabled", tone: "good" }
      : { label: "Cloud policy disabled", tone: "warn" }
    : policyState.status === "error"
      ? { label: "Policy unavailable", tone: "warn" }
      : { label: "Checking policy", tone: "neutral" };
  const policyMessage = livePolicy?.user_visible_message
    || (policyState.status === "error"
      ? "Could not load cloud policy state. The local app must fail closed for requests."
      : "Loading cloud policy state without using cached data.");

  async function requestLocalControlAction(action, body = {}) {
    setControlActionStatus({ tone: "neutral", text: "Sending local control request..." });
    try {
      const response = await fetch("/api/local-support/transparency-action", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, ...body }),
      });
      const result = await response.json();
      if (!response.ok || result.decision === "denied") {
        throw new Error(result.user_visible_message || result.reason || "local_control_denied");
      }
      setControlActionStatus({
        tone: "good",
        text: result.user_visible_message || "Local control request accepted.",
      });
      return result;
    } catch (error) {
      setControlActionStatus({
        tone: "bad",
        text: error instanceof Error ? error.message : "Local control request failed.",
      });
      return null;
    }
  }

  async function startPairing() {
    setPairingState({ status: "loading", challenge: null, error: null });
    try {
      const browserSessionId = `browser_${crypto.randomUUID().replaceAll("-", "")}`;
      const selectedWorkspaceId = typeof liveWorkspace.workspace_id === "string"
        && liveWorkspace.workspace_id !== "not_selected"
        ? liveWorkspace.workspace_id
        : "wk_pending_local_selection";
      const response = await fetch("/api/local-support/pairing", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          account_id: "server_authenticated",
          org_id: livePolicy?.org_id || "org_personal",
          workspace_id: selectedWorkspaceId,
          browser_session_id: browserSessionId,
          requested_user_id: "server_authenticated",
        }),
      });
      const challenge = await response.json();
      if (!response.ok || challenge.decision !== "pairing_challenge_created") {
        throw new Error(challenge.user_visible_message || challenge.reason || "Pairing could not start.");
      }
      setPairingState({ status: "ready", challenge, error: null });
    } catch (error) {
      setPairingState({
        status: "error",
        challenge: null,
        error: error instanceof Error ? error.message : "Pairing could not start.",
      });
    }
  }

  async function createTestRequest() {
    setTestRequestStatus({ tone: "neutral", text: "Queueing a test file request..." });
    try {
      const response = await fetch("/api/local-support/test-request", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      });
      const result = await response.json();
      if (!response.ok || result.decision !== "test_request_queued") {
        throw new Error(result.user_visible_message || result.reason || "Test request could not be queued.");
      }
      setTestRequestStatus({ tone: "good", text: `${result.user_visible_message} Request: ${result.request_id}` });
    } catch (error) {
      setTestRequestStatus({ tone: "bad", text: error instanceof Error ? error.message : "Test request could not be queued." });
    }
  }

  async function togglePause() {
    const action = paused ? "resume_session" : "pause_session";
    const result = await requestLocalControlAction(action);
    if (result) setLocalPaused(!paused);
  }

  async function disconnectLocalSupport() {
    const result = await requestLocalControlAction("disconnect_session");
    if (result) {
      setLocalDisconnected(true);
      setLocalPaused(true);
      setApprovalsRevoked(true);
      setRevokedPorts(ports.map((item) => item.port));
    }
  }

  async function revokeSessionApprovals() {
    const result = await requestLocalControlAction("revoke_session_approvals");
    if (result) setApprovalsRevoked(true);
  }

  async function toggleFastSupport() {
    const enabling = !(fastSupportActive || liveFastSupport);
    const result = await requestLocalControlAction(enabling ? "enable_fast_support" : "disable_fast_support");
    if (result) setFastSupportActive(enabling);
  }

  async function revokePortApproval(port) {
    const result = await requestLocalControlAction("revoke_port", { port });
    if (result) setRevokedPorts((values) => Array.from(new Set([...values, port])));
  }

  async function exportScrubbedHistory() {
    const result = await requestLocalControlAction("export_history");
    if (result) setLastExport("Scrubbed history export requested from local product storage");
  }

  async function deleteLocalHistory() {
    const result = await requestLocalControlAction("delete_history");
    if (result) {
      setHistoryDeleted(true);
      setLastExport(null);
    }
  }

  return (
    <main className="local-support-surface min-h-[100dvh] bg-[var(--bg-app)] [font-family:var(--font-ui)] text-[var(--text-primary)]" data-testid="local-support-surface">
      <div className="local-support-header sticky top-0 z-30 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-app)_96%,transparent)] shadow-[var(--depth-shadow-1)] backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-[color-mix(in_srgb,var(--attention-purple)_28%,transparent)] bg-[color-mix(in_srgb,var(--attention-purple)_10%,transparent)] shadow-[var(--attention-rim)]">
              <ShieldCheck className="size-5 text-[color-mix(in_srgb,var(--attention-purple)_78%,white)]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold text-[var(--text-primary)]">Vectant Local Support</h1>
                <Pill tone={sessionState.tone}>
                  <SessionIcon className="size-3" aria-hidden="true" />
                  {sessionState.label}
                </Pill>
                <Pill tone={fastSupportActive || liveFastSupport ? "warn" : "neutral"}>
                  {fastSupportActive || liveFastSupport ? "Fast Support" : "Balanced mode"}
                </Pill>
                <Pill tone={policyStatus.tone}>{policyStatus.label}</Pill>
              </div>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Workspace: {workspaceDisplay}. Account: {accountDisplay}. Session: {sessionDisplay}.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-[var(--border-medium)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
              onClick={togglePause}
              disabled={!connected}
            >
              {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="bg-[var(--accent-danger)] text-[var(--bg-app)] hover:brightness-110"
              disabled={!connected}
              onClick={disconnectLocalSupport}
            >
              <Unplug className="size-4" aria-hidden="true" />
              Disconnect
            </Button>
          </div>
        </div>
      </div>

      {(fastSupportActive || liveFastSupport) ? (
        <div className="border-b border-amber-400/25 bg-amber-400/10 px-4 py-3 text-sm text-amber-100" role="status">
          <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 lg:px-2">
            <span><strong>Fast Support is active for this session.</strong> Safe metadata may be automatic; secrets stay blocked and source files, logs, ports, and response bodies still require approval.</span>
            <span className="font-mono text-xs">Expires in {Math.max(1, Math.ceil(Number(liveSession.fast_support_remaining_seconds || 30 * 60) / 60))} min</span>
          </div>
        </div>
      ) : null}

      <div className="mx-auto max-w-[1440px] px-4 py-6 lg:px-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
          <section className="local-support-hero rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-5 shadow-[var(--depth-shadow-1)]">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--text-muted)]">Control plane</p>
                <h2 className="mt-2 max-w-[24ch] text-2xl font-semibold leading-tight tracking-[-0.02em] text-[var(--text-primary)] md:text-3xl">
                  Local enforcement state.
                </h2>
                <p className="mt-3 max-w-[68ch] text-sm leading-6 text-[var(--text-muted)]">
                  Available locally is not the same as sent. Port capabilities are explicit and session-scoped. Redacted preview is not raw original.
                </p>
              </div>
              <div className="grid min-w-[260px] gap-2 text-sm">
                <div className="flex items-center justify-between rounded-md bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[var(--text-muted)]">App version gate</span>
                  <span className="text-right text-sm font-medium text-[var(--accent-warning)]">
                    {livePolicy?.min_app_version ? `Update required below ${livePolicy.min_app_version}` : "Not reported"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[var(--text-muted)]">AI and support page access</span>
                  <Pill tone="bad">Blocked in MVP</Pill>
                </div>
                <div className="flex items-center justify-between rounded-md bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[var(--text-muted)]">Shell commands</span>
                  <Pill tone="bad">Blocked</Pill>
                </div>
                <div className="flex items-center justify-between rounded-md bg-[var(--bg-surface)] px-3 py-2">
                  <span className="text-[var(--text-muted)]">File writes</span>
                  <Pill tone="bad">Blocked</Pill>
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <Stat icon={FileCheck2} label="Sent" value={String(sentPayloads.length)} tone="text-[var(--accent-success)]" />
            <Stat icon={Ban} label="Blocked" value={String(blockedItems.length)} tone="text-[var(--accent-danger)]" />
            <Stat icon={Eye} label="Ports" value={String(ports.length)} tone="text-[color-mix(in_srgb,var(--attention-purple)_72%,white)]" />
            <Stat icon={KeyRound} label="Redactions" value={String(redactionCount)} tone="text-[var(--accent-warning)]" />
          </section>
        </div>

        <Tabs defaultValue="overview" className="mt-5">
          <TabsList className="h-auto flex-wrap justify-start rounded-md border border-[var(--border-subtle)] bg-[var(--bg-panel)] p-1 shadow-[var(--depth-shadow-1)]">
            {[
              ["overview", ShieldCheck, "Overview"],
              ["inventory", FolderLock, "Inventory"],
              ["history", History, "Sent history"],
              ["blocked", FileWarning, "Blocked"],
              ["ports", PlugZap, "Ports"],
              ["mode", Settings2, "Permission mode"],
              ["activity", ClipboardCheck, "Activity"],
            ].map(([value, Icon, label]) => (
              <TabsTrigger key={value} value={value} className="rounded-sm px-3 text-[var(--text-secondary)] data-[state=active]:bg-[var(--bg-elevated)] data-[state=active]:text-[var(--text-primary)]">
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Panel
              className="lg:col-span-2"
              title="Pair this browser with the desktop app"
              description="The code expires quickly and can be used once. Compare the fingerprint in both places before confirming."
              action={(
                <Button
                  type="button"
                  size="sm"
                  onClick={startPairing}
                  disabled={pairingState.status === "loading" || connected || livePolicy?.enabled === false}
                >
                  <KeyRound className="size-4" aria-hidden="true" />
                  {pairingState.status === "loading" ? "Starting pairing" : "Start pairing"}
                </Button>
              )}
            >
              {pairingState.status === "ready" ? (
                <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)]">
                  <div className="rounded-lg border border-sky-400/20 bg-sky-400/[0.07] p-4">
                    <div className="text-xs uppercase tracking-[0.08em] text-sky-200">One-time code</div>
                    <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.16em] text-zinc-50">
                      {pairingState.challenge.code}
                    </div>
                    <p className="mt-2 text-xs text-sky-100/80">
                      Expires in {Math.max(1, Math.ceil(Number(pairingState.challenge.expires_in_seconds || 0) / 60))} minutes
                    </p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">Pairing fingerprint</div>
                    <div className="mt-2 font-mono text-lg font-semibold text-zinc-100">
                      {pairingState.challenge.fingerprint}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      Enter the code in Vectant Local Support. Confirm only if this fingerprint appears in the desktop app.
                    </p>
                  </div>
                </div>
              ) : pairingState.status === "error" ? (
                <p role="alert" className="text-sm text-red-200">{pairingState.error}</p>
              ) : (
                <p className="text-sm leading-6 text-zinc-400">
                  No pairing challenge is active. Starting one does not grant file, log, or localhost access.
                </p>
              )}
            </Panel>

            <Panel title="Session boundary" description="One support session, one selected workspace, short lived approvals, and immediate revoke controls.">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Device", liveSession.device_fingerprint || "Not paired", "No renderer access to device keys or preview tokens"],
                  ["Workspace", workspaceDisplay, "Pick one workspace in the desktop app before requests can proceed"],
                  ["Policy", liveExportMetadata.policy_version || "Not reported", "Deny on uncertainty"],
                  ["Scanner", liveExportMetadata.scanner_version || "Not reported", "Secrets blocked or redacted locally"],
                ].map(([label, value, detail]) => (
                  <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                    <div className="mt-2 font-medium text-zinc-100">{value}</div>
                    <div className="mt-1 text-sm text-zinc-400">{detail}</div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Cloud policy state"
              description="This is fetched live from the Local Support policy endpoint with no-store caching. The desktop app still makes the final local decision."
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">Policy route</div>
                  <div className="mt-2">
                    <Pill tone={policyStatus.tone}>{policyStatus.label}</Pill>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">{policyMessage}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">Live gates</div>
                  <dl className="mt-3 grid gap-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-zinc-400">Minimum app version</dt>
                      <dd className="font-mono text-xs text-zinc-200">{livePolicy?.min_app_version || "Not reported"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-zinc-400">Policy version</dt>
                      <dd className="font-mono text-xs text-zinc-200">{liveExportMetadata.policy_version || "Not reported"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-zinc-400">Retention</dt>
                      <dd className="font-mono text-xs text-zinc-200">
                        {formatRetention(livePolicy)}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            </Panel>

            <Panel
              title="Organization restrictions"
              description="Browser preview is available only through an explicit session-scoped loopback grant. AI and support-agent page reads remain blocked in the MVP."
            >
              <div className="space-y-3">
                {orgRestrictions.map(([label, value, tone, detail]) => (
                  <div key={label} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
                    <span className="text-zinc-400">{label}</span>
                    <span className="flex flex-col items-end gap-1 text-right">
                      <Pill tone={tone}>{value}</Pill>
                      {detail ? <span className={cn("text-xs", tone === "bad" ? "text-red-200" : "text-amber-200")}>{detail}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Workspace selection"
              description="Installation is not consent. Vectant can only request context from the selected workspace, and sensitive paths remain blocked inside it."
              action={<Pill tone="warn">Waiting</Pill>}
            >
              <div className="grid gap-3">
                {setupChecklist.map(([label, value]) => (
                  <div key={label} className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-sm font-medium text-zinc-200">{label}</span>
                    <span className="font-mono text-xs text-zinc-400 sm:text-right">{value}</span>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Review before send"
              description="Approvals appear here only after the local app classifies a real request."
              action={(
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="neutral">No queued approvals</Pill>
                  <Button type="button" size="sm" variant="outline" onClick={createTestRequest} disabled={!connected}>
                    Create test request
                  </Button>
                </div>
              )}
            >
              {reviewOpen ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-zinc-400" aria-hidden="true" />
                      <div>
                        <div className="font-medium text-zinc-100">No live approval request</div>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">
                          When a file, log, or port request arrives, the desktop app must show the real target, classification, hash, redactions, actor, and reason before anything can leave this computer.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" className="bg-emerald-300 text-zinc-950 hover:bg-emerald-200" onClick={() => setReviewOpen(false)} disabled>
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Send redacted
                    </Button>
                    <Button type="button" variant="outline" className="border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]" onClick={() => setReviewOpen(false)} disabled>
                      <XCircle className="size-4" aria-hidden="true" />
                      Deny
                    </Button>
                  </div>
                  {testRequestStatus ? <p className={`text-sm ${testRequestStatus.tone === "bad" ? "text-red-300" : testRequestStatus.tone === "good" ? "text-emerald-300" : "text-zinc-400"}`} role="status">{testRequestStatus.text}</p> : null}
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-300">
                  <CheckCircle2 className="size-5 text-emerald-200" aria-hidden="true" />
                  Review closed.
                </div>
              )}
            </Panel>
          </TabsContent>

          <TabsContent value="inventory" className="mt-4">
            <Panel title="Context inventory" description="These items are visible to the local app. Only rows marked sent have left the machine.">
              <DataTable
                columns={["Path", "Type", "Status", "Class", "Sent"]}
                rows={inventory}
                renderRow={(item) => (
                  <tr key={item.path} className="text-zinc-300">
                    <td className="px-4 py-3 font-mono text-xs">{item.path}</td>
                    <td className="px-4 py-3">{item.type}</td>
                    <td className="px-4 py-3">
                      <Pill tone={String(item.status || "").includes("Blocked") ? "bad" : item.sent ? "good" : "warn"}>{item.status || "Unknown"}</Pill>
                    </td>
                    <td className="px-4 py-3">{item.className}</td>
                    <td className="px-4 py-3">{item.sent ? "Yes" : "No"}</td>
                  </tr>
                )}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <Panel title="Sent payload history" description="Every sent payload records actor, reason, classification, byte count, scanner version, and content hash.">
              <DataTable
                columns={["Request", "Actor", "Target", "Bytes", "Redactions", "Reason", "Time"]}
                rows={sentPayloads}
                renderRow={(item) => (
                  <tr key={item.id} className="text-zinc-300">
                    <td className="px-4 py-3 font-mono text-xs">{item.id}</td>
                    <td className="px-4 py-3">{item.actor}</td>
                    <td className="px-4 py-3 font-mono text-xs">{item.target}</td>
                    <td className="px-4 py-3">{item.bytes}</td>
                    <td className="px-4 py-3">{item.redactions}</td>
                    <td className="px-4 py-3">{item.reason}</td>
                    <td className="px-4 py-3 font-mono text-xs">{item.at}</td>
                  </tr>
                )}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="blocked" className="mt-4">
            <Panel title="Blocked sensitive items" description="Denied requests are user-visible, logged, and send zero bytes.">
              <DataTable
                columns={["Target", "Reason", "Class", "Bytes sent", "Time"]}
                rows={blockedItems}
                renderRow={(item) => (
                  <tr key={`${item.target}-${item.at}`} className="text-zinc-300">
                    <td className="px-4 py-3 font-mono text-xs">{item.target}</td>
                    <td className="px-4 py-3">{item.reason}</td>
                    <td className="px-4 py-3">{item.className}</td>
                    <td className="px-4 py-3">0</td>
                    <td className="px-4 py-3 font-mono text-xs">{item.at}</td>
                  </tr>
                )}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="ports" className="mt-4">
            <Panel title="Local ports" description="Manual approval only. Each port can grant browser, AI, support, interaction, response-body, and state-changing method capabilities for this session.">
              <div className="grid gap-4">
                {ports.length === 0 ? (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
                    No local ports are approved. Browser preview stays unavailable until the desktop app binds a real port approval to this session, host, token, and process identity.
                  </div>
                ) : ports.map((item) => {
                  const revoked = revokedPorts.includes(item.port);
                  return (
                    <div key={item.port} className="rounded-lg border border-white/10 bg-zinc-950/70">
                      <div className="grid gap-4 border-b border-white/10 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-mono text-sm font-semibold text-zinc-100">
                              {item.targetHost}:{item.port}
                            </h3>
                            <Pill tone={revoked ? "bad" : "good"}>{revoked ? "Revoked" : "Approved"}</Pill>
                            <Pill tone="neutral">{item.ttl}</Pill>
                          </div>
                          <p className="mt-2 text-sm text-zinc-400">{item.service}</p>
                          <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                            <div className="rounded-md bg-white/[0.03] px-3 py-2">
                              <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">Preview host</div>
                              <div className="mt-1 break-all font-mono text-xs text-zinc-300">{item.previewHost}</div>
                            </div>
                            <div className="rounded-md bg-white/[0.03] px-3 py-2">
                              <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">Process binding</div>
                              <div className="mt-1 font-mono text-xs text-zinc-300">{item.processHash}</div>
                            </div>
                          </div>
                        </div>
                        <div className="grid content-start gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            className="justify-start bg-red-500/90 text-zinc-950 hover:bg-red-400"
                            onClick={() => revokePortApproval(item.port)}
                            disabled={revoked}
                          >
                            <Unplug className="size-4" aria-hidden="true" />
                            Revoke port approval
                          </Button>
                          <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-400">
                            Revoke invalidates the host and preview token for this session.
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                        <div>
                          <div className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-500">Capability flags</div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <CapabilityFlag label="Browser preview for me" enabled={!revoked && item.browser} />
                            <CapabilityFlag label="Vectant AI can read page" enabled={!revoked && item.aiRead} />
                            <CapabilityFlag label="Support agent can read page" enabled={!revoked && item.supportRead} />
                            <CapabilityFlag label="Vectant AI can click" enabled={!revoked && item.aiInteract} />
                            <CapabilityFlag label="Send response bodies" enabled={!revoked && item.responseBodies} />
                            <CapabilityFlag label="Send screenshots" enabled={!revoked && item.screenshots} />
                            <CapabilityFlag label="Console and network summaries" enabled={!revoked && item.consoleNetwork} />
                            <CapabilityFlag label="Persistent approval" enabled={!revoked && item.persistent} />
                          </div>
                        </div>

                        <div>
                          <div className="mb-2 text-xs uppercase tracking-[0.08em] text-zinc-500">Bridge limits</div>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {[
                              ["Allowed methods", item.methods],
                              ["Request rate", item.requestRate],
                              ["Response size", item.responseLimit],
                              ["Preview token", revoked ? "Revoked" : "Present, hidden from renderer"],
                              ["Credential headers", "Cookie and Authorization stripped"],
                              ["Redirects", "Approved loopback targets only; private, LAN, and link-local targets blocked"],
                              ["Service workers", "Blocked"],
                              ["Cache and referrer", "No-store, no-referrer"],
                            ].map(([label, value]) => (
                              <div key={label} className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
                                <div className="text-xs uppercase tracking-[0.08em] text-zinc-500">{label}</div>
                                <div className="mt-1 text-sm text-zinc-300">{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </TabsContent>

          <TabsContent value="mode" className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Panel title="Permission mode" description={`Fast Support is a bounded convenience mode: one workspace, safe metadata only, and ${fastSupportTtl === "Not reported" ? "a policy-controlled TTL" : `up to ${fastSupportTtl}`}. Source files, logs, ports, and response bodies remain review-gated.`}>
              <DataTable
                columns={["Mode", "Status", "Automatic", "Requires approval", "Blocked"]}
                rows={permissionModes}
                renderRow={(item) => (
                  <tr key={item.mode} className="text-zinc-300">
                    <td className="px-4 py-3 font-medium text-zinc-100">{item.mode}</td>
                    <td className="px-4 py-3"><Pill tone={item.tone}>{item.status}</Pill></td>
                    <td className="px-4 py-3">{item.automatic}</td>
                    <td className="px-4 py-3">{item.approval}</td>
                    <td className="px-4 py-3">{item.blocked}</td>
                  </tr>
                )}
              />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-4">
                <div>
                  <div className="font-medium text-amber-100">{fastSupportActive || liveFastSupport ? "Fast Support is active" : "Enable Fast Support for this session"}</div>
                  <p className="mt-1 max-w-[70ch] text-sm leading-6 text-amber-100/80">Automatically shares safe project metadata for the selected workspace. Secrets, source, logs, writes, commands, repo uploads, and persistent approvals remain blocked or approval-gated.</p>
                </div>
                <Button type="button" variant={fastSupportActive || liveFastSupport ? "outline" : "default"} disabled={!connected || !fastSupportEnabled || paused} onClick={toggleFastSupport}>
                  {fastSupportActive || liveFastSupport ? "Switch to Balanced" : "Enable Fast Support"}
                </Button>
              </div>
            </Panel>

            <Panel title="Approval controls" description="Revoking approvals forces every future send or preview request back through local review.">
              <div className="grid gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  onClick={revokeSessionApprovals}
                  disabled={!connected}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Revoke session approvals
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="justify-start bg-red-500/90 text-zinc-950 hover:bg-red-400"
                  onClick={disconnectLocalSupport}
                  disabled={!connected}
                >
                  <Unplug className="size-4" aria-hidden="true" />
                  Disconnect and revoke
                </Button>
                <div className={cn(
                  "rounded-lg border px-3 py-2 text-sm",
                  approvalsRevoked
                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                    : "border-white/10 bg-white/[0.03] text-zinc-400",
                )}>
                  {approvalsRevoked
                    ? "Session approvals revoked. Future sends require review."
                    : connected
                      ? "No live approvals are active."
                      : "Connect the desktop app before revoking approvals. This page will not fake a revoke."}
                </div>
                {controlActionStatus ? (
                  <div className={cn(
                    "rounded-lg border px-3 py-2 text-sm",
                    controlActionStatus.tone === "good" && "border-emerald-400/20 bg-emerald-400/10 text-emerald-100",
                    controlActionStatus.tone === "bad" && "border-red-400/20 bg-red-400/10 text-red-100",
                    controlActionStatus.tone === "neutral" && "border-white/10 bg-white/[0.03] text-zinc-400",
                  )}>
                    {controlActionStatus.text}
                  </div>
                ) : null}
              </div>
            </Panel>
          </TabsContent>

          <TabsContent value="activity" className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Panel title="Activity log" description="User-facing events include denied requests, redactions, approvals, pause, disconnect, export, and delete actions.">
              <div className="space-y-3">
                {visibleActivity.map((item) => (
                  <div key={`${item.at}-${item.text}`} className="flex gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                    <span className="font-mono text-xs text-zinc-500">{item.at}</span>
                    <div>
                      <Pill tone={item.kind === "Denied" ? "bad" : item.kind === "Redaction" ? "warn" : "info"}>{item.kind}</Pill>
                      <p className="mt-2 text-sm text-zinc-300">{item.text}</p>
                    </div>
                  </div>
                ))}
                {historyDeleted ? (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">Local activity history deleted.</div>
                ) : null}
                {!historyDeleted && visibleActivity.length === 0 ? (
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">
                    No live local support activity has been recorded.
                  </div>
                ) : null}
              </div>
            </Panel>
            <Panel title="Local history controls" description="Exports are scrubbed. Delete requires a live desktop app storage action.">
              <div className="grid gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  onClick={exportScrubbedHistory}
                  disabled={!connected}
                >
                  <Download className="size-4" aria-hidden="true" />
                  Export current scrubbed view
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  disabled={!historyDeleted}
                  onClick={() => {
                    setHistoryDeleted(false);
                    setLastExport(null);
                  }}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Restore local history view
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="justify-start bg-red-500/90 text-zinc-950 hover:bg-red-400"
                  disabled={!connected}
                  onClick={deleteLocalHistory}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete local history
                </Button>
                {lastExport ? (
                  <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
                    {lastExport}
                  </div>
                ) : null}
                {!connected ? (
                  <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                    Connect the desktop app before exporting or deleting local activity. This page will not fake local storage actions.
                  </div>
                ) : null}
                {controlActionStatus ? (
                  <div className={cn(
                    "rounded-lg border px-3 py-2 text-sm",
                    controlActionStatus.tone === "good" && "border-emerald-400/20 bg-emerald-400/10 text-emerald-100",
                    controlActionStatus.tone === "bad" && "border-red-400/20 bg-red-400/10 text-red-100",
                    controlActionStatus.tone === "neutral" && "border-white/10 bg-white/[0.03] text-zinc-400",
                  )}>
                    {controlActionStatus.text}
                  </div>
                ) : null}
              </div>
            </Panel>
          </TabsContent>

        </Tabs>
      </div>
    </main>
  );
}
