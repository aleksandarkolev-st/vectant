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

export function normalizeDojoWorkspaceSummary(input = {}, workspaceSlug = '') {
  const state = input?.state || input || {};
  const dojo = state.dojo || state.skillCredential || state.skill_credential || {};
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
    allowedActions: dojo.skillCard?.canDoAlone || dojo.license?.allowedActions || [],
    gatedActions: dojo.skillCard?.willAskBefore || dojo.license?.gatedActions || [],
    blockedActions: dojo.skillCard?.willNotDo || dojo.license?.blockedActions || [],
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
