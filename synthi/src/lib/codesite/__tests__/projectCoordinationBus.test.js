import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_COORDINATION_PIPELINE,
  ProjectCoordinationBusError,
  createProjectCoordinationBus,
} from '../projectCoordinationBus.js';

function rawObservation(overrides = {}) {
  return {
    projectId: 'project-1',
    eventType: 'runtime.observed',
    provider: 'provider-neutral',
    observation: {
      summary: 'rotation.completed@v2 observed',
      sourcePaths: ['src/CharacterController.cpp'],
    },
    ...overrides,
  };
}

function makeAdapters(overrides = {}) {
  const calls = [];
  const adapters = {
    normalize: vi.fn(async (input) => {
      calls.push('normalize');
      return {
        id: 'event-1',
        projectId: input.projectId,
        eventType: input.eventType,
        source: { kind: 'agent', provider: input.provider },
        payload: input.observation,
      };
    }),
    redact: vi.fn(async (event) => {
      calls.push('redact');
      return { ...event, redactionClass: 'project_fact' };
    }),
    classify: vi.fn(async (event) => {
      calls.push('classify');
      return { ...event, classification: { priority: 'high' } };
    }),
    correlate: vi.fn(async (event) => {
      calls.push('correlate');
      return {
        ...event,
        correlation: {
          sourcePaths: event.payload.sourcePaths,
          transactionIds: ['transaction-2'],
        },
      };
    }),
    authorize: vi.fn(async () => {
      calls.push('authorize');
      return {
        allowed: true,
        recipients: ['agent-session-2'],
        policyDecisionId: 'policy-1',
      };
    }),
    persist: vi.fn(async (event) => {
      calls.push('persist');
      return { ...event, persistedAt: '2026-08-22T12:00:00.000Z' };
    }),
    route: vi.fn(async (_event, metadata) => {
      calls.push('route');
      return { attempted: metadata.authorization.recipients.length, queued: 1 };
    }),
    ...overrides,
  };
  return { adapters, calls };
}

describe('project coordination bus', () => {
  it('enforces normalize -> redact -> classify -> correlate -> authorize -> persist -> route', async () => {
    const { adapters, calls } = makeAdapters();
    const bus = createProjectCoordinationBus(adapters);

    const result = await bus.publish(rawObservation(), { actorUserId: 'alice' });

    expect(calls).toEqual(PROJECT_COORDINATION_PIPELINE);
    expect(result.event).toMatchObject({
      id: 'event-1',
      projectId: 'project-1',
      eventType: 'runtime.observed',
      redactionClass: 'project_fact',
      classification: { priority: 'high' },
      correlation: {
        sourcePaths: ['src/CharacterController.cpp'],
        transactionIds: ['transaction-2'],
      },
      persistedAt: '2026-08-22T12:00:00.000Z',
    });
    expect(result.authorization.recipients).toEqual(['agent-session-2']);
    expect(result.delivery).toEqual({ attempted: 1, queued: 1 });
    expect(adapters.persist.mock.calls[0][1]).toMatchObject({
      context: { actorUserId: 'alice' },
      authorization: { allowed: true, policyDecisionId: 'policy-1' },
    });
    expect(adapters.route.mock.calls[0][0]).toBe(result.event);
  });

  it.each([
    ['raw prompt', { prompt: 'privately supplied instructions' }],
    ['terminal transcript', { nested: { terminalTranscript: '$ export INTERNAL=value' } }],
    ['provider account state', { providerAccountState: { billingPlan: 'enterprise' } }],
    ['credential', { credential: 'username and password' }],
    ['access token', { authToken: 'not-for-project-sharing' }],
    ['private key', { notes: '-----BEGIN PRIVATE KEY----- material' }],
    ['authorization header', { notes: 'Authorization: Bearer private-value-123' }],
    ['credentialed URL', { notes: 'postgresql://alice:private@database.example/app' }],
  ])('rejects %s before redaction, persistence, or routing', async (_label, privateMaterial) => {
    const { adapters, calls } = makeAdapters();
    const bus = createProjectCoordinationBus(adapters);

    await expect(bus.publish(rawObservation({
      observation: {
        summary: 'otherwise shareable observation',
        ...privateMaterial,
      },
    }))).rejects.toMatchObject({
      code: 'coordination_private_material_rejected',
      stage: 'redact',
    });

    expect(calls).toEqual(['normalize']);
    expect(adapters.redact).not.toHaveBeenCalled();
    expect(adapters.persist).not.toHaveBeenCalled();
    expect(adapters.route).not.toHaveBeenCalled();
  });

  it('does not mistake provider session references, prompt summaries, or token counts for private material', async () => {
    const { adapters } = makeAdapters();
    const bus = createProjectCoordinationBus(adapters);

    await expect(bus.publish(rawObservation({
      observation: {
        summary: 'bounded project fact',
        providerSessionRef: 'provider-session-opaque-1',
        promptSummary: 'redacted coordination summary',
        tokenCount: 42,
        secretRef: 'vault-reference-only',
      },
    }))).resolves.toMatchObject({ event: { id: 'event-1' } });
  });

  it('fails closed when a later adapter reintroduces private material', async () => {
    const calls = [];
    const { adapters } = makeAdapters({
      classify: vi.fn(async (event) => {
        calls.push('classify');
        return { ...event, payload: { ...event.payload, rawPrompt: 'private again' } };
      }),
    });
    const bus = createProjectCoordinationBus(adapters);

    await expect(bus.publish(rawObservation())).rejects.toMatchObject({
      code: 'coordination_private_material_rejected',
      stage: 'classify',
    });
    expect(adapters.authorize).not.toHaveBeenCalled();
    expect(adapters.persist).not.toHaveBeenCalled();
    expect(adapters.route).not.toHaveBeenCalled();
  });

  it('does not persist or route an authorization denial', async () => {
    const calls = [];
    const { adapters } = makeAdapters({
      authorize: vi.fn(async () => {
        calls.push('authorize');
        return { allowed: false, reason: 'recipient_zone_not_visible' };
      }),
    });
    const bus = createProjectCoordinationBus(adapters);

    await expect(bus.publish(rawObservation())).rejects.toMatchObject({
      code: 'coordination_event_not_authorized',
      stage: 'authorize',
      status: 403,
      details: { reason: 'recipient_zone_not_visible' },
    });
    expect(adapters.persist).not.toHaveBeenCalled();
    expect(adapters.route).not.toHaveBeenCalled();
  });

  it.each(['codex', 'claude', 'copilot', 'custom', 'brand-new-provider']) (
    'applies the identical pipeline and policy to the %s provider',
    async (provider) => {
      const { adapters, calls } = makeAdapters();
      const bus = createProjectCoordinationBus(adapters);

      const result = await bus.publish(rawObservation({ provider }));

      expect(calls).toEqual(PROJECT_COORDINATION_PIPELINE);
      expect(result.event.source).toEqual({ kind: 'agent', provider });
      expect(result.authorization.recipients).toEqual(['agent-session-2']);
    },
  );

  it.each(['redact', 'classify', 'correlate', 'persist'])(
    'rejects a project identity change introduced during %s',
    async (stage) => {
      const { adapters } = makeAdapters({
        [stage]: vi.fn(async (event) => ({ ...event, projectId: 'different-project' })),
      });
      const bus = createProjectCoordinationBus(adapters);

      await expect(bus.publish(rawObservation())).rejects.toMatchObject({
        code: 'coordination_event_identity_changed',
        stage,
        details: { field: 'projectId' },
      });
      expect(adapters.route).not.toHaveBeenCalled();
    },
  );

  it('keeps the normalized event class stable through classification', async () => {
    const { adapters } = makeAdapters({
      classify: vi.fn(async (event) => ({ ...event, eventType: 'unrelated.changed' })),
    });
    const bus = createProjectCoordinationBus(adapters);

    await expect(bus.publish(rawObservation())).rejects.toMatchObject({
      code: 'coordination_event_identity_changed',
      stage: 'classify',
      details: { field: 'eventType' },
    });
    expect(adapters.authorize).not.toHaveBeenCalled();
    expect(adapters.persist).not.toHaveBeenCalled();
    expect(adapters.route).not.toHaveBeenCalled();
  });

  it('requires every pipeline adapter when the bus is created', () => {
    const { adapters } = makeAdapters();
    delete adapters.correlate;

    expect(() => createProjectCoordinationBus(adapters)).toThrowError(
      expect.objectContaining({
        code: 'coordination_adapter_required',
        stage: 'configure',
        details: { adapter: 'correlate' },
      }),
    );
  });

  it('wraps adapter failures with the exact failed stage and preserves the cause', async () => {
    const failure = new Error('storage unavailable');
    const { adapters } = makeAdapters({
      persist: vi.fn(async () => {
        throw failure;
      }),
    });
    const bus = createProjectCoordinationBus(adapters);

    const rejection = await bus.publish(rawObservation()).catch((error) => error);
    expect(rejection).toBeInstanceOf(ProjectCoordinationBusError);
    expect(rejection).toMatchObject({
      code: 'coordination_stage_failed',
      stage: 'persist',
      status: 500,
      cause: failure,
    });
    expect(adapters.route).not.toHaveBeenCalled();
  });
});
