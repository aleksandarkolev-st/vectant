"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { applyCodeSiteRouteRevision, applyCodeSiteQuarantine, createCodeSiteProject, createEmptyCodeSiteRadarState, exportCodeSiteArtifacts, fetchCodeSiteCoreState, fetchCodeSiteDeploymentStatus, fetchCodeSiteEvidenceSlice, fetchCodeSiteLineProvenance, fetchCodeSiteQuarantineSlice, fetchCodeSiteRadarState, issueCodeSitePermit, proposeCodeSiteRouteRevision, replayCodeSiteQuarantine, resumeCodeSiteMayday, reviewCodeSiteDocument, reviewCodeSiteRouteRevision, simulateCodeSiteShadowMerge, subscribeCodeSiteProjectEvents } from "./codesiteClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeSiteIcons } from "./icons";
import DesktopSectionRail from "./nav/DesktopSectionRail";
import MobileSectionTabs from "./nav/MobileSectionTabs";
import ViewStrip from "./nav/ViewStrip";
import {
  DEFAULT_GROUP_KEY, SECTION_GROUPS, groupForSection, groupSummary,
} from "./lib/sectionGroups";
import { causalReplayHandovers } from "./views/replay/handovers";
import {
  ActivityView, ChannelsView, EvidenceView, GovernanceView, GraphView, InspectionsView,
  ExpertiseView, LocksView, OverviewView, QuarantineView, ReplayView, SimulatorView,
} from "./views";
import { IconButton, LoadingSkeleton, Pill } from "./ui";
import {
  asArray, compact, inspectionRunRefs, latestCounterfactualSimulation,
  lineRange, pathCoversFile, toneLabel, uniqueByEvent, uniqueValues,
} from "./lib/format";
import { incidentNeedsResume } from "./lib/governance";
import { resolveGovernanceReviewTarget } from "./lib/governanceActions";
import {
  mergeQuarantineRecords, quarantineRecordsFromEvents, selectedPathKey,
} from "./lib/quarantine";

// Coordination modes (docs/CHANNEL_MODES_TRADEOFFS.md). Speed/audit are
// relative 1-4 ratings rendered as dot meters in the picker.
const CHANNEL_MODE_OPTIONS = [
  {
    value: "mediated_only",
    label: "🛡️ Mediated only",
    speed: 1,
    audit: 4,
    hint: "Every agent message is recorded and auditable. Slowest. For regulated/compliance workloads.",
  },
  {
    value: "registered_direct",
    label: "⚖️ Registered direct",
    speed: 3,
    audit: 3,
    hint: "Agents negotiate directly after a governed handshake. Who-talked-to-whom is audited; contents are not stored.",
  },
  {
    value: "direct_preferred",
    label: "⚡ Direct preferred",
    speed: 4,
    audit: 2,
    hint: "Fastest collaboration; agents open channels automatically on overlapping routes. Lighter audit trail.",
  },
  {
    value: "open_local",
    label: "🧪 Open local (dev)",
    speed: 4,
    audit: 1,
    hint: "Dev only. Minimal guards for protocol experiments. Refused in production builds.",
  },
];


/**
 * Liveness is SSE-first: `subscribeCodeSiteProjectEvents` streams 36 named event
 * types and now refreshes the core state on arrival, so the poll below is a
 * safety net for a dropped stream rather than the primary mechanism.
 *
 * Every view's core data is covered by at least one streamed event type:
 *
 *   overview     tower_instruction, holding_pattern, ground_stop, mayday,
 *                mayday_resumed, clearance_*, transaction_*, rfi, change_order,
 *                policy_delta_*, incident_reported
 *   radar        near_miss, route_deviation, radar_result, transponder_update
 *   tower        every type — the event log *is* this view's data
 *   governance   rfi, change_order, policy_delta_*, arbiter_verdict
 *   runway       clearance_requested, clearance_issued, write_allowed,
 *                write_denied, landing_requested, holding_pattern
 *   quarantine   write_quarantined, quarantine_reviewed, quarantine_replayed,
 *                quarantine_applied
 *   inspections  inspection_result
 *   replay       shadow_run, black_box_closed
 *   simulator    shadow_run — and its results are request/response, not polled
 *
 * Evidence is the exception: no event type announces a metrics recomputation or
 * an artifact export, so that view keeps the old 5s cadence for its own slice
 * rather than silently going stale for up to 30 seconds.
 */
const POLL_MS = 30000;
const EVIDENCE_POLL_MS = 5000;
const STREAM_REFRESH_DEBOUNCE_MS = 400;
const STREAM_EVENT_BUFFER_LIMIT = 12;
const TOWER_EVENT_FEED_LIMIT = 24;

const EMPTY_DEPLOYMENT_STATUS = {
  status: "loading",
  checkedAt: null,
  checks: {},
};

/**
 * Per-view data, held apart from the core state so a core refresh cannot wipe
 * it. `null` means "not loaded", which is what makes the `?? radarState.x`
 * reads below fall back to the composite fetch when one has run.
 */
const EMPTY_VIEW_SLICES = {
  metrics: null,
  artifactPreview: null,
  quarantines: null,
  quarantineError: null,
};

const VIEWS = {
  overview: OverviewView,
  radar: GraphView,
  tower: ActivityView,
  channels: ChannelsView,
  expertise: ExpertiseView,
  governance: GovernanceView,
  runway: LocksView,
  quarantine: QuarantineView,
  evidence: EvidenceView,
  inspections: InspectionsView,
  replay: ReplayView,
  simulator: SimulatorView,
};

















































export default function CodeSitePanel({ workspaceSlug }) {
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [radarState, setRadarState] = useState(() =>
    createEmptyCodeSiteRadarState(workspaceSlug),
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectChannelMode, setNewProjectChannelMode] = useState(
    "registered_direct",
  );
  const [exportResult, setExportResult] = useState(null);
  const [lineInspector, setLineInspector] = useState({
    status: "idle",
    row: null,
    rows: [],
    error: null,
  });
  const [simulationRun, setSimulationRun] = useState({
    status: "idle",
    result: null,
    error: null,
  });
  const [quarantineReview, setQuarantineReview] = useState({
    selectedId: null,
    selectedPaths: [],
    status: "idle",
    replay: null,
    replayPathKey: "",
    apply: null,
    error: null,
  });
  const [streamStatus, setStreamStatus] = useState("polling");
  const [streamEvents, setStreamEvents] = useState([]);
  const [activeSection, setActiveSection] = useState("overview");
  const [permitDraft, setPermitDraft] = useState({
    title: "",
    permitType: "restricted_route",
    route: "",
  });
  const [routeDraft, setRouteDraft] = useState({ route: "", reason: "" });
  const [governanceAction, setGovernanceAction] = useState({
    status: "idle",
    result: null,
    error: null,
  });
  const [pendingReviewTarget, setPendingReviewTarget] = useState(null);
  const [viewSlices, setViewSlices] = useState(EMPTY_VIEW_SLICES);
  const [activeGroup, setActiveGroup] = useState(DEFAULT_GROUP_KEY);
  const [deploymentStatus, setDeploymentStatus] = useState(EMPTY_DEPLOYMENT_STATUS);

  const loadRadar = useCallback(
    async ({ silent = false, full = false, projectId = selectedProjectId } = {}) => {
      if (!workspaceSlug) {
        setRadarState(createEmptyCodeSiteRadarState(workspaceSlug));
        setLoading(false);
        return;
      }

      if (!silent) setLoading(true);

      try {
        // `full` is the explicit Refresh action, where the user is asking for
        // everything at once. Everything else — mount, poll, stream, and the
        // reload after a mutation — takes core only and lets the mounted view
        // fetch its own slice.
        const next = full
          ? await fetchCodeSiteRadarState(workspaceSlug, projectId)
          : await fetchCodeSiteCoreState(workspaceSlug, projectId);
        setRadarState(next);
        if (full) setViewSlices(EMPTY_VIEW_SLICES);
        setError(null);
        if (
          next.selectedProjectId &&
          next.selectedProjectId !== selectedProjectId
        ) {
          setSelectedProjectId(next.selectedProjectId);
        }
      } catch (nextError) {
        setError({
          status: nextError.status,
          message: nextError.message || "codesite_request_failed",
        });
      } finally {
        setLoading(false);
      }
    },
    [selectedProjectId, workspaceSlug],
  );

  useEffect(() => {
    loadRadar();
  }, [loadRadar]);

  useEffect(() => {
    if (!workspaceSlug || !radarState.selectedProjectId) return undefined;
    const timer = window.setInterval(() => {
      loadRadar({ silent: true, projectId: radarState.selectedProjectId });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRadar, radarState.selectedProjectId, workspaceSlug]);

  useEffect(() => {
    const projectId = radarState.selectedProjectId;
    if (!workspaceSlug || !projectId) {
      setDeploymentStatus(EMPTY_DEPLOYMENT_STATUS);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchCodeSiteDeploymentStatus(workspaceSlug, projectId);
        if (!cancelled) setDeploymentStatus(next || EMPTY_DEPLOYMENT_STATUS);
      } catch (_) {
        if (!cancelled) {
          const failed = { ok: false, code: "status_request_failed" };
          setDeploymentStatus({
            status: "degraded",
            checkedAt: new Date().toISOString(),
            checks: {
              controlPlaneReachable: failed,
              activityBridgeReachable: failed,
              overlayCapable: failed,
              inboxDeliveryCapable: failed,
              runtimeEventAdapterHealthy: failed,
            },
          });
        }
      }
    };
    setDeploymentStatus(EMPTY_DEPLOYMENT_STATUS);
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [radarState.selectedProjectId, workspaceSlug]);

  // A project switch invalidates every slice. Clear them so the outgoing
  // project's metrics and quarantines cannot show under the incoming one.
  useEffect(() => {
    setViewSlices(EMPTY_VIEW_SLICES);
  }, [radarState.selectedProjectId]);

  // Evidence is the one view with no invalidating event type, so it keeps its
  // own short poll rather than waiting on the 30s core cadence.
  useEffect(() => {
    const projectId = radarState.selectedProjectId;
    if (activeSection !== "evidence" || !workspaceSlug || !projectId) {
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      const slice = await fetchCodeSiteEvidenceSlice(workspaceSlug, projectId);
      if (!cancelled) setViewSlices((current) => ({ ...current, ...slice }));
    };
    void load();
    const timer = window.setInterval(load, EVIDENCE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSection, radarState.selectedProjectId, workspaceSlug]);

  // Not gated on the active view: the Overview's Needs Attention digest and
  // TowerNowStrip both count quarantines, so gating this would silently
  // undercount them. The win here is that it no longer blocks first paint —
  // core renders, then this fills in. It needs transaction ids from the core
  // state, so it re-runs whenever core changes, which the stream now drives on
  // every quarantine_* event. No separate poll needed.
  useEffect(() => {
    if (!workspaceSlug || !radarState.selectedProjectId) return undefined;
    let cancelled = false;
    void (async () => {
      const slice = await fetchCodeSiteQuarantineSlice(workspaceSlug, {
        project: radarState.project,
        controlState: radarState.controlState,
        events: radarState.events,
      });
      if (!cancelled) setViewSlices((current) => ({ ...current, ...slice }));
    })();
    return () => {
      cancelled = true;
    };
  }, [
    radarState.controlState,
    radarState.events,
    radarState.project,
    radarState.selectedProjectId,
    workspaceSlug,
  ]);

  useEffect(() => {
    setStreamEvents([]);
    if (!workspaceSlug || !radarState.selectedProjectId) {
      setStreamStatus("polling");
      return undefined;
    }
    // Events arrive in bursts — a commit emits several in a row — so coalesce
    // them into one refresh instead of one per event.
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        });
      }, STREAM_REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeCodeSiteProjectEvents(
      workspaceSlug,
      radarState.selectedProjectId,
      {
        onStatus: setStreamStatus,
        onEvent: (event) => {
          setStreamEvents((current) => {
            const id =
              event?.id ||
              event?.eventId ||
              `${event?.eventType || "event"}:${event?.createdAt || current.length}`;
            const withoutDuplicate = current.filter(
              (item) => (item?.id || item?.eventId) !== id,
            );
            return [event, ...withoutDuplicate].slice(0, STREAM_EVENT_BUFFER_LIMIT);
          });
          scheduleRefresh();
        },
      },
    );
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe?.();
    };
  }, [loadRadar, radarState.selectedProjectId, workspaceSlug]);

  // Also moves the group, so the drill-in links from TowerNowStrip and
  // CodeSiteOperatingModel land on a section whose group tile is selected.
  const handleSelectSection = useCallback((sectionKey) => {
    setActiveSection(sectionKey);
    setActiveGroup(groupForSection(sectionKey));
  }, []);

  // Selecting a group lands on its first section.
  const handleSelectGroup = useCallback((groupKey) => {
    setActiveGroup(groupKey);
    const group = SECTION_GROUPS.find((entry) => entry.key === groupKey);
    if (group?.sections.length) setActiveSection(group.sections[0]);
  }, []);

  const handleCreateProject = useCallback(
    async (event) => {
      event?.preventDefault?.();
      if (!workspaceSlug || acting) return;

      const title = newProjectTitle.trim() || "Coordination run";
      setActing(true);
      try {
        const project = await createCodeSiteProject(workspaceSlug, {
          title,
          request: title,
          channelMode: newProjectChannelMode,
          zonePolicy: {
            zones: [],
            noFlyZones: [],
            classRules: {},
          },
        });
        setNewProjectTitle("");
        setSelectedProjectId(project?.id || null);
        window.dispatchEvent(new CustomEvent("codesite-projects-changed", {
          detail: { workspaceSlug },
        }));
        await loadRadar({ projectId: project?.id || null });
      } catch (nextError) {
        setError({
          status: nextError.status,
          message: nextError.message || "codesite_create_failed",
        });
      } finally {
        setActing(false);
      }
    },
    [acting, loadRadar, newProjectTitle, newProjectChannelMode, workspaceSlug],
  );

  const handleExportArtifacts = useCallback(async () => {
    if (!workspaceSlug || !radarState.selectedProjectId || acting) return;

    setActing(true);
    try {
      const result = await exportCodeSiteArtifacts(
        workspaceSlug,
        radarState.selectedProjectId,
      );
      setExportResult(result);
      await loadRadar({
        silent: true,
        projectId: radarState.selectedProjectId,
      });
    } catch (nextError) {
      setError({
        status: nextError.status,
        message: nextError.message || "codesite_artifact_export_failed",
      });
    } finally {
      setActing(false);
    }
  }, [acting, loadRadar, radarState.selectedProjectId, workspaceSlug]);

  const handleRunTowerSimulation = useCallback(async () => {
    if (!workspaceSlug || !radarState.selectedProjectId || acting) return;

    setActing(true);
    setSimulationRun({
      status: "running",
      result: simulationRun.result,
      error: null,
    });
    try {
      const result = await simulateCodeSiteShadowMerge(
        workspaceSlug,
        radarState.selectedProjectId,
      );
      setSimulationRun({ status: "ready", result, error: null });
      await loadRadar({
        silent: true,
        projectId: radarState.selectedProjectId,
      });
    } catch (nextError) {
      setSimulationRun({
        status: "error",
        result: simulationRun.result,
        error: nextError.message || "codesite_tower_simulation_failed",
      });
    } finally {
      setActing(false);
    }
  }, [
    acting,
    loadRadar,
    radarState.selectedProjectId,
    simulationRun.result,
    workspaceSlug,
  ]);

  const runGovernanceAction = useCallback(
    async (operation) => {
      if (!workspaceSlug || acting) return;
      setActing(true);
      setGovernanceAction({ status: "running", result: null, error: null });
      try {
        const result = await operation();
        setGovernanceAction({ status: "ready", result, error: null });
        await loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        });
      } catch (nextError) {
        setGovernanceAction({
          status: "error",
          result: nextError.body || null,
          error: nextError.message || "codesite_governance_action_failed",
        });
      } finally {
        setActing(false);
      }
    },
    [acting, loadRadar, radarState.selectedProjectId, workspaceSlug],
  );

  const handleIssuePermit = useCallback(
    (payload) => {
      if (!radarState.selectedProjectId) return;
      return runGovernanceAction(() =>
        issueCodeSitePermit(
          workspaceSlug,
          radarState.selectedProjectId,
          payload,
        ),
      );
    },
    [radarState.selectedProjectId, runGovernanceAction, workspaceSlug],
  );

  const handleReviewDocument = useCallback(
    (documentRecord, decision, rationale = "") => {
      if (!documentRecord?.id) return;
      return runGovernanceAction(() =>
        reviewCodeSiteDocument(workspaceSlug, documentRecord.id, {
          decision,
          summary:
            rationale ||
            `Reviewed from CodeSite governance console as ${decision}.`,
          reviewTimeMs: 90_000,
          baselineReviewTimeMs: 300_000,
          evidenceRefs: [`codesite:ui:document-review:${documentRecord.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleProposeRouteRevision = useCallback(
    (plan, payload) => {
      if (!plan?.id) return;
      return runGovernanceAction(() =>
        proposeCodeSiteRouteRevision(workspaceSlug, plan.id, payload),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleReviewRouteRevision = useCallback(
    (revision, decision, rationale = "") => {
      if (!revision?.id) return;
      return runGovernanceAction(() =>
        reviewCodeSiteRouteRevision(workspaceSlug, revision.id, {
          decision,
          reason:
            rationale ||
            `Plan change ${decision} from CodeSite governance console.`,
          evidenceRefs: [`codesite:ui:route-review:${revision.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleApplyRouteRevision = useCallback(
    (revision, rationale = "") => {
      if (!revision?.id) return;
      return runGovernanceAction(() =>
        applyCodeSiteRouteRevision(workspaceSlug, revision.id, {
          appliedBy: "codesite_governance_console",
          rationale:
            rationale ||
            "Operator reviewed route scope, affected leases, and evidence.",
          evidenceRefs: [`codesite:ui:route-apply:${revision.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const handleResumeMayday = useCallback(
    (incident, inspectionRunIds = [], reviewRationale = "") => {
      if (!incident?.id) return;
      const rationale =
        reviewRationale ||
        "Operator reviewed incident replay, stop-work document, suspended approvals, and passing inspection evidence.";
      return runGovernanceAction(() =>
        resumeCodeSiteMayday(workspaceSlug, incident.id, {
          approved: true,
          humanApproval: true,
          rationale,
          summary: rationale,
          inspectionRunIds,
          replayRefs: uniqueValues([
            incident.replayDigest,
            incident.incidentReplay?.replayDigest,
          ]),
          evidenceRefs: [`codesite:ui:mayday-resume:${incident.id}`],
        }),
      );
    },
    [runGovernanceAction, workspaceSlug],
  );

  const currentProject = radarState.project;
  const controlState = radarState.controlState;
  const metrics = viewSlices.metrics ?? radarState.metrics;
  const metricSections = metrics?.sections || {};
  const metricSummary = metrics?.summary || {};
  const hasProjects = radarState.projects.length > 0;
  const collisionForecast =
    radarState.collisionForecast || controlState?.collisionForecast || {};
  const risks = asArray(collisionForecast.risks);
  const runwayOccupancy = asArray(
    collisionForecast.runwayOccupancy ||
      controlState?.collisionForecast?.runwayOccupancy,
  );
  const activeFlights = asArray(controlState?.activeFlights);
  const activeLeases = asArray(controlState?.activeMutationLeases);
  const activeTransactions = asArray(controlState?.activeTransactions);
  const pilotLicenseHealth = asArray(controlState?.pilotLicenseHealth);
  const filesystemBoundaryProofs = asArray(
    controlState?.filesystemBoundaryProofs,
  );
  const mutationTransactions = asArray(currentProject?.mutationTxns);
  const agentRegistry = asArray(currentProject?.agentRegistry);
  const assumptions = asArray(currentProject?.assumptions);
  const proofBundles = asArray(currentProject?.proofBundles);
  const inspectionRuns = asArray(currentProject?.inspectionRuns);
  const incidents = asArray(currentProject?.incidents);
  const replayHandovers = useMemo(
    () => causalReplayHandovers(incidents, proofBundles),
    [incidents, proofBundles],
  );
  const inboxItems = asArray(currentProject?.inboxItems);
  const documents = asArray(currentProject?.documents);
  const permits = asArray(currentProject?.permits);
  const routeRevisions = asArray(currentProject?.routeRevisions);
  const openMaydays = incidents.filter(incidentNeedsResume);

  // Declared here rather than beside the other handlers because it reads the
  // derived governance collections above.
  const handleRequiredActionReview = useCallback(
    (action) => {
      setActiveSection("governance");
      setPendingReviewTarget(
        resolveGovernanceReviewTarget(action, {
          documents,
          routeRevisions,
          openMaydays,
          inspectionRuns,
        }),
      );
    },
    [documents, routeRevisions, openMaydays, inspectionRuns],
  );
  const handlePendingReviewTargetConsumed = useCallback(() => {
    setPendingReviewTarget(null);
  }, []);

  const counterfactualRuns = asArray(currentProject?.counterfactualRuns);
  const artifacts = asArray(
    (viewSlices.artifactPreview ?? radarState.artifactPreview)?.files,
  );
  const events = uniqueByEvent([
    ...streamEvents,
    ...asArray(radarState.events).slice().reverse(),
  ]).slice(0, TOWER_EVENT_FEED_LIMIT);
  const allEvents = asArray(radarState.events);
  const fetchedQuarantines = viewSlices.quarantines ?? radarState.quarantines;
  const quarantineRecords = useMemo(
    () =>
      mergeQuarantineRecords(
        fetchedQuarantines,
        controlState?.pendingQuarantines,
        quarantineRecordsFromEvents(allEvents),
      ),
    [allEvents, controlState?.pendingQuarantines, fetchedQuarantines],
  );
  const actionableQuarantineRecords = useMemo(
    () =>
      quarantineRecords.filter(
        (record) =>
          asArray(record.changes).length ||
          asArray(record.paths).length ||
          asArray(record.remainingPaths).length,
      ),
    [quarantineRecords],
  );
  const selectedQuarantine =
    actionableQuarantineRecords.find(
      (record) => record.quarantineId === quarantineReview.selectedId,
    ) ||
    actionableQuarantineRecords[0] ||
    null;
  const zones = asArray(currentProject?.zonePolicy?.zones);
  const noFlyZones = asArray(
    currentProject?.zonePolicy?.noFlyZones || currentProject?.zonePolicy?.noFly,
  )
    .map((zone) =>
      typeof zone === "string" ? zone : zone?.pattern || zone?.path || zone?.id,
    )
    .filter(Boolean);
  const lineProvenance = asArray(currentProject?.lineProvenance);
  const selectedLineRow = lineInspector.row;
  const selectedLineTransaction = selectedLineRow
    ? selectedLineRow.transaction ||
      activeTransactions.find(
        (txn) => txn.id === selectedLineRow.transactionId,
      ) ||
      mutationTransactions.find(
        (txn) => txn.id === selectedLineRow.transactionId,
      ) ||
      null
    : null;
  const selectedLineLease = selectedLineRow
    ? selectedLineRow.mutationLease ||
      activeLeases.find(
        (lease) => lease.id === selectedLineTransaction?.mutationLeaseId,
      ) ||
      asArray(currentProject?.mutationLeases).find(
        (lease) => lease.id === selectedLineTransaction?.mutationLeaseId,
      ) ||
      null
    : null;
  const selectedLineProof = selectedLineRow
    ? selectedLineRow.proofBundleId
      ? asArray(selectedLineRow.proofBundles).find(
          (bundle) => bundle.id === selectedLineRow.proofBundleId,
        ) ||
        proofBundles.find(
          (bundle) => bundle.id === selectedLineRow.proofBundleId,
        ) ||
        null
      : asArray(selectedLineRow.proofBundles)[0] || null
    : null;
  const selectedLineEvidenceRefs = selectedLineRow
    ? uniqueValues([
        ...asArray(selectedLineRow.evidenceRefs),
        ...asArray(selectedLineProof?.evidenceRefs),
      ])
    : [];
  const selectedLineInspectionRefs = selectedLineRow
    ? uniqueValues(
        inspectionRuns
          .filter((run) =>
            asArray(run.changedPaths).some((changedPath) =>
              pathCoversFile(changedPath, selectedLineRow.filePath),
            ),
          )
          .flatMap(inspectionRunRefs),
      )
    : [];
  const selectedLineDojoRefs = selectedLineRow
    ? uniqueValues([
        ...asArray(selectedLineRow.dojoSourceRefs),
        selectedLineLease?.dojoProofRef,
        selectedLineLease?.dojoLicenseRef,
        ...asArray(selectedLineLease?.dojoEvidenceRefs),
      ])
    : [];
  const artifactContent = artifacts.find(
    (file) => file.contentPreview,
  )?.contentPreview;
  const artifactContentPath = artifacts.find(
    (file) => file.contentPreview,
  )?.path;
  const latestSimulation = latestCounterfactualSimulation(counterfactualRuns);
  const towerSimulation = simulationRun.result || latestSimulation.result;
  const towerUniverses = asArray(towerSimulation?.universes);
  const selectedUniverse =
    towerUniverses.find(
      (universe) => universe.strategy === towerSimulation?.selected,
    ) ||
    towerUniverses[0] ||
    null;

  useEffect(() => {
    setLineInspector({ status: "idle", row: null, rows: [], error: null });
    setSimulationRun({ status: "idle", result: null, error: null });
    setQuarantineReview({
      selectedId: null,
      selectedPaths: [],
      status: "idle",
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    });
    setPermitDraft({ title: "", permitType: "restricted_route", route: "" });
    setRouteDraft({ route: "", reason: "" });
    setGovernanceAction({ status: "idle", result: null, error: null });
  }, [currentProject?.id]);

  useEffect(() => {
    if (!selectedQuarantine) return;
    if (quarantineReview.selectedId === selectedQuarantine.quarantineId) return;
    setQuarantineReview((current) => ({
      ...current,
      selectedId: selectedQuarantine.quarantineId,
      selectedPaths: [],
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    }));
  }, [quarantineReview.selectedId, selectedQuarantine]);

  const handleInspectLine = useCallback(
    async (row) => {
      if (!row?.filePath) return;
      const range = lineRange(row);
      setLineInspector({ status: "loading", row, rows: [], error: null });
      try {
        const rows = await fetchCodeSiteLineProvenance(workspaceSlug, {
          projectId: currentProject?.id,
          filePath: row.filePath,
          lineAnchor: row.lineAnchor,
          lineNumber: range.startLine,
        });
        const nextRows = rows.length ? rows : [row];
        setLineInspector({
          status: "ready",
          row: nextRows[0],
          rows: nextRows,
          error: null,
        });
      } catch (nextError) {
        setLineInspector({
          status: "error",
          row,
          rows: [row],
          error: nextError.message || "line_provenance_lookup_failed",
        });
      }
    },
    [currentProject?.id, workspaceSlug],
  );

  const handleSelectQuarantine = useCallback((record) => {
    setQuarantineReview({
      selectedId: record?.quarantineId || null,
      selectedPaths: [],
      status: "idle",
      replay: null,
      replayPathKey: "",
      apply: null,
      error: null,
    });
  }, []);

  const handleToggleQuarantinePath = useCallback((path) => {
    if (!path) return;
    setQuarantineReview((current) => {
      const currentPaths = new Set(current.selectedPaths);
      if (currentPaths.has(path)) currentPaths.delete(path);
      else currentPaths.add(path);
      return {
        ...current,
        selectedPaths: [...currentPaths],
        replay: null,
        replayPathKey: "",
        apply: null,
        error: null,
      };
    });
  }, []);

  const handleReplayQuarantine = useCallback(
    async (record) => {
      if (!workspaceSlug || !record?.quarantineId || acting) return;
      const paths = quarantineReview.selectedPaths;
      if (!paths.length) {
        setQuarantineReview((current) => ({
          ...current,
          error: "Select at least one quarantined path before replay.",
        }));
        return;
      }
      setActing(true);
      setQuarantineReview((current) => ({
        ...current,
        status: "replaying",
        error: null,
        replay: null,
        replayPathKey: selectedPathKey(paths),
        apply: null,
      }));
      try {
        const result = await replayCodeSiteQuarantine(
          workspaceSlug,
          record.quarantineId,
          {
            transactionId: record.transactionId,
            mutationLeaseId: record.mutationLeaseId,
            agentSessionId: record.agentSessionId,
            displayCallsign: record.displayCallsign,
            paths,
          },
        );
        setQuarantineReview((current) => ({
          ...current,
          status: "replayed",
          replay: result,
          replayPathKey: selectedPathKey(paths),
          error: null,
        }));
        void loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        }).catch((nextError) => {
          setError({
            status: nextError.status,
            message: nextError.message || "codesite_quarantine_refresh_failed",
          });
        });
      } catch (nextError) {
        setQuarantineReview((current) => ({
          ...current,
          status: "error",
          replay: nextError.body || null,
          replayPathKey: selectedPathKey(paths),
          error: nextError.message || "codesite_quarantine_replay_failed",
        }));
      } finally {
        setActing(false);
      }
    },
    [
      acting,
      loadRadar,
      quarantineReview.selectedPaths,
      radarState.selectedProjectId,
      workspaceSlug,
    ],
  );

  const handleApplyQuarantine = useCallback(
    async (record) => {
      if (!workspaceSlug || !record?.quarantineId || acting) return;
      const paths = quarantineReview.selectedPaths;
      if (
        !paths.length ||
        quarantineReview.replay?.ok !== true ||
        quarantineReview.replayPathKey !== selectedPathKey(paths)
      ) {
        setQuarantineReview((current) => ({
          ...current,
          error: "Replay the selected quarantined paths before apply.",
        }));
        return;
      }
      setActing(true);
      setQuarantineReview((current) => ({
        ...current,
        status: "applying",
        error: null,
        apply: null,
      }));
      try {
        const result = await applyCodeSiteQuarantine(
          workspaceSlug,
          record.quarantineId,
          {
            transactionId: record.transactionId,
            mutationLeaseId: record.mutationLeaseId,
            agentSessionId: record.agentSessionId,
            displayCallsign: record.displayCallsign,
            paths,
          },
        );
        setQuarantineReview((current) => ({
          ...current,
          status: "applied",
          apply: result,
          error: null,
        }));
        void loadRadar({
          silent: true,
          projectId: radarState.selectedProjectId,
        }).catch((nextError) => {
          setError({
            status: nextError.status,
            message: nextError.message || "codesite_quarantine_refresh_failed",
          });
        });
      } catch (nextError) {
        setQuarantineReview((current) => ({
          ...current,
          status: "error",
          apply: nextError.body || null,
          error: nextError.message || "codesite_quarantine_apply_failed",
        }));
      } finally {
        setActing(false);
      }
    },
    [
      acting,
      loadRadar,
      quarantineReview.replay,
      quarantineReview.replayPathKey,
      quarantineReview.selectedPaths,
      radarState.selectedProjectId,
      workspaceSlug,
    ],
  );

  const latestStatus = useMemo(() => {
    if (error?.status === 401) return "auth";
    if (error?.status === 404) return "missing";
    if (error) return "error";
    return controlState?.towerState || currentProject?.status || "idle";
  }, [controlState?.towerState, currentProject?.status, error]);
  const sections = useMemo(
    () => [
      { key: "overview", label: "Overview", icon: CodeSiteIcons.liveState },
      { key: "radar", label: "Graph", icon: CodeSiteIcons.workspaceGraph },
      { key: "tower", label: "Activity", icon: CodeSiteIcons.activity },
      { key: "channels", label: "Channels", icon: CodeSiteIcons.workspaceGraph },
      { key: "expertise", label: "Expertise", icon: CodeSiteIcons.agents },
      { key: "governance", label: "Governance", icon: CodeSiteIcons.governance },
      { key: "runway", label: "Locks", icon: CodeSiteIcons.pathLocks },
      { key: "quarantine", label: "Quarantine", icon: CodeSiteIcons.quarantine },
      { key: "evidence", label: "Evidence", icon: CodeSiteIcons.evidence },
      { key: "inspections", label: "Inspections", icon: CodeSiteIcons.lineage },
      { key: "replay", label: "Replay", icon: CodeSiteIcons.replay },
      { key: "simulator", label: "Simulator", icon: CodeSiteIcons.simulator },
    ],
    [],
  );

  // First navigation level: the four groups, each carrying the live detail line
  // and count that make the panel readable without clicking into it.
  const groupTiles = useMemo(
    () =>
      SECTION_GROUPS.map((group) => ({
        ...group,
        ...groupSummary(group.key, radarState.counts, {
          actionableQuarantines: actionableQuarantineRecords.length,
          counterfactualRuns: counterfactualRuns.length,
        }),
      })),
    [radarState.counts, actionableQuarantineRecords.length, counterfactualRuns.length],
  );

  // Second level: the sections belonging to the active group.
  const groupSections = useMemo(() => {
    const group = SECTION_GROUPS.find((entry) => entry.key === activeGroup);
    return sections.filter((section) => group?.sections.includes(section.key));
  }, [activeGroup, sections]);

  const activeSectionLabel = useMemo(
    () => sections.find((section) => section.key === activeSection)?.label,
    [sections, activeSection],
  );

  const viewProps = {
    project: currentProject,
    workspaceSlug,
    counts: radarState.counts,
    status: latestStatus,
    streamStatus,
    streamEvents,
    deploymentStatus,
    collisionForecast,
    risks,
    zones,
    noFlyZones,
    activeFlights,
    agentRegistry,
    activeLeases,
    activeTransactions,
    mutationTransactions,
    permits,
    documents,
    routeRevisions,
    openMaydays,
    runwayOccupancy,
    pilotLicenseHealth,
    proofBundles,
    quarantineRecords,
    events,
    allEvents,
    inboxItems,
    incidents,
    inspectionRuns,
    filesystemBoundaryProofs,
    allowedPaths: controlState?.allowedPaths,
    blockedPaths: controlState?.blockedPaths,
    requiredActions: asArray(controlState?.requiredActions),
    metrics,
    metricSections,
    metricSummary,
    artifacts,
    artifactContent,
    artifactContentPath,
    exportResult,
    replayHandovers,
    lineProvenance,
    selectedLineRow,
    selectedLineTransaction,
    selectedLineLease,
    selectedLineProof,
    selectedLineEvidenceRefs,
    selectedLineInspectionRefs,
    selectedLineDojoRefs,
    lineInspector,
    towerSimulation,
    latestSimulation,
    towerUniverses,
    selectedUniverse,
    assumptions,
    simulationRun,
    actionableQuarantineRecords,
    quarantineError: viewSlices.quarantineError ?? radarState.quarantineError,
    quarantineReview,
    selectedQuarantineId:
      selectedQuarantine?.quarantineId || quarantineReview.selectedId,
    permitDraft,
    routeDraft,
    actionState: governanceAction,
    disabled: acting,
    simulationDisabled: !radarState.selectedProjectId || loading || acting,
    onSelect: handleSelectSection,
    onPermitDraft: setPermitDraft,
    onRouteDraft: setRouteDraft,
    onIssuePermit: handleIssuePermit,
    onReviewDocument: handleReviewDocument,
    onProposeRouteRevision: handleProposeRouteRevision,
    onReviewRouteRevision: handleReviewRouteRevision,
    onApplyRouteRevision: handleApplyRouteRevision,
    onResumeMayday: handleResumeMayday,
    onRequiredActionReview: handleRequiredActionReview,
    pendingReviewTarget,
    onPendingReviewTargetConsumed: handlePendingReviewTargetConsumed,
    onSelectQuarantine: handleSelectQuarantine,
    onToggleQuarantinePath: handleToggleQuarantinePath,
    onReplayQuarantine: handleReplayQuarantine,
    onApplyQuarantine: handleApplyQuarantine,
    onInspectLine: handleInspectLine,
    onRunSimulation: handleRunTowerSimulation,
  };
  const ActiveView = VIEWS[activeSection] || OverviewView;

  // The root carries `@container/panel`: this panel is a dock whose width is
  // independent of the viewport, so everything inside lays out against
  // `@min-[…]/panel:` rather than the viewport breakpoints. Tailwind's container t-shirt
  // scale is not the viewport scale (`@md` is 28rem, not 48rem), so the
  // thresholds below are all explicit `@min-[…]` and mean what they say.
  return (
    <div
      data-testid="codesite-panel"
      className="vt-app-surface @container/panel flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{
        "--text-muted":
          "color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary) 22%)",
        color: "var(--text-primary)",
      }}
    >
      {/* vt-toolbar supplies the min-height, bottom border and panel gradient,
          so the frame shows through instead of being painted over. */}
      <div className="vt-toolbar shrink-0 px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                background:
                  "color-mix(in srgb, var(--accent-primary) 9%, var(--bg-elevated))",
              }}
            >
              <CodeSiteIcons.control
                className="h-4 w-4"
                style={{ color: "var(--accent-primary)" }}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">
                CodeSite Operations
              </div>
              <div
                className="truncate text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Agent work, path locks, governance, and release evidence
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className="hidden max-w-[18rem] truncate text-[11px] @min-[28rem]/panel:block"
              style={{ color: "var(--text-muted)" }}
              title={workspaceSlug}
            >
              {compact(workspaceSlug, "No workspace")}
            </span>
            <Pill tone={latestStatus}>{toneLabel(latestStatus)}</Pill>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasProjects ? (
            <div className="min-w-0 basis-full @min-[28rem]/panel:min-w-[220px] @min-[28rem]/panel:basis-0 @min-[28rem]/panel:flex-1">
              <label htmlFor="codesite-project-select" className="sr-only">
                CodeSite project
              </label>
              <Select
                value={radarState.selectedProjectId ? String(radarState.selectedProjectId) : undefined}
                onValueChange={(value) => setSelectedProjectId(value || null)}
              >
                <SelectTrigger
                  id="codesite-project-select"
                  data-testid="codesite-project-select"
                  className="h-11 w-full min-w-0 truncate text-xs"
                  aria-label="CodeSite project"
                >
                  <SelectValue placeholder="Select operation" />
                </SelectTrigger>
                <SelectContent align="start" className="min-w-[220px]">
                  {radarState.projects.map((project, index) => {
                    const value = String(project.id || project.slug || `project-${index}`);
                    return (
                      <SelectItem
                        key={value}
                        value={value}
                      >
                        {project.title}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <IconButton
            title="Refresh"
            onClick={() => loadRadar({ full: true })}
            disabled={loading || acting}
            testId="codesite-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </IconButton>
          <IconButton
            title="Export artifacts"
            onClick={handleExportArtifacts}
            disabled={!radarState.selectedProjectId || loading || acting}
            testId="codesite-export"
          >
            <CodeSiteIcons.artifacts className="h-3.5 w-3.5" />
            Export
          </IconButton>
        </div>
      </div>

      {loading && !currentProject && !error ? (
        <LoadingSkeleton />
      ) : (
        <div
          data-testid="codesite-panel-scroll"
          className="min-h-0 flex-1 overflow-y-auto pb-16"
          tabIndex={0}
          aria-label="CodeSite coordination sections"
          style={{
            background:
              "linear-gradient(90deg, color-mix(in srgb, var(--border-subtle) 20%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border-subtle) 14%, transparent) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        >
          <MobileSectionTabs
            groups={groupTiles}
            activeGroup={activeGroup}
            onSelect={handleSelectGroup}
            activeSectionLabel={activeSectionLabel}
          />
          <DesktopSectionRail
            groups={groupTiles}
            activeGroup={activeGroup}
            onSelect={handleSelectGroup}
          />
          {/* Second level, rendered here rather than inside either rail so it
              stays reachable at every panel width. */}
          <ViewStrip
            sections={groupSections}
            activeSection={activeSection}
            onSelect={handleSelectSection}
          />
          {error ? (
            <div
              data-testid="codesite-error-state"
              className="m-3 grid gap-3 rounded-lg border px-3 py-3 text-xs @min-[28rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[28rem]/panel:items-center"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--accent-danger) 38%, var(--border-subtle))",
                color: "var(--text-primary)",
                background:
                  "color-mix(in srgb, var(--bg-surface) 90%, var(--accent-danger) 4%)",
              }}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 font-semibold">
                  <CodeSiteIcons.conflicts className="h-3.5 w-3.5 shrink-0" />
                  <span>CodeSite sync interrupted</span>
                </div>
                <div
                  className="mt-1 break-words leading-5"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {error.status ? `${error.status}: ` : null}
                  {error.message}
                </div>
              </div>
              <IconButton
                title="Retry CodeSite sync"
                onClick={() => loadRadar({ full: true })}
                disabled={loading || acting}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </IconButton>
            </div>
          ) : null}

          {!hasProjects ? (
            <div className="p-3">
              <form
                data-testid="codesite-empty-state"
                onSubmit={handleCreateProject}
                className="grid gap-4 rounded-lg border p-4"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--border-subtle) 64%, var(--accent-primary) 36%)",
                  background:
                    "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 7%), var(--bg-editor))",
                }}
              >
                <div className="grid gap-3 @min-[28rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[28rem]/panel:items-start">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md border"
                        style={{
                          borderColor:
                            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
                          background:
                            "color-mix(in srgb, var(--accent-primary) 10%, transparent)",
                        }}
                      >
                        <CodeSiteIcons.control
                          className="h-3.5 w-3.5"
                          style={{ color: "var(--accent-primary)" }}
                        />
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          No coordination project yet
                        </div>
                        <div
                          className="mt-1 text-xs leading-5"
                          style={{ color: "var(--text-muted)" }}
                        >
                          Create a governed workspace for agent workstreams, path locks, approvals, and evidence.
                        </div>
                      </div>
                    </div>
                  </div>
                  <Pill tone="idle">needs setup</Pill>
                </div>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="codesite-new-project-title"
                      className="mb-1 block text-[11px]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Project title
                    </label>
                    <input
                      id="codesite-new-project-title"
                      value={newProjectTitle}
                      onChange={(event) =>
                        setNewProjectTitle(event.target.value)
                      }
                      placeholder="Coordination project"
                      className="h-8 w-full min-w-0 rounded border px-2 text-xs outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)] focus:[outline-style:solid]"
                      style={{
                        borderColor: "var(--border-subtle)",
                        background: "var(--bg-editor)",
                        color: "var(--text-primary)",
                      }}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <div
                    className="mb-1 text-[11px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    How should agents in this project coordinate?
                  </div>
                  <div
                    className="mb-2 text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    This trades speed against auditability. It applies to every
                    agent session attached to this project.
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {CHANNEL_MODE_OPTIONS.map((option) => {
                      const selected =
                        newProjectChannelMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setNewProjectChannelMode(option.value)}
                          className="rounded border p-2 text-left transition-colors"
                          style={{
                            borderColor: selected
                              ? "var(--attention-purple)"
                              : "var(--border-subtle)",
                            background: selected
                              ? "var(--bg-hover)"
                              : "var(--bg-editor)",
                            color: "var(--text-primary)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] font-medium">
                              {option.label}
                            </span>
                            <span
                              className="text-[10px]"
                              title={`Speed ${option.speed}/4 · Audit ${option.audit}/4`}
                            >
                              {"●".repeat(option.speed)}
                              <span style={{ color: "var(--text-muted)" }}>
                                {"○".repeat(4 - option.speed)}
                              </span>
                              {" / "}
                              {"●".repeat(option.audit)}
                              <span style={{ color: "var(--text-muted)" }}>
                                {"○".repeat(4 - option.audit)}
                              </span>
                            </span>
                          </div>
                          <div
                            className="mt-0.5 text-[10px] leading-snug"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {option.hint}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                  <div className="flex items-end gap-2">
                  <IconButton
                    title="Create project"
                    variant="primary"
                    disabled={acting || !workspaceSlug}
                    type="submit"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create
                  </IconButton>
                </div>
              </form>
            </div>
          ) : null}

          {currentProject ? (
            <div
              id={`codesite-section-${activeSection}`}
              role="tabpanel"
              data-testid="codesite-responsive-proof-target"
              className="grid min-w-0 content-start"
            >
              <ActiveView {...viewProps} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
