import { CodeSiteIcons } from "../icons";
import {
  actionEntity, actionEvidenceRefs, actionHasGovernanceReviewTarget,
  actionLabel, actionOwner, actionSeverity, documentNeedsReview,
  routeRevisionCanReview,
} from "../lib/governance";
import { EmptyLine, OperatorPane, Pill, Section, TagList } from "../ui";
import GovernanceConsole from "./governance/GovernanceConsole";

export default function GovernanceView({
  project,
  counts,
  activeFlights,
  activeLeases,
  incidents,
  inspectionRuns,
  permits,
  documents,
  routeRevisions,
  openMaydays,
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
  requiredActions,
  onRequiredActionReview,
  pendingReviewTarget,
  onPendingReviewTargetConsumed,
}) {
  return (
    <>
      <div className="grid min-w-0 content-start gap-3 p-3 @min-[28rem]/panel:p-4">
        <OperatorPane
          title="Governance Console"
          icon={CodeSiteIcons.governance}
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
            project={project}
            activeFlights={activeFlights}
            activeLeases={activeLeases}
            incidents={incidents}
            inspectionRuns={inspectionRuns}
            permitDraft={permitDraft}
            routeDraft={routeDraft}
            onPermitDraft={onPermitDraft}
            onRouteDraft={onRouteDraft}
            onIssuePermit={onIssuePermit}
            onReviewDocument={onReviewDocument}
            onProposeRouteRevision={onProposeRouteRevision}
            onReviewRouteRevision={onReviewRouteRevision}
            onApplyRouteRevision={onApplyRouteRevision}
            onResumeMayday={onResumeMayday}
            actionState={actionState}
            disabled={disabled}
            pendingReviewTarget={pendingReviewTarget}
            onPendingReviewTargetConsumed={onPendingReviewTargetConsumed}
            condensed
          />
        </OperatorPane>
      </div>

      <Section
        title="Required Actions"
        icon={CodeSiteIcons.actions}
        right={
          <Pill
            tone={
              counts.requiredActions ? "holding" : "active"
            }
          >
            {counts.requiredActions}
          </Pill>
        }
      >
        {requiredActions.length === 0 ? (
          <EmptyLine>No blocking actions</EmptyLine>
        ) : (
          <div className="space-y-1" data-testid="codesite-required-actions-list">
            {requiredActions.map((action, index) => (
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
                <div className="grid gap-2 @min-[28rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[28rem]/panel:items-start">
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
                      className="mt-1 grid gap-1 font-mono text-[10px] @min-[28rem]/panel:grid-cols-2"
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
                    onClick={() => onRequiredActionReview(action)}
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
    </>
  );
}
