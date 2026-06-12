'use client';

import { getAgentWorkflowState } from './agentWorkflowClient';

export function createEmptyDojoSummary(workspaceSlug = '') {
  return {
    workspaceSlug,
    status: 'empty',
    selectedSkill: null,
    skills: [],
    metrics: {
      skillCount: 0,
      licensedCount: 0,
      guardrailCount: 0,
      scenarioCount: 0,
      artifactCount: 0,
    },
    governance: {
      metrics: {
        skillCount: 0,
        activeLicenseCount: 0,
        expiredLicenseCount: 0,
        pendingApprovalCount: 0,
        caseLawReviewCount: 0,
      },
      licenseHealth: [],
      approvalQueue: [],
      caseLawReviewQueue: [],
    },
    practice: {
      scenarios: [],
      latestRun: null,
      organoid: {
        syntheticOnly: false,
        fixtureSeed: '',
        tissueNames: [],
        dataPolicy: {},
      },
      windTunnel: {
        runCount: 0,
        passCount: 0,
        failCount: 0,
        blockedCount: 0,
        stopReason: '',
        budget: {},
        runs: [],
      },
      coverage: {
        score: 0,
        criticalFailures: 0,
        blockedScenarios: 0,
      },
    },
    bridgeStatus: 'unknown',
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function compactStrings(values) {
  return asArray(values)
    .map((value) => {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object') {
        return String(value.label || value.title || value.name || value.id || value.caseId || value.case_id || '').trim();
      }
      return String(value || '').trim();
    })
    .filter(Boolean);
}

function normalizePublishedTools(dojo) {
  const explicitTools = asArray(dojo.publishedTools || dojo.published_tools || dojo.toolRegistrations || dojo.tool_registrations)
    .map((tool) => {
      if (typeof tool === 'string') {
        return { name: tool, version: '', status: 'published' };
      }
      return {
        name: tool?.name || tool?.toolName || tool?.tool_name || '',
        version: tool?.version || tool?.toolVersion || tool?.tool_version || '',
        status: tool?.status || 'published',
      };
    })
    .filter((tool) => tool.name);
  const publishedToolName = dojo.publishedToolName || dojo.published_tool_name || '';
  if (explicitTools.length || !publishedToolName) return explicitTools;
  return [{ name: publishedToolName, version: '', status: dojo.published ? 'published' : 'draft' }];
}

function normalizeProofRequirements(dojo, license) {
  const explicit = compactStrings(
    dojo.proofRequirements
      || dojo.proof_requirements
      || license?.proofRequirements
      || license?.proof_requirements
      || license?.requiredProofClaims
      || license?.required_proof_claims
      || license?.requiredEvidenceClaims
      || license?.required_evidence_claims,
  );
  if (explicit.length) return explicit;
  return Boolean(dojo.proofRequired ?? dojo.proof_required) ? ['Valid proof capsule'] : [];
}

function normalizeTimeline(dojo) {
  return asArray(dojo.entrustmentTimeline || dojo.entrustment_timeline || dojo.lifecycle?.entrustmentHistory || dojo.lifecycle?.entrustment_history)
    .map((entry) => {
      if (typeof entry === 'string') return { label: entry, at: '', level: '' };
      return {
        label: entry?.label || entry?.event || entry?.status || entry?.level || '',
        at: entry?.at || entry?.createdAt || entry?.created_at || entry?.timestamp || '',
        level: entry?.level || entry?.entrustmentLevel || entry?.entrustment_level || '',
      };
    })
    .filter((entry) => entry.label || entry.level);
}

function normalizeGraphNode(node) {
  const guardrailRefs = compactStrings(
    node.guardrail_refs || node.guardrailRefs || node.guardrails?.map?.((guardrail) => guardrail.guardrail_id || guardrail.id || guardrail),
  );
  const assertions = asArray(node.assertions).map((assertion) => {
    if (typeof assertion === 'string') return assertion;
    return assertion?.description || assertion?.assertion_id || assertion?.id || '';
  }).filter(Boolean);
  return {
    id: node.node_id || node.nodeId || node.id || '',
    kind: node.kind || 'Action',
    label: node.label || node.action || node.node_id || 'Graph node',
    risk: node.risk || (node.kind === 'Action' ? 'mutation' : 'safe'),
    substrate: node.substrate || node.substrate_options?.[0] || node.substrateOptions?.[0] || '',
    action: node.action || node.metadata?.action_kind || '',
    inputs: compactStrings(node.inputs),
    outputs: compactStrings(node.outputs),
    guardrailRefs,
    caseRefs: compactStrings(node.case_refs || node.caseRefs || node.case_law_refs || node.caseLawRefs),
    proofRequired: Boolean(node.proof?.required || node.kind === 'Proof'),
    proofClaims: compactStrings(node.proof?.required_claims || node.proof?.requiredClaims || node.metadata?.evidence_claims),
    assertions,
    evidencePolicy: compactStrings(node.evidence_policy || node.evidencePolicy),
    expiryTriggers: compactStrings(node.expiry_triggers || node.expiryTriggers),
    memory: node.memory || {},
    metadata: node.metadata || {},
  };
}

function normalizeGraphEdge(edge) {
  return {
    id: edge.edge_id || edge.edgeId || edge.id || `${edge.from_node_id || edge.from}-${edge.to_node_id || edge.to}`,
    from: edge.from_node_id || edge.fromNodeId || edge.from || '',
    to: edge.to_node_id || edge.toNodeId || edge.to || '',
    condition: edge.condition || '',
    confidence: Number(edge.confidence ?? 1),
    observedVariants: compactStrings(edge.observed_variants || edge.observedVariants || edge.learned_from || edge.learnedFrom),
  };
}

function fallbackGraphForSkill(skill) {
  const actionLabel = skill.allowedActions?.[0] || skill.gatedActions?.[0] || 'Licensed action';
  const nodes = [
    { id: 'trigger', kind: 'Trigger', label: 'MCP skill call', risk: 'safe', inputs: [], outputs: ['permission'], guardrailRefs: [], caseRefs: [], proofRequired: false, proofClaims: [], assertions: [], evidencePolicy: [], expiryTriggers: [], memory: {}, metadata: {} },
    { id: 'permission', kind: 'Permission', label: skill.entrustmentLevel || 'Permission check', risk: 'safe', inputs: ['trigger'], outputs: ['proof'], guardrailRefs: skill.blockedActions || [], caseRefs: skill.caseLawRefs || [], proofRequired: false, proofClaims: [], assertions: [], evidencePolicy: [], expiryTriggers: [], memory: {}, metadata: { license_status: skill.licenseStatus } },
    { id: 'proof', kind: 'Proof', label: 'Validate proof capsule', risk: 'safe', inputs: ['permission'], outputs: ['action'], guardrailRefs: [], caseRefs: [], proofRequired: skill.proofRequired, proofClaims: skill.proofRequirements || [], assertions: [], evidencePolicy: [], expiryTriggers: [], memory: {}, metadata: {} },
    { id: 'action', kind: 'Action', label: actionLabel, risk: 'mutation', inputs: ['proof'], outputs: ['assertion'], guardrailRefs: skill.blockedActions || [], caseRefs: skill.caseLawRefs || [], proofRequired: skill.proofRequired, proofClaims: skill.proofRequirements || [], assertions: ['Postcondition required'], evidencePolicy: [], expiryTriggers: [], memory: {}, metadata: { substrate: skill.publishedToolName || 'dojo_dispatcher' } },
    { id: 'assertion', kind: 'Assertion', label: 'Verify postcondition', risk: 'safe', inputs: ['action'], outputs: ['expiry'], guardrailRefs: [], caseRefs: [], proofRequired: false, proofClaims: [], assertions: ['Observed result matches expected state'], evidencePolicy: [], expiryTriggers: [], memory: {}, metadata: {} },
    { id: 'expiry', kind: 'Expiry', label: 'Recertification check', risk: 'safe', inputs: ['assertion'], outputs: [], guardrailRefs: [], caseRefs: [], proofRequired: false, proofClaims: [], assertions: [], evidencePolicy: [], expiryTriggers: compactStrings(skill.expiryPolicy), memory: {}, metadata: { expires_at: skill.licenseExpiresAt } },
  ];
  return {
    graphId: `fallback_${skill.skillId}`,
    schemaVersion: 'synthi.dojo.skillGraph.fallback.v1',
    skillId: skill.skillId,
    version: '',
    mode: skill.licenseStatus === 'licensed' ? 'production' : 'practice',
    nodes,
    edges: [
      { id: 'trigger-permission', from: 'trigger', to: 'permission', condition: 'call_received', confidence: 1, observedVariants: [] },
      { id: 'permission-proof', from: 'permission', to: 'proof', condition: 'license_allowed', confidence: 1, observedVariants: [] },
      { id: 'proof-action', from: 'proof', to: 'action', condition: 'proof_valid', confidence: 1, observedVariants: [] },
      { id: 'action-assertion', from: 'action', to: 'assertion', condition: 'postcondition_required', confidence: 1, observedVariants: [] },
      { id: 'assertion-expiry', from: 'assertion', to: 'expiry', condition: 'run_complete', confidence: 1, observedVariants: [] },
    ],
    validation: { ok: false, issues: [{ issue_id: 'graph_report_missing', severity: 'warning', message: 'No backend graph report was present; displaying a derived shell.' }] },
    derived: true,
  };
}

function normalizeSkillGraph(dojo, skill) {
  const rawGraph = dojo.skillCortex || dojo.skill_cortex || dojo.skillGraph || dojo.skill_graph || dojo.graph || dojo.cortex;
  if (!rawGraph || !Array.isArray(rawGraph.nodes)) return fallbackGraphForSkill(skill);
  const nodes = rawGraph.nodes.map(normalizeGraphNode).filter((node) => node.id);
  const edges = asArray(rawGraph.edges).map(normalizeGraphEdge).filter((edge) => edge.from && edge.to);
  return {
    graphId: rawGraph.graph_id || rawGraph.workflow_graph_id || rawGraph.graphId || '',
    schemaVersion: rawGraph.schema_version || rawGraph.schemaVersion || '',
    skillId: rawGraph.skill_id || rawGraph.skillId || skill.skillId,
    version: rawGraph.graph_version || rawGraph.graphVersion || rawGraph.skill_version || rawGraph.skillVersion || '',
    mode: rawGraph.mode || (skill.licenseStatus === 'licensed' ? 'production' : 'practice'),
    nodes,
    edges,
    validation: rawGraph.validation || { ok: true, issues: [] },
    entryNodeId: rawGraph.entry_node_id || rawGraph.entryNodeId || nodes[0]?.id || '',
    exitNodeIds: compactStrings(rawGraph.exit_node_ids || rawGraph.exitNodeIds),
    derived: false,
  };
}

function normalizeEvidenceClaims(values) {
  return asArray(values)
    .map((claim) => {
      if (typeof claim === 'string') return { claim, status: 'unknown', satisfied: false, evidenceRecordIds: [] };
      return {
        claim: claim?.claim || claim?.claim_id || claim?.id || '',
        status: claim?.status || (claim?.satisfied ? 'satisfied' : 'unsatisfied'),
        satisfied: Boolean(claim?.satisfied ?? claim?.ok),
        evidenceRecordIds: compactStrings(claim?.evidence_record_ids || claim?.evidenceRecordIds || claim?.record_ids || claim?.recordIds),
      };
    })
    .filter((claim) => claim.claim);
}

function normalizeProofCapsule(dojo) {
  const proof = dojo.proof || dojo.proofCapsule || dojo.proof_capsule || {};
  const validation = proof.validation || dojo.proofValidation || dojo.proof_validation || {};
  const dryRun = dojo.proofDryRun || dojo.proof_dry_run || {};
  const capsuleId = proof.capsuleId || proof.capsule_id || proof.id || '';
  if (!capsuleId && !validation.status && !dryRun.status) return null;
  const evidenceClaims = normalizeEvidenceClaims(proof.evidence_claims || proof.evidenceClaims || validation.evidence_claim_results || validation.evidenceClaimResults);
  const timeline = asArray(proof.validationTimeline || proof.validation_timeline || validation.timeline || validation.events)
    .map((event) => {
      if (typeof event === 'string') return { label: event, status: '', at: '' };
      return {
        label: event?.label || event?.event || event?.step || event?.status || '',
        status: event?.status || '',
        at: event?.at || event?.createdAt || event?.created_at || event?.timestamp || '',
      };
    })
    .filter((event) => event.label || event.status);
  if (dryRun.status) {
    timeline.push({ label: dryRun.dryRun || dryRun.dry_run ? 'Dry-run validation' : 'Proof run', status: dryRun.status, at: dryRun.at || '' });
  }
  return {
    capsuleId,
    status: proof.status || validation.status || dryRun.status || 'issued',
    requestedAction: proof.requestedAction || proof.requested_action || validation.requested_action || '',
    issuer: proof.issuer || '',
    keyId: proof.keyId || proof.key_id || '',
    nonce: proof.nonce || '',
    issuedAt: proof.issuedAt || proof.issued_at || '',
    expiresAt: proof.expiresAt || proof.expires_at || '',
    signatureAlgorithm: proof.signatureAlgorithm || proof.signature_algorithm || '',
    substrate: proof.substrateClaim || proof.substrate_claim || '',
    replayState: proof.replayState || proof.replay_state || proof.status || '',
    revocationReason: proof.revocationReason || proof.revocation_reason || '',
    blockedBy: compactStrings(validation.blocked_by || validation.blockedBy),
    errorCodes: compactStrings(validation.error_codes || validation.errorCodes),
    evidenceClaims,
    evidenceRecordIds: compactStrings(proof.evidence_record_ids || proof.evidenceRecordIds),
    guardrailsActive: compactStrings(proof.guardrails_active || proof.guardrailsActive),
    validationTimeline: timeline,
  };
}

function normalizeCaseLawRefs(values) {
  return asArray(values)
    .map((item) => {
      if (typeof item === 'string') return { id: item, title: item, status: '' };
      return {
        id: item?.case_id || item?.caseId || item?.id || item?.title || '',
        title: item?.title || item?.finding || item?.case_id || item?.caseId || '',
        status: item?.status || '',
      };
    })
    .filter((item) => item.id || item.title);
}

function normalizeRefusal(dojo, skill) {
  const block = dojo.blockExplanation || dojo.block_explanation || {};
  const validation = block.validation || {};
  const upgrade = dojo.permissionUpgrade || dojo.permission_upgrade || {};
  const refusalText = block.refusal || block.message || validation.refusal || '';
  const blockedBy = compactStrings(block.blocked_by || block.blockedBy || validation.blocked_by || validation.blockedBy);
  const errorCodes = compactStrings(block.error_codes || block.errorCodes || validation.error_codes || validation.errorCodes);
  const caseLawRefs = normalizeCaseLawRefs(block.relevant_case_law || block.relevantCaseLaw || block.caseLawRefs || block.case_law_refs)
    .concat(normalizeCaseLawRefs(skill.caseLawRefs));
  if (!refusalText && !blockedBy.length && !errorCodes.length && !caseLawRefs.length) return null;
  return {
    status: block.status || validation.status || 'blocked',
    requestedAction: block.requestedAction || block.requested_action || validation.requested_action || '',
    refusal: refusalText,
    blockedBy,
    errorCodes,
    caseLawRefs,
    requiredSteps: compactStrings(upgrade.requiredSteps || upgrade.required_steps),
    nextStep: block.nextStep || block.next_step || '',
  };
}

function normalizeLicenseHealthItem(item, fallbackSkill) {
  return {
    skillId: item.skill_id || item.skillId || fallbackSkill?.skillId || '',
    skillName: item.skill_name || item.skillName || fallbackSkill?.title || '',
    workspaceId: item.workspace_id || item.workspaceId || '',
    licenseId: item.license_id || item.licenseId || fallbackSkill?.licenseId || '',
    licenseVersion: item.license_version || item.licenseVersion || '',
    status: item.status || fallbackSkill?.licenseStatus || 'draft',
    entrustmentLevel: item.entrustment_level || item.entrustmentLevel || fallbackSkill?.entrustmentLevel || 'E0',
    readinessLevel: Number(item.readiness_level ?? item.readinessLevel ?? fallbackSkill?.readinessLevel ?? 0),
    autonomyLevel: item.autonomy_level || item.autonomyLevel || '',
    expiresAt: item.expires_at || item.expiresAt || fallbackSkill?.licenseExpiresAt || '',
    daysUntilExpiry: item.days_until_expiry ?? item.daysUntilExpiry ?? fallbackSkill?.daysUntilExpiry ?? null,
    proofRequired: Boolean(item.proof_required ?? item.proofRequired ?? fallbackSkill?.proofRequired),
    allowedActionCount: Number(item.allowed_action_count ?? item.allowedActionCount ?? fallbackSkill?.allowedActions?.length ?? 0),
    gatedActionCount: Number(item.gated_action_count ?? item.gatedActionCount ?? fallbackSkill?.gatedActions?.length ?? 0),
    blockedActionCount: Number(item.blocked_action_count ?? item.blockedActionCount ?? fallbackSkill?.blockedActions?.length ?? 0),
    recertificationTriggers: compactStrings(item.recertification_triggers || item.recertificationTriggers),
  };
}

function normalizeApprovalItem(item) {
  return {
    queueId: item.queue_id || item.queueId || `${item.skill_id || item.skillId || 'skill'}:${item.action || 'approval'}`,
    skillId: item.skill_id || item.skillId || '',
    workspaceId: item.workspace_id || item.workspaceId || '',
    licenseId: item.license_id || item.licenseId || '',
    action: item.action || '',
    constraints: compactStrings(item.constraints),
    reason: item.reason || '',
    status: item.status || 'pending',
    source: item.source || 'license_gated_action',
  };
}

function normalizeCaseLawReviewItem(item) {
  return {
    caseId: item.case_id || item.caseId || item.id || '',
    title: item.title || '',
    skillId: item.skill_id || item.skillId || '',
    workspaceId: item.workspace_id || item.workspaceId || '',
    finding: item.finding || '',
    impact: item.impact || '',
    ruleCreated: item.rule_created || item.ruleCreated || '',
    status: item.status || 'proposed',
    evidenceRefs: compactStrings(item.evidence_refs || item.evidenceRefs),
    bindingScope: item.binding_scope || item.bindingScope || '',
    createdAt: item.created_at || item.createdAt || '',
  };
}

function normalizeGovernanceState(state, skill, workspaceSlug) {
  const raw = state.governanceService || state.governance_service || state.governance || {};
  const rawMetrics = raw.metrics || {};
  const approvalQueue = asArray(raw.approval_queue || raw.approvalQueue).map(normalizeApprovalItem).filter((item) => item.action || item.queueId);
  const caseLawReviewQueue = asArray(raw.case_law_review_queue || raw.caseLawReviewQueue)
    .map(normalizeCaseLawReviewItem)
    .filter((item) => item.caseId || item.title);
  const licenseHealth = asArray(raw.license_health || raw.licenseHealth)
    .map((item) => normalizeLicenseHealthItem(item, skill))
    .filter((item) => item.skillId || item.licenseId);
  const fallbackLicenseHealth = licenseHealth.length || !skill
    ? licenseHealth
    : [normalizeLicenseHealthItem({
      skill_id: skill.skillId,
      skill_name: skill.title,
      workspace_id: workspaceSlug,
      license_id: skill.licenseId,
      status: skill.licenseStatus,
      entrustment_level: skill.entrustmentLevel,
      readiness_level: skill.readinessLevel,
      expires_at: skill.licenseExpiresAt,
      days_until_expiry: skill.daysUntilExpiry,
      proof_required: skill.proofRequired,
    }, skill)];
  return {
    metrics: {
      skillCount: Number(rawMetrics.skill_count ?? rawMetrics.skillCount ?? state.metrics?.skillCount ?? (skill ? 1 : 0)),
      activeLicenseCount: Number(rawMetrics.active_license_count ?? rawMetrics.activeLicenseCount ?? fallbackLicenseHealth.filter((item) => ['active', 'expiring', 'licensed'].includes(item.status)).length),
      expiredLicenseCount: Number(rawMetrics.expired_license_count ?? rawMetrics.expiredLicenseCount ?? fallbackLicenseHealth.filter((item) => ['expired', 'revoked'].includes(item.status)).length),
      pendingApprovalCount: Number(rawMetrics.pending_approval_count ?? rawMetrics.pendingApprovalCount ?? raw.approvalCount ?? approvalQueue.length),
      caseLawReviewCount: Number(rawMetrics.case_law_review_count ?? rawMetrics.caseLawReviewCount ?? caseLawReviewQueue.length),
    },
    licenseHealth: fallbackLicenseHealth,
    approvalQueue,
    caseLawReviewQueue,
  };
}

function normalizeScenarioItem(item, index = 0) {
  const id = item?.scenario_id || item?.scenarioId || item?.id || `scenario-${index + 1}`;
  return {
    id,
    title: item?.title || item?.name || id,
    layer: item?.layer || item?.kind || '',
    simulatorTier: item?.simulator_tier || item?.simulatorTier || item?.tier || '',
    mutationKind: item?.mutation_kind || item?.mutationKind || '',
    expectedBehavior: item?.expected_behavior || item?.expectedBehavior || item?.oracle?.expected_behavior || '',
    riskTags: compactStrings(item?.risk_tags || item?.riskTags),
    generatedFrom: item?.generated_from || item?.generatedFrom || '',
    status: item?.status || item?.result?.status || 'queued',
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs),
  };
}

function normalizeScenarioRunItem(item, index = 0) {
  const runId = item?.run_id || item?.runId || item?.id || `run-${index + 1}`;
  return {
    runId,
    scenarioId: item?.scenario_id || item?.scenarioId || '',
    mutationKind: item?.mutation_kind || item?.mutationKind || '',
    mode: item?.mode || '',
    simulatorTier: item?.simulator_tier || item?.simulatorTier || item?.tier || '',
    substrate: item?.substrate || '',
    status: item?.status || item?.oracle_result?.status || item?.oracleResult?.status || 'unknown',
    expectationMet: Boolean(item?.expectation_met ?? item?.expectationMet),
    finding: item?.finding || item?.oracle_result?.finding || item?.oracleResult?.finding || '',
    guardrailsTriggered: compactStrings(item?.guardrails_triggered || item?.guardrailsTriggered),
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs || item?.observed_evidence || item?.observedEvidence),
    startedAt: item?.started_at || item?.startedAt || '',
    completedAt: item?.completed_at || item?.completedAt || item?.finished_at || item?.finishedAt || '',
    fixtureHash: item?.fixture_materialization_hash || item?.fixtureMaterializationHash || '',
    cost: item?.cost || {},
  };
}

function normalizeOrganoidState(dojo) {
  const raw = dojo.workspaceOrganoid || dojo.workspace_organoid || dojo.organoid || dojo.vivarium || {};
  const dataPolicy = raw.data_policy || raw.dataPolicy || {};
  const tissues = raw.tissues || {};
  return {
    syntheticOnly: Boolean(dataPolicy.synthetic_data_only ?? dataPolicy.syntheticDataOnly ?? raw.synthetic_data_only ?? raw.syntheticDataOnly),
    fixtureSeed: raw.fixture_seed || raw.fixtureSeed || raw.reset_profile?.seed || raw.resetProfile?.seed || '',
    tissueNames: Object.keys(tissues).filter(Boolean),
    dataPolicy,
  };
}

function normalizeWindTunnelState(dojo) {
  const raw = dojo.windTunnel || dojo.wind_tunnel || {};
  const summary = raw.summary || {};
  const runs = asArray(raw.runs || raw.scenario_runs || raw.scenarioRuns)
    .map(normalizeScenarioRunItem)
    .filter((run) => run.runId || run.scenarioId);
  const passCount = Number(raw.passCount ?? raw.pass_count ?? summary.passed ?? runs.filter((run) => run.status === 'passed').length);
  const failCount = Number(raw.failCount ?? raw.fail_count ?? summary.failed ?? runs.filter((run) => run.status === 'failed').length);
  const blockedCount = Number(raw.blockedCount ?? raw.blocked_count ?? summary.blocked ?? runs.filter((run) => run.status === 'blocked').length);
  return {
    runCount: Number(raw.runCount ?? raw.run_count ?? summary.run_count ?? runs.length),
    passCount,
    failCount,
    blockedCount,
    stopReason: raw.stopReason || raw.stop_reason || summary.stop_reason || '',
    budget: raw.budget || summary.budget || {},
    runs,
  };
}

function normalizePracticeState(state, dojo, skill) {
  const rawScenarios = asArray(
    dojo.scenarios
      || dojo.vivarium?.scenarios
      || dojo.workspaceOrganoid?.scenarios
      || dojo.workspace_organoid?.scenarios
      || dojo.organoid?.scenarios,
  );
  const scenarios = rawScenarios.map(normalizeScenarioItem).filter((scenario) => scenario.id);
  const latestRunRaw = dojo.vivariumRun
    || dojo.vivarium_run
    || dojo.scenarioRun
    || dojo.scenario_run
    || dojo.latestScenarioRun
    || dojo.latest_scenario_run
    || null;
  const latestRun = latestRunRaw ? normalizeScenarioRunItem(latestRunRaw) : null;
  const windTunnel = normalizeWindTunnelState(dojo);
  const checkride = dojo.checkride || {};
  return {
    scenarios,
    latestRun,
    organoid: normalizeOrganoidState(dojo),
    windTunnel,
    coverage: {
      score: Number(checkride.coverageScore ?? checkride.coverage_score ?? skill?.coverageScore ?? state.metrics?.coverage ?? 0),
      criticalFailures: Number(checkride.criticalFailures ?? checkride.critical_failures ?? 0),
      blockedScenarios: Number(checkride.blockedScenarios ?? checkride.blocked_scenarios ?? 0),
    },
  };
}

export function normalizeDojoWorkspaceSummary(input = {}, workspaceSlug = '') {
  const state = input?.state || input || {};
  const dojo = state.dojo || state.skillCredential || state.skill_credential || {};
  const license = dojo.license || {};
  const empty = createEmptyDojoSummary(workspaceSlug);
  if (!dojo.skillId && !dojo.skill_id) {
    return {
      ...empty,
      governance: normalizeGovernanceState(state, null, workspaceSlug),
      practice: normalizePracticeState(state, dojo, null),
      bridgeStatus: state.runtime?.status || state.status || 'ready',
    };
  }

  const skill = {
    skillId: dojo.skillId || dojo.skill_id,
    title: dojo.skillCard?.title || dojo.label || dojo.name || 'Dojo skill',
    status: dojo.status || (dojo.published ? 'licensed' : 'draft'),
    entrustmentLevel: dojo.entrustmentLevel || dojo.entrustment_level || 'E0',
    readinessLevel: dojo.readinessLevel ?? dojo.readiness_level ?? 0,
    coverageScore: Number(dojo.checkride?.coverageScore ?? dojo.checkride?.coverage_score ?? 0),
    scenarioCount: Number(dojo.scenarioCount ?? dojo.scenario_count ?? 0),
    guardrailCount: Array.isArray(dojo.guardrails) ? dojo.guardrails.length : Number(dojo.guardrailCount ?? 0),
    artifactCount: Number(dojo.artifactCount ?? dojo.artifact_count ?? 0),
    proofRequired: Boolean(dojo.proofRequired ?? dojo.proof_required),
    publishedToolName: dojo.publishedToolName || dojo.published_tool_name || '',
    licenseStatus: dojo.lifecycle?.status || dojo.licenseHealth?.status || dojo.status || 'draft',
    licenseId: dojo.licenseId || dojo.license_id || license.licenseId || license.license_id || '',
    licenseExpiresAt: dojo.licenseExpiresAt || dojo.license_expires_at || dojo.lifecycle?.expiresAt || dojo.lifecycle?.expires_at || license.expiresAt || license.expires_at || '',
    daysUntilExpiry: dojo.lifecycle?.daysUntilExpiry ?? dojo.lifecycle?.days_until_expiry ?? license.daysUntilExpiry ?? license.days_until_expiry ?? null,
    expiryPolicy: dojo.lifecycle?.expiryPolicy || dojo.lifecycle?.expiry_policy || license.expiryPolicy || license.expiry_policy || '',
    allowedActions: compactStrings(dojo.skillCard?.canDoAlone || license.allowedActions || license.allowed_actions),
    gatedActions: compactStrings(dojo.skillCard?.willAskBefore || license.gatedActions || license.gated_actions),
    blockedActions: compactStrings(dojo.skillCard?.willNotDo || license.blockedActions || license.blocked_actions),
    blockedContexts: compactStrings(dojo.blockedContexts || dojo.blocked_contexts || license.blockedContexts || license.blocked_contexts),
    caseLawRefs: compactStrings(dojo.caseLawRefs || dojo.case_law_refs || dojo.caseLaw || dojo.case_law),
    proofRequirements: normalizeProofRequirements(dojo, license),
    publishedTools: normalizePublishedTools(dojo),
    entrustmentTimeline: normalizeTimeline(dojo),
  };
  skill.graph = normalizeSkillGraph(dojo, skill);
  skill.proofCapsule = normalizeProofCapsule(dojo);
  skill.refusal = normalizeRefusal(dojo, skill);
  skill.practice = normalizePracticeState(state, dojo, skill);

  return {
    ...empty,
    status: skill.status,
    selectedSkill: skill,
    skills: [skill],
    metrics: {
      skillCount: 1,
      licensedCount: skill.status === 'licensed' || dojo.published ? 1 : 0,
      guardrailCount: skill.guardrailCount,
      scenarioCount: skill.scenarioCount,
      artifactCount: skill.artifactCount,
    },
    governance: normalizeGovernanceState(state, skill, workspaceSlug),
    practice: skill.practice,
    bridgeStatus: state.runtime?.status || state.status || 'ready',
  };
}

export async function getDojoWorkspaceSummary({ workspaceSlug = '', signal, url, token } = {}) {
  const state = await getAgentWorkflowState({ signal, url, token });
  return normalizeDojoWorkspaceSummary(state, workspaceSlug);
}
