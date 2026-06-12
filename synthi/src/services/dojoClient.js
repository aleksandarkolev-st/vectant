'use client';

import { callAgentWorkflowTool, getAgentWorkflowState } from './agentWorkflowClient';
import { getCurrentUser } from './userIdentity';

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
      skillRegistry: [],
      policyGates: [],
      recertificationQueue: [],
      auditExports: [],
      complianceEvidencePack: {
        packId: '',
        generatedAt: '',
        artifacts: [],
        missingArtifacts: [],
        retentionClass: '',
      },
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
    debug: {
      timeMachine: null,
      ghostRun: null,
    },
    source: {
      uiContract: {
        contractId: '',
        targetOrigin: '',
        actions: [],
        refusalContracts: [],
      },
      sourcePrPlan: {
        planId: '',
        readiness: 'not_ready',
        patchCount: 0,
        files: [],
        generatedTests: [],
        reviewChecklist: [],
      },
      apiCandidates: [],
      generatedTools: [],
      substrateNodes: [],
      metrics: {
        uiActionCount: 0,
        sourceMappedActionCount: 0,
        patchCount: 0,
        reviewRequiredPatchCount: 0,
        apiCandidateCount: 0,
        approvedApiCandidateCount: 0,
        generatedToolCount: 0,
      },
    },
    evidence: {
      ledger: {
        ledgerId: '',
        headHash: '',
        records: [],
        storageModel: {},
        retentionPolicy: {},
      },
      redactedExport: {
        manifestId: '',
        artifacts: [],
        excluded: [],
        redactionCount: 0,
      },
      claims: [],
      metrics: {
        recordCount: 0,
        redactedCount: 0,
        metadataOnlyCount: 0,
        claimCount: 0,
        exportArtifactCount: 0,
      },
    },
    caseLaw: {
      records: [],
      guardrails: [],
      antibodies: [],
      metrics: {
        recordCount: 0,
        bindingCount: 0,
        proposedCount: 0,
        deprecatedCount: 0,
        guardrailCount: 0,
        antibodyCount: 0,
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
        rule: item?.rule_created || item?.ruleCreated || '',
        evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs),
      };
    })
    .filter((item) => item.id || item.title);
}

function normalizeRefusal(dojo, skill) {
  const block = dojo.blockExplanation || dojo.block_explanation || {};
  const validation = block.validation || {};
  const structured = block.refusal_explanation || block.refusalExplanation || validation.refusal_explanation || validation.refusalExplanation || {};
  const upgrade = dojo.permissionUpgrade || dojo.permission_upgrade || {};
  const refusalText = block.refusal || block.message || validation.refusal || '';
  const blockedBy = compactStrings(structured.blocked_by || structured.blockedBy || block.blocked_by || block.blockedBy || validation.blocked_by || validation.blockedBy);
  const errorCodes = compactStrings(block.error_codes || block.errorCodes || validation.error_codes || validation.errorCodes);
  const caseLawRefs = normalizeCaseLawRefs(structured.case_law_citations || structured.caseLawCitations)
    .concat(normalizeCaseLawRefs(block.relevant_case_law || block.relevantCaseLaw || block.caseLawRefs || block.case_law_refs))
    .concat(normalizeCaseLawRefs(skill.caseLawRefs));
  const nextStep = structured.smallest_allowed_next_step || structured.smallestAllowedNextStep || block.nextStep || block.next_step || '';
  const rule = structured.rule || block.rule || '';
  const evidenceRefs = compactStrings(structured.evidence_refs || structured.evidenceRefs);
  if (!refusalText && !blockedBy.length && !errorCodes.length && !caseLawRefs.length && !rule && !nextStep) return null;
  return {
    status: block.status || validation.status || 'blocked',
    requestedAction: structured.blocked_action || structured.blockedAction || block.requestedAction || block.requested_action || validation.requested_action || '',
    refusal: refusalText,
    rule,
    blockedBy,
    errorCodes,
    caseLawRefs: dedupeCaseLawRefs(caseLawRefs),
    evidenceRefs,
    requiredSteps: compactStrings(upgrade.requiredSteps || upgrade.required_steps),
    nextStep,
  };
}

function dedupeCaseLawRefs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.id}:${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    requestId: item.request_id || item.requestId || '',
    skillId: item.skill_id || item.skillId || '',
    workspaceId: item.workspace_id || item.workspaceId || '',
    licenseId: item.license_id || item.licenseId || '',
    action: item.action || '',
    constraints: compactStrings(item.constraints),
    reason: item.reason || '',
    status: item.status || 'pending',
    source: item.source || 'license_gated_action',
    requestedAt: item.requested_at || item.requestedAt || '',
    evidenceRefs: compactStrings(item.evidence_refs || item.evidenceRefs),
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

function normalizeSkillRegistryItem(item, fallbackSkill) {
  return {
    skillId: item.skill_id || item.skillId || fallbackSkill?.skillId || '',
    title: item.title || item.skill_name || item.skillName || item.name || fallbackSkill?.title || '',
    workspaceId: item.workspace_id || item.workspaceId || '',
    status: item.status || fallbackSkill?.status || 'draft',
    licenseStatus: item.license_status || item.licenseStatus || fallbackSkill?.licenseStatus || '',
    entrustmentLevel: item.entrustment_level || item.entrustmentLevel || fallbackSkill?.entrustmentLevel || 'E0',
    readinessLevel: Number(item.readiness_level ?? item.readinessLevel ?? fallbackSkill?.readinessLevel ?? 0),
    owner: item.owner || item.owner_id || item.ownerId || '',
    publishedToolName: item.published_tool_name || item.publishedToolName || fallbackSkill?.publishedToolName || '',
    updatedAt: item.updated_at || item.updatedAt || item.last_trained_at || item.lastTrainedAt || '',
  };
}

function normalizePolicyGateItem(item, index = 0) {
  return {
    gateId: item.gate_id || item.gateId || item.id || `policy-gate-${index + 1}`,
    name: item.name || item.title || item.rule || `Policy gate ${index + 1}`,
    status: item.status || item.result || 'unknown',
    severity: item.severity || item.risk || '',
    owner: item.owner || item.owner_id || item.ownerId || '',
    scope: item.scope || item.binding_scope || item.bindingScope || '',
    blocks: compactStrings(item.blocks || item.blocked_actions || item.blockedActions),
    evidenceRefs: compactStrings(item.evidence_refs || item.evidenceRefs),
    nextStep: item.next_step || item.nextStep || '',
  };
}

function normalizeRecertificationItem(item, index = 0) {
  return {
    queueId: item.queue_id || item.queueId || item.id || `recertification-${index + 1}`,
    skillId: item.skill_id || item.skillId || '',
    skillName: item.skill_name || item.skillName || item.title || '',
    reason: item.reason || item.trigger || '',
    dueAt: item.due_at || item.dueAt || item.expires_at || item.expiresAt || '',
    status: item.status || 'queued',
    priority: item.priority || item.severity || '',
    evidenceRefs: compactStrings(item.evidence_refs || item.evidenceRefs),
  };
}

function normalizeAuditExportItem(item, index = 0) {
  return {
    exportId: item.export_id || item.exportId || item.id || `audit-export-${index + 1}`,
    title: item.title || item.name || item.kind || `Audit export ${index + 1}`,
    status: item.status || 'available',
    generatedAt: item.generated_at || item.generatedAt || item.created_at || item.createdAt || '',
    format: item.format || item.content_type || item.contentType || '',
    recordCount: Number(item.record_count ?? item.recordCount ?? 0),
    digest: item.digest || item.sha256 || item.artifact_sha256 || item.artifactSha256 || '',
  };
}

function normalizeComplianceEvidencePack(raw) {
  const source = raw || {};
  return {
    packId: source.pack_id || source.packId || source.export_id || source.exportId || '',
    generatedAt: source.generated_at || source.generatedAt || source.created_at || source.createdAt || '',
    artifacts: asArray(source.artifacts || source.required_artifacts || source.requiredArtifacts)
      .map((artifact, index) => {
        if (typeof artifact === 'string') return { artifactId: artifact, title: artifact, status: 'available' };
        return {
          artifactId: artifact.artifact_id || artifact.artifactId || artifact.id || `compliance-artifact-${index + 1}`,
          title: artifact.title || artifact.name || artifact.kind || artifact.path || `Compliance artifact ${index + 1}`,
          status: artifact.status || 'available',
          digest: artifact.digest || artifact.sha256 || artifact.artifact_sha256 || artifact.artifactSha256 || '',
          evidenceRefs: compactStrings(artifact.evidence_refs || artifact.evidenceRefs),
        };
      })
      .filter((artifact) => artifact.artifactId || artifact.title),
    missingArtifacts: compactStrings(source.missing_artifacts || source.missingArtifacts),
    retentionClass: source.retention_class || source.retentionClass || '',
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
  const skillRegistry = asArray(raw.skill_registry || raw.skillRegistry || raw.registry?.skills || raw.skills)
    .map((item) => normalizeSkillRegistryItem(item, skill))
    .filter((item) => item.skillId || item.title);
  const policyGates = asArray(raw.policy_gates || raw.policyGates || raw.policy_gate_table || raw.policyGateTable)
    .map(normalizePolicyGateItem)
    .filter((item) => item.gateId || item.name);
  const recertificationQueue = asArray(raw.recertification_queue || raw.recertificationQueue || raw.recertifications)
    .map(normalizeRecertificationItem)
    .filter((item) => item.queueId || item.skillId);
  const auditExports = asArray(raw.audit_exports || raw.auditExports || raw.audit_export_panel || raw.auditExportPanel)
    .map(normalizeAuditExportItem)
    .filter((item) => item.exportId || item.title);
  const complianceEvidencePack = normalizeComplianceEvidencePack(raw.compliance_evidence_pack || raw.complianceEvidencePack || raw.compliance_export || raw.complianceExport);
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
      policyGateCount: Number(rawMetrics.policy_gate_count ?? rawMetrics.policyGateCount ?? policyGates.length),
      recertificationCount: Number(rawMetrics.recertification_count ?? rawMetrics.recertificationCount ?? recertificationQueue.length),
      complianceArtifactCount: Number(rawMetrics.compliance_artifact_count ?? rawMetrics.complianceArtifactCount ?? complianceEvidencePack.artifacts.length),
    },
    licenseHealth: fallbackLicenseHealth,
    approvalQueue,
    caseLawReviewQueue,
    skillRegistry: skillRegistry.length || !skill ? skillRegistry : [normalizeSkillRegistryItem({}, skill)],
    policyGates,
    recertificationQueue,
    auditExports,
    complianceEvidencePack,
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

function normalizeTimeMachineReport(dojo) {
  const raw = dojo.timeMachineDebugger || dojo.time_machine_debugger || dojo.timeMachine || dojo.time_machine || {};
  if (!raw.debug_id && !raw.debugId && !raw.question && !raw.counterfactual && !raw.baseline) return null;
  const baseline = raw.baseline || {};
  const counterfactual = raw.counterfactual || {};
  return {
    schemaVersion: raw.schema_version || raw.schemaVersion || '',
    debugId: raw.debug_id || raw.debugId || '',
    question: raw.question || '',
    baseline: {
      scenarioId: baseline.scenario_id || baseline.scenarioId || '',
      mutationKind: baseline.mutation_kind || baseline.mutationKind || '',
      status: baseline.status || 'not_recorded',
      finding: baseline.finding || '',
    },
    counterfactual: {
      changedVariable: counterfactual.changed_variable || counterfactual.changedVariable || '',
      expectedStatusAfterChange: counterfactual.expected_status_after_change || counterfactual.expectedStatusAfterChange || '',
      causalFinding: counterfactual.causal_finding || counterfactual.causalFinding || '',
      licenseImpact: counterfactual.license_impact || counterfactual.licenseImpact || '',
    },
    guardrails: asArray(raw.guardrails).map((guardrail) => ({
      id: guardrail?.guardrail_id || guardrail?.guardrailId || guardrail?.id || guardrail?.title || '',
      title: guardrail?.title || guardrail?.label || guardrail?.id || '',
      rule: guardrail?.rule || guardrail?.predicate || '',
      severity: guardrail?.severity || '',
    })).filter((guardrail) => guardrail.id || guardrail.title || guardrail.rule),
    replayPlan: asArray(raw.replay_plan || raw.replayPlan).map((step) => ({
      step: step?.step || step?.label || '',
      simulatorTier: step?.simulator_tier ?? step?.simulatorTier ?? '',
      expectedEvidence: compactStrings(step?.expected_evidence || step?.expectedEvidence),
    })).filter((step) => step.step),
  };
}

function actionLabel(action) {
  if (!action || typeof action !== 'object') return '';
  return String(action.label || action.name || action.selector || action.text || action.action || action.kind || '').trim();
}

function normalizeGhostRun(dojo) {
  const raw = dojo.ghostRun || dojo.ghost_run || dojo.ghostMode?.ghost_run || dojo.ghost_mode?.ghost_run || dojo.ghostMode || dojo.ghost_mode || {};
  if (!raw.run_id && !raw.runId && !raw.status && !raw.observed_human_action && !raw.agent_planned_action) return null;
  const observedAction = raw.observed_human_action || raw.observedHumanAction || {};
  const plannedAction = raw.agent_planned_action || raw.agentPlannedAction || {};
  return {
    runId: raw.run_id || raw.runId || '',
    status: raw.status || 'not_recorded',
    wouldExecute: Boolean(raw.would_execute ?? raw.wouldExecute),
    productionMutationsExecuted: Boolean(raw.production_mutations_executed ?? raw.productionMutationsExecuted),
    licenseStatus: raw.license_status || raw.licenseStatus || '',
    shadowEvidenceId: raw.shadow_evidence_id || raw.shadowEvidenceId || raw.shadow_evidence?.evidence_id || raw.shadowEvidence?.evidenceId || '',
    evidenceRefs: compactStrings(raw.evidence_refs || raw.evidenceRefs || raw.shadow_evidence?.evidence_refs || raw.shadowEvidence?.evidenceRefs),
    explanation: raw.explanation || '',
    entrustmentImpact: normalizeGhostEntrustmentImpact(raw.entrustment_impact || raw.entrustmentImpact || raw.shadow_evidence?.entrustment_impact || raw.shadowEvidence?.entrustmentImpact),
    observedAction,
    plannedAction,
    observedLabel: actionLabel(observedAction),
    plannedLabel: actionLabel(plannedAction),
    guardrailsTriggered: compactStrings(raw.guardrails_triggered || raw.guardrailsTriggered),
  };
}

function normalizeGhostEntrustmentImpact(raw = {}) {
  return {
    upgradeAllowed: Boolean(raw.upgrade_allowed ?? raw.upgradeAllowed),
    recommendedEntrustment: raw.recommended_entrustment || raw.recommendedEntrustment || '',
    reason: raw.reason || '',
  };
}

function normalizeDebugState(dojo) {
  return {
    timeMachine: normalizeTimeMachineReport(dojo),
    ghostRun: normalizeGhostRun(dojo),
  };
}

function normalizeUiContractAction(action, index = 0) {
  return {
    actionId: action?.action_id || action?.actionId || action?.id || `ui-action-${index + 1}`,
    label: action?.label || action?.name || action?.action || `Action ${index + 1}`,
    sourceStepId: action?.source_step_id || action?.sourceStepId || '',
    sourceAnchorId: action?.source_anchor_id || action?.sourceAnchorId || '',
    stableLocator: action?.stable_locator || action?.stableLocator || '',
    fallbackLocators: compactStrings(action?.fallback_locators || action?.fallbackLocators),
    requiredInputs: compactStrings(action?.required_inputs || action?.requiredInputs),
    allowedSubstrates: compactStrings(action?.allowed_substrates || action?.allowedSubstrates),
    successCondition: action?.success_condition || action?.successCondition || '',
    riskTags: compactStrings(action?.risk_tags || action?.riskTags),
    proofClaims: compactStrings(action?.proof_claims || action?.proofClaims),
  };
}

function normalizeUiContract(dojo, state = {}) {
  const source = dojo.source || dojo.source_state || state.source || state.source_state || {};
  const raw = dojo.agentReadyUiContract
    || dojo.agent_ready_ui_contract
    || dojo.uiContract
    || dojo.ui_contract
    || source.agentReadyUiContract
    || source.agent_ready_ui_contract
    || state.agentReadyUiContract
    || state.agent_ready_ui_contract
    || {};
  const actions = asArray(raw.actions).map(normalizeUiContractAction).filter((action) => action.actionId || action.label);
  return {
    contractId: raw.contract_id || raw.contractId || '',
    targetOrigin: raw.target_app_origin || raw.targetAppOrigin || raw.app_origin || raw.appOrigin || '',
    actions,
    refusalContracts: asArray(raw.refusal_contracts || raw.refusalContracts).map((item) => ({
      guardrailId: item?.guardrail_id || item?.guardrailId || item?.id || '',
      refusal: item?.refusal || item?.message || '',
    })).filter((item) => item.guardrailId || item.refusal),
  };
}

function normalizeSourcePatch(patch, index = 0) {
  return {
    patchId: patch?.patch_id || patch?.patchId || patch?.id || `patch-${index + 1}`,
    actionId: patch?.action_id || patch?.actionId || '',
    intent: patch?.intent || '',
    suggestedAttribute: patch?.suggested_attribute || patch?.suggestedAttribute || '',
    riskAnnotation: patch?.risk_annotation || patch?.riskAnnotation || '',
    successHook: patch?.success_hook || patch?.successHook || '',
    proofHook: patch?.proof_hook || patch?.proofHook || '',
    reviewRequired: Boolean(patch?.review_required ?? patch?.reviewRequired),
  };
}

function normalizeSourcePrPlan(dojo, state = {}) {
  const source = dojo.source || dojo.source_state || state.source || state.source_state || {};
  const raw = dojo.sourceAffordancePrPlan
    || dojo.source_affordance_pr_plan
    || source.sourceAffordancePrPlan
    || source.source_affordance_pr_plan
    || state.sourceAffordancePrPlan
    || state.source_affordance_pr_plan
    || {};
  const files = asArray(raw.files).map((file, fileIndex) => ({
    filePath: file?.file_path || file?.filePath || file?.path || `source-file-${fileIndex + 1}`,
    sourceAnchorId: file?.source_anchor_id || file?.sourceAnchorId || '',
    patches: asArray(file?.patches).map(normalizeSourcePatch).filter((patch) => patch.patchId || patch.intent),
  })).filter((file) => file.filePath || file.patches.length);
  return {
    planId: raw.plan_id || raw.planId || '',
    readiness: raw.readiness || 'not_ready',
    patchCount: Number(raw.patch_count ?? raw.patchCount ?? files.reduce((sum, file) => sum + file.patches.length, 0)),
    files,
    generatedTests: asArray(raw.generated_tests || raw.generatedTests).map((item) => ({
      path: item?.path || item?.file_path || item?.filePath || '',
      purpose: item?.purpose || item?.description || '',
    })).filter((item) => item.path || item.purpose),
    reviewChecklist: compactStrings(raw.review_checklist || raw.reviewChecklist),
  };
}

function normalizeApiIssue(issue) {
  return {
    issueId: issue?.issue_id || issue?.issueId || issue?.id || '',
    severity: issue?.severity || 'error',
    message: issue?.message || issue?.description || '',
  };
}

function normalizeApiCandidate(candidate, index = 0) {
  const review = candidate?.review || candidate?.candidate_review || candidate?.candidateReview || {};
  const issues = asArray(candidate?.issues || review.issues).map(normalizeApiIssue).filter((issue) => issue.issueId || issue.message);
  return {
    candidateId: candidate?.candidate_id || candidate?.candidateId || candidate?.id || `api-candidate-${index + 1}`,
    method: candidate?.method || '',
    path: candidate?.path || candidate?.url || '',
    mutationClass: candidate?.mutation_class || candidate?.mutationClass || '',
    authScope: candidate?.auth_scope || candidate?.authScope || '',
    idempotencyKeyLocation: candidate?.idempotency_key_location || candidate?.idempotencyKeyLocation || '',
    rollbackStrategy: candidate?.rollback_strategy || candidate?.rollbackStrategy || '',
    postcondition: candidate?.postcondition || '',
    reviewStatus: candidate?.review_status || candidate?.reviewStatus || 'candidate',
    okToPromote: Boolean(review.ok_to_promote ?? review.okToPromote),
    inferredFrom: compactStrings(candidate?.inferred_from || candidate?.inferredFrom),
    proofClaimMapping: candidate?.proof_claim_mapping || candidate?.proofClaimMapping || {},
    issues,
  };
}

function normalizeGeneratedTool(tool, index = 0) {
  return {
    toolName: tool?.tool_name || tool?.toolName || tool?.name || `generated-tool-${index + 1}`,
    toolVersion: tool?.tool_version || tool?.toolVersion || tool?.version || '',
    candidateId: tool?.candidate_id || tool?.candidateId || '',
    status: tool?.status || tool?.review_status || tool?.reviewStatus || 'draft',
    proofRequired: Boolean(tool?.proof_required ?? tool?.proofRequired),
    schemaDigest: tool?.schema_digest || tool?.schemaDigest || tool?.manifest_digest || tool?.manifestDigest || '',
    blockedBy: compactStrings(tool?.blocked_by || tool?.blockedBy || tool?.issues),
  };
}

function normalizeSubstrateNodes(skill, sourceState) {
  const graphNodes = asArray(skill?.graph?.nodes)
    .filter((node) => node.kind === 'Action' || node.kind === 'Locate' || node.substrate || node.metadata?.substrate)
    .map((node) => ({
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      substrate: node.substrate || node.metadata?.substrate || 'runtime',
      sourceAnchorId: node.metadata?.source_anchor_id || node.metadata?.sourceAnchorId || '',
      apiCandidateId: node.metadata?.api_candidate_id || node.metadata?.apiCandidateId || '',
      proofRequired: Boolean(node.proofRequired),
    }));
  if (graphNodes.length) return graphNodes;
  return sourceState.uiContract.actions.map((action) => ({
    nodeId: action.sourceStepId || action.actionId,
    label: action.label,
    kind: 'Action',
    substrate: action.allowedSubstrates.join(', ') || 'ui',
    sourceAnchorId: action.sourceAnchorId,
    apiCandidateId: '',
    proofRequired: action.proofClaims.length > 0,
  }));
}

function normalizeSourceState(state, dojo, skill) {
  const source = dojo.source || dojo.source_state || state.source || state.source_state || {};
  const uiContract = normalizeUiContract(dojo, state);
  const sourcePrPlan = normalizeSourcePrPlan(dojo, state);
  const apiCandidates = asArray(
    dojo.apiCandidates
      || dojo.api_candidates
      || source.apiCandidates
      || source.api_candidates
      || state.apiCandidates
      || state.api_candidates,
  ).map(normalizeApiCandidate).filter((candidate) => candidate.candidateId || candidate.path);
  const generatedTools = asArray(
    dojo.generatedTools
      || dojo.generated_tools
      || dojo.apiTools
      || dojo.api_tools
      || source.generatedTools
      || source.generated_tools
      || state.generatedTools
      || state.generated_tools,
  ).map(normalizeGeneratedTool).filter((tool) => tool.toolName);
  const partialSourceState = { uiContract, sourcePrPlan, apiCandidates, generatedTools };
  const substrateNodes = normalizeSubstrateNodes(skill, partialSourceState);
  const reviewRequiredPatchCount = sourcePrPlan.files.reduce(
    (sum, file) => sum + file.patches.filter((patch) => patch.reviewRequired).length,
    0,
  );
  return {
    uiContract,
    sourcePrPlan,
    apiCandidates,
    generatedTools,
    substrateNodes,
    metrics: {
      uiActionCount: uiContract.actions.length,
      sourceMappedActionCount: uiContract.actions.filter((action) => action.sourceAnchorId || action.stableLocator).length,
      patchCount: sourcePrPlan.patchCount,
      reviewRequiredPatchCount,
      apiCandidateCount: apiCandidates.length,
      approvedApiCandidateCount: apiCandidates.filter((candidate) => candidate.reviewStatus === 'approved' || candidate.okToPromote).length,
      generatedToolCount: generatedTools.length,
    },
  };
}

function normalizeEvidenceLedgerRecord(record, index = 0) {
  const recordId = record?.record_id || record?.recordId || record?.id || `evidence-${index + 1}`;
  return {
    recordId,
    kind: record?.kind || record?.artifact_type || record?.artifactType || 'artifact',
    ref: record?.ref || record?.artifact_uri || record?.artifactUri || record?.source_ref || record?.sourceRef || '',
    redaction: record?.redaction || (record?.redaction_manifest_sha256 || record?.redactionManifestSha256 ? 'redacted' : 'metadata_only'),
    hash: record?.hash || record?.record_hash || record?.recordHash || record?.artifact_sha256 || record?.artifactSha256 || '',
    previousHash: record?.previous_hash || record?.previousHash || '',
    ledgerHeadHash: record?.ledger_head_hash || record?.ledgerHeadHash || '',
    redactionManifestSha256: record?.redaction_manifest_sha256 || record?.redactionManifestSha256 || '',
    claimIds: compactStrings(record?.claim_ids || record?.claimIds),
    retentionClass: record?.retention_class || record?.retentionClass || '',
    legalHold: Boolean(record?.legal_hold ?? record?.legalHold),
    createdAt: record?.created_at || record?.createdAt || '',
  };
}

function normalizeEvidenceLedger(state, dojo) {
  const raw = dojo.evidenceLedger
    || dojo.evidence_ledger
    || dojo.universe?.evidence_ledger
    || dojo.universe?.evidenceLedger
    || state.evidenceLedger
    || state.evidence_ledger
    || state.universe?.evidence_ledger
    || state.universe?.evidenceLedger
    || {};
  const records = asArray(raw.records || raw.evidence_records || raw.evidenceRecords)
    .map(normalizeEvidenceLedgerRecord)
    .filter((record) => record.recordId || record.ref);
  return {
    ledgerId: raw.ledger_id || raw.ledgerId || '',
    headHash: raw.head_hash || raw.headHash || raw.ledger_head_hash || raw.ledgerHeadHash || records.at(-1)?.hash || '',
    records,
    storageModel: raw.storage_model || raw.storageModel || {},
    retentionPolicy: raw.retention_policy || raw.retentionPolicy || {},
  };
}

function normalizeRedactedExportArtifact(artifact, index = 0) {
  return {
    artifactId: artifact?.artifact_id || artifact?.artifactId || artifact?.id || `artifact-${index + 1}`,
    kind: artifact?.artifact_kind || artifact?.artifactKind || artifact?.kind || '',
    uri: artifact?.artifact_uri || artifact?.artifactUri || artifact?.uri || '',
    redactionId: artifact?.redaction_id || artifact?.redactionId || '',
    redactionCount: Number(artifact?.redaction_count ?? artifact?.redactionCount ?? 0),
    redactionManifestSha256: artifact?.redaction_manifest_sha256 || artifact?.redactionManifestSha256 || '',
    rulesApplied: compactStrings(artifact?.rules_applied || artifact?.rulesApplied),
    sourceRefs: compactStrings(artifact?.source_refs || artifact?.sourceRefs),
  };
}

function normalizeRedactedEvidenceExport(state, dojo) {
  const raw = dojo.redactedEvidenceExportManifest
    || dojo.redacted_evidence_export_manifest
    || dojo.redactedEvidence
    || dojo.redacted_evidence
    || state.redactedEvidenceExportManifest
    || state.redacted_evidence_export_manifest
    || state.redactedEvidence
    || state.redacted_evidence
    || {};
  const artifacts = asArray(raw.artifacts || raw.redacted_artifacts || raw.redactedArtifacts)
    .map(normalizeRedactedExportArtifact)
    .filter((artifact) => artifact.artifactId || artifact.uri);
  return {
    manifestId: raw.manifest_id || raw.manifestId || raw.export_id || raw.exportId || '',
    artifacts,
    excluded: compactStrings(raw.excluded || raw.excluded_artifacts || raw.excludedArtifacts),
    redactionCount: Number(raw.redaction_count ?? raw.redactionCount ?? artifacts.reduce((sum, artifact) => sum + artifact.redactionCount, 0)),
  };
}

function normalizeEvidenceClaim(item) {
  if (typeof item === 'string') return { claim: item, status: 'unknown', evidenceRefs: [] };
  return {
    claim: item?.claim || item?.claim_id || item?.claimId || item?.id || '',
    status: item?.status || (item?.satisfied ? 'satisfied' : 'unknown'),
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs || item?.evidence_record_ids || item?.evidenceRecordIds),
  };
}

function normalizeEvidenceState(state, dojo, skill) {
  const ledger = normalizeEvidenceLedger(state, dojo);
  const redactedExport = normalizeRedactedEvidenceExport(state, dojo);
  const governanceClaims = state.governance?.audit_report?.evidence_claims
    || state.governance?.auditReport?.evidenceClaims
    || dojo.governance?.evidenceClaims
    || dojo.governance?.evidence_claims
    || [];
  const claims = asArray(
    dojo.evidenceClaims
      || dojo.evidence_claims
      || skill?.proofCapsule?.evidenceClaims
      || governanceClaims,
  ).map(normalizeEvidenceClaim).filter((claim) => claim.claim);
  return {
    ledger,
    redactedExport,
    claims,
    metrics: {
      recordCount: ledger.records.length,
      redactedCount: ledger.records.filter((record) => record.redaction === 'redacted').length,
      metadataOnlyCount: ledger.records.filter((record) => record.redaction === 'metadata_only').length,
      claimCount: claims.length,
      exportArtifactCount: redactedExport.artifacts.length,
    },
  };
}

function normalizeCaseLawRecord(item, index = 0) {
  const bindingScope = item?.binding_scope || item?.bindingScope || '';
  return {
    caseId: item?.case_id || item?.caseId || item?.id || `case-${index + 1}`,
    title: item?.title || item?.finding || `Case ${index + 1}`,
    date: item?.date || item?.created_at || item?.createdAt || item?.updated_at || item?.updatedAt || '',
    sourceSkillId: item?.source_skill_id || item?.sourceSkillId || item?.skill_id || item?.skillId || '',
    sourceRunId: item?.source_run_id || item?.sourceRunId || item?.run_id || item?.runId || '',
    finding: item?.finding || '',
    impact: item?.impact || '',
    ruleCreated: item?.rule_created || item?.ruleCreated || item?.rule || '',
    appliesTo: compactStrings(item?.applies_to || item?.appliesTo),
    bindingScope: typeof bindingScope === 'string' ? bindingScope : [bindingScope?.kind, bindingScope?.id].filter(Boolean).join(':'),
    status: item?.status || 'proposed',
    reviewer: item?.reviewer || '',
    appealStatus: item?.appeal_status || item?.appealStatus || '',
    supersededBy: item?.superseded_by || item?.supersededBy || '',
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs),
  };
}

function normalizeGuardrailRecord(item, index = 0) {
  return {
    guardrailId: item?.guardrail_id || item?.guardrailId || item?.id || `guardrail-${index + 1}`,
    title: item?.title || item?.label || `Guardrail ${index + 1}`,
    rule: item?.rule || item?.predicate || '',
    blocksActions: compactStrings(item?.blocks_actions || item?.blocksActions || item?.blocked_actions || item?.blockedActions),
    sourceCaseId: item?.source_case_id || item?.sourceCaseId || '',
    severity: item?.severity || '',
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs),
  };
}

function normalizeAntibodyRecord(item, index = 0) {
  return {
    antibodyId: item?.antibody_id || item?.antibodyId || item?.id || `antibody-${index + 1}`,
    caseId: item?.case_id || item?.caseId || '',
    guardrailId: item?.guardrail_id || item?.guardrailId || '',
    trigger: item?.trigger || '',
    response: item?.response || '',
    appliesTo: compactStrings(item?.applies_to || item?.appliesTo),
    bindingScope: item?.binding_scope || item?.bindingScope || '',
    evidenceRefs: compactStrings(item?.evidence_refs || item?.evidenceRefs),
    createdAt: item?.created_at || item?.createdAt || '',
  };
}

function normalizeCaseLawState(state, dojo) {
  const rawRecords = dojo.caseLawRecords
    || dojo.case_law_records
    || dojo.caseLaw
    || dojo.case_law
    || state.caseLawRecords
    || state.case_law_records
    || state.caseLaw
    || state.case_law
    || state.governanceService?.case_law_review_queue
    || state.governanceService?.caseLawReviewQueue
    || [];
  const records = asArray(rawRecords).map(normalizeCaseLawRecord).filter((record) => record.caseId || record.title);
  const guardrails = asArray(dojo.guardrails || state.guardrails)
    .map(normalizeGuardrailRecord)
    .filter((guardrail) => guardrail.guardrailId || guardrail.title);
  const antibodies = asArray(dojo.antibodies || dojo.antibodyRegistry || dojo.antibody_registry || state.antibodies || state.antibodyRegistry || state.antibody_registry)
    .map(normalizeAntibodyRecord)
    .filter((antibody) => antibody.antibodyId || antibody.caseId || antibody.guardrailId);
  return {
    records,
    guardrails,
    antibodies,
    metrics: {
      recordCount: records.length,
      bindingCount: records.filter((record) => record.status === 'binding' || record.status === 'approved').length,
      proposedCount: records.filter((record) => record.status === 'proposed').length,
      deprecatedCount: records.filter((record) => record.status === 'deprecated').length,
      guardrailCount: guardrails.length,
      antibodyCount: antibodies.length,
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
      debug: normalizeDebugState(dojo),
      source: normalizeSourceState(state, dojo, null),
      evidence: normalizeEvidenceState(state, dojo, null),
      caseLaw: normalizeCaseLawState(state, dojo),
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
  skill.debug = normalizeDebugState(dojo);
  skill.source = normalizeSourceState(state, dojo, skill);
  skill.evidence = normalizeEvidenceState(state, dojo, skill);
  skill.caseLaw = normalizeCaseLawState(state, dojo);

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
    debug: skill.debug,
    source: skill.source,
    evidence: skill.evidence,
    caseLaw: skill.caseLaw,
    bridgeStatus: state.runtime?.status || state.status || 'ready',
  };
}

export async function getDojoWorkspaceSummary({ workspaceSlug = '', signal, url, token } = {}) {
  const state = await getAgentWorkflowState({ signal, url, token });
  return normalizeDojoWorkspaceSummary(state, workspaceSlug);
}

function bridgeToolActionError(body, fallbackCode) {
  const result = body?.result || {};
  const code = result.error || body?.error || fallbackCode;
  const detail = result.detail || result.message || body?.detail || body?.message || '';
  return new Error(detail ? `${code}: ${detail}` : code);
}

function assertBridgeToolActionOk(body, fallbackCode) {
  if (!body?.ok || body?.is_error || body?.result?.error) {
    throw bridgeToolActionError(body, fallbackCode);
  }
}

function summaryFromToolBody(body, workspaceSlug) {
  return normalizeDojoWorkspaceSummary(body?.state || {}, workspaceSlug);
}

function resolveGovernanceActor({ actorId, actorType = 'human' } = {}) {
  const currentUser = getCurrentUser();
  return {
    actorId: actorId || currentUser?.id || '',
    actorType,
  };
}

export async function reviewDojoPermissionUpgrade({
  item,
  decision,
  workspaceSlug = '',
  reason = '',
  evidenceRefs = [],
  reviewerActorId,
  reviewerActorType = 'human',
  signal,
  url,
  token,
} = {}) {
  const requestId = item?.requestId || item?.request_id || '';
  if (!requestId) throw new Error('dojo_permission_upgrade_request_id_required');
  if (decision !== 'approved' && decision !== 'denied') throw new Error('dojo_permission_upgrade_decision_required');
  const reviewer = resolveGovernanceActor({ actorId: reviewerActorId, actorType: reviewerActorType });
  const body = await callAgentWorkflowTool({
    url,
    token,
    signal,
    tool: 'synthi_dojo_review_permission_upgrade',
    arguments: {
      request_id: requestId,
      decision,
      reviewer_actor_id: reviewer.actorId,
      reviewer_actor_type: reviewer.actorType,
      ...(reason ? { reason } : {}),
      evidence_refs: compactStrings(evidenceRefs),
    },
  });
  assertBridgeToolActionOk(body, 'dojo_permission_upgrade_review_failed');
  return {
    body,
    result: body.result,
    summary: summaryFromToolBody(body, workspaceSlug),
    message: `Permission ${decision}: ${item?.action || requestId}`,
  };
}

export async function revokeDojoLicense({
  item,
  workspaceSlug = '',
  reason = '',
  evidenceRefs = [],
  actorId,
  actorType = 'human',
  signal,
  url,
  token,
} = {}) {
  const skillId = item?.skillId || item?.skill_id || '';
  if (!skillId) throw new Error('dojo_license_skill_id_required');
  const actor = resolveGovernanceActor({ actorId, actorType });
  const body = await callAgentWorkflowTool({
    url,
    token,
    signal,
    tool: 'synthi_dojo_revoke_license',
    arguments: {
      skill_id: skillId,
      ...(reason ? { reason } : {}),
      actor_id: actor.actorId,
      actor_type: actor.actorType,
      evidence_refs: compactStrings(evidenceRefs),
    },
  });
  assertBridgeToolActionOk(body, 'dojo_license_revoke_failed');
  return {
    body,
    result: body.result,
    summary: summaryFromToolBody(body, workspaceSlug),
    message: `License revoked: ${item?.skillName || item?.skillId || skillId}`,
  };
}
