import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codeSiteClient from '../codesiteClient';
import {
  CODE_SITE_LIVE_EVENT_TYPES,
  adoptCodeSiteLearningCatalogEntry,
  decideCodeSiteFleetNotam,
  fetchCodeSiteFleetNotams,
  fetchCodeSiteLearningCatalog,
  answerCodeSiteProjectQuestion,
  fetchCodeSiteProjectExperts,
  fetchCodeSiteProjectKnowledge,
  submitCodeSiteProjectQuestionFeedback,
  subscribeCodeSiteProjectEvents,
  supersedeCodeSiteFleetNotam,
  updateCodeSiteProjectControlPlan,
  withdrawCodeSiteFleetNotam,
} from '../codesiteClient';

describe('CodeSite live event subscription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribes to every agent lifecycle event so registry presence refreshes immediately', () => {
    const listeners = new Map();
    const close = vi.fn();
    class FakeEventSource {
      constructor(url) { this.url = url; }
      addEventListener(type, listener) { listeners.set(type, listener); }
      removeEventListener(type) { listeners.delete(type); }
      close() { close(); }
    }
    vi.stubGlobal('window', { EventSource: FakeEventSource });

    const onEvent = vi.fn();
    const unsubscribe = subscribeCodeSiteProjectEvents('team', 'project-1', { onEvent });

    expect(CODE_SITE_LIVE_EVENT_TYPES).toEqual(expect.arrayContaining([
      'agent_attached',
      'agent_resumed',
      'agent_heartbeat',
      'agent_detached',
    ]));
    for (const eventType of ['agent_attached', 'agent_resumed', 'agent_heartbeat', 'agent_detached']) {
      expect(listeners.has(eventType)).toBe(true);
    }
    listeners.get('agent_heartbeat')({ data: JSON.stringify({ eventType: 'agent_heartbeat', actorId: 'agent-1' }) });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'agent_heartbeat' }));
    unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribes to every shared knowledge event type', () => {
    const listeners = new Map();
    class FakeEventSource {
      addEventListener(type, listener) { listeners.set(type, listener); }
      removeEventListener(type) { listeners.delete(type); }
      close() {}
    }
    vi.stubGlobal('window', { EventSource: FakeEventSource });
    const eventTypes = [
      'discovery_recorded',
      'lead_opened',
      'lead_claimed',
      'lead_resolved',
      'lead_dismissed',
      'shared_skill_published',
      'shared_skill_updated',
      'workspace_learning_adopted',
      'impact_notice_created',
      'impact_notice_responded',
      'handoff_ready',
      'handoff_acknowledged',
      'agent_question_asked',
      'agent_question_answered',
      'agent_question_feedback_submitted',
    ];
    const onEvent = vi.fn();

    const unsubscribe = subscribeCodeSiteProjectEvents('team', 'project-1', { onEvent });

    expect(CODE_SITE_LIVE_EVENT_TYPES).toEqual(expect.arrayContaining(eventTypes));
    for (const eventType of eventTypes) expect(listeners.has(eventType)).toBe(true);
    listeners.get('impact_notice_created')({
      data: JSON.stringify({ eventType: 'impact_notice_created', actorId: 'knowledge-1' }),
    });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'impact_notice_created' }));
    unsubscribe();
    for (const eventType of eventTypes) expect(listeners.has(eventType)).toBe(false);
  });
});

describe('CodeSite learning catalogue client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists, adopts, and configures learning through project-scoped routes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      learning: [{ id: 'lesson/1', scope: 'workspace' }],
      networkEnabled: true,
      project: { id: 'project/1' },
      event: { eventType: 'workspace_learning_adopted' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(fetchCodeSiteLearningCatalog('team/a', 'project/1')).resolves.toEqual({
      learning: [{ id: 'lesson/1', scope: 'workspace' }],
      networkEnabled: true,
    });
    await adoptCodeSiteLearningCatalogEntry('team/a', 'project/1', 'lesson/1');
    await updateCodeSiteProjectControlPlan('team/a', 'project/1', {
      learningNetwork: { workspace: true, network: true },
    });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/learning-catalog',
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/learning-catalog/lesson%2F1/adopt',
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/control-plan',
    ]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(fetch.mock.calls[2][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ learningNetwork: { workspace: true, network: true } }),
    });
  });
});

describe('CodeSite fleet NOTAM client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the lifecycle board with explicit, safe visibility filters', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      advisories: [{ notamId: 'notam-1' }], suppressed: 2,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await expect(fetchCodeSiteFleetNotams('team/a', 'project/1', {
      includeOwn: true,
      includeMuted: true,
      includeInactive: true,
      route: ' packages/api/** ',
      ignored: 'never-forwarded',
    })).resolves.toEqual({ advisories: [{ notamId: 'notam-1' }], suppressed: 2 });

    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/fleet-notams?include_own=true&include_muted=true&include_inactive=true&route=packages%2Fapi%2F**',
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('sends local decisions and origin lifecycle actions to explicit routes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ fleetNotam: { notamId: 'notam/1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await decideCodeSiteFleetNotam('team', 'project', 'notam/1', { state: 'adopt', reason: 'reproduced locally' });
    await withdrawCodeSiteFleetNotam('team', 'project', 'notam/1', { reason: 'replaced' });
    await supersedeCodeSiteFleetNotam('team', 'project', 'notam/1', { policyDeltaId: 'delta-2' });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/team/codesite/projects/project/fleet-notams/notam%2F1/decision',
      '/api/workspace/team/codesite/projects/project/fleet-notams/notam%2F1/withdraw',
      '/api/workspace/team/codesite/projects/project/fleet-notams/notam%2F1/supersede',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ state: 'adopt', reason: 'reproduced locally' }) });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ reason: 'replaced' }) });
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ policyDeltaId: 'delta-2' }) });
  });
});

describe('CodeSite project knowledge client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists human-visible project knowledge with only safe allowlisted filters', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      knowledge: [{ id: 'knowledge-1', kind: 'discovery', status: 'verified' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const knowledge = await fetchCodeSiteProjectKnowledge('team/a', 'project/1', {
      kind: ' Discovery ',
      status: ' VERIFIED ',
      limit: 25,
      since: '2026-08-22T10:00:00+02:00',
      auth_token: 'csa_private_agent_token',
      agent_session_id: 'agent-private',
      providerSessionRef: 'provider-private-ref',
      prompt: 'private prompt',
    });

    expect(knowledge).toEqual([{ id: 'knowledge-1', kind: 'discovery', status: 'verified' }]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/knowledge?kind=discovery&status=verified&limit=25&since=2026-08-22T08%3A00%3A00.000Z',
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const serializedRequest = JSON.stringify(fetch.mock.calls);
    expect(serializedRequest).not.toContain('csa_private_agent_token');
    expect(serializedRequest).not.toContain('agent-private');
    expect(serializedRequest).not.toContain('provider-private-ref');
    expect(serializedRequest).not.toContain('private prompt');
    expect(serializedRequest).not.toContain('/agent-sessions/');
    expect(serializedRequest).not.toContain('/inbox/');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('authorization');
  });

  it('forwards the project-safe agent question kind filter', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ knowledge: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await fetchCodeSiteProjectKnowledge('team', 'project-1', {
      kind: 'agent_question',
      status: 'open',
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team/codesite/projects/project-1/knowledge?kind=agent_question&status=open',
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('forwards a cursor and exposes the next page token without changing the array contract', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      knowledge: [{ id: 'question-2', kind: 'agent_question', status: 'open' }],
      nextCursor: 'cursor/next',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const knowledge = await fetchCodeSiteProjectKnowledge('team', 'project-1', {
      kind: 'agent_question',
      status: 'open',
      cursor: 'cursor/current',
    });

    expect(knowledge).toEqual([{ id: 'question-2', kind: 'agent_question', status: 'open' }]);
    expect(knowledge.nextCursor).toBe('cursor/next');
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team/codesite/projects/project-1/knowledge?kind=agent_question&status=open&cursor=cursor%2Fcurrent',
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('drops invalid knowledge filters instead of forwarding arbitrary values', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ knowledge: 'invalid' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const knowledge = await fetchCodeSiteProjectKnowledge('team', 'project-1', {
      kind: 'private_prompt',
      status: '../verified',
      limit: 101,
      since: 'not-a-date',
      unknown: 'do-not-forward',
    });

    expect(knowledge).toEqual([]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team/codesite/projects/project-1/knowledge',
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('does not request project knowledge without both human route identifiers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(fetchCodeSiteProjectKnowledge('', 'project-1')).resolves.toEqual([]);
    await expect(fetchCodeSiteProjectKnowledge('team', '')).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requests project experts with repeated, encoded reference parameters', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      projectId: 'project/1',
      experts: [{ agentSessionId: 'session-1', score: 2 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await fetchCodeSiteProjectExperts('team/a', 'project/1', {
      paths: ['src/a.ts', 'src/a.ts', 'src/b.ts'],
      symbols: ['build?Plan'],
      contracts: ['route/v2'],
    });

    expect(result.experts).toEqual([{ agentSessionId: 'session-1', score: 2 }]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspace/team%2Fa/codesite/projects/project%2F1/experts?path=src%2Fa.ts&path=src%2Fb.ts&symbol=build%3FPlan&contract=route%2Fv2',
      { headers: { 'Content-Type': 'application/json' } },
    );
  });

  it('uses human project routes for answering and reviewing a question', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await answerCodeSiteProjectQuestion('team', 'project-1', 'question/1', 'Use the shared route.', ['proof:1', 'proof:1']);
    await submitCodeSiteProjectQuestionFeedback('team', 'project-1', 'question/1', {
      verdict: 'needs_correction',
      correction: 'Prefer the versioned contract.',
      evidenceRefs: ['contract:2'],
    });

    expect(fetch.mock.calls).toEqual([
      [
        '/api/workspace/team/codesite/projects/project-1/questions/question%2F1/answer',
        {
          method: 'POST',
          body: JSON.stringify({ answer: 'Use the shared route.', evidenceRefs: ['proof:1'] }),
          headers: { 'Content-Type': 'application/json' },
        },
      ],
      [
        '/api/workspace/team/codesite/projects/project-1/knowledge/question%2F1/feedback',
        {
          method: 'POST',
          body: JSON.stringify({
            verdict: 'needs_correction',
            correction: 'Prefer the versioned contract.',
            evidenceRefs: ['contract:2'],
          }),
          headers: { 'Content-Type': 'application/json' },
        },
      ],
    ]);
  });

  it('does not request project experts without both human route identifiers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(fetchCodeSiteProjectExperts('', 'project-1', { paths: ['src/a.ts'] })).resolves.toBeNull();
    await expect(fetchCodeSiteProjectExperts('team', '', { paths: ['src/a.ts'] })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not expose agent identity, agent read, or inbox response browser helpers', () => {
    for (const forbiddenExport of [
      'createAgentKnowledgeItem',
      'getAgentSharedKnowledge',
      'respondToAgentKnowledgeInbox',
      'fetchCodeSiteAgentKnowledge',
      'respondCodeSiteImpactNotice',
    ]) {
      expect(codeSiteClient).not.toHaveProperty(forbiddenExport);
    }
  });
});
