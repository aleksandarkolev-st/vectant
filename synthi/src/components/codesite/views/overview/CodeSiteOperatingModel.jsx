import { Pill } from "../../ui";
import { motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../../lib/motion";
import { asArray } from "../../lib/format";
import { documentNeedsReview, routeRevisionCanReview } from "../../lib/governance";
import { CodeSiteIcons } from "../../icons";

export default function CodeSiteOperatingModel({
  activeFlights,
  activeLeases,
  documents,
  routeRevisions,
  proofBundles,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
  const flightCount = asArray(activeFlights).length;
  const leaseCount = asArray(activeLeases).length;
  const documentReviewCount = asArray(documents).filter(documentNeedsReview).length;
  const routeReviewCount = asArray(routeRevisions).filter(routeRevisionCanReview).length;
  const proofCount = asArray(proofBundles).length;
  const rows = [
    {
      key: "scope",
      label: "Workstreams",
      status: flightCount ? "active" : "idle",
      owner: asArray(activeFlights).map((flight) => flight.displayCallsign).filter(Boolean).slice(0, 2).join(", ") || "unassigned",
      evidence: `${leaseCount} locks`,
      detail: `${flightCount} active / owned paths and risk areas`,
      icon: CodeSiteIcons.workspaceGraph,
      section: "radar",
    },
    {
      key: "activity",
      label: "Activity",
      status: flightCount ? "live" : "quiet",
      owner: "tower",
      evidence: "event stream",
      detail: "Agent updates, blockers, and system guardrails",
      icon: CodeSiteIcons.activity,
      section: "tower",
    },
    {
      key: "governance",
      label: "Governance",
      status: documentReviewCount + routeReviewCount ? "review" : "clear",
      owner: `${documentReviewCount} docs`,
      evidence: `${routeReviewCount} route reviews`,
      detail: `${leaseCount} approvals / permit and document review`,
      icon: CodeSiteIcons.governance,
      section: "governance",
    },
    {
      key: "evidence",
      label: "Evidence",
      status: proofCount ? "available" : "pending",
      owner: "recorder",
      evidence: `${proofCount} bundles`,
      detail: `${asArray(documents).length} docs / ${asArray(routeRevisions).length} plan changes`,
      icon: CodeSiteIcons.evidence,
      section: "evidence",
    },
  ];

  return (
    <section
      data-testid="codesite-operating-model"
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: "color-mix(in srgb, var(--border-subtle) 84%, transparent)",
        background: "color-mix(in srgb, var(--bg-surface) 92%, transparent)",
      }}
    >
      <div className="grid gap-2 border-b px-3 py-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center" style={{ borderColor: "color-mix(in srgb, var(--border-subtle) 72%, transparent)" }}>
        <div className="min-w-0">
          <div className="text-xs font-semibold">Operating queue</div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
            Saved views for active work, approvals, and replay evidence
          </div>
        </div>
        <div className="flex min-w-0 gap-1 overflow-x-auto" aria-label="CodeSite saved views">
          {["Active", "Review", "Evidence"].map((view) => (
            <button
              key={view}
              type="button"
              className="h-7 shrink-0 rounded-md border px-2 text-[11px]"
              style={{
                borderColor: "var(--border-subtle)",
                background: view === "Active" ? "color-mix(in srgb, var(--primary) 9%, transparent)" : "transparent",
                color: view === "Active" ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {view}
            </button>
          ))}
        </div>
      </div>
      <div className="hidden grid-cols-[1.1fr_0.7fr_0.8fr_1fr_auto] gap-2 border-b px-3 py-2 text-[10px] uppercase tracking-normal md:grid" style={{ borderColor: "color-mix(in srgb, var(--border-subtle) 72%, transparent)", color: "var(--text-muted)" }}>
        <span>Queue</span>
        <span>Status</span>
        <span>Owner</span>
        <span>Evidence</span>
        <span>Open</span>
      </div>
      <div className="divide-y divide-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)]">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <motion.button
              key={row.key}
              type="button"
              onClick={() => onSelect?.(row.section)}
              whileHover={reduceMotion ? undefined : { x: 2 }}
              whileTap={reduceMotion ? undefined : { scale: 0.995 }}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: MOTION_EASE }}
              className="grid min-h-14 w-full gap-2 px-3 py-2 text-left outline-none transition-[background] hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--primary)] md:grid-cols-[1.1fr_0.7fr_0.8fr_1fr_auto] md:items-center"
            >
              <span className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-md border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)" }}>
                  <Icon className="h-3.5 w-3.5" style={{ color: "var(--primary)" }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{row.label}</span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{row.detail}</span>
                </span>
              </span>
              <span><Pill tone={row.status}>{row.status}</Pill></span>
              <span className="truncate font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>{row.owner}</span>
              <span className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>{row.evidence}</span>
              <span className="font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>{row.section}</span>
            </motion.button>
          );
        })}
      </div>
    </section>
  );
}
