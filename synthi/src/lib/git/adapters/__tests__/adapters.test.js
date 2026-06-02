import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ token: vi.fn(async () => 'TKN'), fetchMock: vi.fn() }));
vi.mock('../../token.js', () => ({ withFreshToken: h.token }));
vi.mock('../../safeFetch.js', () => ({ gitFetch: (...a) => h.fetchMock(...a) }));

import { getAdapter } from '../index.js';

function okJson(data) { return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }; }
beforeEach(() => { vi.clearAllMocks(); });

describe('github adapter', () => {
  it('createPullRequest posts to /repos/:repo/pulls and normalizes the PR', async () => {
    h.fetchMock.mockResolvedValue(okJson({ number: 7, html_url: 'https://gh/pr/7', state: 'open' }));
    const a = getAdapter('github');
    const r = await a.createPullRequest({ providerType: 'github', authType: 'pat', secret: {} }, { repo: 'o/r', sourceBranch: 'f', targetBranch: 'main', title: 't', body: 'b' });
    expect(r.ok).toBe(true);
    expect(r.pr).toMatchObject({ id: 7, url: 'https://gh/pr/7', state: 'open' });
    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toContain('/repos/o/r/pulls');
    expect(init.headers.authorization).toBe('Bearer TKN');
  });
});

describe('gitlab adapter', () => {
  it('createPullRequest posts a merge_request and normalizes it to a PR shape', async () => {
    h.fetchMock.mockResolvedValue(okJson({ iid: 3, web_url: 'https://gl/mr/3', state: 'opened' }));
    const a = getAdapter('gitlab');
    const r = await a.createPullRequest({ providerType: 'gitlab', authType: 'pat', secret: {} }, { repo: 'group/proj', sourceBranch: 'f', targetBranch: 'main', title: 't', body: 'b' });
    expect(r.ok).toBe(true);
    expect(r.pr).toMatchObject({ id: 3, url: 'https://gl/mr/3', state: 'opened' });
    expect(h.fetchMock.mock.calls[0][0]).toContain('/projects/group%2Fproj/merge_requests');
  });
  it('maps a non-ok response to a typed error', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    const r = await getAdapter('gitlab').listRepos({ providerType: 'gitlab', authType: 'pat', secret: {} }, {});
    expect(r).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

it('generic reuses the gitlab adapter', () => {
  expect(getAdapter('generic').listRepos).toBe(getAdapter('gitlab').listRepos);
});
