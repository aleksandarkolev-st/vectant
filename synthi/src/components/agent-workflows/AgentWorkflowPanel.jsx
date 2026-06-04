'use client';

import { memo, useCallback, useMemo, useState } from 'react';
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
  OBSERVE: 'synthi_browser_observe',
  BEGIN_TEACH: 'synthi_browser_begin_teach',
  END_TEACH: 'synthi_browser_end_teach',
  CONFIGURE_AUTH: 'synthi_browser_configure_auth',
  OPEN_SOURCE: 'synthi_source_identity_open',
  COMPILE_CONTRACT: 'synthi_workflow_compile_contract',
  PREFIX_VALIDATE: 'synthi_workflow_prefix_validate',
  GENERATE_SCRIPT: 'synthi_workflow_generate_playwright',
  GENERATE_MANIFEST: 'synthi_workflow_generate_tool_manifest',
  PUBLISH_TOOL: 'synthi_workflow_publish_tool',
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

  return {
    primary: {
      action: primary.action,
      label: primary.actionLabel,
      enabled: Boolean(primary.actionEnabled),
      disabledReason: primary.disabledReason,
    },
    secondary: [
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
        label: 'Publish',
        icon: 'teach',
        enabled: scriptReady && unresolvedCount === 0,
        disabledReason: scriptReady ? 'Resolve workflow questions first' : 'Generate the Playwright workflow first',
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
        <h3 className="truncate text-xs font-semibold">Review Queue</h3>
      </div>
      <ul>
        {rows.map((item, index) => (
          <li key={item.id || `${item.label || item.title}-${index}`} className="border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="truncate text-xs font-medium">{item.label || item.title || 'Workflow question'}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {item.detail || item.reason || 'Needs a stable replay decision.'}
            </div>
          </li>
        ))}
      </ul>
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

export const AgentWorkflowPanel = memo(function AgentWorkflowPanel({
  workspaceSlug,
  workflowState,
  onWorkflowAction,
}) {
  const [localRecording, setLocalRecording] = useState(false);

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
