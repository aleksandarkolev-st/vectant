import { CodeSiteIcons } from "../icons";

/**
 * Thirteen sections is more than a panel this size can present flat, which is why the
 * old rail needed a horizontal scroller and a status card beside it to explain
 * which one you were on. Workflows solves the same problem next door with two
 * levels: a four-tile command strip over a sub-view strip. These four groups are
 * that first level.
 *
 * Order matters — it is the order of the tiles, and `live` is the landing group.
 */
export const SECTION_GROUPS = [
  {
    key: "live",
    label: "Live",
    icon: CodeSiteIcons.liveState,
    sections: ["overview", "radar", "tower", "channels"],
  },
  {
    key: "decisions",
    label: "Decisions",
    icon: CodeSiteIcons.governance,
    sections: ["governance", "notams", "learning", "runway", "quarantine"],
  },
  {
    key: "proof",
    label: "Proof",
    icon: CodeSiteIcons.evidence,
    sections: ["evidence", "inspections"],
  },
  {
    key: "analysis",
    label: "Analysis",
    icon: CodeSiteIcons.replay,
    sections: ["replay", "simulator"],
  },
];

export const DEFAULT_GROUP_KEY = "live";

/** Which group owns a section key. Falls back to the landing group. */
export function groupForSection(sectionKey) {
  const group = SECTION_GROUPS.find((entry) => entry.sections.includes(sectionKey));
  return group?.key || DEFAULT_GROUP_KEY;
}

/**
 * Tile detail line and count, mirroring WorkflowCommandStrip's `detail`/`count`.
 * This is what makes the panel legible to someone opening it for the first time:
 * "Decisions · Needs review · 4" explains the panel without a click.
 */
export function groupSummary(groupKey, counts, extra = {}) {
  const {
    requiredActions = 0,
    activeFlights = 0,
    proofBundles = 0,
    inspectionRuns = 0,
  } = counts || {};
  const { actionableQuarantines = 0, counterfactualRuns = 0 } = extra;

  if (groupKey === "live") {
    return {
      detail: activeFlights ? "In flight" : "Idle",
      count: activeFlights,
      tone: activeFlights ? "active" : "idle",
    };
  }
  if (groupKey === "decisions") {
    const pending = requiredActions + actionableQuarantines;
    return {
      detail: pending ? "Needs review" : "Clear",
      count: pending,
      tone: pending ? "high" : "low",
    };
  }
  if (groupKey === "proof") {
    return {
      detail: proofBundles ? "Captured" : "Waiting",
      count: proofBundles + inspectionRuns,
      tone: proofBundles ? "active" : "idle",
    };
  }
  return {
    detail: counterfactualRuns ? "Runs recorded" : "No runs",
    count: counterfactualRuns,
    tone: "idle",
  };
}
