import { motion, useReducedMotion } from "framer-motion";
import { STATUS_PULSE_EASE } from "../../lib/motion";
import { asArray, indicatorTone, toneLabel } from "../../lib/format";
import { documentNeedsReview, routeRevisionCanReview } from "../../lib/governance";
import { CodeSiteIcons } from "../../icons";

export default function TowerNowStrip({
  towerState,
  streamStatus,
  collisionForecast,
  risks,
  requiredActionCount,
  documents,
  routeRevisions,
  openMaydays,
  runwayOccupancy,
  activeTransactions,
  proofBundles,
  quarantineRecords,
  onSelect,
}) {
  const reduceMotion = useReducedMotion();
  const documentsNeedingReview = asArray(documents).filter(documentNeedsReview)
    .length;
  const routeReviews = asArray(routeRevisions).filter(routeRevisionCanReview)
    .length;
  const requiredCount = Math.max(
    Number(requiredActionCount) || 0,
    documentsNeedingReview + routeReviews,
  );
  const forecastRisk = collisionForecast?.riskLevel || "unknown";
  const runwayCount = asArray(runwayOccupancy).length;
  const transactionCount = asArray(activeTransactions).length;
  const proofCount = asArray(proofBundles).length;
  const quarantineCount = asArray(quarantineRecords).length;
  const maydayCount = asArray(openMaydays).length;
  const riskCount = asArray(risks).length;
  const cards = [
    {
      key: "tower",
      label: "Live state",
      shortLabel: "Live",
      value: toneLabel(towerState),
      detail:
        streamStatus === "live"
          ? "Live coordination stream"
          : `Stream ${toneLabel(streamStatus)}`,
      tone: towerState,
      icon: CodeSiteIcons.liveState,
      section: "tower",
    },
    {
      key: "collision",
      label: "Conflicts",
      shortLabel: "Risk",
      value: toneLabel(forecastRisk),
      detail: riskCount
        ? `${riskCount} forecasted risk${riskCount === 1 ? "" : "s"}`
        : "No forecasted conflicts",
      tone: forecastRisk,
      icon: CodeSiteIcons.conflicts,
      section: "radar",
    },
    {
      key: "clearance",
      label: "Approvals",
      shortLabel: "Approval",
      value: requiredCount,
      detail: `${documentsNeedingReview} docs / ${routeReviews} plan changes`,
      tone: requiredCount ? "holding" : "active",
      icon: CodeSiteIcons.actions,
      section: "governance",
    },
    {
      key: "mayday",
      label: "Paused incidents",
      shortLabel: "Resume",
      value: maydayCount,
      detail: maydayCount
        ? "Inspection evidence needed before resume"
        : "No paused incidents",
      tone: maydayCount ? "high" : "active",
      icon: CodeSiteIcons.recovery,
      section: "replay",
    },
    {
      key: "runway",
      label: "Path locks",
      shortLabel: "Locks",
      value: runwayCount,
      detail: transactionCount
        ? `${transactionCount} open transaction${transactionCount === 1 ? "" : "s"}`
        : "No occupied write lock",
      tone: runwayCount || transactionCount ? "holding" : "active",
      icon: CodeSiteIcons.pathLocks,
      section: "radar",
    },
    {
      key: "proof",
      label: "Evidence",
      value: proofCount,
      detail: quarantineCount
        ? `${quarantineCount} quarantine${quarantineCount === 1 ? "" : "s"} need replay`
        : "Evidence handoff ready",
      tone: quarantineCount ? "warning" : proofCount ? "active" : "idle",
      icon: CodeSiteIcons.evidence,
      section: "evidence",
    },
  ];

  return (
    <div
      data-testid="codesite-tower-now"
      className="flex gap-1.5 overflow-x-auto rounded-[var(--radius-panel)] border p-1.5"
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 62%, var(--accent-primary) 38%)",
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 90%, var(--accent-primary) 7%), color-mix(in srgb, var(--bg-surface) 94%, var(--text-primary) 3%))",
      }}
      aria-label="CodeSite live coordination summary"
    >
      {cards.map((card, index) => {
        const Icon = card.icon;
        const urgent = ["high", "critical", "warning", "holding"].includes(
          String(card.tone || "").toLowerCase(),
        );
        return (
          <button
            key={card.key}
            type="button"
            data-testid={`codesite-tower-now-${card.key}`}
            aria-label={`${card.label}: ${card.value}. ${card.detail}`}
            onClick={() => onSelect?.(card.section)}
            className="group min-w-[9.25rem] flex-1 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-left outline-none transition-[background,border-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 78%, var(--text-primary) 10%)",
              background: urgent
                ? "color-mix(in srgb, var(--bg-editor) 78%, var(--accent-primary) 8%)"
                : "color-mix(in srgb, var(--bg-surface) 94%, var(--bg-editor) 6%)",
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
                  style={{
                    background:
                      "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
                  }}
                >
                  <Icon
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--accent-primary)" }}
                  />
                </span>
                <span
                  className="truncate text-[10px] font-semibold uppercase sm:hidden"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.shortLabel || card.label}
                </span>
                <span
                  className="hidden truncate text-[10px] font-semibold uppercase sm:inline"
                  style={{ color: "var(--text-muted)" }}
                >
                  {card.label}
                </span>
              </span>
              <motion.span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={indicatorTone(card.tone)}
                animate={
                  urgent && !reduceMotion
                    ? { opacity: [0.52, 1, 0.52], scale: [0.9, 1.18, 0.9] }
                    : undefined
                }
                transition={
                  urgent && !reduceMotion
                    ? {
                        duration: 1.8,
                        ease: STATUS_PULSE_EASE,
                        repeat: Infinity,
                        delay: index * 0.08,
                      }
                    : undefined
                }
              />
            </div>
            <div
              className="mt-1 break-words font-mono text-sm font-semibold leading-tight tabular-nums sm:text-base"
              style={{ color: "var(--text-primary)" }}
            >
              {card.value}
            </div>
            <div
              className="mt-0.5 hidden min-h-4 text-[10.5px] leading-4 sm:block"
              style={{ color: "var(--text-secondary)" }}
            >
              {card.detail}
            </div>
          </button>
        );
      })}
    </div>
  );
}
