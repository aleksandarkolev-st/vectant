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

export function normalizeDojoWorkspaceSummary(input = {}, workspaceSlug = '') {
  const state = input?.state || input || {};
  const dojo = state.dojo || state.skillCredential || state.skill_credential || {};
  const license = dojo.license || {};
  const empty = createEmptyDojoSummary(workspaceSlug);
  if (!dojo.skillId && !dojo.skill_id) {
    return {
      ...empty,
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
    bridgeStatus: state.runtime?.status || state.status || 'ready',
  };
}

export async function getDojoWorkspaceSummary({ workspaceSlug = '', signal, url, token } = {}) {
  const state = await getAgentWorkflowState({ signal, url, token });
  return normalizeDojoWorkspaceSummary(state, workspaceSlug);
}
