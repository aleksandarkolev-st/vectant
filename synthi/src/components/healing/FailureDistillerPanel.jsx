'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BadgeCheck, BarChart3, ClipboardCheck, FileSearch, FlaskConical, PackageCheck, Play, Sprout, Trash2 } from 'lucide-react';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';

const inputClass = 'mt-1 w-full rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none focus:ring-2';

function capsulePath(result) {
  return result?.workspacePath || result?.workspace_path || '';
}

function parseJson(value, label) {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

export function FailureDistillerPanel({ workspaceSlug = '', workspaceRef = '', activeFile = '' }) {
  const gateway = useAnalyzerGateway();
  const [command, setCommand] = useState('');
  const [signature, setSignature] = useState('');
  const [observationKind, setObservationKind] = useState('command');
  const [observationFile, setObservationFile] = useState(activeFile);
  const [adapterRecording, setAdapterRecording] = useState('');
  const [containerImage, setContainerImage] = useState('');
  const [budget, setBudget] = useState('standard');
  const [patchEdits, setPatchEdits] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [affectedChecks, setAffectedChecks] = useState('');
  const [capsule, setCapsule] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const imagePinned = /@sha256:[a-f0-9]{64}$/i.test(containerImage.trim());
  const ready = Boolean(workspaceRef && command.trim() && imagePinned);
  const currentCapsulePath = capsulePath(capsule);

  useEffect(() => {
    if (activeFile) setObservationFile(activeFile);
  }, [activeFile]);

  const execute = useCallback(async (action) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setOutcome(result);
      const nextCapsulePath = capsulePath(result);
      if (nextCapsulePath) setCapsule({ ...result, workspacePath: nextCapsulePath });
      if (!result?.ok) setError(result?.reason || result?.status || 'The operation did not complete.');
      return result;
    } catch (cause) {
      setError(cause?.message || 'The gateway request failed.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const distill = useCallback(async () => {
    if (!ready) return;
    try {
      const recording = parseJson(adapterRecording, 'Recorded adapter evidence') || {};
      if (observationKind !== 'command' && Object.keys(recording).length === 0) {
        throw new Error(`${observationKind.toUpperCase()} distillation requires its recorded adapter evidence.`);
      }
      const observation = { kind: observationKind, ...(observationFile.trim() ? { filePath: observationFile.trim() } : {}), ...recording };
      const captured = observationKind === 'command'
        ? null
        : await gateway.captureFailureObservation({ workspaceRef, observation });
      await execute(() => gateway.distillFailure({
        workspaceRef,
        command: command.trim(),
        signature: signature.trim() ? { required: [signature.trim()] } : {},
        ...(captured ? { observationRef: captured.observationId || captured.observation_id } : { observation }),
        isolation: { mode: 'container', engine: 'docker', image: containerImage.trim() },
        budget: { preset: budget },
        autoDiscover: true,
        networkPolicy: 'deny',
      }));
    } catch (cause) {
      setError(cause.message);
    }
  }, [adapterRecording, budget, command, containerImage, execute, gateway, observationFile, observationKind, ready, signature, workspaceRef]);

  const validatePatch = useCallback(async () => {
    try {
      const edits = parseJson(patchEdits, 'Patch edits');
      const checks = parseJson(affectedChecks, 'Affected checks');
      if (!Array.isArray(edits) || edits.length === 0) throw new Error('Provide at least one provenance-backed patch edit.');
      if (checks !== null && !Array.isArray(checks)) throw new Error('Affected checks must be an array of command arrays.');
      await execute(() => gateway.validateFailureCapsulePatch({
        capsulePath: currentCapsulePath,
        workspaceRef,
        edits,
        ...(checks ? { affectedChecks: checks } : {}),
      }));
    } catch (cause) {
      setError(cause.message);
    }
  }, [affectedChecks, currentCapsulePath, execute, gateway, patchEdits]);

  const workspaceLabel = useMemo(() => workspaceSlug || 'Workspace unavailable', [workspaceSlug]);

  return (
    <section className="h-full overflow-y-auto p-3" data-testid="failure-distiller-panel">
      <header className="mb-4 border-b pb-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-start gap-2">
          <FlaskConical size={17} style={{ color: 'var(--accent-info)' }} />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Failure Distiller</h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Build a small, evidence-backed reproducer without editing source.</p>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="rounded px-1.5 py-0.5" style={{ background: 'var(--bg-editor)' }}>Workspace: {workspaceLabel}</span>
          <span>{workspaceRef ? 'Scoped access' : 'Waiting for workspace identity'}</span>
        </div>
      </header>

      <div className="space-y-4">
        <section aria-labelledby="distiller-create-heading">
          <h3 id="distiller-create-heading" className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Create capsule</h3>
          <div className="mt-2 space-y-2">
            <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Failing command
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="pytest tests/test_invite.py" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
            </label>
            <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Isolated runtime image
              <input value={containerImage} onChange={(event) => setContainerImage(event.target.value)} placeholder="registry/image@sha256:…" className={inputClass} aria-describedby="distiller-image-policy" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
              <span id="distiller-image-policy" className="mt-1 block">A server-allowlisted digest is required. Network and package installation remain denied.</span>
              {containerImage.trim() && !imagePinned ? <span className="mt-1 block" role="alert" style={{ color: 'var(--accent-danger)' }}>Mutable image tags cannot run in Failure Distiller.</span> : null}
            </label>
            <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Failure signature regex, optional
              <input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="InviteModal.onSubmit" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Observed via
                <select value={observationKind} onChange={(event) => setObservationKind(event.target.value)} className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
                  <option value="command">Command/test</option><option value="hmr">HMR, experimental</option><option value="browser">Browser, experimental</option><option value="native">Native, experimental</option><option value="gpu">GPU, experimental</option>
                </select>
              </label>
              <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Source file
                <input value={observationFile} onChange={(event) => setObservationFile(event.target.value)} className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
              </label>
            </div>
            {observationKind !== 'command' ? <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Recorded adapter evidence, JSON
              <textarea value={adapterRecording} onChange={(event) => setAdapterRecording(event.target.value)} rows={4} className={`${inputClass} font-mono`} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
            </label> : null}
            <div className="flex items-center gap-2">
              <label className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Budget
                <select value={budget} onChange={(event) => setBudget(event.target.value)} className="ml-1 rounded border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}><option value="fast">Fast</option><option value="standard">Standard</option><option value="deep">Deep</option></select>
              </label>
              <button type="button" disabled={busy || !ready} onClick={distill} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-xs disabled:opacity-50" style={{ background: 'var(--accent-primary)', color: 'var(--bg-app)' }}><Play size={12} /> Distill</button>
            </div>
          </div>
        </section>

        <section aria-labelledby="distiller-capsule-heading" className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <h3 id="distiller-capsule-heading" className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Capsule workspace</h3>
          {!currentCapsulePath ? <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>Distill a stable failing command to unlock replay, evidence, patch validation, and Vivarium handoff.</p> : <div className="mt-2 space-y-2">
            <div className="font-mono text-[10px] break-all" style={{ color: 'var(--text-muted)' }}>{currentCapsulePath}</div>
            <div className="flex flex-wrap gap-2">
              <ActionButton busy={busy} onClick={() => execute(() => gateway.runFailureCapsule(currentCapsulePath, workspaceRef))} Icon={Play}>Replay</ActionButton>
              <ActionButton busy={busy} disabled={!observationFile.trim()} onClick={() => execute(() => gateway.explainFailureCapsule(currentCapsulePath, observationFile.trim(), workspaceRef))} Icon={FileSearch}>Explain</ActionButton>
              <ActionButton busy={busy} onClick={() => execute(() => gateway.materializeFailureCapsule({ capsulePath: currentCapsulePath, workspaceRef }))} Icon={PackageCheck}>Materialize</ActionButton>
              <ActionButton busy={busy} onClick={() => execute(() => gateway.exportFailureCapsuleToVivarium(currentCapsulePath, workspaceRef))} Icon={Sprout}>Export</ActionButton>
              <ActionButton busy={busy} onClick={() => execute(() => gateway.promoteFailureCapsuleToVivarium(currentCapsulePath, 'regression', workspaceRef))} Icon={BadgeCheck}>Promote</ActionButton>
              <ActionButton busy={busy} danger onClick={() => { if (window.confirm('Permanently delete this capsule and its materialized contents?')) execute(async () => { const result = await gateway.deleteFailureCapsule(currentCapsulePath, workspaceRef); if (result?.ok) setCapsule(null); return result; }); }} Icon={Trash2}>Delete</ActionButton>
            </div>
            <details className="rounded border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
              <summary className="cursor-pointer text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>Validate patch in original workspace</summary>
              <label className="mt-2 block text-[10px]" style={{ color: 'var(--text-muted)' }}>Edits JSON
                <textarea value={patchEdits} onChange={(event) => setPatchEdits(event.target.value)} rows={4} className={`${inputClass} font-mono`} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-app)' }} />
              </label>
              <label className="mt-2 block text-[10px]" style={{ color: 'var(--text-muted)' }}>Affected checks JSON, optional
                <textarea value={affectedChecks} onChange={(event) => setAffectedChecks(event.target.value)} rows={2} className={`${inputClass} font-mono`} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-app)' }} />
              </label>
              <button type="button" disabled={busy} onClick={validatePatch} className="th-focus-ring mt-2 flex items-center gap-1 rounded border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}><ClipboardCheck size={12} /> Validate patch</button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ActionButton busy={busy} onClick={() => execute(async () => { const result = await gateway.requestFailureCapsuleApply(currentCapsulePath, workspaceRef); setApprovalId(result?.approvalId || result?.approval_id || ''); return result; })} Icon={BadgeCheck}>Request apply approval</ActionButton>
                <input aria-label="Patch approval ID" value={approvalId} onChange={(event) => setApprovalId(event.target.value)} placeholder="Approval ID" className={`${inputClass} flex-1 font-mono`} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-app)' }} />
                <ActionButton busy={busy} disabled={!approvalId.trim()} danger onClick={() => { if (window.confirm('Apply this exact approved patch to the active workspace?')) execute(() => gateway.applyApprovedFailureCapsulePatch(currentCapsulePath, workspaceRef, approvalId.trim())); }} Icon={BadgeCheck}>Apply approved patch</ActionButton>
              </div>
            </details>
          </div>}
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton busy={busy} disabled={!workspaceRef} onClick={() => execute(() => gateway.purgeExpiredFailureCapsules(workspaceRef))} Icon={Trash2}>Purge expired</ActionButton>
            <ActionButton busy={busy} onClick={() => execute(() => gateway.getFailureDistillerMetrics())} Icon={BarChart3}>Metrics</ActionButton>
          </div>
        </section>
      </div>

      {busy ? <div className="mt-3 text-[11px]" role="status" aria-live="polite" style={{ color: 'var(--text-muted)' }}>Failure Distiller is running in an isolated job.</div> : null}
      {error ? <div className="mt-3 flex gap-1 text-[11px]" role="alert" style={{ color: 'var(--accent-danger)' }}><AlertTriangle size={13} />{error}</div> : null}
      {outcome ? <OutcomeSummary outcome={outcome} /> : null}
    </section>
  );
}

function ActionButton({ busy, disabled = false, danger = false, onClick, Icon, children }) {
  return <button type="button" disabled={busy || disabled} onClick={onClick} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: danger ? 'var(--accent-danger)' : 'var(--border-subtle)', color: danger ? 'var(--accent-danger)' : 'var(--text-secondary)' }}><Icon size={12} />{children}</button>;
}

function OutcomeSummary({ outcome }) {
  return <div className="mt-3 rounded border p-2 text-[11px]" aria-live="polite" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
    <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{outcome.status || 'completed'}</div>
    {outcome.capsuleId ? <div className="font-mono" style={{ color: 'var(--text-muted)' }}>{outcome.capsuleId}</div> : null}
    {outcome.baseline ? <div style={{ color: 'var(--text-muted)' }}>Baseline stability: {outcome.baseline.matching_failures ?? outcome.baseline.matches}/{outcome.baseline.attempts} matching failures</div> : null}
    {outcome.reduction ? <div style={{ color: 'var(--text-muted)' }}>{outcome.reduction.removed_units} removed, {outcome.reduction.retained_units} retained</div> : null}
    {outcome.reduction?.untested_count ? <div style={{ color: 'var(--accent-warning)' }}>{outcome.reduction.untested_count} units untested: {outcome.reduction.limiting_reason}</div> : null}
    {outcome.budget?.max_executions ? <div style={{ color: 'var(--text-muted)' }}>Budget: {outcome.budget.executions_performed_current_request}/{outcome.budget.max_executions} executions</div> : null}
    {outcome.reason ? <div style={{ color: 'var(--text-muted)' }}>{outcome.reason}</div> : null}
    {outcome.metrics ? <div style={{ color: 'var(--text-muted)' }}>{outcome.metrics.accepted_capsules} capsules, {Math.round((outcome.metrics.reduction_ratio || 0) * 100)}% unit reduction, {outcome.metrics.validated_patches} validated patches</div> : null}
  </div>;
}

export default FailureDistillerPanel;
