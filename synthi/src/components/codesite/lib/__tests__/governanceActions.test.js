import { describe, expect, it } from 'vitest';
import { resolveGovernanceReviewTarget } from '../governanceActions';

const DATA = {
  documents: [
    { id: 'doc-open', status: 'open' },
    { id: 'doc-done', status: 'approved' },
  ],
  routeRevisions: [
    { id: 'route-proposed', status: 'proposed' },
    { id: 'route-approved', status: 'approved' },
  ],
  // maydayResumeInspectionRefs derives its refs from evidence overlap, not from
  // a run's incidentId, so the run has to share an evidence ref with the
  // incident for the resume to be actionable.
  openMaydays: [
    {
      id: 'inc-1',
      category: 'mayday',
      status: 'open',
      evidenceRefs: ['incident:inc-1:evidence'],
    },
  ],
  inspectionRuns: [
    {
      id: 'run-1',
      status: 'passed',
      evidenceRefs: ['incident:inc-1:evidence'],
    },
  ],
};

describe('resolveGovernanceReviewTarget', () => {
  it('targets a document that still needs review', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_document', documentId: 'doc-open' }, DATA))
      .toEqual({ entity: 'document', entityId: 'doc-open', intent: 'approve' });
  });

  it('ignores a document that is already approved', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_document', documentId: 'doc-done' }, DATA))
      .toBeNull();
  });

  it('targets review for a proposed plan change, not apply', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_route', routeRevisionId: 'route-proposed' }, DATA))
      .toEqual({ entity: 'routeRevision', entityId: 'route-proposed', intent: 'review' });
  });

  it('targets apply for an approved plan change', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_route', routeRevisionId: 'route-approved' }, DATA))
      .toEqual({ entity: 'routeRevision', entityId: 'route-approved', intent: 'apply' });
  });

  it('targets a mayday resume only when inspection evidence exists', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'mayday_resume', incidentId: 'inc-1' }, DATA))
      .toEqual({ entity: 'incident', entityId: 'inc-1', intent: 'resume' });
    expect(resolveGovernanceReviewTarget(
      { kind: 'mayday_resume', incidentId: 'inc-1' },
      { ...DATA, inspectionRuns: [] },
    )).toBeNull();
  });

  it('returns null for an action with no governance target', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'something_else' }, DATA)).toBeNull();
  });
});
