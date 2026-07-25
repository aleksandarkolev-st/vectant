import { EmptyLine, IconButton, PathList, Pill } from "../../ui";
import { useState, useCallback } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { asArray, compact, productCopy, uniqueValues } from "../../lib/format";
import { documentLabel, documentNeedsReview, firstRoutePattern, incidentNeedsResume, maydayResumeInspectionRefs, routeRevisionCanApply, routeRevisionCanReview } from "../../lib/governance";
import { CodeSiteIcons } from "../../icons";
import GovernanceReviewGate from "./GovernanceReviewGate";

export default function GovernanceConsole({
  project,
  activeFlights,
  activeLeases,
  incidents,
  permitDraft,
  routeDraft,
  onPermitDraft,
  onRouteDraft,
  onIssuePermit,
  onReviewDocument,
  onProposeRouteRevision,
  onReviewRouteRevision,
  onApplyRouteRevision,
  onResumeMayday,
  actionState,
  disabled,
  inspectionRuns,
  condensed = false,
}) {
  const reduceMotion = useReducedMotion();
  const permits = asArray(project?.permits);
  const documents = asArray(project?.documents);
  const routeRevisions = asArray(project?.routeRevisions);
  const openDocuments = documents.filter(documentNeedsReview);
  const maydayIncidents = incidents.filter(incidentNeedsResume);
  const primaryPlan =
    activeFlights[0] || asArray(project?.executionPlans)[0] || {};
  const lease = activeLeases[0] || {};
  const defaultPermitRoute = firstRoutePattern(primaryPlan);
  const draftRoute = permitDraft.route || defaultPermitRoute;
  const permitAllowedPaths = draftRoute ? [draftRoute] : [];
  const [pendingReview, setPendingReview] = useState(null);
  const [reviewRationale, setReviewRationale] = useState("");
  const queueGovernanceAction = useCallback((action) => {
    setPendingReview(action);
    setReviewRationale("");
  }, []);
  const confirmGovernanceAction = useCallback(async (rationale) => {
    if (!pendingReview?.execute) return;
    const trimmed = String(rationale || "").trim();
    const result = await pendingReview.execute(trimmed);
    setPendingReview(null);
    setReviewRationale("");
    return result;
  }, [pendingReview]);

  return (
    <div
      data-testid="codesite-governance-console"
      className={
        condensed
          ? "grid min-w-0 gap-3"
          : "grid min-w-0 gap-3 xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.18fr)]"
      }
    >
      <motion.form
        layout={!reduceMotion}
        onSubmit={(event) => {
          event.preventDefault();
          const payload = {
            title:
              permitDraft.title ||
              `Protected change approval for ${compact(primaryPlan.displayCallsign, "workstream")}`,
            permitType: permitDraft.permitType || "restricted_route",
            executionPlanId: primaryPlan.id || null,
            mutationLeaseId: lease.id || null,
            allowedPaths: permitAllowedPaths,
            route: permitAllowedPaths,
            scope: {
              allowedPaths: permitAllowedPaths,
              route: permitAllowedPaths,
            },
            approval: { source: "codesite_governance_console" },
            evidenceRefs: [`codesite:ui:permit:${project?.id || "project"}`],
          };
          queueGovernanceAction({
            kind: "permit",
            title: payload.title,
            entity: payload.mutationLeaseId || payload.executionPlanId,
            owner: primaryPlan.displayCallsign || lease.displayCallsign,
            severity: "high",
            scope: permitAllowedPaths,
            evidenceRefs: payload.evidenceRefs,
            execute: (rationale) =>
              onIssuePermit({
                ...payload,
                approval: {
                  ...payload.approval,
                  rationale,
                  reviewedAt: new Date().toISOString(),
                },
              }),
          });
        }}
        className="rounded border p-3"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 74%, var(--accent-primary) 26%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 7%), var(--bg-surface))",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Protected change approval</div>
            <div
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              Issue review evidence for protected and shared paths before approval.
            </div>
          </div>
          <Pill tone={permits.length ? "active" : "holding"}>
            {permits.length}
          </Pill>
        </div>
        <div className="mt-3 grid gap-2">
          <label
            className="grid gap-1 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Permit title
            <input
              data-testid="codesite-permit-title-input"
              value={permitDraft.title}
              onChange={(event) =>
                onPermitDraft({ ...permitDraft, title: event.target.value })
              }
              placeholder={`Permit for ${compact(primaryPlan.displayCallsign, "workstream")}`}
              className="h-10 rounded border px-2 text-xs outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
              }}
            />
          </label>
          <label
            className="grid gap-1 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Allowed paths
            <input
              data-testid="codesite-permit-route-input"
              value={draftRoute}
              onChange={(event) =>
                onPermitDraft({ ...permitDraft, route: event.target.value })
              }
              placeholder="synthi/prisma/**"
              className="h-10 rounded border px-2 font-mono text-xs outline-none"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
              }}
            />
          </label>
          <IconButton
            title="Issue permit"
            type="submit"
            variant="primary"
            disabled={disabled || !project?.id}
            testId="codesite-issue-permit-button"
          >
            <CodeSiteIcons.approvals className="h-3.5 w-3.5" />
            Issue permit
          </IconButton>
        </div>
      </motion.form>

      <GovernanceReviewGate
        action={pendingReview}
        rationale={reviewRationale}
        onRationale={setReviewRationale}
        onCancel={() => {
          setPendingReview(null);
          setReviewRationale("");
        }}
        onConfirm={confirmGovernanceAction}
        disabled={disabled || actionState.status === "running"}
      />

      <div className="grid min-w-0 gap-3">
        <div className={condensed ? "grid gap-2" : "grid gap-2 md:grid-cols-2"}>
          <div
            className="rounded-lg border p-2"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">Documents</div>
              <Pill tone={openDocuments.length ? "holding" : "active"}>
                {openDocuments.length} open
              </Pill>
            </div>
            {documents.length ? (
              <>
              {documents.slice(0, 5).map((document) => (
                <div
                  key={document.id}
                  data-testid="codesite-document-row"
                  data-codesite-document-id={document.id || ""}
                  className="rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor:
                      "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
                    background:
                      "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 82%, var(--bg-surface) 18%))",
                  }}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                    <span className="min-w-0 truncate font-medium">
                      {documentLabel(document)}
                    </span>
                    <Pill
                      tone={document.status}
                      className="max-w-[8.5rem] justify-center break-words text-center whitespace-normal sm:max-w-none"
                    >
                      {compact(document.status, "open")}
                    </Pill>
                  </div>
                  <div
                    className="mt-1 flex flex-wrap items-center gap-1"
                    data-testid="codesite-document-review-actions"
                  >
                    <IconButton
                      title="Approve document"
                      disabled={disabled || !documentNeedsReview(document)}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "document_review",
                          title: `Approve ${documentLabel(document)}`,
                          entity: document.id,
                          owner: document.fromSessionId || document.fromSession || "coordinator",
                          severity: document.blocking ? "high" : "medium",
                          evidenceRefs: uniqueValues([
                            ...asArray(document.evidenceRefs),
                            `codesite:ui:document-review:${document.id}`,
                          ]),
                          execute: (rationale) =>
                            onReviewDocument(document, "approved", rationale),
                        })
                      }
                      testId="codesite-document-approve-button"
                    >
                      <CodeSiteIcons.governance className="h-3.5 w-3.5" />
                      Approve
                    </IconButton>
                    <IconButton
                      title="Reject document"
                      disabled={disabled || !documentNeedsReview(document)}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "document_review",
                          title: `Reject ${documentLabel(document)}`,
                          entity: document.id,
                          owner: document.fromSessionId || document.fromSession || "coordinator",
                          severity: "high",
                          evidenceRefs: uniqueValues([
                            ...asArray(document.evidenceRefs),
                            `codesite:ui:document-review:${document.id}`,
                          ]),
                          execute: (rationale) =>
                            onReviewDocument(document, "rejected", rationale),
                        })
                      }
                      testId="codesite-document-reject-button"
                    >
                      <CodeSiteIcons.conflicts className="h-3.5 w-3.5" />
                      Reject
                    </IconButton>
                  </div>
                </div>
              ))}
              {documents.length > 5 ? (
                <details
                  data-testid="codesite-documents-show-all"
                  className="rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <summary className="cursor-pointer font-semibold">
                    Show all documents ({documents.length})
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {documents.slice(5).map((document) => (
                      <div
                        key={`hidden-${document.id}`}
                        className="flex min-w-0 items-center justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {documentLabel(document)}
                        </span>
                        <Pill tone={document.status}>
                          {compact(document.status, "open")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              </>
            ) : (
              <EmptyLine>No RFIs or change orders filed</EmptyLine>
            )}
          </div>

          <div
            className="rounded-lg border p-2"
            style={{
              borderColor:
                "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold">Plan changes</div>
              <Pill tone={routeRevisions.length ? "holding" : "idle"}>
                {routeRevisions.length}
              </Pill>
            </div>
            <form
              className="mb-2 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const payload = {
                  proposedRoute: [routeDraft.route || defaultPermitRoute],
                  reason: routeDraft.reason || "operator_reroute",
                  affectedLeases: lease.id ? [lease.id] : [],
                  evidenceRefs: [
                    `codesite:ui:route-revision:${project?.id || "project"}`,
                  ],
                };
                queueGovernanceAction({
                  kind: "route_revision",
                  title: `Propose plan change for ${compact(primaryPlan.displayCallsign, "workstream")}`,
                  entity: primaryPlan.id,
                  owner: primaryPlan.displayCallsign || lease.displayCallsign,
                  severity: "high",
                  scope: payload.proposedRoute,
                  evidenceRefs: payload.evidenceRefs,
                  execute: (rationale) =>
                    onProposeRouteRevision(primaryPlan, {
                      ...payload,
                      reason: `${payload.reason}: ${rationale}`,
                    }),
                });
              }}
            >
              <input
                data-testid="codesite-route-revision-input"
                value={routeDraft.route}
                onChange={(event) =>
                  onRouteDraft({ ...routeDraft, route: event.target.value })
                }
                placeholder={defaultPermitRoute}
                className="h-10 rounded border px-2 font-mono text-xs outline-none"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                  color: "var(--text-primary)",
                }}
              />
              <IconButton
                title="Propose plan change"
                type="submit"
                disabled={disabled || !primaryPlan.id}
                testId="codesite-route-propose-button"
              >
                <CodeSiteIcons.planChanges className="h-3.5 w-3.5" />
                Propose change
              </IconButton>
            </form>
            {routeRevisions.length
              ? (
                <>
                {routeRevisions.slice(0, 5).map((revision) => (
                  <div
                    key={revision.id}
                    data-testid="codesite-route-revision-row"
                    data-codesite-route-revision-id={revision.id || ""}
                    className="rounded-md border px-2 py-2 text-xs"
                    style={{
                      borderColor:
                        "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
                      background:
                        "linear-gradient(180deg, var(--bg-editor), color-mix(in srgb, var(--bg-editor) 82%, var(--bg-surface) 18%))",
                    }}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                      <code className="min-w-0 break-all text-[10px] leading-4 whitespace-normal">
                        {asArray(revision.proposedRoute).join(", ") ||
                          "route pending"}
                      </code>
                      <Pill
                        tone={revision.status}
                        className="max-w-[8.5rem] justify-center break-words text-center whitespace-normal sm:max-w-none"
                      >
                        {compact(revision.status, "proposed")}
                      </Pill>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <IconButton
                        title="Approve plan change"
                        disabled={disabled || !routeRevisionCanReview(revision)}
                        onClick={() =>
                          queueGovernanceAction({
                            kind: "route_revision_review",
                            title: "Approve plan change",
                            entity: revision.id,
                            owner: revision.displayCallsign || revision.executionPlanId,
                            severity: "high",
                            scope: revision.proposedRoute,
                            evidenceRefs: uniqueValues([
                              ...asArray(revision.evidenceRefs),
                              `codesite:ui:route-review:${revision.id}`,
                            ]),
                            execute: (rationale) =>
                              onReviewRouteRevision(
                                revision,
                                "approved",
                                rationale,
                              ),
                          })
                        }
                        testId="codesite-route-review-button"
                      >
                        <CodeSiteIcons.governance className="h-3.5 w-3.5" />
                        Approve
                      </IconButton>
                      <IconButton
                        title="Apply plan change"
                        disabled={disabled || !routeRevisionCanApply(revision)}
                        onClick={() =>
                          queueGovernanceAction({
                            kind: "route_revision_apply",
                            title: "Apply plan change",
                            entity: revision.id,
                            owner: revision.displayCallsign || revision.executionPlanId,
                            severity: "critical",
                            scope: revision.proposedRoute,
                            evidenceRefs: uniqueValues([
                              ...asArray(revision.evidenceRefs),
                              `codesite:ui:route-apply:${revision.id}`,
                            ]),
                            execute: (rationale) =>
                              onApplyRouteRevision(revision, rationale),
                          })
                        }
                        testId="codesite-route-apply-button"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Apply
                      </IconButton>
                    </div>
                  </div>
                ))}
                {routeRevisions.length > 5 ? (
                  <details
                    data-testid="codesite-route-revisions-show-all"
                    className="rounded-md border px-2 py-2 text-xs"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <summary className="cursor-pointer font-semibold">
                    Show all plan changes ({routeRevisions.length})
                    </summary>
                    <div className="mt-2 grid gap-1">
                      {routeRevisions.slice(5).map((revision) => (
                        <div
                          key={`hidden-route-${revision.id}`}
                          className="flex min-w-0 items-start justify-between gap-2"
                        >
                          <code className="min-w-0 break-all text-[10px]">
                            {asArray(revision.proposedRoute).join(", ") ||
                              "route pending"}
                          </code>
                          <Pill tone={revision.status}>
                            {compact(revision.status, "proposed")}
                          </Pill>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
                </>
              )
              : null}
          </div>
        </div>

        <div
          data-testid="codesite-mayday-banner"
          className="rounded-lg border p-3"
          style={{
            borderColor: maydayIncidents.length
              ? "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))"
              : "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
            background: maydayIncidents.length
              ? "linear-gradient(180deg, color-mix(in srgb, var(--accent-danger) 10%, var(--bg-surface)), var(--bg-surface))"
              : "var(--bg-surface)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">
                Paused incident recovery
              </div>
              <div
                className="mt-1 truncate text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                Resume only after replay, inspection, and recovery evidence.
              </div>
            </div>
            <Pill tone={maydayIncidents.length ? "critical" : "active"}>
              {maydayIncidents.length} open
            </Pill>
          </div>
          {maydayIncidents.length
            ? (
              <>
              {maydayIncidents.slice(0, 3).map((incident) => {
                const inspectionRunIds = maydayResumeInspectionRefs(
                  incident,
                  inspectionRuns,
                );
                return (
                  <div
                    key={incident.id}
                    data-testid="codesite-ground-stop-row"
                    data-codesite-mayday-id={incident.id || ""}
                    className="mt-2 grid gap-2 rounded border px-2 py-1.5 text-xs sm:grid-cols-[minmax(0,1fr)_auto]"
                    style={{
                      borderColor: "var(--border-subtle)",
                      background: "var(--bg-editor)",
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {productCopy(incident.category, "emergency")}
                      </div>
                      <PathList
                        paths={incident.affectedZones}
                        empty="no affected zones"
                        maxVisible={4}
                      />
                      <div
                        className="mt-1 truncate text-[10px]"
                        style={{
                          color: inspectionRunIds.length
                            ? "var(--text-muted)"
                            : "var(--accent-danger)",
                        }}
                      >
                        {inspectionRunIds.length
                          ? `inspection: ${inspectionRunIds.join(", ")}`
                          : "inspection evidence required"}
                      </div>
                    </div>
                    <IconButton
                      title="Resume paused incident"
                      disabled={disabled || inspectionRunIds.length === 0}
                      onClick={() =>
                        queueGovernanceAction({
                          kind: "mayday_resume",
                          title: `Resume ${productCopy(incident.category, "paused incident")}`,
                          entity: incident.id,
                          owner: asArray(incident.participants)[0] || "coordinator",
                          severity: "critical",
                          scope: incident.affectedZones,
                          evidenceRefs: uniqueValues([
                            ...asArray(incident.evidenceRefs),
                            incident.replayDigest,
                            `codesite:ui:mayday-resume:${incident.id}`,
                          ]),
                          execute: (rationale) =>
                            onResumeMayday(
                              incident,
                              inspectionRunIds,
                              rationale,
                            ),
                        })
                      }
                      testId="codesite-resume-mayday-submit"
                    >
                      <CodeSiteIcons.recovery className="h-3.5 w-3.5" />
                      Resume
                    </IconButton>
                  </div>
                );
              })}
              {maydayIncidents.length > 3 ? (
                <details
                  data-testid="codesite-maydays-show-all"
                  className="mt-2 rounded-md border px-2 py-2 text-xs"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-editor)",
                  }}
                >
                  <summary className="cursor-pointer font-semibold">
                    Show all paused incidents ({maydayIncidents.length})
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {maydayIncidents.slice(3).map((incident) => (
                      <div
                        key={`hidden-mayday-${incident.id}`}
                        className="flex min-w-0 items-start justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {productCopy(incident.category, "emergency")} /{" "}
                          {compact(incident.id, "incident")}
                        </span>
                        <Pill tone={incident.severity || incident.status}>
                          {compact(incident.severity || incident.status, "open")}
                        </Pill>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              </>
            )
            : null}
        </div>

        {actionState.error || actionState.result ? (
          <div
            data-testid="codesite-governance-action-result"
            className="rounded border px-3 py-2 text-xs"
            style={{
              borderColor: actionState.error
                ? "color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))"
                : "color-mix(in srgb, var(--accent-success) 40%, var(--border-subtle))",
              background: "var(--bg-surface)",
            }}
          >
            {actionState.error ||
              compact(
                actionState.result?.event?.eventType ||
                  actionState.result?.routeRevision?.status ||
                  actionState.result?.permit?.status ||
                  actionState.status,
                "updated",
              )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
