"use client";

import { useMemo, useState } from "react";
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
import {
  RED_TEAM_SCENARIOS,
  RELEASE_BLOCKERS,
  UX_ACCEPTANCE_PROMPTS,
  summarizeLocalSupportReleaseReadiness,
} from "@/lib/local-support/acceptance";
import { cn } from "@/lib/utils";

const inventory = [
  { path: "src/App.tsx", type: "Source", status: "Available locally", className: "L2", sent: false },
  { path: "package.json", type: "Dependency metadata", status: "Sent to Vectant", className: "L1", sent: true },
  { path: "vite.config.ts", type: "Config", status: "Awaiting review", className: "L2", sent: false },
  { path: ".env", type: "Secret file", status: "Blocked locally", className: "L4", sent: false },
  { path: ".aws/credentials", type: "Cloud credentials", status: "Blocked locally", className: "L5", sent: false },
];

const sentPayloads = [
  {
    id: "req_pkg_91",
    actor: "Vectant AI",
    target: "package.json",
    bytes: "2.9 KB",
    className: "L1",
    redactions: 0,
    reason: "Identify package manager and scripts",
    at: "12:42:18",
  },
  {
    id: "req_log_18",
    actor: "Support agent",
    target: "dev-server.log",
    bytes: "4.1 KB redacted",
    className: "L3",
    redactions: 2,
    reason: "Review startup failure",
    at: "12:44:03",
  },
];

const blockedItems = [
  { target: ".env", reason: "blocked_secret_file_pattern", className: "L4", at: "12:45:12" },
  { target: "../.ssh/id_ed25519", reason: "path_outside_workspace", className: "L5", at: "12:46:40" },
  { target: "http://169.254.169.254/latest/meta-data/", reason: "preview_redirect_blocked", className: "L5", at: "12:48:07" },
];

const activity = [
  { kind: "Control", text: "Paired browser session with fingerprint 7f2a-b83c-19d4.", at: "12:40:02" },
  { kind: "Data", text: "Sent package.json after local policy allowed metadata sharing.", at: "12:42:18" },
  { kind: "Redaction", text: "Redacted authorization_header and database_url from dev-server.log.", at: "12:44:03" },
  { kind: "Denied", text: "Blocked .env. Nothing was sent to Vectant.", at: "12:45:12" },
  { kind: "Preview", text: "Approved browser preview for localhost:5173. AI page reading remains off.", at: "12:47:31" },
];

const exportMetadata = {
  exported_by: "local_support_app",
  export_type: "scrubbed_activity_history",
  session_id: "sess_7K9",
  workspace_display: "vectant-demo",
  policy_version: "2026.07.05",
  scanner_version: "scanner-2026.07.05",
  raw_bodies_included: false,
};

const orgRestrictions = [
  ["Browser preview", "Allowed", "good", null],
  ["Vectant AI page reading", "Blocked", "bad", "Blocked by organization"],
  ["Support agent page reading", "Blocked", "bad", "Blocked by organization"],
  ["Fast Support", "Disabled", "bad", "Disabled for MVP"],
  ["Minimum app version", "Required", "warn", "0.1.0 required"],
  ["Activity retention", "Limited", "warn", "30 days, raw bodies never stored"],
];

const setupChecklist = [
  ["Workspace chosen", "C:\\Users\\alex\\projects\\vectant-demo"],
  ["Secret denylist active", ".env, SSH, cloud, kube, keychain patterns"],
  ["Local policy mode", "Balanced, with source and logs review-gated"],
  ["Pairing consent", "Only this browser session and account"],
];

const permissionModes = [
  {
    mode: "Balanced mode",
    status: "Active",
    automatic: "Low-risk metadata only",
    approval: "Source, logs, port preview",
    blocked: "Secrets, writes, commands, agent page reading",
    tone: "good",
  },
  {
    mode: "Manual mode",
    status: "Available",
    automatic: "Nothing",
    approval: "Every file, log, and port",
    blocked: "Same security denylist",
    tone: "info",
  },
  {
    mode: "Fast Support",
    status: "Disabled",
    automatic: "Not available in MVP",
    approval: "Requires separate security review",
    blocked: "Auto-send, broad repo upload, persistent approvals",
    tone: "bad",
  },
];

const ports = [
  {
    port: 5173,
    service: "Vite dev server",
    targetHost: "127.0.0.1",
    previewHost: "br-local-p5173.vectant-preview.dev",
    process: "vite dev server",
    processHash: "sha256:9c4f...b812",
    ttl: "Current session only",
    token: "Short lived preview token",
    requestRate: "60 requests per minute",
    responseLimit: "5 MB hard cap",
    browser: true,
    aiRead: false,
    supportRead: false,
    aiInteract: false,
    responseBodies: false,
    screenshots: false,
    consoleNetwork: false,
    persistent: false,
    methods: "GET, HEAD, OPTIONS",
  },
];

function Pill({ tone = "neutral", children }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium",
        tone === "good" && "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
        tone === "warn" && "border-amber-400/25 bg-amber-400/10 text-amber-200",
        tone === "bad" && "border-red-400/25 bg-red-400/10 text-red-200",
        tone === "info" && "border-sky-400/25 bg-sky-400/10 text-sky-200",
        tone === "neutral" && "border-white/10 bg-white/[0.04] text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}

function Panel({ title, description, action, children, className }) {
  return (
    <section className={cn("rounded-lg border border-white/10 bg-zinc-950/62", className)}>
      <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          {description ? <p className="mt-1 max-w-[72ch] text-sm leading-6 text-zinc-400">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  return (
    <div className="rounded-lg border border-white/10 bg-zinc-900/55 p-4">
      <div className="flex items-center justify-between gap-3">
        <Icon className={cn("size-4", tone || "text-zinc-300")} aria-hidden="true" />
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-zinc-500">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold text-zinc-50">{value}</div>
    </div>
  );
}

function DataTable({ columns, rows, renderRow }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.08em] text-zinc-500">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-4 py-3 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );
}

function CapabilityFlag({ label, enabled }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
      <span className="text-zinc-300">{label}</span>
      <Pill tone={enabled ? "good" : "bad"}>{enabled ? "Allowed" : "Off"}</Pill>
    </div>
  );
}

export default function LocalSupportTransparency() {
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [historyDeleted, setHistoryDeleted] = useState(false);
  const [lastExport, setLastExport] = useState(null);
  const [approvalsRevoked, setApprovalsRevoked] = useState(false);
  const [revokedPorts, setRevokedPorts] = useState([]);

  const sessionState = useMemo(() => {
    if (!connected) return { label: "Disconnected", tone: "bad", Icon: XCircle };
    if (paused) return { label: "Paused", tone: "warn", Icon: Pause };
    return { label: "Connected", tone: "good", Icon: CheckCircle2 };
  }, [connected, paused]);

  const SessionIcon = sessionState.Icon;
  const visibleActivity = historyDeleted ? [] : activity;
  const releaseReadiness = summarizeLocalSupportReleaseReadiness();
  const ciRequiredBlockers = RELEASE_BLOCKERS.filter((item) => item.status === "ci_required");

  function exportScrubbedHistory() {
    const payload = {
      ...exportMetadata,
      exported_at: new Date().toISOString(),
      events: visibleActivity.map((item) => ({
        at: item.at,
        class: item.kind,
        summary: item.text,
        user_visible: true,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vectant-local-support-history-${exportMetadata.session_id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setLastExport(`${payload.events.length} scrubbed events exported`);
  }

  return (
    <main className="min-h-[100dvh] bg-[oklch(0.12_0.01_270)] text-zinc-100">
      <div className="sticky top-0 z-30 border-b border-white/10 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-400/10">
              <ShieldCheck className="size-5 text-emerald-200" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold text-zinc-50">Vectant Local Support</h1>
                <Pill tone={sessionState.tone}>
                  <SessionIcon className="size-3" aria-hidden="true" />
                  {sessionState.label}
                </Pill>
                <Pill tone="neutral">Balanced mode</Pill>
              </div>
              <p className="mt-1 text-sm text-zinc-400">
                Workspace: C:\Users\alex\projects\vectant-demo. Account: alex@vectant.dev. Session: sess_7K9.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
              onClick={() => setPaused((value) => !value)}
              disabled={!connected}
            >
              {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="bg-red-500/90 text-zinc-950 hover:bg-red-400"
              onClick={() => {
                setConnected(false);
                setPaused(true);
              }}
            >
              <Unplug className="size-4" aria-hidden="true" />
              Disconnect
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1440px] px-4 py-6 lg:px-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
          <section className="rounded-lg border border-white/10 bg-zinc-950/70 p-5">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.12em] text-emerald-300">Local enforcement first</p>
                <h2 className="mt-3 max-w-[18ch] text-4xl font-semibold leading-[1.02] text-zinc-50 md:text-5xl">
                  You control what Vectant can see.
                </h2>
                <p className="mt-4 max-w-[68ch] text-sm leading-6 text-zinc-400">
                  Available locally is not the same as sent. Browser preview is not AI page reading. Redacted preview is not raw original.
                </p>
              </div>
              <div className="grid min-w-[260px] gap-2 text-sm">
                <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2">
                  <span className="text-zinc-400">App version gate</span>
                  <span className="text-right text-sm font-medium text-amber-200">Update required below 0.1.0</span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2">
                  <span className="text-zinc-400">AI page reading remains off</span>
                  <Pill tone="bad">Off</Pill>
                </div>
                <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2">
                  <span className="text-zinc-400">Shell commands</span>
                  <Pill tone="bad">Blocked</Pill>
                </div>
                <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-3 py-2">
                  <span className="text-zinc-400">File writes</span>
                  <Pill tone="bad">Blocked</Pill>
                </div>
              </div>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <Stat icon={FileCheck2} label="Sent" value="2" tone="text-emerald-200" />
            <Stat icon={Ban} label="Blocked" value="3" tone="text-red-200" />
            <Stat icon={Eye} label="Ports" value="1" tone="text-sky-200" />
            <Stat icon={KeyRound} label="Redactions" value="2" tone="text-amber-200" />
          </section>
        </div>

        <Tabs defaultValue="overview" className="mt-5">
          <TabsList className="h-auto flex-wrap justify-start rounded-lg border border-white/10 bg-zinc-950 p-1">
            {[
              ["overview", ShieldCheck, "Overview"],
              ["inventory", FolderLock, "Inventory"],
              ["history", History, "Sent history"],
              ["blocked", FileWarning, "Blocked"],
              ["ports", PlugZap, "Ports"],
              ["mode", Settings2, "Permission mode"],
              ["activity", ClipboardCheck, "Activity"],
              ["release", ShieldCheck, "Release gate"],
            ].map(([value, Icon, label]) => (
              <TabsTrigger key={value} value={value} className="rounded-md px-3 text-zinc-300 data-[state=active]:bg-white/[0.08]">
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview" className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
            <Panel title="Session boundary" description="One support session, one selected workspace, short lived approvals, and immediate revoke controls.">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Device", "DESKTOP-7K9Q", "Paired with fingerprint 7f2a-b83c-19d4"],
                  ["Workspace", "vectant-demo", "Canonical path checked before every read"],
                  ["Policy", "2026.07.05", "Deny on uncertainty"],
                  ["Scanner", "scanner-2026.07.05", "Secrets blocked or redacted locally"],
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
              title="Organization restrictions"
              description="Your organization allows browser preview but blocks Vectant AI and support agents from reading local page contents."
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
              action={<Pill tone="good">Selected</Pill>}
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
              description="This approval has a redacted preview. Raw secrets never leave this computer."
              action={<Pill tone="warn">Approval required</Pill>}
            >
              {reviewOpen ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-200" aria-hidden="true" />
                      <div>
                        <div className="font-medium text-amber-100">Support agent wants dev-server.log</div>
                        <p className="mt-1 text-sm leading-6 text-amber-100/75">
                          Local Support found and redacted 2 possible secrets. Approving sends only the redacted preview.
                        </p>
                      </div>
                    </div>
                  </div>
                  <pre className="max-h-44 overflow-auto rounded-lg border border-white/10 bg-zinc-950 p-4 text-xs leading-6 text-zinc-300">
{`[12:43:10] GET /api/start
Authorization: [REDACTED:authorization_header]
DATABASE_URL=[REDACTED:database_url]
Error: module failed to resolve`}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" className="bg-emerald-300 text-zinc-950 hover:bg-emerald-200" onClick={() => setReviewOpen(false)}>
                      <CheckCircle2 className="size-4" aria-hidden="true" />
                      Send redacted
                    </Button>
                    <Button type="button" variant="outline" className="border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]" onClick={() => setReviewOpen(false)}>
                      <XCircle className="size-4" aria-hidden="true" />
                      Deny
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-300">
                  <CheckCircle2 className="size-5 text-emerald-200" aria-hidden="true" />
                  Review closed for this mock session.
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
                      <Pill tone={item.status.includes("Blocked") ? "bad" : item.sent ? "good" : "warn"}>{item.status}</Pill>
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
            <Panel title="Local ports" description="Manual approval only. Preview is browser-only unless a separate future security review enables AI read.">
              <div className="grid gap-4">
                {ports.map((item) => {
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
                            onClick={() => setRevokedPorts((values) => Array.from(new Set([...values, item.port])))}
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
                              ["Preview token", revoked ? "Revoked" : item.token],
                              ["Credential headers", "Cookie and Authorization stripped"],
                              ["Redirects", "Loopback only, private network blocked"],
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
            <Panel title="Permission mode" description="Balanced is the default for MVP. Manual mode is stricter. Fast Support is disabled until a separate security review approves it.">
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
            </Panel>

            <Panel title="Approval controls" description="Revoking approvals forces every future send or preview request back through local review.">
              <div className="grid gap-3">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  onClick={() => setApprovalsRevoked(true)}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Revoke session approvals
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="justify-start bg-red-500/90 text-zinc-950 hover:bg-red-400"
                  onClick={() => {
                    setConnected(false);
                    setPaused(true);
                    setApprovalsRevoked(true);
                  }}
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
                  {approvalsRevoked ? "Session approvals revoked. Future sends require review." : "No approvals revoked in this mock session."}
                </div>
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
                  <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-zinc-400">Local activity history deleted for this mock session.</div>
                ) : null}
              </div>
            </Panel>
            <Panel title="Local history controls" description="Exports are scrubbed. Delete removes local activity records for the completed session.">
              <div className="grid gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  onClick={exportScrubbedHistory}
                >
                  <Download className="size-4" aria-hidden="true" />
                  Export scrubbed history
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]"
                  onClick={() => {
                    setHistoryDeleted(false);
                    setLastExport(null);
                  }}
                >
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Restore demo history
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  className="justify-start bg-red-500/90 text-zinc-950 hover:bg-red-400"
                  onClick={() => {
                    setHistoryDeleted(true);
                    setLastExport(null);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete local history
                </Button>
                {lastExport ? (
                  <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
                    {lastExport}
                  </div>
                ) : null}
              </div>
            </Panel>
          </TabsContent>

          <TabsContent value="release" className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Panel
              title="Release blocker evidence"
              description="Every blocker from the security transparency plan is mapped to code, tests, UI proof, CI gates, or release packaging evidence."
            >
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat icon={ClipboardCheck} label="Mapped" value={`${releaseReadiness.mapped}/${releaseReadiness.total}`} tone="text-emerald-200" />
                <Stat icon={ShieldCheck} label="Security" value={releaseReadiness.byCategory.security} tone="text-sky-200" />
                <Stat icon={Eye} label="Transparency" value={releaseReadiness.byCategory.frontend_transparency} tone="text-amber-200" />
                <Stat icon={Settings2} label="Product" value={releaseReadiness.byCategory.product} tone="text-zinc-200" />
              </div>

              <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-white/[0.04] text-xs uppercase tracking-[0.08em] text-zinc-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Blocker</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {RELEASE_BLOCKERS.map((item) => (
                      <tr key={item.id} className="text-zinc-300">
                        <td className="px-4 py-3">
                          <div className="font-medium text-zinc-100">{item.label}</div>
                          <div className="mt-1 font-mono text-xs text-zinc-500">{item.category}</div>
                        </td>
                        <td className="px-4 py-3">
                          <Pill tone={item.status === "implemented" ? "good" : "warn"}>
                            {item.status === "implemented" ? "Implemented" : "CI required"}
                          </Pill>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {item.evidence.map((evidence) => (
                              <span key={evidence} className="rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-zinc-400">
                                {evidence}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="grid gap-4">
              <Panel title="CI and release packaging" description="These items are intentionally gated outside the browser UI and must stay green before beta.">
                <div className="space-y-3">
                  {ciRequiredBlockers.map((item) => (
                    <div key={item.id} className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-amber-100">{item.label}</span>
                        <Pill tone="warn">CI required</Pill>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {item.evidence.map((evidence) => (
                          <span key={evidence} className="rounded border border-amber-200/20 bg-zinc-950/40 px-2 py-1 font-mono text-[11px] text-amber-100/80">
                            {evidence}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="Red-team scenarios" description="Public beta stays blocked until these attack paths have passing evidence and no open critical or high findings.">
                <div className="space-y-2">
                  {RED_TEAM_SCENARIOS.map((scenario) => (
                    <div key={scenario.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-zinc-200">{scenario.label}</span>
                        <Pill tone="good">Covered</Pill>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-500">{scenario.evidence}</div>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="UX acceptance prompts" description="Test users must answer these after onboarding. More than 10 percent failure blocks public beta.">
                <div className="space-y-2">
                  {UX_ACCEPTANCE_PROMPTS.map((prompt) => (
                    <div key={prompt.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="text-sm font-medium text-zinc-200">{prompt.question}</div>
                      <div className="mt-1 text-xs leading-5 text-zinc-500">{prompt.answerEvidence}</div>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
