import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  canRead: vi.fn(),
  canWrite: vi.fn(),
  listLocalPrograms: vi.fn(),
  listInstalls: vi.fn(),
  listPermissionGrants: vi.fn(),
  createPermissionGrant: vi.fn(),
  upsertLocalProgram: vi.fn(),
  createInstall: vi.fn(),
  getInstall: vi.fn(),
  getProgramVersion: vi.fn(),
  publishProgram: vi.fn(),
  listPublishedPrograms: vi.fn(),
  getPublishedProgramVersion: vi.fn(),
  incrementInstallCount: vi.fn(),
  createProgramSession: vi.fn(),
  updateProgramSession: vi.fn(),
  appendProgramRuntimeEvent: vi.fn(),
  discoverManifest: vi.fn(),
  launchInstalledProgram: vi.fn(),
  scaffoldProgram: vi.fn(),
  fetchDetectedRepoProgram: vi.fn(),
  submitForReview: vi.fn(),
  processSubmission: vi.fn(),
  listSubmissionsForWorkspace: vi.fn(),
  unpublishProgram: vi.fn(),
  canPublish: vi.fn(),
  generateManifestFromContext: vi.fn(),
  fetchWorkspaceContext: vi.fn(),
  evaluatePaywall: vi.fn(),
  paywallDenial: vi.fn(),
  listPricingForPrograms: vi.fn(),
  listActiveEntitlementProgramIds: vi.fn(),
  toPublicPricing: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead, canWriteScope: h.canWrite }));
vi.mock('@/lib/programs/store', () => ({
  listLocalPrograms: h.listLocalPrograms,
  listInstalls: h.listInstalls,
  listPermissionGrants: h.listPermissionGrants,
  createPermissionGrant: h.createPermissionGrant,
  upsertLocalProgram: h.upsertLocalProgram,
  createInstall: h.createInstall,
  getInstall: h.getInstall,
  getProgramVersion: h.getProgramVersion,
  createProgramSession: h.createProgramSession,
  updateProgramSession: h.updateProgramSession,
  appendProgramRuntimeEvent: h.appendProgramRuntimeEvent,
  publishProgram: h.publishProgram,
  listPublishedPrograms: h.listPublishedPrograms,
  getPublishedProgramVersion: h.getPublishedProgramVersion,
  incrementInstallCount: h.incrementInstallCount,
  listSubmissionsForWorkspace: h.listSubmissionsForWorkspace,
  unpublishProgram: h.unpublishProgram,
  listPricingForPrograms: h.listPricingForPrograms,
  listActiveEntitlementProgramIds: h.listActiveEntitlementProgramIds,
  // Real-ish projection so the install route can return a public install.
  toPublicInstall: (row) =>
    row
      ? { id: row.id, version: row.version, status: row.status, packageId: row.program?.packageId ?? null, publisher: row.program?.publisher ?? null }
      : row,
  // Pass-through projection for published programs in route tests.
  toPublicMarketplaceProgram: (row) => row,
  // Allow-listed review-queue projection (versionId + state, no raw manifest).
  toReviewQueueItem: (row) => (row ? { versionId: row.id, reviewState: row.reviewState, packageId: row.program?.packageId ?? null } : row),
}));
vi.mock('@/lib/programs/runtimeClient', () => ({
  discoverManifest: h.discoverManifest,
  launchInstalledProgram: h.launchInstalledProgram,
  scaffoldProgram: h.scaffoldProgram,
  fetchDetectedRepoProgram: h.fetchDetectedRepoProgram,
  fetchWorkspaceContext: h.fetchWorkspaceContext,
}));
vi.mock('@/lib/programs/manifestGenerator', () => ({ generateManifestFromContext: h.generateManifestFromContext }));
vi.mock('@/lib/programs/reviewOrchestrator', () => ({ submitForReview: h.submitForReview, processSubmission: h.processSubmission }));
vi.mock('@/lib/programs/entitlements', () => ({ canPublish: h.canPublish, isPlatformAdmin: vi.fn() }));
vi.mock('@/lib/programs/paidGate', () => ({ evaluatePaywall: h.evaluatePaywall, paywallDenial: h.paywallDenial }));
vi.mock('@/lib/programs/pricing', () => ({ toPublicPricing: h.toPublicPricing }));

import { GET as GET_MARKETPLACE } from '../marketplace/route.js';
import { GET as GET_INSTALLED } from '../installed/route.js';
import { POST as POST_INSTALL } from '../install/route.js';
import { POST as POST_LAUNCH } from '../[installId]/launch/route.js';
import { POST as POST_PUBLISH } from '../publish/route.js';
import { GET as GET_SUBMISSIONS } from '../submissions/route.js';
import { POST as POST_UNPUBLISH } from '../unpublish/route.js';
import { POST as POST_GEN } from '../generate-manifest/route.js';
import { POST as POST_SAVE } from '../manifest/route.js';
import { POST as POST_SCAFFOLD } from '../scaffold/route.js';
import { GET as GET_DETECT, POST as POST_DETECT } from '../detect/route.js';

const req = (url, body, method = 'GET') => ({ url, method, json: async () => body });
const ctx = (params) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c', workspaceUserId: 'gh1' });
  h.canRead.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.canPublish.mockReturnValue(true);
  h.listPermissionGrants.mockResolvedValue([]);
  h.appendProgramRuntimeEvent.mockResolvedValue({ id: 'evt-1' });
  // Paywall allows by default; specific tests override to a denial.
  h.evaluatePaywall.mockResolvedValue({ ok: true });
  h.paywallDenial.mockImplementation((d) => (d && !d.ok
    ? { status: d.reason === 'billing_unconfigured' ? 503 : 402, body: { error: d.reason, priceCents: d.priceCents ?? null, currency: d.currency ?? null } }
    : null));
  // Catalog enrichment: no pricing / no entitlements by default.
  h.listPricingForPrograms.mockResolvedValue([]);
  h.listActiveEntitlementProgramIds.mockResolvedValue([]);
  h.toPublicPricing.mockImplementation((p) => (p ? { priceCents: p.priceCents, currency: p.currency, isPaid: p.priceCents > 0 } : null));
});

describe('GET /programs/marketplace', () => {
  it('returns the published catalog (search) for a member', async () => {
    h.listPublishedPrograms.mockResolvedValue([
      { id: 'p1', packageId: '@team/web', publisher: 'team', verified: false, latestVersion: '1.0.0', displayName: 'Web', description: null, installCount: 3 },
    ]);

    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace?q=web'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.listPublishedPrograms).toHaveBeenCalledWith({ q: 'web' });
    const body = await res.json();
    expect(body.programs[0]).toMatchObject({ packageId: '@team/web', publisher: 'team', installCount: 3 });
  });

  it('rejects a non-member', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.listPublishedPrograms).not.toHaveBeenCalled();
  });

  it('enriches each program with a redacted price + entitlement (no payout ref / take-rate)', async () => {
    h.listPublishedPrograms.mockResolvedValue([{ id: 'p1', packageId: '@team/paid', publisher: 'team', installCount: 0 }]);
    h.listPricingForPrograms.mockResolvedValue([{ programId: 'p1', priceCents: 500, currency: 'eur', payoutAccountRef: 'acct_9', takeRateBps: 3000 }]);
    h.listActiveEntitlementProgramIds.mockResolvedValue(['p1']);

    const res = await GET_MARKETPLACE(req('http://x/api/workspace/team/programs/marketplace'), ctx({ slug: 'team' }));
    const prog = (await res.json()).programs[0];

    expect(prog.price).toEqual({ priceCents: 500, currency: 'eur', isPaid: true });
    expect(prog.isPaid).toBe(true);
    expect(prog.entitled).toBe(true);
    expect(h.listActiveEntitlementProgramIds).toHaveBeenCalledWith({ subjectId: 'u1', programIds: ['p1'] });
    const raw = JSON.stringify(prog);
    expect(raw).not.toContain('acct_9');
    expect(raw).not.toContain('takeRateBps');
  });
});

describe('POST /programs/publish (submit to review)', () => {
  it('submits the workspace manifest + image ref through the review gate', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'pending_review' });

    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'reg.io/me/tool:1' }, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.submitForReview).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sourceImageRef: 'reg.io/me/tool:1', submittedByUserId: 'u1' }));
    const body = await res.json();
    expect(body.submission).toMatchObject({ versionId: 'ver1', reviewState: 'pending_review' });
  });

  it('rejects publish when canPublish is false (entitlement, 403)', async () => {
    h.canPublish.mockReturnValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.submitForReview).not.toHaveBeenCalled();
  });

  it('rejects publish for a plain member (workspace write, 403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.submitForReview).not.toHaveBeenCalled();
  });

  it('returns 404 when there is no workspace manifest to submit', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });

  it('surfaces a rejected result (still 200, body carries the reasons)', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run x' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'rejected', reasons: [{ code: 'host_escape' }] });
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'x' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submission.reviewState).toBe('rejected');
    expect(body.submission.reasons[0].code).toBe('host_escape');
  });
});

describe('POST /programs/publish — queued image submission kicks off processing', () => {
  it('returns the queued submission and fire-and-forgets processSubmission', async () => {
    h.discoverManifest.mockResolvedValue({ config: { packageId: 'tool', version: '1.0.0', runtimeType: 'container', launch: 'docker run reg.io/me/tool:1' }, source: 'vectant.programs.json' });
    h.submitForReview.mockResolvedValue({ versionId: 'ver1', reviewState: 'submitted' });
    h.processSubmission.mockResolvedValue({ reviewState: 'published' });
    const res = await POST_PUBLISH(req('http://x/api/workspace/team/programs/publish', { sourceImageRef: 'reg.io/me/tool:1' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect((await res.json()).submission.reviewState).toBe('submitted');
    expect(h.processSubmission).toHaveBeenCalledWith('ver1');
  });
});

describe('POST /programs/unpublish', () => {
  it('unpublishes the workspace own program for an owner/admin', async () => {
    h.unpublishProgram.mockResolvedValue({ id: 'p1', publishedVersion: null });
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@team/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect(h.unpublishProgram).toHaveBeenCalledWith('@team/tool');
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@team/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.unpublishProgram).not.toHaveBeenCalled();
  });

  it('refuses to unpublish a program owned by another workspace (403)', async () => {
    const res = await POST_UNPUBLISH(req('http://x/api/workspace/team/programs/unpublish', { packageId: '@other/tool' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.unpublishProgram).not.toHaveBeenCalled();
  });
});

describe('POST /programs/generate-manifest', () => {
  it('generates + validates a manifest (owner/admin)', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({ 'package.json': '{}' });
    h.generateManifestFromContext.mockResolvedValue({ packageId: 'web', version: '1.0.0', runtimeType: 'web', launch: 'npm run dev', ports: [3000], permissions: ['program.launch'] });
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.manifest.packageId).toBe('web');
    expect(h.fetchWorkspaceContext).toHaveBeenCalledWith('team', 'gh1');
  });

  it('returns valid:false + errors for an invalid generated manifest', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({});
    h.generateManifestFromContext.mockResolvedValue({ packageId: '../evil', version: '1.0.0', launch: 'x' });
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('502 when the engine returns nothing', async () => {
    h.fetchWorkspaceContext.mockResolvedValue({});
    h.generateManifestFromContext.mockResolvedValue(null);
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(502);
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_GEN(req('http://x/api/workspace/team/programs/generate-manifest', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.generateManifestFromContext).not.toHaveBeenCalled();
  });
});

describe('POST /programs/manifest (save)', () => {
  const good = { packageId: 'web', version: '1.0.0', runtimeType: 'web', launch: 'npm run dev', ports: [3000], permissions: ['program.launch'] };
  it('re-validates + writes vectant.programs.json (overwrite) for an owner/admin', async () => {
    h.scaffoldProgram.mockResolvedValue({ written: ['vectant.programs.json'], skipped: [] });
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: good }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const passed = h.scaffoldProgram.mock.calls[0][0];
    expect(passed.overwrite).toBe(true);
    expect(passed.files[0].path).toBe('vectant.programs.json');
  });

  it('422 (never writes) for an invalid manifest', async () => {
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: { packageId: '../evil', version: '1.0.0', launch: 'x' } }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(422);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_SAVE(req('http://x/api/workspace/team/programs/manifest', { manifest: good }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });
});

describe('GET /programs/submissions', () => {
  it('lists the workspace submissions (redacted) for a member', async () => {
    h.listSubmissionsForWorkspace.mockResolvedValue([{ id: 'ver1', reviewState: 'pending_review', manifestJson: '{"env":{"SECRET":"x"}}', program: { packageId: '@team/tool' } }]);
    const res = await GET_SUBMISSIONS(req('http://x/api/workspace/team/programs/submissions'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submissions[0]).toMatchObject({ versionId: 'ver1', reviewState: 'pending_review' });
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('rejects a non-member (403)', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_SUBMISSIONS(req('http://x/api/workspace/team/programs/submissions'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.listSubmissionsForWorkspace).not.toHaveBeenCalled();
  });
});

describe('GET /programs/installed', () => {
  it('lists installs (public projection) for a member', async () => {
    h.listInstalls.mockResolvedValue([
      { id: 'inst1', version: '1.0.0', status: 'installed', program: { packageId: 'local:team:web', publisher: 'local' } },
    ]);

    const res = await GET_INSTALLED(req('http://x/api/workspace/team/programs/installed'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installs[0]).toMatchObject({ id: 'inst1', packageId: 'local:team:web', status: 'installed' });
  });
});

describe('POST /programs/install', () => {
  const manifest = {
    config: {
      packageId: 'web', version: '1.0.0', displayName: 'Web', runtimeType: 'web',
      workingDir: '', install: ['npm ci'], launch: 'npm run dev', env: {}, ports: [3000],
      surfaces: [], health: null, permissions: ['program.launch', 'network.outbound'],
      source: 'vectant.programs.json', sourceHints: {},
    },
    source: 'vectant.programs.json',
  };

  it('installs for an owner/admin once consent covers the manifest scopes', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.createPermissionGrant.mockResolvedValue({ id: 'g1', scopes: ['program.launch', 'network.outbound'] });
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' }, version: { id: 'ver1' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { grantScopes: ['program.launch', 'network.outbound'] }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.install).toMatchObject({ id: 'inst1', packageId: 'local:team:web' });
    expect(body.grant).toMatchObject({ id: 'g1' });
    expect(h.createInstall).toHaveBeenCalledWith(expect.objectContaining({ programId: 'prog1', version: '1.0.0', grantId: 'g1', status: 'installed' }));
    // Per-user repos require the actor's workspaceUserId to resolve the workspace cwd.
    expect(h.discoverManifest).toHaveBeenCalledWith('team', 'gh1');
  });

  it('blocks a paid published install without entitlement (402, no install created)', async () => {
    h.getPublishedProgramVersion.mockResolvedValue({ program: { id: 'progPaid', packageId: '@team/paid' }, config: { ...manifest.config } });
    h.evaluatePaywall.mockResolvedValue({ ok: false, reason: 'payment_required', priceCents: 500, currency: 'eur' });
    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@team/paid', version: '1.0.0' }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: 'payment_required', priceCents: 500 });
    expect(h.evaluatePaywall).toHaveBeenCalledWith({ programId: 'progPaid', subjectId: 'u1' });
    expect(h.createInstall).not.toHaveBeenCalled();
  });

  it('allows a paid published install when entitled', async () => {
    h.getPublishedProgramVersion.mockResolvedValue({ program: { id: 'progPaid', packageId: '@team/paid' }, config: { ...manifest.config } });
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.createInstall.mockResolvedValue({ id: 'inst9', version: '1.0.0', status: 'installed' });
    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@team/paid', version: '1.0.0' }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(200);
    expect(h.createInstall).toHaveBeenCalled();
  });

  it('reuses an existing grant that already covers the manifest scopes', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.createPermissionGrant).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.grant).toMatchObject({ id: 'g0' });
  });

  it('requires consent (409) listing the manifest scopes when none granted', async () => {
    h.discoverManifest.mockResolvedValue(manifest);

    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('consent_required');
    expect(body.requested).toEqual(['program.launch', 'network.outbound']);
    expect(h.createInstall).not.toHaveBeenCalled();
  });

  it('rejects install for a plain member', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.discoverManifest).not.toHaveBeenCalled();
  });

  it('returns 404 when no manifest is found', async () => {
    h.discoverManifest.mockResolvedValue(null);
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', { grantScopes: ['program.launch'] }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
  });

  it('returns 422 manifest_invalid when the manifest fails validation', async () => {
    h.discoverManifest.mockRejectedValue(Object.assign(new Error('Invalid packageId'), {
      name: 'ProgramManifestError', code: 'invalid_field', field: 'packageId',
    }));
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('manifest_invalid');
    expect(body.message).toBe('Invalid packageId');
  });

  it('returns 502 program_runtime_unreachable when discovery fails for a non-manifest reason', async () => {
    h.discoverManifest.mockRejectedValue(Object.assign(new Error('Collab runtime request failed (500)'), { status: 500 }));
    const res = await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('program_runtime_unreachable');
  });

  it('installs a published program by packageId+version and bumps installCount', async () => {
    h.getPublishedProgramVersion.mockResolvedValue({
      program: { id: 'pubprog', packageId: '@other/web', publisher: 'other' },
      version: { id: 'v1' },
      config: { packageId: 'web', version: '1.0.0', permissions: ['program.launch'] },
    });
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch'] }]);
    h.createInstall.mockResolvedValue({ id: 'inst2', version: '1.0.0', status: 'installed' });

    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '1.0.0' }, 'POST'),
      ctx({ slug: 'team' }),
    );

    expect(res.status).toBe(200);
    expect(h.discoverManifest).not.toHaveBeenCalled();
    expect(h.createInstall).toHaveBeenCalledWith(expect.objectContaining({ programId: 'pubprog', version: '1.0.0', status: 'installed' }));
    expect(h.incrementInstallCount).toHaveBeenCalledWith('pubprog');
  });

  it('returns 404 when the published program/version is not found', async () => {
    h.getPublishedProgramVersion.mockResolvedValue(null);
    const res = await POST_INSTALL(
      req('http://x/api/workspace/team/programs/install', { packageId: '@other/web', version: '9.9.9', grantScopes: ['program.launch'] }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(404);
  });

  it('does not bump installCount for a local workspace-manifest install', async () => {
    h.discoverManifest.mockResolvedValue(manifest);
    h.listPermissionGrants.mockResolvedValue([{ id: 'g0', scopes: ['program.launch', 'network.outbound'] }]);
    h.upsertLocalProgram.mockResolvedValue({ program: { id: 'prog1', packageId: 'local:team:web', publisher: 'local' } });
    h.createInstall.mockResolvedValue({ id: 'inst1', version: '1.0.0', status: 'installed' });

    await POST_INSTALL(req('http://x/api/workspace/team/programs/install', {}, 'POST'), ctx({ slug: 'team' }));
    expect(h.incrementInstallCount).not.toHaveBeenCalled();
  });
});

describe('POST /programs/[installId]/launch', () => {
  it('launches an install from its stored manifest for an owner/admin', async () => {
    const codeSiteContext = { projectId: 'project-1', transactionId: 'txn-1', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' };
    h.getInstall.mockResolvedValue({ id: 'inst1', programId: 'prog1', workspaceSlug: 'team', version: '1.0.0' });
    h.getProgramVersion.mockResolvedValue({ manifestJson: JSON.stringify({ runtimeType: 'web', displayName: 'Web', launch: 'npm run dev', ports: [3000] }) });
    h.createProgramSession.mockResolvedValue({ id: 'ps1', workspaceSlug: 'team', runtimeType: 'web', state: 'starting' });
    h.launchInstalledProgram.mockResolvedValue({ sessionId: 'ps1', state: 'running', activePorts: [3000], webPort: 3000 });
    h.updateProgramSession.mockResolvedValue({ id: 'ps1', workspaceSlug: 'team', state: 'running' });

    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', { codeSiteContext }, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));

    expect(res.status).toBe(200);
    expect(h.launchInstalledProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps1', userId: 'gh1', codeSiteContext }));
    expect(h.appendProgramRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'launch_requested',
      codeSiteContext,
    }));
    expect(h.appendProgramRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'launch_ack',
      codeSiteContext,
    }));
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps1', state: 'running', activePorts: [3000], webPort: 3000 });
  });

  it('rejects launch for a plain member', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));
    expect(res.status).toBe(403);
    expect(h.getInstall).not.toHaveBeenCalled();
  });

  it('returns 404 when the install is missing', async () => {
    h.getInstall.mockResolvedValue(null);
    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));
    expect(res.status).toBe(404);
  });

  it('blocks launch when the paywall denies (refund/revoke) — 402, no session', async () => {
    h.getInstall.mockResolvedValue({ id: 'inst1', programId: 'progPaid', workspaceSlug: 'team', version: '1.0.0' });
    h.evaluatePaywall.mockResolvedValue({ ok: false, reason: 'payment_required', priceCents: 500, currency: 'eur' });
    const res = await POST_LAUNCH(req('http://x/api/workspace/team/programs/inst1/launch', {}, 'POST'), ctx({ slug: 'team', installId: 'inst1' }));
    expect(res.status).toBe(402);
    expect(h.evaluatePaywall).toHaveBeenCalledWith({ programId: 'progPaid', subjectId: 'u1' });
    expect(h.createProgramSession).not.toHaveBeenCalled();
  });
});

describe('POST /programs/scaffold', () => {
  it('scaffolds a known default into the workspace for an owner/admin', async () => {
    h.scaffoldProgram.mockResolvedValue({ written: ['package.json', 'app/page.js'], skipped: [] });
    const res = await POST_SCAFFOLD(
      req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'),
      ctx({ slug: 'team' }),
    );
    expect(res.status).toBe(200);
    expect(h.scaffoldProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', userId: 'gh1' }));
    const passed = h.scaffoldProgram.mock.calls[0][0];
    expect(passed.files.some((f) => f.path === 'package.json')).toBe(true);
    const body = await res.json();
    expect(body.written).toContain('package.json');
  });

  it('rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/nextjs-dev' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });

  it('returns 404 for a packageId with no scaffold template', async () => {
    const res = await POST_SCAFFOLD(req('http://x/api/workspace/team/programs/scaffold', { packageId: '@vectant/lazygit' }, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
    expect(h.scaffoldProgram).not.toHaveBeenCalled();
  });
});

describe('GET /programs/detect (Slice 1)', () => {
  it('returns the detected repo program for a member (forwarding the workspace user)', async () => {
    h.fetchDetectedRepoProgram.mockResolvedValue({ config: { runtimeType: 'container', launch: 'docker compose up' }, source: 'docker-compose.yml' });
    const res = await GET_DETECT(req('http://x/api/workspace/team/programs/detect'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect(h.fetchDetectedRepoProgram).toHaveBeenCalledWith('team', 'gh1');
    const body = await res.json();
    expect(body.detected.source).toBe('docker-compose.yml');
  });

  it('returns a null detected when nothing container-like is present', async () => {
    h.fetchDetectedRepoProgram.mockResolvedValue(null);
    const res = await GET_DETECT(req('http://x/api/workspace/team/programs/detect'), ctx({ slug: 'team' }));
    expect(res.status).toBe(200);
    expect((await res.json()).detected).toBeNull();
  });

  it('rejects a non-member (403)', async () => {
    h.canRead.mockResolvedValue(false);
    const res = await GET_DETECT(req('http://x/api/workspace/team/programs/detect'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.fetchDetectedRepoProgram).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller (401)', async () => {
    h.actor.mockResolvedValue(null);
    const res = await GET_DETECT(req('http://x/api/workspace/team/programs/detect'), ctx({ slug: 'team' }));
    expect(res.status).toBe(401);
  });

  it('POST launches the detected repo program (re-detected server-side) and surfaces runtimeScope', async () => {
    const codeSiteContext = { projectId: 'project-1', transactionId: 'txn-1', mutationLeaseId: 'lease-1', agentSessionId: 'agent-1' };
    h.fetchDetectedRepoProgram.mockResolvedValue({ config: { runtimeType: 'container', displayName: 'Compose', launch: 'docker compose up' }, source: 'docker-compose.yml' });
    h.createProgramSession.mockResolvedValue({ id: 'ps-d', workspaceSlug: 'team', runtimeType: 'container', state: 'starting' });
    h.launchInstalledProgram.mockResolvedValue({ sessionId: 'ps-d', state: 'running', activePorts: [8080], webPort: 8080, runtimeScope: 'scope-1' });
    h.updateProgramSession.mockResolvedValue({ id: 'ps-d', workspaceSlug: 'team', state: 'running' });

    const res = await POST_DETECT(req('http://x/api/workspace/team/programs/detect', { codeSiteContext }, 'POST'), ctx({ slug: 'team' }));

    expect(res.status).toBe(200);
    expect(h.launchInstalledProgram).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'team', sessionId: 'ps-d', userId: 'gh1', codeSiteContext }));
    expect(h.appendProgramRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'launch_requested',
      codeSiteContext,
    }));
    expect(h.appendProgramRuntimeEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'launch_ack',
      codeSiteContext,
    }));
    const body = await res.json();
    expect(body.session).toMatchObject({ id: 'ps-d', state: 'running', runtimeScope: 'scope-1' });
  });

  it('POST returns 404 when nothing container-like is detected', async () => {
    h.fetchDetectedRepoProgram.mockResolvedValue(null);
    const res = await POST_DETECT(req('http://x/api/workspace/team/programs/detect', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(404);
    expect(h.launchInstalledProgram).not.toHaveBeenCalled();
  });

  it('POST rejects a plain member (403)', async () => {
    h.canWrite.mockResolvedValue(false);
    const res = await POST_DETECT(req('http://x/api/workspace/team/programs/detect', {}, 'POST'), ctx({ slug: 'team' }));
    expect(res.status).toBe(403);
    expect(h.fetchDetectedRepoProgram).not.toHaveBeenCalled();
  });
});
