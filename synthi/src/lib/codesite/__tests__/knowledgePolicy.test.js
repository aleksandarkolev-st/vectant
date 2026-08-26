import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_REFERENCE_LIMITS,
  allowedKnowledgeTransitions,
  knowledgeDedupeKey,
  normalizeKnowledgeReferences,
  safeKnowledgeProjection,
  transitionKnowledgeItem,
  validateKnowledgeItem,
  validateSharedSkillRecipe,
} from '../knowledgePolicy';

const SOURCE = Object.freeze({
  actorType: 'agent',
  actorId: 'user-alice',
  agentSessionId: 'agent-alice',
  terminalSessionId: 'terminal-alice',
});

function base(kind, overrides = {}) {
  return {
    kind,
    id: `${String(kind).replace('_', '-')}-1`,
    projectId: 'project-shared',
    title: `${kind} title`,
    summary: `${kind} summary`,
    source: { ...SOURCE },
    references: {
      paths: ['src/CharacterController.cpp'],
      symbols: ['CharacterController::Turn'],
      contracts: ['rotation.completed@v1'],
      runtimeSessionIds: ['preview-runtime-1'],
      agentSessionIds: ['agent-alice'],
      workstreamIds: ['workstream-producer'],
      transactionIds: ['txn-producer'],
    },
    evidenceRefs: ['source:sha256:abc123'],
    tags: ['rotation'],
    createdAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  };
}

function discovery(overrides = {}) {
  return base('discovery', { confidence: 0.92, status: 'verified', ...overrides });
}

function lead(overrides = {}) {
  return base('lead', { confidence: 0.58, status: 'open', priority: 'high', ...overrides });
}

function skill(overrides = {}) {
  return base('shared_skill', {
    status: 'published',
    skillKey: 'run-rotation-contract-tests',
    recipe: {
      commands: ['npm test -- rotation-contract'],
      requiredPermissions: [],
      requiredTools: ['npm'],
      requiredEnvironmentKeys: [],
      usageConditions: ['Run from a clean project checkout.'],
      workingDirectory: 'synthi',
      actionClass: 'read_only',
    },
    ...overrides,
  });
}

function impact(overrides = {}) {
  return base('impact_notice', {
    status: 'pending',
    sourceKnowledgeId: 'discovery-1',
    recipientAgentSessionIds: ['agent-ben'],
    requiresResponse: true,
    responseAction: 'Acknowledge or refresh the affected transaction.',
    ...overrides,
  });
}

function handoff(overrides = {}) {
  return base('handoff', {
    status: 'ready',
    fromAgentSessionId: 'agent-alice',
    toAgentSessionId: 'agent-ben',
    unresolvedRisks: ['Consumer still targets contract v1.'],
    requiredActions: ['Refresh against rotation.completed@v2.'],
    ...overrides,
  });
}

function question(overrides = {}) {
  return base('agent_question', {
    title: 'Who owns the door-state consumer path?',
    summary: 'Need to know whether DoorState::apply also clamps velocity before I change the input mapping.',
    status: 'open',
    urgency: 'normal',
    suggestedExpertAgentSessionIds: ['agent-alice'],
    ...overrides,
  });
}

function fixtureFor(kind, overrides = {}) {
  if (kind === 'discovery') return discovery(overrides);
  if (kind === 'lead') return lead(overrides);
  if (kind === 'shared_skill') return skill(overrides);
  if (kind === 'impact_notice') return impact(overrides);
  if (kind === 'agent_question') return question(overrides);
  return handoff(overrides);
}

function expectPolicyError(callback, code) {
  expect(callback).toThrow(expect.objectContaining({ code, status: 422 }));
}

describe('knowledge kind validation and safe normalization', () => {
  it('validates every Workstream C object kind with its required semantic fields', () => {
    expect(KNOWLEDGE_KINDS).toEqual([
      'discovery',
      'lead',
      'shared_skill',
      'impact_notice',
      'handoff',
      'agent_question',
    ]);

    expect(validateKnowledgeItem(discovery())).toMatchObject({
      kind: 'discovery',
      confidence: 0.92,
      verification: 'verified',
      references: { contracts: ['rotation.completed@v1'] },
    });
    expect(validateKnowledgeItem(lead())).toMatchObject({
      kind: 'lead',
      confidence: 0.58,
      priority: 'high',
    });
    expect(validateKnowledgeItem(skill())).toMatchObject({
      kind: 'shared_skill',
      skillKey: 'run-rotation-contract-tests',
      recipe: { actionClass: 'read_only', destructive: false, external: false },
    });
    expect(validateKnowledgeItem(impact())).toMatchObject({
      kind: 'impact_notice',
      sourceKnowledgeId: 'discovery-1',
      recipientAgentSessionIds: ['agent-ben'],
      requiresResponse: true,
    });
    expect(validateKnowledgeItem(handoff())).toMatchObject({
      kind: 'handoff',
      fromAgentSessionId: 'agent-alice',
      toAgentSessionId: 'agent-ben',
      unresolvedRisks: ['Consumer still targets contract v1.'],
    });
  });

  it.each([
    ['Discovery', 'discovery'],
    ['Shared Skill', 'shared_skill'],
    ['shared-skill', 'shared_skill'],
    ['ImpactNotice', 'impact_notice'],
    ['impact', 'impact_notice'],
    ['Handoff', 'handoff'],
  ])('normalizes the %s kind alias', (kind, expected) => {
    const seed = fixtureFor(expected);
    expect(validateKnowledgeItem({ ...seed, kind })).toMatchObject({ kind: expected });
  });

  it.each([
    [null, 'knowledge_item_invalid'],
    [[], 'knowledge_item_invalid'],
    [{}, 'knowledge_kind_invalid'],
    [{ ...discovery(), kind: 'chat_message' }, 'knowledge_kind_invalid'],
    [{ ...discovery(), projectId: '../other' }, 'knowledge_project_id_invalid'],
    [{ ...discovery(), title: ' ' }, 'knowledge_title_required'],
    [{ ...discovery(), summary: '' }, 'knowledge_summary_required'],
    [{ ...discovery(), source: null }, 'knowledge_source_required'],
    [{ ...discovery(), source: { actorType: 'provider', actorId: 'alice' } }, 'knowledge_source_actor_type_invalid'],
    [{ ...discovery(), visibility: 'public_internet' }, 'knowledge_visibility_invalid'],
    [{ ...discovery(), visibility: 'owner_private', redactionClass: 'project_fact' }, 'knowledge_private_visibility_redaction_mismatch'],
    [{ ...discovery(), references: {} }, 'knowledge_references_required'],
    [{ ...discovery(), evidenceRefs: [] }, 'knowledge_discovery_evidence_required'],
    [{ ...discovery(), verification: 'trusted_without_review' }, 'knowledge_discovery_verification_invalid'],
    [{ ...skill(), evidenceRefs: [] }, 'knowledge_skill_evidence_required'],
    [{ ...handoff(), evidenceRefs: [] }, 'knowledge_handoff_evidence_required'],
    [{ ...impact(), recipientAgentSessionIds: [] }, 'knowledge_impact_recipient_agent_session_ids_required'],
  ])('rejects malformed generic or kind-specific input with %s', (input, code) => {
    expectPolicyError(() => validateKnowledgeItem(input), code);
  });

  it('normalizes whitespace, duplicates, timestamps, aliases, and optional ownership', () => {
    const result = validateKnowledgeItem(lead({
      type: 'lead',
      kind: undefined,
      title: '  Rotation   lead  ',
      summary: '  Investigate the half-turn event.  ',
      owner_user_id: 'user-ben',
      owner_agent_session_id: 'agent-ben',
      pathRefs: ['src\\DoorState.cpp', 'src/DoorState.cpp'],
      symbolRefs: [' DoorState::OnRotation ', 'DoorState::OnRotation'],
      contractRefs: [' rotation.completed@v2 '],
      references: undefined,
      evidenceRefs: ['runtime:1', 'runtime:1'],
      updatedAt: '2026-08-22T12:00:00+02:00',
    }));

    expect(result).toMatchObject({
      kind: 'lead',
      title: 'Rotation lead',
      summary: 'Investigate the half-turn event.',
      ownerUserId: 'user-ben',
      ownerAgentSessionId: 'agent-ben',
      references: {
        paths: ['src/DoorState.cpp'],
        symbols: ['DoorState::OnRotation'],
        contracts: ['rotation.completed@v2'],
      },
      evidenceRefs: ['runtime:1'],
      updatedAt: '2026-08-22T10:00:00.000Z',
    });
  });

  it('does not mutate caller-owned input', () => {
    const input = discovery();
    const before = JSON.stringify(input);
    const result = validateKnowledgeItem(input);
    result.references.paths.push('src/Other.cpp');
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('bounded knowledge references', () => {
  it('normalizes all supported reference classes into a compact canonical shape', () => {
    expect(normalizeKnowledgeReferences({
      references: {
        paths: ['src\\DoorState.cpp'],
        symbols: ['DoorState::OnRotation'],
        contracts: ['rotation.completed@v2'],
        runtimeIds: ['runtime-preview'],
        sessionIds: ['agent-ben'],
        workstreams: ['consumer-work'],
        transactions: ['txn-consumer'],
      },
    })).toEqual({
      paths: ['src/DoorState.cpp'],
      symbols: ['DoorState::OnRotation'],
      contracts: ['rotation.completed@v2'],
      runtimeSessionIds: ['runtime-preview'],
      agentSessionIds: ['agent-ben'],
      workstreamIds: ['consumer-work'],
      transactionIds: ['txn-consumer'],
    });
  });

  it.each([
    ['../secrets.txt', 'knowledge_path_traversal_forbidden'],
    ['src/../secrets.txt', 'knowledge_path_traversal_forbidden'],
    ['./src/file.js', 'knowledge_path_traversal_forbidden'],
    ['src//file.js', 'knowledge_path_traversal_forbidden'],
    ['/etc/passwd', 'knowledge_path_absolute_forbidden'],
    ['C:\\Windows\\secret.txt', 'knowledge_path_absolute_forbidden'],
    ['\\\\server\\share\\secret.txt', 'knowledge_path_absolute_forbidden'],
    ['src/file\u0000.js', 'knowledge_path_references_nul_forbidden'],
  ])('denies unsafe path reference %j', (path, code) => {
    expectPolicyError(() => normalizeKnowledgeReferences({ references: { paths: [path] } }), code);
  });

  it.each([
    [{ references: { symbols: ['Turn\u0000Hidden'] } }, 'knowledge_symbol_references_nul_forbidden'],
    [{ references: { agentSessionIds: ['agent id'] } }, 'knowledge_reference_id_invalid'],
    [{ references: { contracts: ['x'.repeat(KNOWLEDGE_REFERENCE_LIMITS.semanticLength + 1)] } }, 'knowledge_contract_references_too_long'],
    [{ references: { paths: ['x'.repeat(KNOWLEDGE_REFERENCE_LIMITS.pathLength + 1)] } }, 'knowledge_path_references_too_long'],
  ])('denies malformed or overlong semantic and identity references', (input, code) => {
    expectPolicyError(() => normalizeKnowledgeReferences(input), code);
  });

  it('enforces per-reference-class and aggregate collection bounds', () => {
    const tooManyPaths = Array.from({ length: KNOWLEDGE_REFERENCE_LIMITS.perType + 1 }, (_, index) => `src/file-${index}.js`);
    expectPolicyError(
      () => normalizeKnowledgeReferences({ references: { paths: tooManyPaths } }),
      'knowledge_path_references_limit_exceeded',
    );

    const twentyFive = (prefix) => Array.from({ length: 25 }, (_, index) => `${prefix}-${index}`);
    expectPolicyError(() => normalizeKnowledgeReferences({
      references: {
        symbols: twentyFive('symbol'),
        contracts: twentyFive('contract'),
        runtimeSessionIds: twentyFive('runtime'),
        agentSessionIds: twentyFive('agent'),
      },
    }), 'knowledge_reference_total_limit_exceeded');
  });
});

describe('confidence, statuses, and transitions', () => {
  it.each([0, 0.25, 1, '0.75'])('accepts bounded confidence %j', (confidence) => {
    expect(validateKnowledgeItem(discovery({ confidence })).confidence).toBe(Number(confidence));
  });

  it.each([undefined, null, -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, 'not-a-number'])('rejects invalid discovery confidence %j', (confidence) => {
    const expected = confidence == null ? 'knowledge_confidence_required' : 'knowledge_confidence_invalid';
    expectPolicyError(() => validateKnowledgeItem(discovery({ confidence })), expected);
  });

  const statusMatrix = {
    discovery: ['draft', 'verified', 'rejected', 'invalidated', 'archived'],
    lead: ['open', 'claimed', 'escalated', 'resolved', 'dismissed', 'archived'],
    shared_skill: ['draft', 'pending_review', 'published', 'rejected', 'deprecated', 'revoked'],
    impact_notice: ['pending', 'acknowledged', 'rebasing', 'resolved', 'irrelevant', 'aborted', 'expired'],
    handoff: ['draft', 'ready', 'acknowledged', 'reopened', 'completed', 'declined', 'cancelled', 'expired'],
  };

  for (const [kind, statuses] of Object.entries(statusMatrix)) {
    it(`accepts every declared ${kind} status and rejects undeclared states`, () => {
      for (const status of statuses) {
        expect(validateKnowledgeItem(fixtureFor(kind, { status })).status).toBe(status);
      }
      expectPolicyError(
        () => validateKnowledgeItem(fixtureFor(kind, { status: 'silently_done' })),
        'knowledge_status_invalid',
      );
    });
  }

  it.each([
    ['discovery', 'draft', 'verified'],
    ['lead', 'open', 'claimed'],
    ['shared_skill', 'pending_review', 'published'],
    ['impact_notice', 'pending', 'acknowledged'],
    ['impact_notice', 'acknowledged', 'rebasing'],
    ['impact_notice', 'rebasing', 'resolved'],
    ['handoff', 'ready', 'acknowledged'],
    ['handoff', 'acknowledged', 'completed'],
  ])('allows the %s %s -> %s transition with attributable evidence', (kind, from, to) => {
    const result = transitionKnowledgeItem(fixtureFor(kind, { status: from }), to, {
      actorId: 'user-reviewer',
      reason: 'Reviewed against current project evidence.',
      evidenceRefs: ['review:sha256:def456'],
      at: '2026-08-22T11:00:00.000Z',
    });
    expect(result).toMatchObject({
      status: to,
      updatedAt: '2026-08-22T11:00:00.000Z',
      transition: {
        from,
        to,
        actorId: 'user-reviewer',
        reason: 'Reviewed against current project evidence.',
        evidenceRefs: ['review:sha256:def456'],
      },
    });
  });

  it.each([
    ['discovery', 'archived', 'verified'],
    ['lead', 'resolved', 'open'],
    ['shared_skill', 'revoked', 'published'],
    ['impact_notice', 'resolved', 'rebasing'],
    ['handoff', 'completed', 'ready'],
  ])('denies the %s %s -> %s transition', (kind, from, to) => {
    expectPolicyError(() => transitionKnowledgeItem(fixtureFor(kind, { status: from }), to, {
      actorId: 'user-reviewer',
      reason: 'Attempt invalid transition.',
    }), 'knowledge_status_transition_forbidden');
  });

  it('requires an actor and reason for a state change but makes same-state validation idempotent', () => {
    expectPolicyError(
      () => transitionKnowledgeItem(impact(), 'acknowledged', { reason: 'Seen.' }),
      'knowledge_transition_actor_id_required',
    );
    expectPolicyError(
      () => transitionKnowledgeItem(impact(), 'acknowledged', { actorId: 'user-ben' }),
      'knowledge_transition_reason_required',
    );
    expect(transitionKnowledgeItem(impact(), 'pending')).toMatchObject({ status: 'pending' });
  });

  it('returns a defensive copy of allowed transitions', () => {
    const transitions = allowedKnowledgeTransitions('impact_notice', 'pending');
    expect(transitions).toEqual(['acknowledged', 'irrelevant', 'expired']);
    transitions.push('resolved');
    expect(allowedKnowledgeTransitions('impact_notice', 'pending')).not.toContain('resolved');
  });
});

describe('safe knowledge projections and dedupe keys', () => {
  it.each([
    ['providerPrompt', 'do not share'],
    ['terminalTranscript', 'private shell history'],
    ['credential', 'password'],
    ['apiToken', 'secret-token'],
    ['cookies', ['session=secret']],
    ['privateKey', 'pem'],
    ['providerSessionRef', 'provider-private'],
    ['environmentValues', { API_KEY: 'secret' }],
  ])('rejects private material in field %s before projection', (field, value) => {
    expectPolicyError(
      () => safeKnowledgeProjection({ ...discovery(), metadata: { [field]: value } }),
      'knowledge_private_material_forbidden',
    );
  });

  it('rejects cyclic input instead of recursing or accidentally exposing it', () => {
    const input = discovery();
    input.metadata = {};
    input.metadata.self = input;
    expectPolicyError(() => safeKnowledgeProjection(input), 'knowledge_cyclic_input_forbidden');
  });

  it('projects only the kind-specific public contract and omits unrelated metadata', () => {
    const projection = safeKnowledgeProjection({
      ...impact(),
      harmlessInternalCache: { deliveryAttempts: 4 },
    });
    expect(projection).toMatchObject({
      kind: 'impact_notice',
      sourceKnowledgeId: 'discovery-1',
      recipientAgentSessionIds: ['agent-ben'],
      references: { paths: ['src/CharacterController.cpp'] },
    });
    expect(projection).not.toHaveProperty('harmlessInternalCache');
    expect(JSON.stringify(projection)).not.toMatch(/prompt|transcript|credential|providerSessionRef/i);
  });

  it('creates deterministic order-independent dedupe keys without embedding source content', () => {
    const first = discovery({
      references: {
        paths: ['src/B.cpp', 'src/A.cpp'],
        contracts: ['rotation.completed@v2', 'rotation.completed@v1'],
      },
    });
    const second = discovery({
      references: {
        contracts: ['rotation.completed@v1', 'rotation.completed@v2'],
        paths: ['src/A.cpp', 'src/B.cpp'],
      },
      source: { ...SOURCE, actorId: 'user-other', agentSessionId: 'agent-other' },
      evidenceRefs: ['different:evidence'],
    });
    const firstKey = knowledgeDedupeKey(first);
    const secondKey = knowledgeDedupeKey(second);
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^knowledge:discovery:[a-f0-9]{64}$/);
    expect(firstKey).not.toContain('CharacterController');
  });

  it('changes dedupe identity for a materially different contract, recipient, skill command, or handoff target', () => {
    expect(knowledgeDedupeKey(discovery())).not.toBe(knowledgeDedupeKey(discovery({
      references: { contracts: ['rotation.completed@v2'] },
    })));
    expect(knowledgeDedupeKey(impact())).not.toBe(knowledgeDedupeKey(impact({
      recipientAgentSessionIds: ['agent-priya'],
    })));
    expect(knowledgeDedupeKey(skill())).not.toBe(knowledgeDedupeKey(skill({
      recipe: { ...skill().recipe, commands: ['npm test -- all-contracts'] },
    })));
    expect(knowledgeDedupeKey(handoff())).not.toBe(knowledgeDedupeKey(handoff({
      toAgentSessionId: 'agent-priya',
    })));
  });

  it('treats skill command order as material while keeping reference order immaterial', () => {
    const first = skill({
      recipe: { ...skill().recipe, commands: ['npm run build', 'npm test'] },
    });
    const reordered = skill({
      recipe: { ...skill().recipe, commands: ['npm test', 'npm run build'] },
    });
    expect(knowledgeDedupeKey(first)).not.toBe(knowledgeDedupeKey(reordered));
  });
});

describe('shared skill recipe publication policy', () => {
  const safeRecipe = {
    commands: ['npm test -- rotation-contract --token "$API_TOKEN"'],
    requiredPermissions: [],
    requiredTools: ['npm'],
    requiredEnvironmentKeys: ['API_TOKEN'],
    usageConditions: ['Use the project test environment.'],
    workingDirectory: 'synthi',
    actionClass: 'read_only',
  };

  it('allows references to declared environment keys without publishing their values', () => {
    const result = validateSharedSkillRecipe(safeRecipe);
    expect(result).toMatchObject({
      requiredEnvironmentKeys: ['API_TOKEN'],
      destructive: false,
      external: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });

  it.each([
    [{ ...safeRecipe, env: { API_TOKEN: 'secret' } }],
    [{ ...safeRecipe, environment: { API_TOKEN: 'secret' } }],
    [{ ...safeRecipe, commands: ['API_TOKEN=secret npm test'] }],
    [{ ...safeRecipe, commands: ['export API_TOKEN=secret; npm test'] }],
    [{ ...safeRecipe, commands: ['$env:API_TOKEN = "secret"; npm test'] }],
    [{ ...safeRecipe, commands: ['npm test -- --token=secret'] }],
    [{ ...safeRecipe, commands: ['curl -H "Authorization: Bearer-secret" https://example.test'] }],
    [{ ...safeRecipe, commands: ['curl https://user:password@example.test'] }],
    [{ ...safeRecipe, commands: ['printenv'] }],
    [{ ...safeRecipe, commands: ['Get-ChildItem Env:'] }],
    [{ ...safeRecipe, commands: ['cat .env'] }],
  ])('forbids recipe environment values and environment dumps', (recipe) => {
    const expected = Object.prototype.hasOwnProperty.call(recipe, 'env') || Object.prototype.hasOwnProperty.call(recipe, 'environment')
      ? 'knowledge_private_material_forbidden'
      : 'knowledge_skill_recipe_env_values_forbidden';
    expectPolicyError(() => validateSharedSkillRecipe(recipe), expected);
  });

  it.each([
    'rm -rf build',
    'Remove-Item -Recurse build',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'DROP TABLE users',
    'terraform destroy -auto-approve',
    'kubectl delete namespace production',
    'docker system prune -af',
  ])('gates destructive command %j on explicit attributable human approval', (command) => {
    const recipe = { ...safeRecipe, commands: [command] };
    expectPolicyError(
      () => validateSharedSkillRecipe(recipe),
      'knowledge_skill_destructive_action_requires_human_approval',
    );
    expectPolicyError(
      () => validateSharedSkillRecipe(recipe, {
        approvals: { humanApproved: true, destructiveActions: true },
      }),
      'knowledge_skill_human_approval_identity_required',
    );
    expect(validateSharedSkillRecipe(recipe, {
      approvals: {
        humanApproved: true,
        destructiveActions: true,
        externalActions: command.startsWith('kubectl'),
        approvedByUserId: 'user-admin',
      },
    })).toMatchObject({ destructive: true, approvals: { approvedByUserId: 'user-admin' } });
  });

  it.each([
    'curl https://example.test/hook',
    'Invoke-RestMethod https://example.test/hook',
    'git push origin main',
    'npm publish',
    'docker push registry.example.test/app:v1',
    'gh pr create --title release',
    'aws s3 cp artifact.zip s3://release-bucket/',
    'kubectl apply -f deployment.yaml',
    'ssh deploy@example.test restart-service',
  ])('gates external action %j on explicit attributable human approval', (command) => {
    const recipe = { ...safeRecipe, commands: [command] };
    expectPolicyError(
      () => validateSharedSkillRecipe(recipe),
      'knowledge_skill_external_action_requires_human_approval',
    );
    expect(validateSharedSkillRecipe(recipe, {
      approvals: {
        humanApproved: true,
        externalActions: true,
        approvedByUserId: 'user-admin',
      },
    })).toMatchObject({ external: true, approvals: { approvedByUserId: 'user-admin' } });
  });

  it('requires both approval classes when one command is destructive and external', () => {
    const recipe = { ...safeRecipe, commands: ['kubectl delete namespace preview'] };
    expectPolicyError(() => validateSharedSkillRecipe(recipe, {
      approvals: {
        humanApproved: true,
        destructiveActions: true,
        approvedByUserId: 'user-admin',
      },
    }), 'knowledge_skill_external_action_requires_human_approval');
    expect(validateSharedSkillRecipe(recipe, {
      approvals: {
        humanApproved: true,
        destructiveActions: true,
        externalActions: true,
        approvedByUserId: 'user-admin',
      },
    })).toMatchObject({ destructive: true, external: true });
  });

  it.each([
    [{ commands: ['npm test'], usageConditions: ['Use a checkout.'] }, 'knowledge_skill_required_permissions_unknown'],
    [{ ...safeRecipe, commands: [] }, 'knowledge_skill_commands_required'],
    [{ ...safeRecipe, usageConditions: [] }, 'knowledge_skill_usage_conditions_required'],
    [{ ...safeRecipe, requiredEnvironmentKeys: ['lowercase-key'] }, 'knowledge_skill_environment_key_invalid'],
    [{ ...safeRecipe, workingDirectory: '../outside' }, 'knowledge_path_traversal_forbidden'],
    [{ ...safeRecipe, actionClass: 'unreviewed_remote' }, 'knowledge_skill_action_class_invalid'],
    [{ ...safeRecipe, commands: Array.from({ length: 33 }, (_, index) => `npm test -- case-${index}`) }, 'knowledge_skill_commands_limit_exceeded'],
  ])('rejects incomplete or unbounded recipe metadata with %s', (recipe, code) => {
    expectPolicyError(() => validateSharedSkillRecipe(recipe), code);
  });

  it('requires source references, evidence, permissions, and usage conditions before publishing a skill', () => {
    expectPolicyError(() => validateKnowledgeItem(skill({ references: {} })), 'knowledge_references_required');
    expectPolicyError(() => validateKnowledgeItem(skill({ evidenceRefs: [] })), 'knowledge_skill_evidence_required');
    expectPolicyError(() => validateKnowledgeItem(skill({
      recipe: { ...safeRecipe, requiredPermissions: undefined },
    })), 'knowledge_skill_required_permissions_unknown');
    expectPolicyError(() => validateKnowledgeItem(skill({
      recipe: { ...safeRecipe, usageConditions: [] },
    })), 'knowledge_skill_usage_conditions_required');
  });
});

describe('agent_question knowledge kind', () => {
  it('normalizes a routed question with urgency and suggested experts', () => {
    const normalized = validateKnowledgeItem(question());
    expect(normalized).toMatchObject({
      kind: 'agent_question',
      status: 'open',
      questionUrgency: 'normal',
      suggestedExpertAgentSessionIds: ['agent-alice'],
    });
  });

  it('rejects unrouted broadcast questions unless explicitly allowed', () => {
    // Stored rows are resynced through artifact projection, which must bypass
    // this creation-time routing rule; newly-created questions still cannot.
    expectPolicyError(
      () => validateKnowledgeItem(question({ suggestedExpertAgentSessionIds: [] })),
      'knowledge_question_experts_or_unrouted_required',
    );
    expect(validateKnowledgeItem(question({
      suggestedExpertAgentSessionIds: [],
      allowUnrouted: true,
    })).suggestedExpertAgentSessionIds).toEqual([]);
  });

  it('accepts the documented snake_case unrouted flag', () => {
    expect(validateKnowledgeItem(question({
      suggestedExpertAgentSessionIds: [],
      allow_unrouted: true,
    })).suggestedExpertAgentSessionIds).toEqual([]);
  });

  it('rejects invalid urgency and oversized suggestion lists', () => {
    expectPolicyError(() => validateKnowledgeItem(question({ urgency: 'yesterday' })), 'knowledge_question_urgency_invalid');
    expectPolicyError(
      () => validateKnowledgeItem(question({
        suggestedExpertAgentSessionIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      })),
      'knowledge_question_suggested_expert_agent_session_ids_limit_exceeded',
    );
  });

  it('dedupes identical re-asks by asker and references', () => {
    const first = knowledgeDedupeKey(question());
    const second = knowledgeDedupeKey(question());
    const otherAsker = knowledgeDedupeKey(question({
      source: { ...SOURCE, agentSessionId: 'agent-someone-else' },
    }));
    expect(first).toBe(second);
    expect(first).not.toBe(otherAsker);
  });

  it('projects an answered question without exposing response routing metadata', () => {
    const projection = validateKnowledgeItem(question({
      status: 'answered',
      answerText: 'Yes, clamped at maxTurnRate.',
      answeredByAgentSessionId: 'agent-alice',
    }));
    expect(projection.answerText).toBe('Yes, clamped at maxTurnRate.');
    expect(safeKnowledgeProjection(projection).answerText).toBe('Yes, clamped at maxTurnRate.');
  });
});
