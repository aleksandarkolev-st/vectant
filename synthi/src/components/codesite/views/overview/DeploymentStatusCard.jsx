import { CodeSiteIcons } from "../../icons";
import { Pill } from "../../ui";

const CHECKS = [
  ["controlPlaneReachable", "Control-plane reachable"],
  ["activityBridgeReachable", "Activity bridge reachable"],
  ["overlayCapable", "Overlay capable"],
  ["inboxDeliveryCapable", "Inbox delivery capable"],
  ["runtimeEventAdapterHealthy", "Runtime event adapter healthy"],
];

const DETAIL_BY_CODE = {
  project_query_succeeded: "Authorized project query succeeded",
  authenticated_activity_round_trip_succeeded: "Authenticated publish, refresh, and cleanup succeeded",
  docker_overlay_runtime_ready: "Linux Docker overlay runtime and image are ready",
  durable_inbox_query_succeeded: "Durable inbox relation is readable",
  runtime_event_adapter_unconfigured: "No runtime event adapter is connected yet",
  docker_runtime_probe_timeout: "Runtime probe timed out",
  docker_overlay_runtime_unavailable: "Docker overlay runtime or image is unavailable",
  linux_overlay_runtime_required: "A Linux overlay runtime is required",
  overlay_runtime_unavailable: "Overlay runtime is unavailable",
  overlay_capability_unavailable: "Overlay capability could not be verified",
  runtime_event_adapter_health_unavailable: "Runtime adapter health could not be verified",
  collab_deployment_status_unreachable: "Collaboration deployment status is unreachable",
  status_request_failed: "Deployment status request failed",
};

function checkState(status, check) {
  if (status === "loading" || !check) return { label: "Checking", tone: "pending" };
  return check.ok
    ? { label: "Available", tone: "active" }
    : { label: "Unavailable", tone: "holding" };
}

function checkedLabel(value) {
  if (!value) return "Waiting for the first live check";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Live check completed";
  return `Checked ${timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export default function DeploymentStatusCard({ deploymentStatus }) {
  const status = deploymentStatus?.status || "loading";
  const StatusIcon = CodeSiteIcons.control;
  const healthyCount = CHECKS.filter(([key]) => deploymentStatus?.checks?.[key]?.ok).length;

  return (
    <section
      aria-labelledby="codesite-deployment-status-title"
      data-testid="codesite-deployment-status"
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: "var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-surface) 92%, var(--accent-primary) 3%)",
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-3 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent-primary)" }} />
          <div className="min-w-0">
            <h3 id="codesite-deployment-status-title" className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Deployment status
            </h3>
            <p className="mt-0.5 text-xs leading-5" style={{ color: "var(--text-muted)" }}>
              {checkedLabel(deploymentStatus?.checkedAt)}. Signals come from live control-plane, bridge, inbox, and runtime probes.
            </p>
          </div>
        </div>
        <Pill tone={healthyCount === CHECKS.length ? "active" : status === "loading" ? "pending" : "holding"}>
          {status === "loading" ? "Checking" : `${healthyCount}/${CHECKS.length} available`}
        </Pill>
      </div>
      <div className="grid @min-[42rem]/panel:grid-cols-2 @min-[68rem]/panel:grid-cols-5">
        {CHECKS.map(([key, label], index) => {
          const check = deploymentStatus?.checks?.[key];
          const state = checkState(status, check);
          return (
            <div
              key={key}
              data-testid={`codesite-deployment-check-${key}`}
              data-status={check?.ok === true ? "available" : status === "loading" ? "checking" : "unavailable"}
              className={`min-w-0 px-3 py-3 ${index ? "border-t @min-[42rem]/panel:border-l @min-[42rem]/panel:border-t-0" : ""}`}
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 text-xs font-semibold leading-5" style={{ color: "var(--text-primary)" }}>
                  {label}
                </span>
                <Pill tone={state.tone}>{state.label}</Pill>
              </div>
              <p className="mt-1.5 text-[11px] leading-4" style={{ color: "var(--text-muted)" }}>
                {status === "loading"
                  ? "Running live check"
                  : (DETAIL_BY_CODE[check?.code] || "Live capability check did not pass")}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
