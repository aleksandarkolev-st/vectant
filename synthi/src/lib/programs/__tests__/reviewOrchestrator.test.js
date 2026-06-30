import { beforeEach, describe, expect, it, vi } from 'vitest';
import { submitForReview, approveSubmission, rejectSubmission } from '../reviewOrchestrator';

const containerConfig = {
  packageId: 'tool', version: '1.0.0', displayName: 'Tool', runtimeType: 'container',
  workingDir: '', install: ['docker pull reg.io/me/tool:1'], env: {}, ports: [6901],
  launch: 'docker run --rm -p 6901:6901 -v "$PWD":/workspace reg.io/me/tool:1',
  surfaces: [], health: null, permissions: ['program.launch'], source: 'vectant.programs.json', sourceHints: {},
};

let deps;
beforeEach(() => {
  deps = {
    store: {
      createSubmission: vi.fn().mockResolvedValue({ program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' }, version: { id: 'ver1' } }),
      transitionReview: vi.fn().mockResolvedValue(true),
      getReviewVersionById: vi.fn(),
      publishApprovedVersion: vi.fn().mockResolvedValue(true),
    },
    hardGates: vi.fn().mockReturnValue({ ok: true, reasons: [] }),
    scanner: vi.fn().mockResolvedValue({ ok: true, summary: { decisiveCves: [] } }),
    reHost: vi.fn().mockResolvedValue({ ref: 'ar.host/p/community/team/tool@sha256:dead', digest: 'sha256:dead' }),
    target: vi.fn().mockReturnValue('ar.host/p/community/team/tool'),
    pin: vi.fn().mockImplementation((cfg) => ({ ...cfg, launch: 'docker run ar.host/p/community/team/tool@sha256:dead' })),
    aiReview: vi.fn().mockResolvedValue({ riskScore: 0.1, flags: [], rationale: 'fine' }),
    aiDecide: vi.fn().mockReturnValue('auto_approve'),
    aiEnabled: false,
  };
});

describe('submitForReview', () => {
  it('clean container submission lands in pending_review (Phase 1, no AI)', async () => {
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.scanner).toHaveBeenCalledWith('reg.io/me/tool:1', expect.anything());
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'submitted', toState: 'scanning' }));
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'pending_review' }));
  });

  it('hard-gate failure routes straight to rejected (never scanned)', async () => {
    deps.hardGates.mockReturnValue({ ok: false, reasons: [{ code: 'host_escape', message: 'x' }] });
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.scanner).not.toHaveBeenCalled();
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'submitted', toState: 'rejected', reason: [{ code: 'host_escape', message: 'x' }] }));
  });

  it('over-threshold CVE routes to rejected', async () => {
    deps.scanner.mockResolvedValue({ ok: false, summary: { decisiveCves: ['CVE-9'] } });
    const res = await submitForReview({ workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'rejected' }));
  });

  it('web submission skips scanning and lands in pending_review', async () => {
    const web = { ...containerConfig, runtimeType: 'web', launch: 'npm run dev', install: ['npm ci'] };
    const res = await submitForReview({ workspaceSlug: 'team', config: web, sourceImageRef: null, submittedByUserId: 'u1' }, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.scanner).not.toHaveBeenCalled();
  });
});

describe('approveSubmission', () => {
  beforeEach(() => {
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver1', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1',
      manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' },
    });
  });

  it('approves: rehosts by digest, pins the manifest, publishes', async () => {
    const res = await approveSubmission({ versionId: 'ver1', adminUserId: 'admin1' }, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.reHost).toHaveBeenCalledWith('reg.io/me/tool:1', 'ar.host/p/community/team/tool', expect.anything());
    const pubArg = deps.store.publishApprovedVersion.mock.calls[0][1];
    expect(pubArg.hostedImageDigest).toBe('sha256:dead');
    expect(JSON.parse(pubArg.publishedManifestJson).launch).toContain('@sha256:dead');
  });

  it('refuses self-approval (submitter cannot approve their own)', async () => {
    const res = await approveSubmission({ versionId: 'ver1', adminUserId: 'u1' }, deps);
    expect(res.error).toBe('self_review_forbidden');
    expect(deps.reHost).not.toHaveBeenCalled();
    expect(deps.store.publishApprovedVersion).not.toHaveBeenCalled();
  });

  it('a web program approves with no re-host', async () => {
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver2', version: '1.0.0', reviewState: 'pending_review', submittedByUserId: 'u1', sourceImageRef: null,
      manifestJson: JSON.stringify({ ...containerConfig, runtimeType: 'web', launch: 'npm run dev' }), program: { id: 'prog2', publisher: 'team', packageId: '@team/web' },
    });
    const res = await approveSubmission({ versionId: 'ver2', adminUserId: 'admin1' }, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.reHost).not.toHaveBeenCalled();
    const pubArg = deps.store.publishApprovedVersion.mock.calls[0][1];
    expect(pubArg.hostedImageDigest).toBeNull();
  });
});

describe('rejectSubmission', () => {
  it('records reject notes + transitions pending_review -> rejected', async () => {
    deps.store.getReviewVersionById.mockResolvedValue({ id: 'ver1', reviewState: 'pending_review', submittedByUserId: 'u1' });
    const res = await rejectSubmission({ versionId: 'ver1', adminUserId: 'admin1', notes: 'spammy' }, deps);
    expect(res.reviewState).toBe('rejected');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'pending_review', toState: 'rejected', actorUserId: 'admin1', patch: { reviewNotes: 'spammy' } }));
  });
});

describe('submitForReview — Phase 2 AI layer', () => {
  const base = { workspaceSlug: 'team', config: containerConfig, sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' };

  it('flag OFF → pending_review, AI not called (Phase-1 behavior preserved)', async () => {
    deps.aiEnabled = false;
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.aiReview).not.toHaveBeenCalled();
  });

  it('flag ON + auto_approve → ai_review → published (reuses re-host + publish)', async () => {
    deps.aiEnabled = true;
    deps.aiDecide.mockReturnValue('auto_approve');
    deps.store.getReviewVersionById.mockResolvedValue({
      id: 'ver1', version: '1.0.0', reviewState: 'rehosting', submittedByUserId: 'u1', sourceImageRef: 'reg.io/me/tool:1',
      manifestJson: JSON.stringify(containerConfig), program: { id: 'prog1', publisher: 'team', packageId: '@team/tool' },
    });
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('published');
    expect(deps.store.transitionReview).toHaveBeenCalledWith('ver1', expect.objectContaining({ fromState: 'scanning', toState: 'ai_review' }));
    expect(deps.reHost).toHaveBeenCalled();
    expect(deps.store.publishApprovedVersion).toHaveBeenCalled();
  });

  it('flag ON + manual decision → pending_review (stores aiRiskJson)', async () => {
    deps.aiEnabled = true;
    deps.aiDecide.mockReturnValue('manual');
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
    expect(deps.reHost).not.toHaveBeenCalled();
    const aiTransition = deps.store.transitionReview.mock.calls.find((c) => c[1].toState === 'pending_review');
    expect(aiTransition[1].patch.aiRiskJson).toContain('riskScore');
  });

  it('flag ON + AI fails closed (high risk) → manual', async () => {
    deps.aiEnabled = true;
    deps.aiReview.mockResolvedValue({ riskScore: 1, flags: ['ai_unavailable'], rationale: 'down' });
    deps.aiDecide.mockReturnValue('manual');
    const res = await submitForReview(base, deps);
    expect(res.reviewState).toBe('pending_review');
  });
});
