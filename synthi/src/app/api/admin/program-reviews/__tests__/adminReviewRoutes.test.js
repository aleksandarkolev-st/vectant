import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  isPlatformAdmin: vi.fn(),
  listPendingReview: vi.fn(),
  toReviewQueueItem: vi.fn((r) => ({ versionId: r.id, reviewState: r.reviewState })),
  approveSubmission: vi.fn(),
  rejectSubmission: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/programs/entitlements', () => ({ isPlatformAdmin: h.isPlatformAdmin, canPublish: vi.fn() }));
vi.mock('@/lib/programs/store', () => ({ listPendingReview: h.listPendingReview, toReviewQueueItem: h.toReviewQueueItem }));
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ approveSubmission: h.approveSubmission, rejectSubmission: h.rejectSubmission }));

import { GET as GET_QUEUE } from '../route.js';
import { POST as POST_REVIEW } from '../[versionId]/route.js';

const req = (url, body, method = 'GET') => ({ url, method, json: async () => body });
const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'admin1', email: 'admin@y.io' });
  h.isPlatformAdmin.mockReturnValue(true);
});

describe('GET /admin/program-reviews', () => {
  it('lists the pending queue (redacted) for a platform admin', async () => {
    h.listPendingReview.mockResolvedValue([{ id: 'ver1', reviewState: 'pending_review' }]);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue[0]).toMatchObject({ versionId: 'ver1' });
  });

  it('rejects a non-admin (403)', async () => {
    h.isPlatformAdmin.mockReturnValue(false);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(403);
    expect(h.listPendingReview).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated (401)', async () => {
    h.actor.mockResolvedValue(null);
    const res = await GET_QUEUE(req('http://x/api/admin/program-reviews'));
    expect(res.status).toBe(401);
  });
});

describe('POST /admin/program-reviews/[versionId]', () => {
  it('approves via the orchestrator', async () => {
    h.approveSubmission.mockResolvedValue({ versionId: 'ver1', reviewState: 'published' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(200);
    expect(h.approveSubmission).toHaveBeenCalledWith({ versionId: 'ver1', adminUserId: 'admin1' });
    expect((await res.json()).result.reviewState).toBe('published');
  });

  it('rejects via the orchestrator with notes', async () => {
    h.rejectSubmission.mockResolvedValue({ versionId: 'ver1', reviewState: 'rejected' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'reject', notes: 'nope' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(200);
    expect(h.rejectSubmission).toHaveBeenCalledWith({ versionId: 'ver1', adminUserId: 'admin1', notes: 'nope' });
  });

  it('maps self_review_forbidden to 403', async () => {
    h.approveSubmission.mockResolvedValue({ error: 'self_review_forbidden' });
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(403);
  });

  it('rejects a non-admin (403) before doing anything', async () => {
    h.isPlatformAdmin.mockReturnValue(false);
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'approve' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(403);
    expect(h.approveSubmission).not.toHaveBeenCalled();
  });

  it('400 on an unknown action', async () => {
    const res = await POST_REVIEW(req('http://x/api/admin/program-reviews/ver1', { action: 'frobnicate' }, 'POST'), ctx({ versionId: 'ver1' }));
    expect(res.status).toBe(400);
  });
});
