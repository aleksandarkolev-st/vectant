"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Plus, RefreshCw } from "lucide-react";
import { applyCodeSiteRouteRevision, applyCodeSiteQuarantine, createCodeSiteProject, createEmptyCodeSiteRadarState, exportCodeSiteArtifacts, fetchCodeSiteLineProvenance, fetchCodeSiteRadarState, issueCodeSitePermit, proposeCodeSiteRouteRevision, replayCodeSiteQuarantine, resumeCodeSiteMayday, reviewCodeSiteDocument, reviewCodeSiteRouteRevision, simulateCodeSiteShadowMerge, subscribeCodeSiteProjectEvents } from "./codesiteClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodeSiteIcons } from "./icons";
import { MOTION_EASE } from "./lib/motion";
import ScopeTopology from "./views/graph/ScopeTopology";
import DesktopSectionRail from "./nav/DesktopSectionRail";
import MobileSectionTabs from "./nav/MobileSectionTabs";
import TowerNowStrip from "./views/overview/TowerNowStrip";
import CodeSiteOperatingModel from "./views/overview/CodeSiteOperatingModel";
import SuccessMetricsDeck from "./views/evidence/SuccessMetricsDeck";
import SerializableIsolationDeck from "./views/evidence/SerializableIsolationDeck";
import RunwayOccupancyBoard from "./views/locks/RunwayOccupancyBoard";
import PilotLicenseHealthPanel from "./views/locks/PilotLicenseHealthPanel";
import TowerSimulatorDeck from "./views/simulator/TowerSimulatorDeck";
import FilesystemBoundaryProofPanel from "./views/quarantine/FilesystemBoundaryProofPanel";
import QuarantineReviewPanel from "./views/quarantine/QuarantineReviewPanel";
import TowerStreamPanel from "./views/activity/TowerStreamPanel";
import BlackBoxFlightRecorder from "./views/activity/BlackBoxFlightRecorder";
import GovernanceConsole from "./views/governance/GovernanceConsole";
import CausalReplayDeck from "./views/replay/CausalReplayDeck";
import LineProvenanceDeck from "./views/replay/LineProvenanceDeck";
import { causalReplayHandovers, replayCompletenessTone } from "./views/replay/handovers";
import { EmptyLine, IconButton, JsonPreview, LoadingSkeleton, Metric, OperatorPane, PathList, Pill, Row, Section, StatusRailItem, TagList } from "./ui";
import {
  asArray, compact, formatTime, inspectionRunRefs,
  latestCounterfactualSimulation, lineRange, mergeTransactionSources,
  pathCoversFile, productCopy, riskTone, toneLabel, uniqueByEvent, uniqueValues,
} from "./lib/format";
import {
  actionEntity, actionEntityId, actionEvidenceRefs,
  actionHasGovernanceReviewTarget, actionKind, actionLabel, actionOwner,
  actionSeverity, documentNeedsReview, incidentNeedsResume,
  routeRevisionCanReview,
} from "./lib/governance";
import {
  hasEntries, mergeQuarantineRecords, quarantineRecordsFromEvents,
  selectedPathKey,
} from "./lib/quarantine";
import { displayZoneName, zonePaths, zoneTierLabel } from "./lib/graph";


const POLL_MS = 5000;




function findGovernanceEntityRow(attributeName, entityId) {
  if (!entityId || typeof document === "undefined") return null;
  return Array.from(document.querySelectorAll(`[${attributeName}]`)).find(
    (element) => element.getAttribute(attributeName) === entityId,
  );
}













































export default function CodeSitePanel({ workspaceSlug }) {
  const reduceMotion = useReducedMotion();
  const scrollContainerRef = useRef(null);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [radarState, setRadarState] = useState(() =>
    createEmptyCodeSiteRadarState(workspaceSlug),
  );
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState(null);
  const [newProjectTitle, setNewProjectTitle] = useState("");
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
  const [activeSection, setActiveSection] = useState("radar");
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

  const loadRadar = useCallback(
    async ({ silent = false, projectId = selectedProjectId } = {}) => {
      if (!workspaceSlug) {
        setRadarState(createEmptyCodeSiteRadarState(workspaceSlug));
        setLoading(false);
        return;
      }

      if (!silent) setLoading(true);

      try {
        const next = await fetchCodeSiteRadarState(workspaceSlug, projectId);
        setRadarState(next);
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
    setStreamEvents([]);
    if (!workspaceSlug || !radarState.selectedProjectId) {
      setStreamStatus("polling");
      return undefined;
    }
    return subscribeCodeSiteProjectEvents(
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
            return [event, ...withoutDuplicate].slice(0, 12);
          });
        },
      },
    );
  }, [radarState.selectedProjectId, workspaceSlug]);

  const handleSelectSection = useCallback(
    (sectionKey) => {
      setActiveSection(sectionKey);
      if (typeof document !== "undefined") {
        const target = document.querySelector(
          `[data-codesite-section="${sectionKey}"]`,
        );
        const scrollContainer = scrollContainerRef.current;
        if (!target || !scrollContainer) {
          target?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          return;
        }
        const stickyHeight = [
          '[data-testid="codesite-mobile-section-tabs"]',
          '[data-testid="codesite-desktop-section-rail"]',
        ].reduce((height, selector) => {
          const rail = scrollContainer.querySelector(selector);
          return height + (rail?.getBoundingClientRect().height || 0);
        }, 0);
        if (typeof scrollContainer.scrollTo !== "function") {
          target?.scrollIntoView?.({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        scrollContainer.scrollTo({
          top: Math.max(
            0,
            scrollContainer.scrollTop +
              targetRect.top -
              containerRect.top -
              stickyHeight -
              12,
          ),
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }
    },
    [reduceMotion],
  );

  const handleRequiredActionReview = useCallback(
    (action) => {
      handleSelectSection("governance");
      const kind = actionKind(action);
      const entityId = actionEntityId(action);
      window.setTimeout(() => {
        const candidates = [];
        if (action?.documentId || /document|rfi|change_order/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-document-id",
            action?.documentId || entityId,
          );
          const button = row?.querySelector(
            '[data-testid="codesite-document-approve-button"]',
          );
          if (button) candidates.push(button);
        }
        if (action?.routeRevisionId || /route|reroute/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-route-revision-id",
            action?.routeRevisionId || entityId,
          );
          // Both route buttons always render; only their disabled state differs,
          // so `apply || review` always resolved to apply and left review
          // unreachable. Offer both and let the disabled filter below choose —
          // apply first, preserving the original preference.
          const applyButton = row?.querySelector(
            '[data-testid="codesite-route-apply-button"]',
          );
          const reviewButton = row?.querySelector(
            '[data-testid="codesite-route-review-button"]',
          );
          if (applyButton) candidates.push(applyButton);
          if (reviewButton) candidates.push(reviewButton);
        }
        if (action?.incidentId || /mayday|ground|resume/.test(kind)) {
          const row = findGovernanceEntityRow(
            "data-codesite-mayday-id",
            action?.incidentId || entityId,
          );
          const button = row?.querySelector(
            '[data-testid="codesite-resume-mayday-submit"]',
          );
          if (button) candidates.push(button);
        }

        const target = candidates.find((button) => !button.disabled);
        if (target) {
          target.focus({ preventScroll: true });
          target.click();
          return;
        }

        const console = document.querySelector(
          '[data-testid="codesite-governance-console"]',
        );
        console?.scrollIntoView?.({ behavior: "auto", block: "start" });
        console?.focus?.({ preventScroll: true });
      }, 0);
    },
    [handleSelectSection],
  );

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
          zonePolicy: {
            zones: [],
            noFlyZones: [],
            classRules: {},
          },
        });
        setNewProjectTitle("");
        setSelectedProjectId(project?.id || null);
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
    [acting, loadRadar, newProjectTitle, workspaceSlug],
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
  const metrics = radarState.metrics;
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
  const counterfactualRuns = asArray(currentProject?.counterfactualRuns);
  const artifacts = asArray(radarState.artifactPreview?.files);
  const events = uniqueByEvent([
    ...streamEvents,
    ...asArray(radarState.events).slice().reverse(),
  ]).slice(0, 24);
  const allEvents = asArray(radarState.events);
  const quarantineRecords = useMemo(
    () =>
      mergeQuarantineRecords(
        radarState.quarantines,
        controlState?.pendingQuarantines,
        quarantineRecordsFromEvents(allEvents),
      ),
    [allEvents, controlState?.pendingQuarantines, radarState.quarantines],
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
  const mobileSections = useMemo(
    () => [
      { key: "radar", label: "Graph", icon: CodeSiteIcons.workspaceGraph },
      { key: "tower", label: "Activity", icon: CodeSiteIcons.activity },
      { key: "governance", label: "Governance", icon: CodeSiteIcons.governance },
      { key: "evidence", label: "Evidence", icon: CodeSiteIcons.evidence },
      { key: "simulator", label: "Simulator", icon: CodeSiteIcons.simulator },
      { key: "quarantine", label: "Quarantine", icon: CodeSiteIcons.quarantine },
      { key: "replay", label: "Replay", icon: CodeSiteIcons.replay },
      { key: "lineage", label: "Lineage", icon: CodeSiteIcons.lineage },
      { key: "runway", label: "Locks", icon: CodeSiteIcons.pathLocks },
    ],
    [],
  );

  return (
    <div
      data-testid="codesite-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{
        "--text-muted":
          "color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary) 22%)",
        color: "var(--text-primary)",
      }}
    >
      <div
        className="shrink-0 border-b px-3 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.16)]"
        style={{
          borderColor: "var(--codesite-panel-line)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-sidebar) 94%, var(--bg-elevated) 6%), color-mix(in srgb, var(--bg-sidebar) 98%, var(--bg-editor) 2%))",
        }}
      >
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
              className="hidden max-w-[18rem] truncate text-[11px] sm:block"
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
            <div className="min-w-0 basis-full sm:min-w-[220px] sm:basis-0 sm:flex-1">
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
            onClick={() => loadRadar()}
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
          ref={scrollContainerRef}
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
            sections={mobileSections}
            activeSection={activeSection}
            onSelect={handleSelectSection}
          />
          <DesktopSectionRail
            sections={mobileSections}
            activeSection={activeSection}
            onSelect={handleSelectSection}
            status={latestStatus}
            streamStatus={streamStatus}
          />
          {error ? (
            <div
              data-testid="codesite-error-state"
              className="m-3 grid gap-3 rounded-lg border px-3 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
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
                onClick={() => loadRadar()}
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
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
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
            <>
              <motion.div
                data-testid="codesite-operator-cockpit"
                className="grid gap-3 p-3 sm:p-4"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.24,
                  ease: MOTION_EASE,
                }}
              >
                <div
                  data-testid="codesite-mission-control-header"
                  className="grid gap-3 rounded-lg border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.055)] xl:grid-cols-[minmax(0,1fr)_minmax(460px,0.82fr)] xl:items-center"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--border-subtle) 58%, var(--accent-primary) 42%)",
                    background:
                      "linear-gradient(135deg, color-mix(in srgb, var(--bg-surface) 88%, var(--accent-primary) 9%), color-mix(in srgb, var(--bg-editor) 92%, var(--text-primary) 4%))",
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Pill tone={latestStatus}>{toneLabel(latestStatus)}</Pill>
                      <Pill
                        tone={
                          streamStatus === "live"
                            ? "active"
                            : streamStatus === "reconnecting"
                              ? "warning"
                              : "idle"
                        }
                      >
                        {streamStatus}
                      </Pill>
                      {collisionForecast.riskLevel ? (
                        <Pill tone={collisionForecast.riskLevel}>
                          {collisionForecast.riskLevel}
                        </Pill>
                      ) : null}
                    </div>
                    <h2
                      className="mt-2 max-w-[760px] break-words text-2xl font-semibold leading-tight sm:text-3xl"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {currentProject.title}
                    </h2>
                    <p
                      className="mt-1.5 max-w-[72ch] text-sm leading-6"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {currentProject.request}
                    </p>
                  </div>
                  <div
                    data-testid="codesite-status-rail"
                    className="grid grid-cols-2 gap-2 xl:grid-cols-4"
                  >
                    <StatusRailItem
                      label="Workstreams"
                      value={radarState.counts.activeFlights}
                      tone={activeFlights.length ? "active" : "idle"}
                      icon={CodeSiteIcons.agents}
                      testId="codesite-status-flights"
                    />
                    <StatusRailItem
                      label="Actions"
                      value={radarState.counts.requiredActions}
                      tone={radarState.counts.requiredActions ? "high" : "low"}
                      icon={CodeSiteIcons.actions}
                      testId="codesite-status-required"
                    />
                    <StatusRailItem
                      label="Approvals"
                      value={permits.length}
                      tone={permits.length ? "active" : "holding"}
                      icon={CodeSiteIcons.approvals}
                      testId="codesite-status-permits"
                    />
                    <StatusRailItem
                      label="Plan changes"
                      value={routeRevisions.length}
                      tone={
                        routeRevisions.filter(routeRevisionCanReview).length
                          ? "warning"
                          : "active"
                      }
                      icon={CodeSiteIcons.planChanges}
                      testId="codesite-status-plan-changes"
                    />
                  </div>
                </div>

                <TowerNowStrip
                  towerState={latestStatus}
                  streamStatus={streamStatus}
                  collisionForecast={collisionForecast}
                  risks={risks}
                  requiredActionCount={radarState.counts.requiredActions}
                  documents={documents}
                  routeRevisions={routeRevisions}
                  openMaydays={openMaydays}
                  runwayOccupancy={runwayOccupancy}
                  activeTransactions={activeTransactions}
                  proofBundles={proofBundles}
                  quarantineRecords={quarantineRecords}
                  onSelect={handleSelectSection}
                />

                <CodeSiteOperatingModel
                  activeFlights={activeFlights}
                  activeLeases={activeLeases}
                  documents={documents}
                  routeRevisions={routeRevisions}
                  proofBundles={proofBundles}
                  onSelect={handleSelectSection}
                />

                <div
                  data-testid="codesite-responsive-proof-target"
                  className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)] xl:items-start"
                >
                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Workspace Graph"
                      icon={CodeSiteIcons.workspaceGraph}
                      sectionKey="radar"
                      testId="codesite-operator-airspace-pane"
                      right={
                        <Pill>{zones.length || activeFlights.length}</Pill>
                      }
                    >
                      <ScopeTopology
                        zones={zones}
                        noFlyZones={noFlyZones}
                        flights={activeFlights}
                        risks={risks}
                        events={events}
                        inspections={inspectionRuns}
                        condensed
                      />
                    </OperatorPane>

                    <div
                      data-testid="codesite-metric-rail"
                      className="grid grid-cols-[repeat(auto-fit,minmax(126px,1fr))] gap-2"
                    >
                      <Metric
                        label="Workstreams"
                        value={radarState.counts.activeFlights}
                        testId="codesite-metric-flights"
                        icon={CodeSiteIcons.agents}
                      />
                      <Metric
                        label="Path locks"
                        value={radarState.counts.activeMutationLeases}
                        icon={CodeSiteIcons.pathLocks}
                      />
                      <Metric
                        label="Transactions"
                        value={radarState.counts.activeTransactions}
                        icon={CodeSiteIcons.transactions}
                      />
                      <Metric
                        label="Actions"
                        value={radarState.counts.requiredActions}
                        tone={
                          radarState.counts.requiredActions ? "high" : "low"
                        }
                        icon={CodeSiteIcons.actions}
                      />
                      <Metric
                        label="Conflict"
                        value={compact(collisionForecast.riskLevel, "unknown")}
                        tone={collisionForecast.riskLevel}
                        icon={CodeSiteIcons.conflicts}
                      />
                      <Metric
                        label="Approvals"
                        value={permits.length}
                        tone={permits.length ? "active" : "idle"}
                        testId="codesite-metric-permits"
                        icon={CodeSiteIcons.approvals}
                      />
                      <Metric
                        label="Documents"
                        value={documents.length}
                        tone={
                          documents.filter(documentNeedsReview).length
                            ? "holding"
                            : "active"
                        }
                        icon={CodeSiteIcons.files}
                      />
                      <Metric
                        label="Plan changes"
                        value={routeRevisions.length}
                        tone={
                          routeRevisions.filter(routeRevisionCanReview).length
                            ? "holding"
                            : "idle"
                        }
                        icon={CodeSiteIcons.planChanges}
                      />
                    </div>
                  </div>

                  <div className="grid min-w-0 content-start gap-3">
                    <OperatorPane
                      title="Activity Feed"
                      icon={CodeSiteIcons.activity}
                      sectionKey="tower"
                      testId="codesite-operator-tower-pane"
                      right={
                        <Pill
                          tone={
                            streamStatus === "live"
                              ? "active"
                              : streamStatus === "reconnecting"
                                ? "warning"
                                : "idle"
                          }
                        >
                          {streamStatus}
                        </Pill>
                      }
                    >
                      <TowerStreamPanel
                        events={events}
                        streamStatus={streamStatus}
                        condensed
                      />
                    </OperatorPane>

                    <OperatorPane
                      title="Governance Console"
                      icon={CodeSiteIcons.governance}
                      sectionKey="governance"
                      testId="codesite-operator-governance-pane"
                      right={
                        <Pill
                          tone={
                            documents.filter(documentNeedsReview).length ||
                            routeRevisions.filter(routeRevisionCanReview)
                              .length ||
                            openMaydays.length
                              ? "holding"
                              : "active"
                          }
                        >
                          {permits.length}/{documents.length}/
                          {routeRevisions.length}
                        </Pill>
                      }
                    >
                      <GovernanceConsole
                        project={currentProject}
                        activeFlights={activeFlights}
                        activeLeases={activeLeases}
                        incidents={incidents}
                        inspectionRuns={inspectionRuns}
                        permitDraft={permitDraft}
                        routeDraft={routeDraft}
                        onPermitDraft={setPermitDraft}
                        onRouteDraft={setRouteDraft}
                        onIssuePermit={handleIssuePermit}
                        onReviewDocument={handleReviewDocument}
                        onProposeRouteRevision={handleProposeRouteRevision}
                        onReviewRouteRevision={handleReviewRouteRevision}
                        onApplyRouteRevision={handleApplyRouteRevision}
                        onResumeMayday={handleResumeMayday}
                        actionState={governanceAction}
                        disabled={acting}
                        condensed
                      />
                    </OperatorPane>
                  </div>
                </div>
              </motion.div>

              <Section
                title="Success Metrics"
                icon={CodeSiteIcons.metrics}
                sectionKey="evidence"
                right={
                  <Pill tone={metrics?.status || "pending"}>
                    {metrics ? "measured" : "no data"}
                  </Pill>
                }
              >
                {metrics ? (
                  <SuccessMetricsDeck
                    sections={metricSections}
                    summary={metricSummary}
                  />
                ) : (
                  <EmptyLine>No success metrics exported yet</EmptyLine>
                )}
              </Section>

              <Section
                title="Path Locks"
                icon={CodeSiteIcons.pathLocks}
                sectionKey="runway"
                right={
                  <Pill tone={runwayOccupancy.length ? "holding" : "active"}>
                    {runwayOccupancy.length}
                  </Pill>
                }
              >
                <RunwayOccupancyBoard runways={runwayOccupancy} />
              </Section>

              <Section
                title="Agent Readiness"
                icon={CodeSiteIcons.agents}
                right={
                  <Pill
                    tone={
                      pilotLicenseHealth.some(
                        (record) => record.status !== "active",
                      )
                        ? "holding"
                        : "active"
                    }
                  >
                    {pilotLicenseHealth.length}
                  </Pill>
                }
              >
                <PilotLicenseHealthPanel records={pilotLicenseHealth} />
              </Section>

              <Section
                title="Filesystem Boundary Evidence"
                icon={CodeSiteIcons.files}
                right={
                  <Pill
                    tone={
                      filesystemBoundaryProofs.some(
                        (record) => !record.proofComplete,
                      )
                        ? "holding"
                        : filesystemBoundaryProofs.length
                          ? "active"
                          : "idle"
                    }
                  >
                    {filesystemBoundaryProofs.length}
                  </Pill>
                }
              >
                <FilesystemBoundaryProofPanel
                  records={filesystemBoundaryProofs}
                />
              </Section>

              <Section
                title="Quarantine Review"
                icon={CodeSiteIcons.quarantine}
                sectionKey="quarantine"
                right={
                  <Pill
                    tone={
                      actionableQuarantineRecords.length ? "holding" : "active"
                    }
                  >
                    {actionableQuarantineRecords.length}
                  </Pill>
                }
              >
                <QuarantineReviewPanel
                  records={actionableQuarantineRecords}
                  fetchError={radarState.quarantineError}
                  selectedId={
                    selectedQuarantine?.quarantineId ||
                    quarantineReview.selectedId
                  }
                  selectedPaths={quarantineReview.selectedPaths}
                  reviewState={quarantineReview}
                  onSelect={handleSelectQuarantine}
                  onTogglePath={handleToggleQuarantinePath}
                  onReplay={handleReplayQuarantine}
                  onApply={handleApplyQuarantine}
                  disabled={acting}
                />
              </Section>

              <Section
                title="Conflict Forecast"
                icon={CodeSiteIcons.conflicts}
                right={
                  <Pill tone={riskTone(collisionForecast.riskLevel)}>
                    {compact(collisionForecast.riskLevel, "unknown")}
                  </Pill>
                }
              >
                {risks.length === 0 ? (
                  <EmptyLine>No forecasted conflicts</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {risks.map((risk, index) => (
                      <div
                        key={`${risk.risk || risk.type || "risk"}-${index}`}
                        className="rounded border px-3 py-2 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {compact(risk.risk || risk.type, "collision")}
                          </span>
                          <Pill tone={risk.severity || risk.riskLevel}>
                            {compact(risk.severity || risk.riskLevel, "risk")}
                          </Pill>
                        </div>
                        <div
                          className="mt-1 truncate"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {compact(
                            risk.conflictZone || risk.path || risk.zoneKey,
                            "unknown zone",
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Coordination Simulator"
                icon={CodeSiteIcons.simulator}
                sectionKey="simulator"
                right={
                  <Pill tone={selectedUniverse?.result || simulationRun.status}>
                    {compact(
                      towerSimulation?.selected,
                      simulationRun.status === "running"
                        ? "running"
                        : "not run",
                    )}
                  </Pill>
                }
              >
                <TowerSimulatorDeck
                  towerSimulation={towerSimulation}
                  latestSimulation={latestSimulation}
                  towerUniverses={towerUniverses}
                  selectedUniverse={selectedUniverse}
                  assumptions={assumptions}
                  activeFlights={activeFlights}
                  activeLeases={activeLeases}
                  events={allEvents}
                  simulationRun={simulationRun}
                  onRun={handleRunTowerSimulation}
                  disabled={!radarState.selectedProjectId || loading || acting}
                />
              </Section>

              <Section
                title="Workstreams"
                icon={CodeSiteIcons.agents}
                right={<Pill>{activeFlights.length}</Pill>}
              >
                {activeFlights.length === 0 ? (
                  <EmptyLine>No active workstreams</EmptyLine>
                ) : (
                  <div>
                    {activeFlights.map((plan, index) => (
                      <Row
                        key={
                          plan.id || plan.displayCallsign || `flight-${index}`
                        }
                        testId={`codesite-flight-${plan.id || index}`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {compact(plan.displayCallsign, "agent")}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {compact(plan.domain, "implementation")}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="truncate">
                            {productCopy(plan.mission, "Code mutation workstream")}
                          </div>
                          <PathList paths={plan.route || []} />
                        </div>
                        <div className="justify-self-end">
                          <Pill tone={plan.status}>{toneLabel(plan.status)}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Approvals"
                icon={CodeSiteIcons.approvals}
                right={<Pill>{activeLeases.length}</Pill>}
              >
                {activeLeases.length === 0 ? (
                  <EmptyLine>No active approvals</EmptyLine>
                ) : (
                  <div>
                    {activeLeases.map((lease, index) => (
                      <Row
                        key={
                          lease.id || lease.displayCallsign || `lease-${index}`
                        }
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {compact(lease.displayCallsign, "agent")}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {formatTime(lease.expiresAt) || "open"}
                          </div>
                        </div>
                        <div className="min-w-0">
                          <PathList
                            paths={lease.lease?.allowedPaths || []}
                            empty="route pending"
                          />
                          <TagList
                            items={[
                              lease.dojoProofRef,
                              lease.dojoLicenseRef,
                              ...asArray(lease.dojoEvidenceRefs),
                              lease.dojoLedgerCheckpointHash,
                              lease.dojoDecisionDigest,
                            ]}
                            empty=""
                          />
                          <TagList
                            items={[
                              lease.pilotLicenseHealth?.status
                                ? `agent:${lease.pilotLicenseHealth.status}`
                                : null,
                              lease.pilotLicenseHealth?.level
                                ? `level:${lease.pilotLicenseHealth.level}`
                                : null,
                              lease.pilotLicenseRequirement?.minimumLevel
                                ? `min:${lease.pilotLicenseRequirement.minimumLevel}`
                                : null,
                            ]}
                            empty=""
                          />
                        </div>
                        <div className="justify-self-end">
                          <Pill tone={lease.status}>{toneLabel(lease.status)}</Pill>
                        </div>
                      </Row>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Transactions & Evidence"
                icon={CodeSiteIcons.transactions}
                right={
                  <Pill>
                    {mergeTransactionSources(activeTransactions, mutationTransactions).length}/
                    {proofBundles.length}
                  </Pill>
                }
              >
                <SerializableIsolationDeck
                  activeTransactions={activeTransactions}
                  mutationTransactions={mutationTransactions}
                  proofBundles={proofBundles}
                  events={allEvents}
                />
              </Section>

              <Section
                title="Inspections & Incidents"
                icon={CodeSiteIcons.incidents}
                right={
                  <Pill tone={incidents.length ? "blocked" : "active"}>
                    {incidents.length}
                  </Pill>
                }
              >
                {inspectionRuns.length === 0 && incidents.length === 0 ? (
                  <EmptyLine>No inspections or incidents</EmptyLine>
                ) : (
                  <div className="space-y-2">
                    {inspectionRuns
                      .slice(-3)
                      .reverse()
                      .map((run, index) => (
                        <div
                          key={run.id || `inspection-run-${index}`}
                          className="rounded border px-3 py-2 text-xs"
                          style={{
                            borderColor: "var(--border-subtle)",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {compact(run.displayCallsign, "inspection")}
                            </span>
                            <Pill tone={run.status}>{toneLabel(run.status)}</Pill>
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={run.changedPaths || []}
                              empty="no changed paths"
                            />
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {asArray(run.inspectionSignals)
                              .slice(0, 3)
                              .map((signal, index) => (
                                <Pill
                                  key={`${run.id}-signal-${index}`}
                                  tone={signal.status || run.status}
                                >
                                  {compact(
                                    signal.key || signal.type || signal.kind,
                                    "signal",
                                  )}
                                </Pill>
                              ))}
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={run.evidenceRefs || []}
                              empty="no evidence refs"
                            />
                          </div>
                        </div>
                      ))}
                    {incidents
                      .slice(-3)
                      .reverse()
                      .map((incident, index) => (
                        <div
                          key={incident.id || `incident-${index}`}
                          className="rounded border px-3 py-2 text-xs"
                          style={{
                            borderColor:
                              "color-mix(in srgb, var(--accent-danger) 36%, var(--border-subtle))",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {productCopy(incident.category, "incident")}
                            </span>
                            <Pill tone={incident.severity}>
                              {incident.severity}
                            </Pill>
                          </div>
                          <div className="mt-1">
                            <PathList
                              paths={incident.affectedZones || []}
                              empty="no affected zones"
                            />
                          </div>
                          <div className="mt-1 grid gap-1 sm:grid-cols-2">
                            <PathList
                              paths={incident.participants || []}
                              empty="no participants"
                            />
                            <PathList
                              paths={incident.evidenceRefs || []}
                              empty="no evidence refs"
                            />
                          </div>
                          <div
                            className="mt-1 truncate font-mono text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {incident.replayDigest ||
                              compact(
                                incident.incidentReplay?.summary,
                                "no replay digest",
                              )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </Section>

              <Section
                title="Replay Handover"
                icon={CodeSiteIcons.replay}
                sectionKey="replay"
                right={
                  <Pill
                    tone={
                      replayHandovers.length
                        ? replayCompletenessTone(
                            replayHandovers[0].completeness,
                          )
                        : "pending"
                    }
                  >
                    {replayHandovers.length}
                  </Pill>
                }
              >
                <CausalReplayDeck handovers={replayHandovers} />
              </Section>

              <Section
                title="Artifact Export Preview"
                icon={CodeSiteIcons.artifacts}
                right={<Pill>{artifacts.length}</Pill>}
              >
                {exportResult ? (
                  <div
                    className="mb-2 rounded border px-3 py-2 text-xs"
                    style={{
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {exportResult.written
                      ? "Artifacts written"
                      : "Preview only"}
                    {exportResult.root ? `: ${exportResult.root}` : ""}
                  </div>
                ) : null}
                {artifacts.length === 0 ? (
                  <EmptyLine>No artifact preview</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {artifacts.slice(0, 10).map((file, index) => (
                      <div
                        key={file.path || `artifact-${index}`}
                        className="flex items-center justify-between gap-3 rounded border px-2 py-1.5 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <code
                          className="min-w-0 truncate text-[10px]"
                          title={file.path}
                        >
                          {file.path}
                        </code>
                        <span
                          className="shrink-0 font-mono text-[10px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          {file.bytes}b
                        </span>
                      </div>
                    ))}
                    {artifactContent ? (
                      <div className="pt-2">
                        <div
                          className="mb-1 flex items-center gap-2 text-[11px]"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <CodeSiteIcons.lineage className="h-3.5 w-3.5" />
                          <span className="min-w-0 truncate">
                            {artifactContentPath}
                          </span>
                        </div>
                        <JsonPreview value={artifactContent} maxLines={12} />
                      </div>
                    ) : null}
                  </div>
                )}
              </Section>

              <Section
                title="Audit Event Log"
                icon={CodeSiteIcons.activity}
                right={<Pill>{events.length}</Pill>}
              >
                <BlackBoxFlightRecorder events={events} />
              </Section>

              <Section
                title="Required Actions"
                icon={CodeSiteIcons.actions}
                right={
                  <Pill
                    tone={
                      radarState.counts.requiredActions ? "holding" : "active"
                    }
                  >
                    {radarState.counts.requiredActions}
                  </Pill>
                }
              >
                {asArray(controlState?.requiredActions).length === 0 ? (
                  <EmptyLine>No blocking actions</EmptyLine>
                ) : (
                  <div className="space-y-1" data-testid="codesite-required-actions-list">
                    {controlState.requiredActions.map((action, index) => (
                      <div
                        key={`${actionLabel(action)}-${index}`}
                        data-testid="codesite-required-action-row"
                        className="rounded border px-2 py-2 text-[11px]"
                        style={{
                          borderColor:
                            "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
                          background:
                            "linear-gradient(180deg, var(--bg-surface), color-mix(in srgb, var(--bg-surface) 86%, var(--bg-editor) 14%))",
                        }}
                      >
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <Pill tone={actionSeverity(action)}>
                                {actionSeverity(action)}
                              </Pill>
                              <span className="min-w-0 break-words font-semibold">
                                {actionLabel(action)}
                              </span>
                            </div>
                            <div
                              className="mt-1 grid gap-1 font-mono text-[10px] sm:grid-cols-2"
                              style={{ color: "var(--text-muted)" }}
                            >
                              <span className="min-w-0 break-all">
                                owner: {actionOwner(action)}
                              </span>
                              <span className="min-w-0 break-all">
                                entity: {actionEntity(action)}
                              </span>
                            </div>
                            {actionEvidenceRefs(action).length ? (
                              <TagList
                                items={actionEvidenceRefs(action)}
                                maxVisible={3}
                              />
                            ) : null}
                          </div>
                          <button
                            type="button"
                            data-testid="codesite-required-action-review"
                            aria-label={`${actionHasGovernanceReviewTarget(action) ? "Review" : "Locate"} ${actionLabel(action)}`}
                            onClick={() => handleRequiredActionReview(action)}
                            className="inline-flex min-h-11 items-center justify-center rounded-md border px-3 text-xs font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                            style={{
                              borderColor:
                                "color-mix(in srgb, var(--accent-primary) 45%, var(--border-subtle))",
                              background:
                                "color-mix(in srgb, var(--accent-primary) 12%, var(--bg-elevated))",
                              color: "var(--text-primary)",
                            }}
                          >
                            {actionHasGovernanceReviewTarget(action)
                              ? "Review"
                              : "Locate"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section
                title="Agent Inbox"
                icon={CodeSiteIcons.files}
                right={
                  <Pill
                    tone={
                      inboxItems.some((item) => item.status === "pending")
                        ? "holding"
                        : "active"
                    }
                  >
                    {inboxItems.length}
                  </Pill>
                }
              >
                {inboxItems.length === 0 ? (
                  <EmptyLine>No routed inbox items</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {inboxItems
                      .slice(-5)
                      .reverse()
                      .map((item, index) => (
                        <div
                          key={
                            item.id ||
                            item.eventId ||
                            `${item.kind || "inbox"}-${index}`
                          }
                          className="rounded border px-2 py-1.5 text-xs"
                          style={{
                            borderColor: "var(--border-subtle)",
                            background: "var(--bg-surface)",
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {compact(item.kind, "inbox")}
                              </div>
                              <div
                                className="truncate font-mono text-[10px]"
                                style={{ color: "var(--text-muted)" }}
                              >
                                {compact(item.agentSessionId, "session")} /{" "}
                                {compact(item.eventId, "event")}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {item.requiresResponse ? (
                                <Pill tone="holding">response</Pill>
                              ) : null}
                              <Pill tone={item.status}>
                                {toneLabel(item.status)}
                              </Pill>
                            </div>
                          </div>
                          {hasEntries(item.redactedPayload) ? (
                            <div className="mt-1">
                              <JsonPreview
                                value={item.redactedPayload}
                                maxLines={6}
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                  </div>
                )}
              </Section>

              <Section
                title="Inspections Queue"
                icon={CodeSiteIcons.inspections}
                right={<Pill>{inspectionRuns.length}</Pill>}
              >
                <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
                  <Metric label="Runs" value={inspectionRuns.length} />
                  <Metric
                    label="Incidents"
                    value={incidents.length}
                    tone={incidents.length ? "high" : "low"}
                    icon={CodeSiteIcons.incidents}
                  />
                  <Metric
                    label="Events"
                    value={radarState.counts.events}
                    icon={CodeSiteIcons.activity}
                  />
                  <Metric
                    label="Evidence"
                    value={radarState.counts.proofBundles}
                    icon={CodeSiteIcons.evidence}
                  />
                </div>
              </Section>

              <Section
                title="Lineage Inspector"
                icon={CodeSiteIcons.lineage}
                sectionKey="lineage"
                right={<Pill>{lineProvenance.length}</Pill>}
              >
                <LineProvenanceDeck
                  rows={lineProvenance}
                  selectedLineRow={selectedLineRow}
                  selectedLineTransaction={selectedLineTransaction}
                  selectedLineLease={selectedLineLease}
                  selectedLineProof={selectedLineProof}
                  selectedLineEvidenceRefs={selectedLineEvidenceRefs}
                  selectedLineInspectionRefs={selectedLineInspectionRefs}
                  selectedLineDojoRefs={selectedLineDojoRefs}
                  lineInspector={lineInspector}
                  onInspectLine={handleInspectLine}
                />
              </Section>

              <Section
                title="Work Scope Zones"
                icon={CodeSiteIcons.scopes}
                right={<Pill>{zones.length}</Pill>}
              >
                {zones.length === 0 ? (
                  <EmptyLine>No classified scopes</EmptyLine>
                ) : (
                  <div className="space-y-1">
                    {zones.slice(0, 6).map((zone, index) => (
                      <div
                        key={zone.zoneKey || zone.id || index}
                        className="grid min-h-10 grid-cols-[minmax(76px,0.8fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border px-2 py-1.5 text-xs"
                        style={{
                          borderColor: "var(--border-subtle)",
                          background: "var(--bg-surface)",
                        }}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {displayZoneName(zone, index)}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {zoneTierLabel(zone)}
                          </div>
                        </div>
                        <PathList paths={zonePaths(zone)} empty="no paths" />
                        <Pill tone={zone.risk || "medium"}>
                          {compact(zone.risk, "risk")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="Policy Inputs" icon={CodeSiteIcons.signals}>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-xs">
                  <div
                    className="rounded border px-3 py-2"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-surface)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>
                      Allowed paths
                    </div>
                    <div className="mt-1">
                      <PathList paths={controlState?.allowedPaths || []} />
                    </div>
                  </div>
                  <div
                    className="rounded border px-3 py-2"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-surface)",
                    }}
                  >
                    <div style={{ color: "var(--text-muted)" }}>
                      Blocked paths
                    </div>
                    <div className="mt-1">
                      <PathList paths={controlState?.blockedPaths || []} />
                    </div>
                  </div>
                </div>
              </Section>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
