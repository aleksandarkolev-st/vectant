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
