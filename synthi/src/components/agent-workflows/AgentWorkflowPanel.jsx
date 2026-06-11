'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Braces,
  CheckCircle2,
  CircleDot,
  Cloud,
  Eye,
  FileCode2,
  Fingerprint,
  Gauge,
  GitBranch,
  KeyRound,
  Play,
  Route,
  ShieldCheck,
  Square,
  Workflow,
} from 'lucide-react';

export const WORKFLOW_ACTIONS = Object.freeze({
  ATTACH_WORKSPACE: 'synthi_browser_attach_current_workspace',
  OBSERVE: 'synthi_browser_observe_preview',
  BEGIN_TEACH: 'synthi_browser_begin_teach',
  END_TEACH: 'synthi_browser_end_teach',
  RUN_CHECKRIDE: 'synthi_dojo_run_checkride',
  CONFIGURE_AUTH: 'synthi_auth_get_tool_auth_readiness',
  OPEN_SOURCE: 'synthi_source_get_mapping_status',
  COMPILE_CONTRACT: 'synthi_browser_compile_workflow',
  GET_MUTATION_PLAN: 'synthi_safety_get_mutation_plan',
  SET_REPLAY_ISOLATION_PROFILE: 'synthi_safety_set_replay_isolation_profile',
  PREFIX_VALIDATE: 'synthi_safety_run_prefix_validation',
  RUN_CI_ISOLATED_REPLAY: 'synthi_safety_run_ci_isolated_replay',
  GENERATE_SCRIPT: 'synthi_browser_generate_script',
  GENERATE_MANIFEST: 'synthi_browser_generate_private_tool_manifest',
  PUBLISH_TOOL: 'synthi_dojo_publish_skill',
  EXPORT_DOJO_ARTIFACTS: 'synthi_dojo_export_artifacts',
  ISSUE_PROOF_CAPSULE: 'synthi_dojo_issue_proof_capsule',
  RUN_PROOF_DRY_RUN: 'synthi_dojo_run_with_proof_capsule',
  EXPLAIN_BLOCK: 'synthi_dojo_explain_block',
  REQUEST_PERMISSION_UPGRADE: 'synthi_dojo_request_permission_upgrade',
});

const DEFAULT_WORKSPACE_LABEL = 'Current workspace';

const STATUS_STYLES = {
  ok: {
    color: 'var(--success-foreground, var(--text-primary))',
    background: 'color-mix(in srgb, var(--success, #238636) 14%, transparent)',
    borderColor: 'color-mix(in srgb, var(--success, #238636) 34%, var(--border-subtle))',
  },
  warn: {
    color: 'var(--warning-foreground, var(--text-primary))',
    background: 'color-mix(in srgb, var(--warning, #b7791f) 13%, transparent)',
    borderColor: 'color-mix(in srgb, var(--warning, #b7791f) 34%, var(--border-subtle))',
  },
  danger: {
    color: 'var(--error-foreground, var(--text-primary))',
    background: 'color-mix(in srgb, var(--error, #d73a49) 13%, transparent)',
    borderColor: 'color-mix(in srgb, var(--error, #d73a49) 34%, var(--border-subtle))',
  },
  neutral: {
    color: 'var(--text-muted)',
    background: 'var(--bg-panel)',
    borderColor: 'var(--border-subtle)',
  },
};

const STATUS_ICONS = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: AlertTriangle,
  neutral: CircleDot,
};

const STAGE_ICONS = {
  connect: Cloud,
  observe: Eye,
  teach: Route,
  auth: KeyRound,
  source: Fingerprint,
  run: Gauge,
  export: FileCode2,
  manifest: Braces,
};

const STEP_ICONS = {
  recorded: CircleDot,
  parameter: Braces,
  guarded: ShieldCheck,
  limited: AlertTriangle,
  verified: CheckCircle2,
};

function normalizeTone(value, fallback = 'neutral') {
  if (value === 'ok' || value === 'warn' || value === 'danger' || value === 'neutral') {
    return value;
  }
  return fallback;
}

function readableWorkspaceLabel(workspaceSlug) {
  return typeof workspaceSlug === 'string' && workspaceSlug.trim()
    ? workspaceSlug.trim()
    : DEFAULT_WORKSPACE_LABEL;
}

function mergeObject(base, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  return { ...base, ...value };
}

function isRuntimeAttached(runtime) {
  return ['attached', 'ready', 'observing', 'teaching', 'recording'].includes(runtime?.status);
}

function hasObservedPage(model) {
  return ['ready', 'observing', 'teaching', 'recording'].includes(model.observe?.status) || model.observe?.lastScreenshotAt;
}

function hasRecordedTrace(model) {
  return Number(model.workflow?.stepCount || 0) > 0 || (Array.isArray(model.steps) && model.steps.length > 0);
}

function hasCompiledContract(model) {
  return model.workflow?.contractStatus === 'compiled' || model.workflow?.contractStatus === 'ready';
}

function hasGeneratedScript(model) {
  return model.workflow?.scriptStatus === 'generated' || model.workflow?.scriptStatus === 'ready';
}

function unresolvedQuestionCount(model) {
  return Math.max(
    Number(model.workflow?.unresolvedCount || 0),
    Array.isArray(model.unresolvedSteps) ? model.unresolvedSteps.length : 0,
  );
}

function pickObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function normalizeIsolationState(value = {}) {
  const profile = pickObject(
    value.isolation,
    value.isolationProfile,
    value.isolation_profile,
    value.profileManifest,
    value.profile_manifest,
  ) || {};
  const manifest = pickObject(value.profileManifest, value.profile_manifest, profile) || {};
  const mutationPlan = pickObject(value.mutationPlan, value.mutation_plan) || {};
  const ciReplay = pickObject(mutationPlan.ci_full_replay) || {};
  const commands = pickObject(manifest.commands, profile.commands) || {};
  const missing = normalizeArray(profile.missing || manifest.missing || ciReplay.blockers);
  const readiness = profile.readiness || manifest.readiness || (missing.length > 0 ? 'ciIsolatedIncomplete' : 'notConfigured');
  const canRunFullMutationReplay = Boolean(
    profile.can_run_full_mutation_replay ||
    manifest.can_run_full_mutation_replay ||
    ciReplay.allowed,
  );
  const hasMutation = Boolean(mutationPlan.has_mutation || value.workflow?.hasMutation || canRunFullMutationReplay || missing.length > 0);

  return {
    readiness,
    hasMutation,
    canRunFullMutationReplay,
    baseUrl: profile.base_url || manifest.base_url || null,
    ciCommand: profile.ci_command || commands.ci || null,
    dataResetCommand: profile.data_reset_command || commands.data_reset || null,
    resetAssertionCommand: profile.reset_assertion_command || commands.reset_assertion || null,
    postconditionCommand: profile.postcondition_command || commands.postcondition || null,
    workingDirectory: profile.working_directory || manifest.working_directory || null,
    authProviderId: profile.auth_provider_id || manifest.auth_provider_id || null,
    resetProfileId: profile.reset_profile_id || manifest.reset_profile_id || null,
    stateSeedId: profile.state_seed_id || manifest.state_seed_id || null,
    postconditionConfigured: Boolean(profile.postcondition_command || commands.postcondition),
    allowMutationReplay: Boolean(profile.allow_mutation_replay || manifest.allow_mutation_replay),
    missing,
    detail: profile.detail || manifest.detail || mutationPlan.background_hardening?.reason || '',
  };
}

function normalizeDojoState(value = {}) {
  const raw = pickObject(value.dojo, value.skillCredential, value.skill_credential) || {};
  const skillCard = pickObject(raw.skillCard, raw.skill_card) || {};
  const skillPassport = pickObject(raw.skillPassport, raw.skill_passport) || {};
  const checkride = pickObject(raw.checkride) || {};
  const license = pickObject(raw.license) || {};
  const artifactExport = pickObject(raw.artifactExport, raw.artifact_export) || {};
  const proof = pickObject(raw.proof, raw.proofCapsule, raw.proof_capsule) || {};
  const proofDryRun = pickObject(raw.proofDryRun, raw.proof_dry_run) || {};
  const blockExplanation = pickObject(raw.blockExplanation, raw.block_explanation) || {};
  const permissionUpgrade = pickObject(raw.permissionUpgrade, raw.permission_upgrade) || {};
  const guardrails = Array.isArray(raw.guardrails) ? raw.guardrails : [];
  const allowedActions = Array.isArray(license.allowedActions) ? license.allowedActions : Array.isArray(license.allowed_actions) ? license.allowed_actions : [];
  const gatedActions = Array.isArray(license.gatedActions) ? license.gatedActions : Array.isArray(license.gated_actions) ? license.gated_actions : [];
  const blockedActions = Array.isArray(license.blockedActions) ? license.blockedActions : Array.isArray(license.blocked_actions) ? license.blocked_actions : [];

  return {
    status: raw.status || 'notStarted',
    label: raw.label || skillCard.status || 'No Dojo skill',
    detail: raw.detail || 'Teach a workflow before Dojo can issue a skill license.',
    published: Boolean(raw.published),
    skillId: raw.skillId || raw.skill_id || skillPassport.skill_id || null,
    workflowId: raw.workflowId || raw.workflow_id || null,
    entrustmentLevel: raw.entrustmentLevel || raw.entrustment_level || skillPassport.entrustment_level || 'E0',
    readinessLevel: Number(raw.readinessLevel ?? raw.readiness_level ?? skillPassport.readiness_level ?? 0),
    proofRequired: Boolean(raw.proofRequired ?? raw.proof_required ?? skillPassport.proof_required),
    publishedToolName: raw.publishedToolName || raw.published_tool_name || null,
    scenarioCount: Number(raw.scenarioCount ?? raw.scenario_count ?? 0),
    caseLawCount: Number(raw.caseLawCount ?? raw.case_law_count ?? 0),
    artifactCount: Number(raw.artifactCount ?? raw.artifact_count ?? artifactExport.artifact_count ?? 0),
    licenseExpiresAt: raw.licenseExpiresAt || raw.license_expires_at || skillPassport.license_expires_at || null,
    attackSuccessRate: Number(raw.attackSuccessRate ?? raw.attack_success_rate ?? skillPassport.attack_success_rate ?? 0),
    proof: {
      capsuleId: proof.capsuleId || proof.capsule_id || null,
      status: proof.status || proof.validation?.status || null,
      requestedAction: proof.requestedAction || proof.requested_action || null,
    },
    proofDryRun: {
      status: proofDryRun.status || proofDryRun.validation?.status || null,
      dryRun: Boolean(proofDryRun.dryRun ?? proofDryRun.dry_run),
    },
    blockExplanation: {
      status: blockExplanation.status || blockExplanation.validation?.status || null,
      refusal: blockExplanation.refusal || null,
    },
    permissionUpgrade: {
      requiredSteps: Array.isArray(permissionUpgrade.requiredSteps)
        ? permissionUpgrade.requiredSteps
        : Array.isArray(permissionUpgrade.required_steps)
          ? permissionUpgrade.required_steps
          : [],
    },
    checkride: {
      coverageScore: Number(checkride.coverageScore ?? checkride.coverage_score ?? 0),
      criticalFailures: Number(checkride.criticalFailures ?? checkride.critical_failures ?? 0),
      blockedScenarios: Number(checkride.blockedScenarios ?? checkride.blocked_scenarios ?? 0),
    },
    skillCard: {
      title: skillCard.title || raw.label || 'Dojo skill',
      status: skillCard.status || raw.label || 'Draft',
      canDoAlone: Array.isArray(skillCard.can_do_alone) ? skillCard.can_do_alone : Array.isArray(skillCard.canDoAlone) ? skillCard.canDoAlone : [],
      willAskBefore: Array.isArray(skillCard.will_ask_before) ? skillCard.will_ask_before : Array.isArray(skillCard.willAskBefore) ? skillCard.willAskBefore : [],
      willNotDo: Array.isArray(skillCard.will_not_do) ? skillCard.will_not_do : Array.isArray(skillCard.willNotDo) ? skillCard.willNotDo : [],
      practiced: skillCard.practiced || '',
      foundAndFixed: skillCard.found_and_fixed || skillCard.foundAndFixed || '',
      proofBadge: skillCard.proof_badge || skillCard.proofBadge || (raw.proofRequired ? 'Proof required' : 'Proof optional'),
    },
    license: {
      allowedActions,
      gatedActions,
      blockedActions,
    },
    guardrails,
  };
}

function shouldShowIsolationProfile(model) {
  return Boolean(
    model.isolation?.hasMutation ||
    model.isolation?.canRunFullMutationReplay ||
    model.isolation?.readiness === 'ciIsolatedReady' ||
    (Array.isArray(model.isolation?.missing) && model.isolation.missing.length > 0),
  );
}

function shouldShowDojoSkill(model) {
  return Boolean(model.dojo?.skillId || model.dojo?.status === 'draft' || model.dojo?.status === 'licensed');
}

function buildReadinessRows(model) {
  const runtimeReady = isRuntimeAttached(model.runtime);
  const observed = hasObservedPage(model);
  const traceReady = hasRecordedTrace(model);
  const compiled = hasCompiledContract(model);
  const scriptReady = hasGeneratedScript(model);
  const unresolvedCount = unresolvedQuestionCount(model);

  return [
    {
      label: 'Runtime',
      value: runtimeReady ? 'Hosted browser attached' : 'Attach hosted browser',
      tone: runtimeReady ? 'ok' : 'warn',
    },
    {
      label: 'Observe',
      value: observed ? 'Screenshot allowed' : 'Consent pending',
      tone: observed ? 'ok' : 'warn',
    },
    {
      label: 'Trace',
      value: traceReady ? `${Number(model.workflow?.stepCount || model.steps.length)} steps recorded` : 'No taught steps',
      tone: traceReady ? 'ok' : 'neutral',
    },
    {
      label: 'Contract',
      value: compiled ? 'Compiled' : unresolvedCount > 0 ? `${unresolvedCount} questions` : 'Not compiled',
      tone: compiled ? 'ok' : unresolvedCount > 0 ? 'warn' : 'neutral',
    },
    {
      label: 'Replay',
      value: scriptReady ? 'Playwright ready' : 'Not generated',
      tone: scriptReady ? 'ok' : 'neutral',
    },
  ];
}

function buildStages(model) {
  const runtimeReady = isRuntimeAttached(model.runtime);
  const observed = hasObservedPage(model);
  const traceReady = hasRecordedTrace(model);
  const compiled = hasCompiledContract(model);
  const scriptReady = hasGeneratedScript(model);
  const unresolvedCount = unresolvedQuestionCount(model);
  const recording = model.teach?.state === 'recording';

  return [
    {
      id: 'connect',
      label: 'Connect',
      title: 'Hosted browser runtime',
      detail: runtimeReady
        ? model.runtime?.detail || 'Attached to the workspace browser runtime.'
        : model.runtime?.detail || 'No hosted browser session is attached.',
      tone: runtimeReady ? 'ok' : 'warn',
      action: WORKFLOW_ACTIONS.ATTACH_WORKSPACE,
      actionLabel: runtimeReady ? 'Reattach' : 'Attach',
      actionEnabled: true,
    },
    {
      id: 'observe',
      label: 'Observe',
      title: 'Screenshot consent',
      detail: observed
        ? model.observe?.detail || 'The current workspace view can be inspected.'
        : model.observe?.detail || 'Attach first, then request a screenshot from the hosted runtime.',
      tone: observed ? 'ok' : runtimeReady ? 'warn' : 'neutral',
      action: WORKFLOW_ACTIONS.OBSERVE,
      actionLabel: 'Observe',
      actionEnabled: runtimeReady,
      disabledReason: runtimeReady ? undefined : 'Attach the hosted browser first',
    },
    {
      id: 'teach',
      label: 'Teach',
      title: recording ? 'Recording workflow' : 'Workflow teaching',
      detail: recording
        ? model.teach?.detail || 'Events are being captured for the current workflow.'
        : traceReady
          ? model.teach?.detail || 'A trace is ready for contract compilation.'
          : model.teach?.detail || 'Capture one same-origin workflow in the workspace.',
      tone: recording ? 'warn' : traceReady ? 'ok' : observed ? 'warn' : 'neutral',
      action: recording ? WORKFLOW_ACTIONS.END_TEACH : WORKFLOW_ACTIONS.BEGIN_TEACH,
      actionLabel: recording ? 'Stop' : 'Teach',
      actionEnabled: observed || recording,
      disabledReason: observed ? undefined : 'Observe the hosted browser first',
    },
    {
      id: 'auth',
      label: 'Auth',
      title: 'Session durability',
      detail: model.auth?.detail || (model.auth?.status === 'ready'
        ? 'Auth refresh is configured for replay.'
        : 'No auth checkpoint is configured for replay.'),
      tone: model.auth?.status === 'ready' ? 'ok' : 'neutral',
      action: WORKFLOW_ACTIONS.CONFIGURE_AUTH,
      actionLabel: 'Auth',
      actionEnabled: runtimeReady,
      disabledReason: runtimeReady ? undefined : 'Attach the hosted browser first',
    },
    {
      id: 'source',
      label: 'Source',
      title: 'Workspace source mapping',
      detail: model.source?.detail || (model.source?.status === 'ready'
        ? 'Captured elements can be traced to source files.'
        : 'Source identity tokens are not available for this workflow yet.'),
      tone: model.source?.status === 'ready' ? 'ok' : 'neutral',
      action: WORKFLOW_ACTIONS.OPEN_SOURCE,
      actionLabel: 'Source',
      actionEnabled: traceReady || model.source?.status === 'ready',
      disabledReason: traceReady ? undefined : 'Teach a workflow first',
    },
    {
      id: 'run',
      label: 'Run',
      title: 'Replay validation',
      detail: scriptReady
        ? model.replay?.detail || 'The Playwright workflow can run in a cold session.'
        : compiled
          ? model.replay?.detail || 'Generate Playwright and validate replay.'
          : unresolvedCount > 0
            ? model.replay?.detail || 'Answer unresolved contract questions first.'
            : model.replay?.detail || 'Compile the contract before replay.',
      tone: scriptReady ? 'ok' : unresolvedCount > 0 ? 'warn' : 'neutral',
      action: compiled ? WORKFLOW_ACTIONS.PREFIX_VALIDATE : WORKFLOW_ACTIONS.COMPILE_CONTRACT,
      actionLabel: compiled ? 'Validate' : 'Compile',
      actionEnabled: traceReady && unresolvedCount === 0,
      disabledReason: traceReady ? 'Resolve workflow questions first' : 'Teach a workflow first',
    },
  ];
}

function buildActions(model) {
  const stages = buildStages(model);
  const primary = stages.find((stage) => stage.actionEnabled && stage.tone !== 'ok') || stages.find((stage) => stage.actionEnabled) || stages[0];
  const traceReady = hasRecordedTrace(model);
  const compiled = hasCompiledContract(model);
  const scriptReady = hasGeneratedScript(model);
  const unresolvedCount = unresolvedQuestionCount(model);
  const dojoSkillReady = Boolean(model.dojo?.skillId);
  const dojoLicensed = Boolean(model.dojo?.published || model.dojo?.status === 'licensed');

  return {
    primary: {
      action: primary.action,
      label: primary.actionLabel,
      enabled: Boolean(primary.actionEnabled),
      disabledReason: primary.disabledReason,
    },
    secondary: [
      {
        action: WORKFLOW_ACTIONS.RUN_CHECKRIDE,
        label: 'Checkride',
        icon: 'run',
        enabled: compiled || traceReady,
        disabledReason: 'Teach a workflow first',
      },
      {
        action: WORKFLOW_ACTIONS.COMPILE_CONTRACT,
        label: 'Compile',
        icon: 'manifest',
        enabled: traceReady && unresolvedCount === 0,
        disabledReason: traceReady ? 'Resolve workflow questions first' : 'Teach a workflow first',
      },
      {
        action: WORKFLOW_ACTIONS.PREFIX_VALIDATE,
        label: 'Validate',
        icon: 'run',
        enabled: compiled,
        disabledReason: 'Compile the workflow contract first',
      },
      {
        action: WORKFLOW_ACTIONS.GENERATE_SCRIPT,
        label: 'Export',
        icon: 'export',
        enabled: compiled,
        disabledReason: 'Compile the workflow contract first',
      },
      {
        action: WORKFLOW_ACTIONS.GENERATE_MANIFEST,
        label: 'Manifest',
        icon: 'manifest',
        enabled: scriptReady,
        disabledReason: 'Generate the Playwright workflow first',
      },
      {
        action: WORKFLOW_ACTIONS.PUBLISH_TOOL,
        label: 'License',
        icon: 'teach',
        enabled: compiled && unresolvedCount === 0,
        disabledReason: compiled ? 'Resolve workflow questions first' : 'Compile the workflow contract first',
      },
      {
        action: WORKFLOW_ACTIONS.EXPORT_DOJO_ARTIFACTS,
        label: 'Dojo Export',
        icon: 'export',
        enabled: dojoSkillReady,
        disabledReason: 'License or preview a skill first',
      },
      {
        action: WORKFLOW_ACTIONS.RUN_PROOF_DRY_RUN,
        label: 'Proof Dry-run',
        icon: 'run',
        enabled: dojoLicensed,
        disabledReason: 'License this skill first',
      },
    ],
  };
}

export function createDefaultWorkflowViewModel(workspaceSlug) {
  const workspaceLabel = readableWorkspaceLabel(workspaceSlug);
  const model = {
    workspaceLabel,
    runtime: {
      status: 'notConfigured',
      label: 'Hosted runtime needed',
      detail: 'No hosted browser session is attached.',
    },
    observe: {
      status: 'needsRuntime',
      label: 'Consent pending',
      detail: 'Attach first, then inspect the workspace view.',
    },
    teach: {
      state: 'idle',
      label: 'Ready after observe',
      detail: 'Capture one same-origin workflow in the workspace.',
    },
    auth: {
      status: 'notConfigured',
      label: 'No checkpoint',
      detail: 'Auth can be added before cold-session replay.',
    },
    source: {
      status: 'pending',
      label: 'No source tokens',
      detail: 'Source identity is available after a recorded trace.',
    },
    replay: {
      status: 'notStarted',
      label: 'No replay',
      detail: 'Compile a contract before replay validation.',
    },
    workflow: {
      title: 'Untaught workflow',
      status: 'draft',
      label: 'No trace yet',
      detail: 'Teach a browser workflow in this workspace.',
      stepCount: 0,
      unresolvedCount: 0,
      contractStatus: 'missing',
      scriptStatus: 'missing',
    },
    steps: [],
    blockers: [],
    unresolvedSteps: [],
    history: [],
    isolation: normalizeIsolationState(),
    dojo: normalizeDojoState(),
  };

  return {
    ...model,
    readiness: buildReadinessRows(model),
    stages: buildStages(model),
    actions: buildActions(model),
  };
}

export function normalizeWorkflowPanelState(input, workspaceSlug) {
  const base = createDefaultWorkflowViewModel(workspaceSlug);
  const value = input && typeof input === 'object' ? input : {};
  const merged = {
    ...base,
    ...value,
    workspaceLabel: value.workspaceLabel || base.workspaceLabel,
    runtime: mergeObject(base.runtime, value.runtime),
    observe: mergeObject(base.observe, value.observe),
    teach: mergeObject(base.teach, value.teach),
    auth: mergeObject(base.auth, value.auth),
    source: mergeObject(base.source, value.source),
    replay: mergeObject(base.replay, value.replay),
    workflow: mergeObject(base.workflow, value.workflow),
    steps: Array.isArray(value.steps) ? value.steps : base.steps,
    blockers: Array.isArray(value.blockers) ? value.blockers : base.blockers,
    unresolvedSteps: Array.isArray(value.unresolvedSteps) ? value.unresolvedSteps : base.unresolvedSteps,
    history: Array.isArray(value.history) ? value.history : base.history,
    isolation: normalizeIsolationState(value),
    dojo: normalizeDojoState(value),
  };

  const withDerived = {
    ...merged,
    readiness: Array.isArray(value.readiness) ? value.readiness : buildReadinessRows(merged),
    stages: Array.isArray(value.stages) ? value.stages : buildStages(merged),
  };

  return {
    ...withDerived,
    actions: value.actions && typeof value.actions === 'object'
      ? {
          ...buildActions(withDerived),
          ...value.actions,
          primary: mergeObject(buildActions(withDerived).primary, value.actions.primary),
          secondary: Array.isArray(value.actions.secondary)
            ? value.actions.secondary
            : buildActions(withDerived).secondary,
        }
      : buildActions(withDerived),
  };
}

export function deriveWorkflowPanelSummary(input) {
  const model = normalizeWorkflowPanelState(input, input?.workspaceLabel);
  const unresolvedCount = unresolvedQuestionCount(model);
  const enabledStageActions = model.stages
    .filter((stage) => stage.action && stage.actionEnabled)
    .map((stage) => stage.action);
  const enabledFooterActions = [
    model.actions.primary,
    ...(Array.isArray(model.actions.secondary) ? model.actions.secondary : []),
    shouldShowIsolationProfile(model)
      ? {
          action: model.isolation.canRunFullMutationReplay
            ? WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY
            : WORKFLOW_ACTIONS.GET_MUTATION_PLAN,
          enabled: true,
        }
      : null,
  ]
    .filter((action) => action?.action && action.enabled)
    .map((action) => action.action);

  return {
    workspaceLabel: model.workspaceLabel,
    primaryAction: model.actions.primary?.action,
    primaryEnabled: Boolean(model.actions.primary?.enabled),
    enabledActions: Array.from(new Set([...enabledStageActions, ...enabledFooterActions])),
    blockerCount: model.blockers.length + unresolvedCount,
    stepCount: Number(model.workflow?.stepCount || model.steps.length || 0),
    canPublish: Boolean(
      model.actions.secondary?.some((action) => action.action === WORKFLOW_ACTIONS.PUBLISH_TOOL && action.enabled),
    ),
  };
}

function toneStyle(tone) {
  return STATUS_STYLES[normalizeTone(tone)];
}

function StatusBadge({ label, tone = 'neutral', icon: Icon }) {
  const badgeStyle = toneStyle(tone);
  const BadgeIcon = Icon || STATUS_ICONS[normalizeTone(tone)];
  return (
    <span
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold"
      style={badgeStyle}
    >
      <BadgeIcon className="h-3.5 w-3.5" strokeWidth={2} />
      <span className="max-w-28 truncate">{label}</span>
    </span>
  );
}

function ReadinessRow({ row }) {
  const style = toneStyle(row.tone || row.state);
  return (
    <div
      className="flex min-h-10 items-center justify-between gap-3 rounded-md border px-3 py-2"
      style={style}
    >
      <span className="text-[11px] font-semibold uppercase tracking-normal">{row.label}</span>
      <span className="min-w-0 truncate text-right text-[11px] font-medium">{row.value}</span>
    </div>
  );
}

function ActionButton({ action, label, icon, enabled = true, disabledReason, variant = 'secondary', onAction }) {
  const Icon = STAGE_ICONS[icon] || (action === WORKFLOW_ACTIONS.BEGIN_TEACH ? Eye : action === WORKFLOW_ACTIONS.END_TEACH ? Square : Play);
  const disabled = !enabled;
  const primary = variant === 'primary';

  return (
    <button
      type="button"
      className={[
        'inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition focus:outline-none focus:ring-2',
        primary ? 'h-9 px-3 text-xs' : 'border',
        disabled ? 'cursor-not-allowed opacity-55' : 'hover:opacity-90',
      ].join(' ')}
      style={{
        borderColor: 'var(--border-subtle)',
        background: primary ? 'var(--accent-primary)' : 'var(--bg-panel)',
        color: primary ? 'var(--accent-foreground, var(--bg-app))' : 'var(--text-primary)',
      }}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onClick={() => onAction?.(action)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function profileFormFromIsolation(isolation = {}) {
  return {
    baseUrl: isolation.baseUrl || '',
    ciCommand: isolation.ciCommand || '',
    dataResetCommand: isolation.dataResetCommand || '',
    resetAssertionCommand: isolation.resetAssertionCommand || '',
    postconditionCommand: isolation.postconditionCommand || '',
    workingDirectory: isolation.workingDirectory || '',
    authProviderId: isolation.authProviderId || '',
    resetProfileId: isolation.resetProfileId || '',
    stateSeedId: isolation.stateSeedId || '',
    allowMutationReplay: Boolean(isolation.allowMutationReplay),
  };
}

function trimOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function profilePayloadFromForm(form) {
  const commands = {
    ...(trimOrUndefined(form.ciCommand) ? { ci: trimOrUndefined(form.ciCommand) } : {}),
    ...(trimOrUndefined(form.dataResetCommand) ? { data_reset: trimOrUndefined(form.dataResetCommand) } : {}),
    ...(trimOrUndefined(form.resetAssertionCommand) ? { reset_assertion: trimOrUndefined(form.resetAssertionCommand) } : {}),
    ...(trimOrUndefined(form.postconditionCommand) ? { postcondition: trimOrUndefined(form.postconditionCommand) } : {}),
  };

  return {
    profile_manifest: {
      schema_version: 'synthi.replayIsolationProfile.v1',
      kind: 'ciIsolated',
      ...(trimOrUndefined(form.baseUrl) ? { base_url: trimOrUndefined(form.baseUrl) } : {}),
      ...(Object.keys(commands).length > 0 ? { commands } : {}),
      ...(trimOrUndefined(form.workingDirectory) ? { working_directory: trimOrUndefined(form.workingDirectory) } : {}),
      ...(trimOrUndefined(form.authProviderId) ? { auth_provider_id: trimOrUndefined(form.authProviderId) } : {}),
      ...(trimOrUndefined(form.resetProfileId) ? { reset_profile_id: trimOrUndefined(form.resetProfileId) } : {}),
      ...(trimOrUndefined(form.stateSeedId) ? { state_seed_id: trimOrUndefined(form.stateSeedId) } : {}),
      allow_mutation_replay: Boolean(form.allowMutationReplay),
    },
  };
}

function ProfileField({ label, value, onChange, multiline = false }) {
  const commonProps = {
    className: 'w-full rounded-md border px-2 py-1.5 text-[11px] outline-none focus:ring-2',
    style: {
      borderColor: 'var(--border-subtle)',
      background: 'var(--bg-panel)',
      color: 'var(--text-primary)',
    },
    value,
    onChange: (event) => onChange(event.target.value),
  };

  return (
    <label className="grid gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-normal" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {multiline ? (
        <textarea {...commonProps} rows={2} />
      ) : (
        <input {...commonProps} />
      )}
    </label>
  );
}

function WorkflowStage({ stage, onAction }) {
  const Icon = STAGE_ICONS[stage.id] || Workflow;
  const style = toneStyle(stage.tone);

  return (
    <div className="grid min-h-16 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex h-5 w-5 items-center justify-center rounded" style={{ background: 'var(--bg-panel)', color: 'var(--text-muted)' }}>
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold">{stage.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-normal" style={{ color: 'var(--text-muted)' }}>
            {stage.label}
          </span>
          <p className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{stage.detail}</p>
        </div>
      </div>
      <button
        type="button"
        className="inline-flex h-7 min-w-16 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
        style={{ ...style, minWidth: 64 }}
        disabled={!stage.actionEnabled}
        title={stage.actionEnabled ? undefined : stage.disabledReason}
        onClick={() => onAction?.(stage.action, { stageId: stage.id })}
      >
        {stage.action === WORKFLOW_ACTIONS.END_TEACH ? <Square className="h-3.5 w-3.5" strokeWidth={2} /> : <Play className="h-3.5 w-3.5" strokeWidth={2} />}
        <span className="truncate">{stage.actionLabel}</span>
      </button>
    </div>
  );
}

function WorkflowStep({ step, index }) {
  const Icon = STEP_ICONS[step.state] || CircleDot;
  const tone = step.state === 'limited' ? 'warn' : step.state === 'verified' ? 'ok' : 'neutral';

  return (
    <li
      className="flex min-h-12 items-center gap-3 border-t px-3 py-2"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold"
        style={{ background: 'var(--bg-panel)', color: 'var(--text-muted)' }}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{step.label || step.title}</div>
        <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {step.meta || step.detail || 'Recorded browser event'}
        </div>
      </div>
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
        style={toneStyle(tone)}
        aria-label={step.state || 'recorded'}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
    </li>
  );
}

function EmptyTrace() {
  return (
    <div className="border-t px-3 py-4 text-[11px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
      No taught steps are recorded for this workspace yet.
    </div>
  );
}

function ReviewQueue({ items, blockers }) {
  const rows = items.length > 0 ? items : blockers;
  if (!rows.length) return null;

  return (
    <section className="mt-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="agent-workflow-review">
      <div className="flex items-center gap-2 px-3 py-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} style={{ color: 'var(--warning, #b7791f)' }} />
        <h3 className="truncate text-xs font-semibold">Publish Hardening</h3>
      </div>
      <ul>
        {rows.map((item, index) => (
          <li key={item.id || `${item.label || item.title}-${index}`} className="border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="truncate text-xs font-medium">{item.label || item.title || 'Workflow question'}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {item.detail || item.reason || 'Needs hardening before unattended replay.'}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DojoSkillCredential({ dojo, traceReady, onAction }) {
  if (!dojo || !shouldShowDojoSkill({ dojo })) return null;
  const licensed = dojo.status === 'licensed' || dojo.published;
  const criticalFailures = Number(dojo.checkride?.criticalFailures || 0);
  const tone = licensed ? 'ok' : criticalFailures > 0 ? 'warn' : 'neutral';
  const allowed = dojo.skillCard?.canDoAlone?.length ? dojo.skillCard.canDoAlone : dojo.license?.allowedActions || [];
  const gated = dojo.skillCard?.willAskBefore?.length ? dojo.skillCard.willAskBefore : dojo.license?.gatedActions || [];
  const blocked = dojo.skillCard?.willNotDo?.length ? dojo.skillCard.willNotDo : dojo.license?.blockedActions || [];

  return (
    <section className="mt-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="agent-workflow-dojo">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold">Dojo Skill</h3>
          <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {dojo.detail}
          </p>
        </div>
        <StatusBadge label={dojo.entrustmentLevel || 'E0'} tone={tone} icon={ShieldCheck} />
      </div>
      <dl className="grid gap-1 border-t px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Readiness</dt>
          <dd className="min-w-0 truncate text-right">SRL {dojo.readinessLevel}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Checkride</dt>
          <dd className="min-w-0 truncate text-right">
            {Math.round(Number(dojo.checkride?.coverageScore || 0) * 100)}% coverage
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Practice</dt>
          <dd className="min-w-0 truncate text-right">{dojo.skillCard?.practiced || `${dojo.scenarioCount || 0} synthetic cases`}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Guardrails</dt>
          <dd className="min-w-0 truncate text-right">{dojo.skillCard?.foundAndFixed || `${dojo.guardrails?.length || 0} active`}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Proof</dt>
          <dd className="min-w-0 truncate text-right">{dojo.proofRequired ? 'Required' : 'Optional'}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Artifacts</dt>
          <dd className="min-w-0 truncate text-right">{dojo.artifactCount || 0} exported</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Evil twin</dt>
          <dd className="min-w-0 truncate text-right">{Math.round(Number(dojo.attackSuccessRate || 0) * 100)}% escaped</dd>
        </div>
        {dojo.licenseExpiresAt ? (
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>Expires</dt>
            <dd className="min-w-0 truncate text-right">{String(dojo.licenseExpiresAt).slice(0, 10)}</dd>
          </div>
        ) : null}
        {dojo.publishedToolName ? (
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>MCP tool</dt>
            <dd className="min-w-0 truncate text-right">{dojo.publishedToolName}</dd>
          </div>
        ) : null}
      </dl>
      <div className="grid gap-1 border-t px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Can:</span> {allowed.slice(0, 4).join(', ') || 'Practice only'}</div>
        <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Ask:</span> {gated.slice(0, 4).join(', ') || 'None'}</div>
        <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Block:</span> {blocked.slice(0, 4).join(', ') || 'None'}</div>
        {dojo.proof?.capsuleId ? (
          <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Capsule:</span> {dojo.proof.capsuleId}</div>
        ) : null}
        {dojo.proofDryRun?.status ? (
          <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Dry-run:</span> {dojo.proofDryRun.status}</div>
        ) : null}
        {dojo.blockExplanation?.refusal ? (
          <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Why:</span> {dojo.blockExplanation.refusal}</div>
        ) : null}
        {dojo.permissionUpgrade?.requiredSteps?.length ? (
          <div className="truncate"><span style={{ color: 'var(--text-muted)' }}>Upgrade:</span> {dojo.permissionUpgrade.requiredSteps.slice(0, 3).join(', ')}</div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t p-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <ActionButton
          action={WORKFLOW_ACTIONS.RUN_CHECKRIDE}
          label="Checkride"
          icon="run"
          enabled={traceReady}
          disabledReason="Teach a workflow first"
          onAction={onAction}
        />
        <ActionButton
          action={WORKFLOW_ACTIONS.PUBLISH_TOOL}
          label={licensed ? 'Relicense' : 'License'}
          icon="teach"
          enabled={traceReady}
          disabledReason="Teach a workflow first"
          onAction={onAction}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 border-t p-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <ActionButton
          action={WORKFLOW_ACTIONS.EXPORT_DOJO_ARTIFACTS}
          label="Export"
          icon="export"
          enabled={Boolean(dojo.skillId)}
          disabledReason="License or preview a skill first"
          onAction={onAction}
        />
        <ActionButton
          action={WORKFLOW_ACTIONS.ISSUE_PROOF_CAPSULE}
          label="Proof"
          icon="auth"
          enabled={licensed}
          disabledReason="License this skill first"
          onAction={onAction}
        />
        <ActionButton
          action={WORKFLOW_ACTIONS.RUN_PROOF_DRY_RUN}
          label="Dry-run"
          icon="run"
          enabled={licensed}
          disabledReason="License this skill first"
          onAction={onAction}
        />
        <ActionButton
          action={WORKFLOW_ACTIONS.EXPLAIN_BLOCK}
          label="Why"
          icon="manifest"
          enabled={Boolean(dojo.skillId)}
          disabledReason="License or preview a skill first"
          onAction={onAction}
        />
        <ActionButton
          action={WORKFLOW_ACTIONS.REQUEST_PERMISSION_UPGRADE}
          label="Upgrade"
          icon="teach"
          enabled={Boolean(dojo.skillId)}
          disabledReason="License or preview a skill first"
          onAction={onAction}
        />
      </div>
    </section>
  );
}

function HistoryList({ history }) {
  if (!history.length) {
    return (
      <div className="mt-3 rounded-md border px-3 py-3 text-[11px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
        No validation runs yet.
      </div>
    );
  }

  return (
    <section className="mt-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
        <h3 className="truncate text-xs font-semibold">Run History</h3>
      </div>
      <ul>
        {history.slice(0, 4).map((run, index) => (
          <li key={run.id || `${run.label || run.title}-${index}`} className="flex items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{run.label || run.title}</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{run.detail || run.startedAt || 'Replay run'}</div>
            </div>
            <StatusBadge label={run.statusLabel || run.status || 'Run'} tone={run.tone || (run.status === 'passed' ? 'ok' : 'warn')} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function IsolationProfileCard({ isolation, traceReady, onAction }) {
  const safeIsolation = isolation || {};
  const [editing, setEditing] = useState(!safeIsolation.canRunFullMutationReplay);
  const [form, setForm] = useState(() => profileFormFromIsolation(safeIsolation));
  useEffect(() => {
    setForm(profileFormFromIsolation(safeIsolation));
    if (!safeIsolation.canRunFullMutationReplay) setEditing(true);
  }, [
    safeIsolation.baseUrl,
    safeIsolation.ciCommand,
    safeIsolation.dataResetCommand,
    safeIsolation.resetAssertionCommand,
    safeIsolation.postconditionCommand,
    safeIsolation.workingDirectory,
    safeIsolation.authProviderId,
    safeIsolation.resetProfileId,
    safeIsolation.stateSeedId,
    safeIsolation.allowMutationReplay,
    safeIsolation.canRunFullMutationReplay,
  ]);
  if (!isolation) return null;
  const ready = isolation.canRunFullMutationReplay || isolation.readiness === 'ciIsolatedReady';
  const missing = Array.isArray(isolation.missing) ? isolation.missing : [];
  const action = ready ? WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY : WORKFLOW_ACTIONS.GET_MUTATION_PLAN;
  const actionLabel = ready ? 'CI replay' : 'Plan';
  const updateForm = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const saveProfile = () => {
    onAction?.(WORKFLOW_ACTIONS.SET_REPLAY_ISOLATION_PROFILE, profilePayloadFromForm(form));
  };

  return (
    <section className="mt-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="agent-workflow-isolation">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold">CI replay profile</h3>
          <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {ready
              ? 'Mutation replay is isolated by reset, seed, and postcondition checks.'
              : isolation.detail || 'Full mutation replay needs a resettable profile and postcondition.'}
          </p>
        </div>
        <StatusBadge
          label={ready ? 'Ready' : missing.length > 0 ? 'Incomplete' : 'Plan'}
          tone={ready ? 'ok' : missing.length > 0 ? 'warn' : 'neutral'}
          icon={ShieldCheck}
        />
      </div>
      <dl className="grid gap-1 border-t px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Reset profile</dt>
          <dd className="min-w-0 truncate text-right">{isolation.resetProfileId || 'Not configured'}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>State seed</dt>
          <dd className="min-w-0 truncate text-right">{isolation.stateSeedId || 'Not configured'}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Postcondition</dt>
          <dd className="min-w-0 truncate text-right">{isolation.postconditionConfigured ? 'Configured' : 'Missing'}</dd>
        </div>
        {missing.length > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>Missing</dt>
            <dd className="min-w-0 truncate text-right">{missing.slice(0, 3).join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {editing ? (
        <form
          className="grid gap-2 border-t px-3 py-2"
          style={{ borderColor: 'var(--border-subtle)' }}
          onSubmit={(event) => {
            event.preventDefault();
            saveProfile();
          }}
        >
          <ProfileField label="Base URL" value={form.baseUrl} onChange={updateForm('baseUrl')} />
          <ProfileField label="CI command" value={form.ciCommand} onChange={updateForm('ciCommand')} multiline />
          <ProfileField label="Reset command" value={form.dataResetCommand} onChange={updateForm('dataResetCommand')} multiline />
          <ProfileField label="Reset assertion" value={form.resetAssertionCommand} onChange={updateForm('resetAssertionCommand')} multiline />
          <ProfileField label="Postcondition" value={form.postconditionCommand} onChange={updateForm('postconditionCommand')} multiline />
          <div className="grid grid-cols-2 gap-2">
            <ProfileField label="Reset profile" value={form.resetProfileId} onChange={updateForm('resetProfileId')} />
            <ProfileField label="State seed" value={form.stateSeedId} onChange={updateForm('stateSeedId')} />
          </div>
          <ProfileField label="Working directory" value={form.workingDirectory} onChange={updateForm('workingDirectory')} />
          <ProfileField label="Auth provider" value={form.authProviderId} onChange={updateForm('authProviderId')} />
          <label className="flex min-h-8 items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={form.allowMutationReplay}
              onChange={(event) => updateForm('allowMutationReplay')(event.target.checked)}
            />
            <span>Allow mutation replay in isolated CI</span>
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition hover:opacity-90"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
            >
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="truncate">Save profile</span>
            </button>
            {ready ? (
              <button
                type="button"
                className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition hover:opacity-90"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-muted)' }}
                onClick={() => setEditing(false)}
              >
                <span className="truncate">Cancel</span>
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      <div className="border-t p-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="grid grid-cols-2 gap-2">
          <ActionButton
            action={action}
            label={actionLabel}
            icon="run"
            enabled={traceReady || ready}
            disabledReason="Teach a workflow first"
            onAction={onAction}
          />
          <button
            type="button"
            className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition hover:opacity-90"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
            onClick={() => setEditing((current) => !current)}
          >
            <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="truncate">{editing ? 'Hide setup' : 'Edit profile'}</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export const AgentWorkflowPanel = memo(function AgentWorkflowPanel({
  workspaceSlug,
  workflowState,
  onWorkflowAction,
}) {
  const [localRecording, setLocalRecording] = useState(false);

  useEffect(() => {
    const externalTeachState = workflowState?.teach?.state;
    if (externalTeachState === 'recording') setLocalRecording(true);
    else if (externalTeachState) setLocalRecording(false);
  }, [workflowState?.teach?.state]);

  const model = useMemo(() => {
    const normalized = normalizeWorkflowPanelState(workflowState, workspaceSlug);
    if (!localRecording) return normalized;
    return normalizeWorkflowPanelState(
      {
        ...normalized,
        teach: {
          ...normalized.teach,
          state: 'recording',
          label: 'Recording',
          detail: 'Events are being captured for this workflow.',
        },
        workflow: {
          ...normalized.workflow,
          label: 'Trace in progress',
          detail: 'Stop teaching to compile the workflow contract.',
        },
      },
      workspaceSlug,
    );
  }, [localRecording, workflowState, workspaceSlug]);

  const summary = useMemo(() => deriveWorkflowPanelSummary(model), [model]);
  const headerTone = summary.blockerCount > 0 ? 'warn' : hasGeneratedScript(model) ? 'ok' : 'neutral';
  const headerLabel = localRecording ? 'Teaching' : model.workflow?.label || 'Workflow draft';
  const traceReady = hasRecordedTrace(model);

  const emitWorkflowAction = useCallback((action, payload = {}) => {
    if (!action) return;
    const detail = {
      action,
      workspaceSlug: readableWorkspaceLabel(workspaceSlug),
      payload,
      requestedAt: new Date().toISOString(),
    };

    if (action === WORKFLOW_ACTIONS.BEGIN_TEACH) setLocalRecording(true);
    if (action === WORKFLOW_ACTIONS.END_TEACH) setLocalRecording(false);

    onWorkflowAction?.(detail);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('synthi:agent-workflow-action', { detail }));
    }
  }, [onWorkflowAction, workspaceSlug]);

  return (
    <section
      data-testid="agent-workflow-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}
    >
      <header className="border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Workflow className="h-4 w-4 shrink-0" strokeWidth={2} style={{ color: 'var(--accent-tertiary)' }} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Workflows</h2>
              <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {model.workspaceLabel}
              </p>
            </div>
          </div>
          <StatusBadge label={headerLabel} tone={headerTone} icon={localRecording ? Square : BadgeCheck} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="grid gap-2" data-testid="agent-workflow-readiness">
          {model.readiness.map((row) => (
            <ReadinessRow key={row.label} row={row} />
          ))}
        </div>

        <section className="mt-4 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold">{model.workflow.title}</h3>
              <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{model.workflow.detail}</p>
            </div>
            <StatusBadge
              label={`${summary.stepCount} steps`}
              tone={summary.stepCount > 0 ? 'ok' : 'neutral'}
              icon={Route}
            />
          </div>

          <div data-testid="agent-workflow-stages">
            {model.stages.map((stage) => (
              <WorkflowStage key={stage.id} stage={stage} onAction={emitWorkflowAction} />
            ))}
          </div>
        </section>

        <section className="mt-3 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="agent-workflow-steps">
          <div className="flex items-center gap-2 px-3 py-2">
            <Route className="h-3.5 w-3.5 shrink-0" strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
            <h3 className="truncate text-xs font-semibold">Recorded Trace</h3>
          </div>
          <ol>
            {model.steps.length > 0
              ? model.steps.map((step, index) => <WorkflowStep key={step.id || `${step.label}-${index}`} step={step} index={index} />)
              : <EmptyTrace />}
          </ol>
        </section>

        <ReviewQueue items={model.unresolvedSteps} blockers={model.blockers} />
        <DojoSkillCredential dojo={model.dojo} traceReady={traceReady} onAction={emitWorkflowAction} />
        {shouldShowIsolationProfile(model) ? (
          <IsolationProfileCard isolation={model.isolation} traceReady={traceReady} onAction={emitWorkflowAction} />
        ) : null}
        <HistoryList history={model.history} />
      </div>

      <footer className="grid gap-2 border-t p-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <ActionButton
          action={model.actions.primary?.action}
          label={model.actions.primary?.label || 'Attach'}
          enabled={model.actions.primary?.enabled}
          disabledReason={model.actions.primary?.disabledReason}
          variant="primary"
          icon={model.actions.primary?.action === WORKFLOW_ACTIONS.ATTACH_WORKSPACE ? 'connect' : undefined}
          onAction={emitWorkflowAction}
        />
        <div className="grid grid-cols-2 gap-2">
          {model.actions.secondary.map((action) => (
            <ActionButton
              key={action.action}
              action={action.action}
              label={action.label}
              icon={action.icon}
              enabled={action.enabled}
              disabledReason={action.disabledReason}
              onAction={emitWorkflowAction}
            />
          ))}
        </div>
      </footer>
    </section>
  );
});

export default AgentWorkflowPanel;
