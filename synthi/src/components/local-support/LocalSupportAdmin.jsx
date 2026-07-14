"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import "./local-support.css";

const EMPTY_POLICY = {
  global_enabled: false,
  org_disabled: false,
  pairing_disabled: false,
  preview_disabled: false,
  agent_access_disabled: true,
  min_app_version: "0.1.0",
  vulnerable_versions: [],
  retention_days: 30,
};

export default function LocalSupportAdmin() {
  const [token, setToken] = useState("");
  const [state, setState] = useState(null);
  const [policy, setPolicy] = useState(EMPTY_POLICY);
  const [orgId, setOrgId] = useState("");
  const [status, setStatus] = useState("Enter the operations token to load live controls.");
  const [busy, setBusy] = useState(false);

  async function request(body) {
    if (token.length < 8) throw new Error("Enter a valid operations token.");
    const scope = !body && orgId.trim() ? `?org_id=${encodeURIComponent(orgId.trim())}` : "";
    const response = await fetch(`/api/local-support/admin/state${scope}`, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: {
        "x-vectant-admin-token": token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.decision === "denied") {
      throw new Error(result.reason || "The admin request was denied.");
    }
    return result;
  }

  async function load() {
    setBusy(true);
    try {
      const result = await request();
      setState(result);
      setPolicy({ ...EMPTY_POLICY, ...result.policy });
      setOrgId(result.policy?.org_id || orgId.trim());
      setStatus("Live policy and operations state loaded.");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy() {
    setBusy(true);
    try {
      await request({ action: "update_policy", ...(orgId.trim() ? { org_id: orgId.trim() } : {}), ...policy });
      setStatus("Policy updated. New requests use it immediately.");
      await load();
    } catch (error) {
      setStatus(error.message);
      setBusy(false);
    }
  }

  async function revoke(targetType, targetId) {
    if (!window.confirm(`Revoke ${targetType} ${targetId}? Active access will stop immediately.`)) return;
    setBusy(true);
    try {
      await request({ target_type: targetType, target_id: targetId });
      setStatus(`${targetType === "device" ? "Device" : "Session"} revoked.`);
      await load();
    } catch (error) {
      setStatus(error.message);
      setBusy(false);
    }
  }

  return (
    <main className="local-support-admin min-h-screen bg-[#090b0f] px-5 py-8 text-zinc-100 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        <header className="mb-10 flex flex-col gap-6 border-b border-white/10 pb-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">Local Support / Operations</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">Control access without losing the audit trail.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-400">Kill switches, version enforcement, device revocation, and security alerts. Raw local payloads never appear here.</p>
          </div>
          <div className="flex w-full max-w-md gap-2">
            <label className="relative flex-1">
              <KeyRound className="absolute left-3 top-3 h-4 w-4 text-zinc-500" />
              <span className="sr-only">Operations token</span>
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Operations token" autoComplete="off" className="h-10 w-full rounded-md border border-white/10 bg-white/[0.04] pl-10 pr-3 text-sm outline-none focus:border-emerald-400/50" />
            </label>
            <Button onClick={load} disabled={busy || token.length < 8} className="bg-emerald-300 text-zinc-950 hover:bg-emerald-200">
              <RefreshCw className={`mr-2 h-4 w-4 ${busy ? "animate-spin" : ""}`} /> Load
            </Button>
          </div>
        </header>

        <div role="status" className="mb-6 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">{status}</div>

        <section className="grid gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="bg-[#0d1015] p-6">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div><h2 className="text-lg font-semibold">Effective policy</h2><p className="mt-1 text-sm text-zinc-500">Changes are durable and fail closed if unavailable.</p></div>
              {state?.policy?.enabled ? <ShieldCheck className="h-6 w-6 text-emerald-300" /> : <ShieldOff className="h-6 w-6 text-red-300" />}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["global_enabled", "Global access", "Master enable for Local Support"],
                ["org_disabled", "Organization kill switch", "Stop all organization access"],
                ["pairing_disabled", "Pairing disabled", "Block new device sessions"],
                ["preview_disabled", "Preview disabled", "Stop localhost browser preview"],
                ["agent_access_disabled", "Agent access disabled", "Keep AI and support reads blocked"],
              ].map(([key, label, help]) => (
                <label key={key} className="flex cursor-pointer items-start gap-3 rounded-md border border-white/10 bg-white/[0.025] p-4">
                  <input type="checkbox" checked={policy[key]} onChange={(event) => setPolicy((value) => ({ ...value, [key]: event.target.checked }))} className="mt-1 accent-emerald-300" />
                  <span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-5 text-zinc-500">{help}</span></span>
                </label>
              ))}
            </div>
            <div className="mt-4 max-w-md">
              <Field label="Organization scope (blank = global)" value={orgId} onChange={setOrgId} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Minimum app version" value={policy.min_app_version} onChange={(value) => setPolicy((item) => ({ ...item, min_app_version: value }))} />
              <Field label="Vulnerable versions" value={policy.vulnerable_versions.join(", ")} onChange={(value) => setPolicy((item) => ({ ...item, vulnerable_versions: value.split(",").map((entry) => entry.trim()).filter(Boolean) }))} />
              <Field label="Retention days (0 = none)" type="number" min={0} value={policy.retention_days} onChange={(value) => setPolicy((item) => ({ ...item, retention_days: Number(value) }))} />
            </div>
            <Button onClick={savePolicy} disabled={busy || !state} className="mt-5 bg-zinc-100 text-zinc-950 hover:bg-white">Apply policy</Button>
          </div>

          <div className="bg-[#0b0e13] p-6">
            <h2 className="text-lg font-semibold">Security alerts</h2>
            <p className="mt-1 text-sm text-zinc-500">Scrubbed, routed operational signals.</p>
            <div className="mt-5 space-y-2">
              {(state?.security_alerts || []).length === 0 && <Empty>No alerts in the current window.</Empty>}
              {(state?.security_alerts || []).map((alert) => (
                <article key={alert.event_id} className="rounded-md border border-amber-300/15 bg-amber-300/[0.04] p-4">
                  <div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="h-4 w-4 text-amber-300" />{alert.event_type || "security_event"}</div>
                  <p className="mt-2 text-xs text-zinc-500">{alert.severity} · {alert.alert_route} · {alert.at || "time unavailable"}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <ResourceList title="Paired devices" empty="No paired devices." items={state?.paired_devices} idKey="device_id" onRevoke={(id) => revoke("device", id)} />
          <ResourceList title="Active sessions" empty="No active sessions." items={state?.active_sessions} idKey="session_id" onRevoke={(id) => revoke("session", id)} />
        </section>
      </div>
    </main>
  );
}

function Field({ label, value, onChange, type = "text", min }) {
  return <label className="text-xs font-medium text-zinc-400">{label}<input type={type} value={value} min={type === "number" ? min ?? 1 : undefined} max={type === "number" ? 90 : undefined} onChange={(event) => onChange(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-100 outline-none focus:border-emerald-400/50" /></label>;
}

function ResourceList({ title, empty, items = [], idKey, onRevoke }) {
  return <div className="rounded-lg border border-white/10 bg-[#0d1015] p-6"><h2 className="text-lg font-semibold">{title}</h2><div className="mt-4 space-y-2">{items.length === 0 && <Empty>{empty}</Empty>}{items.map((item) => <article key={item[idKey]} className="flex items-center justify-between gap-4 rounded-md border border-white/10 p-4"><div className="min-w-0"><p className="truncate text-sm font-medium">{item[idKey]}</p><p className="mt-1 text-xs text-zinc-500">v{item.app_version || "unknown"} · {item.approved_ports_count || 0} approved ports · {item.last_active_at || "never active"}</p></div><Button variant="outline" size="sm" disabled={item.revoked} onClick={() => onRevoke(item[idKey])} className="border-red-400/20 text-red-200 hover:bg-red-400/10">{item.revoked ? "Revoked" : "Revoke"}</Button></article>)}</div></div>;
}

function Empty({ children }) {
  return <p className="rounded-md border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-600">{children}</p>;
}
