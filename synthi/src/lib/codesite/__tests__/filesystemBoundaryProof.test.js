import { describe, expect, it } from 'vitest';
import { buildFilesystemBoundaryProofRecords } from '../filesystemBoundaryProof.js';

describe('CodeSite filesystem boundary proofs', () => {
  it('normalizes denied and quarantined write proof fields without fabricating missing data', () => {
    const records = buildFilesystemBoundaryProofRecords({
      id: 'project-1',
      workspaceSlug: 'acme',
      mutationLeases: [{
        id: 'lease-1',
        displayCallsign: 'ATLAS-1',
        status: 'active',
        lease: {
          allowedPaths: ['frontend/**'],
          blockedPaths: ['infra/prod/**'],
          allowedTools: ['terminal_exec'],
        },
        dojoLicenseRef: 'dojo:license:atlas',
        dojoProofRef: 'dojo:proof:atlas',
      }],
      policyDecisions: [{
        id: 'decision-deny-1',
        mutationLeaseId: 'lease-1',
        displayCallsign: null,
        decision: 'block',
        reasonCodes: ['active_clearance_required'],
        decisionBody: {
          matchedLeaseId: 'lease-1',
          requestedLeaseId: 'lease-1',
          towerInstruction: 'Write preflight blocked for infra/prod.env. Request clearance.',
          inspectedLeases: [{ mutationLeaseId: 'lease-1', ok: false }],
        },
      }],
      events: [
        {
          id: 'evt-denied-1',
          projectId: 'project-1',
          eventType: 'write_denied',
          mutationLeaseId: 'lease-1',
          actorType: 'codesitefs',
          actorId: 'decision-deny-1',
          evidenceRefs: ['runtime:event:terminal-write-1'],
          details: {
            path: 'infra/prod.env',
            source: 'runtime_pod_terminal',
            tool: 'terminal_exec',
            disposition: 'write_denied',
            matchedLeaseId: 'lease-1',
            mutationLeaseId: 'lease-1',
            policyDecisionId: 'decision-deny-1',
            reasonCodes: ['entered_no_fly_zone'],
            codesiteFsEvent: {
              type: null,
              source: 'runtime_pod_terminal',
              operation: 'write',
              path: 'infra/prod.env',
              details: {
                process_ancestry: ['python', 'bash', 'codex-cli'],
                reason_codes: ['entered_no_fly_zone'],
              },
            },
          },
          createdAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'evt-incomplete-1',
          projectId: 'project-1',
          eventType: 'write_denied',
          actorType: 'codesitefs',
          evidenceRefs: [],
          details: {
            path: 'frontend/App.jsx',
            disposition: 'write_denied',
          },
          createdAt: '2026-07-01T00:01:00.000Z',
        },
      ],
    });

    const denied = records.find((record) => record.eventId === 'evt-denied-1');
    expect(denied).toMatchObject({
      proofId: 'fs-boundary-evt-denied-1',
      disposition: 'write_denied',
      path: 'infra/prod.env',
      leaseState: 'inspected_clearance_rejected',
      mutationLeaseId: null,
      requestedMutationLeaseId: 'lease-1',
      inspectedLeases: [expect.objectContaining({ mutationLeaseId: 'lease-1', ok: false })],
      proofComplete: true,
      reasonCodes: expect.arrayContaining(['entered_no_fly_zone', 'active_clearance_required']),
      process: { ancestry: ['python', 'bash', 'codex-cli'], display: 'python <- bash <- codex-cli' },
      evidenceRefs: expect.arrayContaining(['event:evt-denied-1', 'runtime:event:terminal-write-1']),
    });
    expect(denied.reason).toContain('Write preflight blocked');

    const incomplete = records.find((record) => record.eventId === 'evt-incomplete-1');
    expect(incomplete).toMatchObject({
      path: 'frontend/App.jsx',
      leaseState: 'no_active_clearance',
      proofComplete: false,
      missingProofFields: expect.arrayContaining(['reason', 'process']),
    });
    expect(incomplete.process.display).toBeNull();
    expect(incomplete.evidenceRefs).toEqual(['event:evt-incomplete-1']);
  });
});
