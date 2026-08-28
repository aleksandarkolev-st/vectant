import { describe, expect, it } from 'vitest';
import {
  PROJECT_OBSERVATION_EVENT_TYPES,
  PROJECT_OBSERVATION_SCHEMA_VERSION,
  ProjectObservationValidationError,
  normalizeInspectionFailedObservation,
  normalizeProjectObservation,
  normalizeRuntimeObservedObservation,
  normalizeSourceChangedObservation,
  buildObservationCoordinationInput,
  observationEventType,
  observationFactPayload,
} from '../projectObservation.js';

const occurredAt = '2026-08-22T12:34:56.000Z';

describe('observation coordination bridge', () => {
  it('maps every observation type onto a whitelisted coordination event type', () => {
    expect(observationEventType('source_changed')).toBe('source_changed_observed');
    expect(observationEventType('runtime_observed')).toBe('runtime_observed');
    expect(observationEventType('inspection_failed')).toBe('inspection_failed');
    expect(observationEventType('discovery_recorded')).toBeNull();
    expect(observationEventType('')).toBeNull();
    expect(observationEventType(null)).toBeNull();
  });

  it('builds a coordination input carrying identity, references, fact, and evidence', () => {
    const observation = normalizeSourceChangedObservation(sourceInput());
    const input = buildObservationCoordinationInput(observation, { actorId: 'terminal-adapter-1' });
    expect(input.eventType).toBe('source_changed_observed');
    expect(input.actorType).toBe('adapter');
    expect(input.actorId).toBe('terminal-adapter-1');
    expect(input.mutationLeaseId).toBe('lease-1');
    expect(input.details.observationId).toBe(observation.id);
    expect(input.details.schemaVersion).toBe(PROJECT_OBSERVATION_SCHEMA_VERSION);
    expect(input.details.producer).toEqual({ kind: 'codesite_landing', eventId: 'transaction-1:proof-abc' });
    expect(input.details.references.paths).toContain('src/CharacterController.cpp');
    expect(input.details.fact.changeKind).toBe('landed');
    expect(input.details.fact.proofBundleDigest).toBe('sha256:proof-abc');
    expect(input.details.providerSessionBound).toBe(true);
    expect(input.evidenceRefs).toEqual(['artifact:proof-abc']);
  });

  it.each(['source_changed', 'runtime_observed', 'inspection_failed'])('extracts only declared fact keys for %s', (eventType) => {
    const builders = {
      source_changed: sourceInput,
      runtime_observed: runtimeInput,
      inspection_failed: inspectionInput,
    };
    const observation = builders[eventType] ? (
      eventType === 'source_changed' ? normalizeSourceChangedObservation(builders[eventType]())
        : eventType === 'runtime_observed' ? normalizeRuntimeObservedObservation(builders[eventType]())
          : normalizeInspectionFailedObservation(builders[eventType]())
    ) : null;
    const fact = observationFactPayload(observation);
    expect(fact).toBeTruthy();
    for (const [key, value] of Object.entries(fact)) {
      expect(value).toBeDefined();
      expect(JSON.stringify(value)).not.toContain('undefined');
    }
    expect(Object.keys(fact).sort()).toEqual(
      Object.keys(observation.payload.fact).sort(),
    );
  });

  it('returns null instead of throwing for malformed observations', () => {
    expect(buildObservationCoordinationInput(null)).toBeNull();
    expect(buildObservationCoordinationInput('nope')).toBeNull();
    expect(buildObservationCoordinationInput({ eventType: 'runtime_observed' })).toBeNull();
    expect(observationFactPayload(normalizeSourceChangedObservation(sourceInput()), 'runtime_observed')).toBeNull();
    expect(observationFactPayload({ eventType: 'source_changed' })).toBeNull();
  });

  it('keeps private material out of the coordination details via the real bus redaction boundary', async () => {
    const observation = normalizeRuntimeObservedObservation(runtimeInput());
    const input = buildObservationCoordinationInput(observation, { actorId: 'program-runtime' });
    const { createProjectCoordinationBus } = await import('../projectCoordinationBus.js');
    const bus = createProjectCoordinationBus({
      normalize: async (event) => event,
      redact: async (event) => event,
      classify: async (event) => event,
      correlate: async (event) => event,
      authorize: async () => ({ allowed: true, recipients: [] }),
      persist: async (event) => event,
      route: async (event) => ({ eventId: event.id, delivered: true }),
    });
    await expect(bus.publish({
      id: input.details.observationId,
      projectId: 'project-1',
      eventType: input.eventType,
      payload: { details: input.details, evidenceRefs: input.evidenceRefs },
    })).resolves.toMatchObject({ delivery: { delivered: true } });
    expect(JSON.stringify(input)).not.toMatch(/prompt|transcript|credential|token/i);
  });
});


function sourceInput(overrides = {}) {
  return {
    eventType: 'source_changed',
    projectId: 'project-1',
    producer: { kind: 'codesite_landing', eventId: 'transaction-1:proof-abc' },
    occurredAt,
    causalParentIds: ['event-commit-1'],
    refs: {
      transactionIds: ['transaction-1'],
      mutationLeaseIds: ['lease-1'],
      agentSessionIds: ['agent-session-1'],
      paths: ['src\\CharacterController.cpp', './src/CharacterController.cpp'],
      symbols: ['CharacterController::rotate'],
      contracts: ['rotation.completed@v2'],
      process: {
        pid: 400,
        parentPid: 200,
        ancestry: [
          { pid: 200, parentPid: 100, imageDigest: 'sha256:parent' },
          { pid: 100, parentPid: 1, imageDigest: 'sha256:root' },
        ],
      },
    },
    providerSessionBound: true,
    evidenceRefs: ['artifact:proof-abc'],
    fact: {
      changeKind: 'landed',
      proofBundleId: 'proof-1',
      proofBundleDigest: 'sha256:proof-abc',
      repoStateDigest: 'sha256:repo-abc',
      reasonCodes: ['serializable_commit_landed'],
    },
    ...overrides,
  };
}

function runtimeInput(overrides = {}) {
  return {
    eventType: 'runtime_observed',
    projectId: 'project-1',
    producer: { kind: 'program_runtime_adapter', eventId: 'program-event-42' },
    occurredAt,
    causalParentIds: ['event-source-1'],
    refs: {
      transactionIds: ['transaction-2'],
      runtimeSessionIds: ['runtime-session-7'],
      paths: ['src/runtime.ts'],
      symbols: ['Runtime::start'],
      contracts: ['runtime.health@v1'],
      process: {
        pid: 912,
        parentPid: 500,
        ancestry: [{ pid: 500, parentPid: 1, imageDigest: 'sha256:launcher' }],
      },
    },
    providerSessionBound: false,
    evidenceRefs: ['runtime-event:42'],
    fact: {
      observationKind: 'crashed',
      runtimeState: 'crashed',
      exitCode: 17,
      signal: 'SIGTERM',
      healthState: 'unhealthy',
      ports: [8080, 3000, 8080],
      reasonCodes: ['process_exit_nonzero'],
    },
    ...overrides,
  };
}

function inspectionInput(overrides = {}) {
  return {
    eventType: 'inspection_failed',
    projectId: 'project-1',
    producer: { kind: 'inspection_runner', eventId: 'inspection-run-9:failed' },
    occurredAt,
    causalParentIds: ['event-inspection-result-9'],
    refs: {
      transactionIds: ['transaction-2'],
      executionPlanIds: ['plan-2'],
      inspectionRunIds: ['inspection-run-9'],
      paths: ['src/runtime.ts', 'tests/runtime.test.ts'],
      symbols: ['Runtime::start'],
      contracts: ['runtime.health@v1'],
      runtimeSessionIds: ['runtime-session-7'],
    },
    evidenceRefs: ['artifact:test-digest'],
    fact: {
      inspectionKind: 'test',
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      failingSignalKeys: ['contract_test', 'unit_test'],
      reasonCodes: ['inspection_command_failed'],
    },
    ...overrides,
  };
}

describe('project observation vocabulary', () => {
  it('defines only the three Workstream D observation classes', () => {
    expect(PROJECT_OBSERVATION_EVENT_TYPES).toEqual([
      'source_changed',
      'runtime_observed',
      'inspection_failed',
    ]);
  });

  it('normalizes a landed source change into a bus-ready provider-neutral envelope', () => {
    const normalized = normalizeSourceChangedObservation(sourceInput());

    expect(normalized).toEqual({
      schemaVersion: PROJECT_OBSERVATION_SCHEMA_VERSION,
      id: expect.stringMatching(/^obs_[a-f0-9]{64}$/),
      projectId: 'project-1',
      eventType: 'source_changed',
      producer: { kind: 'codesite_landing', eventId: 'transaction-1:proof-abc' },
      occurredAt,
      causalParentIds: ['event-commit-1'],
      payload: {
        references: {
          transactionIds: ['transaction-1'],
          mutationLeaseIds: ['lease-1'],
          agentSessionIds: ['agent-session-1'],
          runtimeSessionIds: [],
          executionPlanIds: [],
          inspectionRunIds: [],
          paths: ['src/CharacterController.cpp'],
          symbols: ['CharacterController::rotate'],
          contracts: ['rotation.completed@v2'],
          process: {
            pid: 400,
            parentPid: 200,
            ancestry: [
              { pid: 200, parentPid: 100, imageDigest: 'sha256:parent' },
              { pid: 100, parentPid: 1, imageDigest: 'sha256:root' },
            ],
          },
        },
        providerSessionBound: true,
        evidenceRefs: ['artifact:proof-abc'],
        fact: {
          changeKind: 'landed',
          proofBundleId: 'proof-1',
          proofBundleDigest: 'sha256:proof-abc',
          repoStateDigest: 'sha256:repo-abc',
          reasonCodes: ['serializable_commit_landed'],
        },
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.payload.references)).toBe(true);
  });

  it('normalizes runtime state, process ancestry, paths, symbols, contracts, and numeric ports', () => {
    const normalized = normalizeRuntimeObservedObservation(runtimeInput());

    expect(normalized.eventType).toBe('runtime_observed');
    expect(normalized.payload.references).toMatchObject({
      transactionIds: ['transaction-2'],
      runtimeSessionIds: ['runtime-session-7'],
      paths: ['src/runtime.ts'],
      symbols: ['Runtime::start'],
      contracts: ['runtime.health@v1'],
      process: { pid: 912, parentPid: 500 },
    });
    expect(normalized.payload.fact).toEqual({
      observationKind: 'crashed',
      runtimeState: 'crashed',
      exitCode: 17,
      signal: 'SIGTERM',
      healthState: 'unhealthy',
      ports: [3000, 8080],
      reasonCodes: ['process_exit_nonzero'],
    });
    expect(normalized.payload.providerSessionBound).toBe(false);
  });

  it('normalizes inspection failure without accepting test output', () => {
    const normalized = normalizeInspectionFailedObservation(inspectionInput());

    expect(normalized.eventType).toBe('inspection_failed');
    expect(normalized.payload.references).toMatchObject({
      transactionIds: ['transaction-2'],
      executionPlanIds: ['plan-2'],
      inspectionRunIds: ['inspection-run-9'],
      runtimeSessionIds: ['runtime-session-7'],
    });
    expect(normalized.payload.fact).toEqual({
      inspectionKind: 'test',
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      failingSignalKeys: ['contract_test', 'unit_test'],
      reasonCodes: ['inspection_command_failed'],
    });
  });

  it('dispatches the generic normalizer by event type', () => {
    expect(normalizeProjectObservation(sourceInput()).eventType).toBe('source_changed');
    expect(normalizeProjectObservation(runtimeInput()).eventType).toBe('runtime_observed');
    expect(normalizeProjectObservation(inspectionInput()).eventType).toBe('inspection_failed');
  });

  it('derives a stable id from project, class, producer kind, and producer event id only', () => {
    const first = normalizeRuntimeObservedObservation(runtimeInput());
    const reordered = normalizeRuntimeObservedObservation(runtimeInput({
      causalParentIds: ['event-z', 'event-a'],
      evidenceRefs: ['runtime-event:changed'],
      fact: {
        observationKind: 'health_changed',
        runtimeState: 'unhealthy',
        healthState: 'unhealthy',
        reasonCodes: ['probe_failed'],
      },
    }));
    const otherProducerEvent = normalizeRuntimeObservedObservation(runtimeInput({
      producer: { kind: 'program_runtime_adapter', eventId: 'program-event-43' },
    }));

    expect(first.id).toBe(reordered.id);
    expect(otherProducerEvent.id).not.toBe(first.id);
  });

  it('canonicalizes ordering and timestamp representation deterministically', () => {
    const normalized = normalizeSourceChangedObservation(sourceInput({
      occurredAt: '2026-08-22T15:34:56+03:00',
      causalParentIds: ['z', 'a', 'z'],
      evidenceRefs: ['z:evidence', 'a:evidence'],
      refs: {
        paths: ['z/file.ts', 'a/file.ts'],
        symbols: ['Z::run', 'A::run'],
        contracts: ['z@v1', 'a@v1'],
        transactionIds: ['txn-z', 'txn-a', 'txn-z'],
      },
    }));

    expect(normalized.occurredAt).toBe(occurredAt);
    expect(normalized.causalParentIds).toEqual(['a', 'z']);
    expect(normalized.payload.evidenceRefs).toEqual(['a:evidence', 'z:evidence']);
    expect(normalized.payload.references).toMatchObject({
      transactionIds: ['txn-a', 'txn-z'],
      paths: ['a/file.ts', 'z/file.ts'],
      symbols: ['A::run', 'Z::run'],
      contracts: ['a@v1', 'z@v1'],
    });
  });

  it.each([
    ['raw', 'opaque bytes'],
    ['output', 'compiler text'],
    ['stdout', 'test output'],
    ['stderr', 'test error'],
    ['message', 'free form runtime message'],
    ['command', 'npm test'],
    ['env', { SAFE: 'value' }],
    ['prompt', 'private instructions'],
    ['transcript', 'terminal history'],
    ['token', 'opaque-token-value'],
    ['providerSessionRef', 'provider-session-private'],
  ])('rejects private field %s before schema normalization', (field, value) => {
    const input = runtimeInput();
    input.fact = { ...input.fact, nested: { [field]: value } };

    expect(() => normalizeRuntimeObservedObservation(input)).toThrowError(
      expect.objectContaining({
        code: 'project_observation_private_material_rejected',
        path: `$.fact.nested.${field}`,
      }),
    );
  });

  it.each([
    'Authorization: Bearer abcdefghijklmnop',
    'password=hunter2',
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz',
    'postgres://alice:private@db.example.test/app',
    '-----BEGIN PRIVATE KEY-----',
  ])('rejects secret-like string values anywhere in the input', (secret) => {
    const input = sourceInput();
    input.evidenceRefs = ['artifact:safe', secret];

    expect(() => normalizeSourceChangedObservation(input)).toThrowError(
      expect.objectContaining({ code: 'project_observation_private_material_rejected' }),
    );
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    const input = sourceInput({ vendor: 'specific-provider' });

    expect(() => normalizeSourceChangedObservation(input)).toThrowError(
      expect.objectContaining({
        code: 'project_observation_field_not_allowed',
        path: '$.vendor',
      }),
    );
  });

  it('rejects unknown nested fields', () => {
    const input = runtimeInput();
    input.refs = { ...input.refs, workspacePath: 'C:/private/workspace' };

    expect(() => normalizeRuntimeObservedObservation(input)).toThrowError(
      expect.objectContaining({
        code: 'project_observation_field_not_allowed',
        path: '$.refs.workspacePath',
      }),
    );
  });

  it('accepts only a boolean providerSessionBound signal', () => {
    expect(normalizeRuntimeObservedObservation(runtimeInput({ providerSessionBound: true })).payload.providerSessionBound).toBe(true);
    expect(normalizeRuntimeObservedObservation(runtimeInput({ providerSessionBound: undefined })).payload.providerSessionBound).toBe(false);
    expect(() => normalizeRuntimeObservedObservation(runtimeInput({ providerSessionBound: 'yes' }))).toThrowError(
      expect.objectContaining({ code: 'project_observation_boolean_required' }),
    );
  });

  it('rejects a provider session reference even when a bound boolean is also present', () => {
    const input = runtimeInput({ providerSessionBound: true });
    input.producer.providerSessionRef = 'private-provider-session';

    expect(() => normalizeRuntimeObservedObservation(input)).toThrowError(
      expect.objectContaining({ code: 'project_observation_private_material_rejected' }),
    );
  });

  it.each([
    [sourceInput({ refs: { transactionIds: ['transaction-1'] } }), 'project_observation_source_reference_required'],
    [runtimeInput({ refs: { transactionIds: ['transaction-1'] } }), 'project_observation_runtime_reference_required'],
    [inspectionInput({ refs: { transactionIds: ['transaction-1'] } }), 'project_observation_inspection_reference_required'],
  ])('requires class-specific correlation references', (input, code) => {
    expect(() => normalizeProjectObservation(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects non-failed inspection facts', () => {
    const input = inspectionInput();
    input.fact = { ...input.fact, status: 'passed' };

    expect(() => normalizeInspectionFailedObservation(input)).toThrowError(
      expect.objectContaining({
        code: 'project_observation_value_not_allowed',
        path: '$.fact.status',
      }),
    );
  });

  it('rejects mismatched specific normalizer event types', () => {
    expect(() => normalizeSourceChangedObservation(runtimeInput())).toThrowError(
      expect.objectContaining({ code: 'project_observation_event_type_mismatch' }),
    );
  });

  it('rejects absolute, traversal, and empty source paths', () => {
    for (const path of ['/etc/passwd', 'C:\\private\\file.ts', '../private/file.ts', '']) {
      const input = sourceInput();
      input.refs = { ...input.refs, paths: [path] };
      expect(() => normalizeSourceChangedObservation(input)).toThrow(ProjectObservationValidationError);
    }
  });

  it('rejects non-plain, cyclic, and non-finite input', () => {
    const cyclic = runtimeInput();
    cyclic.loop = cyclic;
    expect(() => normalizeRuntimeObservedObservation(cyclic)).toThrowError(
      expect.objectContaining({ code: 'project_observation_not_serializable' }),
    );

    const dated = runtimeInput({ fact: new Date() });
    expect(() => normalizeRuntimeObservedObservation(dated)).toThrowError(
      expect.objectContaining({ code: 'project_observation_not_serializable' }),
    );

    const infinite = runtimeInput();
    infinite.fact.exitCode = Number.POSITIVE_INFINITY;
    expect(() => normalizeRuntimeObservedObservation(infinite)).toThrowError(
      expect.objectContaining({ code: 'project_observation_not_serializable' }),
    );
  });
});
