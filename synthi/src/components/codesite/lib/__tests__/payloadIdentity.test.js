import { describe, expect, it, vi } from 'vitest';
import {
  documentReviewAction,
  maydayResumeAction,
  routeApplyAction,
  routeReviewAction,
} from '../governanceActions';

/**
 * The five queueGovernanceAction payloads used to be inline object literals in
 * GovernanceConsole's JSX. They were extracted into builders so the required-
 * action path and the console's own buttons could share one definition rather
 * than drifting.
 *
 * The expectations below are transcribed from those original literals as they
 * stood at commit 62cbbd3e8, immediately before the extraction. They exist to
 * pin the payloads independently of the builders — if someone "tidies" a builder
 * and changes a severity or an evidence ref, the console's behaviour changes,
 * and that is exactly what this catches.
 */

const DOC = {
  id: 'doc-1',
  title: 'Checkout schema RFI',
  fromSessionId: 'session-7',
  blocking: true,
  evidenceRefs: ['rfi:checkout'],
};

const REVISION = {
  id: 'route-rev-1',
  displayCallsign: 'ATLAS-1',
  executionPlanId: 'plan-1',
  proposedRoute: ['api/checkout/v2/**'],
  evidenceRefs: ['route-revision:proposal'],
};

const INCIDENT = {
  id: 'incident-1',
  category: 'mayday',
  participants: ['ATLAS-1'],
  affectedZones: ['api/checkout/**'],
  evidenceRefs: ['incident:evidence'],
  replayDigest: 'sha256:incident',
};

describe('governance payload identity', () => {
  it('document approve matches the original literal', () => {
    const onReviewDocument = vi.fn();
    const action = documentReviewAction(DOC, 'approved', { onReviewDocument });
    expect(action).toMatchObject({
      kind: 'document_review',
      title: 'Approve Checkout schema RFI',
      entity: 'doc-1',
      owner: 'session-7',
      severity: 'high', // blocking: true
      evidenceRefs: ['rfi:checkout', 'codesite:ui:document-review:doc-1'],
    });
    action.execute('because');
    expect(onReviewDocument).toHaveBeenCalledWith(DOC, 'approved', 'because');
  });

  it('document approve drops to medium severity when not blocking', () => {
    const action = documentReviewAction({ ...DOC, blocking: false }, 'approved', {
      onReviewDocument: vi.fn(),
    });
    expect(action.severity).toBe('medium');
  });

  it('document reject is always high severity', () => {
    const onReviewDocument = vi.fn();
    const action = documentReviewAction({ ...DOC, blocking: false }, 'rejected', { onReviewDocument });
    expect(action).toMatchObject({
      kind: 'document_review',
      title: 'Reject Checkout schema RFI',
      entity: 'doc-1',
      owner: 'session-7',
      severity: 'high',
    });
    action.execute('nope');
    expect(onReviewDocument).toHaveBeenCalledWith({ ...DOC, blocking: false }, 'rejected', 'nope');
  });

  it('falls back to coordinator when the document has no session', () => {
    const action = documentReviewAction(
      { id: 'doc-2', title: 'x', evidenceRefs: [] },
      'approved',
      { onReviewDocument: vi.fn() },
    );
    expect(action.owner).toBe('coordinator');
  });

  it('route review matches the original literal', () => {
    const onReviewRouteRevision = vi.fn();
    const action = routeReviewAction(REVISION, { onReviewRouteRevision });
    expect(action).toMatchObject({
      kind: 'route_revision_review',
      title: 'Approve plan change',
      entity: 'route-rev-1',
      owner: 'ATLAS-1',
      severity: 'high',
      scope: ['api/checkout/v2/**'],
      evidenceRefs: ['route-revision:proposal', 'codesite:ui:route-review:route-rev-1'],
    });
    action.execute('reviewed');
    expect(onReviewRouteRevision).toHaveBeenCalledWith(REVISION, 'approved', 'reviewed');
  });

  it('route apply matches the original literal', () => {
    const onApplyRouteRevision = vi.fn();
    const action = routeApplyAction(REVISION, { onApplyRouteRevision });
    expect(action).toMatchObject({
      kind: 'route_revision_apply',
      title: 'Apply plan change',
      entity: 'route-rev-1',
      owner: 'ATLAS-1',
      severity: 'critical',
      scope: ['api/checkout/v2/**'],
      evidenceRefs: ['route-revision:proposal', 'codesite:ui:route-apply:route-rev-1'],
    });
    action.execute('applied');
    expect(onApplyRouteRevision).toHaveBeenCalledWith(REVISION, 'applied');
  });

  it('mayday resume matches the original literal', () => {
    const onResumeMayday = vi.fn();
    const action = maydayResumeAction(INCIDENT, ['run-1'], { onResumeMayday });
    expect(action).toMatchObject({
      kind: 'mayday_resume',
      entity: 'incident-1',
      owner: 'ATLAS-1',
      severity: 'critical',
      scope: ['api/checkout/**'],
      evidenceRefs: [
        'incident:evidence',
        'sha256:incident',
        'codesite:ui:mayday-resume:incident-1',
      ],
    });
    action.execute('resumed');
    expect(onResumeMayday).toHaveBeenCalledWith(INCIDENT, ['run-1'], 'resumed');
  });
});
